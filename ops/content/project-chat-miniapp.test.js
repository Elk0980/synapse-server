'use strict';

/* Telegram Mini App: подпись Telegram (Ed25519), TTL и повтор initData, коды привязки,
   узкая room-сессия участника и её отзыв. Тестовая пара ключей передаётся только фабрике
   в этом файле; server.js такой параметр не пробрасывает.
   node --test ops/content/project-chat-miniapp.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat } = require('./project-chat');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 1)]);
const ROOM = 'palitra-love';
const OTHER = 'alvi';
const OWNER_ID = 1;
const BOT_ID = '777000';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_HEX = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const DARIA_TG = 5001;

const requireSession = (request) => {
  if (!request.session) throw Object.assign(new Error('Требуется вход в кабинет'), { status: 401 });
  return request.session;
};
const requireCsrf = (request, session) => {
  if (String(request.headers['x-csrf-token'] || '') !== session.csrf) throw Object.assign(new Error('Некорректный CSRF-токен'), { status: 403 });
};
const sendJson = (response, status, payload, headers) => { response.statusCode = status; response.payload = payload; response.headers = headers; };
const readBody = async (request) => request.body;

function setup({ botId = BOT_ID, publicKeyHex = PUBLIC_HEX } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-miniapp-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  const clock = { offset: 0, get now() { return Date.now() + this.offset; }, tick(ms) { this.offset += ms; } };
  const chat = createProjectChat({ db, authStore, assetsDir: dir, runnerUrl: '', chatApiKey: '',
    requireSession, requireCsrf, sendJson, readBody, fetchImpl: async () => { throw new Error('нет службы'); },
    miniApp: { botId, sessionSecret: 'test-session-secret', publicKeyHex, now: () => clock.now } });
  const session = (id) => ({ user: authStore.getById(id), csrf: `csrf-${id}` });
  const person = (login, companies) => authStore.create(OWNER_ID, { login, displayName: login, password: 'x'.repeat(12), companies, permissions: [] }, HASH);
  return { db, authStore, chat, clock, session, person, owner: session(OWNER_ID) };
}
/* initData в формате Telegram: подпись Ed25519 над bot_id:WebAppData + отсортированные пары.
   auth_date по умолчанию уникален для каждого вызова: одинаковые строки — это уже повтор входа. */
let sequence = 0;
/* project — подписанный start_param (ссылка проекта); null — открытие без ссылки проекта. */
function initData({ user = { id: DARIA_TG, first_name: 'Дарья' }, authDate = Math.floor(Date.now() / 1000) - (sequence++ % 250), botId = BOT_ID, key = privateKey, project = ROOM, extra = {}, raw = null } = {}) {
  const params = { auth_date: String(authDate), query_id: 'AAHdF6IQAAAAAN0XohDhrOrc', user: JSON.stringify(user), ...(project ? { start_param: project } : {}), ...extra };
  const data = `${botId}:WebAppData\n${Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('\n')}`;
  const signature = crypto.sign(null, Buffer.from(data, 'utf8'), key).toString('base64url');
  return `${new URLSearchParams({ ...params, hash: 'ab'.repeat(32), signature }).toString()}${raw || ''}`;
}
async function call(chat, { session = null, method = 'GET', url, body, bytes, headers = {} }) {
  const request = bytes ? Readable.from([bytes]) : {};
  request.method = method;
  request.headers = { ...(session && method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}), ...headers };
  request.session = session;
  request.body = body;
  const response = { statusCode: 0, payload: null, headers: null, raw: null,
    writeHead(status, head) { this.statusCode = status; this.headers = head; }, end(data) { this.raw = data; } };
  await chat.handle(request, response, new URL(`http://x${url}`));
  return response;
}
async function post(chat, body, { method = 'POST' } = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = method; request.headers = {};
  const response = { statusCode: 0, payload: null };
  await chat.miniApp.handle(request, response, new URL('http://x/content/project-chat-miniapp/session'));
  return response;
}
const room = (suffix = '', code = ROOM) => `/content/project-chat/${code}${suffix}`;
const status = (value) => (error) => error.status === value;
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const addMember = (chat, owner, ids, code = ROOM) => call(chat, { session: owner, method: 'PUT', url: room('/members', code), body: { userIds: ids } });
const linkDaria = async ({ chat, owner, person }, { tg = DARIA_TG, member = true } = {}) => {
  const daria = person('daria', [ROOM]);
  if (member) await addMember(chat, owner, [daria.id]);
  const unlinked = await post(chat, { initData: initData({ user: { id: tg, first_name: 'Дарья' } }) });
  assert.equal(unlinked.statusCode, 403);
  const linked = await call(chat, { session: owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: unlinked.payload.linkCode, userId: daria.id } });
  assert.equal(linked.statusCode, 201);
  // Новое открытие Mini App — новые данные входа (auth_date уникален по умолчанию).
  const opened = await post(chat, { initData: initData({ user: { id: tg, first_name: 'Дарья' } }) });
  assert.equal(opened.statusCode, 200);
  return { daria, token: opened.payload.token, opened: opened.payload };
};

