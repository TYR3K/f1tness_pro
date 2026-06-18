/*
 * page-scan.js — страница «Определение» (📷)
 * Контроллер window.PageScan, регистрируется через App.registerPage("scan", {...}).
 *
 * Назначение страницы:
 *   1. Дать пользователю сфотографировать / загрузить фото блюда.
 *   2. Показать превью выбранного фото.
 *   3. Отправить фото на бэкенд (App.api.analyzeFood) с индикатором загрузки.
 *   4. Показать карточку результата: название блюда, калории, Б/Ж/У, комментарий.
 *   5. Дать выбрать приём пищи (Завтрак/Обед/Ужин/Перекус) и добавить запись
 *      в рацион за сегодня (App.api.addDiary) с уведомлением об успехе.
 *   6. Корректно обрабатывать ошибки (сеть/AI/неверный файл) с кнопкой повтора.
 *
 * Весь UI-текст на русском. Идентификаторы/ключи — на английском.
 */
(function () {
  "use strict";

  // ===== Внутреннее состояние контроллера =====
  // Хранит выбранный файл, результат анализа и выбранный приём пищи.
  // Сбрасывается при reset() и при каждом новом showe страницы.
  var state = {
    file: null,            // выбранный File (фото)
    previewUrl: null,      // objectURL для превью (нужно освобождать)
    result: null,          // результат анализа { dish_name, calories, proteins, fats, carbs, note }
    mealType: "breakfast", // выбранный приём пищи по умолчанию
  };

  // Соответствие ключей приёмов пищи и русских подписей (для кнопок-чипов).
  // Источник истины по подписям — App.mealLabel, но порядок задаём здесь.
  var MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];

  // ===== Утилиты =====

  // Освобождает ранее созданный objectURL превью (чтобы не текла память).
  function revokePreview() {
    if (state.previewUrl) {
      try {
        URL.revokeObjectURL(state.previewUrl);
      } catch (e) {
        /* игнорируем — браузер мог уже освободить URL */
      }
      state.previewUrl = null;
    }
  }

  // Полный сброс состояния страницы к исходному (экран загрузки фото).
  function reset() {
    revokePreview();
    state.file = null;
    state.result = null;
    state.mealType = "breakfast";
    render();
  }

  // Безопасное экранирование текста от AI/пользователя перед вставкой в HTML.
  function esc(s) {
    if (App && typeof App.escapeHtml === "function") {
      return App.escapeHtml(s == null ? "" : String(s));
    }
    // Запасной вариант, если хелпер недоступен.
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Форматирование числа (округление) через хелпер App.fmt с запасным вариантом.
  function fmt(n) {
    if (App && typeof App.fmt === "function") return App.fmt(n);
    var num = Number(n);
    return isFinite(num) ? String(Math.round(num)) : "0";
  }

  // Русская подпись приёма пищи.
  function mealLabel(type) {
    if (App && typeof App.mealLabel === "function") return App.mealLabel(type);
    var map = { breakfast: "Завтрак", lunch: "Обед", dinner: "Ужин", snack: "Перекус" };
    return map[type] || type;
  }

  // Короткий показ уведомления.
  function toast(msg) {
    if (App && typeof App.toast === "function") App.toast(msg);
  }

  // Лёгкая тактильная отдача (если доступна в Telegram).
  function haptic(kind) {
    if (App && typeof App.haptic === "function") App.haptic(kind);
  }

  // ===== Корневой элемент представления =====
  // viewEl передаётся в onShow и сохраняется для перерисовок.
  var viewEl = null;

  // ===== Рендеринг экранов =====
  // Страница имеет несколько состояний, переключаемых через render():
  //   - нет файла           -> экран загрузки фото
  //   - есть файл, нет result-> экран превью (анализ запускается автоматически)
  //   - есть result         -> карточка результата + выбор приёма пищи
  // Ошибки показываются поверх через renderError().

  function render() {
    if (!viewEl) return;

    if (state.result) {
      renderResult();
    } else if (state.file) {
      renderPreview();
    } else {
      renderUpload();
    }
  }

  // --- Экран 1: загрузка/съёмка фото ---
  function renderUpload() {
    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">Определение еды</h1>' +
          '<p class="page-subtitle">Сфотографируйте блюдо или загрузите фото — ' +
            'ИИ оценит калории и БЖУ.</p>' +
        "</header>" +
        '<div class="card scan-dropzone" id="scan-dropzone">' +
          '<div class="scan-dropzone__icon" aria-hidden="true">📷</div>' +
          '<p class="scan-dropzone__hint">Чёткое фото одной порции даёт точный результат.</p>' +
          // Скрытый input: открываем камеру/галерею кнопкой.
          '<input type="file" id="scan-file" accept="image/*" capture="environment" hidden>' +
          '<button type="button" class="btn btn-cta btn-block" id="scan-pick">' +
            "Сфотографировать / Загрузить" +
          "</button>" +
        "</div>" +
      "</section>";

    var fileInput = viewEl.querySelector("#scan-file");
    var pickBtn = viewEl.querySelector("#scan-pick");

    // Кнопка открывает системный диалог выбора файла/камеры.
    pickBtn.addEventListener("click", function () {
      haptic("light");
      fileInput.click();
    });

    // При выборе файла — валидируем и запускаем анализ.
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      onFileChosen(f);
    });
  }

  // --- Экран 2: превью выбранного фото (анализ идёт автоматически) ---
  function renderPreview() {
    var src = state.previewUrl || "";
    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">Определение еды</h1>' +
        "</header>" +
        '<div class="card scan-preview">' +
          '<img class="scan-preview__img" src="' + esc(src) + '" alt="Выбранное фото">' +
          '<p class="scan-preview__status">Анализируем фото…</p>' +
        "</div>" +
        '<button type="button" class="btn btn-ghost btn-block" id="scan-cancel">Отмена</button>' +
      "</section>";

    var cancelBtn = viewEl.querySelector("#scan-cancel");
    cancelBtn.addEventListener("click", function () {
      haptic("light");
      reset();
    });
  }

  // --- Экран 3: карточка результата + выбор приёма пищи ---
  function renderResult() {
    var r = state.result || {};
    var src = state.previewUrl || "";

    // Кнопки-чипы выбора приёма пищи.
    var chips = MEAL_TYPES.map(function (t) {
      var active = t === state.mealType ? " is-active" : "";
      return (
        '<button type="button" class="meal-chip' + active + '" data-meal="' + t + '">' +
          esc(mealLabel(t)) +
        "</button>"
      );
    }).join("");

    // Комментарий от ИИ показываем только если он есть.
    var noteHtml = r.note
      ? '<p class="result-note">' + esc(r.note) + "</p>"
      : "";

    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">Результат</h1>' +
        "</header>" +
        '<div class="card result-card">' +
          (src
            ? '<img class="result-card__img" src="' + esc(src) + '" alt="Фото блюда">'
            : "") +
          '<h2 class="result-card__name">' + esc(r.dish_name || "Без названия") + "</h2>" +
          '<div class="result-card__kcal">' +
            '<span class="result-card__kcal-val">' + fmt(r.calories) + "</span>" +
            '<span class="result-card__kcal-unit">ккал</span>' +
          "</div>" +
          '<div class="macros">' +
            '<div class="macro"><span class="macro__val">' + fmt(r.proteins) + " г</span>" +
              '<span class="macro__lbl">Белки</span></div>' +
            '<div class="macro"><span class="macro__val">' + fmt(r.fats) + " г</span>" +
              '<span class="macro__lbl">Жиры</span></div>' +
            '<div class="macro"><span class="macro__val">' + fmt(r.carbs) + " г</span>" +
              '<span class="macro__lbl">Углеводы</span></div>' +
          "</div>" +
          noteHtml +
        "</div>" +
        '<div class="meal-picker">' +
          '<p class="meal-picker__label">Добавить как:</p>' +
          '<div class="meal-chips" id="scan-meals">' + chips + "</div>" +
        "</div>" +
        '<button type="button" class="btn btn-cta btn-block" id="scan-add">' +
          "Добавить в рацион" +
        "</button>" +
        '<button type="button" class="btn btn-ghost btn-block" id="scan-reset">Отмена</button>' +
      "</section>";

    // Переключение выбранного приёма пищи.
    var mealsWrap = viewEl.querySelector("#scan-meals");
    mealsWrap.addEventListener("click", function (ev) {
      var btn = ev.target.closest(".meal-chip");
      if (!btn) return;
      var t = btn.getAttribute("data-meal");
      if (!t) return;
      state.mealType = t;
      haptic("light");
      // Перерисовываем чипы, чтобы обновить активный класс.
      var all = mealsWrap.querySelectorAll(".meal-chip");
      all.forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-meal") === t);
      });
    });

    // Добавление записи в рацион.
    viewEl.querySelector("#scan-add").addEventListener("click", function () {
      addToDiary();
    });

    // Отмена — полный сброс к экрану загрузки.
    viewEl.querySelector("#scan-reset").addEventListener("click", function () {
      haptic("light");
      reset();
    });
  }

  // --- Экран ошибки (с возможностью повтора) ---
  // mode: "analyze" — повтор анализа того же файла; "upload" — вернуться к выбору.
  function renderError(message, mode) {
    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">Что-то пошло не так</h1>' +
        "</header>" +
        '<div class="card error-card">' +
          '<div class="error-card__icon" aria-hidden="true">⚠️</div>' +
          '<p class="error-card__msg">' + esc(message) + "</p>" +
          '<button type="button" class="btn btn-cta btn-block" id="scan-retry">' +
            "Повторить" +
          "</button>" +
          '<button type="button" class="btn btn-ghost btn-block" id="scan-back">' +
            "Выбрать другое фото" +
          "</button>" +
        "</div>" +
      "</section>";

    viewEl.querySelector("#scan-retry").addEventListener("click", function () {
      haptic("medium");
      if (mode === "analyze" && state.file) {
        // Повторяем анализ того же файла.
        renderPreview();
        analyze();
      } else {
        reset();
      }
    });

    viewEl.querySelector("#scan-back").addEventListener("click", function () {
      haptic("light");
      reset();
    });
  }

  // ===== Логика =====

  // Обработка выбранного файла: валидация типа, создание превью, запуск анализа.
  function onFileChosen(file) {
    // Проверяем, что это изображение (мягкая проверка по MIME).
    if (file.type && file.type.indexOf("image/") !== 0) {
      toast("Пожалуйста, выберите изображение");
      return;
    }
    // Освобождаем предыдущее превью и готовим новое.
    revokePreview();
    state.file = file;
    state.result = null;
    try {
      state.previewUrl = URL.createObjectURL(file);
    } catch (e) {
      state.previewUrl = null;
    }
    renderPreview();
    analyze();
  }

  // Отправка фото на бэкенд и обработка ответа.
  function analyze() {
    if (!state.file) {
      reset();
      return;
    }
    var fileAtStart = state.file; // фиксируем, чтобы не показать чужой результат

    if (App && typeof App.showLoading === "function") App.showLoading();

    App.api
      .analyzeFood(state.file)
      .then(function (res) {
        // Если за время запроса пользователь сбросил/сменил файл — игнорируем ответ.
        if (state.file !== fileAtStart) return;
        state.result = {
          dish_name: res && res.dish_name ? res.dish_name : "Не удалось распознать еду",
          calories: res ? res.calories : 0,
          proteins: res ? res.proteins : 0,
          fats: res ? res.fats : 0,
          carbs: res ? res.carbs : 0,
          note: res && res.note ? res.note : "",
        };
        render();
      })
      .catch(function (err) {
        if (state.file !== fileAtStart) return;
        var msg =
          (err && err.message) ||
          "Не удалось проанализировать фото. Проверьте соединение и попробуйте снова.";
        renderError(msg, "analyze");
      })
      .finally(function () {
        if (App && typeof App.hideLoading === "function") App.hideLoading();
      });
  }

  // Добавление распознанного блюда в дневник за сегодня.
  function addToDiary() {
    if (!state.result) return;
    var r = state.result;

    // Формируем запись строго по форме DiaryEntryIn.
    var entry = {
      date: App.todayStr(),
      meal_type: state.mealType,
      dish_name: r.dish_name,
      calories: Math.round(Number(r.calories) || 0),
      proteins: Number(r.proteins) || 0,
      fats: Number(r.fats) || 0,
      carbs: Number(r.carbs) || 0,
    };

    if (App && typeof App.showLoading === "function") App.showLoading();

    App.api
      .addDiary(entry)
      .then(function () {
        haptic("success");
        toast("Добавлено в рацион: " + mealLabel(state.mealType));
        // Инвалидируем кэш дневника на сегодня, чтобы вкладка «Мой рацион» обновилась.
        if (App.state && App.state.diaryByDate) {
          delete App.state.diaryByDate[entry.date];
        }
        reset();
      })
      .catch(function (err) {
        haptic("error");
        var msg =
          (err && err.message) ||
          "Не удалось добавить запись. Проверьте соединение и попробуйте снова.";
        toast(msg);
      })
      .finally(function () {
        if (App && typeof App.hideLoading === "function") App.hideLoading();
      });
  }

  // ===== Контроллер страницы =====
  window.PageScan = {
    // Вызывается при показе вкладки. Получаем контейнер и рисуем экран загрузки.
    onShow: function (el) {
      viewEl = el;
      // Каждый показ начинаем «с чистого листа», освобождая прошлое превью.
      revokePreview();
      state.file = null;
      state.result = null;
      state.mealType = "breakfast";
      render();
    },
    // Вызывается при уходе с вкладки — освобождаем ресурсы превью.
    onHide: function () {
      revokePreview();
    },
  };

  // Регистрируем контроллер в приложении.
  if (window.App && typeof App.registerPage === "function") {
    App.registerPage("scan", window.PageScan);
  }
})();
