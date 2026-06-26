"""
Приём апдейтов Telegram-бота и работа с Bot API (Этап 1, система подписки).

Здесь сосредоточена вся «бот-сторона» подписки:
  * _bot_api(method, payload)        — низкоуровневый вызов Telegram Bot API;
  * create_stars_invoice_link(...)   — создание ссылки на счёт в Telegram Stars;
  * handle_update(db, update)        — обработка входящего апдейта (webhook):
        - pre_checkout_query     -> подтверждаем оплату (answerPreCheckoutQuery);
        - successful_payment     -> активируем premium (payment_providers);
        - /givepro | /revokepro  -> ручная выдача/отзыв доступа ВЛАДЕЛЬЦЕМ;
        - /start                 -> приветственное сообщение.

Язык сообщений:
  Пользовательские сообщения выдаются на двух языках (RU/EN):
    * /start — язык определяется по message["from"]["language_code"]
      (начинается на "ru" -> русский, иначе английский);
    * подтверждение оплаты (successful_payment) — по User.language активированного
      пользователя (фолбэк "ru").
  Ответы ВЛАДЕЛЬЦУ на /givepro и /revokepro оставлены на русском (владелец один).

Безопасность (критично):
  * Команды /givepro и /revokepro доступны ТОЛЬКО владельцу. Владелец
    определяется СТРОГО по telegram_id == config.OWNER_ID, НИКОГДА по username.
    Если команду прислал не владелец — мы просто молча выходим, не отвечая и
    не раскрывая сам факт существования команды.
  * Активация premium происходит только на бэкенде — фронт обойти не может.

Надёжность: ВЕСЬ разбор апдейта обёрнут в try/except. Любой сбой (битый апдейт,
недоступный Bot API, ошибка БД) логируется и не валит обработку вебхука —
наружу исключения не пробрасываются, чтобы Telegram не ретраил вечно.
"""

import logging
import os

# httpx — для обращения к Telegram Bot API. Импортируем мягко, чтобы отсутствие
# зависимости не ломало импорт всего приложения (тот же паттерн, что в notifications.py).
try:
    import httpx
except Exception:  # pragma: no cover - на случай отсутствия httpx
    httpx = None

from datetime import datetime

from backend.config import OWNER_ID, TARIFFS, BOT_USERNAME
from backend.models import User, ProGrant, DiaryEntry
from backend import payment_providers
from backend import subscription
from backend import ai_service

logger = logging.getLogger("telegram_bot")

# Токен Telegram-бота (без него вызовы Bot API невозможны).
BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()


# --------------------------------------------------------------------------- #
#  Локализация пользовательских сообщений (RU / EN)
# --------------------------------------------------------------------------- #
def _norm_lang(lang) -> str:
    """Нормализовать язык к "ru" или "en" (по умолчанию "ru").

    Значение, начинающееся на "en" (без учёта регистра), трактуем как
    английский; всё остальное (None/пусто/"ru"/"ru-RU"/мусор) — как русский.
    Подходит и для Telegram language_code ("en", "en-US", "ru", "ru-RU"...),
    и для сохранённого в БД User.language.
    """
    try:
        if str(lang or "").strip().lower().startswith("en"):
            return "en"
    except Exception:
        pass
    return "ru"


def _user_language(db, tid: int) -> str:
    """Подтянуть язык пользователя по telegram_id (фолбэк "ru").

    При любой ошибке/отсутствии пользователя возвращаем "ru".
    """
    try:
        user = db.query(User).filter(User.telegram_id == tid).first()
        if user is not None:
            return _norm_lang(getattr(user, "language", None))
    except Exception as exc:
        logger.warning("_user_language: ошибка получения языка tid=%s: %s", tid, exc)
    return "ru"