test('подпись Telegram: только правильный ключ, бот, срок и форма данных; без bot id вход отключён', async () => {
  const { chat, clock } = setup();
  const good = initData();
  assert.equal(chat.miniApp.verifyInitData(good).telegramUserId, String(DARIA_TG));
  const { privateKey: stranger } = crypto.generateKeyPairSync('ed25519');
  for (const [name, raw] of [
    ['чужой ключ', initData({ key: stranger })],
    ['чужой бот', initData({ botId: '1' })],
    ['подмена пользователя', good.replace(encodeURIComponent(String(DARIA_TG)), encodeURIComponent('9999'))],
    ['дубль параметра', initData({ raw: `&user=${encodeURIComponent(JSON.stringify({ id: 9999, first_name: 'X' }))}` })],
    ['без подписи', new URLSearchParams({ auth_date: '1', user: '{"id":1}' }).toString()],
    ['user.id не число', initData({ user: { id: '5001', first_name: 'Дарья' } })],
    ['user.id ноль', initData({ user: { id: 0 } })],
    ['user.id дробный', initData({ user: { id: 1.5 } })],
    ['слишком старые', initData({ authDate: Math.floor(Date.now() / 1000) - 301 })],
    ['из будущего', initData({ authDate: Math.floor(Date.now() / 1000) + 61 })],
    ['пусто', ''],
    ['огромный', `${good}&pad=${'x'.repeat(17000)}`],
  ]) assert.throws(() => chat.miniApp.verifyInitData(raw), status(401), name);
  // Срок считается серверными часами: через 6 минут те же данные уже не принимаются.
  clock.tick(6 * 60000);
  assert.throws(() => chat.miniApp.verifyInitData(good), (error) => error.status === 401 && error.state === 'expired');
  const off = setup({ botId: '' });
  await assert.rejects(() => post(off.chat, { initData: initData() }).then((r) => { if (r.statusCode !== 200) throw Object.assign(new Error(r.payload.error), { status: r.statusCode }); }), status(503));
  assert.equal(off.chat.miniApp.enabled, false);
  assert.ok(off.chat.miniApp.issues.some((issue) => issue.includes('TELEGRAM_BOT_ID')));
  assert.equal(setup({ botId: 'abc' }).chat.miniApp.enabled, false);
  // Транспорт: только POST, JSON-объект, ограниченный размер.
  assert.equal((await post(chat, { initData: 'x' })).statusCode, 401);
  await assert.rejects(() => post(chat, { initData: 'x' }, { method: 'GET' }), status(405));
  await assert.rejects(() => post(chat, { initData: 'x'.repeat(21000) }), status(413));
});

