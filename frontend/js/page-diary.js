/**
 * page-diary.js — страница «Мой рацион» / "My Diary".
 *
 * Регистрирует контроллер страницы через App.registerPage("diary", {...}).
 * Возможности:
 *   - Переключатель даты (◀ дата ▶), по умолчанию сегодняшний день.
 *   - Загрузка дневника за выбранную дату через App.api.getDiary(date).
 *   - Отрисовка четырёх приёмов пищи (Завтрак/Обед/Ужин/Перекус),
 *     в каждом — список записей (название + ккал + кнопка удаления ✕).
 *   - Удаление записи через App.api.deleteEntry(id) с последующей перезагрузкой.
 *   - Итог калорий за день с учётом тренировок («Съедено − Сожжено = Итого»)
 *     + прогресс-бар относительно daily_goal_kcal по net_calories.
 *   - Две кнопки действий: «➕ Добавить вручную» и «🤖 Что съесть?».
 *       • Ручное добавление: форма (название, ккал, Б/Ж/У, вес — необязательно,
 *         селектор приёма пищи) + блок «Недавние» с добавлением в один тап.
 *       • «Что съесть?»: рекомендации блюд под оставшиеся КБЖУ.
 *   - Карточка «Напоминания о еде»: тумблер + три поля времени (завтрак/обед/
 *     ужин). Хранится через App.api.getNotificationSettings /
 *     saveNotificationSettings (поля meal_reminder_enabled, breakfast_time,
 *     lunch_time, dinner_time).
 *   - Пустые состояния, скелетон загрузки, экран ошибки с кнопкой «Повторить».
 *
 * Локализация: весь видимый пользователю текст оборачивается в App.pick(ru, en)
 * НА МОМЕНТ РЕНДЕРА, чтобы смена языка (App.setLang) с перерисовкой давала нужный
 * текст. Данные от API (названия блюд) и пользовательский ввод не переводятся.
 */
