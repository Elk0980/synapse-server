'use strict';
/* PhaseE UI: настоящие изменённые palitra-chat.{html,js,css} и palitra-work.{js,css} (+ readonly palitra-work.html) в headless
   Chrome. /chat и его assets отдаёт настоящий draftHook palitra-host-adapter.cjs; JSON API — синтетические ответы в форме
   принятых DTO E (uploads.enabled, upload:{ref,state}, квитанция с attachments[ref]). Байты из страницы перехватываются
   (postDataBuffer) и сверяются с выбранным файлом. Каждый случай — новый непостоянный context без профиля; неизвестные
   запросы — abort и провал; наружу ничего не уходит.
   Запуск (Root, Node 24): node --test phaseE-ui.test.cjs (PALITRA_PLAYWRIGHT / PALITRA_CHROME — при необходимости).
   Автор тест не запускал: результата прогона здесь нет. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');

const DIR = __dirname;
const PLAYWRIGHT = process.env.PALITRA_PLAYWRIGHT || 'playwright';
const CHROME = process.env.PALITRA_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOP = 'https://palitra-phasee-qa.invalid';
const APP = 'https://synapse-phasee-qa.invalid';
const DRAFT = Object.freeze({ id: 'site-44bbe13f1bad5e005b2a', company_code: 'palitra-love' });
const GUEST_CSRF = '0a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455aabb';
const CHAT_TOKEN = 'C'.repeat(43);
const STAMP = '2026-10-14T09:00:00.000Z';
const MIB = 1024 * 1024;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(80, 3)]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const { createPalitraHostAdapter } = require(path.join(DIR, 'palitra-host-adapter.cjs'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let i = 0; i < 150; i += 1) { if (predicate()) return; await sleep(20); }
  throw new Error(`Не дождались: ${label}`);
}
const json = (status, body) => ({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
const file = (name, contentType) => ({ status: 200, contentType, body: fs.readFileSync(path.join(DIR, name)) });

function hookHost() {
  return createPalitraHostAdapter({ env: { PALITRA_CHECKOUT_ENABLED: 'true', PALITRA_SHOP_ORIGIN: SHOP }, priceRow: () => ({ body: '{}', version: 1 }),
    clientIp: () => '203.0.113.9', originOf: (req) => String(req.headers.origin || ''), siteOrders: { submit: () => ({ status: 201, body: { ok: true, orderId: 1 } }) }, chatPublicDir: DIR });
}
function capture() {
  const chunks = [];
  const res = new Writable({ write(chunk, _e, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.statusCode = 0; res.headers = {};
  res.writeHead = (status, headers = {}) => { res.statusCode = status; res.headers = { ...headers }; return res; };
  const end = res.end.bind(res);
  res.end = (body) => { if (body !== undefined && body !== null) chunks.push(Buffer.from(body)); return end(); };
  res.done = new Promise((resolve) => res.on('finish', resolve));
  res.body = () => Buffer.concat(chunks);
  return res;
}
async function shell(host, entry) {
  const res = capture();
  const handled = await host.draftHook.handle({ request: { method: entry.method, url: entry.path + entry.search, headers: { host: new URL(SHOP).hostname } },
    response: res, url: new URL(entry.path + entry.search, SHOP), draft: DRAFT, hostname: new URL(SHOP).hostname });
  if (!handled) return null;
  await res.done;
  const headers = {};
  for (const [name, value] of Object.entries(res.headers)) if (!['content-type', 'content-length'].includes(name.toLowerCase())) headers[name] = String(value);
  return { status: res.statusCode, contentType: res.headers['Content-Type'], headers, body: res.body() };
}

/* ---------- изолированный браузер ---------- */
let chromium = null, browser = null;
test.before(async () => {
  ({ chromium } = require(PLAYWRIGHT));
  browser = await chromium.launch({ headless: true, executablePath: CHROME,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--metrics-recording-only'] });
});
test.after(async () => { if (browser) await browser.close(); });
async function withPage({ viewport = { width: 1000, height: 800 }, router }, run) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', acceptDownloads: false });
  const log = { requests: [], blocked: [], errors: [] };
  try {
    if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', (socket) => socket.close());
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const entry = { method: request.method(), origin: url.origin, path: url.pathname, search: url.search, url, headers: request.headers(),
        body: request.postData() || '', buffer: request.postDataBuffer() || Buffer.alloc(0) };
      log.requests.push(entry);
      let out = null;
      try { out = entry.path === '/favicon.ico' ? { status: 204, contentType: 'image/x-icon', body: '' } : await router(entry); }
      catch (error) { log.errors.push(`router: ${error.message}`); }
      try {
        if (out) await route.fulfill({ status: out.status, contentType: out.contentType, headers: { 'Cache-Control': 'no-store', ...(out.headers || {}) }, body: out.body });
        else { log.blocked.push(`${entry.method} ${url.href}`); await route.abort('blockedbyclient'); }
      } catch (_) { /* запрос уже отменён страницей */ }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', (error) => log.errors.push(error.message));
    await run({ page, log, context });
    assert.deepEqual(log.errors, [], 'ошибки исполнения настоящих скриптов');
    assert.deepEqual(log.blocked, [], 'неожиданные запросы');
  } finally { await context.close(); }
}

/* ---------- покупатель: синтетический чат с загрузками ---------- */
function buyerServer({ enabled = true } = {}) {
  const host = hookHost();
  const thread = { id: 41, orderId: 7001, createdAt: STAMP, updatedAt: STAMP, lastMessageAt: STAMP, telegramLinked: false };
  const srv = { enabled, messages: [{ id: 1, direction: 'out', author: 'shop', channel: 'shop', text: 'Здравствуйте! Пришлите фото.', createdAt: STAMP, stored: true }],
    prepares: [], bytes: [], statuses: [], posts: [], uploads: new Map(), failBytes: 0, holdBytes: null, nextId: 100 };
  const committed = (upload) => ({ id: upload.messageId, direction: 'in', author: 'customer', channel: 'web', text: upload.caption, createdAt: STAMP, stored: true,
    attachments: [{ ref: upload.ref, kind: 'photo', mime: 'image/png', name: upload.name, size: upload.size, storageStatus: 'stored', error: '', presentation: 'image' }] });
  const view = (upload) => ({ ref: upload.ref, requestId: upload.requestId, target: 'thread:41', state: upload.state, name: upload.name, size: upload.size,
    sha256: upload.sha256, caption: upload.caption, expiresAt: STAMP, error: '' });
  srv.route = async (entry) => {
    if (entry.origin !== SHOP) return null;
    if (['/chat', '/assets/palitra-chat.js', '/assets/palitra-chat.css'].includes(entry.path)) return shell(host, entry);
    if (entry.method === 'GET' && entry.path === '/api/draft-account/session') return json(200, { user: null, csrf: GUEST_CSRF });
    const uploadPath = /^\/api\/customer-chat\/threads\/41\/(uploads|attachments)(?:\/(upload:[0-9a-f-]{36}))?(\/bytes)?$/.exec(entry.path);
    if (uploadPath) {
      const [, kind, ref, bytes] = uploadPath;
      if (kind === 'attachments' && entry.method === 'GET') return { status: 200, contentType: 'image/png', body: PNG };
      if (kind === 'uploads' && !ref && entry.method === 'POST') {
        const body = JSON.parse(entry.body);
        srv.prepares.push({ body, headers: entry.headers });
        let upload = [...srv.uploads.values()].find((u) => u.requestId === body.requestId);
        const duplicate = Boolean(upload);
        if (!upload) {
          upload = { ref: `upload:${crypto.randomUUID()}`, requestId: body.requestId, name: body.name, size: body.size, sha256: body.sha256, caption: body.caption, state: 'prepared' };
          srv.uploads.set(upload.ref, upload);
        }
        return json(duplicate ? 200 : 201, { ok: true, duplicate, threadId: 41, upload: view(upload), ...(upload.state === 'committed' ? { requestId: upload.requestId, message: committed(upload) } : {}) });
      }
      const upload = srv.uploads.get(ref);
      if (!upload) return json(404, { ok: false, code: 'NOT_FOUND', error: 'Не найдено' });
      if (!bytes && entry.method === 'GET') {
        srv.statuses.push(ref);
        return json(200, { ok: true, threadId: 41, upload: view(upload), ...(upload.state === 'committed' ? { requestId: upload.requestId, message: committed(upload) } : {}) });
      }
      if (bytes && entry.method === 'POST') {
        srv.bytes.push({ ref, buffer: entry.buffer, headers: entry.headers });
        if (srv.holdBytes) await srv.holdBytes;
        if (srv.failBytes > 0) { srv.failBytes -= 1; return json(503, { ok: false, code: 'INTERNAL', error: 'Чат временно недоступен' }); }
        if (entry.buffer.length !== upload.size || sha(entry.buffer) !== upload.sha256) return json(422, { ok: false, code: 'HASH_MISMATCH', error: 'Файл не совпал с выбранным — выберите тот же файл' });
        if (upload.state !== 'committed') { upload.state = 'committed'; upload.messageId = ++srv.nextId; srv.messages.push(committed(upload)); }
        return json(201, { ok: true, duplicate: false, threadId: 41, requestId: upload.requestId, message: committed(upload), upload: view(upload) });
      }
      return null;
    }
    if (entry.method !== 'POST' || !entry.path.startsWith('/api/customer-chat/')) return null;
    const route = entry.path.slice('/api/customer-chat/'.length);
    if (route === 'session') return json(200, { ok: true, created: false, csrfToken: CHAT_TOKEN, expiresAt: '2026-11-13T09:00:00.000Z' });
    const body = JSON.parse(entry.body || '{}');
    if (route === 'threads') return json(200, { ok: true, threads: [thread], nextBefore: null });
    if (route === 'messages') return json(200, { ok: true, thread, messages: srv.messages, nextBefore: null, ...(srv.enabled ? { uploads: { enabled: true, maxBytes: 20 * MIB } } : {}) });
    if (route === 'message') {
      srv.posts.push(body);
      const message = { id: ++srv.nextId, direction: 'in', author: 'customer', channel: 'web', text: body.text, createdAt: STAMP, stored: true };
      srv.messages.push(message);
      return json(201, { ok: true, duplicate: false, threadId: 41, message });
    }
    return null;
  };
  return srv;
}
const chatTitle = (page) => page.waitForFunction(() => document.getElementById('pc-title').textContent === 'Заявка №7001');
const chatReady = (page) => page.waitForFunction(() => document.getElementById('pc-title').textContent === 'Заявка №7001' && !document.getElementById('pc-send').disabled);
const fileReady = (page, id, name) => page.waitForFunction(([node, expected]) => {
  const text = document.getElementById(node).textContent;
  return text.startsWith(`${expected} ·`) && !text.includes('проверяем');
}, [id, name]);

test('U1. /chat: «Прикрепить файл» → подпись + файл → prepare точной формы, байты того же файла с CSRF чата; квитанция очищает отправленное; файл виден в истории', async () => {
  const srv = buyerServer();
  await withPage({ router: srv.route }, async ({ page }) => {
    await page.goto(`${SHOP}/chat?thread=41`);
    await chatReady(page);
    assert.equal(await page.locator('input[type=file]#pc-file').count(), 1);
    assert.equal(await page.locator('label[for="pc-file"]').textContent(), 'Прикрепить файл');
    assert.match(await page.locator('#pc-files-note').textContent(), /один файл до 20 МБ/);
    await page.locator('#pc-text').fill('Подпись к фото');
    await page.locator('#pc-file').setInputFiles({ name: 'образец.png', mimeType: 'image/png', buffer: PNG });
    await fileReady(page, 'pc-file-name', 'образец.png');
    await page.locator('#pc-send').click();
    await page.waitForFunction(() => document.getElementById('pc-state').dataset.state === 'ok');
    assert.equal(srv.prepares.length, 1);
    const { body, headers } = srv.prepares[0];
    assert.deepEqual(Object.keys(body).sort(), ['caption', 'name', 'requestId', 'sha256', 'size']);
    assert.match(body.requestId, UUID);
    assert.deepEqual([body.name, body.size, body.sha256, body.caption, headers['x-palitra-chat-csrf']], ['образец.png', PNG.length, sha(PNG), 'Подпись к фото', CHAT_TOKEN]);
    assert.equal(srv.bytes.length, 1);
    assert.deepEqual([Buffer.compare(srv.bytes[0].buffer, PNG), srv.bytes[0].headers['content-type'], srv.bytes[0].headers['x-palitra-chat-csrf']], [0, 'application/octet-stream', CHAT_TOKEN]);
    assert.equal(await page.locator('#pc-text').inputValue(), '', 'отправленная подпись очищена');
    assert.equal(await page.locator('#pc-file-name').textContent(), 'Файл не выбран');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('palitra-chat-pending-v1')), null);
    const ref = [...srv.uploads.keys()][0];
    await page.locator(`#pc-messages [data-key="101"] a.pc-file__download`).waitFor();
    assert.equal(await page.locator('#pc-messages [data-key="101"] a.pc-file__download').getAttribute('href'), `/api/customer-chat/threads/41/attachments/${ref}`);
    assert.deepEqual(await page.locator('#pc-messages [data-key="101"] .pc-msg__text').allTextContents(), ['Подпись к фото'], 'подпись один раз');
    assert.equal(srv.posts.length, 0, 'текстовый маршрут не вызывался');
  });
});