def _greeting_text(lang: str, name: str) -> str:
    """Собрать приветственное сообщение /start на нужном языке.

    name — имя пользователя (может быть пустым). HTML не используется, поэтому
    спецсимволы в имени безопасны для отправки как обычный текст.
    """
    if lang == "en":
        return (
            (f"Hi, {name}! " if name else "Hi! ")
            + "This is the «Calories» app bot 🥗\n\n"
            "Open the mini app to count calories from photos, keep a food diary, "
            "track workouts and supplements.\n"
            "You can subscribe right inside the app."
        )
    # Русский вариант (по умолчанию) — без изменений относительно прежнего текста.
    return (
        (f"Привет, {name}! " if name else "Привет! ")
        + "Это бот приложения «Калории» 🥗\n\n"
        "Открывайте мини-приложение, чтобы считать калории по фото, "
        "вести дневник питания, тренировки и спортпит.\n"
        "Оформить подписку можно прямо в приложении."
    )


def _payment_success_text(lang: str) -> str:
    """Текст подтверждения успешной оплаты на нужном языке."""
    if lang == "en":
        return (
            "✅ Payment received! Premium access is now active.\n"
            "Thank you for your support — enjoy the «Calories» app."
        )
    # Русский вариант (по умолчанию) — без изменений относительно прежнего текста.
    return (
        "✅ Оплата получена! Премиум-доступ активирован.\n"
        "Спасибо за поддержку — приятного пользования приложением «Калории»."
    )


# --------------------------------------------------------------------------- #
#  Локализация голосового ввода еды (Этап 2)
# --------------------------------------------------------------------------- #
# Человекочитаемые названия приёмов пищи для сводки (RU / EN).
_MEAL_TITLES = {
    "ru": {
        "breakfast": "завтрак",
        "lunch": "обед",
        "dinner": "ужин",
        "snack": "перекус",
    },
    "en": {
        "breakfast": "breakfast",
        "lunch": "lunch",
        "dinner": "dinner",
        "snack": "snack",
    },
}


def _voice_premium_required_text(lang: str) -> str:
    """Вежливый отказ free-пользователю на голосовой ввод (нужна подписка)."""
    if lang == "en":
        return (
            "🎤 Voice food logging is a premium feature.\n"
            "Open the «Calories» app to subscribe and add meals just by speaking."
        )
    # Русский вариант (по умолчанию).
    return (
        "🎤 Голосовой ввод еды — премиум-функция.\n"
        "Откройте приложение «Калории», оформите подписку — и добавляйте "
        "приёмы пищи просто голосом."
    )


def _voice_error_text(lang: str) -> str:
    """Вежливое сообщение об ошибке обработки голосового (не распознали и т.п.)."""
    if lang == "en":
        return (
            "😔 Couldn't process your voice message. "
            "Try again and describe what you ate a bit more clearly."
        )
    # Русский вариант (по умолчанию).
    return (
        "😔 Не удалось обработать голосовое сообщение. "
        "Попробуйте ещё раз и опишите чуть чётче, что вы съели."
    )


def _voice_summary_text(lang: str, transcript: str, meal_type: str, items: list) -> str:
    """
    Собрать сводку по распознанному голосовому приёму пищи (RU / EN).

    transcript — распознанный Whisper текст; meal_type — итоговый приём пищи
    ("breakfast"/"lunch"/"dinner"/"snack"); items — список словарей блюд с
    полями dish_name/calories. Возвращает готовый текст сообщения пользователю:
    распознанный текст + список «блюдо — N ккал» + «Итого X ккал» + приём пищи.
    """
    meal_title = _MEAL_TITLES.get(lang, _MEAL_TITLES["ru"]).get(meal_type, meal_type)

    # Итоговая калорийность по всем добавленным блюдам.
    total = 0
    lines = []
    for it in items:
        try:
            cal = int(it.get("calories") or 0)
        except Exception:
            cal = 0
        total += cal
        name = str(it.get("dish_name") or "").strip() or ("dish" if lang == "en" else "блюдо")
        if lang == "en":
            lines.append(f"• {name} — {cal} kcal")
        else:
            lines.append(f"• {name} — {cal} ккал")

    body = "\n".join(lines)
    if lang == "en":
        return (
            f"🎤 Recognized: «{transcript}»\n\n"
            f"{body}\n\n"
            f"Total: {total} kcal\n"
            f"Added to: {meal_title}."
        )
    # Русский вариант (по умолчанию).
    return (
        f"🎤 Распознано: «{transcript}»\n\n"
        f"{body}\n\n"
        f"Итого: {total} ккал\n"
        f"Добавлено в приём: {meal_title}."
    )


