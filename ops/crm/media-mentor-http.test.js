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
    variantStatus: (code) => ({planRevision: null, canTransfer: false, blockedReason: 'Заглушка', items: [], company: code}),
    transferVariants: (code, body, actor) => { transfers.push({code, body, actor, scope: 'variants'}); return {createdCount: 0, companyCode: code, posts: []}; },
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

test('замечание к строке принимает редактор своей компании, автор приходит из личности', async (t) => {
  const f=fixture(t);
  const viewer={...EDITOR,permissions:['autoposting.view']};
  const editor={...EDITOR,permissions:['autoposting.view','autoposting.edit']};
  const brief=await seedBrief(f);
  await f.call('PUT','/media-mentor/plan',OWNER,
    {planRevision:0,briefRevision:brief.brief.revision,days:days()});
  const message={planRevision:1,dayIndex:0,message:'Может, это тема для продающего рилса?'};
  await assert.rejects(f.call('POST','/media-mentor/plan/feedback',viewer,message),
    error=>error.status===403);
  assert.deepEqual(f.seen.at(-1),{code:'alvi',permission:'autoposting.edit'});
  await assert.rejects(f.call('POST','/media-mentor/plan/feedback',editor,
    {...message,actorName:'Самозванец'}),error=>error.status===400);
  await assert.rejects(f.call('POST','/media-mentor/plan/feedback',editor,message,'avokado'),
    error=>error.status===403);
  const saved=await f.call('POST','/media-mentor/plan/feedback',editor,message);
  assert.equal(saved.status,201);
  assert.equal(saved.result.feedback.length,1);
  assert.deepEqual([saved.result.feedback[0].actorId,saved.result.feedback[0].actorName],
    [7,'Редактор клиента']);
  assert.equal((await f.call('GET','/media-mentor',viewer)).result.feedback[0].message,message.message);
  assert.equal((await f.call('GET','/media-mentor/plan/versions/1',viewer)).result.feedback.length,1);
  assert.deepEqual((await f.call('GET','/media-mentor',OWNER,undefined,'avokado')).result.feedback,[]);
});

test('неизвестные адреса и методы закрыты', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.call('POST', '/media-mentor', OWNER, {}), (error) => error.status === 405);
  await assert.rejects(f.call('GET', '/media-mentor/brief', OWNER), (error) => error.status === 405);
  await assert.rejects(f.call('DELETE', '/media-mentor/plan', OWNER), (error) => error.status === 405);
  await assert.rejects(f.call('PUT', '/media-mentor/plan/decision', OWNER, {}), (error) => error.status === 405);
  await assert.rejects(f.call('GET', '/media-mentor/plan/transfer', OWNER), (error) => error.status === 405);
  await assert.rejects(f.call('GET', '/media-mentor/plan/feedback', OWNER), (error) => error.status === 405);
  await assert.rejects(f.call('DELETE', '/media-mentor/plan/transfer/42', OWNER), (error) => error.status === 405);
  await assert.rejects(f.call('GET', '/media-mentor/unknown', OWNER), (error) => error.status === 404);
});

/* ---------- Маршруты и права решений по версиям площадок ----------
   Проверяется не заглушка, а сам маршрут: право, метод, компания и то, что решение
   действительно записывается настоящим модулем Медиа-наставника. */

async function seedPlan(f, identity = OWNER) {
  await seedBrief(f, identity);
  const withVariants = days().map((day) => ({...day,
    variants: {telegram: {text: 'ТГ текст'}, vk: {text: 'ВК текст'}}}));
  const saved = await f.call('PUT', '/media-mentor/plan', identity,
    {planRevision: 0, briefRevision: 1, days: withVariants});
  assert.equal(saved.status, 200, JSON.stringify(saved.result));
  return saved.result;
}

