"""
Сервис AI-распознавания еды по фотографии и текстовых AI-подсказок.

Использует OpenAI GPT-4o (Vision) для анализа изображения блюда и оценки
его калорийности и БЖУ. Перед отправкой изображение уменьшается с помощью
Pillow для снижения стоимости запроса.

Надёжность:
  * промпт настроен на «всегда дай оценку» (не отказываться от обычной еды);
  * при пустом/некорректном ответе модели делается повторная попытка;
  * ответ парсится устойчиво (срезаются markdown-ограждения ```);
  * «сырой» ответ модели логируется и возвращается в debug-данных,
    чтобы его можно было посмотреть при отладке.

Публичные функции:
    analyze_food_image(image_bytes, mime="image/jpeg") -> dict
        Распознаёт блюдо по фото (КБЖУ + примерный вес порции + уверенность).
    recommend_meals(remaining_calories, remaining_proteins, remaining_fats,
                    remaining_carbs, diet_goal, time_of_day) -> dict
        Подбирает 2-3 варианта блюд под остаток КБЖУ на день.
    suggest_supplements(diet_goal) -> dict
        Подбирает спортивные добавки под цель пользователя.
    recommend_supplements(improvement_goal, training_count, workout_types,
                          diet_goal) -> dict
        Персональный подбор добавок с учётом цели улучшения, частоты/типа
        тренировок и цели диеты.
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

# Допустимые значения уровня уверенности модели в оценке.
CONFIDENCE_LEVELS = ("low", "medium", "high")

# Системный промпт: заставляем модель ВСЕГДА оценивать обычную еду,
# а не отказываться. Отказ допустим только если еды на фото реально нет.
SYSTEM_PROMPT = (
    "Ты — опытный нутрициолог. На фотографии — еда. "
    "Твоя задача — ВСЕГДА определить блюдо и оценить его пищевую ценность, "
    "даже если ты не уверен на 100%: дай наиболее вероятную оценку по тому, что видишь.\n\n"
    "Верни СТРОГО валидный JSON-объект (и НИЧЕГО кроме него) с полями:\n"
    '  "dish_name"    — строка, название блюда на русском '
    '(например: "Варёный картофель", "Тефтели с подливой", "Варёная кукуруза");\n'
    '  "weight_grams" — целое число, примерный ВЕС видимой порции в граммах '
    "(оцени по размеру тарелки/приборов на фото);\n"
    '  "calories"     — целое число, ккал для порции, видимой на фото;\n'
    '  "proteins"     — число, белки в граммах;\n'
    '  "fats"         — число, жиры в граммах;\n'
    '  "carbs"        — число, углеводы в граммах;\n'
    '  "confidence"   — строка-уровень уверенности в оценке: '
    '"low", "medium" или "high";\n'
    '  "note"         — строка, короткий комментарий на русском '
    "(состав, степень уверенности или совет).\n\n"
    "Правила:\n"
    "- Оценивай реалистично по размеру видимой порции; для настоящей еды "
    "weight_grams, calories и БЖУ должны быть БОЛЬШЕ нуля.\n"
    "- Если на фото НЕСКОЛЬКО блюд/продуктов — оцени их СУММАРНО "
    "(общий вес и общее КБЖУ) и перечисли все блюда в dish_name через запятую.\n"
    "- confidence ставь \"high\", если блюдо очевидно и порция хорошо видна; "
    "\"medium\" при обычной неопределённости; \"low\", если фото нечёткое "
    "или состав трудно определить.\n"
    "- НЕ отказывайся от оценки обычных блюд (картофель, мясо, каши, супы и т.п.).\n"
    "- Только если на фото СОВСЕМ нет еды (пустая тарелка, не еда), "
    'верни dish_name="' + NO_FOOD_NAME + '", confidence="high" и нули.'
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


def _coerce_confidence(value, default: str = "medium") -> str:
    """
    Нормализует уровень уверенности к одному из CONFIDENCE_LEVELS.

    Принимает строку в любом регистре с возможными пробелами; всё, что
    не входит в допустимый набор, заменяется на default ("medium").
    """
    try:
        if value is None:
            return default
        normalized = str(value).strip().lower()
        return normalized if normalized in CONFIDENCE_LEVELS else default
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
                            "Определи блюдо на этом фото, оцени примерный вес порции, "
                            "калорийность и БЖУ. "
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
            "dish_name": str, "weight_grams": int, "calories": int,
            "proteins": float, "fats": float, "carbs": float,
            "confidence": str, "note": str,
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
            # Примерный вес видимой порции (граммы); если модель не указала — 0.
            "weight_grams": _coerce_int(data.get("weight_grams")),
            "calories": _coerce_int(data.get("calories")),
            "proteins": _coerce_float(data.get("proteins")),
            "fats": _coerce_float(data.get("fats")),
            "carbs": _coerce_float(data.get("carbs")),
            # Уровень уверенности модели; по умолчанию "medium".
            "confidence": _coerce_confidence(data.get("confidence")),
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


# --------------------------------------------------------------------------- #
#  Текстовые AI-подсказки: подбор блюд и спортивных добавок
# --------------------------------------------------------------------------- #
#
# Обе функции ниже используют тот же подход, что и analyze_food_image:
#   * единый клиент OpenAI() (ключ из окружения);
#   * response_format=json_object — модель обязана вернуть JSON-объект;
#   * несколько попыток (MAX_ATTEMPTS) на случай пустого/битого ответа;
#   * устойчивый разбор JSON через _extract_json;
#   * при неудаче — AIError с «сырым» ответом для отладки.

# Системный промпт для подбора блюд под остаток КБЖУ.
RECOMMEND_SYSTEM_PROMPT = (
    "Ты — опытный нутрициолог и повар. Пользователь хочет «добрать» дневную "
    "норму КБЖУ и просит 2-3 варианта блюд под оставшийся лимит.\n\n"
    "Верни СТРОГО валидный JSON-объект (и НИЧЕГО кроме него) с полем:\n"
    '  "suggestions" — массив из 2-3 объектов, каждый с полями:\n'
    '      "dish_name" — строка, название блюда на русском;\n'
    '      "calories"  — целое число, ккал порции;\n'
    '      "proteins"  — число, белки в граммах;\n'
    '      "fats"      — число, жиры в граммах;\n'
    '      "carbs"     — число, углеводы в граммах;\n'
    '      "reason"    — строка, почему это блюдо подходит '
    "(коротко, на русском).\n\n"
    "Правила:\n"
    "- Подбирай реальные, простые в приготовлении блюда.\n"
    "- Суммарно блюдо должно вписываться в оставшийся лимит калорий "
    "и помогать добрать БЖУ (особенно белок).\n"
    "- Учитывай цель (loss — похудение, maintain — поддержание, "
    "gain — набор массы) и время суток, если они указаны.\n"
    "- Если лимит калорий маленький или отрицательный — предложи лёгкие "
    "низкокалорийные варианты (овощи, нежирный белок).\n"
    "- Числа — реалистичные и положительные."
)

# Системный промпт для подбора спортивных добавок.
SUPPLEMENT_SYSTEM_PROMPT = (
    "Ты — консультант по спортивному питанию. Пользователь просит подсказать "
    "базовые спортивные добавки под его цель.\n\n"
    "Верни СТРОГО валидный JSON-объект (и НИЧЕГО кроме него) с полем:\n"
    '  "suggestions" — массив из 3-5 объектов, каждый с полями:\n'
    '      "name"    — строка, название добавки на русском '
    '(например: "Креатин моногидрат", "Сывороточный протеин", "Омега-3");\n'
    '      "dosage"  — строка, типичная суточная дозировка '
    '(например: "3-5 г в день");\n'
    '      "note"    — строка, кратко зачем нужна и как принимать.\n\n'
    "Правила:\n"
    "- Предлагай только распространённые, безопасные базовые добавки.\n"
    "- Учитывай цель (loss — похудение, maintain — поддержание, "
    "gain — набор массы), если она указана.\n"
    "- НЕ предлагай рецептурные препараты, гормоны и любые запрещённые вещества.\n"
    "- Формулировки — общие и осторожные, без медицинских обещаний."
)

# Системный промпт для ПЕРСОНАЛЬНОГО подбора добавок: учитывает цель улучшения
# (сон/восстановление/сила/энергия/иммунитет или произвольный текст),
# частоту и тип тренировок, а также цель диеты.
SUPPLEMENT_RECOMMEND_SYSTEM_PROMPT = (
    "Ты — опытный эксперт по спортивному питанию. Подбери пользователю "
    "персональные базовые добавки, учитывая его данные.\n\n"
    "Учитывай при подборе:\n"
    "- ЦЕЛЬ УЛУЧШЕНИЯ (improvement_goal): например, сон, восстановление, "
    "сила, энергия, иммунитет — или произвольный текст пользователя;\n"
    "- ЧАСТОТУ и ТИП тренировок (training_count — число тренировок за "
    "последние 2 недели; workout_types — какие именно тренировки);\n"
    "- ЦЕЛЬ ДИЕТЫ (diet_goal: loss — похудение, maintain — поддержание, "
    "gain — набор массы).\n\n"
    "Примеры логики (ориентир, не жёсткое правило):\n"
    "- цель «сон» -> магний, глицин;\n"
    "- цель «восстановление» + частые тренировки -> протеин, омега-3, магний;\n"
    "- цель «сила» + частые силовые тренировки -> креатин моногидрат, протеин;\n"
    "- цель «энергия» -> кофеин/L-карнитин в умеренных дозах, витамины группы B;\n"
    "- цель «иммунитет» -> витамин D, витамин C, цинк.\n\n"
    "Верни СТРОГО валидный JSON-объект (и НИЧЕГО кроме него) с полем:\n"
    '  "suggestions" — массив из 2-4 объектов, каждый с полями:\n'
    '      "name"    — строка, название добавки на русском '
    '(например: "Креатин моногидрат", "Магний", "Омега-3");\n'
    '      "dosage"  — строка, типичная суточная дозировка '
    '(например: "3-5 г в день");\n'
    '      "note"    — строка, кратко зачем нужна именно под цель/тренировки '
    "и как принимать.\n\n"
    "Правила:\n"
    "- Предлагай только распространённые, безопасные базовые добавки "
    "(2-4 штуки, без воды).\n"
    "- Связывай выбор с целью улучшения и тренировками пользователя.\n"
    "- НЕ предлагай рецептурные препараты, гормоны и любые запрещённые вещества.\n"
    "- Формулировки — общие и осторожные, без медицинских обещаний."
)


def _call_text_model(client: "OpenAI", system_prompt: str, user_prompt: str):
    """
    Один текстовый вызов модели (без изображения) с принудительным JSON-ответом.

    Возвращает (content, finish_reason, refusal). Используется и для подбора
    блюд, и для подбора добавок — логика идентична вызову в analyze_food_image.
    """
    response = client.chat.completions.create(
        model=MODEL,
        response_format={"type": "json_object"},
        max_tokens=MAX_TOKENS,
        temperature=0.5,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    choice = response.choices[0]
    content = choice.message.content
    refusal = getattr(choice.message, "refusal", None)
    return content, choice.finish_reason, refusal


def _run_text_completion(system_prompt: str, user_prompt: str, log_tag: str) -> tuple[dict, dict]:
    """
    Общий «движок» текстовых AI-подсказок (подбор блюд/добавок).

    Делает MAX_ATTEMPTS попыток вызвать модель, устойчиво разбирает JSON и
    возвращает кортеж (data, debug), где data — распарсенный объект ответа,
    debug — служебная информация о вызове.

    При неудаче всех попыток выбрасывает AIError (как и analyze_food_image).
    """
    client = OpenAI()

    last_error = "неизвестная ошибка"
    raw = ""
    finish_reason = None
    refusal = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            content, finish_reason, refusal = _call_text_model(
                client, system_prompt, user_prompt
            )
            raw = content or ""
            logger.info(
                "AI[%s] попытка %d/%d: finish=%s refusal=%s raw=%s",
                log_tag, attempt, MAX_ATTEMPTS, finish_reason, refusal, raw[:600],
            )
        except Exception as exc:  # сеть, ключ, лимиты OpenAI и т.п.
            last_error = f"ошибка обращения к OpenAI: {exc}"
            logger.warning(
                "AI[%s] попытка %d/%d не удалась: %s", log_tag, attempt, MAX_ATTEMPTS, exc
            )
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

        debug = {
            "raw": raw,
            "finish_reason": finish_reason,
            "refusal": refusal,
            "model": MODEL,
            "attempts": attempt,
        }
        return data, debug

    # Все попытки исчерпаны — поведение как в analyze_food_image.
    logger.error("AI[%s]: все попытки исчерпаны. Последняя ошибка: %s", log_tag, last_error)
    raise AIError(
        f"AI не ответил ({log_tag}): {last_error}",
        raw=raw,
        finish_reason=finish_reason,
        refusal=refusal,
    )


def recommend_meals(
    remaining_calories: int,
    remaining_proteins: float,
    remaining_fats: float,
    remaining_carbs: float,
    diet_goal: str | None = None,
    time_of_day: str | None = None,
) -> dict:
    """
    Подбирает 2-3 варианта блюд под оставшийся на день лимит КБЖУ.

    Возвращает словарь:
        {
            "suggestions": [
                {"dish_name": str, "calories": int, "proteins": float,
                 "fats": float, "carbs": float, "reason": str},
                ...
            ]
        }

    При неудаче обращения к ИИ выбрасывает AIError (502 на уровне роута).
    """
    # Формируем запрос пользователя с понятными числами остатка.
    parts = [
        "Подбери 2-3 блюда, чтобы добрать оставшуюся за день норму КБЖУ.",
        f"Осталось калорий: {remaining_calories} ккал.",
        f"Осталось белков: {remaining_proteins} г.",
        f"Осталось жиров: {remaining_fats} г.",
        f"Осталось углеводов: {remaining_carbs} г.",
    ]
    if diet_goal:
        parts.append(f"Цель пользователя: {diet_goal}.")
    if time_of_day:
        parts.append(f"Время суток / приём пищи: {time_of_day}.")
    parts.append("Верни результат строго в формате JSON по инструкции.")
    user_prompt = "\n".join(parts)

    data, _debug = _run_text_completion(
        RECOMMEND_SYSTEM_PROMPT, user_prompt, log_tag="recommend"
    )

    # Нормализуем массив предложений: чистим типы и пропускаем мусор.
    raw_items = data.get("suggestions")
    if not isinstance(raw_items, list):
        raw_items = []

    suggestions: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        dish_name = item.get("dish_name")
        if not isinstance(dish_name, str) or not dish_name.strip():
            continue
        reason = item.get("reason")
        if not isinstance(reason, str):
            reason = ""
        suggestions.append(
            {
                "dish_name": dish_name.strip(),
                "calories": _coerce_int(item.get("calories")),
                "proteins": _coerce_float(item.get("proteins")),
                "fats": _coerce_float(item.get("fats")),
                "carbs": _coerce_float(item.get("carbs")),
                "reason": reason.strip(),
            }
        )

    # Если модель вернула валидный JSON, но без пригодных вариантов —
    # считаем это неудачей разбора (роут отдаст 502).
    if not suggestions:
        raise AIError(
            "AI не вернул ни одного корректного варианта блюда",
            raw=_debug.get("raw", ""),
            finish_reason=_debug.get("finish_reason"),
            refusal=_debug.get("refusal"),
        )

    return {"suggestions": suggestions}


def suggest_supplements(diet_goal: str | None = None) -> dict:
    """
    Подбирает базовые спортивные добавки под цель пользователя.

    Возвращает словарь:
        {
            "suggestions": [
                {"name": str, "dosage": str, "note": str},
                ...
            ]
        }

    При неудаче обращения к ИИ выбрасывает AIError (502 на уровне роута).
    Дисклеймер добавляется на уровне роута, чтобы держать его в одном месте.
    """
    # Запрос пользователя; цель добавляем, если она известна.
    parts = ["Подскажи базовые спортивные добавки."]
    if diet_goal:
        parts.append(f"Моя цель: {diet_goal}.")
    parts.append("Верни результат строго в формате JSON по инструкции.")
    user_prompt = "\n".join(parts)

    data, _debug = _run_text_completion(
        SUPPLEMENT_SYSTEM_PROMPT, user_prompt, log_tag="supplements"
    )

    # Нормализуем массив рекомендаций.
    raw_items = data.get("suggestions")
    if not isinstance(raw_items, list):
        raw_items = []

    suggestions: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        dosage = item.get("dosage")
        if not isinstance(dosage, str):
            dosage = ""
        note = item.get("note")
        if not isinstance(note, str):
            note = ""
        suggestions.append(
            {
                "name": name.strip(),
                "dosage": dosage.strip(),
                "note": note.strip(),
            }
        )

    if not suggestions:
        raise AIError(
            "AI не вернул ни одной корректной добавки",
            raw=_debug.get("raw", ""),
            finish_reason=_debug.get("finish_reason"),
            refusal=_debug.get("refusal"),
        )

    return {"suggestions": suggestions}


def recommend_supplements(
    improvement_goal: str | None = None,
    training_count: int = 0,
    workout_types: list[str] | None = None,
    diet_goal: str | None = None,
) -> dict:
    """
    Персональный подбор спортивных добавок (2-4 шт.) с учётом:
      * improvement_goal — цели улучшения (сон/восстановление/сила/энергия/
        иммунитет или произвольный текст пользователя);
      * training_count   — числа тренировок за последние 2 недели;
      * workout_types    — типов этих тренировок;
      * diet_goal        — цели диеты (loss/maintain/gain).

    Возвращает словарь:
        {
            "suggestions": [
                {"name": str, "dosage": str, "note": str},
                ...
            ]
        }

    Использует тот же паттерн, что suggest_supplements (OpenAI json_object,
    ретрай, устойчивый разбор JSON). При неудаче обращения к ИИ выбрасывает
    AIError (502 на уровне роута). Дисклеймер добавляется на уровне роута.
    """
    # Формируем запрос пользователя из тех данных, что известны.
    parts = ["Подбери мне персональные спортивные добавки (2-4 штуки)."]

    if improvement_goal and str(improvement_goal).strip():
        parts.append(f"Цель улучшения: {str(improvement_goal).strip()}.")
    else:
        parts.append("Цель улучшения не указана — подбери базовый набор.")

    # Частота тренировок за последние 2 недели.
    parts.append(f"Тренировок за последние 2 недели: {_coerce_int(training_count)}.")

    # Типы тренировок (если есть) — перечисляем их через запятую.
    if workout_types:
        types_clean = [
            str(t).strip() for t in workout_types if t and str(t).strip()
        ]
        if types_clean:
            parts.append("Типы тренировок: " + ", ".join(types_clean) + ".")

    if diet_goal and str(diet_goal).strip():
        parts.append(f"Цель диеты: {str(diet_goal).strip()}.")

    parts.append("Верни результат строго в формате JSON по инструкции.")
    user_prompt = "\n".join(parts)

    data, _debug = _run_text_completion(
        SUPPLEMENT_RECOMMEND_SYSTEM_PROMPT, user_prompt, log_tag="supplement_recommend"
    )

    # Нормализуем массив рекомендаций (та же чистка типов, что в suggest_supplements).
    raw_items = data.get("suggestions")
    if not isinstance(raw_items, list):
        raw_items = []

    suggestions: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        dosage = item.get("dosage")
        if not isinstance(dosage, str):
            dosage = ""
        note = item.get("note")
        if not isinstance(note, str):
            note = ""
        suggestions.append(
            {
                "name": name.strip(),
                "dosage": dosage.strip(),
                "note": note.strip(),
            }
        )

    if not suggestions:
        raise AIError(
            "AI не вернул ни одной корректной добавки",
            raw=_debug.get("raw", ""),
            finish_reason=_debug.get("finish_reason"),
            refusal=_debug.get("refusal"),
        )

    return {"suggestions": suggestions}
