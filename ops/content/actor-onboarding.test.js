'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createActorOnboarding } = require('./actor-onboarding');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 3).toString('base64url')}$${Buffer.alloc(32, 4).toString('base64url')}`;
const PROFILE = { direction: 'Переезд', role: 'Рассказываю личный опыт', cameraComfort: 'small_steps',
  voiceComfort: 'short_voice', boundaries: 'Не обсуждать семью', suggestions: 'Начать с прогулки' };

function setup(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  const auth = createAuthStore(db, `owner:owner:${HASH}`);
  const add = (login, companies, permissions) => auth.create(1, { login, displayName: login,
    password: 'test-password', companies, permissions }, HASH);
  const actor = add('actor', ['taisabai'], ['actor-onboarding.self']);
  const colleague = add('colleague', ['taisabai'], ['actor-onboarding.self']);
  const director = add('director', ['taisabai'], ['actor-onboarding.manage']);
  const outsider = add('outsider', ['alvi'], ['actor-onboarding.self', 'actor-onboarding.manage']);
  const serviceOptions = { db, authStore: auth,
    requireSession: (request) => { if (!request.session) throw Object.assign(new Error('Требуется вход'), { status: 401 }); return request.session; },
    requireCsrf: (request, session) => { if (request.headers['x-csrf-token'] !== session.csrf) {
      throw Object.assign(new Error('Некорректный CSRF-токен'), { status: 403 });
    } }, readJson: async (request) => request.body,
    sendJson: (response, status, payload) => { response.status = status; response.body = payload; }, ...options };
  const service = createActorOnboarding(serviceOptions);
  t.after(() => db.close());
  const session = (user) => ({ user: auth.getById(user.id), csrf: `csrf-${user.id}` });
  return { db, auth, service, serviceOptions, actor, colleague, director, outsider, owner: auth.getById(1), session };
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
const checkInRoute = `/content/actor-onboarding/check-in${self}`;
const ANSWERS = {comfort: 'mixed', obstacles: 'Личная трудность', improvements: 'Личное предложение',
  nextStep: 'Личный небольшой шаг'};

test('опрос доступен ровно через 14 суток после первого полного профиля и не просрочивается', async (t) => {
  let at = '2026-09-01T10:30:00.000Z';
  const f = setup(t, {now: () => at});
  assert.equal((await call(f, f.actor, 'GET', checkInRoute)).body.status, 'not_ready');
  assert.equal((await call(f, f.actor, 'PUT', checkInRoute, {revision: 0, answers: ANSWERS})).status, 409);
  await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`,
    {revision: 0, profile: {...PROFILE, role: ' ', voiceComfort: 'unknown'}});
  assert.equal((await call(f, f.actor, 'GET', checkInRoute)).body.dueAt, null);
  at = '2026-09-03T10:30:00.000Z';
  await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`, {revision: 1, profile: PROFILE});
  let view = (await call(f, f.actor, 'GET', checkInRoute)).body;
  assert.equal(view.status, 'waiting');
  assert.equal(view.completedAt, at);
  assert.equal(view.dueAt, '2026-09-17T10:30:00.000Z');
  assert.equal(view.questions.length, 4);
  assert.ok(view.questions.every((item) => item.label && item.why));
  at = '2026-09-04T10:30:00.000Z';
  await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`,
    {revision: 2, profile: {...PROFILE, role: ''}});
  at = '2026-09-17T10:29:59.999Z';
  assert.equal((await call(f, f.actor, 'GET', checkInRoute)).body.status, 'waiting');
  assert.equal((await call(f, f.actor, 'PUT', checkInRoute, {revision: 0, answers: ANSWERS})).status, 409);
  at = '2026-09-17T10:30:00.000Z';
  view = (await call(f, f.actor, 'GET', checkInRoute)).body;
  assert.equal(view.status, 'due');
  assert.equal(view.completedAt, '2026-09-03T10:30:00.000Z');
  at = '2026-12-30T10:30:00.000Z';
  assert.equal((await call(f, f.actor, 'GET', checkInRoute)).body.status, 'due');
  const saved = await call(f, f.actor, 'PUT', checkInRoute, {revision: 0, answers: ANSWERS});
  assert.equal(saved.status, 200, saved.error?.message);
  assert.equal(saved.body.status, 'saved');
  assert.equal(saved.body.revision, 1);
  assert.equal(saved.body.savedAt, at);
  assert.equal((await call(f, f.actor, 'GET', `/content/actor-onboarding${self}`)).body.revision, 3);
  at = '2027-01-31T10:30:00.000Z';
  assert.equal((await call(f, f.actor, 'GET', checkInRoute)).body.status, 'saved', 'новый цикл не начинается');
  assert.equal((await call(f, f.actor, 'PUT', checkInRoute, {revision: 1, answers: ANSWERS})).body.revision, 1);
  assert.equal((await call(f, f.actor, 'PUT', checkInRoute, {revision: 0, answers: ANSWERS})).status, 409);
  const changed = await call(f, f.actor, 'PUT', checkInRoute,
    {revision: 1, answers: {...ANSWERS, comfort: 'comfortable'}});
  assert.equal(changed.body.revision, 2);
  assert.equal(changed.body.createdAt, saved.body.createdAt);
});

test('ответы опроса изолированы по участнику и компании, сводка содержит только статус и даты', async (t) => {
  let at = '2026-09-01T00:00:00.000Z';
  const f = setup(t, {now: () => at});
  f.auth.updateAccess(f.owner.id, f.actor.id, ['taisabai', 'synapse-business'], ['actor-onboarding.self']);
  await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`, {revision: 0, profile: PROFILE});
  at = '2026-09-16T00:00:00.000Z';
  await call(f, f.actor, 'PUT', checkInRoute, {revision: 0, answers: ANSWERS});
  for (const response of [await call(f, f.colleague, 'GET', checkInRoute),
    await call(f, f.actor, 'GET', '/content/actor-onboarding/check-in?companyCode=synapse-business')]) {
    assert.equal(response.status, 200);
    assert.equal(response.body.revision, 0);
    assert.equal(response.body.status, 'not_ready');
    assert.equal(response.body.answers.nextStep, '');
  }
  const summary = (await call(f, f.director, 'GET', `/content/actor-onboarding/summary${self}`)).body;
  assert.deepEqual(Object.keys(summary.participants[0].checkIn).sort(),
    ['completedAt', 'dueAt', 'savedAt', 'status']);
  assert.equal(summary.participants[0].checkIn.status, 'saved');
  for (const value of Object.values(ANSWERS)) assert.equal(JSON.stringify(summary).includes(value), false);
  const directorOwn = await call(f, f.director, 'GET', checkInRoute);
  assert.equal(directorOwn.body.actorId, f.director.id);
  assert.equal(directorOwn.body.status, 'not_ready');
  assert.equal(directorOwn.body.answers.nextStep, '', 'управление даёт свою анкету, но не чужие ответы');
  assert.equal((await call(f, f.outsider, 'GET', checkInRoute)).status, 403);
  assert.equal((await call(f, null, 'GET', checkInRoute)).status, 401);
  assert.equal((await call(f, f.actor, 'GET', `${checkInRoute}&actorId=${f.colleague.id}`)).status, 400);
  assert.equal((await call(f, f.actor, 'GET', '/content/actor-onboarding/check-in?companyCode=alvi')).status, 403);
  assert.deepEqual(f.service.getOwnProfile('taisabai', f.actor.id), PROFILE);
  assert.equal(f.service.getOwnProfile('synapse-business', f.actor.id), null);
  assert.equal(f.service.getOwnProfile('taisabai', f.colleague.id), null);
  assert.equal(f.service.getOwnProfile('alvi', f.actor.id), null);
  assert.equal(f.service.getOwnProfile('taisabai', String(f.actor.id)), null);
  const stale = f.session(f.actor);
  f.auth.updateAccess(f.owner.id, f.actor.id, ['taisabai'], []);
  for (const method of ['GET', 'PUT']) await assert.rejects(f.service.handle({method,
    session: stale, headers: {'x-csrf-token': stale.csrf}, body: {revision: 1, answers: ANSWERS}}, {},
  new URL(checkInRoute, 'http://localhost')), (error) => error.status === 403);
  assert.equal(f.service.getOwnProfile('taisabai', f.actor.id), null);
  assert.equal((await call(f, f.director, 'GET', `/content/actor-onboarding/summary${self}`)).body.total, 0);
});

