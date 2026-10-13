'use strict';
/* Синтетические проверки доступа к измерениям MAX (specs/094-max-native-analytics, SC001).
   Сети нет: fetch подменён, ответы — сырой JSON с int64 вне точности Number. База — SQLite
   в памяти (без временных каталогов), закрывается после каждого теста. Это не доказательство
   работы с настоящим MAX (SC002) — только локальные контрактные границы модуля. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createSocialMaxAccess, maxChatRef, normalizeMaxId, MAX_PROVIDER, MAX_API_ORIGIN} = require('./social-max-access.js');

const NOW = Date.parse('2026-10-13T08:00:00.000Z');
const TOKEN = 'max-token-ALVI-0123456789abcdef';
const TOKEN_B = 'max-token-AVOCADO-fedcba9876543210';
const CHAT = '-72000000000000001';
// Соседнее значение: как Number оба превращаются в -72000000000000000.
const CHAT_NEIGHBOUR = '-72000000000000000';
const CHAT_B = '-72000000000000003';
const BOT = '9007199254740993';
const BOT_NEIGHBOUR = '9007199254740992';
const DTO_KEYS = ['companyCode', 'provider', 'configured', 'status', 'statusCode', 'revision', 'checked',
  'channelConfirmed', 'channelId', 'channelAccountRef', 'checkedAt', 'channelReason'];

/* Небольшой двойник существующего склада social_analytics_credentials. Повторяет наблюдаемый
   контракт: новый ключ увеличивает ревизию и сбрасывает проверку, пустое сохранение увеличивает
   ревизию без смены ключа, checked только при checked_revision === revision и status connected,
   markChecked — CAS по ревизии с флагом applied, resolve отдаёт unreadable для конверта, который
   не открывается под AAD этой компании и провайдера. Настоящее AES-GCM здесь не воспроизводится. */
function credentialStub(db, now) {
  db.exec(`CREATE TABLE stub_analytics_credentials (
    company_code TEXT NOT NULL COLLATE NOCASE, provider TEXT NOT NULL,
    sealed TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, checked_revision INTEGER,
    status TEXT NOT NULL DEFAULT 'not_configured', status_code TEXT NOT NULL DEFAULT '', checked_at TEXT,
    PRIMARY KEY(company_code, provider));`);
  const aad = (company, provider) => `synapse/social-analytics/v1/${company}/${provider}`;
  const rowOf = (company, provider) => db.prepare(
    'SELECT * FROM stub_analytics_credentials WHERE company_code=? AND provider=?').get(company, provider);
  const store = {
    providers: [],
    get(company, provider) {
      store.providers.push(provider);
      const row = rowOf(company, provider);
      return {companyCode: company, provider, configured: Boolean(row?.sealed),
        status: row?.status || 'not_configured', statusCode: row?.status_code || '',
        revision: row?.revision ?? 0, checkedRevision: row?.checked_revision ?? null,
        checked: Boolean(row && row.checked_revision !== null && row.checked_revision === row.revision && row.status === 'connected'),
        checkedAt: row?.checked_at || null};
    },
    save(company, provider, token) {
      if (!token) {
        db.prepare('UPDATE stub_analytics_credentials SET revision=revision+1 WHERE company_code=? AND provider=?')
          .run(company, provider);
        return;
      }
      const sealed = JSON.stringify({v: 1, aad: aad(company, provider), data: Buffer.from(token).toString('base64')});
      db.prepare(`INSERT INTO stub_analytics_credentials(company_code,provider,sealed,revision,checked_revision,status,status_code,checked_at)
        VALUES(?,?,?,1,NULL,'unchecked','',NULL) ON CONFLICT(company_code,provider) DO UPDATE SET sealed=excluded.sealed,
        revision=stub_analytics_credentials.revision+1,checked_revision=NULL,status='unchecked',status_code='',checked_at=NULL`)
        .run(company, provider, sealed);
    },
    // Конверт чужой компании: под AAD этой компании он не открывается.
    corrupt(company, provider) {
      const sealed = JSON.stringify({v: 1, aad: aad('other', provider), data: ''});
      db.prepare('UPDATE stub_analytics_credentials SET sealed=? WHERE company_code=? AND provider=?').run(sealed, company, provider);
    },
    resolve(company, provider) {
      store.providers.push(provider);
      const row = rowOf(company, provider);
      if (!row || !row.sealed) return null;
      const envelope = JSON.parse(row.sealed);
      if (envelope.aad !== aad(company, provider))
        return {companyCode: company, provider, revision: row.revision, credential: null, unreadable: true};
      return {companyCode: company, provider, revision: row.revision,
        credential: Buffer.from(envelope.data, 'base64').toString('utf8'), unreadable: false};
    },
    markChecked(company, provider, {revision, status, code = ''} = {}) {
      store.providers.push(provider);
      const changes = db.prepare(`UPDATE stub_analytics_credentials
        SET status=?,status_code=?,checked_revision=CASE WHEN ?='connected' THEN revision ELSE NULL END,checked_at=?
        WHERE company_code=? AND provider=? AND revision=?`)
        .run(status, String(code || '').slice(0, 60), status, new Date(now()).toISOString(), company, provider, revision).changes;
      return {...store.get(company, provider), applied: Boolean(changes)};
    },
    connectionRevision(company, provider) {
      const row = rowOf(company, provider);
      return row && row.sealed ? {revision: row.revision, provider} : null;
    },
  };
  return store;
}

