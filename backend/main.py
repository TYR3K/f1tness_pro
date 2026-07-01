"""Точка входа FastAPI-приложения «Calorie Mini App».

Запуск из корня проекта:
    uvicorn backend.main:app

Здесь собирается весь backend: загрузка .env, CORS, инициализация БД,
все API-маршруты и раздача статики фронтенда (монтируется ПОСЛЕДНЕЙ,
чтобы API-маршруты имели приоритет).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import date as date_cls, timedelta
from pathlib import Path

# .env загружаем в самом начале, ДО чтения переменных окружения сервисами.
from dotenv import load_dotenv

load_dotenv()

# Базовая настройка логирования, чтобы INFO-логи (включая сырой ответ модели
# из ai_service) были видны в консоли uvicorn и в логах Railway.
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("main")

# Режим отладки ИИ: при включении в ответ /food/analyze добавляется «сырой»
# ответ модели (поле debug), а в тексте ошибки — её причина. По умолчанию
# включён в dev-режиме (ALLOW_INSECURE_AUTH=1); на проде включается DEBUG_AI=1.
DEBUG_AI = os.getenv("DEBUG_AI") == "1" or os.getenv("ALLOW_INSECURE_AUTH") == "1"

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from backend import (
    adaptive,
    config,
    cycle,
    fitness,
    notifications,
    nutrition,
    payment_providers,
    subscription,
    telegram_bot,
)
from backend.ai_service import (
    AIError,
    analyze_food_image,
    calculate_food,
    estimate_workout_calories,
    generate_meal_plan,
    generate_weekly_report,
    healthy_snacks,
    parse_food_text,
    recommend_meals,
    recommend_supplements,
    regenerate_meal_item,
    suggest_food,
    suggest_supplements,
    transcribe_audio,
)
from backend.auth import get_current_user
from backend.database import get_db, init_db
from backend.models import (
    CycleLog,
    DiaryEntry,
    FavoriteFood,
    MealTemplate,
    ProgressPhoto,
    NotificationSettings,
    Supplement,
    SupplementReminder,
    SupplementReminderItem,
    TrainingReminder,
    User,
    WeightLog,
    Workout,
)
from backend.schemas import (
    AdaptiveResultOut,
    AnalyzeOut,
    CopyYesterdayIn,
    CycleLogIn,
    CycleStatusOut,
    DiaryDayOut,
    DiaryEntryIn,
    DiaryEntryOut,
    FoodCalculateIn,
    FoodCalculateOut,
    FoodSuggestIn,
    FoodSuggestOut,
    GoalCalcIn,
    GoalCalcOut,
    HealthySnacksOut,
    HistoryDay,
    HistoryOut,
    ManualFoodIn,
    MealPlanDay,
    MealPlanDish,
    MealPlanIn,
    MealPlanOut,
    MealsOut,
    NotificationSettingsIn,
    NotificationSettingsOut,
    ProfileIn,
    ProfileOut,
    ProgressListOut,
    ProgressPhotoOut,
    RecentFoodOut,
    RecentFoodsOut,
    RecommendIn,
    RecommendItem,
    RecommendOut,
    RegenerateItemIn,
    RegenerateItemOut,
    ScansRemainingOut,
    StarsInvoiceIn,
    StarsInvoiceOut,
    SubscriptionStatusOut,
    SupplementIn,
    SupplementListOut,
    SupplementOut,
    SupplementRecommendIn,
    SupplementRecommendOut,
    SupplementReminderIn,
    SupplementReminderItemOut,
    SupplementReminderOut,
    SupplementRemindersOut,
    SupplementSuggestItem,
    SupplementSuggestOut,
    TemplateApplyIn,
    TemplateItem,
    TemplateListOut,
    TemplateOut,
    TemplateSaveIn,
    TrainingReminderIn,
    TrainingReminderOut,
    TrainingRemindersOut,
    VoiceFoodOut,
    VoiceItemOut,
    WeeklyReportOut,
    WeightAddIn,
    WeightHistoryOut,
    WeightLogOut,
    WeightPoint,
    WorkoutDayOut,
    WorkoutEstimateIn,
    WorkoutEstimateOut,
    WorkoutIn,
    WorkoutOut,
    YesterdayItem,
    YesterdayOut,
)

# Допустимые типы приёмов пищи (порядок важен для группировки/вывода).
MEAL_TYPES = ("breakfast", "lunch", "dinner", "snack")

# Максимальный размер загружаемого фото (8 МБ) — защита от перерасхода памяти.
MAX_UPLOAD_BYTES = 8 * 1024 * 1024

# Максимальный размер загружаемого голосового сообщения (20 МБ) — защита памяти.
MAX_AUDIO_BYTES = 20 * 1024 * 1024


# --------------------------------------------------------------------------- #
#  Хелперы для напоминаний (дни недели <-> CSV, мягкая валидация времени)
# --------------------------------------------------------------------------- #
def _weekdays_to_csv(weekdays: list[int]) -> str:
    """Превратить список дней недели (Пн=0..Вс=6) в CSV-строку "0,2,4".

    Оставляем только корректные значения 0..6, убираем дубликаты и сортируем,
    чтобы строка в БД была предсказуемой.
    """
    cleaned = sorted({int(d) for d in weekdays if 0 <= int(d) <= 6})
    return ",".join(str(d) for d in cleaned)


def _csv_to_weekdays(csv: str | None) -> list[int]:
    """Разобрать CSV-строку дней недели обратно в список int (Пн=0..Вс=6).

    Пустые/битые элементы молча пропускаем, чтобы кривые данные в БД не валили
    выдачу всего списка напоминаний.
    """
    if not csv:
        return []
    result: list[int] = []
    for part in csv.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            value = int(part)
        except (TypeError, ValueError):
            continue
        if 0 <= value <= 6:
            result.append(value)
    return result


def _normalize_time(value: str | None) -> str:
    """Мягко привести время к виду "HH:MM".

    Принимаем "9:5" / "09:05" и т.п.; при явной ошибке формата возвращаем 400.
    Значения вне диапазона (часы 0..23, минуты 0..59) считаем ошибкой клиента.
    """
    if value is None:
        raise HTTPException(status_code=400, detail="Не указано время (HH:MM)")
    raw = str(value).strip()
    parts = raw.split(":")
    if len(parts) != 2:
        raise HTTPException(status_code=400, detail="Некорректное время, нужен формат HH:MM")
    try:
        hour = int(parts[0])
        minute = int(parts[1])
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Некорректное время, нужен формат HH:MM")
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise HTTPException(status_code=400, detail="Некорректное время, нужен формат HH:MM")
    return f"{hour:02d}:{minute:02d}"


# Жизненный цикл приложения: создаём таблицы БД при старте и запускаем
# планировщик уведомлений. Используем lifespan вместо устаревшего
# @app.on_event("startup").
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Создаём/мигрируем БД. Это критично — без таблиц приложение не работает.
    init_db()

    # Планировщик пуш-уведомлений — НЕОБЯЗАТЕЛЬНАЯ часть. Любая его ошибка
    # не должна мешать старту API, поэтому оборачиваем в try/except.
    scheduler = None
    try:
        scheduler = notifications.start_scheduler()
        if scheduler is not None:
            logger.info("Планировщик уведомлений запущен")
        else:
            logger.info("Планировщик уведомлений отключён (нет токена/ENABLE_SCHEDULER=0)")
    except Exception as exc:  # noqa: BLE001 — планировщик не должен валить старт
        logger.warning("Не удалось запустить планировщик уведомлений: %s", exc)
        scheduler = None

    try:
        yield
    finally:
        # На выходе аккуратно останавливаем планировщик, если он был запущен.
        if scheduler is not None:
            try:
                notifications.stop_scheduler(scheduler)
                logger.info("Планировщик уведомлений остановлен")
            except Exception as exc:  # noqa: BLE001
                logger.warning("Ошибка при остановке планировщика: %s", exc)


app = FastAPI(title="Calorie Mini App", lifespan=lifespan)

# CORS: разрешаем любой источник и кастомный заголовок X-Telegram-Init-Data.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
#  Служебный маршрут (без авторизации)
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health() -> dict:
    """Проверка работоспособности сервиса."""
    return {"status": "ok"}


# --------------------------------------------------------------------------- #
#  Авторизация / профиль
# --------------------------------------------------------------------------- #
@app.post("/auth/verify", response_model=ProfileOut)
def auth_verify(user: User = Depends(get_current_user)) -> User:
    """Проверка initData и upsert пользователя.

    Зависимость get_current_user уже выполняет валидацию и создание/обновление
    записи пользователя, поэтому достаточно вернуть текущего пользователя.
    """
    return user


@app.get("/profile", response_model=ProfileOut)
def get_profile(user: User = Depends(get_current_user)) -> User:
    """Вернуть профиль текущего пользователя."""
    return user


@app.post("/profile", response_model=ProfileOut)
def update_profile(
    data: ProfileIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """Обновить профиль пользователя.

    Обновляются только переданные поля. Если цель по калориям не задана
    напрямую, но известны вес, рост, возраст и пол — рассчитываем её по
    формуле Миффлина — Сан Жеора.
    """
    payload = data.model_dump(exclude_unset=True)

    # Применяем только реально переданные поля профиля.
    # Помимо базовых параметров теперь поддерживаем цель диеты, целевые БЖУ
    # и язык интерфейса/ИИ (language: "ru"|"en") — пользователь может сменить язык.
    for field in (
        "weight",
        "height",
        "age",
        "gender",
        "activity_level",
        "daily_goal_kcal",
        "diet_goal",
        "target_proteins",
        "target_fats",
        "target_carbs",
        "language",
        # Этап 3: флаг адаптивных калорий (вкл/выкл авто-пересчёт по динамике веса).
        "adaptive_enabled",
    ):
        if field in payload:
            setattr(user, field, payload[field])

    # Автоматический расчёт дневной нормы калорий, если она не указана явно.
    if (
        user.daily_goal_kcal is None
        and user.weight is not None
        and user.height is not None
        and user.age is not None
        and user.gender is not None
    ):
        # Формула Миффлина — Сан Жеора (BMR).
        bmr = 10 * user.weight + 6.25 * user.height - 5 * user.age
        bmr += 5 if user.gender == "male" else -161
        # Умножаем BMR на коэффициент активности (по умолчанию 1.375).
        activity = user.activity_level if user.activity_level else 1.375
        user.daily_goal_kcal = round(bmr * activity)

    # #7: единый ввод веса. Если в запросе пришёл валидный положительный вес —
    # дублируем его в замер веса за сегодня (upsert по user+date, как /weight/add),
    # чтобы тренд и адаптивный расчёт питались тем же единственным вводом.
    if "weight" in payload:
        try:
            weight_val = float(payload["weight"])
        except (TypeError, ValueError):
            weight_val = None
        if weight_val is not None and weight_val > 0:
            today_iso = date_cls.today().isoformat()
            existing = (
                db.query(WeightLog)
                .filter(
                    WeightLog.telegram_id == user.telegram_id,
                    WeightLog.date == today_iso,
                )
                .first()
            )
            if existing is not None:
                # Запись за сегодня уже есть — обновляем вес.
                existing.weight = weight_val
            else:
                # Замера за сегодня ещё не было — создаём новый.
                db.add(
                    WeightLog(
                        telegram_id=user.telegram_id,
                        date=today_iso,
                        weight=weight_val,
                    )
                )

    db.commit()
    db.refresh(user)
    return user


# --------------------------------------------------------------------------- #
#  Распознавание еды
# --------------------------------------------------------------------------- #
@app.post("/food/analyze", response_model=AnalyzeOut)
async def food_analyze(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AnalyzeOut:
    """Принять фото, проанализировать его ИИ и вернуть КБЖУ блюда.

    Для бесплатных пользователей действует дневной лимит сканирований:
    ПЕРЕД обращением к ИИ проверяем доступность скана (assert_scan_available
    бросит 402, если лимит исчерпан), а ПОСЛЕ успешного результата фиксируем
    использование (record_scan). Для премиум-пользователей лимита нет.
    """
    # Проверяем лимит ДО любой тяжёлой работы: не читаем файл впустую и не
    # дёргаем ИИ, если бесплатный лимит на сегодня уже исчерпан (бросит 402).
    subscription.assert_scan_available(db, user)

    # Читаем не больше лимита + 1 байт, чтобы поймать превышение размера.
    image_bytes = await file.read(MAX_UPLOAD_BYTES + 1)
    if not image_bytes:
        # Пустой файл — некорректная загрузка.
        raise HTTPException(status_code=400, detail="Пустой файл изображения")
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        # Слишком большой файл — не тратим память и не дёргаем ИИ впустую.
        raise HTTPException(status_code=413, detail="Файл слишком большой (макс. 8 МБ)")

    mime = file.content_type or "image/jpeg"
    # Язык распознавания берём из профиля пользователя ("ru" по умолчанию).
    lang = user.language or "ru"
    try:
        result = analyze_food_image(image_bytes, mime=mime, lang=lang)
    except AIError as exc:
        # Сырой ответ модели всегда пишем в лог сервера (виден в логах Railway).
        logger.warning(
            "food/analyze: %s | finish=%s refusal=%s raw=%s",
            exc, exc.finish_reason, exc.refusal, (exc.raw or "")[:600],
        )
        # Пользователю — понятный текст; при DEBUG_AI добавляем причину и сырой ответ.
        detail = "Не удалось распознать еду на фото. Попробуйте кадр чётче и при хорошем освещении."
        if DEBUG_AI:
            detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
        raise HTTPException(status_code=502, detail=detail)
    except RuntimeError as exc:
        # Прочие сбои сервиса (нет ключа, недоступность OpenAI и т.п.).
        logger.warning("food/analyze: %s", exc)
        detail = "Сервис распознавания временно недоступен. Попробуйте позже."
        if DEBUG_AI:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail)

    # Скан успешно выполнен — фиксируем использование (для премиум ничего не делает).
    subscription.record_scan(db, user)

    return AnalyzeOut(
        dish_name=result["dish_name"],
        calories=result["calories"],
        proteins=result["proteins"],
        fats=result["fats"],
        carbs=result["carbs"],
        note=result["note"],
        # Новые поля оценки порции — берём из результата, если модель их вернула.
        weight_grams=result.get("weight_grams"),
        confidence=result.get("confidence"),
        # debug отдаём только в режиме отладки, чтобы не светить «сырой» ответ в проде.
        debug=result.get("_debug") if DEBUG_AI else None,
    )


# --------------------------------------------------------------------------- #
#  Голосовой ввод еды (Этап 2): речь -> текст (Whisper) -> разбор блюд (GPT)
# --------------------------------------------------------------------------- #
@app.post("/food/voice", response_model=VoiceFoodOut)
async def food_voice(
    file: UploadFile = File(...),
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> VoiceFoodOut:
    """Принять голосовое сообщение, распознать речь и разобрать блюда с КБЖУ.

    Премиум-функция (доступ только через require_premium, иначе 402).
    Шаги: читаем аудио с лимитом размера -> Whisper переводит речь в текст ->
    GPT извлекает блюда с количеством, оценивает КБЖУ и определяет приём пищи.
    Язык распознавания/разбора берём из профиля пользователя ("ru" по умолчанию).
    Запись в дневник здесь НЕ создаём — клиент сам решает, что добавить.
    """
    # Читаем не больше лимита + 1 байт, чтобы поймать превышение размера.
    audio_bytes = await file.read(MAX_AUDIO_BYTES + 1)
    if not audio_bytes:
        # Пустой файл — некорректная загрузка.
        raise HTTPException(status_code=400, detail="Пустой аудиофайл")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        # Слишком большой файл — не тратим память и не дёргаем ИИ впустую.
        raise HTTPException(status_code=413, detail="Аудиофайл слишком большой (макс. 20 МБ)")

    # Язык распознавания берём из профиля пользователя ("ru" по умолчанию).
    lang = user.language or "ru"
    # Имя файла нужно Whisper для определения формата; даём дефолт, если пусто.
    filename = file.filename or "audio.ogg"

    try:
        # 1) Речь -> текст (Whisper).
        text = transcribe_audio(audio_bytes, filename, lang)
        # 2) Текст -> блюда с количеством, КБЖУ и определением приёма пищи (GPT).
        parsed = parse_food_text(text, lang)
    except AIError as exc:
        # Сырой ответ модели всегда пишем в лог сервера (виден в логах Railway).
        logger.warning(
            "food/voice: %s | finish=%s refusal=%s raw=%s",
            exc, exc.finish_reason, exc.refusal, (exc.raw or "")[:600],
        )
        # Пользователю — понятный текст; при DEBUG_AI добавляем причину и сырой ответ.
        detail = "Не удалось распознать еду из голосового сообщения. Попробуйте сказать чётче."
        if DEBUG_AI:
            detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
        raise HTTPException(status_code=502, detail=detail)
    except RuntimeError as exc:
        # Прочие сбои сервиса (нет ключа, недоступность OpenAI и т.п.).
        logger.warning("food/voice: %s", exc)
        detail = "Сервис распознавания речи временно недоступен. Попробуйте позже."
        if DEBUG_AI:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail)

    # Собираем список блюд; «мусорные» элементы parse_food_text уже отфильтровал.
    items = [
        VoiceItemOut(
            dish_name=it["dish_name"],
            calories=it["calories"],
            proteins=it["proteins"],
            fats=it["fats"],
            carbs=it["carbs"],
            # Количество и единица измерения (parse_food_text теперь их отдаёт).
            quantity=it.get("quantity"),
            unit=it.get("unit"),
        )
        for it in parsed.get("items", [])
    ]
    return VoiceFoodOut(
        transcript=text,
        meal_type=parsed.get("meal_type"),
        items=items,
    )


# --------------------------------------------------------------------------- #
#  Дневник питания
# --------------------------------------------------------------------------- #
@app.post("/diary/add", response_model=DiaryEntryOut)
def diary_add(
    entry: DiaryEntryIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DiaryEntry:
    """Добавить запись в дневник текущего пользователя."""
    db_entry = DiaryEntry(
        telegram_id=user.telegram_id,
        date=entry.date,
        meal_type=entry.meal_type,
        dish_name=entry.dish_name,
        calories=entry.calories,
        proteins=entry.proteins,
        fats=entry.fats,
        carbs=entry.carbs,
        # Количество и единица измерения (канонический ключ) — опциональны.
        quantity=entry.quantity,
        unit=entry.unit,
    )
    db.add(db_entry)
    db.commit()
    db.refresh(db_entry)
    return db_entry


@app.get("/diary/{date}", response_model=DiaryDayOut)
def diary_day(
    date: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DiaryDayOut:
    """Вернуть все записи за день, сгруппированные по приёмам пищи, и итоги."""
    entries = (
        db.query(DiaryEntry)
        .filter(DiaryEntry.telegram_id == user.telegram_id, DiaryEntry.date == date)
        .order_by(DiaryEntry.created_at.asc(), DiaryEntry.id.asc())
        .all()
    )

    # Группируем записи по типу приёма пищи.
    grouped: dict[str, list[DiaryEntryOut]] = {mt: [] for mt in MEAL_TYPES}
    total_calories = 0
    total_proteins = 0.0
    total_fats = 0.0
    total_carbs = 0.0

    for e in entries:
        out = DiaryEntryOut.model_validate(e)
        # Неизвестные типы относим к перекусам, чтобы запись не потерялась.
        bucket = e.meal_type if e.meal_type in grouped else "snack"
        grouped[bucket].append(out)
        total_calories += e.calories or 0
        total_proteins += e.proteins or 0.0
        total_fats += e.fats or 0.0
        total_carbs += e.carbs or 0.0

    meals = MealsOut(**grouped)

    # Сожжённые за день калории — сумма по тренировкам этой даты.
    workouts = (
        db.query(Workout)
        .filter(Workout.telegram_id == user.telegram_id, Workout.date == date)
        .all()
    )
    total_burned = sum((w.calories_burned or 0) for w in workouts)
    # Чистые калории = съедено − сожжено (может быть отрицательным).
    net_calories = total_calories - total_burned

    return DiaryDayOut(
        date=date,
        daily_goal_kcal=user.daily_goal_kcal,
        total_calories=total_calories,
        total_proteins=round(total_proteins, 1),
        total_fats=round(total_fats, 1),
        total_carbs=round(total_carbs, 1),
        total_burned=total_burned,
        net_calories=net_calories,
        meals=meals,
    )


@app.delete("/diary/{entry_id}")
def diary_delete(
    entry_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Удалить запись дневника, если она принадлежит текущему пользователю."""
    entry = db.query(DiaryEntry).filter(DiaryEntry.id == entry_id).first()
    if entry is None or entry.telegram_id != user.telegram_id:
        # Чужую или несуществующую запись прячем за 404.
        raise HTTPException(status_code=404, detail="Запись не найдена")

    db.delete(entry)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- #
