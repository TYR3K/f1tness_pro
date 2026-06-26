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
 * Локализация (RU/EN): весь видимый пользователю текст оборачивается в
 *   App.pick("рус","eng") В МОМЕНТ РЕНДЕРА, чтобы смена языка давала нужный
 *   текст после перерисовки. Идентификаторы/ключи/console — НЕ переводятся.
 */
(function () {
  "use strict";

  // Безопасный выбор языка: если App.pick недоступен — отдаём русский вариант.
  // ВАЖНО: вызывать НА МОМЕНТ РЕНДЕРА (внутри render/обработчиков), а не один раз
  // на уровне модуля, чтобы смена языка отражалась после перерисовки.
  function L(ru, en) {
    if (App && typeof App.pick === "function") return App.pick(ru, en);
    return ru;
  }

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

  // ===== Внутреннее состояние ГОЛОСОВОГО ввода (Этап 2) =====
  // Отдельно от фото-потока. Хранит активную запись (MediaRecorder/stream/чанки)
  // и результат распознавания со списком РЕДАКТИРУЕМЫХ блюд.
  // Сбрасывается через voiceReset() и при каждом show страницы.
  var voice = {
    recording: false,      // идёт ли сейчас запись
    recorder: null,        // экземпляр MediaRecorder
    stream: null,          // активный MediaStream (треки нужно останавливать)
    chunks: [],            // собранные аудио-чанки (ondataavailable)
    timer: null,           // setInterval таймера записи
    seconds: 0,            // длительность текущей записи (сек)
    result: null,          // { transcript, meal_type } последнего распознавания
    items: null,           // массив редактируемых блюд [{dish_name,calories,proteins,fats,carbs}]
    mealType: "breakfast", // выбранный приём пищи для голосового результата
  };

  // Соответствие ключей приёмов пищи и подписей (для кнопок-чипов).
  // Источник истины по подписям — App.mealLabel, но порядок задаём здесь.
  var MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];

  // Подписи уровней уверenности модели. Локализуются в момент рендера
  // через confidenceLabel(), а не на уровне модуля.
  function confidenceLabel(conf) {
    if (conf === "low") return L("низкая", "low");
    if (conf === "medium") return L("средняя", "medium");
    if (conf === "high") return L("высокая", "high");
    return "";
  }

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

  // Локализованная подпись приёма пищи (через App.mealLabel, который сам
  // выбирает язык по App.pick в момент вызова).
  function mealLabel(type) {
    if (App && typeof App.mealLabel === "function") return App.mealLabel(type);
    return type;
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
      msg.indexOf("сканир") !== -1 ||
      msg.indexOf("limit") !== -1
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
        esc(L("Сканирование без ограничений", "Unlimited scans")) +
        "</p>"
      );
    }
    if (!s) return ""; // нет данных — ничего не показываем
    var remaining = num(s.remaining);
    if (s.is_premium || s.remaining === -1 || remaining < 0) {
      // На всякий случай дублируем premium-ветку, если статус пришёл из ответа.
      return (
        '<p class="scan-counter scan-counter--premium">' +
        esc(L("Сканирование без ограничений", "Unlimited scans")) +
        "</p>"
      );
    }
    var limit = num(s.limit);
    var low = remaining <= 0 ? " scan-counter--empty" : "";
    if (remaining <= 0) {
      return (
        '<p class="scan-counter scan-counter--free' + low + '">' +
        esc(L(
          "Бесплатные сканирования на сегодня закончились",
          "No free scans left today"
        )) +
        "</p>"
      );
    }
    return (
      '<p class="scan-counter scan-counter--free' + low + '">' +
      esc(L(
        "Осталось " + fmt(remaining) + " из " + fmt(limit) + " бесплатных сканирований",
        fmt(remaining) + " of " + fmt(limit) + " free scans left"
      )) +
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
          '<h1 class="page-title">' +
            esc(L("Определение еды", "Food recognition")) +
          "</h1>" +
          '<p class="page-subtitle">' +
            esc(L(
              "Сфотографируйте блюдо или загрузите фото — ИИ оценит калории и БЖУ.",
              "Take a photo of your dish or upload one — AI will estimate calories and macros."
            )) +
          "</p>" +
        "</header>" +
        '<div class="card scan-dropzone" id="scan-dropzone">' +
          '<div class="scan-dropzone__icon" aria-hidden="true">📷</div>' +
          '<p class="scan-dropzone__hint">' +
            esc(L(
              "Чёткое фото одной порции даёт точный результат.",
              "A clear photo of a single serving gives the best accuracy."
            )) +
          "</p>" +
          // Скрытый input: открываем камеру/галерею кнопкой.
          '<input type="file" id="scan-file" accept="image/*" capture="environment" hidden>' +
          '<button type="button" class="btn btn-cta btn-block" id="scan-pick">' +
            esc(L("Сфотографировать / Загрузить", "Take photo / Upload")) +
          "</button>" +
          // Голосовой ввод (Этап 2, премиум). Отдельная кнопка под фото.
          '<button type="button" class="btn btn-ghost btn-block scan-voice-btn" id="scan-voice-pick">' +
            "🎤 " + esc(L("Записать голосом", "Record by voice")) +
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

    // Голосовой ввод — отдельный поток (премиум-гейтинг внутри).
    var voiceBtn = viewEl.querySelector("#scan-voice-pick");
    if (voiceBtn) {
      voiceBtn.addEventListener("click", function () {
        haptic("light");
        onVoiceTap();
      });
    }

    // Подгружаем актуальный остаток сканирований (best-effort) — обновит счётчик.
    loadScansRemaining();
  }

  // --- Экран 2: превью выбранного фото (анализ идёт автоматически) ---
  function renderPreview() {
    var src = state.previewUrl || "";
    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">' +
            esc(L("Определение еды", "Food recognition")) +
          "</h1>" +
        "</header>" +
        '<div class="card scan-preview">' +
          '<img class="scan-preview__img" src="' + esc(src) + '" alt="' +
            esc(L("Выбранное фото", "Selected photo")) + '">' +
          '<p class="scan-preview__status">' +
            esc(L("Анализируем фото…", "Analyzing photo…")) +
          "</p>" +
        "</div>" +
        '<button type="button" class="btn btn-ghost btn-block" id="scan-cancel">' +
          esc(L("Отмена", "Cancel")) +
        "</button>" +
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

    // Бейдж уверенности модели (low/medium/high -> низкая/средняя/высокая | low/medium/high).
    var conf = r.confidence;
    var confHtml = "";
    var confLabel = confidenceLabel(conf);
    if (conf && confLabel) {
      confHtml =
        '<div class="scan-edit-confidence scan-edit-confidence--' + esc(conf) + '">' +
          '<span class="scan-edit-confidence__label">' +
            esc(L("Уверенность ИИ:", "AI confidence:")) +
          "</span> " +
          '<span class="scan-edit-confidence__value">' + esc(confLabel) + "</span>" +
        "</div>";
    }

    // Комментарий от ИИ показываем только если он есть (это данные API — не переводим).
    var noteHtml = r.note
      ? '<p class="result-note">' + esc(r.note) + "</p>"
      : "";

    // Отладочный блок с «сырым» ответом модели (приходит только при DEBUG_AI).
    var debugHtml = r.debug
      ? '<details class="ai-debug">' +
          '<summary class="ai-debug__sum">' +
            esc(L("Ответ модели (debug)", "Model response (debug)")) +
          "</summary>" +
          '<pre class="ai-debug__pre">' + esc(JSON.stringify(r.debug, null, 2)) + "</pre>" +
        "</details>"
      : "";

    // Поле веса порции показываем всегда; если исходный вес неизвестен —
    // пропорциональный пересчёт не делаем, разрешая ручное редактирование значений.
    var hasBaseWeight = state.base && num(state.base.weight) > 0;
    var weightHintHtml = hasBaseWeight
      ? '<p class="scan-edit-hint">' +
          esc(L(
            "При изменении веса калории и БЖУ пересчитываются автоматически.",
            "Calories and macros recalculate automatically when you change the weight."
          )) +
        "</p>"
      : '<p class="scan-edit-hint">' +
          esc(L(
            "Вес порции не определён — отредактируйте значения вручную.",
            "Serving weight not detected — edit the values manually."
          )) +
        "</p>";

    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">' +
            esc(L("Результат", "Result")) +
          "</h1>" +
          '<p class="page-subtitle">' +
            esc(L(
              "Проверьте и при необходимости поправьте значения перед добавлением.",
              "Review and adjust the values if needed before adding."
            )) +
          "</p>" +
        "</header>" +
        '<div class="card result-card scan-edit-card">' +
          (src
            ? '<img class="result-card__img" src="' + esc(src) + '" alt="' +
                esc(L("Фото блюда", "Dish photo")) + '">'
            : "") +
          confHtml +
          '<form class="scan-edit-form" id="scan-edit-form" autocomplete="off">' +
            // Название блюда.
            '<label class="field scan-edit-field scan-edit-field--name">' +
              '<span class="field__label">' +
                esc(L("Название", "Name")) +
              "</span>" +
              '<input type="text" class="field__input scan-edit-input" id="scan-edit-name" ' +
                'value="' + esc(e.dish_name == null ? "" : e.dish_name) + '" ' +
                'placeholder="' + esc(L("Название блюда", "Dish name")) + '" maxlength="120">' +
            "</label>" +
            // Вес порции (граммы).
            '<label class="field scan-edit-field scan-edit-field--weight">' +
              '<span class="field__label">' +
                esc(L("Вес порции, г", "Serving weight, g")) +
              "</span>" +
              '<input type="number" inputmode="decimal" min="0" step="1" ' +
                'class="field__input scan-edit-input scan-edit-input--num" id="scan-edit-weight" ' +
                'value="' + esc(e.weight == null ? "" : e.weight) + '" placeholder="0">' +
            "</label>" +
            weightHintHtml +
            // Калории.
            '<label class="field scan-edit-field scan-edit-field--calories">' +
              '<span class="field__label">' +
                esc(L("Калории, ккал", "Calories, kcal")) +
              "</span>" +
              '<input type="number" inputmode="decimal" min="0" step="1" ' +
                'class="field__input scan-edit-input scan-edit-input--num" id="scan-edit-calories" ' +
                'value="' + esc(e.calories == null ? "" : e.calories) + '" placeholder="0">' +
            "</label>" +
            // Б/Ж/У в одну сетку.
            '<div class="scan-edit-macros">' +
              '<label class="field scan-edit-field scan-edit-field--macro">' +
                '<span class="field__label">' +
                  esc(L("Белки, г", "Protein, g")) +
                "</span>" +
                '<input type="number" inputmode="decimal" min="0" step="0.1" ' +
                  'class="field__input scan-edit-input scan-edit-input--num" id="scan-edit-proteins" ' +
                  'value="' + esc(e.proteins == null ? "" : e.proteins) + '" placeholder="0">' +
              "</label>" +
              '<label class="field scan-edit-field scan-edit-field--macro">' +
                '<span class="field__label">' +
                  esc(L("Жиры, г", "Fat, g")) +
                "</span>" +
                '<input type="number" inputmode="decimal" min="0" step="0.1" ' +
                  'class="field__input scan-edit-input scan-edit-input--num" id="scan-edit-fats" ' +
                  'value="' + esc(e.fats == null ? "" : e.fats) + '" placeholder="0">' +
              "</label>" +
              '<label class="field scan-edit-field scan-edit-field--macro">' +
                '<span class="field__label">' +
                  esc(L("Углеводы, г", "Carbs, g")) +
                "</span>" +
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
          '<p class="meal-picker__label">' +
            esc(L("Добавить как:", "Add as:")) +
          "</p>" +
          '<div class="meal-chips" id="scan-meals">' + chips + "</div>" +
        "</div>" +
        '<button type="button" class="btn btn-cta btn-block" id="scan-add">' +
          esc(L("Добавить в рацион", "Add to diary")) +
        "</button>" +
        '<button type="button" class="btn btn-ghost btn-block" id="scan-reset">' +
          esc(L("Отмена", "Cancel")) +
        "</button>" +
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
          '<h1 class="page-title">' +
            esc(L("Что-то пошло не так", "Something went wrong")) +
          "</h1>" +
        "</header>" +
        '<div class="card error-card">' +
          '<div class="error-card__icon" aria-hidden="true">⚠️</div>' +
          // Текст в прокручиваемом блоке: при DEBUG_AI сюда приходит и сырой ответ.
          '<div class="error-card__msg">' + esc(message) + "</div>" +
          '<button type="button" class="btn btn-cta btn-block" id="scan-retry">' +
            esc(L("Повторить", "Retry")) +
          "</button>" +
          '<button type="button" class="btn btn-ghost btn-block" id="scan-back">' +
            esc(L("Выбрать другое фото", "Choose another photo")) +
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
        title: L("Лимит сканирований", "Scan limit reached"),
        desc: L(
          "На сегодня бесплатные сканирования закончились",
          "You've used all free scans for today"
        ),
        bullets: [
          L("Безлимитные сканирования по подписке", "Unlimited scans with a subscription"),
          L("AI-распознавание еды по фото", "AI food recognition from photos"),
        ],
      });
      return;
    }
    // Запасной вариант, если единый paywall недоступен — обычный экран ошибки.
    renderError(
      L(
        "На сегодня бесплатные сканирования закончились. Оформите подписку для безлимита.",
        "You've used all free scans for today. Subscribe for unlimited access."
      ),
      "upload"
    );
  }

  // ===== Логика =====

  // Обработка выбранного файла: валидация типа, создание превью, запуск анализа.
  function onFileChosen(file) {
    // Проверяем, что это изображение (мягкая проверка по MIME).
    if (file.type && file.type.indexOf("image/") !== 0) {
      toast(L("Пожалуйста, выберите изображение", "Please choose an image"));
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
          dish_name:
            res && res.dish_name
              ? res.dish_name
              : L("Не удалось распознать еду", "Could not recognize the food"),
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
          L(
            "Не удалось проанализировать фото. Проверьте соединение и попробуйте снова.",
            "Could not analyze the photo. Check your connection and try again."
          );
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
      toast(L("Укажите название блюда", "Enter a dish name"));
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
        toast(
          L("Добавлено в рацион: ", "Added to diary: ") + mealLabel(state.mealType)
        );
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
          L(
            "Не удалось добавить запись. Проверьте соединение и попробуйте снова.",
            "Could not add the entry. Check your connection and try again."
          );
        toast(msg);
      })
      .finally(function () {
        if (App && typeof App.hideLoading === "function") App.hideLoading();
      });
  }

  /* =====================================================================
   *  ГОЛОСОВОЙ ВВОД ЕДЫ (Этап 2)
   *  Отдельный от фото поток. Премиум-фича: гейтинг через App.paywall.
   *  Поддержка записи проверяется по navigator.mediaDevices + MediaRecorder.
   *  При отсутствии поддержки/доступа — фолбэк «отправьте голосовое боту».
   * ===================================================================== */

  // Поддерживается ли запись звука в этом окружении.
  function voiceRecordingSupported() {
    return !!(
      navigator &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof window.MediaRecorder !== "undefined"
    );
  }

  // Останавливает все треки активного аудиопотока и очищает таймер записи.
  // Вызывается в ЛЮБОМ исходе (стоп/отмена/ошибка), чтобы не держать микрофон.
  function voiceStopStream() {
    if (voice.timer) {
      try {
        clearInterval(voice.timer);
      } catch (e) {
        /* игнорируем */
      }
      voice.timer = null;
    }
    if (voice.stream) {
      try {
        var tracks = voice.stream.getTracks ? voice.stream.getTracks() : [];
        for (var i = 0; i < tracks.length; i++) {
          try {
            tracks[i].stop();
          } catch (e2) {
            /* игнорируем — трек мог уже остановиться */
          }
        }
      } catch (e3) {
        /* игнорируем */
      }
      voice.stream = null;
    }
    voice.recorder = null;
    voice.recording = false;
  }

  // Полный сброс голосового состояния (ресурсы + данные результата).
  function voiceReset() {
    voiceStopStream();
    voice.chunks = [];
    voice.seconds = 0;
    voice.result = null;
    voice.items = null;
    voice.mealType = "breakfast";
  }

  // Параметры paywall голосового ввода (контракт задачи).
  function voicePaywallOpts() {
    return {
      icon: "🎤",
      title: L("Голосовой ввод", "Voice input"),
      desc: L(
        "Опишите еду голосом — ИИ распознает блюда и калории",
        "Describe your meal by voice — AI detects dishes and calories"
      ),
      bullets: [
        L("Голосом вместо фото", "Voice instead of photo"),
        L("Несколько блюд за раз", "Several dishes at once"),
        L("Авто-расчёт КБЖУ", "Automatic calories & macros"),
      ],
    };
  }

  // Показывает paywall голосового ввода в текущем контейнере.
  function showVoicePaywall() {
    if (App && typeof App.scrollTop === "function") App.scrollTop();
    if (App && typeof App.paywall === "function") {
      App.paywall(viewEl, voicePaywallOpts());
    }
  }

  // Похоже ли на ошибку «нужен премиум» (402) для голосового потока.
  function isVoicePremiumError(err) {
    if (!err) return false;
    var status = err.status || err.code || err.httpStatus;
    if (status === 402 || status === "402") return true;
    var code = (err && err.code ? String(err.code) : "").toLowerCase();
    if (code.indexOf("premium") !== -1 || code.indexOf("subscription") !== -1) return true;
    var msg = (err && err.message ? String(err.message) : "").toLowerCase();
    if (!msg) return false;
    return (
      msg.indexOf("402") !== -1 ||
      msg.indexOf("премиум") !== -1 ||
      msg.indexOf("premium") !== -1 ||
      msg.indexOf("подписк") !== -1 ||
      msg.indexOf("subscription") !== -1
    );
  }

  // Тап по кнопке голосового ввода: гейтинг -> запись (или фолбэк).
  function onVoiceTap() {
    // ГЕЙТИНГ: голос — премиум.
    if (!isPremium()) {
      showVoicePaywall();
      return;
    }
    // Запись недоступна -> сразу фолбэк «отправьте голосовое боту».
    if (!voiceRecordingSupported()) {
      renderVoiceUnavailable();
      return;
    }
    startVoiceRecording();
  }

  // Запрашивает доступ к микрофону и запускает запись.
  function startVoiceRecording() {
    voiceReset();
    var stream;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(function (s) {
        stream = s;
        voice.stream = s;

        var rec;
        try {
          rec = new MediaRecorder(s);
        } catch (e) {
          // Некоторые окружения не умеют создать MediaRecorder из потока.
          voiceStopStream();
          renderVoiceUnavailable();
          return;
        }
        voice.recorder = rec;
        voice.chunks = [];

        rec.ondataavailable = function (ev) {
          if (ev && ev.data && ev.data.size > 0) {
            voice.chunks.push(ev.data);
          }
        };
        // onstop обрабатываем явно при нажатии «Стоп» (см. stopVoiceRecording),
        // чтобы отличить отправку от отмены.
        rec.onerror = function () {
          voiceStopStream();
          renderVoiceError(
            L(
              "Не удалось записать голос. Попробуйте ещё раз.",
              "Could not record the voice. Please try again."
            )
          );
        };

        try {
          rec.start();
        } catch (e2) {
          voiceStopStream();
          renderVoiceUnavailable();
          return;
        }

        voice.recording = true;
        voice.seconds = 0;
        renderVoiceRecording();

        // Таймер длительности записи.
        voice.timer = setInterval(function () {
          voice.seconds += 1;
          updateVoiceTimer();
        }, 1000);
      })
      .catch(function () {
        // Доступ к микрофону отклонён или недоступен -> фолбэк.
        voiceStopStream();
        renderVoiceUnavailable();
      });
  }

  // Останавливает запись по «Стоп», собирает Blob и отправляет на распознавание.
  function stopVoiceRecording() {
    var rec = voice.recorder;
    if (!rec) {
      // Нечего останавливать — возвращаемся к экрану загрузки.
      voiceReset();
      render();
      return;
    }

    // Останавливаем таймер сразу (визуально запись завершена).
    if (voice.timer) {
      try {
        clearInterval(voice.timer);
      } catch (e) {}
      voice.timer = null;
    }
    voice.recording = false;

    var mime = rec.mimeType || "audio/webm";

    // По событию stop собираем Blob и отправляем.
    rec.onstop = function () {
      // Освобождаем микрофон СРАЗУ после остановки рекордера.
      voiceStopStream();

      var blob;
      try {
        blob = new Blob(voice.chunks, { type: mime });
      } catch (e) {
        blob = new Blob(voice.chunks);
      }
      voice.chunks = [];

      if (!blob || blob.size === 0) {
        renderVoiceError(
          L(
            "Запись пустая. Попробуйте ещё раз.",
            "The recording is empty. Please try again."
          )
        );
        return;
      }

      var file = blobToVoiceFile(blob, mime);
      submitVoice(file);
    };

    try {
      rec.stop();
    } catch (e) {
      // Если stop не сработал — освобождаем ресурсы и показываем ошибку.
      voiceStopStream();
      renderVoiceError(
        L(
          "Не удалось завершить запись. Попробуйте ещё раз.",
          "Could not finish the recording. Please try again."
        )
      );
    }
  }

  // Отмена записи: останавливаем без отправки, сбрасываем к экрану загрузки.
  function cancelVoiceRecording() {
    var rec = voice.recorder;
    if (rec) {
      // Глушим onstop, чтобы не отправить запись после отмены.
      rec.onstop = null;
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch (e) {}
    }
    voiceReset();
    render();
  }

  // Делает File из Blob с именем по mime (контракт: webm/mp4/ogg -> иначе webm).
  function blobToVoiceFile(blob, mime) {
    var m = (mime || "").toLowerCase();
    var name = "voice.webm";
    if (m.indexOf("mp4") !== -1) name = "voice.mp4";
    else if (m.indexOf("ogg") !== -1) name = "voice.ogg";
    else if (m.indexOf("webm") !== -1) name = "voice.webm";

    var type = blob.type || mime || "audio/webm";
    try {
      return new File([blob], name, { type: type });
    } catch (e) {
      // Старые webview без конструктора File: дополняем Blob именем вручную.
      try {
        blob.name = name;
      } catch (e2) {}
      return blob;
    }
  }

  // Отправка аудио на бэкенд и обработка ответа.
  function submitVoice(file) {
    if (App && typeof App.showLoading === "function") App.showLoading();

    App.api
      .analyzeVoice(file)
      .then(function (res) {
        var rawItems = res && Array.isArray(res.items) ? res.items : [];
        // Нормализуем блюда к редактируемой форме.
        voice.items = rawItems.map(function (it) {
          it = it || {};
          return {
            dish_name: it.dish_name == null ? "" : String(it.dish_name),
            calories: Math.round(num(it.calories)),
            proteins: round1(num(it.proteins)),
            fats: round1(num(it.fats)),
            carbs: round1(num(it.carbs)),
          };
        });
        voice.result = {
          transcript: res && res.transcript ? String(res.transcript) : "",
          meal_type: res && res.meal_type ? res.meal_type : null,
        };
        // Приём пищи по умолчанию: из ответа или "breakfast".
        var mt = voice.result.meal_type;
        voice.mealType = MEAL_TYPES.indexOf(mt) !== -1 ? mt : "breakfast";

        renderVoiceResult();
      })
      .catch(function (err) {
        // 402/премиум -> paywall; иначе экран ошибки голоса.
        if (isVoicePremiumError(err)) {
          showVoicePaywall();
          return;
        }
        renderVoiceError(
          L(
            "Не удалось распознать голос. Попробуйте ещё раз.",
            "Could not recognize the voice. Please try again."
          )
        );
      })
      .finally(function () {
        if (App && typeof App.hideLoading === "function") App.hideLoading();
      });
  }

  // --- Экран записи голоса (таймер + индикатор + Стоп/Отмена) ---
  function renderVoiceRecording() {
    if (App && typeof App.scrollTop === "function") App.scrollTop();

    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">' +
            esc(L("Голосовой ввод", "Voice input")) +
          "</h1>" +
          '<p class="page-subtitle">' +
            esc(L(
              "Назовите блюда и примерные порции — затем нажмите «Стоп».",
              "Say the dishes and rough portions — then tap “Stop”."
            )) +
          "</p>" +
        "</header>" +
        '<div class="card scan-voice-rec">' +
          '<div class="scan-voice-rec__indicator" aria-hidden="true">' +
            '<span class="scan-voice-rec__pulse"></span>' +
            '<span class="scan-voice-rec__mic">🎤</span>' +
          "</div>" +
          '<p class="scan-voice-rec__status">' +
            esc(L("Идёт запись…", "Recording…")) +
          "</p>" +
          '<div class="scan-voice-rec__timer" id="scan-voice-timer">' +
            esc(formatVoiceTime(voice.seconds)) +
          "</div>" +
        "</div>" +
        '<button type="button" class="btn btn-cta btn-block scan-voice-stop" id="scan-voice-stop">' +
          esc(L("■ Стоп", "■ Stop")) +
        "</button>" +
        '<button type="button" class="btn btn-ghost btn-block scan-voice-cancel" id="scan-voice-cancel">' +
          esc(L("Отмена", "Cancel")) +
        "</button>" +
      "</section>";

    viewEl.querySelector("#scan-voice-stop").addEventListener("click", function () {
      haptic("medium");
      stopVoiceRecording();
    });
    viewEl.querySelector("#scan-voice-cancel").addEventListener("click", function () {
      haptic("light");
      cancelVoiceRecording();
    });
  }

  // Форматирует длительность записи в M:SS.
  function formatVoiceTime(totalSec) {
    var s = Math.max(0, Math.round(num(totalSec)));
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + ":" + (sec < 10 ? "0" + sec : "" + sec);
  }

  // Обновляет только узел таймера (без полной перерисовки экрана записи).
  function updateVoiceTimer() {
    if (!viewEl) return;
    var t = viewEl.querySelector("#scan-voice-timer");
    if (t) t.textContent = formatVoiceTime(voice.seconds);
  }

  // --- Экран «запись недоступна» (фолбэк на бота) ---
  function renderVoiceUnavailable() {
    if (App && typeof App.scrollTop === "function") App.scrollTop();
    voiceReset();

    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">' +
            esc(L("Голосовой ввод", "Voice input")) +
          "</h1>" +
        "</header>" +
        '<div class="card scan-voice-unavailable">' +
          '<div class="scan-voice-unavailable__icon" aria-hidden="true">🎤</div>' +
          '<p class="scan-voice-unavailable__msg">' +
            esc(L(
              "Запись недоступна. Отправьте голосовое сообщение боту — он распознает и добавит еду.",
              "Recording is unavailable. Send a voice message to the bot — it will recognize and add the food."
            )) +
          "</p>" +
          '<button type="button" class="btn btn-cta btn-block scan-voice-back" id="scan-voice-back">' +
            esc(L("Назад", "Back")) +
          "</button>" +
        "</div>" +
      "</section>";

    viewEl.querySelector("#scan-voice-back").addEventListener("click", function () {
      haptic("light");
      voiceReset();
      render();
    });
  }

  // --- Экран ошибки голоса (Повторить/Назад) ---
  function renderVoiceError(message) {
    if (App && typeof App.scrollTop === "function") App.scrollTop();
    voiceStopStream();

    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">' +
            esc(L("Что-то пошло не так", "Something went wrong")) +
          "</h1>" +
        "</header>" +
        '<div class="card error-card scan-voice-error">' +
          '<div class="error-card__icon" aria-hidden="true">⚠️</div>' +
          '<div class="error-card__msg">' + esc(message) + "</div>" +
          '<button type="button" class="btn btn-cta btn-block" id="scan-voice-retry">' +
            esc(L("Повторить", "Retry")) +
          "</button>" +
          '<button type="button" class="btn btn-ghost btn-block" id="scan-voice-error-back">' +
            esc(L("Назад", "Back")) +
          "</button>" +
        "</div>" +
      "</section>";

    viewEl.querySelector("#scan-voice-retry").addEventListener("click", function () {
      haptic("medium");
      voiceReset();
      onVoiceTap();
    });
    viewEl.querySelector("#scan-voice-error-back").addEventListener("click", function () {
      haptic("light");
      voiceReset();
      render();
    });
  }

  // --- Экран результата голоса: транскрипт + выбор приёма + список блюд ---
  function renderVoiceResult() {
    if (App && typeof App.scrollTop === "function") App.scrollTop();

    var items = Array.isArray(voice.items) ? voice.items : [];

    // Если ничего не распознано — сообщение и кнопка назад.
    if (!items.length) {
      viewEl.innerHTML =
        '<section class="page page-scan">' +
          '<header class="page-head">' +
            '<h1 class="page-title">' +
              esc(L("Голосовой ввод", "Voice input")) +
            "</h1>" +
          "</header>" +
          '<div class="card scan-voice-empty">' +
            '<div class="scan-voice-empty__icon" aria-hidden="true">🤷</div>' +
            (voice.result && voice.result.transcript
              ? '<p class="scan-voice-transcript">' + esc(voice.result.transcript) + "</p>"
              : "") +
            '<p class="scan-voice-empty__msg">' +
              esc(L(
                "Не удалось распознать блюда. Попробуйте сказать чётче.",
                "Could not detect any dishes. Try speaking more clearly."
              )) +
            "</p>" +
            '<button type="button" class="btn btn-cta btn-block" id="scan-voice-empty-retry">' +
              esc(L("Записать снова", "Record again")) +
            "</button>" +
            '<button type="button" class="btn btn-ghost btn-block" id="scan-voice-empty-back">' +
              esc(L("Назад", "Back")) +
            "</button>" +
          "</div>" +
        "</section>";

      viewEl.querySelector("#scan-voice-empty-retry").addEventListener("click", function () {
        haptic("medium");
        voiceReset();
        onVoiceTap();
      });
      viewEl.querySelector("#scan-voice-empty-back").addEventListener("click", function () {
        haptic("light");
        voiceReset();
        render();
      });
      return;
    }

    // Транскрипт (мелким) — данные распознавания, экранируем.
    var transcriptHtml =
      voice.result && voice.result.transcript
        ? '<p class="scan-voice-transcript">' +
            '<span class="scan-voice-transcript__label">' +
              esc(L("Распознано:", "Recognized:")) +
            "</span> " +
            esc(voice.result.transcript) +
          "</p>"
        : "";

    // Чипы выбора приёма пищи.
    var chips = MEAL_TYPES.map(function (t) {
      var active = t === voice.mealType ? " is-active" : "";
      return (
        '<button type="button" class="meal-chip' + active + '" data-meal="' + t + '">' +
          esc(mealLabel(t)) +
        "</button>"
      );
    }).join("");

    // Редактируемые строки блюд.
    var rowsHtml = items.map(function (it, idx) {
      return voiceItemRowHtml(it, idx);
    }).join("");

    viewEl.innerHTML =
      '<section class="page page-scan">' +
        '<header class="page-head">' +
          '<h1 class="page-title">' +
            esc(L("Распознанные блюда", "Recognized dishes")) +
          "</h1>" +
          '<p class="page-subtitle">' +
            esc(L(
              "Проверьте и поправьте значения перед добавлением.",
              "Review and adjust the values before adding."
            )) +
          "</p>" +
        "</header>" +
        '<div class="card scan-voice-card">' +
          transcriptHtml +
          '<div class="meal-picker">' +
            '<p class="meal-picker__label">' +
              esc(L("Добавить как:", "Add as:")) +
            "</p>" +
            '<div class="meal-chips" id="scan-voice-meals">' + chips + "</div>" +
          "</div>" +
          '<div class="scan-voice-items" id="scan-voice-items">' + rowsHtml + "</div>" +
        "</div>" +
        '<button type="button" class="btn btn-cta btn-block" id="scan-voice-add">' +
          esc(L("Добавить в рацион", "Add to diary")) +
        "</button>" +
        '<button type="button" class="btn btn-ghost btn-block" id="scan-voice-result-cancel">' +
          esc(L("Отмена", "Cancel")) +
        "</button>" +
      "</section>";

    // Выбор приёма пищи.
    var mealsWrap = viewEl.querySelector("#scan-voice-meals");
    mealsWrap.addEventListener("click", function (ev) {
      var btn = ev.target.closest(".meal-chip");
      if (!btn) return;
      var t = btn.getAttribute("data-meal");
      if (!t) return;
      voice.mealType = t;
      haptic("light");
      var all = mealsWrap.querySelectorAll(".meal-chip");
      all.forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-meal") === t);
      });
    });

    bindVoiceItemInputs();

    // Добавить все оставшиеся блюда в рацион.
    viewEl.querySelector("#scan-voice-add").addEventListener("click", function () {
      addVoiceToDiary();
    });

    // Отмена — полный сброс к экрану загрузки.
    viewEl.querySelector("#scan-voice-result-cancel").addEventListener("click", function () {
      haptic("light");
      voiceReset();
      render();
    });
  }

  // HTML одной редактируемой строки блюда голосового результата.
  function voiceItemRowHtml(it, idx) {
    it = it || {};
    return (
      '<div class="scan-voice-item" data-idx="' + idx + '">' +
        '<div class="scan-voice-item__head">' +
          '<input type="text" class="field__input scan-voice-input scan-voice-input--name" ' +
            'data-field="dish_name" data-idx="' + idx + '" ' +
            'value="' + esc(it.dish_name == null ? "" : it.dish_name) + '" ' +
            'placeholder="' + esc(L("Название блюда", "Dish name")) + '" maxlength="120">' +
          '<button type="button" class="scan-voice-item__remove" data-idx="' + idx + '" ' +
            'aria-label="' + esc(L("Удалить", "Remove")) + '">✕</button>' +
        "</div>" +
        '<div class="scan-voice-item__nums">' +
          voiceNumFieldHtml(L("Ккал", "Kcal"), "calories", idx, it.calories, "1") +
          voiceNumFieldHtml(L("Б", "P"), "proteins", idx, it.proteins, "0.1") +
          voiceNumFieldHtml(L("Ж", "F"), "fats", idx, it.fats, "0.1") +
          voiceNumFieldHtml(L("У", "C"), "carbs", idx, it.carbs, "0.1") +
        "</div>" +
      "</div>"
    );
  }

  // HTML компактного числового поля строки блюда.
  function voiceNumFieldHtml(label, field, idx, value, step) {
    return (
      '<label class="scan-voice-num">' +
        '<span class="scan-voice-num__label">' + esc(label) + "</span>" +
        '<input type="number" inputmode="decimal" min="0" step="' + esc(step) + '" ' +
          'class="field__input scan-voice-input scan-voice-input--num" ' +
          'data-field="' + esc(field) + '" data-idx="' + idx + '" ' +
          'value="' + esc(value == null ? "" : value) + '" placeholder="0">' +
      "</label>"
    );
  }

  // Привязка обработчиков к инпутам и кнопкам удаления строк голосового результата.
  function bindVoiceItemInputs() {
    var wrap = viewEl.querySelector("#scan-voice-items");
    if (!wrap) return;

    // Синхронизация значений инпутов в voice.items.
    wrap.addEventListener("input", function (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute) return;
      var field = el.getAttribute("data-field");
      if (!field) return;
      var idx = parseInt(el.getAttribute("data-idx"), 10);
      if (isNaN(idx) || !voice.items || !voice.items[idx]) return;

      if (field === "dish_name") {
        voice.items[idx].dish_name = el.value;
        return;
      }
      if (el.value === "") {
        voice.items[idx][field] = "";
        return;
      }
      var v = num(el.value);
      voice.items[idx][field] = field === "calories" ? Math.round(v) : round1(v);
    });

    // Удаление строки блюда.
    wrap.addEventListener("click", function (ev) {
      var btn = ev.target.closest(".scan-voice-item__remove");
      if (!btn) return;
      var idx = parseInt(btn.getAttribute("data-idx"), 10);
      if (isNaN(idx) || !voice.items) return;
      voice.items.splice(idx, 1);
      haptic("light");
      // Перерисовываем результат (переиндексация строк); если строк не осталось —
      // renderVoiceResult покажет «пусто».
      renderVoiceResult();
    });
  }

  // Добавление всех оставшихся распознанных блюд в дневник за сегодня.
  function addVoiceToDiary() {
    var items = Array.isArray(voice.items) ? voice.items : [];
    if (!items.length) {
      toast(L("Нет блюд для добавления", "No dishes to add"));
      return;
    }

    // Готовим записи строго по DiaryEntryIn; пропускаем строки без названия.
    var date = App.todayStr();
    var mealType = voice.mealType;
    var entries = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var dishName = (it.dish_name == null ? "" : String(it.dish_name)).trim();
      if (!dishName) continue;
      entries.push({
        date: date,
        meal_type: mealType,
        dish_name: dishName,
        calories: Math.round(num(it.calories)),
        proteins: num(it.proteins),
        fats: num(it.fats),
        carbs: num(it.carbs),
      });
    }

    if (!entries.length) {
      haptic("warning");
      toast(L("Укажите названия блюд", "Enter dish names"));
      return;
    }

    if (App && typeof App.showLoading === "function") App.showLoading();

    Promise.all(
      entries.map(function (entry) {
        return App.api.addDiary(entry);
      })
    )
      .then(function () {
        haptic("success");
        toast(
          L("Добавлено в рацион: ", "Added to diary: ") + mealLabel(mealType)
        );
        // Инвалидируем кэш дневника на сегодня.
        if (App.state && App.state.diaryByDate) {
          delete App.state.diaryByDate[date];
        }
        voiceReset();
        render();
      })
      .catch(function (err) {
        haptic("error");
        var msg =
          (err && err.message) ||
          L(
            "Не удалось добавить записи. Проверьте соединение и попробуйте снова.",
            "Could not add the entries. Check your connection and try again."
          );
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
      // Сбрасываем голосовой поток и освобождаем микрофон, если он был занят.
      voiceReset();
      render();
    },
    // Вызывается при уходе с вкладки — освобождаем ресурсы превью и микрофон.
    onHide: function () {
      revokePreview();
      // Останавливаем активную запись/поток (микрофон) при уходе со страницы.
      voiceStopStream();
    },
  };

  // Регистрируем контроллер в приложении.
  if (window.App && typeof App.registerPage === "function") {
    App.registerPage("scan", window.PageScan);
  }
})();
