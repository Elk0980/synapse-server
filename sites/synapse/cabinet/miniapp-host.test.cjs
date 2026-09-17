const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

/* Хост Telegram Mini App: экраны вне Telegram / без привязки / повторного открытия, тема и
   размеры Telegram, монтирование общего чата с токеном в памяти и его забывание при отзыве.
   node --test sites/synapse/cabinet/miniapp-host.test.cjs */

const HOST = fs.readFileSync(path.join(__dirname, 'miniapp-host.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, 'project-chat.js'), 'utf8');
const ORIGIN = 'https://synapse.synapsebusiness.ru/miniapp.html';
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
// Окна закрываются после каждого теста, в том числе упавшего: иначе таймеры опроса комнаты держат процесс.
const windows = [];
test.afterEach(() => { for (const w of windows.splice(0)) w.close(); });
const snapshot = (over = {}) => ({ room: { replyMode: 'addressed', telegramChatId: '-1001' }, access: { canReply: true, owner: false },
  members: [{ userId: 2, displayName: 'Дарья' }], messages: [{ id: 'm1', authorType: 'assistant', authorName: 'Хью', text: 'Готово', createdAt: '2026-09-17T09:00:00.000Z', deliveryStatus: 'sent', attachments: [] }],
  tasks: [], stages: [], ai: { configured: true, connected: true, runtimeState: 'connected', queued: 0, failed: 0 }, hasMore: false, oldestMessageId: null, ...over });

function boot({ telegram, routes = {} } = {}) {
  // Без pretendToBeVisual: его цикл кадров держит процесс живым. Видимость задаётся ниже вручную,
  // а окно закрывается в конце теста — вместе с ним гаснут таймеры опроса комнаты.
  const dom = new JSDOM('<main id="miniapp"></main>', { runScripts: 'outside-only', url: ORIGIN });
  const w = dom.window;
  Object.defineProperty(w, 'crypto', { configurable: true, writable: true, value: { randomUUID: () => 'client-1' } });
  w.AbortSignal.timeout = () => new w.AbortController().signal;
  w.AbortSignal.any = () => new w.AbortController().signal;
  const blobs = { created: [], revoked: [] };
  w.URL.createObjectURL = () => { const url = `blob:asset-${blobs.created.length + 1}`; blobs.created.push(url); return url; };
  w.URL.revokeObjectURL = (url) => blobs.revoked.push(url);
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => false });
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => 'visible' });
  const calls = [];
  w.fetch = (input, init = {}) => {
    const url = new w.URL(String(input), ORIGIN);
    const method = (init.method || 'GET').toUpperCase();
    const call = { url: url.pathname + url.search, method, headers: init.headers || {}, body: init.body, credentials: init.credentials, redirect: init.redirect };
    calls.push(call);
    const handler = routes[`${method} ${url.pathname}`];
    const result = handler ? handler(call) : { status: 404, body: { error: 'нет маршрута' } };
    if (result instanceof Error) return Promise.reject(result);
    const status = result.status ?? 200;
    return Promise.resolve({ ok: status < 300, status, json: async () => result.body || {}, blob: async () => new w.Blob(['x']) });
  };
  const back = { shown: false, handler: null };
  if (telegram) {
    w.Telegram = { WebApp: { initData: telegram.initData ?? 'query_id=AAE&user=%7B%22id%22%3A5001%7D&auth_date=1&signature=sig', initDataUnsafe: { start_param: telegram.startParam },
      themeParams: telegram.themeParams || { bg_color: '#101418', text_color: '#f0f0f0', hint_color: '#8a94a0', button_color: '#5aa9ff', secondary_bg_color: '#1b2128' },
      colorScheme: 'dark', viewportStableHeight: 640, safeAreaInset: { top: 20, bottom: 10, left: 0, right: 0 }, contentSafeAreaInset: { top: 46, bottom: 0, left: 0, right: 0 },
      ready() { this.readyCalled = true; }, expand() {}, close() { this.closed = true; }, onEvent() {},
      BackButton: { show() { back.shown = true; }, hide() { back.shown = false; }, onClick(fn) { back.handler = fn; } } } };
  }
  w.eval(HOST);
  w.eval(CHAT);
  windows.push(w);
  return { w, d: w.document, calls, back, blobs, tg: w.Telegram?.WebApp, close: () => {} };
}
const text = (h) => h.d.getElementById('miniapp').textContent;
const click = (h, selector) => { const node = h.d.querySelector(selector); assert.ok(node, `нет ${selector}`); node.dispatchEvent(new h.w.Event('click', { bubbles: true })); };