const reply = (text, status = 200, headers = {}) =>
  new Response(text, {status, headers: {'content-type': 'application/json', ...headers}});
// Сырые ответы MAX: лишние поля (имена, описание, владелец, участники) обязаны отбрасываться.
const chatRaw = (input = {}) => { const {id = CHAT, type = '"channel"', status = '"active"', participants = '1234'} = input; const messages = Object.hasOwn(input,'messages') ? input.messages : '321'; return (
`{"chat_id":${id},"type":${type},"status":${status},"last_event_time":1760000000000,"participants_count":${participants},`
  + `"is_public":true,"title":"Название канала","description":"Описание канала","owner_id":555,`
  + `"participants":{"777":1760000000000},"link":"https://max.ru/example"${messages === undefined ? '' : `,"messages_count":${messages}`}}`); };
const meRaw = ({id = BOT, isBot = 'true'} = {}) =>
  `{"user_id":${id},"first_name":"Бот аналитики","username":"analytics_bot","is_bot":${isBot},"last_activity_time":1760000000000}`;
const memberRaw = ({id = BOT, isBot = 'true', isAdmin = 'true'} = {}) =>
  `{"user_id":${id},"first_name":"Бот аналитики","is_bot":${isBot},"is_admin":${isAdmin},"is_owner":false,`
  + `"last_access_time":1,"join_time":1,"permissions":["read_all_messages","write"]}`;
const messageRaw = (input = {}) => { const {chat = CHAT, type = '"channel"', mid = '"mid_1"', ts = '1760000000123'} = input; const stat = Object.hasOwn(input,'stat') ? input.stat : '{"views":42}'; return (
`{"sender":{"user_id":444,"first_name":"Автор","is_bot":false},"recipient":{"chat_id":${chat},"chat_type":${type},"user_id":null},`
  + `"timestamp":${ts},"body":{"mid":${mid},"seq":115000000000000001,"text":"Текст поста",`
  + `"attachments":[{"type":"image","payload":{"url":"https://files.example/1.jpg"}}]},"url":"https://max.ru/example/1"`
  + `${stat === undefined ? '' : `,"stat":${stat}`}}`); };
const page = (...items) => `{"messages":[${items.join(',')}]}`;

function mockFetch(routes) {
  const calls = [];
  const impl = (url, init) => {
    calls.push({url, init});
    const route = routes[new URL(url).pathname];
    if (!route) return Promise.reject(new TypeError(`unexpected ${url}`));
    return Promise.resolve().then(() => route(new URL(url), init));
  };
  impl.calls = calls;
  return impl;
}

function env(t, {timeoutMs = 500, maxBytes} = {}) {
  const db = new DatabaseSync(':memory:');
  const clock = {value: NOW};
  const store = credentialStub(db, () => clock.value);
  const routes = {
    '/me': () => reply(meRaw()),
    [`/chats/${CHAT}`]: () => reply(chatRaw()),
    [`/chats/${CHAT}/members/me`]: () => reply(memberRaw()),
    [`/chats/${CHAT_B}`]: () => reply(chatRaw({id: CHAT_B})),
    [`/chats/${CHAT_B}/members/me`]: () => reply(memberRaw()),
    '/messages': () => reply(page(messageRaw())),
  };
  const fetchImpl = mockFetch(routes);
  const access = createSocialMaxAccess(db, {credentials: store, fetchImpl, now: () => clock.value, timeoutMs, maxBytes});
  t.after(async () => { await access.stop(); db.close(); });
  return {db, store, routes, fetchImpl, access, clock};
}
async function bind(e, company = 'alvi', chat = CHAT, token = TOKEN) {
  e.store.save(company, MAX_PROVIDER, token);
  return e.access.verify(company, {accountRef: chat, actor: {userId: 7, userName: 'Владелец'}});
}
const bindingRow = (e, company) => e.db.prepare('SELECT * FROM social_max_channels WHERE company_code=?').get(company);
// Ошибка наружу: только наш код и текст, без токена и тела ответа MAX.
function assertSafeError(error, code) {
  assert.equal(error.code, code);
  const text = `${error.message} ${JSON.stringify(error)} ${error.stack}`;
  for (const secret of [TOKEN, TOKEN_B, 'SECRET-UPSTREAM', 'evil.example']) assert.ok(!text.includes(secret), `утечка ${secret}`);
  assert.deepEqual(Object.keys(error).sort(), ['code', 'status']);
  return true;
}
const rejectsWith = (promise, code) => assert.rejects(promise, (error) => assertSafeError(error, code));

