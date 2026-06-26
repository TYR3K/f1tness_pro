"""Точка входа FastAPI-приложения «Calorie Mini App».

Запуск из корня проекта:
    uvicorn backend.main:app

Здесь собирается весь backend: загрузка .env, CORS, инициализация БД,
все API-маршруты и раздача статики фронтенда (монтируется ПОСЛЕДНЕЙ,
чтобы API-маршруты имели приоритет).
"""

from __future__ import annotations

import logging
import os
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

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from backend import (
    config,
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
    recommend_meals,
    recommend_supplements,
    suggest_supplements,
)
from backend.auth import get_current_user
from backend.database import get_db, init_db
from backend.models import (
    DiaryEntry,
    FavoriteFood,
    NotificationSettings,
    Supplement,
    SupplementReminder,
    SupplementReminderItem,
    TrainingReminder,
    User,
    Workout,
)
from backend.schemas import (
    AnalyzeOut,
    DiaryDayOut,
    DiaryEntryIn,
    DiaryEntryOut,
    GoalCalcIn,
    GoalCalcOut,
    HistoryDay,
    HistoryOut,
    ManualFoodIn,
    MealsOut,
    NotificationSettingsIn,
    NotificationSettingsOut,
    ProfileIn,
    ProfileOut,
    RecentFoodOut,
    RecentFoodsOut,
    RecommendIn,
    RecommendItem,
    RecommendOut,
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
    TrainingReminderIn,
    TrainingReminderOut,
    TrainingRemindersOut,
    WorkoutDayOut,
    WorkoutEstimateIn,
    WorkoutEstimateOut,
    WorkoutIn,
    WorkoutOut,
)

# Допустимые типы приёмов пищи (порядок важен для группировки/вывода).
MEAL_TYPES = ("breakfast", "lunch", "dinner", "snack")

# Максимальный размер загружаемого фото (8 МБ) — защита от перерасхода памяти.
MAX_UPLOAD_BYTES = 8 * 1024 * 1024


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
    # Помимо базовых параметров теперь поддерживаем цель диеты и целевые БЖУ.
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
    try:
        result = analyze_food_image(image_bytes, mime=mime)
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

    Расчёт ведётся по таблице MET с учётом веса пользователя (если он указан
    в профиле, иначе берётся усреднённое значение внутри fitness-модуля).
    """
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
        type=data.type,
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
        result = suggest_supplements(diet_goal)
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


@app.get("/notifications/settings", response_model=NotificationSettingsOut)
def notifications_get(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationSettings:
    """Вернуть настройки уведомлений (создав их с дефолтами при первом запросе)."""
    return _get_or_create_notification_settings(db, user.telegram_id)


@app.post("/notifications/settings", response_model=NotificationSettingsOut)
def notifications_update(
    data: NotificationSettingsIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationSettings:
    """Обновить настройки уведомлений (upsert), меняя только переданные поля."""
    settings = _get_or_create_notification_settings(db, user.telegram_id)

    payload = data.model_dump(exclude_unset=True)
    for field, value in payload.items():
        # Применяем только реально переданные поля, чтобы не сбросить остальные.
        setattr(settings, field, value)

    db.commit()
    db.refresh(settings)
    return settings


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
        label=data.label,
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
#  Статика фронтенда — монтируется ПОСЛЕДНЕЙ, чтобы API-маршруты были в приоритете
# --------------------------------------------------------------------------- #
frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="static")