test('вне Telegram страница честно просит открыть чат из Telegram и ничего не запрашивает', async () => {
  const h = boot();
  await settle();
  assert.match(text(h), /Откройте чат проекта из Telegram/);
  assert.equal(h.calls.length, 0);
  h.close();
});

test('вход по подписи: тема и размеры Telegram применяются, чат монтируется с токеном в памяти, не в адресе и не в cookie', async () => {
  const h = boot({ telegram: { startParam: 'palitra-love' }, routes: {
    'POST /content/project-chat-miniapp/session': () => ({ body: { token: 'room.p.s', expiresAt: '2026-09-18T00:00:00.000Z', startParam: 'palitra-love', companies: [{ code: 'palitra-love', title: 'Палитра' }], identity: { userId: 2, displayName: 'Дарья', role: 'member' } } }),
    'GET /content/project-chat/palitra-love': () => ({ body: snapshot({ messages: [{ id: 'm1', authorType: 'assistant', authorName: 'Хью', text: 'Готово', createdAt: '2026-09-17T09:00:00.000Z', deliveryStatus: 'sent',
      attachments: [{ id: 'a1', name: 'фото.jpg', mime: 'image/jpeg', url: '/content/project-chat/palitra-love/attachments/1' },
        { id: 'a2', name: 'чужое.jpg', mime: 'image/jpeg', url: '/content/project-chat/alvi/attachments/2' }] }] }) }),
    'GET /content/project-chat/palitra-love/attachments/1': () => ({ body: {} }),
    'GET /content/project-chat/alvi/attachments/2': () => ({ body: {} }),
  } });
  await settle(10);
  const session = h.calls.find((c) => c.url.startsWith('/content/project-chat-miniapp/session'));
  assert.equal(session.credentials, 'omit');
  // Незаверенная подсказка start_param из initDataUnsafe не отправляется: проект сервер берёт из подписи.
  assert.deepEqual(JSON.parse(session.body), { initData: h.tg.initData });
  assert.equal(h.tg.readyCalled, true);
  const style = h.d.documentElement.style;
  assert.equal(style.getPropertyValue('--surface'), '#101418');
  assert.equal(style.getPropertyValue('--accent'), '#5aa9ff');
  assert.equal(style.getPropertyValue('--ma-viewport'), '640px');
  assert.equal(style.getPropertyValue('--ma-safe-top'), '66px');
  assert.equal(h.d.documentElement.dataset.theme, 'dark');
  const room = h.calls.find((c) => c.url.startsWith('/content/project-chat/palitra-love'));
  assert.equal(room.headers.Authorization, 'Bearer room.p.s');
  assert.equal(room.headers['X-CSRF-Token'], undefined);
  assert.ok(h.calls.every((c) => !c.url.includes('room.p.s')), 'токен не уходит в адрес');
  assert.equal(h.d.cookie, '');
  assert.match(text(h), /Готово/);
  assert.match(text(h), /ИИ · бизнес-ассистент Синапс Бизнес/);
  assert.equal(h.d.querySelector('[data-pc-mode="private"]'), null);
  assert.equal(h.d.querySelector('[data-pc-settings]').hidden, true);
  assert.equal(h.back.shown, false, 'один проект — кнопка «Назад» не нужна');
  // Файл читается только с маршрута вложений открытого проекта, без редиректов; чужой путь не получает токен.
  const assets = h.calls.filter((c) => c.url.includes('/attachments/'));
  assert.deepEqual(assets.map((c) => c.url), ['/content/project-chat/palitra-love/attachments/1']);
  assert.equal(assets[0].headers.Authorization, 'Bearer room.p.s');
  assert.equal(assets[0].redirect, 'error');
  assert.equal(h.d.querySelector('[data-pc-asset$="/1"] img').getAttribute('src'), 'blob:asset-1');
  assert.match(h.d.querySelector('[data-pc-asset$="/2"]').textContent, /Не удалось загрузить файл/);
  h.close();
});

test('без ссылки проекта код не выдаётся: экран просит открыть ссылку своего проекта', async () => {
  const h = boot({ telegram: {}, routes: { 'POST /content/project-chat-miniapp/session': () => ({ status: 403, body: { state: 'no_project', error: 'Откройте чат по ссылке своего проекта' } }) } });
  await settle();
  assert.match(text(h), /Откройте чат по ссылке своего проекта/);
  assert.equal(h.d.querySelector('.ma-code'), null, 'кода на экране нет');
  assert.doesNotMatch(text(h), /Сообщите владельцу/);
  assert.equal(h.calls.length, 1);
  h.close();
});

