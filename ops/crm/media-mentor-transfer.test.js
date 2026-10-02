'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createCompanyInformation} = require('./company-information');
const {createAutoposting} = require('./autoposting');
const {createMediaMentor} = require('./media-mentor');
const {createMediaMentorTransfer, MEDIA_MENTOR_TRANSFER_ORIGIN} = require('./media-mentor-transfer');

const ADMIN = {userId: 1, userName: 'Владелец Synapse'};
const EDITOR = {userId: 7, userName: 'Редактор клиента'};
const BRIEF = {goal: 'Записи на массаж', product: 'Массаж 60 минут', audience: 'Офисные сотрудники',
  pains: ['Болит спина'],
  confirmedFacts: [{id: 'f1', statement: 'Приём 10:00–21:00', source: 'Карточка ЛК'}],
  assets: [{id: 'a1', title: 'Съёмка кабинета', kind: 'photo', note: ''}],
  shootingComfort: {level: 'hands_only', notes: ''}, platforms: ['telegram', 'vk']};
const days = (count = 7, patch = () => ({})) => Array.from({length: count}, (item, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`, platform: index % 2 ? 'vk' : 'telegram',
  format: 'post', role: 'reach', topic: `Тема дня ${index + 1}`, hook: `Зацепка ${index + 1}`,
  assetId: 'a1', mentorNote: `Заметка ${index + 1}`, ...patch(index)}));

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,
      timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials)
      VALUES(1,'alvi','ALVI','Asia/Irkutsk','[]'),(2,'avokado','Авокадо','UTC','[]');`);
  let time = Date.parse('2026-09-19T09:00:00Z');
  const publishCalls = [];
  const information = createCompanyInformation(db, {now: () => time});
  const transport = {approvalDestination:(_code,id)=>({destinationRevision:id==='telegram'?1:0,channelRevision:id==='telegram'?1:0}),getSettings: () => ({channels: [{id: 'telegram', enabled: true, connected: true, revision: 1}]}),
    publish: async (input) => { publishCalls.push(input); return {externalId: 'x', url: 'https://example.test/p'}; }};
  const autoposting = createAutoposting(db, {information, transport, now: () => time, logger: {warn() {}}});
  const mentor = createMediaMentor(db, {now: () => time});
  const api = createMediaMentorTransfer(db, {mentor, autoposting, information, now: () => time});
  const ready = (code = 'alvi', plan = days()) => {
    const brief = mentor.saveBrief(code, {revision: 0, brief: BRIEF}, EDITOR);
    const saved = mentor.savePlan(code, {planRevision: 0, briefRevision: brief.brief.revision, days: plan}, EDITOR);
    mentor.decide(code, {planRevision: saved.plan.revision, briefRevision: brief.brief.revision,
      decision: 'approved', comment: 'Берём'}, ADMIN);
    return {planRevision: saved.plan.revision, briefRevision: brief.brief.revision};
  };
  return {db, information, autoposting, mentor, api, ready, publishCalls,
    advance: (ms) => { time += ms; }, drain: () => autoposting.drain()};
}

test('перенос создаёт только черновики: ни публикации, ни очереди, ни каналов и времени', async (t) => {
  const f = fixture(t), versions = f.ready();
  const result = f.api.transfer('alvi', versions, ADMIN);
  assert.equal(result.created, true);
  assert.equal(result.alreadyTransferred, false);
  assert.equal(result.posts.length, 7);
  assert.equal(result.createsPublications, false);
  assert.match(result.notice, /Публикация не выполняется/);
  for (const post of result.posts) {
    assert.equal(post.status, 'draft');
    assert.equal(post.scheduledAt, null);
    assert.deepEqual(post.platformIds, []);
    assert.deepEqual(post.mediaUrls, []);
    assert.equal(post.text, '');
    assert.equal(post.origin, MEDIA_MENTOR_TRANSFER_ORIGIN);
    assert.equal(post.approval.approved, false);
    assert.equal(post.review?.state ?? 'draft', 'draft');
    // Автопостинг сам показывает, чего не хватает: выдуманной готовности нет.
    assert.equal(post.readiness.ready, false);
    assert.ok(post.readiness.issues.some((issue) => /Нет материала/.test(issue)));
    assert.ok(post.readiness.issues.some((issue) => /Нет текста/.test(issue)));
  }
  assert.deepEqual(result.leavesUnfilled, ['Текст поста', 'Материалы (фото или видео)',
    'Каналы публикации', 'Дата и время отправки']);
  // Ни одной доставки и ни одной отправки: рабочий цикл автопостинга ничего не берёт.
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_deliveries').get().n, 0);
  f.advance(10 * 24 * 60 * 60 * 1000);
  await f.drain();
  await f.drain();
  assert.deepEqual(f.publishCalls, []);
  assert.ok(f.autoposting.list('alvi').posts.every((post) => post.status === 'draft'));
});

test('содержание дня переносится без выдумок: тема, формат, роль, зацепка и заметка', (t) => {
  const f = fixture(t), versions = f.ready();
  const result = f.api.transfer('alvi', versions, ADMIN);
  const first = result.posts[0];
  assert.equal(first.title, 'Тема дня 1');
  assert.equal(first.meta.format, 'post');
  assert.equal(first.meta.role, 'reach');
  assert.equal(first.meta.hook, 'Зацепка 1');
  assert.equal(first.meta.idea, 'Тема дня 1');
  assert.equal(first.meta.hughNote, 'Заметка 1');
  assert.match(first.meta.methodSource, /Медиа-наставник · план v1 · бриф v1 · день 2026-10-01 · площадка telegram/);
  assert.equal(first.meta.audience, '', 'аудитория брифа в карточку не додумывается');
  assert.equal(first.meta.metrics, '');
  // day_key в автопостинге — слот D1…D7 недельного пакета, а не календарная дата плана.
  assert.equal(first.dayKey, '');
  assert.deepEqual(result.items.map((item) => [item.dayIndex, item.planDate, item.planPlatform]),
    [[0, '2026-10-01', 'telegram'], [1, '2026-10-02', 'vk'], [2, '2026-10-03', 'telegram'],
      [3, '2026-10-04', 'vk'], [4, '2026-10-05', 'telegram'], [5, '2026-10-06', 'vk'], [6, '2026-10-07', 'telegram']]);
  assert.equal(first.timezone, 'Asia/Irkutsk', 'часовой пояс берётся у компании, а не выдумывается');
});

