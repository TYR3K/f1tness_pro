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
    language: Optional[str] = None           # язык пользователя: "ru" | "en"
    # Адаптивные калории (Этап 3).
    adaptive_enabled: Optional[bool] = None       # включён ли адаптивный пересчёт цели
    calculated_maintenance: Optional[int] = None  # фактическое поддержание, ккал/день


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
    language: Optional[str] = None           # язык пользователя: "ru" | "en"
    # Адаптивные калории (Этап 3): включение адаптивного пересчёта цели.
    adaptive_enabled: Optional[bool] = None


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


# --------------------------------------------------------------------------- #
#  Подписка и доступ (Этап 1): статус подписки, лимит сканов, оплата Stars
# --------------------------------------------------------------------------- #
class SubscriptionStatusOut(BaseModel):
    """Текущий статус подписки пользователя и доступные тарифы.

    is_premium вычисляется ТОЛЬКО на бэкенде (owner / lifetime / активная дата),
    фронт использует его лишь для отображения, но не для контроля доступа.
    tariffs — словарь тарифов из конфига (цены берутся из env, не хардкодятся).
    """

    subscription_type: str                       # "free" | "monthly" | "yearly" | "lifetime"
    subscription_until: Optional[str] = None     # ISO-дата окончания подписки (или None)
    is_premium: bool                             # есть ли активный премиум-доступ
    is_owner: bool                               # является ли пользователь владельцем
    tariffs: Dict[str, Any]                      # доступные тарифы (config.TARIFFS)
    tribute_url: Optional[str] = None            # ссылка оплаты через Tribute (или None)


class ScansRemainingOut(BaseModel):
    """Остаток бесплатных сканирований еды на сегодня.

    Для премиум-пользователей remaining = -1 (безлимит).
    """

    used: int                                    # уже использовано сканов сегодня
    limit: int                                   # дневной лимит бесплатных сканов
    remaining: int                               # осталось сканов (-1 = безлимит)
    is_premium: bool                             # активен ли премиум (безлимит)


class StarsInvoiceIn(BaseModel):
    """Запрос на создание счёта Telegram Stars для выбранного тарифа."""

    tariff: str                                  # "monthly" | "yearly" | "lifetime"


class StarsInvoiceOut(BaseModel):
    """Ссылка-счёт Telegram Stars, которую фронт открывает для оплаты."""

    invoice_link: str                            # invoice link от Bot API


# --------------------------------------------------------------------------- #
#  Голосовой ввод еды (Этап 2): распознавание речи -> разбор блюд с КБЖУ
# --------------------------------------------------------------------------- #
class VoiceItemOut(BaseModel):
    """Одно блюдо, распознанное из голосового описания приёма пищи."""

    dish_name: str          # название блюда (на языке пользователя)
    calories: int           # калории, ккал
    proteins: float         # белки, г
    fats: float             # жиры, г
    carbs: float            # углеводы, г


class VoiceFoodOut(BaseModel):
    """Результат голосового ввода еды.

    transcript — распознанный текст; meal_type — определённый приём пищи
    (breakfast|lunch|dinner|snack) или None, если его не удалось понять;
    items — список разобранных блюд с оценкой КБЖУ.
    """

    transcript: str                              # распознанный текст речи
    meal_type: Optional[str] = None              # breakfast|lunch|dinner|snack|None
    items: List[VoiceItemOut] = []               # разобранные блюда с КБЖУ


# --------------------------------------------------------------------------- #
#  Трекинг веса и адаптивные калории (Этап 3)
# --------------------------------------------------------------------------- #
class WeightAddIn(BaseModel):
    """Добавление/обновление замера веса за конкретную дату."""

    date: str               # ISO-дата "YYYY-MM-DD"
    weight: float           # вес, кг