test('решение по версиям площадок: маршрут свой, метод один, компания обязательна', async (t) => {
  const f = fixture(t);
  await seedPlan(f);
  const body = {planRevision: 1, briefRevision: 1, scope: 'plan', decision: 'approved', comment: ''};
  const ok = await f.call('POST', '/media-mentor/plan/variants/decision', OWNER, body);
  assert.equal(ok.status, 201);
  assert.equal(ok.result.variants.filter((item) => item.status === 'approved').length, 14);
  assert.equal(ok.result.capabilities.planApprovalAuthorizesPublishing, false,
    'ответ не выдаёт согласование плана за разрешение публиковать');
  // Другие методы на том же адресе не подхватываются молча: модуль отвечает отказом 405,
  // а не пропускает запрос дальше как чужой.
  for (const method of ['GET', 'PUT', 'DELETE']) {
    await assert.rejects(() => f.call(method, '/media-mentor/plan/variants/decision', OWNER, body),
      (error) => error.status === 405, method);
  }
  // Соседний адрес модулю не принадлежит.
  const neighbour = await f.call('POST', '/media-mentor-rollout/plan/variants/decision', OWNER, body);
  assert.equal(neighbour.handled, false);
});

test('решение по версиям — только владелец; редактор получает понятный отказ', async (t) => {
  const f = fixture(t);
  await seedPlan(f);
  const body = {planRevision: 1, briefRevision: 1, scope: 'plan', decision: 'approved', comment: ''};
  const editor = {...EDITOR, permissions: ['autoposting.view', 'autoposting.edit']};
  await assert.rejects(() => f.call('POST', '/media-mentor/plan/variants/decision', editor, body),
    (error) => error.status === 403 && error.details.code === 'FORBIDDEN');
  // Право на запись проверяется тем же ключом, что и у остальных изменений раздела.
  assert.deepEqual(f.seen.at(-1), {code: 'alvi', permission: 'autoposting.edit'});
  const stranger = {...EDITOR, permissions: ['autoposting.view']};
  await assert.rejects(() => f.call('POST', '/media-mentor/plan/variants/decision', stranger, body),
    (error) => error.status === 403);
  // Ни одно решение не записалось.
  const state = await f.call('GET', '/media-mentor', OWNER);
  assert.deepEqual(state.result.variants.filter((item) => item.status === 'approved'), []);
});

test('чужая компания решение по версиям не принимает и своих решений не отдаёт', async (t) => {
  const f = fixture(t);
  await seedPlan(f);
  const body = {planRevision: 1, briefRevision: 1, scope: 'plan', decision: 'approved', comment: ''};
  const editor = {...EDITOR, permissions: ['autoposting.view', 'autoposting.edit'], role: 'editor'};
  await assert.rejects(() => f.call('POST', '/media-mentor/plan/variants/decision', editor, body, 'avokado'),
    (error) => error.status === 403);
  await f.call('POST', '/media-mentor/plan/variants/decision', OWNER, body);
  const other = await f.call('GET', '/media-mentor', OWNER, undefined, 'avokado');
  assert.deepEqual(other.result.variants, [], 'решения одной компании другой не видны');
});

test('перенос версий идёт по праву правки автопостинга и получает автора из личности', async (t) => {
  const f = fixture(t);
  await seedPlan(f);
  const editor = {...EDITOR, permissions: ['autoposting.view', 'autoposting.edit']};
  const body = {planRevision: 1, briefRevision: 1};
  const done = await f.call('POST', '/media-mentor/plan/variants/transfer', editor, body);
  assert.equal(done.status, 200, 'перенос владельцем не ограничен: это правка карточек автопостинга');
  assert.deepEqual(f.seen.at(-1), {code: 'alvi', permission: 'autoposting.edit'});
  const last = f.transfers.at(-1);
  assert.equal(last.scope, 'variants');
  assert.deepEqual(last.actor, {userId: 7, userName: 'Редактор клиента'});
  // Имя автора из тела запроса не принимается.
  await f.call('POST', '/media-mentor/plan/variants/transfer', editor, {...body, actorName: 'Подставной'});
  assert.deepEqual(f.transfers.at(-1).actor, {userId: 7, userName: 'Редактор клиента'});
  const readOnly = {...EDITOR, permissions: ['autoposting.view']};
  await assert.rejects(() => f.call('POST', '/media-mentor/plan/variants/transfer', readOnly, body),
    (error) => error.status === 403);
  for (const method of ['GET', 'PUT']) {
    await assert.rejects(() => f.call(method, '/media-mentor/plan/variants/transfer', editor, body),
      (error) => error.status === 405, method);
  }
});