test('из карточки черновика восстанавливаются точные бриф, задание и исходник без ручного поиска', (t) => {
  const f = fixture(t), versions = f.ready();
  const result = f.api.transfer('alvi', versions, ADMIN);
  const post = result.posts[0];
  // Указатель на самой карточке называет обе неизменяемые версии и конкретный исходник.
  assert.match(post.meta.methodSource, /план v1/);
  assert.match(post.meta.methodSource, /бриф v1/);
  assert.match(post.meta.methodSource, /исходник a1/);
  // Расписка отдаёт задание дня и описание исходника сразу.
  assert.equal(result.items[0].planAssetId, 'a1');
  assert.equal(result.items[0].topic, 'Тема дня 1');
  assert.deepEqual(result.items[0].asset, {id: 'a1', title: 'Съёмка кабинета', kind: 'photo', note: ''});

  const context = f.api.context('alvi', post.id);
  assert.equal(context.postId, post.id);
  assert.deepEqual([context.planRevision, context.briefRevision], [1, 1]);
  // ideaId и variants добавлены версиями площадок: задание дня от этого не изменилось.
  const {ideaId, variants, ...dayFields} = context.day;
  assert.deepEqual(dayFields, {date: '2026-10-01', platform: 'telegram', format: 'post', role: 'reach',
    topic: 'Тема дня 1', hook: 'Зацепка 1', assetId: 'a1', mentorNote: 'Заметка 1'});
  assert.ok(ideaId, 'у идеи есть устойчивый идентификатор');
  assert.deepEqual(Object.keys(variants), ['telegram'], 'старый план читается как одна версия');
  assert.deepEqual(context.asset, {id: 'a1', title: 'Съёмка кабинета', kind: 'photo', note: ''});
  assert.equal(context.assetIsMedia, false, 'исходник — описание, а не готовое медиа');
  assert.match(context.notice, /не готовое медиа/);
  // Бриф приходит целиком, без обрезки: аудитория в карточку не помещалась, здесь она есть.
  assert.equal(context.brief.audience, BRIEF.audience);
  assert.deepEqual(context.brief.pains, BRIEF.pains);
  assert.deepEqual(context.brief.confirmedFacts, BRIEF.confirmedFacts);
  assert.equal(context.decision.decision, 'approved');
});

test('задание черновика берётся из неизменяемой версии и не меняется от поздних правок брифа', (t) => {
  const f = fixture(t), versions = f.ready();
  const result = f.api.transfer('alvi', versions, ADMIN);
  const post = result.posts[0];
  // Владелец переименовал исходник и сменил цель уже после согласования и переноса.
  f.mentor.saveBrief('alvi', {revision: versions.briefRevision, brief: {goal: 'Совсем другая цель',
    assets: [{id: 'a1', title: 'ПЕРЕИМЕНОВАНО ПОЗЖЕ', kind: 'video', note: 'другое'}]}}, EDITOR);
  const context = f.api.context('alvi', post.id);
  assert.equal(context.briefRevision, versions.briefRevision);
  assert.equal(context.brief.goal, BRIEF.goal);
  assert.deepEqual(context.asset, {id: 'a1', title: 'Съёмка кабинета', kind: 'photo', note: ''});
  assert.doesNotMatch(JSON.stringify(context), /ПЕРЕИМЕНОВАНО ПОЗЖЕ/);
});

test('контекст черновика не выдаётся по чужой компании и по чужой карточке', (t) => {
  const f = fixture(t);
  const alvi = f.api.transfer('alvi', f.ready('alvi'), ADMIN);
  f.ready('avokado');
  assert.throws(() => f.api.context('avokado', alvi.posts[0].id), (error) => error.status === 404);
  assert.throws(() => f.api.context('alvi', 999999), (error) => error.status === 404);
  for (const bad of [0, -1, 'abc', null]) {
    assert.throws(() => f.api.context('alvi', bad), (error) => error.status === 404);
  }
  // Карточка, созданная не переносом, контекста не имеет.
  const own = f.autoposting.create('alvi', {title: 'Своя карточка', text: 'Текст',
    profileRevision: f.information.get('alvi').revision}, 7);
  assert.throws(() => f.api.context('alvi', own.id), (error) => error.status === 404);
});

test('длинный идентификатор исходника помещается в указатель карточки', (t) => {
  const f = fixture(t);
  const longId = 'a'.repeat(100);
  const brief = f.mentor.saveBrief('alvi', {revision: 0,
    brief: {...BRIEF, assets: [{id: longId, title: 'Длинный идентификатор', kind: 'photo', note: ''}]}}, EDITOR);
  const plan = f.mentor.savePlan('alvi', {planRevision: 0, briefRevision: brief.brief.revision,
    days: days(7).map((day) => ({...day, assetId: longId}))}, EDITOR);
  f.mentor.decide('alvi', {planRevision: plan.plan.revision, briefRevision: brief.brief.revision,
    decision: 'approved', comment: 'Берём'}, ADMIN);
  const result = f.api.transfer('alvi', {planRevision: plan.plan.revision,
    briefRevision: brief.brief.revision}, ADMIN);
  assert.ok(result.posts[0].meta.methodSource.includes(longId));
  assert.ok(result.posts[0].meta.methodSource.length <= 300);
  assert.equal(f.api.context('alvi', result.posts[0].id).asset.id, longId);
});

test('день без исходника переносится и честно сообщает, что исходник не указан', (t) => {
  const f = fixture(t);
  const versions = f.ready('alvi', days(7).map((day) => ({...day, assetId: ''})));
  const result = f.api.transfer('alvi', versions, ADMIN);
  assert.match(result.posts[0].meta.methodSource, /исходник не указан/);
  assert.equal(result.items[0].planAssetId, '');
  assert.equal(result.items[0].asset, null);
  assert.equal(f.api.context('alvi', result.posts[0].id).asset, null);
});

test('материал берётся из карточки автопостинга: описание исходника за файл не выдаётся', (t) => {
  const f = fixture(t), versions = f.ready();
  const result = f.api.transfer('alvi', versions, ADMIN);
  const post = result.posts[0];
  // Исходник в брифе описан, а файла нет: состояние честное.
  assert.equal(result.items[0].asset.title, 'Съёмка кабинета');
  assert.equal(result.items[0].hasMedia, false);
  assert.equal(result.items[0].mediaCount, 0);
  assert.deepEqual(post.mediaUrls, [], 'описание исходника не подставлено как медиа');
  assert.equal(f.api.status('alvi').awaitingMaterial, 7);
  const before = f.api.context('alvi', post.id);
  assert.equal(before.material.hasMedia, false);
  assert.equal(before.material.mediaKind, 'none');
  assert.equal(before.material.ready, false);
  assert.equal(before.material.uploadPath, '/content/publishing-assets');
  assert.equal(before.material.attachPath, `/autoposting/posts/${post.id}`);
  assert.match(before.material.notice, /Описание исходника из брифа материалом не является/);
  assert.doesNotMatch(JSON.stringify(before.material), /Съёмка кабинета/);

  // Файл прикладывается существующим механизмом автопостинга — второго склада нет.
  const url = 'https://synapse.test/content/publishing-assets/alvi/' + 'a'.repeat(32) + '.jpg';
  f.autoposting.update(post.id, 'alvi', {revision: post.revision, mediaUrls: [url],
    profileRevision: f.information.get('alvi').revision}, ADMIN);
  const after = f.api.context('alvi', post.id);
  assert.equal(after.material.hasMedia, true);
  assert.equal(after.material.mediaCount, 1);
  assert.deepEqual(after.material.mediaUrls, [url]);
  assert.equal(after.material.mediaKind, 'image');
  const status = f.api.status('alvi');
  assert.equal(status.awaitingMaterial, 6);
  assert.equal(status.current.items[0].hasMedia, true);
  assert.equal(status.current.items[1].hasMedia, false);
  // Задание и исходник от загрузки файла не изменились.
  assert.deepEqual(after.asset, before.asset);
  assert.deepEqual(after.day, before.day);
});