test('normalizeMaxId: signed int64 канонической строкой, небезопасный Number и неточные записи отклоняются', () => {
  assert.equal(normalizeMaxId(BOT), BOT);
  assert.equal(normalizeMaxId(CHAT), CHAT);
  assert.equal(normalizeMaxId('-9223372036854775808'), '-9223372036854775808');
  assert.equal(normalizeMaxId('9223372036854775807'), '9223372036854775807');
  assert.equal(normalizeMaxId('9223372036854775808'), null);
  assert.equal(normalizeMaxId('-9223372036854775809'), null);
  assert.equal(normalizeMaxId('-0'), '0');
  assert.equal(normalizeMaxId(123), '123');
  assert.equal(normalizeMaxId(-123n), '-123');
  assert.equal(normalizeMaxId(2 ** 53), null);
  assert.equal(normalizeMaxId(1.5), null);
  for (const bad of ['007', '1e3', '1.0', ' 1', '+1', '', '-', '0x10', {}, null, undefined, true]) assert.equal(normalizeMaxId(bad), null);
  assert.deepEqual(maxChatRef(''), {kind: 'none', key: ''});
  assert.deepEqual(maxChatRef(undefined), {kind: 'none', key: ''});
  assert.deepEqual(maxChatRef(` ${CHAT} `), {kind: 'id', key: CHAT, chatId: CHAT});
  // Ссылку или имя канала без списка GET /chats в chat_id не разрешить — запись не угадывается.
  for (const bad of ['https://max.ru/example', '@example', 'id:-1']) assert.deepEqual(maxChatRef(bad), {kind: 'invalid', key: ''});
  assert.equal(MAX_PROVIDER, 'max_analytics');
  assert.equal(MAX_API_ORIGIN, 'https://platform-api2.max.ru');
});

test('verify: три читающих GET с сырым токеном, int64 без потери точности, безопасный DTO', async (t) => {
  const e = env(t);
  const dto = await bind(e);
  assert.deepEqual(Object.keys(dto).sort(), [...DTO_KEYS].sort());
  assert.equal(dto.channelConfirmed, true);
  assert.equal(dto.channelId, CHAT);
  assert.equal(dto.channelAccountRef, CHAT);
  assert.equal(dto.revision, 1);
  assert.equal(dto.status, 'connected');
  assert.equal(dto.checked, true);
  assert.deepEqual(e.fetchImpl.calls.map((call) => call.url),
    [`${MAX_API_ORIGIN}/me`, `${MAX_API_ORIGIN}/chats/${CHAT}`, `${MAX_API_ORIGIN}/chats/${CHAT}/members/me`]);
  for (const call of e.fetchImpl.calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers.authorization, TOKEN);
    assert.ok(!/bearer/i.test(call.init.headers.authorization));
    assert.ok(!call.url.includes(TOKEN) && !call.url.includes('?'));
    assert.equal(call.init.body, undefined);
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  const text = JSON.stringify(dto);
  for (const hidden of [TOKEN, BOT, 'Бот аналитики', 'analytics_bot', 'Название канала', 'Описание']) assert.ok(!text.includes(hidden));
  const row = bindingRow(e, 'alvi');
  assert.equal(row.chat_id, CHAT);
  assert.equal(row.access_revision, 1);
  assert.equal(row.account_ref, CHAT);
  assert.equal(row.checked_at, new Date(NOW).toISOString());
  assert.equal(row.actor_id, 7);
  assert.ok(e.store.providers.every((provider) => provider === MAX_PROVIDER));
});

test('verify: соседний int64 канала и бота не совпадает, хотя как Number они равны', async (t) => {
  const e = env(t);
  e.routes[`/chats/${CHAT}`] = () => reply(chatRaw({id: CHAT_NEIGHBOUR}));
  e.store.save('alvi', MAX_PROVIDER, TOKEN);
  await rejectsWith(e.access.verify('alvi', {accountRef: CHAT}), 'RESPONSE_SCOPE_MISMATCH');
  // Непонятный ответ не отзывает доступ и ничего не записывает.
  assert.equal(e.store.get('alvi', MAX_PROVIDER).status, 'unchecked');
  assert.equal(bindingRow(e, 'alvi'), undefined);

  e.routes[`/chats/${CHAT}`] = () => reply(chatRaw());
  e.routes[`/chats/${CHAT}/members/me`] = () => reply(memberRaw({id: BOT_NEIGHBOUR}));
  await rejectsWith(e.access.verify('alvi', {accountRef: CHAT}), 'MEMBERSHIP_MISMATCH');
  assert.equal(e.store.get('alvi', MAX_PROVIDER).statusCode, 'MEMBERSHIP_MISMATCH');
  assert.equal(bindingRow(e, 'alvi'), undefined);
});