# --------------------------------------------------------------------------- #
#  Низкоуровневый вызов Telegram Bot API
# --------------------------------------------------------------------------- #
def _bot_api(method: str, payload: dict):
    """
    Вызвать произвольный метод Telegram Bot API.

    Делает POST на https://api.telegram.org/bot{BOT_TOKEN}/{method} с телом
    payload (JSON). Возвращает поле "result" из ответа Telegram при успехе,
    иначе None. Никогда не бросает исключение наружу.

    Если не задан BOT_TOKEN или не установлен httpx — тихо возвращаем None
    (это не ошибка приложения, просто бот сейчас «немой»).
    """
    if not BOT_TOKEN:
        logger.debug("_bot_api: BOT_TOKEN не задан, метод %s пропущен", method)
        return None
    if httpx is None:
        logger.warning("_bot_api: httpx не установлен, метод %s невозможен", method)
        return None

    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    try:
        resp = httpx.post(url, json=payload, timeout=10)
        # Разбираем JSON-ответ Telegram. Поле ok=true означает успех.
        try:
            data = resp.json()
        except Exception:
            data = None

        if resp.status_code == 200 and isinstance(data, dict) and data.get("ok"):
            return data.get("result")

        # Любой неуспех — логируем (без падения).
        logger.warning(
            "_bot_api: метод=%s статус=%s ответ=%s",
            method, resp.status_code, (resp.text or "")[:300],
        )
        return None
    except Exception as exc:
        # Сетевой/прочий сбой — логируем и считаем неуспехом.
        logger.warning("_bot_api: ошибка вызова метода %s: %s", method, exc)
        return None


# --------------------------------------------------------------------------- #
#  Скачивание файла из Telegram (для голосовых сообщений)
# --------------------------------------------------------------------------- #
def _download_file(file_path: str) -> bytes | None:
    """
    Скачать содержимое файла Telegram по его file_path.

    file_path берётся из ответа метода getFile (result["file_path"]). Сам файл
    лежит по адресу https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}.
    Возвращает байты файла при успехе, иначе None (никогда не бросает наружу).

    Без BOT_TOKEN или httpx, а также при любой сетевой/HTTP-ошибке — тихо
    возвращаем None: это не должно валить обработку апдейта.
    """
    if not BOT_TOKEN:
        logger.debug("_download_file: BOT_TOKEN не задан, скачивание пропущено")
        return None
    if httpx is None:
        logger.warning("_download_file: httpx не установлен, скачивание невозможно")
        return None
    if not file_path:
        return None

    url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}"
    try:
        resp = httpx.get(url, timeout=30)
        if resp.status_code == 200 and resp.content:
            return resp.content
        logger.warning(
            "_download_file: статус=%s длина=%s",
            resp.status_code, len(resp.content or b""),
        )
        return None
    except Exception as exc:
        logger.warning("_download_file: ошибка скачивания файла: %s", exc)
        return None


# --------------------------------------------------------------------------- #
#  Создание ссылки на счёт в Telegram Stars
# --------------------------------------------------------------------------- #
def create_stars_invoice_link(tariff: str, telegram_id: int) -> str:
    """
    Создать ссылку на оплату подписки через Telegram Stars (метод createInvoiceLink).

    Цена берётся из config.TARIFFS[tariff]["stars"] (в звёздах, валюта XTR).
    В payload счёта кодируем "{tariff}:{telegram_id}" — это вернётся обратно
    в successful_payment, и по нему мы поймём, кому и какую подписку активировать.

    Возвращает строку-ссылку. При любой ошибке (неизвестный тариф, сбой Bot API)
    бросает RuntimeError("Не удалось создать счёт") — вызывающий код в main.py
    превратит это в HTTP 502.
    """
    t = TARIFFS.get(tariff)
    if not t:
        # Неизвестный тариф — счёт создать нельзя.
        logger.warning("create_stars_invoice_link: неизвестный тариф %r", tariff)
        raise RuntimeError("Не удалось создать счёт")

    # Цена в звёздах. Для XTR amount задаётся в самих звёздах (не в копейках).
    stars = int(t.get("stars") or 0)

    # Человекочитаемое название тарифа для счёта.
    titles = {
        "monthly": "Подписка на месяц",
        "yearly": "Подписка на год",
        "lifetime": "Пожизненная подписка",
    }
    title = titles.get(tariff, "Подписка")
    description = "Доступ к премиум-функциям приложения «Калории»."

    # payload вернётся в successful_payment — по нему активируем нужного юзера.
    payload = f"{tariff}:{telegram_id}"

    result = _bot_api(
        "createInvoiceLink",
        {
            "title": title,
            "description": description,
            "payload": payload,
            # Платёж в Telegram Stars — валюта XTR без провайдер-токена.
            "currency": "XTR",
            "prices": [{"label": "Подписка", "amount": stars}],
        },
    )

    # Telegram возвращает строку-ссылку прямо в result.
    if isinstance(result, str) and result:
        return result

    # Не получили ссылку — сигнализируем наверх ошибкой.
    logger.warning(
        "create_stars_invoice_link: Bot API не вернул ссылку (tariff=%s, tid=%s)",
        tariff, telegram_id,
    )
    raise RuntimeError("Не удалось создать счёт")


