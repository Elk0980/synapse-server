'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createMediaMentor} = require('./media-mentor');
const {createMediaMentorHandler} = require('./media-mentor-http');

const OWNER = {userId: 1, userName: 'Владелец Synapse', role: 'owner'};
const EDITOR = {userId: 7, userName: 'Редактор клиента', role: 'editor', companies: ['alvi']};

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,
      is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name,timezone) VALUES(1,'alvi','ALVI','Asia/Irkutsk'),(2,'avokado','Авокадо','UTC');`);
  let time = Date.parse('2026-09-19T09:00:00Z');
  const mentor = createMediaMentor(db, {now: () => time});
  const seen = [], transfers = [];
  // Перенос проверяется своим тестом на настоящих модулях; здесь важен только маршрут и права.
  const transfer = {
    status: (code) => ({planRevision: null, canTransfer: false, blockedReason: 'Заглушка', company: code}),
    transfer: (code, body, actor) => { transfers.push({code, body, actor}); return {created: true, companyCode: code, posts: []}; },
    context: (code, postId) => ({companyCode: code, postId, asset: null, assetIsMedia: false}),
  };
  const handler = createMediaMentorHandler({
    mentor, transfer,
    companyModuleContext: (request, code, permission) => {
      seen.push({code, permission});
      const identity = request.identity;
      if (!identity) { const error = new Error('Недостаточно прав'); error.status = 403; throw error; }
      if (identity.role !== 'owner' && !identity.permissions.includes(permission)) {
        const error = new Error('Недостаточно прав'); error.status = 403; throw error;
      }
      if (identity.role !== 'owner' && !(identity.companies || []).includes(String(code).toLowerCase())) {
        const error = new Error('Нет доступа к компании'); error.status = 403; throw error;
      }
      return {identity};
    },
    readJson: async (request) => request.body,
    send: (response, status, result) => { response.sent = {status, result}; },
  });
  const call = async (method, path, identity, body, code = 'alvi') => {
    const response = {};
    const query = code === null ? '' : `?companyCode=${code}`;
    const handled = await handler({method, identity, body}, response, new URL(`http://crm.local${path}${query}`), {});
    return {handled, ...response.sent || {}};
  };
  return {db, mentor, handler, call, seen, transfers, advance: (ms) => { time += ms; }};
}

const BRIEF = {goal: 'Записи на массаж', product: 'Массаж 60 минут', audience: 'Офисные сотрудники',
  pains: ['Болит спина', 'Нет времени'],
  confirmedFacts: [{id: 'f1', statement: 'Приём 10:00–21:00', source: 'Карточка компании в ЛК'}],
  assets: [{id: 'a1', title: 'Съёмка кабинета', kind: 'photo', note: 'Снято 12.09'}],
  shootingComfort: {level: 'hands_only', notes: 'Лицо не показываем'},
  platforms: ['telegram', 'vk']};
const days = (count = 7, platform = 'telegram') => Array.from({length: count}, (item, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`, platform, format: 'post', role: 'reach',
  topic: `Тема дня ${index + 1}`, hook: '', assetId: 'a1', mentorNote: ''}));

async function seedBrief(f, identity = OWNER) {
  const saved = await f.call('PUT', '/media-mentor/brief', identity, {revision: 0, brief: BRIEF});
  assert.equal(saved.status, 200, JSON.stringify(saved.result));
  return saved.result;
}

test('маршрут не перехватывает соседние адреса и отвечает на свои', async (t) => {
  const f = fixture(t);
  for (const path of ['/media-mentor-rollout', '/media-mentor-rollout/survey', '/leads', '/autoposting/posts']) {
    assert.equal(await f.handler({method: 'GET', identity: OWNER}, {}, new URL(`http://crm.local${path}`), {}), false, path);
  }
  const read = await f.call('GET', '/media-mentor', OWNER);
  assert.equal(read.handled, true);
  assert.equal(read.status, 200);
  assert.equal(read.result.companyCode, 'alvi');
  assert.equal(read.result.brief.revision, 0);
  assert.equal(read.result.plan, null);
  assert.equal(read.result.approval.status, 'absent');
  assert.ok(read.result.vocabulary.platforms.some((item) => item.id === 'telegram'));
});

