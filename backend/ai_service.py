"""
Сервис AI-распознавания еды по фотографии.

Использует OpenAI GPT-4o (Vision) для анализа изображения блюда и оценки
его калорийности и БЖУ. Перед отправкой изображение уменьшается с помощью
Pillow для снижения стоимости запроса.

Надёжность:
  * промпт настроен на «всегда дай оценку» (не отказываться от обычной еды);
  * при пустом/некорректном ответе модели делается повторная попытка;
  * ответ парсится устойчиво (срезаются markdown-ограждения ```);
  * «сырой» ответ модели логируется и возвращается в debug-данных,
    чтобы его можно было посмотреть при отладке.

Публичная функция:
    analyze_food_image(image_bytes, mime="image/jpeg") -> dict
"""

import base64
import io
import json
import logging
import os
import re

# Pillow — для уменьшения изображения (best-effort, не критично для работы).
try:
    from PIL import Image
except Exception:  # pragma: no cover - на случай отсутствия Pillow
    Image = None

# Клиент OpenAI (openai>=1.40). Ключ OPENAI_API_KEY берётся из окружения
# автоматически при создании клиента OpenAI().
from openai import OpenAI

logger = logging.getLogger("ai_service")

# Модель можно переопределить переменной окружения (например, gpt-4o-mini — дешевле).
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o")
# Максимальный размер большей стороны изображения после уменьшения (в пикселях).
MAX_DIMENSION = 1024
# Качество JPEG при пересжатии.
JPEG_QUALITY = 85
# Лимит токенов ответа (JSON с оценкой короткий — этого с запасом хватает).
MAX_TOKENS = 700
# Сколько всего попыток сделать при пустом/битом ответе модели.
MAX_ATTEMPTS = 2

# Текст-маркер «на фото нет еды».
NO_FOOD_NAME = "На фото не найдено еды"

# Системный промпт: заставляем модель ВСЕГДА оценивать обычную еду,
# а не отказываться. Отказ допустим только если еды на фото реально нет.
SYSTEM_PROMPT = (
    "Ты — опытный нутрициолог. На фотографии — еда. "
    "Твоя задача — ВСЕГДА определить блюдо и оценить его пищевую ценность, "
    "даже если ты не уверен на 100%: дай наиболее вероятную оценку по тому, что видишь.\n\n"
    "Верни СТРОГО валидный JSON-объект (и НИЧЕГО кроме него) с полями:\n"
    '  "dish_name" — строка, название блюда на русском '
    '(например: "Варёный картофель", "Тефтели с подливой", "Варёная кукуруза");\n'
    '  "calories"  — целое число, ккал для порции, видимой на фото;\n'
    '  "proteins"  — число, белки в граммах;\n'
    '  "fats"      — число, жиры в граммах;\n'
    '  "carbs"     — число, углеводы в граммах;\n'
    '  "note"      — строка, короткий комментарий на русском '
    "(состав, степень уверенности или совет).\n\n"
    "Правила:\n"
    "- Оценивай реалистично по размеру видимой порции; для настоящей еды "
    "calories и БЖУ должны быть БОЛЬШЕ нуля.\n"
    "- Если на фото несколько продуктов — оцени их суммарно и перечисли в dish_name.\n"
    "- НЕ отказывайся от оценки обычных блюд (картофель, мясо, каши, супы и т.п.).\n"
    "- Только если на фото СОВСЕМ нет еды (пустая тарелка, не еда), "
    'верни dish_name="' + NO_FOOD_NAME + '" и нули.'
)


class AIError(RuntimeError):
    """Ошибка анализа фото. Несёт «сырой» ответ модели для отладки."""

    def __init__(self, message: str, raw: str = "", finish_reason=None, refusal=None):
        super().__init__(message)
        self.raw = raw or ""
        self.finish_reason = finish_reason
        self.refusal = refusal


def _downscale_image(image_bytes: bytes) -> tuple[bytes, str]:
    """
    Уменьшает изображение до MAX_DIMENSION по большей стороне и пересжимает
    в JPEG (best-effort). Возвращает кортеж (байты, mime).

    Если Pillow недоступен или произошла любая ошибка — возвращает исходные
    байты как есть с mime "image/jpeg".
    """
    if Image is None:
        return image_bytes, "image/jpeg"

    try:
        img = Image.open(io.BytesIO(image_bytes))

        # Приводим к RGB, чтобы корректно сохранить в JPEG.
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        width, height = img.size
        largest = max(width, height)
        if largest > MAX_DIMENSION:
            scale = MAX_DIMENSION / float(largest)
            new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
            img = img.resize(new_size, Image.LANCZOS)

        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=JPEG_QUALITY)
        return buffer.getvalue(), "image/jpeg"
    except Exception:
        return image_bytes, "image/jpeg"