test('материал одной компании не виден в другой', (t) => {
  const f = fixture(t);
  const alvi = f.api.transfer('alvi', f.ready('alvi'), ADMIN);
  const avokado = f.api.transfer('avokado', f.ready('avokado'), ADMIN);
  const url = 'https://synapse.test/content/publishing-assets/alvi/' + 'b'.repeat(32) + '.mp4';
  f.autoposting.update(alvi.posts[0].id, 'alvi', {revision: alvi.posts[0].revision, mediaUrls: [url],
    profileRevision: f.information.get('alvi').revision}, ADMIN);
  assert.equal(f.api.status('alvi').awaitingMaterial, 6);
  assert.equal(f.api.status('avokado').awaitingMaterial, 7, 'чужой файл не засчитан');
  assert.doesNotMatch(JSON.stringify(f.api.status('avokado')), /publishing-assets\/alvi/);
  assert.ok(f.api.status('avokado').current.items.every((item) => item.hasMedia === false));
  // Карточка другой компании не читается даже по прямому номеру.
  assert.throws(() => f.api.context('avokado', alvi.posts[0].id), (error) => error.status === 404);
});

test('повторный перенос той же версии не создаёт дубли и возвращает тот же список', (t) => {
  const f = fixture(t), versions = f.ready();
  const first = f.api.transfer('alvi', versions, ADMIN);
  const again = f.api.transfer('alvi', versions, EDITOR);
  assert.equal(again.created, false);
  assert.equal(again.alreadyTransferred, true);
  assert.deepEqual(again.postIds, first.postIds);
  assert.equal(again.actorName, 'Владелец Synapse', 'расписка остаётся от первого переноса');
  assert.equal(f.autoposting.list('alvi').posts.length, 7);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM media_mentor_plan_transfers WHERE company_id=1').get().n, 1);
  assert.throws(() => f.db.prepare('DELETE FROM media_mentor_plan_transfers WHERE company_id=1').run(), /Immutable/);
  assert.throws(() => f.db.prepare(`INSERT INTO media_mentor_plan_transfers
    (company_id,plan_revision,brief_revision,day_count,profile_revision,created_at)
    VALUES(1,?,1,7,1,'2026-09-19T09:00:00.000Z')`).run(versions.planRevision), /UNIQUE/);
});

