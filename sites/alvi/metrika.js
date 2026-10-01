/* Яндекс Метрика для сайта ALVI. Номер счётчика задаётся здесь и только здесь.

   Правка 01.10.2026 (второй проход):
   - глобальный перехват fetch снят: заявку засчитывает только callback.js по ответу сервера;
   - этапы считаются по фактической видимости с порогом от размера окна, с учётом вкладки и модалок;
   - встроенный прайс (iframe окна прайса) — клиентский просмотр: второй счётчик в iframe не запускается,
     а просмотр цен и клики передаются родителю сообщением с проверкой origin, source и списка целей;
   - ссылки классифицируются по текущему href в момент клика (company-links.js может подменить его позже);
   - канал Telegram остаётся переходом в канал даже внутри блока контактов.
   Тексты, дизайн, цены, ссылки и состав услуг не меняются. */
(function (host, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) host.AlviMetrika = api.start(host);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  var COUNTER_ID = 112777602;
  var MESSAGE_TYPE = 'alvi-metrika:v1';
  var HOLD_MS = 1000;
  var DEBOUNCE_MS = 1500;
  var CHECK_THROTTLE_MS = 150;
  var POLL_MS = 1000;

  // Каналы, которые всегда считаются переходом в канал, а не контактом для записи.
  var KNOWN_CHANNELS = ['spa_stio_alvi'];

  function dict(keys) {
    var out = Object.create(null);
    keys.forEach(function (k) { out[k] = true; });
    return out;
  }
  function has(map, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key); }

  // Значения параметра network — только из этого списка, чтобы в цели не попало ничего лишнего.
  var SOCIAL_NETWORKS = dict(['t.me', 'max.ru', 'vk.com', 'vk.ru', 'instagram.com', 'facebook.com', 'ok.ru',
    'youtube.com', 'dzen.ru', 'tiktok.com', '2gis.ru', 'yandex.ru']);

  // Что iframe окна прайса вправе передать родителю. Ничего про форму заявки здесь нет.
  var FORWARDABLE = dict(['price_view', 'click_phone', 'click_telegram', 'click_max', 'click_whatsapp',
    'social_profile_click', 'booking_click', 'contact_route_click']);

  // Перекрывающие слои: открытая модалка (окно прайса, промо), aria-modal, экран загрузки.
  var OVERLAYS = 'dialog[open], [aria-modal="true"], #page-loader.is-visible:not(.is-complete)';

  var REASON_RE = /^[a-z0-9_]{1,20}$/;

  /* ---------- классификация ссылки по текущему href ---------- */

  function network(hostname) {
    var h = String(hostname || '').toLowerCase().replace(/^(www|m)\./, '');
    if (h === 'youtu.be') h = 'youtube.com';
    if (h === 'telegram.me') h = 't.me';
    for (var key in SOCIAL_NETWORKS) {
      if (h === key || h.slice(-(key.length + 1)) === '.' + key) return key;
    }
    return null;
  }

  function social(net) { return { goal: 'social_profile_click', params: { network: net } }; }

  function pagePath(pathname) { return String(pathname || '').replace(/index\.html$/, ''); }

  // Возвращает {goal, params?} или null. Читает ТОЛЬКО текущий href и роль data-company-link;
  // устаревший data-contact-route после подмены ссылки не учитывается.
  function classifyLink(anchor, baseHref) {
    if (!anchor || typeof anchor.getAttribute !== 'function') return null;
    var raw = String(anchor.getAttribute('href') || '').trim();
    if (!raw) return null;
    var url, base;
    try { base = new URL(baseHref); url = new URL(raw, base); } catch (_) { return null; }
    var role = String(anchor.getAttribute('data-company-link') || '');

    if (url.protocol === 'tel:') return { goal: 'click_phone' };
    if (url.protocol === 'whatsapp:') return { goal: 'click_whatsapp' };
    if (url.protocol === 'tg:') return /(^|[?&])phone=/.test(url.search) ? { goal: 'click_telegram' } : social('t.me');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    var hostname = url.hostname.toLowerCase().replace(/^www\./, '');

    // Онлайн-запись — только фактическая ссылка Yclients. Это намерение, а не подтверждённая запись.
    if (hostname === 'yclients.com' || hostname.slice(-13) === '.yclients.com') return { goal: 'booking_click' };

    if (url.origin === base.origin) {
      var toContacts = url.hash === '#contacts' || url.hash === '#callback-form';
      var samePage = pagePath(url.pathname) === pagePath(base.pathname);
      var toHome = /\/(index\.html)?$/.test(url.pathname);
      return toContacts && (samePage || toHome) ? { goal: 'contact_route_click' } : null;
    }

    if (hostname === 't.me' || hostname === 'telegram.me') {
      var first = (url.pathname.split('/')[1] || '').toLowerCase();
      if (KNOWN_CHANNELS.indexOf(first) > -1) return social('t.me');
      if (/^\+?\d{10,15}$/.test(first)) return { goal: 'click_telegram' };
      if (role === 'telegram') return { goal: 'click_telegram' };
      return social('t.me');
    }
    if (hostname === 'max.ru') {
      if (/^\/u\//.test(url.pathname) || role === 'max') return { goal: 'click_max' };
      return social('max.ru');
    }
    if (hostname === 'wa.me' || hostname === 'api.whatsapp.com' || hostname === 'whatsapp.com') return { goal: 'click_whatsapp' };

    var net = network(hostname);
    return net ? social(net) : null;
  }

  /* ---------- фактическая видимость ---------- */

  function shown(node, win) {
    if (node.hidden) return false;
    var st = win.getComputedStyle(node);
    if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    return true;
  }

  function occluded(el, win, doc) {
    var layers = doc.querySelectorAll(OVERLAYS);
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (layer === el || layer.contains(el)) continue;
      if (shown(layer, win)) return true;
    }
    return false;
  }

  // Порог от окна: видна половина блока ИЛИ блок занимает не меньше половины окна.
  // Высокий блок (выше экрана) засчитывается, когда занимает половину экрана, — он не обязан
  // целиком на 50% войти в окно. Плюс вкладка активна, блок не скрыт и не перекрыт модалкой.
  function visibleEnough(el, win) {
    var doc = win.document;
    if (!el || !el.isConnected) return false;
    if (doc.visibilityState && doc.visibilityState !== 'visible') return false;
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden || n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert')) return false;
      var st = win.getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
      var op = parseFloat(st.opacity);
      if (!isNaN(op) && op < 0.1) return false;
    }
    var r = el.getBoundingClientRect();
    var vh = win.innerHeight || doc.documentElement.clientHeight || 0;
    var vw = win.innerWidth || doc.documentElement.clientWidth || 0;
    if (r.width < 1 || r.height < 1 || vh < 1 || vw < 1) return false;
    var visH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    var visW = Math.min(r.right, vw) - Math.max(r.left, 0);
    if (visH < Math.min(r.height, vh) * 0.5) return false;
    if (visW < Math.min(r.width, vw) * 0.5) return false;
    return !occluded(el, win, doc);
  }

  /* ---------- наблюдатель этапов с удержанием ---------- */

  function createStages(win, clock, onStage) {
    var doc = win.document;
    var targets = [];
    var pending = 0;
    var finished = false;
    var cleanup = [];

    function check() {
      if (finished) return;
      var now = clock.now();
      var open = 0;
      targets.forEach(function (t) {
        if (t.done) return;
        open++;
        var nodes = Array.prototype.slice.call(doc.querySelectorAll(t.selector));
        var seen = nodes.some(function (node) { return visibleEnough(node, win); });
        if (!seen) { t.since = null; return; }
        if (t.since === null) {
          t.since = now;
          clock.set(check, HOLD_MS + 20);
          return;
        }
        if (now - t.since >= HOLD_MS) {
          t.done = true;
          open--;
          onStage(t.goal);
        }
      });
      if (!open && targets.length) {
        finished = true;
        cleanup.forEach(function (fn) { try { fn(); } catch (_) {} });
      }
    }

    function request() {
      if (pending || finished) return;
      pending = clock.set(function () { pending = 0; check(); }, CHECK_THROTTLE_MS);
    }

    function add(goal, selector) { targets.push({ goal: goal, selector: selector, since: null, done: false }); }

    function wire() {
      var opts = { passive: true };
      win.addEventListener('scroll', request, opts);
      win.addEventListener('resize', request, opts);
      doc.addEventListener('visibilitychange', request);
      cleanup.push(function () {
        win.removeEventListener('scroll', request, opts);
        win.removeEventListener('resize', request, opts);
        doc.removeEventListener('visibilitychange', request);
      });
      // Только редкие атрибуты (модалка открылась, блок раскрыли). Классы и inline-стили на главной
      // меняет анимация на каждом кадре — следить за ними дорого, их покрывает редкий опрос ниже.
      if (typeof win.MutationObserver === 'function' && doc.body) {
        var mo = new win.MutationObserver(request);
        mo.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'aria-hidden', 'inert'] });
        cleanup.push(function () { mo.disconnect(); });
      }
      // Опрос раз в секунду, пока остались неотправленные этапы: ловит раскрытие сцены классом
      // или стилем и окончание экрана загрузки без прокрутки. После всех этапов останавливается.
      (function poll() {
        if (finished) return;
        check();
        clock.set(poll, POLL_MS);
      })();
      if (typeof win.IntersectionObserver === 'function') {
        var steps = [];
        for (var i = 0; i <= 10; i++) steps.push(i / 10);
        var io = new win.IntersectionObserver(request, { threshold: steps });
        targets.forEach(function (t) {
          Array.prototype.forEach.call(doc.querySelectorAll(t.selector), function (node) { io.observe(node); });
        });
        cleanup.push(function () { io.disconnect(); });
      }
    }

    return { add: add, check: check, wire: wire };
  }

  /* ---------- общие помощники ---------- */

  function safe(fn, fallback) { try { return fn(); } catch (_) { return fallback; } }

  function makeClock(win, opts) {
    return {
      now: opts.now || function () { return Date.now(); },
      set: opts.setTimeout || function (fn, ms) { return win.setTimeout(fn, ms); }
    };
  }

  function sanitize(params) {
    if (!params || typeof params !== 'object') return undefined;
    var out = {};
    if (typeof params.reason === 'string' && REASON_RE.test(params.reason)) out.reason = params.reason;
    if (typeof params.network === 'string') out.network = has(SOCIAL_NETWORKS, params.network) ? params.network : 'other';
    return Object.keys(out).length ? out : undefined;
  }

  function isPricePage(win) {
    var doc = win.document;
    return Boolean((doc.body && doc.body.hasAttribute('data-full-price')) || /(^|\/)price\.html$/.test(win.location.pathname));
  }

  var PRICE_CONTENT = '.price-content, .price-layout';

  function closestAnchor(event) {
    var t = event && event.target;
    return t && t.closest ? t.closest('a[href]') : null;
  }

  function onReady(doc, fn) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function noop() {}

  /* ---------- режим: iframe окна прайса ---------- */

  function isOverlayFrame(win, parentWin) {
    var embedded = safe(function () { return new URLSearchParams(win.location.search).get('embedded') === '1'; }, false);
    if (!embedded || !parentWin || parentWin === win) return false;
    return safe(function () { return parentWin.location.origin === win.location.origin; }, false);
  }

  function startFrame(win, parentWin, opts) {
    var doc = win.document;
    var clock = makeClock(win, opts);
    win.alviGoal = noop;
    win.alviGoalOnce = noop;
    var lastAt = Object.create(null);

    // В сообщении только тип, имя цели и, для перехода в профиль, домен из списка.
    // Адрес ссылки, текст, телефон и параметры страницы родителю не передаются.
    function post(goal, params) {
      if (!has(FORWARDABLE, goal)) return;
      var msg = { type: MESSAGE_TYPE, goal: goal };
      var clean = sanitize(params);
      if (clean && clean.network) msg.network = clean.network;
      try { parentWin.postMessage(msg, win.location.origin); } catch (_) {}
    }

    doc.addEventListener('click', function (event) {
      var hit = classifyLink(closestAnchor(event), win.location.href);
      if (!hit) return;
      var n = clock.now();
      if (lastAt[hit.goal] != null && n - lastAt[hit.goal] < DEBOUNCE_MS) return;
      lastAt[hit.goal] = n;
      post(hit.goal, hit.params);
    }, true);

    var stages = createStages(win, clock, function (goal) { post(goal); });
    if (isPricePage(win)) stages.add('price_view', PRICE_CONTENT);
    onReady(doc, stages.wire);

    return { mode: 'frame', check: stages.check };
  }

  /* ---------- режим: основной счётчик ---------- */

  function loadTag(win) {
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      for (var j = 0; j < e.scripts.length; j++) { if (e.scripts[j].src === r) { return; } }
      k = e.createElement(t); a = e.getElementsByTagName(t)[0];
      k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(win, win.document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
    try {
      win.ym(COUNTER_ID, 'init', {
        clickmap: true,
        trackLinks: true,
        accurateTrackBounce: true,
        webvisor: true
      });
    } catch (_) {}
  }

  function startCounter(win, opts) {
    var doc = win.document;
    var clock = makeClock(win, opts);
    if (!opts.skipTag) loadTag(win);
    win.ALVI_METRIKA_ID = COUNTER_ID;

    var send = opts.send || function (name, params) {
      try {
        if (!win.ym) return;
        if (params) win.ym(COUNTER_ID, 'reachGoal', name, params);
        else win.ym(COUNTER_ID, 'reachGoal', name);
      } catch (_) {}
    };

    var stageSent = Object.create(null);
    function stage(goal) {
      if (stageSent[goal]) return false;
      stageSent[goal] = true;
      send(goal);
      return true;
    }

    var lastAt = Object.create(null);
    function debounced(goal, params) {
      var n = clock.now();
      if (lastAt[goal] != null && n - lastAt[goal] < DEBOUNCE_MS) return false;
      lastAt[goal] = n;
      send(goal, sanitize(params));
      return true;
    }

    // callback.js и другие скрипты шлют цели только через эту функцию; параметры чистятся.
    win.alviGoal = function (name, params) {
      if (typeof name !== 'string' || !name) return;
      send(name, sanitize(params));
    };
    win.alviGoalOnce = stage;

    doc.addEventListener('click', function (event) {
      var hit = classifyLink(closestAnchor(event), win.location.href);
      if (hit) debounced(hit.goal, hit.params);
    }, true);

    // Сообщения принимаются только от iframe окна прайса этой же страницы и этого же origin.
    function handleMessage(event) {
      var frame = doc.querySelector('iframe.alvi-price-dialog__frame');
      if (!frame || !event || event.source == null || event.source !== frame.contentWindow) return false;
      if (event.origin !== win.location.origin) return false;
      var data = event.data;
      if (!data || typeof data !== 'object' || data.type !== MESSAGE_TYPE || !has(FORWARDABLE, data.goal)) return false;
      if (data.goal === 'price_view') {
        var dialog = frame.closest('dialog');
        var opened = dialog && (dialog.open || dialog.hasAttribute('open'));
        if (!opened || (doc.visibilityState && doc.visibilityState !== 'visible')) return false;
        return stage('price_view');
      }
      var params = data.goal === 'social_profile_click' ? { network: typeof data.network === 'string' ? data.network : '' } : undefined;
      return debounced(data.goal, params);
    }
    win.addEventListener('message', handleMessage);

    var stages = createStages(win, clock, stage);
    if (isPricePage(win)) {
      // Отдельная страница прайса, открытая напрямую.
      stages.add('price_view', PRICE_CONTENT);
    } else {
      // На главной блоки программ — это просмотр программ, а не прайса.
      // Просмотр прайса на главной приходит только из окна прайса (сообщение iframe).
      stages.add('service_view', '#for-self, #for-two');
      stages.add('contact_view', '#contacts');
      stages.add('callback_open', '#callback-form');
      stages.add('quiz_complete', '#quiz-result');
    }
    onReady(doc, stages.wire);

    return { mode: 'counter', check: stages.check, handleMessage: handleMessage, stage: stage };
  }

  /* ---------- выбор режима ---------- */

  function start(win, opts) {
    opts = opts || {};
    var parentWin = 'parent' in opts ? opts.parent : safe(function () { return win.parent; }, null);
    var topWin = 'top' in opts ? opts.top : safe(function () { return win.top; }, null);
    var framed = parentWin !== win || topWin !== win;
    if (framed) {
      if (isOverlayFrame(win, parentWin)) return startFrame(win, parentWin, opts);
      // Чужой или служебный iframe (кабинет, редактор): ни счётчика, ни сообщений.
      win.alviGoal = noop;
      win.alviGoalOnce = noop;
      return { mode: 'inert' };
    }
    return startCounter(win, opts);
  }

  return {
    start: start,
    classifyLink: classifyLink,
    visibleEnough: visibleEnough,
    sanitize: sanitize,
    MESSAGE_TYPE: MESSAGE_TYPE,
    HOLD_MS: HOLD_MS,
    DEBOUNCE_MS: DEBOUNCE_MS,
    FORWARDABLE: Object.keys(FORWARDABLE)
  };
});
