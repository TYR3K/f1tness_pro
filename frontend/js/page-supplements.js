/*
 * page-supplements.js — страница «Добавки» (💊).
 *
 * Регистрирует контроллер страницы через App.registerPage("supplements", {...}).
 * Публичная ссылка — window.PageSupplements.
 *
 * Раздел состоит из трёх частей:
 *
 *   1. МОИ ДОБАВКИ
 *      - Список добавок (App.api.getSupplements) с удалением
 *        (App.api.deleteSupplement).
 *      - Форма добавления: название, тип, дозировка, время приёма (HH:MM),
 *        чекбокс «напоминать» -> App.api.addSupplement.
 *
 *   2. НАПОМИНАНИЯ О ПРИЁМЕ
 *      - Список напоминаний (App.api.getSupplementReminders) с удалением
 *        (App.api.deleteSupplementReminder). Показывается состав каждого
 *        («Ночь, 22:00 — магний, ZMA»).
 *      - Форма создания: метка/название (Утро/Ночь/своё) + время (input time) +
 *        множественный выбор добавок (чекбоксы по App.api.getSupplements) +
 *        вкл/выкл -> App.api.addSupplementReminder({label,time,enabled,supplement_ids}).
 *
 *   3. AI-СОВЕТЫ ПО ДОБАВКАМ
 *      - Пресеты цели улучшения чипами (Сон / Восстановление / Сила / Энергия /
 *        Иммунитет) + поле свободного ввода.
 *      - Кнопка «Получить совет» -> App.api.recommendSupplements({improvement_goal})
 *        -> карточки {name,dosage,note} + обязательный дисклеймер из ответа.
 *      - Предзаполнение improvement_goal из profile.supplement_goal.
 *
 * Весь пользовательский текст — на русском. Полная обработка ошибок (сеть/AI),
 * состояния загрузки (скелетоны), пустые состояния.
 */
