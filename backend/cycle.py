"""
Расчёт фазы менструального цикла (Этап 6).

По дате начала последней менструации, средней длине цикла и длительности
менструации определяем текущий день цикла и его фазу, а также прогноз следующей
менструации, дату овуляции и фертильное окно.

ВАЖНО: все расчёты — ОРИЕНТИРОВОЧНЫЕ (по усреднённой модели) и НЕ являются
медицинской рекомендацией. Дисклеймер показывается пользователю на фронтенде.

Фазы (ключи латиницей — локализуются на фронте через App.pick):
  - "menstrual"  — менструация (дни 1..period_length);
  - "follicular" — фолликулярная (после менструации до овуляции);
  - "ovulation"  — овуляторная (окно ±1 день вокруг овуляции);
  - "luteal"     — лютеиновая (после овуляции до конца цикла).

День овуляции оценивается как (cycle_length - LUTEAL_DAYS): лютеиновая фаза
относительно постоянна (~14 дней), поэтому это стандартная устойчивая эвристика.
"""

from datetime import date, timedelta

# Границы валидных значений (защита от абсурдных вводов пользователя).
MIN_CYCLE_LENGTH = 20
MAX_CYCLE_LENGTH = 45
MIN_PERIOD_LENGTH = 1
MAX_PERIOD_LENGTH = 10

# Значения по умолчанию, если пользователь не указал.
DEFAULT_CYCLE_LENGTH = 28
DEFAULT_PERIOD_LENGTH = 5

# Фиксированная длина лютеиновой фазы (дней) для оценки дня овуляции.
LUTEAL_DAYS = 14

# Все возможные ключи фаз (для валидации/тестов).
PHASES = ("menstrual", "follicular", "ovulation", "luteal")


def clamp_cycle_length(value) -> int:
    """Привести длину цикла к валидному диапазону; при мусоре — значение по умолчанию."""
    try:
        v = int(value)
    except (TypeError, ValueError):
        return DEFAULT_CYCLE_LENGTH
    return max(MIN_CYCLE_LENGTH, min(MAX_CYCLE_LENGTH, v))


def clamp_period_length(value) -> int:
    """Привести длительность менструации к валидному диапазону; при мусоре — по умолчанию."""
    try:
        v = int(value)
    except (TypeError, ValueError):
        return DEFAULT_PERIOD_LENGTH
    return max(MIN_PERIOD_LENGTH, min(MAX_PERIOD_LENGTH, v))


def parse_date(value):
    """Разобрать ISO-дату "YYYY-MM-DD" в date; при ошибке — None."""
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def compute_status(
    cycle_start_date,
    cycle_length=None,
    period_length=None,
    today=None,
) -> dict:
    """
    Рассчитать текущий статус цикла на дату today (по умолчанию — сегодня).

    Параметры:
      cycle_start_date — date | ISO-строка: начало последней известной менструации;
      cycle_length     — средняя длина цикла (дней), при None -> 28;
      period_length    — длительность менструации (дней), при None -> 5;
      today            — date, на которую считаем (для тестов).

    Возвращает словарь:
      {
        "cycle_start_date": ISO-строка (начало ТЕКУЩЕГО расчётного цикла),
        "cycle_length": int, "period_length": int,
        "day_of_cycle": int (1-based),
        "phase": один из PHASES,
        "next_period_date": ISO, "days_until_next_period": int,
        "ovulation_date": ISO, "fertile_start": ISO, "fertile_end": ISO
      }
    Если дата начала не парсится — возвращает None (вызывающий отдаст has_data=False).
    """
    start = parse_date(cycle_start_date)
    if start is None:
        return None

    cl = clamp_cycle_length(cycle_length if cycle_length is not None else DEFAULT_CYCLE_LENGTH)
    pl = clamp_period_length(period_length if period_length is not None else DEFAULT_PERIOD_LENGTH)
    # Менструация не может длиться дольше самого цикла.
    if pl > cl:
        pl = cl

    if today is None:
        today = date.today()

    # Сколько полных циклов прошло с указанного старта — проецируем модель вперёд,
    # чтобы «начало последней менструации» из прошлого не давало день цикла > длины.
    delta_days = (today - start).days
    if delta_days < 0:
        # Начало в будущем — трактуем как первый день (ещё не наступило).
        current_start = start
    else:
        cycles_elapsed = delta_days // cl
        current_start = start + timedelta(days=cycles_elapsed * cl)

    day_of_cycle = (today - current_start).days + 1  # 1-based
    if day_of_cycle < 1:
        day_of_cycle = 1

    # Прогноз следующей менструации.
    next_period_date = current_start + timedelta(days=cl)
    days_until_next_period = (next_period_date - today).days

    # Оценка дня овуляции и фертильного окна.
    ovulation_day = cl - LUTEAL_DAYS  # 1-based номер дня в цикле
    if ovulation_day < 1:
        ovulation_day = 1
    ovulation_date = current_start + timedelta(days=ovulation_day - 1)
    fertile_start = ovulation_date - timedelta(days=5)
    fertile_end = ovulation_date + timedelta(days=1)

    # Определение фазы. Менструация имеет приоритет (первые дни цикла).
    if day_of_cycle <= pl:
        phase = "menstrual"
    elif day_of_cycle < ovulation_day - 1:
        phase = "follicular"
    elif day_of_cycle <= ovulation_day + 1:
        phase = "ovulation"
    else:
        phase = "luteal"

    return {
        "cycle_start_date": current_start.isoformat(),
        "cycle_length": cl,
        "period_length": pl,
        "day_of_cycle": day_of_cycle,
        "phase": phase,
        "next_period_date": next_period_date.isoformat(),
        "days_until_next_period": days_until_next_period,
        "ovulation_date": ovulation_date.isoformat(),
        "fertile_start": fertile_start.isoformat(),
        "fertile_end": fertile_end.isoformat(),
    }
