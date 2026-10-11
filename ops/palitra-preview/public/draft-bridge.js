/* Palitra — ТЕСТОВЫЙ мост сайта-черновика с приложением (парный тест из Telegram-просмотра). Не production.
   Подключается в начале свежего общего /assets/storefront.js (SITE_storefront.js, см. DEPLOY.md): там же охрана
   черновика получает одну проверку window.PalitraTestBridge.allowsNativeSubmit(). order.js не меняется.

   Правила:
   - Без ключа в адресе (#palitra-test=…), без сохранённой тестовой пары и без незавершённого обмена ключа скрипт
     НИЧЕГО не делает: fetch не подменяется, запросов нет — обычный черновик и его остановка приёма заявок как есть.
   - Ключ из адреса сразу убирается штатным history.replaceState и обменивается на собственный cookie тестового
     сервера (__Host-palitra_test, HttpOnly — скрипту не виден). До подтверждённого обмена ключ лежит только в
     sessionStorage этой вкладки (повтор после потерянного ответа), затем удаляется. В localStorage — только
     отметка «тест включён/завершён» и время окончания.
   - Cookie на сайте одна на браузер, поэтому вкладка помнит СВОЙ тест (несекретный X-Palitra-Test-Context в
     sessionStorage) и присылает его с каждой заявкой. Если в другой вкладке открыли другой тест, сервер отвечает
     423 без записи, а вкладка показывает это и переходит к новому тесту только по явной кнопке — с очисткой
     неотправленных номеров заявок order.js (они относились к прежнему тесту).
   - Перехватывается только точный POST /api/orders этого же сайта (нативные формы order.js): тот же body, requestId
     и AbortSignal уходят на /_palitra_test/api/orders; добавляется только заголовок теста, credentials 'omit'
     меняются на 'same-origin' только в этом вызове. Все остальные запросы проходят без изменений.
   - Ответ тестового сервера — в формате формы ({ok, orderId, message}): корзина очищается штатно, текст — от
     тестового сервера. Завершённый или сменившийся тест (423) не отправляет заявку вслепую ни в тестовый, ни в
     обычный маршрут; корзина сохраняется.
   - Стили задаются через CSSOM (без inline-разметки и без ослабления CSP); шрифт наследуется от сайта. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) api.mount(root);
}(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const PREFIX = '/_palitra_test';
  const ENDPOINT = '/api/orders';
  const MARK = 'palitra-test-pair-v1';
  const CONTEXT_KEY = 'palitra-test-context-v1';
  const CLAIM_KEY = 'palitra-test-claim-v1';
  const NATIVE_REQUESTS = ['palitra-order-request-v1:cart', 'palitra-order-request-v1:request'];
  const FRAGMENT = /^#palitra-test=([A-Za-z0-9_-]{43})$/;
  const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
  const STALE_MS = 24 * 60 * 60 * 1000; // отметку давно закончившегося теста убираем молча
  const TEXT = {
    connecting: 'Подключаем тест сайта с приложением Palitra…',
    active: 'Тест сайта с приложением Palitra. Заявки с этого сайта уходят только на тестовый сервер, никуда не отправляются и хранятся в памяти не дольше 6 часов. Это не настоящие заказы.',
    ended: 'Тест с приложением завершён: прошло до 6 часов, создан новый тест или тестовый сервер перезапущен. Заявка не отправлена, корзина сохранена. Создайте новый тест в приложении.',
    changed: 'В этом браузере открыт другой тест. Эта вкладка относится к прежнему — заявка не отправлена, ничего не записано, корзина сохранена.',
    retry: 'Не удалось подтвердить подключение теста: ответ тестового сервера не дошёл. Заявки пока не отправляются — нажмите «Повторить».',
    unavailable: 'Тестовый сервер не ответил. Заявка не отправлена, корзина сохранена — попробуйте ещё раз.',
    invalid: 'Тестовая ссылка не подошла. Обычный черновик работает как раньше.'
  };
  const BUTTON = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: '56px', padding: '0 24px',
    borderRadius: '28px', border: '0', font: 'inherit', fontWeight: '700', lineHeight: '1.2', textDecoration: 'none', cursor: 'pointer' };

  function memoryStorage() { const map = new Map(); return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) }; }
  function storageOf(win, name) { try { const s = win[name]; s.getItem(MARK); return s; } catch (_) { return memoryStorage(); } }
  function readMark(storage) {
    try {
      const mark = JSON.parse(storage.getItem(MARK) || 'null');
      if (mark && typeof mark === 'object' && ['active', 'ended'].includes(mark.state) && Number.isFinite(Date.parse(mark.latestEnd))) return mark;
    } catch (_) { /* повреждённая отметка */ }
    return null;
  }
  const get = (storage, key) => { try { return storage.getItem(key); } catch (_) { return null; } };
  const put = (storage, key, value) => { try { if (value === null) storage.removeItem(key); else storage.setItem(key, value); } catch (_) { /* недоступно */ } };
  function style(el, props) { for (const key of Object.keys(props)) el.style[key] = props[key]; return el; }

  function mount(win) {
    if (!win || !win.document || !win.location || win.__palitraTestBridge) return null;
    const doc = win.document, loc = win.location;
    const local = storageOf(win, 'localStorage'), tab = storageOf(win, 'sessionStorage');
    const match = FRAGMENT.exec(String(loc.hash || ''));
    const pendingClaim = get(tab, CLAIM_KEY);
    let capability = match ? match[1] : pendingClaim && CAPABILITY.test(pendingClaim) ? pendingClaim : null;
    let mark = readMark(local);
    if (mark && Date.now() - Date.parse(mark.latestEnd) > STALE_MS) { put(local, MARK, null); mark = null; }
    if (!capability && !mark) return null; // обычный черновик: ничего не меняем
    win.__palitraTestBridge = true;
    // Ключ не остаётся в адресе, истории и закладках; на сервер фрагмент и так не уходит.
    if (match) {
      try { win.history.replaceState(win.history.state, '', loc.pathname + loc.search); } catch (_) { /* адрес не изменился */ }
      put(tab, CLAIM_KEY, capability); // до подтверждённого обмена — только в этой вкладке
    }

    let mode = capability ? 'claiming' : mark.state === 'ended' || Date.parse(mark.latestEnd) <= Date.now() ? 'ended' : 'checking';
    let message = mode === 'ended' ? TEXT.ended : '';
    let pending = Promise.resolve();
    let strip = null, receipt = null;
    const nativeFetch = win.fetch;
    const expected = () => get(tab, CONTEXT_KEY);

    const call = (path, init) => nativeFetch.call(win, PREFIX + path, init);
    const json = (res) => res.json().catch(() => null);
    const errorOf = (body) => (body && typeof body.error === 'string' ? body.error : '');
    function adopt(body) {
      // Свой тест вкладки. Номера неотправленных заявок прежнего теста в новый не переносятся.
      if (expected() !== body.context) { for (const key of NATIVE_REQUESTS) put(tab, key, null); put(tab, CONTEXT_KEY, body.context); }
      activate(body);
    }
    function activate(body) {
      mode = 'active'; message = '';
      if (body && typeof body.latestEnd === 'string') put(local, MARK, JSON.stringify({ state: 'active', latestEnd: body.latestEnd }));
      render();
    }
    function end(text) {
      mode = 'ended'; message = text || TEXT.ended;
      const current = readMark(local);
      put(local, MARK, JSON.stringify({ state: 'ended', latestEnd: current ? current.latestEnd : new Date().toISOString() }));
      render();
    }
    function changed(text) { mode = 'changed'; message = text || TEXT.changed; render(); }
    const validContext = (body) => body && body.ok === true && typeof body.context === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.context);
    function claim() {
      mode = 'claiming'; render();
      pending = call('/api/claim', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ capability }) })
        .then((res) => json(res).then((body) => {
          if (res.status === 200 && validContext(body)) { capability = null; put(tab, CLAIM_KEY, null); adopt(body); return; }
          if (res.status >= 400 && res.status < 500 && errorOf(body)) {
            // Ссылка явно не подошла (завершена, открыта в другом браузере, испорчена): тестовый режим не включается.
            capability = null; put(tab, CLAIM_KEY, null); put(local, MARK, null);
            mode = 'invalid'; message = errorOf(body) || TEXT.invalid; render();
            return;
          }
          // Исход неизвестен (ответ потерян, нечитаем, ошибка сервера): cookie мог быть принят — повтор той же ссылки
          // в этой вкладке безопасен (сервер вернёт то же состояние), обычный маршрут формы не используется.
          mode = 'retry'; message = TEXT.retry; render();
        }), () => { mode = 'retry'; message = TEXT.retry; render(); });
      return pending;
    }
    function check() {
      const ctx = expected();
      pending = call('/api/session', { method: 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', ...(ctx ? { 'X-Palitra-Test-Context': ctx } : {}) } })
        .then((res) => json(res).then((body) => {
          if (res.status === 200 && validContext(body)) { if (!ctx) adopt(body); else if (body.context === ctx) activate(body); else changed(); }
          else if (res.status === 423 && body && body.code === 'TEST_CONTEXT_CHANGED') changed(errorOf(body));
          else if (res.status === 423) end(errorOf(body));
          else { mode = 'retry'; message = TEXT.retry; render(); }
        }), () => { mode = 'retry'; message = TEXT.retry; render(); });
      return pending;
    }
    const retry = () => (capability ? claim() : check());
    function synthetic(status, body) {
      return new win.Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    function isNativeOrder(input, init) {
      if (typeof input !== 'string' && !(win.URL && input instanceof win.URL)) return false;
      if (String((init && init.method) || 'GET').toUpperCase() !== 'POST') return false;
      let url;
      try { url = new win.URL(String(input), loc.href); } catch (_) { return false; }
      return url.origin === loc.origin && url.pathname === ENDPOINT && !url.search && !url.hash;
    }
    function withTest(init, ctx) {
      const base = init && init.headers, headers = {};
      if (base && typeof base.forEach === 'function') base.forEach((value, key) => { headers[key] = value; });
      else if (base && typeof base === 'object') Object.assign(headers, base);
      headers['X-Palitra-Test-Context'] = ctx;
      return Object.assign({}, init, { headers, credentials: 'same-origin' });
    }
    function inspect(res, form) {
      json(res).then((body) => {
        if ((res.status === 201 || res.status === 200) && body && body.ok === true && Number.isSafeInteger(body.orderId) && body.orderId > 0) {
          // После штатного сообщения формы: кнопка ведёт к этому заказу в «Моих тестовых заказах».
          win.setTimeout(() => showReceipt(form, body.testOrderId), 0);
        } else if (res.status === 423 && body && ['TEST_CONTEXT_CHANGED', 'TEST_CONTEXT_REQUIRED'].includes(body.code)) changed(errorOf(body));
        else if (res.status === 423) end(errorOf(body));
      });
    }
    win.fetch = function (input, init) {
      if (!isNativeOrder(input, init)) return nativeFetch.apply(win, arguments);
      const form = doc.querySelector ? doc.querySelector('form[aria-busy="true"]') : null;
      // Тест, к которому относится УЖЕ подготовленная формой заявка (тело и requestId), фиксируется до ожидания:
      // если за время ожидания вкладка перешла к другому тесту, заявка не уходит ни в один.
      const ctx = expected();
      return pending.then(() => {
        if (mode === 'invalid') return nativeFetch.call(win, input, init); // явно не тест — как обычный черновик
        if (mode === 'ended') return synthetic(423, { error: message || TEXT.ended, code: 'TEST_EXPIRED' });
        if (mode === 'changed' || (ctx && expected() !== ctx)) return synthetic(423, { error: message || TEXT.changed, code: 'TEST_CONTEXT_CHANGED' });
        if (mode !== 'active' || !ctx) return synthetic(503, { error: TEXT.unavailable, code: 'ORDERS_UNAVAILABLE' });
        return call(ENDPOINT, withTest(init, ctx)).then((res) => { inspect(res.clone(), form); return res; });
      });
    };
    /* Охрана черновика в storefront.js отклоняет нативные формы, пока тест не подтверждён: форма не готовит тело и
       requestId (и не сохраняет их) до тех пор, пока у вкладки нет подтверждённого теста. Здесь — только понятный
       текст о состоянии подключения поверх штатного сообщения охраны. */
    win.PalitraTestBridge = Object.freeze({ allowsNativeSubmit: () => mode === 'active' && Boolean(expected()), mode: () => mode });
    const ORDER_FORMS = 'form[data-order-form],#zayavka form,.cart form';
    const BLOCKED = {
      claiming: 'Тест с приложением ещё подключается — заявка не отправлена, корзина и поля сохранены. Отправьте её, когда наверху появится «Тест сайта с приложением Palitra».',
      checking: 'Тест с приложением ещё подключается — заявка не отправлена, корзина и поля сохранены. Отправьте её, когда наверху появится «Тест сайта с приложением Palitra».'
    };
    if (doc.addEventListener) doc.addEventListener('submit', (event) => {
      const form = event.target;
      if (!form || typeof form.matches !== 'function' || !form.matches(ORDER_FORMS) || mode === 'invalid') return;
      const allowed = win.PalitraTestBridge.allowsNativeSubmit();
      win.setTimeout(() => {
        const node = form.querySelector('[data-draft-order-status]');
        if (!node) return;
        node.textContent = allowed ? '' : BLOCKED[mode] || (mode === 'retry' ? TEXT.retry : message || TEXT.unavailable);
      }, 0);
    }, true);

    /* ---------- тестовая полоса ---------- */
    function button(label, onClick) {
      const b = style(doc.createElement('button'), { ...BUTTON, background: '#F4EFE4', color: '#173c2b' });
      b.type = 'button'; b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }
    function link(label, href, colors) {
      const a = style(doc.createElement('a'), { ...BUTTON, ...colors });
      a.href = href; a.textContent = label;
      return a;
    }
    function render() {
      if (!doc.body) return;
      if (!strip) {
        strip = style(doc.createElement('div'), { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px', padding: '12px 16px',
          background: '#2C2A25', color: '#F4EFE4', font: 'inherit', fontSize: '15px', lineHeight: '1.4', position: 'relative', zIndex: '60' });
        strip.setAttribute('data-palitra-test-strip', '');
        strip.setAttribute('role', 'region');
        strip.setAttribute('aria-label', 'Тест сайта с приложением');
        doc.body.insertBefore(strip, doc.body.firstChild);
      }
      while (strip.firstChild) strip.removeChild(strip.firstChild);
      const text = style(doc.createElement('p'), { margin: '0', flex: '1 1 260px' });
      text.textContent = mode === 'active' ? TEXT.active : mode === 'claiming' || mode === 'checking' ? TEXT.connecting : message;
      strip.appendChild(text);
      if (mode === 'active') strip.appendChild(link('Мои тестовые заказы', `${PREFIX}/`, { background: '#F4EFE4', color: '#173c2b' }));
      if (mode === 'retry') strip.appendChild(button('Повторить', retry));
      if (mode === 'changed') strip.appendChild(button('Перейти к текущему тесту', () => {
        put(tab, CONTEXT_KEY, null); for (const key of NATIVE_REQUESTS) put(tab, key, null);
        win.location.reload();
      }));
      if (mode === 'ended') strip.appendChild(button('Выйти из тестового режима', () => { put(local, MARK, null); put(tab, CONTEXT_KEY, null); win.location.reload(); }));
      if (mode === 'invalid') strip.appendChild(button('Закрыть', () => { if (strip.parentNode) strip.parentNode.removeChild(strip); strip = null; }));
    }
    function showReceipt(form, testOrderId) {
      if (receipt && receipt.parentNode) receipt.parentNode.removeChild(receipt);
      receipt = link('Мой тестовый заказ', Number.isSafeInteger(testOrderId) && testOrderId > 0 ? `${PREFIX}/#order=${testOrderId}` : `${PREFIX}/`,
        { background: 'var(--green, #173c2b)', color: '#fff', marginTop: '12px' });
      receipt.setAttribute('data-palitra-test-receipt', '');
      const status = form && form.querySelector ? form.querySelector('[data-order-status]') : null;
      if (status && status.parentNode) status.parentNode.insertBefore(receipt, status.nextSibling);
      else if (form) form.appendChild(receipt);
      else if (strip) strip.appendChild(receipt);
    }

    if (doc.body) render(); else doc.addEventListener('DOMContentLoaded', render, { once: true });
    if (mode === 'claiming') claim(); else if (mode === 'checking') check();
    return { mode: () => mode, ready: () => pending, strip: () => strip, receipt: () => receipt, retry };
  }

  return { PREFIX, ENDPOINT, MARK, CONTEXT_KEY, CLAIM_KEY, NATIVE_REQUESTS, FRAGMENT, TEXT, mount };
}));
