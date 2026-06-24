"""
Планировщик и отправка push-уведомлений в Telegram.

Модуль работает поверх существующей архитектуры (см. database.py / models.py)
и НИЧЕГО в ней не меняет. Раз в минуту фоновый планировщик (APScheduler)
проверяет настройки уведомлений каждого пользователя (NotificationSettings)
и отправляет напоминания через Telegram Bot API (метод sendMessage по httpx).

Виды уведомлений:
  * приёмы пищи (breakfast / lunch / dinner) — только если за сегодня нет
    записи дневника соответствующего типа;
  * тренировка (training);
  * приём спортпита (supplement:{id}) — по каждой добавке с включённым
    напоминанием и заданным временем;
  * вечерняя сводка дня (summary) — съедено / цель / осталось.

Чтобы не слать одно и то же несколько раз за день, факт отправки фиксируется
в таблице NotificationLog (дедупликация по паре «вид + дата»).

Надёжность — главный приоритет: ВЕСЬ код обёрнут в try/except. Ни падение
планировщика, ни ошибка отправки (например, бот заблокирован пользователем —
HTTP 403) не должны валить приложение. Если планировщик отключён
(ENABLE_SCHEDULER="0") или не задан BOT_TOKEN — модуль просто бездействует.

Публичные функции:
    start_scheduler() -> scheduler | None
    stop_scheduler(sched) -> None
    check_notifications() -> None
    send_telegram(chat_id, text) -> bool
"""

import logging
import os
from datetime import datetime

# httpx — для обращения к Telegram Bot API. Импортируем мягко, чтобы отсутствие
# зависимости не ломало импорт всего приложения.
try:
    import httpx
except Exception:  # pragma: no cover - на случай отсутствия httpx
    httpx = None

# APScheduler — фоновый планировщик. Тоже импортируем мягко.
try:
    from apscheduler.schedulers.background import BackgroundScheduler
except Exception:  # pragma: no cover - на случай отсутствия APScheduler
    BackgroundScheduler = None

# Часовой пояс приложения. По умолчанию — московское время; при недоступности
# zoneinfo/нужной зоны откатываемся на UTC, чтобы модуль продолжал работать.
try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover - очень старый Python
    ZoneInfo = None

from backend.database import SessionLocal
from backend.models import (
    DiaryEntry,
    NotificationLog,
    NotificationSettings,
    Supplement,
    User,
)

logger = logging.getLogger("notifications")

# Токен Telegram-бота (без него отправка невозможна).
BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()

# Имя часового пояса приложения (например, "Europe/Moscow").
APP_TZ_NAME = os.getenv("APP_TZ", "Europe/Moscow")


def _resolve_tz():
    """Вернуть объект часового пояса приложения с откатом на UTC."""
    if ZoneInfo is not None:
        try:
            return ZoneInfo(APP_TZ_NAME)
        except Exception as exc:  # неизвестная зона / нет tzdata
            logger.warning("APP_TZ=%s недоступен (%s), используем UTC", APP_TZ_NAME, exc)
    # Фолбэк — наивный UTC через стандартную библиотеку.
    try:
        from datetime import timezone
        return timezone.utc
    except Exception:  # pragma: no cover
        return None


# Часовой пояс приложения, вычисляется один раз при импорте.
APP_TZ = _resolve_tz()


# --------------------------------------------------------------------------- #
#  Отправка сообщения в Telegram
# --------------------------------------------------------------------------- #
def send_telegram(chat_id: int, text: str) -> bool:
    """Отправить текстовое сообщение пользователю через Telegram Bot API.

    Возвращает True при успехе и False при любой ошибке (нет токена/httpx,
    сетевой сбой, бот заблокирован пользователем -> 403 и т.п.). Никогда не
    бросает исключение наружу.
    """
    if not BOT_TOKEN:
        # Без токена слать некуда — тихо выходим (это не ошибка приложения).
        logger.debug("send_telegram: BOT_TOKEN не задан, пропуск")
        return False
    if httpx is None:
        logger.warning("send_telegram: httpx не установлен, отправка невозможна")
        return False

    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    try:
        resp = httpx.post(
            url,
            json={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                # Отключаем превью ссылок — в напоминаниях оно не нужно.
                "disable_web_page_preview": True,
            },
            timeout=10,
        )
        if resp.status_code == 200:
            return True
        # Частые случаи: 403 — бот заблокирован пользователем; 400 — неверный chat_id.
        logger.warning(
            "send_telegram: chat_id=%s статус=%s ответ=%s",
            chat_id, resp.status_code, resp.text[:300],
        )
        return False
    except Exception as exc:
        # Любой сетевой/прочий сбой — логируем и считаем неуспехом.
        logger.warning("send_telegram: ошибка отправки chat_id=%s: %s", chat_id, exc)
        return False


