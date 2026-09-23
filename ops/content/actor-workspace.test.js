'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createActorWorkspace } = require('./actor-workspace');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 3).toString('base64url')}$${Buffer.alloc(32, 4).toString('base64url')}`;
const ENTRY = { date: '2026-09-24', platform: 'instagram', format: 'reel',
  topic: 'Мой опыт переезда', status: 'idea' };
const path = (route = 'plan', company = 'taisabai') =>
  `/content/actor-workspace/${route}?companyCode=${company}`;

function setup(t, { ask = null, loadSocialOverview = null } = {}) {
  const db = new DatabaseSync(':memory:');
  const auth = createAuthStore(db, `owner:owner:${HASH}`);
  const add = (login, companies, permissions) => auth.create(1, { login,
    displayName: login, password: 'test-password', companies, permissions }, HASH);
  const vlad = add('vlad', ['taisabai'], ['actor-onboarding.self']);
  const lena = add('lena', ['taisabai'], ['actor-onboarding.self']);
  const director = add('director', ['taisabai'], ['actor-onboarding.manage']);
  const outsider = add('outsider', ['alvi'], ['actor-onboarding.self', 'actor-onboarding.manage']);
  const service = createActorWorkspace({ db, authStore: auth,
    requireSession: (request) => {
      if (!request.session) throw Object.assign(new Error('Требуется вход'), { status: 401 });
      return request.session;
    },
    requireCsrf: (request, session) => {
      if (request.headers['x-csrf-token'] !== session.csrf) {
        throw Object.assign(new Error('Некорректный CSRF-токен'), { status: 403 });
      }
    },
    readJson: async (request) => request.body,
    sendJson: (response, status, payload) => { response.status = status; response.body = payload; },
    ask, loadSocialOverview,
  });
  t.after(() => db.close());
  const session = (user) => ({ user: auth.getById(user.id), csrf: `csrf-${user.id}` });
  return { db, auth, service, vlad, lena, director, outsider, owner: auth.getById(1), session };
}
async function call(f, user, method, route, body, opts = {}) {
  const session = opts.session || (user ? f.session(user) : null);
  const request = { method, session, body, headers: {
    ...(session ? { 'x-csrf-token': session.csrf } : {}), ...opts.headers } };
  const response = { status: 0, body: null };
  try {
    const handled = await f.service.handle(request, response, new URL(route, 'http://localhost'));
    return { handled, status: response.status, body: response.body };
  } catch (error) { return { handled: true, status: error.status || 500, error }; }
}

test('личные планы участников и компаний не смешиваются; руководителю видны только счётчики', async (t) => {
  const f = setup(t);
  const written = await call(f, f.vlad, 'PUT', path(), { revision: 0, entries: [ENTRY] });
  assert.equal(written.status, 200, written.error?.message);
  assert.equal(written.body.revision, 1);
  assert.equal(written.body.publicationEnabled, false);
  assert.deepEqual((await call(f, f.lena, 'GET', path())).body.entries, []);
  assert.deepEqual((await call(f, f.owner, 'GET', path())).body.entries, []);
  assert.equal((await call(f, f.vlad, 'GET', path('plan', 'alvi'))).status, 403);
  assert.equal((await call(f, f.outsider, 'GET', path())).status, 403);
  assert.equal((await call(f, f.director, 'GET', path())).status, 200,
    'управляющий может иметь собственный план, но не открывает чужой');
  const summary = await call(f, f.director, 'GET', path('summary'));
  assert.equal(summary.status, 200);
  const row = summary.body.participants.find((p) => p.actorId === f.vlad.id);
  assert.equal(row.plannedMaterials, 1);
  assert.equal(JSON.stringify(summary.body).includes(ENTRY.topic), false);
  assert.equal((await call(f, f.vlad, 'GET', path('summary'))).status, 403);
  assert.equal((await call(f, f.outsider, 'GET', path('summary'))).status, 403);
  assert.equal((await call(f, f.vlad, 'GET', `${path()}&actorId=${f.lena.id}`)).status, 400);
});

test('версии личного плана защищают от потери правок; повтор не создаёт новую версию', async (t) => {
  const f = setup(t);
  const first = await call(f, f.vlad, 'PUT', path(), { revision: 0, entries: [ENTRY] });
  assert.equal(first.status, 200);
  assert.equal((await call(f, f.vlad, 'PUT', path(), { revision: 1, entries: [ENTRY] })).body.revision, 1);
  assert.equal((await call(f, f.vlad, 'PUT', path(), { revision: 0, entries: [] })).status, 409);
  const changed = await call(f, f.vlad, 'PUT', path(),
    { revision: 1, entries: [{ ...ENTRY, topic: 'Новый сценарий' }] });
  assert.equal(changed.body.revision, 2);
  assert.equal((await call(f, f.vlad, 'GET', path())).body.entries[0].topic, 'Новый сценарий');
  const bad = [
    { ...ENTRY, date: '2026-02-30' },
    { ...ENTRY, status: 'published' },
    { ...ENTRY, actorId: f.lena.id },
  ];
  for (const entry of bad) assert.equal((await call(f, f.vlad, 'PUT', path(),
    { revision: 2, entries: [entry] })).status, 400);
  assert.equal((await call(f, f.vlad, 'PUT', path(),
    { revision: 2, entries: [ENTRY] }, { headers: { 'x-csrf-token': 'wrong' } })).status, 403);
});