test('одноразовость входа считается по подписанным данным: перестановка, перекодирование и правка hash — повтор', async () => {
  const { chat } = setup();
  const raw = initData({ user: { id: DARIA_TG, first_name: 'Дарья Ф.' }, extra: { chat_type: 'supergroup' } });
  assert.equal((await post(chat, { initData: raw })).statusCode, 403, 'первый вход принят (код привязки)');
  const params = [...new URLSearchParams(raw)];
  const variants = {
    'перестановка параметров': new URLSearchParams(params.slice().reverse()).toString(),
    'эквивалентное percent-кодирование': raw.replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%7B/g, '%7b'),
    'другой неподписанный hash': raw.replace(/hash=[0-9a-f]+/, 'hash=' + 'cd'.repeat(32)),
    'без hash': new URLSearchParams(params.filter(([key]) => key !== 'hash')).toString(),
    'hash в другом месте и с пробелом в имени как +': new URLSearchParams([['hash', '00'], ...params.filter(([key]) => key !== 'hash')]).toString(),
  };
  for (const [name, variant] of Object.entries(variants)) {
    assert.notEqual(variant, raw, name);
    assert.equal(chat.miniApp.verifyInitData(variant).nonce, chat.miniApp.verifyInitData(raw).nonce, `${name}: та же подписанная информация`);
    const replayed = await post(chat, { initData: variant });
    assert.deepEqual([replayed.statusCode, replayed.payload.state], [409, 'replayed'], name);
  }
  // Подпись, срок и дубли параметров не ослаблены: испорченный вариант отвергается, а не считается повтором.
  const tampered = raw.replace('query_id=AAHdF6IQAAAAAN0XohDhrOrc', 'query_id=AAHdF6IQAAAAAN0XohDhrOrX');
  assert.notEqual(tampered, raw);
  assert.equal((await post(chat, { initData: tampered })).statusCode, 401);
  assert.equal((await post(chat, { initData: `${raw}&chat_type=private` })).statusCode, 401);
  // Новые подписанные данные (другой auth_date) — новый вход, тот же действующий код.
  const fresh = await post(chat, { initData: initData({ user: { id: DARIA_TG, first_name: 'Дарья Ф.' } }) });
  assert.equal(fresh.statusCode, 403);
  assert.equal(fresh.payload.state, 'unlinked');
});

