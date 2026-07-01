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

      // ---- ПРЕМИУМ: Недельный AI-отчёт (контейнер заполняется в renderReport) ----
      '<section class="rep-card card" id="accReportCard"></section>' +

      // ---- ПРЕМИУМ: Трекинг цикла (контейнер заполняется в renderCycle) ----
      '<section class="cyc-card card" id="accCycleCard"></section>' +

      // ---- ПРЕМИУМ: Фото-прогресс (контейнер заполняется в renderProgress) ----
      '<section class="prog-card card" id="accProgressCard"></section>' +

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
   *  ПРЕМИУМ: НЕДЕЛЬНЫЙ AI-ОТЧЁТ / WEEKLY AI REPORT (Этап 5)
   *  Кнопка «Сформировать отчёт» -> App.api.getWeeklyReport().
   *  Показывает summary, список insights (буллеты), focus-совет (выделенный)
   *  и компактные ключевые stats. Платный роут (для free — paywall в карточке).
   *  Префикс CSS-классов: rep-.
   * ===================================================================== */

  /**
   * Строит карточку «Недельный AI-отчёт». Для free вставляет paywall прямо в
   * карточку (суб-контейнер, остальной аккаунт цел). Для премиум — заголовок,
   * подсказка, кнопка генерации и пустой контейнер тела (заполняется по клику).
   */
  function renderReport() {
    var card = els.reportCard;
    if (!card) return;

    if (!App.isPremium()) {
      // Гейтинг: paywall показываем в саму карточку (суб-контейнер, не весь #view).
      card.innerHTML = "";
      card.classList.add("rep-gate");
      App.paywall(card, {
        icon: "🧠",
        title: L("Недельный AI-отчёт", "Weekly AI report"),
        desc: L(
          "Краткий разбор недели: калории, БЖУ, тренировки и вес — с выводами и советом.",
          "A weekly recap: calories, macros, workouts and weight — with insights and a focus tip."
        ),
        bullets: [
          L("Сводка за неделю", "Weekly summary"),
          L("Полезные выводы", "Actionable insights"),
          L("Главный фокус недели", "Focus of the week")
        ]
      });
      return;
    }

    // Снимаем класс-гейт, если он остался от прошлого рендера (когда статус
    // подписки ещё не подтянулся): иначе карточка теряет фон/паддинг.
    card.classList.remove("rep-gate");

    card.innerHTML =
      '<h2 class="acc-title">' +
      App.escapeHtml(L("Недельный AI-отчёт", "Weekly AI report")) +
      "</h2>" +
      '<p class="rep-hint">' +
      App.escapeHtml(
        L(
          "Сформируем краткий разбор вашей недели: калории, БЖУ, тренировки и вес.",
          "We'll build a short recap of your week: calories, macros, workouts and weight."
        )
      ) +
      "</p>" +
      '<button type="button" class="btn btn--cta rep-gen-btn" id="accReportGen">🧠 ' +
      App.escapeHtml(L("Сформировать отчёт", "Generate report")) +
      "</button>" +
      '<div class="rep-body" id="accReportBody"></div>';

    var genBtn = card.querySelector("#accReportGen");
    var body = card.querySelector("#accReportBody");
    if (genBtn) {
      genBtn.addEventListener("click", function () {
        loadReport(genBtn, body);
      });
    }
  }

  /**
   * Загружает недельный AI-отчёт и отрисовывает результат.
   * Показывает состояние загрузки, обрабатывает ошибки (с кнопкой повтора).
   */
  function loadReport(genBtn, body) {
    if (!body) return;
    if (genBtn) genBtn.disabled = true;
    App.haptic("light");

    // Состояние загрузки (скелетон) прямо в теле отчёта.
    body.innerHTML =
      '<div class="rep-loading">' +
      '<div class="skeleton skeleton--block"></div>' +
      '<div class="rep-loading__text">' +
      App.escapeHtml(L("Анализируем неделю…", "Analyzing your week…")) +
      "</div>" +
      "</div>";

    App.api
      .getWeeklyReport()
      .then(function (res) {
        renderReportResult(body, res || {});
        App.haptic("success");
      })
      .catch(function (err) {
        var reason = err && err.message ? err.message : L("Ошибка сети", "Network error");
        body.innerHTML =
          '<div class="rep-error">' +
          "<p>" +
          App.escapeHtml(
            L("Не удалось сформировать отчёт.", "Failed to generate the report.")
          ) +
          "</p>" +
          '<p class="rep-error__msg">' +
          App.escapeHtml(reason) +
          "</p>" +
          '<button type="button" class="btn btn--ghost" id="accReportRetry">' +
          App.escapeHtml(L("Повторить", "Retry")) +
          "</button>" +
          "</div>";
        App.haptic("error");
        var retry = body.querySelector("#accReportRetry");
        if (retry) {
          retry.addEventListener("click", function () {
            loadReport(genBtn, body);
          });
        }
      })
      .finally(function () {
        if (genBtn) {
          genBtn.disabled = false;
          // После первой генерации меняем подпись на «Обновить отчёт».
          genBtn.textContent =
            "🔄 " + L("Обновить отчёт", "Refresh report");
        }
      });
  }

  /**
   * Отрисовывает результат недельного AI-отчёта.
   * @param {HTMLElement} body — контейнер тела отчёта.
   * @param {Object} res — {summary, insights:[str], focus:str|null, stats:{...}|null}.
   */
  function renderReportResult(body, res) {
    if (!body) return;

    var summary = res.summary ? String(res.summary).trim() : "";
    var insights = Array.isArray(res.insights) ? res.insights : [];
    var focus = res.focus ? String(res.focus).trim() : "";
    var stats = res.stats && typeof res.stats === "object" ? res.stats : null;

    // Пустой ответ — мягкое приглашение вести дневник.
    if (!summary && !insights.length && !focus && !stats) {
      body.innerHTML =
        '<div class="rep-empty">' +
        '<div class="rep-empty__icon" aria-hidden="true">📭</div>' +
        '<div class="rep-empty__text">' +
        App.escapeHtml(
          L(
            "Пока мало данных за неделю. Добавляйте приёмы пищи и тренировки — и отчёт станет точнее.",
            "Not enough data this week yet. Log meals and workouts — the report will get sharper."
          )
        ) +
        "</div>" +
        "</div>";
      return;
    }

    var html = "";

    // ---- Сводка ----
    if (summary) {
      html +=
        '<p class="rep-summary">' + App.escapeHtml(summary) + "</p>";
    }

    // ---- Список выводов (буллеты) ----
    if (insights.length) {
      var items = "";
      for (var i = 0; i < insights.length; i++) {
        var ins = insights[i];
        if (ins == null || String(ins).trim() === "") continue;
        items +=
          '<li class="rep-insight">' +
          '<span class="rep-insight__mark" aria-hidden="true">•</span>' +
          '<span class="rep-insight__text">' +
          App.escapeHtml(String(ins).trim()) +
          "</span>" +
          "</li>";
      }
      if (items) {
        html +=
          '<div class="rep-insights-title">' +
          App.escapeHtml(L("Выводы", "Insights")) +
          "</div>" +
          '<ul class="rep-insights">' + items + "</ul>";
      }
    }

    // ---- Главный фокус (выделенный совет) ----
    if (focus) {
      html +=
        '<div class="rep-focus">' +
        '<span class="rep-focus__icon" aria-hidden="true">🎯</span>' +
        '<span class="rep-focus__body">' +
        '<span class="rep-focus__label">' +
        App.escapeHtml(L("Фокус недели", "Focus of the week")) +
        "</span>" +
        '<span class="rep-focus__text">' +
        App.escapeHtml(focus) +
        "</span>" +
        "</span>" +
        "</div>";
    }

    // ---- Компактные ключевые stats ----
    if (stats) {
      html += renderReportStats(stats);
    }

    body.innerHTML = html;
  }

  /**
   * Формирует компактный блок ключевых метрик отчёта.
   * Показываем только заполненные значения (средние калории/дефицит,
   * тренировки, изменение веса и пр.).
   * @param {Object} s — объект stats.
   * @returns {string} HTML-разметка блока статистики.
   */
  function renderReportStats(s) {
    var kcal = L("ккал", "kcal");
    var cells = [];

    // Хелпер добавления ячейки (значение + подпись). Пустые значения пропускаем.
    function add(value, label, cls) {
      if (value == null || value === "") return;
      cells.push(
        '<div class="rep-stat' +
        (cls ? " " + cls : "") +
        '">' +
        '<span class="rep-stat__value">' +
        App.escapeHtml(value) +
        "</span>" +
        '<span class="rep-stat__label">' +
        App.escapeHtml(label) +
        "</span>" +
        "</div>"
      );
    }

    // Средние калории (+ цель в скобках, если задана).
    if (s.avg_calories != null && isFinite(Number(s.avg_calories))) {
      var calVal = App.fmt(s.avg_calories) + " " + kcal;
      add(calVal, L("Средние калории", "Avg calories"));
    }

    // Цель по калориям.
    if (s.goal != null && isFinite(Number(s.goal))) {
      add(App.fmt(s.goal) + " " + kcal, L("Цель", "Goal"));
    }

    // Средний дефицит (со знаком: дефицит/профицит).
    if (s.avg_deficit != null && isFinite(Number(s.avg_deficit))) {
      add(
        fmtChange(s.avg_deficit) + " " + kcal,
        L("Средний дефицит", "Avg deficit"),
        Number(s.avg_deficit) < 0 ? "rep-stat--good" : ""
      );
    }

    // Дни с записями.
    if (s.days_logged != null && isFinite(Number(s.days_logged))) {
      add(App.fmt(s.days_logged), L("Дней с записями", "Days logged"));
    }

    // Тренировки за неделю.
    if (s.workouts_count != null && isFinite(Number(s.workouts_count))) {
      add(App.fmt(s.workouts_count), L("Тренировок", "Workouts"));
    }

    // Сожжено калорий.
    if (s.total_burned != null && isFinite(Number(s.total_burned))) {
      add(App.fmt(s.total_burned) + " " + kcal, L("Сожжено", "Burned"));
    }

    // Изменение веса за неделю.
    if (s.weight_change_kg != null && isFinite(Number(s.weight_change_kg))) {
      var wNum = Number(s.weight_change_kg);
      add(
        fmtChange(s.weight_change_kg) + " " + L("кг", "kg"),
        L("Изменение веса", "Weight change"),
        wNum < 0 ? "rep-stat--down" : wNum > 0 ? "rep-stat--up" : ""
      );
    }

    // Средние БЖУ (одной строкой в подписи).
    var prot = s.avg_proteins;
    var fat = s.avg_fats;
    var carb = s.avg_carbs;
    if (
      (prot != null && isFinite(Number(prot))) ||
      (fat != null && isFinite(Number(fat))) ||
      (carb != null && isFinite(Number(carb)))
    ) {
      var g = L("г", "g");
      var macroVal =
        App.fmt(prot || 0) +
        "/" +
        App.fmt(fat || 0) +
        "/" +
        App.fmt(carb || 0) +
        " " +
        g;
      add(macroVal, L("Б/Ж/У в среднем", "Avg P/F/C"));
    }

    if (!cells.length) return "";

    return (
      '<div class="rep-stats-title">' +
      App.escapeHtml(L("Ключевые цифры", "Key numbers")) +
      "</div>" +
      '<div class="rep-stats">' + cells.join("") + "</div>"
    );
  }

  /* =====================================================================
   *  ТРЕКИНГ ЦИКЛА (Этап 6)
   *  Премиум-карточка: пользователь вводит дату начала последней менструации,
   *  среднюю длину цикла и длительность менструации; бэкенд считает фазу, день,
   *  прогноз и фертильное окно. Показываем деликатно, с фазовыми советами по
   *  питанию/тренировкам/самочувствию. Значения ориентировочные (дисклеймер).
   *  Женская фича: для профиля с gender="male" карточка скрывается.
   *  Префикс CSS-классов: cyc-. Весь текст через L/App.pick (RU/EN).
   * ===================================================================== */

  // Двузначная дополняющая функция (без зависимости от padStart в старых webview).
  function cyc2(n) {
    n = String(n);
    return n.length < 2 ? "0" + n : n;
  }

  // Сегодняшняя дата в ISO "YYYY-MM-DD" по локальному времени (для max/дефолта).
  function cycToday() {
    var d = new Date();
    return d.getFullYear() + "-" + cyc2(d.getMonth() + 1) + "-" + cyc2(d.getDate());
  }

  // Короткий формат ISO-даты -> "DD.MM" (для фертильного окна и прогнозов).
  function cycShortDate(iso) {
    if (!iso || String(iso).length < 10) return "";
    var p = String(iso).split("-");
    return p[2] + "." + p[1];
  }

  // Метаданные фаз: эмодзи, название и советы (питание/тренировки/самочувствие).
  function cyclePhaseInfo(phase) {
    var map = {
      menstrual: {
        icon: "🩸",
        name: L("Менструация", "Menstruation"),
        cls: "cyc-phase--menstrual",
        nutrition: L(
          "Больше железа: красное мясо, гречка, зелень, гранат. Тёплая еда и вода.",
          "More iron: red meat, buckwheat, greens, pomegranate. Warm food and water."
        ),
        training: L(
          "Мягкая активность: прогулки, растяжка, лёгкая йога.",
          "Gentle activity: walks, stretching, light yoga."
        ),
        wellbeing: L(
          "Отдых и сон в приоритете — не корите себя за усталость.",
          "Prioritize rest and sleep — be kind to yourself if you're tired."
        )
      },
      follicular: {
        icon: "🌱",
        name: L("Фолликулярная фаза", "Follicular phase"),
        cls: "cyc-phase--follicular",
        nutrition: L(
          "Энергии больше — упор на белок и сложные углеводы.",
          "More energy — focus on protein and complex carbs."
        ),
        training: L(
          "Хорошее время для силовых и интенсивных тренировок.",
          "A great time for strength and high-intensity training."
        ),
        wellbeing: L(
          "Настроение на подъёме — планируйте важные дела.",
          "Mood is rising — plan important tasks."
        )
      },
      ovulation: {
        icon: "✨",
        name: L("Овуляция", "Ovulation"),
        cls: "cyc-phase--ovulation",
        nutrition: L(
          "Лёгкая клетчатка и антиоксиданты: овощи, ягоды, зелень.",
          "Light fiber and antioxidants: veggies, berries, greens."
        ),
        training: L(
          "Пик силы и выносливости — можно замахнуться на рекорды.",
          "Peak strength and endurance — go for personal bests."
        ),
        wellbeing: L(
          "Больше энергии и общения — используйте момент.",
          "More energy and sociability — make the most of it."
        )
      },
      luteal: {
        icon: "🌙",
        name: L("Лютеиновая фаза", "Luteal phase"),
        cls: "cyc-phase--luteal",
        nutrition: L(
          "Тяга к сладкому — магний и сложные углеводы: орехи, тёмный шоколад, овощи.",
          "Sweet cravings — magnesium and complex carbs: nuts, dark chocolate, veggies."
        ),
        training: L(
          "Ближе к концу снижайте интенсивность: лёгкое кардио, йога.",
          "Ease off intensity toward the end: light cardio, yoga."
        ),
        wellbeing: L(
          "Возможна раздражительность — сон, вода, меньше кофеина.",
          "Possible irritability — sleep, water, less caffeine."
        )
      }
    };
    return map[phase] || null;
  }

  /**
   * Карточка «Трекинг цикла». Для free — единый paywall в карточку. Для мужского
   * профиля карточка скрывается. Для премиум — статус загружается один раз за
   * показ (кэш в els.cycleData), дальше перерисовки идут из кэша без запросов.
   */
  function renderCycle() {
    var card = els.cycleCard;
    if (!card) return;

    // Женская фича: для явно мужского профиля скрываем карточку целиком.
    var gender = App.state.profile && App.state.profile.gender;
    if (gender === "male") {
      card.style.display = "none";
      card.innerHTML = "";
      return;
    }
    card.style.display = "";

    if (!App.isPremium()) {
      // Гейтинг: paywall прямо в карточку (суб-контейнер, не весь #view).
      els.cycleLoaded = false;
      card.innerHTML = "";
      card.classList.add("cyc-gate");
      App.paywall(card, {
        icon: "🌸",
        title: L("Трекинг цикла", "Cycle tracking"),
        desc: L(
          "Отслеживайте фазу цикла и получайте советы по питанию и тренировкам под неё.",
          "Track your cycle phase and get nutrition and training tips tailored to it."
        ),
        bullets: [
          L("Текущая фаза и день цикла", "Current phase and cycle day"),
          L("Прогноз менструации и овуляции", "Period and ovulation forecast"),
          L("Советы под фазу цикла", "Phase-based tips")
        ]
      });
      return;
    }
    card.classList.remove("cyc-gate");

    // Уже загружено в этот показ — рендерим из кэша, без повторного запроса.
    if (els.cycleLoaded) {
      renderCycleView(card, els.cycleData || { has_data: false });
      return;
    }
    // Уже идёт загрузка — не перезапускаем (оставляем скелетон).
    if (els.cycleFetching) return;

    els.cycleFetching = true;
    card.innerHTML =
      cycleHeaderHtml() +
      '<div class="cyc-body">' +
      '<div class="skeleton skeleton--block"></div>' +
      "</div>";

    App.api
      .getCycleStatus()
      .then(function (res) {
        els.cycleFetching = false;
        els.cycleLoaded = true;
        els.cycleData = res || { has_data: false };
        // Карточка ещё на экране (не ушли со страницы)?
        if (els && els.cycleCard) renderCycleView(els.cycleCard, els.cycleData);
      })
      .catch(function (err) {
        els.cycleFetching = false;
        if (!els || !els.cycleCard) return;
        var reason = err && err.message ? err.message : L("Ошибка сети", "Network error");
        els.cycleCard.innerHTML =
          cycleHeaderHtml() +
          '<div class="cyc-body"><div class="cyc-error">' +
          "<p>" +
          App.escapeHtml(L("Не удалось загрузить данные цикла.", "Failed to load cycle data.")) +
          "</p>" +
          '<p class="cyc-error__msg">' + App.escapeHtml(reason) + "</p>" +
          '<button type="button" class="btn btn--ghost" id="accCycleRetry">' +
          App.escapeHtml(L("Повторить", "Retry")) +
          "</button></div></div>";
        var retry = els.cycleCard.querySelector("#accCycleRetry");
        if (retry) {
          retry.addEventListener("click", function () {
            els.cycleLoaded = false;
            renderCycle();
          });
        }
      });
  }

  // Заголовок карточки цикла (общий для всех состояний).
  function cycleHeaderHtml() {
    return (
      '<h2 class="acc-title">' +
      App.escapeHtml(L("Трекинг цикла", "Cycle tracking")) +
      "</h2>"
    );
  }

  /**
   * Решает, что показать: форму настройки (нет данных / режим редактирования)
   * или статус текущей фазы.
   */
  function renderCycleView(card, data) {
    if (!card) return;
    if (!data || !data.has_data) {
      card.innerHTML =
        cycleHeaderHtml() +
        '<p class="cyc-hint">' +
        App.escapeHtml(
          L(
            "Отметьте начало последней менструации — покажем текущую фазу, прогноз и советы под неё.",
            "Log the start of your last period — we'll show the current phase, a forecast and phase-based tips."
          )
        ) +
        "</p>" +
        '<div class="cyc-body">' + cycleFormHtml(null) + "</div>";
      bindCycleForm(card, false);
      return;
    }
    // Есть данные — показываем статус.
    card.innerHTML = cycleHeaderHtml() + '<div class="cyc-body">' + cycleStatusHtml(data) + "</div>";
    bindCycleStatus(card);
  }

  /**
   * HTML формы ввода/редактирования данных цикла. При наличии data поля
   * предзаполняются текущими значениями.
   */
  function cycleFormHtml(data) {
    var startVal = data && data.cycle_start_date ? data.cycle_start_date : "";
    var clVal = data && data.cycle_length ? data.cycle_length : "";
    var plVal = data && data.period_length ? data.period_length : "";
    var notesVal = data && data.notes ? data.notes : "";
    var today = cycToday();

    return (
      '<form class="cyc-form" id="accCycleForm">' +
      // Дата начала менструации.
      '<label class="cyc-field">' +
      '<span class="cyc-field__label">' +
      App.escapeHtml(L("Начало последней менструации", "Last period start")) +
      "</span>" +
      '<input type="date" class="field cyc-input" id="accCycStart" max="' +
      today +
      '" value="' +
      App.escapeHtml(startVal) +
      '" required>' +
      "</label>" +
      // Средняя длина цикла.
      '<label class="cyc-field">' +
      '<span class="cyc-field__label">' +
      App.escapeHtml(L("Средняя длина цикла, дней", "Average cycle length, days")) +
      "</span>" +
      '<input type="number" inputmode="numeric" class="field cyc-input" id="accCycLen" ' +
      'min="20" max="45" placeholder="28" value="' +
      App.escapeHtml(String(clVal)) +
      '">' +
      "</label>" +
      // Длительность менструации.
      '<label class="cyc-field">' +
      '<span class="cyc-field__label">' +
      App.escapeHtml(L("Длительность менструации, дней", "Period length, days")) +
      "</span>" +
      '<input type="number" inputmode="numeric" class="field cyc-input" id="accCycPeriod" ' +
      'min="1" max="10" placeholder="5" value="' +
      App.escapeHtml(String(plVal)) +
      '">' +
      "</label>" +
      // Заметка (необязательно).
      '<label class="cyc-field">' +
      '<span class="cyc-field__label">' +
      App.escapeHtml(L("Заметка (необязательно)", "Note (optional)")) +
      "</span>" +
      '<input type="text" class="field cyc-input" id="accCycNotes" maxlength="200" placeholder="' +
      App.escapeHtml(L("самочувствие, симптомы…", "how you feel, symptoms…")) +
      '" value="' +
      App.escapeHtml(notesVal) +
      '">' +
      "</label>" +
      '<button type="submit" class="btn btn--cta cyc-save" id="accCycSave">' +
      App.escapeHtml(L("Сохранить", "Save")) +
      "</button>" +
      '<p class="cyc-disclaimer">' +
      App.escapeHtml(
        L(
          "Прогноз ориентировочный и не заменяет консультацию врача.",
          "The forecast is approximate and not a substitute for medical advice."
        )
      ) +
      "</p>" +
      "</form>"
    );
  }

  // Вешает submit-обработчик на форму цикла (сохранение данных).
  function bindCycleForm(card, isEdit) {
    var form = card.querySelector("#accCycleForm");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      onCycleSave(card);
    });
    // В режиме редактирования (есть данные) добавим кнопку «Отмена» -> назад к статусу.
    if (isEdit) {
      var cancel = card.querySelector("#accCycCancel");
      if (cancel) {
        cancel.addEventListener("click", function () {
          renderCycleView(card, els.cycleData);
        });
      }
    }
  }

  // Собирает данные формы, валидирует и отправляет на бэкенд.
  function onCycleSave(card) {
    var startEl = card.querySelector("#accCycStart");
    var lenEl = card.querySelector("#accCycLen");
    var perEl = card.querySelector("#accCycPeriod");
    var notesEl = card.querySelector("#accCycNotes");
    var saveBtn = card.querySelector("#accCycSave");

    var start = startEl ? String(startEl.value || "").trim() : "";
    if (!start) {
      App.toast(L("Укажите дату начала менструации", "Please set the period start date"));
      App.haptic("error");
      return;
    }

    var payload = { cycle_start_date: start };
    if (lenEl && String(lenEl.value).trim() !== "") {
      payload.cycle_length = parseInt(lenEl.value, 10);
    }
    if (perEl && String(perEl.value).trim() !== "") {
      payload.period_length = parseInt(perEl.value, 10);
    }
    if (notesEl && String(notesEl.value).trim() !== "") {
      payload.notes = String(notesEl.value).trim();
    }

    if (saveBtn) saveBtn.disabled = true;
    App.haptic("light");

    App.api
      .logCycle(payload)
      .then(function (res) {
        els.cycleLoaded = true;
        els.cycleData = res || { has_data: false };
        renderCycleView(card, els.cycleData);
        App.toast(L("Данные цикла сохранены", "Cycle data saved"));
        App.haptic("success");
      })
      .catch(function (err) {
        if (saveBtn) saveBtn.disabled = false;
        var reason = err && err.message ? err.message : L("Ошибка сети", "Network error");
        App.toast(L("Не удалось сохранить: ", "Failed to save: ") + reason);
        App.haptic("error");
      });
  }

  // HTML блока текущего статуса цикла (фаза, день, прогнозы, советы).
  function cycleStatusHtml(data) {
    var info = cyclePhaseInfo(data.phase);
    var phaseName = info ? info.name : L("Фаза цикла", "Cycle phase");
    var phaseIcon = info ? info.icon : "🌸";
    var phaseCls = info ? info.cls : "";

    // Плашка фазы + день цикла.
    var html =
      '<div class="cyc-phase ' + phaseCls + '">' +
      '<span class="cyc-phase__icon" aria-hidden="true">' + phaseIcon + "</span>" +
      '<span class="cyc-phase__text">' +
      '<span class="cyc-phase__name">' + App.escapeHtml(phaseName) + "</span>" +
      '<span class="cyc-phase__day">' +
      App.escapeHtml(
        L("День цикла: ", "Cycle day: ") + (data.day_of_cycle != null ? data.day_of_cycle : "—")
      ) +
      "</span>" +
      "</span>" +
      "</div>";

    // Прогнозы: следующая менструация (обратный отсчёт) + фертильное окно.
    var facts = [];
    if (data.days_until_next_period != null) {
      var dleft = Number(data.days_until_next_period);
      var whenText;
      if (dleft <= 0) {
        whenText = L("ожидается сегодня", "expected today");
      } else {
        whenText =
          L("через ", "in ") + dleft + " " + cycDays(dleft) +
          (data.next_period_date ? " · " + cycShortDate(data.next_period_date) : "");
      }
      facts.push(
        cycFactHtml("📅", L("Следующая менструация", "Next period"), whenText)
      );
    }
    if (data.ovulation_date) {
      facts.push(
        cycFactHtml("✨", L("Овуляция (оценка)", "Ovulation (est.)"), cycShortDate(data.ovulation_date))
      );
    }
    if (data.fertile_start && data.fertile_end) {
      facts.push(
        cycFactHtml(
          "🌷",
          L("Фертильное окно", "Fertile window"),
          cycShortDate(data.fertile_start) + "–" + cycShortDate(data.fertile_end)
        )
      );
    }
    if (facts.length) {
      html += '<div class="cyc-facts">' + facts.join("") + "</div>";
    }

    // Советы под фазу (питание / тренировки / самочувствие).
    if (info) {
      html +=
        '<div class="cyc-tips">' +
        '<div class="cyc-tips__title">' +
        App.escapeHtml(L("Рекомендации на эту фазу", "Tips for this phase")) +
        "</div>" +
        cycTipHtml("🍽️", L("Питание", "Nutrition"), info.nutrition) +
        cycTipHtml("🏃", L("Тренировки", "Training"), info.training) +
        cycTipHtml("💗", L("Самочувствие", "Well-being"), info.wellbeing) +
        "</div>";
    }

    // Заметка пользователя (если есть).
    if (data.notes) {
      html +=
        '<div class="cyc-note">' +
        '<span class="cyc-note__label">' +
        App.escapeHtml(L("Заметка: ", "Note: ")) +
        "</span>" +
        App.escapeHtml(data.notes) +
        "</div>";
    }

    // Действия: обновить данные / сбросить.
    html +=
      '<div class="cyc-actions">' +
      '<button type="button" class="btn btn--ghost cyc-edit" id="accCycEdit">' +
      App.escapeHtml(L("Обновить данные", "Update data")) +
      "</button>" +
      '<button type="button" class="btn btn--ghost cyc-reset" id="accCycReset">' +
      App.escapeHtml(L("Сбросить", "Reset")) +
      "</button>" +
      "</div>" +
      '<p class="cyc-disclaimer">' +
      App.escapeHtml(
        L(
          "Прогноз ориентировочный и не заменяет консультацию врача.",
          "The forecast is approximate and not a substitute for medical advice."
        )
      ) +
      "</p>";

    return html;
  }

  // Склонение слова «день» для русского (2 дня / 5 дней); для EN всегда day(s).
  function cycDays(n) {
    if (App.lang === "en") return n === 1 ? "day" : "days";
    var m10 = n % 10;
    var m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return "день";
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "дня";
    return "дней";
  }

  // Один факт-прогноз (иконка + подпись + значение).
  function cycFactHtml(icon, label, value) {
    return (
      '<div class="cyc-fact">' +
      '<span class="cyc-fact__icon" aria-hidden="true">' + icon + "</span>" +
      '<span class="cyc-fact__body">' +
      '<span class="cyc-fact__label">' + App.escapeHtml(label) + "</span>" +
      '<span class="cyc-fact__value">' + App.escapeHtml(value) + "</span>" +
      "</span>" +
      "</div>"
    );
  }

  // Один совет под фазу (иконка + заголовок + текст).
  function cycTipHtml(icon, title, text) {
    return (
      '<div class="cyc-tip">' +
      '<span class="cyc-tip__icon" aria-hidden="true">' + icon + "</span>" +
      '<span class="cyc-tip__body">' +
      '<span class="cyc-tip__title">' + App.escapeHtml(title) + "</span>" +
      '<span class="cyc-tip__text">' + App.escapeHtml(text) + "</span>" +
      "</span>" +
      "</div>"
    );
  }

  // Вешает обработчики на кнопки «Обновить данные» и «Сбросить».
  function bindCycleStatus(card) {
    var editBtn = card.querySelector("#accCycEdit");
    if (editBtn) {
      editBtn.addEventListener("click", function () {
        App.haptic("selection");
        // Показываем форму, предзаполненную текущими данными, с кнопкой «Отмена».
        card.innerHTML =
          cycleHeaderHtml() +
          '<div class="cyc-body">' +
          cycleFormHtml(els.cycleData) +
          "</div>";
        // Добавляем кнопку отмены рядом с сохранением.
        var saveBtn = card.querySelector("#accCycSave");
        if (saveBtn) {
          var cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "btn btn--ghost cyc-cancel";
          cancel.id = "accCycCancel";
          cancel.textContent = L("Отмена", "Cancel");
          saveBtn.insertAdjacentElement("afterend", cancel);
        }
        bindCycleForm(card, true);
      });
    }

    var resetBtn = card.querySelector("#accCycReset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (!window.confirm(L("Удалить данные цикла?", "Delete cycle data?"))) return;
        resetBtn.disabled = true;
        App.haptic("light");
        App.api
          .resetCycle()
          .then(function () {
            els.cycleLoaded = true;
            els.cycleData = { has_data: false };
            renderCycleView(card, els.cycleData);
            App.toast(L("Данные цикла удалены", "Cycle data deleted"));
            App.haptic("success");
          })
          .catch(function (err) {
            resetBtn.disabled = false;
            var reason = err && err.message ? err.message : L("Ошибка сети", "Network error");
            App.toast(L("Не удалось удалить: ", "Failed to delete: ") + reason);
            App.haptic("error");
          });
      });
    }
  }

  /* =====================================================================
   *  ФОТО-ПРОГРЕСС (Этап 7)
   *  Премиум-карточка: приватные фото прогресса (загрузка, таймлайн, сравнение
   *  «до/после»). Файлы приватны — грузятся авторизованно как blob -> object URL,
   *  ссылки нигде не публикуются. Object URL'ы освобождаются при уходе/перерисовке.
   *  Префикс CSS-классов: prog-. Весь текст через L/App.pick (RU/EN).
   * ===================================================================== */

  // Форматирование ISO-даты -> "DD.MM.YYYY" для подписей фото.
  function progFmtDate(iso) {
    if (!iso || String(iso).length < 10) return "";
    var p = String(iso).split("-");
    return p[2] + "." + p[1] + "." + p[0];
  }

  // Формат веса с точностью до 0.1 кг (без хвостового ".0"), для подписей фото.
  function progWeight(w) {
    var n = Number(w);
    if (!isFinite(n)) return "";
    return String(Math.round(n * 10) / 10);
  }

  // Освобождает все object URL'ы фото (защита от утечек памяти).
  function revokeProgressUrls() {
    if (els && els.progressUrlMap) {
      Object.keys(els.progressUrlMap).forEach(function (k) {
        try {
          URL.revokeObjectURL(els.progressUrlMap[k]);
        } catch (e) {}
      });
      els.progressUrlMap = {};
    }
    if (els && els.progressPreviewUrl) {
      try {
        URL.revokeObjectURL(els.progressPreviewUrl);
      } catch (e) {}
      els.progressPreviewUrl = null;
    }
  }

  // Возвращает (кэшируя) object URL приватного изображения по id.
  function getCachedProgressUrl(id) {
    if (!els) return Promise.reject(new Error("gone"));
    if (!els.progressUrlMap) els.progressUrlMap = {};
    if (els.progressUrlMap[id]) return Promise.resolve(els.progressUrlMap[id]);
    return App.api.getProgressImageUrl(id).then(function (url) {
      if (!els) {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {}
        throw new Error("gone");
      }
      if (!els.progressUrlMap) els.progressUrlMap = {};
      els.progressUrlMap[id] = url;
      return url;
    });
  }

  // Заголовок карточки (общий для всех состояний).
  function progressHeaderHtml() {
    return (
      '<h2 class="acc-title">' +
      App.escapeHtml(L("Фото-прогресс", "Progress photos")) +
      "</h2>"
    );
  }

  /**
   * Карточка «Фото-прогресс». Для free — единый paywall в карточку. Для премиум —
   * список фото загружается один раз за показ (кэш в els.progressData), дальше
   * перерисовки идут из кэша; при загрузке/удалении список обновляется.
   */
  function renderProgress() {
    var card = els.progressCard;
    if (!card) return;

    if (!App.isPremium()) {
      els.progressLoaded = false;
      revokeProgressUrls();
      card.innerHTML = "";
      card.classList.add("prog-gate");
      App.paywall(card, {
        icon: "📸",
        title: L("Фото-прогресс", "Progress photos"),
        desc: L(
          "Сохраняйте фото прогресса и сравнивайте «до/после». Фото приватны — видите только вы.",
          "Save progress photos and compare before/after. Photos are private — only you can see them."
        ),
        bullets: [
          L("Личный таймлайн фото", "Personal photo timeline"),
          L("Сравнение «до/после»", "Before/after comparison"),
          L("Полная приватность", "Fully private")
        ]
      });
      return;
    }
    card.classList.remove("prog-gate");

    if (els.progressLoaded) {
      renderProgressView(card, els.progressData || []);
      return;
    }
    if (els.progressFetching) return;

    els.progressFetching = true;
    card.innerHTML =
      progressHeaderHtml() +
      '<div class="prog-body"><div class="skeleton skeleton--block"></div></div>';

    App.api
      .getProgressList()
      .then(function (res) {
        els.progressFetching = false;
        els.progressLoaded = true;
        els.progressData = (res && res.items) || [];
        if (els && els.progressCard) renderProgressView(els.progressCard, els.progressData);
      })
      .catch(function (err) {
        els.progressFetching = false;
        if (!els || !els.progressCard) return;
        var reason = err && err.message ? err.message : L("Ошибка сети", "Network error");
        els.progressCard.innerHTML =
          progressHeaderHtml() +
          '<div class="prog-body"><div class="cyc-error">' +
          "<p>" +
          App.escapeHtml(L("Не удалось загрузить фото.", "Failed to load photos.")) +
          "</p>" +
          '<p class="cyc-error__msg">' + App.escapeHtml(reason) + "</p>" +
          '<button type="button" class="btn btn--ghost" id="accProgRetry">' +
          App.escapeHtml(L("Повторить", "Retry")) +
          "</button></div></div>";
        var retry = els.progressCard.querySelector("#accProgRetry");
        if (retry) {
          retry.addEventListener("click", function () {
            els.progressLoaded = false;
            renderProgress();
          });
        }
      });
  }

  /**
   * Основное содержимое карточки: приватная пометка, кнопка добавления,
   * таймлайн миниатюр и (при >=2 фото) блок сравнения «до/после».
   */
  function renderProgressView(card, items) {
    if (!card) return;
    items = items || [];

    var html =
      progressHeaderHtml() +
      '<p class="prog-privacy">🔒 ' +
      App.escapeHtml(
        L(
          "Фото приватны и видны только вам.",
          "Photos are private and visible only to you."
        )
      ) +
      "</p>" +
      '<button type="button" class="btn btn--cta prog-add" id="accProgAdd">➕ ' +
      App.escapeHtml(L("Добавить фото", "Add photo")) +
      "</button>" +
      '<input type="file" accept="image/*" id="accProgFile" class="prog-file" hidden>' +
      '<div class="prog-upload" id="accProgForm"></div>';

    if (!items.length) {
      html +=
        '<div class="prog-empty">' +
        '<div class="prog-empty__icon" aria-hidden="true">📷</div>' +
        '<div class="prog-empty__text">' +
        App.escapeHtml(
          L(
            "Пока нет фото. Добавьте первое — так удобно отслеживать изменения.",
            "No photos yet. Add your first one — a handy way to track changes."
          )
        ) +
        "</div></div>";
    } else {
      html += progressTimelineHtml(items);
      if (items.length >= 2) {
        html += progressCompareHtml(items);
      }
    }

    card.innerHTML = html;
    bindProgress(card, items);
    loadProgressThumbs(card, items);
    if (items.length >= 2) setupProgressCompare(card, items);
  }

  // HTML таймлайна миниатюр (img подгружается асинхронно как blob).
  function progressTimelineHtml(items) {
    var cells = "";
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var meta = progFmtDate(it.date);
      if (it.weight != null && it.weight !== "") {
        meta += " · " + progWeight(it.weight) + " " + L("кг", "kg");
      }
      cells +=
        '<div class="prog-item" data-id="' + it.id + '">' +
        '<div class="prog-item__frame">' +
        '<img class="prog-item__img" alt="" data-id="' + it.id + '">' +
        '<button type="button" class="prog-item__del" data-id="' + it.id + '" ' +
        'aria-label="' + App.escapeHtml(L("Удалить", "Delete")) + '">✕</button>' +
        "</div>" +
        '<div class="prog-item__meta">' + App.escapeHtml(meta) + "</div>" +
        "</div>";
    }
    return (
      '<div class="prog-timeline-title">' +
      App.escapeHtml(L("Таймлайн", "Timeline")) +
      "</div>" +
      '<div class="prog-timeline">' + cells + "</div>"
    );
  }

  // Асинхронно проставляет src миниатюрам (из кэша object URL).
  function loadProgressThumbs(card, items) {
    items.forEach(function (it) {
      var img = card.querySelector('.prog-item__img[data-id="' + it.id + '"]');
      if (!img) return;
      getCachedProgressUrl(it.id)
        .then(function (url) {
          // Карточка ещё жива и это тот же элемент?
          if (img && img.isConnected) img.src = url;
        })
        .catch(function () {
          /* фото не загрузилось — оставляем пустую рамку */
        });
    });
  }

  // HTML блока сравнения «до/после» (два селектора + слайдер-шторка).
  function progressCompareHtml(items) {
    var opts = "";
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var label = progFmtDate(it.date);
      if (it.weight != null && it.weight !== "") {
        label += " · " + progWeight(it.weight) + " " + L("кг", "kg");
      }
      opts +=
        '<option value="' + it.id + '">' + App.escapeHtml(label) + "</option>";
    }
    return (
      '<div class="prog-compare-title">' +
      App.escapeHtml(L("Сравнение «до/после»", "Before / after")) +
      "</div>" +
      '<div class="prog-compare">' +
      '<div class="prog-compare__stage" id="accProgStage">' +
      '<img class="prog-compare__img prog-compare__before" id="accProgBeforeImg" alt="">' +
      '<img class="prog-compare__img prog-compare__after" id="accProgAfterImg" alt="">' +
      '<div class="prog-compare__handle" id="accProgHandle"></div>' +
      "</div>" +
      '<input type="range" min="0" max="100" value="50" class="prog-compare__range" id="accProgRange">' +
      '<div class="prog-compare__selects">' +
      '<label class="prog-compare__sel">' +
      '<span>' + App.escapeHtml(L("До", "Before")) + "</span>" +
      '<select class="field prog-compare__select" id="accProgBefore">' + opts + "</select>" +
      "</label>" +
      '<label class="prog-compare__sel">' +
      '<span>' + App.escapeHtml(L("После", "After")) + "</span>" +
      '<select class="field prog-compare__select" id="accProgAfter">' + opts + "</select>" +
      "</label>" +
      "</div>" +
      "</div>"
    );
  }

  // Инициализирует сравнение: дефолт до=первое, после=последнее; слайдер + селекты.
  function setupProgressCompare(card, items) {
    var beforeSel = card.querySelector("#accProgBefore");
    var afterSel = card.querySelector("#accProgAfter");
    var beforeImg = card.querySelector("#accProgBeforeImg");
    var afterImg = card.querySelector("#accProgAfterImg");
    var range = card.querySelector("#accProgRange");
    var handle = card.querySelector("#accProgHandle");
    if (!beforeSel || !afterSel || !beforeImg || !afterImg || !range || !handle) return;

    // По умолчанию сравниваем самое раннее фото с самым поздним.
    beforeSel.value = String(items[0].id);
    afterSel.value = String(items[items.length - 1].id);

    function setImg(imgEl, id) {
      getCachedProgressUrl(id)
        .then(function (url) {
          if (imgEl && imgEl.isConnected) imgEl.src = url;
        })
        .catch(function () {});
    }

    function applyClip() {
      var v = Number(range.value);
      // Показываем левые v% «после»-фото поверх «до»-фото.
      afterImg.style.clipPath = "inset(0 " + (100 - v) + "% 0 0)";
      afterImg.style.webkitClipPath = "inset(0 " + (100 - v) + "% 0 0)";
      handle.style.left = v + "%";
    }

    setImg(beforeImg, items[0].id);
    setImg(afterImg, items[items.length - 1].id);
    applyClip();

    range.addEventListener("input", applyClip);
    beforeSel.addEventListener("change", function () {
      setImg(beforeImg, beforeSel.value);
    });
    afterSel.addEventListener("change", function () {
      setImg(afterImg, afterSel.value);
    });
  }

  // Вешает обработчики: добавление фото, форму загрузки, удаление.
  function bindProgress(card, items) {
    var addBtn = card.querySelector("#accProgAdd");
    var fileInput = card.querySelector("#accProgFile");
    if (addBtn && fileInput) {
      addBtn.addEventListener("click", function () {
        App.haptic("selection");
        fileInput.value = ""; // позволяем повторно выбрать тот же файл
        fileInput.click();
      });
      fileInput.addEventListener("change", function () {
        var f = fileInput.files && fileInput.files[0];
        if (f) openProgressUploadForm(card, f);
      });
    }

    // Удаление фото (делегирование по кнопкам «✕»).
    var timeline = card.querySelector(".prog-timeline");
    if (timeline) {
      timeline.addEventListener("click", function (e) {
        var btn = e.target.closest(".prog-item__del");
        if (!btn) return;
        var id = btn.getAttribute("data-id");
        if (!id) return;
        if (!window.confirm(L("Удалить это фото?", "Delete this photo?"))) return;
        onProgressDelete(card, id);
      });
    }
  }

  // Показывает инлайн-форму загрузки: превью выбранного файла + вес + дата.
  function openProgressUploadForm(card, file) {
    var form = card.querySelector("#accProgForm");
    if (!form) return;

    // Готовим превью выбранного файла (локальный object URL — освобождаем при закрытии).
    if (els.progressPreviewUrl) {
      try {
        URL.revokeObjectURL(els.progressPreviewUrl);
      } catch (e) {}
    }
    els.progressPreviewUrl = URL.createObjectURL(file);
    els.progressPendingFile = file;

    form.innerHTML =
      '<div class="prog-upload__preview">' +
      '<img src="' + els.progressPreviewUrl + '" alt="" class="prog-upload__img">' +
      "</div>" +
      '<label class="cyc-field">' +
      '<span class="cyc-field__label">' +
      App.escapeHtml(L("Дата", "Date")) +
      "</span>" +
      '<input type="date" class="field prog-upload__input" id="accProgDate" max="' +
      cycToday() +
      '" value="' + cycToday() + '">' +
      "</label>" +
      '<label class="cyc-field">' +
      '<span class="cyc-field__label">' +
      App.escapeHtml(L("Вес, кг (необязательно)", "Weight, kg (optional)")) +
      "</span>" +
      '<input type="number" inputmode="decimal" step="0.1" min="0" class="field prog-upload__input" ' +
      'id="accProgWeight" placeholder="' + App.escapeHtml(L("напр. 72.5", "e.g. 72.5")) + '">' +
      "</label>" +
      '<div class="prog-upload__actions">' +
      '<button type="button" class="btn btn--cta prog-upload__save" id="accProgSave">' +
      App.escapeHtml(L("Загрузить", "Upload")) +
      "</button>" +
      '<button type="button" class="btn btn--ghost prog-upload__cancel" id="accProgCancel">' +
      App.escapeHtml(L("Отмена", "Cancel")) +
      "</button>" +
      "</div>";

    var save = form.querySelector("#accProgSave");
    var cancel = form.querySelector("#accProgCancel");
    if (save) save.addEventListener("click", function () { onProgressUpload(card, form); });
    if (cancel) cancel.addEventListener("click", function () { closeProgressUploadForm(card); });
  }

  // Закрывает форму загрузки и освобождает превью-URL.
  function closeProgressUploadForm(card) {
    var form = card.querySelector("#accProgForm");
    if (form) form.innerHTML = "";
    if (els && els.progressPreviewUrl) {
      try {
        URL.revokeObjectURL(els.progressPreviewUrl);
      } catch (e) {}
      els.progressPreviewUrl = null;
    }
    if (els) els.progressPendingFile = null;
  }

  // Отправляет выбранный файл на сервер, затем обновляет список.
  function onProgressUpload(card, form) {
    var file = els.progressPendingFile;
    if (!file) return;
    var dateEl = form.querySelector("#accProgDate");
    var weightEl = form.querySelector("#accProgWeight");
    var saveBtn = form.querySelector("#accProgSave");

    var date = dateEl ? String(dateEl.value || "").trim() : "";
    var weight = weightEl ? String(weightEl.value || "").trim() : "";

    if (saveBtn) saveBtn.disabled = true;
    App.haptic("light");

    App.api
      .uploadProgress(file, date, weight)
      .then(function (photo) {
        closeProgressUploadForm(card);
        // Добавляем новое фото в кэш данных и перерисовываем (без полного refetch).
        if (!Array.isArray(els.progressData)) els.progressData = [];
        els.progressData.push(photo);
        // Пересортировка по дате по возрастанию (как на бэкенде).
        els.progressData.sort(function (a, b) {
          if (a.date === b.date) return (a.id || 0) - (b.id || 0);
          return a.date < b.date ? -1 : 1;
        });
        renderProgressView(card, els.progressData);
        App.toast(L("Фото добавлено", "Photo added"));
        App.haptic("success");
      })
      .catch(function (err) {
        if (saveBtn) saveBtn.disabled = false;
        var reason = err && err.message ? err.message : L("Ошибка сети", "Network error");
        App.toast(L("Не удалось загрузить: ", "Failed to upload: ") + reason);
        App.haptic("error");
      });
  }

  // Удаляет фото на сервере и обновляет список/кэш.
  function onProgressDelete(card, id) {
    App.haptic("light");
    App.api
      .deleteProgress(id)
      .then(function () {
        // Освобождаем object URL удалённого фото.
        if (els.progressUrlMap && els.progressUrlMap[id]) {
          try {
            URL.revokeObjectURL(els.progressUrlMap[id]);
          } catch (e) {}
          delete els.progressUrlMap[id];
        }
        els.progressData = (els.progressData || []).filter(function (p) {
          return String(p.id) !== String(id);
        });
        renderProgressView(card, els.progressData);
        App.toast(L("Фото удалено", "Photo deleted"));
        App.haptic("success");
      })
      .catch(function (err) {
        var reason = err && err.message ? err.message : L("Ошибка сети", "Network error");
        App.toast(L("Не удалось удалить: ", "Failed to delete: ") + reason);
        App.haptic("error");
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
      reportCard: viewEl.querySelector("#accReportCard"),
      cycleCard: viewEl.querySelector("#accCycleCard"),
      progressCard: viewEl.querySelector("#accProgressCard"),
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
    renderReport();
    renderCycle();
    renderProgress();
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
     * Вызывается при уходе со страницы — освобождаем object URL'ы фото и кэш ссылок.
     */
    onHide: function () {
      // Освобождаем blob-URL'ы приватных фото, чтобы не текла память.
      revokeProgressUrls();
      els = null;
    }
  };

  // Регистрируем страницу и публикуем контроллер для отладки.
  window.PageAccount = controller;
  App.registerPage("account", controller);
})();
