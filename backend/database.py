"""
Модуль настройки базы данных (SQLAlchemy).

Здесь создаётся движок (engine), фабрика сессий (SessionLocal),
базовый класс моделей (Base), а также вспомогательные функции:
  - get_db()         — зависимость FastAPI, выдающая сессию и закрывающая её;
  - run_migrations() — идемпотентное добавление новых колонок в таблицу users;
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


def run_migrations():
    """
    Идемпотентные миграции для существующей таблицы users.

    Новые таблицы создаются через Base.metadata.create_all(), но добавить
    колонки в УЖЕ существующую таблицу create_all не умеет. Поэтому здесь
    мы аккуратно через ALTER TABLE добавляем недостающие колонки, проверяя
    их наличие, чтобы НЕ потерять данные пользователей.

    Работает и для SQLite, и для PostgreSQL. Каждый ALTER выполняется в
    отдельной транзакции и обёрнут в try/except — ошибка одной колонки
    не должна мешать остальным и не должна валить приложение.
    """
    # Список новых колонок: (имя, SQL-тип, выражение DEFAULT или None).
    new_columns = [
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
    ]

    try:
        inspector = inspect(engine)
        # Если таблицы users ещё нет (совсем чистая БД) — миграции не нужны:
        # create_all уже создаст её сразу с новыми колонками.
        if "users" not in inspector.get_table_names():
            return
        existing_columns = {col["name"] for col in inspector.get_columns("users")}
    except Exception as exc:  # noqa: BLE001 — миграции не должны валить старт
        logger.warning("Не удалось проинспектировать таблицу users: %s", exc)
        return

    for name, sql_type, default in new_columns:
        # Колонка уже существует — пропускаем (идемпотентность).
        if name in existing_columns:
            continue

        # Собираем безопасный ALTER TABLE. Имена/типы — из нашего списка,
        # пользовательского ввода здесь нет, поэтому подстановка безопасна.
        ddl = f"ALTER TABLE users ADD COLUMN {name} {sql_type}"
        if default is not None:
            ddl += f" DEFAULT {default}"

        try:
            with engine.begin() as conn:
                conn.execute(text(ddl))
            logger.info("Миграция: добавлена колонка users.%s", name)
        except Exception as exc:  # noqa: BLE001 — лог и продолжаем
            logger.warning(
                "Не удалось добавить колонку users.%s (%s): %s",
                name,
                sql_type,
                exc,
            )


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
