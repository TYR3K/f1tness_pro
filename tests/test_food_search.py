"""Поиск блюд во внешней базе (Open Food Facts).

Проверяем самое хрупкое: пересчёт энергии из килоджоулей, отбраковку мусорных
записей, кэш и ГЛОБАЛЬНЫЙ троттлинг (у внешнего сервиса лимит 10 запросов в
минуту на IP всего сервера — без ограничителя нас забанит за минуту).

Сеть не используется: httpx.get подменяется.

Запуск:  .venv/Scripts/python.exe tests/test_food_search.py
"""

import os
import sys
import pathlib
import tempfile
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_tmp, "fs.db").replace("\\", "/")
os.environ["ALLOW_INSECURE_AUTH"] = "1"
os.environ["ENABLE_SCHEDULER"] = "0"
os.environ["OWNER_ID"] = "0"

from backend import food_search  # noqa: E402


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


def make_hits():
    return {
        "hits": [
            # 1) Нормальная запись с готовыми ккал.
            {"code": "1", "product_name": "Творог 5%", "brands": "Простоквашино",
             "nutriments": {"energy-kcal_100g": 121, "proteins_100g": 16.0,
                            "fat_100g": 5.0, "carbohydrates_100g": 3.0}},
            # 2) Энергия ТОЛЬКО в килоджоулях -> должна пересчитаться в ккал.
            {"code": "2", "product_name": "Молоко 2.5%", "brands": ["Домик в деревне"],
             "nutriments": {"energy-kj_100g": 220, "proteins_100g": 2.9,
                            "fat_100g": 2.5, "carbohydrates_100g": 4.7}},
            # 3) Устаревшее поле energy_100g (тоже кДж).
            {"code": "3", "product_name": "Гречка", "brands": None,
             "nutriments": {"energy_100g": 1380, "proteins_100g": 12.6,
                            "fat_100g": 3.3, "carbohydrates_100g": 68.0}},
            # --- мусор, который обязан отсеяться ---
            {"code": "4", "product_name": "", "nutriments": {"energy-kcal_100g": 100}},
            {"code": "5", "product_name": "Без нутриентов", "nutriments": {}},
            {"code": "6", "product_name": "Битые калории", "nutriments": {"energy-kcal_100g": 99999}},
            {"code": "7", "product_name": "Нулевые калории", "nutriments": {"energy-kcal_100g": 0}},
            {"code": "8", "nutriments": {"energy-kcal_100g": 50}},
            "не словарь",
            # 9) Дубликат первой записи по названию+бренду.
            {"code": "9", "product_name": "творог 5%", "brands": "Простоквашино",
             "nutriments": {"energy-kcal_100g": 121, "proteins_100g": 16.0,
                            "fat_100g": 5.0, "carbohydrates_100g": 3.0}},
        ]
    }


def reset_state():
    food_search._cache.clear()
    food_search._request_times.clear()