(function () {
  "use strict";

  // Пресеты цели улучшения (чипы AI-советов): эмодзи + значение для сервера.
  var IMPROVEMENT_PRESETS = [
    { value: "Сон", emoji: "😴", label: "Сон" },
    { value: "Восстановление", emoji: "🔄", label: "Восстановление" },
    { value: "Сила", emoji: "💪", label: "Сила" },
    { value: "Энергия", emoji: "⚡", label: "Энергия" },
    { value: "Иммунитет", emoji: "🛡️", label: "Иммунитет" }
  ];

  // Внутреннее состояние контроллера.
  var state = {
    viewEl: null,           // корневой элемент страницы (#view)
    supLoading: false,      // флаг загрузки списка добавок (защита от гонок)
    remLoading: false,      // флаг загрузки списка напоминаний
    supplements: [],        // последний загруженный список добавок (для чекбоксов)
    improvementGoal: ""     // выбранная/введённая цель улучшения для AI-советов
  };

  /* =====================================================================
   *  УТИЛИТЫ
   * ===================================================================== */

  function esc(s) {
    return App.escapeHtml(s == null ? "" : String(s));
  }

  function haptic(kind) {
    if (App && typeof App.haptic === "function") App.haptic(kind);
  }

  function toast(msg) {
    if (App && typeof App.toast === "function") App.toast(msg);
  }

  /**
   * Хелпер: поиск элемента по id внутри текущего представления.
   */
  function byId(id) {
    if (!state.viewEl) return null;
    return state.viewEl.querySelector("#" + id);
  }

  /**
   * Приводит значение времени к строке "HH:MM" для поля ввода/отображения.
   * Сервер может вернуть "HH:MM:SS" — оставляем первые 5 символов.
   */
  function timeValue(v) {
    if (v == null) return "";
    var s = String(v).trim();
    if (s.length >= 5) return s.slice(0, 5);
    return s;
  }

  /* =====================================================================
   *  РАЗМЕТКА: СКЕЛЕТОНЫ
   * ===================================================================== */

  /**
   * Скелетон списка добавок.
   */
  function supplementsSkeletonHtml() {
    var rows = "";
    for (var i = 0; i < 2; i++) {
      rows +=
        '<div class="sup-item skeleton-block">' +
        '<div class="skeleton skeleton-line skeleton-title"></div>' +
        '<div class="skeleton skeleton-line short"></div>' +
        "</div>";
    }
    return '<div class="sup-skeleton">' + rows + "</div>";
  }

  /**
   * Скелетон списка напоминаний.
   */
  function remindersSkeletonHtml() {
    var rows = "";
    for (var i = 0; i < 2; i++) {
      rows +=
        '<div class="sup-rem-item skeleton-block">' +
        '<div class="skeleton skeleton-line skeleton-title"></div>' +
        '<div class="skeleton skeleton-line short"></div>' +
        "</div>";
    }
    return '<div class="sup-rem-skeleton">' + rows + "</div>";
  }

  /* =====================================================================
   *  РАЗМЕТКА: СТАТИЧЕСКИЙ КАРКАС СТРАНИЦЫ
   * ===================================================================== */

  /**
   * Форма добавления добавки.
   */
  function supplementFormHtml() {
    return (
      '<form class="sup-form" id="supForm" novalidate>' +
      '<h3 class="sup-form__title">Добавить добавку</h3>' +

      '<label class="field">' +
      '<span class="field__label">Название</span>' +
      '<input class="field__input" id="supName" type="text" ' +
      'placeholder="Креатин" maxlength="100" autocomplete="off">' +
      "</label>" +

      '<div class="sup-form__grid">' +
      '<label class="field">' +
      '<span class="field__label">Тип</span>' +
      '<input class="field__input" id="supType" type="text" ' +
      'placeholder="Аминокислоты" maxlength="60" autocomplete="off">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">Дозировка</span>' +
      '<input class="field__input" id="supDosage" type="text" ' +
      'placeholder="5 г" maxlength="60" autocomplete="off">' +
      "</label>" +
      "</div>" +

      '<label class="field">' +
      '<span class="field__label">Время приёма</span>' +
      '<input class="field__input" id="supTime" type="time">' +
      "</label>" +

      '<label class="sup-form__check">' +
      '<input type="checkbox" id="supReminder" class="sup-form__checkbox">' +
      '<span class="sup-form__check-label">Напоминать о приёме</span>' +
      "</label>" +

      '<button type="submit" class="btn btn-cta btn-block sup-add" id="supAddBtn">' +
      "Добавить добавку" +
      "</button>" +
      "</form>"
    );
  }

  /**
   * Карточка раздела «Мои добавки» (список + форма).
   */
  function supplementCardHtml() {
    return (
      '<section class="card sup-card">' +
      '<h2 class="sup-card__title">Мои добавки</h2>' +
      '<p class="sup-card__subtitle">Ваши добавки и приёмы спортивного питания.</p>' +

      // Контейнер списка добавок (наполняется отдельно).
      '<div id="supList" class="sup-list"></div>' +

      // Форма добавления.
      supplementFormHtml() +
      "</section>"
    );
  }

  /**
   * Форма создания напоминания о приёме добавок.
   */
  function reminderFormHtml() {
    return (
      '<form class="sup-rem-form" id="supRemForm" novalidate>' +
      '<h3 class="sup-rem-form__title">Новое напоминание</h3>' +

      '<div class="sup-rem-form__grid">' +
      '<label class="field">' +
      '<span class="field__label">Название</span>' +
      '<input class="field__input" id="remLabel" type="text" ' +
      'placeholder="Утро / Ночь" maxlength="60" autocomplete="off" list="remLabelList">' +
      '<datalist id="remLabelList">' +
      '<option value="Утро"></option>' +
      '<option value="День"></option>' +
      '<option value="Вечер"></option>' +
      '<option value="Ночь"></option>' +
      "</datalist>" +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">Время</span>' +
      '<input class="field__input" id="remTime" type="time">' +
      "</label>" +
      "</div>" +

      // Множественный выбор добавок (наполняется по списку принимаемых).
      '<div class="sup-rem-form__pick">' +
      '<span class="field__label">Какие добавки напомнить</span>' +
      '<div id="remPicks" class="sup-rem-picks"></div>' +
      "</div>" +

      '<label class="sup-rem-form__check">' +
      '<input type="checkbox" id="remEnabled" class="sup-rem-form__checkbox" checked>' +
      '<span class="sup-rem-form__check-label">Напоминание включено</span>' +
      "</label>" +

      '<button type="submit" class="btn btn-cta btn-block sup-rem-add" id="remAddBtn">' +
      "Создать напоминание" +
      "</button>" +
      "</form>"
    );
  }

  /**
   * Карточка раздела «Напоминания о приёме» (список + форма).
   */
  function reminderCardHtml() {
    return (
      '<section class="card sup-rem-card">' +
      '<h2 class="sup-rem-card__title">Напоминания о приёме</h2>' +
      '<p class="sup-rem-card__subtitle">Telegram напомнит вовремя принять добавки.</p>' +

      // Контейнер списка напоминаний (наполняется отдельно).
      '<div id="remList" class="sup-rem-list"></div>' +

      // Форма создания.
      reminderFormHtml() +
      "</section>"
    );
  }

  /**
   * Чипы пресетов цели улучшения для AI-советов.
   */
  function presetChipsHtml() {
    return IMPROVEMENT_PRESETS.map(function (p) {
      return (
        '<button type="button" class="chip sup-ai-chip" ' +
        'data-goal="' + esc(p.value) + '">' +
        '<span class="sup-ai-chip__emoji" aria-hidden="true">' + p.emoji + "</span>" +
        '<span class="sup-ai-chip__label">' + esc(p.label) + "</span>" +
        "</button>"
      );
    }).join("");
  }

  /**
   * Карточка раздела «AI-советы по добавкам».
   */
  function aiCardHtml() {
    return (
      '<section class="card sup-ai-card">' +
      '<h2 class="sup-ai-card__title">AI-советы по добавкам</h2>' +
      '<p class="sup-ai-card__subtitle">Выберите, что хотите улучшить, ' +
      "или опишите цель своими словами.</p>" +

      '<div class="sup-ai-chips" id="supAiChips">' +
      presetChipsHtml() +
      "</div>" +

      '<label class="field sup-ai-field">' +
      '<span class="field__label">Цель улучшения</span>' +
      '<input class="field__input" id="supAiGoal" type="text" ' +
      'placeholder="Например: меньше усталости" maxlength="80" autocomplete="off">' +
      "</label>" +

      '<button type="button" class="btn btn-cta btn-block sup-ai-btn" id="supAiBtn">' +
      "🤖 Получить совет" +
      "</button>" +

      '<div id="supAiBox" class="sup-ai-box"></div>' +
      "</section>"
    );
  }

  /**
   * Полный каркас страницы. Динамические части (списки) наполняются
   * отдельными функциями после монтирования.
   */
  function pageTemplate() {
    return (
      '<section class="page page-supplements">' +
      '<h1 class="page__title">Добавки</h1>' +

      // Раздел «Мои добавки».
      supplementCardHtml() +

      // Раздел «Напоминания о приёме».
      reminderCardHtml() +

      // Раздел «AI-советы по добавкам».
      aiCardHtml() +
      "</section>"
    );
  }

  /* =====================================================================
   *  РАЗМЕТКА: ДИНАМИЧЕСКИЕ ЧАСТИ — МОИ ДОБАВКИ
   * ===================================================================== */

  /**
   * Разметка одной строки добавки.
   */
  function supplementRowHtml(s) {
    // Собираем строку с деталями (тип / дозировка / время), пропуская пустые.
    var parts = [];
    if (s.type) parts.push(esc(s.type));
    if (s.dosage) parts.push(esc(s.dosage));
    if (s.intake_time) parts.push(esc(timeValue(s.intake_time)));
    var meta = parts.join(" · ");

    var reminder = s.reminder_enabled
      ? '<span class="sup-item__badge">🔔 напоминание</span>'
      : "";

    return (
      '<li class="sup-item" data-id="' + esc(s.id) + '">' +
      '<div class="sup-item__main">' +
      '<span class="sup-item__name">' + esc(s.name || "Без названия") + "</span>" +
      (meta ? '<span class="sup-item__meta">' + meta + "</span>" : "") +
      reminder +
      "</div>" +
      '<button class="sup-item__del" type="button" data-id="' + esc(s.id) + '" ' +
      'aria-label="Удалить добавку" title="Удалить">✕</button>' +
      "</li>"
    );
  }

  /**
   * Отрисовка списка добавок.
   * @param {Object} data { items:[...] }
   */
  function renderSupplements(data) {
    var box = byId("supList");
    var items = (data && data.items) || [];

    // Запоминаем список — он нужен для чекбоксов в форме напоминаний.
    state.supplements = items;

    // Список добавок мог измениться — перерисуем чекбоксы напоминаний.
    renderReminderPicks();

    if (!box) return;

    if (!items.length) {
      box.innerHTML =
        '<div class="sup-empty">' +
        '<div class="sup-empty__icon" aria-hidden="true">💊</div>' +
        '<p class="sup-empty__text">Добавки пока не добавлены.</p>' +
        "</div>";
      return;
    }

    var rows = "";
    for (var i = 0; i < items.length; i++) {
      rows += supplementRowHtml(items[i]);
    }
    box.innerHTML = '<ul class="sup-item-list">' + rows + "</ul>";

    var delButtons = box.querySelectorAll(".sup-item__del");
    for (var k = 0; k < delButtons.length; k++) {
      delButtons[k].addEventListener("click", onSupplementDelete);
    }
  }

  /**
   * Состояние ошибки загрузки добавок с кнопкой «Повторить».
   */
  function renderSupplementsError(message) {
    var box = byId("supList");
    if (!box) return;
    box.innerHTML =
      '<div class="sup-error">' +
      '<div class="sup-error__icon" aria-hidden="true">⚠️</div>' +
      '<p class="sup-error__title">Не удалось загрузить добавки</p>' +
      '<p class="sup-error__text">' + esc(message || "Неизвестная ошибка") + "</p>" +
      '<button class="btn btn-ghost sup-error__retry" type="button">Повторить</button>' +
      "</div>";
    var retry = box.querySelector(".sup-error__retry");
    if (retry) {
      retry.addEventListener("click", function () {
        loadSupplements();
      });
    }
  }

  /* =====================================================================
   *  РАЗМЕТКА: ДИНАМИЧЕСКИЕ ЧАСТИ — НАПОМИНАНИЯ
   * ===================================================================== */

  /**
   * Отрисовывает чекбоксы выбора добавок в форме напоминания
   * на основе текущего списка принимаемых добавок (state.supplements).
   */
  function renderReminderPicks() {
    var box = byId("remPicks");
    if (!box) return;

    var items = state.supplements || [];
    if (!items.length) {
      box.innerHTML =
        '<p class="sup-rem-picks__empty">Сначала добавьте добавки выше — ' +
        "тогда их можно будет выбрать для напоминания.</p>";
      return;
    }

    var html = items
      .map(function (s) {
        var label = s.name || "Без названия";
        return (
          '<label class="sup-rem-pick">' +
          '<input type="checkbox" class="sup-rem-pick__input" ' +
          'value="' + esc(s.id) + '">' +
          '<span class="sup-rem-pick__label">' + esc(label) + "</span>" +
          "</label>"
        );
      })
      .join("");

    box.innerHTML = html;
  }

  /**
   * Разметка одной строки напоминания.
   * Показывает состав («Ночь, 22:00 — магний, ZMA»).
   */
  function reminderRowHtml(r) {
    var label = r.label || "Напоминание";
    var time = timeValue(r.time);
    var sups = (r.supplements || [])
      .map(function (s) {
        return esc(s.name || "");
      })
      .filter(function (n) {
        return n !== "";
      });

    // Заголовок: «Ночь, 22:00».
    var headParts = [esc(label)];
    if (time) headParts.push(esc(time));
    var head = headParts.join(", ");

    // Состав через тире: «— магний, ZMA».
    var composition = sups.length
      ? '<span class="sup-rem-item__sups"> — ' + sups.join(", ") + "</span>"
      : '<span class="sup-rem-item__sups sup-rem-item__sups--empty"> — добавки не выбраны</span>';

    var stateBadge = r.enabled
      ? '<span class="sup-rem-item__badge sup-rem-item__badge--on">🔔 вкл</span>'
      : '<span class="sup-rem-item__badge sup-rem-item__badge--off">выкл</span>';

    return (
      '<li class="sup-rem-item" data-id="' + esc(r.id) + '">' +
      '<div class="sup-rem-item__main">' +
      '<span class="sup-rem-item__head">' + head + composition + "</span>" +
      stateBadge +
      "</div>" +
      '<button class="sup-rem-item__del" type="button" data-id="' + esc(r.id) + '" ' +
      'aria-label="Удалить напоминание" title="Удалить">✕</button>' +
      "</li>"
    );
  }

  /**
   * Отрисовка списка напоминаний.
   * @param {Object} data { items:[...] }
   */
  function renderReminders(data) {
    var box = byId("remList");
    if (!box) return;

    var items = (data && data.items) || [];

    if (!items.length) {
      box.innerHTML =
        '<div class="sup-rem-empty">' +
        '<div class="sup-rem-empty__icon" aria-hidden="true">🔔</div>' +
        '<p class="sup-rem-empty__text">Напоминаний пока нет. ' +
        "Создайте первое с помощью формы ниже.</p>" +
        "</div>";
      return;
    }

    var rows = "";
    for (var i = 0; i < items.length; i++) {
      rows += reminderRowHtml(items[i]);
    }
    box.innerHTML = '<ul class="sup-rem-item-list">' + rows + "</ul>";

    var delButtons = box.querySelectorAll(".sup-rem-item__del");
    for (var k = 0; k < delButtons.length; k++) {
      delButtons[k].addEventListener("click", onReminderDelete);
    }
  }

  /**
   * Состояние ошибки загрузки напоминаний с кнопкой «Повторить».
   */
  function renderRemindersError(message) {
    var box = byId("remList");
    if (!box) return;
    box.innerHTML =
      '<div class="sup-rem-error">' +
      '<div class="sup-rem-error__icon" aria-hidden="true">⚠️</div>' +
      '<p class="sup-rem-error__title">Не удалось загрузить напоминания</p>' +
      '<p class="sup-rem-error__text">' + esc(message || "Неизвестная ошибка") + "</p>" +
      '<button class="btn btn-ghost sup-rem-error__retry" type="button">Повторить</button>' +
      "</div>";
    var retry = box.querySelector(".sup-rem-error__retry");
    if (retry) {
      retry.addEventListener("click", function () {
        loadReminders();
      });
    }
  }

  /* =====================================================================
   *  РАЗМЕТКА: ДИНАМИЧЕСКИЕ ЧАСТИ — AI-СОВЕТЫ
   * ===================================================================== */

  /**
   * Отрисовка результата AI-совета.
   * @param {Object} res { suggestions:[{name,dosage,note}], disclaimer,
   *                        training_count, improvement_goal }
   */
  function renderAi(res) {
    var box = byId("supAiBox");
    if (!box) return;

    var suggestions = (res && res.suggestions) || [];
    var disclaimer = res && res.disclaimer ? res.disclaimer : "";
    var goal = res && res.improvement_goal ? res.improvement_goal : "";

    if (!suggestions.length) {
      // Даже при пустых рекомендациях показываем дисклеймер, если он пришёл.
      var emptyDisclaimer = disclaimer
        ? '<p class="sup-ai-disclaimer">⚠️ ' + esc(disclaimer) + "</p>"
        : "";
      box.innerHTML =
        '<div class="sup-ai-box__inner">' +
        '<div class="sup-ai-box__empty">' +
        "Подходящих рекомендаций не нашлось. Попробуйте уточнить цель." +
        "</div>" +
        emptyDisclaimer +
        "</div>";
      return;
    }

    var cards = suggestions
      .map(function (s) {
        var note = s.note
          ? '<p class="sup-ai-suggest__note">' + esc(s.note) + "</p>"
          : "";
        var dosage = s.dosage
          ? '<span class="sup-ai-suggest__dosage">' + esc(s.dosage) + "</span>"
          : "";
        return (
          '<div class="sup-ai-suggest">' +
          '<div class="sup-ai-suggest__head">' +
          '<span class="sup-ai-suggest__name">' + esc(s.name || "Добавка") + "</span>" +
          dosage +
          "</div>" +
          note +
          '<button type="button" class="btn btn-ghost sup-ai-suggest__use" ' +
          'data-name="' + esc(s.name || "") + '" ' +
          'data-dosage="' + esc(s.dosage || "") + '">Заполнить форму</button>' +
          "</div>"
        );
      })
      .join("");

    // Дисклеймер ОБЯЗАТЕЛЕН — показываем всегда, когда он пришёл с сервера.
    var disclaimerHtml = disclaimer
      ? '<p class="sup-ai-disclaimer">⚠️ ' + esc(disclaimer) + "</p>"
      : "";

    var goalHtml = goal
      ? '<p class="sup-ai-box__goal">Цель: ' + esc(goal) + "</p>"
      : "";

    box.innerHTML =
      '<div class="sup-ai-box__inner">' +
      '<p class="sup-ai-box__heading">Рекомендации</p>' +
      goalHtml +
      '<div class="sup-ai-suggest-list">' + cards + "</div>" +
      disclaimerHtml +
      "</div>";

    // Кнопки «Заполнить форму» переносят данные совета в форму добавления.
    var useButtons = box.querySelectorAll(".sup-ai-suggest__use");
    for (var i = 0; i < useButtons.length; i++) {
      useButtons[i].addEventListener("click", onAiSuggestionUse);
    }
  }

  /* =====================================================================
   *  ЗАГРУЗКА ДАННЫХ
   * ===================================================================== */

  /**
   * Загрузка списка добавок (со скелетоном и обработкой ошибок).
   */
  function loadSupplements() {
    if (state.supLoading) return;
    state.supLoading = true;

    var box = byId("supList");
    if (box) box.innerHTML = supplementsSkeletonHtml();

    App.api
      .getSupplements()
      .then(function (data) {
        renderSupplements(data);
      })
      .catch(function (err) {
        renderSupplementsError(
          (err && err.message) || "Проблема с сетью. Проверьте соединение."
        );
      })
      .then(function () {
        state.supLoading = false;
      });
  }

  /**
   * Загрузка списка напоминаний (со скелетоном и обработкой ошибок).
   */
  function loadReminders() {
    if (state.remLoading) return;
    state.remLoading = true;

    var box = byId("remList");
    if (box) box.innerHTML = remindersSkeletonHtml();

    App.api
      .getSupplementReminders()
      .then(function (data) {
        renderReminders(data);
      })
      .catch(function (err) {
        renderRemindersError(
          (err && err.message) || "Проблема с сетью. Проверьте соединение."
        );
      })
      .then(function () {
        state.remLoading = false;
      });
  }

  /* =====================================================================
   *  ОБРАБОТЧИКИ: МОИ ДОБАВКИ
   * ===================================================================== */

  /**
   * Отправка формы добавления добавки.
   */
  function onSupplementSubmit(e) {
    if (e) e.preventDefault();

    var nameEl = byId("supName");
    var typeEl = byId("supType");
    var dosageEl = byId("supDosage");
    var timeEl = byId("supTime");
    var reminderEl = byId("supReminder");
    var btn = byId("supAddBtn");
    if (!nameEl) return;

    var name = (nameEl.value || "").trim();
    if (!name) {
      toast("Укажите название добавки");
      haptic("error");
      nameEl.focus();
      return;
    }

    var payload = {
      name: name,
      type: (typeEl && typeEl.value || "").trim(),
      dosage: (dosageEl && dosageEl.value || "").trim(),
      reminder_enabled: !!(reminderEl && reminderEl.checked)
    };

    // Время приёма передаём только если оно задано (HH:MM).
    var time = (timeEl && timeEl.value || "").trim();
    if (time) {
      payload.intake_time = time;
    }

    if (btn) btn.disabled = true;
    App.showLoading();

    App.api
      .addSupplement(payload)
      .then(function () {
        haptic("success");
        toast("Добавка добавлена");
        // Очищаем форму.
        nameEl.value = "";
        if (typeEl) typeEl.value = "";
        if (dosageEl) dosageEl.value = "";
        if (timeEl) timeEl.value = "";
        if (reminderEl) reminderEl.checked = false;
        // Перезагружаем список (он же обновит чекбоксы напоминаний).
        loadSupplements();
      })
      .catch(function (err) {
        haptic("error");
        toast((err && err.message) || "Не удалось добавить добавку");
      })
      .finally(function () {
        if (btn) btn.disabled = false;
        App.hideLoading();
      });
  }

  /**
   * Удаление добавки по кнопке ✕.
   */
  function onSupplementDelete(ev) {
    var btn = ev.currentTarget;
    var id = parseInt(btn.getAttribute("data-id"), 10);
    if (isNaN(id)) return;
    if (btn.disabled) return;

    btn.disabled = true;
    btn.textContent = "…";
    haptic("light");
    App.showLoading();

    App.api
      .deleteSupplement(id)
      .then(function () {
        toast("Добавка удалена");
        loadSupplements();
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "✕";
        haptic("error");
        toast((err && err.message) || "Не удалось удалить добавку");
      })
      .finally(function () {
        App.hideLoading();
      });
  }

  /* =====================================================================
   *  ОБРАБОТЧИКИ: НАПОМИНАНИЯ
   * ===================================================================== */

  /**
   * Отправка формы создания напоминания.
   */
  function onReminderSubmit(e) {
    if (e) e.preventDefault();

    var labelEl = byId("remLabel");
    var timeEl = byId("remTime");
    var enabledEl = byId("remEnabled");
    var picksBox = byId("remPicks");
    var btn = byId("remAddBtn");
    if (!labelEl || !timeEl) return;

    var label = (labelEl.value || "").trim();
    if (!label) {
      toast("Укажите название напоминания");
      haptic("error");
      labelEl.focus();
      return;
    }

    var time = (timeEl.value || "").trim();
    if (!time) {
      toast("Укажите время напоминания");
      haptic("error");
      timeEl.focus();
      return;
    }

    // Собираем id выбранных добавок.
    var supplementIds = [];
    if (picksBox) {
      var checks = picksBox.querySelectorAll(".sup-rem-pick__input:checked");
      for (var i = 0; i < checks.length; i++) {
        var sid = parseInt(checks[i].value, 10);
        if (!isNaN(sid)) supplementIds.push(sid);
      }
    }

    if (!supplementIds.length) {
      toast("Выберите хотя бы одну добавку");
      haptic("error");
      return;
    }

    var payload = {
      label: label,
      time: time,
      enabled: !!(enabledEl && enabledEl.checked),
      supplement_ids: supplementIds
    };

    if (btn) btn.disabled = true;
    App.showLoading();

    App.api
      .addSupplementReminder(payload)
      .then(function () {
        haptic("success");
        toast("Напоминание создано");
        // Сбрасываем форму.
        labelEl.value = "";
        timeEl.value = "";
        if (enabledEl) enabledEl.checked = true;
        if (picksBox) {
          var allChecks = picksBox.querySelectorAll(".sup-rem-pick__input");
          for (var j = 0; j < allChecks.length; j++) {
            allChecks[j].checked = false;
          }
        }
        loadReminders();
      })
      .catch(function (err) {
        haptic("error");
        toast((err && err.message) || "Не удалось создать напоминание");
      })
      .finally(function () {
        if (btn) btn.disabled = false;
        App.hideLoading();
      });
  }

  /**
   * Удаление напоминания по кнопке ✕.
   */
  function onReminderDelete(ev) {
    var btn = ev.currentTarget;
    var id = parseInt(btn.getAttribute("data-id"), 10);
    if (isNaN(id)) return;
    if (btn.disabled) return;

    btn.disabled = true;
    btn.textContent = "…";
    haptic("light");
    App.showLoading();

    App.api
      .deleteSupplementReminder(id)
      .then(function () {
        toast("Напоминание удалено");
        loadReminders();
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "✕";
        haptic("error");
        toast((err && err.message) || "Не удалось удалить напоминание");
      })
      .finally(function () {
        App.hideLoading();
      });
  }

  /* =====================================================================
   *  ОБРАБОТЧИКИ: AI-СОВЕТЫ
   * ===================================================================== */

  /**
   * Подсвечивает активный чип пресета (по совпадению значения с полем ввода).
   */
  function syncChips() {
    var chipsBox = byId("supAiChips");
    var goalEl = byId("supAiGoal");
    if (!chipsBox || !goalEl) return;
    var current = (goalEl.value || "").trim().toLowerCase();
    var chips = chipsBox.querySelectorAll(".sup-ai-chip");
    for (var i = 0; i < chips.length; i++) {
      var val = (chips[i].getAttribute("data-goal") || "").trim().toLowerCase();
      if (val && val === current) {
        chips[i].classList.add("chip--active");
        chips[i].classList.add("sup-ai-chip--active");
      } else {
        chips[i].classList.remove("chip--active");
        chips[i].classList.remove("sup-ai-chip--active");
      }
    }
  }

  /**
   * Клик по чипу пресета — подставляет цель в поле ввода.
   */
  function onChipClick(ev) {
    var chip = ev.currentTarget;
    var goal = chip.getAttribute("data-goal") || "";
    var goalEl = byId("supAiGoal");
    if (goalEl) {
      goalEl.value = goal;
    }
    state.improvementGoal = goal;
    syncChips();
    haptic("selection");
  }

  /**
   * Кнопка «Получить совет» — запрашивает рекомендации у сервера.
   */
  function onAiRequest() {
    var btn = byId("supAiBtn");
    var box = byId("supAiBox");
    var goalEl = byId("supAiGoal");
    if (!box) return;

    var goal = goalEl ? (goalEl.value || "").trim() : "";
    if (!goal) {
      toast("Выберите цель или опишите её своими словами");
      haptic("error");
      if (goalEl) goalEl.focus();
      return;
    }

    state.improvementGoal = goal;

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Подбираем…";
    }
    box.innerHTML =
      '<div class="sup-ai-box__loading">' +
      '<div class="skeleton skeleton-line"></div>' +
      '<div class="skeleton skeleton-line short"></div>' +
      "</div>";

    App.api
      .recommendSupplements({ improvement_goal: goal })
      .then(function (res) {
        renderAi(res);
        haptic("success");
      })
      .catch(function (err) {
        box.innerHTML =
          '<div class="sup-ai-box__error">' +
          '<p class="sup-ai-box__error-text">' +
          esc((err && err.message) || "Не удалось получить совет") +
          "</p>" +
          '<button type="button" class="btn btn-ghost sup-ai-box__retry">Повторить</button>' +
          "</div>";
        var retry = box.querySelector(".sup-ai-box__retry");
        if (retry) retry.addEventListener("click", onAiRequest);
        haptic("error");
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "🤖 Получить совет";
        }
      });
  }

  /**
   * Кнопка «Заполнить форму» в карточке совета — переносит
   * название и дозировку в поля формы добавления.
   */
  function onAiSuggestionUse(ev) {
    var btn = ev.currentTarget;
    var name = btn.getAttribute("data-name") || "";
    var dosage = btn.getAttribute("data-dosage") || "";

    var nameEl = byId("supName");
    var dosageEl = byId("supDosage");
    if (nameEl) nameEl.value = name;
    if (dosageEl) dosageEl.value = dosage;

    haptic("light");
    toast("Поля заполнены — проверьте и сохраните");

    // Подскроллим к форме, чтобы пользователь видел заполненные поля.
    var form = byId("supForm");
    if (form && typeof form.scrollIntoView === "function") {
      try {
        form.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (e) {
        form.scrollIntoView();
      }
    }
  }

  /* =====================================================================
   *  ПРЕДЗАПОЛНЕНИЕ ЦЕЛИ УЛУЧШЕНИЯ
   * ===================================================================== */

  /**
   * Предзаполняет поле цели улучшения сохранённым profile.supplement_goal.
   * Сначала использует кэш профиля, затем подтягивает актуальный профиль.
   */
  function prefillImprovementGoal() {
    var goalEl = byId("supAiGoal");
    if (!goalEl) return;

    // 1) Сразу подставляем из кэша, если он есть.
    var cached = App.state && App.state.profile;
    if (cached && cached.supplement_goal) {
      goalEl.value = cached.supplement_goal;
      state.improvementGoal = cached.supplement_goal;
      syncChips();
    }

    // 2) Подтягиваем актуальный профиль (best-effort, без агрессивных ошибок).
    App.api
      .getProfile()
      .then(function (profile) {
        if (profile) {
          App.state.profile = profile;
          // Заполняем только если пользователь ещё не тронул поле вручную.
          var el = byId("supAiGoal");
          if (el && !(el.value || "").trim() && profile.supplement_goal) {
            el.value = profile.supplement_goal;
            state.improvementGoal = profile.supplement_goal;
            syncChips();
          }
        }
      })
      .catch(function () {
        // Профиль не критичен для этой страницы — молча игнорируем.
      });
  }

  /* =====================================================================
   *  ПРИВЯЗКА ОБРАБОТЧИКОВ
   * ===================================================================== */

  /**
   * Навешивает все обработчики событий после монтирования разметки.
   */
  function bindEvents() {
    // Форма добавки.
    var supForm = byId("supForm");
    if (supForm) supForm.addEventListener("submit", onSupplementSubmit);

    // Форма напоминания.
    var remForm = byId("supRemForm");
    if (remForm) remForm.addEventListener("submit", onReminderSubmit);

    // Чипы AI-целей.
    var chipsBox = byId("supAiChips");
    if (chipsBox) {
      var chips = chipsBox.querySelectorAll(".sup-ai-chip");
      for (var i = 0; i < chips.length; i++) {
        chips[i].addEventListener("click", onChipClick);
      }
    }

    // Поле свободного ввода цели — синхронизируем подсветку чипов.
    var goalEl = byId("supAiGoal");
    if (goalEl) {
      goalEl.addEventListener("input", function () {
        state.improvementGoal = (goalEl.value || "").trim();
        syncChips();
      });
    }

    // Кнопка «Получить совет».
    var aiBtn = byId("supAiBtn");
    if (aiBtn) aiBtn.addEventListener("click", onAiRequest);
  }

  /* =====================================================================
   *  КОНТРОЛЛЕР СТРАНИЦЫ
   * ===================================================================== */

  var controller = {
    /**
     * Вызывается при показе страницы: строит разметку, вешает обработчики,
     * загружает добавки и напоминания, предзаполняет цель AI-советов.
     */
    onShow: function (viewEl) {
      state.viewEl = viewEl;

      // Гейтинг: добавки — премиум-функция. Если подписки нет,
      // показываем единый paywall и выходим (доступ контролируется сервером).
      if (
        App &&
        typeof App.requirePremium === "function" &&
        !App.requirePremium(viewEl, {
          icon: "💊",
          title: "Добавки",
          desc: "Спортпит, напоминания и AI-советы",
          bullets: [
            "Учёт добавок и дозировок",
            "Напоминания о приёме",
            "AI-подсказки по добавкам под цель"
          ]
        })
      ) {
        return;
      }

      state.supLoading = false;
      state.remLoading = false;
      state.supplements = [];

      viewEl.innerHTML = pageTemplate();

      // Стартовое пустое состояние чекбоксов напоминаний (до загрузки добавок).
      renderReminderPicks();

      bindEvents();

      // Параллельно загружаем добавки и напоминания.
      loadSupplements();
      loadReminders();

      // Предзаполняем цель улучшения для AI-советов.
      prefillImprovementGoal();

      // Прокрутка наверх, чтобы экран не «залип» прокрученным вниз.
      App.scrollTop();
    },

    /**
     * Вызывается при уходе со страницы — освобождаем ссылки на DOM.
     */
    onHide: function () {
      state.viewEl = null;
      state.supLoading = false;
      state.remLoading = false;
      state.supplements = [];
    }
  };

  // Публикуем контроллер и регистрируем страницу.
  window.PageSupplements = controller;
  if (window.App && typeof App.registerPage === "function") {
    App.registerPage("supplements", controller);
  }
})();