test('опрос проверяет CSRF, точную форму тела и допустимые ответы', async (t) => {
  let at = '2026-09-01T00:00:00.000Z';
  const f = setup(t, {now: () => at});
  await call(f, f.actor, 'PUT', `/content/actor-onboarding${self}`, {revision: 0, profile: PROFILE});
  at = '2026-09-16T00:00:00.000Z';
  const invalid = [null, [], {}, {revision: '0', answers: ANSWERS}, {revision: -1, answers: ANSWERS},
    {revision: 0, answers: ANSWERS, actorId: f.colleague.id},
    {revision: 0, answers: {...ANSWERS, companyCode: 'synapse-business'}},
    {revision: 0, answers: {...ANSWERS, comfort: 'unknown'}},
    {revision: 0, answers: {...ANSWERS, nextStep: ' '}},
    {revision: 0, answers: {...ANSWERS, obstacles: 'x'.repeat(2001)}},
    {revision: 0, answers: {...ANSWERS, improvements: null}}];
  for (const body of invalid) assert.equal((await call(f, f.actor, 'PUT', checkInRoute, body)).status, 400);
  assert.equal((await call(f, f.actor, 'PUT', checkInRoute, {revision: 0, answers: ANSWERS},
    {'x-csrf-token': 'wrong'})).status, 403);
  assert.equal((await call(f, f.actor, 'POST', checkInRoute, {})).status, 405);
  assert.equal((await call(f, f.actor, 'GET', checkInRoute)).body.revision, 0);
});

