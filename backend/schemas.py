"""Pydantic-схемы (v2), описывающие тела запросов и ответов API.

Имена полей строго соответствуют JSON-контракту фронтенда.
Все nullable-поля профиля помечены как Optional[...].
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

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
    # Цель диеты и целевые БЖУ (добавлено).
    diet_goal: Optional[str] = None         # "loss" | "maintain" | "gain"
    target_proteins: Optional[float] = None  # целевой белок, г
    target_fats: Optional[float] = None      # целевой жир, г
    target_carbs: Optional[float] = None     # целевые углеводы, г
    supplement_goal: Optional[str] = None    # цель улучшения для AI-советов по спортпиту


class ProfileIn(BaseModel):
    """Входные данные для обновления профиля. Все поля необязательны."""

    weight: Optional[float] = None
    height: Optional[float] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    activity_level: Optional[float] = None
    daily_goal_kcal: Optional[int] = None
    # Цель диеты и целевые БЖУ (добавлено).
    diet_goal: Optional[str] = None
    target_proteins: Optional[float] = None
    target_fats: Optional[float] = None
    target_carbs: Optional[float] = None
    supplement_goal: Optional[str] = None


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
    # Оценка веса видимой порции в граммах и уровень уверенности модели.
    weight_grams: Optional[int] = None       # оценка веса порции, г
    confidence: Optional[str] = None         # "low" | "medium" | "high"
    # Отладочные данные (сырой ответ модели и т.п.) — заполняются только
    # при включённом DEBUG_AI, иначе None и не мешают в проде.
    debug: Optional[Dict[str, Any]] = None


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
    # Тренировки за день: сожжено калорий и «чистый» баланс (съедено - сожжено).
    total_burned: int = 0
    net_calories: int = 0


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


# --------------------------------------------------------------------------- #
#  Тренировки (workout)
# --------------------------------------------------------------------------- #
class WorkoutIn(BaseModel):
    """Тренировка, которую клиент добавляет в журнал."""

    date: str               # ISO-дата "YYYY-MM-DD"
    type: str               # cardio | strength | walking | yoga | other
    duration_min: int       # длительность, мин
    calories_burned: int    # сожжено калорий, ккал


class WorkoutOut(BaseModel):
    """Тренировка, отдаваемая клиенту (с идентификатором)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    date: str
    type: str
    duration_min: int
    calories_burned: int


class WorkoutDayOut(BaseModel):
    """Список тренировок за день + суммарно сожжённые калории."""

    date: str
    workouts: List[WorkoutOut] = []
    total_burned: int = 0


class WorkoutEstimateIn(BaseModel):
    """Запрос на оценку сожжённых калорий по типу и длительности."""

    type: str               # cardio | strength | walking | yoga | other
    duration_min: int       # длительность, мин


class WorkoutEstimateOut(BaseModel):
    """Оценка сожжённых калорий и использованный коэффициент MET."""

    calories_burned: int    # сожжено калорий, ккал
    met: float              # коэффициент MET, использованный в расчёте


# --------------------------------------------------------------------------- #
#  Ручное добавление еды и «недавние» блюда
# --------------------------------------------------------------------------- #
class ManualFoodIn(BaseModel):
    """Ручной ввод блюда в дневник (без фото)."""

    date: str               # ISO-дата "YYYY-MM-DD"
    meal_type: str          # breakfast | lunch | dinner | snack
    dish_name: str
    calories: int
    proteins: float
    fats: float
    carbs: float


class RecentFoodOut(BaseModel):
    """Одно недавнее/избранное блюдо для быстрого повторного добавления."""

    dish_name: str
    calories: int
    proteins: float
    fats: float
    carbs: float


class RecentFoodsOut(BaseModel):
    """Список недавних/избранных блюд."""

    items: List[RecentFoodOut] = []


# --------------------------------------------------------------------------- #
#  Рекомендации блюд (ИИ)
# --------------------------------------------------------------------------- #
class RecommendIn(BaseModel):
    """Запрос на ИИ-рекомендацию блюд с учётом остатка по калориям/БЖУ."""

    remaining_calories: int     # осталось калорий до цели, ккал
    remaining_proteins: float   # осталось белка, г
    remaining_fats: float       # осталось жира, г
    remaining_carbs: float      # осталось углеводов, г
    diet_goal: Optional[str] = None      # "loss" | "maintain" | "gain"
    time_of_day: Optional[str] = None    # подсказка по времени суток


class RecommendItem(BaseModel):
    """Один вариант рекомендованного блюда."""

    dish_name: str
    calories: int
    proteins: float
    fats: float
    carbs: float
    reason: str             # почему предложено именно это блюдо


class RecommendOut(BaseModel):
    """Набор рекомендованных блюд."""

    suggestions: List[RecommendItem] = []


# --------------------------------------------------------------------------- #
#  Спортивное питание / добавки (supplement)
# --------------------------------------------------------------------------- #
class SupplementIn(BaseModel):
    """Добавка, которую клиент сохраняет в свой список."""

    name: str
    type: str
    dosage: str
    intake_time: Optional[str] = None    # время приёма "HH:MM"
    reminder_enabled: bool = False       # включено ли напоминание


