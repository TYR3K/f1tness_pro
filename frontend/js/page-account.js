/*
 * page-account.js — страница «Мой аккаунт».
 *
 * Регистрирует контроллер страницы через App.registerPage("account", {...}).
 * Возможности:
 *   - Шапка с аватаром (App.user.photo_url) и именем пользователя.
 *   - Форма профиля: вес, рост, возраст, пол (Мужской/Женский -> male/female),
 *     уровень активности, цель питания (diet_goal) и цель по калориям (ккал/день).
 *   - Кнопка «Рассчитать автоматически» — вызывает App.api.calculateGoal на
 *     сервере (сервер сам сохраняет результат в профиль), подставляет дневную
 *     норму в поле цели и показывает блок целевых БЖУ.
 *   - Кнопка «Сохранить» — отправляет профиль через App.api.saveProfile
 *     (включая diet_goal).
 *   - Карточка «Язык / Language»: переключатель RU/EN -> App.setLang(...).
 *   - ПРЕМИУМ: карточка «Вес / Weight» — ввод замера + SVG-график динамики
 *     (замеры + линия тренда), текущий вес и изменение за период.
 *   - ПРЕМИУМ: карточка «Адаптивные калории / Adaptive calories» — тумблер
 *     adaptive_enabled + кнопка пересчёта дневной цели по реальной динамике веса.
 *   - Карточка «Вечерняя сводка»: ТОЛЬКО тумблер daily_summary_enabled и время
 *     summary_time (App.api.getNotificationSettings / saveNotificationSettings).
 *     Остальные напоминания вынесены в свои разделы (Тренировки, Добавки, Рацион).
 *   - Ниже — история за последние 30 дней (App.api.getHistory(30))
 *     в виде простого столбчатого графика (дата + ккал).
 *
 * Предзаполнение формы выполняется через App.api.getProfile.
 * Весь видимый пользователю текст локализован через App.pick(ru, en) и
 * вычисляется НА МОМЕНТ РЕНДЕРА, чтобы смена языка давала корректный текст.
 */
