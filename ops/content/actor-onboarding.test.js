'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createActorOnboarding } = require('./actor-onboarding');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 3).toString('base64url')}$${Buffer.alloc(32, 4).toString('base64url')}`;
const PROFILE = { direction: 'Переезд', role: 'Рассказываю личный опыт', cameraComfort: 'small_steps',
  voiceComfort: 'short_voice', boundaries: 'Не обсуждать семью', suggestions: 'Начать с прогулки' };

function setup(t) {
  const db = new DatabaseSync(':memory:');
  const auth = createAuthStore(db, `owner:owner:${HASH}`);
  const add = (login, companies, permissions) => auth.create(1, { login, displayName: login,
    password: 'test-password', companies, permissions }, HASH);
  const actor = add('actor', ['taisabai'], ['actor-onboarding.self']);
  const colleague = add('colleague', ['taisabai'], ['actor-onboarding.self']);
  const director = add('director', ['taisabai'], ['actor-onboarding.manage']);
  const outsider = add('outsider', ['alvi'], ['actor-onboarding.self', 'actor-onboarding.manage']);
  const service = createActorOnboarding({ db, authStore: auth,
    requireSession: (request) => { if (!request.session) throw Object.assign(new Error('Требуется вход'), { status: 401 }); return request.session; },
    requireCsrf: (request, session) => { if (request.headers['x-csrf-token'] !== session.csrf) {
      throw Object.assign(new Error('Некорректный CSRF-токен'), { status: 403 });
    } }, readJson: async (request) => request.body,
    sendJson: (response, status, payload) => { response.status = status; response.body = payload; } });
  t.after(() => db.close());
  const session = (user) => ({ user: auth.getById(user.id), csrf: `csrf-${user.id}` });
  return { db, auth, service, actor, colleague, director, outsider, owner: auth.getById(1), session };
}

async function call(f, user, method, path, body, headers = {}) {
  const session = user ? f.session(user) : null;
  const request = { method, session, body, headers: { ...(session ? { 'x-csrf-token': session.csrf } : {}), ...headers } };
  const response = { status: 0, body: null };
  try { const handled = await f.service.handle(request, response, new URL(path, 'http://localhost'));
    return { handled, status: response.status, body: response.body };
  } catch (error) { return { handled: true, status: error.status || 500, error }; }
}
const self = '?companyCode=taisabai';

test('участник сохраняет только свой профиль; другой участник не видит его ответы', async (t) => {
  const f = setup(t);
  const first = await call(f, f.actor, 'GET', `/content/actor-onboarding${self}`);
  assert.equal(first.status, 200);
  assert.equal(first.body.revision, 0);
  assert.equal(first.body.questions.length, 6);
  const saved = await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`,
    { revision: 0, profile: PROFILE });
  assert.equal(saved.status, 200, saved.error?.message);
  assert.equal(saved.body.revision, 1);
  const other = await call(f, f.colleague, 'GET', `/content/actor-onboarding${self}`);
  assert.equal(other.status, 200);
  assert.equal(other.body.revision, 0);
  assert.equal(JSON.stringify(other.body).includes(PROFILE.boundaries), false);
  assert.equal((await call(f, f.colleague, 'GET', `/content/actor-onboarding/summary${self}`)).status, 403);
  assert.equal((await call(f, f.actor, 'GET', `/content/actor-onboarding${self}&actorId=${f.colleague.id}`)).status, 400);
  assert.equal((await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`,
    { revision: 1, profile: PROFILE, actorId: f.colleague.id })).status, 400);
  const duplicate = await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`,
    { revision: 1, profile: PROFILE });
  assert.equal(duplicate.body.revision, 1, 'повтор без изменений не создаёт версию');
  assert.equal((await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`,
    { revision: 0, profile: PROFILE })).status, 409);
});

test('сводка доступна только уполномоченному директору/Synapse и не раскрывает свободные ответы', async (t) => {
  const f = setup(t);
  await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`, { revision: 0, profile: PROFILE });
  const summary = await call(f, f.director, 'GET', `/content/actor-onboarding/summary${self}`);
  assert.equal(summary.status, 200);
  assert.deepEqual([summary.body.total, summary.body.ready], [1, 1]);
  assert.equal(summary.body.participants[0].actorId, f.actor.id);
  assert.equal(summary.body.participants[0].hasBoundaries, true);
  assert.equal(JSON.stringify(summary.body).includes(PROFILE.boundaries), false);
  assert.equal(JSON.stringify(summary.body).includes(PROFILE.suggestions), false);
  assert.equal((await call(f, f.owner, 'GET', `/content/actor-onboarding/summary${self}`)).status, 200);
  assert.equal((await call(f, f.outsider, 'GET', `/content/actor-onboarding/summary${self}`)).status, 403);
  assert.equal((await call(f, f.director, 'PUT', `/content/actor-onboarding/summary${self}`, {})).status, 405);
});

test('чужая компания и отсутствие права закрыты; отзыв доступа действует для прежней сессии', async (t) => {
  const f = setup(t);
  assert.equal((await call(f, f.actor, 'GET', '/content/actor-onboarding?companyCode=alvi')).status, 403);
  assert.equal((await call(f, f.outsider, 'GET', `/content/actor-onboarding${self}`)).status, 403);
  assert.equal((await call(f, null, 'GET', `/content/actor-onboarding${self}`)).status, 401);
  assert.equal((await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`,
    { revision: 0, profile: PROFILE }, { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`,
    { revision: 0, profile: PROFILE })).status, 200);
  const stale = f.session(f.actor);
  f.auth.updateAccess(f.owner.id, f.actor.id, ['taisabai'], []);
  const request = { method: 'GET', session: stale, headers: {} }, response = {};
  await assert.rejects(f.service.handle(request, response,
    new URL(`/content/actor-onboarding${self}`, 'http://localhost')),
  (error) => error.status === 403);
  assert.equal((await call(f, f.director, 'GET', `/content/actor-onboarding/summary${self}`)).body.total,
    0, 'после отзыва права прежний профиль не отображается в сводке текущих участников');
  f.auth.updateAccess(f.owner.id, f.actor.id, [], ['actor-onboarding.self']);
  assert.equal((await call(f, f.actor, 'GET', `/content/actor-onboarding${self}`)).status, 403);
});

test('роль владельца нельзя подставить в старую сессию редактора', async (t) => {
  const f = setup(t);
  const session = f.session(f.actor);
  session.user = { ...session.user, role: 'owner' };
  const response = {};
  await assert.rejects(f.service.handle({ method: 'GET', headers: {}, session }, response,
    new URL('/content/actor-onboarding/summary?companyCode=taisabai', 'http://localhost')),
  (error) => error.status === 403);
});