# --------------------------------------------------------------------------- #
#  Вспомогательное: разбор @username из текста команды
# --------------------------------------------------------------------------- #
def _parse_username_arg(text: str) -> str | None:
    """
    Извлечь username из текста команды вида "/givepro @vasya" или "/givepro vasya".

    Возвращает username БЕЗ ведущего "@" или None, если аргумент не указан.
    """
    try:
        parts = str(text).split()
        if len(parts) < 2:
            return None
        uname = parts[1].strip()
        if uname.startswith("@"):
            uname = uname[1:]
        uname = uname.strip()
        return uname or None
    except Exception:
        return None


# --------------------------------------------------------------------------- #
#  Команды владельца: /givepro и /revokepro
# --------------------------------------------------------------------------- #
def _handle_owner_command(db, message: dict, text: str) -> None:
    """
    Обработать команду /givepro или /revokepro.

    БЕЗОПАСНОСТЬ: команду выполняет ТОЛЬКО владелец (from.id == OWNER_ID).
    Если отправитель не владелец — молча выходим (не отвечаем, не раскрываем
    существование команды). Владелец определяется строго по id, не по username.

    Цель команды задаётся через @username: ищем пользователя по User.username.
    Если такого пользователя нет в БД — просим владельца, чтобы цель сначала
    открыла приложение (так у нас появится её telegram_id).

    Примечание по языку: ответы адресованы ВЛАДЕЛЬЦУ (он один), поэтому
    оставлены на русском — локализация здесь не требуется.
    """
    from_id = None
    try:
        from_id = int(message.get("from", {}).get("id"))
    except Exception:
        from_id = None

    # Только владелец. Без OWNER_ID (==0) команда недоступна никому.
    if not OWNER_ID or from_id != OWNER_ID:
        # Молча игнорируем — не раскрываем команду посторонним.
        return

    # Чат, куда отвечать владельцу (его личный чат с ботом).
    chat_id = None
    try:
        chat_id = message.get("chat", {}).get("id")
    except Exception:
        chat_id = None

    is_give = text.strip().startswith("/givepro")
    action = "give" if is_give else "revoke"

    # Разбираем @username из команды.
    uname = _parse_username_arg(text)
    if not uname:
        if chat_id is not None:
            _bot_api("sendMessage", {
                "chat_id": chat_id,
                "text": "Укажите username: /givepro @username",
            })
        return

    # Ищем целевого пользователя по username (он должен был открыть приложение).
    target = None
    try:
        target = db.query(User).filter(User.username == uname).first()
    except Exception as exc:
        logger.warning("_handle_owner_command: ошибка поиска пользователя %s: %s", uname, exc)
        try:
            db.rollback()
        except Exception:
            pass
        target = None

    if target is None:
        if chat_id is not None:
            _bot_api("sendMessage", {
                "chat_id": chat_id,
                "text": (
                    f"Пользователь @{uname} не найден. "
                    "Попросите его открыть приложение хотя бы один раз, "
                    "после этого команда сработает."
                ),
            })
        return

    target_id = getattr(target, "telegram_id", None)

    # Выполняем выдачу/отзыв доступа через единый слой активации.
    try:
        if is_give:
            # Владелец выдаёт пожизненный доступ вручную (provider="owner", сумма 0).
            payment_providers.activate_premium(db, int(target_id), "lifetime", "owner", 0, "XTR")
            result_text = f"Готово: @{uname} получил пожизненный доступ."
        else:
            payment_providers.revoke_premium(db, int(target_id))
            result_text = f"Готово: доступ для @{uname} отозван."
    except Exception as exc:
        logger.warning("_handle_owner_command: сбой %s для %s: %s", action, uname, exc)
        try:
            db.rollback()
        except Exception:
            pass
        if chat_id is not None:
            _bot_api("sendMessage", {
                "chat_id": chat_id,
                "text": f"Не удалось выполнить операцию для @{uname}.",
            })
        return

    # Журналируем факт ручной выдачи/отзыва доступа (ProGrant).
    try:
        db.add(ProGrant(
            granted_by=OWNER_ID,
            granted_to=int(target_id),
            action=action,
        ))
        db.commit()
    except Exception as exc:
        logger.warning("_handle_owner_command: не удалось записать ProGrant (%s)", exc)
        try:
            db.rollback()
        except Exception:
            pass

    # Сообщаем владельцу результат.
    if chat_id is not None:
        _bot_api("sendMessage", {"chat_id": chat_id, "text": result_text})