(function () {
  "use strict";

  /**
   * Локальный хелпер локализации. Делегирует в App.pick(ru, en); если App.pick
   * по какой-то причине ещё не готов — безопасно возвращает русский вариант.
   * Вызывается НА МОМЕНТ РЕНДЕРА, поэтому смена языка корректно перерисовывает UI.
   * @param {string} ru русский текст
   * @param {string} en английский текст
   * @returns {string}
   */
  function pick(ru, en) {
    if (App && typeof App.pick === "function") {
      return App.pick(ru, en);
    }
    return ru;
  }

  // Порядок приёмов пищи (подписи берём из App.mealLabel — он уже локализован).
  var MEAL_ORDER = ["breakfast", "lunch", "dinner", "snack"];

  // Иконки для секций приёмов пищи (чисто декоративные).
  var MEAL_ICONS = {
    breakfast: "🌅",
    lunch: "🍲",
    dinner: "🌙",
    snack: "🍏"
  };

  // Внутреннее состояние контроллера страницы.
  var state = {
    date: null,        // текущая выбранная дата "YYYY-MM-DD"
    viewEl: null,      // корневой элемент страницы (#view)
    loading: false,    // флаг, чтобы не запускать параллельные перезагрузки
    day: null,         // последний загруженный DiaryDayOut (для модалок)
    panel: null        // открытая панель: "manual" | "recommend" | null
  };

  /**
   * Прибавляет к дате в формате ISO ("YYYY-MM-DD") заданное число дней
   * и возвращает новую дату в том же формате. Работает в локальной зоне
   * без риска «уплыть» из-за часовых поясов (используем полдень).
   * @param {string} isoDate "YYYY-MM-DD"
   * @param {number} deltaDays смещение в днях (может быть отрицательным)
   * @returns {string} новая дата "YYYY-MM-DD"
   */
  function shiftDate(isoDate, deltaDays) {
    var parts = String(isoDate).split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1; // месяцы в Date считаются с нуля
    var d = parseInt(parts[2], 10);
    // 12:00 локального времени защищает от смещения через границу суток.
    var dt = new Date(y, m, d, 12, 0, 0, 0);
    dt.setDate(dt.getDate() + deltaDays);
    var yy = dt.getFullYear();
    var mm = String(dt.getMonth() + 1).padStart(2, "0");
    var dd = String(dt.getDate()).padStart(2, "0");
    return yy + "-" + mm + "-" + dd;
  }

  /**
   * Человеко-читаемая подпись даты для переключателя.
   * Сегодня -> «Сегодня»/"Today", вчера -> «Вчера»/"Yesterday",
   * завтра -> «Завтра»/"Tomorrow", иначе «18 июня 2026» / "18 June 2026".
   * Локализуется на момент рендера через App.pick.
   * @param {string} isoDate "YYYY-MM-DD"
   * @returns {string}
   */
  function humanDate(isoDate) {
    var today = App.todayStr();
    if (isoDate === today) {
      return pick("Сегодня", "Today");
    }
    if (isoDate === shiftDate(today, -1)) {
      return pick("Вчера", "Yesterday");
    }
    if (isoDate === shiftDate(today, 1)) {
      return pick("Завтра", "Tomorrow");
    }
    var monthsRu = [
      "января", "февраля", "марта", "апреля", "мая", "июня",
      "июля", "августа", "сентября", "октября", "ноября", "декабря"
    ];
    var monthsEn = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    var parts = String(isoDate).split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(d) || !monthsRu[m]) {
      return isoDate; // запасной вариант, если дата вдруг некорректна
    }
    // Формат: RU «18 июня 2026», EN "18 June 2026".
    return pick(
      d + " " + monthsRu[m] + " " + y,
      d + " " + monthsEn[m] + " " + y
    );
  }

  /**
   * HTML-разметка скелетона загрузки (мягкие «пульсирующие» плашки).
   * @returns {string}
   */
  function skeletonHtml() {
    var rows = "";
    for (var i = 0; i < MEAL_ORDER.length; i++) {
      rows +=
        '<div class="diary-meal skeleton-block">' +
        '<div class="skeleton skeleton-line skeleton-title"></div>' +
        '<div class="skeleton skeleton-line"></div>' +
        '<div class="skeleton skeleton-line short"></div>' +
        "</div>";
    }
    return (
      '<div class="diary-skeleton">' +
      '<div class="skeleton skeleton-line skeleton-total"></div>' +
      rows +
      "</div>"
    );
  }

  /**
   * Разметка одной записи приёма пищи.
   * Название блюда (entry.dish_name) — данные от API/пользователя, не переводим.
   * @param {Object} entry DiaryEntryOut
   * @returns {string}
   */
  function entryRowHtml(entry) {
    var name = App.escapeHtml(entry.dish_name || pick("Без названия", "Untitled"));
    var kcal = App.fmt(entry.calories || 0);
    // Б/Ж/У -> P/F/C (Белки/Жиры/Углеводы -> Protein/Fat/Carbs).
    var pLabel = pick("Б", "P");
    var fLabel = pick("Ж", "F");
    var cLabel = pick("У", "C");
    return (
      '<li class="diary-entry" data-id="' + entry.id + '">' +
      '<div class="diary-entry__main">' +
      '<span class="diary-entry__name">' + name + "</span>" +
      '<span class="diary-entry__macros">' + pLabel + " " + App.fmt(entry.proteins || 0) +
      " · " + fLabel + " " + App.fmt(entry.fats || 0) +
      " · " + cLabel + " " + App.fmt(entry.carbs || 0) + "</span>" +
      "</div>" +
      '<span class="diary-entry__kcal">' + kcal + " " + pick("ккал", "kcal") + "</span>" +
      '<button class="diary-entry__del" type="button" ' +
      'data-id="' + entry.id + '" aria-label="' + App.escapeHtml(pick("Удалить запись", "Delete entry")) +
      '" title="' + App.escapeHtml(pick("Удалить", "Delete")) + '">✕</button>' +
      "</li>"
    );
  }

  /**
   * Разметка одной секции приёма пищи.
   * @param {string} mealType "breakfast" | "lunch" | "dinner" | "snack"
   * @param {Array}  entries  список DiaryEntryOut
   * @returns {string}
   */
  function mealSectionHtml(mealType, entries) {
    entries = entries || [];
    var label = App.mealLabel(mealType); // App.mealLabel уже локализован
    var icon = MEAL_ICONS[mealType] || "🍽️";

    // Сумма калорий по приёму пищи.
    var mealKcal = 0;
    for (var i = 0; i < entries.length; i++) {
      mealKcal += Number(entries[i].calories) || 0;
    }

    var body;
    if (entries.length === 0) {
      // Пустое состояние конкретного приёма пищи.
      body = '<p class="diary-meal__empty">' +
        App.escapeHtml(pick("Пока ничего не добавлено", "Nothing added yet")) + "</p>";
    } else {
      var rows = "";
      for (var j = 0; j < entries.length; j++) {
        rows += entryRowHtml(entries[j]);
      }
      body = '<ul class="diary-meal__list">' + rows + "</ul>";
    }

    return (
      '<section class="card diary-meal">' +
      '<header class="diary-meal__head">' +
      '<span class="diary-meal__title">' +
      '<span class="diary-meal__icon">' + icon + "</span> " +
      App.escapeHtml(label) +
      "</span>" +
      '<span class="diary-meal__kcal">' + App.fmt(mealKcal) + " " + pick("ккал", "kcal") + "</span>" +
      "</header>" +
      body +
      "</section>"
    );
  }

  /**
   * Разметка карточки с итогом дня и прогресс-баром цели.
   * Если за день есть сожжённые калории (total_burned > 0), показываем
   * баланс «Съедено X − Сожжено Y = Итого Z ккал», а прогресс-бар
   * относительно цели считаем по net_calories. Иначе — как раньше.
   * @param {Object} day DiaryDayOut
   * @returns {string}
   */
  function totalsHtml(day) {
    var eaten = Number(day.total_calories) || 0;
    var burned = Number(day.total_burned) || 0;
    // net_calories с сервера; если поля нет — считаем сами.
    var net = (day.net_calories !== undefined && day.net_calories !== null)
      ? Number(day.net_calories)
      : eaten - burned;
    var goal = day.daily_goal_kcal; // может быть null

    var kcal = pick("ккал", "kcal");

    // Значение, относительно которого считаем прогресс и остаток.
    // При наличии тренировок учитываем «чистые» калории.
    var hasBurned = burned > 0;
    var basis = hasBurned ? net : eaten;

    // Блок баланса с учётом тренировок (только если что-то сожжено).
    var balanceBlock = "";
    if (hasBurned) {
      balanceBlock =
        '<div class="diary-balance">' +
        '<span class="diary-balance__part diary-balance__eaten">' +
        App.escapeHtml(pick("Съедено", "Eaten")) + " " + App.fmt(eaten) + "</span>" +
        '<span class="diary-balance__op">−</span>' +
        '<span class="diary-balance__part diary-balance__burned">' +
        App.escapeHtml(pick("Сожжено", "Burned")) + " " + App.fmt(burned) + "</span>" +
        '<span class="diary-balance__op">=</span>' +
        '<span class="diary-balance__part diary-balance__net">' +
        App.escapeHtml(pick("Итого", "Total")) + " " + App.fmt(net) + " " + kcal + "</span>" +
        "</div>";
    }

    var progressBlock;
    if (goal && goal > 0) {
      var pct = Math.round((basis / goal) * 100);
      var width = Math.max(0, Math.min(100, pct)); // ширину ограничиваем 0..100%
      var over = basis > goal;
      var remaining = goal - basis;

      var hint;
      if (over) {
        hint = pick("Превышение на ", "Over by ") + App.fmt(Math.abs(remaining)) + " " + kcal;
      } else {
        hint = pick("Осталось ", "Remaining ") + App.fmt(remaining) + " " + kcal;
      }

      progressBlock =
        '<div class="diary-progress">' +
        '<div class="diary-progress__track">' +
        '<div class="diary-progress__fill' + (over ? " is-over" : "") + '" ' +
        'style="width:' + width + '%"></div>' +
        "</div>" +
        '<div class="diary-progress__labels">' +
        '<span>' + App.fmt(basis) + " / " + App.fmt(goal) + " " + kcal +
        (hasBurned ? pick(" (с учётом тренировок)", " (incl. workouts)") : "") + "</span>" +
        '<span class="diary-progress__hint' + (over ? " is-over" : "") + '">' +
        App.escapeHtml(hint) + "</span>" +
        "</div>" +
        "</div>";
    } else {
      // Цель не задана — подсказываем перейти в аккаунт.
      progressBlock =
        '<p class="diary-total__nogoal">' +
        App.escapeHtml(pick(
          "Цель калорий не задана. Установите её в разделе «Мой аккаунт».",
          "Calorie goal is not set. Set it in the “My Account” section."
        )) + "</p>";
    }

    // Главное число карточки: при наличии тренировок показываем net,
    // иначе — съеденные калории (как и было раньше).
    var headValue = hasBurned ? net : eaten;
    var headCaption = hasBurned
      ? pick("Итого за день (нетто)", "Daily total (net)")
      : pick("Итого за день", "Daily total");

    return (
      '<section class="card diary-total">' +
      '<div class="diary-total__row">' +
      '<span class="diary-total__caption">' + App.escapeHtml(headCaption) + "</span>" +
      '<span class="diary-total__value">' + App.fmt(headValue) + " " + kcal + "</span>" +
      "</div>" +
      balanceBlock +
      '<div class="diary-total__macros">' +
      App.escapeHtml(pick("Белки", "Protein")) + " " + App.fmt(day.total_proteins || 0) + " " + pick("г", "g") + " · " +
      App.escapeHtml(pick("Жиры", "Fat")) + " " + App.fmt(day.total_fats || 0) + " " + pick("г", "g") + " · " +
      App.escapeHtml(pick("Углеводы", "Carbs")) + " " + App.fmt(day.total_carbs || 0) + " " + pick("г", "g") +
      "</div>" +
      progressBlock +
      "</section>"
    );
  }

  /**
   * Возвращает true, если пользователь премиум (через единый App.isPremium).
   * Базовый дневник бесплатен; платная только AI-рекомендация «Что съесть?».
   * @returns {boolean}
   */
  function isPremium() {
    return !!(App && typeof App.isPremium === "function" && App.isPremium());
  }

  /**
   * Разметка панели действий рациона: «➕ Добавить вручную» и «🤖 Что съесть?».
   * Кнопка «Что съесть?» — платная: для бесплатных пользователей помечаем её
   * замком (🔒). Контроль доступа серверный, фронт лишь показывает paywall.
   * @returns {string}
   */
  function actionsHtml() {
    var locked = !isPremium();
    var recommendText = pick("🤖 Что съесть?", "🤖 What to eat?");
    // Для бесплатного пользователя добавляем замок и пометку платной фичи.
    var recommendLabel = locked ? recommendText + " 🔒" : recommendText;
    var recommendCls =
      "btn btn--ghost diary-actions__btn diary-actions__btn--recommend" +
      (locked ? " is-locked" : "");

    return (
      '<div class="diary-actions">' +
      '<button class="btn btn--ghost diary-actions__btn" type="button" ' +
      'data-action="manual">' + App.escapeHtml(pick("➕ Добавить вручную", "➕ Add manually")) + "</button>" +
      '<button class="' + recommendCls + '" type="button" ' +
      'data-action="recommend"' + (locked ? ' data-locked="1"' : "") + ">" +
      App.escapeHtml(recommendLabel) +
      "</button>" +
      "</div>" +
      // Контейнер для разворачиваемой панели (ручной ввод / рекомендации).
      '<div id="diary-panel" class="diary-panel"></div>'
    );
  }

  /**
   * Разметка переключателя даты (◀ дата ▶).
   * @returns {string}
   */
  function dateBarHtml() {
    return (
      '<div class="diary-datebar card">' +
      '<button class="diary-datebar__nav" type="button" data-nav="prev" ' +
      'aria-label="' + App.escapeHtml(pick("Предыдущий день", "Previous day")) + '">◀</button>' +
      '<div class="diary-datebar__label">' +
      '<span class="diary-datebar__date">' + App.escapeHtml(humanDate(state.date)) + "</span>" +
      '<span class="diary-datebar__iso">' + App.escapeHtml(state.date) + "</span>" +
      "</div>" +
      '<button class="diary-datebar__nav" type="button" data-nav="next" ' +
      'aria-label="' + App.escapeHtml(pick("Следующий день", "Next day")) + '">▶</button>' +
      "</div>"
    );
  }

  /**
   * Полная отрисовка дня (итоги + кнопки действий + 4 секции приёмов пищи).
   * @param {Object} day DiaryDayOut
   */
  function renderDay(day) {
    var content = document.getElementById("diary-content");
    if (!content) return;

    // Запоминаем день для модалок «Что съесть?» (нужны остатки КБЖУ).
    state.day = day;

    // Безопасные значения на случай неполного ответа сервера.
    var meals = day.meals || {};

    var sections = "";
    for (var i = 0; i < MEAL_ORDER.length; i++) {
      var type = MEAL_ORDER[i];
      sections += mealSectionHtml(type, meals[type]);
    }

    // Подсчёт общего количества записей за день для пустого состояния.
    var totalEntries = 0;
    for (var j = 0; j < MEAL_ORDER.length; j++) {
      var arr = meals[MEAL_ORDER[j]] || [];
      totalEntries += arr.length;
    }

    var emptyDayHint = "";
    if (totalEntries === 0) {
      emptyDayHint =
        '<div class="diary-empty">' +
        '<div class="diary-empty__icon">🍽️</div>' +
        '<p class="diary-empty__title">' +
        App.escapeHtml(pick("За этот день записей нет", "No entries for this day")) + "</p>" +
        '<p class="diary-empty__text">' +
        App.escapeHtml(pick(
          "Откройте раздел «Определение», чтобы распознать блюдо, либо добавьте запись вручную.",
          "Open the “Scan” section to recognize a dish, or add an entry manually."
        )) + "</p>" +
        "</div>";
    }

    content.innerHTML =
      totalsHtml(day) + actionsHtml() + emptyDayHint + sections +
      // Контейнер карточки «Напоминания о еде» (рисуется отдельно).
      '<div id="diary-notif" class="diary-notif"></div>';

    // Навешиваем обработчики удаления на кнопки ✕.
    var delButtons = content.querySelectorAll(".diary-entry__del");
    for (var k = 0; k < delButtons.length; k++) {
      delButtons[k].addEventListener("click", onDeleteClick);
    }

    // Навешиваем обработчики на кнопки действий (ручной ввод / рекомендации).
    var actionButtons = content.querySelectorAll(".diary-actions__btn");
    for (var a = 0; a < actionButtons.length; a++) {
      actionButtons[a].addEventListener("click", onActionClick);
    }

    // Если перед перезагрузкой была открыта панель — восстанавливаем её.
    if (state.panel === "manual") {
      openManualPanel();
    } else if (state.panel === "recommend") {
      // Платную панель восстанавливаем с учётом статуса: free -> paywall.
      if (isPremium()) {
        openRecommendPanel();
      } else {
        openRecommendPaywall();
      }
    }

    // Карточка напоминаний о еде (загружается асинхронно, со своим состоянием).
    loadMealReminders();
  }

  /**
   * Отрисовка состояния ошибки с кнопкой «Повторить».
   * @param {string} message текст ошибки
   */
  function renderError(message) {
    var content = document.getElementById("diary-content");
    if (!content) return;
    content.innerHTML =
      '<div class="card diary-error">' +
      '<div class="diary-error__icon">⚠️</div>' +
      '<p class="diary-error__title">' +
      App.escapeHtml(pick("Не удалось загрузить рацион", "Failed to load diary")) + "</p>" +
      '<p class="diary-error__text">' +
      App.escapeHtml(message || pick("Неизвестная ошибка", "Unknown error")) + "</p>" +
      '<button class="btn btn--cta diary-error__retry" type="button">' +
      App.escapeHtml(pick("Повторить", "Retry")) + "</button>" +
      "</div>";

    var retryBtn = content.querySelector(".diary-error__retry");
    if (retryBtn) {
      retryBtn.addEventListener("click", function () {
        loadAndRender();
      });
    }
  }

  /**
   * Загрузка данных за текущую дату и их отрисовка.
   * Показывает скелетон на время загрузки, ошибку — при сбое.
   */
  function loadAndRender() {
    if (state.loading) return; // защита от двойных запросов
    state.loading = true;

    var content = document.getElementById("diary-content");
    if (content) {
      content.innerHTML = skeletonHtml();
    }

    App.api
      .getDiary(state.date)
      .then(function (day) {
        // Кладём в кэш состояния приложения (необязательно, но полезно).
        if (App.state && App.state.diaryByDate) {
          App.state.diaryByDate[state.date] = day;
        }
        renderDay(day);
      })
      .catch(function (err) {
        renderError(
          (err && err.message) ||
          pick("Проблема с сетью. Проверьте соединение.", "Network problem. Check your connection.")
        );
      })
      .then(function () {
        // finally-аналог: снимаем флаг загрузки в любом случае.
        state.loading = false;
      });
  }

  /**
   * Обработчик клика по кнопке удаления записи.
   * Удаляет запись на сервере и перезагружает день.
   * @param {Event} ev
   */
  function onDeleteClick(ev) {
    var btn = ev.currentTarget;
    var id = parseInt(btn.getAttribute("data-id"), 10);
    if (isNaN(id)) return;

    // Защита от повторных кликов по той же кнопке.
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "…";

    App.haptic && App.haptic("light");
    App.showLoading();

    App.api
      .deleteEntry(id)
      .then(function () {
        App.toast(pick("Запись удалена", "Entry deleted"));
        // Сбрасываем кэш по дате и перезагружаем актуальные данные.
        if (App.state && App.state.diaryByDate) {
          delete App.state.diaryByDate[state.date];
        }
        loadAndRender();
      })
      .catch(function (err) {
        // Возвращаем кнопку в исходное состояние при ошибке.
        btn.disabled = false;
        btn.textContent = "✕";
        App.toast((err && err.message) || pick("Не удалось удалить запись", "Failed to delete entry"));
      })
      .then(function () {
        App.hideLoading();
      });
  }

  // ===========================================================================
  // ДЕЙСТВИЯ: ручное добавление и рекомендации.
  // ===========================================================================

  /**
   * Клик по кнопке действия в панели рациона.
   * Открывает соответствующую панель либо сворачивает её при повторном клике.
   * @param {Event} ev
   */
  function onActionClick(ev) {
    var action = ev.currentTarget.getAttribute("data-action");
    App.haptic && App.haptic("light");

    // «Что съесть?» — платная фича. Для бесплатных пользователей вместо панели
    // рекомендаций показываем единый paywall (ведёт на экран подписки).
    // Базовый дневник (ручной ввод, недавние, удаление, баланс) остаётся бесплатным.
    if (action === "recommend" && !isPremium()) {
      state.panel = "recommend";
      syncActionButtons();
      openRecommendPaywall();
      return;
    }

    // Повторный клик по той же кнопке закрывает панель.
    if (state.panel === action) {
      state.panel = null;
      var panel = document.getElementById("diary-panel");
      if (panel) panel.innerHTML = "";
      syncActionButtons();
      return;
    }

    state.panel = action;
    syncActionButtons();

    if (action === "manual") {
      openManualPanel();
    } else if (action === "recommend") {
      openRecommendPanel();
    }
  }

  /**
   * Показывает единый paywall для платной фичи «Что съесть?» в области панели
   * действий (без ухода со страницы). Кнопка внутри ведёт на экран подписки.
   * Контроль доступа серверный — это лишь визуальная заглушка.
   */
  function openRecommendPaywall() {
    var panel = document.getElementById("diary-panel");
    if (!panel) return;

    if (App && typeof App.paywall === "function") {
      App.paywall(panel, {
        icon: "🤖",
        title: pick("Что съесть?", "What to eat?"),
        desc: pick(
          "AI подберёт блюда под остаток вашей дневной нормы КБЖУ",
          "AI will suggest dishes to fit your remaining daily calories and macros"
        ),
        bullets: [
          pick("Персональные рекомендации под цель", "Personalized recommendations for your goal"),
          pick("Учёт остатка калорий и БЖУ за день", "Accounts for remaining calories and macros"),
          pick("Добавление подсказанного блюда в один тап", "Add a suggested dish in one tap")
        ]
      });
      return;
    }

    // Запасной вариант, если единый paywall недоступен — ведём в подписку кнопкой.
    panel.innerHTML =
      '<section class="card diary-recommend diary-recommend--locked">' +
      '<h2 class="diary-recommend__title">🔒 ' + App.escapeHtml(pick("Что съесть?", "What to eat?")) + "</h2>" +
      '<p class="diary-recommend__sub">' +
      App.escapeHtml(pick("AI-подсказки доступны по подписке.", "AI suggestions are available with a subscription.")) + "</p>" +
      '<button type="button" class="btn btn--cta btn-block diary-recommend__subscribe">' +
      App.escapeHtml(pick("Оформить подписку", "Get subscription")) + "</button>" +
      "</section>";
    var subBtn = panel.querySelector(".diary-recommend__subscribe");
    if (subBtn) {
      subBtn.addEventListener("click", function () {
        App.haptic && App.haptic("light");
        if (App && typeof App.navigate === "function") App.navigate("subscription");
      });
    }
  }

  /**
   * Подсвечивает активную кнопку действия в соответствии с открытой панелью.
   */
  function syncActionButtons() {
    var content = document.getElementById("diary-content");
    if (!content) return;
    var buttons = content.querySelectorAll(".diary-actions__btn");
    for (var i = 0; i < buttons.length; i++) {
      var act = buttons[i].getAttribute("data-action");
      buttons[i].classList.toggle("is-active", act === state.panel);
    }
  }

  /**
   * Возвращает разметку чипов выбора приёма пищи.
   * Подписи берём из App.mealLabel — он уже локализован.
   * @param {string} selected выбранный тип
   * @param {string} attr     имя data-атрибута (например "manual-meal")
   * @returns {string}
   */
  function mealChipsHtml(selected, attr) {
    var chips = "";
    for (var i = 0; i < MEAL_ORDER.length; i++) {
      var t = MEAL_ORDER[i];
      var active = t === selected ? " is-active" : "";
      chips +=
        '<button type="button" class="meal-chip' + active + '" ' +
        "data-" + attr + '="' + t + '">' +
        App.escapeHtml(App.mealLabel(t)) +
        "</button>";
    }
    return '<div class="meal-chips">' + chips + "</div>";
  }

  // ---------------------------------------------------------------------------
  // Ручное добавление блюда.
  // ---------------------------------------------------------------------------

  /**
   * Открывает панель ручного добавления: форма + блок «Недавние».
   */
  function openManualPanel() {
    var panel = document.getElementById("diary-panel");
    if (!panel) return;

    panel.innerHTML =
      '<section class="card diary-manual">' +
      '<h2 class="diary-manual__title">' +
      App.escapeHtml(pick("Добавить вручную", "Add manually")) + "</h2>" +
      '<form class="diary-manual__form" id="diary-manual-form" novalidate>' +
      // Название блюда.
      '<label class="field">' +
      '<span class="field__label">' + App.escapeHtml(pick("Название блюда", "Dish name")) + "</span>" +
      '<input class="field__input" type="text" name="dish_name" ' +
      'placeholder="' + App.escapeHtml(pick("Например, овсянка с бананом", "e.g. oatmeal with banana")) +
      '" maxlength="120" required>' +
      "</label>" +
      // Калории.
      '<label class="field">' +
      '<span class="field__label">' + App.escapeHtml(pick("Калории, ккал", "Calories, kcal")) + "</span>" +
      '<input class="field__input" type="number" name="calories" ' +
      'inputmode="numeric" min="0" step="1" placeholder="0" required>' +
      "</label>" +
      // Б / Ж / У в одну строку.
      '<div class="diary-manual__macros">' +
      '<label class="field diary-manual__macro">' +
      '<span class="field__label">' + App.escapeHtml(pick("Белки, г", "Protein, g")) + "</span>" +
      '<input class="field__input" type="number" name="proteins" ' +
      'inputmode="decimal" min="0" step="0.1" placeholder="0">' +
      "</label>" +
      '<label class="field diary-manual__macro">' +
      '<span class="field__label">' + App.escapeHtml(pick("Жиры, г", "Fat, g")) + "</span>" +
      '<input class="field__input" type="number" name="fats" ' +
      'inputmode="decimal" min="0" step="0.1" placeholder="0">' +
      "</label>" +
      '<label class="field diary-manual__macro">' +
      '<span class="field__label">' + App.escapeHtml(pick("Углеводы, г", "Carbs, g")) + "</span>" +
      '<input class="field__input" type="number" name="carbs" ' +
      'inputmode="decimal" min="0" step="0.1" placeholder="0">' +
      "</label>" +
      "</div>" +
      // Вес порции (необязательно, для удобства — на КБЖУ не влияет).
      '<label class="field">' +
      '<span class="field__label">' + App.escapeHtml(pick("Вес порции, г", "Portion weight, g")) +
      ' <span class="field__hint">' + App.escapeHtml(pick("(необязательно)", "(optional)")) + "</span></span>" +
      '<input class="field__input" type="number" name="portion_g" ' +
      'inputmode="numeric" min="0" step="1" placeholder="—">' +
      "</label>" +
      // Селектор приёма пищи.
      '<div class="diary-manual__meal">' +
      '<span class="field__label">' + App.escapeHtml(pick("Приём пищи", "Meal")) + "</span>" +
      mealChipsHtml("breakfast", "manual-meal") +
      "</div>" +
      '<button class="btn btn--cta btn-block diary-manual__submit" type="submit">' +
      App.escapeHtml(pick("Добавить в рацион", "Add to diary")) + "</button>" +
      "</form>" +
      // Контейнер блока «Недавние».
      '<div id="diary-recent" class="recent"></div>' +
      "</section>";

    // Выбранный приём пищи для ручной формы (по умолчанию завтрак).
    var manualMeal = "breakfast";

    var mealsWrap = panel.querySelector(".diary-manual__meal .meal-chips");
    if (mealsWrap) {
      mealsWrap.addEventListener("click", function (ev) {
        var btn = ev.target.closest(".meal-chip");
        if (!btn) return;
        var t = btn.getAttribute("data-manual-meal");
        if (!t) return;
        manualMeal = t;
        App.haptic && App.haptic("light");
        var all = mealsWrap.querySelectorAll(".meal-chip");
        for (var i = 0; i < all.length; i++) {
          all[i].classList.toggle(
            "is-active",
            all[i].getAttribute("data-manual-meal") === t
          );
        }
      });
    }

    var form = panel.querySelector("#diary-manual-form");
    if (form) {
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        submitManual(form, manualMeal);
      });
    }

    // Подгружаем недавние блюда (асинхронно, со своим состоянием загрузки).
    loadRecent();
  }

  /**
   * Парсит и валидирует данные ручной формы и отправляет их на сервер.
   * @param {HTMLFormElement} form
   * @param {string} mealType выбранный приём пищи
   */
  function submitManual(form, mealType) {
    var name = (form.dish_name.value || "").trim();
    var calories = Number(form.calories.value);
    var proteins = Number(form.proteins.value) || 0;
    var fats = Number(form.fats.value) || 0;
    var carbs = Number(form.carbs.value) || 0;

    if (!name) {
      App.toast(pick("Укажите название блюда", "Enter a dish name"));
      try { form.dish_name.focus(); } catch (e) {}
      return;
    }
    if (!isFinite(calories) || calories < 0) {
      App.toast(pick("Укажите калорийность блюда", "Enter the dish calories"));
      try { form.calories.focus(); } catch (e) {}
      return;
    }

    var entry = {
      date: state.date,
      meal_type: mealType,
      dish_name: name,
      calories: Math.round(calories),
      proteins: proteins,
      fats: fats,
      carbs: carbs
    };

    var submitBtn = form.querySelector(".diary-manual__submit");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = pick("Добавляем…", "Adding…");
    }
    App.showLoading();

    App.api
      .addManualFood(entry)
      .then(function () {
        App.haptic && App.haptic("success");
        App.toast(pick("Добавлено: ", "Added: ") + App.mealLabel(mealType));
        // Закрываем панель и инвалидируем кэш дня.
        state.panel = null;
        if (App.state && App.state.diaryByDate) {
          delete App.state.diaryByDate[state.date];
        }
        loadAndRender();
      })
      .catch(function (err) {
        App.haptic && App.haptic("error");
        App.toast((err && err.message) || pick("Не удалось добавить блюдо", "Failed to add dish"));
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = pick("Добавить в рацион", "Add to diary");
        }
      })
      .then(function () {
        App.hideLoading();
      });
  }

  // ---------------------------------------------------------------------------
  // Блок «Недавние» — добавление ранее введённых блюд в один тап.
  // ---------------------------------------------------------------------------

  /**
   * Загружает список недавних блюд и рисует их карточками.
   */
  function loadRecent() {
    var box = document.getElementById("diary-recent");
    if (!box) return;

    box.innerHTML =
      '<h3 class="recent__title">' + App.escapeHtml(pick("Недавние", "Recent")) + "</h3>" +
      '<div class="recent__list">' +
      '<div class="skeleton skeleton-block recent__skeleton"></div>' +
      '<div class="skeleton skeleton-block recent__skeleton"></div>' +
      "</div>";

    App.api
      .getRecentFoods()
      .then(function (res) {
        var items = (res && res.items) || [];
        renderRecent(items);
      })
      .catch(function () {
        // Недавние — вспомогательный блок: при ошибке просто скрываем его.
        if (box) box.innerHTML = "";
      });
  }

  /**
   * Рисует карточки недавних блюд. Каждое можно добавить в один тап:
   * выбираем приём пищи чипами вверху блока и добавляем блюдо.
   * @param {Array} items список {dish_name, calories, proteins, fats, carbs}
   */
  function renderRecent(items) {
    var box = document.getElementById("diary-recent");
    if (!box) return;

    if (!items.length) {
      box.innerHTML =
        '<h3 class="recent__title">' + App.escapeHtml(pick("Недавние", "Recent")) + "</h3>" +
        '<p class="recent__empty">' +
        App.escapeHtml(pick(
          "Здесь появятся блюда, которые вы добавляли вручную.",
          "Dishes you add manually will appear here."
        )) + "</p>";
      return;
    }

    // Выбор приёма пищи для быстрого добавления из «Недавних».
    var recentMeal = "breakfast";

    // Б/Ж/У -> P/F/C.
    var pLabel = pick("Б", "P");
    var fLabel = pick("Ж", "F");
    var cLabel = pick("У", "C");
    var kcal = pick("ккал", "kcal");

    var cards = "";
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      cards +=
        '<button type="button" class="recent__item" data-idx="' + i + '">' +
        '<span class="recent__name">' +
        App.escapeHtml(it.dish_name || pick("Без названия", "Untitled")) + "</span>" +
        '<span class="recent__macros">' +
        App.fmt(it.calories || 0) + " " + kcal + " · " + pLabel + " " + App.fmt(it.proteins || 0) +
        " · " + fLabel + " " + App.fmt(it.fats || 0) + " · " + cLabel + " " + App.fmt(it.carbs || 0) +
        "</span>" +
        '<span class="recent__add" aria-hidden="true">＋</span>' +
        "</button>";
    }

    box.innerHTML =
      '<h3 class="recent__title">' + App.escapeHtml(pick("Недавние", "Recent")) + "</h3>" +
      '<div class="recent__meal">' +
      '<span class="field__label">' + App.escapeHtml(pick("Добавить как", "Add as")) + "</span>" +
      mealChipsHtml("breakfast", "recent-meal") +
      "</div>" +
      '<div class="recent__list">' + cards + "</div>";

    // Переключение приёма пищи для блока «Недавние».
    var mealsWrap = box.querySelector(".recent__meal .meal-chips");
    if (mealsWrap) {
      mealsWrap.addEventListener("click", function (ev) {
        var btn = ev.target.closest(".meal-chip");
        if (!btn) return;
        var t = btn.getAttribute("data-recent-meal");
        if (!t) return;
        recentMeal = t;
        App.haptic && App.haptic("light");
        var all = mealsWrap.querySelectorAll(".meal-chip");
        for (var i = 0; i < all.length; i++) {
          all[i].classList.toggle(
            "is-active",
            all[i].getAttribute("data-recent-meal") === t
          );
        }
      });
    }

    // Быстрое добавление по тапу на карточку блюда.
    var list = box.querySelector(".recent__list");
    if (list) {
      list.addEventListener("click", function (ev) {
        var card = ev.target.closest(".recent__item");
        if (!card) return;
        var idx = parseInt(card.getAttribute("data-idx"), 10);
        if (isNaN(idx) || !items[idx]) return;
        quickAdd(items[idx], recentMeal, card);
      });
    }
  }

  /**
   * Добавляет произвольное блюдо в рацион выбранного приёма пищи.
   * Используется и «Недавними», и рекомендациями.
   * @param {Object} food {dish_name, calories, proteins, fats, carbs}
   * @param {string} mealType
   * @param {HTMLElement} [trigger] кнопка-инициатор (для блокировки)
   */
  function quickAdd(food, mealType, trigger) {
    var entry = {
      date: state.date,
      meal_type: mealType,
      dish_name: food.dish_name || pick("Без названия", "Untitled"),
      calories: Math.round(Number(food.calories) || 0),
      proteins: Number(food.proteins) || 0,
      fats: Number(food.fats) || 0,
      carbs: Number(food.carbs) || 0
    };

    if (trigger) trigger.disabled = true;
    App.haptic && App.haptic("light");
    App.showLoading();

    App.api
      .addManualFood(entry)
      .then(function () {
        App.haptic && App.haptic("success");
        App.toast(pick("Добавлено: ", "Added: ") + App.mealLabel(mealType));
        state.panel = null;
        if (App.state && App.state.diaryByDate) {
          delete App.state.diaryByDate[state.date];
        }
        loadAndRender();
      })
      .catch(function (err) {
        App.haptic && App.haptic("error");
        App.toast((err && err.message) || pick("Не удалось добавить блюдо", "Failed to add dish"));
        if (trigger) trigger.disabled = false;
      })
      .then(function () {
        App.hideLoading();
      });
  }

  // ---------------------------------------------------------------------------
  // Рекомендации «Что съесть?».
  // ---------------------------------------------------------------------------

  /**
   * Открывает панель рекомендаций, считает остатки КБЖУ и запрашивает варианты.
   */
  function openRecommendPanel() {
    var panel = document.getElementById("diary-panel");
    if (!panel) return;

    panel.innerHTML =
      '<section class="card diary-recommend">' +
      '<h2 class="diary-recommend__title">' +
      App.escapeHtml(pick("Что съесть?", "What to eat?")) + "</h2>" +
      '<p class="diary-recommend__sub">' +
      App.escapeHtml(pick(
        "Подбираем блюда под остаток дневной нормы.",
        "Suggesting dishes to fit your remaining daily allowance."
      )) + "</p>" +
      '<div id="diary-recommend-body" class="diary-recommend__body">' +
      // Скелетон на время запроса.
      '<div class="skeleton skeleton-block diary-recommend__skeleton"></div>' +
      '<div class="skeleton skeleton-block diary-recommend__skeleton"></div>' +
      '<div class="skeleton skeleton-block diary-recommend__skeleton"></div>' +
      "</div>" +
      "</section>";

    requestRecommendations();
  }

  /**
   * Считает остатки КБЖУ и вызывает App.api.recommendFood.
   */
  function requestRecommendations() {
    var day = state.day || {};
    var profile = (App.state && App.state.profile) || {};

    var goalKcal = Number(day.daily_goal_kcal) || 0;
    var eaten = Number(day.total_calories) || 0;

    var remainingCalories = Math.max(0, goalKcal - eaten);
    var remainingProteins = Math.max(0, (Number(profile.target_proteins) || 0) - (Number(day.total_proteins) || 0));
    var remainingFats = Math.max(0, (Number(profile.target_fats) || 0) - (Number(day.total_fats) || 0));
    var remainingCarbs = Math.max(0, (Number(profile.target_carbs) || 0) - (Number(day.total_carbs) || 0));

    var payload = {
      remaining_calories: Math.round(remainingCalories),
      remaining_proteins: Math.round(remainingProteins),
      remaining_fats: Math.round(remainingFats),
      remaining_carbs: Math.round(remainingCarbs),
      time_of_day: timeOfDay()
    };
    if (profile.diet_goal) {
      payload.diet_goal = profile.diet_goal;
    }

    App.api
      .recommendFood(payload)
      .then(function (res) {
        var suggestions = (res && res.suggestions) || [];
        renderRecommendations(suggestions, remainingCalories);
      })
      .catch(function (err) {
        renderRecommendError(
          (err && err.message) ||
          pick("Не удалось получить рекомендации.", "Failed to get recommendations.")
        );
      });
  }

  /**
   * Грубая оценка времени суток для подсказки серверу.
   * @returns {string} "morning" | "afternoon" | "evening" | "night"
   */
  function timeOfDay() {
    var h = new Date().getHours();
    if (h >= 5 && h < 11) return "morning";
    if (h >= 11 && h < 16) return "afternoon";
    if (h >= 16 && h < 22) return "evening";
    return "night";
  }

  /**
   * Рисует карточки-рекомендации. Каждую можно добавить в рацион в один тап.
   * Название и причина (dish_name, reason) приходят от API — не переводим.
   * @param {Array} suggestions [{dish_name,calories,proteins,fats,carbs,reason}]
   * @param {number} remainingCalories остаток калорий (для подсказки)
   */
  function renderRecommendations(suggestions, remainingCalories) {
    var body = document.getElementById("diary-recommend-body");
    if (!body) return;

    if (!suggestions.length) {
      body.innerHTML =
        '<p class="diary-recommend__empty">' +
        App.escapeHtml(remainingCalories <= 0
          ? pick(
              "На сегодня дневная норма уже выбрана — подсказывать нечего.",
              "Today's allowance is already used up — nothing to suggest."
            )
          : pick(
              "Сейчас нет подходящих вариантов. Попробуйте позже.",
              "No suitable options right now. Try again later."
            )) +
        "</p>";
      return;
    }

    // Селектор приёма пищи для добавления рекомендации.
    var recMeal = "breakfast";

    var kcal = pick("ккал", "kcal");
    var pLabel = pick("Б", "P");
    var fLabel = pick("Ж", "F");
    var cLabel = pick("У", "C");

    var cards = "";
    for (var i = 0; i < suggestions.length; i++) {
      var s = suggestions[i] || {};
      var reason = s.reason
        ? '<p class="diary-recommend-item__reason">' + App.escapeHtml(s.reason) + "</p>"
        : "";
      cards +=
        '<div class="diary-recommend-item" data-idx="' + i + '">' +
        '<div class="diary-recommend-item__head">' +
        '<span class="diary-recommend-item__name">' +
        App.escapeHtml(s.dish_name || pick("Блюдо", "Dish")) + "</span>" +
        '<span class="diary-recommend-item__kcal">' +
        App.fmt(s.calories || 0) + " " + kcal + "</span>" +
        "</div>" +
        '<p class="diary-recommend-item__macros">' + pLabel + " " + App.fmt(s.proteins || 0) +
        " · " + fLabel + " " + App.fmt(s.fats || 0) +
        " · " + cLabel + " " + App.fmt(s.carbs || 0) + "</p>" +
        reason +
        '<button type="button" class="btn btn--cta diary-recommend-item__add" ' +
        'data-idx="' + i + '">' + App.escapeHtml(pick("Добавить в рацион", "Add to diary")) + "</button>" +
        "</div>";
    }

    body.innerHTML =
      '<div class="diary-recommend__meal">' +
      '<span class="field__label">' + App.escapeHtml(pick("Добавить как", "Add as")) + "</span>" +
      mealChipsHtml("breakfast", "rec-meal") +
      "</div>" +
      '<div class="diary-recommend__list">' + cards + "</div>";

    // Переключение приёма пищи для рекомендаций.
    var mealsWrap = body.querySelector(".diary-recommend__meal .meal-chips");
    if (mealsWrap) {
      mealsWrap.addEventListener("click", function (ev) {
        var btn = ev.target.closest(".meal-chip");
        if (!btn) return;
        var t = btn.getAttribute("data-rec-meal");
        if (!t) return;
        recMeal = t;
        App.haptic && App.haptic("light");
        var all = mealsWrap.querySelectorAll(".meal-chip");
        for (var i = 0; i < all.length; i++) {
          all[i].classList.toggle(
            "is-active",
            all[i].getAttribute("data-rec-meal") === t
          );
        }
      });
    }

    // Добавление рекомендации по кнопке.
    var list = body.querySelector(".diary-recommend__list");
    if (list) {
      list.addEventListener("click", function (ev) {
        var addBtn = ev.target.closest(".diary-recommend-item__add");
        if (!addBtn) return;
        var idx = parseInt(addBtn.getAttribute("data-idx"), 10);
        if (isNaN(idx) || !suggestions[idx]) return;
        quickAdd(suggestions[idx], recMeal, addBtn);
      });
    }
  }

  /**
   * Состояние ошибки внутри панели рекомендаций с кнопкой «Повторить».
   * @param {string} message
   */
  function renderRecommendError(message) {
    var body = document.getElementById("diary-recommend-body");
    if (!body) return;
    body.innerHTML =
      '<div class="diary-recommend__error">' +
      '<p class="diary-recommend__error-text">' + App.escapeHtml(message) + "</p>" +
      '<button type="button" class="btn btn--ghost diary-recommend__retry">' +
      App.escapeHtml(pick("Повторить", "Retry")) + "</button>" +
      "</div>";

    var retry = body.querySelector(".diary-recommend__retry");
    if (retry) {
      retry.addEventListener("click", function () {
        App.haptic && App.haptic("light");
        body.innerHTML =
          '<div class="skeleton skeleton-block diary-recommend__skeleton"></div>' +
          '<div class="skeleton skeleton-block diary-recommend__skeleton"></div>' +
          '<div class="skeleton skeleton-block diary-recommend__skeleton"></div>';
        requestRecommendations();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Карточка «Напоминания о еде».
  //
  // Хранится через общие настройки уведомлений (NotificationSettings):
  //   meal_reminder_enabled — тумблер включения напоминаний;
  //   breakfast_time / lunch_time / dinner_time — время для завтрака/обеда/ужина.
  // На сохранение отправляем только эти поля (остальные настройки уведомлений
  // живут в своих разделах: тренировки, добавки, аккаунт).
  // ---------------------------------------------------------------------------

  // Поля времени карточки напоминаний (ключ настроек -> [рус, eng] подписи).
  // Подписи локализуем на момент рендера через pick(...).
  var MEAL_REMINDER_TIMES = [
    { key: "breakfast_time", labelRu: "Завтрак", labelEn: "Breakfast" },
    { key: "lunch_time", labelRu: "Обед", labelEn: "Lunch" },
    { key: "dinner_time", labelRu: "Ужин", labelEn: "Dinner" }
  ];

  /**
   * Безопасно приводит значение времени к строке "HH:MM" для поля type=time.
   * Сервер может вернуть "HH:MM:SS" — оставляем первые 5 символов.
   * @param {*} v
   * @returns {string}
   */
  function timeValue(v) {
    if (v == null) return "";
    var s = String(v).trim();
    if (s.length >= 5) return s.slice(0, 5);
    return s;
  }

  /**
   * Загружает настройки уведомлений и рисует карточку «Напоминания о еде».
   * Карточка вспомогательная: при ошибке показываем кнопку «Повторить».
   */
  function loadMealReminders() {
    var box = document.getElementById("diary-notif");
    if (!box) return;

    box.innerHTML =
      '<section class="card diary-notif-card">' +
      '<h2 class="diary-notif-title">' +
      App.escapeHtml(pick("Напоминания о еде", "Meal reminders")) + "</h2>" +
      '<div class="diary-notif-body">' +
      '<div class="skeleton skeleton-block diary-notif-skeleton"></div>' +
      "</div>" +
      "</section>";

    App.api
      .getNotificationSettings()
      .then(function (settings) {
        renderMealReminders(settings || {});
      })
      .catch(function (err) {
        renderMealRemindersError(
          (err && err.message) ? err.message : pick("Ошибка сети", "Network error")
        );
      });
  }

  /**
   * Рисует тело карточки «Напоминания о еде»: тумблер + три поля времени
   * и кнопку «Сохранить».
   * @param {Object} s NotificationSettingsOut
   */
  function renderMealReminders(s) {
    var box = document.getElementById("diary-notif");
    if (!box) return;

    var enabled = !!s.meal_reminder_enabled;

    var timesHtml = MEAL_REMINDER_TIMES.map(function (t) {
      return (
        '<label class="diary-notif-time">' +
        '<span class="diary-notif-time__label">' +
        App.escapeHtml(pick(t.labelRu, t.labelEn)) +
        "</span>" +
        '<input class="field__input diary-notif-time__input" type="time" ' +
        'data-diary-notif-time="' +
        App.escapeHtml(t.key) +
        '" value="' +
        App.escapeHtml(timeValue(s[t.key])) +
        '" placeholder="08:00">' +
        "</label>"
      );
    }).join("");

    box.innerHTML =
      '<section class="card diary-notif-card">' +
      '<h2 class="diary-notif-title">' +
      App.escapeHtml(pick("Напоминания о еде", "Meal reminders")) + "</h2>" +
      '<p class="diary-notif-sub">' +
      App.escapeHtml(pick(
        "Будем напоминать залогировать приёмы пищи в выбранное время.",
        "We'll remind you to log your meals at the chosen times."
      )) + "</p>" +
      '<label class="diary-notif-toggle">' +
      '<input class="diary-notif-toggle__input" type="checkbox" ' +
      'id="diary-notif-enabled"' +
      (enabled ? " checked" : "") +
      ">" +
      '<span class="diary-notif-toggle__label">' +
      App.escapeHtml(pick("Включить напоминания о еде", "Enable meal reminders")) + "</span>" +
      "</label>" +
      '<div class="diary-notif-times" id="diary-notif-times"' +
      (enabled ? "" : " hidden") +
      ">" +
      timesHtml +
      "</div>" +
      '<button type="button" class="btn btn--cta diary-notif-save" id="diary-notif-save">' +
      App.escapeHtml(pick("Сохранить", "Save")) + "</button>" +
      "</section>";

    // Тумблер показывает/скрывает поля времени.
    var toggle = box.querySelector("#diary-notif-enabled");
    var timesBox = box.querySelector("#diary-notif-times");
    if (toggle && timesBox) {
      toggle.addEventListener("change", function () {
        timesBox.hidden = !toggle.checked;
        App.haptic && App.haptic("selection");
      });
    }

    var saveBtn = box.querySelector("#diary-notif-save");
    if (saveBtn) {
      saveBtn.addEventListener("click", onSaveMealReminders);
    }
  }

  /**
   * Состояние ошибки карточки напоминаний с кнопкой «Повторить».
   * @param {string} message
   */
  function renderMealRemindersError(message) {
    var box = document.getElementById("diary-notif");
    if (!box) return;
    box.innerHTML =
      '<section class="card diary-notif-card">' +
      '<h2 class="diary-notif-title">' +
      App.escapeHtml(pick("Напоминания о еде", "Meal reminders")) + "</h2>" +
      '<div class="diary-notif-error">' +
      '<p class="diary-notif-error__text">' +
      App.escapeHtml(pick(
        "Не удалось загрузить настройки напоминаний.",
        "Failed to load reminder settings."
      )) + "</p>" +
      '<p class="diary-notif-error__msg">' + App.escapeHtml(message) + "</p>" +
      '<button type="button" class="btn btn--ghost diary-notif-retry" id="diary-notif-retry">' +
      App.escapeHtml(pick("Повторить", "Retry")) + "</button>" +
      "</div>" +
      "</section>";

    var retry = box.querySelector("#diary-notif-retry");
    if (retry) {
      retry.addEventListener("click", function () {
        App.haptic && App.haptic("light");
        loadMealReminders();
      });
    }
  }

  /**
   * Собирает значения карточки «Напоминания о еде» и сохраняет на сервере.
   * Отправляем только относящиеся к еде поля, чтобы не затрагивать остальные
   * настройки уведомлений.
   */
  function onSaveMealReminders() {
    var box = document.getElementById("diary-notif");
    if (!box) return;

    var toggle = box.querySelector("#diary-notif-enabled");
    var enabled = !!(toggle && toggle.checked);

    var payload = { meal_reminder_enabled: enabled };

    // Поля времени: пустые значения не отправляем.
    var times = box.querySelectorAll("[data-diary-notif-time]");
    for (var i = 0; i < times.length; i++) {
      var key = times[i].getAttribute("data-diary-notif-time");
      var val = (times[i].value || "").trim();
      if (key && val) {
        payload[key] = val;
      }
    }

    var saveBtn = box.querySelector("#diary-notif-save");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = pick("Сохраняем…", "Saving…");
    }
    App.showLoading();

    App.api
      .saveNotificationSettings(payload)
      .then(function (settings) {
        // Перерисовываем актуальными данными от сервера (или нашим payload).
        renderMealReminders(settings || payload);
        App.haptic && App.haptic("success");
        App.toast(pick("Напоминания о еде сохранены", "Meal reminders saved"));
      })
      .catch(function (err) {
        App.haptic && App.haptic("error");
        App.toast((err && err.message) || pick("Не удалось сохранить напоминания", "Failed to save reminders"));
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = pick("Сохранить", "Save");
        }
      })
      .then(function () {
        App.hideLoading();
      });
  }

  /**
   * Обновляет подпись даты в шапке без полной перерисовки страницы.
   */
  function updateDateLabel() {
    var dateEl = state.viewEl && state.viewEl.querySelector(".diary-datebar__date");
    var isoEl = state.viewEl && state.viewEl.querySelector(".diary-datebar__iso");
    if (dateEl) dateEl.textContent = humanDate(state.date);
    if (isoEl) isoEl.textContent = state.date;
  }

  /**
   * Переключение даты на заданное число дней и перезагрузка.
   * @param {number} delta
   */
  function changeDate(delta) {
    state.date = shiftDate(state.date, delta);
    // При смене даты закрываем открытую панель действий.
    state.panel = null;
    App.haptic && App.haptic("selection");
    updateDateLabel();
    loadAndRender();
  }

  // ---------------------------------------------------------------------------
  // Контроллер страницы для App.registerPage.
  // ---------------------------------------------------------------------------
  var controller = {
    /**
     * Вызывается при показе страницы. Строит разметку и загружает данные.
     * @param {HTMLElement} viewEl контейнер #view
     */
    onShow: function (viewEl) {
      state.viewEl = viewEl;

      // При каждом показе по умолчанию открываем сегодняшний день.
      state.date = App.todayStr();
      // Панель действий при входе на страницу закрыта.
      state.panel = null;
      state.day = null;

      // Прокручиваем к началу при входе на страницу.
      App.scrollTop && App.scrollTop();

      // Базовая разметка: переключатель даты + контейнер для контента.
      // Заголовок локализуем на момент рендера.
      viewEl.innerHTML =
        '<div class="page page-diary">' +
        '<h1 class="page__title">' + App.escapeHtml(pick("Мой рацион", "My Diary")) + "</h1>" +
        dateBarHtml() +
        '<div id="diary-content" class="diary-content"></div>' +
        "</div>";

      // Навигация по датам (◀ / ▶).
      var navButtons = viewEl.querySelectorAll(".diary-datebar__nav");
      for (var i = 0; i < navButtons.length; i++) {
        navButtons[i].addEventListener("click", function (ev) {
          var dir = ev.currentTarget.getAttribute("data-nav");
          changeDate(dir === "next" ? 1 : -1);
        });
      }

      // Загружаем данные за выбранную дату.
      loadAndRender();
    },

    /**
     * Вызывается при уходе со страницы — чистим ссылки на DOM.
     */
    onHide: function () {
      state.viewEl = null;
      state.loading = false;
      state.panel = null;
      state.day = null;
    }
  };

  // Регистрируем страницу в приложении.
  // window.PageDiary — публичная ссылка на контроллер (на случай нужды извне).
  window.PageDiary = controller;
  App.registerPage("diary", controller);
})();