test('непривязанный участник получает код; привязать может только владелец и только к участнику комнаты', async () => {
  const state = setup();
  const { chat, owner, person, session, clock } = state;
  const daria = person('daria', [ROOM]);
  const raw = initData();
  const first = await post(chat, { initData: raw });
  assert.equal(first.statusCode, 403);
  assert.equal(first.payload.state, 'unlinked');
  assert.equal(first.payload.project, ROOM);
  assert.match(first.payload.linkCode, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.ok(Date.parse(first.payload.expiresAt) > clock.now);
  assert.ok(!JSON.stringify(first.payload).includes('5001'), 'ответ не раскрывает Telegram ID');
  // Тот же initData второй раз — повтор; новое открытие возвращает тот же действующий код.
  const replayed = await post(chat, { initData: raw });
  assert.deepEqual([replayed.statusCode, replayed.payload.state], [409, 'replayed']);
  const again = await post(chat, { initData: initData() });
  assert.equal(again.payload.linkCode, first.payload.linkCode);
  // Код виден владельцу в комнате из подсказки и не виден в другой; участнику список недоступен.
  await addMember(chat, owner, [daria.id]);
  const mine = await call(chat, { session: owner, url: room('/telegram-links') });
  assert.deepEqual(mine.payload.pending.map((p) => [p.firstName, p.code]), [['Дарья', first.payload.linkCode]]);
  assert.deepEqual((await call(chat, { session: owner, url: room('/telegram-links', OTHER) })).payload.pending, []);
  await assert.rejects(() => call(chat, { session: session(daria.id), url: room('/telegram-links') }), status(403));
  // Привязка: не участник → 400, чужая комната → 404, неизвестный код → 404, участник → 201.
  const anna = person('anna', [ROOM]);
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: first.payload.linkCode, userId: anna.id } }), status(400));
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/telegram-links', OTHER), body: { linkCode: first.payload.linkCode, userId: daria.id } }), status(404));
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: 'ZZZZZZ', userId: daria.id } }), status(404));
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: first.payload.linkCode, userId: daria.id, extra: 1 } }), status(400));
  const linked = await call(chat, { session: owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: first.payload.linkCode.toLowerCase(), userId: daria.id } });
  assert.equal(linked.statusCode, 201);
  assert.deepEqual(linked.payload.links.map((l) => [l.userId, l.telegramUserId]), [[daria.id, String(DARIA_TG)]]);
  assert.deepEqual(linked.payload.pending, [], 'использованный код исчезает из ожидающих');
  // Ранее использованные данные входа не открывают чат и после привязки: нужно новое открытие.
  assert.equal((await post(chat, { initData: raw })).statusCode, 409);
  const opened = await post(chat, { initData: initData() });
  assert.equal(opened.statusCode, 200);
  assert.match(opened.payload.token, /^room\./);
  assert.equal(opened.payload.startParam, ROOM, 'подписанный проект возвращается как подсказка выбора');
  assert.deepEqual(opened.payload.companies.map((c) => c.code), [ROOM]);
  assert.ok(opened.payload.companies[0].title);
  assert.deepEqual(opened.payload.identity, { userId: daria.id, displayName: 'daria', role: 'member' });
  assert.ok(!JSON.stringify(opened.payload).includes('csrf'));
  // Повторные коды ограничены: пока код действует, он возвращается тот же; новых — не больше двадцати в сутки.
  const stranger = { id: 6002, first_name: 'Гость' };
  const codes = new Set();
  for (let round = 0; round < 20; round++) {
    const issued = await post(chat, { initData: initData({ user: stranger, authDate: Math.floor(clock.now / 1000) }) });
    assert.equal(issued.statusCode, 403);
    codes.add(issued.payload.linkCode);
    clock.tick(16 * 60000);
  }
  assert.equal(codes.size, 20, 'после истечения выдаётся новый код');
  assert.equal((await post(chat, { initData: initData({ user: stranger, authDate: Math.floor(clock.now / 1000) }) })).statusCode, 429);
  // Привязанный, но не участник ни одной комнаты — честный отказ без кода.
  const boris = person('boris', [OTHER]);
  const borisCode = await post(chat, { initData: initData({ user: { id: 7003, first_name: 'Борис' }, project: OTHER, authDate: Math.floor(clock.now / 1000) }) });
  await addMember(chat, owner, [boris.id], OTHER);
  await call(chat, { session: owner, method: 'POST', url: room('/telegram-links', OTHER), body: { linkCode: borisCode.payload.linkCode, userId: boris.id } });
  await call(chat, { session: owner, method: 'PUT', url: room('/members', OTHER), body: { userIds: [] } });
  const noRooms = await post(chat, { initData: initData({ user: { id: 7003, first_name: 'Борис' }, authDate: Math.floor(clock.now / 1000) - 1 }) });
  assert.deepEqual([noRooms.statusCode, noRooms.payload.state], [403, 'no_rooms']);
  assert.equal(noRooms.payload.linkCode, undefined);
});

