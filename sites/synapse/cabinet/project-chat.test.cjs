const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(path.join(__dirname, 'project-chat.js'), 'utf8');
const ORIGIN = 'https://synapse.synapsebusiness.ru/cabinet.html';
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const settle = async (rounds = 4) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ids = (dom) => [...dom.window.document.querySelectorAll('.pc-message')].map((node) => node.dataset.messageId);
const text = (dom, selector) => dom.window.document.querySelector(selector)?.textContent || '';

// jsdom builds vary between machines; the view only needs deterministic, timer-free stand-ins.
const polyfill = (w) => {
  let uuid = 0;
  Object.defineProperty(w, 'crypto', { configurable: true, writable: true, value: { randomUUID: () => `client-${++uuid}` } });
  w.AbortSignal.timeout = () => new w.AbortController().signal;
  w.AbortSignal.any = (signals) => {
    const controller = new w.AbortController();
    for (const signal of signals) {
      if (signal.aborted) { controller.abort(signal.reason); break; }
      signal.addEventListener('abort', () => controller.abort(signal.reason));
    }
    return controller.signal;
  };
  const dialog = w.HTMLDialogElement && w.HTMLDialogElement.prototype;
  if (dialog && typeof dialog.showModal !== 'function') {
    dialog.showModal = function showModal() { this.setAttribute('open', ''); };
    dialog.close = function close() { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
  }
  // Без pretendToBeVisual jsdom сообщает document.hidden === true, и опрос переписки
  // штатно пропускается. Кабинет проверяется как открытая видимая вкладка; свойство
  // переопределяется на самом документе, чтобы не зависеть от сборки jsdom и не
  // запускать её цикл кадров.
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => false });
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => 'visible' });
};

const member = (userId, displayName) => ({ userId, displayName });
const message = (over = {}) => ({ id: 'm1', authorType: 'human', authorName: 'Влад', text: 'Привет', createdAt: '2026-09-17T09:00:00.000Z', deliveryStatus: 'local', attachments: [], ...over });
const snapshot = (over = {}) => ({
  room: { replyMode: 'addressed', telegramChatId: '-1001234567890' },
  access: { canReply: true, owner: true },
  members: [member(1, 'Влад'), member(2, 'Дарья')],
  messages: [message()],
  tasks: [],
  stages: [],
  ai: { configured: true, connected: true, runtimeState: 'connected', queued: 0, failed: 0 },
  hasMore: false,
  oldestMessageId: null,
  ...over
});

const boot = (options = {}) => {
  const dom = new JSDOM('<main><section id="hugh-view"></section></main>', { runScripts: 'outside-only', url: ORIGIN });
  const w = dom.window;
  const d = w.document;
  polyfill(w);
  const calls = [];
  const routes = options.routes || {};
  w.fetch = (input, init = {}) => {
    const url = String(input);
    const method = (init.method || 'GET').toUpperCase();
    const call = { url, method, headers: init.headers || {}, body: init.body };
    calls.push(call);
    const key = `${method} ${new w.URL(url, ORIGIN).pathname}`;
    const handler = routes[key] || (key.endsWith('/resolve') ? () => ({body:{shared:false}}) : null);
    return Promise.resolve(handler ? handler(call) : { status: 404, body: { error: `нет маршрута ${key}` } }).then((result) => {
      if (result instanceof Error) throw result;
      const status = result.status === undefined ? 200 : result.status;
      return { ok: status >= 200 && status < 300, status, json: async () => result.body || {} };
    });
  };
  // An explicit clock lets a test run the 5-second poll deterministically and prove that
  // the poll timer — not some other scheduled work — is what it triggered.
  const clock = {
    timers: new Map(),
    next: 0,
    pending: () => [...clock.timers.values()].map((entry) => entry.delay),
    fire: async (delay = 5000) => {
      const due = [...clock.timers.entries()].filter(([, entry]) => entry.delay === delay);
      if (!due.length) throw new Error(`нет запланированного таймера на ${delay} мс`);
      for (const [id] of due) clock.timers.delete(id);
      for (const [, entry] of due) await entry.fn();
    }
  };
  if (options.clock) {
    w.setTimeout = (fn, delay) => { clock.next += 1; clock.timers.set(clock.next, { fn, delay: Number(delay) || 0 }); return clock.next; };
    w.clearTimeout = (id) => { clock.timers.delete(id); };
  }
  const views = {};
  w.SbCabinet = { registerView: (name, definition) => { views[name] = definition; } };
  w.eval(SOURCE);
  w.SbCabinet.privateHugh = { render: async (ctx) => { ctx.byId('hugh-view').textContent = 'Личная переписка'; }, stop() {} };
  const scope = { company: options.company || 'palitra-love', view: 'hugh' };
  const ctx = {
    identity: {
      role: options.role || 'owner',
      userId: 1,
      csrfToken: 'csrf-token',
      displayName: 'Влад',
      permissions: options.permissions || [],
      companies: [{ id: 'palitra-love', name: 'Палитра' }, { id: 'alvi', name: 'АЛВИ' }]
    },
    get selectedProjectId() { return scope.company; },
    get currentView() { return scope.view; },
    byId: (id) => d.getElementById(id),
    escapeHTML
  };
  const click = (selector) => { const node = d.querySelector(selector); assert.ok(node, `нет элемента ${selector}`); node.dispatchEvent(new w.Event('click', { bubbles: true })); };
  const submit = (selector) => { const node = d.querySelector(selector); assert.ok(node, `нет формы ${selector}`); node.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); };
  return { dom, w, d, views, calls, ctx, scope, click, submit, clock };
};

const mount = async (harness) => { await harness.views.hugh.render(harness.d.getElementById('hugh-view'), harness.ctx); await settle(); };

test('хост Mini App: заголовок вместо cookie и CSRF, вложения через защищённый blob, освобождение при смене проекта и отзыве', async () => {
  const harness = boot({ role: 'member', clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ access: { canReply: true, owner: false }, messages: [
      message({ id: 'm1', text: 'Смотри', attachments: [{ id: 'a1', name: 'стена.jpg', mime: 'image/jpeg', url: '/content/project-chat/palitra-love/attachments/a1' }, { id: 'a2', name: 'смета.pdf', mime: 'application/pdf', url: '/content/project-chat/palitra-love/attachments/a2' }] }),
      message({ id: 'm2', authorType: 'assistant', authorName: 'Хью', text: 'Принято' })
    ] }) }),
    'POST /content/project-chat/palitra-love/messages': () => ({ body: { ok: true } }),
    'GET /content/project-chat/alvi': () => ({ body: snapshot({ access: { canReply: true, owner: false }, messages: [] }) })
  } });
  const { w, d } = harness;
  const created = [], revoked = [], fetched = [], revokedMessages = [];
  w.URL.createObjectURL = () => { const url = `blob:asset-${created.length + 1}`; created.push(url); return url; };
  w.URL.revokeObjectURL = (url) => revoked.push(url);
  harness.ctx.identity.csrfToken = '';
  harness.ctx.authHeaders = () => ({ Authorization: 'Bearer room.token' });
  harness.ctx.fetchAsset = async (url) => { fetched.push(url); return new w.Blob(['bytes']); };
  harness.ctx.onRevoked = (message) => revokedMessages.push(message);
  await mount(harness);
  await settle();
  const room = harness.calls.find((call) => call.url.endsWith('/content/project-chat/palitra-love'));
  assert.equal(room.headers.Authorization, 'Bearer room.token');
  // Файлы не запрашиваются картинкой или ссылкой с адресом сервера: только защищённым запросом хоста.
  assert.deepEqual(fetched, ['https://synapse.synapsebusiness.ru/content/project-chat/palitra-love/attachments/a1', 'https://synapse.synapsebusiness.ru/content/project-chat/palitra-love/attachments/a2']);
  const image = d.querySelector('[data-pc-asset$="/a1"]'), pdf = d.querySelector('[data-pc-asset$="/a2"]');
  assert.equal(image.querySelector('img').getAttribute('src'), 'blob:asset-1');
  assert.equal(image.getAttribute('href'), 'blob:asset-1');
  assert.equal(pdf.getAttribute('href'), 'blob:asset-2');
  assert.equal(pdf.querySelector('img'), null);
  assert.equal(d.querySelector('[data-pc-asset-state]'), null, 'после загрузки пометка «Загружаем…» снята');
  assert.ok(!d.body.innerHTML.includes('room.token'), 'токен не попадает в разметку');
  assert.equal(d.querySelector('.pc-ai-badge').textContent, 'ИИ · бизнес-ассистент Синапс Бизнес');
  assert.equal(d.querySelector('[data-pc-mode="private"]'), null);
  assert.equal(d.querySelector('[data-pc-settings]').hidden, true);
  d.querySelector('[data-pc-compose] textarea').value = 'Из Telegram';
  harness.submit('[data-pc-compose]');
  await settle();
  const post = harness.calls.find((call) => call.method === 'POST');
  assert.equal(post.headers.Authorization, 'Bearer room.token');
  assert.equal(post.headers['X-CSRF-Token'], undefined);
  // Смена проекта освобождает blob-адреса прежней комнаты; поздний ответ не создаёт новых.
  harness.scope.company = 'alvi';
  await harness.views.hugh.onProjectChange(harness.ctx);
  await settle();
  assert.deepEqual(revoked, ['blob:asset-1', 'blob:asset-2']);
  assert.equal(created.length, 2);
  // Отзыв доступа: сообщение хоста — про Telegram, а не про вход в кабинет.
  harness.ctx.identity.csrfToken = '';
  const alviRoute = harness.calls.length;
  harness.w.fetch = () => Promise.resolve({ ok: false, status: 401, json: async () => ({ error: 'Сессия чата истекла' }) });
  d.querySelector('[data-pc-compose] textarea').value = 'Ещё';
  harness.submit('[data-pc-compose]');
  await settle();
  assert.ok(harness.calls.length >= alviRoute);
  assert.match(revokedMessages.at(-1) || '', /снова откройте чат из Telegram/);
  assert.equal(d.querySelector('[data-pc-compose]').hidden, true);
  // Явное снятие вида хостом: опрос комнаты больше не запланирован, повторный вызов безопасен.
  assert.equal(typeof harness.views.hugh.unmount, 'function');
  harness.views.hugh.unmount();
  harness.views.hugh.unmount();
  assert.deepEqual(harness.clock.pending().filter((delay) => delay === 5000), []);
  harness.w.close();
});