test('новая согласованная версия плана переносится отдельно и не трогает прошлые черновики', (t) => {
  const f = fixture(t), versions = f.ready();
  const first = f.api.transfer('alvi', versions, ADMIN);
  const updated = f.mentor.savePlan('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision, days: days(8)}, EDITOR);
  f.mentor.decide('alvi', {planRevision: updated.plan.revision, briefRevision: versions.briefRevision,
    decision: 'approved', comment: 'Вторая версия'}, ADMIN);
  const second = f.api.transfer('alvi', {planRevision: updated.plan.revision,
    briefRevision: versions.briefRevision}, ADMIN);
  assert.equal(second.created, true);
  assert.equal(second.posts.length, 8);
  assert.equal(f.autoposting.list('alvi').posts.length, 15);
  assert.equal(new Set([...first.postIds, ...second.postIds]).size, 15, 'карточки не переиспользуются');
  assert.equal(f.api.status('alvi').history.length, 2);
  // Прежние черновики остаются нетронутыми: их не обновили, не заменили и не отменили.
  const kept = f.autoposting.list('alvi').posts.filter((post) => first.postIds.includes(post.id));
  assert.equal(kept.length, 7);
  assert.ok(kept.every((post) => post.status === 'draft'));
  assert.ok(kept.every((post) => /план v1/.test(post.meta.methodSource)));
  // Защита от повтора не распространяется на разные версии — и так и сказано.
  assert.equal(second.repeatProtection, 'Повтор защищён в пределах одной версии плана');
  assert.match(second.newVersionNotice, /остаются в автопостинге как есть/);
});

test('перед переносом новой версии пользователь предупреждён, что старые черновики остаются', (t) => {
  const f = fixture(t), versions = f.ready();
  assert.equal(f.api.status('alvi').previousTransfers, 0);
  assert.equal(f.api.status('alvi').newVersionNotice, '', 'первый перенос пугать нечем');
  f.api.transfer('alvi', versions, ADMIN);
  const afterFirst = f.api.status('alvi');
  assert.equal(afterFirst.previousTransfers, 1);
  assert.equal(afterFirst.canTransfer, false);
  assert.equal(afterFirst.newVersionNotice, '', 'эта версия уже перенесена, новых черновиков не будет');
  const updated = f.mentor.savePlan('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision, days: days(8)}, EDITOR);
  f.mentor.decide('alvi', {planRevision: updated.plan.revision, briefRevision: versions.briefRevision,
    decision: 'approved', comment: 'Вторая версия'}, ADMIN);
  const ready = f.api.status('alvi');
  assert.equal(ready.canTransfer, true);
  assert.equal(ready.previousTransfers, 1);
  assert.match(ready.newVersionNotice, /создаёт новые черновики/);
  assert.match(ready.newVersionNotice, /не обновляются, не заменяются и не удаляются/);
  assert.equal(ready.repeatProtection, 'Повтор защищён в пределах одной версии плана');
});

test('устаревшая версия, изменившийся бриф и несогласованный план не переносятся', (t) => {
  const f = fixture(t);
  const brief = f.mentor.saveBrief('alvi', {revision: 0, brief: BRIEF}, EDITOR);
  const plan = f.mentor.savePlan('alvi', {planRevision: 0, briefRevision: brief.brief.revision, days: days()}, EDITOR);
  const versions = {planRevision: plan.plan.revision, briefRevision: brief.brief.revision};
  // Согласования ещё нет.
  assert.throws(() => f.api.transfer('alvi', versions, ADMIN),
    (error) => error.status === 409 && error.details.code === 'PLAN_NOT_APPROVED');
  assert.throws(() => f.api.transfer('alvi', {...versions, planRevision: 99}, ADMIN),
    (error) => error.status === 409 && error.details.code === 'STALE_PLAN');
  assert.throws(() => f.api.transfer('alvi', {...versions, briefRevision: 99}, ADMIN),
    (error) => error.status === 409 && error.details.code === 'BRIEF_CHANGED');
  f.mentor.decide('alvi', {...versions, decision: 'rejected', comment: 'Переделать'}, ADMIN);
  assert.throws(() => f.api.transfer('alvi', versions, ADMIN),
    (error) => error.status === 409 && error.details.code === 'PLAN_NOT_APPROVED');
  f.mentor.decide('alvi', {...versions, decision: 'approved', comment: ''}, ADMIN);
  // Правка брифа возвращает план на пересогласование — перенос снова закрыт.
  const edited = f.mentor.saveBrief('alvi', {revision: brief.brief.revision, brief: {goal: 'Новая цель'}}, EDITOR);
  assert.equal(edited.approval.status, 'needs_reapproval');
  assert.throws(() => f.api.transfer('alvi', {planRevision: versions.planRevision,
    briefRevision: edited.brief.revision}, ADMIN),
  (error) => error.status === 409 && error.details.code === 'BRIEF_CHANGED');
  assert.equal(f.autoposting.list('alvi').posts.length, 0, 'ни одного черновика после отказов');
});

test('перенос не пересекает компании', (t) => {
  const f = fixture(t), versions = f.ready('alvi');
  f.api.transfer('alvi', versions, ADMIN);
  assert.equal(f.autoposting.list('avokado').posts.length, 0);
  // У другой компании своего плана нет.
  assert.throws(() => f.api.transfer('avokado', versions, ADMIN), (error) => error.status === 404);
  const other = f.ready('avokado', days(7));
  const moved = f.api.transfer('avokado', other, ADMIN);
  assert.equal(moved.posts.length, 7);
  assert.ok(moved.posts.every((post) => post.companyCode === 'avokado'));
  assert.equal(f.autoposting.list('alvi').posts.length, 7);
  assert.equal(f.autoposting.list('avokado').posts.length, 7);
  const alviStatus = f.api.status('alvi'), avokadoStatus = f.api.status('avokado');
  assert.equal(alviStatus.current.postIds.length, 7);
  assert.equal(new Set([...alviStatus.current.postIds, ...avokadoStatus.current.postIds]).size, 14);
  assert.throws(() => f.api.status('missing'), (error) => error.status === 404);
  assert.throws(() => f.api.transfer('../alvi', versions, ADMIN), (error) => error.status === 400);
});

test('слишком длинная тема отклоняется целиком, а не обрезается молча', (t) => {
  const f = fixture(t);
  const long = 'Т'.repeat(201);
  const versions = f.ready('alvi', days(7, (index) => (index === 2 ? {topic: long} : {})));
  assert.throws(() => f.api.transfer('alvi', versions, ADMIN),
    (error) => error.status === 400 && /2026-10-03/.test(error.message) && /200/.test(error.message));
  assert.equal(f.autoposting.list('alvi').posts.length, 0, 'частичного переноса не остаётся');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM media_mentor_plan_transfers').get().n, 0);
});

test('черновик записывает актуальную версию данных компании, а не выдуманную', (t) => {
  const f = fixture(t), versions = f.ready();
  // Правка карточки компании перенос не блокирует: черновик ничего не отправляет,
  // поэтому он просто фиксирует ту версию данных, которая актуальна на момент переноса.
  f.db.prepare("UPDATE companies SET phone='+7 changed' WHERE id=1").run();
  const moved = f.api.transfer('alvi', versions, ADMIN);
  assert.equal(moved.created, true);
  const profile = f.information.get('alvi');
  assert.ok(moved.posts.every((post) => post.profileRevision === profile.revision));
  assert.equal(moved.profileRevision, profile.revision);
  // Дальнейшая правка компании черновики не трогает: они по-прежнему черновики.
  f.db.prepare("UPDATE companies SET city='Иркутск' WHERE id=1").run();
  assert.ok(f.autoposting.list('alvi').posts.every((post) => post.status === 'draft'));
});

test('состояние переноса объясняет, что можно и чего нельзя', (t) => {
  const f = fixture(t);
  const empty = f.api.status('alvi');
  assert.deepEqual([empty.planRevision, empty.canTransfer, empty.blockedReason],
    [null, false, 'План ещё не составлен']);
  assert.equal(empty.createsPublications, false);
  assert.equal(empty.schedules, false);
  assert.equal(empty.choosesChannels, false);
  assert.equal(empty.target, 'autoposting-drafts');
  const versions = f.ready();
  const ready = f.api.status('alvi');
  assert.equal(ready.canTransfer, true);
  assert.equal(ready.approvalStatus, 'approved');
  assert.equal(ready.current, null);
  f.api.transfer('alvi', versions, ADMIN);
  const done = f.api.status('alvi');
  assert.equal(done.canTransfer, false);
  assert.equal(done.blockedReason, 'Эта версия плана уже перенесена');
  assert.equal(done.current.postIds.length, 7);
  assert.equal(done.current.complete, true);
});

test('перенос переживает перезапуск сервиса и не повторяется', (t) => {
  const f = fixture(t), versions = f.ready();
  const first = f.api.transfer('alvi', versions, ADMIN);
  const restarted = createMediaMentorTransfer(f.db,
    {mentor: f.mentor, autoposting: f.autoposting, information: f.information});
  const again = restarted.transfer('alvi', versions, ADMIN);
  assert.equal(again.created, false);
  assert.deepEqual(again.postIds, first.postIds);
  assert.equal(f.autoposting.list('alvi').posts.length, 7);
});

/* ---------- Версии площадок: перенос по версиям и охрана отправки ----------
   Набор живёт в этом файле, а не отдельным модулем: CI перечисляет серверные тесты
   Медиа-наставника поимённо, и отдельный файл в прогон не попадал бы.
   Проверяется не интерфейс, а источник: планирование, фоновый обход очереди и последний
   барьер перед передачей площадке. Отозванная версия не уходит в эфир ни одним из путей. */
const {MEDIA_MENTOR_PLAN_LINK_REASON, MEDIA_MENTOR_PLAN_PLATFORM_REASON} = require('./media-mentor-plan-link');
const VARIANT_ADMIN = ADMIN, VARIANT_EDITOR = EDITOR;
const variantsOf = (patch = {}) => ({
  telegram: {text: 'Телеграм: свой текст', hook: 'ТГ зацепка'},
  vk: {text: 'ВК: свой текст', hook: 'ВК зацепка'}, ...patch});
const variantDays = (count = 7) => Array.from({length: count}, (item, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`, platform: index % 2 ? 'vk' : 'telegram',
  format: 'post', role: 'reach', topic: `Тема дня ${index + 1}`, hook: `Зацепка ${index + 1}`,
  assetId: 'a1', mentorNote: `Заметка ${index + 1}`, variants: variantsOf()}));

function variantFixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,
      timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials)
      VALUES(1,'alvi','ALVI','Asia/Irkutsk','[]'),(2,'avokado','Авокадо','UTC','[]');`);
  let time = Date.parse('2026-09-19T09:00:00Z');
  const publishCalls = [];
  const information = createCompanyInformation(db, {now: () => time});
  const channels = [{id: 'telegram', platform: 'telegram', enabled: true, connected: true, revision: 1},
    {id: 'vk', platform: 'vk', enabled: true, connected: true, revision: 1}];
  const hooks = {beforeEachPublish: null};
  const transport = {approvalDestination:(_code,id)=>{const channel=channels.find(item=>item.id===id);return {destinationRevision:channel?.revision||0,channelRevision:channel?.revision||0};},getSettings: async () => ({channels}),
    publish: async (input) => {
      if (hooks.beforeEachPublish) await hooks.beforeEachPublish(input);
      if (input.beforePublish) input.beforePublish();
      publishCalls.push({channelId: input.channelId, text: input.post.text});
      return {externalId: `x-${publishCalls.length}`, url: 'https://example.test/p'};
    }};
  const autoposting = createAutoposting(db, {information, transport, now: () => time, logger: {warn() {}}});
  const mentor = createMediaMentor(db, {now: () => time});
  const api = createMediaMentorTransfer(db, {mentor, autoposting, information, now: () => time});
  const ready = (code = 'alvi', plan = variantDays()) => {
    const brief = mentor.saveBrief(code, {revision: 0, brief: BRIEF}, VARIANT_EDITOR);
    const saved = mentor.savePlan(code, {planRevision: 0, briefRevision: brief.brief.revision, days: plan}, VARIANT_EDITOR);
    return {planRevision: saved.plan.revision, briefRevision: brief.brief.revision, plan: saved.plan};
  };
  const approveAll = (code, versions) => mentor.decideVariants(code,
    {planRevision: versions.planRevision, briefRevision: versions.briefRevision,
      scope: 'plan', decision: 'approved', comment: ''}, VARIANT_ADMIN);
  /* Постановка карточки в план обычным путём автопостинга: каналы, материал, ОТДЕЛЬНОЕ
     одобрение материала и время задаёт владелец. Согласование плана этого не заменяет. */
  const prepare = (postId, code, channelIds) => {
    let post = autoposting.get(postId, code);
    return autoposting.update(postId, code, {revision: post.revision, platformIds: channelIds,
      mediaUrls: ['https://example.test/a.jpg'], profileRevision: post.profileRevision}, VARIANT_ADMIN);
  };
  const approve = (postId, code, channelIds) => {
    const post = autoposting.get(postId, code);
    return autoposting.approve(postId, code, {revision: post.revision, approved: true,
      comment: '', platformIds: channelIds}, VARIANT_ADMIN);
  };
  const queue = async (postId, code, channelIds) => {
    prepare(postId, code, channelIds);
    approve(postId, code, channelIds);
    const post = autoposting.get(postId, code);
    return await autoposting.schedule(postId, code, {revision: post.revision,
      scheduledAt: new Date(time + 3600000).toISOString(), timezone: 'Asia/Irkutsk',
      profileRevision: post.profileRevision, platformIds: channelIds});
  };
  // Площадка канала меняется независимо от его идентификатора: id и platform — разные вещи.
  const renameChannel = (channelId, platform) => {
    const channel = channels.find((item) => item.id === channelId);
    // Ревизия канала НЕ меняется: иначе сработала бы прежняя проверка CHANNEL_CHANGED,
    // и подмена площадки осталась бы непроверенной.
    channel.platform = platform;
  };
  return {db, information, autoposting, mentor, api, ready, approveAll, queue, prepare, approve,
    renameChannel, publishCalls, hooks,
    now: () => time, advance: (ms) => { time += ms; }, drain: () => autoposting.drain()};
}

test('перенос идёт по версиям площадок: каждый согласованный текст становится своим черновиком', (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  assert.equal(result.createdCount, 14, 'семь идей по две согласованные версии');
  assert.equal(result.createsPublications, false);
  const texts = new Set(result.posts.map((post) => post.text));
  assert.ok(texts.has('Телеграм: свой текст') && texts.has('ВК: свой текст'),
    'полный текст версии сохраняется, а не обрезается и не склеивается');
  for (const post of result.posts) {
    assert.equal(post.status, 'draft');
    assert.equal(post.scheduledAt, null, 'плановое время версии очередью публикации не становится');
    assert.deepEqual(post.platformIds, [], 'каналы не выбираются');
    assert.equal(post.dayKey, '');
    assert.equal(post.origin, MEDIA_MENTOR_TRANSFER_ORIGIN);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_deliveries').get().n, 0);
  // Происхождение названо целиком и не меняется задним числом.
  assert.match(result.posts[0].meta.methodSource,
    /план v1 · бриф v1 · идея idea-[\w-]+ · площадка \w+ · версия содержимого 1/);
  assert.match(result.posts[0].meta.methodSource, /ориентир плана, не очередь публикации/);
});

test('несогласованная, пустая и исключённая версии не переносятся', (t) => {
  const f = variantFixture(t);
  const plan = variantDays().map((day, index) => index === 0
    ? {...day, variants: {telegram: {text: 'Только телеграм'}, vk: {text: '', excluded: true}}} : day);
  const versions = f.ready('alvi', plan);
  const state = f.mentor.decideVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision, scope: 'idea',
    ideaId: versions.plan.days[0].ideaId, decision: 'approved', comment: ''}, VARIANT_ADMIN);
  const result = f.api.transferVariants('alvi', {planRevision: state.plan.revision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  assert.equal(result.createdCount, 1, 'только одна согласованная непустая версия');
  assert.equal(result.posts[0].text, 'Только телеграм');
});

test('повтор переноса не дублирует, а правка соседней версии не трогает уже перенесённые', (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const body = {planRevision: versions.planRevision, briefRevision: versions.briefRevision};
  const first = f.api.transferVariants('alvi', body, VARIANT_ADMIN);
  const again = f.api.transferVariants('alvi', body, VARIANT_ADMIN);
  assert.equal(again.createdCount, 0);
  assert.equal(again.alreadyTransferred, 14);
  assert.deepEqual(again.skipped.map((item) => item.postId).sort(),
    first.created.map((item) => item.postId).sort());
  // Правится только текст vk первой идеи: остальные версии сохраняют свою ревизию содержимого.
  const state = f.mentor.get('alvi');
  const edited = state.plan.days.map((day, index) => index === 0
    ? {...day, variants: {...day.variants, vk: {...day.variants.vk, text: 'ВК: новый текст'}}} : day);
  const saved = f.mentor.savePlan('alvi', {planRevision: state.plan.revision,
    briefRevision: versions.briefRevision, days: edited}, VARIANT_EDITOR);
  const after = f.api.transferVariants('alvi', {planRevision: saved.plan.revision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  assert.equal(after.createdCount, 0, 'правленая версия ещё не согласована — переносить нечего');
  assert.equal(after.alreadyTransferred, 13, 'нетронутые версии не переносятся заново');
  assert.equal(f.autoposting.list('alvi').posts.length, 14, 'дубликатов не появилось');
});

test('старая расписка по дням остаётся нетронутой и только читается', (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.mentor.decide('alvi', {planRevision: versions.planRevision, briefRevision: versions.briefRevision,
    decision: 'approved', comment: 'Берём'}, VARIANT_ADMIN);
  const legacy = f.api.transfer('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  assert.equal(legacy.created, true);
  const before = f.db.prepare('SELECT COUNT(*) n FROM media_mentor_plan_transfer_items').get().n;
  f.approveAll('alvi', versions);
  f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM media_mentor_plan_transfer_items').get().n, before,
    'перенос по версиям не переписывает прежнюю расписку');
  assert.equal(f.api.status('alvi').current.items.length, 7, 'прежняя расписка читается как была');
});

test('отзыв согласования версии запрещает постановку карточки в план', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const item = result.created.find((row) => row.platform === 'telegram');
  const state = f.mentor.get('alvi');
  f.mentor.decideVariants('alvi', {planRevision: state.plan.revision, briefRevision: versions.briefRevision,
    scope: 'variants', ideaId: item.ideaId, platforms: ['telegram'],
    decision: 'withdrawn', comment: 'Передумали'}, VARIANT_ADMIN);
  await assert.rejects(() => f.queue(item.postId, 'alvi', ['telegram']),
    (error) => error.details.code === MEDIA_MENTOR_PLAN_LINK_REASON);
});

test('отзыв после постановки в план снимает отправку в рабочем цикле, а не только в интерфейсе', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const item = result.created.find((row) => row.platform === 'telegram');
  await f.queue(item.postId, 'alvi', ['telegram']);
  const state = f.mentor.get('alvi');
  f.mentor.decideVariants('alvi', {planRevision: state.plan.revision, briefRevision: versions.briefRevision,
    scope: 'variants', ideaId: item.ideaId, platforms: ['telegram'],
    decision: 'withdrawn', comment: 'Передумали'}, VARIANT_ADMIN);
  f.advance(2 * 3600000);
  await f.drain();
  assert.deepEqual(f.publishCalls, [], 'отозванная версия не ушла в эфир');
  const post = f.autoposting.get(item.postId, 'alvi');
  assert.equal(post.status, 'needs_review');
  assert.equal(post.lastErrorCode, MEDIA_MENTOR_PLAN_LINK_REASON);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM autoposting_deliveries WHERE post_id=? AND status='pending'")
    .get(item.postId).n, 0, 'ожидающая доставка снята, а не оставлена на следующий проход');
});

test('отзыв во время ожидания транспорта останавливает передачу на последнем барьере', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const item = result.created.find((row) => row.platform === 'telegram');
  await f.queue(item.postId, 'alvi', ['telegram']);
  f.advance(2 * 3600000);
  // Отзыв происходит уже внутри отправки, пока транспорт ждёт предварительные запросы.
  f.hooks.beforeEachPublish = async () => {
    const state = f.mentor.get('alvi');
    f.mentor.decideVariants('alvi', {planRevision: state.plan.revision, briefRevision: versions.briefRevision,
      scope: 'variants', ideaId: item.ideaId, platforms: ['telegram'],
      decision: 'withdrawn', comment: 'Передумали'}, VARIANT_ADMIN);
  };
  await f.drain();
  assert.deepEqual(f.publishCalls, [], 'барьер сработал до передачи площадке');
  const delivery = f.db.prepare('SELECT status,error_code errorCode FROM autoposting_deliveries WHERE post_id=?').get(item.postId);
  assert.equal(delivery.status, 'failed', 'неоднозначной отправки не было: запрет однозначен');
  // Повторного прохода отправка не получает: карточка ушла на разбор.
  f.hooks.beforeEachPublish = null;
  await f.drain();
  assert.deepEqual(f.publishCalls, []);
});

test('отзыв одной площадки не касается соседней версии той же идеи', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const idea = result.created[0].ideaId;
  const tg = result.created.find((row) => row.ideaId === idea && row.platform === 'telegram');
  const vk = result.created.find((row) => row.ideaId === idea && row.platform === 'vk');
  await f.queue(tg.postId, 'alvi', ['telegram']);
  await f.queue(vk.postId, 'alvi', ['vk']);
  const state = f.mentor.get('alvi');
  f.mentor.decideVariants('alvi', {planRevision: state.plan.revision, briefRevision: versions.briefRevision,
    scope: 'variants', ideaId: idea, platforms: ['telegram'],
    decision: 'withdrawn', comment: 'Только телеграм'}, VARIANT_ADMIN);
  f.advance(2 * 3600000);
  await f.drain();
  await f.drain();
  assert.deepEqual(f.publishCalls.map((call) => call.channelId), ['vk'], 'соседняя версия ушла как была');
  assert.equal(f.publishCalls[0].text, 'ВК: свой текст');
  assert.equal(f.autoposting.get(tg.postId, 'alvi').status, 'needs_review');
});

