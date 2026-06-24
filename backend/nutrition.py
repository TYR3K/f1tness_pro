"""
Расчёт суточной нормы калорий и целевых БЖУ.

Чистые функции без побочных эффектов. Используется формула
Миффлина — Сан Жеора для базового обмена (BMR), затем учитывается
коэффициент активности (TDEE) и цель пользователя (похудение / поддержание / набор).
Распределение макронутриентов (белки/жиры/углеводы) зависит от выбранной цели.
"""

from __future__ import annotations

# Поправочные коэффициенты к TDEE в зависимости от цели.
#   loss     — дефицит калорий (похудение);
#   maintain — поддержание текущего веса;
#   gain      — профицит калорий (набор массы).
_GOAL_FACTORS: dict[str, float] = {
    "loss": 0.85,
    "maintain": 1.0,
    "gain": 1.10,
}

# Доли калорийности по макронутриентам (белок / жир / углеводы) для каждой цели.
# Сумма долей в каждой строке равна 1.0.
_MACRO_SPLITS: dict[str, tuple[float, float, float]] = {
    "loss": (0.30, 0.30, 0.40),
    "maintain": (0.25, 0.30, 0.45),
    "gain": (0.25, 0.25, 0.50),
}


def compute_goal(
    weight: float | None,
    height: float | None,
    age: int | None,
    gender: str | None,
    activity_level: float | None,
    diet_goal: str | None,
) -> dict:
    """
    Рассчитать суточную норму калорий и целевые БЖУ.

    Аргументы:
        weight         — вес, кг;
        height         — рост, см;
        age            — возраст, лет;
        gender         — пол: "male" | "female";
        activity_level — коэффициент активности (по умолчанию 1.375);
        diet_goal      — цель: "loss" | "maintain" | "gain".

    Возвращает словарь:
        {
          "daily_goal_kcal": int,   # суточная норма калорий
          "target_proteins": float, # целевые белки, г
          "target_fats": float,     # целевые жиры, г
          "target_carbs": float,    # целевые углеводы, г
          "diet_goal": str,         # нормализованная цель
          "bmr": int,               # базовый обмен веществ, ккал
          "tdee": int,              # суточный расход с учётом активности, ккал
        }

    Бросает:
        ValueError — если не заданы вес, рост или возраст.
    """
    # Без основных параметров расчёт невозможен.
    if weight is None or height is None or age is None:
        raise ValueError("Заполните вес, рост и возраст")

    # --- Базовый обмен веществ (BMR) по формуле Миффлина — Сан Жеора. ---
    # Для мужчин поправка +5, для женщин -161.
    sex_correction = 5 if gender == "male" else -161
    bmr = 10 * weight + 6.25 * height - 5 * age + sex_correction

    # --- Суточный расход (TDEE) с учётом активности. ---
    # Если коэффициент не задан — берём умеренную активность 1.375.
    tdee = bmr * (activity_level or 1.375)

    # --- Корректировка под цель. ---
    # Неизвестная цель -> коэффициент 1.0 (поддержание).
    factor = _GOAL_FACTORS.get(diet_goal, 1.0)
    goal = round(tdee * factor)

    # --- Распределение БЖУ. ---
    # Для неизвестной цели используем сплит "maintain".
    p_share, f_share, c_share = _MACRO_SPLITS.get(diet_goal, _MACRO_SPLITS["maintain"])

    # Переводим калории по каждому макросу в граммы:
    #   белки и углеводы — 4 ккал/г, жиры — 9 ккал/г.
    protein_g = round(goal * p_share / 4)
    fat_g = round(goal * f_share / 9)
    carb_g = round(goal * c_share / 4)

    return {
        "daily_goal_kcal": goal,
        "target_proteins": protein_g,
        "target_fats": fat_g,
        "target_carbs": carb_g,
        "diet_goal": diet_goal or "maintain",
        "bmr": round(bmr),
        "tdee": round(tdee),
    }
