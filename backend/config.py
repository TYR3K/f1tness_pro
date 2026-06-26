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

# Секрет вебхука Telegram (заголовок X-Telegram-Bot-Api-Secret-Token).
# Если пусто — проверка секрета пропускается (dev-режим).
TELEGRAM_WEBHOOK_SECRET: str = os.getenv("TELEGRAM_WEBHOOK_SECRET", "")

# Секрет вебхука платёжного провайдера Tribute.
# Если пусто — проверка секрета пропускается (dev-режим).
TRIBUTE_WEBHOOK_SECRET: str = os.getenv("TRIBUTE_WEBHOOK_SECRET", "")

# Username бота (без "@") — для формирования ссылок/счётов.
BOT_USERNAME: str = os.getenv("BOT_USERNAME", "")

# Ссылка на оплату через Tribute (создаётся в Tribute и кладётся в env).
# Если пусто — кнопка «Оплатить через Tribute» на фронте просто не показывается.
TRIBUTE_URL: str = os.getenv("TRIBUTE_URL", "")


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