test('правка текста версии после переноса останавливает отправку прежнего черновика', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const item = result.created.find((row) => row.platform === 'telegram');
  await f.queue(item.postId, 'alvi', ['telegram']);
  const state = f.mentor.get('alvi');
  const edited = state.plan.days.map((day) => day.ideaId === item.ideaId
    ? {...day, variants: {...day.variants, telegram: {...day.variants.telegram, text: 'Переписали'}}} : day);
  f.mentor.savePlan('alvi', {planRevision: state.plan.revision,
    briefRevision: versions.briefRevision, days: edited}, VARIANT_EDITOR);
  f.advance(2 * 3600000);
  await f.drain();
  assert.deepEqual(f.publishCalls, [], 'старый текст не ушёл после правки версии');
});

test('очистка подписей и дня недели не снимает связь с версией плана', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const item = result.created.find((row) => row.platform === 'telegram');
  let post = f.autoposting.get(item.postId, 'alvi');
  post = f.autoposting.update(item.postId, 'alvi', {revision: post.revision, dayKey: '', captions: {},
    mediaUrls: ['https://example.test/a.jpg'], platformIds: ['telegram'],
    profileRevision: post.profileRevision}, VARIANT_ADMIN);
  const state = f.mentor.get('alvi');
  f.mentor.decideVariants('alvi', {planRevision: state.plan.revision, briefRevision: versions.briefRevision,
    scope: 'variants', ideaId: item.ideaId, platforms: ['telegram'],
    decision: 'withdrawn', comment: 'Передумали'}, VARIANT_ADMIN);
  await assert.rejects(() => f.autoposting.schedule(item.postId, 'alvi', {revision: post.revision,
    scheduledAt: new Date(f.now() + 3600000).toISOString(), timezone: 'Asia/Irkutsk',
    profileRevision: post.profileRevision, platformIds: ['telegram']}),
  (error) => error.details.code === MEDIA_MENTOR_PLAN_LINK_REASON);
});

