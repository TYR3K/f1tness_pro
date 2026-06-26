/*
 * app.js — ядро мини-приложения.
 * Определяет глобальный объект window.App: доступ к Telegram WebApp,
 * HTTP-клиент к бэкенду, простой роутер по страницам и набор хелперов.
 *
 * ВАЖНО: этот файл НЕ вызывает App.init() — инициализация запускается
 * отдельным inline-скриптом в конце index.html (после регистрации страниц).
 *
 * Все комментарии и тексты для пользователя — на русском языке.
 */
(function () {
  "use strict";

  // Ссылка на Telegram WebApp (может отсутствовать вне Telegram).
  var tg = (window.Telegram && window.Telegram.WebApp) || null;

  // Глобальный объект приложения. Страницы опираются на этот публичный контракт.
  var App = {
    // Telegram WebApp SDK (или null, если приложение открыто вне Telegram).
    tg: tg,

    // Telegram-пользователь из initDataUnsafe (или null).
    user: (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null,

    // Простой кэш состояния приложения.
    state: {
      profile: null, // последний загруженный профиль пользователя
      diaryByDate: {} // кэш дневника по датам: { "YYYY-MM-DD": DiaryDayOut }
    },

    // Статус подписки. По умолчанию — НЕ премиум (fail-safe: при сбое
    // загрузки показываем paywall, а не открываем платные фичи).
    // Заполняется в App.init после авторизации через App.api.getSubscription().
    subscription: {
      is_premium: false,
      is_owner: false,
      subscription_type: "free",
      subscription_until: null,
      tariffs: {},
      tribute_url: null
    },

    // Реестр зарегистрированных страниц: { name: controller }.
    _pages: {},

    // Имя текущей активной страницы (или null до первой навигации).
    _current: null
  };

  /* =====================================================================
   *  HTTP-КЛИЕНТ
   *  Базовый URL — тот же origin (""), что и статика, отдаваемая бэкендом.
   * ===================================================================== */

  // Имя заголовка авторизации Telegram (должно совпадать с бэкендом).
  var INIT_HEADER = "X-Telegram-Init-Data";

  /**
   * Возвращает строку initData для авторизации.
   * Если приложение открыто вне Telegram — вернёт пустую строку
   * (бэкенд может разрешить dev-режим через ALLOW_INSECURE_AUTH).
   */
  function initData() {
    return (App.tg && App.tg.initData) || "";
  }

  /**
   * Универсальная обёртка над fetch.
   * - Всегда добавляет заголовок X-Telegram-Init-Data.
   * - Для JSON-тела ставит Content-Type: application/json и сериализует объект.
   * - Для FormData НЕ выставляет Content-Type вручную (его проставит браузер
   *   вместе с boundary).
   * - При ответе !res.ok бросает Error с текстом detail от сервера.
   *
   * @param {string} path  путь запроса (например, "/api/profile")
   * @param {object} [opts] { method, body, isForm }
   * @returns {Promise<any>} распарсенный JSON-ответ
   */
  function request(path, opts) {
    opts = opts || {};
    var method = opts.method || "GET";
    var headers = {};
    // Заголовок авторизации Telegram присутствует во всех запросах.
    headers[INIT_HEADER] = initData();

    var fetchOpts = { method: method, headers: headers };

    if (opts.isForm) {
      // FormData: тело передаём как есть, Content-Type не трогаем.
      fetchOpts.body = opts.body;
    } else if (opts.body !== undefined && opts.body !== null) {
      // JSON: проставляем заголовок и сериализуем тело.
      headers["Content-Type"] = "application/json";
      fetchOpts.body = JSON.stringify(opts.body);
    }

    return fetch(path, fetchOpts).then(function (res) {
      // Пытаемся разобрать тело ответа как JSON (даже при ошибке —
      // там может лежать detail с описанием проблемы).
      return res
        .text()
        .then(function (raw) {
          var data = null;
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch (e) {
              data = null; // тело не JSON — оставляем null
            }
          }

          if (!res.ok) {
            // Достаём осмысленное сообщение об ошибке от сервера.
            var detail = "";
            if (data && typeof data === "object") {
              if (typeof data.detail === "string") {
                detail = data.detail;
              } else if (data.detail && typeof data.detail === "object") {
                // detail может быть объектом {error, message} (например 402)
                // или массивом ошибок валидации pydantic.
                if (typeof data.detail.message === "string") {
                  detail = data.detail.message;
                } else {
                  try {
                    detail = JSON.stringify(data.detail);
                  } catch (e2) {
                    detail = String(data.detail);
                  }
                }
              } else if (data.detail) {
                detail = String(data.detail);
              } else if (typeof data.message === "string") {
                detail = data.message;
              }
            }
            if (!detail) {
              detail = raw || "Ошибка " + res.status;
            }
            var err = new Error(detail);
            // Прокидываем HTTP-статус и машиночитаемый код ошибки наверх,
            // чтобы страницы могли отличить paywall (402) от прочих сбоев.
            err.status = res.status;
            if (data && data.detail && typeof data.detail === "object" &&
                typeof data.detail.error === "string") {
              err.code = data.detail.error;
            }
            throw err;
          }

          return data;
        });
    }).catch(function (err) {
      // Отдельно обрабатываем сетевые сбои (бэкенд недоступен, нет интернета).
      if (err instanceof TypeError) {
        throw new Error("Нет соединения с сервером. Проверьте интернет.");
      }
      throw err;
    });
  }

  /**
   * Публичный API-клиент. Каждый метод возвращает Promise и
   * бросает Error(message) при неудаче.
   */
  App.api = {
    // Подтверждение авторизации и получение профиля (триггерит upsert на бэке).
    verify: function () {
      return request("/auth/verify", { method: "POST" });
    },

    // Анализ фото еды. Принимает File, отправляет multipart/form-data.
    analyzeFood: function (file) {
      var form = new FormData();
      form.append("file", file);
      return request("/food/analyze", {
        method: "POST",
        body: form,
        isForm: true
      });
    },

    // Добавление записи в дневник (тело — DiaryEntryIn).
    addDiary: function (entry) {
      return request("/diary/add", { method: "POST", body: entry });
    },

    // Получение дневника за конкретную дату ("YYYY-MM-DD").
    getDiary: function (dateStr) {
      return request("/diary/" + encodeURIComponent(dateStr));
    },

    // Удаление записи дневника по id.
    deleteEntry: function (id) {
      return request("/diary/" + encodeURIComponent(id), { method: "DELETE" });
    },

    // Получение профиля пользователя.
    getProfile: function () {
      return request("/profile");
    },

    // Сохранение профиля (тело — ProfileIn, все поля опциональны).
    saveProfile: function (data) {
      return request("/profile", { method: "POST", body: data });
    },

    // История за последние N дней (по умолчанию 30).
    getHistory: function (days) {
      var d = days || 30;
      return request("/history?days=" + encodeURIComponent(d));
    },

    /* -------------------------------------------------------------------
     *  ТРЕНИРОВКИ
     * ------------------------------------------------------------------- */

    // Добавление тренировки. Тело: {date, type, duration_min, calories_burned}.
    // Ответ: {id, date, type, duration_min, calories_burned}.
    addWorkout: function (w) {
      return request("/workout/add", { method: "POST", body: w });
    },

    // Тренировки за дату ("YYYY-MM-DD"). Ответ: {date, workouts:[...], total_burned}.
    getWorkouts: function (dateStr) {
      return request("/workout/" + encodeURIComponent(dateStr));
    },

    // Удаление тренировки по id. Ответ: {ok}.
    deleteWorkout: function (id) {
      return request("/workout/" + encodeURIComponent(id), { method: "DELETE" });
    },

    // Оценка сожжённых калорий. Тело: {type, duration_min}.
    // Ответ: {calories_burned, met}.
    estimateWorkout: function (payload) {
      return request("/workout/estimate", { method: "POST", body: payload });
    },

    /* -------------------------------------------------------------------
     *  ЕДА (ручной ввод, недавнее, рекомендации)
     * ------------------------------------------------------------------- */

    // Ручное добавление блюда в дневник.
    // Тело: {date, meal_type, dish_name, calories, proteins, fats, carbs}.
    // Ответ: DiaryEntryOut.
    addManualFood: function (entry) {
      return request("/food/manual", { method: "POST", body: entry });
    },

    // Недавно добавленные блюда.
    // Ответ: {items:[{dish_name, calories, proteins, fats, carbs}]}.
    getRecentFoods: function () {
      return request("/food/recent");
    },

    // Рекомендации блюд по остатку нормы.
    // Тело: {remaining_calories, remaining_proteins, remaining_fats,
    //        remaining_carbs, diet_goal?, time_of_day?}.
    // Ответ: {suggestions:[{dish_name, calories, proteins, fats, carbs, reason}]}.
    recommendFood: function (payload) {
      return request("/food/recommend", { method: "POST", body: payload });
    },

    /* -------------------------------------------------------------------
     *  ДОБАВКИ (БАДы, витамины и т.п.)
     * ------------------------------------------------------------------- */

    // Добавление добавки.
    // Тело: {name, type, dosage, intake_time?, reminder_enabled?}.
    // Ответ: {id, name, type, dosage, intake_time, reminder_enabled}.
    addSupplement: function (s) {
      return request("/supplement/add", { method: "POST", body: s });
    },

    // Список добавок. Ответ: {items:[...]}.
    getSupplements: function () {
      return request("/supplement/list");
    },

    // Удаление добавки по id. Ответ: {ok}.
    deleteSupplement: function (id) {
      return request("/supplement/" + encodeURIComponent(id), {
        method: "DELETE"
      });
    },

    // Подсказки по добавкам.
    // Ответ: {suggestions:[{name, dosage, note}], disclaimer}.
    suggestSupplements: function () {
      return request("/supplement/suggest");
    },

    /* -------------------------------------------------------------------
     *  ЦЕЛЬ ПО КАЛОРИЯМ
     * ------------------------------------------------------------------- */

    // Расчёт дневной нормы. Тело: {weight?, height?, age?, gender?,
    //   activity_level?, diet_goal?}.
    // Ответ: {daily_goal_kcal, target_proteins, target_fats, target_carbs,
    //   diet_goal, bmr, tdee}.
    // ВНИМАНИЕ: сервер сам сохраняет результат в профиль.
    calculateGoal: function (payload) {
      return request("/goal/calculate", { method: "POST", body: payload });
    },

    /* -------------------------------------------------------------------
     *  УВЕДОМЛЕНИЯ
     * ------------------------------------------------------------------- */

    // Текущие настройки уведомлений.
    // Ответ: {telegram_id, meal_reminder_enabled, breakfast_time, lunch_time,
    //   dinner_time, training_reminder_enabled, training_time,
    //   supplement_reminder_enabled, daily_summary_enabled, summary_time}.
    getNotificationSettings: function () {
      return request("/notifications/settings");
    },

    // Сохранение настроек уведомлений (частичный объект тех же полей).
    // Ответ: NotificationSettingsOut.
    saveNotificationSettings: function (payload) {
      return request("/notifications/settings", {
        method: "POST",
        body: payload
      });
    },

    /* -------------------------------------------------------------------
     *  НАПОМИНАНИЯ О ТРЕНИРОВКАХ
     *  weekdays: массив int (0=Пн,1=Вт,2=Ср,3=Чт,4=Пт,5=Сб,6=Вс).
     * ------------------------------------------------------------------- */

    // Список напоминаний о тренировке.
    // Ответ: {items:[{id, weekdays:[int], time, enabled}]}.
    getTrainingReminders: function () {
      return request("/reminders/training");
    },

    // Добавление напоминания о тренировке.
    // Тело: {weekdays:[int], time, enabled}.
    // Ответ: {id, weekdays, time, enabled}.
    addTrainingReminder: function (r) {
      return request("/reminders/training", { method: "POST", body: r });
    },

    // Удаление напоминания о тренировке по id. Ответ: {ok}.
    deleteTrainingReminder: function (id) {
      return request("/reminders/training/" + encodeURIComponent(id), {
        method: "DELETE"
      });
    },

    /* -------------------------------------------------------------------
     *  НАПОМИНАНИЯ О ПРИЁМЕ ДОБАВОК
     * ------------------------------------------------------------------- */

    // Список напоминаний о приёме добавок.
    // Ответ: {items:[{id, label, time, enabled, supplements:[{id, name}]}]}.
    getSupplementReminders: function () {
      return request("/reminders/supplement");
    },

    // Добавление напоминания о приёме добавок.
    // Тело: {label, time, enabled, supplement_ids:[int]}.
    // Ответ: {id, label, time, enabled, supplements:[{id, name}]}.
    addSupplementReminder: function (r) {
      return request("/reminders/supplement", { method: "POST", body: r });
    },

    // Удаление напоминания о приёме добавок по id. Ответ: {ok}.
    deleteSupplementReminder: function (id) {
      return request("/reminders/supplement/" + encodeURIComponent(id), {
        method: "DELETE"
      });
    },

    /* -------------------------------------------------------------------
     *  AI-РЕКОМЕНДАЦИИ ДОБАВОК ПО ЦЕЛИ УЛУЧШЕНИЯ
     * ------------------------------------------------------------------- */

    // Подбор добавок под цель улучшения.
    // Тело: {improvement_goal}.
    // Ответ: {suggestions:[{name, dosage, note}], disclaimer,
    //   training_count, improvement_goal}.
    recommendSupplements: function (payload) {
      return request("/supplement/recommend", {
        method: "POST",
        body: payload
      });
    },

    /* -------------------------------------------------------------------
     *  ПОДПИСКА И ОПЛАТА (Этап 1)
     * ------------------------------------------------------------------- */

    // Статус подписки пользователя.
    // Ответ: {subscription_type, subscription_until, is_premium, is_owner,
    //   tariffs:{monthly:{stars,days}, yearly:{stars,days}, lifetime:{stars,days}},
    //   tribute_url}.
    getSubscription: function () {
      return request("/subscription/status");
    },

    // Остаток бесплатных сканирований на сегодня.
    // Ответ: {used, limit, remaining (-1=безлимит), is_premium}.
    getScansRemaining: function () {
      return request("/scans/remaining");
    },

    // Создание инвойса Telegram Stars для оплаты подписки.
    // Тело: {tariff:"monthly"|"yearly"|"lifetime"}.
    // Ответ: {invoice_link}.
    createStarsInvoice: function (tariff) {
      return request("/payment/stars/invoice", {
        method: "POST",
        body: { tariff: tariff }
      });
    }
  };

  /* =====================================================================
   *  РОУТЕР ПО СТРАНИЦАМ
   * ===================================================================== */

  /**
   * Регистрирует страницу.
   * @param {string} name  одно из {scan, diary, account, workouts, supplements, subscription}
   * @param {object} controller { onShow(viewEl), onHide?() }
   */
  App.registerPage = function (name, controller) {
    App._pages[name] = controller;
  };

  /**
   * Переход на страницу по имени.
   * Вызывает onHide текущей страницы, очищает #view, подсвечивает таб
   * и вызывает onShow целевой страницы.
   * @param {string} name
   */
  App.navigate = function (name) {
    var target = App._pages[name];
    if (!target) {
      // Запрошена незарегистрированная страница — игнорируем во избежание краша.
      return;
    }

    // Скрываем текущую страницу (если у неё есть обработчик onHide).
    if (App._current && App._pages[App._current]) {
      var prev = App._pages[App._current];
      if (typeof prev.onHide === "function") {
        try {
          prev.onHide();
        } catch (e) {
          // Ошибка в onHide не должна блокировать навигацию.
          console.error("Ошибка в onHide страницы " + App._current, e);
        }
      }
    }

    // Очищаем контейнер представления.
    var viewEl = document.getElementById("view");
    if (viewEl) {
      viewEl.innerHTML = "";
    }

    // Обновляем активный таб в нижней навигации.
    var tabs = document.querySelectorAll("#tabbar .tab");
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (t.getAttribute("data-page") === name) {
        t.classList.add("active");
      } else {
        t.classList.remove("active");
      }
    }

    App._current = name;

    // Показываем целевую страницу.
    if (typeof target.onShow === "function") {
      target.onShow(viewEl);
    }

    // Сбрасываем прокрутку наверх: иначе после смены экрана (или короткого
    // экрана ошибки) можно «застрять» прокрученным вниз без возможности вернуться.
    App.scrollTop();
  };

  /* =====================================================================
   *  ПОДПИСКА: ЕДИНЫЙ PAYWALL И ОПЛАТА
   *  Контроль доступа — на бэкенде (платные роуты отдают 402). Фронт лишь
   *  ПОКАЗЫВАЕТ paywall и предлагает оформить подписку, не дублируя проверки
   *  как «безопасность».
   * ===================================================================== */

  /**
   * Премиум ли текущий пользователь (по кэшированному статусу).
   * @returns {boolean}
   */
  App.isPremium = function () {
    return !!(App.subscription && App.subscription.is_premium);
  };

  /**
   * Перезагружает статус подписки в App.subscription (best-effort).
   * При ошибке статус НЕ меняется (остаётся прежним).
   * @returns {Promise}
   */
  App.refreshSubscription = function () {
    return App.api
      .getSubscription()
      .then(function (status) {
        if (status && typeof status === "object") {
          App.subscription = status;
        }
        return App.subscription;
      })
      .catch(function (err) {
        // Не критично: оставляем прежний статус. Логируем для диагностики.
        console.warn("Не удалось обновить статус подписки: " + err.message);
        return App.subscription;
      });
  };

  /**
   * Рендерит экран-заглушку (paywall) заблокированной фичи в контейнер.
   * @param {HTMLElement} viewEl  контейнер для вставки
   * @param {object} [opts] { icon, title, desc, bullets:[...] }
   */
  App.paywall = function (viewEl, opts) {
    if (!viewEl) {
      return;
    }
    opts = opts || {};
    var icon = opts.icon || "🔒";
    var title = opts.title || "Премиум-функция";
    var desc = opts.desc || "Эта возможность доступна по подписке";
    var bullets = Array.isArray(opts.bullets) ? opts.bullets : [];

    var bulletsHtml = "";
    if (bullets.length) {
      var items = "";
      for (var i = 0; i < bullets.length; i++) {
        items +=
          '<li class="paywall-bullet">' +
          '<span class="paywall-bullet-mark" aria-hidden="true">✓</span>' +
          '<span class="paywall-bullet-text">' +
          App.escapeHtml(bullets[i]) +
          "</span>" +
          "</li>";
      }
      bulletsHtml = '<ul class="paywall-bullets">' + items + "</ul>";
    }

    var html =
      '<section class="paywall">' +
      '<div class="card paywall-card">' +
      '<div class="paywall-icon" aria-hidden="true">' +
      App.escapeHtml(icon) +
      "</div>" +
      '<h2 class="paywall-title">' +
      App.escapeHtml(title) +
      "</h2>" +
      '<p class="paywall-desc">' +
      App.escapeHtml(desc) +
      "</p>" +
      bulletsHtml +
      "</div>" +
      '<div class="paywall-lock">' +
      '<span class="paywall-lock-icon" aria-hidden="true">🔒</span>' +
      '<span class="paywall-lock-text">Недоступно — нужна подписка</span>' +
      "</div>" +
      '<button type="button" class="btn btn-cta btn-block paywall-cta" id="paywall-subscribe">' +
      "Оформить подписку" +
      "</button>" +
      "</section>";

    viewEl.innerHTML = html;

    var btn = viewEl.querySelector("#paywall-subscribe");
    if (btn) {
      btn.addEventListener("click", function () {
        App.haptic("light");
        App.navigate("subscription");
      });
    }
  };

  /**
   * Требует премиум для показа фичи. Если премиум есть — возвращает true.
   * Иначе рендерит paywall в контейнер и возвращает false.
   * Страницы используют как ранний выход:
   *   if (!App.requirePremium(viewEl, {...})) return;
   * @param {HTMLElement} viewEl
   * @param {object} [opts]
   * @returns {boolean}
   */
  App.requirePremium = function (viewEl, opts) {
    if (App.isPremium()) {
      return true;
    }
    App.paywall(viewEl, opts);
    return false;
  };

  /**
   * Запускает оплату подписки тарифом через Telegram Stars.
   * Получает invoice_link с бэкенда и открывает нативный инвойс Telegram.
   * После успешной оплаты обновляет статус и переоткрывает текущую страницу.
   * @param {string} tariff "monthly"|"yearly"|"lifetime"
   * @returns {Promise}
   */
  App.payStars = function (tariff) {
    return App.api
      .createStarsInvoice(tariff)
      .then(function (res) {
        var link = res && res.invoice_link;
        if (!link) {
          App.toast("Не удалось создать счёт на оплату");
          return;
        }
        if (App.tg && typeof App.tg.openInvoice === "function") {
          App.tg.openInvoice(link, function (status) {
            if (status === "paid") {
              App.refreshSubscription().then(function () {
                App.toast("Подписка активна!");
                // Переоткрываем текущий экран, чтобы UI отразил новый статус.
                if (App._current) {
                  App.navigate(App._current);
                }
              });
            } else if (status === "failed") {
              App.toast("Оплата не прошла");
            }
            // status === "cancelled" / "pending" — молча игнорируем.
          });
        } else {
          // Вне Telegram оплата недоступна.
          App.toast("Оплата доступна в Telegram");
        }
      })
      .catch(function (err) {
        App.toast(err && err.message ? err.message : "Ошибка оплаты");
      });
  };

  /* =====================================================================
   *  ИНИЦИАЛИЗАЦИЯ
   * ===================================================================== */

  /**
   * Прокидывает безопасные отступы Telegram в CSS-переменные:
   *   --tg-safe-top    — вырез экрана + плавающие кнопки Telegram сверху;
   *   --tg-safe-bottom — нижняя безопасная зона.
   * Критично при открытии из поиска/по ссылке (полноэкранный режим), иначе
   * контент уезжает под верхние элементы Telegram (Close/«…»).
   */
  function applySafeArea() {
    if (!App.tg) return;
    try {
      var sa = App.tg.safeAreaInset || {};
      var csa = App.tg.contentSafeAreaInset || {};
      var top = (Number(sa.top) || 0) + (Number(csa.top) || 0);
      var bottom = (Number(sa.bottom) || 0) + (Number(csa.bottom) || 0);
      var root = document.documentElement.style;
      root.setProperty("--tg-safe-top", top + "px");
      root.setProperty("--tg-safe-bottom", bottom + "px");
    } catch (e) {
      /* безопасные зоны — не критичны, игнорируем сбой */
    }
  }

  /**
   * Применяет тему Telegram к CSS-переменным (если данные доступны).
   * Делается мягко: при отсутствии данных просто используется дизайн по умолчанию.
   */
  function applyTheme() {
    if (!App.tg) {
      return;
    }
    try {
      // Стабильная высота вьюпорта Telegram для корректной верстки.
      var stable = App.tg.viewportStableHeight;
      if (stable) {
        document.documentElement.style.setProperty(
          "--tg-viewport-stable-height",
          stable + "px"
        );
      }
      // Безопасные зоны Telegram (вырез + плавающие кнопки сверху).
      applySafeArea();

      // Подписка на изменение размеров вьюпорта (клавиатура, разворот) и зон.
      if (typeof App.tg.onEvent === "function") {
        App.tg.onEvent("viewportChanged", function () {
          var h = App.tg.viewportStableHeight;
          if (h) {
            document.documentElement.style.setProperty(
              "--tg-viewport-stable-height",
              h + "px"
            );
          }
          applySafeArea();
        });
        App.tg.onEvent("safeAreaChanged", applySafeArea);
        App.tg.onEvent("contentSafeAreaChanged", applySafeArea);
      }
    } catch (e) {
      // Тема — не критичный функционал, ошибки игнорируем.
      console.warn("Не удалось применить тему Telegram", e);
    }
  }

  /**
   * Инициализация приложения. Вызывается ОДИН раз из index.html
   * после регистрации всех страниц.
   */
  App.init = function () {
    // Сообщаем Telegram о готовности и разворачиваем окно на весь экран.
    if (App.tg) {
      try {
        if (typeof App.tg.ready === "function") {
          App.tg.ready();
        }
        if (typeof App.tg.expand === "function") {
          App.tg.expand();
        }
        // Отключаем вертикальные свайпы Telegram (Bot API 7.7+): из-за них
        // контент «уезжает» вверх и прокрутка залипает после смены экрана.
        if (typeof App.tg.disableVerticalSwipes === "function") {
          App.tg.disableVerticalSwipes();
        }
      } catch (e) {
        console.warn("Ошибка инициализации Telegram WebApp", e);
      }
    }

    // Обновляем пользователя (на случай, если SDK подгрузился позже).
    App.user =
      (App.tg && App.tg.initDataUnsafe && App.tg.initDataUnsafe.user) || null;

    // Применяем тему/вьюпорт.
    applyTheme();

    // Навешиваем обработчики на кнопки нижней навигации.
    var tabs = document.querySelectorAll("#tabbar .tab");
    for (var i = 0; i < tabs.length; i++) {
      (function (tab) {
        tab.addEventListener("click", function () {
          var page = tab.getAttribute("data-page");
          if (page) {
            App.haptic("light");
            App.navigate(page);
          }
        });
      })(tabs[i]);
    }

    // Best-effort авторизация: подтверждаем пользователя и кэшируем профиль,
    // ЗАТЕМ загружаем статус подписки и только после этого делаем первую
    // навигацию — gated-страницы должны знать статус подписки при показе.
    // Все шаги fail-safe: ошибки не блокируют запуск, статус подписки при
    // сбое остаётся дефолтным (НЕ премиум) — пользователю покажется paywall.
    App.api
      .verify()
      .then(function (profile) {
        App.state.profile = profile;
      })
      .catch(function (err) {
        console.warn("Авторизация не выполнена: " + err.message);
      })
      .then(function () {
        // refreshSubscription сам гасит свои ошибки, статус остаётся дефолтным.
        return App.refreshSubscription();
      })
      .then(function () {
        // Стартовая страница — «Определение» (после загрузки статуса подписки).
        App.navigate("scan");
      });
  };

  /* =====================================================================
   *  ХЕЛПЕРЫ ДЛЯ СТРАНИЦ
   * ===================================================================== */

  // Таймер автоскрытия тоста.
  var _toastTimer = null;

  /**
   * Показывает короткое всплывающее уведомление (toast).
   * @param {string} msg
   */
  App.toast = function (msg) {
    var el = document.getElementById("toast");
    if (!el) {
      // Запасной вариант, если контейнера тоста нет в разметке.
      try {
        console.log("[toast] " + msg);
      } catch (e) {}
      return;
    }
    el.textContent = msg;
    el.classList.add("show");
    if (_toastTimer) {
      clearTimeout(_toastTimer);
    }
    _toastTimer = setTimeout(function () {
      el.classList.remove("show");
    }, 2800);
  };

  /** Показывает оверлей загрузки (#loading). */
  App.showLoading = function () {
    var el = document.getElementById("loading");
    if (el) {
      el.classList.add("show");
    }
  };

  /** Скрывает оверлей загрузки (#loading). */
  App.hideLoading = function () {
    var el = document.getElementById("loading");
    if (el) {
      el.classList.remove("show");
    }
  };

  /** Надёжно прокручивает страницу в самый верх (для разных вебвью/Telegram). */
  App.scrollTop = function () {
    try {
      window.scrollTo(0, 0);
    } catch (e) {}
    try {
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
      if (document.documentElement) document.documentElement.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
    } catch (e) {}
  };

  /**
   * Возвращает сегодняшнюю дату в формате "YYYY-MM-DD" по локальному времени.
   * @returns {string}
   */
  App.todayStr = function () {
    var d = new Date();
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return (
      y +
      "-" +
      (m < 10 ? "0" + m : "" + m) +
      "-" +
      (day < 10 ? "0" + day : "" + day)
    );
  };

  /**
   * Форматирует число: округляет до целого и возвращает строкой.
   * Нечисловые значения превращаются в "0".
   * @param {number} n
   * @returns {string}
   */
  App.fmt = function (n) {
    var num = Number(n);
    if (!isFinite(num)) {
      return "0";
    }
    return String(Math.round(num));
  };

  // Соответствие типов приёма пищи и русских подписей.
  var MEAL_LABELS = {
    breakfast: "Завтрак",
    lunch: "Обед",
    dinner: "Ужин",
    snack: "Перекус"
  };

  /**
   * Возвращает русскую подпись для типа приёма пищи.
   * @param {string} type breakfast|lunch|dinner|snack
   * @returns {string}
   */
  App.mealLabel = function (type) {
    return MEAL_LABELS[type] || type || "";
  };

  /**
   * Вызывает тактильную отдачу (haptic feedback) через Telegram, если доступно.
   * @param {string} [type] "light"|"medium"|"heavy"|"selection"|"success"|"warning"|"error"
   */
  App.haptic = function (type) {
    if (!App.tg || !App.tg.HapticFeedback) {
      return;
    }
    try {
      var hf = App.tg.HapticFeedback;
      if (type === "success" || type === "warning" || type === "error") {
        hf.notificationOccurred(type);
      } else if (type === "selection") {
        // Тактильный «тик» при переключении (выбор даты, таба и т.п.).
        if (typeof hf.selectionChanged === "function") {
          hf.selectionChanged();
        }
      } else {
        // Лёгкая отдача по умолчанию.
        hf.impactOccurred(type || "light");
      }
    } catch (e) {
      // Тактильная отдача не критична — молча игнорируем.
    }
  };

  /**
   * Экранирует HTML-спецсимволы для безопасной вставки текста в разметку.
   * @param {string} s
   * @returns {string}
   */
  App.escapeHtml = function (s) {
    if (s === null || s === undefined) {
      return "";
    }
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  // Публикуем объект приложения в глобальной области.
  window.App = App;
})();
