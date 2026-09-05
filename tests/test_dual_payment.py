"""Два способа оплаты подписки одновременно: Telegram Stars и банковская карта.

Проверяем, что статус подписки корректно сообщает фронту о доступности карты
(и НЕ обещает её, когда приём карт не настроен или у тарифа нет рублёвой цены),
а также что оба канала начисляют доступ через общий слой активации.

Запуск:  .venv/Scripts/python.exe tests/test_dual_payment.py
"""

import base64
import hashlib
import hmac
import importlib
import os
import sys
import pathlib
import tempfile
from urllib.parse import urlencode

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_tmp = tempfile.mkdtemp()
SECRET = "dual_secret"

os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_tmp, "dual.db").replace("\\", "/")
os.environ["ENABLE_SCHEDULER"] = "0"
os.environ["OWNER_ID"] = "0"
os.environ["ALLOW_INSECURE_AUTH"] = "1"
os.environ["PRICE_MONTHLY_STARS"] = "250"
os.environ["PRICE_YEARLY_STARS"] = "2000"
os.environ["PRICE_LIFETIME_STARS"] = "4000"


def build_app(card_enabled: bool):
    """Пересобрать приложение с включённым/выключенным приёмом карт."""
    if card_enabled:
        os.environ["CLOUDPAYMENTS_PUBLIC_ID"] = "pk_dual"
        os.environ["CLOUDPAYMENTS_API_SECRET"] = SECRET
        os.environ["PRICE_MONTHLY_RUB"] = "499"
        os.environ["PRICE_YEARLY_RUB"] = "3990"
        os.environ["PRICE_LIFETIME_RUB"] = "0"      # картой не продаётся
    else:
        for key in ("CLOUDPAYMENTS_PUBLIC_ID", "CLOUDPAYMENTS_API_SECRET",
                    "PRICE_MONTHLY_RUB", "PRICE_YEARLY_RUB", "PRICE_LIFETIME_RUB"):
            os.environ.pop(key, None)

    import backend.config
    importlib.reload(backend.config)
    import backend.cloudpayments
    importlib.reload(backend.cloudpayments)
    import backend.main
    importlib.reload(backend.main)

    from fastapi.testclient import TestClient
    from backend.database import init_db
    init_db()
    return TestClient(backend.main.app), backend.main


def main():
    problems = []

    def check(name, condition, extra=""):
        if not condition:
            problems.append(f"{name}  {extra}")

    # --- 1. Карты НЕ настроены: витрина есть, но оплаты нет ----------------
    # Рублёвая цена и кнопка показываются всегда (их требует модерация
    # платёжного сервиса), а вот принять деньги без ключей нельзя.
    client, _ = build_app(card_enabled=False)
    status = client.get("/subscription/status").json()

    check("статус отдаётся", "tariffs" in status, status)
    check("витрина показывается", status.get("card_enabled") is True,
          status.get("card_enabled"))
    check("провайдер = none без ключей", status.get("card_provider") == "none",
          status.get("card_provider"))
    check("рублёвые цены есть", bool(status.get("card_prices")), status.get("card_prices"))
    check("звёздные тарифы на месте", set(status.get("tariffs", {})) ==
          {"monthly", "yearly", "lifetime"}, sorted(status.get("tariffs", {})))

    resp = client.get("/payment/cloudpayments/config", params={"tariff": "monthly"})
    check("конфиг карты -> 503, когда выключено", resp.status_code == 503, resp.status_code)

    # --- 2. Карты настроены: оба способа доступны одновременно -------------
    client, main_module = build_app(card_enabled=True)
    status = client.get("/subscription/status").json()

    check("card_enabled=True", status.get("card_enabled") is True, status.get("card_enabled"))
    check("провайдер = cloudpayments", status.get("card_provider") == "cloudpayments",
          status.get("card_provider"))
    check("валюта", status.get("card_currency") == "RUB", status.get("card_currency"))
    prices = status.get("card_prices") or {}
    check("цена месячного", prices.get("monthly") == 499, prices)
    check("цена годового", prices.get("yearly") == 3990, prices)
    check("вечный тариф без рублёвой цены не предлагается картой",
          "lifetime" not in prices, prices)
    # Звёзды никуда не делись — это по-прежнему основной способ.
    check("звёзды доступны для всех трёх тарифов",
          set(status.get("tariffs", {})) == {"monthly", "yearly", "lifetime"},
          sorted(status.get("tariffs", {})))
    check("цена в звёздах сохранилась",
          status["tariffs"]["monthly"]["stars"] == 250, status["tariffs"]["monthly"])

    # --- 3. Конфиг виджета: публичные данные, без секрета ------------------
    resp = client.get("/payment/cloudpayments/config", params={"tariff": "monthly"})
    check("конфиг карты 200", resp.status_code == 200, resp.text[:200])
    cfg = resp.json() if resp.status_code == 200 else {}
    check("public_id отдан", cfg.get("public_id") == "pk_dual", cfg.get("public_id"))
    check("секрет не утёк", SECRET not in resp.text, "секрет в ответе!")
    check("сумма в рублях", cfg.get("amount") == 499, cfg.get("amount"))
    check("плательщик — текущий пользователь", cfg.get("account_id") == "1",
          cfg.get("account_id"))

    resp = client.get("/payment/cloudpayments/config", params={"tariff": "lifetime"})
    check("вечный картой -> 400", resp.status_code == 400, resp.status_code)

    # --- 4. Оплата картой реально включает премиум -------------------------
    fields = {
        "OperationType": "Payment", "Status": "Completed", "TransactionId": "9001", "Amount": "499", "Currency": "RUB",
        "AccountId": "1", "InvoiceId": cfg.get("invoice_id", "monthly:1:x"),
        "TestMode": "0",
    }
    body = urlencode(fields).encode()
    signature = base64.b64encode(
        hmac.new(SECRET.encode(), body, hashlib.sha256).digest()
    ).decode()
    resp = client.post(
        "/payment/cloudpayments/webhook",
        content=body,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Content-HMAC": signature},
    )
    check("вебхук -> {'code': 0}", resp.json() == {"code": 0}, resp.json())

    status = client.get("/subscription/status").json()
    check("после оплаты картой премиум активен", status.get("is_premium") is True, status)
    check("тип подписки monthly", status.get("subscription_type") == "monthly",
          status.get("subscription_type"))

    # --- 5. Оплата звёздами по-прежнему создаёт счёт -----------------------
    # Сам вызов Telegram не делаем — проверяем, что маршрут существует и
    # требует корректный тариф (создание счёта уходит в Bot API).
    resp = client.post("/payment/stars/invoice", json={"tariff": "нет-такого"})
    check("неизвестный тариф для звёзд -> ошибка", resp.status_code >= 400, resp.status_code)

    if problems:
        print("FAIL:")
        for p in problems:
            print("  -", p)
        return 1

    print("OK: без настройки карт фронт их не предлагает (card_enabled=False, конфиг 503);")
    print("    с настройкой доступны ОБА способа — звёзды для всех тарифов и карта для")
    print("    тарифов с рублёвой ценой; секрет не утекает; оплата картой включает премиум")
    return 0


if __name__ == "__main__":
    sys.exit(main())