# --------------------------------------------------------------------------- #
#  Дедупликация: журнал отправленных уведомлений (NotificationLog)
# --------------------------------------------------------------------------- #
def _was_sent(db, tid: int, kind: str, date: str) -> bool:
    """Проверить, отправлялось ли уведомление данного вида этому юзеру сегодня."""
    try:
        return (
            db.query(NotificationLog)
            .filter(
                NotificationLog.telegram_id == tid,
                NotificationLog.kind == kind,
                NotificationLog.date == date,
            )
            .first()
            is not None
        )
    except Exception as exc:
        # При сбое запроса считаем «не отправлено», но защищаемся от дублей выше.
        logger.warning("_was_sent: ошибка запроса (%s) tid=%s kind=%s", exc, tid, kind)
        return False


def _mark_sent(db, tid: int, kind: str, date: str) -> None:
    """Зафиксировать факт отправки уведомления (для дедупликации)."""
    try:
        db.add(
            NotificationLog(
                telegram_id=tid,
                kind=kind,
                date=date,
            )
        )
        db.commit()
    except Exception as exc:
        logger.warning("_mark_sent: не удалось записать лог (%s) tid=%s kind=%s", exc, tid, kind)
        try:
            db.rollback()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
#  Вспомогательное: сравнение времени "HH:MM" с текущим
# --------------------------------------------------------------------------- #
def _time_reached(now: datetime, hhmm: str | None) -> bool:
    """True, если текущее время (now) уже достигло заданного "HH:MM".

    Сравниваем по минутам в пределах текущих суток. Некорректные/пустые
    значения трактуем как «время ещё не наступило» (False).
    """
    if not hhmm:
        return False
    try:
        parts = str(hhmm).strip().split(":")
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
    except Exception:
        return False
    now_minutes = now.hour * 60 + now.minute
    target_minutes = hour * 60 + minute
    return now_minutes >= target_minutes


def _has_diary_entry(db, tid: int, date: str, meal_type: str) -> bool:
    """Есть ли у пользователя за дату запись дневника указанного приёма пищи."""
    try:
        return (
            db.query(DiaryEntry)
            .filter(
                DiaryEntry.telegram_id == tid,
                DiaryEntry.date == date,
                DiaryEntry.meal_type == meal_type,
            )
            .first()
            is not None
        )
    except Exception as exc:
        logger.warning("_has_diary_entry: ошибка запроса (%s) tid=%s", exc, tid)
        # При сбое лучше НЕ слать напоминание (считаем, что запись есть).
        return True


# --------------------------------------------------------------------------- #
#  Обработка одного пользователя
# --------------------------------------------------------------------------- #
def _process_meal_reminder(db, tid: int, today: str, now: datetime,
                           kind: str, meal_time: str | None, label: str, emoji: str) -> None:
    """Напоминание о приёме пищи: шлём, только если запись ещё не сделана."""
    if not _time_reached(now, meal_time):
        return
    if _was_sent(db, tid, kind, today):
        return
    # Если запись этого приёма пищи за сегодня уже есть — напоминать не нужно.
    if _has_diary_entry(db, tid, today, kind):
        return
    text = (
        f"{emoji} <b>Напоминание: {label}</b>\n"
        f"Не забудьте поесть и записать приём пищи в дневник 🍽️"
    )
    if send_telegram(tid, text):
        _mark_sent(db, tid, kind, today)


def _process_training_reminder(db, tid: int, today: str, now: datetime,
                               settings: "NotificationSettings") -> None:
    """Напоминание о тренировке."""
    if not getattr(settings, "training_reminder_enabled", False):
        return
    if not _time_reached(now, getattr(settings, "training_time", None)):
        return
    if _was_sent(db, tid, "training", today):
        return
    text = (
        "💪 <b>Время тренировки!</b>\n"
        "Пора размяться. После — не забудьте записать тренировку 🏋️"
    )
    if send_telegram(tid, text):
        _mark_sent(db, tid, "training", today)