const DECISIVE_VERIFY = [
  ['не канал', `/chats/${CHAT}`, () => reply(chatRaw({type: '"chat"'})), 'NOT_A_CHANNEL'],
  ['бот удалён из канала', `/chats/${CHAT}`, () => reply(chatRaw({status: '"removed"'})), 'CHANNEL_INACTIVE'],
  ['бот не администратор', `/chats/${CHAT}/members/me`, () => reply(memberRaw({isAdmin: 'false'})), 'NOT_ADMIN'],
  ['членство не бота', `/chats/${CHAT}/members/me`, () => reply(memberRaw({isBot: 'false'})), 'MEMBERSHIP_MISMATCH'],
  ['токен не бота', '/me', () => reply(meRaw({isBot: 'false'})), 'NOT_A_BOT'],
  ['401 токена', '/me', () => reply('{"code":"verify.token","message":"SECRET-UPSTREAM"}', 401), 'ACCESS_DENIED'],
  ['403 канала', `/chats/${CHAT}`, () => reply('{"code":"access.denied","message":"SECRET-UPSTREAM"}', 403), 'ACCESS_DENIED'],
  ['404 членства', `/chats/${CHAT}/members/me`, () => reply('{"message":"SECRET-UPSTREAM"}', 404), 'CHANNEL_NOT_FOUND'],
];
for (const [name, path, route, code] of DECISIVE_VERIFY) {
  test(`verify: постоянная причина «${name}» снимает подтверждение текущей ревизии и не пишет привязку`, async (t) => {
    const e = env(t);
    e.routes[path] = route;
    e.store.save('alvi', MAX_PROVIDER, TOKEN);
    await rejectsWith(e.access.verify('alvi', {accountRef: CHAT}), code);
    const state = e.access.get('alvi');
    assert.equal(state.status, 'error');
    assert.equal(state.statusCode, code);
    assert.equal(state.channelConfirmed, false);
    assert.equal(bindingRow(e, 'alvi'), undefined);
  });
}

test('verify: временный сбой не трогает ранее подтверждённую привязку', async (t) => {
  const e = env(t);
  await bind(e);
  const cases = [
    [() => reply('{"message":"SECRET-UPSTREAM"}', 500), 'UPSTREAM_ERROR'],
    [() => reply('{}', 503), 'UPSTREAM_ERROR'],
    [() => reply('{}', 429), 'RATE_LIMITED'],
    [() => reply('{"user_id":'), 'RESPONSE_UNCERTAIN'],
  ];
  for (const [route, code] of cases) {
    e.routes['/me'] = route;
    await rejectsWith(e.access.verify('alvi', {accountRef: CHAT}), code);
    const state = e.access.get('alvi');
    assert.equal(state.channelConfirmed, true, code);
    assert.equal(state.statusCode, '');
    assert.equal(bindingRow(e, 'alvi').chat_id, CHAT);
  }
});

test('verify: нет записи канала, ссылка вместо chat_id, нечитаемый или отсутствующий доступ — без сети', async (t) => {
  const e = env(t);
  await rejectsWith(e.access.verify('alvi', {accountRef: CHAT}), 'MISSING_ACCESS');
  e.store.save('alvi', MAX_PROVIDER, TOKEN);
  await rejectsWith(e.access.verify('alvi', {accountRef: ''}), 'CHANNEL_REF_REQUIRED');
  assert.equal(e.store.get('alvi', MAX_PROVIDER).statusCode, 'CHANNEL_REF_REQUIRED');
  await rejectsWith(e.access.verify('alvi', {accountRef: 'https://max.ru/example'}), 'CHANNEL_REF_INVALID');
  e.store.corrupt('alvi', MAX_PROVIDER);
  await rejectsWith(e.access.verify('alvi', {accountRef: CHAT}), 'CREDENTIAL_UNREADABLE');
  assert.equal(e.store.get('alvi', MAX_PROVIDER).statusCode, 'CREDENTIAL_UNREADABLE');
  assert.equal(e.fetchImpl.calls.length, 0);
  assert.throws(() => e.access.get('../alvi'), {code: 'NOT_FOUND'});
});

test('verify: новая ревизия во время сети — результат и отказ прежнего токена не применяются', async (t) => {
  const e = env(t);
  e.store.save('alvi', MAX_PROVIDER, TOKEN);
  e.routes[`/chats/${CHAT}/members/me`] = () => { e.store.save('alvi', MAX_PROVIDER, 'max-token-new'); return reply(memberRaw()); };
  await rejectsWith(e.access.verify('alvi', {accountRef: CHAT}), 'REVISION_CONFLICT');
  let state = e.store.get('alvi', MAX_PROVIDER);
  assert.deepEqual([state.revision, state.status, state.checked], [2, 'unchecked', false]);
  assert.equal(bindingRow(e, 'alvi'), undefined);

  // Поздний постоянный отказ старого токена не помечает ошибкой новый сохранённый доступ.
  e.routes[`/chats/${CHAT}/members/me`] = () => { e.store.save('alvi', MAX_PROVIDER, 'max-token-newer'); return reply('{}', 403); };
  await rejectsWith(e.access.verify('alvi', {accountRef: CHAT}), 'REVISION_CONFLICT');
  state = e.store.get('alvi', MAX_PROVIDER);
  assert.deepEqual([state.revision, state.status, state.statusCode], [3, 'unchecked', '']);
});

