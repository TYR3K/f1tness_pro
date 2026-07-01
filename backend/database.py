"""
Модуль настройки базы данных (SQLAlchemy).

Здесь создаётся движок (engine), фабрика сессий (SessionLocal),
базовый класс моделей (Base), а также вспомогательные функции:
  - get_db()         — зависимость FastAPI, выдающая сессию и закрывающая её;
  - run_migrations() — идемпотентное добавление новых колонок в существующие
                       таблицы (users, diary_entries);
  - init_db()        — создание новых таблиц и применение миграций при старте.
"""

import logging
import os

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

logger = logging.getLogger(__name__)

# URL подключения к БД. По умолчанию — локальный файл SQLite в корне проекта.
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")

# Для SQLite требуется отключить проверку потока, т.к. FastAPI работает
# с несколькими потоками, а соединение по умолчанию привязано к одному.
connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

# Движок SQLAlchemy — точка подключения к базе данных.
engine = create_engine(DATABASE_URL, connect_args=connect_args)

# Фабрика сессий. autoflush/autocommit выключены для явного контроля транзакций.
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

# Базовый класс для всех ORM-моделей.
Base = declarative_base()


def get_db():
    """
    Зависимость FastAPI: создаёт сессию БД на время запроса
    и гарантированно закрывает её по завершении.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _migrate_table(table_name, new_columns):
    """
    Идемпотентно добавить недостающие колонки в существующую таблицу.

    new_columns — список кортежей (имя, SQL-тип, выражение DEFAULT или None).
    Проверяем наличие таблицы через inspector; если её ещё нет (чистая БД) —
    ничего не делаем, create_all создаст таблицу сразу с новыми колонками.
    Каждый ALTER выполняется в отдельной транзакции и обёрнут в try/except —
    ошибка одной колонки не мешает остальным и не валит приложение.
    Имена/типы — из нашего списка (без пользовательского ввода), поэтому
    строковая подстановка в DDL безопасна.
    """
    try:
        inspector = inspect(engine)
        # Если таблицы ещё нет (совсем чистая БД) — миграции не нужны.
        if table_name not in inspector.get_table_names():
            return
        existing_columns = {col["name"] for col in inspector.get_columns(table_name)}
    except Exception as exc:  # noqa: BLE001 — миграции не должны валить старт
        logger.warning("Не удалось проинспектировать таблицу %s: %s", table_name, exc)
        return

    for name, sql_type, default in new_columns:
        # Колонка уже существует — пропускаем (идемпотентность).
        if name in existing_columns:
            continue

        ddl = f"ALTER TABLE {table_name} ADD COLUMN {name} {sql_type}"
        if default is not None:
            ddl += f" DEFAULT {default}"

        try:
            with engine.begin() as conn:
                conn.execute(text(ddl))
            logger.info("Миграция: добавлена колонка %s.%s", table_name, name)
        except Exception as exc:  # noqa: BLE001 — лог и продолжаем
            logger.warning(
                "Не удалось добавить колонку %s.%s (%s): %s",
                table_name,
                name,
                sql_type,
                exc,
            )


def run_migrations():
    """
    Идемпотентные миграции для существующих таблиц (users, diary_entries).

    Новые таблицы создаются через Base.metadata.create_all(), но добавить
    колонки в УЖЕ существующую таблицу create_all не умеет. Поэтому здесь
    мы аккуратно через ALTER TABLE добавляем недостающие колонки, проверяя
    их наличие, чтобы НЕ потерять данные пользователей.

    Работает и для SQLite, и для PostgreSQL.
    """
    # --- Таблица users: список новых колонок (имя, SQL-тип, DEFAULT или None). ---
    user_columns = [
        ("diet_goal", "TEXT", "'maintain'"),
        ("target_proteins", "REAL", None),
        ("target_fats", "REAL", None),
        ("target_carbs", "REAL", None),
        # Цель улучшения для AI-советов по спортпиту (nullable, без default).
        ("supplement_goal", "TEXT", None),
        # --- Поля подписки и доступа (Этап 1) ---
        ("subscription_type", "TEXT", "'free'"),   # тип подписки, по умолчанию free
        ("subscription_until", "DATETIME", None),  # дата окончания подписки (UTC)
        ("is_owner", "INTEGER", "0"),              # владелец приложения (булево как 0/1)
        ("daily_scans_used", "INTEGER", "0"),      # использовано сканов за сутки
        ("daily_scans_date", "TEXT", None),        # дата счётчика сканов (ISO)
        # Язык интерфейса/сообщений пользователя ("ru" | "en"), nullable.
        ("language", "TEXT", None),
        # --- Поля адаптивных калорий (Этап 3) ---
        ("adaptive_enabled", "INTEGER", "0"),      # включён ли адаптивный пересчёт (0/1)
        ("calculated_maintenance", "INTEGER", None),  # фактическое поддержание (ккал/день)
        ("adaptive_last_calc", "TEXT", None),      # дата последнего пересчёта (ISO)
    ]
    _migrate_table("users", user_columns)

    # --- Таблица diary_entries: количество и единица измерения (nullable). ---
    diary_columns = [
        ("quantity", "REAL", None),   # число (2, 100, ...)
        ("unit", "TEXT", None),       # канонический ключ: pcs | g | ml | serving
    ]
    _migrate_table("diary_entries", diary_columns)


def init_db():
    """
    Инициализация БД:
      1) импортируем модели (чтобы они зарегистрировались в метаданных Base);
      2) создаём недостающие таблицы (create_all — существующие не трогает);
      3) применяем миграции (добавляем новые колонки в существующую users).

    Существующие данные пользователей при этом сохраняются.
    """
    # Импорт моделей обязателен до create_all, иначе таблицы не будут созданы.
    from backend import models  # noqa: F401

    # Создаём новые таблицы; уже существующие таблицы create_all не пересоздаёт.
    Base.metadata.create_all(bind=engine)

    # Добавляем новые колонки в существующую таблицу users (идемпотентно).
    run_migrations()
