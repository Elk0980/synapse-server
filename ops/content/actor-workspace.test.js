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

function setup(t) {
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
  assert.equal(sent.body.automatedReplyAvailable, false);
  assert.equal(sent.body.status, 'saved');
  assert.match(sent.body.notice, /Автоматический ответ пока не подключён/);
  const repeated = await call(f, f.vlad, 'POST', path('messages'), body);
  assert.equal(repeated.body.message.id, sent.body.message.id);
  assert.equal((await call(f, f.vlad, 'POST', path('messages'),
    { ...body, text: 'другой текст' })).status, 409);
  assert.equal((await call(f, f.vlad, 'GET', path('messages'))).body.messages[0].text, text);
  assert.deepEqual((await call(f, f.lena, 'GET', path('messages'))).body.messages, []);
  assert.deepEqual((await call(f, f.owner, 'GET', path('messages'))).body.messages, []);
  const summary = await call(f, f.director, 'GET', path('summary'));
  assert.equal(summary.body.participants.find((p) => p.actorId === f.vlad.id).requests, 1);
  assert.equal(JSON.stringify(summary.body).includes(text), false);
  assert.equal((await call(f, f.vlad, 'GET', `${path('messages')}&actorId=${f.lena.id}`)).status, 400);
  assert.equal((await call(f, f.vlad, 'GET', `${path('messages')}&before=0`)).status, 400);
  assert.equal((await call(f, f.vlad, 'POST', path('messages'), body,
    { headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await call(f, f.outsider, 'GET', path('messages'))).status, 403);
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
  const f = setup(t);
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
