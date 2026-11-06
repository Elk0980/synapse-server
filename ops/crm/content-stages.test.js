'use strict';
/* specs/209-cf-stages: вычисляемый этап идеи плана, публикации идеи, связь ролика с идеей,
   загрузка «вне плана» и часовой пояс компании. Настоящие модули Медиа-наставника и «Материалов». */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createMediaMentor} = require('./media-mentor');
const {createReelMaterials} = require('./reel-materials');
const {createReelMaterialsHandler} = require('./reel-materials-http');
const {createMediaMentorHandler} = require('./media-mentor-http');
const {createContentStages, shootingFacts, STAGE_IDS, FACTS_HEADER} = require('./content-stages');

const OWNER = {userId: 1, userName: 'Владелец'};
const asset = (code, n = 'a') => `https://synapse.synapsebusiness.ru/content/publishing-assets/${code}/${n.repeat(32)}.mp4`;
const BRIEF = {goal: 'Записи', product: 'Процедура', audience: 'Взрослые', pains: ['Нет времени'],
  confirmedFacts: [{id: 'f1', statement: 'Работаем с 10 до 21', source: 'ЛК'}], assets: [],
  shootingComfort: {level: 'on_camera', notes: ''}, platforms: ['vk', 'telegram']};
const IDEAS = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7'];
const plan = () => IDEAS.map((ideaId, index) => ({ideaId, date: `2026-11-${String(index + 10).padStart(2, '0')}`, platform: 'vk',
  format: 'reel', role: 'reach', topic: `Рилс ${index + 1}`, hook: '', assetId: '', mentorNote: '', variants: {vk: {text: `Подпись ${index + 1}`}}}));