class WeightLogOut(BaseModel):
    """Замер веса, отдаваемый клиенту (с идентификатором)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    date: str               # ISO-дата "YYYY-MM-DD"
    weight: float           # вес, кг


class WeightPoint(BaseModel):
    """Одна точка графика веса (дата + значение)."""

    date: str               # ISO-дата "YYYY-MM-DD"
    weight: float           # вес, кг


class WeightHistoryOut(BaseModel):
    """История веса за период: фактические замеры, линия тренда и сводка.

    logs — фактические замеры по возрастанию даты;
    trend — сглаженная линия тренда (линейная регрессия) для графика;
    latest — последний известный вес; change_kg — изменение за период
    (последний минус первый замер).
    """

    logs: List[WeightPoint] = []                 # фактические замеры
    trend: List[WeightPoint] = []                # линия тренда
    latest: Optional[float] = None               # последний вес, кг
    change_kg: Optional[float] = None            # изменение за период, кг


class AdaptiveResultOut(BaseModel):
    """Результат адаптивного пересчёта дневной цели по динамике веса.

    enough_data — хватило ли данных для расчёта; при False остальные числовые
    поля обычно None, а explanation поясняет, чего не хватает.
    """

    enough_data: bool                            # достаточно ли данных для расчёта
    maintenance: Optional[int] = None            # фактическое поддержание, ккал/день
    new_goal: Optional[int] = None               # скорректированная дневная цель, ккал
    weekly_change_kg: Optional[float] = None     # изменение веса, кг/неделю
    avg_intake: Optional[int] = None             # средний дневной калораж, ккал
    days_used: int = 0                           # охват данных в днях
    explanation: str                             # пояснение результата (RU/EN)


# --------------------------------------------------------------------------- #
#  Шаблоны питания (Этап 4)
# --------------------------------------------------------------------------- #
class TemplateItem(BaseModel):
    """Одно блюдо внутри шаблона питания (с КБЖУ и опциональным приёмом пищи).

    meal_type указывается у блюда в day-шаблоне (чтобы при применении блюдо
    попало в нужный приём пищи); для dish/meal-шаблонов обычно None.
    """

    dish_name: str
    calories: int
    proteins: float
    fats: float
    carbs: float
    meal_type: Optional[str] = None              # breakfast|lunch|dinner|snack|None


class TemplateSaveIn(BaseModel):
    """Запрос на сохранение шаблона питания."""

    name: str                                    # имя шаблона
    template_type: str                           # "dish" | "meal" | "day"
    meal_type: Optional[str] = None              # приём пищи по умолчанию (или None)
    items: List[TemplateItem] = []               # блюда шаблона


class TemplateOut(BaseModel):
    """Шаблон питания, отдаваемый клиенту (с распарсенными блюдами)."""

    id: int
    name: str
    template_type: str                           # "dish" | "meal" | "day"
    meal_type: Optional[str] = None              # приём пищи по умолчанию (или None)
    items: List[TemplateItem] = []               # блюда шаблона


class TemplateListOut(BaseModel):
    """Список шаблонов питания пользователя."""

    items: List[TemplateOut] = []


class TemplateApplyIn(BaseModel):
    """Запрос на применение шаблона к конкретной дате дневника."""

    date: str                                    # ISO-дата "YYYY-MM-DD"
    meal_type: Optional[str] = None              # переопределение приёма пищи (или None)


class CopyYesterdayIn(BaseModel):
    """Запрос на копирование записей дневника со вчера на указанную дату."""

    date: str                                    # ISO-дата "YYYY-MM-DD" (целевой день)


# --------------------------------------------------------------------------- #
#  AI-функции (Этап 5): недельный отчёт, планировщик меню, умные предложения еды
# --------------------------------------------------------------------------- #
class WeeklyReportOut(BaseModel):
    """Недельный AI-отчёт: краткая сводка, инсайты-наблюдения и фокус-совет.

    summary — 1-2 предложения общей картины недели;
    insights — 3-5 строк с инсайтами (тренды калорий/БЖУ, связь с весом и
    тренировками, средний дефицит); focus — один главный совет на следующую
    неделю; stats — сырая собранная статистика (для отображения цифр на клиенте).
    """

    summary: str                                 # краткая сводка недели (1-2 предложения)
    insights: List[str] = []                     # инсайты-наблюдения (3-5 строк)
    focus: Optional[str] = None                  # главный фокус-совет на неделю
    stats: Optional[Dict[str, Any]] = None       # собранная недельная статистика


class MealPlanIn(BaseModel):
    """Запрос на генерацию AI-плана меню на день или неделю."""

    scope: str = "day"                           # "day" (1 день) | "week" (7 дней)
    preferences: Optional[str] = None            # пищевые предпочтения/ограничения
    budget: Optional[str] = None                 # бюджет ("эконом" и т.п.)


class MealPlanDish(BaseModel):
    """Одно блюдо в плане меню (с КБЖУ)."""

    dish_name: str
    calories: int
    proteins: float
    fats: float
    carbs: float


class MealPlanDay(BaseModel):
    """Один день плана меню: блюда, сгруппированные по приёмам пищи.

    meals — словарь "breakfast"|"lunch"|"dinner"|"snack" -> список блюд.
    """

    label: str                                   # подпись дня ("День 1" / "Понедельник")
    meals: Dict[str, List[MealPlanDish]] = {}    # блюда по приёмам пищи


class MealPlanOut(BaseModel):
    """AI-план меню: дни с блюдами и общий список покупок."""

    days: List[MealPlanDay] = []                 # дни плана (1 или 7)
    shopping_list: List[str] = []                # список покупок под план


class RegenerateItemIn(BaseModel):
    """Запрос на замену одного блюда в плане меню альтернативным."""

    meal_type: str                               # breakfast | lunch | dinner | snack
    around_calories: Optional[int] = None        # целевая калорийность блюда (~)
    preferences: Optional[str] = None            # пищевые предпочтения/ограничения


class RegenerateItemOut(BaseModel):
    """Одно альтернативное блюдо (та же форма, что MealPlanDish)."""

    dish_name: str
    calories: int
    proteins: float
    fats: float
    carbs: float


class FoodSuggestIn(BaseModel):
    """Запрос на умное предложение еды под остаток КБЖУ и пожелание."""

    meal_type: Optional[str] = None              # breakfast|lunch|dinner|snack|None
    free_text: Optional[str] = None              # произвольное пожелание ("хочу рыбу")
    remaining_calories: int                      # осталось калорий до цели, ккал
    remaining_proteins: float                    # осталось белка, г
    remaining_fats: float                        # осталось жира, г
    remaining_carbs: float                       # осталось углеводов, г


class FoodSuggestOut(BaseModel):
    """Набор умных предложений еды (переиспользует RecommendItem)."""

    suggestions: List[RecommendItem] = []        # 2-3 варианта с обоснованием


class HealthySnacksOut(BaseModel):
    """Набор низкокалорийных перекусов-«вкусняшек» под остаток калорий."""

    suggestions: List[RecommendItem] = []        # 3-4 варианта с обоснованием


# --------------------------------------------------------------------------- #
#  Трекинг цикла (Этап 6)
# --------------------------------------------------------------------------- #
class CycleLogIn(BaseModel):
    """Запрос на сохранение данных о менструальном цикле.

    cycle_length/period_length необязательны: при отсутствии берутся значения
    по умолчанию (28 и 5) и приводятся к валидному диапазону на бэкенде.
    """

    cycle_start_date: str                        # ISO-дата начала менструации "YYYY-MM-DD"
    cycle_length: Optional[int] = None           # средняя длина цикла, дней (по умолч. 28)
    period_length: Optional[int] = None          # длительность менструации, дней (по умолч. 5)
    notes: Optional[str] = None                  # необязательная заметка о самочувствии


class CycleStatusOut(BaseModel):
    """Текущий статус цикла: фаза, день, прогнозы и фертильное окно.

    has_data=False означает, что пользователь ещё не вводил данные (остальные
    поля тогда None). phase — ключ фазы ("menstrual"|"follicular"|"ovulation"|
    "luteal"), локализуется на клиенте. Все даты — ISO "YYYY-MM-DD".
    Значения ОРИЕНТИРОВОЧНЫЕ (не медицинская рекомендация).
    """

    has_data: bool                               # есть ли сохранённые данные цикла
    cycle_start_date: Optional[str] = None       # начало текущего расчётного цикла
    cycle_length: Optional[int] = None           # длина цикла, дней
    period_length: Optional[int] = None          # длительность менструации, дней
    day_of_cycle: Optional[int] = None           # текущий день цикла (1-based)
    phase: Optional[str] = None                  # ключ фазы (см. выше)
    next_period_date: Optional[str] = None       # прогноз следующей менструации
    days_until_next_period: Optional[int] = None # дней до следующей менструации
    ovulation_date: Optional[str] = None         # оценка даты овуляции
    fertile_start: Optional[str] = None          # начало фертильного окна
    fertile_end: Optional[str] = None            # конец фертильного окна
    notes: Optional[str] = None                  # заметка пользователя (последняя запись)


# --------------------------------------------------------------------------- #
#  Фото-прогресс (Этап 7)
# --------------------------------------------------------------------------- #
class ProgressPhotoOut(BaseModel):
    """Метаданные одного фото прогресса (без публичной ссылки на файл).

    image_url — путь к АВТОРИЗОВАННОМУ эндпоинту выдачи файла ("/progress/{id}/image"):
    его нужно запрашивать с заголовком авторизации (фронт грузит как blob). Прямого
    публичного доступа к изображению нет.
    """

    id: int
    date: str                                    # ISO-дата снимка "YYYY-MM-DD"
    weight: Optional[float] = None               # вес на момент снимка, кг
    image_url: str                               # путь авторизованной выдачи файла
    created_at: Optional[str] = None             # когда загружено (ISO), для сортировки


class ProgressListOut(BaseModel):
    """Список фото прогресса пользователя (по возрастанию даты)."""

    items: List[ProgressPhotoOut] = []