test('владелец привязывает код Telegram только к участнику комнаты и может отвязать', async () => {
  const posts = [], deletes = [];
  let links = { links: [], pending: [{ code: 'K7M2PQ', firstName: 'Дарья', createdAt: '2026-09-17T09:00:00.000Z', expiresAt: '2026-09-17T09:15:00.000Z' }] };
  const harness = boot({ routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [] }) }),
    'GET /content/project-chat/palitra-love/candidates': () => ({ body: { candidates: [member(1, 'Влад'), member(2, 'Дарья')] } }),
    'GET /content/project-chat/palitra-love/telegram-links': () => ({ body: links }),
    'POST /content/project-chat/palitra-love/telegram-links': (call) => { posts.push(JSON.parse(call.body)); links = { links: [{ telegramUserId: '5001', userId: 2, displayName: 'Дарья', linkedAt: '2026-09-17T09:01:00.000Z' }], pending: [] }; return { status: 201, body: links }; },
    'DELETE /content/project-chat/palitra-love/telegram-links/5001': (call) => { deletes.push(call); links = { links: [], pending: [] }; return { body: links }; }
  } });
  await mount(harness);
  harness.click('[data-pc-edit-members]');
  await settle();
  const { d } = harness;
  const section = d.querySelector('[data-pc-tg-links]');
  assert.match(section.textContent, /Ожидают привязки/);
  assert.match(section.textContent, /Дарья · код K7M2PQ/);
  // Без выбора участника привязка не отправляется.
  harness.click('[data-pc-tg-link="K7M2PQ"]');
  await settle();
  assert.equal(posts.length, 0);
  assert.match(d.querySelector('[data-pc-tg-alert]').textContent, /Выберите участника/);
  const select = d.querySelector('[data-pc-tg-user="K7M2PQ"]');
  assert.deepEqual([...select.options].map((o) => o.value), ['', '1', '2'], 'только участники комнаты');
  select.value = '2';
  harness.click('[data-pc-tg-link="K7M2PQ"]');
  await settle();
  assert.deepEqual(posts, [{ linkCode: 'K7M2PQ', userId: 2 }]);
  assert.match(section.textContent, /Привязаны/);
  assert.match(section.textContent, /Дарья · Telegram ID 5001/);
  harness.click('[data-pc-tg-unlink="5001"]');
  await settle();
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].headers['X-CSRF-Token'], 'csrf-token');
  assert.match(section.textContent, /никто не ждёт привязки/);
  harness.w.close();
});

test('общая переписка экранирует имена, тексты и файлы, показывает фото и честную отметку доставки', async () => {
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [
        message({ id: 'm1', authorName: '<img src=x onerror="alert(1)">', text: 'Смотри <script>alert(2)</script>', deliveryStatus: 'sending', attachments: [{ id: 'a1', name: 'фото "стена".jpg', mime: 'image/jpeg', url: '/content/project-chat/palitra-love/attachments/a1' }] }),
        message({ id: 'm2', authorType: 'telegram', authorName: 'Дарья', text: 'Готово', deliveryStatus: 'sent', attachments: [{ id: 'a2', name: 'видео.mp4', mime: 'video/mp4', url: null, note: 'файл слишком большой для кабинета' }] }),
        message({ id: 'm3', authorType: 'assistant', authorName: 'Хью', text: 'Принято' })
      ] }) })
    }
  });
  await mount(harness);
  const { d } = harness;
  assert.deepEqual(ids(harness.dom), ['m1', 'm2', 'm3']);
  // Ответ ИИ помечен явно и всегда одинаково; людей пометка не касается.
  assert.equal(d.querySelectorAll('.pc-ai-badge').length, 1);
  assert.equal(d.querySelector('[data-message-id="m3"] .pc-ai-badge').textContent, 'ИИ · бизнес-ассистент Синапс Бизнес');
  assert.equal(d.querySelector('[data-message-id="m1"] .pc-ai-badge'), null);
  assert.equal(d.querySelector('.pc-message-meta strong').textContent, '<img src=x onerror="alert(1)">');
  assert.equal(d.querySelectorAll('script').length, 0);
  assert.match(d.querySelector('.pc-message-text').textContent, /<script>alert\(2\)<\/script>/);
  const photos = d.querySelectorAll('.pc-attachment img');
  assert.equal(photos.length, 1);
  assert.equal(new harness.w.URL(photos[0].src, ORIGIN).pathname, '/content/project-chat/palitra-love/attachments/a1');
  assert.equal(photos[0].getAttribute('alt'), 'фото "стена".jpg');
  assert.equal(d.querySelectorAll('a.pc-attachment').length, 1);
  assert.match(text(harness.dom, '.pc-attachment-missing'), /видео\.mp4 · файл слишком большой для кабинета/);
  assert.match(d.body.textContent, /Отправляется в Telegram/);
  assert.match(d.body.textContent, /Отправлено в Telegram/);
  harness.w.close();
});

test('участник без права ответа видит историю, но не композитор и не действия по задачам', async () => {
  const harness = boot({
    role: 'manager',
    routes: { 'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ access: { canReply: false, owner: false }, messages: [message({ text: 'Смета согласована' })] }) }) }
  });
  await mount(harness);
  const { d } = harness;
  assert.match(d.querySelector('[data-pc-messages]').textContent, /Смета согласована/);
  assert.equal(d.querySelector('[data-pc-compose]').hidden, true);
  assert.equal(d.querySelector('[data-pc-readonly]').hidden, false);
  assert.equal(d.querySelectorAll('[data-pc-message-task]').length, 0);
  assert.equal(d.querySelector('[data-pc-new-task]').hidden, true);
  assert.equal(d.querySelector('[data-pc-settings]').hidden, true);
  assert.equal(d.querySelector('[data-pc-edit-members]').hidden, true);
  assert.equal(d.querySelector('[data-pc-mode="private"]'), null);
  harness.w.close();
});

test('настроенный, но неподключённый Хью не выдаётся за работающего', async () => {
  const harness = boot({
    routes: { 'GET /content/project-chat/palitra-love': () => ({ body: snapshot({
      room: { replyMode: 'delegate', telegramChatId: '' },
      ai: { configured: true, connected: false, runtimeState: 'login_required', queued: 2, failed: 0 },
      messages: [message({ text: 'Хью, посчитай смету', aiStatus: 'queued' })]
    }) }) }
  });
  await mount(harness);
  const summary = text(harness.dom, '[data-pc-ai]');
  assert.doesNotMatch(summary, /отвечает по обращению|заменяет Влада/);
  assert.match(summary, /ждёт подтверждения входа/);
  assert.match(summary, /Ожидают ответа: 2/);
  assert.match(harness.d.body.textContent, /Ответ Хью появится после подключения подписки/);
  assert.doesNotMatch(harness.d.body.textContent, /Хью готовит ответ/);
  assert.equal(harness.d.querySelector('[data-pc-retry-ai]').hidden, true);
  assert.match(text(harness.dom, '[data-pc-connection]'), /Telegram пока не привязан/);
  harness.w.close();
});

test('при исчерпанном пределе подписки Хью не выдаётся за отвечающего, а коды входа не уходят участникам', async () => {
  const harness = boot({
    routes: { 'GET /content/project-chat/palitra-love': () => ({ body: snapshot({
      room: { replyMode: 'delegate', telegramChatId: '-1001234567890' },
      ai: { configured: true, connected: true, runtimeState: 'connected', queued: 2, failed: 0, limited: true, retryAfter: 900, waitingReason: 'Достигнут дневной лимит подписки.' },
      messages: [message({ id: 'm1', text: 'Хью, посчитай смету', aiStatus: 'queued' })]
    }) }) }
  });
  await mount(harness);
  const summary = text(harness.dom, '[data-pc-ai]');
  assert.match(summary, /Хью сейчас не отвечает: достигнут предел подписки\./);
  assert.match(summary, /Достигнут дневной лимит подписки\./);
  assert.match(summary, /Повторим примерно через 15 мин\./);
  assert.match(summary, /Ждут ответа: 2\./);
  assert.match(summary, /обработает автоматически, когда ограничение снимется/);
  assert.doesNotMatch(summary, /отвечает по обращению|заменяет Влада|Готовит ответы/);
  assert.match(harness.d.body.textContent, /Ответ Хью отложен до снятия ограничения подписки/);
  assert.doesNotMatch(harness.d.body.textContent, /Хью готовит ответ/);
  assert.doesNotMatch(harness.d.body.textContent, /auth\.openai\.com|Код:/);
  harness.w.close();

  // Обычный участник видит общее пояснение, но не ссылку и не код входа владельца.
  const participant = boot({
    role: 'manager',
    routes: { 'GET /content/project-chat/palitra-love': () => ({ body: snapshot({
      access: { canReply: true, owner: false },
      ai: { configured: true, connected: true, runtimeState: 'connected', queued: 1, failed: 0, limited: true, retryAfter: 45, waitingReason: 'Войдите по коду ABCD-1234 на https://auth.openai.com/codex/device' },
      messages: []
    }) }) }
  });
  await mount(participant);
  const shared = text(participant.dom, '[data-pc-ai]');
  assert.match(shared, /Хью сейчас не отвечает: достигнут предел подписки\./);
  assert.match(shared, /Повторим меньше чем через минуту\./);
  assert.match(shared, /Сохранённые вопросы Хью обработает автоматически/);
  assert.doesNotMatch(participant.d.body.textContent, /ABCD-1234|auth\.openai\.com/);
  assert.equal(participant.d.querySelector('[data-pc-settings]').hidden, true);
  assert.equal(participant.d.querySelector('[data-pc-retry-ai]').hidden, true);
  participant.w.close();
});

test('владелец повторяет только неудавшиеся ответы Хью и не трогает неподтверждённую доставку Telegram', async () => {
  const retries = [];
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({
        ai: { configured: true, connected: true, runtimeState: 'connected', queued: 0, failed: 2 },
        messages: [message({ text: 'Хью, где смета?', aiStatus: 'failed', deliveryStatus: 'uncertain' })]
      }) }),
      'POST /content/project-chat/palitra-love/retry-ai': (call) => { retries.push(call); return { body: { retried: 2 } }; }
    }
  });
  await mount(harness);
  assert.equal(harness.d.querySelector('[data-pc-retry-ai]').hidden, false);
  assert.match(harness.d.body.textContent, /Доставка в Telegram уточняется/);
  harness.click('[data-pc-retry-ai]');
  await settle();
  assert.equal(retries.length, 1);
  assert.deepEqual(JSON.parse(retries[0].body), {});
  assert.equal(retries[0].headers['X-CSRF-Token'], 'csrf-token');
  assert.equal(harness.calls.filter((call) => call.method === 'POST').length, 1);
  harness.w.close();
});

test('фотография загружается, отправляется без текста и повтор использует тот же clientMessageId', async () => {
  const posts = [];
  let failNext = true;
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [] }) }),
      'POST /content/project-chat/palitra-love/attachments': () => ({ body: { attachment: { id: 'a9', name: 'стена.jpg', mime: 'image/jpeg' } } }),
      'POST /content/project-chat/palitra-love/messages': (call) => {
        posts.push(JSON.parse(call.body));
        if (failNext) { failNext = false; return { status: 502, body: { error: 'Сервер недоступен' } }; }
        return { body: { ok: true } };
      }
    }
  });
  await mount(harness);
  const { d, w } = harness;
  const file = new w.File(['bytes'], 'стена.jpg', { type: 'image/jpeg' });
  const input = d.querySelector('[data-pc-upload]');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  const uploads = harness.calls.filter((call) => call.url.includes('/attachments'));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].headers['X-Filename'], encodeURIComponent('стена.jpg'));
  assert.equal(uploads[0].headers['Content-Type'], 'image/jpeg');
  assert.equal(uploads[0].body, file);
  assert.equal(d.querySelectorAll('.pc-pending-file').length, 1);

  harness.submit('[data-pc-compose]');
  await settle();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].attachmentIds, ['a9']);
  assert.equal(posts[0].text, '');
  assert.equal(d.querySelector('[data-pc-compose] [type="submit"]').textContent, 'Повторить отправку');
  assert.match(text(harness.dom, '[data-pc-notice]'), /не будет добавлено дважды/);

  harness.submit('[data-pc-compose]');
  await settle();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].clientMessageId, posts[0].clientMessageId);
  assert.deepEqual(posts[1].attachmentIds, ['a9']);
  assert.equal(d.querySelectorAll('.pc-pending-file').length, 0);
  assert.equal(d.querySelector('[data-pc-compose] [type="submit"]').textContent, 'Отправить');
  harness.w.close();
});