def _coerce_int(value, default: int = 0) -> int:
    """Безопасно приводит значение к целому числу (с округлением)."""
    try:
        if value is None:
            return default
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def _coerce_float(value, default: float = 0.0) -> float:
    """Безопасно приводит значение к числу с плавающей точкой (округление до 1 знака)."""
    try:
        if value is None:
            return default
        return round(float(value), 1)
    except (TypeError, ValueError):
        return default


def _extract_json(content: str):
    """
    Пытается достать JSON-объект из текста ответа модели.

    Устойчив к markdown-ограждениям (```json ... ```) и к лишнему тексту
    вокруг: берёт подстроку от первой "{" до последней "}". Возвращает dict
    или None, если распарсить не удалось.
    """
    if not content:
        return None

    text = content.strip()

    # Срезаем ограждения ```json ... ``` или ``` ... ```.
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()

    # Прямой разбор.
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except (ValueError, TypeError):
        pass

    # Фолбэк: берём фрагмент между первой "{" и последней "}".
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            data = json.loads(text[start:end + 1])
            if isinstance(data, dict):
                return data
        except (ValueError, TypeError):
            pass

    return None


def _call_model(client: "OpenAI", data_url: str):
    """Один вызов модели. Возвращает (content, finish_reason, refusal)."""
    response = client.chat.completions.create(
        model=MODEL,
        response_format={"type": "json_object"},
        max_tokens=MAX_TOKENS,
        temperature=0.3,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Определи блюдо на этом фото и оцени его калорийность и БЖУ. "
                            "Верни результат строго в формате JSON по инструкции."
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
    )
    choice = response.choices[0]
    content = choice.message.content
    refusal = getattr(choice.message, "refusal", None)
    return content, choice.finish_reason, refusal


def analyze_food_image(image_bytes: bytes, mime: str = "image/jpeg") -> dict:
    """
    Анализирует фотографию еды и возвращает оценку калорийности и БЖУ.

    Возвращает словарь:
        {
            "dish_name": str, "calories": int, "proteins": float,
            "fats": float, "carbs": float, "note": str,
            "_debug": { "raw": str, "finish_reason": str|None,
                        "refusal": str|None, "model": str, "attempts": int },
        }

    При невозможности получить корректный ответ выбрасывает AIError
    (наследник RuntimeError) с «сырым» ответом модели внутри.
    """
    # 1. Уменьшаем изображение и формируем data URL.
    processed_bytes, processed_mime = _downscale_image(image_bytes)
    b64 = base64.b64encode(processed_bytes).decode("ascii")
    data_url = f"data:{processed_mime};base64,{b64}"

    # 2. Клиент OpenAI (ключ из переменной окружения OPENAI_API_KEY).
    client = OpenAI()

    last_error = "неизвестная ошибка"
    raw = ""
    finish_reason = None
    refusal = None

    # 3. Несколько попыток: пустой/битый ответ модели — частая транзиентная проблема.
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            content, finish_reason, refusal = _call_model(client, data_url)
            raw = content or ""
            # Всегда логируем сырой ответ — он будет виден в логах Railway/uvicorn.
            logger.info(
                "AI попытка %d/%d: finish=%s refusal=%s raw=%s",
                attempt, MAX_ATTEMPTS, finish_reason, refusal, raw[:600],
            )
        except Exception as exc:  # сеть, ключ, лимиты OpenAI и т.п.
            last_error = f"ошибка обращения к OpenAI: {exc}"
            logger.warning("AI попытка %d/%d не удалась: %s", attempt, MAX_ATTEMPTS, exc)
            continue

        if not raw.strip():
            last_error = (
                "модель вернула пустой ответ "
                f"(finish_reason={finish_reason}, refusal={refusal or 'нет'})"
            )
            continue

        data = _extract_json(raw)
        if data is None:
            last_error = "ответ модели не является корректным JSON"
            continue

        # 4. Успех: нормализуем поля.
        dish_name = data.get("dish_name")
        if not isinstance(dish_name, str) or not dish_name.strip():
            dish_name = NO_FOOD_NAME

        note = data.get("note")
        if not isinstance(note, str):
            note = ""

        return {
            "dish_name": dish_name.strip(),
            "calories": _coerce_int(data.get("calories")),
            "proteins": _coerce_float(data.get("proteins")),
            "fats": _coerce_float(data.get("fats")),
            "carbs": _coerce_float(data.get("carbs")),
            "note": note.strip(),
            "_debug": {
                "raw": raw,
                "finish_reason": finish_reason,
                "refusal": refusal,
                "model": MODEL,
                "attempts": attempt,
            },
        }

    # 5. Все попытки исчерпаны.
    logger.error("AI: все попытки исчерпаны. Последняя ошибка: %s", last_error)
    raise AIError(
        f"Не удалось распознать еду: {last_error}",
        raw=raw,
        finish_reason=finish_reason,
        refusal=refusal,
    )