test('приватные сообщения сохраняются без выдуманного ответа; повтор идемпотентен', async (t) => {
  const f = setup(t);
  const text = 'Личная просьба: снимать только за кадром';
  const body = { clientMessageId: 'request-00001', text };
  const sent = await call(f, f.vlad, 'POST', path('messages'), body);
  assert.equal(sent.status, 200, sent.error?.message);
  assert.equal(sent.body.assistantEnabled, false);
  assert.equal(sent.body.message.aiStatus, 'pending');
  assert.match(sent.body.notice, /Хью сейчас недоступен/);
  const repeated = await call(f, f.vlad, 'POST', path('messages'), body);
  assert.equal(repeated.body.message.id, sent.body.message.id);
  assert.equal(repeated.body.repeated, true);
  assert.equal((await call(f, f.vlad, 'POST', path('messages'),
    { ...body, text: 'другой текст' })).status, 409);
  assert.equal((await call(f, f.vlad, 'GET', path('messages'))).body.messages[0].text, text);
  assert.deepEqual((await call(f, f.lena, 'GET', path('messages'))).body.messages, []);
  assert.deepEqual((await call(f, f.owner, 'GET', path('messages'))).body.messages, []);
  const summary = await call(f, f.director, 'GET', path('summary'));
  assert.equal(summary.body.participants.find((p) => p.actorId === f.vlad.id).requests, 1);
  assert.equal(summary.body.participants.find((p) => p.actorId === f.vlad.id).awaitingReply, 1);
  assert.equal(JSON.stringify(summary.body).includes(text), false);
  assert.equal((await call(f, f.vlad, 'GET', `${path('messages')}&actorId=${f.lena.id}`)).status, 400);
  assert.equal((await call(f, f.vlad, 'GET', `${path('messages')}&before=0`)).status, 400);
  assert.equal((await call(f, f.vlad, 'POST', path('messages'), body,
    { headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await call(f, f.outsider, 'GET', path('messages'))).status, 403);
});

test('Хью получает только историю этого участника и сохраняет ответ в личной области', async (t) => {
  const calls = [];
  const f = setup(t, { ask: async (payload) => { calls.push(payload);
    return { text: `Ответ ${calls.length}`, provider: 'test', model: 'test-model' }; } });
  assert.equal((await call(f, f.vlad, 'GET', path('messages'))).body.messages.length, 0);
  assert.equal(calls.length, 0, 'открытие переписки не вызывает модель');
  // Чужие вопросы лежат в той же БД, но не могут попасть в контекст личного ответа.
  await call(f, f.lena, 'POST', path('messages'),
    { clientMessageId: 'lena-000001', text: 'Секрет Лены' });
  await call(f, f.vlad, 'POST', path('messages'),
    { clientMessageId: 'vlad-000001', text: 'Вопрос Влада 1' });
  const sent = await call(f, f.vlad, 'POST', path('messages'),
    { clientMessageId: 'vlad-000002', text: 'Вопрос Влада 2' });
  assert.equal(sent.status, 200, sent.error?.message);
  assert.equal(sent.body.message.aiStatus, 'done');
  assert.equal(sent.body.message.reply, 'Ответ 3');
  assert.equal(calls.length, 3);
  const prompt = calls[2];
  assert.equal(prompt.companyCode, 'taisabai');
  assert.equal(prompt.audience, 'actor-private');
  assert.match(prompt.jobId, /^actor-private:taisabai:/);
  assert.deepEqual(prompt.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(JSON.stringify(prompt).includes('Секрет Лены'), false);
  assert.equal(JSON.stringify(prompt).includes('Алви'), false);
  assert.equal((await call(f, f.lena, 'GET', path('messages'))).body.messages[0].reply, 'Ответ 1');
  assert.equal((await call(f, f.owner, 'GET', path('messages'))).body.messages.length, 0);
  const summary = await call(f, f.director, 'GET', path('summary'));
  assert.equal(summary.body.participants.find((p) => p.actorId === f.vlad.id).awaitingReply, 0);
  assert.equal(JSON.stringify(summary.body).includes('Вопрос Влада'), false);
  assert.equal(JSON.stringify(summary.body).includes('Ответ 3'), false);
  const repeated = await call(f, f.vlad, 'POST', path('messages'),
    { clientMessageId: 'vlad-000002', text: 'Вопрос Влада 2' });
  assert.equal(repeated.body.repeated, true);
  assert.equal(repeated.body.message.reply, 'Ответ 3');
  assert.equal(calls.length, 3, 'повтор с тем же ID не тратит модель');
});

test('отказ провайдера оставляет вопрос ожидающим; повтор не запускает второй запрос', async (t) => {
  const calls = [];
  const f = setup(t, { ask: async (payload) => { calls.push(payload);
    throw new Error('provider secret sk-test-secret-123456789'); } });
  const body = { clientMessageId: 'failed-00001', text: 'Нужна помощь с первым роликом' };
  const first = await call(f, f.vlad, 'POST', path('messages'), body);
  assert.equal(first.status, 200);
  assert.equal(first.body.message.aiStatus, 'pending');
  assert.equal(first.body.message.reply, null);
  assert.equal(JSON.stringify(first.body).includes('sk-test-secret'), false);
  const second = await call(f, f.vlad, 'POST', path('messages'), body);
  assert.equal(second.body.message.id, first.body.message.id);
  assert.equal(second.body.message.aiStatus, 'pending');
  assert.equal(calls.length, 1);
  assert.equal((await call(f, f.vlad, 'GET', path('messages'))).body.messages[0].aiStatus,
    'pending');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM actor_workspace_messages').get().n, 1);
});

test('два одновременных запроса с одним ID не создают двойной вызов модели', async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const f = setup(t, { ask: async (payload) => { calls.push(payload); return waiting; } });
  const body = { clientMessageId: 'parallel-001', text: 'Проверка повтора' };
  const first = call(f, f.vlad, 'POST', path('messages'), body);
  // Первое обращение сохраняет вопрос до вызова асинхронной модели.
  await new Promise((resolve) => setImmediate(resolve));
  const second = await call(f, f.vlad, 'POST', path('messages'), body);
  assert.equal(second.body.message.aiStatus, 'running');
  assert.equal(second.body.repeated, true);
  assert.equal(calls.length, 1);
  assert.equal((await call(f, f.vlad, 'POST', path('messages'),
    { clientMessageId: 'parallel-002', text: 'Второй вопрос' })).status, 409);
  release({ text: 'Готовый ответ', provider: 'test', model: 'm' });
  const finished = await first;
  assert.equal(finished.body.message.reply, 'Готовый ответ');
  assert.equal(calls.length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM actor_workspace_messages').get().n, 1);
});

test('отзыв доступа во время ответа не раскрывает участнику ответ через прежнюю сессию', async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const f = setup(t, { ask: async () => waiting });
  const stale = f.session(f.vlad);
  const first = call(f, f.vlad, 'POST', path('messages'),
    { clientMessageId: 'revoke-00001', text: 'Личный вопрос' }, { session: stale });
  await new Promise((resolve) => setImmediate(resolve));
  f.auth.updateAccess(f.owner.id, f.vlad.id, ['taisabai'], []);
  release({ text: 'Личный ответ' });
  assert.equal((await first).status, 403);
  assert.equal((await call(f, f.vlad, 'GET', path('messages'), undefined, { session: stale })).status, 403);
  const summary = await call(f, f.director, 'GET', path('summary'));
  assert.equal(JSON.stringify(summary.body).includes('Личный ответ'), false);
});

test('участнику доступна только общая статистика своей компании без CRM и учётных записей', async (t) => {
  const calls = [];
  const f = setup(t, { loadSocialOverview: async (code) => {
    calls.push(code);
    return { companyCode: code, from: '2026-09-01', to: '2026-09-23',
      socialAggregate: { views: 1234, likes: 23, reach: 999 },
      platforms: { instagram: { configured: true, dataStatus: 'partial',
        accountRef: 'private-account', totals: { views: 800, likes: 10 },
        days: { '2026-09-01': { views: { value: 800 } } }, history: [] } },
      crm: { leads: [{ name: 'Личные данные клиента', phone: '123' }], revenue: 99999 },
      posts: [{ url: 'https://private.example/post' }],
      runs: [{ error: 'secret provider response' }] };
  } });
  assert.equal(f.auth.getById(f.vlad.id).permissions.includes('analytics.view'), false);
  const result = await call(f, f.vlad, 'GET', path('stats'));
  assert.equal(result.status, 200, result.error?.message);
  assert.equal(result.body.socialAggregate.views, 1234);
  assert.equal(result.body.platforms.instagram.totals.views, 800);
  assert.equal(result.body.platforms.instagram.dataStatus, 'partial');
  assert.equal(JSON.stringify(result.body).includes('private-account'), false);
  assert.equal(JSON.stringify(result.body).includes('Личные данные клиента'), false);
  assert.equal(JSON.stringify(result.body).includes('private.example'), false);
  assert.equal(JSON.stringify(result.body).includes('99999'), false);
  assert.equal(result.body.socialAggregate.reach, undefined);
  assert.deepEqual(calls, ['taisabai']);
  assert.equal((await call(f, f.vlad, 'GET', path('stats', 'alvi'))).status, 403);
  assert.equal((await call(f, f.vlad, 'GET', `${path('stats')}&actorId=${f.lena.id}`)).status, 400);
  assert.equal((await call(f, null, 'GET', path('stats'))).status, 401);
});

test('неверная компания в ответе статистики не раскрывается участнику', async (t) => {
  const f = setup(t, { loadSocialOverview: async () => ({ companyCode: 'alvi',
    socialAggregate: { views: 999 }, crm: { secret: 'private' } }) });
  const denied = await call(f, f.vlad, 'GET', path('stats'));
  assert.equal(denied.status, 502);
  assert.equal(denied.error.message.includes('private'), false);
  assert.equal((await call(f, f.vlad, 'POST', path('stats'), {})).status, 405);
});

test('отозванное право блокирует прежнюю сессию и скрывает участника из сводки', async (t) => {
  const f = setup(t);
  await call(f, f.vlad, 'PUT', path(), { revision: 0, entries: [ENTRY] });
  const stale = f.session(f.vlad);
  f.auth.updateAccess(f.owner.id, f.vlad.id, ['taisabai'], []);
  assert.equal((await call(f, f.vlad, 'GET', path(), undefined, { session: stale })).status, 403);
  assert.equal((await call(f, f.vlad, 'GET', path('messages'), undefined, { session: stale })).status, 403);
  assert.equal((await call(f, f.director, 'GET', path('summary'))).body.participants
    .some((p) => p.actorId === f.vlad.id), false);
  f.auth.updateAccess(f.owner.id, f.vlad.id, [], ['actor-onboarding.self']);
  assert.equal((await call(f, f.vlad, 'GET', path())).status, 403);
});

test('два проекта одного человека сохраняют отдельные планы и переписки', async (t) => {
  const calls = [];
  const f = setup(t, { ask: async (payload) => { calls.push(payload);
    return { text: 'Отдельный ответ', provider: 'test', model: 'test' }; } });
  f.auth.updateAccess(f.owner.id, f.vlad.id, ['taisabai', 'alvi'], ['actor-onboarding.self']);
  await call(f, f.vlad, 'PUT', path(), { revision: 0, entries: [ENTRY] });
  await call(f, f.vlad, 'PUT', path('plan', 'alvi'),
    { revision: 0, entries: [{ ...ENTRY, topic: 'Только для Алви' }] });
  await call(f, f.vlad, 'POST', path('messages'),
    { clientMessageId: 'request-00001', text: 'ТайСабай: личный вопрос' });
  await call(f, f.vlad, 'POST', path('messages', 'alvi'),
    { clientMessageId: 'request-00001', text: 'Алви: другой вопрос' });
  assert.equal((await call(f, f.vlad, 'GET', path())).body.entries[0].topic, ENTRY.topic);
  assert.equal((await call(f, f.vlad, 'GET', path('plan', 'alvi'))).body.entries[0].topic,
    'Только для Алви');
  assert.equal((await call(f, f.vlad, 'GET', path('messages'))).body.messages[0].text,
    'ТайСабай: личный вопрос');
  assert.equal((await call(f, f.vlad, 'GET', path('messages', 'alvi'))).body.messages[0].text,
    'Алви: другой вопрос');
  assert.equal(JSON.stringify(calls[0]).includes('Алви: другой вопрос'), false);
  assert.equal(JSON.stringify(calls[1]).includes('ТайСабай: личный вопрос'), false);
});

test('подмена роли в cookie не даёт управляющий доступ; неподдерживаемый метод закрыт', async (t) => {
  const f = setup(t);
  const session = f.session(f.vlad);
  session.user = { ...session.user, role: 'owner' };
  assert.equal((await call(f, f.vlad, 'GET', path('summary'), undefined, { session })).status, 403);
  assert.equal((await call(f, null, 'GET', path())).status, 401);
  assert.equal((await call(f, f.vlad, 'DELETE', path())).status, 405);
  assert.equal((await call(f, f.vlad, 'POST', path('summary'), {})).status, 405);
  assert.equal((await call(f, f.vlad, 'POST', `${path('messages')}&actorId=2`,
    { clientMessageId: 'request-00001', text: 'x' })).status, 400);
});
