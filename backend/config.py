"""
Конфигурация подписки и доступа (Этап 1).

Все значения читаются из переменных окружения (os.getenv). Цены НЕ хардкодим —
тарифы и лимиты задаются через env, чтобы их можно было менять без правки кода.

Модуль НЕ имеет зависимостей от других модулей backend (database/models/auth),
поэтому его безопасно импортировать откуда угодно — циклов импорта не возникает.
"""

import os


# Telegram ID владельца приложения. Доступ владельца определяется СТРОГО по id,
# никогда по username (username можно сменить/подделать). 0 — владелец не задан.
OWNER_ID: int = int(os.getenv("OWNER_ID", "0") or 0)

# Сколько бесплатных сканирований еды в сутки доступно free-пользователю.
FREE_SCAN_LIMIT: int = int(os.getenv("FREE_SCAN_LIMIT", "3"))

# Длительность одноразового бесплатного пробного периода (дней). 0 — триал выключен.
TRIAL_DAYS: int = int(os.getenv("TRIAL_DAYS", "7"))

# Секрет вебхука Telegram (заголовок X-Telegram-Bot-Api-Secret-Token).
# Если пусто — проверка секрета пропускается (dev-режим).
TELEGRAM_WEBHOOK_SECRET: str = os.getenv("TELEGRAM_WEBHOOK_SECRET", "")

# Секрет вебхука платёжного провайдера Tribute.
# Если пусто — проверка секрета пропускается (dev-режим).
TRIBUTE_WEBHOOK_SECRET: str = os.getenv("TRIBUTE_WEBHOOK_SECRET", "")

# Username бота (без "@") — для формирования ссылок/счётов.
BOT_USERNAME: str = os.getenv("BOT_USERNAME", "")

# Публичный https-URL мини-приложения (для кнопки «Открыть приложение» в /start).
# Если задан — к приветствию прикрепляется inline-кнопка web_app. Пример:
# https://f1tnesspro-production.up.railway.app
MINI_APP_URL: str = os.getenv("MINI_APP_URL", "")

# Ссылка на оплату через Tribute (создаётся в Tribute и кладётся в env).
# Если пусто — кнопка «Оплатить через Tribute» на фронте просто не показывается.
TRIBUTE_URL: str = os.getenv("TRIBUTE_URL", "")

# Каталог для приватных фото прогресса (Этап 7). Файлы НЕ раздаются статикой —
# только через авторизованный эндпоинт с проверкой владельца. По умолчанию —
# локальная папка в корне проекта (на Railway диск эфемерный; для постоянного
# хранения позже можно подключить том/R2, поменяв только этот путь).
PROGRESS_PHOTOS_DIR: str = os.getenv("PROGRESS_PHOTOS_DIR", "./progress_photos")

# Максимальный размер загружаемого фото прогресса (12 МБ).
PROGRESS_PHOTO_MAX_BYTES: int = int(os.getenv("PROGRESS_PHOTO_MAX_BYTES", str(12 * 1024 * 1024)))


# Тарифы подписки. Цены — в Telegram Stars (XTR), берутся из env.
#   stars — стоимость в звёздах;
#   days  — на сколько дней продлевается подписка (None = пожизненно).
TARIFFS: dict = {
    "monthly": {
        "stars": int(os.getenv("PRICE_MONTHLY_STARS", "250")),
        "days": int(os.getenv("SUBSCRIPTION_MONTHLY_DAYS", "30")),
    },
    "yearly": {
        "stars": int(os.getenv("PRICE_YEARLY_STARS", "2000")),
        "days": int(os.getenv("SUBSCRIPTION_YEARLY_DAYS", "365")),
    },
    "lifetime": {
        "stars": int(os.getenv("PRICE_LIFETIME_STARS", "4000")),
        "days": None,  # None — пожизненная подписка (без срока окончания).
    },
}


def tariff_for(name):
    """
    Вернуть описание тарифа по его имени ("monthly" | "yearly" | "lifetime")
    или None, если тариф с таким именем не задан.
    """
    return TARIFFS.get(name)


# --------------------------------------------------------------------------- #
#  CloudPayments — ДОПОЛНИТЕЛЬНЫЙ канал оплаты подписки (карты РФ)
#
#  ВАЖНО: основной способ оплаты внутри мини-приложения — Telegram Stars
#  (этого требуют правила Telegram для цифровых товаров). CloudPayments нужен
#  для оплаты ВНЕ Telegram (лендинг/сайт), чтобы не нарушать эти правила.
#
#  Пока переменные не заданы, интеграция полностью выключена: маршруты
#  отвечают 503, виджет на фронте не показывается.
# --------------------------------------------------------------------------- #

