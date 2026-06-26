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
 *   2. НАПОМИНАНИЯ О ТРЕНИРОВКЕ (карточкой)
 *      - Список напоминаний (App.api.getTrainingReminders) с удалением
 *        (App.api.deleteTrainingReminder).
 *      - Форма: выбор дней недели (чипы Пн…Вс -> [0..6], можно несколько),
 *        время (input time), переключатель вкл/выкл
 *        -> App.api.addTrainingReminder({weekdays,time,enabled}).
 *      - Дни недели показываются словами (напр. «Пн, Ср, Пт · 18:00»).
 *
 * Раздел «Спортпит» вынесен на отдельную страницу page-supplements.
 *
 * Локализация RU/EN: все видимые пользователю строки оборачиваются в
 * App.pick("рус","eng") НА МОМЕНТ РЕНДЕРА, чтобы смена языка давала нужный
 * текст при перерисовке. Полная обработка ошибок (сеть/AI), состояния
 * загрузки (скелетоны), пустые состояния.
 */
(function () {
  "use strict";

  /**
   * Локализация: возвращает строку по текущему языку App.lang.
   * Используем безопасный фолбэк на русский, если App.pick недоступен.
   */
  function pick(ru, en) {
    if (App && typeof App.pick === "function") return App.pick(ru, en);
    return ru;
  }

  // Типы тренировок: значение для бэкенда. Подписи локализуются на момент
  // рендера через workoutLabel()/workoutTypeLabel(), порядок задаёт расположение
  // опций в выпадающем списке.
  var WORKOUT_TYPES = ["cardio", "strength", "walking", "yoga", "other"];

  // Декоративные иконки для типов тренировок в списке.
  var WORKOUT_ICONS = {
    cardio: "🏃",
    strength: "🏋️",
    walking: "🚶",
    yoga: "🧘",
    other: "🤸"
  };

  /**
   * Локализованная подпись типа тренировки (вызывается на момент рендера).
   */
  function workoutTypeLabel(type) {
    switch (type) {
      case "cardio":
        return pick("Кардио", "Cardio");
      case "strength":
        return pick("Силовая", "Strength");
      case "walking":
        return pick("Ходьба", "Walking");
      case "yoga":
        return pick("Йога", "Yoga");
      case "other":
        return pick("Другое", "Other");
      default:
        return null;
    }
  }

  // Дни недели: индекс 0=Пн … 6=Вс. Используются и в чипах формы, и в списке.
  // Подписи локализуются на момент рендера через weekdayShort().
  var WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

  /**
   * Локализованная короткая подпись дня недели (вызывается на момент рендера).
   * 0=Пн … 6=Вс.
   */
  function weekdayShort(value) {
    switch (value) {
      case 0:
        return pick("Пн", "Mon");
      case 1:
        return pick("Вт", "Tue");
      case 2:
        return pick("Ср", "Wed");
      case 3:
        return pick("Чт", "Thu");
      case 4:
        return pick("Пт", "Fri");
      case 5:
        return pick("Сб", "Sat");
      case 6:
        return pick("Вс", "Sun");
      default:
        return null;
    }
  }

  // Внутреннее состояние контроллера.
  var state = {
    viewEl: null,        // корневой элемент страницы (#view)
    date: null,          // выбранная дата "YYYY-MM-DD"
    wkLoading: false,    // флаг загрузки списка тренировок (защита от гонок)
    remLoading: false,   // флаг загрузки списка напоминаний
    remDays: []          // выбранные дни недели в форме напоминания ([0..6])
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
   * Локализованная подпись типа тренировки (с запасным вариантом).
   */
  function workoutLabel(type) {
    return workoutTypeLabel(type) || type || pick("Тренировка", "Workout");
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
    if (isoDate === today) return pick("Сегодня", "Today");
    if (isoDate === shiftDate(today, -1)) return pick("Вчера", "Yesterday");
    if (isoDate === shiftDate(today, 1)) return pick("Завтра", "Tomorrow");
    var months = pick(
      [
        "января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря"
      ],
      [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
      ]
    );
    var parts = String(isoDate).split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(d) || !months[m]) return isoDate;
    // В английском принят порядок «June 18, 2026», в русском — «18 июня 2026».
    if (App && App.lang === "en") return months[m] + " " + d + ", " + y;
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

  /**
   * Превращает массив индексов дней недели в человеко-читаемую строку.
   * Например, [0,2,4] -> "Пн, Ср, Пт". Каждый день — всю неделю -> "Ежедневно".
   * Подписи локализуются на момент вызова.
   */
  function weekdaysToText(days) {
    if (!days || !days.length) return "";
    // Нормализуем: только валидные индексы, по возрастанию, без повторов.
    var clean = [];
    var seen = {};
    var sorted = days.slice().sort(function (a, b) {
      return a - b;
    });
    for (var i = 0; i < sorted.length; i++) {
      var v = sorted[i];
      if (weekdayShort(v) != null && !seen[v]) {
        seen[v] = true;
        clean.push(v);
      }
    }
    if (!clean.length) return "";
    if (clean.length === 7) return pick("Ежедневно", "Daily");
    return clean
      .map(function (v) {
        return weekdayShort(v);
      })
      .join(", ");
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
   * Скелетон списка напоминаний о тренировке.
   */
  function remindersSkeletonHtml() {
    var rows = "";
    for (var i = 0; i < 2; i++) {
      rows +=
        '<div class="wk-rem-item skeleton-block">' +
        '<div class="skeleton skeleton-line skeleton-title"></div>' +
        '<div class="skeleton skeleton-line short"></div>' +
        "</div>";
    }
    return '<div class="wk-rem-skeleton">' + rows + "</div>";
  }

  /* =====================================================================
   *  РАЗМЕТКА: СТАТИЧЕСКИЙ КАРКАС СТРАНИЦЫ
   * ===================================================================== */

  /**
   * Опции <option> для select типов тренировок.
   */
  function workoutTypeOptionsHtml() {
    return WORKOUT_TYPES.map(function (t) {
      return '<option value="' + esc(t) + '">' + esc(workoutTypeLabel(t)) + "</option>";
    }).join("");
  }

  /**
   * Переключатель даты (◀ дата ▶) — стиль как на странице рациона.
   */
  function dateBarHtml() {
    return (
      '<div class="wk-datebar card">' +
      '<button class="wk-datebar__nav" type="button" data-nav="prev" ' +
      'aria-label="' + esc(pick("Предыдущий день", "Previous day")) + '">◀</button>' +
      '<div class="wk-datebar__label">' +
      '<span class="wk-datebar__date">' + esc(humanDate(state.date)) + "</span>" +
      '<span class="wk-datebar__iso">' + esc(state.date) + "</span>" +
      "</div>" +
      '<button class="wk-datebar__nav" type="button" data-nav="next" ' +
      'aria-label="' + esc(pick("Следующий день", "Next day")) + '">▶</button>' +
      "</div>"
    );
  }

  /**
   * Форма добавления тренировки.
   */
  function workoutFormHtml() {
    return (
      '<form class="card wk-form" id="wkForm" novalidate>' +
      '<h2 class="wk-form__title">' + esc(pick("Добавить тренировку", "Add workout")) + "</h2>" +

      '<label class="field">' +
      '<span class="field__label">' + esc(pick("Тип тренировки", "Workout type")) + "</span>" +
      '<select class="field__input" id="wkType">' +
      workoutTypeOptionsHtml() +
      "</select>" +
      "</label>" +

      '<div class="wk-form__grid">' +
      '<label class="field">' +
      '<span class="field__label">' + esc(pick("Длительность, мин", "Duration, min")) + "</span>" +
      '<input class="field__input" id="wkDuration" type="number" ' +
      'inputmode="numeric" min="0" step="1" placeholder="30">' +
      "</label>" +

      '<label class="field">' +
      '<span class="field__label">' + esc(pick("Сожжено, ккал", "Burned, kcal")) + "</span>" +
      '<input class="field__input" id="wkCalories" type="number" ' +
      'inputmode="numeric" min="0" step="1" placeholder="250">' +
      "</label>" +
      "</div>" +

      '<button type="button" class="btn btn-ghost btn-block wk-estimate" id="wkEstimateBtn">' +
      "🔥 " + esc(pick("Оценить калории", "Estimate calories")) +
      "</button>" +
      '<button type="submit" class="btn btn-cta btn-block wk-add" id="wkAddBtn">' +
      esc(pick("Добавить тренировку", "Add workout")) +
      "</button>" +
      '<p class="wk-form__hint">' +
      esc(pick(
        "Введите калории вручную или нажмите «Оценить», чтобы рассчитать их по типу и длительности.",
        "Enter calories manually or tap “Estimate” to calculate them from type and duration."
      )) +
      "</p>" +
      "</form>"
    );
  }

  /**
   * Чипы выбора дней недели в форме напоминания.
   * Активный чип помечается классом is-active (синхронизируется с state.remDays).
   */
  function weekdayChipsHtml() {
    return WEEKDAYS.map(function (d) {
      var active = state.remDays.indexOf(d) !== -1;
      return (
        '<button type="button" class="wk-rem-day' +
        (active ? " is-active" : "") +
        '" data-day="' + d + '" ' +
        'aria-pressed="' + (active ? "true" : "false") + '">' +
        esc(weekdayShort(d)) +
        "</button>"
      );
    }).join("");
  }

  /**
   * Форма добавления напоминания о тренировке.
   */
  function reminderFormHtml() {
    return (
      '<form class="wk-rem-form" id="wkRemForm" novalidate>' +
      '<h3 class="wk-rem-form__title">' + esc(pick("Новое напоминание", "New reminder")) + "</h3>" +

      '<div class="field">' +
      '<span class="field__label">' + esc(pick("Дни недели", "Weekdays")) + "</span>" +
      '<div class="wk-rem-days" id="wkRemDays">' +
      weekdayChipsHtml() +
      "</div>" +
      "</div>" +

      '<div class="wk-rem-form__grid">' +
      '<label class="field">' +
      '<span class="field__label">' + esc(pick("Время", "Time")) + "</span>" +
      '<input class="field__input" id="wkRemTime" type="time" value="18:00">' +
      "</label>" +

      '<label class="wk-rem-form__check">' +
      '<input type="checkbox" id="wkRemEnabled" class="wk-rem-form__checkbox" checked>' +
      '<span class="wk-rem-form__check-label">' + esc(pick("Включено", "Enabled")) + "</span>" +
      "</label>" +
      "</div>" +

      '<button type="submit" class="btn btn-cta btn-block wk-rem-add" id="wkRemAddBtn">' +
      esc(pick("Добавить напоминание", "Add reminder")) +
      "</button>" +
      '<p class="wk-rem-form__hint">' +
      esc(pick(
        "Выберите один или несколько дней (например, Пн, Ср, Пт) и время напоминания.",
        "Pick one or more days (e.g. Mon, Wed, Fri) and a reminder time."
      )) +
      "</p>" +
      "</form>"
    );
  }

  /**
   * Карточка раздела «Напоминания о тренировке» (список + форма).
   */
  function reminderCardHtml() {
    return (
      '<section class="card wk-rem-card">' +
      '<h2 class="wk-rem-card__title">' + esc(pick("Напоминания о тренировке", "Workout reminders")) + "</h2>" +
      '<p class="wk-rem-card__subtitle">' +
      esc(pick("Мы напомним вам не пропустить тренировку.", "We’ll remind you not to skip your workout.")) +
      "</p>" +

      // Контейнер списка напоминаний (наполняется отдельно).
      '<div id="wkRemList" class="wk-rem-list"></div>' +

      // Форма добавления.
      reminderFormHtml() +
      "</section>"
    );
  }

  /**
   * Полный каркас страницы. Динамические части (список тренировок, итог,
   * список напоминаний) наполняются отдельными функциями после монтирования.
   */
  function pageTemplate() {
    return (
      '<section class="page page-workouts">' +
      '<h1 class="page__title">' + esc(pick("Тренировки", "Workouts")) + "</h1>" +

      dateBarHtml() +

      // Итог «Сожжено за день» (наполняется в renderWorkouts).
      '<div id="wkSummary" class="wk-summary"></div>' +

      // Форма добавления тренировки.
      workoutFormHtml() +

      // Список тренировок за выбранную дату.
      '<div id="wkList" class="wk-list"></div>' +

      // Раздел «Напоминания о тренировке».
      reminderCardHtml() +
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
      '<span class="wk-item__meta">' + esc(String(dur)) + " " + esc(pick("мин", "min")) +
      " · " + kcal + " " + esc(pick("ккал", "kcal")) + "</span>" +
      "</div>" +
      '<button class="wk-item__del" type="button" data-id="' + esc(w.id) + '" ' +
      'aria-label="' + esc(pick("Удалить тренировку", "Delete workout")) + '" ' +
      'title="' + esc(pick("Удалить", "Delete")) + '">✕</button>' +
      "</li>"
    );
  }

  /**
   * Разметка карточки итога «Сожжено за день».
   */
  function summaryHtml(totalBurned) {
    return (
      '<section class="card wk-summary__card">' +
      '<span class="wk-summary__caption">' + esc(pick("Сожжено за день", "Burned today")) + "</span>" +
      '<span class="wk-summary__value">' + fmt(totalBurned || 0) + " " + esc(pick("ккал", "kcal")) + "</span>" +
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
        '<p class="wk-empty__title">' +
        esc(pick("За этот день тренировок нет", "No workouts for this day")) +
        "</p>" +
        '<p class="wk-empty__text">' +
        esc(pick("Добавьте тренировку с помощью формы выше.", "Add a workout using the form above.")) +
        "</p>" +
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
      '<p class="wk-error__title">' +
      esc(pick("Не удалось загрузить тренировки", "Couldn’t load workouts")) +
      "</p>" +
      '<p class="wk-error__text">' + esc(message || pick("Неизвестная ошибка", "Unknown error")) + "</p>" +
      '<button class="btn btn-ghost wk-error__retry" type="button">' +
      esc(pick("Повторить", "Retry")) +
      "</button>" +
      "</div>";
    var retry = listBox.querySelector(".wk-error__retry");
    if (retry) {
      retry.addEventListener("click", function () {
        loadWorkouts();
      });
    }
  }

  /* =====================================================================
   *  РАЗМЕТКА: ДИНАМИЧЕСКИЕ ЧАСТИ НАПОМИНАНИЙ
   * ===================================================================== */

  /**
   * Разметка одной строки напоминания о тренировке.
   * @param {Object} r { id, weekdays:[int], time, enabled }
   */
  function reminderRowHtml(r) {
    var daysText = weekdaysToText(r.weekdays) || pick("Дни не выбраны", "No days selected");
    var time = r.time ? esc(r.time) : "";
    var meta = time ? daysText + " · " + time : daysText;

    var badge = r.enabled
      ? '<span class="wk-rem-item__badge wk-rem-item__badge--on">🔔 ' + esc(pick("включено", "on")) + "</span>"
      : '<span class="wk-rem-item__badge wk-rem-item__badge--off">🔕 ' + esc(pick("выключено", "off")) + "</span>";

    return (
      '<li class="wk-rem-item" data-id="' + esc(r.id) + '">' +
      '<div class="wk-rem-item__main">' +
      '<span class="wk-rem-item__meta">' + esc(meta) + "</span>" +
      badge +
      "</div>" +
      '<button class="wk-rem-item__del" type="button" data-id="' + esc(r.id) + '" ' +
      'aria-label="' + esc(pick("Удалить напоминание", "Delete reminder")) + '" ' +
      'title="' + esc(pick("Удалить", "Delete")) + '">✕</button>' +
      "</li>"
    );
  }

  /**
   * Отрисовка списка напоминаний о тренировке.
   * @param {Object} data { items:[...] }
   */
  function renderReminders(data) {
    var box = byId("wkRemList");
    if (!box) return;

    var items = (data && data.items) || [];

    if (!items.length) {
      box.innerHTML =
        '<div class="wk-rem-empty">' +
        '<div class="wk-rem-empty__icon" aria-hidden="true">⏰</div>' +
        '<p class="wk-rem-empty__text">' + esc(pick("Напоминаний пока нет.", "No reminders yet.")) + "</p>" +
        "</div>";
      return;
    }

    var rows = "";
    for (var i = 0; i < items.length; i++) {
      rows += reminderRowHtml(items[i]);
    }
    box.innerHTML = '<ul class="wk-rem-item-list">' + rows + "</ul>";

    var delButtons = box.querySelectorAll(".wk-rem-item__del");
    for (var k = 0; k < delButtons.length; k++) {
      delButtons[k].addEventListener("click", onReminderDelete);
    }
  }

  /**
   * Состояние ошибки загрузки напоминаний с кнопкой «Повторить».
   */
  function renderRemindersError(message) {
    var box = byId("wkRemList");
    if (!box) return;
    box.innerHTML =
      '<div class="wk-rem-error">' +
      '<div class="wk-rem-error__icon" aria-hidden="true">⚠️</div>' +
      '<p class="wk-rem-error__title">' +
      esc(pick("Не удалось загрузить напоминания", "Couldn’t load reminders")) +
      "</p>" +
      '<p class="wk-rem-error__text">' + esc(message || pick("Неизвестная ошибка", "Unknown error")) + "</p>" +
      '<button class="btn btn-ghost wk-rem-error__retry" type="button">' +
      esc(pick("Повторить", "Retry")) +
      "</button>" +
      "</div>";
    var retry = box.querySelector(".wk-rem-error__retry");
    if (retry) {
      retry.addEventListener("click", function () {
        loadReminders();
      });
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
          (err && err.message) || pick("Проблема с сетью. Проверьте соединение.", "Network problem. Check your connection.")
        );
      })
      .then(function () {
        state.wkLoading = false;
      });
  }

  /**
   * Загрузка списка напоминаний (со скелетоном и обработкой ошибок).
   */
  function loadReminders() {
    if (state.remLoading) return;
    state.remLoading = true;

    var box = byId("wkRemList");
    if (box) box.innerHTML = remindersSkeletonHtml();

    App.api
      .getTrainingReminders()
      .then(function (data) {
        renderReminders(data);
      })
      .catch(function (err) {
        renderRemindersError(
          (err && err.message) || pick("Проблема с сетью. Проверьте соединение.", "Network problem. Check your connection.")
        );
      })
      .then(function () {
        state.remLoading = false;
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
      toast(pick("Укажите длительность тренировки в минутах", "Enter the workout duration in minutes"));
      haptic("error");
      durEl.focus();
      return;
    }

    var type = typeEl.value;

    if (btn) {
      btn.disabled = true;
      btn.textContent = pick("Оцениваем…", "Estimating…");
    }
    App.showLoading();

    App.api
      .estimateWorkout({ type: type, duration_min: duration })
      .then(function (res) {
        var kcal = res && res.calories_burned != null ? res.calories_burned : null;
        if (kcal == null) {
          toast(pick("Не удалось оценить калории", "Couldn’t estimate calories"));
          haptic("warning");
          return;
        }
        calEl.value = Math.round(Number(kcal) || 0);
        haptic("success");
        toast(pick("Оценка: ", "Estimate: ") + fmt(kcal) + " " + pick("ккал", "kcal"));
      })
      .catch(function (err) {
        haptic("error");
        toast((err && err.message) || pick("Не удалось оценить калории", "Couldn’t estimate calories"));
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "🔥 " + pick("Оценить калории", "Estimate calories");
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
      toast(pick("Укажите длительность тренировки в минутах", "Enter the workout duration in minutes"));
      haptic("error");
      durEl.focus();
      return;
    }
    if (calories == null) {
      toast(pick("Укажите калории или нажмите «Оценить»", "Enter calories or tap “Estimate”"));
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
        toast(pick("Тренировка добавлена", "Workout added"));
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
        toast((err && err.message) || pick("Не удалось добавить тренировку", "Couldn’t add workout"));
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
        toast(pick("Тренировка удалена", "Workout deleted"));
        if (App.state && App.state.diaryByDate) {
          delete App.state.diaryByDate[state.date];
        }
        loadWorkouts();
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "✕";
        haptic("error");
        toast((err && err.message) || pick("Не удалось удалить тренировку", "Couldn’t delete workout"));
      })
      .finally(function () {
        App.hideLoading();
      });
  }

  /* =====================================================================
   *  ОБРАБОТЧИКИ: НАПОМИНАНИЯ О ТРЕНИРОВКЕ
   * ===================================================================== */

  /**
   * Переключение выбора дня недели в форме (чип).
   */
  function onWeekdayToggle(ev) {
    var btn = ev.currentTarget;
    var day = parseInt(btn.getAttribute("data-day"), 10);
    if (isNaN(day)) return;

    var idx = state.remDays.indexOf(day);
    if (idx === -1) {
      state.remDays.push(day);
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
    } else {
      state.remDays.splice(idx, 1);
      btn.classList.remove("is-active");
      btn.setAttribute("aria-pressed", "false");
    }
    haptic("selection");
  }

  /**
   * Сброс формы напоминания после успешного добавления.
   */
  function resetReminderForm() {
    state.remDays = [];
    var daysBox = byId("wkRemDays");
    if (daysBox) {
      var chips = daysBox.querySelectorAll(".wk-rem-day");
      for (var i = 0; i < chips.length; i++) {
        chips[i].classList.remove("is-active");
        chips[i].setAttribute("aria-pressed", "false");
      }
    }
    var timeEl = byId("wkRemTime");
    if (timeEl) timeEl.value = "18:00";
    var enabledEl = byId("wkRemEnabled");
    if (enabledEl) enabledEl.checked = true;
  }

  /**
   * Отправка формы добавления напоминания о тренировке.
   */
  function onReminderSubmit(e) {
    if (e) e.preventDefault();

    var timeEl = byId("wkRemTime");
    var enabledEl = byId("wkRemEnabled");
    var btn = byId("wkRemAddBtn");

    // Нужен хотя бы один выбранный день.
    if (!state.remDays.length) {
      toast(pick("Выберите хотя бы один день недели", "Pick at least one weekday"));
      haptic("error");
      return;
    }

    var time = (timeEl && timeEl.value || "").trim();
    if (!time) {
      toast(pick("Укажите время напоминания", "Set the reminder time"));
      haptic("error");
      if (timeEl) timeEl.focus();
      return;
    }

    // Отдаём дни отсортированными по возрастанию для предсказуемого порядка.
    var weekdays = state.remDays.slice().sort(function (a, b) {
      return a - b;
    });

    var payload = {
      weekdays: weekdays,
      time: time,
      enabled: !!(enabledEl && enabledEl.checked)
    };

    if (btn) btn.disabled = true;
    App.showLoading();

    App.api
      .addTrainingReminder(payload)
      .then(function () {
        haptic("success");
        toast(pick("Напоминание добавлено", "Reminder added"));
        resetReminderForm();
        loadReminders();
      })
      .catch(function (err) {
        haptic("error");
        toast((err && err.message) || pick("Не удалось добавить напоминание", "Couldn’t add reminder"));
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
      .deleteTrainingReminder(id)
      .then(function () {
        toast(pick("Напоминание удалено", "Reminder deleted"));
        loadReminders();
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "✕";
        haptic("error");
        toast((err && err.message) || pick("Не удалось удалить напоминание", "Couldn’t delete reminder"));
      })
      .finally(function () {
        App.hideLoading();
      });
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

    // Чипы дней недели в форме напоминания.
    var dayChips = state.viewEl.querySelectorAll(".wk-rem-day");
    for (var d = 0; d < dayChips.length; d++) {
      dayChips[d].addEventListener("click", onWeekdayToggle);
    }

    // Форма напоминания о тренировке.
    var remForm = byId("wkRemForm");
    if (remForm) remForm.addEventListener("submit", onReminderSubmit);
  }

  /* =====================================================================
   *  КОНТРОЛЛЕР СТРАНИЦЫ
   * ===================================================================== */

  var controller = {
    /**
     * Вызывается при показе страницы: строит разметку, вешает обработчики,
     * загружает тренировки и напоминания.
     */
    onShow: function (viewEl) {
      state.viewEl = viewEl;

      // Гейтинг: тренировки — премиум-функция. Если подписки нет,
      // показываем единый paywall и выходим (доступ контролируется сервером).
      if (
        App &&
        typeof App.requirePremium === "function" &&
        !App.requirePremium(viewEl, {
          icon: "🏋️",
          title: pick("Тренировки", "Workouts"),
          desc: pick(
            "Журнал тренировок, расход калорий и баланс дня",
            "Workout log, calories burned and daily balance"
          ),
          bullets: [
            pick("Учёт тренировок и сожжённых калорий", "Track workouts and calories burned"),
            pick("Оценка калорий по MET", "MET-based calorie estimation"),
            pick("Напоминания о тренировке по дням недели", "Workout reminders by weekday")
          ]
        })
      ) {
        return;
      }

      state.wkLoading = false;
      state.remLoading = false;
      // Сбрасываем выбор дней недели в форме напоминания.
      state.remDays = [];

      // При каждом показе по умолчанию открываем сегодняшний день.
      state.date = App.todayStr();

      viewEl.innerHTML = pageTemplate();

      bindEvents();

      // Параллельно загружаем оба раздела.
      loadWorkouts();
      loadReminders();

      // Прокрутка наверх, чтобы экран не «залип» прокрученным вниз.
      App.scrollTop();
    },

    /**
     * Вызывается при уходе со страницы — освобождаем ссылки на DOM.
     */
    onHide: function () {
      state.viewEl = null;
      state.wkLoading = false;
      state.remLoading = false;
      state.remDays = [];
    }
  };

  // Публикуем контроллер и регистрируем страницу.
  window.PageWorkouts = controller;
  if (window.App && typeof App.registerPage === "function") {
    App.registerPage("workouts", controller);
  }
})();