test('поздний ответ прежней компании не попадает в открытый чат другой компании', async () => {
  const gate = deferred();
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => gate.promise,
      'GET /content/project-chat/alvi': () => ({ body: snapshot({ messages: [message({ id: 'x1', text: 'Переписка АЛВИ' })] }) })
    }
  });
  const rendering = harness.views.hugh.render(harness.d.getElementById('hugh-view'), harness.ctx);
  await settle();
  harness.scope.company = 'alvi';
  gate.resolve({ body: snapshot({ messages: [message({ id: 'p1', text: 'Секретная смета Палитры' })] }) });
  await rendering;
  await settle();
  assert.doesNotMatch(harness.d.body.textContent, /Секретная смета Палитры/);
  assert.equal(harness.calls.filter((call) => call.url.includes('/alvi')).length, 0);
  harness.w.close();
});

test('переключение на личную вкладку во время загрузки файла сохраняет черновик и не ломает интерфейс', async () => {
  const gate = deferred();
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [] }) }),
      'POST /content/project-chat/palitra-love/attachments': () => gate.promise
    }
  });
  await mount(harness);
  const { d, w } = harness;
  d.querySelector('[data-pc-compose] textarea').value = 'Черновик для Дарьи';
  const input = d.querySelector('[data-pc-upload]');
  Object.defineProperty(input, 'files', { configurable: true, value: [new w.File(['bytes'], 'план.pdf', { type: 'application/pdf' })] });
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();

  harness.click('[data-pc-mode="private"]');
  await settle();
  assert.equal(d.querySelector('[data-pc-compose]'), null);
  gate.resolve({ body: { attachment: { id: 'a3', name: 'план.pdf', mime: 'application/pdf' } } });
  await settle();
  assert.doesNotMatch(text(harness.dom, '[data-pc-notice]'), /null|undefined|Cannot/);

  harness.click('[data-pc-mode="shared"]');
  await settle();
  assert.equal(d.querySelector('[data-pc-compose] textarea').value, 'Черновик для Дарьи');
  assert.equal(d.querySelectorAll('.pc-pending-file').length, 1);
  assert.match(text(harness.dom, '.pc-pending-file'), /план\.pdf/);
  assert.equal(d.querySelector('[data-pc-compose] [type="submit"]').disabled, false);
  harness.w.close();
});

test('отозванный доступ убирает прежнюю переписку, закрывает диалоги и блокирует композитор', async () => {
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [message({ text: 'Секретный бюджет 900 000' })], tasks: [{ id: 't1', title: 'Закупка красок', status: 'todo', assigneeId: 2, stageId: null }] }) }),
      'POST /content/project-chat/palitra-love/messages': () => ({ status: 403, body: { error: 'forbidden' } })
    }
  });
  await mount(harness);
  const { d } = harness;
  harness.click('[data-pc-new-task]');
  assert.equal(d.querySelectorAll('dialog').length, 1);
  d.querySelector('[data-pc-compose] textarea').value = 'Ещё вопрос';
  harness.submit('[data-pc-compose]');
  await settle();
  assert.doesNotMatch(d.body.textContent, /Секретный бюджет|Закупка красок/);
  assert.equal(d.querySelectorAll('dialog').length, 0);
  assert.equal(d.querySelector('[data-pc-compose]').hidden, true);
  assert.equal(d.querySelector('[data-pc-compose] textarea').disabled, true);
  assert.equal(d.querySelector('[data-pc-compose] textarea').value, '');
  assert.equal(d.querySelector('[data-pc-readonly]').hidden, false);
  assert.match(text(harness.dom, '[data-pc-notice]'), /Доступ к чату проекта не назначен/);
  assert.equal(d.querySelector('[data-pc-older]').hidden, true);
  harness.w.close();
});

test('более ранние сообщения подгружаются постранично и остаются после обновления снимка', async () => {
  const pages = [];
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [message({ id: 'm5', text: 'Пятое' }), message({ id: 'm6', text: 'Шестое' })], hasMore: true, oldestMessageId: 'm5' }) }),
      'GET /content/project-chat/palitra-love/messages': (call) => {
        pages.push(call.url);
        return { body: { messages: [message({ id: 'm3', text: 'Третье' }), message({ id: 'm4', text: 'Четвёртое' })], hasMore: false, oldestMessageId: 'm3' } };
      },
      'POST /content/project-chat/palitra-love/tasks': () => ({ body: { task: { id: 't1' } } })
    }
  });
  await mount(harness);
  const { d } = harness;
  assert.equal(d.querySelector('[data-pc-older]').hidden, false);
  harness.click('[data-pc-older]');
  await settle();
  assert.equal(pages.length, 1);
  assert.match(pages[0], /\/messages\?before=m5&limit=100$/);
  assert.deepEqual(ids(harness.dom), ['m3', 'm4', 'm5', 'm6']);
  assert.equal(d.querySelector('[data-pc-older]').hidden, true);

  harness.click('[data-pc-new-task]');
  d.querySelector('dialog [name="title"]').value = 'Проверка обновления';
  harness.submit('dialog form');
  await settle();
  assert.deepEqual(ids(harness.dom), ['m3', 'm4', 'm5', 'm6']);
  assert.equal(pages.length, 1);
  harness.w.close();
});

test('подгруженная история не теряет сообщение, выпавшее из окна нового снимка', async () => {
  let total = 200;
  let delivery = 'pending';
  const olderCalls = [];
  const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => {
    const number = from + index;
    return message({
      id: 'm' + number,
      text: 'Сообщение ' + number,
      createdAt: new Date(Date.UTC(2026, 8, 17, 0, 0, number)).toISOString(),
      deliveryStatus: number === 150 ? delivery : 'sent'
    });
  });
  const harness = boot({
    clock: true,
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({
        messages: range(total - 99, total), hasMore: true, oldestMessageId: 'm' + (total - 99)
      }) }),
      'GET /content/project-chat/palitra-love/messages': (call) => {
        const before = Number(new URL(call.url, ORIGIN).searchParams.get('before').slice(1));
        olderCalls.push(before);
        const start = Math.max(1, before - 100);
        return { body: { messages: range(start, before - 1), hasMore: start > 1, oldestMessageId: 'm' + start } };
      }
    }
  });
  await mount(harness);
  const { d } = harness;
  assert.equal(ids(harness.dom).length, 100);
  assert.equal(ids(harness.dom)[0], 'm101');
  assert.equal(d.querySelector('[data-pc-older]').hidden, false);

  harness.click('[data-pc-older]');
  await settle();
  assert.deepEqual(olderCalls, [101], 'страница запрашивается от самого старого известного сообщения');
  assert.equal(ids(harness.dom).length, 200);
  assert.equal(d.querySelector('[data-pc-older]').hidden, true);

  // Появилось новое сообщение: окно снимка сдвинулось и больше не содержит m101.
  total = 201;
  delivery = 'sent';
  await harness.clock.fire(5000);
  await settle();
  const shown = ids(harness.dom);
  assert.equal(shown.length, 201);
  assert.ok(shown.includes('m101'), 'сообщение, выпавшее из окна снимка, должно остаться в истории');
  assert.deepEqual(shown, Array.from({ length: 201 }, (_, index) => 'm' + (index + 1)));
  assert.equal(d.querySelectorAll('[data-message-id="m150"]').length, 1, 'обновление приходит по тому же ID');
  assert.match(d.querySelector('[data-message-id="m150"]').textContent, /Отправлено в Telegram/);
  assert.equal(d.querySelector('[data-pc-older]').hidden, true, 'снимок не должен возвращать признак «есть ещё старее»');
  assert.deepEqual(olderCalls, [101]);
  harness.w.close();
});

test('после сдвига окна снимка следующая страница берётся от самого старого известного сообщения', async () => {
  let total = 300;
  const olderCalls = [];
  const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => message({
    id: 'm' + (from + index), text: 'Сообщение ' + (from + index), createdAt: new Date(Date.UTC(2026, 8, 17, 0, 0, from + index)).toISOString()
  }));
  const harness = boot({
    clock: true,
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({
        messages: range(total - 99, total), hasMore: true, oldestMessageId: 'm' + (total - 99)
      }) }),
      'GET /content/project-chat/palitra-love/messages': (call) => {
        const before = Number(new URL(call.url, ORIGIN).searchParams.get('before').slice(1));
        olderCalls.push(before);
        const start = Math.max(1, before - 100);
        return { body: { messages: range(start, before - 1), hasMore: start > 1, oldestMessageId: 'm' + start } };
      }
    }
  });
  await mount(harness);
  const { d } = harness;
  harness.click('[data-pc-older]');
  await settle();
  assert.deepEqual(olderCalls, [201]);
  assert.equal(ids(harness.dom).length, 200);
  assert.equal(d.querySelector('[data-pc-older]').hidden, false, 'ещё есть более ранние страницы');

  total = 301;
  await harness.clock.fire(5000);
  await settle();
  assert.equal(ids(harness.dom).length, 201);
  assert.ok(ids(harness.dom).includes('m201'));
  assert.equal(d.querySelector('[data-pc-older]').hidden, false);

  harness.click('[data-pc-older]');
  await settle();
  assert.deepEqual(olderCalls, [201, 101], 'курсор следует за историей кабинета, а не за окном снимка');
  assert.deepEqual(ids(harness.dom), Array.from({ length: 301 }, (_, index) => 'm' + (index + 1)));
  assert.equal(d.querySelector('[data-pc-older]').hidden, true);
  harness.w.close();
});

test('незавершённая подгрузка прежней компании не возвращает кнопку в чат другой компании', async () => {
  const gate = deferred();
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [message({ id: 'p1', text: 'Смета Палитры' })], hasMore: true, oldestMessageId: 'p1' }) }),
      'GET /content/project-chat/palitra-love/messages': () => gate.promise,
      'GET /content/project-chat/alvi': () => ({ body: snapshot({ messages: [message({ id: 'a1', text: 'Переписка АЛВИ' })], hasMore: false, oldestMessageId: null }) })
    }
  });
  await mount(harness);
  const { d } = harness;
  assert.equal(d.querySelector('[data-pc-older]').hidden, false);
  harness.click('[data-pc-older]');
  await settle();

  harness.scope.company = 'alvi';
  await harness.views.hugh.onProjectChange(harness.ctx);
  await settle();
  assert.match(d.querySelector('[data-pc-messages]').textContent, /Переписка АЛВИ/);
  assert.equal(d.querySelector('[data-pc-older]').hidden, true);

  gate.resolve({ body: { messages: [message({ id: 'p0', text: 'Старая смета Палитры' })], hasMore: true, oldestMessageId: 'p0' } });
  await settle();
  assert.equal(d.querySelector('[data-pc-older]').hidden, true, 'кнопка прежней компании не должна возвращаться');
  assert.equal(d.querySelector('[data-pc-older]').disabled, false);
  assert.deepEqual(ids(harness.dom), ['a1']);
  assert.doesNotMatch(d.querySelector('[data-pc-messages]').textContent, /Палитр/);
  harness.w.close();
});