# --------------------------------------------------------------------------- #
#  Голосовой ввод еды (Этап 2): voice / audio -> Whisper -> GPT -> дневник
# --------------------------------------------------------------------------- #
def _handle_voice_message(db, message: dict) -> None:
    """
    Обработать голосовое (voice) или аудио (audio) сообщение пользователя.

    Сценарий (всё внутри try/except — сбой не валит обработку апдейта):
      1) определяем отправителя и его язык;
      2) проверяем премиум: free-пользователю вежливо отвечаем про подписку
         и выходим (subscription.is_premium);
      3) скачиваем файл (getFile -> file_path -> _download_file);
      4) распознаём речь (ai_service.transcribe_audio) и парсим блюда
         (ai_service.parse_food_text) на языке пользователя;
      5) добавляем каждое блюдо в DiaryEntry за сегодня (meal_type из фразы,
         либо "snack" по умолчанию), коммитим;
      6) отправляем пользователю сводку на его языке (RU/EN).

    При любой ошибке ИИ/скачивания — вежливое сообщение пользователю, без падения.
    """
    # --- 1) Отправитель и чат для ответа -------------------------------------- #
    from_id = None
    try:
        from_id = int(message.get("from", {}).get("id"))
    except Exception:
        from_id = None

    chat_id = None
    try:
        chat_id = message.get("chat", {}).get("id")
    except Exception:
        chat_id = None
    if chat_id is None:
        chat_id = from_id

    if from_id is None or chat_id is None:
        # Без отправителя/чата ответить и сохранить данные некуда.
        return

    # --- 2) Премиум-проверка -------------------------------------------------- #
    # Ищем пользователя в БД. Язык: по User.language, а для незнакомого
    # пользователя — по language_code из самого апдейта.
    user = None
    try:
        user = db.query(User).filter(User.telegram_id == from_id).first()
    except Exception as exc:
        logger.warning("_handle_voice_message: ошибка поиска пользователя tid=%s: %s", from_id, exc)
        try:
            db.rollback()
        except Exception:
            pass
        user = None

    if user is not None:
        lang = _norm_lang(getattr(user, "language", None))
    else:
        lang_code = ""
        try:
            lang_code = message.get("from", {}).get("language_code", "") or ""
        except Exception:
            lang_code = ""
        lang = _norm_lang(lang_code)

    # Нет пользователя в БД или нет активной подписки — вежливый отказ.
    if user is None or not subscription.is_premium(user):
        _bot_api("sendMessage", {
            "chat_id": chat_id,
            "text": _voice_premium_required_text(lang),
        })
        return

    # --- Дальше работаем в защищённом блоке: любая ошибка -> вежливый ответ ---- #
    try:
        # --- 3) Достаём file_id из voice или audio и скачиваем файл ----------- #
        voice = message.get("voice")
        audio = message.get("audio")
        media = voice if isinstance(voice, dict) else audio
        file_id = None
        if isinstance(media, dict):
            file_id = media.get("file_id")
        if not file_id:
            logger.warning("_handle_voice_message: не найден file_id (tid=%s)", from_id)
            _bot_api("sendMessage", {"chat_id": chat_id, "text": _voice_error_text(lang)})
            return

        file_info = _bot_api("getFile", {"file_id": file_id})
        file_path = None
        if isinstance(file_info, dict):
            file_path = file_info.get("file_path")
        if not file_path:
            logger.warning("_handle_voice_message: getFile не вернул file_path (tid=%s)", from_id)
            _bot_api("sendMessage", {"chat_id": chat_id, "text": _voice_error_text(lang)})
            return

        audio_bytes = _download_file(file_path)
        if not audio_bytes:
            logger.warning("_handle_voice_message: не удалось скачать файл (tid=%s)", from_id)
            _bot_api("sendMessage", {"chat_id": chat_id, "text": _voice_error_text(lang)})
            return

        # --- 4) Распознавание речи и парсинг блюд ----------------------------- #
        text = ai_service.transcribe_audio(audio_bytes, "voice.ogg", lang=lang)
        parsed = ai_service.parse_food_text(text, lang=lang)

        items = parsed.get("items") or []
        if not items:
            # GPT не выделил ни одного блюда — сообщаем пользователю.
            _bot_api("sendMessage", {"chat_id": chat_id, "text": _voice_error_text(lang)})
            return

        # Приём пищи: из фразы, иначе "snack" по умолчанию.
        meal_type = parsed.get("meal_type")
        if meal_type not in ("breakfast", "lunch", "dinner", "snack"):
            meal_type = "snack"

        # --- 5) Добавляем каждое блюдо в дневник за сегодня ------------------- #
        today = datetime.utcnow().date().isoformat()
        added = []
        for it in items:
            try:
                entry = DiaryEntry(
                    telegram_id=from_id,
                    date=today,
                    meal_type=meal_type,
                    dish_name=str(it.get("dish_name") or "").strip(),
                    calories=int(it.get("calories") or 0),
                    proteins=float(it.get("proteins") or 0),
                    fats=float(it.get("fats") or 0),
                    carbs=float(it.get("carbs") or 0),
                )
                db.add(entry)
                added.append(it)
            except Exception as exc:
                logger.warning("_handle_voice_message: пропуск блюда %r: %s", it, exc)

        if not added:
            # Ничего не удалось добавить — откатываем и сообщаем об ошибке.
            try:
                db.rollback()
            except Exception:
                pass
            _bot_api("sendMessage", {"chat_id": chat_id, "text": _voice_error_text(lang)})
            return

        db.commit()

        # --- 6) Сводка пользователю на его языке ------------------------------ #
        summary = _voice_summary_text(lang, text, meal_type, added)
        _bot_api("sendMessage", {"chat_id": chat_id, "text": summary})

    except ai_service.AIError as exc:
        # Ошибка ИИ (нет речи / не распознали / GPT не ответил) — вежливый ответ.
        logger.warning("_handle_voice_message: AIError (tid=%s): %s", from_id, exc)
        try:
            db.rollback()
        except Exception:
            pass
        _bot_api("sendMessage", {"chat_id": chat_id, "text": _voice_error_text(lang)})
    except Exception as exc:
        # Любой иной сбой — логируем, вежливо отвечаем, не падаем.
        logger.warning("_handle_voice_message: общий сбой (tid=%s): %s", from_id, exc)
        try:
            db.rollback()
        except Exception:
            pass
        _bot_api("sendMessage", {"chat_id": chat_id, "text": _voice_error_text(lang)})


