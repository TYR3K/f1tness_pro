"""
Сервис AI-распознавания еды по фотографии.

Использует OpenAI GPT-4o (Vision) для анализа изображения блюда и оценки
его калорийности и БЖУ. Перед отправкой изображение уменьшается с помощью
Pillow для снижения стоимости запроса.

Публичная функция:
    analyze_food_image(image_bytes, mime="image/jpeg") -> dict
"""

import base64
import io
import json

# Pillow — для уменьшения изображения (best-effort, не критично для работы).
try:
    from PIL import Image
except Exception:  # pragma: no cover - на случай отсутствия Pillow
    Image = None

# Клиент OpenAI (openai>=1.40). Ключ OPENAI_API_KEY берётся из окружения
# автоматически при создании клиента OpenAI().
from openai import OpenAI


# Максимальный размер большей стороны изображения после уменьшения (в пикселях).
MAX_DIMENSION = 1024
# Качество JPEG при пересжатии.
JPEG_QUALITY = 85

# Системный промпт (на русском): задаём роль эксперта-нутрициолога
# и строгий JSON-формат ответа.
SYSTEM_PROMPT = (
    "Ты — эксперт-нутрициолог. Тебе показывают фотографию еды. "
    "Оцени блюдо на фото и верни СТРОГО валидный JSON-объект со следующими полями:\n"
    '  "dish_name"  — строка, название блюда на русском языке;\n'
    '  "calories"   — целое число, калорийность порции на фото в ккал;\n'
    '  "proteins"   — число, белки в граммах на порцию;\n'
    '  "fats"       — число, жиры в граммах на порцию;\n'
    '  "carbs"      — число, углеводы в граммах на порцию;\n'
    '  "note"       — строка, краткий комментарий или оценка блюда на русском.\n'
    "Оценивай реалистично, исходя из размера видимой порции. "
    "Если на фотографии НЕ еда (или распознать блюдо невозможно), "
    'верни dish_name="Не удалось распознать еду", '
    "а calories, proteins, fats и carbs сделай равными нулю. "
    "Не добавляй никакого текста вне JSON."
)


def _downscale_image(image_bytes: bytes) -> tuple[bytes, str]:
    """
    Уменьшает изображение до MAX_DIMENSION по большей стороне и пересжимает
    в JPEG (best-effort). Возвращает кортеж (байты, mime).

    Если Pillow недоступен или произошла любая ошибка — возвращает исходные
    байты как есть с mime "image/jpeg" (data URL всё равно будет валидным,
    GPT-4o корректно работает с распространёнными форматами).
    """
    # Если Pillow не установлен — отдаём исходные байты без изменений.
    if Image is None:
        return image_bytes, "image/jpeg"

    try:
        img = Image.open(io.BytesIO(image_bytes))

        # Приводим к RGB, чтобы корректно сохранить в JPEG
        # (PNG с альфа-каналом, палитра и т.п. иначе вызовут ошибку).
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        # Уменьшаем только если изображение больше лимита по большей стороне.
        width, height = img.size
        largest = max(width, height)
        if largest > MAX_DIMENSION:
            scale = MAX_DIMENSION / float(largest)
            new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
            img = img.resize(new_size, Image.LANCZOS)

        # Сохраняем в JPEG с заданным качеством.
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=JPEG_QUALITY)
        return buffer.getvalue(), "image/jpeg"
    except Exception:
        # Любая проблема с обработкой — откатываемся на исходные байты.
        return image_bytes, "image/jpeg"


def _coerce_int(value, default: int = 0) -> int:
    """Безопасно приводит значение к целому числу (с округлением)."""
    try:
        if value is None:
            return default
        # Сначала через float, чтобы корректно обработать строки вида "120.0".
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


def analyze_food_image(image_bytes: bytes, mime: str = "image/jpeg") -> dict:
    """
    Анализирует фотографию еды и возвращает оценку калорийности и БЖУ.

    Аргументы:
        image_bytes — байты исходного изображения.
        mime        — MIME-тип исходного изображения (для совместимости).

    Возвращает словарь:
        {
            "dish_name": str,
            "calories":  int,
            "proteins":  float,
            "fats":      float,
            "carbs":     float,
            "note":      str,
        }

    При любой ошибке (сеть, OpenAI, некорректный ответ) выбрасывает
    RuntimeError с понятным сообщением на русском языке.
    """
    try:
        # 1. Уменьшаем изображение для экономии токенов (best-effort).
        processed_bytes, processed_mime = _downscale_image(image_bytes)

        # 2. Кодируем в base64 и формируем data URL.
        b64 = base64.b64encode(processed_bytes).decode("ascii")
        data_url = f"data:{processed_mime};base64,{b64}"

        # 3. Создаём клиента OpenAI (ключ из переменной окружения OPENAI_API_KEY).
        client = OpenAI()

        # 4. Запрос к модели gpt-4o с принудительным JSON-ответом.
        response = client.chat.completions.create(
            model="gpt-4o",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "Проанализируй блюдо на этом фото и верни "
                                "результат строго в формате JSON, как указано в инструкции."
                            ),
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": data_url},
                        },
                    ],
                },
            ],
        )

        # 5. Извлекаем и парсим текст ответа модели.
        content = response.choices[0].message.content
        if not content:
            raise ValueError("пустой ответ модели")

        data = json.loads(content)
        if not isinstance(data, dict):
            raise ValueError("ответ модели не является JSON-объектом")

        # 6. Нормализуем поля и приводим числа к нужным типам.
        dish_name = data.get("dish_name")
        if not isinstance(dish_name, str) or not dish_name.strip():
            dish_name = "Не удалось распознать еду"

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
        }
    except Exception as exc:
        # Любая ошибка — оборачиваем в RuntimeError с причиной.
        raise RuntimeError(f"Не удалось проанализировать фото: {exc}") from exc
