"""
ORM-модели приложения (SQLAlchemy).

Базовые таблицы:
  - User        — пользователь Telegram и его профиль (для расчёта нормы калорий);
  - DiaryEntry  — запись в дневнике питания (один приём пищи / блюдо).

Расширенные таблицы (фитнес, спортпит, уведомления, избранное):
  - Workout              — тренировка пользователя и сожжённые калории;
  - Supplement           — спортивное питание / добавки пользователя;
  - NotificationSettings — настройки пуш-уведомлений пользователя
                           (теперь только приёмы пищи и вечерняя сводка);
  - FavoriteFood         — сохранённые/недавние блюда пользователя;
  - NotificationLog      — журнал отправленных уведомлений (для дедупликации);
  - TrainingReminder       — гибкое напоминание о тренировке (дни недели + время);
  - SupplementReminder     — напоминание о приёме спортпита (метка + время);
  - SupplementReminderItem — связь напоминания спортпита с конкретной добавкой.

Таблицы подписки и доступа (Этап 1):
  - Payment   — журнал успешных платежей за подписку (Stars / Tribute и т.п.);
  - ProGrant  — журнал ручной выдачи/отзыва доступа владельцем (через бота).

Трекинг веса и адаптивные калории (Этап 3):
  - WeightLog — замер веса пользователя за конкретный день
                (для построения тренда и расчёта фактического поддержания).
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

    # Язык интерфейса/сообщений пользователя: "ru" | "en".
    # Стартовое значение задаётся при первом входе по Telegram language_code:
    # "ru" если код начинается с "ru", иначе "en". Пользователь может сменить
    # язык вручную (через /profile), поэтому заданное значение не перетирается.
    language = Column(String, nullable=True)

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

    # Выбранная пользователем цель улучшения для AI-советов по спортпиту
    # (например: "сон", "восстановление", "сила", "энергия", "иммунитет"
    # или произвольный текст). Может отсутствовать.
    supplement_goal = Column(String, nullable=True)

    # --- Поля подписки и доступа (Этап 1, добавлены поверх таблицы) ---
    # Тип подписки: "free" | "monthly" | "yearly" | "lifetime".
    subscription_type = Column(String, nullable=True, default="free")

    # До какой даты (UTC) действует подписка. None — нет срока:
    # либо подписки нет (free), либо она пожизненная (lifetime).
    subscription_until = Column(DateTime, nullable=True)

    # Является ли пользователь владельцем приложения (определяется по OWNER_ID).
    # Владельцу всегда доступен premium-функционал.
    is_owner = Column(Boolean, nullable=True, default=False)

    # Счётчик использованных бесплатных сканирований за текущие сутки.
    daily_scans_used = Column(Integer, nullable=True, default=0)

    # Дата (ISO "YYYY-MM-DD"), к которой относится счётчик daily_scans_used.
    # При наступлении новых суток счётчик обнуляется.
    daily_scans_date = Column(String, nullable=True)

    # --- Поля адаптивных калорий (Этап 3, добавлены поверх таблицы) ---
    # Включён ли адаптивный пересчёт дневной цели по реальной динамике веса.
    adaptive_enabled = Column(Boolean, nullable=True, default=False)

    # Вычисленное фактическое поддержание (ккал/день) по последнему пересчёту.
    # None — пока не рассчитывалось (мало данных).
    calculated_maintenance = Column(Integer, nullable=True)

    # ISO-дата ("YYYY-MM-DD") последнего авто/ручного адаптивного пересчёта.
    # Используется планировщиком для дедупликации (не чаще раза в 7 дней).
    adaptive_last_calc = Column(String, nullable=True)

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
    """
    Настройки пуш-уведомлений пользователя (одна строка на пользователя).

    ВАЖНО: теперь эта таблица используется ТОЛЬКО для приёмов пищи (meal_*)
    и вечерней сводки (daily_summary_*). Напоминания о тренировках и приёме
    спортпита переехали в отдельные таблицы TrainingReminder и
    SupplementReminder. Старые поля (training_*, supplement_reminder_enabled)
    НЕ удаляются, чтобы не потерять существующие данные пользователей.
    """

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
    # (Устаревшее: оставлено для совместимости, переехало в TrainingReminder.)
    training_reminder_enabled = Column(Boolean, default=False)
    training_time = Column(String, default="18:00")    # время тренировки "HH:MM"

    # Напоминание о приёме спортпита.
    # (Устаревшее: оставлено для совместимости, переехало в SupplementReminder.)
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

    # Вид уведомления: "breakfast" | "lunch" | "dinner" | "summary" |
    # "trainrem:{id}" | "supprem:{id}" (и устаревшие "training" / "supplement:{id}").
    kind = Column(String)

    # Дата отправки в формате ISO "YYYY-MM-DD".
    date = Column(String)

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)


class TrainingReminder(Base):
    """
    Гибкое напоминание о тренировке.

    Заменяет старые поля training_* в NotificationSettings: пользователь может
    задать несколько напоминаний, каждое со своим набором дней недели и временем.
    """

    __tablename__ = "training_reminders"

    # Идентификатор напоминания (автоинкремент).
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Владелец записи — ссылка на пользователя по Telegram ID.
    telegram_id = Column(
        BigInteger, ForeignKey("users.telegram_id"), index=True
    )

    # Дни недели в виде CSV по нумерации Python (Пн=0 .. Вс=6),
    # например "0,2,4" — понедельник, среда, пятница.
    weekdays = Column(String)

    # Время напоминания в формате "HH:MM".
    time = Column(String)

    # Включено ли напоминание.
    enabled = Column(Boolean, default=True)

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)


class SupplementReminder(Base):
    """
    Напоминание о приёме спортпита.

    Заменяет supplement_reminder_enabled в NotificationSettings и поля
    напоминаний у самих Supplement: пользователь задаёт метку (например,
    "Утро"/"Ночь"), время и список добавок к приёму (через SupplementReminderItem).
    """

    __tablename__ = "supplement_reminders"

    # Идентификатор напоминания (автоинкремент).
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Владелец записи — ссылка на пользователя по Telegram ID.
    telegram_id = Column(
        BigInteger, ForeignKey("users.telegram_id"), index=True
    )

    # Метка напоминания ("Утро" / "Ночь" / произвольный текст).
    label = Column(String)

    # Время напоминания в формате "HH:MM".
    time = Column(String)

    # Включено ли напоминание.
    enabled = Column(Boolean, default=True)

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)


class SupplementReminderItem(Base):
    """
    Связь напоминания спортпита с конкретной добавкой пользователя.

    Одно напоминание (SupplementReminder) может включать несколько добавок
    (Supplement); каждая такая связь — отдельная строка.
    """

    __tablename__ = "supplement_reminder_items"

    # Идентификатор связи (автоинкремент).
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Ссылка на напоминание спортпита.
    reminder_id = Column(
        Integer, ForeignKey("supplement_reminders.id"), index=True
    )

    # Ссылка на конкретную добавку пользователя.
    supplement_id = Column(Integer, ForeignKey("supplements.id"))


class Payment(Base):
    """
    Журнал успешных платежей за подписку.

    Сюда пишется каждая успешная оплата (Telegram Stars, Tribute и т.п.) —
    для истории и аналитики. На доступ напрямую не влияет: доступ определяется
    полями подписки в таблице users, которые обновляются при активации.
    """

    __tablename__ = "payments"

    # Идентификатор платежа (автоинкремент).
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Telegram ID плательщика (с индексом для выборок по пользователю).
    telegram_id = Column(BigInteger, index=True)

    # Платёжный провайдер: "stars" | "tribute" | "owner" (ручная выдача) и т.п.
    provider = Column(String)

    # Сумма платежа (в единицах провайдера; для Stars — количество звёзд).
    amount = Column(Float)

    # Валюта платежа (для Telegram Stars — "XTR").
    currency = Column(String)

    # Какой тариф был оплачён: "monthly" | "yearly" | "lifetime".
    subscription_type = Column(String)

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)


class ProGrant(Base):
    """
    Журнал ручной выдачи/отзыва premium-доступа владельцем приложения.

    Заполняется при выполнении команд бота /givepro и /revokepro (доступны
    строго владельцу по OWNER_ID). Служит для аудита действий владельца.
    """

    __tablename__ = "pro_grants"

    # Идентификатор записи (автоинкремент).
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Кто выдал/отозвал доступ — Telegram ID владельца (OWNER_ID).
    granted_by = Column(BigInteger)

    # Кому выдан/отозван доступ — Telegram ID целевого пользователя.
    granted_to = Column(BigInteger)

    # Действие: "give" (выдать) | "revoke" (отозвать).
    action = Column(String)

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)


class WeightLog(Base):
    """
    Замер веса пользователя за конкретный день (Этап 3).

    На один день храним одну запись (логика upsert на уровне эндпоинта):
    повторный ввод за ту же дату обновляет существующий вес. По набору
    замеров строится линия тренда и вычисляется фактическое поддержание калорий.
    """

    __tablename__ = "weight_logs"

    # Идентификатор записи (автоинкремент).
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Владелец записи — ссылка на пользователя по Telegram ID.
    telegram_id = Column(
        BigInteger, ForeignKey("users.telegram_id"), index=True
    )

    # Вес, кг.
    weight = Column(Float)

    # Дата замера в формате ISO "YYYY-MM-DD" (с индексом для выборок по периоду).
    date = Column(String, index=True)

    # Дата создания записи (UTC).
    created_at = Column(DateTime, default=datetime.utcnow)