test('без привязки показывается код и понятные шаги; истёкшие или повторные данные — экран повторного открытия', async () => {
  const unlinked = boot({ telegram: {}, routes: { 'POST /content/project-chat-miniapp/session': () => ({ status: 403, body: { state: 'unlinked', linkCode: 'K7M2PQ', expiresAt: new Date(Date.now() + 14 * 60000).toISOString() } }) } });
  await settle();
  assert.match(text(unlinked), /K7M2PQ/);
  assert.match(text(unlinked), /Сообщите владельцу проекта/);
  assert.match(text(unlinked), /закройте это окно и откройте чат снова/);
  assert.equal(unlinked.calls.length, 1, 'повторных запросов входа нет');
  click(unlinked, '[data-ma-close]');
  assert.equal(unlinked.tg.closed, true);
  const replayed = boot({ telegram: {}, routes: { 'POST /content/project-chat-miniapp/session': () => ({ status: 409, body: { state: 'replayed', error: 'x' } }) } });
  await settle();
  assert.match(text(replayed), /уже использованы/);
  assert.match(text(replayed), /снова откройте чат из Telegram/);
  assert.equal(replayed.calls.length, 1);
  const off = boot({ telegram: {}, routes: { 'POST /content/project-chat-miniapp/session': () => ({ status: 503, body: { error: 'x' } }) } });
  await settle();
  assert.match(text(off), /пока не включён/);
  const noRooms = boot({ telegram: {}, routes: { 'POST /content/project-chat-miniapp/session': () => ({ status: 403, body: { state: 'no_rooms' } }) } });
  await settle();
  assert.match(text(noRooms), /ещё не добавил вас в участники/);
  for (const h of [unlinked, replayed, off, noRooms]) h.close();
});

test('несколько проектов: выбор и кнопка «Назад»; отозванная сессия забывает токен и просит открыть заново', async () => {
  let revokedNow = false;
  const h = boot({ telegram: {}, routes: {
    'POST /content/project-chat-miniapp/session': () => ({ body: { token: 'room.p.s', companies: [{ code: 'palitra-love', title: 'Палитра' }, { code: 'alvi', title: 'АЛВИ' }], identity: { userId: 1, displayName: 'Влад', role: 'member' } } }),
    'GET /content/project-chat/alvi': () => ({ body: snapshot({ messages: [{ id: 'm1', authorType: 'human', authorName: 'Анна', text: 'Смета', createdAt: '2026-09-17T09:00:00.000Z', deliveryStatus: 'sent',
      attachments: [{ id: 'a1', name: 'смета.pdf', mime: 'application/pdf', url: '/content/project-chat/alvi/attachments/1' }] }] }) }),
    'GET /content/project-chat/alvi/attachments/1': () => ({ body: {} }),
    'POST /content/project-chat/alvi/messages': () => (revokedNow ? { status: 401, body: { error: 'Сессия чата истекла' } } : { body: { ok: true } }),
  } });
  await settle();
  assert.match(text(h), /Выберите проект/);
  click(h, '[data-ma-company="alvi"]');
  await settle(10);
  assert.equal(h.back.shown, true);
  assert.ok(h.d.querySelector('#hugh-view'));
  assert.match(text(h), /Смета/);
  assert.deepEqual(h.blobs.created, ['blob:asset-1']);
  // «Назад» снимает вид комнаты целиком: blob-адрес освобождён, опрос остановлен.
  h.back.handler();
  assert.match(text(h), /Выберите проект/);
  assert.equal(h.back.shown, false);
  assert.deepEqual(h.blobs.revoked, ['blob:asset-1']);
  const idle = h.calls.length;
  await settle(10);
  assert.equal(h.calls.length, idle, 'после ухода из комнаты запросов нет');
  // Отзыв во время работы: ответ 401 закрывает чат экраном повторного открытия, токен забыт.
  click(h, '[data-ma-company="alvi"]');
  await settle(10);
  revokedNow = true;
  h.d.querySelector('[data-pc-compose] textarea').value = 'Ещё вопрос';
  h.d.querySelector('[data-pc-compose]').dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(10);
  assert.equal(h.d.getElementById('hugh-view'), null, 'комната убрана со страницы');
  assert.match(text(h), /Сессия чата истекла/);
  assert.match(text(h), /снова откройте чат из Telegram/);
  assert.equal(h.back.shown, false);
  const after = h.calls.length;
  await settle(10);
  assert.equal(h.calls.length, after, 'после отзыва запросов с прежним токеном больше нет');
  h.close();
});
