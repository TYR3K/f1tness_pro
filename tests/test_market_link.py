"""Ссылка «Купить» на маркетплейс: работает без партнёрки, корректно
превращается в партнёрскую при заданном MARKET_CLID.

Партнёрский идентификатор (clid) выдаётся на каждую площадку отдельно и только
после ручной модерации, поэтому код обязан работать и БЕЗ него.

Запуск:  .venv/Scripts/python.exe tests/test_market_link.py
"""

import importlib
import os
import sys
import pathlib
import tempfile
from urllib.parse import urlparse, parse_qs

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_tmp, "mk.db").replace("\\", "/")
os.environ["ENABLE_SCHEDULER"] = "0"


def reload_config(**env):
    """Перечитать config с нужными переменными окружения."""
    for key in ("MARKET_CLID", "MARKET_VID", "MARKET_ERID"):
        os.environ.pop(key, None)
    os.environ.update(env)
    from backend import config
    return importlib.reload(config)


def main():
    problems = []

    def check(name, condition, extra=""):
        if not condition:
            problems.append(f"{name}  {extra}")

    # --- 1. Без партнёрки: чистая поисковая ссылка ---------------------------
    cfg = reload_config()
    url = cfg.market_search_url("Креатин моногидрат")
    parsed = urlparse(url)
    q = parse_qs(parsed.query)

    check("хост маркета", parsed.netloc == "market.yandex.ru", parsed.netloc)
    check("путь поиска", parsed.path == "/search", parsed.path)
    check("запрос закодирован", q.get("text") == ["Креатин моногидрат"], q.get("text"))
    check("нет партнёрских параметров без clid",
          not any(k in q for k in ("clid", "pp", "mclid", "distr_type")), sorted(q))
    check("market_is_affiliate() = False", cfg.market_is_affiliate() is False)

    # --- 2. С партнёркой: добавляется фиксированный хвост + clid -------------
    cfg = reload_config(MARKET_CLID="2337934", MARKET_VID="miniapp", MARKET_ERID="TOKEN123")
    q = parse_qs(urlparse(cfg.market_search_url("Протеин")).query)

    check("clid подставлен", q.get("clid") == ["2337934"], q.get("clid"))
    check("pp=900", q.get("pp") == ["900"], q.get("pp"))
    check("mclid=1003", q.get("mclid") == ["1003"], q.get("mclid"))
    check("distr_type=7", q.get("distr_type") == ["7"], q.get("distr_type"))
    check("vid подставлен", q.get("vid") == ["miniapp"], q.get("vid"))
    check("erid подставлен", q.get("erid") == ["TOKEN123"], q.get("erid"))
    check("текст сохранён", q.get("text") == ["Протеин"], q.get("text"))
    check("market_is_affiliate() = True", cfg.market_is_affiliate() is True)

    # --- 3. Необязательные метки не появляются пустыми ----------------------
    cfg = reload_config(MARKET_CLID="777")
    q = parse_qs(urlparse(cfg.market_search_url("Омега-3")).query)
    check("нет пустого vid", "vid" not in q, sorted(q))
    check("нет пустого erid", "erid" not in q, sorted(q))

    # --- 4. Пустое название -> ссылки нет (кнопку показывать не на что) -----
    check("пустой запрос -> None", cfg.market_search_url("") is None)
    check("пробелы -> None", cfg.market_search_url("   ") is None)
    check("None -> None", cfg.market_search_url(None) is None)

    # --- 5. Спецсимволы корректно кодируются --------------------------------
    tricky = "BCAA 2:1:1 & витамин D3"
    q = parse_qs(urlparse(cfg.market_search_url(tricky)).query)
    check("спецсимволы не ломают ссылку", q.get("text") == [tricky], q.get("text"))

    # Возвращаем окружение в исходное состояние для остальных тестов.
    reload_config()

    if problems:
        print("FAIL:")
        for p in problems:
            print("  -", p)
        return 1

    print("OK: без партнёрки — чистая поисковая ссылка; с MARKET_CLID добавляется")
    print("    хвост pp/mclid/distr_type + clid/vid/erid; пустые метки не попадают;")
    print("    пустой запрос -> None; спецсимволы кодируются корректно")
    return 0


if __name__ == "__main__":
    sys.exit(main())