test('U2. /chat: правка поля во время загрузки сохраняется после квитанции; «Убрать» до отправки ничего не отправляет; файл без подписи', async () => {
  const srv = buyerServer();
  await withPage({ router: srv.route }, async ({ page, log }) => {
    await page.goto(`${SHOP}/chat?thread=41`);
    await chatReady(page);
    await page.locator('#pc-file').setInputFiles({ name: 'a.pdf', mimeType: 'application/pdf', buffer: PDF });
    await fileReady(page, 'pc-file-name', 'a.pdf');
    await page.locator('.pc-attach__remove').click();
    assert.equal(await page.locator('#pc-file-name').textContent(), 'Файл не выбран');
    assert.equal(log.requests.filter((r) => /\/uploads/.test(r.path)).length, 0, 'отмена до отправки — без записи');
    await page.locator('#pc-text').fill('Первая подпись');
    await page.locator('#pc-file').setInputFiles({ name: 'a.pdf', mimeType: 'application/pdf', buffer: PDF });
    await fileReady(page, 'pc-file-name', 'a.pdf');
    let release;
    srv.holdBytes = new Promise((resolve) => { release = resolve; });
    await page.locator('#pc-send').click();
    await page.waitForFunction(() => document.getElementById('pc-state').dataset.state === 'pending');
    await page.locator('#pc-text').fill('Следующий черновик, набранный во время загрузки');
    release();
    srv.holdBytes = null;
    await page.waitForFunction(() => document.getElementById('pc-state').dataset.state === 'ok');
    assert.equal(await page.locator('#pc-text').inputValue(), 'Следующий черновик, набранный во время загрузки', 'поздняя правка не стёрта');
    assert.equal(srv.prepares[0].body.caption, 'Первая подпись');
    // Файл без подписи.
    await page.locator('#pc-text').fill('');
    await page.locator('#pc-file').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: PNG });
    await fileReady(page, 'pc-file-name', 'b.png');
    await page.locator('#pc-send').click();
    await until(() => srv.bytes.length === 2, 'байты второго файла');
    await page.waitForFunction(() => document.getElementById('pc-state').dataset.state === 'ok' && document.getElementById('pc-file-name').textContent === 'Файл не выбран');
    assert.deepEqual([srv.prepares.length, srv.prepares[1].body.caption, srv.prepares[1].body.name], [2, '', 'b.png'], 'файл без подписи допустим');
  });
});