const facts = (code, reels) => Buffer.from(JSON.stringify({v: 1, companyCode: code, reels})).toString('base64url');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name,timezone) VALUES(1,'avokado','Авокадо','Asia/Irkutsk'),(2,'alvi','Алви','');
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT,updated_at TEXT,is_deleted INTEGER DEFAULT 0,title TEXT,description TEXT,company_code TEXT,
      assignee_role TEXT,assignee_name TEXT,status TEXT,priority TEXT DEFAULT 'normal',due_date TEXT DEFAULT '',source TEXT,source_ref TEXT,source_author TEXT,created_by TEXT);
    CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,company_id INTEGER,status TEXT,title TEXT,media_urls TEXT DEFAULT '[]',platform_ids TEXT DEFAULT '[]',
      content_revision INTEGER DEFAULT 1,approved_revision INTEGER,deleted_at TEXT,archived_at TEXT);
    CREATE TABLE autoposting_deliveries(post_id INTEGER,channel_id TEXT,status TEXT,url TEXT,finished_at TEXT,PRIMARY KEY(post_id,channel_id));
    CREATE TABLE autoposting_publication_receipts(id INTEGER PRIMARY KEY AUTOINCREMENT,company_id INTEGER,post_id INTEGER,platform TEXT,url TEXT,
      published_at TEXT,content_revision INTEGER);
    CREATE TABLE media_mentor_variant_transfers(id INTEGER PRIMARY KEY,company_id INTEGER,idea_id TEXT,platform TEXT,post_id INTEGER UNIQUE);`);
  const mentor = createMediaMentor(db, {now: () => Date.parse('2026-11-07T01:00:00Z')});
  const materials = createReelMaterials(db, {autoposting: {list: () => ({posts: []})}, information: {get: () => ({revision: 1})},
    mentor: () => mentor, now: () => Date.parse('2026-11-07T01:00:00Z')});
  const stages = createContentStages(db);
  for (const code of ['avokado', 'alvi']) {
    mentor.saveBrief(code, {revision: 0, brief: BRIEF}, OWNER);
    mentor.savePlan(code, {planRevision: 0, briefRevision: 1, days: plan()}, OWNER);
  }
  const decide = (code, ideaId, decision) => mentor.decideVariants(code, {planRevision: mentor.get(code).plan.revision, briefRevision: 1,
    scope: 'idea', ideaId, decision, comment: decision === 'rejected' ? 'Переписать начало' : ''}, OWNER);
  const post = (companyId, id, ideaId, fields = {}) => {
    db.prepare('INSERT INTO autoposting_posts(id,company_id,status,title,media_urls,platform_ids,approved_revision) VALUES(?,?,?,?,?,?,?)')
      .run(id, companyId, fields.status || 'draft', 'Пост', JSON.stringify(fields.media || []), JSON.stringify(['vk']), fields.approved ?? null);
    db.prepare('INSERT INTO media_mentor_variant_transfers(company_id,idea_id,platform,post_id) VALUES(?,?,?,?)').run(companyId, ideaId, 'vk', id);
  };
  const days = (code, header) => new Map(stages.apply(mentor.get(code), code, header === undefined ? null : shootingFacts({headers: {[FACTS_HEADER]: header}}, code))
    .plan.days.map((day) => [day.ideaId, day]));
  return {db, mentor, materials, stages, decide, post, days};
}

test('этап идеи по фактам: сценарий, съёмка, монтаж, публикация; ids — из CfKit.STAGES', (t) => {
  const f = fixture(t);
  f.decide('avokado', 'i2', 'rejected');
  for (const id of ['i3', 'i4', 'i5', 'i6', 'i7']) f.decide('avokado', id, 'approved');
  // i4 — раскадровка из 2 кадров, оба сняты; i3 — снят 1 из 3 кадров: ещё не «Отснято».
  const header = facts('avokado', {i3: [3, 1, 1, 0, null], i4: [2, 2, 2, 0, null]});
  let d = f.days('avokado', header);
  assert.equal(d.get('i1').stage, 'script_review');
  assert.equal(d.get('i2').stage, 'script_rework');
  assert.equal(d.get('i3').stage, 'planned');
  assert.equal(d.get('i4').stage, 'shot'); assert.equal(d.get('i4').stageSource, 'shooting');
  // Монтаж: ролик к идее → на согласовании; правка → на доработке.
  const reel = f.materials.create('avokado', {title: 'Монтаж', mediaUrl: asset('avokado'), durationMs: 5000, ideaId: 'i5'}, {userId: 7, userName: 'СММ'});
  assert.equal(reel.ideaId, 'i5'); assert.deepEqual(reel.planLink, {ideaId: 'i5', source: 'materials'});
  assert.equal(f.days('avokado', header).get('i5').stage, 'edit_review');
  f.materials.requestEdit('avokado', reel.id, {clientRequestId: 'r1', baseVersion: 1, kind: 'request', comment: 'Короче', startMs: 0, endMs: 1000}, {userId: 7, userName: 'СММ'});
  assert.equal(f.days('avokado', header).get('i5').stage, 'edit_rework');
  // Публикации: запланирована → вышла со ссылкой; ошибка; согласованная карточка с роликом → «Готово к выходу».
  f.post(1, 61, 'i6', {status: 'scheduled'});
  f.post(1, 71, 'i7', {status: 'failed'});
  f.post(1, 31, 'i3', {media: [asset('avokado', 'b')], approved: 1});
  d = f.days('avokado', header);
  assert.equal(d.get('i6').stage, 'scheduled');
  assert.deepEqual(d.get('i6').publications, [{platform: 'vk', status: 'scheduled', url: null, publishedAt: null}]);
  assert.equal(d.get('i7').stage, 'publish_error');
  assert.equal(d.get('i3').stage, 'ready');
  f.db.prepare("INSERT INTO autoposting_deliveries VALUES(61,'vk','published','https://vk.com/wall-1_2','2026-11-15T03:00:00Z')").run();
  f.db.prepare("UPDATE autoposting_posts SET status='published' WHERE id=61").run();
  d = f.days('avokado', header);
  assert.equal(d.get('i6').stage, 'published'); assert.equal(d.get('i6').stageSource, 'publication');
  assert.deepEqual(d.get('i6').publications, [{platform: 'vk', status: 'published', url: 'https://vk.com/wall-1_2', publishedAt: '2026-11-15T03:00:00Z'}]);
  for (const day of d.values()) assert.ok(STAGE_IDS.includes(day.stage), day.stage);
  assert.equal([...d.values()].some((day) => day.stage === 'unpublished'), false, 'снятие с публикации не фиксируется — этап не выдумывается');
});

test('без фактов съёмки этап не выдумывается и это помечено; чужой или битый заголовок не принимается', (t) => {
  const f = fixture(t);
  f.decide('avokado', 'i4', 'approved');
  const snapshot = f.stages.apply(f.mentor.get('avokado'), 'avokado', null);
  assert.equal(snapshot.plan.stageFacts.shooting, false);
  assert.equal(new Map(snapshot.plan.days.map((day) => [day.ideaId, day])).get('i4').stage, 'planned');
  assert.equal(shootingFacts({headers: {[FACTS_HEADER]: facts('alvi', {i4: [0, 0, 1, 0, null]})}}, 'avokado'), null, 'факты другой компании');
  assert.equal(shootingFacts({headers: {[FACTS_HEADER]: 'не-base64'}}, 'avokado'), null);
  assert.equal(shootingFacts({headers: {[FACTS_HEADER]: Buffer.from(JSON.stringify({v: 1, companyCode: 'avokado', truncated: true})).toString('base64url')}}, 'avokado'), null);
  // Без раскадровки «Отснято» — по первому дублю (как summary() съёмки); ручной статус «в монтаже» главнее.
  assert.equal(f.days('avokado', facts('avokado', {i4: [0, 0, 1, 0, null]})).get('i4').stage, 'shot');
  assert.equal(f.days('avokado', facts('avokado', {i4: [0, 0, 1, 0, 'editing']})).get('i4').stage, 'editing');
  assert.equal(f.days('avokado', facts('avokado', {i4: [0, 0, 1, 1, null]})).get('i4').stage, 'edit_review');
});

test('изоляция компаний: публикации и ролики Авокадо не меняют этапы Алви; идея чужой компании → 404', (t) => {
  const f = fixture(t);
  f.post(1, 61, 'i6', {status: 'scheduled'});
  f.materials.create('avokado', {title: 'Монтаж', mediaUrl: asset('avokado'), ideaId: 'i5'}, {userId: 7});
  const alvi = f.days('alvi');
  assert.equal(alvi.get('i6').stage, 'script_review'); assert.deepEqual(alvi.get('i6').publications, []);
  assert.equal(alvi.get('i5').stage, 'script_review');
  f.db.prepare("UPDATE media_mentor_plans SET plan=? WHERE company_id=2").run(JSON.stringify({days: [{ideaId: 'only-alvi'}]}));
  assert.throws(() => f.materials.create('avokado', {title: 'x', mediaUrl: asset('avokado'), ideaId: 'only-alvi'}, {userId: 7}), {status: 404});
  assert.throws(() => f.materials.create('avokado', {title: 'x', mediaUrl: asset('avokado'), ideaId: '../x'}, {userId: 7}), {status: 400});
  // Код компании ответа сверяется: снимок другой компании не обогащается.
  const foreign = f.stages.apply(f.mentor.get('alvi'), 'avokado', null);
  assert.equal(foreign.company, undefined);
});

test('POST /autoposting/reels с ideaId: вторая загрузка к той же идее — новая версия, не новая карточка', async (t) => {
  const f = fixture(t);
  const handler = createReelMaterialsHandler({materials: f.materials, readJson: async (request) => request.body,
    send: (response, status, body) => Object.assign(response, {status, body}), trustedService: () => false,
    companyModuleContext: (request, code) => ({identity: {userId: 7, userName: 'СММ'}, company: {code}})});
  const call = async (body) => { const response = {}; await handler({method: 'POST', headers: {}, body}, response, new URL('http://crm/autoposting/reels?companyCode=avokado')); return response; };
  const first = await call({title: 'Рилс 5', mediaUrl: asset('avokado'), ideaId: 'i5'});
  assert.equal(first.status, 201); assert.equal(first.body.versionCount, 1);
  const second = await call({title: 'Рилс 5', mediaUrl: asset('avokado', 'b'), ideaId: 'i5', durationMs: 4000});
  assert.equal(second.status, 200); assert.equal(second.body.appended, true); assert.equal(second.body.appendedVersion, 2);
  assert.equal(second.body.id, first.body.id); assert.equal(second.body.versionCount, 2);
  assert.equal(f.materials.list('avokado').reels.filter((reel) => reel.ideaId === 'i5').length, 1);
  // Ролик, взятый из перенесённой публикации идеи, тоже считается роликом идеи.
  f.db.prepare("INSERT INTO autoposting_posts(id,company_id,status,title) VALUES(90,1,'draft','x')").run();
  f.db.prepare("INSERT INTO media_mentor_variant_transfers(company_id,idea_id,platform,post_id) VALUES(1,'i6','vk',90)").run();
  f.db.prepare(`INSERT INTO reel_materials(company_id,title,release_date,platforms,post_id,created_at,updated_at) VALUES(1,'Из плана','','[]',90,'t','t')`).run();
  const linked = await call({title: 'Рилс 6', mediaUrl: asset('avokado', 'c'), ideaId: 'i6'});
  assert.equal(linked.status, 200); assert.equal(linked.body.postId, 90);
  // Старый клиент без ideaId работает как раньше.
  const old = await call({title: 'Старый', mediaUrl: asset('avokado', 'd')});
  assert.equal(old.status, 201); assert.equal(old.body.ideaId, null); assert.equal(old.body.planLink, null);
  assert.equal((await call({title: 'x', mediaUrl: asset('avokado'), ideaId: 'i5', offPlan: true}).catch((error) => error)).status, 400);
});

test('загрузка «вне плана»: черновик идеи, пока план целиком ждёт решения; решённый план не трогается', (t) => {
  const f = fixture(t);
  const before = f.mentor.get('avokado').plan.revision;
  const reel = f.materials.create('avokado', {title: 'Спонтанный рилс', releaseDate: '2026-11-12', platforms: ['vk'], mediaUrl: asset('avokado'), offPlan: true}, {userId: 7, userName: 'СММ'});
  assert.equal(reel.offPlan.created, true); assert.equal(reel.ideaId, reel.offPlan.ideaId);
  const after = f.mentor.get('avokado');
  assert.equal(after.plan.revision, before + 1);
  const draft = after.plan.days.find((day) => day.ideaId === reel.ideaId);
  assert.equal(draft.productionStatus, 'draft'); assert.equal(draft.format, 'reel'); assert.equal(draft.topic, 'Спонтанный рилс');
  assert.equal(f.days('avokado').get(reel.ideaId).stage, 'edit_review', 'у черновика уже есть ролик');
  // План согласован целиком — новая версия сбросила бы решение: черновик не создаётся, ролик сохраняется без связи.
  const current = f.mentor.get('avokado');
  f.mentor.decide('avokado', {planRevision: current.plan.revision, briefRevision: 1, decision: 'approved', comment: ''}, OWNER);
  const loose = f.materials.create('avokado', {title: 'Ещё', mediaUrl: asset('avokado', 'b'), offPlan: true}, {userId: 7});
  assert.equal(loose.offPlan.created, false); assert.equal(loose.offPlan.reason, 'PLAN_DECIDED'); assert.equal(loose.ideaId, null);
  assert.equal(f.mentor.get('avokado').plan.revision, current.plan.revision);
});

test('сохранение плана с вычисленными полями: stage/publications отбрасываются, новой версии нет', (t) => {
  const f = fixture(t);
  const snapshot = f.stages.apply(f.mentor.get('avokado'), 'avokado', null);
  const saved = f.mentor.savePlan('avokado', {planRevision: snapshot.plan.revision, briefRevision: 1, days: snapshot.plan.days}, OWNER);
  assert.equal(saved.plan.revision, snapshot.plan.revision);
  assert.equal(Object.hasOwn(saved.plan.days[0], 'stage'), false);
});

test('GET /media-mentor: этапы, публикации и часовой пояс компании — добавочные поля', async (t) => {
  const f = fixture(t);
  const handler = createMediaMentorHandler({mentor: f.mentor, stages: f.stages,
    transfer: {status: () => ({}), variantStatus: () => ({})},
    companyModuleContext: (request, code) => ({identity: {...OWNER, role: 'owner'}, company: {code}}), readJson: async () => ({}),
    send: (response, status, body) => Object.assign(response, {status, body})});
  const get = async (code, headers = {}) => { const response = {}; await handler({method: 'GET', headers}, response, new URL(`http://crm/media-mentor?companyCode=${code}`)); return response.body; };
  const avokado = await get('avokado', {[FACTS_HEADER]: facts('avokado', {i1: [0, 0, 1, 0, null]})});
  assert.deepEqual(avokado.company, {code: 'avokado', timeZone: 'Asia/Irkutsk', timeZoneSource: 'company'});
  assert.equal(avokado.plan.stageFacts.shooting, true);
  assert.ok(avokado.plan.days.every((day) => typeof day.stage === 'string' && Array.isArray(day.publications)));
  assert.ok(avokado.brief && avokado.approval && avokado.variants, 'прежние поля на месте');
  const alvi = await get('alvi');
  assert.deepEqual(alvi.company, {code: 'alvi', timeZone: null, timeZoneSource: 'unset'});
  assert.equal(alvi.plan.stageFacts.shooting, false);
});
