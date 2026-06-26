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

from backend.config import OWNER_ID, TARIFFS, BOT_USERNAME
from backend.models import User, ProGrant
from backend import payment_providers

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
#  Главный обработчик входящего апдейта (webhook)
# --------------------------------------------------------------------------- #
def handle_update(db, update: dict) -> None:
    """
    Обработать один входящий апдейт Telegram (приходит на /telegram/webhook).

    Поддерживаемые виды апдейтов:
      * pre_checkout_query        — подтверждаем готовность принять оплату;
      * message.successful_payment — оплата прошла, активируем premium;
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

        # --- 3) Текстовые команды -------------------------------------------- #
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
