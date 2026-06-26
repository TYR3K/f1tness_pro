/*
 * page-scan.js — страница «Определение» (📷)
 * Контроллер window.PageScan, регистрируется через App.registerPage("scan", {...}).
 *
 * Назначение страницы:
 *   1. Дать пользователю сфотографировать / загрузить фото блюда.
 *   2. Показать превью выбранного фото.
 *   3. Отправить фото на бэкенд (App.api.analyzeFood) с индикатором загрузки.
 *   4. Показать карточку результата с РЕДАКТИРУЕМЫМИ значениями: название,
 *      вес порции (граммы), калории, Б/Ж/У, бейдж уверенности, комментарий.
 *      При изменении веса порции калории и БЖУ пересчитываются пропорционально.
 *   5. Дать выбрать приём пищи (Завтрак/Обед/Ужин/Перекус) и добавить запись
 *      в рацион за сегодня (App.api.addDiary) с отредактированными значениями.
 *   6. Корректно обрабатывать ошибки (сеть/AI/неверный файл) с кнопкой повтора.
 *
 * Подписка (Этап 1): сканирование РАБОТАЕТ для бесплатных пользователей, но с
 *   дневным лимитом. На экране загрузки показываем счётчик «Осталось N из 3
 *   бесплатных сканирований» (для premium — «Безлимит»/скрыт). Если бэкенд
 *   отвечает 402 про исчерпанный лимит — вместо экрана ошибки показываем единый
 *   App.paywall (контроль доступа серверный, фронт лишь показывает).
 *
 * Весь UI-текст на русском. Идентификаторы/ключи — на английском.
 */
