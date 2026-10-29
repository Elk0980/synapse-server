/* Campaign continuity, conversion intents, behaviour stages and the site counter.
   Единственный счётчик сайта — Яндекс Метрика 112772817 (номер подтверждён клиенткой
   18.09.2026). Загрузчик и инициализация выполняются ровно один раз.

   Что здесь считается и чего здесь нет:
   - Этапы (service_view, price_view, contact_view, callback_open) — ровно один раз
     на просмотр страницы и только при фактической видимости сцены.
   - Действия (клики, шаги формы) — каждое срабатывание, отдельно от этапов.
   - reachGoal вызывается БЕЗ параметров: ни значения полей, ни телефон, ни имя,
     ни URL в Метрику не передаются. Канал остаётся только в dataLayer.
   - Встроенный прайс (price.html?embedded=1 внутри iframe на главной) — это
     публичный прайс, который смотрит посетитель, а не служебный визит. Второй
     счётчик в нём не подключается. Фактический просмотр прайса (price_view) и клики
     передаются в родительское окно через postMessage; родитель принимает их только
     со своего origin, только от iframe своего диалога прайса и только из allowlist.
     Загрузка iframe сама по себе ничего не засчитывает. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) api.start(host, host.document);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const storageKey = 'avk_src';
  const counterId = 112772817;
  const counterLoader = 'https://mc.yandex.ru/metrika/tag.js?id=' + counterId;
  // Вебвизор выключен: опубликованная privacy.html прямо говорит, что запись действий
  // посетителя отключена. Эта правка запись действий не расширяет.
  const webvisor = false;
  const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'yclid'];
  const lifetime = 30 * 86400000;
  const sitePages = /\/(?:index\.html|price\.html|contacts\.html)?$/;
  const bookingHost = /(^|\.)yclients\.com$/i;
  const bridgeToken = 'avokado-analytics';
  const stageDwell = 900;
  // Единственный разрешённый список целей. Ничего вне него в Метрику не уходит.
  const stageGoals = Object.freeze(['service_view', 'price_view', 'contact_view', 'callback_open']);
  const actionGoals = Object.freeze(['callback_start', 'callback_attempt', 'callback_submit',
    'callback_duplicate', 'callback_error', 'phone_click', 'messenger_click', 'social_click',
    'booking_click', 'price_click', 'contact_choice']);
  const allowedGoals = Object.freeze(stageGoals.concat(actionGoals));
  // Что встроенный прайс вправе передать родителю: клики и фактический просмотр прайса.
  // Остальные этапы относятся к сценам главной и считаются только там.
  const bridgeGoals = Object.freeze(actionGoals.concat(['price_view']));
  // Личный диалог против сообщества: сообщество, канал или приглашение в группу —
  // не личное сообщение студии. Когда доказательства личного диалога нет, ссылка
  // идёт в social_click. t.me/+<цифры> — ссылка на номер (7–15 цифр по E.164);
  // t.me/+<код> с буквами и t.me/joinchat/<код> — приглашения в группу.
  const chatHosts = [
    {host: /^(?:.+\.)?wa\.me$/i, channel: 'whatsapp', direct: url => /^\/\+?\d{6,}\/?$/.test(url.pathname)},
    {host: /^(?:.+\.)?whatsapp\.com$/i, channel: 'whatsapp', direct: url => /^\/send\/?$/.test(url.pathname) && url.searchParams.has('phone')},
    {host: /^(?:.+\.)?(?:t\.me|telegram\.me)$/i, channel: 'telegram', direct: url => /^\/\+\d{7,15}\/?$/.test(url.pathname)},
    {host: /^(?:.+\.)?telegram\.org$/i, channel: 'telegram', direct: () => false},
    {host: /^(?:.+\.)?vk\.me$/i, channel: 'vk', direct: () => true},
    {host: /^(?:.+\.)?(?:vk\.com|vkontakte\.ru)$/i, channel: 'vk', direct: url => /^\/(?:im|write-?\d+)\/?$/.test(url.pathname)},
    {host: /^(?:.+\.)?max\.ru$/i, channel: 'max', direct: url => /^\/u\/[^/]+\/?$/.test(url.pathname)},
    {host: /^(?:.+\.)?m\.me$/i, channel: 'messenger', direct: () => true},
    {host: /^(?:.+\.)?messenger\.com$/i, channel: 'messenger', direct: url => /^\/t\//.test(url.pathname)},
    {host: /^(?:.+\.)?(?:instagram\.com|facebook\.com|fb\.com|ok\.ru|youtube\.com|youtu\.be|tiktok\.com|dzen\.ru)$/i,
      channel: 'social', direct: () => false}
  ];
  function readAttribution(location, referrer, storage, now) {
    const query = new URL(location.href).searchParams;
    const incoming = {};
    keys.forEach(key => { const value = query.get(key); if (value) incoming[key] = value.slice(0, 512); });
    let saved = {};
    try { saved = JSON.parse(storage.getItem(storageKey) || '{}') || {}; } catch (_) {}
    const seen = Date.parse(saved.first_seen);
    let result = {};
    let internalReferrer = false;
    try { internalReferrer = new URL(referrer).origin === location.origin; } catch (_) {}
    if (Object.keys(incoming).length) {
      const sameCampaign = keys.every(key => (incoming[key] || '') === (saved[key] || ''));
      const keepDate = internalReferrer && sameCampaign && Number.isFinite(seen) && seen <= now && now - seen < lifetime;
      result = {...incoming, first_seen: keepDate ? saved.first_seen : new Date(now).toISOString()};
    } else if (Number.isFinite(seen) && seen <= now && now - seen < lifetime) {
      keys.forEach(key => { if (typeof saved[key] === 'string' && saved[key]) result[key] = saved[key].slice(0, 512); });
      result.first_seen = saved.first_seen;
    } else {
      try {
        const ref = new URL(referrer);
        if (['http:', 'https:'].includes(ref.protocol) && ref.hostname !== location.hostname) {
          result = {utm_source: ref.hostname.replace(/^www\./, ''), utm_medium: 'referral', first_seen: new Date(now).toISOString()};
        }
      } catch (_) {}
    }
    try {
      if (Object.keys(result).length) storage.setItem(storageKey, JSON.stringify(result));
      else storage.removeItem(storageKey);
    } catch (_) {}
    // Keep this visit's tags in memory even when browser storage is unavailable.
    return result;
  }
  function decorateUrl(value, base, attribution, entryPoint) {
    let url;
    try { url = new URL(value, base); } catch (_) { return value; }
    if (!['https:', 'http:'].includes(url.protocol)) return value;
    const current = new URL(base);
    const booking = bookingHost.test(url.hostname);
    const internal = url.origin === current.origin && sitePages.test(url.pathname) && url.pathname !== current.pathname && !value.startsWith('#');
    if (!booking && !internal) return value;
    keys.forEach(key => { if (attribution[key]) url.searchParams.set(key, attribution[key]); });
    // The ad creative's utm_content and the website button are different dimensions.
    if (booking && entryPoint) url.searchParams.set('entry_point', entryPoint);
    return url.href;
  }
  function classify(value, base) {
    let url;
    try { url = new URL(value, base); } catch (_) { return null; }
    if (url.protocol === 'tel:') return {event: 'phone_click', channel: 'phone'};
    if (['tg:', 'whatsapp:', 'viber:'].includes(url.protocol)) return {event: 'messenger_click', channel: url.protocol.slice(0, -1)};
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    // Онлайн-запись — только фактический Yclients, никакой другой хост.
    if (bookingHost.test(url.hostname)) return {event: 'booking_click', channel: 'yclients'};
    for (const entry of chatHosts) {
      if (!entry.host.test(url.hostname)) continue;
      let direct = false;
      try { direct = Boolean(entry.direct(url)); } catch (_) { direct = false; }
      return direct
        ? {event: 'messenger_click', channel: entry.channel}
        : {event: 'social_click', channel: entry.channel};
    }
    const current = new URL(base);
    if (url.origin === current.origin) {
      // Со страницы прайса (в том числе из встроенного) ссылка «← Вернуться на сайт»
      // ведёт на index.html#price — это уход с прайса, а не намерение его открыть.
      const onPrice = /\/price\.html$/.test(current.pathname);
      const toPrice = !onPrice && ((/\/price\.html$/.test(url.pathname) && url.pathname !== current.pathname) || url.hash === '#price');
      const toContacts = (/\/contacts\.html$/.test(url.pathname) && url.pathname !== current.pathname) || url.hash === '#contacts';
      if (toPrice) return {event: 'price_click'};
      // Любой переход к контактам, включая fallback «написать нам», который
      // contact-route.js переписал на #contacts, — намерение contact_choice.
      // Этап contact_view засчитывается только по фактической видимости контактов.
      if (toContacts) return {event: 'contact_choice'};
    }
    return null;
  }
  // Счётчик сайта. Договор о состоянии, важен для повторных вызовов:
  //   win.__metrikaReady выставляется ТОЛЬКО после того, как загрузчик реально вставлен
  //   в документ. Сбой до вставки состояние не меняет, поэтому следующий вызов
  //   с рабочим документом подключит счётчик как обычно.
  //   Возвращается true только когда вставлен загрузчик И прошла инициализация.
  // Аналитика ни при каких ошибках не должна обрывать атрибуцию, поэтому исключения
  // гасятся здесь, а не улетают в start().
  function startCounter(win, doc) {
    if (!win || win.__metrikaReady) return false;
    // Тот же признак отказа от трекинга, что и у приёмника целей ниже — отдельной механики не заводим.
    if (win.navigator && win.navigator.doNotTrack === '1') return false;
    // Документ без создания элементов (тесты, урезанное окружение) — счётчик просто
    // не подключается, состояние не меняется.
    if (!doc || typeof doc.createElement !== 'function') return false;
    // Очередь ym определяется до вставки загрузчика, как в официальном коде счётчика.
    try {
      win.ym = win.ym || function () { (win.ym.a = win.ym.a || []).push(arguments); };
      win.ym.l = Number(new Date());
    } catch (_) { return false; }
    try {
      const script = doc.createElement('script');
      script.async = true;
      script.src = counterLoader;
      const scripts = typeof doc.getElementsByTagName === 'function' ? doc.getElementsByTagName('script') : null;
      const first = scripts && scripts[0];
      if (first && first.parentNode) first.parentNode.insertBefore(script, first);
      else (doc.head || doc.documentElement).appendChild(script);
    } catch (_) { return false; }
    // Загрузчик на странице — второй раз его вставлять нельзя даже при сбое init ниже.
    win.__metrikaReady = true;
    try {
      win.ym(counterId, 'init', {clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: webvisor});
    } catch (_) { return false; }
    return true;
  }
  // Встроенный прайс: окно внутри iframe с ?embedded=1 либо с классом, который
  // ставит сам price.html. Там счётчика быть не должно.
  function isEmbedded(win, doc) {
    try {
      if (!win.parent || win.parent === win) return false;
      if (new URLSearchParams(win.location.search).get('embedded') === '1') return true;
      const root = doc && doc.documentElement;
      if (root && root.classList && root.classList.contains('av-price-embedded')) return true;
    } catch (_) { return true; }
    return false;
  }
  // Лоадер страницы (#page-loader: fixed, inset 0, непрозрачный фон, z-index 10000)
  // закрывает экран, только пока он показан: класс is-visible без is-complete и не
  // display:none. Без классов он прозрачен (opacity 0 в стилях страницы).
  function loaderCovers(win, doc) {
    const loader = typeof doc.getElementById === 'function' ? doc.getElementById('page-loader') : null;
    if (!loader || loader.hidden) return false;
    let style = null;
    if (typeof win.getComputedStyle === 'function') {
      try { style = win.getComputedStyle(loader); } catch (_) { style = null; }
    }
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    if (loader.classList.contains('is-complete')) return false;
    if (loader.classList.contains('is-visible')) return true;
    return Boolean(style && style.opacity !== '' && style.opacity !== undefined && Number(style.opacity) > 0);
  }
  // Что сейчас закрывает страницу. На сайте все диалоги открываются только через
  // showModal (прайс, промо, галерея результатов), поэтому любой dialog[open] —
  // модальный и закрывает всё, что не внутри него. Классы html.av-price-open и
  // html.promo-open ставят сами скрипты сайта — они учитываются отдельно, чтобы
  // промежуток между классом и showModal тоже был закрыт. null — «закрыто всё».
  function coverings(win, doc) {
    const list = [];
    if (typeof doc.querySelectorAll === 'function') doc.querySelectorAll('dialog[open]').forEach(dialog => list.push(dialog));
    const root = doc.documentElement;
    const flagged = name => Boolean(root && root.classList && root.classList.contains(name));
    [['av-price-open', '.av-price-dialog'], ['promo-open', '#promo']].forEach(([flag, selector]) => {
      if (!flagged(flag)) return;
      const owner = typeof doc.querySelector === 'function' ? doc.querySelector(selector) : null;
      list.push(owner || null);
    });
    if (loaderCovers(win, doc)) list.push(doc.getElementById('page-loader'));
    return list;
  }
  // Сцена не перекрыта, если каждое закрывающее окно содержит её саму: этап внутри
  // открытой модалки допускается только когда относится к этой модалке.
  function unobstructed(win, doc, element) {
    return coverings(win, doc).every(cover => Boolean(cover && cover.contains && cover.contains(element)));
  }
  // Сцена засчитывается только если её действительно видно: активная вкладка,
  // элемент не скрыт, не нулевого размера и не перекрыт модальным окном или лоадером.
  function visibleEnough(win, doc, element) {
    if (!element || element.hidden) return false;
    if (doc.visibilityState && doc.visibilityState !== 'visible') return false;
    const root = doc.documentElement;
    if (!unobstructed(win, doc, element)) return false;
    if (typeof win.getComputedStyle === 'function') {
      let style;
      try { style = win.getComputedStyle(element); } catch (_) { style = null; }
      // Пустая строка opacity — «не задано», а не ноль: Number('') === 0 дал бы ложный отказ.
      const transparent = style && style.opacity !== '' && style.opacity !== undefined && Number(style.opacity) === 0;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || transparent)) return false;
    }
    let box;
    try { box = element.getBoundingClientRect(); } catch (_) { return false; }
    if (!box || box.width < 1 || box.height < 1) return false;
    const viewport = win.innerHeight || (root && root.clientHeight) || 0;
    if (viewport < 1) return false;
    const shown = Math.min(box.bottom, viewport) - Math.max(box.top, 0);
    if (shown <= 0) return false;
    return shown >= Math.min(box.height * 0.5, viewport * 0.3);
  }
  // Один приёмник для этапов и действий. Этапы дедуплицируются, действия — нет.
  function createTracker(win, options) {
    const settings = options || {};
    const fired = new Set();
    function allowed(goal) { return allowedGoals.includes(goal); }
    function refused() { return Boolean(win.navigator && win.navigator.doNotTrack === '1'); }
    function push(goal, detail) {
      const event = {event: goal};
      if (detail && detail.channel) event.channel = detail.channel;
      if (detail && detail.entry_point) event.entry_point = detail.entry_point;
      win.dataLayer = win.dataLayer || [];
      win.dataLayer.push(event);
    }
    function reach(goal) {
      // Только идентификатор цели. Никаких параметров — значит никаких персональных данных.
      try { if (typeof win.ym === 'function') win.ym(counterId, 'reachGoal', goal); } catch (_) {}
    }
    function track(goal, detail) {
      if (!allowed(goal) || refused()) return false;
      const stage = stageGoals.includes(goal);
      // Во встроенном прайсе из этапов возможен только фактический просмотр прайса.
      if (settings.embedded && !bridgeGoals.includes(goal)) return false;
      if (stage) {
        if (fired.has(goal)) return false;
        fired.add(goal);
      }
      push(goal, detail);
      if (settings.embedded) {
        try {
          win.parent.postMessage({source: bridgeToken, goal: goal,
            channel: detail && detail.channel ? String(detail.channel).slice(0, 32) : ''}, win.location.origin);
        } catch (_) {}
      } else reach(goal);
      return true;
    }
    function once(key) {
      if (fired.has(key)) return false;
      fired.add(key);
      return true;
    }
    return {track, done: goal => fired.has(goal), once, goals: allowedGoals};
  }
  // Окна iframe диалога прайса на этой странице и открыт ли сейчас их диалог.
  function bridgeFrames(doc) {
    const frames = [];
    doc.querySelectorAll('.av-price-dialog iframe').forEach(frame => {
      let view = null;
      try { view = frame.contentWindow; } catch (_) { view = null; }
      if (!view) return;
      const dialog = frame.closest('.av-price-dialog');
      const shown = Boolean(dialog && (dialog.open === true || dialog.hasAttribute('open')));
      // Открыт и не перекрыт другим модальным окном или лоадером.
      frames.push({view, open: shown && unobstructed(doc.defaultView || {}, doc, dialog)});
    });
    return frames;
  }
  // Сообщение из встроенного прайса принимается, только если совпали все три условия:
  // origin — собственный; source — окно iframe диалога прайса этой страницы;
  // цель — из bridgeGoals. price_view — только пока диалог фактически открыт.
  function acceptBridgeMessage(win, event, frames) {
    if (!event || event.origin !== win.location.origin) return null;
    const data = event.data;
    if (!data || data.source !== bridgeToken || typeof data.goal !== 'string') return null;
    if (!bridgeGoals.includes(data.goal)) return null;
    const frame = (frames || []).find(item => item && item.view && item.view === event.source);
    if (!frame) return null;
    if (data.goal === 'price_view' && !frame.open) return null;
    const channel = typeof data.channel === 'string' && /^[a-z0-9_-]{1,32}$/.test(data.channel) ? data.channel : '';
    return {goal: data.goal, channel};
  }
  function createStageWatcher(win, doc, tracker) {
    const stages = [];
    const pending = new Map();
    function clear(goal) {
      const timer = pending.get(goal);
      if (timer) { win.clearTimeout(timer); pending.delete(goal); }
    }
    function register(goal, select) { stages.push({goal, select}); }
    function check() {
      stages.forEach(stage => {
        if (tracker.done(stage.goal)) { clear(stage.goal); return; }
        let element = null;
        try { element = stage.select(); } catch (_) { element = null; }
        if (!visibleEnough(win, doc, element)) { clear(stage.goal); return; }
        if (pending.has(stage.goal)) return;
        pending.set(stage.goal, win.setTimeout(() => {
          pending.delete(stage.goal);
          let still = null;
          try { still = stage.select(); } catch (_) { still = null; }
          if (visibleEnough(win, doc, still)) tracker.track(stage.goal);
        }, stageDwell));
      });
    }
    return {register, check, stages};
  }
  function start(win, doc) {
    if (win.__avokadoAttributionLoaded) return;
    win.__avokadoAttributionLoaded = true;
    const embedded = isEmbedded(win, doc);
    const tracker = createTracker(win, {embedded});
    // Хук для callback.js: шаги формы знает только он, перехватывать глобальный
    // fetch запрещено, поэтому он вызывает этот объект напрямую.
    win.AvokadoAnalytics = {track: tracker.track, goals: allowedGoals, embedded};
    // Ещё один рубеж: что бы ни случилось со счётчиком, разметка ссылок и события
    // атрибуции обязаны запуститься. Во встроенном прайсе счётчик не подключается.
    if (!embedded) { try { startCounter(win, doc); } catch (_) {} }
    let storage;
    try { storage = win.localStorage; } catch (_) {}
    const attribution = readAttribution(win.location, doc.referrer || '', storage, Date.now());
    const page = /\/price\.html$/.test(win.location.pathname) ? 'price' : /\/contacts\.html$/.test(win.location.pathname) ? 'contacts' : 'landing';
    function entryPoint(anchor, event) {
      const value = anchor.getAttribute('data-entry-point') || '';
      return /^[a-z0-9_-]{1,80}$/i.test(value) ? value : page + '_' + event.replace(/_click$/, '');
    }
    function decorate(anchor) {
      const value = anchor.getAttribute('href');
      if (!value) return;
      const action = classify(value, win.location.href);
      const point = action && action.event === 'booking_click' ? entryPoint(anchor, 'booking_click') : '';
      const next = decorateUrl(value, win.location.href, attribution, point);
      if (next !== value) anchor.setAttribute('href', next);
    }
    function scan(node) {
      if (node.matches && node.matches('a[href]')) decorate(node);
      if (node.querySelectorAll) node.querySelectorAll('a[href]').forEach(decorate);
    }
    scan(doc);
    if (win.MutationObserver) new win.MutationObserver(records => records.forEach(record => {
      if (record.type === 'attributes') decorate(record.target);
      else record.addedNodes.forEach(scan);
    })).observe(doc.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['href']});
    function onClick(event) {
      if (event.button !== undefined && event.button > 1) return;
      const anchor = event.target && event.target.closest && event.target.closest('a[href]');
      if (!anchor) return;
      // Capture also covers a newly inserted link before its mutation callback runs.
      // Ссылки переписывает company-links.js из CRM, поэтому цель определяется
      // по действующему href в момент клика, а не по разметке документа.
      decorate(anchor);
      const action = classify(anchor.getAttribute('href'), win.location.href);
      if (!action) return;
      tracker.track(action.event, {channel: action.channel, entry_point: entryPoint(anchor, action.event)});
    }
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('auxclick', event => { if (event.button === 1) onClick(event); }, true);
    const watcher = createStageWatcher(win, doc, tracker);
    // Прайс считается просмотренным, когда каталог действительно отрисован и виден,
    // а не когда загрузился пустой каркас страницы.
    const renderedCatalog = () => doc.querySelector('#av-catalog-content .av-direction') ? doc.getElementById('av-catalog-content') : null;
    const recheck = () => watcher.check();
    if (embedded) {
      // Внутри iframe — только просмотр прайса, и тот уходит родителю, а не в счётчик.
      watcher.register('price_view', renderedCatalog);
    } else {
      // Услуги считаются показанными, когда каталог услуг отрисован и блок виден;
      // заглушка «Загружаем услуги» или «Прайс временно недоступен» этапом не является.
      if (page === 'landing') watcher.register('service_view', () => doc.querySelector('#price .av-direction') ? doc.getElementById('price') : null);
      if (page === 'price') watcher.register('price_view', renderedCatalog);
      watcher.register('contact_view', () => doc.getElementById('contact-messengers') ||
        doc.getElementById('messengers') || doc.getElementById('contacts'));
      watcher.register('callback_open', () => doc.querySelector('[data-callback-form]'));
      if (win.MutationObserver) {
        // Открытие и закрытие модалок (класс html, атрибут open у dialog) и исчезновение
        // лоадера меняют видимость сцен без прокрутки — пересчитываем сразу.
        new win.MutationObserver(recheck).observe(doc.documentElement, {attributes: true, attributeFilter: ['class']});
        new win.MutationObserver(recheck).observe(doc.body, {subtree: true, attributes: true, attributeFilter: ['open']});
        const loader = doc.getElementById('page-loader');
        if (loader) new win.MutationObserver(recheck).observe(loader, {attributes: true, attributeFilter: ['class', 'style', 'hidden']});
      }
      // Первый ввод в форму — отдельное действие, один раз на форму за просмотр страницы.
      doc.addEventListener('input', event => {
        const form = event.target && event.target.closest && event.target.closest('[data-callback-form]');
        if (!form) return;
        if (!tracker.once('callback_start:' + (form.id || 'form'))) return;
        tracker.track('callback_start');
      }, true);
      win.addEventListener('message', event => {
        const accepted = acceptBridgeMessage(win, event, bridgeFrames(doc));
        if (accepted) tracker.track(accepted.goal, {channel: accepted.channel});
      });
    }
    win.addEventListener('scroll', recheck, {passive: true});
    win.addEventListener('resize', recheck, {passive: true});
    win.addEventListener('load', recheck);
    doc.addEventListener('visibilitychange', recheck);
    doc.addEventListener('avokado:catalog-ready', recheck);
    watcher.check();
    return {attribution, tracker, watcher, embedded};
  }
  return {storageKey, lifetime, counterId, counterLoader, webvisor, stageGoals, actionGoals,
    allowedGoals, bridgeGoals, bridgeToken, stageDwell, readAttribution, decorateUrl, classify,
    startCounter, isEmbedded, loaderCovers, coverings, unobstructed, visibleEnough, createTracker,
    createStageWatcher, bridgeFrames, acceptBridgeMessage, start};
});