test('задача из сообщения хранит источник, исполнителя из этой комнаты и ограничение названия', async () => {
  const tasks = [];
  const long = 'Покрасить стену в переговорной '.repeat(20);
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({
        messages: [message({ id: 'm1', text: long })],
        stages: [{ id: 7, title: 'Подготовка' }]
      }) }),
      'POST /content/project-chat/palitra-love/tasks': (call) => { tasks.push(JSON.parse(call.body)); return { body: { task: { id: 't9' } } }; }
    }
  });
  await mount(harness);
  const { d } = harness;
  harness.click('[data-pc-message-task="m1"]');
  const dialog = d.querySelector('dialog');
  const title = dialog.querySelector('[name="title"]');
  assert.equal(title.maxLength, 200);
  assert.equal(title.value.length, 200);
  assert.deepEqual([...dialog.querySelectorAll('[name="assigneeId"] option')].map((option) => option.value), ['', '1', '2']);
  assert.deepEqual([...dialog.querySelectorAll('[name="stageId"] option')].map((option) => option.value), ['', '7']);
  dialog.querySelector('[name="assigneeId"]').value = '2';
  dialog.querySelector('[name="stageId"]').value = '7';
  dialog.querySelector('[name="due"]').value = '2026-10-01';
  dialog.querySelector('[name="status"]').value = 'in_progress';
  harness.submit('dialog form');
  await settle();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].sourceMessageId, 'm1');
  assert.equal(tasks[0].assigneeId, 2);
  assert.equal(tasks[0].stageId, 7);
  assert.equal(tasks[0].due, '2026-10-01');
  assert.equal(tasks[0].status, 'in_progress');
  assert.equal(tasks[0].title, title.value.trim());
  assert.ok(tasks[0].title.length <= 200 && tasks[0].title.length > 150);
  assert.equal(d.querySelectorAll('dialog[open]').length, 0);
  harness.w.close();
});

test('задача помнит исполнителя, вышедшего из проекта, и не даёт назначить другого бывшего', async () => {
  const saved = [];
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({
        messages: [],
        members: [member(1, 'Влад'), member(3, 'Анна')],
        formerMembers: [{ userId: 2, displayName: 'Дарья' }, { userId: 4, displayName: 'Игорь' }],
        stages: [{ id: 5, title: 'Покраска' }],
        tasks: [
          { id: 't1', title: 'Закупить краску', status: 'in_progress', assigneeId: 2, assigneeName: 'Дарья', assigneeActive: false, stageId: 5, due: '2026-09-25' },
          { id: 't2', title: 'Сдать переговорную', status: 'todo', assigneeId: 3, assigneeName: 'Анна', assigneeActive: true, stageId: 5, due: null }
        ]
      }) }),
      'PATCH /content/project-chat/palitra-love/tasks/t1': (call) => { saved.push(JSON.parse(call.body)); return { body: { task: { id: 't1' } } }; }
    }
  });
  await mount(harness);
  const { d } = harness;
  const rows = [...d.querySelectorAll('.pc-task')];
  assert.match(rows[0].textContent, /Дарья \(бывший участник\)/);
  assert.match(rows[1].textContent, /Анна/);
  assert.doesNotMatch(rows[1].textContent, /бывший участник/);
  assert.equal(d.querySelector('[data-pc-members]').textContent, 'Влад, Анна');

  harness.click('[data-pc-task="t1"]');
  const dialog = d.querySelector('dialog');
  const select = dialog.querySelector('[name="assigneeId"]');
  assert.deepEqual([...select.options].map((option) => option.value), ['', '1', '3', '2']);
  assert.equal(select.options[3].textContent, 'Дарья (бывший участник)');
  assert.equal(select.value, '2', 'исполнитель задачи должен остаться выбранным');
  assert.ok(![...select.options].some((option) => option.value === '4'), 'другой бывший участник не предлагается');

  // Подставленный вручную бывший участник не проходит: смена назначения на него запрещена.
  const rogue = d.createElement('option');
  rogue.value = '4';
  rogue.textContent = 'Игорь';
  select.append(rogue);
  select.value = '4';
  harness.submit('dialog form');
  await settle();
  assert.equal(saved.length, 0);
  assert.match(dialog.querySelector('[role="alert"]').textContent, /вышел из проекта/);

  // Правка другого поля сохраняет исторического исполнителя.
  select.value = '2';
  dialog.querySelector('[name="status"]').value = 'done';
  harness.submit('dialog form');
  await settle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].assigneeId, 2);
  assert.equal(saved[0].status, 'done');
  assert.equal(saved[0].stageId, 5);
  assert.equal(saved[0].due, '2026-09-25');
  harness.w.close();
});

test('новая задача предлагает только действующих участников', async () => {
  const saved = [];
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({
        messages: [message({ id: 'm1', text: 'Нужна помощь со стеной' })],
        members: [member(1, 'Влад'), member(3, 'Анна')],
        formerMembers: [{ userId: 2, displayName: 'Дарья' }],
        stages: [],
        tasks: []
      }) }),
      'POST /content/project-chat/palitra-love/tasks': (call) => { saved.push(JSON.parse(call.body)); return { body: { task: { id: 't9' } } }; }
    }
  });
  await mount(harness);
  const { d } = harness;
  harness.click('[data-pc-message-task="m1"]');
  const dialog = d.querySelector('dialog');
  assert.deepEqual([...dialog.querySelectorAll('[name="assigneeId"] option')].map((option) => option.value), ['', '1', '3']);
  dialog.querySelector('[name="assigneeId"]').value = '3';
  harness.submit('dialog form');
  await settle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].assigneeId, 3);
  assert.equal(saved[0].sourceMessageId, 'm1');
  harness.w.close();
});

test('владелец видит состояние подписки Codex без выдуманного подключения', async () => {
  let connected = false;
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [] }) }),
      'GET /content/project-chat-runtime/status': () => ({ body: connected
        ? { connected: true, authenticated: true, provider: 'codex', model: 'gpt-5-codex', state: 'connected' }
        : { connected: false, authenticated: false, provider: 'codex', state: 'login_required', loginUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' } }),
      'POST /content/project-chat-runtime/login': () => { connected = true; return { body: { connected: true, authenticated: true, provider: 'codex', model: 'gpt-5-codex', state: 'connected' } }; }
    }
  });
  await mount(harness);
  harness.click('[data-pc-settings]');
  await settle();
  const { d } = harness;
  const runtime = d.querySelector('[data-pc-runtime]');
  assert.doesNotMatch(runtime.textContent, /подключена к серверу/);
  assert.match(runtime.textContent, /Код: ABCD-1234/);
  assert.equal(runtime.querySelector('a').href, 'https://auth.openai.com/codex/device');
  harness.click('[data-pc-login]');
  await settle();
  assert.match(d.querySelector('[data-pc-runtime]').textContent, /Подписка Codex подключена к серверу\. Модель: gpt-5-codex\./);
  harness.w.close();
});

test('произвольная ссылка входа не предлагается вместо официальной страницы Codex', async () => {
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [] }) }),
      'GET /content/project-chat-runtime/status': () => ({ body: { connected: false, authenticated: false, provider: 'codex', state: 'login_required', loginUrl: 'https://login.example.test/device', userCode: 'WXYZ-9999' } })
    }
  });
  await mount(harness);
  harness.click('[data-pc-settings]');
  await settle();
  const runtime = harness.d.querySelector('[data-pc-runtime]');
  assert.equal(runtime.querySelector('a'), null);
  assert.doesNotMatch(runtime.innerHTML, /login\.example\.test/);
  // Без проверенной ссылки подтверждать нечем: код в одиночку никуда не ведёт и не показывается.
  assert.doesNotMatch(runtime.textContent, /WXYZ-9999/);
  assert.match(runtime.textContent, /Нажмите «Подключить подписку»/);
  harness.w.close();
});

test('до нажатия «Подключить подписку» владельцу не обещают ссылку и не просят открыть её вручную', async () => {
  let started = false;
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [] }) }),
      // Обычное состояние покоя рантайма: вход нужен, но код ещё не запрашивали.
      'GET /content/project-chat-runtime/status': () => ({ body: started
        ? { connected: false, authenticated: false, provider: 'codex', state: 'login_required', loginUrl: 'https://auth.openai.com/codex/device', userCode: 'QRST-5678' }
        : { connected: false, authenticated: false, provider: 'codex', state: 'login_required', loginUrl: null, userCode: null, error: 'Нужен вход в подписку ChatGPT' } }),
      'POST /content/project-chat-runtime/login': () => { started = true; return { body: { connected: false, authenticated: false, provider: 'codex', state: 'login_required', loginUrl: 'https://auth.openai.com/codex/device', userCode: 'QRST-5678' } }; }
    }
  });
  await mount(harness);
  harness.click('[data-pc-settings]');
  await settle();
  const { d } = harness;
  const idle = d.querySelector('[data-pc-runtime]');
  assert.equal(idle.querySelector('a'), null);
  assert.doesNotMatch(idle.textContent, /не передал|Откройте официальную страницу/);
  assert.match(idle.textContent, /Нажмите «Подключить подписку»/);

  // Ссылка и код появляются только вместе и только после запроса входа.
  harness.click('[data-pc-login]');
  await settle();
  const pending = d.querySelector('[data-pc-runtime]');
  assert.equal(pending.querySelector('a').href, 'https://auth.openai.com/codex/device');
  assert.match(pending.textContent, /Код: QRST-5678/);
  assert.match(pending.textContent, /Откройте официальную страницу входа Codex/);
  assert.equal(d.querySelector('[data-pc-login]').disabled, false);
  // Вход уходит POST только с кодом компании: ссылок и кодов клиент не придумывает.
  const loginCall = harness.calls.find((call) => call.url.includes('/project-chat-runtime/login'));
  assert.equal(loginCall.method, 'POST');
  assert.deepEqual(JSON.parse(loginCall.body), { companyCode: 'palitra-love' });
  // Проверка состояния тоже указывает компанию: сервер выбирает по ней локальный или серверный путь.
  const statusCall = harness.calls.find((call) => call.url.includes('/project-chat-runtime/status'));
  assert.equal(new harness.w.URL(statusCall.url, ORIGIN).searchParams.get('companyCode'), 'palitra-love');
  harness.w.close();
});