test('U3. /chat: неизвестный исход байтов → перезагрузка → сначала GET состояния, «Выберите тот же файл»; тот же файл — тот же upload и requestId, без новой подготовки', async () => {
  const srv = buyerServer();
  srv.failBytes = 1;
  await withPage({ router: srv.route }, async ({ page }) => {
    await page.goto(`${SHOP}/chat?thread=41`);
    await chatReady(page);
    await page.locator('#pc-text').fill('Подпись');
    await page.locator('#pc-file').setInputFiles({ name: 'образец.png', mimeType: 'image/png', buffer: PNG });
    await fileReady(page, 'pc-file-name', 'образец.png');
    await page.locator('#pc-send').click();
    await page.locator('#pc-unknown').waitFor();
    const stored = JSON.parse(await page.evaluate(() => sessionStorage.getItem('palitra-chat-pending-v1')));
    assert.deepEqual([stored.type, stored.name, stored.size, stored.sha256, stored.text, stored.uploadRef], ['file', 'образец.png', PNG.length, sha(PNG), 'Подпись', [...srv.uploads.keys()][0]]);
    assert.equal(JSON.stringify(stored).includes(CHAT_TOKEN), false, 'CSRF не сохраняется');
    await page.reload();
    await chatTitle(page);
    await page.locator('#pc-unknown').waitFor();
    assert.equal(await page.locator('#pc-send').isDisabled(), true, 'новая отправка заблокирована');
    assert.match(await page.locator('#pc-file-name').textContent(), /Неотправленный файл: образец\.png/);
    await page.locator('#pc-retry').click();
    await page.waitForFunction(() => document.getElementById('pc-state').textContent.includes('Выберите тот же файл'));
    assert.deepEqual([srv.statuses.length, srv.prepares.length, srv.bytes.length], [1, 1, 1], 'только чтение состояния, без новой подготовки и байтов');
    await page.locator('#pc-file').setInputFiles({ name: 'другое.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from([0])]) });
    await page.waitForFunction(() => document.getElementById('pc-state').textContent.includes('Это другой файл'));
    await page.locator('#pc-file').setInputFiles({ name: 'образец.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForFunction(() => document.getElementById('pc-state').textContent.includes('Это тот же файл'));
    await page.locator('#pc-retry').click();
    await page.waitForFunction(() => document.getElementById('pc-state').dataset.state === 'ok');
    assert.deepEqual([srv.prepares.length, srv.bytes.length, srv.bytes[1].ref, srv.bytes[0].ref], [1, 2, stored.uploadRef, stored.uploadRef]);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('palitra-chat-pending-v1')), null);
  });
});

test('U4. /chat: загрузки не включены сервером — выбора файла нет, прежний «только текст»; 320px — выбор файла в ширине экрана и доступен с клавиатуры', async () => {
  const off = buyerServer({ enabled: false });
  await withPage({ router: off.route }, async ({ page }) => {
    await page.goto(`${SHOP}/chat?thread=41`);
    await chatReady(page);
    assert.equal(await page.locator('input[type=file]').count(), 0);
    assert.match(await page.locator('#pc-files-note').textContent(), /только текст/);
  });
  const srv = buyerServer();
  await withPage({ viewport: { width: 320, height: 640 }, router: srv.route }, async ({ page }) => {
    await page.goto(`${SHOP}/chat?thread=41`);
    await chatReady(page);
    const boxes = await page.evaluate(() => ['.pc-attach', '.pc-attach__pick', '#pc-send'].map((s) => document.querySelector(s).getBoundingClientRect().right));
    assert.ok(boxes.every((right) => right <= 320 + 0.5), JSON.stringify(boxes));
    await page.locator('#pc-text').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pc-file', 'Tab из поля — на выбор файла');
    const pick = await page.locator('.pc-attach__pick').boundingBox();
    assert.ok(pick && pick.height >= 44 - 0.5, 'цель касания 44px');
    await page.locator('#pc-file').setInputFiles({ name: `${'очень-длинное-имя-'.repeat(8)}.pdf`, mimeType: 'application/pdf', buffer: PDF });
    await page.waitForFunction(() => document.getElementById('pc-file-name').textContent.includes('.pdf ·'));
    const name = await page.locator('#pc-file-name').boundingBox();
    assert.ok(name && name.x + name.width <= 320 + 0.5, 'длинное имя переносится');
  });
});

/* ---------- владелец: чат сайта и прежний диалог ---------- */
const OWNER = Object.freeze({ userId: 7, login: 'owner7', displayName: 'QA владелец', role: 'owner', csrfToken: 'owner-csrf-7' });
function ownerServer({ enabled = true } = {}) {
  const srv = { enabled, prepares: [], bytes: [], uploads: new Map(), nextId: 50,
    thread: { id: 1, orderId: 31, createdAt: STAMP, updatedAt: STAMP, lastMessageAt: STAMP, telegramLinked: true },
    threadMessages: [{ id: 1, direction: 'in', author: 'customer', source: 'web', text: 'Пришлите счёт', createdAt: STAMP, web: 'stored', deliveries: [] }],
    legacyMessages: [{ id: 1, direction: 'in', authorType: 'client', text: 'Прежний вопрос', createdAt: STAMP, deliveryStatus: 'received', deliveryError: '', edited: false, versions: [], attachments: [] }] };
  const uploadsInfo = () => (srv.enabled ? { uploads: { enabled: true, maxBytes: 20 * MIB } } : {});
  const view = (u) => ({ ref: u.ref, requestId: u.requestId, target: u.target, state: u.state, name: u.name, size: u.size, sha256: u.sha256, caption: u.caption, expiresAt: STAMP, error: '' });
  srv.route = async (entry) => {
    if (entry.origin !== APP) return null;
    const { method, path: p } = entry;
    if (method === 'GET' && p === '/cabinet/palitra-work.html') return file('palitra-work.html', 'text/html; charset=utf-8');
    if (method === 'GET' && p === '/cabinet/palitra-work.css') return file('palitra-work.css', 'text/css; charset=utf-8');
    if (method === 'GET' && p === '/cabinet/palitra-work.js') return file('palitra-work.js', 'application/javascript; charset=utf-8');
    if (method === 'GET' && p === '/content/whoami') return json(200, OWNER);
    if (method === 'GET' && p === '/content/palitra/orders') return json(200, { orders: [], nextCursor: null });
    if (method === 'GET' && p === '/content/palitra/client-dialogs') return json(200, { dialogs: [{ id: 1, name: 'Клиент бота', unread: 0, lastMessageAt: STAMP, lastMessage: 'вопрос' }], nextCursor: null });
    if (method === 'GET' && p === '/content/palitra/client-dialogs/1') return json(200, { dialog: { id: 1, name: 'Клиент бота', unread: 0 }, order: null, messages: srv.legacyMessages, ...uploadsInfo() });
    if (method === 'GET' && p === '/content/palitra/customer-threads') return json(200, { threads: [{ ...srv.thread, lastMessage: 'счёт', undelivered: 0 }], nextBefore: null });
    if (method === 'GET' && p === '/content/palitra/customer-threads/1') return json(200, { thread: srv.thread, messages: srv.threadMessages, nextBefore: null, ...uploadsInfo() });
    const m = /^\/content\/palitra\/(customer-threads|client-dialogs)\/1\/(uploads|attachments)(?:\/(upload:[0-9a-f-]{36}))?(\/bytes)?$/.exec(p);
    if (!m) return null;
    const [, scope, kind, ref, bytes] = m;
    if (kind === 'attachments' && method === 'GET') return { status: 200, contentType: 'application/octet-stream', body: PDF };
    if (kind === 'uploads' && !ref && method === 'POST') {
      const body = JSON.parse(entry.body);
      srv.prepares.push({ scope, body, headers: entry.headers });
      const upload = { ref: `upload:${crypto.randomUUID()}`, requestId: body.requestId, name: body.name, size: body.size, sha256: body.sha256, caption: body.caption, state: 'prepared', scope,
        target: scope === 'customer-threads' ? 'thread:1' : 'legacy:1' };
      srv.uploads.set(upload.ref, upload);
      return json(201, { ok: true, duplicate: false, ...(scope === 'customer-threads' ? { threadId: 1 } : { dialogId: 1 }), upload: view(upload) });
    }
    if (bytes && method === 'POST') {
      const upload = srv.uploads.get(ref);
      srv.bytes.push({ scope, ref, buffer: entry.buffer, headers: entry.headers });
      upload.state = 'committed';
      const id = ++srv.nextId;
      if (scope === 'customer-threads') {
        const message = { id, direction: 'out', author: 'owner', source: 'app', text: upload.caption, createdAt: STAMP, web: 'stored', deliveries: [],
          attachments: [{ ref, kind: 'document', mime: 'application/octet-stream', name: upload.name, size: upload.size, storageStatus: 'stored', error: '', presentation: 'download' }] };
        srv.threadMessages.push(message);
        return json(201, { ok: true, duplicate: false, threadId: 1, requestId: upload.requestId, message, upload: view(upload) });
      }
      srv.legacyMessages.push({ id, direction: 'out', authorType: 'operator', text: upload.caption, createdAt: STAMP, deliveryStatus: 'pending', deliveryError: '', edited: false, versions: [],
        attachments: [{ id: ref, ref, kind: 'document', mime: 'application/octet-stream', name: upload.name, size: upload.size, status: 'stored', error: '', superseded: false, supersededAt: null }] });
      return json(201, { ok: true, duplicate: false, dialogId: 1, messageId: id, jobId: 'cb:900', deliveryStatus: 'pending', deliveryError: '', requestId: upload.requestId, upload: view(upload) });
    }
    return null;
  };
  return srv;
}
async function openOwner(page, ref) {
  await page.goto(`${APP}/cabinet/palitra-work.html`);
  await page.locator('#pw-main').waitFor();
  await page.locator('#tab-chat').click();
  const list = ref.startsWith('thread') ? '#threads-list' : '#dialogs-list';
  await page.locator(`${list} [data-ref="${ref}"]`).click();
}

test('U5. Владелец: файл в чат сайта и файл в прежний диалог — prepare и байты своими маршрутами с CSRF кабинета; ссылки скачивания своей переписки; HTML владельца не менялся', async () => {
  const srv = ownerServer();
  await withPage({ router: srv.route }, async ({ page }) => {
    await openOwner(page, 'thread:1');
    await page.waitForFunction(() => document.getElementById('chat-title').textContent === 'Заявка №31 · чат на сайте');
    assert.equal(await page.locator('#composer input[type=file]#composer-file').count(), 1, 'выбор файла смонтирован в существующую форму');
    assert.match(await page.locator('#chat-note').textContent(), /один файл до 20 МБ/);
    await page.locator('#composer-file').setInputFiles({ name: 'счёт.pdf', mimeType: 'application/pdf', buffer: PDF });
    await fileReady(page, 'composer-file-name', 'счёт.pdf');
    await page.locator('#composer-send').click();
    await page.waitForFunction(() => document.getElementById('composer-state').textContent.includes('Файл сохранён в чате на сайте'));
    const [threadPrepare] = srv.prepares;
    assert.deepEqual([threadPrepare.scope, threadPrepare.body.caption, threadPrepare.body.sha256, threadPrepare.headers['x-csrf-token']], ['customer-threads', '', sha(PDF), OWNER.csrfToken]);
    assert.deepEqual([srv.bytes[0].scope, Buffer.compare(srv.bytes[0].buffer, PDF), srv.bytes[0].headers['content-type'], srv.bytes[0].headers['x-csrf-token']],
      ['customer-threads', 0, 'application/octet-stream', OWNER.csrfToken]);
    const threadRef = srv.bytes[0].ref;
    await page.locator('#chat-messages [data-key="thread:51"] a.pw-msg__file').waitFor();
    assert.equal(await page.locator('#chat-messages [data-key="thread:51"] a.pw-msg__file').getAttribute('href'), `/content/palitra/customer-threads/1/attachments/${threadRef}`);
    // Прежний диалог бота — тот же выбор файла, свой маршрут и ссылка файла именно этого диалога.
    await page.evaluate(() => document.getElementById('chat-back').click());
    await page.locator('#dialogs-list [data-ref="legacy:1"]').click();
    await page.waitForFunction(() => document.getElementById('chat-title').textContent === 'Клиент бота');
    assert.equal(await page.locator('#composer-file-name').textContent(), 'Файл не выбран', 'выбор файла другой переписки не переносится');
    await page.locator('#composer-text').fill('Счёт во вложении');
    await page.locator('#composer-file').setInputFiles({ name: 'счёт.pdf', mimeType: 'application/pdf', buffer: PDF });
    await fileReady(page, 'composer-file-name', 'счёт.pdf');
    await page.locator('#composer-send').click();
    await page.waitForFunction(() => document.getElementById('composer-state').textContent.includes('Файл поставлен в очередь'));
    assert.deepEqual([srv.prepares[1].scope, srv.prepares[1].body.caption, srv.bytes[1].scope], ['client-dialogs', 'Счёт во вложении', 'client-dialogs']);
    assert.equal(await page.locator('#composer-text').inputValue(), '');
    const legacyRef = srv.bytes[1].ref;
    await page.locator('#chat-messages [data-key="legacy:52"] a.pw-msg__file').waitFor();
    assert.equal(await page.locator('#chat-messages [data-key="legacy:52"] a.pw-msg__file').getAttribute('href'), `/content/palitra/client-dialogs/1/attachments/${legacyRef}`);
    const pending = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('palitra-work-unknown-reply')).map((k) => sessionStorage.getItem(k)));
    assert.deepEqual(pending, [], 'после точных квитанций незавершённых записей нет');
  });
  assert.match(fs.readFileSync(path.join(DIR, 'palitra-work.html'), 'utf8'), /<form class="pw-composer" id="composer" novalidate>/);
});

test('U6. Владелец: загрузки не включены — выбора файла нет, текстовый ответ как раньше', async () => {
  const srv = ownerServer({ enabled: false });
  await withPage({ router: srv.route }, async ({ page }) => {
    await openOwner(page, 'thread:1');
    await page.waitForFunction(() => document.getElementById('chat-title').textContent === 'Заявка №31 · чат на сайте');
    assert.equal(await page.locator('input[type=file]').count(), 0);
    assert.match(await page.locator('#chat-note').textContent(), /только текст/);
  });
});