test('код привязки принадлежит ровно проекту из подписанной ссылки: без проекта кода нет, чужая комната его не видит и не применяет', async () => {
  const { chat, db, owner, person } = setup();
  const daria = person('daria', [ROOM, OTHER]);
  await addMember(chat, owner, [daria.id]);
  await addMember(chat, owner, [daria.id], OTHER);
  // Без подписанного проекта, с неизвестным проектом или с незаверенной подсказкой в теле — честный отказ без кода.
  for (const body of [
    { initData: initData({ project: null }) },
    { initData: initData({ project: 'nope' }) },
    { initData: initData({ project: null }), startParam: ROOM },
  ]) {
    const denied = await post(chat, body);
    assert.deepEqual([denied.statusCode, denied.payload.state, denied.payload.linkCode], [403, 'no_project', undefined]);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_miniapp_link_codes').get().n, 0, 'кодов без проекта не создаётся');
  // Код для Palitra виден только в Palitra и применим только там.
  const palitra = await post(chat, { initData: initData() });
  assert.equal(palitra.payload.project, ROOM);
  assert.deepEqual((await call(chat, { session: owner, url: room('/telegram-links') })).payload.pending.map((p) => p.code), [palitra.payload.linkCode]);
  assert.deepEqual((await call(chat, { session: owner, url: room('/telegram-links', OTHER) })).payload.pending, []);
  await assert.rejects(() => call(chat, { session: owner, method: 'POST', url: room('/telegram-links', OTHER), body: { linkCode: palitra.payload.linkCode, userId: daria.id } }), status(404));
  // Тот же Telegram открывает ссылку другого проекта: новый код, прежний не возвращается и не меняется.
  const alvi = await post(chat, { initData: initData({ project: OTHER }) });
  assert.equal(alvi.payload.project, OTHER);
  assert.notEqual(alvi.payload.linkCode, palitra.payload.linkCode);
  const palitraPending = (await call(chat, { session: owner, url: room('/telegram-links') })).payload.pending;
  assert.deepEqual(palitraPending.map((p) => [p.code, p.expiresAt]), [[palitra.payload.linkCode, palitra.payload.expiresAt]]);
  assert.deepEqual((await call(chat, { session: owner, url: room('/telegram-links', OTHER) })).payload.pending.map((p) => p.code), [alvi.payload.linkCode]);
  // Повторное открытие той же ссылки возвращает тот же код своего проекта.
  assert.equal((await post(chat, { initData: initData({ project: OTHER }) })).payload.linkCode, alvi.payload.linkCode);
  // Привязка в своей комнате; после неё вход открывает обе комнаты, подсказка — из подписанной ссылки.
  assert.equal((await call(chat, { session: owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: palitra.payload.linkCode, userId: daria.id } })).statusCode, 201);
  const opened = await post(chat, { initData: initData({ project: OTHER }) });
  assert.equal(opened.statusCode, 200);
  assert.deepEqual(opened.payload.companies.map((c) => c.code).sort(), [OTHER, ROOM]);
  assert.equal(opened.payload.startParam, OTHER);
  assert.equal((await post(chat, { initData: initData({ project: null }) })).payload.startParam, null, 'без ссылки проекта подсказки нет');
});