test('компания с локальным обработчиком: выключенный компьютер показывается честно, вопросы ждут', async () => {
  const harness = boot({
    routes: { 'GET /content/project-chat/palitra-love': () => ({ body: snapshot({
      room: { replyMode: 'delegate', telegramChatId: '' },
      ai: { configured: true, connected: false, runtimeState: 'offline', local: true, offline: true, lastSeen: '2026-09-17T08:00:00.000Z', queued: 1, waiting: 0, failed: 0,
        waitingReason: 'Компьютер Хью сейчас не на связи: ответ отправится после его возвращения' },
      messages: [message({ id: 'm1', text: 'Хью, посчитай смету', aiStatus: 'pending' })]
    }) }),
      'GET /content/project-chat-runtime/status': () => ({ body: { configured: true, local: true, offline: true, lastSeen: '2026-09-17T08:00:00.000Z',
        connected: false, authenticated: false, state: 'offline', provider: 'codex', model: '', loginPending: false, loginUrl: '', userCode: '',
        error: 'Компьютер Хью не на связи' } }) }
  });
  await mount(harness);
  const summary = text(harness.dom, '[data-pc-ai]');
  assert.match(summary, /Компьютер Хью сейчас не на связи/);
  assert.match(summary, /Ожидают ответа: 1/);
  assert.doesNotMatch(summary, /заменяет Влада|не подключены|недоступен/);
  assert.match(harness.d.body.textContent, /когда его компьютер снова будет на связи/);
  assert.doesNotMatch(harness.d.body.textContent, /Хью готовит ответ|после подключения подписки/);
  assert.equal(harness.d.querySelector('[data-pc-retry-ai]').hidden, true);
  assert.equal(harness.d.querySelector('[data-pc-compose]').hidden, false);
  harness.click('[data-pc-settings]');
  await settle();
  const runtime = harness.d.querySelector('[data-pc-runtime]');
  assert.match(runtime.textContent, /Компьютер Хью сейчас не на связи\. Последний сигнал: /);
  assert.match(runtime.textContent, /вопросы к Хью ждут/);
  // Выключенный компьютер — не сломанный вход: подключать подписку заново не просим.
  assert.doesNotMatch(runtime.textContent, /Нажмите «Подключить подписку»/);
  assert.equal(runtime.querySelector('a'), null);
  harness.w.close();
});

test('вход на компьютере Хью: команда принимается 202, кабинет опрашивает состояние и показывает код, когда он пришёл', async () => {
  const statusCalls = [];
  let phase = 'idle';
  const status = () => {
    statusCalls.push(phase);
    if (phase === 'idle') return { local: true, configured: true, state: 'login_required', connected: false, authenticated: false, offline: false, loginPending: false, loginUrl: '', userCode: '', error: 'Нужен вход владельца в подписку на компьютере Хью' };
    if (phase === 'pending') return { local: true, configured: true, state: 'login_pending', connected: false, authenticated: false, offline: false, loginPending: true, loginUrl: '', userCode: '', error: 'Команда входа передана компьютеру Хью, ждём ссылку и код' };
    return { local: true, configured: true, state: 'login_required', connected: false, authenticated: false, offline: false, loginPending: false, loginUrl: 'https://auth.openai.com/codex/device', userCode: 'QRST-5678', expiresAt: '2026-09-17T09:15:00.000Z', error: 'Подтвердите вход по коду на официальной странице Codex' };
  };
  const harness = boot({
    clock: true,
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [], ai: { configured: true, connected: false, runtimeState: 'login_required', local: true, offline: false, queued: 0, failed: 0 } }) }),
      'GET /content/project-chat-runtime/status': () => ({ body: status() }),
      // Сервер команду сохранил, но ответ на POST до кабинета не дошёл: команда от этого не исчезла.
      'POST /content/project-chat-runtime/login': (call) => { assert.deepEqual(JSON.parse(call.body), { companyCode: 'palitra-love' }); phase = 'pending'; return new Error('соединение оборвалось'); }
    }
  });
  await mount(harness);
  harness.click('[data-pc-settings]');
  await settle();
  const { d } = harness;
  assert.match(d.querySelector('[data-pc-runtime]').textContent, /Подписка Codex на компьютере Хью пока не подключена/);
  assert.match(d.querySelector('[data-pc-runtime]').textContent, /команда уйдёт на компьютер Хью/);
  assert.equal(harness.clock.pending().filter((delay) => delay === 3000).length, 0, 'в покое опроса входа нет');

  harness.click('[data-pc-login]');
  await settle();
  assert.match(d.querySelector('[data-pc-runtime]').textContent, /Запрос входа передан компьютеру Хью/);
  assert.doesNotMatch(d.querySelector('[data-pc-runtime]').textContent, /Подключение не начато/, 'потерянный ответ не выдаётся за отсутствие команды');
  assert.equal(d.querySelector('[data-pc-runtime] a'), null);
  assert.equal(d.querySelector('[data-pc-login]').disabled, false);
  assert.deepEqual(harness.clock.pending().filter((delay) => delay === 3000), [3000], 'после 202 запланирован опрос входа');

  // Компьютер ещё не ответил: опрос продолжается, кнопки не блокируются.
  await harness.clock.fire(3000);
  await settle();
  assert.match(d.querySelector('[data-pc-runtime]').textContent, /Запрос входа передан/);
  assert.deepEqual(harness.clock.pending().filter((delay) => delay === 3000), [3000]);
  assert.equal(d.querySelector('[data-pc-runtime-check]').disabled, false);

  // Код пришёл: показываем официальную ссылку и код, опрос останавливается.
  phase = 'code';
  await harness.clock.fire(3000);
  await settle();
  const runtime = d.querySelector('[data-pc-runtime]');
  assert.equal(runtime.querySelector('a').href, 'https://auth.openai.com/codex/device');
  assert.match(runtime.textContent, /Код: QRST-5678/);
  assert.match(runtime.textContent, /Код действует до/);
  assert.deepEqual(harness.clock.pending().filter((delay) => delay === 3000), [], 'после кода опрос не планируется');
  assert.deepEqual(statusCalls, ['idle', 'pending', 'pending', 'code']);
  // Обычный опрос переписки при этом не пострадал.
  assert.ok(harness.clock.pending().includes(5000));
  harness.w.close();
});

test('закрытие настроек и отозванная сессия останавливают опрос входа и убирают код', async () => {
  let phase = 'pending';
  const base = { local: true, configured: true, connected: false, authenticated: false, offline: false };
  const status = () => (phase === 'gone' ? { status: 401, body: { error: 'Требуется вход в кабинет' } }
    : phase === 'pending' ? { body: { ...base, state: 'login_pending', loginPending: true, loginUrl: '', userCode: '' } }
      : { body: { ...base, state: 'login_required', loginPending: false, loginUrl: 'https://auth.openai.com/codex/device', userCode: 'QRST-5678' } });
  const harness = boot({
    clock: true,
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [message({ text: 'Секретная смета' })], ai: { configured: true, connected: false, runtimeState: 'login_pending', local: true, offline: false, queued: 0, failed: 0 } }) }),
      'GET /content/project-chat-runtime/status': () => status()
    }
  });
  await mount(harness);
  assert.match(text(harness.dom, '[data-pc-ai]'), /ждёт, пока владелец подтвердит вход/);
  // Пока команда только ожидает, опрос идёт и без нажатия; закрытие диалога его снимает.
  harness.click('[data-pc-settings]');
  await settle();
  assert.deepEqual(harness.clock.pending().filter((delay) => delay === 3000), [3000], 'ожидающая команда входа опрашивается');
  harness.click('dialog [data-pc-close]');
  await settle();
  assert.equal(harness.d.querySelector('dialog'), null);
  assert.deepEqual(harness.clock.pending().filter((delay) => delay === 3000), [], 'закрытый диалог не опрашивает вход');
  assert.ok(harness.clock.pending().includes(5000));

  // Сессия отозвана во время опроса: код и диалог исчезают, опрос и комната закрываются.
  phase = 'code';
  harness.click('[data-pc-settings]');
  await settle();
  assert.match(harness.d.querySelector('[data-pc-runtime]').textContent, /Код: QRST-5678/);
  phase = 'pending';
  harness.click('[data-pc-runtime-check]');
  await settle();
  assert.deepEqual(harness.clock.pending().filter((delay) => delay === 3000), [3000]);
  phase = 'gone';
  await harness.clock.fire(3000);
  await settle();
  assert.equal(harness.d.querySelector('dialog'), null, 'диалог с кодом закрыт');
  assert.doesNotMatch(harness.d.body.textContent, /QRST-5678|Секретная смета/);
  assert.deepEqual(harness.clock.pending().filter((delay) => delay === 3000), [], 'опрос входа остановлен');
  assert.match(text(harness.dom, '[data-pc-notice]'), /Сессия завершена/);
  assert.equal(harness.d.querySelector('[data-pc-compose]').hidden, true);
  harness.w.close();
});

test('запрос входа без ответа сервера: причина названа неизвестной, а не «временным сбоем сети»', async () => {
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [] }) }),
      'GET /content/project-chat-runtime/status': () => ({ body: { connected: false, authenticated: false, provider: 'codex', state: 'login_required', loginUrl: null, userCode: null } }),
      'POST /content/project-chat-runtime/login': () => new Error('соединение оборвалось')
    }
  });
  await mount(harness);
  harness.click('[data-pc-settings]');
  await settle();
  const { d } = harness;
  harness.click('[data-pc-login]');
  await settle();
  const runtime = d.querySelector('[data-pc-runtime]');
  assert.match(runtime.textContent, /Подключение не начато/);
  assert.match(runtime.textContent, /причина неизвестна/);
  assert.match(runtime.textContent, /Повторите попытку/);
  // Ни догадки про временный сбой, ни «региона», ни сырого текста ошибки браузера.
  assert.doesNotMatch(runtime.textContent, /временн|регион|страна|VPN|соединение оборвалось/i);
  assert.equal(runtime.querySelector('a'), null);
  // Кнопки возвращаются в рабочее состояние: повтор возможен без переоткрытия настроек.
  assert.equal(d.querySelector('[data-pc-login]').disabled, false);
  assert.equal(d.querySelector('[data-pc-runtime-check]').disabled, false);
  harness.w.close();
});

test('названная сервером причина входа показывается как есть и не подменяется догадкой', async () => {
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [] }) }),
      'GET /content/project-chat-runtime/status': () => ({ body: { connected: false, authenticated: false, provider: 'codex', state: 'login_required', loginUrl: null, userCode: null } }),
      // Так отвечает прокси, когда рантайм не смог начать вход: свой код ответа 503,
      // а причина — отдельным нейтральным пояснением (может называть код сервиса входа).
      'POST /content/project-chat-runtime/login': () => ({ status: 503,
        body: { connected: false, authenticated: false, configured: true, provider: 'codex', state: 'unknown', error: 'Сервис входа ответил кодом 503' } })
    }
  });
  await mount(harness);
  harness.click('[data-pc-settings]');
  await settle();
  const { d } = harness;
  harness.click('[data-pc-login]');
  await settle();
  const runtime = d.querySelector('[data-pc-runtime]');
  assert.equal(runtime.textContent, 'Подключение не начато. Сервис входа ответил кодом 503. Повторите попытку.');
  assert.doesNotMatch(runtime.textContent, /временн|регион|страна|VPN/i);
  assert.equal(d.querySelector('[data-pc-login]').disabled, false);
  harness.w.close();
});

