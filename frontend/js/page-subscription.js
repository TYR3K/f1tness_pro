/*
 * page-subscription.js — страница «Подписка» (💎).
 *
 * Регистрирует контроллер через App.registerPage("subscription", {...}).
 * Публичная ссылка — window.PageSubscription.
 *
 * Страница НЕ входит в нижнюю навигацию (#tabbar) — она открывается кнопкой
 * «💎 Подписка» со страницы «Аккаунт». Возврат — кнопкой «Назад» в account.
 *
 * Что показывает:
 *   1. ТЕКУЩИЙ СТАТУС подписки (App.subscription):
 *        - премиум  -> «Подписка активна» + «до <дата>» (или «Навсегда»
 *          для lifetime/owner);
 *        - free     -> «Бесплатный доступ».
 *   2. КАРТОЧКИ ТАРИФОВ из App.subscription.tariffs:
 *        Месячный (monthly), Годовой (yearly), Вечный (lifetime).
 *        У каждого — цена «N ⭐» и кнопка «Оплатить N ⭐» -> App.payStars(tariff).
 *   3. Если задан App.subscription.tribute_url — кнопка «Оплатить через Tribute»
 *        -> (App.tg.openLink || window.open)(tribute_url).
 *
 * Контроль доступа — на сервере (платные роуты отдают 402). Эта страница лишь
 * показывает варианты оплаты и текущий статус. При показе и после оплаты статус
 * обновляется через App.refreshSubscription().
 *
 * Весь UI и комментарии — на русском, с обработкой ошибок и загрузки.
 * Классы — с префиксом sub-.
 */