test('ответ маршрута не заявляет, что HTTP и кабинета нет, и отделяет согласование от публикации', async (t) => {
  const f = fixture(t);
  const read = await f.call('GET', '/media-mentor', OWNER);
  assert.deepEqual(read.result.capabilities, {publishing: false, modelSuggestions: false,
    httpApi: true, cabinetUi: true, planApprovalAuthorizesPublishing: false});
  assert.match(read.result.notice, /не разрешение публиковать/);
  assert.doesNotMatch(read.result.notice, /HTTP-маршрутов и интерфейса кабинета у раздела ещё нет/);
  // Сам модуль основы не изменён: он по-прежнему сообщает о себе то же, что и раньше.
  assert.equal(f.mentor.get('alvi').capabilities.httpApi, false);
});

test('чтение требует autoposting.view, запись — autoposting.edit, компания обязательна', async (t) => {
  const f = fixture(t);
  const viewer = {...EDITOR, permissions: ['autoposting.view']};
  const editor = {...EDITOR, permissions: ['autoposting.view', 'autoposting.edit']};
  assert.equal((await f.call('GET', '/media-mentor', viewer)).status, 200);
  assert.deepEqual(f.seen.at(-1), {code: 'alvi', permission: 'autoposting.view'});
  await assert.rejects(f.call('PUT', '/media-mentor/brief', viewer, {revision: 0, brief: BRIEF}),
    (error) => error.status === 403);
  assert.deepEqual(f.seen.at(-1), {code: 'alvi', permission: 'autoposting.edit'});
  assert.equal((await f.call('PUT', '/media-mentor/brief', editor, {revision: 0, brief: BRIEF})).status, 200);
  await assert.rejects(f.call('GET', '/media-mentor', viewer, undefined, 'avokado'), (error) => error.status === 403);
  await assert.rejects(f.call('GET', '/media-mentor', null), (error) => error.status === 403);
  await assert.rejects(f.call('GET', '/media-mentor', OWNER, undefined, 'missing'), (error) => error.status === 404);
});

test('автор изменения берётся из личности запроса, а не из тела', async (t) => {
  const f = fixture(t);
  const editor = {...EDITOR, permissions: ['autoposting.view', 'autoposting.edit']};
  await assert.rejects(f.call('PUT', '/media-mentor/brief', editor,
    {revision: 0, brief: BRIEF, actor: {userId: 1, userName: 'Подставное имя'}}),
  (error) => error.status === 400, 'лишнее поле в теле отвергается');
  const saved = await f.call('PUT', '/media-mentor/brief', editor, {revision: 0, brief: BRIEF});
  assert.equal(saved.result.brief.history[0].actorName, 'Редактор клиента');
  assert.equal(saved.result.brief.history[0].actorId, 7);
});

test('устаревшая версия брифа и плана не переписывает чужую правку', async (t) => {
  const f = fixture(t);
  const first = await seedBrief(f);
  assert.equal(first.brief.revision, 1);
  await assert.rejects(f.call('PUT', '/media-mentor/brief', OWNER, {revision: 0, brief: {goal: 'Другая цель'}}),
    (error) => error.status === 409 && error.details.code === 'REVISION_CONFLICT');
  assert.equal(f.mentor.get('alvi').brief.fields.goal, 'Записи на массаж');

  const planned = await f.call('PUT', '/media-mentor/plan', OWNER,
    {planRevision: 0, briefRevision: first.brief.revision, days: days()});
  assert.equal(planned.status, 200, JSON.stringify(planned.result));
  assert.equal(planned.result.plan.revision, 1);
  assert.equal(planned.result.plan.windowDays, 7);
  assert.equal(planned.result.approval.status, 'pending');
  await assert.rejects(f.call('PUT', '/media-mentor/plan', OWNER,
    {planRevision: 0, briefRevision: first.brief.revision, days: days(8)}),
  (error) => error.status === 409 && error.details.code === 'REVISION_CONFLICT');
  await assert.rejects(f.call('PUT', '/media-mentor/plan', OWNER,
    {planRevision: 1, briefRevision: 99, days: days(8)}),
  (error) => error.status === 409 && error.details.code === 'BRIEF_CHANGED');
});

