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
 *   - Кнопки действий: «➕ Добавить вручную», «🤖 Что съесть?» (премиум),
 *     «🍴 AI-план меню» (премиум) и блок шаблонов питания (премиум).
 *       • Ручное добавление: форма (название, ккал, Б/Ж/У, вес — необязательно,
 *         селектор приёма пищи) + блок «Недавние» с добавлением в один тап.
 *       • «Что съесть?» (Этап 5, премиум): выбор приёма пищи + свободный ввод
 *         «Чего хочется?» -> App.api.suggestFood (умные предложения), кнопка
 *         «🍬 Вкусняшки» -> App.api.getHealthySnacks; фолбэк — recommendFood.
 *       • «AI-план меню» (Этап 5, премиум): выбор охвата (День/Неделя) +
 *         предпочтения -> App.api.generateMealPlan; по дням приёмы пищи с КБЖУ,
 *         замена блюда -> App.api.regenerateMealItem; список покупок.
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
    panel: null,       // открытая панель: "manual" | "recommend" | "templates" | "meal-plan" | null
    // Состояние панели AI-плана меню (Этап 5): выбранный охват, предпочтения,
    // последний полученный план (для замены блюд в UI без полного перезапроса).
    planScope: "day",  // "day" | "week"
    planPrefs: "",     // текст предпочтений из поля ввода
    plan: null,        // последний MealPlanOut {days:[...], shopping_list:[...]}
    // Состояние улучшенной панели «Что съесть?» (Этап 5).
    suggestMeal: null, // выбранный приём пищи ("breakfast"... ) или null (весь день)
    suggestText: ""    // свободный ввод «Чего хочется?»
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
   * Базовый дневник бесплатен; платные только AI-фичи.
   * @returns {boolean}
   */
  function isPremium() {
    return !!(App && typeof App.isPremium === "function" && App.isPremium());
  }

  /**
   * Разметка панели действий рациона: «➕ Добавить вручную», «🤖 Что съесть?»,
   * «🍴 AI-план меню» (Этап 5) и блок шаблонов (Этап 4): «💾 Сохранить день как
   * шаблон», «📋 Шаблоны», «📅 Скопировать вчера».
   * Кнопки «Что съесть?», «AI-план меню», шаблоны и копирование — платные: для
   * бесплатных пользователей помечаем их замком (🔒). Контроль доступа серверный,
   * фронт лишь показывает paywall. Базовый дневник (ручной ввод) остаётся бесплатным.
   * @returns {string}
   */
  function actionsHtml() {
    var locked = !isPremium();
    var lockMark = locked ? " 🔒" : "";
    var lockAttr = locked ? ' data-locked="1"' : "";
    var lockCls = locked ? " is-locked" : "";

    var recommendText = pick("🤖 Что съесть?", "🤖 What to eat?");
    var recommendLabel = recommendText + lockMark;
    var recommendCls =
      "btn btn--ghost diary-actions__btn diary-actions__btn--recommend" + lockCls;

    // AI-план меню (Этап 5) — премиум. Префикс классов plan-.
    var planText = pick("🍴 AI-план меню", "🍴 AI meal plan");
    var planLabel = planText + lockMark;
    var planCls =
      "btn btn--ghost diary-actions__btn diary-actions__btn--meal-plan plan-actions__btn" + lockCls;

    // Премиум-кнопки шаблонов: вешаем замок и data-locked для free.
    var saveTplLabel = pick("💾 Сохранить день как шаблон", "💾 Save day as template") + lockMark;
    var tplListLabel = pick("📋 Шаблоны", "📋 Templates") + lockMark;
    var copyYestLabel = pick("📅 Скопировать вчера", "📅 Copy yesterday") + lockMark;

    return (
      '<div class="diary-actions">' +
      '<button class="btn btn--ghost diary-actions__btn" type="button" ' +
      'data-action="manual">' + App.escapeHtml(pick("➕ Добавить вручную", "➕ Add manually")) + "</button>" +
      '<button class="' + recommendCls + '" type="button" ' +
      'data-action="recommend"' + lockAttr + ">" +
      App.escapeHtml(recommendLabel) +
      "</button>" +
      '<button class="' + planCls + '" type="button" ' +
      'data-action="meal-plan"' + lockAttr + ">" +
      App.escapeHtml(planLabel) +
      "</button>" +
      "</div>" +
      // Блок премиум-действий с шаблонами питания (Этап 4). Префикс классов tpl-.
      // Переиспользуем контейнер .diary-actions (flex + gap) и базовый размер
      // .diary-actions__btn, чтобы кнопки выглядели в одном стиле с дневником;
      // собственные tpl-классы добавляем для адресных обработчиков/стилей.
      '<div class="diary-actions tpl-actions">' +
      '<button class="btn btn--ghost diary-actions__btn tpl-actions__btn tpl-actions__btn--save' + lockCls + '" ' +
      'type="button" data-action="tpl-save"' + lockAttr + ">" +
      App.escapeHtml(saveTplLabel) + "</button>" +
      '<button class="btn btn--ghost diary-actions__btn tpl-actions__btn tpl-actions__btn--list' + lockCls + '" ' +
      'type="button" data-action="tpl-list"' + lockAttr + ">" +
      App.escapeHtml(tplListLabel) + "</button>" +
      '<button class="btn btn--ghost diary-actions__btn tpl-actions__btn tpl-actions__btn--copy' + lockCls + '" ' +
      'type="button" data-action="tpl-copy"' + lockAttr + ">" +
      App.escapeHtml(copyYestLabel) + "</button>" +
      "</div>" +
      // Контейнер для разворачиваемой панели (ручной ввод / рекомендации /
      // шаблоны / AI-план меню).
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

    // Навешиваем обработчики на базовые кнопки действий (ручной ввод /
    // рекомендации / AI-план меню). Кнопки шаблонов исключаем
    // (:not(.tpl-actions__btn)), так как они тоже несут класс .diary-actions__btn
    // ради единого размера, но имеют собственный обработчик onTemplateActionClick.
    var actionButtons = content.querySelectorAll(
      ".diary-actions__btn:not(.tpl-actions__btn)"
    );
    for (var a = 0; a < actionButtons.length; a++) {
      actionButtons[a].addEventListener("click", onActionClick);
    }

    // Навешиваем обработчики на премиум-кнопки шаблонов (Этап 4).
    var tplButtons = content.querySelectorAll(".tpl-actions__btn");
    for (var t = 0; t < tplButtons.length; t++) {
      tplButtons[t].addEventListener("click", onTemplateActionClick);
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
    } else if (state.panel === "meal-plan") {
      // AI-план меню: free -> paywall, premium -> панель.
      if (isPremium()) {
        openMealPlanPanel();
      } else {
        openMealPlanPaywall();
      }
    } else if (state.panel === "templates") {
      // Панель списка шаблонов: free -> paywall, premium -> список.
      if (isPremium()) {
        openTemplatesPanel();
      } else {
        openTemplatesPaywall();
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
  // ДЕЙСТВИЯ: ручное добавление, рекомендации, AI-план меню.
  // ===========================================================================

  /**
   * Клик по кнопке действия в панели рациона.
   * Открывает соответствующую панель либо сворачивает её при повторном клике.
   * @param {Event} ev
   */
  function onActionClick(ev) {
    var action = ev.currentTarget.getAttribute("data-action");
    App.haptic && App.haptic("light");

    // «Что съесть?» и «AI-план меню» — платные фичи. Для бесплатных
    // пользователей вместо панели показываем единый paywall (ведёт на экран
    // подписки). Базовый дневник (ручной ввод, недавние, удаление, баланс)
    // остаётся бесплатным.
    if (action === "recommend" && !isPremium()) {
      state.panel = "recommend";
      syncActionButtons();
      openRecommendPaywall();
      return;
    }
    if (action === "meal-plan" && !isPremium()) {
      state.panel = "meal-plan";
      syncActionButtons();
      openMealPlanPaywall();
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
    } else if (action === "meal-plan") {
      openMealPlanPanel();
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
   * Показывает единый paywall для платной фичи «AI-план меню» в области панели
   * действий. Контроль доступа серверный — это лишь визуальная заглушка.
   */
  function openMealPlanPaywall() {
    var panel = document.getElementById("diary-panel");
    if (!panel) return;

    if (App && typeof App.paywall === "function") {
      App.paywall(panel, {
        icon: "🍴",
        title: pick("AI-план меню", "AI meal plan"),
        desc: pick(
          "AI составит меню на день или неделю и соберёт список покупок",
          "AI will compose a day or week menu and build a shopping list"
        ),
        bullets: [
          pick("Меню по приёмам пищи с КБЖУ", "Menu by meals with calories and macros"),
          pick("Замена любого блюда в один тап", "Swap any dish in one tap"),
          pick("Готовый список покупок", "Ready-made shopping list")
        ]
      });
      return;
    }

    // Запасной вариант, если единый paywall недоступен — ведём в подписку кнопкой.
    panel.innerHTML =
      '<section class="card plan-locked">' +
      '<h2 class="plan-locked__title">🔒 ' + App.escapeHtml(pick("AI-план меню", "AI meal plan")) + "</h2>" +
      '<p class="plan-locked__sub">' +
      App.escapeHtml(pick("AI-планировщик меню доступен по подписке.", "The AI meal planner is available with a subscription.")) + "</p>" +
      '<button type="button" class="btn btn--cta btn-block plan-locked__subscribe">' +
      App.escapeHtml(pick("Оформить подписку", "Get subscription")) + "</button>" +
      "</section>";
    var subBtn = panel.querySelector(".plan-locked__subscribe");
    if (subBtn) {
      subBtn.addEventListener("click", function () {
        App.haptic && App.haptic("light");
        if (App && typeof App.navigate === "function") App.navigate("subscription");
      });
    }
  }

  /**
   * Подсвечивает активную кнопку действия в соответствии с открытой панелью.
   * Учитывает и базовые кнопки (.diary-actions__btn), и кнопки шаблонов
   * (.tpl-actions__btn). Панель "templates" подсвечивает кнопку «📋 Шаблоны».
   */
  function syncActionButtons() {
    var content = document.getElementById("diary-content");
    if (!content) return;
    var buttons = content.querySelectorAll(".diary-actions__btn");
    for (var i = 0; i < buttons.length; i++) {
      var act = buttons[i].getAttribute("data-action");
      // Кнопки шаблонов учитываем отдельным циклом ниже — их пропускаем здесь.
      if (buttons[i].classList.contains("tpl-actions__btn")) continue;
      buttons[i].classList.toggle("is-active", act === state.panel);
    }
    // Кнопки шаблонов: активна только «📋 Шаблоны» (data-action="tpl-list"),
    // когда открыта панель списка шаблонов. Кнопки «Сохранить»/«Скопировать»
    // выполняют разовое действие и не остаются «активными».
    var tplButtons = content.querySelectorAll(".tpl-actions__btn");
    for (var j = 0; j < tplButtons.length; j++) {
      var tplAct = tplButtons[j].getAttribute("data-action");
      tplButtons[j].classList.toggle(
        "is-active",
        tplAct === "tpl-list" && state.panel === "templates"
      );
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
   * Используется «Недавними», рекомендациями и AI-планом меню.
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
  // Рекомендации «Что съесть?» (Этап 5: умные предложения).
  //
  // Панель содержит:
  //   - чипы выбора приёма пищи (Завтрак/Обед/Ужин/Перекус + «Весь день»);
  //   - поле свободного ввода «Чего хочется?»;
  //   - кнопку «Подобрать» -> App.api.suggestFood (если выбран приём/есть текст)
  //     ИЛИ существующий App.api.recommendFood (фолбэк, общий случай);
  //   - кнопку «🍬 Вкусняшки» -> App.api.getHealthySnacks.
  // Результаты — карточки {dish_name,calories,...,reason} с добавлением в один тап.
  // Префикс классов suggest-.
  // ---------------------------------------------------------------------------

  /**
   * Открывает панель рекомендаций «Что съесть?» с управлением (приём пищи,
   * свободный ввод, кнопки) и областью результатов.
   */
  function openRecommendPanel() {
    var panel = document.getElementById("diary-panel");
    if (!panel) return;

    // Подпись «Весь день» как отдельный чип (meal_type=null -> общий подбор).
    var allActive = state.suggestMeal == null ? " is-active" : "";
    var chips = "";
    for (var i = 0; i < MEAL_ORDER.length; i++) {
      var t = MEAL_ORDER[i];
      var active = state.suggestMeal === t ? " is-active" : "";
      chips +=
        '<button type="button" class="meal-chip' + active + '" ' +
        'data-suggest-meal="' + t + '">' +
        App.escapeHtml(App.mealLabel(t)) + "</button>";
    }
    var mealChips =
      '<div class="meal-chips suggest-chips">' +
      '<button type="button" class="meal-chip' + allActive + '" data-suggest-meal="all">' +
      App.escapeHtml(pick("Весь день", "Whole day")) + "</button>" +
      chips +
      "</div>";

    panel.innerHTML =
      '<section class="card diary-recommend suggest-panel">' +
      '<h2 class="diary-recommend__title">' +
      App.escapeHtml(pick("Что съесть?", "What to eat?")) + "</h2>" +
      '<p class="diary-recommend__sub">' +
      App.escapeHtml(pick(
        "Подбираем блюда под остаток дневной нормы.",
        "Suggesting dishes to fit your remaining daily allowance."
      )) + "</p>" +
      // Выбор приёма пищи.
      '<div class="suggest-controls">' +
      '<span class="field__label">' + App.escapeHtml(pick("Приём пищи", "Meal")) + "</span>" +
      mealChips +
      // Свободный ввод «Чего хочется?».
      '<label class="field suggest-free">' +
      '<span class="field__label">' + App.escapeHtml(pick("Чего хочется?", "What do you feel like?")) +
      ' <span class="field__hint">' + App.escapeHtml(pick("(необязательно)", "(optional)")) + "</span></span>" +
      '<input class="field__input suggest-free__input" type="text" maxlength="120" ' +
      'value="' + App.escapeHtml(state.suggestText || "") + '" ' +
      'placeholder="' + App.escapeHtml(pick("Например, что-то сладкое и белковое", "e.g. something sweet and high-protein")) + '">' +
      "</label>" +
      // Кнопки действий: подобрать + вкусняшки.
      '<div class="suggest-buttons">' +
      '<button type="button" class="btn btn--cta suggest-btn suggest-btn--go">' +
      App.escapeHtml(pick("Подобрать", "Suggest")) + "</button>" +
      '<button type="button" class="btn btn--ghost suggest-btn suggest-btn--snacks">' +
      App.escapeHtml(pick("🍬 Вкусняшки", "🍬 Healthy snacks")) + "</button>" +
      "</div>" +
      "</div>" +
      // Область результатов.
      '<div id="diary-recommend-body" class="diary-recommend__body suggest-body">' +
      '<p class="suggest-hint">' +
      App.escapeHtml(pick(
        "Выберите приём пищи или опишите, чего хочется, и нажмите «Подобрать».",
        "Pick a meal or describe what you feel like, then tap “Suggest”."
      )) + "</p>" +
      "</div>" +
      "</section>";

    // Переключение приёма пищи (включая «Весь день» -> null).
    var chipsWrap = panel.querySelector(".suggest-chips");
    if (chipsWrap) {
      chipsWrap.addEventListener("click", function (ev) {
        var btn = ev.target.closest(".meal-chip");
        if (!btn) return;
        var v = btn.getAttribute("data-suggest-meal");
        if (!v) return;
        state.suggestMeal = v === "all" ? null : v;
        App.haptic && App.haptic("light");
        var all = chipsWrap.querySelectorAll(".meal-chip");
        for (var i = 0; i < all.length; i++) {
          var av = all[i].getAttribute("data-suggest-meal");
          var on = (av === "all" && state.suggestMeal == null) || av === state.suggestMeal;
          all[i].classList.toggle("is-active", on);
        }
      });
    }

    // Сохраняем свободный ввод в состоянии (чтобы переживал перерисовку).
    var freeInput = panel.querySelector(".suggest-free__input");
    if (freeInput) {
      freeInput.addEventListener("input", function () {
        state.suggestText = freeInput.value || "";
      });
    }

    // Кнопка «Подобрать».
    var goBtn = panel.querySelector(".suggest-btn--go");
    if (goBtn) {
      goBtn.addEventListener("click", function () {
        App.haptic && App.haptic("light");
        if (freeInput) state.suggestText = freeInput.value || "";
        requestSuggestions();
      });
    }

    // Кнопка «🍬 Вкусняшки».
    var snacksBtn = panel.querySelector(".suggest-btn--snacks");
    if (snacksBtn) {
      snacksBtn.addEventListener("click", function () {
        App.haptic && App.haptic("light");
        requestHealthySnacks();
      });
    }
  }

  /**
   * Считает остатки КБЖУ за текущий день относительно цели и target_* профиля.
   * @returns {Object} {remainingCalories, remainingProteins, remainingFats,
   *                     remainingCarbs}
   */
  function computeRemaining() {
    var day = state.day || {};
    var profile = (App.state && App.state.profile) || {};

    var goalKcal = Number(day.daily_goal_kcal) || 0;
    var eaten = Number(day.total_calories) || 0;

    return {
      remainingCalories: Math.max(0, goalKcal - eaten),
      remainingProteins: Math.max(0, (Number(profile.target_proteins) || 0) - (Number(day.total_proteins) || 0)),
      remainingFats: Math.max(0, (Number(profile.target_fats) || 0) - (Number(day.total_fats) || 0)),
      remainingCarbs: Math.max(0, (Number(profile.target_carbs) || 0) - (Number(day.total_carbs) || 0))
    };
  }

  /**
   * Показывает скелетон в области результатов «Что съесть?».
   */
  function showSuggestSkeleton() {
    var body = document.getElementById("diary-recommend-body");
    if (!body) return;
    body.innerHTML =
      '<div class="skeleton skeleton-block diary-recommend__skeleton"></div>' +
      '<div class="skeleton skeleton-block diary-recommend__skeleton"></div>' +
      '<div class="skeleton skeleton-block diary-recommend__skeleton"></div>';
  }

  /**
   * Подбирает блюда по выбранному приёму/свободному вводу.
   * Если выбран приём пищи ИЛИ есть свободный текст — используем умный
   * App.api.suggestFood. Иначе (общий случай «весь день» без текста) —
   * существующий App.api.recommendFood как фолбэк.
   */
  function requestSuggestions() {
    var rem = computeRemaining();
    var freeText = (state.suggestText || "").trim();
    var mealType = state.suggestMeal || null;

    showSuggestSkeleton();

    // Решаем, какой эндпоинт использовать.
    var useSuggest = !!mealType || !!freeText;

    if (useSuggest && App.api && typeof App.api.suggestFood === "function") {
      var payload = {
        remaining_calories: Math.round(rem.remainingCalories),
        remaining_proteins: Math.round(rem.remainingProteins),
        remaining_fats: Math.round(rem.remainingFats),
        remaining_carbs: Math.round(rem.remainingCarbs)
      };
      if (mealType) payload.meal_type = mealType;
      if (freeText) payload.free_text = freeText;

      App.api
        .suggestFood(payload)
        .then(function (res) {
          var suggestions = (res && res.suggestions) || [];
          renderRecommendations(suggestions, rem.remainingCalories);
        })
        .catch(function (err) {
          renderRecommendError(
            (err && err.message) ||
            pick("Не удалось получить предложения.", "Failed to get suggestions.")
          );
        });
      return;
    }

    // Фолбэк: общий подбор под остаток нормы (как раньше).
    requestRecommendations(rem);
  }

  /**
   * Запрашивает «вкусняшки» (полезные перекусы) через App.api.getHealthySnacks.
   */
  function requestHealthySnacks() {
    var rem = computeRemaining();

    showSuggestSkeleton();

    if (!(App.api && typeof App.api.getHealthySnacks === "function")) {
      renderRecommendError(
        pick("Подсказки временно недоступны.", "Suggestions are temporarily unavailable.")
      );
      return;
    }

    App.api
      .getHealthySnacks()
      .then(function (res) {
        var suggestions = (res && res.suggestions) || [];
        renderRecommendations(suggestions, rem.remainingCalories);
      })
      .catch(function (err) {
        renderRecommendError(
          (err && err.message) ||
          pick("Не удалось получить вкусняшки.", "Failed to get healthy snacks.")
        );
      });
  }

  /**
   * Считает остатки КБЖУ и вызывает App.api.recommendFood (фолбэк-поток).
   * @param {Object} [rem] заранее посчитанные остатки (иначе считаем сами)
   */
  function requestRecommendations(rem) {
    rem = rem || computeRemaining();
    var profile = (App.state && App.state.profile) || {};

    var payload = {
      remaining_calories: Math.round(rem.remainingCalories),
      remaining_proteins: Math.round(rem.remainingProteins),
      remaining_fats: Math.round(rem.remainingFats),
      remaining_carbs: Math.round(rem.remainingCarbs),
      time_of_day: timeOfDay()
    };
    if (profile.diet_goal) {
      payload.diet_goal = profile.diet_goal;
    }

    App.api
      .recommendFood(payload)
      .then(function (res) {
        var suggestions = (res && res.suggestions) || [];
        renderRecommendations(suggestions, rem.remainingCalories);
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
   * Если в панели «Что съесть?» выбран конкретный приём пищи — он становится
   * приёмом по умолчанию для добавления.
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

    // Приём пищи для добавления рекомендации: по умолчанию — выбранный в панели
    // «Что съесть?» (если выбран), иначе завтрак.
    var recMeal = state.suggestMeal || "breakfast";

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
      mealChipsHtml(recMeal, "rec-meal") +
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
        // Повторяем последнее действие через основной поток подбора.
        requestSuggestions();
      });
    }
  }

  // ===========================================================================
  // AI-ПЛАН МЕНЮ (Этап 5, ПРЕМИУМ).
  //
  // Панель .plan-panel:
  //   - чипы выбора охвата (День / Неделя);
  //   - поле предпочтений (текст);
  //   - кнопка «Сгенерировать» -> App.api.generateMealPlan({scope, preferences});
  //   - по дням: label дня + блюда по приёмам (App.mealLabel) с КБЖУ; у каждого
  //     блюда кнопка «🔄 Заменить» -> App.api.regenerateMealItem -> замена в UI;
  //   - список покупок (shopping_list) буллетами;
  //   - кнопка «Сгенерировать заново».
  // Префикс классов plan-.
  // ===========================================================================

  /**
   * Открывает панель AI-плана меню: управление (охват + предпочтения + кнопка)
   * и область результатов плана.
   */
  function openMealPlanPanel() {
    var panel = document.getElementById("diary-panel");
    if (!panel) return;

    panel.innerHTML =
      '<section class="card plan-panel">' +
      '<h2 class="plan-panel__title">' +
      App.escapeHtml(pick("AI-план меню", "AI meal plan")) + "</h2>" +
      '<p class="plan-panel__sub">' +
      App.escapeHtml(pick(
        "Составим меню под вашу цель и соберём список покупок.",
        "We'll compose a menu for your goal and build a shopping list."
      )) + "</p>" +
      // Управление.
      '<div class="plan-controls">' +
      '<span class="field__label">' + App.escapeHtml(pick("На сколько", "Scope")) + "</span>" +
      planScopeChipsHtml() +
      '<label class="field plan-prefs">' +
      '<span class="field__label">' + App.escapeHtml(pick("Предпочтения", "Preferences")) +
      ' <span class="field__hint">' + App.escapeHtml(pick("(необязательно)", "(optional)")) + "</span></span>" +
      '<input class="field__input plan-prefs__input" type="text" maxlength="160" ' +
      'value="' + App.escapeHtml(state.planPrefs || "") + '" ' +
      'placeholder="' + App.escapeHtml(pick("Например, без свинины, больше рыбы", "e.g. no pork, more fish")) + '">' +
      "</label>" +
      '<button type="button" class="btn btn--cta btn-block plan-generate">' +
      App.escapeHtml(pick("Сгенерировать", "Generate")) + "</button>" +
      "</div>" +
      // Область результата.
      '<div id="plan-body" class="plan-body"></div>' +
      "</section>";

    // Чипы выбора охвата.
    var scopeWrap = panel.querySelector(".plan-scope");
    if (scopeWrap) {
      scopeWrap.addEventListener("click", function (ev) {
        var btn = ev.target.closest(".plan-scope__chip");
        if (!btn) return;
        var sc = btn.getAttribute("data-plan-scope");
        if (!sc) return;
        state.planScope = sc;
        App.haptic && App.haptic("light");
        var all = scopeWrap.querySelectorAll(".plan-scope__chip");
        for (var i = 0; i < all.length; i++) {
          all[i].classList.toggle(
            "is-active",
            all[i].getAttribute("data-plan-scope") === sc
          );
        }
      });
    }

    // Поле предпочтений -> состояние.
    var prefsInput = panel.querySelector(".plan-prefs__input");
    if (prefsInput) {
      prefsInput.addEventListener("input", function () {
        state.planPrefs = prefsInput.value || "";
      });
    }

    // Кнопка генерации.
    var genBtn = panel.querySelector(".plan-generate");
    if (genBtn) {
      genBtn.addEventListener("click", function () {
        App.haptic && App.haptic("light");
        if (prefsInput) state.planPrefs = prefsInput.value || "";
        requestMealPlan();
      });
    }

    // Если план уже был сгенерирован ранее (в этой сессии панели) — показываем.
    if (state.plan) {
      renderMealPlan(state.plan);
    } else {
      var body = document.getElementById("plan-body");
      if (body) {
        body.innerHTML =
          '<p class="plan-hint">' +
          App.escapeHtml(pick(
            "Выберите охват и нажмите «Сгенерировать».",
            "Pick a scope and tap “Generate”."
          )) + "</p>";
      }
    }
  }

  /**
   * Разметка чипов выбора охвата плана (День / Неделя).
   * @returns {string}
   */
  function planScopeChipsHtml() {
    var scopes = [
      { v: "day", ru: "День", en: "Day" },
      { v: "week", ru: "Неделя", en: "Week" }
    ];
    var chips = "";
    for (var i = 0; i < scopes.length; i++) {
      var sc = scopes[i];
      var active = state.planScope === sc.v ? " is-active" : "";
      chips +=
        '<button type="button" class="meal-chip plan-scope__chip' + active + '" ' +
        'data-plan-scope="' + sc.v + '">' +
        App.escapeHtml(pick(sc.ru, sc.en)) + "</button>";
    }
    return '<div class="meal-chips plan-scope">' + chips + "</div>";
  }

  /**
   * Запрашивает план меню у сервера и рисует его (или ошибку).
   */
  function requestMealPlan() {
    var body = document.getElementById("plan-body");
    if (body) {
      body.innerHTML =
        '<div class="skeleton skeleton-block plan-skeleton"></div>' +
        '<div class="skeleton skeleton-block plan-skeleton"></div>' +
        '<div class="skeleton skeleton-block plan-skeleton"></div>';
    }

    if (!(App.api && typeof App.api.generateMealPlan === "function")) {
      renderMealPlanError(
        pick("Планировщик меню временно недоступен.", "The meal planner is temporarily unavailable.")
      );
      return;
    }

    var payload = { scope: state.planScope === "week" ? "week" : "day" };
    var prefs = (state.planPrefs || "").trim();
    if (prefs) payload.preferences = prefs;

    App.api
      .generateMealPlan(payload)
      .then(function (res) {
        state.plan = res || { days: [], shopping_list: [] };
        renderMealPlan(state.plan);
      })
      .catch(function (err) {
        renderMealPlanError(
          (err && err.message) ||
          pick("Не удалось составить план меню.", "Failed to generate the meal plan.")
        );
      });
  }

  /**
   * Рисует план меню: дни, приёмы пищи, блюда (с кнопкой замены) и список покупок.
   * Названия блюд и подписи дней приходят от API — не переводим (только экранируем).
   * @param {Object} plan {days:[{label, meals:{...}}], shopping_list:[str]}
   */
  function renderMealPlan(plan) {
    var body = document.getElementById("plan-body");
    if (!body) return;

    plan = plan || {};
    var days = plan.days || [];
    var shopping = plan.shopping_list || [];

    if (!days.length) {
      body.innerHTML =
        '<p class="plan-empty">' +
        App.escapeHtml(pick(
          "План пуст. Попробуйте сгенерировать ещё раз.",
          "The plan is empty. Try generating again."
        )) + "</p>";
      return;
    }

    var html = "";
    for (var d = 0; d < days.length; d++) {
      var day = days[d] || {};
      var meals = day.meals || {};
      var label = day.label || (pick("День ", "Day ") + (d + 1));

      var mealsHtml = "";
      for (var m = 0; m < MEAL_ORDER.length; m++) {
        var mealType = MEAL_ORDER[m];
        var dishes = meals[mealType] || [];
        if (!dishes.length) continue;

        var dishesHtml = "";
        for (var i = 0; i < dishes.length; i++) {
          dishesHtml += planDishHtml(dishes[i], d, mealType, i);
        }

        mealsHtml +=
          '<div class="plan-meal">' +
          '<div class="plan-meal__head">' +
          '<span class="plan-meal__icon" aria-hidden="true">' + (MEAL_ICONS[mealType] || "🍽️") + "</span> " +
          '<span class="plan-meal__title">' + App.escapeHtml(App.mealLabel(mealType)) + "</span>" +
          "</div>" +
          '<div class="plan-meal__dishes">' + dishesHtml + "</div>" +
          "</div>";
      }

      html +=
        '<section class="plan-day" data-day="' + d + '">' +
        '<h3 class="plan-day__title">' + App.escapeHtml(label) + "</h3>" +
        mealsHtml +
        "</section>";
    }

    // Список покупок.
    var shoppingHtml = "";
    if (shopping.length) {
      var lis = "";
      for (var s = 0; s < shopping.length; s++) {
        lis += '<li class="plan-shopping__item">' + App.escapeHtml(shopping[s]) + "</li>";
      }
      shoppingHtml =
        '<section class="plan-shopping card">' +
        '<h3 class="plan-shopping__title">' +
        App.escapeHtml(pick("🛒 Список покупок", "🛒 Shopping list")) + "</h3>" +
        '<ul class="plan-shopping__list">' + lis + "</ul>" +
        "</section>";
    }

    // Кнопка «Сгенерировать заново».
    var regenHtml =
      '<button type="button" class="btn btn--ghost btn-block plan-regenerate">' +
      App.escapeHtml(pick("🔁 Сгенерировать заново", "🔁 Generate again")) + "</button>";

    body.innerHTML =
      '<div class="plan-days">' + html + "</div>" +
      shoppingHtml +
      regenHtml;

    // Делегируем клики по кнопкам «Заменить».
    var daysWrap = body.querySelector(".plan-days");
    if (daysWrap) {
      daysWrap.addEventListener("click", function (ev) {
        var swapBtn = ev.target.closest(".plan-dish__swap");
        if (!swapBtn) return;
        var dIdx = parseInt(swapBtn.getAttribute("data-day"), 10);
        var mealType = swapBtn.getAttribute("data-meal");
        var iIdx = parseInt(swapBtn.getAttribute("data-idx"), 10);
        if (isNaN(dIdx) || !mealType || isNaN(iIdx)) return;
        regenerateDish(dIdx, mealType, iIdx, swapBtn);
      });
    }

    // Кнопка повторной генерации.
    var regenBtn = body.querySelector(".plan-regenerate");
    if (regenBtn) {
      regenBtn.addEventListener("click", function () {
        App.haptic && App.haptic("light");
        requestMealPlan();
      });
    }
  }

  /**
   * Разметка одного блюда в плане меню с кнопкой замены.
   * Название блюда — данные от API, не переводим (экранируем).
   * @param {Object} dish {dish_name, calories, proteins, fats, carbs}
   * @param {number} dayIdx индекс дня
   * @param {string} mealType тип приёма пищи
   * @param {number} idx индекс блюда внутри приёма
   * @returns {string}
   */
  function planDishHtml(dish, dayIdx, mealType, idx) {
    dish = dish || {};
    var kcal = pick("ккал", "kcal");
    var pLabel = pick("Б", "P");
    var fLabel = pick("Ж", "F");
    var cLabel = pick("У", "C");

    return (
      '<div class="plan-dish" data-day="' + dayIdx + '" data-meal="' + mealType + '" data-idx="' + idx + '">' +
      '<div class="plan-dish__info">' +
      '<span class="plan-dish__name">' +
      App.escapeHtml(dish.dish_name || pick("Блюдо", "Dish")) + "</span>" +
      '<span class="plan-dish__macros">' +
      App.fmt(dish.calories || 0) + " " + kcal + " · " +
      pLabel + " " + App.fmt(dish.proteins || 0) + " · " +
      fLabel + " " + App.fmt(dish.fats || 0) + " · " +
      cLabel + " " + App.fmt(dish.carbs || 0) +
      "</span>" +
      "</div>" +
      '<button type="button" class="plan-dish__swap" ' +
      'data-day="' + dayIdx + '" data-meal="' + mealType + '" data-idx="' + idx + '" ' +
      'title="' + App.escapeHtml(pick("Заменить блюдо", "Replace dish")) + '" ' +
      'aria-label="' + App.escapeHtml(pick("Заменить блюдо", "Replace dish")) + '">🔄 ' +
      App.escapeHtml(pick("Заменить", "Replace")) + "</button>" +
      "</div>"
    );
  }

  /**
   * Заменяет одно блюдо в плане: запрашивает новое у сервера и обновляет UI
   * на месте (без полного перезапроса плана).
   * @param {number} dayIdx индекс дня
   * @param {string} mealType тип приёма пищи
   * @param {number} idx индекс блюда внутри приёма
   * @param {HTMLElement} swapBtn кнопка-инициатор (для блокировки/спиннера)
   */
  function regenerateDish(dayIdx, mealType, idx, swapBtn) {
    if (!state.plan || !state.plan.days || !state.plan.days[dayIdx]) return;
    var meals = state.plan.days[dayIdx].meals || {};
    var dishes = meals[mealType] || [];
    var current = dishes[idx];
    if (!current) return;

    if (swapBtn) {
      if (swapBtn.disabled) return; // защита от повторных кликов
      swapBtn.disabled = true;
      swapBtn.textContent = pick("Меняем…", "Swapping…");
    }
    App.haptic && App.haptic("light");

    if (!(App.api && typeof App.api.regenerateMealItem === "function")) {
      if (swapBtn) {
        swapBtn.disabled = false;
        swapBtn.textContent = "🔄 " + pick("Заменить", "Replace");
      }
      App.toast(pick("Замена временно недоступна.", "Replacing is temporarily unavailable."));
      return;
    }

    var payload = {
      meal_type: mealType,
      around_calories: Math.round(Number(current.calories) || 0)
    };
    var prefs = (state.planPrefs || "").trim();
    if (prefs) payload.preferences = prefs;

    App.api
      .regenerateMealItem(payload)
      .then(function (newDish) {
        if (!newDish || typeof newDish !== "object") {
          throw new Error(pick("Пустой ответ сервера", "Empty server response"));
        }
        // Обновляем модель плана и перерисовываем конкретное блюдо в DOM.
        state.plan.days[dayIdx].meals[mealType][idx] = newDish;
        replaceDishInDom(dayIdx, mealType, idx, newDish);
        App.haptic && App.haptic("success");
      })
      .catch(function (err) {
        App.haptic && App.haptic("error");
        App.toast((err && err.message) || pick("Не удалось заменить блюдо", "Failed to replace dish"));
        if (swapBtn) {
          swapBtn.disabled = false;
          swapBtn.textContent = "🔄 " + pick("Заменить", "Replace");
        }
      });
  }

  /**
   * Заменяет разметку конкретного блюда в DOM новым блюдом (после замены).
   * @param {number} dayIdx
   * @param {string} mealType
   * @param {number} idx
   * @param {Object} newDish
   */
  function replaceDishInDom(dayIdx, mealType, idx, newDish) {
    var body = document.getElementById("plan-body");
    if (!body) return;
    var selector =
      '.plan-dish[data-day="' + dayIdx + '"][data-meal="' + mealType + '"][data-idx="' + idx + '"]';
    var oldEl = body.querySelector(selector);
    if (!oldEl) return;

    var wrap = document.createElement("div");
    wrap.innerHTML = planDishHtml(newDish, dayIdx, mealType, idx);
    var newEl = wrap.firstChild;
    if (newEl && oldEl.parentNode) {
      oldEl.parentNode.replaceChild(newEl, oldEl);
    }
  }

  /**
   * Состояние ошибки внутри панели AI-плана меню с кнопкой «Повторить».
   * @param {string} message
   */
  function renderMealPlanError(message) {
    var body = document.getElementById("plan-body");
    if (!body) return;
    body.innerHTML =
      '<div class="plan-error">' +
      '<p class="plan-error__text">' + App.escapeHtml(message) + "</p>" +
      '<button type="button" class="btn btn--ghost plan-error__retry">' +
      App.escapeHtml(pick("Повторить", "Retry")) + "</button>" +
      "</div>";

    var retry = body.querySelector(".plan-error__retry");
    if (retry) {
      retry.addEventListener("click", function () {
        App.haptic && App.haptic("light");
        requestMealPlan();
      });
    }
  }

  // ===========================================================================
  // ШАБЛОНЫ ПИТАНИЯ (Этап 4, ПРЕМИУМ).
  //
  // Три действия в блоке .tpl-actions:
  //   «💾 Сохранить день как шаблон» — собирает все записи текущего дня в items
  //     (с их meal_type) и сохраняет шаблон типа "day" с введённым именем.
  //   «📋 Шаблоны» — открывает панель со списком шаблонов: применить к текущей
  //     дате или удалить.
  //   «📅 Скопировать вчера» — копирует все записи дневника со «вчера» (даты −1)
  //     на текущую дату.
  // Все три — платные: для free показываем единый App.paywall в области панели.
  // Базовый дневник остаётся бесплатным. Префикс классов tpl-.
  // ===========================================================================

  /**
   * Клик по премиум-кнопке шаблонов (.tpl-actions__btn).
   * Для free любая из трёх кнопок показывает paywall в области панели.
   * Для премиум — выполняет соответствующее действие.
   * @param {Event} ev
   */
  function onTemplateActionClick(ev) {
    var action = ev.currentTarget.getAttribute("data-action");
    App.haptic && App.haptic("light");

    // Все действия с шаблонами — платные. Для бесплатных пользователей
    // показываем единый paywall (ведёт на экран подписки) и помечаем панель
    // как "templates", чтобы при перерисовке состояние сохранялось.
    if (!isPremium()) {
      state.panel = "templates";
      syncActionButtons();
      openTemplatesPaywall();
      return;
    }

    if (action === "tpl-save") {
      // Разовое действие: открываем форму ввода имени (панель не «залипает»).
      openSaveTemplatePanel();
    } else if (action === "tpl-list") {
      // Повторный клик по «Шаблоны» сворачивает панель.
      if (state.panel === "templates") {
        state.panel = null;
        var panel = document.getElementById("diary-panel");
        if (panel) panel.innerHTML = "";
        syncActionButtons();
        return;
      }
      state.panel = "templates";
      syncActionButtons();
      openTemplatesPanel();
    } else if (action === "tpl-copy") {
      copyYesterday();
    }
  }

  /**
   * Показывает единый paywall для премиум-фич шаблонов в области панели действий.
   * Контроль доступа серверный — это лишь визуальная заглушка.
   */
  function openTemplatesPaywall() {
    var panel = document.getElementById("diary-panel");
    if (!panel) return;

    if (App && typeof App.paywall === "function") {
      App.paywall(panel, {
        icon: "📋",
        title: pick("Шаблоны питания", "Meal templates"),
        desc: pick(
          "Сохраняйте дни как шаблоны и добавляйте их в рацион одним тапом",
          "Save days as templates and add them to your diary in one tap"
        ),
        bullets: [
          pick("Сохранение дня целиком как шаблона", "Save a whole day as a template"),
          pick("Применение шаблона к любой дате", "Apply a template to any date"),
          pick("Копирование рациона со вчерашнего дня", "Copy yesterday's diary in one tap")
        ]
      });
      return;
    }

    // Запасной вариант, если единый paywall недоступен — ведём в подписку кнопкой.
    panel.innerHTML =
      '<section class="card tpl-locked">' +
      '<h2 class="tpl-locked__title">🔒 ' + App.escapeHtml(pick("Шаблоны питания", "Meal templates")) + "</h2>" +
      '<p class="tpl-locked__sub">' +
      App.escapeHtml(pick("Шаблоны доступны по подписке.", "Templates are available with a subscription.")) + "</p>" +
      '<button type="button" class="btn btn--cta btn-block tpl-locked__subscribe">' +
      App.escapeHtml(pick("Оформить подписку", "Get subscription")) + "</button>" +
      "</section>";
    var subBtn = panel.querySelector(".tpl-locked__subscribe");
    if (subBtn) {
      subBtn.addEventListener("click", function () {
        App.haptic && App.haptic("light");
        if (App && typeof App.navigate === "function") App.navigate("subscription");
      });
    }
  }

  /**
   * Собирает все записи текущего загруженного дня в массив items для шаблона.
   * Каждый элемент хранит meal_type своей секции, чтобы при применении шаблона
   * блюда легли в нужные приёмы пищи.
   * @returns {Array} items [{dish_name, calories, proteins, fats, carbs, meal_type}]
   */
  function collectDayItems() {
    var day = state.day || {};
    var meals = day.meals || {};
    var items = [];
    for (var i = 0; i < MEAL_ORDER.length; i++) {
      var type = MEAL_ORDER[i];
      var arr = meals[type] || [];
      for (var j = 0; j < arr.length; j++) {
        var e = arr[j] || {};
        items.push({
          dish_name: e.dish_name || pick("Без названия", "Untitled"),
          calories: Math.round(Number(e.calories) || 0),
          proteins: Number(e.proteins) || 0,
          fats: Number(e.fats) || 0,
          carbs: Number(e.carbs) || 0,
          meal_type: type
        });
      }
    }
    return items;
  }

  /**
   * Открывает панель «Сохранить день как шаблон»: инлайн-поле ввода имени
   * и кнопка сохранения. Если за день нет записей — показываем подсказку.
   */
  function openSaveTemplatePanel() {
    var panel = document.getElementById("diary-panel");
    if (!panel) return;

    var items = collectDayItems();

    if (!items.length) {
      // Пустой день нечего сохранять — показываем пустое состояние.
      panel.innerHTML =
        '<section class="card tpl-save">' +
        '<h2 class="tpl-save__title">' +
        App.escapeHtml(pick("Сохранить день как шаблон", "Save day as template")) + "</h2>" +
        '<p class="tpl-save__empty">' +
        App.escapeHtml(pick(
          "За этот день нет записей. Добавьте блюда, чтобы сохранить день как шаблон.",
          "No entries for this day. Add dishes to save the day as a template."
        )) + "</p>" +
        "</section>";
      return;
    }

    // Значение по умолчанию для имени — «Шаблон» + человеко-читаемая дата.
    var defaultName = pick("Шаблон ", "Template ") + humanDate(state.date);

    panel.innerHTML =
      '<section class="card tpl-save">' +
      '<h2 class="tpl-save__title">' +
      App.escapeHtml(pick("Сохранить день как шаблон", "Save day as template")) + "</h2>" +
      '<p class="tpl-save__sub">' +
      App.escapeHtml(
        pick("Блюд в шаблоне: ", "Dishes in template: ") + items.length
      ) + "</p>" +
      '<label class="field">' +
      '<span class="field__label">' + App.escapeHtml(pick("Название шаблона", "Template name")) + "</span>" +
      '<input class="field__input tpl-save__name" type="text" maxlength="80" ' +
      'value="' + App.escapeHtml(defaultName) + '" ' +
      'placeholder="' + App.escapeHtml(pick("Например, «Мой обычный день»", "e.g. “My usual day”")) + '">' +
      "</label>" +
      '<button type="button" class="btn btn--cta btn-block tpl-save__submit">' +
      App.escapeHtml(pick("Сохранить шаблон", "Save template")) + "</button>" +
      "</section>";

    var nameInput = panel.querySelector(".tpl-save__name");
    var submitBtn = panel.querySelector(".tpl-save__submit");
    if (submitBtn) {
      submitBtn.addEventListener("click", function () {
        var name = (nameInput && nameInput.value ? nameInput.value : "").trim();
        if (!name) {
          App.toast(pick("Укажите название шаблона", "Enter a template name"));
          try { if (nameInput) nameInput.focus(); } catch (e) {}
          return;
        }
        submitSaveTemplate(name, items, submitBtn);
      });
    }
  }

  /**
   * Отправляет шаблон типа "day" на сервер.
   * @param {string} name имя шаблона
   * @param {Array} items блюда дня
   * @param {HTMLElement} [trigger] кнопка-инициатор (для блокировки)
   */
  function submitSaveTemplate(name, items, trigger) {
    if (trigger) {
      trigger.disabled = true;
      trigger.textContent = pick("Сохраняем…", "Saving…");
    }
    App.showLoading();

    App.api
      .saveTemplate({ name: name, template_type: "day", items: items })
      .then(function () {
        App.haptic && App.haptic("success");
        App.toast(pick("Шаблон сохранён", "Template saved"));
        // Сворачиваем панель действий.
        state.panel = null;
        var panel = document.getElementById("diary-panel");
        if (panel) panel.innerHTML = "";
        syncActionButtons();
      })
      .catch(function (err) {
        App.haptic && App.haptic("error");
        App.toast((err && err.message) || pick("Не удалось сохранить шаблон", "Failed to save template"));
        if (trigger) {
          trigger.disabled = false;
          trigger.textContent = pick("Сохранить шаблон", "Save template");
        }
      })
      .then(function () {
        App.hideLoading();
      });
  }

  /**
   * Открывает панель со списком шаблонов и загружает их с сервера.
   */
  function openTemplatesPanel() {
    var panel = document.getElementById("diary-panel");
    if (!panel) return;

    panel.innerHTML =
      '<section class="card tpl-list">' +
      '<h2 class="tpl-list__title">' +
      App.escapeHtml(pick("Шаблоны питания", "Meal templates")) + "</h2>" +
      '<p class="tpl-list__sub">' +
      App.escapeHtml(pick(
        "Добавьте шаблон в рацион выбранной даты или удалите ненужный.",
        "Add a template to the selected date or remove the ones you don't need."
      )) + "</p>" +
      '<div id="tpl-list-body" class="tpl-list__body">' +
      '<div class="skeleton skeleton-block tpl-list__skeleton"></div>' +
      '<div class="skeleton skeleton-block tpl-list__skeleton"></div>' +
      "</div>" +
      "</section>";

    loadTemplates();
  }

  /**
   * Загружает список шаблонов пользователя и рисует его.
   */
  function loadTemplates() {
    var body = document.getElementById("tpl-list-body");
    if (!body) return;

    App.api
      .getTemplates()
      .then(function (res) {
        var items = (res && res.items) || [];
        renderTemplates(items);
      })
      .catch(function (err) {
        renderTemplatesError(
          (err && err.message) ||
          pick("Не удалось загрузить шаблоны.", "Failed to load templates.")
        );
      });
  }

  /**
   * Человеко-читаемая подпись типа шаблона.
   * @param {string} type "dish" | "meal" | "day"
   * @returns {string}
   */
  function templateTypeLabel(type) {
    switch (type) {
      case "day":
        return pick("День", "Day");
      case "meal":
        return pick("Приём пищи", "Meal");
      case "dish":
        return pick("Блюдо", "Dish");
      default:
        return type || "";
    }
  }

  /**
   * Рисует список шаблонов: имя, тип, число блюд, кнопки «Добавить»/«Удалить».
   * Имена шаблонов — пользовательский ввод, не переводим (только экранируем).
   * @param {Array} items список TemplateOut
   */
  function renderTemplates(items) {
    var body = document.getElementById("tpl-list-body");
    if (!body) return;

    if (!items.length) {
      body.innerHTML =
        '<p class="tpl-list__empty">' +
        App.escapeHtml(pick(
          "У вас пока нет шаблонов. Сохраните день кнопкой «💾 Сохранить день как шаблон».",
          "You have no templates yet. Save a day with the “💾 Save day as template” button."
        )) + "</p>";
      return;
    }

    var dishesWord = pick("блюд", "dishes");
    var cards = "";
    for (var i = 0; i < items.length; i++) {
      var tpl = items[i] || {};
      var count = (tpl.items && tpl.items.length) || 0;
      var typeLabel = templateTypeLabel(tpl.template_type);
      cards +=
        '<div class="tpl-card" data-id="' + App.escapeHtml(tpl.id) + '">' +
        '<div class="tpl-card__info">' +
        '<span class="tpl-card__name">' +
        App.escapeHtml(tpl.name || pick("Без названия", "Untitled")) + "</span>" +
        '<span class="tpl-card__meta">' +
        App.escapeHtml(typeLabel) + " · " + App.fmt(count) + " " + App.escapeHtml(dishesWord) +
        "</span>" +
        "</div>" +
        '<div class="tpl-card__actions">' +
        '<button type="button" class="btn btn--cta tpl-card__apply" data-id="' + App.escapeHtml(tpl.id) + '">' +
        App.escapeHtml(pick("Добавить", "Add")) + "</button>" +
        '<button type="button" class="tpl-card__del" data-id="' + App.escapeHtml(tpl.id) + '" ' +
        'aria-label="' + App.escapeHtml(pick("Удалить шаблон", "Delete template")) +
        '" title="' + App.escapeHtml(pick("Удалить", "Delete")) + '">✕</button>' +
        "</div>" +
        "</div>";
    }

    body.innerHTML = '<div class="tpl-card-list">' + cards + "</div>";

    // Делегируем клики: «Добавить» (применить) и «✕» (удалить).
    var listWrap = body.querySelector(".tpl-card-list");
    if (listWrap) {
      listWrap.addEventListener("click", function (ev) {
        var applyBtn = ev.target.closest(".tpl-card__apply");
        if (applyBtn) {
          var applyId = parseInt(applyBtn.getAttribute("data-id"), 10);
          if (!isNaN(applyId)) applyTemplate(applyId, applyBtn);
          return;
        }
        var delBtn = ev.target.closest(".tpl-card__del");
        if (delBtn) {
          var delId = parseInt(delBtn.getAttribute("data-id"), 10);
          if (!isNaN(delId)) deleteTemplate(delId, delBtn);
        }
      });
    }
  }

  /**
   * Состояние ошибки внутри панели шаблонов с кнопкой «Повторить».
   * @param {string} message
   */
  function renderTemplatesError(message) {
    var body = document.getElementById("tpl-list-body");
    if (!body) return;
    body.innerHTML =
      '<div class="tpl-list__error">' +
      '<p class="tpl-list__error-text">' + App.escapeHtml(message) + "</p>" +
      '<button type="button" class="btn btn--ghost tpl-list__retry">' +
      App.escapeHtml(pick("Повторить", "Retry")) + "</button>" +
      "</div>";

    var retry = body.querySelector(".tpl-list__retry");
    if (retry) {
      retry.addEventListener("click", function () {
        App.haptic && App.haptic("light");
        body.innerHTML =
          '<div class="skeleton skeleton-block tpl-list__skeleton"></div>' +
          '<div class="skeleton skeleton-block tpl-list__skeleton"></div>';
        loadTemplates();
      });
    }
  }

  /**
   * Применяет шаблон к текущей дате: создаёт записи дневника и перезагружает день.
   * @param {number} id id шаблона
   * @param {HTMLElement} [trigger] кнопка-инициатор (для блокировки)
   */
  function applyTemplate(id, trigger) {
    if (trigger) {
      if (trigger.disabled) return; // защита от повторных кликов
      trigger.disabled = true;
      trigger.textContent = pick("Добавляем…", "Adding…");
    }
    App.haptic && App.haptic("light");
    App.showLoading();

    App.api
      .applyTemplate(id, { date: state.date })
      .then(function (res) {
        var added = (res && res.added) || 0;
        App.haptic && App.haptic("success");
        App.toast(
          pick("Добавлено блюд: ", "Dishes added: ") + App.fmt(added)
        );
        // Закрываем панель и инвалидируем кэш дня, затем перезагружаем.
        state.panel = null;
        if (App.state && App.state.diaryByDate) {
          delete App.state.diaryByDate[state.date];
        }
        loadAndRender();
      })
      .catch(function (err) {
        App.haptic && App.haptic("error");
        App.toast((err && err.message) || pick("Не удалось применить шаблон", "Failed to apply template"));
        if (trigger) {
          trigger.disabled = false;
          trigger.textContent = pick("Добавить", "Add");
        }
      })
      .then(function () {
        App.hideLoading();
      });
  }

  /**
   * Удаляет шаблон по id и перезагружает список шаблонов.
   * @param {number} id id шаблона
   * @param {HTMLElement} [trigger] кнопка-инициатор (для блокировки)
   */
  function deleteTemplate(id, trigger) {
    if (trigger) {
      if (trigger.disabled) return;
      trigger.disabled = true;
      trigger.textContent = "…";
    }
    App.haptic && App.haptic("light");
    App.showLoading();

    App.api
      .deleteTemplate(id)
      .then(function () {
        App.haptic && App.haptic("success");
        App.toast(pick("Шаблон удалён", "Template deleted"));
        // Перезагружаем список шаблонов в открытой панели.
        loadTemplates();
      })
      .catch(function (err) {
        App.haptic && App.haptic("error");
        App.toast((err && err.message) || pick("Не удалось удалить шаблон", "Failed to delete template"));
        if (trigger) {
          trigger.disabled = false;
          trigger.textContent = "✕";
        }
      })
      .then(function () {
        App.hideLoading();
      });
  }

  /**
   * Копирует все записи дневника со «вчера» (даты −1) на текущую дату.
   * Разовое действие, не оставляет панель открытой.
   */
  function copyYesterday() {
    App.haptic && App.haptic("light");
    App.showLoading();

    App.api
      .copyYesterday({ date: state.date })
      .then(function (res) {
        var added = (res && res.added) || 0;
        if (added > 0) {
          App.haptic && App.haptic("success");
          App.toast(
            pick("Скопировано блюд: ", "Dishes copied: ") + App.fmt(added)
          );
          // Инвалидируем кэш дня и перезагружаем актуальные данные.
          state.panel = null;
          if (App.state && App.state.diaryByDate) {
            delete App.state.diaryByDate[state.date];
          }
          loadAndRender();
        } else {
          // За вчера не было записей — просто сообщаем об этом.
          App.toast(pick("За вчера нет записей для копирования", "No entries yesterday to copy"));
        }
      })
      .catch(function (err) {
        App.haptic && App.haptic("error");
        App.toast((err && err.message) || pick("Не удалось скопировать вчерашний день", "Failed to copy yesterday"));
      })
      .then(function () {
        App.hideLoading();
      });
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
      // Сбрасываем состояние AI-панелей (план меню / умные предложения).
      state.plan = null;
      state.planScope = "day";
      state.planPrefs = "";
      state.suggestMeal = null;
      state.suggestText = "";

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
      // Сбрасываем состояние AI-панелей.
      state.plan = null;
      state.planPrefs = "";
      state.suggestMeal = null;
      state.suggestText = "";
    }
  };

  // Регистрируем страницу в приложении.
  // window.PageDiary — публичная ссылка на контроллер (на случай нужды извне).
  window.PageDiary = controller;
  App.registerPage("diary", controller);
})();
