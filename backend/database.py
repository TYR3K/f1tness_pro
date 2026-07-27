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
# В продакшене задаётся через переменную окружения DATABASE_URL (например,
# PostgreSQL от Railway). Код одинаково работает и с SQLite, и с PostgreSQL.
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")

# Некоторые платформы (Railway/Heroku) отдают устаревшую схему "postgres://",
# а SQLAlchemy 2.x понимает только "postgresql://". Аккуратно нормализуем.
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://"):]

# Параметры движка зависят от СУБД.
connect_args: dict = {}
engine_kwargs: dict = {}
if DATABASE_URL.startswith("sqlite"):
    # Для SQLite отключаем проверку потока: FastAPI работает в нескольких потоках,
    # а соединение по умолчанию привязано к одному.
    connect_args = {"check_same_thread": False}
else:
    # Внешняя СУБД (PostgreSQL): pool_pre_ping проверяет «живость» соединения
    # перед выдачей из пула, pool_recycle пересоздаёт его раз в 30 минут —
    # чтобы не ловить обрыв простаивающих соединений (Railway их со временем закрывает).
    engine_kwargs = {"pool_pre_ping": True, "pool_recycle": 1800}

# Движок SQLAlchemy — точка подключения к базе данных.
engine = create_engine(DATABASE_URL, connect_args=connect_args, **engine_kwargs)

# ГРОМКОЕ предупреждение, если в проде мы свалились на файловый SQLite.
# На Railway файловая система КОНТЕЙНЕРА эфемерна: при каждом редеплое/рестарте
# файл app.db создаётся заново, и ВСЕ пользователи с их данными исчезают.
# Именно так выглядит баг «человек открыл приложение, а через день его нет в базе».
_DB_URL_FROM_ENV = bool(os.getenv("DATABASE_URL"))
IS_EPHEMERAL_SQLITE = DATABASE_URL.startswith("sqlite") and not _DB_URL_FROM_ENV