test('исчерпанная квота подписки не выдаётся в настройках за готовность к ответам', async () => {
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [] }) }),
      // Так отвечает рантайм при лимите: вход не тронут, но состояние уже не connected.
      'GET /content/project-chat-runtime/status': () => ({ body: { connected: true, authenticated: true, provider: 'codex', model: 'gpt-5-codex', state: 'unavailable', error: 'Лимит подписки исчерпан, ответ будет позже' } })
    }
  });
  await mount(harness);
  harness.click('[data-pc-settings]');
  await settle();
  const runtime = harness.d.querySelector('[data-pc-runtime]');
  assert.doesNotMatch(runtime.textContent, /Подписка Codex подключена к серверу/);
  assert.match(runtime.textContent, /ответы сейчас недоступны/);
  assert.match(runtime.textContent, /Лимит подписки исчерпан, ответ будет позже/);
  // Вход не сломан: повторно подключать подписку не предлагаем.
  assert.equal(runtime.querySelector('a'), null);
  assert.doesNotMatch(runtime.textContent, /Нажмите «Подключить подписку»/);
  harness.w.close();
});

test('снимок, пришедший после перехода на личную вкладку, не рисуется в исчезнувшем общем чате', async () => {
  const gate = deferred();
  const harness = boot({ routes: { 'GET /content/project-chat/palitra-love': () => gate.promise } });
  const rendering = harness.views.hugh.render(harness.d.getElementById('hugh-view'), harness.ctx);
  await settle(); // Разрешение общей комнаты завершено, снимок ещё ожидается.
  harness.click('[data-pc-mode="private"]');
  await settle();
  gate.resolve({ body: snapshot({ messages: [message({ text: 'Поздний снимок общего чата' })] }) });
  await rendering;
  await settle();
  assert.match(harness.d.body.textContent, /Личная переписка/);
  assert.doesNotMatch(harness.d.body.textContent, /Поздний снимок общего чата/);
  assert.equal(harness.d.querySelector('[data-pc-messages]'), null);
  assert.equal(harness.d.querySelector('[data-pc-mode="private"]').getAttribute('aria-pressed'), 'true');
  harness.w.close();
});

test('опрос, завершившийся на личной вкладке, не пишет в общий чат ни при успехе, ни при ошибке', async () => {
  const gates = [];
  const harness = boot({
    clock: true,
    routes: { 'GET /content/project-chat/palitra-love': () => { const gate = deferred(); gates.push(gate); return gate.promise; } }
  });
  const { d } = harness;
  const rendering = harness.views.hugh.render(d.getElementById('hugh-view'), harness.ctx);
  await settle();
  gates[0].resolve({ body: snapshot({ messages: [message({ id: 'm1', text: 'Первый снимок' })] }) });
  await rendering;
  await settle();
  assert.match(d.body.textContent, /Первый снимок/);
  assert.equal(d.hidden, false);
  assert.equal(gates.length, 1);
  assert.deepEqual(harness.clock.pending(), [5000], 'после показа комнаты должен быть запланирован опрос');

  // Успешная ветка: опрос уже ушёл в сеть, когда пользователь открыл личную вкладку.
  const successfulPoll = harness.clock.fire(5000);
  await settle();
  assert.equal(gates.length, 2, 'видимая вкладка должна выполнить запрос опроса');
  harness.click('[data-pc-mode="private"]');
  await settle();
  gates[1].resolve({ body: snapshot({ messages: [message({ id: 'm2', text: 'Поздний ответ опроса' })] }) });
  await successfulPoll;
  await settle();
  assert.match(d.body.textContent, /Личная переписка/);
  assert.doesNotMatch(d.body.textContent, /Поздний ответ опроса/);
  assert.equal(d.querySelector('[data-pc-sync]'), null);
  assert.deepEqual(harness.clock.pending(), [], 'опрос на личной вкладке не должен планировать себя заново');

  harness.click('[data-pc-mode="shared"]');
  await settle();
  gates[2].resolve({ body: snapshot({ messages: [message({ id: 'm3', text: 'Снимок после возврата' })] }) });
  await settle();
  assert.match(d.body.textContent, /Снимок после возврата/);
  assert.deepEqual(harness.clock.pending(), [5000]);

  // Ветка ошибки: тот же переход, но запрос опроса завершается сбоем сервера.
  const failingPoll = harness.clock.fire(5000);
  await settle();
  assert.equal(gates.length, 4);
  harness.click('[data-pc-mode="private"]');
  await settle();
  gates[3].resolve({ status: 500, body: { error: 'Сервер недоступен' } });
  await failingPoll;
  await settle();
  assert.match(d.body.textContent, /Личная переписка/);
  assert.doesNotMatch(d.body.textContent, /Сервер недоступен|Не удалось обновить переписку/);
  assert.deepEqual(harness.clock.pending(), [], 'сбой опроса на личной вкладке не должен возобновлять цикл');

  harness.click('[data-pc-mode="shared"]');
  await settle();
  gates[4].resolve({ body: snapshot({ messages: [message({ id: 'm4', text: 'Общий чат снова работает' })] }) });
  await settle();
  assert.match(d.querySelector('[data-pc-messages]').textContent, /Общий чат снова работает/);
  harness.w.close();
});

test('недоступный сервис ответов показывается честно и не блокирует переписку', async () => {
  const harness = boot({
    routes: {
      'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [message({ text: 'Работаем' })], ai: { configured: true, connected: false, runtimeState: 'unavailable', queued: 0, failed: 0 } }) }),
      'GET /content/project-chat-runtime/status': () => ({ body: { connected: false, authenticated: false, provider: 'codex', state: 'unavailable', error: 'Сервис не отвечает' } })
    }
  });
  await mount(harness);
  assert.match(text(harness.dom, '[data-pc-ai]'), /Сервис ответов Хью сейчас недоступен\. Переписка, файлы и задачи проекта работают\./);
  assert.equal(harness.d.querySelector('[data-pc-compose]').hidden, false);
  harness.click('[data-pc-settings]');
  await settle();
  const runtime = harness.d.querySelector('[data-pc-runtime]');
  assert.match(runtime.textContent, /Сервис ответов Хью сейчас недоступен/);
  assert.equal(runtime.querySelector('a'), null);
  harness.w.close();
});

test('карточка задачи: ссылка вне кнопки, дата проверки показывается днём и не теряет время', async () => {
  const task = { id: 7, externalRef: 'А8', title: 'Фото вылезает на ПК', status: 'done', kind: 'client_remark',
    site: 'palitra-love', siteLabel: 'Палитра', siteStatus: 'known', publication: 'published',
    publicationLabel: 'Опубликовано и проверено на сайте', publishedUrl: 'https://example.test/a8',
    verifiedAt: '2026-09-18T12:30:00Z', sourceQuote: '', notes: [], fixedOnSite: true, cancelled: false,
    assigneeId: null, stageId: null, due: '' };
  // clock: true — опрос переписки идёт на управляемых таймерах, иначе реальный таймер держит процесс.
  const harness = boot({ clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ tasks: [task] }) }),
    'PATCH /content/project-chat/palitra-love/tasks/7': (call) => ({ body: { task: { ...task, ...JSON.parse(call.body) } } })
  } });
  await mount(harness);
  const { d } = harness;

  // Ссылка не должна быть внутри кнопки: вложенные интерактивные элементы ломают клик и доступность.
  const link = d.querySelector('.pc-task-link a');
  assert.ok(link, 'ссылка на страницу показана');
  assert.equal(link.closest('button'), null, 'ссылка вынесена за пределы кнопки задачи');
  assert.equal(d.querySelectorAll('[data-pc-task] a').length, 0, 'внутри кнопки ссылок нет');
  assert.match(d.querySelector('.pc-task-link').textContent, /проверено 2026-09-18/);

  // В диалоге дата показывается днём — иначе input type="date" молча очистил бы её.
  harness.click('[data-pc-task="7"]');
  await settle();
  const form = d.querySelector('.pc-dialog form');
  assert.equal(form.elements.verifiedAt.value, '2026-09-18');
  assert.equal(form.elements.verifiedAtFull.value, '2026-09-18T12:30:00Z');

  // День не меняли — уходит исходное значение целиком, время не потеряно.
  harness.submit('.pc-dialog form');
  await settle();
  const saved = harness.calls.find((call) => call.method === 'PATCH');
  assert.equal(JSON.parse(saved.body).verifiedAt, '2026-09-18T12:30:00Z');
});

test('импорт реестра: только владельцу, ошибки файла названы, результат показан, второго реестра нет', async () => {
  const registry = { schemaVersion: 1, asOf: '2026-09-18', tasks: [{ externalRef: 'А8', title: 'Фото вылезает на ПК' }] };
  const harness = boot({ clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot() }),
    'POST /content/project-chat/palitra-love/tasks/import': () => ({ body: { imported: 1, skipped: 1,
      results: [{ externalRef: 'А8', skipped: false }, { externalRef: 'А9', skipped: true, reason: 'изменено в кабинете позже снимка реестра' }],
      tasks: [] } })
  } });
  await mount(harness);
  const { d, w } = harness;
  const button = d.querySelector('[data-pc-import]');
  assert.ok(button, 'кнопка импорта есть у владельца');
  assert.equal(button.hidden, false);

  harness.click('[data-pc-import]');
  await settle();
  const form = d.querySelector('.pc-dialog form');
  assert.ok(form.elements.registry, 'в диалоге есть выбор файла');

  // Не JSON — понятная ошибка, запроса на сервер нет.
  const file = (text) => ({ text: async () => text });
  Object.defineProperty(form.elements.registry, 'files', { configurable: true, get: () => [file('не json')] });
  harness.submit('.pc-dialog form');
  await settle();
  assert.match(d.querySelector('.pc-dialog [role="alert"]').textContent, /не JSON/i);
  assert.equal(harness.calls.filter((call) => call.url.includes('/tasks/import')).length, 0);

  // Объект без задач тоже отклоняется до отправки.
  Object.defineProperty(form.elements.registry, 'files', { configurable: true, get: () => [file(JSON.stringify({ schemaVersion: 1, tasks: [] }))] });
  harness.submit('.pc-dialog form');
  await settle();
  assert.match(d.querySelector('.pc-dialog [role="alert"]').textContent, /нет списка задач/i);
  assert.equal(harness.calls.filter((call) => call.url.includes('/tasks/import')).length, 0);

  // Правильный файл уходит одним запросом, результат показан владельцу.
  Object.defineProperty(form.elements.registry, 'files', { configurable: true, get: () => [file(JSON.stringify(registry))] });
  harness.submit('.pc-dialog form');
  await settle();
  const sent = harness.calls.filter((call) => call.url.includes('/tasks/import'));
  assert.equal(sent.length, 1, 'ровно один запрос импорта, второго реестра не заводим');
  assert.equal(JSON.parse(sent[0].body).force, false, 'без отметки перезапись не запрашивается');
  assert.match(text(harness.dom, '[data-pc-notice]'), /обновлено 1, пропущено 1/);
  assert.match(text(harness.dom, '[data-pc-notice]'), /изменено в кабинете позже снимка/);
  // Сообщений в переписку импорт не добавляет: в Telegram при импорте ничего не уходит.
  assert.equal(harness.calls.filter((call) => call.url.includes('/messages') && call.method === 'POST').length, 0);
  void w;
});