test('room-сессия: права участника, тот же ACL для вложений, владельческие маршруты закрыты, cookie не подменяет токен', async () => {
  const state = setup();
  const { chat, db, owner, person, session } = state;
  const { daria, token } = await linkDaria(state);
  const view = await call(chat, { url: room(), headers: bearer(token) });
  assert.equal(view.statusCode, 200);
  assert.deepEqual([view.payload.access.owner, view.payload.access.canReply, view.payload.ai.runtimeError], [false, true, '']);
  // Сообщение и вложение без CSRF, но с токеном; файл читается тем же маршрутом и тем же ACL.
  const said = await call(chat, { method: 'POST', url: room('/messages'), headers: bearer(token), body: { text: 'Из Telegram', clientMessageId: 'tg-00001' } });
  assert.equal(said.statusCode, 201);
  assert.equal(said.payload.message.authorName, 'daria');
  const uploaded = await call(chat, { method: 'POST', url: room('/attachments'), bytes: PNG, headers: { ...bearer(token), 'x-filename': 'photo.png', 'content-type': 'image/png' } });
  assert.equal(uploaded.statusCode, 201);
  const file = await call(chat, { url: room(`/attachments/${uploaded.payload.attachment.id}`), headers: bearer(token) });
  assert.equal(file.statusCode, 200);
  assert.deepEqual(file.raw, PNG);
  await assert.rejects(() => call(chat, { url: room(`/attachments/${uploaded.payload.attachment.id}`, OTHER), headers: bearer(token) }), status(403));
  const task = await call(chat, { method: 'POST', url: room('/tasks'), headers: bearer(token), body: { title: 'Афиша', assigneeId: daria.id, status: 'in_progress' } });
  assert.equal(task.statusCode, 201);
  // Владельческие маршруты закрыты для room-сессии, чужая компания — тоже.
  for (const request of [
    { method: 'PATCH', url: room('/settings'), body: { replyMode: 'delegate' } },
    { method: 'PUT', url: room('/members'), body: { userIds: [] } },
    { url: room('/candidates') },
    { method: 'POST', url: room('/retry-ai'), body: {} },
    { url: room('/telegram-links') },
    { method: 'DELETE', url: room(`/telegram-links/${DARIA_TG}`) },
    { url: room('', OTHER) },
  ]) await assert.rejects(() => call(chat, { ...request, headers: bearer(token) }), status(request.url.includes(OTHER) ? 403 : 403), request.url);
  // Поддельный, чужой или пустой токен не откатывается к cookie владельца: 401, даже с сессией кабинета.
  const [head, payload] = token.split('.').slice(0, 2);
  const forged = `${head}.${payload}.${'A'.repeat(43)}`;
  await assert.rejects(() => call(chat, { url: room(), headers: bearer(forged) }), status(401));
  await assert.rejects(() => call(chat, { session: owner, url: room(), headers: bearer(forged) }), status(401));
  await assert.rejects(() => call(chat, { session: owner, url: room(), headers: bearer('room.a.b') }), status(401));
  await assert.rejects(() => call(chat, { session: owner, url: room(), headers: { authorization: 'Bearer not-a-room-token' } }), status(401));
  // Владелец через Mini App — тоже участник: настройки и привязки для него закрыты.
  const ownerCode = await post(chat, { initData: initData({ user: { id: 1001, first_name: 'Влад' } }) });
  await call(chat, { session: owner, method: 'POST', url: room('/telegram-links'), body: { linkCode: ownerCode.payload.linkCode, userId: OWNER_ID } });
  const ownerOpened = await post(chat, { initData: initData({ user: { id: 1001, first_name: 'Влад' }, authDate: Math.floor(Date.now() / 1000) - 3 }) });
  assert.equal(ownerOpened.statusCode, 200);
  assert.ok(ownerOpened.payload.companies.length > 1, 'владелец состоит во всех комнатах');
  const ownerView = await call(chat, { url: room(), headers: bearer(ownerOpened.payload.token) });
  assert.equal(ownerView.payload.access.owner, false);
  await assert.rejects(() => call(chat, { method: 'PATCH', url: room('/settings'), headers: bearer(ownerOpened.payload.token), body: { replyMode: 'delegate' } }), status(403));
  // Обычный путь кабинета не изменился.
  assert.equal((await call(chat, { session: owner, url: room() })).payload.access.owner, true);
  assert.equal((await call(chat, { session: session(daria.id), url: room() })).payload.access.owner, false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM project_chat_messages WHERE author_type='human'").get().n, 1);
});

test('отзыв: отвязка, исключение из участников, смена пароля и срок токена закрывают room-сессию сразу', async () => {
  const state = setup();
  const { chat, authStore, owner, clock } = state;
  const { daria, token } = await linkDaria(state);
  assert.equal((await call(chat, { url: room(), headers: bearer(token) })).statusCode, 200);
  // Исключение из участников: 403; возврат — снова работает тем же токеном.
  await addMember(chat, owner, []);
  await assert.rejects(() => call(chat, { url: room(), headers: bearer(token) }), status(403));
  await addMember(chat, owner, [daria.id]);
  assert.equal((await call(chat, { url: room(), headers: bearer(token) })).statusCode, 200);
  // Отвязка владельцем — токен недействителен на следующем же запросе; чужой ID — 404.
  await assert.rejects(() => call(chat, { session: owner, method: 'DELETE', url: room('/telegram-links/999') }), status(404));
  const unlinked = await call(chat, { session: owner, method: 'DELETE', url: room(`/telegram-links/${DARIA_TG}`) });
  assert.deepEqual([unlinked.statusCode, unlinked.payload.links], [200, []]);
  await assert.rejects(() => call(chat, { url: room(), headers: bearer(token) }), status(401));
  // Повторная привязка выдаёт новый токен; старый остаётся отозванным (версия привязки выросла).
  const fresh = await linkDaria({ ...state, person: () => daria });
  assert.equal((await call(chat, { url: room(), headers: bearer(fresh.token) })).statusCode, 200);
  await assert.rejects(() => call(chat, { url: room(), headers: bearer(token) }), status(401));
  // Смена пароля и истечение 12 часов.
  authStore.updatePassword(OWNER_ID, daria.id, HASH);
  await assert.rejects(() => call(chat, { url: room(), headers: bearer(fresh.token) }), status(401));
  const relogin = await post(chat, { initData: initData({ authDate: Math.floor(clock.now / 1000) - 4 }) });
  assert.equal(relogin.statusCode, 200);
  clock.tick(12 * 3600000 + 1000);
  await assert.rejects(() => call(chat, { url: room(), headers: bearer(relogin.payload.token) }), status(401));
});
