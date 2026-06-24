"""
ORM-модели приложения (SQLAlchemy).

Базовые таблицы:
  - User        — пользователь Telegram и его профиль (для расчёта нормы калорий);
  - DiaryEntry  — запись в дневнике питания (один приём пищи / блюдо).

Расширенные таблицы (фитнес, спортпит, уведомления, избранное):
  - Workout              — тренировка пользователя и сожжённые калории;
  - Supplement           — спортивное питание / добавки пользователя;
  - NotificationSettings — настройки пуш-уведомлений пользователя;
  - FavoriteFood         — сохранённые/недавние блюда пользователя;
  - NotificationLog      — журнал отправленных уведомлений (для дедупликации).
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
)

from backend.database import Base


class User(Base):
    """Пользователь Telegram и параметры его профиля."""

    __tablename__ = "users"

    # Telegram ID — первичный ключ. Без автоинкремента: значение задаём сами.
    telegram_id = Column(BigInteger, primary_key=True, autoincrement=False)

    # Данные из Telegram (могут отсутствовать).
    username = Column(String, nullable=True)
    first_name = Column(String, nullable=True)
    photo_url = Column(String, nullable=True)

    # Физические параметры для формулы Миффлина — Сан Жеора.
    weight = Column(Float, nullable=True)   # вес, кг
    height = Column(Float, nullable=True)   # рост, см
    age = Column(Integer, nullable=True)    # возраст, лет

    # Пол: "male" | "female" — нужен для формулы расчёта BMR.
    gender = Column(String, nullable=True, default="male")

    # Коэффициент активности для расчёта суточной нормы (TDEE).
    activity_level = Column(Float, nullable=True, default=1.375)

    # Целевая суточная норма калорий (ккал).
    daily_goal_kcal = Column(Integer, nullable=True)

    # --- Новые поля цели по питанию (добавлены поверх существующей таблицы) ---
    # Цель диеты: "loss" (похудение) | "maintain" (поддержание) | "gain" (набор).
    diet_goal = Column(String, nullable=True, default="maintain")

    # Целевые нормы БЖУ (граммы) — рассчитываются вместе с дневной нормой калорий.
    target_proteins = Column(Float, nullable=True)  # белки, г
    target_fats = Column(Float, nullable=True)      # жиры, г
    target_carbs = Column(Float, nullable=True)     # углеводы, г

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)


class DiaryEntry(Base):
    """Одна запись дневника питания: блюдо в рамках приёма пищи за конкретный день."""

    __tablename__ = "diary_entries"

    # Идентификатор записи (автоинкремент).
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Владелец записи — ссылка на пользователя по Telegram ID.
    telegram_id = Column(
        BigInteger, ForeignKey("users.telegram_id"), index=True
    )

    # Дата в формате ISO "YYYY-MM-DD" (с индексом для быстрых выборок по дню).
    date = Column(String, index=True)

    # Тип приёма пищи: breakfast | lunch | dinner | snack.
    meal_type = Column(String)

    # Название блюда (на русском).
    dish_name = Column(String)

    # Пищевая ценность порции.
    calories = Column(Integer)   # калории, ккал
    proteins = Column(Float)     # белки, г
    fats = Column(Float)         # жиры, г
    carbs = Column(Float)        # углеводы, г

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)


class Workout(Base):
    """Тренировка пользователя за конкретный день и сожжённые калории."""

    __tablename__ = "workouts"

    # Идентификатор тренировки (автоинкремент).
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Владелец записи — ссылка на пользователя по Telegram ID.
    telegram_id = Column(
        BigInteger, ForeignKey("users.telegram_id"), index=True
    )

    # Дата в формате ISO "YYYY-MM-DD" (с индексом для выборок по дню).
    date = Column(String, index=True)

    # Тип тренировки: cardio | strength | walking | yoga | other.
    type = Column(String)

    # Длительность тренировки, минуты.
    duration_min = Column(Integer)

    # Сожжённые калории, ккал.
    calories_burned = Column(Integer)

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)


class Supplement(Base):
    """Спортивное питание / добавка пользователя."""

    __tablename__ = "supplements"

    # Идентификатор добавки (автоинкремент).
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Владелец записи — ссылка на пользователя по Telegram ID.
    telegram_id = Column(
        BigInteger, ForeignKey("users.telegram_id"), index=True
    )

    # Название добавки (например, "Креатин").
    name = Column(String)

    # Тип добавки (например, "протеин", "витамины").
    type = Column(String)

    # Дозировка (например, "5 г").
    dosage = Column(String)

    # Время приёма в формате "HH:MM" (может отсутствовать).
    intake_time = Column(String, nullable=True)

    # Включено ли напоминание о приёме.
    reminder_enabled = Column(Boolean, default=False)

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)


class NotificationSettings(Base):
    """Настройки пуш-уведомлений пользователя (одна строка на пользователя)."""

    __tablename__ = "notification_settings"

    # Первичный ключ — Telegram ID пользователя (одна строка на юзера).
    telegram_id = Column(
        BigInteger,
        ForeignKey("users.telegram_id"),
        primary_key=True,
        autoincrement=False,
    )

    # Напоминания о приёмах пищи.
    meal_reminder_enabled = Column(Boolean, default=False)
    breakfast_time = Column(String, default="09:00")  # время завтрака "HH:MM"
    lunch_time = Column(String, default="13:00")       # время обеда "HH:MM"
    dinner_time = Column(String, default="19:00")      # время ужина "HH:MM"

    # Напоминание о тренировке.
    training_reminder_enabled = Column(Boolean, default=False)
    training_time = Column(String, default="18:00")    # время тренировки "HH:MM"

    # Напоминание о приёме спортпита.
    supplement_reminder_enabled = Column(Boolean, default=False)

    # Ежедневная сводка по питанию.
    daily_summary_enabled = Column(Boolean, default=False)
    summary_time = Column(String, default="21:00")     # время сводки "HH:MM"


class FavoriteFood(Base):
    """Сохранённое / недавнее блюдо пользователя (для быстрого повторного добавления)."""

    __tablename__ = "favorite_foods"

    # Идентификатор записи (автоинкремент).
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Владелец записи — ссылка на пользователя по Telegram ID.
    telegram_id = Column(
        BigInteger, ForeignKey("users.telegram_id"), index=True
    )

    # Название блюда (на русском).
    dish_name = Column(String)

    # Пищевая ценность порции.
    calories = Column(Integer)   # калории, ккал
    proteins = Column(Float)     # белки, г
    fats = Column(Float)         # жиры, г
    carbs = Column(Float)        # углеводы, г

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)


class NotificationLog(Base):
    """
    Журнал отправленных уведомлений.

    Используется для дедупликации: чтобы одно и то же уведомление
    (например, "завтрак") не отправлялось пользователю дважды за один день.
    """

    __tablename__ = "notification_log"

    # Идентификатор записи (автоинкремент).
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Кому отправлено — Telegram ID пользователя.
    telegram_id = Column(BigInteger, index=True)

    # Вид уведомления: "breakfast" | "lunch" | "dinner" | "training" |
    # "summary" | "supplement:{id}".
    kind = Column(String)

    # Дата отправки в формате ISO "YYYY-MM-DD".
    date = Column(String)

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)