def _process_supplement_reminders(db, tid: int, today: str, now: datetime,
                                  settings: "NotificationSettings") -> None:
    """Напоминания о приёме спортивного питания / добавок."""
    if not getattr(settings, "supplement_reminder_enabled", False):
        return
    try:
        supplements = (
            db.query(Supplement)
            .filter(
                Supplement.telegram_id == tid,
                Supplement.reminder_enabled == True,  # noqa: E712 — нужно для SQL
            )
            .all()
        )
    except Exception as exc:
        logger.warning("_process_supplement_reminders: ошибка выборки (%s) tid=%s", exc, tid)
        return

    for sup in supplements:
        try:
            intake_time = getattr(sup, "intake_time", None)
            if not _time_reached(now, intake_time):
                continue
            kind = f"supplement:{sup.id}"
            if _was_sent(db, tid, kind, today):
                continue
            name = sup.name or "добавка"
            dosage = (f" — {sup.dosage}" if getattr(sup, "dosage", None) else "")
            text = (
                f"💊 <b>Приём добавки</b>\n"
                f"Пора принять: <b>{name}</b>{dosage}"
            )
            if send_telegram(tid, text):
                _mark_sent(db, tid, kind, today)
        except Exception as exc:
            # Сбой по одной добавке не должен прерывать остальные.
            logger.warning("_process_supplement_reminders: сбой по добавке (%s) tid=%s", exc, tid)


def _process_daily_summary(db, tid: int, today: str, now: datetime,
                           user: "User", settings: "NotificationSettings") -> None:
    """Вечерняя сводка по дню: съедено / цель / осталось."""
    if not getattr(settings, "daily_summary_enabled", False):
        return
    if not _time_reached(now, getattr(settings, "summary_time", None)):
        return
    if _was_sent(db, tid, "summary", today):
        return

    # Считаем съеденные за день калории.
    try:
        entries = (
            db.query(DiaryEntry)
            .filter(DiaryEntry.telegram_id == tid, DiaryEntry.date == today)
            .all()
        )
    except Exception as exc:
        logger.warning("_process_daily_summary: ошибка выборки дневника (%s) tid=%s", exc, tid)
        return

    eaten = sum((e.calories or 0) for e in entries)
    goal = getattr(user, "daily_goal_kcal", None)

    if goal:
        remaining = goal - eaten
        if remaining >= 0:
            tail = f"Осталось: <b>{remaining}</b> ккал ✅"
        else:
            tail = f"Превышение: <b>{abs(remaining)}</b> ккал ⚠️"
        text = (
            "📊 <b>Итоги дня</b>\n"
            f"Съедено: <b>{eaten}</b> ккал\n"
            f"Цель: <b>{goal}</b> ккал\n"
            f"{tail}"
        )
    else:
        # Цель не задана — отдаём только факт съеденного.
        text = (
            "📊 <b>Итоги дня</b>\n"
            f"Съедено: <b>{eaten}</b> ккал\n"
            "Цель по калориям не задана — задайте её в профиле 🎯"
        )

    if send_telegram(tid, text):
        _mark_sent(db, tid, "summary", today)


