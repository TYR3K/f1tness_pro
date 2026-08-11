"""Запуск всех проверок проекта одной командой.

    .venv/Scripts/python.exe tests/run_all.py

Каждый тест запускается ОТДЕЛЬНЫМ процессом: модули backend читают переменные
окружения и создают движок БД на импорте, поэтому в одном процессе тесты
влияли бы друг на друга.
"""

import pathlib
import subprocess
import sys

TESTS_DIR = pathlib.Path(__file__).resolve().parent


def main():
    files = sorted(p for p in TESTS_DIR.glob("test_*.py"))
    if not files:
        print("Тесты не найдены")
        return 1

    failed = []
    for path in files:
        print(f"\n{'=' * 60}\n{path.name}\n{'=' * 60}")
        proc = subprocess.run(
            [sys.executable, str(path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        output = (proc.stdout or "") + (proc.stderr or "")
        # Печатаем только содержательные строки (без шума библиотек).
        for line in output.splitlines():
            low = line.lower()
            if any(noise in low for noise in ("deprecation", "from starlette", "http request", "info:")):
                continue
            print(line)
        if proc.returncode != 0:
            failed.append(path.name)

    print(f"\n{'=' * 60}")
    if failed:
        print(f"ПРОВАЛЕНО: {len(failed)} из {len(files)} — {', '.join(failed)}")
        return 1
    print(f"ВСЁ ЗЕЛЁНОЕ: {len(files)} наборов проверок пройдено")
    return 0


if __name__ == "__main__":
    sys.exit(main())