test('verify: смена записи канала в аккаунте во время проверки отбрасывает результат', async (t) => {
  const e = env(t);
  e.store.save('alvi', MAX_PROVIDER, TOKEN);
  let current = CHAT;
  e.routes[`/chats/${CHAT}/members/me`] = () => { current = CHAT_B; return reply(memberRaw()); };
  await rejectsWith(e.access.verify('alvi', {accountRef: CHAT, accountRefNow: () => current}), 'REVISION_CONFLICT');
  assert.equal(bindingRow(e, 'alvi'), undefined);
  assert.equal(e.store.get('alvi', MAX_PROVIDER).status, 'unchecked');
  await rejectsWith(e.access.verify('alvi', {accountRef: CHAT, accountRefNow: () => { throw new Error(TOKEN); }}), 'REVISION_CONFLICT');
  // Та же запись в другом написании — тот же канал.
  const dto = await e.access.verify('alvi', {accountRef: CHAT, accountRefNow: () => ` ${CHAT} `});
  assert.equal(dto.channelConfirmed, true);
});

test('verify: один канал — одна компания; доступы и отказы компаний не смешиваются', async (t) => {
  const e = env(t);
  await bind(e, 'alvi', CHAT, TOKEN);
  e.store.save('avocado', MAX_PROVIDER, TOKEN_B);
  await rejectsWith(e.access.verify('avocado', {accountRef: CHAT}), 'CHANNEL_TAKEN');
  assert.equal(e.access.get('alvi').channelConfirmed, true);
  assert.equal(e.access.get('avocado').statusCode, 'CHANNEL_TAKEN');
  assert.equal(bindingRow(e, 'avocado'), undefined);

  // Перепривязка alvi на другой канал освобождает первый.
  await e.access.verify('alvi', {accountRef: CHAT_B});
  assert.equal(e.access.get('alvi').channelId, CHAT_B);
  const from = e.fetchImpl.calls.length;
  const dto = await e.access.verify('avocado', {accountRef: CHAT});
  assert.equal(dto.channelId, CHAT);
  assert.ok(e.fetchImpl.calls.slice(from).every((call) => call.init.headers.authorization === TOKEN_B));

  // Отзыв доступа одной компании не трогает другую.
  e.routes[`/chats/${CHAT}`] = () => reply('{}', 401);
  await rejectsWith(e.access.readChannel('avocado'), 'ACCESS_DENIED');
  assert.equal(e.access.get('avocado').channelConfirmed, false);
  assert.equal(e.access.get('avocado').statusCode, 'ACCESS_DENIED');
  assert.equal(e.access.get('alvi').channelConfirmed, true);
  assert.equal(e.access.get('alvi').statusCode, '');
  const calls = e.fetchImpl.calls.length;
  await rejectsWith(e.access.readChannel('avocado'), 'BINDING_UNCONFIRMED');
  assert.equal(e.fetchImpl.calls.length, calls);
});

test('ready и bindingFingerprint: синхронно, без сети и секрета, меняются вместе с ревизией', async (t) => {
  const e = env(t);
  assert.equal(e.access.bindingFingerprint('alvi'), null);
  assert.deepEqual(e.access.ready('alvi'),
    {ok: false, reason: 'доступ к измерениям MAX не сохранён', chatId: '', accountRef: '', accessRevision: 0});
  await bind(e);
  const calls = e.fetchImpl.calls.length;
  const fingerprint = e.access.bindingFingerprint('alvi');
  assert.equal(fingerprint, `max_analytics:1:${CHAT}:${CHAT}:confirmed`);
  assert.ok(!fingerprint.includes(TOKEN));
  assert.deepEqual(e.access.ready('ALVI'), {ok: true, reason: '', chatId: CHAT, accountRef: CHAT, accessRevision: 1});
  e.store.save('alvi', MAX_PROVIDER, '');
  assert.notEqual(e.access.bindingFingerprint('alvi'), fingerprint);
  assert.equal(e.access.ready('alvi').ok, false);
  assert.equal(e.access.ready('alvi').accessRevision, 2);
  assert.equal(e.fetchImpl.calls.length, calls);
  await rejectsWith(e.access.readChannel('alvi'), 'BINDING_UNCONFIRMED');
  assert.equal(e.fetchImpl.calls.length, calls);
});

test('readChannel: только идентичность, тип, состояние и счётчики; время наблюдения — после ответа', async (t) => {
  const e = env(t);
  await bind(e);
  e.routes[`/chats/${CHAT}`] = () => { e.clock.value += 5000; return reply(chatRaw()); };
  const result = await e.access.readChannel('alvi');
  assert.deepEqual(result, {companyCode: 'alvi', chatId: CHAT, accessRevision: 1,
    observedAt: new Date(NOW + 5000).toISOString(),
    data: {chat_id: CHAT, type: 'channel', status: 'active', participants_count: 1234, messages_count: 321}});
  const text = JSON.stringify(result);
  for (const hidden of ['Название', 'Описание', '555', '777', 'max.ru', TOKEN]) assert.ok(!text.includes(hidden));
  // messages_count необязателен: отсутствие или null — не ноль, поле просто не выдаётся.
  for (const messages of [undefined, 'null']) {
    e.routes[`/chats/${CHAT}`] = () => reply(chatRaw({messages}));
    const {data} = await e.access.readChannel('alvi');
    assert.equal(Object.hasOwn(data, 'messages_count'), false);
  }
  e.routes[`/chats/${CHAT}`] = () => reply(chatRaw({participants: '0'}));
  assert.equal((await e.access.readChannel('alvi')).data.participants_count, 0);
});