test('план проверяется по брифу: площадка, исходник, окно 7–14 дней', async (t) => {
  const f = fixture(t);
  const brief = await seedBrief(f);
  const base = {planRevision: 0, briefRevision: brief.brief.revision};
  for (const body of [
    {...base, days: days(6)},
    {...base, days: days(7, 'instagram')},
    {...base, days: days(7).map((day) => ({...day, assetId: 'missing'}))},
    {...base, days: days(7).map((day) => ({...day, topic: ''}))},
    {...base, days: days(7).map((day) => ({...day, format: 'unknown'}))},
    {...base, days: []},
  ]) await assert.rejects(f.call('PUT', '/media-mentor/plan', OWNER, body), (error) => error.status === 400);
  assert.equal(f.mentor.get('alvi').plan, null);
});

test('решение по плану принимает только владелец, именно по своей версии и не даёт права публиковать', async (t) => {
  const f = fixture(t);
  const editor = {...EDITOR, permissions: ['autoposting.view', 'autoposting.edit']};
  const brief = await seedBrief(f);
  const planned = await f.call('PUT', '/media-mentor/plan', OWNER,
    {planRevision: 0, briefRevision: brief.brief.revision, days: days()});
  const decision = {planRevision: planned.result.plan.revision, briefRevision: brief.brief.revision,
    decision: 'approved', comment: ''};
  await assert.rejects(f.call('POST', '/media-mentor/plan/decision', editor, decision),
    (error) => error.status === 403 && /только владелец/.test(error.message));
  assert.equal(f.mentor.get('alvi').approval.status, 'pending');

  const approved = await f.call('POST', '/media-mentor/plan/decision', OWNER, decision);
  assert.equal(approved.status, 201);
  assert.equal(approved.result.approval.status, 'approved');
  assert.equal(approved.result.approval.actorName, 'Владелец Synapse');
  assert.equal(approved.result.approval.actorId, 1);
  // Согласование — решение по тексту: разрешения публиковать оно не выдаёт.
  assert.equal(approved.result.capabilities.publishing, false);
  assert.equal(approved.result.capabilities.planApprovalAuthorizesPublishing, false);

  // Отклонение без комментария не принимается, устаревшая версия — тоже.
  await assert.rejects(f.call('POST', '/media-mentor/plan/decision', OWNER, {...decision, decision: 'rejected', comment: ''}),
    (error) => error.status === 400);
  await assert.rejects(f.call('POST', '/media-mentor/plan/decision', OWNER, {...decision, planRevision: 99}),
    (error) => error.status === 409 && error.details.code === 'STALE_PLAN');
});

test('правка брифа возвращает согласованный план на пересогласование', async (t) => {
  const f = fixture(t);
  const brief = await seedBrief(f);
  await f.call('PUT', '/media-mentor/plan', OWNER, {planRevision: 0, briefRevision: brief.brief.revision, days: days()});
  await f.call('POST', '/media-mentor/plan/decision', OWNER,
    {planRevision: 1, briefRevision: brief.brief.revision, decision: 'approved', comment: 'Берём в работу'});
  assert.equal(f.mentor.get('alvi').approval.status, 'approved');
  const edited = await f.call('PUT', '/media-mentor/brief', OWNER,
    {revision: brief.brief.revision, brief: {goal: 'Новая цель'}});
  assert.equal(edited.result.approval.status, 'needs_reapproval');
  assert.equal(edited.result.approval.requiresReapproval, true);
  await assert.rejects(f.call('POST', '/media-mentor/plan/decision', OWNER,
    {planRevision: 1, briefRevision: edited.result.brief.revision, decision: 'approved', comment: ''}),
  (error) => error.status === 409 && error.details.code === 'BRIEF_CHANGED');
});

