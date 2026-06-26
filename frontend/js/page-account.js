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
 *   - Карточка «Вечерняя сводка»: ТОЛЬКО тумблер daily_summary_enabled и время
 *     summary_time (App.api.getNotificationSettings / saveNotificationSettings).
 *     Остальные напоминания вынесены в свои разделы (Тренировки, Добавки, Рацион).
 *   - Ниже — история за последние 30 дней (App.api.getHistory(30))
 *     в виде простого столбчатого графика (дата + ккал).
 *
 * Предзаполнение формы выполняется через App.api.getProfile.
 * Весь UI и комментарии — на русском, с обработкой ошибок и состояний загрузки.
 */
(function () {
  "use strict";

  // Варианты уровня активности для выпадающего списка.
  // value — коэффициент TDEE, label — понятное описание на русском.
  var ACTIVITY_OPTIONS = [
    { value: 1.2, label: "Минимальная (сидячий образ жизни)" },
    { value: 1.375, label: "Лёгкая (1-3 тренировки в неделю)" },
    { value: 1.55, label: "Средняя (3-5 тренировок в неделю)" },
    { value: 1.725, label: "Высокая (6-7 тренировок в неделю)" },
    { value: 1.9, label: "Очень высокая (тяжёлый физический труд)" }
  ];

  // Варианты цели питания (diet_goal). value — то, что уходит на сервер.
  var DIET_GOAL_OPTIONS = [
    { value: "loss", label: "Похудение" },
    { value: "maintain", label: "Поддержание" },
    { value: "gain", label: "Набор массы" }
  ];

  // Значение времени по умолчанию для вечерней сводки, если сервер не вернул своё.
  var DEFAULT_SUMMARY_TIME = "21:00";

  // Ссылки на корневой элемент представления и элементы формы.
  // Хранятся в замыкании контроллера, чтобы переиспользовать между методами.
  var els = null;

  /**
   * Возвращает HTML-разметку всей страницы аккаунта.
   */
  function template() {
    // Имя пользователя для шапки (берём из Telegram-объекта, если есть).
    var u = App.user || {};
    var displayName =
      (u.first_name ? u.first_name : "") +
      (u.last_name ? " " + u.last_name : "");
    if (!displayName.trim()) {
      displayName = u.username ? "@" + u.username : "Пользователь";
    }

    // Опции уровня активности.
    var activityOptionsHtml = ACTIVITY_OPTIONS.map(function (o) {
      return (
        '<option value="' +
        o.value +
        '">' +
        App.escapeHtml(o.label) +
        "</option>"
      );
    }).join("");

    // Опции цели питания.
    var dietGoalOptionsHtml = DIET_GOAL_OPTIONS.map(function (o) {
      return (
        '<option value="' +
        App.escapeHtml(o.value) +
        '">' +
        App.escapeHtml(o.label) +
        "</option>"
      );
    }).join("");

    // Аватар: либо картинка из Telegram, либо заглушка с эмодзи.
    var avatarHtml = u.photo_url
      ? '<img class="acc-avatar" id="accAvatar" alt="Аватар" src="' +
        App.escapeHtml(u.photo_url) +
        '">'
      : '<div class="acc-avatar acc-avatar--empty" id="accAvatar">👤</div>';

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

      // ---- Форма профиля ----
      '<form class="acc-form card" id="accForm" novalidate>' +
      '<h2 class="acc-title">Мои параметры</h2>' +

      '<div class="acc-grid">' +
      '<label class="field">' +
      '<span class="field__label">Вес, кг</span>' +
      '<input class="field__input" id="accWeight" type="number" inputmode="decimal" min="0" step="0.1" placeholder="70">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">Рост, см</span>' +
      '<input class="field__input" id="accHeight" type="number" inputmode="decimal" min="0" step="0.1" placeholder="175">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">Возраст, лет</span>' +
      '<input class="field__input" id="accAge" type="number" inputmode="numeric" min="0" step="1" placeholder="30">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">Пол</span>' +
      '<select class="field__input" id="accGender">' +
      '<option value="male">Мужской</option>' +
      '<option value="female">Женский</option>' +
      "</select>" +
      "</label>" +
      "</div>" +

      '<label class="field">' +
      '<span class="field__label">Уровень активности</span>' +
      '<select class="field__input" id="accActivity">' +
      activityOptionsHtml +
      "</select>" +
      "</label>" +

      // ---- Цель питания (diet_goal) ----
      '<label class="field goal-field">' +
      '<span class="field__label">Цель питания</span>' +
      '<select class="field__input" id="accDietGoal">' +
      dietGoalOptionsHtml +
      "</select>" +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">Цель по калориям, ккал/день</span>' +
      '<input class="field__input" id="accGoal" type="number" inputmode="numeric" min="0" step="1" placeholder="2000">' +
      "</label>" +

      // ---- Блок целевых БЖУ (скрыт, пока нет данных) ----
      '<div class="goal-macros" id="accGoalMacros" hidden>' +
      '<div class="goal-macros__title">Целевые БЖУ в день</div>' +
      '<div class="goal-macros__grid">' +
      '<div class="goal-macro goal-macro--prot">' +
      '<span class="goal-macro__value" id="accTargetProt">—</span>' +
      '<span class="goal-macro__label">Белки, г</span>' +
      "</div>" +
      '<div class="goal-macro goal-macro--fat">' +
      '<span class="goal-macro__value" id="accTargetFat">—</span>' +
      '<span class="goal-macro__label">Жиры, г</span>' +
      "</div>" +
      '<div class="goal-macro goal-macro--carb">' +
      '<span class="goal-macro__value" id="accTargetCarb">—</span>' +
      '<span class="goal-macro__label">Углеводы, г</span>' +
      "</div>" +
      "</div>" +
      "</div>" +

      '<button type="button" class="btn btn--ghost" id="accCalcBtn">⚙️ Рассчитать автоматически</button>' +
      '<button type="submit" class="btn btn--cta" id="accSaveBtn">Сохранить</button>' +

      '<p class="acc-hint">Автоматический расчёт учитывает ваши параметры, уровень активности и цель питания.</p>' +
      "</form>" +

      // ---- Карточка «Вечерняя сводка» ----
      // Здесь остаётся ТОЛЬКО ежедневная вечерняя сводка. Напоминания о приёмах
      // пищи, тренировках и добавках перенесены в соответствующие разделы.
      '<section class="acc-summary card" id="accSummary">' +
      '<h2 class="acc-title">Вечерняя сводка</h2>' +
      '<p class="acc-summary-hint">Раз в день пришлём короткий итог: сколько калорий и БЖУ набрано за день.</p>' +
      '<div class="acc-summary-body" id="accSummaryBody">' +
      '<div class="skeleton skeleton--block"></div>' +
      "</div>" +
      "</section>" +

      // ---- История за 30 дней ----
      '<section class="acc-history card">' +
      '<h2 class="acc-title">История за 30 дней</h2>' +
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
      App.toast("Заполните вес, рост и возраст для расчёта");
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
          throw new Error("Пустой ответ сервера");
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
          "Норма рассчитана: " +
            App.fmt(res.daily_goal_kcal) +
            " ккал"
        );
      })
      .catch(function (err) {
        App.haptic("error");
        App.toast(
          "Не удалось рассчитать: " +
            (err && err.message ? err.message : "ошибка")
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
        App.toast("Профиль сохранён");
      })
      .catch(function (err) {
        App.haptic("error");
        App.toast("Не удалось сохранить: " + (err && err.message ? err.message : "ошибка"));
      })
      .finally(function () {
        els.saveBtn.disabled = false;
        App.hideLoading();
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
          '<p>Не удалось загрузить настройки сводки.</p>' +
          '<p class="acc-summary-error__msg">' +
          App.escapeHtml(err && err.message ? err.message : "Ошибка сети") +
          "</p>" +
          '<button type="button" class="btn btn--ghost" id="accSummaryRetry">Повторить</button>' +
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
      '<span class="acc-summary-toggle__label">Присылать вечернюю сводку</span>' +
      "</label>" +
      "</div>" +
      '<label class="field acc-summary-time" id="accSummaryTimeField"' +
      (enabled ? "" : " hidden") +
      ">" +
      '<span class="field__label">Время сводки</span>' +
      '<input class="field__input acc-summary-time__input" type="time" id="accSummaryTime" value="' +
      App.escapeHtml(time) +
      '" placeholder="21:00">' +
      "</label>" +
      '<button type="button" class="btn btn--cta acc-summary-save" id="accSummarySave">Сохранить</button>';

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
        App.toast("Настройки сводки сохранены");
      })
      .catch(function (err) {
        App.haptic("error");
        App.toast(
          "Не удалось сохранить: " +
            (err && err.message ? err.message : "ошибка")
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
          '<p>Не удалось загрузить историю.</p>' +
          '<p class="acc-error__msg">' +
          App.escapeHtml(err && err.message ? err.message : "Ошибка сети") +
          "</p>" +
          '<button type="button" class="btn btn--ghost" id="accHistRetry">Повторить</button>' +
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
        '<div class="acc-empty">Пока нет данных. Добавьте приёмы пищи в раздел «Мой рацион».</div>';
      return;
    }

    // Максимум для масштабирования столбцов: учитываем цель и фактические значения.
    var maxVal = 0;
    days.forEach(function (d) {
      if (d.total_calories > maxVal) maxVal = d.total_calories;
    });
    if (goal != null && goal > maxVal) maxVal = goal;
    if (maxVal <= 0) maxVal = 1; // защита от деления на ноль

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
          " ккал</span>" +
          "</div>"
        );
      })
      .join("");

    var goalLine =
      goal != null
        ? '<div class="hist-goal">Цель: ' + App.fmt(goal) + " ккал/день</div>"
        : '<div class="hist-goal hist-goal--muted">Цель не задана</div>';

    box.innerHTML = goalLine + '<div class="hist-list">' + rows + "</div>";
  }

  /**
   * Преобразует ISO-дату "YYYY-MM-DD" в короткий русский формат "ДД.ММ".
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
   * Находит и кэширует ссылки на элементы формы внутри представления.
   */
  function bindElements(viewEl) {
    els = {
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
      els.calcBtn.addEventListener("click", onCalc);
      els.form.addEventListener("submit", onSave);

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
          App.toast(
            "Не удалось загрузить профиль: " +
              (err && err.message ? err.message : "ошибка")
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