test('импорт и выбор сайтов доступны только владельцу', async () => {
  const harness = boot({ role: 'member', clock: true, permissions: ['chat.view', 'chat.reply'], routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ access: { canReply: true, owner: false } }) })
  } });
  await mount(harness);
  const { d } = harness;
  assert.equal(d.querySelector('[data-pc-import]').hidden, true, 'участнику кнопка импорта не показана');
  assert.equal(d.querySelector('[data-pc-settings]').hidden, true);
  // Прямой вызов из кода тоже ничего не открывает: проверка права внутри обработчика.
  harness.click('[data-pc-import]');
  await settle();
  assert.equal(d.querySelector('.pc-dialog'), null, 'диалог импорта участнику не открывается');
});

test('настройки владельца: список обслуживаемых сайтов сохраняется', async () => {
  const harness = boot({ clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ room: { replyMode: 'addressed', telegramChatId: '-100', sites: [] } }) }),
    'PATCH /content/project-chat/palitra-love/settings': () => ({ body: { ok: true } }),
    'GET /content/project-chat-runtime/status': () => ({ body: { configured: true, connected: true, state: 'connected' } })
  } });
  await mount(harness);
  const { d } = harness;
  harness.click('[data-pc-settings]');
  await settle();
  const box = d.querySelector('[data-pc-site][value="alvi"]');
  assert.ok(box, 'в настройках есть выбор второго сайта');
  assert.equal(d.querySelector('[data-pc-site][value="palitra-love"]'), null, 'свой проект в списке не дублируется');
  box.checked = true;
  harness.submit('.pc-dialog form');
  await settle();
  const saved = harness.calls.find((call) => call.method === 'PATCH' && call.url.includes('/settings'));
  assert.deepEqual(JSON.parse(saved.body).sites, ['alvi']);
  // Диалог закрываем: опрос состояния Хью живёт не дольше окна и не должен держать процесс.
  const close = d.querySelector('.pc-dialog [data-pc-close]');
  if (close) close.dispatchEvent(new harness.w.Event('click', { bubbles: true }));
  harness.views.hugh.stop?.();
  await settle();
});

test('импорт: force из файла не подменяет решение владельца', async () => {
  // В файле стоит force: true, галочка снята — перезапись правок кабинета запрашиваться не должна.
  const registry = { schemaVersion: 1, asOf: '2026-09-18', force: true,
    tasks: [{ externalRef: 'А8', title: 'Фото вылезает на ПК' }] };
  const harness = boot({ clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot() }),
    'POST /content/project-chat/palitra-love/tasks/import': () => ({ body: { imported: 1, skipped: 0, results: [], tasks: [] } })
  } });
  await mount(harness);
  const { d } = harness;
  harness.click('[data-pc-import]');
  await settle();
  const form = d.querySelector('.pc-dialog form');
  const file = (text) => ({ text: async () => text });
  Object.defineProperty(form.elements.registry, 'files', { configurable: true, get: () => [file(JSON.stringify(registry))] });

  assert.equal(form.elements.force.checked, false, 'по умолчанию перезапись не запрошена');
  harness.submit('.pc-dialog form');
  await settle();
  const first = harness.calls.filter((call) => call.url.includes('/tasks/import'));
  assert.equal(first.length, 1);
  assert.equal(JSON.parse(first[0].body).force, false, 'force из файла не действует без отметки владельца');

  // С отметкой владельца force уходит осознанно.
  harness.click('[data-pc-import]');
  await settle();
  const second = d.querySelector('.pc-dialog form');
  Object.defineProperty(second.elements.registry, 'files', { configurable: true, get: () => [file(JSON.stringify({ ...registry, force: false }))] });
  second.elements.force.checked = true;
  harness.submit('.pc-dialog form');
  await settle();
  const sent = harness.calls.filter((call) => call.url.includes('/tasks/import'));
  assert.equal(sent.length, 2);
  assert.equal(JSON.parse(sent[1].body).force, true, 'отметка владельца включает перезапись даже при force:false в файле');
});

test('планирование: кнопка рядом с отправкой, срок уходит с поясом, черновик очищается', async () => {
  const harness = boot({ clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot() }),
    'POST /content/project-chat/palitra-love/scheduled': () => ({ status: 201, body: { item: { id: 5 } } })
  } });
  await mount(harness);
  const { d } = harness;
  const button = d.querySelector('[data-pc-schedule]');
  assert.ok(button, 'кнопка «Запланировать» есть рядом с «Отправить»');
  assert.equal(button.hidden, false);
  assert.ok(d.querySelector('[data-pc-compose] [data-pc-schedule]'), 'кнопка внутри формы отправки');

  // Черновик из поля ввода попадает в диалог.
  d.querySelector('[data-pc-compose]').elements.text.value = 'Сводка по правкам';
  harness.click('[data-pc-schedule]');
  await settle();
  const form = d.querySelector('.pc-dialog form');
  assert.equal(form.elements.text.value, 'Сводка по правкам');
  assert.ok(form.elements.timezone, 'часовой пояс задаётся явно');
  assert.ok([...form.elements.timezone.options].some((option) => option.value === 'Asia/Irkutsk'));

  form.elements.date.value = '2026-09-19';
  form.elements.time.value = '09:00';
  form.elements.timezone.value = 'Asia/Irkutsk';
  harness.submit('.pc-dialog form');
  await settle();
  const sent = harness.calls.find((call) => call.url.includes('/scheduled') && call.method === 'POST');
  assert.ok(sent, 'запрос ушёл');
  const body = JSON.parse(sent.body);
  assert.equal(body.dueAtLocal, '2026-09-19T09:00');
  assert.equal(body.timezone, 'Asia/Irkutsk');
  assert.equal(body.text, 'Сводка по правкам');
  assert.equal(typeof body.clientId, 'string');
  assert.match(body.clientId, /^plan-[\w-]{8,}$/, 'ключ повтора запроса передан');
  assert.equal(d.querySelector('[data-pc-compose]').elements.text.value, '', 'черновик не остаётся вторым экземпляром');
});

test('планирование: список показывает срок, пояс и состояние доставки, отмена доступна только ожидающему', async () => {
  const scheduled = [
    { id: 1, kind: 'message', text: 'Утренняя сводка', dueAt: '2026-09-19T01:00:00.000Z', timezone: 'Asia/Irkutsk',
      status: 'pending', deliveryStatus: '', error: '', taskId: null, authorId: 1, canManage: true },
    { id: 2, kind: 'task_reminder', text: 'Проверить правку', dueAt: '2026-09-18T01:00:00.000Z', timezone: 'Asia/Irkutsk',
      status: 'sent', deliveryStatus: 'uncertain', error: '', taskId: 7, authorId: 1, canManage: false },
    { id: 3, kind: 'message', text: 'Старое', dueAt: '2026-09-10T01:00:00.000Z', timezone: 'Asia/Irkutsk',
      status: 'expired', deliveryStatus: '', error: 'Срок прошёл, пока сервер был недоступен: сообщение не отправлено', taskId: null, authorId: 1, canManage: false }
  ];
  const harness = boot({ clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ scheduled }) }),
    'PATCH /content/project-chat/palitra-love/scheduled/1': () => ({ body: { item: { id: 1, status: 'cancelled' } } })
  } });
  await mount(harness);
  const { d } = harness;
  const items = [...d.querySelectorAll('.pc-scheduled-item')];
  assert.equal(items.length, 3);
  assert.match(items[0].textContent, /19\.09\.2026, 09:00/, 'срок показан в поясе владельца');
  assert.match(items[0].textContent, /Asia\/Irkutsk/);
  assert.match(items[0].textContent, /Ожидает отправки/);
  // Отправленное в ЛК не выдаётся за доставленное в Telegram.
  assert.match(items[1].textContent, /Отправлено · доставка уточняется/);
  assert.match(items[1].textContent, /Напоминание по задаче/);
  assert.match(items[2].textContent, /Срок прошёл, не отправлено/);

  assert.ok(items[0].querySelector('[data-pc-schedule-cancel="1"]'), 'ожидающее можно отменить');
  assert.equal(items[1].querySelector('[data-pc-schedule-cancel]'), null, 'отправленное не отменяется');
  assert.equal(items[2].querySelector('[data-pc-schedule-edit]'), null, 'просроченное не редактируется');

  harness.click('[data-pc-schedule-cancel="1"]');
  await settle();
  const cancel = harness.calls.find((call) => call.method === 'PATCH' && call.url.includes('/scheduled/1'));
  assert.ok(cancel);
  assert.deepEqual(JSON.parse(cancel.body), { status: 'cancelled' });
});

test('планирование недоступно без права ответа', async () => {
  const harness = boot({ role: 'member', clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ access: { canReply: false, owner: false },
      scheduled: [{ id: 1, kind: 'message', text: 'Сводка', dueAt: '2026-09-19T01:00:00.000Z', timezone: 'Asia/Irkutsk',
        status: 'pending', deliveryStatus: '', error: '', taskId: null, authorId: 2, canManage: false }] }) })
  } });
  await mount(harness);
  const { d } = harness;
  assert.equal(d.querySelector('[data-pc-schedule]').hidden, true, 'без права ответа кнопки нет');
  assert.equal(d.querySelector('[data-pc-schedule-cancel]'), null, 'и отменить чужое нельзя');
  harness.click('[data-pc-schedule]');
  await settle();
  assert.equal(d.querySelector('.pc-dialog'), null, 'диалог не открывается');
});

test('напоминание по задаче: кнопка у задачи открывает планирование и уходит kind с taskId', async () => {
  const task = { id: 7, externalRef: 'А8', title: 'Фото вылезает на ПК', status: 'done', kind: 'client_remark',
    site: 'palitra-love', siteLabel: 'Палитра', siteStatus: 'known', publication: 'prepared',
    publicationLabel: 'Готово, на сайте ещё нет', publishedUrl: '', verifiedAt: '', sourceQuote: '',
    notes: [], fixedOnSite: false, cancelled: false, assigneeId: null, stageId: null, due: '' };
  const harness = boot({ clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ tasks: [task] }) }),
    'POST /content/project-chat/palitra-love/scheduled': () => ({ status: 201, body: { item: { id: 9 } } })
  } });
  await mount(harness);
  const { d } = harness;
  const remind = d.querySelector('[data-pc-task-remind="7"]');
  assert.ok(remind, 'у задачи есть кнопка «Напомнить»');
  assert.equal(remind.closest('[data-pc-task]'), null, 'кнопка не вложена в кнопку задачи');

  harness.click('[data-pc-task-remind="7"]');
  await settle();
  const form = d.querySelector('.pc-dialog form');
  assert.ok(form, 'открылся диалог планирования');
  assert.match(d.querySelector('.pc-dialog').textContent, /Фото вылезает на ПК/, 'видно, о какой задаче речь');
  form.elements.text.value = 'Проверить, что правка на сайте';
  form.elements.date.value = '2026-09-19';
  form.elements.time.value = '09:00';
  form.elements.timezone.value = 'Asia/Irkutsk';
  harness.submit('.pc-dialog form');
  await settle();

  const sent = harness.calls.find((call) => call.method === 'POST' && call.url.includes('/scheduled'));
  assert.ok(sent, 'запрос ушёл');
  const body = JSON.parse(sent.body);
  assert.equal(body.kind, 'task_reminder');
  assert.equal(body.taskId, 7);
  assert.equal(body.dueAtLocal, '2026-09-19T09:00');
  assert.equal(body.timezone, 'Asia/Irkutsk');
  assert.equal(body.text, 'Проверить, что правка на сайте');
});