test('старые полные анкеты получают неизменную дату из последнего сохранения', (t) => {
  const f = setup(t, {now: () => '2026-09-30T00:00:00.000Z'});
  f.db.prepare(`INSERT INTO actor_onboarding_profiles
    (company_code,user_id,revision,profile_json,created_at,updated_at) VALUES(?,?,1,?,?,?)`)
    .run('taisabai', f.actor.id, JSON.stringify(PROFILE), '2026-09-01T00:00:00Z', '2026-09-04T00:00:00Z');
  createActorOnboarding(f.serviceOptions);
  assert.equal(f.db.prepare('SELECT completed_at FROM actor_onboarding_completion').get().completed_at,
    '2026-09-04T00:00:00Z');
  f.db.prepare('UPDATE actor_onboarding_profiles SET updated_at=?').run('2026-09-20T00:00:00Z');
  createActorOnboarding(f.serviceOptions);
  assert.equal(f.db.prepare('SELECT completed_at FROM actor_onboarding_completion').get().completed_at,
    '2026-09-04T00:00:00Z');
});

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

test('личные соцсети начинаются с предложения: коллега не видит, директор проверяет', async (t) => {
  const f = setup(t);
  const route = `/content/actor-onboarding/social-links${self}`;
  const review = `/content/actor-onboarding/social-links/review${self}`;
  const proposed = await call(f, f.actor, 'PUT', route,
    { platform: 'instagram', publicUrl: 'https://www.instagram.com/actor/', revision: 0 });
  assert.equal(proposed.status, 200, proposed.error?.message);
  assert.deepEqual([proposed.body.links[0].publicUrl, proposed.body.links[0].status,
    proposed.body.links[0].revision], ['https://www.instagram.com/actor', 'pending', 1]);
  assert.match(proposed.body.notice, /не подключаются автоматически/);
  assert.equal((await call(f, f.colleague, 'GET', route)).body.links.length, 0);
  assert.equal((await call(f, f.actor, 'GET', review)).status, 403);
  assert.equal((await call(f, f.outsider, 'GET', review)).status, 403);
  const managerView = await call(f, f.director, 'GET', review);
  assert.equal(managerView.body.links[0].actorId, f.actor.id);
  const approved = await call(f, f.director, 'PUT', review,
    { actorId: f.actor.id, platform: 'instagram', revision: 1, decision: 'approved' });
  assert.equal(approved.status, 200, approved.error?.message);
  assert.deepEqual([approved.body.links[0].status, approved.body.links[0].revision], ['approved', 2]);
  assert.equal((await call(f, f.actor, 'GET', route)).body.links[0].status, 'approved');
  const revised = await call(f, f.actor, 'PUT', route,
    { platform: 'instagram', publicUrl: 'https://instagram.com/actor.new', revision: 2 });
  assert.deepEqual([revised.body.links[0].status, revised.body.links[0].revision,
    revised.body.links[0].reviewedAt], ['pending', 3, null], 'изменённый адрес требует новой проверки');
  assert.equal((await call(f, f.director, 'PUT', review,
    { actorId: f.actor.id, platform: 'instagram', revision: 2, decision: 'approved' })).status, 409);
  const rejected = await call(f, f.director, 'PUT', review,
    { actorId: f.actor.id, platform: 'instagram', revision: 3, decision: 'rejected' });
  assert.equal(rejected.body.links[0].status, 'rejected');
  assert.equal((await call(f, f.actor, 'DELETE', route,
    { platform: 'instagram', revision: 4 })).body.links.length, 0);
});

