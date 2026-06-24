/*
 * page-workouts.js — страница «Тренировки» (🏋️).
 *
 * Регистрирует контроллер страницы через App.registerPage("workouts", {...}).
 * Публичная ссылка — window.PageWorkouts.
 *
 * Раздел состоит из двух частей:
 *
 *   1. ТРЕНИРОВКИ
 *      - Переключатель даты (◀ дата ▶), по умолчанию App.todayStr().
 *      - Форма добавления: тип (Кардио/Силовая/Ходьба/Йога/Другое),
 *        длительность (мин), калории + кнопка «Оценить»
 *        (App.api.estimateWorkout) подставляет calories_burned.
 *      - Кнопка «Добавить» -> App.api.addWorkout -> перезагрузка списка.
 *      - Список тренировок за дату (App.api.getWorkouts) с удалением
 *        (App.api.deleteWorkout).
 *      - Итог «Сожжено за день: N ккал».
 *
 *   2. СПОРТПИТ (карточкой)
 *      - Список добавок (App.api.getSupplements) с удалением
 *        (App.api.deleteSupplement).
 *      - Форма добавления: название, тип, дозировка, время приёма (HH:MM),
 *        чекбокс «напоминать» -> App.api.addSupplement.
 *      - Кнопка «🤖 Подсказать добавки» -> App.api.suggestSupplements,
 *        показывает варианты {name,dosage,note} + видимый дисклеймер.
 *
 * Весь пользовательский текст — на русском. Полная обработка ошибок (сеть/AI),
 * состояния загрузки (скелетоны), пустые состояния.
 */