# --------------------------------------------------------------------------- #
#  Главная функция проверки (вызывается планировщиком каждую минуту)
# --------------------------------------------------------------------------- #
def check_notifications() -> None:
    """Проверить условия и разослать уведомления всем пользователям.

    Открывает собственную сессию БД, проходит по всем NotificationSettings,
    проверяет условия и отправляет напоминания с дедупликацией. Каждый
    пользователь обрабатывается в своём try/except, чтобы сбой одного не
    останавливал остальных. Сессия закрывается в finally.
    """
    db = SessionLocal()
    try:
        # Текущее время в часовом поясе приложения и ISO-дата «сегодня».
        try:
            now = datetime.now(APP_TZ) if APP_TZ is not None else datetime.now()
        except Exception:
            now = datetime.now()
        today = now.date().isoformat()

        # Все строки настроек уведомлений (по одной на пользователя).
        try:
            all_settings = db.query(NotificationSettings).all()
        except Exception as exc:
            logger.warning("check_notifications: не удалось прочитать настройки (%s)", exc)
            return

        for settings in all_settings:
            tid = getattr(settings, "telegram_id", None)
            if tid is None:
                continue
            try:
                # Профиль пользователя нужен для вечерней сводки (цель калорий).
                user = (
                    db.query(User)
                    .filter(User.telegram_id == tid)
                    .first()
                )
                if user is None:
                    # Настройки без пользователя — пропускаем (целостность данных).
                    continue

                # 1) Напоминания о приёмах пищи (только если не записаны).
                if getattr(settings, "meal_reminder_enabled", False):
                    _process_meal_reminder(
                        db, tid, today, now,
                        kind="breakfast",
                        meal_time=getattr(settings, "breakfast_time", None),
                        label="завтрак", emoji="🍳",
                    )
                    _process_meal_reminder(
                        db, tid, today, now,
                        kind="lunch",
                        meal_time=getattr(settings, "lunch_time", None),
                        label="обед", emoji="🍲",
                    )
                    _process_meal_reminder(
                        db, tid, today, now,
                        kind="dinner",
                        meal_time=getattr(settings, "dinner_time", None),
                        label="ужин", emoji="🍽️",
                    )

                # 2) Напоминание о тренировке.
                _process_training_reminder(db, tid, today, now, settings)

                # 3) Напоминания о приёме добавок.
                _process_supplement_reminders(db, tid, today, now, settings)

                # 4) Вечерняя сводка дня.
                _process_daily_summary(db, tid, today, now, user, settings)

            except Exception as exc:
                # Сбой по одному пользователю не должен прерывать рассылку.
                logger.warning("check_notifications: сбой по пользователю tid=%s: %s", tid, exc)
                try:
                    db.rollback()
                except Exception:
                    pass

    except Exception as exc:
        # Любой неожиданный сбой — логируем, приложение не роняем.
        logger.warning("check_notifications: общий сбой проверки уведомлений: %s", exc)
    finally:
        try:
            db.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
#  Запуск / остановка планировщика
# --------------------------------------------------------------------------- #
def start_scheduler():
    """Запустить фоновый планировщик проверки уведомлений.

    Возвращает объект планировщика или None, если запуск невозможен/не нужен:
      * ENABLE_SCHEDULER == "0" — планировщик принудительно отключён;
      * не задан BOT_TOKEN — отправлять уведомления некуда;
      * не установлен APScheduler.

    Никогда не бросает исключение наружу: при любом сбое возвращает None,
    чтобы запуск API не зависел от планировщика.
    """
    try:
        if os.getenv("ENABLE_SCHEDULER") == "0":
            logger.info("Планировщик уведомлений отключён (ENABLE_SCHEDULER=0)")
            return None
        if not BOT_TOKEN:
            logger.info("Планировщик уведомлений не запущен: не задан BOT_TOKEN")
            return None
        if BackgroundScheduler is None:
            logger.warning("Планировщик уведомлений не запущен: APScheduler не установлен")
            return None

        # Планировщик в часовом поясе приложения (если доступен).
        try:
            scheduler = BackgroundScheduler(timezone=APP_TZ) if APP_TZ is not None else BackgroundScheduler()
        except Exception:
            # На случай несовместимости tz с APScheduler — без явного tz.
            scheduler = BackgroundScheduler()

        # Проверяем условия раз в 60 секунд. Все ошибки внутри job уже
        # перехвачены в check_notifications, так что job не «упадёт».
        scheduler.add_job(
            check_notifications,
            trigger="interval",
            seconds=60,
            id="check_notifications",
            replace_existing=True,
            # Если предыдущий запуск задержался — не накапливаем пропущенные.
            max_instances=1,
            coalesce=True,
        )
        scheduler.start()
        logger.info("Планировщик уведомлений запущен (интервал 60 с, TZ=%s)", APP_TZ_NAME)
        return scheduler
    except Exception as exc:
        logger.warning("Не удалось запустить планировщик уведомлений: %s", exc)
        return None


def stop_scheduler(sched) -> None:
    """Остановить планировщик (если он был запущен). Ошибки игнорируем."""
    if sched is None:
        return
    try:
        sched.shutdown(wait=False)
        logger.info("Планировщик уведомлений остановлен")
    except Exception as exc:
        logger.warning("Ошибка остановки планировщика уведомлений: %s", exc)
