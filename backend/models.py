"""
ORM-модели приложения (SQLAlchemy).

Содержит две таблицы:
  - User        — пользователь Telegram и его профиль (для расчёта нормы калорий);
  - DiaryEntry  — запись в дневнике питания (один приём пищи / блюдо).
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
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