test('readChannel: испорченные счётчики отклоняются без отзыва привязки', async (t) => {
  const e = env(t);
  await bind(e);
  const broken = [{participants: '-1'}, {participants: '1.5'}, {participants: '1e3'}, {participants: '9007199254740993'},
    {participants: '"1234"'}, {participants: 'null'}, {messages: '-3'}, {messages: '"321"'}, {type: '5'}];
  for (const fields of broken) {
    e.routes[`/chats/${CHAT}`] = () => reply(chatRaw(fields));
    await rejectsWith(e.access.readChannel('alvi'), 'RESPONSE_UNCERTAIN');
  }
  e.routes[`/chats/${CHAT}`] = () => reply(`{"chat_id":${CHAT},"type":"channel","status":"active","participants_count":5,"participants_count":7,"is_public":true,"last_event_time":1}`);
  await rejectsWith(e.access.readChannel('alvi'), 'RESPONSE_UNCERTAIN');
  e.routes[`/chats/${CHAT}`] = () => reply(chatRaw({id: CHAT_NEIGHBOUR}));
  await rejectsWith(e.access.readChannel('alvi'), 'RESPONSE_SCOPE_MISMATCH');
  assert.equal(e.access.get('alvi').channelConfirmed, true);
});

test('readChannel: канал перестал быть активным — снимается только текущая привязка', async (t) => {
  const e = env(t);
  await bind(e);
  e.routes[`/chats/${CHAT}`] = () => reply(chatRaw({status: '"left"'}));
  await rejectsWith(e.access.readChannel('alvi'), 'CHANNEL_INACTIVE');
  const state = e.access.get('alvi');
  assert.deepEqual([state.channelConfirmed, state.statusCode, state.channelId], [false, 'CHANNEL_INACTIVE', '']);
  assert.equal(bindingRow(e, 'alvi').chat_id, '');
});

test('readChannel: смена ревизии во время сети отбрасывает и ответ, и поздний отказ', async (t) => {
  const e = env(t);
  await bind(e);
  e.routes[`/chats/${CHAT}`] = () => { e.store.save('alvi', MAX_PROVIDER, ''); return reply(chatRaw()); };
  await rejectsWith(e.access.readChannel('alvi'), 'REVISION_CONFLICT');

  e.routes[`/chats/${CHAT}`] = () => reply(chatRaw());
  await e.access.verify('alvi', {accountRef: CHAT});
  e.routes[`/chats/${CHAT}`] = () => { e.store.save('alvi', MAX_PROVIDER, ''); return reply('{}', 401); };
  await rejectsWith(e.access.readChannel('alvi'), 'REVISION_CONFLICT');
  const state = e.store.get('alvi', MAX_PROVIDER);
  // Новая ревизия не помечена отказом старой: статус прежний, код пуст.
  assert.deepEqual([state.revision, state.status, state.statusCode], [3, 'connected', '']);
  assert.equal(bindingRow(e, 'alvi').chat_id, CHAT);
});

test('readMessages: только документированные параметры и сохранённый chat_id', async (t) => {
  const e = env(t);
  await bind(e);
  e.routes['/messages'] = () => reply(page(messageRaw(), messageRaw({mid: '"mid_2"', ts: '1760000000000', stat: undefined})));
  const from = e.fetchImpl.calls.length;
  const result = await e.access.readMessages('alvi', {before: 1760000001000, after: 1760000000000, count: 100});
  await e.access.readMessages('alvi', {});
  e.routes['/messages'] = () => reply(page(messageRaw()));
  const known = await e.access.readMessages('alvi', {messageIds: ['mid_1', 'mid_2']});
  assert.deepEqual(e.fetchImpl.calls.slice(from).map((call) => call.url), [
    `${MAX_API_ORIGIN}/messages?chat_id=${CHAT}&before=1760000001000&after=1760000000000&count=100`,
    `${MAX_API_ORIGIN}/messages?chat_id=${CHAT}`,
    `${MAX_API_ORIGIN}/messages?message_ids=mid_1,mid_2`,
  ]);
  assert.deepEqual(result, {companyCode: 'alvi', chatId: CHAT, accessRevision: 1, observedAt: new Date(NOW).toISOString(),
    data: {messages: [
      {recipient: {chat_id: CHAT, chat_type: 'channel'}, timestamp: 1760000000123, body: {mid: 'mid_1'}, stat: {views: 42}},
      {recipient: {chat_id: CHAT, chat_type: 'channel'}, timestamp: 1760000000000, body: {mid: 'mid_2'}, stat: null},
    ]}});
  // Неотданный известный ID просто отсутствует: решение о «missing» принимает сборщик.
  assert.deepEqual(known.data.messages.map((item) => item.body.mid), ['mid_1']);
  const text = JSON.stringify(result);
  for (const hidden of ['Текст', 'Автор', '444', 'https', 'seq', 'sender', 'attachments', 'user_id', TOKEN]) assert.ok(!text.includes(hidden));
});