test('состоявшаяся отправка не отменяется задним числом и не повторяется', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const item = result.created.find((row) => row.platform === 'telegram');
  await f.queue(item.postId, 'alvi', ['telegram']);
  f.advance(2 * 3600000);
  await f.drain();
  assert.equal(f.publishCalls.length, 1);
  const published = f.db.prepare('SELECT status,external_id externalId FROM autoposting_deliveries WHERE post_id=?').get(item.postId);
  assert.equal(published.status, 'published');
  // Отзыв после отправки: запись о публикации остаётся, повторной отправки не происходит.
  const state = f.mentor.get('alvi');
  f.mentor.decideVariants('alvi', {planRevision: state.plan.revision, briefRevision: versions.briefRevision,
    scope: 'variants', ideaId: item.ideaId, platforms: ['telegram'],
    decision: 'withdrawn', comment: 'Поздно'}, VARIANT_ADMIN);
  await f.drain();
  await f.drain();
  assert.equal(f.publishCalls.length, 1, 'повтора отправки нет');
  const after = f.db.prepare('SELECT status,external_id externalId FROM autoposting_deliveries WHERE post_id=?').get(item.postId);
  assert.deepEqual(after, published, 'результат состоявшейся отправки не стёрт');
  assert.equal(f.autoposting.get(item.postId, 'alvi').status, 'published');
});