def main():
    problems = []

    def check(name, condition, extra=""):
        if not condition:
            problems.append(f"{name}  {extra}")

    # --- 1. Нормализация: пересчёт кДж, отбраковка мусора, дедупликация -----
    reset_state()
    calls = []

    def fake_get(url, params=None, timeout=None, headers=None):
        calls.append({"url": url, "params": params, "headers": headers})
        return FakeResponse(make_hits())

    with mock.patch.object(food_search.httpx, "get", fake_get):
        items = food_search.search_products("творог", lang="ru", limit=12)

    names = [i["name"] for i in items]
    check("отсеян мусор и дубликаты", len(items) == 3, names)
    check("названия", names == ["Творог 5%", "Молоко 2.5%", "Гречка"], names)

    by_name = {i["name"]: i for i in items}
    check("готовые ккал взяты как есть", by_name["Творог 5%"]["calories"] == 121,
          by_name["Творог 5%"]["calories"])
    # 220 кДж / 4.184 = 52.6 -> 53
    check("кДж пересчитаны (energy-kj_100g)", by_name["Молоко 2.5%"]["calories"] == 53,
          by_name["Молоко 2.5%"]["calories"])
    # 1380 кДж / 4.184 = 329.8 -> 330
    check("кДж пересчитаны (energy_100g)", by_name["Гречка"]["calories"] == 330,
          by_name["Гречка"]["calories"])
    check("бренд-массив приведён к строке",
          by_name["Молоко 2.5%"]["brand"] == "Домик в деревне", by_name["Молоко 2.5%"]["brand"])
    check("макросы округлены", by_name["Творог 5%"]["proteins"] == 16.0,
          by_name["Творог 5%"]["proteins"])

    # --- 2. Обязательные требования внешнего сервиса ------------------------
    check("один сетевой запрос", len(calls) == 1, len(calls))
    if calls:
        check("указан User-Agent", "User-Agent" in calls[0]["headers"], calls[0]["headers"])
        check("поля ограничены", "fields" in calls[0]["params"], calls[0]["params"])
        check("язык передан", calls[0]["params"].get("langs") == "ru,en",
              calls[0]["params"].get("langs"))

    # --- 3. Кэш: повторный запрос не идёт в сеть ----------------------------
    with mock.patch.object(food_search.httpx, "get", fake_get):
        again = food_search.search_products("творог", lang="ru", limit=12)
    check("кэш отдал тот же результат", again == items)
    check("кэш предотвратил сетевой запрос", len(calls) == 1, len(calls))

    # --- 4. Глобальный троттлинг ------------------------------------------
    reset_state()
    net_calls = {"n": 0}

    def counting_get(url, params=None, timeout=None, headers=None):
        net_calls["n"] += 1
        return FakeResponse({"hits": []})

    with mock.patch.object(food_search.httpx, "get", counting_get):
        for i in range(food_search.MAX_REQUESTS_PER_MIN + 5):
            food_search.search_products(f"запрос{i}", lang="ru")
    check("троттлинг ограничил исходящие запросы",
          net_calls["n"] == food_search.MAX_REQUESTS_PER_MIN, net_calls["n"])

    # --- 5. Отказоустойчивость: сеть падает -> пустой список, не исключение --
    reset_state()

    def boom(*a, **k):
        raise RuntimeError("сеть недоступна")

    with mock.patch.object(food_search.httpx, "get", boom):
        check("сбой сети -> []", food_search.search_products("что-то") == [])

    reset_state()
    with mock.patch.object(food_search.httpx, "get",
                           lambda *a, **k: FakeResponse({"hits": []}, status_code=503)):
        check("HTTP 503 -> []", food_search.search_products("что-то ещё") == [])

    reset_state()
    with mock.patch.object(food_search.httpx, "get",
                           lambda *a, **k: FakeResponse({"неожиданно": "другое"})):
        check("кривой JSON -> []", food_search.search_products("ещё запрос") == [])

    # --- 6. Слишком короткий запрос вообще не идёт в сеть -------------------
    reset_state()
    with mock.patch.object(food_search.httpx, "get", boom):
        check("1 символ -> []", food_search.search_products("а") == [])
        check("пусто -> []", food_search.search_products("") == [])

    # --- 7. Маршрут /food/search -------------------------------------------
    from fastapi.testclient import TestClient  # noqa: E402
    from backend.database import init_db       # noqa: E402
    from backend.main import app               # noqa: E402

    init_db()
    client = TestClient(app)
    reset_state()

    with mock.patch.object(food_search.httpx, "get", fake_get):
        resp = client.get("/food/search", params={"q": "творог"})
    check("маршрут 200", resp.status_code == 200, resp.text[:200])
    if resp.status_code == 200:
        body = resp.json()
        check("маршрут вернул items", len(body.get("items", [])) == 3, body.get("items"))
        check("маршрут вернул запрос", body.get("query") == "творог", body.get("query"))
        check("основа 100г", body.get("per") == "100g", body.get("per"))

    resp = client.get("/food/search", params={"q": "а"})
    check("короткий запрос -> пусто, но 200",
          resp.status_code == 200 and resp.json()["items"] == [], resp.text[:200])

    if problems:
        print("FAIL:")
        for p in problems:
            print("  -", p)
        return 1

    print("OK: кДж пересчитываются в ккал, мусор и дубликаты отсеиваются,")
    print("    User-Agent и fields передаются, кэш и глобальный троттлинг работают,")
    print("    любые сбои дают пустой список, маршрут /food/search отвечает")
    return 0


if __name__ == "__main__":
    sys.exit(main())