test('readMessages: недопустимый запрос отклоняется до сети', async (t) => {
  const e = env(t);
  await bind(e);
  const calls = e.fetchImpl.calls.length;
  const bad = [null, [], 'mid_1', {chat_id: CHAT}, {chatId: CHAT}, {url: 'https://evil.example/'}, {companyCode: 'avocado'},
    {count: 0}, {count: 101}, {count: 1.5}, {before: -1}, {before: 2 ** 53}, {after: '1'}, {from: 1}, {marker: 1},
    {messageIds: []}, {messageIds: 'mid_1'}, {messageIds: ['bad/id']}, {messageIds: ['mid_1', 'mid_1']},
    {messageIds: Array.from({length: 101}, (_, index) => `m${index}`)}, {messageIds: ['mid_1'], count: 5}];
  for (const query of bad) await rejectsWith(e.access.readMessages('alvi', query), 'BAD_REQUEST');
  assert.equal(e.fetchImpl.calls.length, calls);
});

test('readMessages: просмотры — только stat.views; нет значения — неизвестно, не ноль', async (t) => {
  const e = env(t);
  await bind(e);
  const accepted = [['{"views":0}', {views: 0}], ['null', null], ['{}', null], ['{"views":null}', null], [undefined, null],
    ['{"views":7,"reactions":3,"reach":10,"reposts":1}', {views: 7}]];
  for (const [stat, expected] of accepted) {
    e.routes['/messages'] = () => reply(page(messageRaw({stat})));
    const {data} = await e.access.readMessages('alvi', {count: 1});
    assert.deepEqual(data.messages[0].stat, expected, String(stat));
  }
  for (const stat of ['{"views":-1}', '{"views":1.5}', '{"views":1e3}', '{"views":9007199254740993}', '{"views":"5"}',
    '{"views":true}', '[]', '5']) {
    e.routes['/messages'] = () => reply(page(messageRaw({stat})));
    await rejectsWith(e.access.readMessages('alvi', {count: 1}), 'RESPONSE_UNCERTAIN');
  }
  assert.equal(e.access.get('alvi').channelConfirmed, true);
});

test('readMessages: чужой получатель, неизвестный ID, повтор и переполнение страницы отклоняются', async (t) => {
  const e = env(t);
  await bind(e);
  const cases = [
    [page(messageRaw({chat: CHAT_NEIGHBOUR})), {count: 5}, 'RESPONSE_SCOPE_MISMATCH'],
    [page(messageRaw({type: '"chat"'})), {count: 5}, 'RESPONSE_SCOPE_MISMATCH'],
    [page(messageRaw({chat: 'null'})), {count: 5}, 'RESPONSE_SCOPE_MISMATCH'],
    [page(messageRaw({chat: `"${CHAT}"`})), {count: 5}, 'RESPONSE_UNCERTAIN'],
    [page(messageRaw({mid: '"mid_9"'})), {messageIds: ['mid_1']}, 'RESPONSE_SCOPE_MISMATCH'],
    [page(messageRaw(), messageRaw()), {count: 5}, 'RESPONSE_UNCERTAIN'],
    [page(messageRaw(), messageRaw({mid: '"mid_2"'})), {count: 1}, 'RESPONSE_UNCERTAIN'],
    [page(messageRaw({mid: '"bad/id"'})), {count: 5}, 'RESPONSE_UNCERTAIN'],
    [page(messageRaw({ts: '-1'})), {count: 5}, 'RESPONSE_UNCERTAIN'],
    [page(messageRaw({ts: '1760000000123.5'})), {count: 5}, 'RESPONSE_UNCERTAIN'],
    ['{"messages":[],"messages":[]}', {count: 5}, 'RESPONSE_UNCERTAIN'],
    ['{"marker":1}', {count: 5}, 'RESPONSE_UNCERTAIN'],
  ];
  for (const [body, query, code] of cases) {
    e.routes['/messages'] = () => reply(body);
    await rejectsWith(e.access.readMessages('alvi', query), code);
  }
  assert.equal(e.access.get('alvi').channelConfirmed, true);
  // 403 у GET /messages — бот приостановлен или потерял доступ: привязка снимается.
  e.routes['/messages'] = () => reply('{"message":"SECRET-UPSTREAM"}', 403);
  await rejectsWith(e.access.readMessages('alvi', {count: 5}), 'ACCESS_DENIED');
  assert.equal(e.access.get('alvi').channelConfirmed, false);
});