(function () {
  "use strict";

  // ===== Внутреннее состояние контроллера =====
  // Хранит выбранный файл, результат анализа и выбранный приём пищи.
  // Сбрасывается при reset() и при каждом новом show страницы.
  var state = {
    file: null,            // выбранный File (фото)
    previewUrl: null,      // objectURL для превью (нужно освобождать)
    result: null,          // результат анализа { dish_name, calories, proteins, fats, carbs, note, weight_grams, confidence, debug }
    base: null,            // исходные («сырые») значения анализа для пропорционального пересчёта
    edited: null,          // текущие отредактированные значения формы { dish_name, weight, calories, proteins, fats, carbs }
    mealType: "breakfast", // выбранный приём пищи по умолчанию
    scans: null,           // последний ответ getScansRemaining { used, limit, remaining, is_premium } или null
  };

  // Соответствие ключей приёмов пищи и русских подписей (для кнопок-чипов).
  // Источник истины по подписям — App.mealLabel, но порядок задаём здесь.
  var MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];

  // Русские подписи уровней уверенности модели.
  var CONFIDENCE_LABELS = { low: "низкая", medium: "средняя", high: "высокая" };

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
    state.base = null;
    state.edited = null;
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

  // Безопасное приведение к числу (для значений из input/анализа).
  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  // Округление значения макроса до одного знака (для аккуратного отображения в input).
  function round1(v) {
    return Math.round(num(v) * 10) / 10;
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

  // Премиум-статус пользователя (источник истины — App; здесь только удобный доступ).
  function isPremium() {
    return !!(App && typeof App.isPremium === "function" && App.isPremium());
  }

  // ===== Лимит бесплатных сканирований =====

  // Эвристика: похоже ли сообщение/ошибка на «лимит сканирований» (HTTP 402).
  // Бэкенд при free отдаёт detail {error:"scan_limit", message}; App.api бросает
  // Error с этим message. Дополнительно проверяем числовой код 402, если он есть.
  function isScanLimitError(err) {
    if (!err) return false;
    var status = err.status || err.code || err.httpStatus;
    if (status === 402 || status === "402") return true;
    var msg = (err && err.message ? String(err.message) : "").toLowerCase();
    if (!msg) return false;
    return (
      msg.indexOf("лимит") !== -1 ||
      msg.indexOf("scan") !== -1 ||
      msg.indexOf("scan_limit") !== -1 ||
      msg.indexOf("402") !== -1 ||
      msg.indexOf("сканир") !== -1
    );
  }

  // Запрашивает остаток бесплатных сканирований и обновляет счётчик на экране.
  // Best-effort: при ошибке просто не показываем счётчик (основной поток не ломаем).
  function loadScansRemaining() {
    if (!(App && App.api && typeof App.api.getScansRemaining === "function")) return;
    App.api
      .getScansRemaining()
      .then(function (res) {
        state.scans = res || null;
        updateScanCounter();
      })
      .catch(function () {
        // Счётчик вспомогательный — при сбое тихо скрываем.
        state.scans = null;
        updateScanCounter();
      });
  }

  // Возвращает HTML текущего счётчика сканирований (или "" если показывать нечего).
  function scanCounterHtml() {
    // Премиум / безлимит — либо «Безлимит», либо скрываем при remaining === -1.
    var s = state.scans;
    if (isPremium()) {
      return (
        '<p class="scan-counter scan-counter--premium">' +
        "Сканирование без ограничений" +
        "</p>"
      );
    }
    if (!s) return ""; // нет данных — ничего не показываем
    var remaining = num(s.remaining);
    if (s.is_premium || s.remaining === -1 || remaining < 0) {
      // На всякий случай дублируем premium-ветку, если статус пришёл из ответа.
      return (
        '<p class="scan-counter scan-counter--premium">' +
        "Сканирование без ограничений" +
        "</p>"
      );
    }
    var limit = num(s.limit);
    var low = remaining <= 0 ? " scan-counter--empty" : "";
    if (remaining <= 0) {
      return (
        '<p class="scan-counter scan-counter--free' + low + '">' +
        "Бесплатные сканирования на сегодня закончились" +
        "</p>"
      );
    }
    return (
      '<p class="scan-counter scan-counter--free' + low + '">' +
      "Осталось " + esc(fmt(remaining)) + " из " + esc(fmt(limit)) +
      " бесплатных сканирований" +
      "</p>"
    );
  }

  // Перерисовывает только узел счётчика на экране загрузки (если он сейчас виден).
  function updateScanCounter() {
    if (!viewEl) return;
    var slot = viewEl.querySelector("#scan-counter-slot");
    if (!slot) return; // мы не на экране загрузки — обновлять нечего
    slot.innerHTML = scanCounterHtml();
  }

  // ===== Корневой элемент представления =====
  // viewEl передаётся в onShow и сохраняется для перерисовок.
  var viewEl = null;

  // ===== Рендеринг экранов =====
  // Страница имеет несколько состояний, переключаемых через render():
  //   - нет файла           -> экран загрузки фото
  //   - есть файл, нет result-> экран превью (анализ запускается автоматически)
  //   - есть result         -> карточка результата + редактируемые поля + выбор приёма пищи
  // Ошибки показываются поверх через renderError().

  function render() {
    if (!viewEl) return;

    // При каждой смене экрана возвращаем прокрутку наверх,
    // чтобы короткий экран не «залип» прокрученным вниз.
    if (App && typeof App.scrollTop === "function") App.scrollTop();

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
          // Счётчик бесплатных сканирований (заполняется асинхронно из state.scans).
          '<div id="scan-counter-slot">' + scanCounterHtml() + "</div>" +
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

    // Подгружаем актуальный остаток сканирований (best-effort) — обновит счётчик.
    loadScansRemaining();
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

  // --- Экран 3: карточка результата с редактируемыми полями + выбор приёма пищи ---
  function renderResult() {
    var r = state.result || {};
    var e = state.edited || {};
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

    // Бейдж уверенности модели (low/medium/high -> низкая/средняя/высокая).
    var conf = r.confidence;
    var confHtml = "";
    if (conf && CONFIDENCE_LABELS[conf]) {
      confHtml =
        '<div class="scan-edit-confidence scan-edit-confidence--' + esc(conf) + '">' +
          '<span class="scan-edit-confidence__label">Уверенность ИИ:</span> ' +
          '<span class="scan-edit-confidence__value">' + esc(CONFIDENCE_LABELS[conf]) + "</span>" +
        "</div>";
    }

    // Комментарий от ИИ показываем только если он есть.
    var noteHtml = r.note
      ? '<p class="result-note">' + esc(r.note) + "</p>"
      : "";

    // Отладочный блок с «сырым» ответом модели (приходит только при DEBUG_AI).
    var debugHtml = r.debug
      ? '<details class="ai-debug">' +
          '<summary class="ai-debug__sum">Ответ модели (debug)</summary>' +
          '<pre class="ai-debug__pre">' + esc(JSON.stringify(r.debug, null, 2)) + "</pre>" +
        "</details>"
      : "";

    // Поле веса порции показываем всегда; если исходный вес неизвестен —
    // пропорциональный пересчёт не делаем, разрешая ручное редактирование значений.
    var hasBaseWeight = state.base && num(state.base.weight) > 0;
    var weightHintHtml = hasBaseWeight
      ? '<p class="scan-edit-hint">При изменении веса калории и БЖУ пересчитываются автоматически.</p>'
      : '<p class="scan-edit-hint">Вес порции не определён — отредактируйте значения вручную.</p>';

    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">Результат</h1>' +
          '<p class="page-subtitle">Проверьте и при необходимости поправьте значения перед добавлением.</p>' +
        "</header>" +
        '<div class="card result-card scan-edit-card">' +
          (src
            ? '<img class="result-card__img" src="' + esc(src) + '" alt="Фото блюда">'
            : "") +
          confHtml +
          '<form class="scan-edit-form" id="scan-edit-form" autocomplete="off">' +
            // Название блюда.
            '<label class="field scan-edit-field scan-edit-field--name">' +
              '<span class="field__label">Название</span>' +
              '<input type="text" class="field__input scan-edit-input" id="scan-edit-name" ' +
                'value="' + esc(e.dish_name == null ? "" : e.dish_name) + '" ' +
                'placeholder="Название блюда" maxlength="120">' +
            "</label>" +
            // Вес порции (граммы).
            '<label class="field scan-edit-field scan-edit-field--weight">' +
              '<span class="field__label">Вес порции, г</span>' +
              '<input type="number" inputmode="decimal" min="0" step="1" ' +
                'class="field__input scan-edit-input scan-edit-input--num" id="scan-edit-weight" ' +
                'value="' + esc(e.weight == null ? "" : e.weight) + '" placeholder="0">' +
            "</label>" +
            weightHintHtml +
            // Калории.
            '<label class="field scan-edit-field scan-edit-field--calories">' +
              '<span class="field__label">Калории, ккал</span>' +
              '<input type="number" inputmode="decimal" min="0" step="1" ' +
                'class="field__input scan-edit-input scan-edit-input--num" id="scan-edit-calories" ' +
                'value="' + esc(e.calories == null ? "" : e.calories) + '" placeholder="0">' +
            "</label>" +
            // Б/Ж/У в одну сетку.
            '<div class="scan-edit-macros">' +
              '<label class="field scan-edit-field scan-edit-field--macro">' +
                '<span class="field__label">Белки, г</span>' +
                '<input type="number" inputmode="decimal" min="0" step="0.1" ' +
                  'class="field__input scan-edit-input scan-edit-input--num" id="scan-edit-proteins" ' +
                  'value="' + esc(e.proteins == null ? "" : e.proteins) + '" placeholder="0">' +
              "</label>" +
              '<label class="field scan-edit-field scan-edit-field--macro">' +
                '<span class="field__label">Жиры, г</span>' +
                '<input type="number" inputmode="decimal" min="0" step="0.1" ' +
                  'class="field__input scan-edit-input scan-edit-input--num" id="scan-edit-fats" ' +
                  'value="' + esc(e.fats == null ? "" : e.fats) + '" placeholder="0">' +
              "</label>" +
              '<label class="field scan-edit-field scan-edit-field--macro">' +
                '<span class="field__label">Углеводы, г</span>' +
                '<input type="number" inputmode="decimal" min="0" step="0.1" ' +
                  'class="field__input scan-edit-input scan-edit-input--num" id="scan-edit-carbs" ' +
                  'value="' + esc(e.carbs == null ? "" : e.carbs) + '" placeholder="0">' +
              "</label>" +
            "</div>" +
          "</form>" +
          noteHtml +
        "</div>" +
        debugHtml +
        '<div class="meal-picker">' +
          '<p class="meal-picker__label">Добавить как:</p>' +
          '<div class="meal-chips" id="scan-meals">' + chips + "</div>" +
        "</div>" +
        '<button type="button" class="btn btn-cta btn-block" id="scan-add">' +
          "Добавить в рацион" +
        "</button>" +
        '<button type="button" class="btn btn-ghost btn-block" id="scan-reset">Отмена</button>' +
      "</section>";

    bindResultInputs(hasBaseWeight);

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

  // Привязка обработчиков к редактируемым полям результата.
  // hasBaseWeight: есть ли исходный (ненулевой) вес для пропорционального пересчёта.
  function bindResultInputs(hasBaseWeight) {
    var nameEl = viewEl.querySelector("#scan-edit-name");
    var weightEl = viewEl.querySelector("#scan-edit-weight");
    var calEl = viewEl.querySelector("#scan-edit-calories");
    var protEl = viewEl.querySelector("#scan-edit-proteins");
    var fatEl = viewEl.querySelector("#scan-edit-fats");
    var carbEl = viewEl.querySelector("#scan-edit-carbs");

    // Синхронизирует значение из input в state.edited (без перерасчёта).
    function syncField(key, el, isInt) {
      if (!el) return;
      if (key === "dish_name") {
        state.edited.dish_name = el.value;
        return;
      }
      // Пустую строку оставляем как "", чтобы не подставлять 0 на лету.
      if (el.value === "") {
        state.edited[key] = "";
        return;
      }
      var v = num(el.value);
      state.edited[key] = isInt ? Math.round(v) : round1(v);
    }

    if (nameEl) {
      nameEl.addEventListener("input", function () {
        state.edited.dish_name = nameEl.value;
      });
    }

    // Изменение веса -> пропорциональный пересчёт калорий и БЖУ от исходных значений.
    if (weightEl) {
      weightEl.addEventListener("input", function () {
        state.edited.weight = weightEl.value === "" ? "" : num(weightEl.value);

        if (!hasBaseWeight) {
          // Исходный вес неизвестен — пересчёт невозможен, оставляем ручное редактирование.
          return;
        }
        var baseW = num(state.base.weight);
        var newW = num(weightEl.value);
        // При пустом/нулевом весе пересчёт не делаем — ждём осмысленное значение.
        if (weightEl.value === "" || newW <= 0 || baseW <= 0) return;

        var k = newW / baseW;
        state.edited.calories = Math.round(num(state.base.calories) * k);
        state.edited.proteins = round1(num(state.base.proteins) * k);
        state.edited.fats = round1(num(state.base.fats) * k);
        state.edited.carbs = round1(num(state.base.carbs) * k);

        // Обновляем зависимые поля без полной перерисовки (фокус остаётся на весе).
        if (calEl) calEl.value = String(state.edited.calories);
        if (protEl) protEl.value = String(state.edited.proteins);
        if (fatEl) fatEl.value = String(state.edited.fats);
        if (carbEl) carbEl.value = String(state.edited.carbs);
      });
    }

    // Ручное редактирование калорий/БЖУ — просто синхронизируем в state.edited.
    if (calEl) calEl.addEventListener("input", function () { syncField("calories", calEl, true); });
    if (protEl) protEl.addEventListener("input", function () { syncField("proteins", protEl, false); });
    if (fatEl) fatEl.addEventListener("input", function () { syncField("fats", fatEl, false); });
    if (carbEl) carbEl.addEventListener("input", function () { syncField("carbs", carbEl, false); });
  }

  // --- Экран ошибки (с возможностью повтора) ---
  // mode: "analyze" — повтор анализа того же файла; "upload" — вернуться к выбору.
  function renderError(message, mode) {
    // Сбрасываем прокрутку наверх, чтобы экран ошибки был сразу виден целиком.
    if (App && typeof App.scrollTop === "function") App.scrollTop();

    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">Что-то пошло не так</h1>' +
        "</header>" +
        '<div class="card error-card">' +
          '<div class="error-card__icon" aria-hidden="true">⚠️</div>' +
          // Текст в прокручиваемом блоке: при DEBUG_AI сюда приходит и сырой ответ.
          '<div class="error-card__msg">' + esc(message) + "</div>" +
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

  // --- Экран лимита сканирований (единый paywall) ---
  // Вместо экрана ошибки при HTTP 402 (исчерпан лимит) показываем заблокированную
  // фичу через App.paywall. Контроль доступа серверный — фронт лишь показывает.
  // Освобождаем превью и сбрасываем выбранный файл, чтобы не зависнуть на превью.
  function renderScanLimit() {
    if (App && typeof App.scrollTop === "function") App.scrollTop();

    revokePreview();
    state.file = null;
    state.result = null;
    state.base = null;
    state.edited = null;

    if (App && typeof App.paywall === "function") {
      App.paywall(viewEl, {
        icon: "📷",
        title: "Лимит сканирований",
        desc: "На сегодня бесплатные сканирования закончились",
        bullets: [
          "Безлимитные сканирования по подписке",
          "AI-распознавание еды по фото",
        ],
      });
      return;
    }
    // Запасной вариант, если единый paywall недоступен — обычный экран ошибки.
    renderError(
      "На сегодня бесплатные сканирования закончились. Оформите подписку для безлимита.",
      "upload"
    );
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
    state.base = null;
    state.edited = null;
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

        var weight = res && res.weight_grams != null ? num(res.weight_grams) : 0;
        state.result = {
          dish_name: res && res.dish_name ? res.dish_name : "Не удалось распознать еду",
          calories: res ? num(res.calories) : 0,
          proteins: res ? num(res.proteins) : 0,
          fats: res ? num(res.fats) : 0,
          carbs: res ? num(res.carbs) : 0,
          weight_grams: weight,
          confidence: res && res.confidence ? res.confidence : null,
          note: res && res.note ? res.note : "",
          debug: res && res.debug ? res.debug : null,
        };

        // Исходные («сырые») значения — база для пропорционального пересчёта по весу.
        state.base = {
          weight: weight,
          calories: state.result.calories,
          proteins: state.result.proteins,
          fats: state.result.fats,
          carbs: state.result.carbs,
        };

        // Предзаполняем редактируемую форму результатами анализа.
        state.edited = {
          dish_name: state.result.dish_name,
          weight: weight > 0 ? weight : "",
          calories: Math.round(state.result.calories),
          proteins: round1(state.result.proteins),
          fats: round1(state.result.fats),
          carbs: round1(state.result.carbs),
        };

        render();

        // Успешный анализ потратил одно бесплатное сканирование — обновляем счётчик
        // (отрисуется при следующем возврате на экран загрузки; данные подтянем заранее).
        loadScansRemaining();
      })
      .catch(function (err) {
        if (state.file !== fileAtStart) return;
        // Если бэкенд отверг запрос из-за исчерпанного лимита (402) — показываем
        // единый paywall вместо обычного экрана ошибки.
        if (isScanLimitError(err)) {
          renderScanLimit();
          // Подтянем актуальный остаток (на случай, если paywall сменится).
          loadScansRemaining();
          return;
        }
        var msg =
          (err && err.message) ||
          "Не удалось проанализировать фото. Проверьте соединение и попробуйте снова.";
        renderError(msg, "analyze");
      })
      .finally(function () {
        if (App && typeof App.hideLoading === "function") App.hideLoading();
      });
  }

  // Добавление отредактированного блюда в дневник за сегодня.
  function addToDiary() {
    if (!state.edited) return;
    var e = state.edited;

    var dishName = (e.dish_name == null ? "" : String(e.dish_name)).trim();
    if (!dishName) {
      haptic("warning");
      toast("Укажите название блюда");
      var nameEl = viewEl && viewEl.querySelector("#scan-edit-name");
      if (nameEl) nameEl.focus();
      return;
    }

    // Формируем запись строго по форме DiaryEntryIn — из ОТРЕДАКТИРОВАННЫХ значений.
    var entry = {
      date: App.todayStr(),
      meal_type: state.mealType,
      dish_name: dishName,
      calories: Math.round(num(e.calories)),
      proteins: num(e.proteins),
      fats: num(e.fats),
      carbs: num(e.carbs),
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
      state.base = null;
      state.edited = null;
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