class SupplementOut(BaseModel):
    """Добавка, отдаваемая клиенту (с идентификатором)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    type: str
    dosage: str
    intake_time: Optional[str] = None
    reminder_enabled: bool = False


class SupplementListOut(BaseModel):
    """Список сохранённых добавок пользователя."""

    items: List[SupplementOut] = []


class SupplementSuggestItem(BaseModel):
    """Одна рекомендованная ИИ добавка."""

    name: str
    dosage: str
    note: str


class SupplementSuggestOut(BaseModel):
    """Рекомендации по добавкам с обязательным дисклеймером."""

    suggestions: List[SupplementSuggestItem] = []
    disclaimer: str         # медицинский дисклеймер


# --------------------------------------------------------------------------- #
#  Расчёт суточной нормы калорий и БЖУ
# --------------------------------------------------------------------------- #
class GoalCalcIn(BaseModel):
    """Входные данные для расчёта цели. Недостающее берётся из профиля."""

    weight: Optional[float] = None
    height: Optional[float] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    activity_level: Optional[float] = None
    diet_goal: Optional[str] = None      # "loss" | "maintain" | "gain"


class GoalCalcOut(BaseModel):
    """Результат расчёта суточной нормы и целевых БЖУ."""

    daily_goal_kcal: int    # суточная цель по калориям, ккал
    target_proteins: float  # целевой белок, г
    target_fats: float      # целевой жир, г
    target_carbs: float     # целевые углеводы, г
    diet_goal: str          # применённая цель диеты
    bmr: int                # базовый обмен, ккал
    tdee: int               # суточный расход с учётом активности, ккал


# --------------------------------------------------------------------------- #
#  Настройки уведомлений
# --------------------------------------------------------------------------- #
class NotificationSettingsIn(BaseModel):
    """Частичное обновление настроек уведомлений. Все поля необязательны."""

    meal_reminder_enabled: Optional[bool] = None
    breakfast_time: Optional[str] = None         # "HH:MM"
    lunch_time: Optional[str] = None
    dinner_time: Optional[str] = None
    training_reminder_enabled: Optional[bool] = None
    training_time: Optional[str] = None
    supplement_reminder_enabled: Optional[bool] = None
    daily_summary_enabled: Optional[bool] = None
    summary_time: Optional[str] = None


class NotificationSettingsOut(BaseModel):
    """Текущие настройки уведомлений пользователя."""

    model_config = ConfigDict(from_attributes=True)

    telegram_id: int
    meal_reminder_enabled: bool = False
    breakfast_time: str = "09:00"
    lunch_time: str = "13:00"
    dinner_time: str = "19:00"
    training_reminder_enabled: bool = False
    training_time: str = "18:00"
    supplement_reminder_enabled: bool = False
    daily_summary_enabled: bool = False
    summary_time: str = "21:00"


# --------------------------------------------------------------------------- #
#  Напоминания о тренировках (TrainingReminder)
# --------------------------------------------------------------------------- #
class TrainingReminderIn(BaseModel):
    """Входные данные для создания напоминания о тренировке.

    weekdays — список дней недели по Python (Пн=0 .. Вс=6).
    time — время напоминания в формате "HH:MM".
    """

    weekdays: List[int]              # дни недели: 0=Пн .. 6=Вс
    time: str                        # время "HH:MM"
    enabled: bool = True             # включено ли напоминание


class TrainingReminderOut(BaseModel):
    """Напоминание о тренировке, отдаваемое клиенту (с идентификатором)."""

    id: int
    weekdays: List[int]              # дни недели: 0=Пн .. 6=Вс
    time: str                        # время "HH:MM"
    enabled: bool = True


class TrainingRemindersOut(BaseModel):
    """Список напоминаний о тренировках пользователя."""

    items: List[TrainingReminderOut] = []


# --------------------------------------------------------------------------- #
#  Напоминания о приёме спортпита (SupplementReminder)
# --------------------------------------------------------------------------- #
class SupplementReminderIn(BaseModel):
    """Входные данные для создания напоминания о приёме добавок.

    supplement_ids — id добавок пользователя, которые входят в это напоминание.
    """

    label: str                       # метка: "Утро" | "Ночь" | своё
    time: str                        # время "HH:MM"
    enabled: bool = True             # включено ли напоминание
    supplement_ids: List[int] = []   # id добавок пользователя


class SupplementReminderItemOut(BaseModel):
    """Одна добавка внутри напоминания (id + название)."""

    id: int                          # id добавки (Supplement.id)
    name: str                        # название добавки


class SupplementReminderOut(BaseModel):
    """Напоминание о приёме добавок, отдаваемое клиенту."""

    id: int
    label: str                       # метка напоминания
    time: str                        # время "HH:MM"
    enabled: bool = True
    supplements: List[SupplementReminderItemOut] = []  # входящие добавки


class SupplementRemindersOut(BaseModel):
    """Список напоминаний о приёме добавок пользователя."""

    items: List[SupplementReminderOut] = []


# --------------------------------------------------------------------------- #
#  Рекомендации по спортпиту с учётом цели улучшения и тренировок (ИИ)
# --------------------------------------------------------------------------- #
class SupplementRecommendIn(BaseModel):
    """Запрос на ИИ-рекомендацию добавок с учётом цели улучшения.

    improvement_goal — выбранная цель: сон/восстановление/сила/энергия/
    иммунитет или произвольный текст.
    """

    improvement_goal: Optional[str] = None   # цель улучшения


class SupplementRecommendOut(BaseModel):
    """Результат рекомендации добавок с дисклеймером и контекстом.

    Использует уже существующую SupplementSuggestItem для каждого совета.
    """

    suggestions: List[SupplementSuggestItem] = []
    disclaimer: str                          # медицинский дисклеймер
    training_count: int = 0                  # число тренировок за 2 недели
    improvement_goal: Optional[str] = None   # применённая цель улучшения