(function () {
  "use strict";

  // Типы тренировок: значение для бэкенда -> русская подпись.
  // Порядок задаёт расположение опций в выпадающем списке.
  var WORKOUT_TYPES = [
    { value: "cardio", label: "Кардио" },
    { value: "strength", label: "Силовая" },
    { value: "walking", label: "Ходьба" },
    { value: "yoga", label: "Йога" },
    { value: "other", label: "Другое" }
  ];

  // Декоративные иконки для типов тренировок в списке.
  var WORKOUT_ICONS = {
    cardio: "🏃",
    strength: "🏋️",
    walking: "🚶",
    yoga: "🧘",
    other: "🤸"
  };

  // Соответствие value -> русская подпись (быстрый доступ для рендера списка).
  var WORKOUT_LABELS = {};
  WORKOUT_TYPES.forEach(function (t) {
    WORKOUT_LABELS[t.value] = t.label;
  });

  // Внутреннее состояние контроллера.
  var state = {
    viewEl: null,      // корневой элемент страницы (#view)
    date: null,        // выбранная дата "YYYY-MM-DD"
    wkLoading: false,  // флаг загрузки списка тренировок (защита от гонок)
    supLoading: false  // флаг загрузки списка добавок
  };

  /* =====================================================================
   *  УТИЛИТЫ
   * ===================================================================== */

  function esc(s) {
    return App.escapeHtml(s == null ? "" : String(s));
  }

  function fmt(n) {
    return App.fmt(n);
  }

  function haptic(kind) {
    if (App && typeof App.haptic === "function") App.haptic(kind);
  }

  function toast(msg) {
    if (App && typeof App.toast === "function") App.toast(msg);
  }

  /**
   * Русская подпись типа тренировки (с запасным вариантом).
   */
  function workoutLabel(type) {
    return WORKOUT_LABELS[type] || type || "Тренировка";
  }

  /**
   * Прибавляет к ISO-дате ("YYYY-MM-DD") число дней без риска «уплыть»
   * через границу суток из-за часовых поясов (используем полдень).
   */
  function shiftDate(isoDate, deltaDays) {
    var parts = String(isoDate).split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    var dt = new Date(y, m, d, 12, 0, 0, 0);
    dt.setDate(dt.getDate() + deltaDays);
    var yy = dt.getFullYear();
    var mm = String(dt.getMonth() + 1).padStart(2, "0");
    var dd = String(dt.getDate()).padStart(2, "0");
    return yy + "-" + mm + "-" + dd;
  }

  /**
   * Человеко-читаемая подпись даты: Сегодня / Вчера / Завтра / «18 июня 2026».
   */
  function humanDate(isoDate) {
    var today = App.todayStr();
    if (isoDate === today) return "Сегодня";
    if (isoDate === shiftDate(today, -1)) return "Вчера";
    if (isoDate === shiftDate(today, 1)) return "Завтра";
    var months = [
      "января", "февраля", "марта", "апреля", "мая", "июня",
      "июля", "августа", "сентября", "октября", "ноября", "декабря"
    ];
    var parts = String(isoDate).split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(d) || !months[m]) return isoDate;
    return d + " " + months[m] + " " + y;
  }

  /**
   * Считывает целое неотрицательное число из поля ввода.
   * @returns {number|null} число либо null, если пусто/некорректно/отрицательно.
   */
  function readPositiveInt(input) {
    if (!input) return null;
    var raw = (input.value || "").trim().replace(",", ".");
    if (raw === "") return null;
    var n = Number(raw);
    if (!isFinite(n) || n < 0) return null;
    return Math.round(n);
  }

  /* =====================================================================
   *  РАЗМЕТКА: СКЕЛЕТОНЫ
   * ===================================================================== */

  /**
   * Скелетон списка тренировок (несколько «пульсирующих» строк).
   */
  function workoutsSkeletonHtml() {
    var rows = "";
    for (var i = 0; i < 3; i++) {
      rows +=
        '<div class="wk-item skeleton-block">' +
        '<div class="skeleton skeleton-line skeleton-title"></div>' +
        '<div class="skeleton skeleton-line short"></div>' +
        "</div>";
    }
    return '<div class="wk-skeleton">' + rows + "</div>";
  }

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

  /* =====================================================================
   *  РАЗМЕТКА: СТАТИЧЕСКИЙ КАРКАС СТРАНИЦЫ
   * ===================================================================== */

  /**
   * Опции <option> для select типов тренировок.
   */
  function workoutTypeOptionsHtml() {
    return WORKOUT_TYPES.map(function (t) {
      return '<option value="' + esc(t.value) + '">' + esc(t.label) + "</option>";
    }).join("");
  }

  /**
   * Переключатель даты (◀ дата ▶) — стиль как на странице рациона.
   */
  function dateBarHtml() {
    return (
      '<div class="wk-datebar card">' +
      '<button class="wk-datebar__nav" type="button" data-nav="prev" ' +
      'aria-label="Предыдущий день">◀</button>' +
      '<div class="wk-datebar__label">' +
      '<span class="wk-datebar__date">' + esc(humanDate(state.date)) + "</span>" +
      '<span class="wk-datebar__iso">' + esc(state.date) + "</span>" +
      "</div>" +
      '<button class="wk-datebar__nav" type="button" data-nav="next" ' +
      'aria-label="Следующий день">▶</button>' +
      "</div>"
    );
  }

  /**
   * Форма добавления тренировки.
   */
  function workoutFormHtml() {
    return (
      '<form class="card wk-form" id="wkForm" novalidate>' +
      '<h2 class="wk-form__title">Добавить тренировку</h2>' +

      '<label class="field">' +
      '<span class="field__label">Тип тренировки</span>' +
      '<select class="field__input" id="wkType">' +
      workoutTypeOptionsHtml() +
      "</select>" +
      "</label>" +

      '<div class="wk-form__grid">' +
      '<label class="field">' +
      '<span class="field__label">Длительность, мин</span>' +
      '<input class="field__input" id="wkDuration" type="number" ' +
      'inputmode="numeric" min="0" step="1" placeholder="30">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">Сожжено, ккал</span>' +
      '<input class="field__input" id="wkCalories" type="number" ' +
      'inputmode="numeric" min="0" step="1" placeholder="250">' +
      "</label>" +
      "</div>" +

      '<button type="button" class="btn btn-ghost btn-block wk-estimate" id="wkEstimateBtn">' +
      "🔥 Оценить калории" +
      "</button>" +
      '<button type="submit" class="btn btn-cta btn-block wk-add" id="wkAddBtn">' +
      "Добавить тренировку" +
      "</button>" +
      '<p class="wk-form__hint">Введите калории вручную или нажмите «Оценить», ' +
      "чтобы рассчитать их по типу и длительности.</p>" +
      "</form>"
    );
  }

  /**
   * Форма добавления добавки (спортпит).
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
   * Карточка раздела «Спортпит» целиком (список + кнопка подсказки + форма).
   */
  function supplementCardHtml() {
    return (
      '<section class="card sup-card">' +
      '<h2 class="sup-card__title">Спортпит</h2>' +
      '<p class="sup-card__subtitle">Ваши добавки и приёмы спортивного питания.</p>' +

      // Контейнер списка добавок (наполняется отдельно).
      '<div id="supList" class="sup-list"></div>' +

      // Кнопка ИИ-подсказки и контейнер для её результата.
      '<button type="button" class="btn btn-ghost btn-block sup-suggest" id="supSuggestBtn">' +
      "🤖 Подсказать добавки" +
      "</button>" +
      '<div id="supSuggestBox" class="sup-suggest-box"></div>' +

      // Форма добавления.
      supplementFormHtml() +
      "</section>"
    );
  }

  /**
   * Полный каркас страницы. Динамические части (список тренировок, итог,
   * список добавок) наполняются отдельными функциями после монтирования.
   */
  function pageTemplate() {
    return (
      '<section class="page page-workouts">' +
      '<h1 class="page__title">Тренировки</h1>' +

      dateBarHtml() +

      // Итог «Сожжено за день» (наполняется в renderWorkouts).
      '<div id="wkSummary" class="wk-summary"></div>' +

      // Форма добавления тренировки.
      workoutFormHtml() +

      // Список тренировок за выбранную дату.
      '<div id="wkList" class="wk-list"></div>' +

      // Раздел «Спортпит».
      supplementCardHtml() +
      "</section>"
    );
  }

  /* =====================================================================
   *  РАЗМЕТКА: ДИНАМИЧЕСКИЕ ЧАСТИ ТРЕНИРОВОК
   * ===================================================================== */

  /**
   * Разметка одной строки тренировки в списке.
   */
  function workoutRowHtml(w) {
    var icon = WORKOUT_ICONS[w.type] || "🏋️";
    var label = workoutLabel(w.type);
    var dur = Number(w.duration_min) || 0;
    var kcal = fmt(w.calories_burned || 0);
    return (
      '<li class="wk-item" data-id="' + esc(w.id) + '">' +
      '<div class="wk-item__main">' +
      '<span class="wk-item__title">' +
      '<span class="wk-item__icon" aria-hidden="true">' + icon + "</span> " +
      esc(label) +
      "</span>" +
      '<span class="wk-item__meta">' + esc(String(dur)) + " мин · " + kcal + " ккал</span>" +
      "</div>" +
      '<button class="wk-item__del" type="button" data-id="' + esc(w.id) + '" ' +
      'aria-label="Удалить тренировку" title="Удалить">✕</button>' +
      "</li>"
    );
  }

  /**
   * Разметка карточки итога «Сожжено за день».
   */
  function summaryHtml(totalBurned) {
    return (
      '<section class="card wk-summary__card">' +
      '<span class="wk-summary__caption">Сожжено за день</span>' +
      '<span class="wk-summary__value">' + fmt(totalBurned || 0) + " ккал</span>" +
      "</section>"
    );
  }

  /**
   * Отрисовка списка тренировок и итога после загрузки.
   * @param {Object} data { date, workouts:[...], total_burned }
   */
  function renderWorkouts(data) {
    var listBox = byId("wkList");
    var sumBox = byId("wkSummary");
    if (!listBox) return;

    var workouts = (data && data.workouts) || [];
    var totalBurned = data && data.total_burned != null ? data.total_burned : 0;

    if (sumBox) {
      sumBox.innerHTML = summaryHtml(totalBurned);
    }

    if (!workouts.length) {
      listBox.innerHTML =
        '<div class="wk-empty">' +
        '<div class="wk-empty__icon" aria-hidden="true">🏋️</div>' +
        '<p class="wk-empty__title">За этот день тренировок нет</p>' +
        '<p class="wk-empty__text">Добавьте тренировку с помощью формы выше.</p>' +
        "</div>";
      return;
    }

    var rows = "";
    for (var i = 0; i < workouts.length; i++) {
      rows += workoutRowHtml(workouts[i]);
    }
    listBox.innerHTML = '<ul class="wk-item-list">' + rows + "</ul>";

    // Навешиваем удаление на каждую кнопку ✕.
    var delButtons = listBox.querySelectorAll(".wk-item__del");
    for (var k = 0; k < delButtons.length; k++) {
      delButtons[k].addEventListener("click", onWorkoutDelete);
    }
  }

  /**
   * Состояние ошибки загрузки тренировок с кнопкой «Повторить».
   */
  function renderWorkoutsError(message) {
    var listBox = byId("wkList");
    var sumBox = byId("wkSummary");
    if (sumBox) sumBox.innerHTML = "";
    if (!listBox) return;
    listBox.innerHTML =
      '<div class="card wk-error">' +
      '<div class="wk-error__icon" aria-hidden="true">⚠️</div>' +
      '<p class="wk-error__title">Не удалось загрузить тренировки</p>' +
      '<p class="wk-error__text">' + esc(message || "Неизвестная ошибка") + "</p>" +
      '<button class="btn btn-ghost wk-error__retry" type="button">Повторить</button>' +
      "</div>";
    var retry = listBox.querySelector(".wk-error__retry");
    if (retry) {
      retry.addEventListener("click", function () {
        loadWorkouts();
      });
    }
  }

  /* =====================================================================
   *  РАЗМЕТКА: ДИНАМИЧЕСКИЕ ЧАСТИ СПОРТПИТА
   * ===================================================================== */

  /**
   * Разметка одной строки добавки.
   */
  function supplementRowHtml(s) {
    // Собираем строку с деталями (тип / дозировка / время), пропуская пустые.
    var parts = [];
    if (s.type) parts.push(esc(s.type));
    if (s.dosage) parts.push(esc(s.dosage));
    if (s.intake_time) parts.push(esc(s.intake_time));
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
    if (!box) return;

    var items = (data && data.items) || [];

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

  /**
   * Отрисовка результата ИИ-подсказки добавок.
   * @param {Object} res { suggestions:[{name,dosage,note}], disclaimer }
   */
  function renderSuggestions(res) {
    var box = byId("supSuggestBox");
    if (!box) return;

    var suggestions = (res && res.suggestions) || [];
    var disclaimer = res && res.disclaimer ? res.disclaimer : "";

    if (!suggestions.length) {
      box.innerHTML =
        '<div class="sup-suggest-box__empty">' +
        "Подходящих рекомендаций не нашлось. Попробуйте позже." +
        "</div>";
      return;
    }

    var cards = suggestions
      .map(function (s) {
        var note = s.note
          ? '<p class="sup-suggest-card__note">' + esc(s.note) + "</p>"
          : "";
        var dosage = s.dosage
          ? '<span class="sup-suggest-card__dosage">' + esc(s.dosage) + "</span>"
          : "";
        return (
          '<div class="sup-suggest-card">' +
          '<div class="sup-suggest-card__head">' +
          '<span class="sup-suggest-card__name">' + esc(s.name || "Добавка") + "</span>" +
          dosage +
          "</div>" +
          note +
          '<button type="button" class="btn btn-ghost sup-suggest-card__use" ' +
          'data-name="' + esc(s.name || "") + '" ' +
          'data-dosage="' + esc(s.dosage || "") + '">Заполнить форму</button>' +
          "</div>"
        );
      })
      .join("");

    // Дисклеймер показываем ВСЕГДА, когда он пришёл с сервера.
    var disclaimerHtml = disclaimer
      ? '<p class="sup-disclaimer">⚠️ ' + esc(disclaimer) + "</p>"
      : "";

    box.innerHTML =
      '<div class="sup-suggest-box__inner">' +
      '<p class="sup-suggest-box__title">Рекомендации</p>' +
      '<div class="sup-suggest-list">' + cards + "</div>" +
      disclaimerHtml +
      "</div>";

    // Кнопки «Заполнить форму» переносят данные подсказки в поля формы.
    var useButtons = box.querySelectorAll(".sup-suggest-card__use");
    for (var i = 0; i < useButtons.length; i++) {
      useButtons[i].addEventListener("click", onSuggestionUse);
    }
  }

  /* =====================================================================
   *  ЗАГРУЗКА ДАННЫХ
   * ===================================================================== */

  /**
   * Загрузка тренировок за выбранную дату (со скелетоном и обработкой ошибок).
   */
  function loadWorkouts() {
    if (state.wkLoading) return;
    state.wkLoading = true;

    var listBox = byId("wkList");
    var sumBox = byId("wkSummary");
    if (sumBox) sumBox.innerHTML = "";
    if (listBox) listBox.innerHTML = workoutsSkeletonHtml();

    App.api
      .getWorkouts(state.date)
      .then(function (data) {
        renderWorkouts(data);
      })
      .catch(function (err) {
        renderWorkoutsError(
          (err && err.message) || "Проблема с сетью. Проверьте соединение."
        );
      })
      .then(function () {
        state.wkLoading = false;
      });
  }

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

  /* =====================================================================
   *  ОБРАБОТЧИКИ: ТРЕНИРОВКИ
   * ===================================================================== */

  /**
   * Обновляет подпись даты в шапке без полной перерисовки страницы.
   */
  function updateDateLabel() {
    var dateEl = state.viewEl && state.viewEl.querySelector(".wk-datebar__date");
    var isoEl = state.viewEl && state.viewEl.querySelector(".wk-datebar__iso");
    if (dateEl) dateEl.textContent = humanDate(state.date);
    if (isoEl) isoEl.textContent = state.date;
  }

  /**
   * Переключение даты и перезагрузка списка тренировок.
   */
  function changeDate(delta) {
    state.date = shiftDate(state.date, delta);
    haptic("selection");
    updateDateLabel();
    loadWorkouts();
  }

  /**
   * Кнопка «Оценить калории» — запрашивает оценку у сервера и
   * подставляет результат в поле калорий.
   */
  function onEstimate() {
    var typeEl = byId("wkType");
    var durEl = byId("wkDuration");
    var calEl = byId("wkCalories");
    var btn = byId("wkEstimateBtn");
    if (!typeEl || !durEl || !calEl) return;

    var duration = readPositiveInt(durEl);
    if (duration == null || duration <= 0) {
      toast("Укажите длительность тренировки в минутах");
      haptic("error");
      durEl.focus();
      return;
    }

    var type = typeEl.value;

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Оцениваем…";
    }
    App.showLoading();

    App.api
      .estimateWorkout({ type: type, duration_min: duration })
      .then(function (res) {
        var kcal = res && res.calories_burned != null ? res.calories_burned : null;
        if (kcal == null) {
          toast("Не удалось оценить калории");
          haptic("warning");
          return;
        }
        calEl.value = Math.round(Number(kcal) || 0);
        haptic("success");
        toast("Оценка: " + fmt(kcal) + " ккал");
      })
      .catch(function (err) {
        haptic("error");
        toast((err && err.message) || "Не удалось оценить калории");
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "🔥 Оценить калории";
        }
        App.hideLoading();
      });
  }

  /**
   * Отправка формы добавления тренировки.
   */
  function onWorkoutSubmit(e) {
    if (e) e.preventDefault();

    var typeEl = byId("wkType");
    var durEl = byId("wkDuration");
    var calEl = byId("wkCalories");
    var btn = byId("wkAddBtn");
    if (!typeEl || !durEl || !calEl) return;

    var duration = readPositiveInt(durEl);
    var calories = readPositiveInt(calEl);

    if (duration == null || duration <= 0) {
      toast("Укажите длительность тренировки в минутах");
      haptic("error");
      durEl.focus();
      return;
    }
    if (calories == null) {
      toast("Укажите калории или нажмите «Оценить»");
      haptic("error");
      calEl.focus();
      return;
    }

    var payload = {
      date: state.date,
      type: typeEl.value,
      duration_min: duration,
      calories_burned: calories
    };

    if (btn) btn.disabled = true;
    App.showLoading();

    App.api
      .addWorkout(payload)
      .then(function () {
        haptic("success");
        toast("Тренировка добавлена");
        // Сбрасываем числовые поля формы, тип оставляем.
        durEl.value = "";
        calEl.value = "";
        // Инвалидируем кэш дневника за эту дату: net_calories мог измениться.
        if (App.state && App.state.diaryByDate) {
          delete App.state.diaryByDate[state.date];
        }
        loadWorkouts();
      })
      .catch(function (err) {
        haptic("error");
        toast((err && err.message) || "Не удалось добавить тренировку");
      })
      .finally(function () {
        if (btn) btn.disabled = false;
        App.hideLoading();
      });
  }

  /**
   * Удаление тренировки по кнопке ✕.
   */
  function onWorkoutDelete(ev) {
    var btn = ev.currentTarget;
    var id = parseInt(btn.getAttribute("data-id"), 10);
    if (isNaN(id)) return;
    if (btn.disabled) return;

    btn.disabled = true;
    btn.textContent = "…";
    haptic("light");
    App.showLoading();

    App.api
      .deleteWorkout(id)
      .then(function () {
        toast("Тренировка удалена");
        if (App.state && App.state.diaryByDate) {
          delete App.state.diaryByDate[state.date];
        }
        loadWorkouts();
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "✕";
        haptic("error");
        toast((err && err.message) || "Не удалось удалить тренировку");
      })
      .finally(function () {
        App.hideLoading();
      });
  }

  /* =====================================================================
   *  ОБРАБОТЧИКИ: СПОРТПИТ
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

  /**
   * Кнопка «🤖 Подсказать добавки» — запрашивает рекомендации у сервера.
   */
  function onSuggest() {
    var btn = byId("supSuggestBtn");
    var box = byId("supSuggestBox");
    if (!box) return;

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Подбираем…";
    }
    box.innerHTML =
      '<div class="sup-suggest-box__loading">' +
      '<div class="skeleton skeleton-line"></div>' +
      '<div class="skeleton skeleton-line short"></div>' +
      "</div>";

    App.api
      .suggestSupplements()
      .then(function (res) {
        renderSuggestions(res);
        haptic("success");
      })
      .catch(function (err) {
        box.innerHTML =
          '<div class="sup-suggest-box__error">' +
          '<p class="sup-suggest-box__error-text">' +
          esc((err && err.message) || "Не удалось получить рекомендации") +
          "</p>" +
          '<button type="button" class="btn btn-ghost sup-suggest-box__retry">Повторить</button>' +
          "</div>";
        var retry = box.querySelector(".sup-suggest-box__retry");
        if (retry) retry.addEventListener("click", onSuggest);
        haptic("error");
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "🤖 Подсказать добавки";
        }
      });
  }

  /**
   * Кнопка «Заполнить форму» в карточке рекомендации — переносит
   * название и дозировку в поля формы добавления.
   */
  function onSuggestionUse(ev) {
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
   *  ПРИВЯЗКА ОБРАБОТЧИКОВ
   * ===================================================================== */

  /**
   * Хелпер: поиск элемента по id внутри текущего представления.
   */
  function byId(id) {
    if (!state.viewEl) return null;
    return state.viewEl.querySelector("#" + id);
  }

  /**
   * Навешивает все обработчики событий после монтирования разметки.
   */
  function bindEvents() {
    // Навигация по датам (◀ / ▶).
    var navButtons = state.viewEl.querySelectorAll(".wk-datebar__nav");
    for (var i = 0; i < navButtons.length; i++) {
      navButtons[i].addEventListener("click", function (ev) {
        var dir = ev.currentTarget.getAttribute("data-nav");
        changeDate(dir === "next" ? 1 : -1);
      });
    }

    // Форма и кнопки тренировок.
    var wkForm = byId("wkForm");
    if (wkForm) wkForm.addEventListener("submit", onWorkoutSubmit);

    var estimateBtn = byId("wkEstimateBtn");
    if (estimateBtn) estimateBtn.addEventListener("click", onEstimate);

    // Форма добавки.
    var supForm = byId("supForm");
    if (supForm) supForm.addEventListener("submit", onSupplementSubmit);

    // Кнопка ИИ-подсказки.
    var suggestBtn = byId("supSuggestBtn");
    if (suggestBtn) suggestBtn.addEventListener("click", onSuggest);
  }

  /* =====================================================================
   *  КОНТРОЛЛЕР СТРАНИЦЫ
   * ===================================================================== */

  var controller = {
    /**
     * Вызывается при показе страницы: строит разметку, вешает обработчики,
     * загружает тренировки и добавки.
     */
    onShow: function (viewEl) {
      state.viewEl = viewEl;
      state.wkLoading = false;
      state.supLoading = false;

      // При каждом показе по умолчанию открываем сегодняшний день.
      state.date = App.todayStr();

      viewEl.innerHTML = pageTemplate();

      bindEvents();

      // Параллельно загружаем оба раздела.
      loadWorkouts();
      loadSupplements();

      // Прокрутка наверх, чтобы экран не «залип» прокрученным вниз.
      App.scrollTop();
    },

    /**
     * Вызывается при уходе со страницы — освобождаем ссылки на DOM.
     */
    onHide: function () {
      state.viewEl = null;
      state.wkLoading = false;
      state.supLoading = false;
    }
  };

  // Публикуем контроллер и регистрируем страницу.
  window.PageWorkouts = controller;
  if (window.App && typeof App.registerPage === "function") {
    App.registerPage("workouts", controller);
  }
})();
