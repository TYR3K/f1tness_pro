/*
 * page-account.js — страница «Мой аккаунт».
 *
 * Регистрирует контроллер страницы через App.registerPage("account", {...}).
 * Возможности:
 *   - Шапка с аватаром (App.user.photo_url) и именем пользователя.
 *   - Форма профиля: вес, рост, возраст, пол (Мужской/Женский -> male/female),
 *     уровень активности и цель по калориям (ккал/день).
 *   - Кнопка «Рассчитать автоматически» — считает норму по формуле
 *     Миффлина-Сан Жеора на клиенте и подставляет её в поле цели.
 *   - Кнопка «Сохранить» — отправляет профиль через App.api.saveProfile.
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

      '<label class="field">' +
      '<span class="field__label">Цель по калориям, ккал/день</span>' +
      '<input class="field__input" id="accGoal" type="number" inputmode="numeric" min="0" step="1" placeholder="2000">' +
      "</label>" +

      '<button type="button" class="btn btn--ghost" id="accCalcBtn">⚙️ Рассчитать автоматически</button>' +
      '<button type="submit" class="btn btn--cta" id="accSaveBtn">Сохранить</button>' +

      '<p class="acc-hint">Расчёт выполняется по формуле Миффлина-Сан Жеора с учётом уровня активности.</p>' +
      "</form>" +

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

    if (p.daily_goal_kcal != null) els.goal.value = p.daily_goal_kcal;
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
   * Расчёт нормы калорий по формуле Миффлина-Сан Жеора на клиенте.
   * BMR = 10*вес + 6.25*рост - 5*возраст + (5 для муж. / -161 для жен.)
   * Цель = round(BMR * коэффициент активности).
   * @returns {number|null} цель в ккал либо null, если данных не хватает.
   */
  function calcMifflin() {
    var weight = readNum(els.weight);
    var height = readNum(els.height);
    var age = readNum(els.age);
    var gender = els.gender.value;
    var activity = Number(els.activity.value) || 1.375;

    if (weight == null || height == null || age == null) {
      return null;
    }

    var bmr =
      10 * weight + 6.25 * height - 5 * age + (gender === "female" ? -161 : 5);
    return Math.round(bmr * activity);
  }

  /**
   * Обработчик кнопки «Рассчитать автоматически».
   */
  function onCalc() {
    var goal = calcMifflin();
    if (goal == null) {
      App.toast("Заполните вес, рост и возраст для расчёта");
      App.haptic("error");
      return;
    }
    els.goal.value = goal;
    App.haptic("success");
    App.toast("Норма рассчитана: " + goal + " ккал");
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
      goal: viewEl.querySelector("#accGoal"),
      calcBtn: viewEl.querySelector("#accCalcBtn"),
      saveBtn: viewEl.querySelector("#accSaveBtn"),
      history: viewEl.querySelector("#accHistory")
    };
  }

  // ---- Контроллер страницы ----
  var controller = {
    /**
     * Вызывается при показе страницы: строит разметку, вешает обработчики,
     * подгружает профиль и историю.
     */
    onShow: function (viewEl) {
      viewEl.innerHTML = template();
      bindElements(viewEl);

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
