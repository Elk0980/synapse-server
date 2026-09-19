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
  const transport = {getSettings: () => ({channels: [{id: 'telegram', enabled: true, connected: true, revision: 1}]}),
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
  assert.deepEqual(context.day, {date: '2026-10-01', platform: 'telegram', format: 'post', role: 'reach',
    topic: 'Тема дня 1', hook: 'Зацепка 1', assetId: 'a1', mentorNote: 'Заметка 1'});
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