if IS_EPHEMERAL_SQLITE:
    # Признаки облачного окружения — там такой фолбэк почти наверняка ошибка.
    _cloud = any(
        os.getenv(k)
        for k in ("RAILWAY_ENVIRONMENT", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID", "PORT", "DYNO")
    )
    _msg = (
        "DATABASE_URL НЕ ЗАДАН — используется локальный файл SQLite (%s). "
        "В облаке (Railway) диск эфемерный: данные пользователей будут стираться "
        "при каждом деплое. Задайте DATABASE_URL со ссылкой на PostgreSQL."
    ) % DATABASE_URL
    if _cloud:
        logger.error("=" * 70)
        logger.error("!!! КРИТИЧНО: %s", _msg)
        logger.error("=" * 70)
    else:
        logger.info("Локальная разработка: %s", DATABASE_URL)

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

    # Некоторые типы называются по-разному в разных СУБД. Для не-SQLite
    # (PostgreSQL) приводим SQL-тип к переносимому варианту: DATETIME -> TIMESTAMP.
    # Так будущие миграции безопасно применяются и на PostgreSQL.
    is_sqlite = engine.dialect.name == "sqlite"

    for name, sql_type, default in new_columns:
        # Колонка уже существует — пропускаем (идемпотентность).
        if name in existing_columns:
            continue

        col_type, default = ddl_type_and_default(
            table_name, name, sql_type, default, is_sqlite
        )

        ddl = f"ALTER TABLE {table_name} ADD COLUMN {name} {col_type}"
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


# Колонки, объявленные в моделях как Boolean. На PostgreSQL они ОБЯЗАНЫ иметь
# тип boolean: SQLAlchemy шлёт в них настоящий bool, и integer-колонка приводит к
# «column ... is of type integer but expression is of type boolean» — падает
# ЛЮБОЙ INSERT в таблицу (то есть регистрация новых пользователей).
# На SQLite типизация нестрогая, поэтому проблема там невидима.
_BOOLEAN_COLUMNS = {
    "users": ("is_owner", "adaptive_enabled", "used_trial"),
    "supplements": ("reminder_enabled",),
    "notification_settings": (
        "meal_reminder_enabled",
        "training_reminder_enabled",
        "supplement_reminder_enabled",
        "daily_summary_enabled",
    ),
    "training_reminders": ("enabled",),
    "supplement_reminders": ("enabled",),
}


def ddl_type_and_default(table_name, name, sql_type, default, is_sqlite):
    """Вернуть (SQL-тип, DEFAULT) для ALTER TABLE ADD COLUMN под текущую СУБД.

    Вынесено отдельной функцией, чтобы соответствие «тип в миграции ↔ тип в
    модели» можно было проверять тестом без живой БД (см. проверку схемы).

    Правила:
      * DATETIME -> TIMESTAMP на всех СУБД, кроме SQLite;
      * булевы колонки (_BOOLEAN_COLUMNS) -> BOOLEAN, а DEFAULT '0'/'1' ->
        FALSE/TRUE, иначе PostgreSQL отвергает вставку настоящих bool из ORM.
    """
    col_type = sql_type if is_sqlite else {"DATETIME": "TIMESTAMP"}.get(
        sql_type.upper(), sql_type
    )

    if name in _BOOLEAN_COLUMNS.get(table_name, ()) and not is_sqlite:
        col_type = "BOOLEAN"
        if default is not None:
            default = "FALSE" if str(default).strip().strip("'") == "0" else "TRUE"

    return col_type, default


def _repair_boolean_columns():
    """Починить тип boolean-колонок в существующей PostgreSQL-базе.

    ЗАЧЕМ: ранние миграции добавляли булевы поля как INTEGER (переносимый вариант
    для SQLite). На PostgreSQL это делает таблицу непригодной для вставки — новые
    пользователи не регистрируются вообще. Здесь мы находим такие колонки через
    information_schema и переводим их в boolean БЕЗ ПОТЕРИ ДАННЫХ (0→false, 1→true).

    Идемпотентно: уже корректные колонки пропускаются. На SQLite не делает ничего
    (там ALTER COLUMN TYPE не поддерживается и не нужен).
    """
    if engine.dialect.name == "sqlite":
        return

    for table, columns in _BOOLEAN_COLUMNS.items():
        try:
            inspector = inspect(engine)
            if table not in inspector.get_table_names():
                continue
            actual = {c["name"]: str(c["type"]).upper() for c in inspector.get_columns(table)}
        except Exception as exc:  # noqa: BLE001 — починка не должна валить старт
            logger.warning("_repair_boolean_columns: не удалось прочитать %s: %s", table, exc)
            continue

        for col in columns:
            cur = actual.get(col)
            # Колонки нет или она уже boolean — ничего не делаем.
            if cur is None or "BOOL" in cur:
                continue
            try:
                with engine.begin() as conn:
                    # DEFAULT снимаем: старый default ('0') несовместим с boolean.
                    conn.execute(text(
                        f"ALTER TABLE {table} ALTER COLUMN {col} DROP DEFAULT"
                    ))
                    conn.execute(text(
                        f"ALTER TABLE {table} ALTER COLUMN {col} TYPE BOOLEAN "
                        f"USING ({col} <> 0)"
                    ))
                    conn.execute(text(
                        f"ALTER TABLE {table} ALTER COLUMN {col} SET DEFAULT FALSE"
                    ))
                logger.warning(
                    "МИГРАЦИЯ: %s.%s переведена из %s в BOOLEAN (данные сохранены)",
                    table, col, cur,
                )
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "Не удалось починить тип %s.%s (%s): %s", table, col, cur, exc
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
        ("used_trial", "INTEGER", "0"),            # использован ли пробный период (0/1)
    ]
    _migrate_table("users", user_columns)

    # --- Таблица diary_entries: количество и единица измерения (nullable). ---
    diary_columns = [
        ("quantity", "REAL", None),   # число (2, 100, ...)
        ("unit", "TEXT", None),       # канонический ключ: pcs | g | ml | serving
    ]
    _migrate_table("diary_entries", diary_columns)

    # --- Таблица workouts: свободное описание активности для type="other". ---
    workout_columns = [
        ("description", "TEXT", None),  # текст активности для AI-оценки калорий
    ]
    _migrate_table("workouts", workout_columns)

    # --- Таблица notification_settings: произвольный список времён приёмов пищи. ---
    notification_settings_columns = [
        ("meal_times_json", "TEXT", None),  # JSON-массив времён "HH:MM"
    ]
    _migrate_table("notification_settings", notification_settings_columns)

    # --- Таблица payments: идентификатор списания для идемпотентности оплат. ---
    _migrate_table("payments", [("charge_id", "TEXT", None)])
    # UNIQUE-индекс по charge_id (NULL-значения не конфликтуют в SQLite/PostgreSQL).
    # Через ALTER ADD COLUMN UNIQUE нельзя (SQLite), поэтому отдельным индексом.
    try:
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_charge_id "
                "ON payments (charge_id)"
            ))
    except Exception as exc:  # noqa: BLE001 — индекс не критичен для старта
        logger.warning("Не удалось создать уникальный индекс payments.charge_id: %s", exc)


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

    # Чиним типы булевых колонок, добавленных ранними миграциями как INTEGER.
    # Без этого на PostgreSQL не создаётся НИ ОДИН новый пользователь.
    _repair_boolean_columns()