test('транспорт: перенаправления, размер, поток, кодировка и сбой fetch — безопасные временные отказы', async (t) => {
  const e = env(t, {maxBytes: 2048});
  await bind(e);
  const path = `/chats/${CHAT}`;
  const cases = [
    [() => new Response(null, {status: 302, headers: {location: 'https://evil.example/'}}), 'UPSTREAM_REDIRECT'],
    [() => Object.defineProperty(reply(chatRaw()), 'redirected', {value: true}), 'UPSTREAM_REDIRECT'],
    [() => Object.defineProperty(reply(chatRaw()), 'url', {value: 'https://evil.example/chats/1'}), 'UPSTREAM_REDIRECT'],
    [() => reply(chatRaw(), 200, {'content-length': String(10 * 1048576)}), 'RESPONSE_TOO_LARGE'],
    [() => reply(`{"pad":"${'x'.repeat(4096)}"}`), 'RESPONSE_TOO_LARGE'],
    [() => ({status: 200, type: 'basic', url: '', redirected: false, headers: new Headers(), body: null}), 'RESPONSE_UNCERTAIN'],
    [() => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), {status: 200}), 'RESPONSE_UNCERTAIN'],
    [() => reply(`${chatRaw()}x`), 'RESPONSE_UNCERTAIN'],
    [() => reply(''), 'RESPONSE_UNCERTAIN'],
    [() => new Response(null, {status: 204}), 'RESPONSE_UNCERTAIN'],
    [() => { throw new TypeError(`getaddrinfo ENOTFOUND ${TOKEN}`); }, 'CONNECTION_UNCERTAIN'],
  ];
  for (const [route, code] of cases) {
    e.routes[path] = route;
    await rejectsWith(e.access.readChannel('alvi'), code);
  }
  assert.equal(e.access.get('alvi').channelConfirmed, true);
});

test('транспорт: срок охватывает и ожидание fetch, и зависшее тело', async (t) => {
  const e = env(t, {timeoutMs: 30});
  await bind(e);
  e.routes[`/chats/${CHAT}`] = () => new Promise(() => {});
  await rejectsWith(e.access.readChannel('alvi'), 'TIMEOUT');
  e.routes[`/chats/${CHAT}`] = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"chat_id":')); }}), {status: 200});
  await rejectsWith(e.access.readChannel('alvi'), 'TIMEOUT');
  assert.equal(e.access.get('alvi').channelConfirmed, true);
});

test('отмена вызывающим: до сети и во время сети — STOPPED без записи', async (t) => {
  const e = env(t);
  e.store.save('alvi', MAX_PROVIDER, TOKEN);
  const aborted = new AbortController();
  aborted.abort();
  await rejectsWith(e.access.verify('alvi', {accountRef: CHAT, signal: aborted.signal}), 'STOPPED');
  assert.equal(e.fetchImpl.calls.length, 0);
  const controller = new AbortController();
  e.routes[`/chats/${CHAT}`] = () => { controller.abort(); return new Promise(() => {}); };
  await rejectsWith(e.access.verify('alvi', {accountRef: CHAT, signal: controller.signal}), 'STOPPED');
  assert.equal(bindingRow(e, 'alvi'), undefined);
  assert.equal(e.store.get('alvi', MAX_PROVIDER).status, 'unchecked');
});

test('stop: прерывает зависшую проверку, не пишет поздний результат и закрывает новые обращения', async (t) => {
  const e = env(t);
  await bind(e, 'avocado', CHAT_B, TOKEN_B);
  e.store.save('alvi', MAX_PROVIDER, TOKEN);
  let started;
  const begun = new Promise((resolve) => { started = resolve; });
  e.routes[`/chats/${CHAT}/members/me`] = () => { started(); return new Promise(() => {}); };
  const pending = e.access.verify('alvi', {accountRef: CHAT});
  await begun;
  const stopped = e.access.stop();
  assert.ok(stopped instanceof Promise);
  await stopped;
  await rejectsWith(pending, 'STOPPED');
  assert.equal(bindingRow(e, 'alvi'), undefined);
  assert.equal(e.store.get('alvi', MAX_PROVIDER).status, 'unchecked');
  assert.equal(e.access.get('avocado').channelConfirmed, true);
  const calls = e.fetchImpl.calls.length;
  await rejectsWith(e.access.readChannel('avocado'), 'STOPPED');
  await rejectsWith(e.access.readMessages('avocado', {count: 1}), 'STOPPED');
  await rejectsWith(e.access.verify('avocado', {accountRef: CHAT_B}), 'STOPPED');
  assert.equal(e.fetchImpl.calls.length, calls);
});


test('native MID с подтверждённым prefix mid. сохраняется и запрашивается без потери',async t=>{
 const e=env(t);await bind(e);e.routes['/messages']=()=>reply(page(messageRaw({mid:'"mid.native_1"'})));
 const result=await e.access.readMessages('alvi',{messageIds:['mid.native_1']});assert.equal(result.data.messages[0].body.mid,'mid.native_1');
 assert.ok(e.fetchImpl.calls.at(-1).url.endsWith('message_ids=mid.native_1'));
});

test('документированный forwarded body null очищается без выдуманного ID и чужой receiver всё равно отвергается',async t=>{
 const e=env(t);await bind(e);
 e.routes['/messages']=()=>reply(`{"messages":[{"recipient":{"chat_id":${CHAT},"chat_type":"channel"},"timestamp":1760000000123,"body":null,"sender":{"first_name":"PRIVATE-FORWARD"}}]}`);
 const r=await e.access.readMessages('alvi',{});assert.equal(r.data.messages[0].body,null);assert.equal(JSON.stringify(r).includes('PRIVATE-FORWARD'),false);
 e.routes['/messages']=()=>reply(`{"messages":[{"recipient":{"chat_id":${CHAT_B},"chat_type":"channel"},"timestamp":1760000000123,"body":null}]}`);
 await rejectsWith(e.access.readMessages('alvi',{}),'RESPONSE_SCOPE_MISMATCH');
});