# --------------------------------------------------------------------------- #
#  Главный обработчик входящего апдейта (webhook)
# --------------------------------------------------------------------------- #
def handle_update(db, update: dict) -> None:
    """
    Обработать один входящий апдейт Telegram (приходит на /telegram/webhook).

    Поддерживаемые виды апдейтов:
      * pre_checkout_query        — подтверждаем готовность принять оплату;
      * message.successful_payment — оплата прошла, активируем premium;
      * message.voice|audio       — голосовой ввод еды (премиум, Этап 2);
      * message.text /givepro|/revokepro — команды владельца (см. выше);
      * message.text /start       — приветствие.

    ВСЁ обёрнуто в try/except — любой сбой логируется и не пробрасывается наружу.
    """
    if not isinstance(update, dict):
        return

    try:
        # --- 1) Предварительная проверка оплаты (нужно ответить за ≤10 сек) --- #
        pre_checkout = update.get("pre_checkout_query")
        if isinstance(pre_checkout, dict):
            pcq_id = pre_checkout.get("id")
            if pcq_id is not None:
                # Подтверждаем, что готовы принять платёж.
                _bot_api("answerPreCheckoutQuery", {
                    "pre_checkout_query_id": pcq_id,
                    "ok": True,
                })
            return

        # Дальше работаем с message (обычное сообщение / событие оплаты).
        message = update.get("message")
        if not isinstance(message, dict):
            # Нет сообщения — обрабатывать нечего.
            return

        # --- 2) Успешная оплата -> активируем premium ------------------------- #
        successful_payment = message.get("successful_payment")
        if isinstance(successful_payment, dict):
            try:
                # payload мы задали при создании счёта: "{tariff}:{telegram_id}".
                payload = successful_payment.get("invoice_payload", "") or ""
                tariff, tid_raw = payload.split(":", 1)
                tid = int(tid_raw)

                payment_providers.activate_premium(
                    db,
                    tid,
                    tariff,
                    "stars",
                    successful_payment.get("total_amount"),
                    successful_payment.get("currency", "XTR"),
                )

                # Подтверждение оплаты — на языке активированного пользователя
                # (User.language, фолбэк "ru"). Берём язык по tid из payload —
                # он точно указывает на того, кому активировали подписку.
                lang = _user_language(db, tid)

                # Подтверждаем пользователю активацию подписки.
                chat_id = message.get("chat", {}).get("id", tid)
                _bot_api("sendMessage", {
                    "chat_id": chat_id,
                    "text": _payment_success_text(lang),
                })
            except Exception as exc:
                logger.warning("handle_update: сбой активации после оплаты: %s", exc)
                try:
                    db.rollback()
                except Exception:
                    pass
            return

        # --- 3) Голосовой / аудио ввод еды (премиум, Этап 2) ----------------- #
        # Если в сообщении есть voice или audio — обрабатываем как голосовой
        # ввод еды. Премиум-проверка и вся обработка — внутри _handle_voice_message.
        if isinstance(message.get("voice"), dict) or isinstance(message.get("audio"), dict):
            _handle_voice_message(db, message)
            return

        # --- 4) Текстовые команды -------------------------------------------- #
        text = message.get("text")
        if isinstance(text, str):
            stripped = text.strip()

            # Команды владельца: выдача/отзыв доступа.
            if stripped.startswith("/givepro") or stripped.startswith("/revokepro"):
                _handle_owner_command(db, message, text)
                return

            # Приветствие по /start.
            if stripped == "/start" or stripped.startswith("/start"):
                chat_id = message.get("chat", {}).get("id")
                if chat_id is not None:
                    name = ""
                    try:
                        name = message.get("from", {}).get("first_name", "") or ""
                    except Exception:
                        name = ""
                    # Язык приветствия — по language_code из апдейта
                    # (ru* -> русский, иначе английский). В БД пользователя ещё
                    # может не быть, поэтому опираемся именно на апдейт.
                    lang_code = ""
                    try:
                        lang_code = message.get("from", {}).get("language_code", "") or ""
                    except Exception:
                        lang_code = ""
                    lang = _norm_lang(lang_code)
                    greeting = _greeting_text(lang, name)
                    _bot_api("sendMessage", {"chat_id": chat_id, "text": greeting})
                return

    except Exception as exc:
        # Любой неожиданный сбой — логируем, наружу не пробрасываем.
        logger.warning("handle_update: общий сбой обработки апдейта: %s", exc)
        try:
            db.rollback()
        except Exception:
            pass