test('чужую отложенную отправку кабинет не предлагает трогать', async () => {
  const mine = { id: 1, kind: 'message', text: 'Моя сводка', dueAt: '2026-09-19T01:00:00.000Z', timezone: 'Asia/Irkutsk',
    status: 'pending', deliveryStatus: '', error: '', taskId: null, authorId: 1, canManage: true };
  const foreign = { id: 2, kind: 'message', text: 'Сводка коллеги', dueAt: '2026-09-19T02:00:00.000Z', timezone: 'Asia/Irkutsk',
    status: 'pending', deliveryStatus: '', error: '', taskId: null, authorId: 2, canManage: false };
  const harness = boot({ clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ scheduled: [mine, foreign] }) })
  } });
  await mount(harness);
  const { d } = harness;
  assert.ok(d.querySelector('[data-pc-schedule-cancel="1"]'), 'своё можно отменить');
  assert.equal(d.querySelector('[data-pc-schedule-cancel="2"]'), null, 'чужое не предлагается отменить');
  assert.equal(d.querySelector('[data-pc-schedule-edit="2"]'), null, 'и не предлагается изменить');
  // Запросов к серверу за чужое не делается вовсе: нечего нажать, значит нет и 403 с выходом из чата.
  assert.equal(harness.calls.filter((call) => call.method === 'PATCH').length, 0);
});

test('сводка задач: 12 замечаний, 10 на сайте, 2 отменены и 4 внутренние показаны понятно', async () => {
  const base = { site: 'palitra-love', siteLabel: 'Палитра', siteStatus: 'known', publicationLabel: 'Опубликовано',
    publishedUrl: '', verifiedAt: '', sourceQuote: '', notes: [], assigneeId: null, stageId: null, due: '' };
  const tasks = [
    // Десять замечаний клиента на сайте.
    ...Array.from({ length: 10 }, (unused, index) => ({ ...base, id: index + 1, externalRef: `А${index + 1}`,
      title: `Замечание ${index + 1}`, kind: 'client_remark', status: 'done', publication: 'published',
      fixedOnSite: true, cancelled: false })),
    // Два снятых: исправлением не считаются, даже если публикация когда-то была.
    { ...base, id: 11, externalRef: 'А11', title: 'Снято клиентом', kind: 'client_remark', status: 'cancelled',
      publication: 'not_required', fixedOnSite: false, cancelled: true },
    { ...base, id: 12, externalRef: 'А12', title: 'Снято владельцем', kind: 'client_remark', status: 'cancelled',
      publication: 'published', fixedOnSite: false, cancelled: true },
    // Четыре внутренние работы: в клиентский счёт не входят.
    ...Array.from({ length: 4 }, (unused, index) => ({ ...base, id: 13 + index, externalRef: `ВН${index + 1}`,
      title: `Внутренняя ${index + 1}`, kind: 'internal', status: 'done', publication: 'prepared',
      fixedOnSite: false, cancelled: false }))
  ];
  const harness = boot({ clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ tasks }) })
  } });
  await mount(harness);
  const { d } = harness;
  assert.equal(d.querySelectorAll('.pc-task').length, 16, 'карточки не задваиваются и не пропадают');
  assert.equal(text(harness.dom, '[data-pc-task-count]'),
    'Замечания: 12 · на сайте 10 · осталось 0 · отменено 2 · внутренних 4');

  // Пустой проект: сводка не выдумывает нулей.
  const empty = boot({ clock: true, routes: { 'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ tasks: [] }) }) } });
  await mount(empty);
  assert.equal(text(empty.dom, '[data-pc-task-count]'), '');
});

test('сводка задач: снятое не попадает в «на сайте», незакрытое видно в «осталось»', async () => {
  const base = { site: 'palitra-love', siteLabel: 'Палитра', siteStatus: 'known', publicationLabel: 'Готово',
    publishedUrl: '', verifiedAt: '', sourceQuote: '', notes: [], assigneeId: null, stageId: null, due: '' };
  const tasks = [
    { ...base, id: 1, externalRef: 'А1', title: 'На сайте', kind: 'client_remark', status: 'done',
      publication: 'published', fixedOnSite: true, cancelled: false },
    { ...base, id: 2, externalRef: 'А2', title: 'Ждём уточнения', kind: 'client_remark', status: 'todo',
      publication: 'awaiting_clarification', fixedOnSite: false, cancelled: false },
    { ...base, id: 3, externalRef: 'А3', title: 'Снято', kind: 'client_remark', status: 'cancelled',
      publication: 'published', fixedOnSite: false, cancelled: true }
  ];
  const harness = boot({ clock: true, routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ tasks }) })
  } });
  await mount(harness);
  assert.equal(text(harness.dom, '[data-pc-task-count]'), 'Замечания: 3 · на сайте 1 · осталось 1 · отменено 1');
});

/* Две персоны: имена приходят с сервера, подсказка видна всегда, баннер — до закрытия. */
const PERSONAS = {
  hint: 'Позовите по имени: «Хью, ...» — сайты; «Лео, ...» — контент.',
  banner: { id: 'personas-v1', title: 'В чате два помощника',
    lines: ['Хью — сайты.', 'Лео — контент.', 'Ассистент отвечает только когда его зовут по имени.',
      'Это один сервис с двумя ролями, а не два независимых помощника.'] },
  list: [{ key: 'hugh', name: 'Хью' }, { key: 'leo', name: 'Лео' }],
};
const withStorage = (harness, seen = null) => {
  const store = new Map(seen ? [[seen, '1']] : []);
  Object.defineProperty(harness.w, 'localStorage', { configurable: true,
    value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } });
  return store;
};

test('подсказка с именами персон видна под полем ввода', async () => {
  const harness = boot({ routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ personas: PERSONAS }) }),
  } });
  withStorage(harness);
  await mount(harness);
  const hint = text(harness.dom, '[data-pc-personas-hint]');
  assert.match(hint, /Хью/);
  assert.match(hint, /Лео/);
  harness.w.close();
});

test('баннер о двух помощниках показывается при первом заходе и закрывается навсегда', async () => {
  const harness = boot({ routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ personas: PERSONAS }) }),
  } });
  const store = withStorage(harness);
  await mount(harness);
  const banner = harness.d.querySelector('[data-pc-personas]');
  assert.equal(banner.hidden, false, 'баннер должен быть виден при первом заходе');
  assert.match(banner.textContent, /зовут по имени/);
  assert.match(banner.textContent, /не два независимых помощника/);
  harness.click('[data-pc-personas-close]');
  assert.equal(harness.d.querySelector('[data-pc-personas]').hidden, true);
  assert.equal(store.get('pc-personas-seen:personas-v1'), '1');
  harness.w.close();
});

test('закрытый баннер не возвращается, а подсказка остаётся', async () => {
  const harness = boot({ routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ personas: PERSONAS }) }),
  } });
  withStorage(harness, 'pc-personas-seen:personas-v1');
  await mount(harness);
  assert.equal(harness.d.querySelector('[data-pc-personas]').hidden, true);
  assert.match(text(harness.dom, '[data-pc-personas-hint]'), /Лео/);
  harness.w.close();
});

test('изменился состав персон — баннер показывается заново', async () => {
  const harness = boot({ routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({
      personas: { ...PERSONAS, banner: { ...PERSONAS.banner, id: 'personas-v2' } } }) }),
  } });
  withStorage(harness, 'pc-personas-seen:personas-v1');
  await mount(harness);
  assert.equal(harness.d.querySelector('[data-pc-personas]').hidden, false);
  harness.w.close();
});

test('сервер не прислал персон — экран чата работает без подсказки', async () => {
  const harness = boot({ routes: {
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot() }),
  } });
  withStorage(harness);
  await mount(harness);
  assert.equal(harness.d.querySelector('[data-pc-personas]').hidden, true);
  assert.equal(text(harness.dom, '[data-pc-personas-hint]'), '');
  harness.w.close();
});

/* Резерв ответов. «Доступно 0» без причины выглядит как поломка неизвестной природы —
   именно на этом однажды потерялся час: провайдер числился настроенным и молчал.
   Окно закрывается в finally: упавший тест иначе оставляет его живым и процесс не выходит. */
// Резерв показывается там, где он нужен: когда основной путь ответить не может.
const withFallback = (fallback) => snapshot({ ai: { configured: true, connected: false,
  runtimeState: 'login_required', queued: 0, failed: 0, fallback } });
const bootFallback = (fallback) => boot({ routes: {
  'GET /content/project-chat/palitra-love': () => ({ body: withFallback(fallback) }),
} });

test('резерв без доступных провайдеров называет причину', async () => {
  const harness = bootFallback({ configured: true, available: 0,
    stoppedReason: 'Достигнута граница расхода резервных провайдеров',
    providers: [{ name: 'deepseek', model: 'm', cooling: false, live: true }], issues: [] });
  try {
    await mount(harness);
    assert.match(harness.d.body.textContent, /доступно 0/);
    assert.match(harness.d.body.textContent, /Достигнута граница расхода/);
  } finally { harness.w.close(); }
});

test('доступный резерв причину не показывает', async () => {
  const harness = bootFallback({ configured: true, available: 1, stoppedReason: '',
    providers: [{ name: 'deepseek', model: 'm', cooling: false, live: true }], issues: [] });
  try {
    await mount(harness);
    assert.match(harness.d.body.textContent, /доступно 1/);
    assert.doesNotMatch(harness.d.body.textContent, /Причина:/);
  } finally { harness.w.close(); }
});

test('причина со ссылкой или кодом входа в общий чат не попадает', async () => {
  const harness = bootFallback({ configured: true, available: 0,
    stoppedReason: 'Откройте https://example.com/login и введите ABCD-1234',
    providers: [{ name: 'deepseek', model: 'm', cooling: false, live: false }], issues: [] });
  try {
    await mount(harness);
    assert.doesNotMatch(harness.d.body.textContent, /example\.com|ABCD-1234/);
  } finally { harness.w.close(); }
});


test('Авокадо открывает общий чат АЛВИ, не меняя выбранную компанию кабинета',async()=>{
 const h=boot({company:'avokado',role:'member',routes:{
  'GET /content/project-chat/avokado/resolve':()=>({body:{companyCode:'alvi',shared:true,title:'Алви · Авокадо'}}),
  'GET /content/project-chat/alvi':()=>({body:snapshot({messages:[message({text:'Общая история двух студий'})]})})
 }});
 try{await mount(h);assert.equal(h.scope.company,'avokado');assert.match(h.d.body.textContent,/Алви · Авокадо/);
  assert.match(h.d.body.textContent,/Общая история двух студий/);
  assert.equal(h.calls.filter(c=>c.url==='/content/project-chat/avokado').length,0);
 }finally{h.w.close();}
});