test('продолжение по оставшимся площадкам для карточки из плана прямо запрещено', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const item = result.created.find((row) => row.platform === 'telegram');
  f.prepare(item.postId, 'alvi', ['telegram', 'vk']);
  f.approve(item.postId, 'alvi', ['telegram']);
  const post = f.autoposting.get(item.postId, 'alvi');
  await f.autoposting.schedule(item.postId, 'alvi', {revision: post.revision,
    scheduledAt: new Date(f.now() + 3600000).toISOString(), timezone: 'Asia/Irkutsk',
    profileRevision: post.profileRevision, platformIds: ['telegram']});
  f.advance(2 * 3600000);
  await f.drain();
  const sent = f.autoposting.get(item.postId, 'alvi');
  assert.equal(sent.status, 'published');
  assert.throws(() => f.autoposting.split(item.postId, 'alvi',
    {revision: sent.revision, platformIds: ['vk'], reason: 'Добьём ВК'}, VARIANT_ADMIN),
  (error) => error.details.code === 'PLAN_LINKED_POST');
});

test('чужая компания не видит переносы и не снимает охрану', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const item = result.created[0];
  assert.deepEqual(f.api.variantStatus('avokado').items, []);
  assert.throws(() => f.autoposting.get(item.postId, 'avokado'), (error) => error.details.code === 'NOT_FOUND');
  // Подделка тела запроса охрану не снимает: связь и решения читаются из базы.
  const state = f.mentor.get('alvi');
  f.mentor.decideVariants('alvi', {planRevision: state.plan.revision, briefRevision: versions.briefRevision,
    scope: 'variants', ideaId: item.ideaId, platforms: [item.platform],
    decision: 'withdrawn', comment: 'Передумали'}, VARIANT_ADMIN);
  await assert.rejects(() => f.queue(item.postId, 'alvi', [item.platform]),
    (error) => error.details.code === MEDIA_MENTOR_PLAN_LINK_REASON);
});

test('перенос отказывает на устаревшей версии плана и на изменившемся брифе', (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  assert.throws(() => f.api.transferVariants('alvi', {planRevision: versions.planRevision + 5,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN), (error) => error.details.code === 'STALE_PLAN');
  f.mentor.saveBrief('alvi', {revision: versions.briefRevision,
    brief: {...BRIEF, goal: 'Новая цель'}}, VARIANT_EDITOR);
  assert.throws(() => f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN), (error) => error.details.code === 'BRIEF_CHANGED');
});

/* ---------- Блокеры независимой приёмки, раунд 1 ---------- */

test('решение по прежней версии брифа переносом и отправкой не считается', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const first = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const item = first.created.find((row) => row.platform === 'telegram');
  await f.queue(item.postId, 'alvi', ['telegram']);
  // Бриф уехал вперёд, план сохранён по нему теми же версиями — содержимое не менялось.
  const brief = f.mentor.saveBrief('alvi', {revision: versions.briefRevision,
    brief: {...BRIEF, goal: 'Новая цель'}}, VARIANT_EDITOR);
  const state = f.mentor.get('alvi');
  const saved = f.mentor.savePlan('alvi', {planRevision: state.plan.revision,
    briefRevision: brief.brief.revision, days: state.plan.days}, VARIANT_EDITOR);
  const map = new Map(saved.variants.map((row) => [`${row.ideaId}|${row.platform}`, row]));
  assert.equal(map.get(`${item.ideaId}|telegram`).status, 'pending', 'интерфейс требует пересогласования');
  // Перенос по прежнему согласию не проходит.
  const again = f.api.transferVariants('alvi', {planRevision: saved.plan.revision,
    briefRevision: brief.brief.revision}, VARIANT_ADMIN);
  assert.equal(again.createdCount, 0, 'по решению из прежнего контекста переносить нечего');
  // И отправка тоже: guard читает решение в действующем контексте брифа.
  f.advance(2 * 3600000);
  await f.drain();
  assert.deepEqual(f.publishCalls, [], 'старое согласие отправку не разрешает');
  assert.equal(f.autoposting.get(item.postId, 'alvi').lastErrorCode, MEDIA_MENTOR_PLAN_LINK_REASON);
});

