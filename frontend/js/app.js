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
              } else if (data.detail) {
                // detail может быть массивом ошибок валидации pydantic.
                try {
                  detail = JSON.stringify(data.detail);
                } catch (e2) {
                  detail = String(data.detail);
                }
              } else if (typeof data.message === "string") {
                detail = data.message;
              }
            }
            if (!detail) {
              detail = raw || "Ошибка " + res.status;
            }
            throw new Error(detail);
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
    }
  };

  /* =====================================================================
   *  РОУТЕР ПО СТРАНИЦАМ
   * ===================================================================== */

  /**
   * Регистрирует страницу.
   * @param {string} name  одно из {scan, diary, account}
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
  };

  /* =====================================================================
   *  ИНИЦИАЛИЗАЦИЯ
   * ===================================================================== */

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
      // Подписка на изменение размеров вьюпорта (клавиатура, разворот).
      if (typeof App.tg.onEvent === "function") {
        App.tg.onEvent("viewportChanged", function () {
          var h = App.tg.viewportStableHeight;
          if (h) {
            document.documentElement.style.setProperty(
              "--tg-viewport-stable-height",
              h + "px"
            );
          }
        });
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

    // Best-effort авторизация: подтверждаем пользователя и кэшируем профиль.
    // Ошибку не показываем агрессивно — приложение продолжит работать,
    // а конкретные страницы сами обработают отказ авторизации.
    App.api
      .verify()
      .then(function (profile) {
        App.state.profile = profile;
      })
      .catch(function (err) {
        console.warn("Авторизация не выполнена: " + err.message);
      });

    // Стартовая страница — «Определение».
    App.navigate("scan");
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
