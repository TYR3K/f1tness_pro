/**
 * page-diary.js — страница «Мой рацион».
 *
 * Регистрирует контроллер страницы через App.registerPage("diary", {...}).
 * Возможности:
 *   - Переключатель даты (◀ дата ▶), по умолчанию сегодняшний день.
 *   - Загрузка дневника за выбранную дату через App.api.getDiary(date).
 *   - Отрисовка четырёх приёмов пищи (Завтрак/Обед/Ужин/Перекус),
 *     в каждом — список записей (название + ккал + кнопка удаления ✕).
 *   - Удаление записи через App.api.deleteEntry(id) с последующей перезагрузкой.
 *   - Итог калорий за день + прогресс-бар относительно daily_goal_kcal.
 *   - Пустые состояния, скелетон загрузки, экран ошибки с кнопкой «Повторить».
 *
 * Весь пользовательский текст — на русском.
 */
(function () {
  "use strict";

  // Порядок и русские подписи приёмов пищи.
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
    loading: false     // флаг, чтобы не запускать параллельные перезагрузки
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
   * Сегодня -> «Сегодня», вчера -> «Вчера», иначе «18 июня 2026».
   * @param {string} isoDate "YYYY-MM-DD"
   * @returns {string}
   */
  function humanDate(isoDate) {
    var today = App.todayStr();
    if (isoDate === today) {
      return "Сегодня";
    }
    if (isoDate === shiftDate(today, -1)) {
      return "Вчера";
    }
    if (isoDate === shiftDate(today, 1)) {
      return "Завтра";
    }
    var months = [
      "января", "февраля", "марта", "апреля", "мая", "июня",
      "июля", "августа", "сентября", "октября", "ноября", "декабря"
    ];
    var parts = String(isoDate).split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(d) || !months[m]) {
      return isoDate; // запасной вариант, если дата вдруг некорректна
    }
    return d + " " + months[m] + " " + y;
  }

  /**
   * Возвращает корректное русское склонение слова «запись».
   * 1 запись, 2 записи, 5 записей.
   * @param {number} n
   * @returns {string}
   */
  function pluralEntries(n) {
    var abs = Math.abs(n) % 100;
    var last = abs % 10;
    if (abs > 10 && abs < 20) return "записей";
    if (last === 1) return "запись";
    if (last >= 2 && last <= 4) return "записи";
    return "записей";
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
   * @param {Object} entry DiaryEntryOut
   * @returns {string}
   */
  function entryRowHtml(entry) {
    var name = App.escapeHtml(entry.dish_name || "Без названия");
    var kcal = App.fmt(entry.calories || 0);
    return (
      '<li class="diary-entry" data-id="' + entry.id + '">' +
      '<div class="diary-entry__main">' +
      '<span class="diary-entry__name">' + name + "</span>" +
      '<span class="diary-entry__macros">Б ' + App.fmt(entry.proteins || 0) +
      " · Ж " + App.fmt(entry.fats || 0) +
      " · У " + App.fmt(entry.carbs || 0) + "</span>" +
      "</div>" +
      '<span class="diary-entry__kcal">' + kcal + " ккал</span>" +
      '<button class="diary-entry__del" type="button" ' +
      'data-id="' + entry.id + '" aria-label="Удалить запись" title="Удалить">✕</button>' +
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
    var label = App.mealLabel(mealType);
    var icon = MEAL_ICONS[mealType] || "🍽️";

    // Сумма калорий по приёму пищи.
    var mealKcal = 0;
    for (var i = 0; i < entries.length; i++) {
      mealKcal += Number(entries[i].calories) || 0;
    }

    var body;
    if (entries.length === 0) {
      // Пустое состояние конкретного приёма пищи.
      body = '<p class="diary-meal__empty">Пока ничего не добавлено</p>';
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
      '<span class="diary-meal__kcal">' + App.fmt(mealKcal) + " ккал</span>" +
      "</header>" +
      body +
      "</section>"
    );
  }

  /**
   * Разметка карточки с итогом дня и прогресс-баром цели.
   * @param {Object} day DiaryDayOut
   * @returns {string}
   */
  function totalsHtml(day) {
    var total = Number(day.total_calories) || 0;
    var goal = day.daily_goal_kcal; // может быть null

    var progressBlock;
    if (goal && goal > 0) {
      var pct = Math.round((total / goal) * 100);
      var width = Math.max(0, Math.min(100, pct)); // ширину ограничиваем 0..100%
      var over = total > goal;
      var remaining = goal - total;

      var hint;
      if (over) {
        hint = "Превышение на " + App.fmt(Math.abs(remaining)) + " ккал";
      } else {
        hint = "Осталось " + App.fmt(remaining) + " ккал";
      }

      progressBlock =
        '<div class="diary-progress">' +
        '<div class="diary-progress__track">' +
        '<div class="diary-progress__fill' + (over ? " is-over" : "") + '" ' +
        'style="width:' + width + '%"></div>' +
        "</div>" +
        '<div class="diary-progress__labels">' +
        '<span>' + App.fmt(total) + " / " + App.fmt(goal) + " ккал</span>" +
        '<span class="diary-progress__hint' + (over ? " is-over" : "") + '">' +
        App.escapeHtml(hint) + "</span>" +
        "</div>" +
        "</div>";
    } else {
      // Цель не задана — подсказываем перейти в аккаунт.
      progressBlock =
        '<p class="diary-total__nogoal">Цель калорий не задана. ' +
        "Установите её в разделе «Мой аккаунт».</p>";
    }

    return (
      '<section class="card diary-total">' +
      '<div class="diary-total__row">' +
      '<span class="diary-total__caption">Итого за день</span>' +
      '<span class="diary-total__value">' + App.fmt(total) + " ккал</span>" +
      "</div>" +
      '<div class="diary-total__macros">' +
      "Белки " + App.fmt(day.total_proteins || 0) + " г · " +
      "Жиры " + App.fmt(day.total_fats || 0) + " г · " +
      "Углеводы " + App.fmt(day.total_carbs || 0) + " г" +
      "</div>" +
      progressBlock +
      "</section>"
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
      'aria-label="Предыдущий день">◀</button>' +
      '<div class="diary-datebar__label">' +
      '<span class="diary-datebar__date">' + App.escapeHtml(humanDate(state.date)) + "</span>" +
      '<span class="diary-datebar__iso">' + App.escapeHtml(state.date) + "</span>" +
      "</div>" +
      '<button class="diary-datebar__nav" type="button" data-nav="next" ' +
      'aria-label="Следующий день">▶</button>' +
      "</div>"
    );
  }

  /**
   * Полная отрисовка дня (итоги + 4 секции приёмов пищи).
   * @param {Object} day DiaryDayOut
   */
  function renderDay(day) {
    var content = document.getElementById("diary-content");
    if (!content) return;

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
        '<p class="diary-empty__title">За этот день записей нет</p>' +
        '<p class="diary-empty__text">Откройте раздел «Определение», ' +
        "чтобы распознать блюдо и добавить его в рацион.</p>" +
        "</div>";
    }

    content.innerHTML = totalsHtml(day) + emptyDayHint + sections;

    // Навешиваем обработчики удаления на кнопки ✕.
    var delButtons = content.querySelectorAll(".diary-entry__del");
    for (var k = 0; k < delButtons.length; k++) {
      delButtons[k].addEventListener("click", onDeleteClick);
    }
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
      '<p class="diary-error__title">Не удалось загрузить рацион</p>' +
      '<p class="diary-error__text">' + App.escapeHtml(message || "Неизвестная ошибка") + "</p>" +
      '<button class="btn btn--cta diary-error__retry" type="button">Повторить</button>' +
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
        renderError((err && err.message) || "Проблема с сетью. Проверьте соединение.");
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
        App.toast("Запись удалена");
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
        App.toast((err && err.message) || "Не удалось удалить запись");
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

      // Базовая разметка: переключатель даты + контейнер для контента.
      viewEl.innerHTML =
        '<div class="page page-diary">' +
        '<h1 class="page__title">Мой рацион</h1>' +
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
    }
  };

  // Регистрируем страницу в приложении.
  // window.PageDiary — публичная ссылка на контроллер (на случай нужды извне).
  window.PageDiary = controller;
  App.registerPage("diary", controller);
})();