test('после пересогласования по новому брифу повтор переноса не создаёт дубликат', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const first = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const before = f.autoposting.list('alvi').posts.length;
  const brief = f.mentor.saveBrief('alvi', {revision: versions.briefRevision,
    brief: {...BRIEF, goal: 'Новая цель'}}, VARIANT_EDITOR);
  const state = f.mentor.get('alvi');
  const saved = f.mentor.savePlan('alvi', {planRevision: state.plan.revision,
    briefRevision: brief.brief.revision, days: state.plan.days}, VARIANT_EDITOR);
  f.mentor.decideVariants('alvi', {planRevision: saved.plan.revision,
    briefRevision: brief.brief.revision, scope: 'plan', decision: 'approved', comment: ''}, VARIANT_ADMIN);
  const again = f.api.transferVariants('alvi', {planRevision: saved.plan.revision,
    briefRevision: brief.brief.revision}, VARIANT_ADMIN);
  assert.equal(again.createdCount, 0, 'содержимое не менялось — черновики те же');
  assert.equal(again.alreadyTransferred, first.createdCount);
  assert.equal(f.autoposting.list('alvi').posts.length, before, 'дубликатов не появилось');
  // Прежний черновик снова отправляем: контекст снова актуален.
  const item = first.created.find((row) => row.platform === 'telegram');
  await f.queue(item.postId, 'alvi', ['telegram']);
  f.advance(2 * 3600000);
  await f.drain();
  assert.equal(f.publishCalls.length, 1);
});

test('согласование плана не заменяет отдельное одобрение материала: schedule требует approve', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const item = result.created.find((row) => row.platform === 'telegram');
  // Текст карточки переписан после переноса — публикуется именно он, и его никто не одобрял.
  let post = f.autoposting.get(item.postId, 'alvi');
  post = f.autoposting.update(item.postId, 'alvi', {revision: post.revision, text: 'Совсем другой текст',
    platformIds: ['telegram'], mediaUrls: ['https://example.test/a.jpg'],
    profileRevision: post.profileRevision}, VARIANT_ADMIN);
  assert.equal(post.dayKey, '', 'признаков очереди у карточки нет');
  assert.deepEqual(post.captions, {}, 'подписи пусты — проверка не должна на них опираться');
  await assert.rejects(() => f.autoposting.schedule(item.postId, 'alvi', {revision: post.revision,
    scheduledAt: new Date(f.now() + 3600000).toISOString(), timezone: 'Asia/Irkutsk',
    profileRevision: post.profileRevision, platformIds: ['telegram']}),
  (error) => error.details.code === 'APPROVAL_REQUIRED');
  // После отдельного одобрения материала отправка проходит.
  f.approve(item.postId, 'alvi', ['telegram']);
  const ready = f.autoposting.get(item.postId, 'alvi');
  await f.autoposting.schedule(item.postId, 'alvi', {revision: ready.revision,
    scheduledAt: new Date(f.now() + 3600000).toISOString(), timezone: 'Asia/Irkutsk',
    profileRevision: ready.profileRevision, platformIds: ['telegram']});
  f.advance(2 * 3600000);
  await f.drain();
  assert.deepEqual(f.publishCalls.map((call) => call.text), ['Совсем другой текст']);
});

test('снятое одобрение материала останавливает отправку в рабочем цикле и перед передачей', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const item = result.created.find((row) => row.platform === 'telegram');
  await f.queue(item.postId, 'alvi', ['telegram']);
  // Одобрение материала снято уже после постановки в план.
  const queued = f.autoposting.get(item.postId, 'alvi');
  f.autoposting.approve(item.postId, 'alvi', {revision: queued.revision, approved: false,
    comment: 'Переписать', platformIds: ['telegram']}, VARIANT_ADMIN);
  f.advance(2 * 3600000);
  await f.drain();
  assert.deepEqual(f.publishCalls, [], 'без действующего одобрения материала отправки нет');
});

test('канал другой площадки для карточки из плана запрещён и при живом одобрении материала', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  // Версия ВК возвращена на доработку, согласована только TG.
  const idea = result.created[0].ideaId;
  const state = f.mentor.get('alvi');
  f.mentor.decideVariants('alvi', {planRevision: state.plan.revision,
    briefRevision: versions.briefRevision, scope: 'variants', ideaId: idea, platforms: ['vk'],
    decision: 'rejected', comment: 'Переписать'}, VARIANT_ADMIN);
  const tg = result.created.find((row) => row.ideaId === idea && row.platform === 'telegram');
  f.prepare(tg.postId, 'alvi', ['vk']);
  f.approve(tg.postId, 'alvi', ['vk']);
  const post = f.autoposting.get(tg.postId, 'alvi');
  await assert.rejects(() => f.autoposting.schedule(tg.postId, 'alvi', {revision: post.revision,
    scheduledAt: new Date(f.now() + 3600000).toISOString(), timezone: 'Asia/Irkutsk',
    profileRevision: post.profileRevision, platformIds: ['vk']}),
  (error) => error.details.code === MEDIA_MENTOR_PLAN_PLATFORM_REASON);
});

test('площадка канала берётся из самого канала, а не из его идентификатора', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const tg = result.created.find((row) => row.platform === 'telegram');
  // Канал с идентификатором telegram, но фактической площадкой vk: совпадение id обманывать не должно.
  f.renameChannel('telegram', 'vk');
  f.prepare(tg.postId, 'alvi', ['telegram']);
  f.approve(tg.postId, 'alvi', ['telegram']);
  const post = f.autoposting.get(tg.postId, 'alvi');
  await assert.rejects(() => f.autoposting.schedule(tg.postId, 'alvi', {revision: post.revision,
    scheduledAt: new Date(f.now() + 3600000).toISOString(), timezone: 'Asia/Irkutsk',
    profileRevision: post.profileRevision, platformIds: ['telegram']}),
  (error) => error.details.code === MEDIA_MENTOR_PLAN_PLATFORM_REASON);
});

test('подмена площадки, возникшая после постановки в план, останавливает отправку', async (t) => {
  const f = variantFixture(t), versions = f.ready();
  f.approveAll('alvi', versions);
  const result = f.api.transferVariants('alvi', {planRevision: versions.planRevision,
    briefRevision: versions.briefRevision}, VARIANT_ADMIN);
  const tg = result.created.find((row) => row.platform === 'telegram');
  await f.queue(tg.postId, 'alvi', ['telegram']);
  // Владелец переназначил площадку канала уже после постановки в план.
  f.renameChannel('telegram', 'vk');
  f.advance(2 * 3600000);
  await f.drain();
  assert.deepEqual(f.publishCalls, [], 'канал уводит материал не на ту площадку — отправки нет');
  const post = f.autoposting.get(tg.postId, 'alvi');
  assert.equal(post.status, 'needs_review');
  assert.equal(post.lastErrorCode, MEDIA_MENTOR_PLAN_PLATFORM_REASON, 'названа именно подмена площадки');
});
