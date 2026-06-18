"""Точка входа FastAPI-приложения «Calorie Mini App».

Запуск из корня проекта:
    uvicorn backend.main:app

Здесь собирается весь backend: загрузка .env, CORS, инициализация БД,
все API-маршруты и раздача статики фронтенда (монтируется ПОСЛЕДНЕЙ,
чтобы API-маршруты имели приоритет).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import date as date_cls, timedelta
from pathlib import Path

# .env загружаем в самом начале, ДО чтения переменных окружения сервисами.
from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from backend.ai_service import analyze_food_image
from backend.auth import get_current_user
from backend.database import get_db, init_db
from backend.models import DiaryEntry, User
from backend.schemas import (
    AnalyzeOut,
    DiaryDayOut,
    DiaryEntryIn,
    DiaryEntryOut,
    HistoryDay,
    HistoryOut,
    MealsOut,
    ProfileIn,
    ProfileOut,
)

# Допустимые типы приёмов пищи (порядок важен для группировки/вывода).
MEAL_TYPES = ("breakfast", "lunch", "dinner", "snack")

# Максимальный размер загружаемого фото (8 МБ) — защита от перерасхода памяти.
MAX_UPLOAD_BYTES = 8 * 1024 * 1024


# Жизненный цикл приложения: создаём таблицы БД при старте.
# Используем lifespan вместо устаревшего @app.on_event("startup").
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


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
    for field in ("weight", "height", "age", "gender", "activity_level", "daily_goal_kcal"):
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
) -> AnalyzeOut:
    """Принять фото, проанализировать его ИИ и вернуть КБЖУ блюда."""
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
    except RuntimeError as exc:
        # Ошибка ИИ-сервиса (нет ключа, сбой сети, плохой ответ модели и т.п.).
        raise HTTPException(status_code=502, detail=str(exc))

    return AnalyzeOut(
        dish_name=result["dish_name"],
        calories=result["calories"],
        proteins=result["proteins"],
        fats=result["fats"],
        carbs=result["carbs"],
        note=result["note"],
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

    return DiaryDayOut(
        date=date,
        daily_goal_kcal=user.daily_goal_kcal,
        total_calories=total_calories,
        total_proteins=round(total_proteins, 1),
        total_fats=round(total_fats, 1),
        total_carbs=round(total_carbs, 1),
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
#  Статика фронтенда — монтируется ПОСЛЕДНЕЙ, чтобы API-маршруты были в приоритете
# --------------------------------------------------------------------------- #
frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="static")