(function () {
  "use strict";

  // Описание тарифов: ключ для бэкенда -> метаданные для отображения.
  // Порядок задаёт расположение карточек на странице.
  var TARIFF_META = [
    {
      key: "monthly",
      title: "Месячный",
      icon: "📅",
      note: "Доступ на 30 дней"
    },
    {
      key: "yearly",
      title: "Годовой",
      icon: "🗓️",
      note: "Выгоднее на длинной дистанции",
      badge: "Выгодно"
    },
    {
      key: "lifetime",
      title: "Вечный",
      icon: "♾️",
      note: "Один раз — и навсегда",
      badge: "Навсегда"
    }
  ];

  // Преимущества подписки — общий список ценности (показываем на странице).
  var BENEFITS = [
    "Журнал тренировок и расход калорий",
    "Учёт добавок, напоминания и AI-советы",
    "Безлимитные сканирования еды по фото",
    "AI-подсказки «Что съесть?» под вашу цель"
  ];

  // Внутреннее состояние контроллера (живёт между методами через замыкание).
  var state = {
    viewEl: null, // корневой элемент страницы (#view)
    loading: false // флаг обновления статуса (защита от гонок)
  };

  /* =====================================================================
   *  УТИЛИТЫ
   * ===================================================================== */

  function esc(s) {
    return App.escapeHtml(s == null ? "" : String(s));
  }

  function haptic(kind) {
    if (App && typeof App.haptic === "function") App.haptic(kind);
  }

  function toast(msg) {
    if (App && typeof App.toast === "function") App.toast(msg);
  }

  /**
   * Возвращает текущий объект статуса подписки с безопасными значениями
   * по умолчанию (fail-safe: при отсутствии данных считаем пользователя free).
   */
  function sub() {
    var s = App.subscription || {};
    return {
      subscription_type: s.subscription_type || "free",
      subscription_until: s.subscription_until || null,
      is_premium: !!s.is_premium,
      is_owner: !!s.is_owner,
      tariffs: s.tariffs || {},
      tribute_url: s.tribute_url || null
    };
  }

  /**
   * Преобразует дату от сервера в человекочитаемый русский формат
   * «ДД.ММ.ГГГГ». Принимает ISO-строку или «YYYY-MM-DD …»; при неудаче
   * возвращает исходную строку как есть.
   */
  function formatUntil(raw) {
    if (!raw) return "";
    var str = String(raw);
    // Пытаемся распарсить как полноценную дату.
    var d = new Date(str);
    if (!isNaN(d.getTime())) {
      var day = d.getDate();
      var mon = d.getMonth() + 1;
      var year = d.getFullYear();
      return (
        (day < 10 ? "0" + day : "" + day) +
        "." +
        (mon < 10 ? "0" + mon : "" + mon) +
        "." +
        year
      );
    }
    // Фолбэк: «YYYY-MM-DD…» -> «DD.MM.YYYY».
    var datePart = str.split("T")[0].split(" ")[0];
    var parts = datePart.split("-");
    if (parts.length === 3) {
      return parts[2] + "." + parts[1] + "." + parts[0];
    }
    return str;
  }

  /**
   * Безопасно достаёт цену в звёздах для тарифа (или null, если не задано).
   */
  function tariffStars(tariffs, key) {
    var t = tariffs && tariffs[key];
    if (!t) return null;
    var stars = Number(t.stars);
    return isFinite(stars) ? stars : null;
  }

  /* =====================================================================
   *  РАЗМЕТКА
   * ===================================================================== */

  /**
   * Базовый каркас страницы. Внутренние блоки (статус, тарифы) рендерятся
   * отдельно и перерисовываются при обновлении статуса.
   */
  function template() {
    var benefitsHtml = BENEFITS.map(function (b) {
      return (
        '<li class="sub-benefit">' +
        '<span class="sub-benefit__check" aria-hidden="true">✓</span>' +
        '<span class="sub-benefit__text">' +
        esc(b) +
        "</span>" +
        "</li>"
      );
    }).join("");

    return (
      '<section class="page sub-page">' +
      // ---- Шапка с кнопкой «Назад» ----
      '<header class="sub-head">' +
      '<button type="button" class="sub-back" id="subBack" aria-label="Назад">' +
      '<span class="sub-back__arrow" aria-hidden="true">←</span>' +
      "<span>Назад</span>" +
      "</button>" +
      '<h1 class="page-title sub-title">💎 Подписка</h1>' +
      '<p class="page-subtitle sub-subtitle">Премиум-доступ ко всем возможностям трекера.</p>' +
      "</header>" +

      // ---- Карточка текущего статуса (заполняется renderStatus) ----
      '<div class="card sub-status" id="subStatus">' +
      '<div class="skeleton skeleton--block"></div>' +
      "</div>" +

      // ---- Список преимуществ ----
      '<section class="card sub-benefits">' +
      '<h2 class="sub-section-title">Что входит в подписку</h2>' +
      '<ul class="sub-benefits__list">' +
      benefitsHtml +
      "</ul>" +
      "</section>" +

      // ---- Тарифы (заполняется renderTariffs) ----
      '<section class="sub-tariffs" id="subTariffs">' +
      '<div class="skeleton skeleton--block"></div>' +
      "</section>" +

      // ---- Оплата через Tribute (показывается при наличии ссылки) ----
      '<div class="sub-tribute" id="subTribute" hidden></div>' +

      '<p class="sub-foot">Оплата проходит через Telegram. Доступ открывается сразу после оплаты.</p>' +
      "</section>"
    );
  }

  /**
   * Отрисовывает карточку текущего статуса подписки.
   */
  function renderStatus() {
    var box = state.viewEl && state.viewEl.querySelector("#subStatus");
    if (!box) return;

    var s = sub();

    if (s.is_premium) {
      // Премиум активен. Для owner / lifetime — «Навсегда», иначе «до <дата>».
      var forever =
        s.is_owner || s.subscription_type === "lifetime" || !s.subscription_until;
      var untilLine;
      if (forever) {
        untilLine = '<div class="sub-status__until">Навсегда</div>';
      } else {
        untilLine =
          '<div class="sub-status__until">до ' +
          esc(formatUntil(s.subscription_until)) +
          "</div>";
      }
      box.className = "card sub-status sub-status--premium";
      box.innerHTML =
        '<div class="sub-status__icon" aria-hidden="true">✅</div>' +
        '<div class="sub-status__body">' +
        '<div class="sub-status__title">Подписка активна</div>' +
        untilLine +
        "</div>";
    } else {
      // Бесплатный доступ.
      box.className = "card sub-status sub-status--free";
      box.innerHTML =
        '<div class="sub-status__icon" aria-hidden="true">🔓</div>' +
        '<div class="sub-status__body">' +
        '<div class="sub-status__title">Бесплатный доступ</div>' +
        '<div class="sub-status__until">Оформите подписку, чтобы открыть все возможности</div>' +
        "</div>";
    }
  }

  /**
   * Отрисовывает карточки тарифов из App.subscription.tariffs.
   */
  function renderTariffs() {
    var box = state.viewEl && state.viewEl.querySelector("#subTariffs");
    if (!box) return;

    var s = sub();
    var tariffs = s.tariffs || {};

    // Собираем только те тарифы, для которых сервер вернул цену.
    var cards = [];
    TARIFF_META.forEach(function (meta) {
      var stars = tariffStars(tariffs, meta.key);
      if (stars == null) return; // тариф недоступен — пропускаем

      var badgeHtml = meta.badge
        ? '<span class="sub-tariff__badge">' + esc(meta.badge) + "</span>"
        : "";

      cards.push(
        '<article class="card sub-tariff" data-tariff="' +
          esc(meta.key) +
          '">' +
          '<div class="sub-tariff__head">' +
          '<span class="sub-tariff__icon" aria-hidden="true">' +
          esc(meta.icon) +
          "</span>" +
          '<div class="sub-tariff__info">' +
          '<div class="sub-tariff__title">' +
          esc(meta.title) +
          badgeHtml +
          "</div>" +
          '<div class="sub-tariff__note">' +
          esc(meta.note) +
          "</div>" +
          "</div>" +
          '<div class="sub-tariff__price">' +
          esc(String(stars)) +
          " <span class=\"sub-tariff__star\" aria-hidden=\"true\">⭐</span>" +
          "</div>" +
          "</div>" +
          '<button type="button" class="btn btn--cta sub-tariff__pay" data-tariff="' +
          esc(meta.key) +
          '">Оплатить ' +
          esc(String(stars)) +
          " ⭐</button>" +
          "</article>"
      );
    });

    if (!cards.length) {
      // Тарифы не пришли — мягко сообщаем и предлагаем повторить.
      box.innerHTML =
        '<div class="card sub-tariffs__empty">' +
        "<p>Не удалось загрузить тарифы.</p>" +
        '<button type="button" class="btn btn--ghost" id="subTariffsRetry">Повторить</button>' +
        "</div>";
      var retry = box.querySelector("#subTariffsRetry");
      if (retry) {
        retry.addEventListener("click", function () {
          refreshStatus();
        });
      }
      return;
    }

    box.innerHTML =
      '<h2 class="sub-section-title">Тарифы</h2>' + cards.join("");

    // Навешиваем обработчики оплаты на кнопки тарифов.
    var payBtns = box.querySelectorAll(".sub-tariff__pay");
    for (var i = 0; i < payBtns.length; i++) {
      payBtns[i].addEventListener("click", onPay);
    }
  }

  /**
   * Показывает/прячет блок оплаты через Tribute в зависимости от tribute_url.
   */
  function renderTribute() {
    var box = state.viewEl && state.viewEl.querySelector("#subTribute");
    if (!box) return;

    var s = sub();
    if (!s.tribute_url) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }

    box.hidden = false;
    box.innerHTML =
      '<button type="button" class="btn btn--ghost sub-tribute__btn" id="subTributeBtn">' +
      "Оплатить через Tribute" +
      "</button>" +
      '<p class="sub-tribute__hint">Альтернативный способ оплаты во внешнем сервисе.</p>';

    var btn = box.querySelector("#subTributeBtn");
    if (btn) {
      btn.addEventListener("click", function () {
        onTribute(s.tribute_url);
      });
    }
  }

  /**
   * Перерисовывает все динамические блоки страницы по текущему App.subscription.
   */
  function renderAll() {
    renderStatus();
    renderTariffs();
    renderTribute();
  }

  /* =====================================================================
   *  ДЕЙСТВИЯ
   * ===================================================================== */

  /**
   * Обработчик кнопки «Оплатить N ⭐» — запускает оплату звёздами Telegram
   * через единый App.payStars. После успешной оплаты статус обновляется
   * внутри App.payStars; здесь дополнительно перерисовываем UI.
   */
  function onPay(e) {
    var btn = e && e.currentTarget;
    var tariff = btn && btn.getAttribute("data-tariff");
    if (!tariff) return;

    haptic("light");

    if (!App.payStars) {
      // Контракт гарантирует наличие App.payStars; на всякий случай — фолбэк.
      toast("Оплата временно недоступна");
      return;
    }

    // Блокируем кнопку на время запроса invoice.
    btn.disabled = true;
    App.showLoading();

    Promise.resolve(App.payStars(tariff))
      .then(function () {
        // После оплаты App.payStars сам обновит App.subscription и покажет toast.
        // Перерисовываем UI, чтобы отразить возможный новый статус.
        renderAll();
      })
      .catch(function (err) {
        toast(
          "Не удалось начать оплату: " +
            (err && err.message ? err.message : "ошибка")
        );
        haptic("error");
      })
      .finally(function () {
        btn.disabled = false;
        App.hideLoading();
      });
  }

  /**
   * Открывает ссылку оплаты Tribute во внешнем браузере (через Telegram, если
   * доступно, иначе обычным window.open).
   */
  function onTribute(url) {
    if (!url) return;
    haptic("light");
    try {
      if (App.tg && typeof App.tg.openLink === "function") {
        App.tg.openLink(url);
      } else if (typeof window.open === "function") {
        window.open(url, "_blank");
      } else {
        toast("Ссылка для оплаты недоступна");
      }
    } catch (err) {
      toast("Не удалось открыть оплату");
    }
  }

  /**
   * Обновляет статус подписки с сервера и перерисовывает страницу.
   * Best-effort: при ошибке оставляем текущие данные и показываем их.
   */
  function refreshStatus() {
    if (state.loading) return;
    state.loading = true;

    var done = function () {
      state.loading = false;
      // Страница могла смениться, пока шёл запрос — проверяем актуальность.
      if (state.viewEl && document.body.contains(state.viewEl)) {
        renderAll();
      }
    };

    if (App.refreshSubscription) {
      Promise.resolve(App.refreshSubscription()).then(done, done);
    } else {
      // Контракт гарантирует App.refreshSubscription; фолбэк — просто рендерим.
      done();
    }
  }

  /* =====================================================================
   *  КОНТРОЛЛЕР СТРАНИЦЫ
   * ===================================================================== */

  var controller = {
    /**
     * Показ страницы: строит разметку, вешает обработчики, рисует текущий
     * статус из кэша и обновляет его с сервера.
     */
    onShow: function (viewEl) {
      state.viewEl = viewEl;
      viewEl.innerHTML = template();

      App.scrollTop();

      // Кнопка «Назад» -> возврат в аккаунт.
      var back = viewEl.querySelector("#subBack");
      if (back) {
        back.addEventListener("click", function () {
          haptic("light");
          App.navigate("account");
        });
      }

      // Сначала рисуем по кэшу (мгновенный отклик), затем обновляем с сервера.
      renderAll();
      refreshStatus();
    },

    /**
     * Уход со страницы — освобождаем ссылки.
     */
    onHide: function () {
      state.viewEl = null;
      state.loading = false;
    }
  };

  // Регистрируем страницу и публикуем контроллер (для отладки/повторного входа).
  window.PageSubscription = controller;
  App.registerPage("subscription", controller);
})();
