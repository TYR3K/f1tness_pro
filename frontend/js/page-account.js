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

  // Варианты уровня активности для выпадающего списка.
  // value — коэффициент TDEE, label() — локализованное описание (RU/EN),
  // вычисляется на момент рендера через App.pick.
  var ACTIVITY_OPTIONS = [
    {
      value: 1.2,
      label: function () {
        return App.pick(
          "Минимальная (сидячий образ жизни)",
          "Minimal (sedentary lifestyle)"
        );
      }
    },
    {
      value: 1.375,
      label: function () {
        return App.pick(
          "Лёгкая (1-3 тренировки в неделю)",
          "Light (1-3 workouts per week)"
        );
      }
    },
    {
      value: 1.55,
      label: function () {
        return App.pick(
          "Средняя (3-5 тренировок в неделю)",
          "Moderate (3-5 workouts per week)"
        );
      }
    },
    {
      value: 1.725,
      label: function () {
        return App.pick(
          "Высокая (6-7 тренировок в неделю)",
          "High (6-7 workouts per week)"
        );
      }
    },
    {
      value: 1.9,
      label: function () {
        return App.pick(
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
        return App.pick("Похудение", "Weight loss");
      }
    },
    {
      value: "maintain",
      label: function () {
        return App.pick("Поддержание", "Maintenance");
      }
    },
    {
      value: "gain",
      label: function () {
        return App.pick("Набор массы", "Muscle gain");
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
        text: App.pick("Вечная подписка", "Lifetime subscription"),
        premium: true
      };
    }

    if (premium) {
      var until = formatSubDate(sub.subscription_until);
      if (until) {
        return {
          text: App.pick(
            "Премиум активен до " + until,
            "Premium active until " + until
          ),
          premium: true
        };
      }
      return {
        text: App.pick("Премиум активен", "Premium active"),
        premium: true
      };
    }

    return {
      text: App.pick("Бесплатный доступ", "Free access"),
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
        : App.pick("Пользователь", "User");
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
        App.escapeHtml(App.pick("Аватар", "Avatar")) +
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
      App.escapeHtml(App.pick("Подписка", "Subscription")) +
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
      App.escapeHtml(App.pick("Язык", "Language")) +
      "</h2>" +
      '<div class="acc-lang__switch" role="group" aria-label="' +
      App.escapeHtml(App.pick("Выбор языка", "Language selection")) +
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
      App.escapeHtml(App.pick("Мои параметры", "My parameters")) +
      "</h2>" +

      '<div class="acc-grid">' +
      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(App.pick("Вес, кг", "Weight, kg")) +
      "</span>" +
      '<input class="field__input" id="accWeight" type="number" inputmode="decimal" min="0" step="0.1" placeholder="70">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(App.pick("Рост, см", "Height, cm")) +
      "</span>" +
      '<input class="field__input" id="accHeight" type="number" inputmode="decimal" min="0" step="0.1" placeholder="175">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(App.pick("Возраст, лет", "Age, years")) +
      "</span>" +
      '<input class="field__input" id="accAge" type="number" inputmode="numeric" min="0" step="1" placeholder="30">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(App.pick("Пол", "Gender")) +
      "</span>" +
      '<select class="field__input" id="accGender">' +
      '<option value="male">' +
      App.escapeHtml(App.pick("Мужской", "Male")) +
      "</option>" +
      '<option value="female">' +
      App.escapeHtml(App.pick("Женский", "Female")) +
      "</option>" +
      "</select>" +
      "</label>" +
      "</div>" +

      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(App.pick("Уровень активности", "Activity level")) +
      "</span>" +
      '<select class="field__input" id="accActivity">' +
      activityOptionsHtml +
      "</select>" +
      "</label>" +

      // ---- Цель питания (diet_goal) ----
      '<label class="field goal-field">' +
      '<span class="field__label">' +
      App.escapeHtml(App.pick("Цель питания", "Nutrition goal")) +
      "</span>" +
      '<select class="field__input" id="accDietGoal">' +
      dietGoalOptionsHtml +
      "</select>" +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">' +
      App.escapeHtml(
        App.pick("Цель по калориям, ккал/день", "Calorie goal, kcal/day")
      ) +
      "</span>" +
      '<input class="field__input" id="accGoal" type="number" inputmode="numeric" min="0" step="1" placeholder="2000">' +
      "</label>" +

      // ---- Блок целевых БЖУ (скрыт, пока нет данных) ----
      '<div class="goal-macros" id="accGoalMacros" hidden>' +
      '<div class="goal-macros__title">' +
      App.escapeHtml(App.pick("Целевые БЖУ в день", "Daily target P/F/C")) +
      "</div>" +
      '<div class="goal-macros__grid">' +
      '<div class="goal-macro goal-macro--prot">' +
      '<span class="goal-macro__value" id="accTargetProt">—</span>' +
      '<span class="goal-macro__label">' +
      App.escapeHtml(App.pick("Белки, г", "Protein, g")) +
      "</span>" +
      "</div>" +
      '<div class="goal-macro goal-macro--fat">' +
      '<span class="goal-macro__value" id="accTargetFat">—</span>' +
      '<span class="goal-macro__label">' +
      App.escapeHtml(App.pick("Жиры, г", "Fat, g")) +
      "</span>" +
      "</div>" +
      '<div class="goal-macro goal-macro--carb">' +
      '<span class="goal-macro__value" id="accTargetCarb">—</span>' +
      '<span class="goal-macro__label">' +
      App.escapeHtml(App.pick("Углеводы, г", "Carbs, g")) +
      "</span>" +
      "</div>" +
      "</div>" +
      "</div>" +

      '<button type="button" class="btn btn--ghost" id="accCalcBtn">⚙️ ' +
      App.escapeHtml(
        App.pick("Рассчитать автоматически", "Calculate automatically")
      ) +
      "</button>" +
      '<button type="submit" class="btn btn--cta" id="accSaveBtn">' +
      App.escapeHtml(App.pick("Сохранить", "Save")) +
      "</button>" +

      '<p class="acc-hint">' +
      App.escapeHtml(
        App.pick(
          "Автоматический расчёт учитывает ваши параметры, уровень активности и цель питания.",
          "Automatic calculation takes into account your parameters, activity level and nutrition goal."
        )
      ) +
      "</p>" +
      "</form>" +

      // ---- Карточка «Вечерняя сводка» ----
      // Здесь остаётся ТОЛЬКО ежедневная вечерняя сводка. Напоминания о приёмах
      // пищи, тренировках и добавках перенесены в соответствующие разделы.
      '<section class="acc-summary card" id="accSummary">' +
      '<h2 class="acc-title">' +
      App.escapeHtml(App.pick("Вечерняя сводка", "Evening summary")) +
      "</h2>" +
      '<p class="acc-summary-hint">' +
      App.escapeHtml(
        App.pick(
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
      App.escapeHtml(App.pick("История за 30 дней", "Last 30 days")) +
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
        App.pick(
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
          throw new Error(App.pick("Пустой ответ сервера", "Empty server response"));
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
          App.pick(
            "Норма рассчитана: " + App.fmt(res.daily_goal_kcal) + " ккал",
            "Goal calculated: " + App.fmt(res.daily_goal_kcal) + " kcal"
          )
        );
      })
      .catch(function (err) {
        App.haptic("error");
        var reason = err && err.message ? err.message : App.pick("ошибка", "error");
        App.toast(
          App.pick(
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
        App.toast(App.pick("Профиль сохранён", "Profile saved"));
      })
      .catch(function (err) {
        App.haptic("error");
        var reason = err && err.message ? err.message : App.pick("ошибка", "error");
        App.toast(
          App.pick("Не удалось сохранить: " + reason, "Failed to save: " + reason)
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
            App.pick(
              "Не удалось загрузить настройки сводки.",
              "Failed to load summary settings."
            )
          ) +
          "</p>" +
          '<p class="acc-summary-error__msg">' +
          App.escapeHtml(
            err && err.message
              ? err.message
              : App.pick("Ошибка сети", "Network error")
          ) +
          "</p>" +
          '<button type="button" class="btn btn--ghost" id="accSummaryRetry">' +
          App.escapeHtml(App.pick("Повторить", "Retry")) +
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
        App.pick("Присылать вечернюю сводку", "Send evening summary")
      ) +
      "</span>" +
      "</label>" +
      "</div>" +
      '<label class="field acc-summary-time" id="accSummaryTimeField"' +
      (enabled ? "" : " hidden") +
      ">" +
      '<span class="field__label">' +
      App.escapeHtml(App.pick("Время сводки", "Summary time")) +
      "</span>" +
      '<input class="field__input acc-summary-time__input" type="time" id="accSummaryTime" value="' +
      App.escapeHtml(time) +
      '" placeholder="21:00">' +
      "</label>" +
      '<button type="button" class="btn btn--cta acc-summary-save" id="accSummarySave">' +
      App.escapeHtml(App.pick("Сохранить", "Save")) +
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
          App.pick("Настройки сводки сохранены", "Summary settings saved")
        );
      })
      .catch(function (err) {
        App.haptic("error");
        var reason = err && err.message ? err.message : App.pick("ошибка", "error");
        App.toast(
          App.pick("Не удалось сохранить: " + reason, "Failed to save: " + reason)
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
            App.pick("Не удалось загрузить историю.", "Failed to load history.")
          ) +
          "</p>" +
          '<p class="acc-error__msg">' +
          App.escapeHtml(
            err && err.message
              ? err.message
              : App.pick("Ошибка сети", "Network error")
          ) +
          "</p>" +
          '<button type="button" class="btn btn--ghost" id="accHistRetry">' +
          App.escapeHtml(App.pick("Повторить", "Retry")) +
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
          App.pick(
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

    var kcalUnit = App.pick("ккал", "kcal");

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
          App.escapeHtml(App.pick("Цель: ", "Goal: ")) +
          App.fmt(goal) +
          " " +
          App.escapeHtml(App.pick("ккал/день", "kcal/day")) +
          "</div>"
        : '<div class="hist-goal hist-goal--muted">' +
          App.escapeHtml(App.pick("Цель не задана", "Goal not set")) +
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
      summaryBody: viewEl.querySelector("#accSummaryBody"),
      history: viewEl.querySelector("#accHistory")
    };
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
      if (App.refreshSubscription) {
        App.refreshSubscription()
          .then(refreshSubCard)
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
        })
        .catch(function (err) {
          // Профиль не критичен — форму можно заполнить вручную.
          var reason =
            err && err.message ? err.message : App.pick("ошибка", "error");
          App.toast(
            App.pick(
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