test('ссылки валидируются без ключей и параметров; запись и решение защищены CSRF', async (t) => {
  const f = setup(t);
  const route = `/content/actor-onboarding/social-links${self}`;
  const review = `/content/actor-onboarding/social-links/review${self}`;
  const invalid = [
    ['instagram', 'http://instagram.com/actor'],
    ['instagram', 'https://evil.example/actor'],
    ['instagram', 'https://instagram.com.evil.example/actor'],
    ['instagram', 'https://user:token@instagram.com/actor'],
    ['instagram', 'https://instagram.com/actor?access_token=secret'],
    ['instagram', 'https://instagram.com/actor#secret'],
    ['instagram', 'https://instagram.com/'],
    ['telegram', 'https://t.me/+privateInvite'],
    ['tiktok', 'https://tiktok.com/actor'],
  ];
  for (const [platform, publicUrl] of invalid) {
    assert.equal((await call(f, f.actor, 'PUT', route,
      { platform, publicUrl, revision: 0 })).status, 400, publicUrl);
  }
  assert.equal((await call(f, f.actor, 'PUT', route,
    { platform: 'instagram', publicUrl: 'https://instagram.com/actor', revision: 0,
      accessToken: 'should-never-store' })).status, 400);
  assert.equal((await call(f, f.actor, 'PUT', route,
    { platform: 'instagram', publicUrl: 'https://instagram.com/actor', revision: 0 },
    { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await call(f, f.actor, 'PUT', route,
    { platform: 'instagram', publicUrl: 'https://instagram.com/actor', revision: 0 })).status, 200);
  assert.equal((await call(f, f.director, 'PUT', review,
    { actorId: f.actor.id, platform: 'instagram', revision: 1, decision: 'approved' },
    { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await call(f, f.actor, 'DELETE', route,
    { platform: 'instagram', revision: 1 }, { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await call(f, f.actor, 'GET', route)).body.links.length, 1);
});

test('отзыв роли владельца при чтении решения запрещает подтверждать собственную ссылку', async (t) => {
  let release, bodyStarted;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  const f = setup(t, { readJson: async (request) => {
    if (request.body.decision && request.session.user.role === 'owner') {
      bodyStarted();
      await waiting;
    }
    return request.body;
  } });
  const route = `/content/actor-onboarding/social-links${self}`;
  const review = `/content/actor-onboarding/social-links/review${self}`;
  const account = { displayName: f.actor.displayName, companies: ['taisabai'],
    permissions: ['actor-onboarding.manage'] };
  f.auth.updateAccount(f.owner.id, f.actor.id, { ...account, role: 'owner' });
  assert.equal((await call(f, f.actor, 'PUT', route,
    { platform: 'instagram', publicUrl: 'https://instagram.com/actor', revision: 0 })).status, 200);
  const decision = { actorId: f.actor.id, platform: 'instagram', revision: 1, decision: 'approved' };
  const pending = call(f, f.actor, 'PUT', review, decision);
  await started;
  f.auth.updateAccount(f.owner.id, f.actor.id, { ...account, role: 'editor' });
  release();
  const denied = await pending;
  assert.equal(denied.status, 403, denied.error?.message);
  const unchanged = (await call(f, f.actor, 'GET', route)).body.links[0];
  assert.deepEqual([unchanged.status, unchanged.revision, unchanged.reviewedAt], ['pending', 1, null]);
  const approved = await call(f, f.director, 'PUT', review, decision);
  assert.equal(approved.status, 200, approved.error?.message);
  assert.equal(approved.body.links[0].status, 'approved', 'другой управляющий сохраняет право проверки');
});

test('отзыв доступа скрывает ссылку из списка директора и блокирует старую сессию', async (t) => {
  const f = setup(t);
  const route = `/content/actor-onboarding/social-links${self}`;
  const review = `/content/actor-onboarding/social-links/review${self}`;
  assert.equal((await call(f, f.actor, 'PUT', route,
    { platform: 'youtube', publicUrl: 'https://youtube.com/@actor', revision: 0 })).status, 200);
  assert.equal((await call(f, f.director, 'GET', review)).body.links.length, 1);
  const stale = f.session(f.actor);
  f.auth.updateAccess(f.owner.id, f.actor.id, ['taisabai'], []);
  assert.equal((await call(f, f.director, 'GET', review)).body.links.length, 0);
  const response = {};
  await assert.rejects(f.service.handle({ method: 'GET', headers: {}, session: stale }, response,
    new URL(route, 'http://localhost')), (error) => error.status === 403);
  assert.equal((await call(f, f.director, 'PUT', review,
    { actorId: f.actor.id, platform: 'youtube', revision: 1, decision: 'approved' })).status, 404);
});