# Public ID сайта из личного кабинета CloudPayments (можно светить на фронте).
CLOUDPAYMENTS_PUBLIC_ID = os.getenv("CLOUDPAYMENTS_PUBLIC_ID", "").strip()

# API Secret («пароль для API») — СЕКРЕТ. Им же проверяется подпись вебхуков.
CLOUDPAYMENTS_API_SECRET = os.getenv("CLOUDPAYMENTS_API_SECRET", "").strip()

# Валюта списания.
CLOUDPAYMENTS_CURRENCY = os.getenv("CLOUDPAYMENTS_CURRENCY", "RUB").strip() or "RUB"

# Цены тарифов в рублях (для CloudPayments). Пусто -> тариф недоступен картой.
RUB_PRICES: dict = {
    "monthly": float(os.getenv("PRICE_MONTHLY_RUB", "0") or 0),
    "yearly": float(os.getenv("PRICE_YEARLY_RUB", "0") or 0),
    "lifetime": float(os.getenv("PRICE_LIFETIME_RUB", "0") or 0),
}


def cloudpayments_enabled() -> bool:
    """Настроен ли приём оплаты картой через CloudPayments."""
    return bool(CLOUDPAYMENTS_PUBLIC_ID and CLOUDPAYMENTS_API_SECRET)


def rub_price_for(tariff: str):
    """Цена тарифа в рублях или None, если картой он не продаётся."""
    price = RUB_PRICES.get(tariff)
    return price if price and price > 0 else None


# --------------------------------------------------------------------------- #
#  Витрина «Купить» (маркетплейс) для рекомендаций по спортпиту
#
#  Ссылка собирается ТОЛЬКО на бэкенде: партнёрские параметры не должны быть
#  зашиты во фронт, чтобы их можно было поменять одной переменной окружения.
#
#  Пока партнёрская программа не подключена, MARKET_CLID пуст — тогда отдаётся
#  ОБЫЧНАЯ поисковая ссылка без партнёрского хвоста (она работает сразу).
#  Когда получишь clid площадки в кабинете Яндекс.Дистрибуции — просто задай
#  MARKET_CLID (и при необходимости MARKET_VID / MARKET_ERID), код не меняется.
# --------------------------------------------------------------------------- #

# Базовый адрес поиска маркетплейса. Вынесен в env на случай смены площадки.
MARKET_SEARCH_URL = os.getenv("MARKET_SEARCH_URL", "https://market.yandex.ru/search")

# Идентификатор партнёра (выдаётся на КАЖДУЮ площадку отдельно после модерации).
MARKET_CLID = os.getenv("MARKET_CLID", "").strip()

# Произвольная метка партнёра для сегментации статистики (латиница и цифры).
MARKET_VID = os.getenv("MARKET_VID", "").strip()

# Рекламный токен маркировки (ЕРИР/ОРД). Требуется по ФЗ-38, когда по ссылке
# идёт вознаграждение. Без партнёрки не нужен.
MARKET_ERID = os.getenv("MARKET_ERID", "").strip()

# Фиксированная часть партнёрской ссылки Яндекс.Маркета — одинакова у всех
# партнёров (из официальной справки Яндекс.Дистрибуции).
_MARKET_AFFILIATE_TAIL = {"pp": "900", "mclid": "1003", "distr_type": "7"}


def market_search_url(query: str) -> str | None:
    """Собрать ссылку «Купить» на маркетплейс по названию товара.

    Без MARKET_CLID возвращается обычная поисковая ссылка (работает сразу).
    С заданным MARKET_CLID добавляется партнёрский хвост.
    Пустой запрос -> None (кнопку показывать не на что).
    """
    from urllib.parse import urlencode

    q = (query or "").strip()
    if not q:
        return None

    params = {"text": q}
    if MARKET_CLID:
        params.update(_MARKET_AFFILIATE_TAIL)
        params["clid"] = MARKET_CLID
        if MARKET_VID:
            params["vid"] = MARKET_VID
        if MARKET_ERID:
            params["erid"] = MARKET_ERID

    return f"{MARKET_SEARCH_URL}?{urlencode(params)}"


def market_is_affiliate() -> bool:
    """True, если ссылки партнёрские (тогда по ФЗ-38 нужна пометка «Реклама»)."""
    return bool(MARKET_CLID)
