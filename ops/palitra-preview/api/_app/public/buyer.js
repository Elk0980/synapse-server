/*
 * Palitra — «Мои тестовые заказы» на сайте-черновике. Подключается ДО принятого app.js (режим integration).
 * - window.PalitraSession: запросы приложения /api/… идут в пространство /_palitra_test/api/… этого же сайта с
 *   собственным cookie покупателя (HttpOnly, его не видно скрипту). Роль не выбирается и не передаётся: сервер
 *   сам знает покупателя этой тестовой пары и показывает только его заказы.
 * - Новый заказ здесь не оформляется: вкладка «Заказать» скрыта, а отправка заказа отсюда отклоняется до сети —
 *   тестовый заказ создаётся обычной формой сайта.
 * - Cookie покупателя на сайте одна на браузер, поэтому вкладка помнит свой тест (X-Palitra-Test-Context в
 *   sessionStorage) и присылает его с каждым запросом: если в другой вкладке открыт другой тест, сервер отвечает 423,
 *   данные чужого теста не показываются, а переход к нему — только явной кнопкой.
 * - Завершённый тест (423 от сервера) показывается явно; действия не повторяются вслепую.
 * - #order=N в адресе открывает этот заказ после загрузки списка (номер — не секрет).
 */
'use strict';

(() => {
  const BASE = '/_palitra_test';
  const MARK = 'palitra-test-pair-v1';
  // Ожидаемый тест этой вкладки (несекретный идентификатор пары; общий с мостом сайта, хранится отдельно у вкладки).
  const CONTEXT_KEY = 'palitra-test-context-v1';
  const NATIVE_REQUESTS = ['palitra-order-request-v1:cart', 'palitra-order-request-v1:request'];
  const banner = document.getElementById('testBanner');
  let ended = '';
  let expected = null;
  try { expected = sessionStorage.getItem(CONTEXT_KEY) || null; } catch (_) { expected = null; }

  const failure = (message, status, code) => Object.assign(new Error(message), { status, code });
  function remember(context) { expected = context; try { sessionStorage.setItem(CONTEXT_KEY, context); } catch (_) { /* только память страницы */ } }
  function adoptCurrent() {
    // Явный переход к тесту, открытому сейчас в браузере: прежние ожидание и неотправленные номера заявок сайта
    // относились к другому тесту и не переносятся в новый.
    try { sessionStorage.removeItem(CONTEXT_KEY); for (const key of NATIVE_REQUESTS) sessionStorage.removeItem(key); } catch (_) { /* недоступно */ }
    window.location.reload();
  }
  function showChanged(text) {
    if (!banner || !banner.hidden) return;
    const p = document.createElement('p');
    p.textContent = text;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn btn-secondary test-btn'; b.textContent = 'Перейти к текущему тесту';
    b.addEventListener('click', adoptCurrent);
    banner.replaceChildren(p, b);
    banner.hidden = false;
  }
  function markEnded() {
    // Сайт тоже должен знать, что тест закончился: мост перестанет отправлять заказы на тестовый сервер.
    try {
      const saved = JSON.parse(localStorage.getItem(MARK) || 'null');
      if (saved && typeof saved === 'object') localStorage.setItem(MARK, JSON.stringify({ ...saved, state: 'ended' }));
    } catch (_) { /* хранилище недоступно */ }
  }
  function showEnded(text) {
    if (!banner || !banner.hidden) return;
    const p = document.createElement('p');
    p.textContent = text;
    banner.replaceChildren(p);
    banner.hidden = false;
  }

  window.PalitraSession = {
    async request(path, { method = 'GET', body } = {}) {
      if (typeof path !== 'string' || !path.startsWith('/api/')) throw failure('Действие недоступно.', 404);
      if (method === 'POST' && path === '/api/orders') {
        throw failure('Новый тестовый заказ оформляется на сайте: добавьте набор в корзину и отправьте заявку.', 403, 'SITE_ONLY');
      }
      if (ended) throw failure(ended, 401, 'ended');
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      // Без ожидаемого теста сервер не примет изменение; чтение без него — только первое знакомство вкладки.
      if (expected) headers['X-Palitra-Test-Context'] = expected;
      let res;
      try {
        res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store' });
      } catch (_) { throw failure('Нет связи с тестовым сервером. Введённые данные сохранены — попробуйте ещё раз.', 0, 'network'); }
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (res.status === 423) {
        ended = (data && typeof data.error === 'string' && data.error) || 'Тест с приложением завершён. Действие не выполнено.';
        if (data && ['TEST_CONTEXT_CHANGED', 'TEST_CONTEXT_REQUIRED'].includes(data.code)) {
          // В браузере открыт другой тест: эта вкладка не усваивает его данные; переход — только явной кнопкой.
          showChanged(ended);
        } else {
          // Тест завершён (6 ч, новый тест или перезапуск): действие не выполнено, дальше запросы не отправляются.
          markEnded();
          showEnded(ended);
        }
        throw failure(ended, 401, 'ended');
      }
      const got = res.headers && typeof res.headers.get === 'function' ? res.headers.get('X-Palitra-Test-Context') : null;
      if (res.ok && got) {
        if (!expected) remember(got);
        else if (got !== expected) {
          ended = 'В этом браузере открыт другой тест. Эта вкладка относится к прежнему — данные не показаны, действие не выполнено.';
          showChanged(ended);
          throw failure(ended, 401, 'ended');
        }
      }
      if (res.ok && (!data || typeof data !== 'object')) throw failure('Ответ сервера не удалось прочитать.', res.status, 'unreadable');
      if (!res.ok || !data || data.error) throw failure((data && typeof data.error === 'string' && data.error) || 'Не удалось выполнить действие.', res.status, data && data.code);
      return data;
    }
  };

  // Оформление здесь не показывается: принятый интерфейс открывает «Заказать», если заказов ещё нет.
  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-tab="shop"]') : null;
    if (t) { ev.preventDefault(); ev.stopImmediatePropagation(); }
  }, true);
  const wanted = /^#order=([1-9]\d{0,14})$/.exec(window.location.hash);
  let openId = wanted ? wanted[1] : null;
  function enforce() {
    const shop = document.getElementById('tab-shop');
    if (shop && (shop.getAttribute('aria-current') === 'page' || document.getElementById('shopForm'))) {
      const mine = document.getElementById('tab-mine');
      if (mine) mine.click();
    }
    if (openId) {
      const open = document.querySelector(`[data-action="mine-open"][data-id="${openId}"]`);
      if (open) {
        openId = null;
        try { history.replaceState(history.state, '', window.location.pathname); } catch (_) { /* адрес не меняется */ }
        open.click();
      }
    }
  }
  new MutationObserver(enforce).observe(document.body, { childList: true, subtree: true });

  const reload = document.getElementById('testReload');
  if (reload) reload.addEventListener('click', () => window.location.reload());
})();
