"""Pydantic-схемы (v2), описывающие тела запросов и ответов API.

Имена полей строго соответствуют JSON-контракту фронтенда.
Все nullable-поля профиля помечены как Optional[...].
"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, ConfigDict


# --------------------------------------------------------------------------- #
#  Профиль пользователя
# --------------------------------------------------------------------------- #
class ProfileOut(BaseModel):
    """Профиль пользователя, который отдаётся клиенту."""

    # from_attributes=True позволяет создавать схему прямо из ORM-объекта User.
    model_config = ConfigDict(from_attributes=True)

    telegram_id: int
    username: Optional[str] = None
    first_name: Optional[str] = None
    photo_url: Optional[str] = None
    weight: Optional[float] = None          # вес, кг
    height: Optional[float] = None          # рост, см
    age: Optional[int] = None               # возраст, лет
    gender: Optional[str] = None            # "male" | "female"
    activity_level: Optional[float] = None  # коэффициент активности для TDEE
    daily_goal_kcal: Optional[int] = None   # дневная цель по калориям


class ProfileIn(BaseModel):
    """Входные данные для обновления профиля. Все поля необязательны."""

    weight: Optional[float] = None
    height: Optional[float] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    activity_level: Optional[float] = None
    daily_goal_kcal: Optional[int] = None


# --------------------------------------------------------------------------- #
#  Распознавание еды по фото
# --------------------------------------------------------------------------- #
class AnalyzeOut(BaseModel):
    """Результат анализа фотографии блюда ИИ-сервисом."""

    dish_name: str          # название блюда (на русском)
    calories: int           # калории на порцию, ккал
    proteins: float         # белки, г
    fats: float             # жиры, г
    carbs: float            # углеводы, г
    note: str               # краткий комментарий/оценка


# --------------------------------------------------------------------------- #
#  Дневник питания
# --------------------------------------------------------------------------- #
class DiaryEntryIn(BaseModel):
    """Запись, которую клиент добавляет в дневник."""

    date: str               # ISO-дата "YYYY-MM-DD"
    meal_type: str          # breakfast | lunch | dinner | snack
    dish_name: str
    calories: int
    proteins: float
    fats: float
    carbs: float


class DiaryEntryOut(BaseModel):
    """Запись дневника, отдаваемая клиенту (с идентификатором)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    date: str
    meal_type: str
    dish_name: str
    calories: int
    proteins: float
    fats: float
    carbs: float


class MealsOut(BaseModel):
    """Записи дня, сгруппированные по типу приёма пищи."""

    breakfast: List[DiaryEntryOut] = []
    lunch: List[DiaryEntryOut] = []
    dinner: List[DiaryEntryOut] = []
    snack: List[DiaryEntryOut] = []


class DiaryDayOut(BaseModel):
    """Полная сводка по одному дню дневника."""

    date: str
    daily_goal_kcal: Optional[int] = None
    total_calories: int
    total_proteins: float
    total_fats: float
    total_carbs: float
    meals: MealsOut


# --------------------------------------------------------------------------- #
#  История по дням
# --------------------------------------------------------------------------- #
class HistoryDay(BaseModel):
    """Суммарные калории за один день истории."""

    date: str
    total_calories: int


class HistoryOut(BaseModel):
    """История потребления калорий за выбранный период."""

    goal: Optional[int] = None
    days: List[HistoryDay] = []