#  История
# --------------------------------------------------------------------------- #
@app.get("/history", response_model=HistoryOut)
def history(
    days: int = 30,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> HistoryOut:
    """Вернуть суммарные калории по дням за последние <days> календарных дней.

    В ответ попадают только дни, по которым есть записи; список отсортирован
    по возрастанию даты.
    """
    # Защита от некорректных значений параметра.
    if days < 1:
        days = 1

    today = date_cls.today()
    start = today - timedelta(days=days - 1)
    start_str = start.isoformat()
    end_str = today.isoformat()

    rows = (
        db.query(DiaryEntry)
        .filter(
            DiaryEntry.telegram_id == user.telegram_id,
            DiaryEntry.date >= start_str,
            DiaryEntry.date <= end_str,
        )
        .all()
    )

    # Суммируем калории по каждой дате.
    totals: dict[str, int] = {}
    for r in rows:
        totals[r.date] = totals.get(r.date, 0) + (r.calories or 0)

    day_items = [
        HistoryDay(date=d, total_calories=totals[d]) for d in sorted(totals.keys())
    ]

    return HistoryOut(goal=user.daily_goal_kcal, days=day_items)


# --------------------------------------------------------------------------- #
#  Тренировки (расход калорий)
# --------------------------------------------------------------------------- #
@app.post("/workout/add", response_model=WorkoutOut)
def workout_add(
    data: WorkoutIn,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> Workout:
    """Добавить тренировку текущего пользователя."""
    db_workout = Workout(
        telegram_id=user.telegram_id,
        date=data.date,
        type=data.type,
        duration_min=data.duration_min,
        calories_burned=data.calories_burned,
        description=data.description,
    )
    db.add(db_workout)
    db.commit()
    db.refresh(db_workout)
    return db_workout


@app.get("/workout/{date}", response_model=WorkoutDayOut)
def workout_day(
    date: str,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> WorkoutDayOut:
    """Вернуть тренировки за дату и суммарный расход калорий."""
    workouts = (
        db.query(Workout)
        .filter(Workout.telegram_id == user.telegram_id, Workout.date == date)
        .order_by(Workout.created_at.asc(), Workout.id.asc())
        .all()
    )
    items = [WorkoutOut.model_validate(w) for w in workouts]
    total_burned = sum((w.calories_burned or 0) for w in workouts)
    return WorkoutDayOut(date=date, workouts=items, total_burned=total_burned)


@app.delete("/workout/{workout_id}")
def workout_delete(
    workout_id: int,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> dict:
    """Удалить тренировку, если она принадлежит текущему пользователю."""
    workout = db.query(Workout).filter(Workout.id == workout_id).first()
    if workout is None or workout.telegram_id != user.telegram_id:
        # Чужую или несуществующую тренировку прячем за 404.
        raise HTTPException(status_code=404, detail="Тренировка не найдена")

    db.delete(workout)
    db.commit()
    return {"ok": True}


@app.post("/workout/estimate", response_model=WorkoutEstimateOut)
def workout_estimate(
    data: WorkoutEstimateIn,
    user: User = Depends(subscription.require_premium),
) -> WorkoutEstimateOut:
    """Оценить расход калорий за тренировку по типу и длительности.

    Для типа "other" со свободным описанием расчёт ведёт ИИ по тексту
    активности (реалистичные калории + MET). Для остальных типов (и для
    "other" без описания) — по таблице MET с учётом веса пользователя (если он
    указан в профиле, иначе берётся усреднённое значение внутри fitness-модуля).
    """
    # Для произвольной активности с описанием — AI-оценка калорий по тексту.
    if data.type == "other" and (data.description or "").strip():
        try:
            result = estimate_workout_calories(
                data.description,
                data.duration_min,
                user.weight,
                lang=user.language or "ru",
            )
        except AIError as exc:
            logger.warning(
                "workout/estimate: %s | finish=%s raw=%s",
                exc, exc.finish_reason, (exc.raw or "")[:600],
            )
            detail = "Не удалось оценить калории. Попробуйте позже."
            if DEBUG_AI:
                detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
            raise HTTPException(status_code=502, detail=detail)
        except RuntimeError as exc:
            logger.warning("workout/estimate: %s", exc)
            detail = "Сервис оценки калорий временно недоступен. Попробуйте позже."
            if DEBUG_AI:
                detail = str(exc)
            raise HTTPException(status_code=502, detail=detail)
        return WorkoutEstimateOut(
            calories_burned=result["calories"], met=result["met"]
        )

    kcal, met = fitness.estimate_calories_burned(
        data.type, data.duration_min, user.weight
    )
    return WorkoutEstimateOut(calories_burned=kcal, met=met)


# --------------------------------------------------------------------------- #
#  Еда: ручной ввод, недавние блюда, рекомендации
# --------------------------------------------------------------------------- #
@app.post("/food/manual", response_model=DiaryEntryOut)
def food_manual(
    data: ManualFoodIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DiaryEntry:
    """Добавить блюдо вручную: создать запись дневника и сохранить его
    в «избранное/недавние» (FavoriteFood) для быстрого повторного добавления."""
    # 1) Запись в дневник питания.
    db_entry = DiaryEntry(
        telegram_id=user.telegram_id,
        date=data.date,
        meal_type=data.meal_type,
        dish_name=data.dish_name,
        calories=data.calories,
        proteins=data.proteins,
        fats=data.fats,
        carbs=data.carbs,
        # Количество и единица измерения (канонический ключ) — опциональны.
        quantity=data.quantity,
        unit=data.unit,
    )
    db.add(db_entry)

    # 2) Сохраняем блюдо в «недавние», чтобы его можно было повторно выбрать.
    favorite = FavoriteFood(
        telegram_id=user.telegram_id,
        dish_name=data.dish_name,
        calories=data.calories,
        proteins=data.proteins,
        fats=data.fats,
        carbs=data.carbs,
    )
    db.add(favorite)

    db.commit()
    db.refresh(db_entry)
    return db_entry


@app.get("/food/recent", response_model=RecentFoodsOut)
def food_recent(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RecentFoodsOut:
    """Вернуть недавно добавленные блюда пользователя без повторов по названию."""
    rows = (
        db.query(FavoriteFood)
        .filter(FavoriteFood.telegram_id == user.telegram_id)
        .order_by(FavoriteFood.created_at.desc(), FavoriteFood.id.desc())
        .limit(100)
        .all()
    )

    # Дедупликация по названию блюда — оставляем первое (самое свежее) вхождение.
    seen: set[str] = set()
    items: list[RecentFoodOut] = []
    for r in rows:
        key = (r.dish_name or "").strip().lower()
        if key in seen:
            continue
        seen.add(key)
        items.append(
            RecentFoodOut(
                dish_name=r.dish_name,
                calories=r.calories or 0,
                proteins=r.proteins or 0.0,
                fats=r.fats or 0.0,
                carbs=r.carbs or 0.0,
            )
        )
        # Возвращаем примерно 20 уникальных недавних блюд.
        if len(items) >= 20:
            break

    return RecentFoodsOut(items=items)


@app.post("/food/recommend", response_model=RecommendOut)
def food_recommend(
    data: RecommendIn,
    user: User = Depends(subscription.require_premium),
) -> RecommendOut:
    """Подобрать 2-3 блюда под оставшиеся на день КБЖУ с помощью ИИ."""
    # Если цель диеты не передана явно — берём из профиля пользователя.
    diet_goal = data.diet_goal if data.diet_goal is not None else getattr(user, "diet_goal", None)

    try:
        result = recommend_meals(
            remaining_calories=data.remaining_calories,
            remaining_proteins=data.remaining_proteins,
            remaining_fats=data.remaining_fats,
            remaining_carbs=data.remaining_carbs,
            diet_goal=diet_goal,
            time_of_day=data.time_of_day,
            # Язык рекомендаций берём из профиля пользователя ("ru" по умолчанию).
            lang=user.language or "ru",
        )
    except AIError as exc:
        logger.warning(
            "food/recommend: %s | finish=%s raw=%s",
            exc, exc.finish_reason, (exc.raw or "")[:600],
        )
        detail = "Не удалось подобрать рекомендации. Попробуйте позже."
        if DEBUG_AI:
            detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
        raise HTTPException(status_code=502, detail=detail)
    except RuntimeError as exc:
        logger.warning("food/recommend: %s", exc)
        detail = "Сервис рекомендаций временно недоступен. Попробуйте позже."
        if DEBUG_AI:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail)

    suggestions = [
        RecommendItem(
            dish_name=s["dish_name"],
            calories=s["calories"],
            proteins=s["proteins"],
            fats=s["fats"],
            carbs=s["carbs"],
            reason=s["reason"],
        )
        for s in result.get("suggestions", [])
    ]
    return RecommendOut(suggestions=suggestions)


# --------------------------------------------------------------------------- #
#  Умный расчёт КБЖУ по названию/количеству (базовый дневник — БЕЗ премиума)
# --------------------------------------------------------------------------- #
@app.post("/food/calculate", response_model=FoodCalculateOut)
def food_calculate(
    data: FoodCalculateIn,
    user: User = Depends(get_current_user),
) -> FoodCalculateOut:
    """Оценить ИТОГОВЫЕ КБЖУ продукта в заданном количестве и единице (ИИ).

    Базовая функция дневника — доступна без премиума (get_current_user).
    Если количество/единица не заданы, ИИ подставляет разумное значение по
    умолчанию (1 шт/порция или типичные 100 г) и возвращает применённые
    quantity/unit. Язык расчёта берём из профиля пользователя ("ru" по умолчанию).
    При сбое ИИ отдаём 502 (как в /food/recommend).
    """
    try:
        result = calculate_food(
            data.name,
            data.quantity,
            data.unit,
            lang=user.language or "ru",
        )
    except AIError as exc:
        logger.warning(
            "food/calculate: %s | finish=%s raw=%s",
            exc, exc.finish_reason, (exc.raw or "")[:600],
        )
        detail = "Не удалось рассчитать калорийность. Попробуйте позже."
        if DEBUG_AI:
            detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
        raise HTTPException(status_code=502, detail=detail)
    except RuntimeError as exc:
        logger.warning("food/calculate: %s", exc)
        detail = "Сервис расчёта калорийности временно недоступен. Попробуйте позже."
        if DEBUG_AI:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail)

    return FoodCalculateOut(**result)


# --------------------------------------------------------------------------- #
#  «Вчерашние» блюда для быстрого повтора (базовый дневник — БЕЗ премиума)
# --------------------------------------------------------------------------- #
@app.get("/food/yesterday", response_model=YesterdayOut)
def food_yesterday(
    date: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> YesterdayOut:
    """Вернуть блюда, залогированные пользователем во «вчерашний» день.

    Базовая функция дневника — доступна без премиума (get_current_user).
    ref — переданная дата (если валидна) либо сегодня; «вчера» = ref - 1 день.
    Дедупликация по нижнему регистру названия: оставляем ПЕРВОЕ вхождение
    (самое раннее по времени добавления).
    """
    # Опорная дата: переданная (если валидна) либо сегодняшняя.
    try:
        ref = date_cls.fromisoformat(date) if date else date_cls.today()
    except (TypeError, ValueError):
        ref = date_cls.today()
    yesterday = (ref - timedelta(days=1)).isoformat()

    rows = (
        db.query(DiaryEntry)
        .filter(
            DiaryEntry.telegram_id == user.telegram_id,
            DiaryEntry.date == yesterday,
        )
        .order_by(DiaryEntry.created_at.asc(), DiaryEntry.id.asc())
        .all()
    )

    # Дедупликация по названию блюда — оставляем первое (самое раннее) вхождение.
    seen: set[str] = set()
    items: list[YesterdayItem] = []
    for r in rows:
        key = (r.dish_name or "").strip().lower()
        if key in seen:
            continue
        seen.add(key)
        items.append(
            YesterdayItem(
                dish_name=r.dish_name,
                quantity=r.quantity,
                unit=r.unit,
                calories=r.calories or 0,
                proteins=r.proteins or 0.0,
                fats=r.fats or 0.0,
                carbs=r.carbs or 0.0,
                meal_type=r.meal_type,
            )
        )

    return YesterdayOut(items=items)


# --------------------------------------------------------------------------- #
#  Спортивное питание / добавки
# --------------------------------------------------------------------------- #
@app.post("/supplement/add", response_model=SupplementOut)
def supplement_add(
    data: SupplementIn,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> Supplement:
    """Добавить запись о приёме спортивного питания / добавки."""
    db_supp = Supplement(
        telegram_id=user.telegram_id,
        name=data.name,
        # Тип убран из UI — терпим его отсутствие (по умолчанию пустая строка).
        type=data.type or "",
        dosage=data.dosage,
        intake_time=data.intake_time,
        reminder_enabled=data.reminder_enabled,
    )
    db.add(db_supp)
    db.commit()
    db.refresh(db_supp)
    return db_supp


@app.get("/supplement/list", response_model=SupplementListOut)
def supplement_list(
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> SupplementListOut:
    """Вернуть список добавок пользователя."""
    rows = (
        db.query(Supplement)
        .filter(Supplement.telegram_id == user.telegram_id)
        .order_by(Supplement.created_at.asc(), Supplement.id.asc())
        .all()
    )
    items = [SupplementOut.model_validate(s) for s in rows]
    return SupplementListOut(items=items)


@app.delete("/supplement/{supplement_id}")
def supplement_delete(
    supplement_id: int,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> dict:
    """Удалить добавку, если она принадлежит текущему пользователю."""
    supp = db.query(Supplement).filter(Supplement.id == supplement_id).first()
    if supp is None or supp.telegram_id != user.telegram_id:
        # Чужую или несуществующую запись прячем за 404.
        raise HTTPException(status_code=404, detail="Добавка не найдена")

    db.delete(supp)
    db.commit()
    return {"ok": True}


@app.get("/supplement/suggest", response_model=SupplementSuggestOut)
def supplement_suggest(
    user: User = Depends(subscription.require_premium),
) -> SupplementSuggestOut:
    """Подсказать базовые добавки под цель пользователя с помощью ИИ.

    Важно: это НЕ медицинская рекомендация — об этом сообщаем в disclaimer.
    """
    diet_goal = getattr(user, "diet_goal", None)
    try:
        # Язык подсказок берём из профиля пользователя ("ru" по умолчанию).
        result = suggest_supplements(diet_goal, lang=user.language or "ru")
    except AIError as exc:
        logger.warning(
            "supplement/suggest: %s | finish=%s raw=%s",
            exc, exc.finish_reason, (exc.raw or "")[:600],
        )
        detail = "Не удалось получить подсказки по добавкам. Попробуйте позже."
        if DEBUG_AI:
            detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
        raise HTTPException(status_code=502, detail=detail)
    except RuntimeError as exc:
        logger.warning("supplement/suggest: %s", exc)
        detail = "Сервис подсказок временно недоступен. Попробуйте позже."
        if DEBUG_AI:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail)

    suggestions = [
        SupplementSuggestItem(
            name=s["name"],
            dosage=s["dosage"],
            note=s["note"],
        )
        for s in result.get("suggestions", [])
    ]
    return SupplementSuggestOut(
        suggestions=suggestions,
        disclaimer="Не является медицинской рекомендацией, проконсультируйтесь со специалистом",
    )


# --------------------------------------------------------------------------- #
#  Расчёт цели (калории и БЖУ)
# --------------------------------------------------------------------------- #
@app.post("/goal/calculate", response_model=GoalCalcOut)
def goal_calculate(
    data: GoalCalcIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GoalCalcOut:
    """Рассчитать дневную норму калорий и БЖУ.

    Недостающие во входных данных параметры берём из профиля пользователя.
    Результат сохраняем в профиль (цель, БЖУ, цель диеты, при наличии — пол
    и активность) и возвращаем клиенту.
    """
    # Берём значения из тела запроса, недостающие подставляем из профиля.
    weight = data.weight if data.weight is not None else user.weight
    height = data.height if data.height is not None else user.height
    age = data.age if data.age is not None else user.age
    gender = data.gender if data.gender is not None else user.gender
    activity_level = (
        data.activity_level if data.activity_level is not None else user.activity_level
    )
    diet_goal = (
        data.diet_goal if data.diet_goal is not None else getattr(user, "diet_goal", None)
    )

    try:
        result = nutrition.compute_goal(
            weight=weight,
            height=height,
            age=age,
            gender=gender,
            activity_level=activity_level,
            diet_goal=diet_goal,
        )
    except ValueError as exc:
        # Не хватает исходных данных (вес/рост/возраст) — это ошибка клиента.
        raise HTTPException(status_code=400, detail=str(exc))

    # Сохраняем рассчитанные значения в профиль пользователя.
    user.daily_goal_kcal = result["daily_goal_kcal"]
    user.target_proteins = result["target_proteins"]
    user.target_fats = result["target_fats"]
    user.target_carbs = result["target_carbs"]
    user.diet_goal = result["diet_goal"]
    # Пол и активность сохраняем, только если они были вычислены/переданы.
    if gender is not None:
        user.gender = gender
    if activity_level is not None:
        user.activity_level = activity_level

    db.commit()
    db.refresh(user)

    return GoalCalcOut(
        daily_goal_kcal=result["daily_goal_kcal"],
        target_proteins=result["target_proteins"],
        target_fats=result["target_fats"],
        target_carbs=result["target_carbs"],
        diet_goal=result["diet_goal"],
        bmr=result["bmr"],
        tdee=result["tdee"],
    )


# --------------------------------------------------------------------------- #
#  Настройки уведомлений
# --------------------------------------------------------------------------- #
def _get_or_create_notification_settings(
    db: Session, telegram_id: int
) -> NotificationSettings:
    """Вернуть настройки уведомлений пользователя, создав их при отсутствии."""
    settings = (
        db.query(NotificationSettings)
        .filter(NotificationSettings.telegram_id == telegram_id)
        .first()
    )
    if settings is None:
        # Создаём строку с дефолтами (значения по умолчанию заданы в модели).
        settings = NotificationSettings(telegram_id=telegram_id)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


def _notification_settings_out(settings: NotificationSettings) -> NotificationSettingsOut:
    """Собрать NotificationSettingsOut из ORM + распарсить список времён приёмов.

    meal_times НЕ маппится авто-магией из ORM (в БД это JSON-строка
    meal_times_json), поэтому заполняем его вручную с защитой от битого JSON.
    """
    out = NotificationSettingsOut.model_validate(settings)
    try:
        parsed = json.loads(getattr(settings, "meal_times_json", None) or "[]")
        # На всякий случай проверяем, что это именно список строк.
        if isinstance(parsed, list):
            out.meal_times = [str(t) for t in parsed]
        else:
            out.meal_times = []
    except Exception:
        # Битый/некорректный JSON — отдаём пустой список.
        out.meal_times = []
    return out


@app.get("/notifications/settings", response_model=NotificationSettingsOut)
def notifications_get(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationSettingsOut:
    """Вернуть настройки уведомлений (создав их с дефолтами при первом запросе)."""
    settings = _get_or_create_notification_settings(db, user.telegram_id)
    return _notification_settings_out(settings)


@app.post("/notifications/settings", response_model=NotificationSettingsOut)
def notifications_update(
    data: NotificationSettingsIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationSettingsOut:
    """Обновить настройки уведомлений (upsert), меняя только переданные поля."""
    settings = _get_or_create_notification_settings(db, user.telegram_id)

    payload = data.model_dump(exclude_unset=True)
    # meal_times обрабатываем отдельно: в БД это JSON-строка meal_times_json.
    meal_times = payload.pop("meal_times", None)
    for field, value in payload.items():
        # Применяем только реально переданные поля, чтобы не сбросить остальные.
        setattr(settings, field, value)

    # Если пришёл список времён — очищаем "HH:MM" и сериализуем в JSON.
    if isinstance(meal_times, list):
        cleaned = [_normalize_time(t) for t in meal_times if str(t or "").strip()]
        settings.meal_times_json = json.dumps(cleaned)

    db.commit()
    db.refresh(settings)
    return _notification_settings_out(settings)


# --------------------------------------------------------------------------- #
#  Напоминания о тренировках (новые таблицы TrainingReminder)
# --------------------------------------------------------------------------- #
@app.get("/reminders/training", response_model=TrainingRemindersOut)
def training_reminders_list(
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> TrainingRemindersOut:
    """Вернуть список напоминаний о тренировках текущего пользователя.

    Дни недели хранятся в БД как CSV (Пн=0..Вс=6) и разворачиваются в List[int].
    """
    rows = (
        db.query(TrainingReminder)
        .filter(TrainingReminder.telegram_id == user.telegram_id)
        .order_by(TrainingReminder.created_at.asc(), TrainingReminder.id.asc())
        .all()
    )
    items = [
        TrainingReminderOut(
            id=r.id,
            weekdays=_csv_to_weekdays(r.weekdays),
            time=r.time,
            enabled=bool(r.enabled),
        )
        for r in rows
    ]
    return TrainingRemindersOut(items=items)


@app.post("/reminders/training", response_model=TrainingReminderOut)
def training_reminder_add(
    data: TrainingReminderIn,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> TrainingReminderOut:
    """Создать напоминание о тренировке.

    Дни недели (List[int]) сворачиваем в CSV, время мягко валидируем как HH:MM.
    """
    time_str = _normalize_time(data.time)
    weekdays_csv = _weekdays_to_csv(data.weekdays)

    reminder = TrainingReminder(
        telegram_id=user.telegram_id,
        weekdays=weekdays_csv,
        time=time_str,
        enabled=bool(data.enabled),
    )
    db.add(reminder)
    db.commit()
    db.refresh(reminder)

    return TrainingReminderOut(
        id=reminder.id,
        weekdays=_csv_to_weekdays(reminder.weekdays),
        time=reminder.time,
        enabled=bool(reminder.enabled),
    )


@app.delete("/reminders/training/{reminder_id}")
def training_reminder_delete(
    reminder_id: int,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> dict:
    """Удалить напоминание о тренировке, если оно принадлежит пользователю."""
    reminder = (
        db.query(TrainingReminder)
        .filter(TrainingReminder.id == reminder_id)
        .first()
    )
    if reminder is None or reminder.telegram_id != user.telegram_id:
        # Чужое или несуществующее напоминание прячем за 404.
        raise HTTPException(status_code=404, detail="Напоминание не найдено")

    db.delete(reminder)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- #
#  Напоминания о приёме спортпита (новые таблицы SupplementReminder/Item)
# --------------------------------------------------------------------------- #
def _build_supplement_reminder_out(
    db: Session, reminder: SupplementReminder, telegram_id: int
) -> SupplementReminderOut:
    """Собрать схему ответа для напоминания спортпита с названиями добавок.

    Названия подтягиваем через SupplementReminderItem -> Supplement, оставляя
    только добавки, принадлежащие пользователю (чужие связи игнорируем).
    """
    items = (
        db.query(SupplementReminderItem)
        .filter(SupplementReminderItem.reminder_id == reminder.id)
        .all()
    )
    supplements: list[SupplementReminderItemOut] = []
    for it in items:
        supp = (
            db.query(Supplement)
            .filter(
                Supplement.id == it.supplement_id,
                Supplement.telegram_id == telegram_id,
            )
            .first()
        )
        if supp is not None:
            supplements.append(
                SupplementReminderItemOut(id=supp.id, name=supp.name)
            )

    return SupplementReminderOut(
        id=reminder.id,
        label=reminder.label,
        time=reminder.time,
        enabled=bool(reminder.enabled),
        supplements=supplements,
    )


@app.get("/reminders/supplement", response_model=SupplementRemindersOut)
def supplement_reminders_list(
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> SupplementRemindersOut:
    """Вернуть напоминания о приёме спортпита с названиями привязанных добавок."""
    rows = (
        db.query(SupplementReminder)
        .filter(SupplementReminder.telegram_id == user.telegram_id)
        .order_by(SupplementReminder.created_at.asc(), SupplementReminder.id.asc())
        .all()
    )
    items = [
        _build_supplement_reminder_out(db, r, user.telegram_id) for r in rows
    ]
    return SupplementRemindersOut(items=items)


@app.post("/reminders/supplement", response_model=SupplementReminderOut)
def supplement_reminder_add(
    data: SupplementReminderIn,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> SupplementReminderOut:
    """Создать напоминание о приёме спортпита.

    Для каждого supplement_id, ПРИНАДЛЕЖАЩЕГО пользователю, создаём связь
    SupplementReminderItem; чужие/несуществующие добавки молча пропускаем.
    Время мягко валидируем как HH:MM.
    """
    time_str = _normalize_time(data.time)

    reminder = SupplementReminder(
        telegram_id=user.telegram_id,
        # Метка убрана из UI — терпим её отсутствие (по умолчанию пустая строка).
        label=data.label or "",
        time=time_str,
        enabled=bool(data.enabled),
    )
    db.add(reminder)
    # flush, чтобы получить reminder.id до создания связей.
    db.flush()

    # Привязываем только добавки, реально принадлежащие пользователю.
    for supplement_id in data.supplement_ids or []:
        supp = (
            db.query(Supplement)
            .filter(
                Supplement.id == supplement_id,
                Supplement.telegram_id == user.telegram_id,
            )
            .first()
        )
        if supp is None:
            continue
        db.add(
            SupplementReminderItem(
                reminder_id=reminder.id,
                supplement_id=supp.id,
            )
        )

    db.commit()
    db.refresh(reminder)

    return _build_supplement_reminder_out(db, reminder, user.telegram_id)


@app.delete("/reminders/supplement/{reminder_id}")
def supplement_reminder_delete(
    reminder_id: int,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> dict:
    """Удалить напоминание о спортпите вместе со связанными элементами."""
    reminder = (
        db.query(SupplementReminder)
        .filter(SupplementReminder.id == reminder_id)
        .first()
    )
    if reminder is None or reminder.telegram_id != user.telegram_id:
        # Чужое или несуществующее напоминание прячем за 404.
        raise HTTPException(status_code=404, detail="Напоминание не найдено")

    # Сначала удаляем связанные элементы, затем сам reminder.
    db.query(SupplementReminderItem).filter(
        SupplementReminderItem.reminder_id == reminder.id
    ).delete(synchronize_session=False)
    db.delete(reminder)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- #
#  Персональные рекомендации по спортпиту (ИИ, с учётом тренировок и цели)
# --------------------------------------------------------------------------- #
@app.post("/supplement/recommend", response_model=SupplementRecommendOut)
def supplement_recommend(
    data: SupplementRecommendIn,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> SupplementRecommendOut:
    """Персональные рекомендации по спортпиту от ИИ.

    Учитываем цель улучшения (improvement_goal), частоту/тип тренировок за
    последние 14 дней и цель диеты из профиля. Выбранную цель улучшения
    сохраняем в профиль (user.supplement_goal). НЕ медицинская рекомендация.
    """
    # Сохраняем выбранную цель улучшения в профиль (для будущих советов).
    user.supplement_goal = data.improvement_goal
    db.commit()

    # Считаем тренировки за последние 14 дней и собираем их типы.
    today = date_cls.today()
    start = today - timedelta(days=13)  # 14 календарных дней включительно
    start_str = start.isoformat()
    end_str = today.isoformat()

    workouts = (
        db.query(Workout)
        .filter(
            Workout.telegram_id == user.telegram_id,
            Workout.date >= start_str,
            Workout.date <= end_str,
        )
        .all()
    )
    training_count = len(workouts)
    # Уникальные типы тренировок (без пустых значений), порядок не важен.
    workout_types = sorted(
        {(w.type or "").strip() for w in workouts if (w.type or "").strip()}
    )

    diet_goal = getattr(user, "diet_goal", None)

    try:
        result = recommend_supplements(
            improvement_goal=data.improvement_goal,
            training_count=training_count,
            workout_types=workout_types,
            diet_goal=diet_goal,
            # Язык рекомендаций берём из профиля пользователя ("ru" по умолчанию).
            lang=user.language or "ru",
        )
    except AIError as exc:
        logger.warning(
            "supplement/recommend: %s | finish=%s raw=%s",
            exc, exc.finish_reason, (exc.raw or "")[:600],
        )
        detail = "Не удалось получить рекомендации по добавкам. Попробуйте позже."
        if DEBUG_AI:
            detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
        raise HTTPException(status_code=502, detail=detail)
    except RuntimeError as exc:
        logger.warning("supplement/recommend: %s", exc)
        detail = "Сервис рекомендаций временно недоступен. Попробуйте позже."
        if DEBUG_AI:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail)

    suggestions = [
        SupplementSuggestItem(
            name=s["name"],
            dosage=s["dosage"],
            note=s["note"],
        )
        for s in result.get("suggestions", [])
    ]
    return SupplementRecommendOut(
        suggestions=suggestions,
        disclaimer="Не является медицинской рекомендацией, проконсультируйтесь со специалистом",
        training_count=training_count,
        improvement_goal=data.improvement_goal,
    )


# --------------------------------------------------------------------------- #
#  Подписка и доступ (Этап 1): статус, лимит сканов, оплата Stars, вебхуки
# --------------------------------------------------------------------------- #
@app.get("/subscription/status", response_model=SubscriptionStatusOut)
def subscription_status(
    user: User = Depends(get_current_user),
) -> SubscriptionStatusOut:
    """Вернуть статус подписки текущего пользователя и доступные тарифы.

    is_premium вычисляется ТОЛЬКО на бэкенде (owner / lifetime / активная дата).
    Эндпоинт бесплатный — нужен в т.ч. для показа экрана оформления подписки.
    """
    return SubscriptionStatusOut(
        subscription_type=user.subscription_type or "free",
        subscription_until=(
            user.subscription_until.isoformat() if user.subscription_until else None
        ),
        is_premium=subscription.is_premium(user),
        is_owner=bool(user.is_owner),
        tariffs=config.TARIFFS,
        tribute_url=config.TRIBUTE_URL or None,
    )


@app.get("/scans/remaining", response_model=ScansRemainingOut)
def scans_remaining(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ScansRemainingOut:
    """Вернуть остаток бесплатных сканирований еды на сегодня.

    Для премиум-пользователей remaining = -1 (безлимит). Эндпоинт бесплатный —
    фронт показывает счётчик «осталось сканов» как для free, так и для premium.
    """
    info = subscription.scans_info(db, user)
    return ScansRemainingOut(
        used=info["used"],
        limit=info["limit"],
        remaining=info["remaining"],
        is_premium=info["is_premium"],
    )


@app.post("/payment/stars/invoice", response_model=StarsInvoiceOut)
def payment_stars_invoice(
    data: StarsInvoiceIn,
    user: User = Depends(get_current_user),
) -> StarsInvoiceOut:
    """Создать счёт Telegram Stars для выбранного тарифа.

    Тариф проверяем по config.TARIFFS (неизвестный -> 400). Ссылку-счёт создаёт
    Bot API через telegram_bot.create_stars_invoice_link; при сбое связи с
    Telegram (RuntimeError) отвечаем 502, чтобы фронт показал «попробуйте позже».
    """
    # Валидируем тариф строго по конфигу — произвольные значения не пропускаем.
    if data.tariff not in config.TARIFFS:
        raise HTTPException(status_code=400, detail="Неизвестный тариф")

    try:
        link = telegram_bot.create_stars_invoice_link(data.tariff, user.telegram_id)
    except RuntimeError as exc:
        # Не удалось создать счёт через Bot API (нет токена/недоступность Telegram).
        logger.warning("payment/stars/invoice: %s", exc)
        raise HTTPException(status_code=502, detail="Не удалось создать счёт. Попробуйте позже.")

    return StarsInvoiceOut(invoice_link=link)


@app.post("/telegram/webhook")
async def telegram_webhook(
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """Приём апдейтов бота от Telegram (webhook).

    Без авторизации пользователя: запросы приходят напрямую от Telegram.
    Если задан секрет вебхука, сверяем заголовок X-Telegram-Bot-Api-Secret-Token
    и при несовпадении отвечаем 403. Любые ошибки разбора апдейта глушим и всегда
    отвечаем {"ok": True}, чтобы Telegram не ретраил доставку бесконечно.
    """
    # Проверка секрета вебхука (если он сконфигурирован в env).
    if config.TELEGRAM_WEBHOOK_SECRET:
        header_secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        if header_secret != config.TELEGRAM_WEBHOOK_SECRET:
            raise HTTPException(status_code=403, detail="Неверный секрет вебхука")

    try:
        update = await request.json()
        telegram_bot.handle_update(db, update)
    except Exception as exc:  # noqa: BLE001 — вебхук не должен падать наружу
        logger.warning("telegram/webhook: ошибка обработки апдейта: %s", exc)

    # Telegram ждёт 200 OK; детали обработки наружу не раскрываем.
    return {"ok": True}


@app.post("/payment/tribute/webhook")
async def payment_tribute_webhook(
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """Приём вебхука об оплате от Tribute (альтернативный провайдер подписки).

    ВНИМАНИЕ: точный формат payload Tribute уточняется при подключении провайдера —
    ниже сделан гибкий разбор (telegram_id и сумма ищутся в нескольких возможных
    местах). Секрет проверяем по config.TRIBUTE_WEBHOOK_SECRET (заголовок или поле
    тела); если секрет не задан — в dev-режиме пропускаем. Любые ошибки глушим и
    ВСЕГДА отвечаем 200 {"ok": True}, не раскрывая детали наружу.
    """
    try:
        # Пытаемся прочитать тело как JSON; при сбое — пустой словарь.
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001 — тело может быть не-JSON
            payload = {}
        if not isinstance(payload, dict):
            payload = {}

        # Проверка секрета (если сконфигурирован): сверяем заголовок или поле тела.
        if config.TRIBUTE_WEBHOOK_SECRET:
            header_secret = (
                request.headers.get("X-Tribute-Signature")
                or request.headers.get("X-Webhook-Secret")
                or request.headers.get("Authorization")
            )
            body_secret = payload.get("secret") or payload.get("signature")
            if config.TRIBUTE_WEBHOOK_SECRET not in (header_secret, body_secret):
                # Неверный секрет — молча игнорируем, но отвечаем 200.
                logger.warning("payment/tribute/webhook: неверный секрет, апдейт пропущен")
                return {"ok": True}

        # Гибко извлекаем telegram_id из payload/metadata (формат уточняется).
        meta = payload.get("metadata") or payload.get("data") or {}
        if not isinstance(meta, dict):
            meta = {}
        raw_tid = (
            payload.get("telegram_id")
            or payload.get("user_id")
            or meta.get("telegram_id")
            or meta.get("user_id")
        )
        telegram_id = int(raw_tid) if raw_tid is not None else None

        if telegram_id:
            # Сумма/валюта и тариф: маппинг продукта/суммы -> тариф, по умолчанию monthly.
            amount = payload.get("amount") or meta.get("amount")
            currency = payload.get("currency") or meta.get("currency") or "RUB"
            tariff = (
                payload.get("tariff")
                or payload.get("product")
                or meta.get("tariff")
                or "monthly"
            )
            # Если пришёл неизвестный тариф — откатываемся на monthly.
            if tariff not in config.TARIFFS:
                tariff = "monthly"

            payment_providers.activate_premium(
                db, telegram_id, tariff, "tribute", amount, currency
            )
    except Exception as exc:  # noqa: BLE001 — вебхук всегда отвечает 200
        logger.warning("payment/tribute/webhook: ошибка обработки: %s", exc)

    # Всегда 200, чтобы провайдер не ретраил и мы не палили детали.
    return {"ok": True}


# --------------------------------------------------------------------------- #
#  Трекинг веса и адаптивные калории (Этап 3) — ПРЕМИУМ
#
#  Пользователь вносит вес; по реальной динамике веса за ~2-3 недели против
#  среднего потребления калорий вычисляем фактическое поддержание и
#  корректируем дневную цель под цель диеты. Все три эндпоинта — премиум
#  (require_premium -> 402 без подписки) и объявлены ВЫШЕ app.mount.
# --------------------------------------------------------------------------- #
@app.post("/weight/add", response_model=WeightLogOut)
def weight_add(
    data: WeightAddIn,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> WeightLog:
    """Добавить замер веса (upsert по дате).

    Если за указанную дату у пользователя уже есть запись — обновляем её вес,
    иначе создаём новую. Так на одну дату приходится ровно один замер, что
    важно для корректного построения тренда и адаптивного расчёта.
    """
    existing = (
        db.query(WeightLog)
        .filter(
            WeightLog.telegram_id == user.telegram_id,
            WeightLog.date == data.date,
        )
        .first()
    )
    if existing is not None:
        # Запись за эту дату уже есть — просто обновляем вес.
        existing.weight = data.weight
        db.commit()
        db.refresh(existing)
        return existing

    # Новой даты ещё не было — создаём замер.
    log = WeightLog(
        telegram_id=user.telegram_id,
        date=data.date,
        weight=data.weight,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


@app.get("/weight/history", response_model=WeightHistoryOut)
def weight_history(
    days: int = 90,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> WeightHistoryOut:
    """Вернуть историю веса за период: точки замеров, линию тренда и сводку.

    logs — фактические замеры за последние <days> дней по возрастанию даты;
    trend — сглаженная линия тренда (линейная регрессия) через adaptive.build_trend;
    latest — последний внесённый вес; change_kg — изменение веса за период
    (последний минус первый, округлённо).
    """
    # Защита от некорректных значений параметра.
    if days < 1:
        days = 1

    today = date_cls.today()
    start = today - timedelta(days=days - 1)
    start_str = start.isoformat()
    end_str = today.isoformat()

    rows = (
        db.query(WeightLog)
        .filter(
            WeightLog.telegram_id == user.telegram_id,
            WeightLog.date >= start_str,
            WeightLog.date <= end_str,
        )
        .order_by(WeightLog.date.asc(), WeightLog.id.asc())
        .all()
    )

    # Точки замеров для графика (по возрастанию даты).
    logs = [WeightPoint(date=r.date, weight=r.weight) for r in rows]

    # Линия тренда строится в adaptive.build_trend (чистая математика, без зависимостей).
    # Передаём ему список dict с полями date/weight, который он ожидает.
    trend_raw = adaptive.build_trend([{"date": r.date, "weight": r.weight} for r in rows])
    trend = [WeightPoint(date=p["date"], weight=p["weight"]) for p in trend_raw]

    # Последний вес и изменение за период (последний - первый).
    latest = rows[-1].weight if rows else None
    change_kg = round(rows[-1].weight - rows[0].weight, 1) if len(rows) >= 2 else None

    return WeightHistoryOut(
        logs=logs,
        trend=trend,
        latest=latest,
        change_kg=change_kg,
    )


@app.post("/calories/recalculate-adaptive", response_model=AdaptiveResultOut)
def calories_recalculate_adaptive(
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> AdaptiveResultOut:
    """Пересчитать дневную цель по фактической динамике веса (по кнопке).

    Делегируем всю логику adaptive.run_adaptive_recalc: он собирает замеры веса
    и средний калораж за окно, вычисляет фактическое поддержание и при достатке
    данных сохраняет новую дневную цель в профиль. Возвращаем результат расчёта
    (включая enough_data и пояснение) клиенту. Язык — из профиля пользователя.
    """
    result = adaptive.run_adaptive_recalc(db, user, lang=user.language)
    # run_adaptive_recalc всегда возвращает dict с полем enough_data и понятным
    # пояснением (даже при ошибке/нехватке данных), поэтому собираем ответ мягко.
    return AdaptiveResultOut(
        enough_data=bool(result.get("enough_data", False)),
        maintenance=result.get("maintenance"),
        new_goal=result.get("new_goal"),
        weekly_change_kg=result.get("weekly_change_kg"),
        avg_intake=result.get("avg_intake"),
        days_used=result.get("days_used", 0),
        explanation=result.get("explanation", ""),
    )


# --------------------------------------------------------------------------- #
#  Шаблоны питания (Этап 4) — ПРЕМИУМ
#
#  Пользователь сохраняет набор блюд (одно блюдо / приём / целый день) как
#  шаблон и быстро применяет его к выбранной дате, создавая записи дневника.
#  Отдельно — быстрое копирование вчерашнего дня. Все эндпоинты премиум
#  (require_premium -> 402 без подписки) и объявлены ВЫШЕ app.mount.
# --------------------------------------------------------------------------- #
def _parse_template_items(items_json: str | None) -> list[TemplateItem]:
    """Распарсить items_json шаблона в список TemplateItem, устойчиво к битым данным.

    Если JSON повреждён или это не список — возвращаем пустой список, чтобы
    кривые данные одного шаблона не валили выдачу всего списка. Каждое блюдо
    разбираем мягко: недостающие/нечисловые КБЖУ заменяем нулями.
    """
    if not items_json:
        return []
    try:
        raw = json.loads(items_json)
    except (TypeError, ValueError):
        return []
    if not isinstance(raw, list):
        return []

    items: list[TemplateItem] = []
    for it in raw:
        if not isinstance(it, dict):
            continue
        try:
            items.append(
                TemplateItem(
                    dish_name=str(it.get("dish_name") or ""),
                    calories=int(it.get("calories") or 0),
                    proteins=float(it.get("proteins") or 0.0),
                    fats=float(it.get("fats") or 0.0),
                    carbs=float(it.get("carbs") or 0.0),
                    meal_type=it.get("meal_type") or None,
                )
            )
        except (TypeError, ValueError):
            # Одно битое блюдо не должно ломать весь шаблон — просто пропускаем.
            continue
    return items


@app.post("/template/save", response_model=TemplateOut)
def template_save(
    data: TemplateSaveIn,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> TemplateOut:
    """Сохранить шаблон питания текущего пользователя.

    Список блюд (items) сериализуем в JSON-строку (items_json). В ответ
    возвращаем шаблон с уже распарсенными блюдами.
    """
    # Сериализуем блюда в JSON-строку (ensure_ascii=False — храним кириллицу как есть).
    items_payload = [it.model_dump() for it in data.items]
    items_json = json.dumps(items_payload, ensure_ascii=False)

    template = MealTemplate(
        telegram_id=user.telegram_id,
        name=data.name,
        template_type=data.template_type,
        meal_type=data.meal_type,
        items_json=items_json,
    )
    db.add(template)
    db.commit()
    db.refresh(template)

    return TemplateOut(
        id=template.id,
        name=template.name,
        template_type=template.template_type,
        meal_type=template.meal_type,
        items=_parse_template_items(template.items_json),
    )


@app.get("/template/list", response_model=TemplateListOut)
def template_list(
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> TemplateListOut:
    """Вернуть шаблоны питания пользователя (новые сверху).

    items_json каждого шаблона разворачиваем в список блюд устойчиво к битым
    данным (повреждённый JSON -> пустой список блюд).
    """
    rows = (
        db.query(MealTemplate)
        .filter(MealTemplate.telegram_id == user.telegram_id)
        .order_by(MealTemplate.created_at.desc(), MealTemplate.id.desc())
        .all()
    )
    items = [
        TemplateOut(
            id=t.id,
            name=t.name,
            template_type=t.template_type,
            meal_type=t.meal_type,
            items=_parse_template_items(t.items_json),
        )
        for t in rows
    ]
    return TemplateListOut(items=items)


@app.post("/template/apply/{template_id}")
def template_apply(
    template_id: int,
    data: TemplateApplyIn,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> dict:
    """Применить шаблон к указанной дате: создать записи дневника по его блюдам.

    Берём шаблон, ТОЛЬКО если он принадлежит пользователю (иначе 404). Для
    каждого блюда тип приёма пищи определяем по приоритету:
      item.meal_type (для day-шаблона — у каждого блюда) -> data.meal_type
      -> meal_type самого шаблона -> "snack" (на крайний случай).
    Возвращаем число добавленных записей.
    """
    template = (
        db.query(MealTemplate)
        .filter(MealTemplate.id == template_id)
        .first()
    )
    if template is None or template.telegram_id != user.telegram_id:
        # Чужой или несуществующий шаблон прячем за 404.
        raise HTTPException(status_code=404, detail="Шаблон не найден")

    items = _parse_template_items(template.items_json)

    added = 0
    for it in items:
        # Приём пищи: у блюда (day) -> переопределение запроса -> у шаблона -> snack.
        meal_type = (
            it.meal_type
            or data.meal_type
            or template.meal_type
            or "snack"
        )
        db_entry = DiaryEntry(
            telegram_id=user.telegram_id,
            date=data.date,
            meal_type=meal_type,
            dish_name=it.dish_name,
            calories=it.calories,
            proteins=it.proteins,
            fats=it.fats,
            carbs=it.carbs,
        )
        db.add(db_entry)
        added += 1

    db.commit()
    return {"added": added}


@app.delete("/template/{template_id}")
def template_delete(
    template_id: int,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> dict:
    """Удалить шаблон питания, если он принадлежит текущему пользователю."""
    template = (
        db.query(MealTemplate)
        .filter(MealTemplate.id == template_id)
        .first()
    )
    if template is None or template.telegram_id != user.telegram_id:
        # Чужой или несуществующий шаблон прячем за 404.
        raise HTTPException(status_code=404, detail="Шаблон не найден")

    db.delete(template)
    db.commit()
    return {"ok": True}


@app.post("/diary/copy-yesterday")
def diary_copy_yesterday(
    data: CopyYesterdayIn,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> dict:
    """Скопировать все записи дневника со вчерашнего дня на указанную дату.

    «Вчера» вычисляется как (data.date - 1 день) по ISO-дате. Для каждой записи
    создаём новую с теми же полями (блюдо, КБЖУ, приём пищи). Возвращаем число
    добавленных записей. Если дата некорректна — 400.
    """
    # Вычисляем дату «вчера» относительно целевой даты.
    try:
        target = date_cls.fromisoformat(data.date)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Некорректная дата (нужен формат YYYY-MM-DD)")
    yesterday_str = (target - timedelta(days=1)).isoformat()

    # Берём все записи пользователя за «вчера».
    rows = (
        db.query(DiaryEntry)
        .filter(
            DiaryEntry.telegram_id == user.telegram_id,
            DiaryEntry.date == yesterday_str,
        )
        .order_by(DiaryEntry.created_at.asc(), DiaryEntry.id.asc())
        .all()
    )

    added = 0
    for e in rows:
        db_entry = DiaryEntry(
            telegram_id=user.telegram_id,
            date=data.date,
            meal_type=e.meal_type,
            dish_name=e.dish_name,
            calories=e.calories,
            proteins=e.proteins,
            fats=e.fats,
            carbs=e.carbs,
        )
        db.add(db_entry)
        added += 1

    db.commit()
    return {"added": added}


# --------------------------------------------------------------------------- #
#  AI-функции (Этап 5) — ПРЕМИУМ
#
#  Недельный AI-отчёт с инсайтами, AI-планировщик меню (день/неделя) и умные
#  предложения еды/перекусов. Все эндпоинты премиум (require_premium -> 402 без
#  подписки) и объявлены ВЫШЕ app.mount. При сбое ИИ отдаём 502 (как в остальных
#  AI-роутах); при включённом DEBUG_AI добавляем причину и «сырой» ответ модели.
# --------------------------------------------------------------------------- #
@app.get("/report/weekly", response_model=WeeklyReportOut)
def report_weekly(
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> WeeklyReportOut:
    """Собрать статистику за последние 7 дней и сгенерировать AI-отчёт с инсайтами.

    Статистику считаем на бэкенде (средние калории/БЖУ по дням с записями,
    кол-во залогированных дней, тренировки и сожжённое, изменение веса, средний
    дефицит и тренд калорий «первая половина недели против второй»), затем
    передаём её в ai.generate_weekly_report. При сбое ИИ -> 502.
    """
    today = date_cls.today()
    start = today - timedelta(days=6)  # 7 календарных дней включительно
    start_str = start.isoformat()
    end_str = today.isoformat()

    # --- Питание: суммы по дням, затем средние по дням С ЗАПИСЯМИ ---
    diary_rows = (
        db.query(DiaryEntry)
        .filter(
            DiaryEntry.telegram_id == user.telegram_id,
            DiaryEntry.date >= start_str,
            DiaryEntry.date <= end_str,
        )
        .all()
    )

    # Накапливаем КБЖУ по каждой дате (чтобы усреднять именно по дням, а не записям).
    per_day: dict[str, dict[str, float]] = {}
    for r in diary_rows:
        d = per_day.setdefault(
            r.date, {"calories": 0.0, "proteins": 0.0, "fats": 0.0, "carbs": 0.0}
        )
        d["calories"] += r.calories or 0
        d["proteins"] += r.proteins or 0.0
        d["fats"] += r.fats or 0.0
        d["carbs"] += r.carbs or 0.0

    days_logged = len(per_day)
    if days_logged > 0:
        avg_calories = round(sum(v["calories"] for v in per_day.values()) / days_logged)
        avg_proteins = round(sum(v["proteins"] for v in per_day.values()) / days_logged, 1)
        avg_fats = round(sum(v["fats"] for v in per_day.values()) / days_logged, 1)
        avg_carbs = round(sum(v["carbs"] for v in per_day.values()) / days_logged, 1)
    else:
        avg_calories = 0
        avg_proteins = avg_fats = avg_carbs = 0.0

    # Тренд калорий: средняя за первую половину недели против второй (по датам).
    # Чёткая граница — середина 7-дневного окна (3 дня : 4 дня).
    mid = start + timedelta(days=3)
    mid_str = mid.isoformat()
    first_half = [v["calories"] for d, v in per_day.items() if d < mid_str]
    second_half = [v["calories"] for d, v in per_day.items() if d >= mid_str]
    if first_half and second_half:
        avg_first = sum(first_half) / len(first_half)
        avg_second = sum(second_half) / len(second_half)
        diff = avg_second - avg_first
        # Небольшие колебания считаем стабильностью, чтобы не выдумывать тренд.
        if diff > 75:
            calories_trend = "up"
        elif diff < -75:
            calories_trend = "down"
        else:
            calories_trend = "stable"
    else:
        # Недостаточно данных в одной из половин — тренд неизвестен.
        calories_trend = "unknown"

    # --- Тренировки за неделю: количество и суммарно сожжено ---
    workouts = (
        db.query(Workout)
        .filter(
            Workout.telegram_id == user.telegram_id,
            Workout.date >= start_str,
            Workout.date <= end_str,
        )
        .all()
    )
    workouts_count = len(workouts)
    total_burned = sum((w.calories_burned or 0) for w in workouts)

    # --- Вес: изменение за период (последний минус первый замер) ---
    weight_rows = (
        db.query(WeightLog)
        .filter(
            WeightLog.telegram_id == user.telegram_id,
            WeightLog.date >= start_str,
            WeightLog.date <= end_str,
        )
        .order_by(WeightLog.date.asc(), WeightLog.id.asc())
        .all()
    )
    weight_change_kg = (
        round(weight_rows[-1].weight - weight_rows[0].weight, 1)
        if len(weight_rows) >= 2
        else None
    )

    # --- Цель и средний дефицит ---
    goal = user.daily_goal_kcal
    avg_deficit = (goal - avg_calories) if (goal and days_logged > 0) else None

    # Собранную статистику кладём в stats (отдаётся клиенту) и передаём в ИИ.
    stats = {
        "avg_calories": avg_calories,
        "goal": goal,
        "calories_trend": calories_trend,
        "avg_proteins": avg_proteins,
        "avg_fats": avg_fats,
        "avg_carbs": avg_carbs,
        "days_logged": days_logged,
        "workouts_count": workouts_count,
        "total_burned": total_burned,
        "weight_change_kg": weight_change_kg,
        "avg_deficit": avg_deficit,
    }

    try:
        result = generate_weekly_report(stats, lang=user.language or "ru")
    except AIError as exc:
        logger.warning(
            "report/weekly: %s | finish=%s raw=%s",
            exc, exc.finish_reason, (exc.raw or "")[:600],
        )
        detail = "Не удалось сформировать недельный отчёт. Попробуйте позже."
        if DEBUG_AI:
            detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
        raise HTTPException(status_code=502, detail=detail)
    except RuntimeError as exc:
        logger.warning("report/weekly: %s", exc)
        detail = "Сервис отчётов временно недоступен. Попробуйте позже."
        if DEBUG_AI:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail)

    # insights нормализуем в список строк (на случай нестрогого ответа модели).
    raw_insights = result.get("insights")
    insights = [str(s) for s in raw_insights if str(s).strip()] if isinstance(raw_insights, list) else []

    return WeeklyReportOut(
        summary=str(result.get("summary") or ""),
        insights=insights,
        focus=result.get("focus"),
        stats=stats,
    )


@app.post("/meal-plan/generate", response_model=MealPlanOut)
def meal_plan_generate(
    data: MealPlanIn,
    user: User = Depends(subscription.require_premium),
) -> MealPlanOut:
    """Сгенерировать AI-план меню на день или неделю под цель калорий/БЖУ.

    scope="day" — 1 день, "week" — 7 дней. Цель и целевые БЖУ берём из профиля
    (если цель не задана — 2000 ккал как разумный дефолт). Предпочтения и бюджет
    передаёт клиент. При сбое ИИ -> 502.
    """
    # Нормализуем scope: всё, кроме "week", трактуем как "day".
    scope = "week" if str(data.scope or "").strip().lower() == "week" else "day"

    try:
        result = generate_meal_plan(
            scope=scope,
            daily_goal_kcal=user.daily_goal_kcal or 2000,
            target_proteins=user.target_proteins,
            target_fats=user.target_fats,
            target_carbs=user.target_carbs,
            diet_goal=getattr(user, "diet_goal", None),
            preferences=data.preferences,
            budget=data.budget,
            lang=user.language or "ru",
        )
    except AIError as exc:
        logger.warning(
            "meal-plan/generate: %s | finish=%s raw=%s",
            exc, exc.finish_reason, (exc.raw or "")[:600],
        )
        detail = "Не удалось составить план меню. Попробуйте позже."
        if DEBUG_AI:
            detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
        raise HTTPException(status_code=502, detail=detail)
    except RuntimeError as exc:
        logger.warning("meal-plan/generate: %s", exc)
        detail = "Сервис планировщика меню временно недоступен. Попробуйте позже."
        if DEBUG_AI:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail)

    # Собираем дни плана; блюда группируем по приёмам пищи в той же форме.
    days: list[MealPlanDay] = []
    for d in result.get("days", []):
        if not isinstance(d, dict):
            continue
        meals_in = d.get("meals") if isinstance(d.get("meals"), dict) else {}
        meals_out: dict[str, list[MealPlanDish]] = {}
        for meal_key, dishes in meals_in.items():
            if not isinstance(dishes, list):
                continue
            dish_list: list[MealPlanDish] = []
            for dish in dishes:
                if not isinstance(dish, dict):
                    continue
                dish_list.append(
                    MealPlanDish(
                        dish_name=str(dish.get("dish_name") or ""),
                        calories=int(dish.get("calories") or 0),
                        proteins=float(dish.get("proteins") or 0.0),
                        fats=float(dish.get("fats") or 0.0),
                        carbs=float(dish.get("carbs") or 0.0),
                    )
                )
            meals_out[str(meal_key)] = dish_list
        days.append(MealPlanDay(label=str(d.get("label") or ""), meals=meals_out))

    shopping_list = [
        str(s) for s in result.get("shopping_list", []) if str(s).strip()
    ]

    return MealPlanOut(days=days, shopping_list=shopping_list)


@app.post("/meal-plan/regenerate-item", response_model=RegenerateItemOut)
def meal_plan_regenerate_item(
    data: RegenerateItemIn,
    user: User = Depends(subscription.require_premium),
) -> RegenerateItemOut:
    """Заменить одно блюдо в плане альтернативным под приём пищи и ~калории.

    Удобно, когда конкретное блюдо не нравится: возвращаем ровно одну замену.
    Цель диеты берём из профиля. При сбое ИИ -> 502.
    """
    try:
        result = regenerate_meal_item(
            meal_type=data.meal_type,
            around_calories=data.around_calories,
            diet_goal=getattr(user, "diet_goal", None),
            preferences=data.preferences,
            lang=user.language or "ru",
        )
    except AIError as exc:
        logger.warning(
            "meal-plan/regenerate-item: %s | finish=%s raw=%s",
            exc, exc.finish_reason, (exc.raw or "")[:600],
        )
        detail = "Не удалось подобрать замену блюда. Попробуйте позже."
        if DEBUG_AI:
            detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
        raise HTTPException(status_code=502, detail=detail)
    except RuntimeError as exc:
        logger.warning("meal-plan/regenerate-item: %s", exc)
        detail = "Сервис планировщика меню временно недоступен. Попробуйте позже."
        if DEBUG_AI:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail)

    return RegenerateItemOut(
        dish_name=str(result.get("dish_name") or ""),
        calories=int(result.get("calories") or 0),
        proteins=float(result.get("proteins") or 0.0),
        fats=float(result.get("fats") or 0.0),
        carbs=float(result.get("carbs") or 0.0),
    )


@app.post("/food/suggest", response_model=FoodSuggestOut)
def food_suggest(
    data: FoodSuggestIn,
    user: User = Depends(subscription.require_premium),
) -> FoodSuggestOut:
    """Умное предложение еды под остаток КБЖУ, приём пищи и/или пожелание.

    Если задан meal_type — варианты под этот приём; если задан free_text —
    учитываем пожелание пользователя. Все варианты должны влезать в остаток КБЖУ.
    Цель диеты берём из профиля. При сбое ИИ -> 502.
    """
    try:
        result = suggest_food(
            meal_type=data.meal_type,
            free_text=data.free_text,
            remaining_calories=data.remaining_calories,
            remaining_proteins=data.remaining_proteins,
            remaining_fats=data.remaining_fats,
            remaining_carbs=data.remaining_carbs,
            diet_goal=getattr(user, "diet_goal", None),
            lang=user.language or "ru",
        )
    except AIError as exc:
        logger.warning(
            "food/suggest: %s | finish=%s raw=%s",
            exc, exc.finish_reason, (exc.raw or "")[:600],
        )
        detail = "Не удалось подобрать предложения еды. Попробуйте позже."
        if DEBUG_AI:
            detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
        raise HTTPException(status_code=502, detail=detail)
    except RuntimeError as exc:
        logger.warning("food/suggest: %s", exc)
        detail = "Сервис предложений еды временно недоступен. Попробуйте позже."
        if DEBUG_AI:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail)

    suggestions = [
        RecommendItem(
            dish_name=s["dish_name"],
            calories=s["calories"],
            proteins=s["proteins"],
            fats=s["fats"],
            carbs=s["carbs"],
            reason=s["reason"],
        )
        for s in result.get("suggestions", [])
    ]
    return FoodSuggestOut(suggestions=suggestions)


@app.get("/food/healthy-snacks", response_model=HealthySnacksOut)
def food_healthy_snacks(
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> HealthySnacksOut:
    """Подобрать низкокалорийные перекусы-«вкусняшки» под остаток калорий на сегодня.

    Остаток считаем как (дневная цель − съедено сегодня), не меньше нуля и целым.
    Если цель не задана — берём разумный дефолт 2000 ккал. При сбое ИИ -> 502.
    """
    # Считаем съеденное за сегодня, чтобы вычислить остаток калорий.
    today_str = date_cls.today().isoformat()
    eaten_today = (
        db.query(DiaryEntry)
        .filter(
            DiaryEntry.telegram_id == user.telegram_id,
            DiaryEntry.date == today_str,
        )
        .all()
    )
    consumed = sum((e.calories or 0) for e in eaten_today)
    goal = user.daily_goal_kcal or 2000
    # Остаток — целое и не отрицательное (на крайний случай съели больше цели).
    remaining = max(0, int(goal - consumed))

    try:
        result = healthy_snacks(remaining, lang=user.language or "ru")
    except AIError as exc:
        logger.warning(
            "food/healthy-snacks: %s | finish=%s raw=%s",
            exc, exc.finish_reason, (exc.raw or "")[:600],
        )
        detail = "Не удалось подобрать полезные перекусы. Попробуйте позже."
        if DEBUG_AI:
            detail = f"{exc} | finish={exc.finish_reason} | raw={(exc.raw or 'пусто')[:1500]}"
        raise HTTPException(status_code=502, detail=detail)
    except RuntimeError as exc:
        logger.warning("food/healthy-snacks: %s", exc)
        detail = "Сервис подсказок временно недоступен. Попробуйте позже."
        if DEBUG_AI:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail)

    suggestions = [
        RecommendItem(
            dish_name=s["dish_name"],
            calories=s["calories"],
            proteins=s["proteins"],
            fats=s["fats"],
            carbs=s["carbs"],
            reason=s["reason"],
        )
        for s in result.get("suggestions", [])
    ]
    return HealthySnacksOut(suggestions=suggestions)


# --------------------------------------------------------------------------- #
#  Трекинг цикла (Этап 6) — ПРЕМИУМ
#
#  Пользователь вводит дату начала последней менструации, среднюю длину цикла и
#  длительность менструации; бэкенд рассчитывает текущую фазу, день цикла, прогноз
#  следующей менструации и фертильное окно (backend/cycle.py). Данные приватны —
#  всё фильтруется по telegram_id текущего пользователя. Эндпоинты премиум
#  (require_premium -> 402 без подписки) и объявлены ВЫШЕ app.mount. Значения
#  ОРИЕНТИРОВОЧНЫЕ (не медицинская рекомендация) — дисклеймер показывает фронтенд.
# --------------------------------------------------------------------------- #
def _latest_cycle_log(db: Session, telegram_id: int) -> CycleLog | None:
    """Вернуть самую свежую запись цикла пользователя (или None)."""
    return (
        db.query(CycleLog)
        .filter(CycleLog.telegram_id == telegram_id)
        .order_by(CycleLog.created_at.desc(), CycleLog.id.desc())
        .first()
    )


def _build_cycle_status_out(log: CycleLog | None) -> CycleStatusOut:
    """Собрать ответ статуса цикла из записи БД (или пустой, если записи нет)."""
    if log is None:
        return CycleStatusOut(has_data=False)

    status = cycle.compute_status(
        log.cycle_start_date,
        cycle_length=log.cycle_length,
        period_length=log.period_length,
    )
    if status is None:
        # Дата в записи некорректна — считаем, что данных нет.
        return CycleStatusOut(has_data=False)

    return CycleStatusOut(
        has_data=True,
        cycle_start_date=status["cycle_start_date"],
        cycle_length=status["cycle_length"],
        period_length=status["period_length"],
        day_of_cycle=status["day_of_cycle"],
        phase=status["phase"],
        next_period_date=status["next_period_date"],
        days_until_next_period=status["days_until_next_period"],
        ovulation_date=status["ovulation_date"],
        fertile_start=status["fertile_start"],
        fertile_end=status["fertile_end"],
        notes=log.notes,
    )


@app.get("/cycle/status", response_model=CycleStatusOut)
def cycle_status(
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> CycleStatusOut:
    """Вернуть текущий статус цикла пользователя (по самой свежей записи).

    Если пользователь ещё ничего не вводил — has_data=False (остальные поля None).
    """
    log = _latest_cycle_log(db, user.telegram_id)
    return _build_cycle_status_out(log)


@app.post("/cycle/log", response_model=CycleStatusOut)
def cycle_log(
    data: CycleLogIn,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> CycleStatusOut:
    """Сохранить данные о цикле и вернуть пересчитанный статус.

    Дату начала валидируем строго (нужен формат YYYY-MM-DD); длину цикла и
    менструации приводим к разумному диапазону в backend/cycle.py. Каждая запись
    добавляется в историю (существующие не перезаписываем).
    """
    start = cycle.parse_date(data.cycle_start_date)
    if start is None:
        raise HTTPException(
            status_code=400, detail="Некорректная дата (нужен формат YYYY-MM-DD)"
        )

    # Приводим числовые параметры к валидному диапазону (или к значениям по умолчанию).
    cl = cycle.clamp_cycle_length(
        data.cycle_length if data.cycle_length is not None else cycle.DEFAULT_CYCLE_LENGTH
    )
    pl = cycle.clamp_period_length(
        data.period_length if data.period_length is not None else cycle.DEFAULT_PERIOD_LENGTH
    )

    notes = (data.notes or "").strip() or None

    entry = CycleLog(
        telegram_id=user.telegram_id,
        cycle_start_date=start.isoformat(),
        cycle_length=cl,
        period_length=pl,
        notes=notes,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)

    return _build_cycle_status_out(entry)


@app.delete("/cycle")
def cycle_reset(
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> dict:
    """Удалить все записи цикла пользователя (сброс данных трекера)."""
    deleted = (
        db.query(CycleLog)
        .filter(CycleLog.telegram_id == user.telegram_id)
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"deleted": int(deleted or 0)}


# --------------------------------------------------------------------------- #
#  Фото-прогресс (Этап 7) — ПРЕМИУМ, ПРИВАТНО
#
#  Пользователь загружает фото прогресса с датой и (опц.) весом. ПРИВАТНОСТЬ:
#  файлы сохраняются в защищённый каталог (config.PROGRESS_PHOTOS_DIR) и НЕ
#  раздаются статикой — отдаются ТОЛЬКО через авторизованный эндпоинт
#  GET /progress/{id}/image с проверкой владельца (telegram_id). Публичных
#  ссылок на изображения не существует. Все эндпоинты премиум (402 без подписки)
#  и объявлены ВЫШЕ app.mount.
# --------------------------------------------------------------------------- #
# Разрешённые типы изображений и соответствующие расширения файлов.
_PROGRESS_MIME_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
}


def _progress_dir() -> Path:
    """Абсолютный путь к каталогу приватных фото (создаёт его при необходимости)."""
    d = Path(config.PROGRESS_PHOTOS_DIR)
    if not d.is_absolute():
        d = Path(__file__).resolve().parent.parent / d
    d.mkdir(parents=True, exist_ok=True)
    return d


def _progress_photo_out(photo: ProgressPhoto) -> ProgressPhotoOut:
    """Собрать метаданные фото для клиента (без публичной ссылки на файл)."""
    return ProgressPhotoOut(
        id=photo.id,
        date=photo.date,
        weight=photo.weight,
        image_url=f"/progress/{photo.id}/image",
        created_at=photo.created_at.isoformat() if photo.created_at else None,
    )


@app.post("/progress/upload", response_model=ProgressPhotoOut)
async def progress_upload(
    file: UploadFile = File(...),
    date: str | None = Form(None),
    weight: float | None = Form(None),
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> ProgressPhotoOut:
    """Принять фото прогресса, сохранить в приватный каталог и создать запись.

    Дата снимка (date) по умолчанию — сегодня; вес (weight) необязателен. Тип
    файла проверяем по content-type; размер ограничен config.PROGRESS_PHOTO_MAX_BYTES.
    Возвращаем метаданные (без публичной ссылки — только путь авторизованной выдачи).
    """
    mime = (file.content_type or "").lower().split(";")[0].strip()
    ext = _PROGRESS_MIME_EXT.get(mime)
    if ext is None:
        raise HTTPException(
            status_code=400,
            detail="Неподдерживаемый формат. Загрузите изображение (JPG/PNG/WEBP).",
        )

    max_bytes = config.PROGRESS_PHOTO_MAX_BYTES
    data = await file.read(max_bytes + 1)
    if not data:
        raise HTTPException(status_code=400, detail="Пустой файл изображения")
    if len(data) > max_bytes:
        mb = max_bytes // (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"Файл слишком большой (макс. {mb} МБ)")

    # Дата снимка: валидируем ISO; при отсутствии/ошибке — сегодня.
    snap_date = cycle.parse_date(date) if date else None
    if snap_date is None:
        snap_date = date_cls.today()

    # Имя файла: {telegram_id}_{uuid}.{ext} — непубличное, без перечислимости.
    filename = f"{user.telegram_id}_{uuid.uuid4().hex}{ext}"
    dest = _progress_dir() / filename
    try:
        with open(dest, "wb") as fh:
            fh.write(data)
    except OSError as exc:
        logger.warning("progress/upload: не удалось сохранить файл: %s", exc)
        raise HTTPException(status_code=500, detail="Не удалось сохранить фото. Попробуйте позже.")

    photo = ProgressPhoto(
        telegram_id=user.telegram_id,
        photo_path=filename,
        date=snap_date.isoformat(),
        weight=weight,
    )
    db.add(photo)
    db.commit()
    db.refresh(photo)

    return _progress_photo_out(photo)


@app.get("/progress/list", response_model=ProgressListOut)
def progress_list(
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> ProgressListOut:
    """Вернуть все фото прогресса пользователя по возрастанию даты (для таймлайна)."""
    rows = (
        db.query(ProgressPhoto)
        .filter(ProgressPhoto.telegram_id == user.telegram_id)
        .order_by(ProgressPhoto.date.asc(), ProgressPhoto.id.asc())
        .all()
    )
    return ProgressListOut(items=[_progress_photo_out(p) for p in rows])


@app.get("/progress/{photo_id}/image")
def progress_image(
    photo_id: int,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
):
    """Отдать файл фото прогресса — ТОЛЬКО владельцу (проверка telegram_id).

    Файлы лежат вне статики; сюда попадают лишь авторизованные запросы. Если фото
    принадлежит другому пользователю или отсутствует — 404 (без утечки факта).
    """
    from fastapi.responses import FileResponse

    photo = (
        db.query(ProgressPhoto)
        .filter(
            ProgressPhoto.id == photo_id,
            ProgressPhoto.telegram_id == user.telegram_id,
        )
        .first()
    )
    if photo is None:
        raise HTTPException(status_code=404, detail="Фото не найдено")

    path = _progress_dir() / photo.photo_path
    if not path.exists():
        raise HTTPException(status_code=404, detail="Файл фото недоступен")

    # Приватный ответ: запрещаем кеширование на общих узлах.
    return FileResponse(
        str(path),
        headers={"Cache-Control": "private, no-store"},
    )


@app.delete("/progress/{photo_id}")
def progress_delete(
    photo_id: int,
    user: User = Depends(subscription.require_premium),
    db: Session = Depends(get_db),
) -> dict:
    """Удалить фото прогресса (запись в БД и файл на диске) — только своё."""
    photo = (
        db.query(ProgressPhoto)
        .filter(
            ProgressPhoto.id == photo_id,
            ProgressPhoto.telegram_id == user.telegram_id,
        )
        .first()
    )
    if photo is None:
        raise HTTPException(status_code=404, detail="Фото не найдено")

    # Сначала пытаемся удалить файл (ошибку не считаем фатальной — запись всё равно чистим).
    try:
        fpath = _progress_dir() / photo.photo_path
        if fpath.exists():
            fpath.unlink()
    except OSError as exc:
        logger.warning("progress/delete: не удалось удалить файл %s: %s", photo.photo_path, exc)

    db.delete(photo)
    db.commit()
    return {"deleted": 1}


# --------------------------------------------------------------------------- #
#  Статика фронтенда — монтируется ПОСЛЕДНЕЙ, чтобы API-маршруты были в приоритете
# --------------------------------------------------------------------------- #
frontend_dir = Path(__file__).resolve().parent.parent / "frontend"


# index.html отдаём с no-cache, чтобы Telegram не кешировал старую «оболочку» и
# всегда видел свежие ссылки на ассеты (css/js?v=...). Сами ассеты кешируются по
# версии в query — это лечит «приложение не обновляется после деплоя».
@app.get("/", include_in_schema=False)
def serve_index():
    from fastapi.responses import FileResponse

    return FileResponse(
        str(frontend_dir / "index.html"),
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="static")