test('чтение раздела отдаёт состояние версий и расписку переноса версий', async (t) => {
  const f = fixture(t);
  await seedPlan(f);
  const readOnly = {...EDITOR, permissions: ['autoposting.view']};
  const state = await f.call('GET', '/media-mentor', readOnly);
  assert.equal(state.status, 200);
  assert.deepEqual(f.seen.at(-1), {code: 'alvi', permission: 'autoposting.view'});
  assert.equal(state.result.variants.length, 14, 'состояние версий видно и на чтение');
  assert.ok(state.result.variantTransfer, 'расписка переноса версий отдаётся отдельно от старой');
  assert.ok(state.result.transfer, 'старая расписка по дням остаётся читаемой');
});


test('неподключённая генерация и перенос возвращают501 после проверки доступа',async t=>{
 const f=fixture(t);
 for(const path of ['/media-mentor/generation','/media-mentor/generation/test-job/drafts']){
  await assert.rejects(f.call('POST',path,OWNER,{}),e=>e.status===501&&e.details.code==='PROVIDER_NOT_CONFIGURED');
  await assert.rejects(f.call('POST',path,null,{}),e=>e.status===403);
 }
 assert.equal(f.transfers.length,0);
});

function workflowHttpFixture(t,{enabled=true}={}){
 const f=fixture(t),workflow=require('./content-factory-workflow').createContentFactoryWorkflow(f.db);
 const seen=[];let reads=0;
 const handler=createMediaMentorHandler({mentor:f.mentor,workflow:enabled?workflow:null,
  companyModuleContext(request,code,permission){
   seen.push({code,permission});const identity=request.identity;
   const deny=()=>{throw Object.assign(Error('Synthetic guard denied'),{status:403});};
   if(!identity||identity.role!=='owner'&&!identity.permissions?.includes(permission))deny();
   if(identity.role!=='owner'&&!identity.companies?.includes(String(code).toLowerCase()))deny();
   // Моделирует существующий upstream session/CSRF guard; отдельная CSRF схема в handler не появляется.
   if(request.method!=='GET'&&!request.csrf)deny();
   return {identity,company:require('./company-information').company(f.db,code)};
  },readJson:async request=>{
   reads++;await new Promise(resolve=>setImmediate(resolve));if(request.afterRead)request.afterRead(request);
   if(request.parseError)throw Object.assign(Error('Malformed synthetic JSON'),{status:400});return request.body;
  },send:(response,status,result,headers)=>{response.sent={status,result,headers};}});
 const call=async(method,identity,body,options={})=>{
  const code=Object.hasOwn(options,'code')?options.code:'alvi',response={};
  const request={method,identity,body,csrf:options.csrf!==false,afterRead:options.afterRead,parseError:options.parseError};
  const path=options.path||'/media-mentor/workflow',query=code===null?'':`?companyCode=${code}`;
  const handled=await handler(request,response,new URL(`http://crm.local${path}${query}`),{'x-test':'cors-preserved'});
  return {handled,...response.sent};
 };
 return {...f,workflow,call,seen,reads:()=>reads};
}
test('workflow HTTP использует реальный CF21 get/save, no-store, view/edit и доверенного автора',async t=>{
 const f=workflowHttpFixture(t),viewer={...EDITOR,permissions:['autoposting.view']},editor={...EDITOR,permissions:['autoposting.view','autoposting.edit']};
 const initial=await f.call('GET',viewer);assert.equal(initial.status,200);assert.equal(initial.result.configured,false);
 assert.equal(initial.headers['cache-control'],'no-store');assert.equal(initial.headers['x-test'],'cors-preserved');
 assert.deepEqual(f.seen.at(-1),{code:'alvi',permission:'autoposting.view'});
 const saved=await f.call('PUT',editor,{revision:0,fields:{releaseMode:'manual',publisherName:'Указанное имя'}});
 assert.equal(saved.status,200);assert.equal(saved.result.revision,1);assert.equal(saved.result.configured,true);
 assert.equal(saved.headers['cache-control'],'no-store');assert.equal(saved.result.approverRole,'owner');
 assert.deepEqual(f.seen.slice(-2),[{code:'alvi',permission:'autoposting.edit'},{code:'alvi',permission:'autoposting.edit'}]);
 const actor=f.db.prepare('SELECT actor_id,actor_name FROM content_factory_workflow_versions WHERE company_id=1').get();
 assert.deepEqual({...actor},{actor_id:7,actor_name:'Редактор клиента'});
 assert.equal((await f.call('GET',OWNER,undefined,{code:'avokado'})).result.configured,false);
});
test('workflow HTTP отклоняет view-only/чужую компанию/missing identity/CSRF до JSON и записи',async t=>{
 const f=workflowHttpFixture(t),viewer={...EDITOR,permissions:['autoposting.view']},editor={...EDITOR,permissions:['autoposting.view','autoposting.edit']};
 const body={revision:0,fields:{releaseMode:'manual'}};
 await assert.rejects(f.call('PUT',viewer,body),e=>e.status===403);
 await assert.rejects(f.call('GET',viewer,undefined,{code:'avokado'}),e=>e.status===403);
 await assert.rejects(f.call('GET',null),e=>e.status===403);
 await assert.rejects(f.call('PUT',editor,body,{csrf:false}),e=>e.status===403);
 await assert.rejects(f.call('GET',OWNER,undefined,{code:null}),e=>e.status===400);
 await assert.rejects(f.call('GET',OWNER,undefined,{code:'missing'}),e=>e.status===404);
 assert.equal(f.reads(),0);assert.equal(f.workflow.get('alvi').configured,false);
});
test('workflow HTTP malformed/actor injection/revision/method/missing dependency не создают лишних версий',async t=>{
 const f=workflowHttpFixture(t),body={revision:0,fields:{releaseMode:'manual'}};
 await assert.rejects(f.call('PUT',OWNER,body,{parseError:true}),e=>e.status===400);
 await assert.rejects(f.call('PUT',OWNER,{...body,actorName:'Подставное'}),e=>e.status===400);
 await assert.rejects(f.call('PUT',OWNER,{revision:0,fields:{hours:['24:00']}}),e=>e.status===400);
 assert.equal(f.workflow.get('alvi').configured,false);
 await f.call('PUT',OWNER,body);
 await assert.rejects(f.call('PUT',OWNER,body),e=>e.status===409);
 for(const method of ['POST','DELETE','PATCH','HEAD'])await assert.rejects(f.call(method,OWNER,body),e=>e.status===405);
 await assert.rejects(f.call('GET',OWNER,undefined,{path:'/media-mentor/workflow/extra'}),e=>e.status===404);
 const missing=workflowHttpFixture(t,{enabled:false});
 for(const method of ['GET','PUT'])await assert.rejects(missing.call(method,OWNER,body),e=>e.status===501);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM content_factory_workflow_versions').get().n,1);
});
test('workflow PUT fresh context отклоняет revoke/identity swap/CSRF loss во время JSON',async t=>{
 const editor={...EDITOR,permissions:['autoposting.view','autoposting.edit']};
 for(const afterRead of [request=>{request.identity=null;},request=>{request.identity={...editor,permissions:['autoposting.view']};},
  request=>{request.identity={...editor,userId:99};},request=>{request.csrf=false;}]){
  const f=workflowHttpFixture(t);
  await assert.rejects(f.call('PUT',editor,{revision:0,fields:{releaseMode:'manual'}},{afterRead}),e=>e.status===403);
  assert.equal(f.reads(),1);assert.equal(f.workflow.get('alvi').configured,false);
 }
});
test('workflow PUT использует fresh trusted actor при той же личности',async t=>{
 const f=workflowHttpFixture(t),editor={...EDITOR,permissions:['autoposting.view','autoposting.edit']};
 await f.call('PUT',editor,{revision:0,fields:{releaseMode:'manual'}},{afterRead:request=>{request.identity={...editor,userName:'Актуальное имя'};}});
 assert.equal(f.db.prepare('SELECT actor_name FROM content_factory_workflow_versions').get().actor_name,'Актуальное имя');
});