(function () {
  "use strict";

  // Локальный хелпер локализации — короткий псевдоним App.pick(ru, en).
  // Все видимые строки этой страницы проходят через L/App.pick на момент рендера.
  function L(ru, en) {
    return App.pick(ru, en);
  }

  // Варианты уровня активности для выпадающего списка.
  // value — коэффициент TDEE, label() — локализованное описание (RU/EN),
  // вычисляется на момент рендера через App.pick.
  var ACTIVITY_OPTIONS = [
    {
      value: 1.2,
      label: function () {
        return L(
          "Минимальная (сидячий образ жизни)",
          "Minimal (sedentary lifestyle)"
        );
      }
    },
    {
      value: 1.375,
      label: function () {
        return L(
          "Лёгкая (1-3 тренировки в неделю)",
          "Light (1-3 workouts per week)"
        );
      }
    },
    {
      value: 1.55,
      label: function () {
        return L(
          "Средняя (3-5 тренировок в неделю)",
          "Moderate (3-5 workouts per week)"
        );
      }
    },
    {
      value: 1.725,
      label: function () {
        return L(
          "Высокая (6-7 тренировок в неделю)",
          "High (6-7 workouts per week)"
        );
      }
    },
    {
      value: 1.9,
      label: function () {
        return L(
          "Очень высокая (тяжёлый физический труд)",
          "Very high (hard physical labor)"
        );
      }
    }
  ];

  // Варианты цели питания (diet_goal). value — то, что уходит на сервер.
  // label() локализуется на момент рендера.
  var DIET_GOAL_OPTIONS = [
    {
      value: "loss",
      label: function () {
        return L("Похудение", "Weight loss");
      }
    },
    {
      value: "maintain",
      label: function () {
        return L("Поддержание", "Maintenance");
      }
    },
    {
      value: "gain",
      label: function () {
        return L("Набор массы", "Muscle gain");
      }
    }
  ];

  // Значение времени по умолчанию для вечерней сводки, если сервер не вернул своё.
  var DEFAULT_SUMMARY_TIME = "21:00";

  /**
   * Преобразует ISO-дату подписки (например, "2026-12-31" или
   * "2026-12-31T10:00:00") в короткий формат "ДД.ММ.ГГГГ".
   * Возвращает пустую строку, если дату распознать не удалось.
   */
  function formatSubDate(value) {
    if (!value) return "";
    var s = String(value).trim();
    // Берём только дату, если пришла дата-время.
    var datePart = s.split("T")[0].split(" ")[0];
    var parts = datePart.split("-");
    if (parts.length === 3) {
      return parts[2] + "." + parts[1] + "." + parts[0];
    }
    return datePart;
  }

  /**
   * Формирует краткий статус подписки из App.subscription.
   * Текст локализуется на момент вызова (RU/EN).
   * @returns {{ text:string, premium:boolean }}
   *   premium=true — активная подписка (для подсветки карточки).
   */
  function subscriptionStatus() {
    var sub = (App && App.subscription) || {};
    var type = sub.subscription_type || "free";
    var premium = !!sub.is_premium;

    // Владелец и вечная подписка — доступ навсегда.
    if (sub.is_owner || type === "lifetime") {
      return {
        text: L("Вечная подписка", "Lifetime subscription"),
        premium: true
      };
    }

    if (premium) {
      var until = formatSubDate(sub.subscription_until);
      if (until) {
        return {
          text: L(
            "Премиум активен до " + until,
            "Premium active until " + until
          ),
          premium: true
        };
      }
      return {
        text: L("Премиум активен", "Premium active"),
        premium: true
      };
    }

    return {
      text: L("Бесплатный доступ", "Free access"),
      premium: false
    };
  }

  // Ссылки на корневой элемент представления и элементы формы.
  // Хранятся в замыкании контроллера, чтобы переиспользовать между методами.
  var els = null;

  /**
   * Возвращает HTML-разметку всей страницы аккаунта.
   * Все видимые строки локализуются здесь через App.pick на момент рендера.
   */
  function template() {
    // Имя пользователя для шапки (берём из Telegram-объекта, если есть).
    var u = App.user || {};
    var displayName =
      (u.first_name ? u.first_name : "") +
      (u.last_name ? " " + u.last_name : "");
    if (!displayName.trim()) {
      displayName = u.username
        ? "@" + u.username
        : L("Пользователь", "User");
    }

    // Опции уровня активности (локализованные подписи).
    var activityOptionsHtml = ACTIVITY_OPTIONS.map(function (o) {
      return (
        '<option value="' +
        o.value +
        '">' +
        App.escapeHtml(o.label()) +
        "</option>"
      );
    }).join("");

    // Опции цели питания (локализованные подписи).
    var dietGoalOptionsHtml = DIET_GOAL_OPTIONS.map(function (o) {
      return (
        '<option value="' +
        App.escapeHtml(o.value) +
        '">' +
        App.escapeHtml(o.label()) +
        "</option>"
      );
    }).join("");

    // Аватар: либо картинка из Telegram, либо заглушка с эмодзи.
    var avatarHtml = u.photo_url
      ? '<img class="acc-avatar" id="accAvatar" alt="' +
        App.escapeHtml(L("Аватар", "Avatar")) +
        '" src="' +
        App.escapeHtml(u.photo_url) +
        '">'
      : '<div class="acc-avatar acc-avatar--empty" id="accAvatar">👤</div>';

    // Краткий статус подписки для карточки в начале страницы.
    var sub = subscriptionStatus();

    // Текущий язык — для подсветки активной кнопки переключателя.
    var curLang = App.lang === "en" ? "en" : "ru";

    return (
      '<section class="page page-account">' +
      // ---- Шапка профиля ----
      '<header class="acc-header card">' +
      avatarHtml +
      '<div class="acc-header__info">' +
      '<div class="acc-name">' +
      App.escapeHtml(displayName) +
      "</div>" +
      (u.username
        ? '<div class="acc-username">@' +
          App.escapeHtml(u.username) +
          "</div>"
        : "") +
      "</div>" +
      "</header>" +

      // ---- Карточка-кнопка «Подписка» ----
      // Ведёт на отдельный экран подписки. Показывает краткий текущий статус.
      '<button type="button" class="acc-sub-card card' +
      (sub.premium ? " acc-sub-card--premium" : "") +
      '" id="accSubCard">' +
      '<span class="acc-sub-card__icon">💎</span>' +
      '<span class="acc-sub-card__body">' +
      '<span class="acc-sub-card__title">' +
      App.escapeHtml(L("Подписка", "Subscription")) +
      "</span>" +
      '<span class="acc-sub-card__status" id="accSubStatus">' +
      App.escapeHtml(sub.text) +
      "</span>" +
      "</span>" +
      '<span class="acc-sub-card__arrow" aria-hidden="true">›</span>' +
      "</button>" +

      // ---- Карточка «Язык / Language» ----
      // Сегментированный переключатель: Русский / English.
      // Активная кнопка соответствует текущему App.lang.
      '<section class="acc-lang card" id="accLang">' +
      '<h2 class="acc-title">' +
      App.escapeHtml(L("Язык", "Language")) +
      "</h2>" +
      '<div class="acc-lang__switch" role="group" aria-label="' +
      App.escapeHtml(L("Выбор языка", "Language selection")) +
      '">' +
      '<button type="button" class="acc-lang__btn' +
      (curLang === "ru" ? " acc-lang__btn--active" : "") +
      '" id="accLangRu" data-lang="ru"' +
      (curLang === "ru" ? ' aria-pressed="true"' : ' aria-pressed="false"') +
      ">Русский</button>" +
      '<button type="button" class="acc-lang__btn' +
      (curLang === "en" ? " acc-lang__btn--active" : "") +
      '" id="accLangEn" data-lang="en"' +
      (curLang === "en" ? ' aria-pressed="true"' : ' aria-pressed="false"') +
      ">English</button>" +
      "</div>" +
      "</section>" +

      // ---- Форма профиля ----
      '<form class="acc-form card" id="accForm" novalidate>' +
      '<h2 class="acc-title">' +
      App.escapeHtml(L("Мои параметры", "My parameters")) +
      "</h2>" +

      '<div class="acc-grid">' +
      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(L("Вес, кг", "Weight, kg")) +
      "</span>" +
      '<input class="field__input" id="accWeight" type="number" inputmode="decimal" min="0" step="0.1" placeholder="70">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(L("Рост, см", "Height, cm")) +
      "</span>" +
      '<input class="field__input" id="accHeight" type="number" inputmode="decimal" min="0" step="0.1" placeholder="175">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(L("Возраст, лет", "Age, years")) +
      "</span>" +
      '<input class="field__input" id="accAge" type="number" inputmode="numeric" min="0" step="1" placeholder="30">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(L("Пол", "Gender")) +
      "</span>" +
      '<select class="field__input" id="accGender">' +
      '<option value="male">' +
      App.escapeHtml(L("Мужской", "Male")) +
      "</option>" +
      '<option value="female">' +
      App.escapeHtml(L("Женский", "Female")) +
      "</option>" +
      "</select>" +
      "</label>" +
      "</div>" +

      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(L("Уровень активности", "Activity level")) +
      "</span>" +
      '<select class="field__input" id="accActivity">' +
      activityOptionsHtml +
      "</select>" +
      "</label>" +

      // ---- Цель питания (diet_goal) ----
      '<label class="field goal-field">' +
      '<span class="field__label">' +
      App.escapeHtml(L("Цель питания", "Nutrition goal")) +
      "</span>" +
      '<select class="field__input" id="accDietGoal">' +
      dietGoalOptionsHtml +
      "</select>" +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(
        L("Цель по калориям, ккал/день", "Calorie goal, kcal/day")
      ) +
      "</span>" +
      '<input class="field__input" id="accGoal" type="number" inputmode="numeric" min="0" step="1" placeholder="2000">' +
      "</label>" +

      // ---- Блок целевых БЖУ (скрыт, пока нет данных) ----
      '<div class="goal-macros" id="accGoalMacros" hidden>' +
      '<div class="goal-macros__title">' +
      App.escapeHtml(L("Целевые БЖУ в день", "Daily target P/F/C")) +
      "</div>" +
      '<div class="goal-macros__grid">' +
      '<div class="goal-macro goal-macro--prot">' +
      '<span class="goal-macro__value" id="accTargetProt">—</span>' +
      '<span class="goal-macro__label">' +
      App.escapeHtml(L("Белки, г", "Protein, g")) +
      "</span>" +
      "</div>" +
      '<div class="goal-macro goal-macro--fat">' +
      '<span class="goal-macro__value" id="accTargetFat">—</span>' +
      '<span class="goal-macro__label">' +
      App.escapeHtml(L("Жиры, г", "Fat, g")) +
      "</span>" +
      "</div>" +
      '<div class="goal-macro goal-macro--carb">' +
      '<span class="goal-macro__value" id="accTargetCarb">—</span>' +
      '<span class="goal-macro__label">' +
      App.escapeHtml(L("Углеводы, г", "Carbs, g")) +
      "</span>" +
      "</div>" +
      "</div>" +
      "</div>" +

      '<button type="button" class="btn btn--ghost" id="accCalcBtn">⚙️ ' +
      App.escapeHtml(
        L("Рассчитать автоматически", "Calculate automatically")
      ) +
      "</button>" +
      '<button type="submit" class="btn btn--cta" id="accSaveBtn">' +
      App.escapeHtml(L("Сохранить", "Save")) +
      "</button>" +

      '<p class="acc-hint">' +
      App.escapeHtml(
        L(
          "Автоматический расчёт учитывает ваши параметры, уровень активности и цель питания.",
          "Automatic calculation takes into account your parameters, activity level and nutrition goal."
        )
      ) +
      "</p>" +
      "</form>" +

      // ---- ПРЕМИУМ: Вес / Weight (контейнер заполняется в renderWeight) ----
      '<section class="wt-card card" id="accWeightCard"></section>' +

      // ---- ПРЕМИУМ: Адаптивные калории (контейнер заполняется в renderAdaptive) ----
      '<section class="adapt-card card" id="accAdaptCard"></section>' +

      // ---- Карточка «Вечерняя сводка» ----
      // Здесь остаётся ТОЛЬКО ежедневная вечерняя сводка. Напоминания о приёмах
      // пищи, тренировках и добавках перенесены в соответствующие разделы.
      '<section class="acc-summary card" id="accSummary">' +
      '<h2 class="acc-title">' +
      App.escapeHtml(L("Вечерняя сводка", "Evening summary")) +
      "</h2>" +
      '<p class="acc-summary-hint">' +
      App.escapeHtml(
        L(
          "Раз в день пришлём короткий итог: сколько калорий и БЖУ набрано за день.",
          "Once a day we'll send a short recap: how many calories and macros you logged."
        )
      ) +
      "</p>" +
      '<div class="acc-summary-body" id="accSummaryBody">' +
      '<div class="skeleton skeleton--block"></div>' +
      "</div>" +
      "</section>" +

      // ---- История за 30 дней ----
      '<section class="acc-history card">' +
      '<h2 class="acc-title">' +
      App.escapeHtml(L("История за 30 дней", "Last 30 days")) +
      "</h2>" +
      '<div id="accHistory" class="acc-history__body">' +
      '<div class="skeleton skeleton--block"></div>' +
      "</div>" +
      "</section>" +
      "</section>"
    );
  }

  /**
   * Заполняет форму данными профиля, полученными с сервера.
   * @param {Object} p — объект ProfileOut.
   */
  function fillForm(p) {
    if (!p) return;
    if (p.weight != null) els.weight.value = p.weight;
    if (p.height != null) els.height.value = p.height;
    if (p.age != null) els.age.value = p.age;
    if (p.gender) els.gender.value = p.gender === "female" ? "female" : "male";

    // Уровень активности: выбираем ближайшее доступное значение из списка.
    if (p.activity_level != null) {
      var target = Number(p.activity_level);
      var best = ACTIVITY_OPTIONS[0].value;
      var bestDiff = Infinity;
      ACTIVITY_OPTIONS.forEach(function (o) {
        var d = Math.abs(o.value - target);
        if (d < bestDiff) {
          bestDiff = d;
          best = o.value;
        }
      });
      els.activity.value = String(best);
    }

    // Цель питания (diet_goal). По умолчанию — «Поддержание».
    if (p.diet_goal && isKnownDietGoal(p.diet_goal)) {
      els.dietGoal.value = p.diet_goal;
    }

    if (p.daily_goal_kcal != null) els.goal.value = p.daily_goal_kcal;

    // Целевые БЖУ — показываем блок, если хотя бы одно значение задано.
    showTargetMacros(p.target_proteins, p.target_fats, p.target_carbs);
  }

  /**
   * Проверяет, что переданная цель питания есть в списке известных вариантов.
   */
  function isKnownDietGoal(v) {
    for (var i = 0; i < DIET_GOAL_OPTIONS.length; i++) {
      if (DIET_GOAL_OPTIONS[i].value === v) return true;
    }
    return false;
  }

  /**
   * Показывает или скрывает блок целевых БЖУ.
   * Если все значения пусты — блок прячется.
   */
  function showTargetMacros(prot, fat, carb) {
    if (!els || !els.goalMacros) return;
    var has =
      prot != null && prot !== "" ||
      fat != null && fat !== "" ||
      carb != null && carb !== "";
    if (!has) {
      els.goalMacros.hidden = true;
      return;
    }
    els.targetProt.textContent = prot != null ? App.fmt(prot) : "—";
    els.targetFat.textContent = fat != null ? App.fmt(fat) : "—";
    els.targetCarb.textContent = carb != null ? App.fmt(carb) : "—";
    els.goalMacros.hidden = false;
  }

  /**
   * Считывает числовое значение из поля ввода.
   * @returns {number|null} число либо null, если поле пустое/некорректное.
   */
  function readNum(input) {
    var raw = (input.value || "").trim().replace(",", ".");
    if (raw === "") return null;
    var n = Number(raw);
    return isFinite(n) ? n : null;
  }

  /**
   * Обработчик кнопки «Рассчитать автоматически».
   * Вызывает серверный расчёт App.api.calculateGoal — сервер сам сохраняет
   * результат в профиль. В ответ приходит дневная норма и целевые БЖУ.
   */
  function onCalc() {
    var weight = readNum(els.weight);
    var height = readNum(els.height);
    var age = readNum(els.age);

    if (weight == null || height == null || age == null) {
      App.toast(
        L(
          "Заполните вес, рост и возраст для расчёта",
          "Fill in weight, height and age to calculate"
        )
      );
      App.haptic("error");
      return;
    }

    var payload = {
      weight: weight,
      height: height,
      age: Math.round(age),
      gender: els.gender.value,
      activity_level: Number(els.activity.value) || 1.375,
      diet_goal: els.dietGoal.value
    };

    els.calcBtn.disabled = true;
    App.showLoading();

    App.api
      .calculateGoal(payload)
      .then(function (res) {
        if (!res) {
          throw new Error(L("Пустой ответ сервера", "Empty server response"));
        }
        // Подставляем дневную норму в поле цели.
        if (res.daily_goal_kcal != null) {
          els.goal.value = Math.round(res.daily_goal_kcal);
        }
        // Показываем целевые БЖУ.
        showTargetMacros(
          res.target_proteins,
          res.target_fats,
          res.target_carbs
        );
        // Если сервер вернул нормализованную цель питания — отражаем её.
        if (res.diet_goal && isKnownDietGoal(res.diet_goal)) {
          els.dietGoal.value = res.diet_goal;
        }
        // Сервер сохранил расчёт в профиль — синхронизируем кэш.
        if (App.state.profile) {
          App.state.profile.daily_goal_kcal = res.daily_goal_kcal;
          App.state.profile.target_proteins = res.target_proteins;
          App.state.profile.target_fats = res.target_fats;
          App.state.profile.target_carbs = res.target_carbs;
          App.state.profile.diet_goal = res.diet_goal || els.dietGoal.value;
        }
        App.haptic("success");
        App.toast(
          L(
            "Норма рассчитана: " + App.fmt(res.daily_goal_kcal) + " ккал",
            "Goal calculated: " + App.fmt(res.daily_goal_kcal) + " kcal"
          )
        );
      })
      .catch(function (err) {
        App.haptic("error");
        var reason = err && err.message ? err.message : L("ошибка", "error");
        App.toast(
          L(
            "Не удалось рассчитать: " + reason,
            "Failed to calculate: " + reason
          )
        );
      })
      .finally(function () {
        els.calcBtn.disabled = false;
        App.hideLoading();
      });
  }

  /**
   * Обработчик отправки формы — сохранение профиля на сервере.
   */
  function onSave(e) {
    if (e) e.preventDefault();

    // Собираем только заполненные поля (ProfileIn — все поля опциональны).
    var data = {};
    var weight = readNum(els.weight);
    var height = readNum(els.height);
    var age = readNum(els.age);
    var goal = readNum(els.goal);

    if (weight != null) data.weight = weight;
    if (height != null) data.height = height;
    if (age != null) data.age = Math.round(age);
    data.gender = els.gender.value;
    data.activity_level = Number(els.activity.value) || 1.375;
    data.diet_goal = els.dietGoal.value;
    if (goal != null) data.daily_goal_kcal = Math.round(goal);

    els.saveBtn.disabled = true;
    App.showLoading();

    App.api
      .saveProfile(data)
      .then(function (profile) {
        // Обновляем кэш профиля и переотрисовываем поля.
        App.state.profile = profile;
        fillForm(profile);
        App.haptic("success");
        App.toast(L("Профиль сохранён", "Profile saved"));
      })
      .catch(function (err) {
        App.haptic("error");
        var reason = err && err.message ? err.message : L("ошибка", "error");
        App.toast(
          L("Не удалось сохранить: " + reason, "Failed to save: " + reason)
        );
      })
      .finally(function () {
        els.saveBtn.disabled = false;
        App.hideLoading();
      });
  }

  /* =====================================================================
   *  ЯЗЫК / LANGUAGE
   *  Переключатель RU/EN. По выбору вызывает App.setLang(...),
   *  который сохраняет язык на сервере и перерисовывает текущую страницу.
   * ===================================================================== */

  /**
   * Обработчик нажатия на кнопку выбора языка.
   * Если выбран тот же язык — ничего не делаем (без лишней перерисовки).
   */
  function onPickLang(lang) {
    var cur = App.lang === "en" ? "en" : "ru";
    if (lang === cur) {
      App.haptic("selection");
      return;
    }
    App.haptic("selection");
    if (App.setLang) {
      // setLang сам перерисует страницу аккаунта — подсветка обновится в template().
      App.setLang(lang);
    }
  }

  /* =====================================================================
   *  ПРЕМИУМ: ВЕС / WEIGHT (Этап 3)
   *  Ввод замера веса + SVG-график динамики (точки замеров и линия тренда),
   *  текущий вес и изменение за период. Платный роут (для free — 402).
   * ===================================================================== */

  /**
   * Округляет число до одного знака после запятой и возвращает строкой.
   * Нечисловые значения превращаются в "—".
   */
  function fmt1(n) {
    var num = Number(n);
    if (!isFinite(num)) return "—";
    return String(Math.round(num * 10) / 10);
  }

  /**
   * Изменение веса со знаком: "+1.2" / "-0.8" / "0".
   */
  function fmtChange(n) {
    var num = Number(n);
    if (!isFinite(num)) return "0";
    var rounded = Math.round(num * 10) / 10;
    return (rounded > 0 ? "+" : "") + rounded;
  }

  /**
   * Строит карточку «Вес». Для free вместо содержимого вставляет paywall
   * (один общий блок для веса и адаптивных калорий). Для премиум — форма
   * ввода замера + контейнер графика, который заполняется loadWeight().
   */
  function renderWeight() {
    var card = els.weightCard;
    if (!card) return;

    if (!App.isPremium()) {
      // Гейтинг: показываем paywall в саму карточку (суб-контейнер, не весь #view).
      renderPremiumGate(card);
      return;
    }

    // Снимаем класс-гейт (мог остаться от прошлого рендера, когда статус
    // подписки ещё не подтянулся): иначе карточка теряет фон/паддинг.
    card.classList.remove("wt-gate");

    card.innerHTML =
      '<h2 class="acc-title">' +
      App.escapeHtml(L("Вес", "Weight")) +
      "</h2>" +
      '<p class="wt-hint">' +
      App.escapeHtml(
        L(
          "Записывайте вес регулярно — по динамике строится тренд и адаптивная норма.",
          "Log your weight regularly — the trend and adaptive goal are built from it."
        )
      ) +
      "</p>" +
      '<div class="wt-input-row">' +
      '<label class="field wt-input-field">' +
      '<span class="field__label">' +
      App.escapeHtml(L("Вес сегодня, кг", "Weight today, kg")) +
      "</span>" +
      '<input class="field__input wt-input" id="accWeightInput" type="number" inputmode="decimal" min="0" step="0.1" placeholder="70.0">' +
      "</label>" +
      "</div>" +
      '<button type="button" class="btn btn--cta wt-save-btn" id="accWeightSave">' +
      App.escapeHtml(L("Сохранить вес", "Save weight")) +
      "</button>" +
      '<div class="wt-chart-wrap" id="accWeightChart">' +
      '<div class="skeleton skeleton--block"></div>' +
      "</div>";

    var input = card.querySelector("#accWeightInput");
    var saveBtn = card.querySelector("#accWeightSave");
    var chart = card.querySelector("#accWeightChart");

    // Предзаполняем поле последним известным весом из профиля (удобно).
    if (App.state.profile && App.state.profile.weight != null) {
      input.value = App.state.profile.weight;
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        onSaveWeight(input, saveBtn, chart);
      });
    }

    // Загружаем историю и рисуем график.
    loadWeight(chart);
  }

  /**
   * Сохраняет замер веса (upsert по сегодняшней дате) и перезагружает график.
   */
  function onSaveWeight(input, saveBtn, chart) {
    var weight = readNum(input);
    if (weight == null || weight <= 0) {
      App.toast(L("Введите корректный вес", "Enter a valid weight"));
      App.haptic("error");
      return;
    }

    if (saveBtn) saveBtn.disabled = true;
    App.showLoading();

    App.api
      .addWeight({ date: App.todayStr(), weight: weight })
      .then(function () {
        App.haptic("success");
        App.toast(L("Вес сохранён", "Weight saved"));
        // Перезагружаем график динамики после нового замера.
        loadWeight(chart);
      })
      .catch(function (err) {
        App.haptic("error");
        var reason = err && err.message ? err.message : L("ошибка", "error");
        App.toast(
          L("Не удалось сохранить: " + reason, "Failed to save: " + reason)
        );
      })
      .finally(function () {
        if (saveBtn) saveBtn.disabled = false;
        App.hideLoading();
      });
  }

  /**
   * Загружает историю веса за 90 дней и отрисовывает SVG-график.
   */
  function loadWeight(chart) {
    if (!chart) return;
    chart.innerHTML = '<div class="skeleton skeleton--block"></div>';

    App.api
      .getWeightHistory(90)
      .then(function (res) {
        renderWeightChart(chart, res || {});
      })
      .catch(function (err) {
        chart.innerHTML =
          '<div class="acc-error">' +
          "<p>" +
          App.escapeHtml(
            L("Не удалось загрузить график веса.", "Failed to load weight chart.")
          ) +
          "</p>" +
          '<p class="acc-error__msg">' +
          App.escapeHtml(
            err && err.message ? err.message : L("Ошибка сети", "Network error")
          ) +
          "</p>" +
          '<button type="button" class="btn btn--ghost" id="accWeightRetry">' +
          App.escapeHtml(L("Повторить", "Retry")) +
          "</button>" +
          "</div>";
        var retry = chart.querySelector("#accWeightRetry");
        if (retry) {
          retry.addEventListener("click", function () {
            loadWeight(chart);
          });
        }
      });
  }

  /**
   * Отрисовывает SVG-график динамики веса.
   * @param {HTMLElement} chart — контейнер графика.
   * @param {Object} res — {logs:[{date,weight}], trend:[{date,weight}],
   *   latest:float|null, change_kg:float|null}.
   */
  function renderWeightChart(chart, res) {
    var logs = Array.isArray(res.logs) ? res.logs : [];
    var trend = Array.isArray(res.trend) ? res.trend : [];

    // Пустое состояние — мягкое приглашение добавить первый замер.
    if (!logs.length) {
      chart.innerHTML =
        '<div class="wt-empty">' +
        '<div class="wt-empty__icon" aria-hidden="true">⚖️</div>' +
        '<div class="wt-empty__text">' +
        App.escapeHtml(
          L(
            "Пока нет замеров. Добавьте первый замер веса выше.",
            "No measurements yet. Add your first weight above."
          )
        ) +
        "</div>" +
        "</div>";
      return;
    }

    // ---- Геометрия SVG (адаптивная через viewBox + width:100%) ----
    var W = 320;
    var H = 180;
    var padL = 34; // место под подписи веса слева
    var padR = 12;
    var padT = 12;
    var padB = 22; // место под подписи дат снизу
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    // Собираем все точки (даты по порядку) — за основу берём logs.
    // Ось X — индекс по отсортированным датам логов (равномерно).
    var dates = logs.map(function (p) {
      return p.date;
    });
    var indexByDate = {};
    dates.forEach(function (d, i) {
      indexByDate[d] = i;
    });
    var n = dates.length;

    // Диапазон значений Y: учитываем и замеры, и тренд, с небольшим запасом.
    var allVals = [];
    logs.forEach(function (p) {
      if (p.weight != null && isFinite(Number(p.weight))) {
        allVals.push(Number(p.weight));
      }
    });
    trend.forEach(function (p) {
      if (p.weight != null && isFinite(Number(p.weight))) {
        allVals.push(Number(p.weight));
      }
    });
    var minV = Math.min.apply(null, allVals);
    var maxV = Math.max.apply(null, allVals);
    if (!isFinite(minV) || !isFinite(maxV)) {
      minV = 0;
      maxV = 1;
    }
    if (minV === maxV) {
      // Единственное значение — даём симметричный запас в 1 кг.
      minV -= 1;
      maxV += 1;
    } else {
      var pad = (maxV - minV) * 0.12;
      minV -= pad;
      maxV += pad;
    }
    var spanV = maxV - minV || 1;

    // Хелперы перевода данных в координаты SVG.
    function xAt(i) {
      if (n <= 1) return padL + plotW / 2;
      return padL + (plotW * i) / (n - 1);
    }
    function yAt(v) {
      return padT + plotH - ((Number(v) - minV) / spanV) * plotH;
    }

    // ---- Сетка: горизонтальные линии min / середина / max ----
    var gridLines = "";
    var gridVals = [maxV, (maxV + minV) / 2, minV];
    gridVals.forEach(function (gv) {
      var y = yAt(gv);
      gridLines +=
        '<line class="wt-grid-line" x1="' +
        padL +
        '" y1="' +
        y.toFixed(1) +
        '" x2="' +
        (W - padR) +
        '" y2="' +
        y.toFixed(1) +
        '"></line>';
    });

    // Подписи по оси Y (округлённый вес).
    var yLabels = "";
    [maxV, minV].forEach(function (gv) {
      var y = yAt(gv);
      yLabels +=
        '<text class="wt-axis-label" x="' +
        (padL - 4) +
        '" y="' +
        (y + 3).toFixed(1) +
        '" text-anchor="end">' +
        App.escapeHtml(fmt1(gv)) +
        "</text>";
    });

    // ---- Линия замеров (приглушённая) + точки ----
    var logPointsStr = logs
      .map(function (p) {
        return xAt(indexByDate[p.date]).toFixed(1) + "," + yAt(p.weight).toFixed(1);
      })
      .join(" ");
    var logLine =
      n > 1
        ? '<polyline class="wt-line-logs" points="' + logPointsStr + '"></polyline>'
        : "";
    var logDots = logs
      .map(function (p) {
        return (
          '<circle class="wt-dot" cx="' +
          xAt(indexByDate[p.date]).toFixed(1) +
          '" cy="' +
          yAt(p.weight).toFixed(1) +
          '" r="2.6"></circle>'
        );
      })
      .join("");

    // ---- Линия тренда (выделенная, цвет CTA/зелёный) ----
    var trendLine = "";
    if (trend.length > 1) {
      // Тренд может приходить по своим датам — мапим на ось X логов, где
      // возможно, иначе равномерно распределяем по индексу самого тренда.
      var trendPts = trend
        .map(function (p, i) {
          var xi;
          if (indexByDate.hasOwnProperty(p.date)) {
            xi = xAt(indexByDate[p.date]);
          } else if (trend.length > 1) {
            xi = padL + (plotW * i) / (trend.length - 1);
          } else {
            xi = padL + plotW / 2;
          }
          return xi.toFixed(1) + "," + yAt(p.weight).toFixed(1);
        })
        .join(" ");
      trendLine =
        '<polyline class="wt-line-trend" points="' + trendPts + '"></polyline>';
    }

    // ---- Подписи дат по оси X (первая и последняя) ----
    var xLabels = "";
    if (n >= 1) {
      xLabels +=
        '<text class="wt-axis-label" x="' +
        xAt(0).toFixed(1) +
        '" y="' +
        (H - 6) +
        '" text-anchor="start">' +
        App.escapeHtml(formatDate(dates[0])) +
        "</text>";
    }
    if (n >= 2) {
      xLabels +=
        '<text class="wt-axis-label" x="' +
        xAt(n - 1).toFixed(1) +
        '" y="' +
        (H - 6) +
        '" text-anchor="end">' +
        App.escapeHtml(formatDate(dates[n - 1])) +
        "</text>";
    }

    var svg =
      '<svg class="wt-svg" viewBox="0 0 ' +
      W +
      " " +
      H +
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' +
      App.escapeHtml(L("График динамики веса", "Weight dynamics chart")) +
      '">' +
      gridLines +
      yLabels +
      logLine +
      trendLine +
      logDots +
      xLabels +
      "</svg>";

    // ---- Сводка: текущий вес и изменение за период ----
    var kg = L("кг", "kg");
    var latest = res.latest != null ? res.latest : (logs[n - 1] && logs[n - 1].weight);
    var change = res.change_kg;

    var changeHtml = "";
    if (change != null && isFinite(Number(change))) {
      var num = Number(change);
      var cls =
        num > 0 ? " wt-change--up" : num < 0 ? " wt-change--down" : "";
      changeHtml =
        '<div class="wt-stat">' +
        '<span class="wt-stat__value' +
        cls +
        '">' +
        App.escapeHtml(fmtChange(change) + " " + kg) +
        "</span>" +
        '<span class="wt-stat__label">' +
        App.escapeHtml(L("за период", "over the period")) +
        "</span>" +
        "</div>";
    }

    var latestHtml =
      '<div class="wt-stat">' +
      '<span class="wt-stat__value">' +
      App.escapeHtml(fmt1(latest) + " " + kg) +
      "</span>" +
      '<span class="wt-stat__label">' +
      App.escapeHtml(L("текущий вес", "current weight")) +
      "</span>" +
      "</div>";

    // ---- Легенда (замеры / тренд) ----
    var legend =
      '<div class="wt-legend">' +
      '<span class="wt-legend__item">' +
      '<span class="wt-legend__swatch wt-legend__swatch--logs" aria-hidden="true"></span>' +
      App.escapeHtml(L("Замеры", "Measurements")) +
      "</span>" +
      '<span class="wt-legend__item">' +
      '<span class="wt-legend__swatch wt-legend__swatch--trend" aria-hidden="true"></span>' +
      App.escapeHtml(L("Тренд", "Trend")) +
      "</span>" +
      "</div>";

    chart.innerHTML =
      '<div class="wt-stats">' +
      latestHtml +
      changeHtml +
      "</div>" +
      svg +
      legend;
  }

  /* =====================================================================
   *  ПРЕМИУМ: АДАПТИВНЫЕ КАЛОРИИ / ADAPTIVE CALORIES (Этап 3)
   *  Тумблер adaptive_enabled + кнопка пересчёта дневной цели по реальной
   *  динамике веса. Платный роут (для free — 402).
   * ===================================================================== */

  /**
   * Строит карточку «Адаптивные калории». Для free карточка остаётся пустой —
   * единый paywall показан в карточке веса (renderWeight). Для премиум —
   * тумблер + кнопка пересчёта + блок результата.
   */
  function renderAdaptive() {
    var card = els.adaptCard;
    if (!card) return;

    if (!App.isPremium()) {
      // Гейтинг общий: paywall показывается в карточке веса. Эту карточку прячем.
      card.innerHTML = "";
      card.hidden = true;
      return;
    }
    card.hidden = false;

    var p = App.state.profile || {};
    var enabled = !!p.adaptive_enabled;
    var maintenance = p.calculated_maintenance;

    var maintHtml = "";
    if (maintenance != null && isFinite(Number(maintenance))) {
      maintHtml =
        '<div class="adapt-maint" id="accAdaptMaint">' +
        App.escapeHtml(
          L("Фактическое поддержание ≈ ", "Real maintenance ≈ ") +
            App.fmt(maintenance) +
            L(" ккал", " kcal")
        ) +
        "</div>";
    }

    card.innerHTML =
      '<h2 class="acc-title">' +
      App.escapeHtml(L("Адаптивные калории", "Adaptive calories")) +
      "</h2>" +
      '<div class="adapt-row">' +
      '<label class="adapt-toggle">' +
      '<input class="adapt-toggle__input" type="checkbox" id="accAdaptEnabled"' +
      (enabled ? " checked" : "") +
      ">" +
      '<span class="adapt-toggle__label">' +
      App.escapeHtml(L("Адаптивные калории", "Adaptive calories")) +
      "</span>" +
      "</label>" +
      "</div>" +
      '<p class="adapt-hint">' +
      App.escapeHtml(
        L(
          "Корректирует дневную цель по реальной динамике веса.",
          "Adjusts your daily goal from real weight dynamics."
        )
      ) +
      "</p>" +
      maintHtml +
      '<button type="button" class="btn btn--cta adapt-recalc-btn" id="accAdaptRecalc">' +
      App.escapeHtml(L("Пересчитать по динамике", "Recalculate now")) +
      "</button>" +
      '<div class="adapt-result" id="accAdaptResult" hidden></div>';

    var toggle = card.querySelector("#accAdaptEnabled");
    if (toggle) {
      toggle.addEventListener("change", function () {
        onToggleAdaptive(toggle);
      });
    }

    var recalcBtn = card.querySelector("#accAdaptRecalc");
    if (recalcBtn) {
      recalcBtn.addEventListener("click", function () {
        onRecalcAdaptive(recalcBtn, card.querySelector("#accAdaptResult"));
      });
    }
  }

  /**
   * Переключение тумблера adaptive_enabled — сохраняем в профиль на сервере.
   */
  function onToggleAdaptive(toggle) {
    var enabled = !!toggle.checked;
    App.haptic("selection");
    toggle.disabled = true;

    App.api
      .saveProfile({ adaptive_enabled: enabled })
      .then(function (profile) {
        // Обновляем кэш профиля актуальными данными от сервера.
        if (profile && typeof profile === "object") {
          App.state.profile = profile;
        } else if (App.state.profile) {
          App.state.profile.adaptive_enabled = enabled;
        }
        App.toast(
          enabled
            ? L("Адаптивные калории включены", "Adaptive calories enabled")
            : L("Адаптивные калории выключены", "Adaptive calories disabled")
        );
      })
      .catch(function (err) {
        // При ошибке возвращаем тумблер в прежнее положение.
        toggle.checked = !enabled;
        App.haptic("error");
        var reason = err && err.message ? err.message : L("ошибка", "error");
        App.toast(
          L("Не удалось сохранить: " + reason, "Failed to save: " + reason)
        );
      })
      .finally(function () {
        toggle.disabled = false;
      });
  }

  /**
   * Пересчёт адаптивной цели по реальной динамике веса.
   * При enough_data — показываем поддержание, новую цель и недельное изменение,
   * обновляем поле цели в форме и кэш профиля. Иначе — показываем пояснение.
   */
  function onRecalcAdaptive(btn, resultBox) {
    if (btn) btn.disabled = true;
    App.showLoading();

    App.api
      .recalcAdaptive()
      .then(function (res) {
        res = res || {};
        renderAdaptiveResult(resultBox, res);

        if (res.enough_data && res.new_goal != null) {
          // Обновляем поле цели в форме профиля и кэш.
          if (els && els.goal) {
            els.goal.value = Math.round(res.new_goal);
          }
          if (App.state.profile) {
            App.state.profile.daily_goal_kcal = res.new_goal;
            if (res.maintenance != null) {
              App.state.profile.calculated_maintenance = res.maintenance;
            }
          }
          // Обновляем подпись поддержания в карточке, если она есть.
          updateMaintenanceLabel(res.maintenance);
          App.haptic("success");
          App.toast(
            L(
              "Новая цель: " + App.fmt(res.new_goal) + " ккал",
              "New goal: " + App.fmt(res.new_goal) + " kcal"
            )
          );
        } else {
          App.haptic("warning");
          App.toast(
            L(
              "Недостаточно данных для пересчёта",
              "Not enough data to recalculate"
            )
          );
        }
      })
      .catch(function (err) {
        App.haptic("error");
        var reason = err && err.message ? err.message : L("ошибка", "error");
        App.toast(
          L(
            "Не удалось пересчитать: " + reason,
            "Failed to recalculate: " + reason
          )
        );
      })
      .finally(function () {
        if (btn) btn.disabled = false;
        App.hideLoading();
      });
  }

  /**
   * Обновляет (или создаёт) строку «Фактическое поддержание ≈ N ккал».
   */
  function updateMaintenanceLabel(maintenance) {
    if (!els || !els.adaptCard) return;
    if (maintenance == null || !isFinite(Number(maintenance))) return;
    var line = els.adaptCard.querySelector("#accAdaptMaint");
    var text =
      L("Фактическое поддержание ≈ ", "Real maintenance ≈ ") +
      App.fmt(maintenance) +
      L(" ккал", " kcal");
    if (line) {
      line.textContent = text;
    }
  }

  /**
   * Отрисовывает результат пересчёта адаптивной цели.
   * @param {HTMLElement} box — контейнер результата.
   * @param {Object} res — ответ /calories/recalculate-adaptive.
   */
  function renderAdaptiveResult(box, res) {
    if (!box) return;

    var explanation = res.explanation || "";

    if (!res.enough_data) {
      // Мало данных — показываем только пояснение.
      box.innerHTML =
        '<div class="adapt-note adapt-note--warn">' +
        App.escapeHtml(
          explanation ||
            L(
              "Недостаточно данных. Добавляйте вес и приёмы пищи регулярно.",
              "Not enough data. Log your weight and meals regularly."
            )
        ) +
        "</div>";
      box.hidden = false;
      return;
    }

    var rows = "";
    if (res.maintenance != null) {
      rows +=
        '<div class="adapt-stat">' +
        '<span class="adapt-stat__label">' +
        App.escapeHtml(L("Поддержание", "Maintenance")) +
        "</span>" +
        '<span class="adapt-stat__value">≈ ' +
        App.escapeHtml(App.fmt(res.maintenance)) +
        " " +
        App.escapeHtml(L("ккал", "kcal")) +
        "</span>" +
        "</div>";
    }
    if (res.new_goal != null) {
      rows +=
        '<div class="adapt-stat adapt-stat--accent">' +
        '<span class="adapt-stat__label">' +
        App.escapeHtml(L("Новая цель", "New goal")) +
        "</span>" +
        '<span class="adapt-stat__value">' +
        App.escapeHtml(App.fmt(res.new_goal)) +
        " " +
        App.escapeHtml(L("ккал", "kcal")) +
        "</span>" +
        "</div>";
    }
    if (res.weekly_change_kg != null && isFinite(Number(res.weekly_change_kg))) {
      rows +=
        '<div class="adapt-stat">' +
        '<span class="adapt-stat__label">' +
        App.escapeHtml(L("Изменение веса", "Weight change")) +
        "</span>" +
        '<span class="adapt-stat__value">' +
        App.escapeHtml(
          fmtChange(res.weekly_change_kg) + " " + L("кг/нед", "kg/week")
        ) +
        "</span>" +
        "</div>";
    }

    var explHtml = explanation
      ? '<p class="adapt-expl">' + App.escapeHtml(explanation) + "</p>"
      : "";

    box.innerHTML =
      explHtml + '<div class="adapt-stats">' + rows + "</div>";
    box.hidden = false;
  }

  /**
   * Вставляет ЕДИНЫЙ paywall (вес + адаптивные калории) в переданный контейнер.
   * Использует App.paywall в суб-контейнере (не весь #view).
   */
  function renderPremiumGate(container) {
    if (!container) return;
    // Сбрасываем класс card-обёртки, чтобы paywall не дублировал фон карточки.
    container.innerHTML = "";
    container.classList.add("wt-gate");
    App.paywall(container, {
      icon: "⚖️",
      title: L("Вес и адаптивные калории", "Weight & adaptive calories"),
      desc: L(
        "Следите за трендом веса и подстраивайте норму калорий",
        "Track your weight trend and auto-tune your calories"
      ),
      bullets: [
        L("График тренда веса", "Weight trend chart"),
        L("Фактическое поддержание", "Real maintenance estimate"),
        L("Авто-коррекция цели", "Auto goal adjustment")
      ]
    });
  }

  /* =====================================================================
   *  ВЕЧЕРНЯЯ СВОДКА
   *  Только ежедневная сводка: тумблер daily_summary_enabled + время summary_time.
   *  Остальные напоминания вынесены в разделы Тренировки / Добавки / Рацион.
   * ===================================================================== */

  /**
   * Безопасно приводит значение времени к строке "HH:MM" для поля ввода.
   */
  function timeValue(v) {
    if (v == null) return "";
    var s = String(v).trim();
    // Сервер может вернуть "HH:MM:SS" — оставляем первые 5 символов.
    if (s.length >= 5) return s.slice(0, 5);
    return s;
  }

  /**
   * Загружает настройки уведомлений и отрисовывает карточку вечерней сводки.
   */
  function loadSummary() {
    var box = els.summaryBody;
    if (!box) return;
    box.innerHTML = '<div class="skeleton skeleton--block"></div>';

    App.api
      .getNotificationSettings()
      .then(function (settings) {
        renderSummary(settings || {});
      })
      .catch(function (err) {
        box.innerHTML =
          '<div class="acc-summary-error">' +
          "<p>" +
          App.escapeHtml(
            L(
              "Не удалось загрузить настройки сводки.",
              "Failed to load summary settings."
            )
          ) +
          "</p>" +
          '<p class="acc-summary-error__msg">' +
          App.escapeHtml(
            err && err.message
              ? err.message
              : L("Ошибка сети", "Network error")
          ) +
          "</p>" +
          '<button type="button" class="btn btn--ghost" id="accSummaryRetry">' +
          App.escapeHtml(L("Повторить", "Retry")) +
          "</button>" +
          "</div>";
        var retry = box.querySelector("#accSummaryRetry");
        if (retry) retry.addEventListener("click", loadSummary);
      });
  }

  /**
   * Отрисовывает карточку вечерней сводки по полученным настройкам.
   * @param {Object} s — объект NotificationSettingsOut.
   */
  function renderSummary(s) {
    var box = els.summaryBody;
    if (!box) return;

    var enabled = !!s.daily_summary_enabled;
    var time = timeValue(s.summary_time) || DEFAULT_SUMMARY_TIME;

    box.innerHTML =
      '<div class="acc-summary-row">' +
      '<label class="acc-summary-toggle">' +
      '<input class="acc-summary-toggle__input" type="checkbox" id="accSummaryEnabled"' +
      (enabled ? " checked" : "") +
      ">" +
      '<span class="acc-summary-toggle__label">' +
      App.escapeHtml(
        L("Присылать вечернюю сводку", "Send evening summary")
      ) +
      "</span>" +
      "</label>" +
      "</div>" +
      '<label class="field acc-summary-time" id="accSummaryTimeField"' +
      (enabled ? "" : " hidden") +
      ">" +
      '<span class="field__label">' +
      App.escapeHtml(L("Время сводки", "Summary time")) +
      "</span>" +
      '<input class="field__input acc-summary-time__input" type="time" id="accSummaryTime" value="' +
      App.escapeHtml(time) +
      '" placeholder="21:00">' +
      "</label>" +
      '<button type="button" class="btn btn--cta acc-summary-save" id="accSummarySave">' +
      App.escapeHtml(L("Сохранить", "Save")) +
      "</button>";

    var toggle = box.querySelector("#accSummaryEnabled");
    var timeField = box.querySelector("#accSummaryTimeField");
    if (toggle && timeField) {
      toggle.addEventListener("change", function () {
        timeField.hidden = !toggle.checked;
        App.haptic("selection");
      });
    }

    var saveBtn = box.querySelector("#accSummarySave");
    if (saveBtn) {
      saveBtn.addEventListener("click", onSaveSummary);
    }
  }

  /**
   * Собирает настройки вечерней сводки из карточки и сохраняет на сервере.
   * Отправляем ТОЛЬКО поля сводки, чтобы не затронуть остальные напоминания.
   */
  function onSaveSummary() {
    var box = els.summaryBody;
    if (!box) return;

    var toggle = box.querySelector("#accSummaryEnabled");
    var timeInput = box.querySelector("#accSummaryTime");

    var enabled = !!(toggle && toggle.checked);
    var payload = { daily_summary_enabled: enabled };

    // Время отправляем только когда сводка включена и поле заполнено.
    if (enabled && timeInput) {
      var tVal = (timeInput.value || "").trim();
      if (tVal) {
        payload.summary_time = tVal;
      }
    }

    var saveBtn = box.querySelector("#accSummarySave");
    if (saveBtn) saveBtn.disabled = true;
    App.showLoading();

    App.api
      .saveNotificationSettings(payload)
      .then(function (settings) {
        // Перерисовываем карточку актуальными данными от сервера.
        renderSummary(settings || payload);
        App.haptic("success");
        App.toast(
          L("Настройки сводки сохранены", "Summary settings saved")
        );
      })
      .catch(function (err) {
        App.haptic("error");
        var reason = err && err.message ? err.message : L("ошибка", "error");
        App.toast(
          L("Не удалось сохранить: " + reason, "Failed to save: " + reason)
        );
        if (saveBtn) saveBtn.disabled = false;
      })
      .finally(function () {
        App.hideLoading();
      });
  }

  /* =====================================================================
   *  ИСТОРИЯ ЗА 30 ДНЕЙ
   * ===================================================================== */

  /**
   * Загружает и отрисовывает историю за 30 дней.
   */
  function loadHistory() {
    var box = els.history;
    box.innerHTML = '<div class="skeleton skeleton--block"></div>';

    App.api
      .getHistory(30)
      .then(function (res) {
        renderHistory(res);
      })
      .catch(function (err) {
        box.innerHTML =
          '<div class="acc-error">' +
          "<p>" +
          App.escapeHtml(
            L("Не удалось загрузить историю.", "Failed to load history.")
          ) +
          "</p>" +
          '<p class="acc-error__msg">' +
          App.escapeHtml(
            err && err.message
              ? err.message
              : L("Ошибка сети", "Network error")
          ) +
          "</p>" +
          '<button type="button" class="btn btn--ghost" id="accHistRetry">' +
          App.escapeHtml(L("Повторить", "Retry")) +
          "</button>" +
          "</div>";
        var retry = box.querySelector("#accHistRetry");
        if (retry) retry.addEventListener("click", loadHistory);
      });
  }

  /**
   * Отрисовывает столбчатый график истории.
   * @param {Object} res — объект HistoryOut { goal, days:[{date,total_calories}] }.
   */
  function renderHistory(res) {
    var box = els.history;
    var days = (res && res.days) || [];
    var goal = res && res.goal != null ? res.goal : null;

    if (!days.length) {
      box.innerHTML =
        '<div class="acc-empty">' +
        App.escapeHtml(
          L(
            "Пока нет данных. Добавьте приёмы пищи в раздел «Мой рацион».",
            "No data yet. Add meals in the «Diary» section."
          )
        ) +
        "</div>";
      return;
    }

    // Максимум для масштабирования столбцов: учитываем цель и фактические значения.
    var maxVal = 0;
    days.forEach(function (d) {
      if (d.total_calories > maxVal) maxVal = d.total_calories;
    });
    if (goal != null && goal > maxVal) maxVal = goal;
    if (maxVal <= 0) maxVal = 1; // защита от деления на ноль

    var kcalUnit = L("ккал", "kcal");

    var rows = days
      .map(function (d) {
        var pct = Math.max(2, Math.round((d.total_calories / maxVal) * 100));
        // Превышение цели подсвечиваем другим цветом.
        var over = goal != null && d.total_calories > goal;
        return (
          '<div class="hist-row">' +
          '<span class="hist-row__date">' +
          App.escapeHtml(formatDate(d.date)) +
          "</span>" +
          '<span class="hist-row__bar-wrap">' +
          '<span class="hist-row__bar' +
          (over ? " hist-row__bar--over" : "") +
          '" style="width:' +
          pct +
          '%"></span>' +
          "</span>" +
          '<span class="hist-row__val">' +
          App.fmt(d.total_calories) +
          " " +
          App.escapeHtml(kcalUnit) +
          "</span>" +
          "</div>"
        );
      })
      .join("");

    var goalLine =
      goal != null
        ? '<div class="hist-goal">' +
          App.escapeHtml(L("Цель: ", "Goal: ")) +
          App.fmt(goal) +
          " " +
          App.escapeHtml(L("ккал/день", "kcal/day")) +
          "</div>"
        : '<div class="hist-goal hist-goal--muted">' +
          App.escapeHtml(L("Цель не задана", "Goal not set")) +
          "</div>";

    box.innerHTML = goalLine + '<div class="hist-list">' + rows + "</div>";
  }

  /**
   * Преобразует ISO-дату "YYYY-MM-DD" в короткий формат "ДД.ММ".
   */
  function formatDate(iso) {
    if (!iso || typeof iso !== "string") return String(iso || "");
    var parts = iso.split("-");
    if (parts.length === 3) {
      return parts[2] + "." + parts[1];
    }
    return iso;
  }

  /**
   * Обновляет текст и подсветку карточки подписки по текущему App.subscription.
   * Безопасно к отсутствию элементов (если страница уже скрыта).
   */
  function refreshSubCard() {
    if (!els) return;
    var sub = subscriptionStatus();
    if (els.subStatus) {
      els.subStatus.textContent = sub.text;
    }
    if (els.subCard) {
      if (sub.premium) {
        els.subCard.classList.add("acc-sub-card--premium");
      } else {
        els.subCard.classList.remove("acc-sub-card--premium");
      }
    }
  }

  /**
   * Находит и кэширует ссылки на элементы формы внутри представления.
   */
  function bindElements(viewEl) {
    els = {
      subCard: viewEl.querySelector("#accSubCard"),
      subStatus: viewEl.querySelector("#accSubStatus"),
      langRu: viewEl.querySelector("#accLangRu"),
      langEn: viewEl.querySelector("#accLangEn"),
      form: viewEl.querySelector("#accForm"),
      weight: viewEl.querySelector("#accWeight"),
      height: viewEl.querySelector("#accHeight"),
      age: viewEl.querySelector("#accAge"),
      gender: viewEl.querySelector("#accGender"),
      activity: viewEl.querySelector("#accActivity"),
      dietGoal: viewEl.querySelector("#accDietGoal"),
      goal: viewEl.querySelector("#accGoal"),
      goalMacros: viewEl.querySelector("#accGoalMacros"),
      targetProt: viewEl.querySelector("#accTargetProt"),
      targetFat: viewEl.querySelector("#accTargetFat"),
      targetCarb: viewEl.querySelector("#accTargetCarb"),
      calcBtn: viewEl.querySelector("#accCalcBtn"),
      saveBtn: viewEl.querySelector("#accSaveBtn"),
      weightCard: viewEl.querySelector("#accWeightCard"),
      adaptCard: viewEl.querySelector("#accAdaptCard"),
      summaryBody: viewEl.querySelector("#accSummaryBody"),
      history: viewEl.querySelector("#accHistory")
    };
  }

  /**
   * Перерисовывает премиум-секции (вес + адаптивные калории) по текущему
   * статусу подписки и кэшу профиля. Безопасно к отсутствию элементов.
   */
  function renderPremiumSections() {
    if (!els) return;
    renderWeight();
    renderAdaptive();
  }

  // ---- Контроллер страницы ----
  var controller = {
    /**
     * Вызывается при показе страницы: строит разметку, вешает обработчики,
     * подгружает профиль, настройки вечерней сводки и историю.
     */
    onShow: function (viewEl) {
      viewEl.innerHTML = template();
      bindElements(viewEl);

      // Прокручиваем к началу при входе в раздел.
      App.scrollTop();

      // Обработчики действий.
      // Карточка подписки ведёт на отдельный экран подписки.
      if (els.subCard) {
        els.subCard.addEventListener("click", function () {
          App.haptic("selection");
          App.navigate("subscription");
        });
      }

      // Переключатель языка.
      if (els.langRu) {
        els.langRu.addEventListener("click", function () {
          onPickLang("ru");
        });
      }
      if (els.langEn) {
        els.langEn.addEventListener("click", function () {
          onPickLang("en");
        });
      }

      els.calcBtn.addEventListener("click", onCalc);
      els.form.addEventListener("submit", onSave);

      // Обновляем статус подписки при показе (best-effort, без блокировок).
      // Сначала отображаем известный статус, затем тихо подтягиваем свежий.
      refreshSubCard();
      // Премиум-секции рендерим по известному статусу сразу...
      renderPremiumSections();
      if (App.refreshSubscription) {
        App.refreshSubscription()
          .then(function () {
            refreshSubCard();
            // ...и перерисовываем их, когда статус подписки обновился.
            renderPremiumSections();
          })
          .catch(function () {
            // Статус не критичен для аккаунта — оставляем как есть.
          });
      }

      // Предзаполнение формы данными профиля.
      // Сначала пробуем кэш, затем запрашиваем актуальные данные с сервера.
      if (App.state.profile) {
        fillForm(App.state.profile);
      }
      App.api
        .getProfile()
        .then(function (profile) {
          App.state.profile = profile;
          fillForm(profile);
          // Профиль содержит adaptive_enabled / calculated_maintenance —
          // перерисовываем премиум-секции актуальными данными.
          renderPremiumSections();
        })
        .catch(function (err) {
          // Профиль не критичен — форму можно заполнить вручную.
          var reason =
            err && err.message ? err.message : L("ошибка", "error");
          App.toast(
            L(
              "Не удалось загрузить профиль: " + reason,
              "Failed to load profile: " + reason
            )
          );
        });

      // Загрузка настроек вечерней сводки.
      loadSummary();

      // Загрузка истории за 30 дней.
      loadHistory();
    },

    /**
     * Вызывается при уходе со страницы — освобождаем кэш ссылок.
     */
    onHide: function () {
      els = null;
    }
  };

  // Регистрируем страницу и публикуем контроллер для отладки.
  window.PageAccount = controller;
  App.registerPage("account", controller);
})();