test('компании не смешиваются, а версии читаются только в своей компании', async (t) => {
  const f = fixture(t);
  const brief = await seedBrief(f);
  await f.call('PUT', '/media-mentor/plan', OWNER, {planRevision: 0, briefRevision: brief.brief.revision, days: days()});
  const other = await f.call('GET', '/media-mentor', OWNER, undefined, 'avokado');
  assert.equal(other.result.brief.revision, 0);
  assert.equal(other.result.plan, null);
  assert.doesNotMatch(JSON.stringify(other.result), /Записи на массаж/);

  const version = await f.call('GET', '/media-mentor/brief/versions/1', OWNER);
  assert.equal(version.status, 200);
  assert.equal(version.result.fields.goal, 'Записи на массаж');
  const planVersion = await f.call('GET', '/media-mentor/plan/versions/1', OWNER);
  assert.equal(planVersion.result.days.length, 7);
  await assert.rejects(f.call('GET', '/media-mentor/brief/versions/1', OWNER, undefined, 'avokado'),
    (error) => error.status === 404);
  for (const bad of ['0', 'abc', '-1']) {
    await assert.rejects(f.call('GET', `/media-mentor/brief/versions/${bad}`, OWNER), (error) => error.status === 404);
  }
});

test('перенос плана идёт по праву правки автопостинга и получает автора из личности запроса', async (t) => {
  const f = fixture(t);
  const viewer = {...EDITOR, permissions: ['autoposting.view']};
  const editor = {...EDITOR, permissions: ['autoposting.view', 'autoposting.edit']};
  assert.equal((await f.call('GET', '/media-mentor', OWNER)).result.transfer.canTransfer, false);
  await assert.rejects(f.call('POST', '/media-mentor/plan/transfer', viewer, {planRevision: 1, briefRevision: 1}),
    (error) => error.status === 403);
  assert.deepEqual(f.seen.at(-1), {code: 'alvi', permission: 'autoposting.edit'});
  assert.equal(f.transfers.length, 0);
  const moved = await f.call('POST', '/media-mentor/plan/transfer', editor, {planRevision: 1, briefRevision: 1});
  assert.equal(moved.status, 201);
  assert.deepEqual(f.transfers.at(-1).actor, {userId: 7, userName: 'Редактор клиента'});
  assert.deepEqual(f.transfers.at(-1).body, {planRevision: 1, briefRevision: 1});
  // Контекст черновика — чтение: достаточно права просмотра.
  const context = await f.call('GET', '/media-mentor/plan/transfer/42', viewer);
  assert.equal(context.status, 200);
  assert.deepEqual([context.result.postId, context.result.assetIsMedia], ['42', false]);
  assert.deepEqual(f.seen.at(-1), {code: 'alvi', permission: 'autoposting.view'});
});

test('неизвестные адреса и методы закрыты', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.call('POST', '/media-mentor', OWNER, {}), (error) => error.status === 405);
  await assert.rejects(f.call('GET', '/media-mentor/brief', OWNER), (error) => error.status === 405);
  await assert.rejects(f.call('DELETE', '/media-mentor/plan', OWNER), (error) => error.status === 405);
  await assert.rejects(f.call('PUT', '/media-mentor/plan/decision', OWNER, {}), (error) => error.status === 405);
  await assert.rejects(f.call('GET', '/media-mentor/plan/transfer', OWNER), (error) => error.status === 405);
  await assert.rejects(f.call('DELETE', '/media-mentor/plan/transfer/42', OWNER), (error) => error.status === 405);
  await assert.rejects(f.call('GET', '/media-mentor/unknown', OWNER), (error) => error.status === 404);
});
