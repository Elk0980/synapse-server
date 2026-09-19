'use strict';
/* Синтетический приёмочный сценарий трёх проектов: АЛВИ и Авокадо — пилот,
   Палитра — подключение. Данные здесь выдуманные и техничные: настоящие брифы клиентов
   в тесты не переносятся. Проверяется главное — три проекта не смешиваются ни в брифе,
   ни в плане, ни в согласовании, ни в черновиках, ни в материалах. */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createCompanyInformation} = require('./company-information');
const {createAutoposting} = require('./autoposting');
const {createMediaMentor} = require('./media-mentor');
const {createMediaMentorTransfer} = require('./media-mentor-transfer');

const ADMIN = {userId: 1, userName: 'Владелец Synapse'};
// Метка компании подставляется во все тексты, чтобы протечка была видна сразу.
const PROJECTS = [
  {code: 'alvi', stage: 'пилот', mark: 'MARK-ALVI', platform: 'telegram'},
  {code: 'avokado', stage: 'пилот', mark: 'MARK-AVOKADO', platform: 'vk'},
  {code: 'palitra-love', stage: 'подключение', mark: 'MARK-PALITRA', platform: 'telegram'},
];

function brief(mark, platform) {
  return {goal: `Цель ${mark}`, product: `Продукт ${mark}`, audience: `Аудитория ${mark}`,
    pains: [`Боль ${mark}`],
    confirmedFacts: [{id: 'f1', statement: `Факт ${mark}`, source: `Источник ${mark}`}],
    assets: [{id: 'asset-1', title: `Исходник ${mark}`, kind: 'photo', note: `Заметка ${mark}`}],
    shootingComfort: {level: 'hands_only', notes: `Комфорт ${mark}`}, platforms: [platform]};
}
const days = (mark, platform, count = 7) => Array.from({length: count}, (item, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`, platform, format: 'post', role: 'reach',
  topic: `Тема ${mark} ${index + 1}`, hook: `Зацепка ${mark}`, assetId: 'asset-1',
  mentorNote: `Заметка наставника ${mark}`}));

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,
      timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES
      (1,'alvi','ALVI','Asia/Irkutsk','[]'),(2,'avokado','Авокадо','UTC','[]'),
      (3,'palitra-love','Палитра','Europe/Moscow','[]');`);
  let time = Date.parse('2026-09-19T09:00:00Z');
  const publishCalls = [];
  const information = createCompanyInformation(db, {now: () => time});
  const transport = {getSettings: () => ({channels: []}),
    publish: async (input) => { publishCalls.push(input); return {externalId: 'x', url: 'https://example.test/p'}; }};
  const autoposting = createAutoposting(db, {information, transport, now: () => time, logger: {warn() {}}});
  const mentor = createMediaMentor(db, {now: () => time});
  const transfer = createMediaMentorTransfer(db, {mentor, autoposting, information, now: () => time});
  return {db, information, autoposting, mentor, transfer, publishCalls,
    advance: (ms) => { time += ms; }};
}

test('три проекта проходят путь до черновиков с материалом и нигде не смешиваются', async (t) => {
  const f = fixture(t), state = new Map();

  // 1. Бриф каждого проекта — свой.
  for (const project of PROJECTS) {
    const saved = f.mentor.saveBrief(project.code, {revision: 0, brief: brief(project.mark, project.platform)}, ADMIN);
    assert.equal(saved.brief.revision, 1);
    state.set(project.code, {briefRevision: saved.brief.revision});
  }
  for (const project of PROJECTS) {
    const snapshot = f.mentor.get(project.code);
    assert.equal(snapshot.brief.fields.goal, `Цель ${project.mark}`);
    for (const other of PROJECTS.filter((item) => item.code !== project.code)) {
      assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(other.mark), `${project.code} видит ${other.mark}`);
    }
  }

  // 2. План 7–14 дней и 3. утверждение конкретной версии.
  for (const project of PROJECTS) {
    const versions = state.get(project.code);
    const plan = f.mentor.savePlan(project.code, {planRevision: 0, briefRevision: versions.briefRevision,
      days: days(project.mark, project.platform)}, ADMIN);
    assert.equal(plan.plan.windowDays, 7);
    assert.equal(plan.approval.status, 'pending');
    f.mentor.decide(project.code, {planRevision: plan.plan.revision, briefRevision: versions.briefRevision,
      decision: 'approved', comment: `Согласовано ${project.mark}`}, ADMIN);
    versions.planRevision = plan.plan.revision;
    assert.equal(f.mentor.get(project.code).approval.status, 'approved');
  }
  // Чужая площадка в план не проходит: у каждого проекта своя.
  assert.throws(() => f.mentor.savePlan('palitra-love', {planRevision: 1, briefRevision: 1,
    days: days('MARK-PALITRA', 'vk')}, ADMIN), (error) => error.status === 400);

  // 4. Перенос в черновики и 5. материал.
  for (const project of PROJECTS) {
    const versions = state.get(project.code);
    const moved = f.transfer.transfer(project.code, versions, ADMIN);
    assert.equal(moved.created, true);
    assert.equal(moved.posts.length, 7);
    assert.ok(moved.posts.every((post) => post.status === 'draft' && post.mediaUrls.length === 0));
    versions.postIds = moved.postIds;
    versions.firstPost = moved.posts[0];
    assert.equal(f.transfer.status(project.code).awaitingMaterial, 7);
  }
  for (const project of PROJECTS) {
    const versions = state.get(project.code);
    const url = `https://synapse.test/content/publishing-assets/${project.code}/${project.code.replace(/[^a-z]/g, '').padEnd(32, 'z').slice(0, 32)}.jpg`;
    f.autoposting.update(versions.firstPost.id, project.code, {revision: versions.firstPost.revision,
      mediaUrls: [url], profileRevision: f.information.get(project.code).revision}, ADMIN);
    versions.mediaUrl = url;
  }

  // Ни один проект не видит чужого: ни задания, ни исходника, ни файла, ни черновика.
  for (const project of PROJECTS) {
    const versions = state.get(project.code);
    const status = f.transfer.status(project.code);
    assert.equal(status.awaitingMaterial, 6);
    assert.equal(status.current.items.filter((item) => item.hasMedia).length, 1);
    const context = f.transfer.context(project.code, versions.firstPost.id);
    assert.equal(context.brief.audience, `Аудитория ${project.mark}`);
    assert.equal(context.asset.title, `Исходник ${project.mark}`);
    assert.deepEqual(context.material.mediaUrls, [versions.mediaUrl]);
    const own = JSON.stringify({status, context, posts: f.autoposting.list(project.code).posts});
    for (const other of PROJECTS.filter((item) => item.code !== project.code)) {
      assert.doesNotMatch(own, new RegExp(other.mark), `${project.code} видит ${other.mark}`);
      assert.doesNotMatch(own, new RegExp(`publishing-assets/${other.code}`), `${project.code} видит файл ${other.code}`);
      assert.throws(() => f.transfer.context(project.code, state.get(other.code).firstPost.id),
        (error) => error.status === 404, `${project.code} читает карточку ${other.code}`);
    }
    assert.equal(f.autoposting.list(project.code).posts.length, 7);
  }

  // 6. Onlypult и 7. результат: каналов нет, поэтому публикаций быть не может.
  for (const project of PROJECTS) {
    assert.ok(f.autoposting.list(project.code).posts.every((post) => post.platformIds.length === 0));
  }
  f.advance(30 * 24 * 60 * 60 * 1000);
  await f.autoposting.drain();
  await f.autoposting.drain();
  assert.deepEqual(f.publishCalls, [], 'ни один проект ничего не опубликовал');
  assert.ok(PROJECTS.every((project) =>
    f.autoposting.list(project.code).posts.every((post) => post.status === 'draft')));
});

test('удалённый проект выпадает из работы и не отдаёт чужой контекст', (t) => {
  const f = fixture(t);
  const prepared = PROJECTS.map((project) => {
    const saved = f.mentor.saveBrief(project.code, {revision: 0, brief: brief(project.mark, project.platform)}, ADMIN);
    const plan = f.mentor.savePlan(project.code, {planRevision: 0, briefRevision: saved.brief.revision,
      days: days(project.mark, project.platform)}, ADMIN);
    f.mentor.decide(project.code, {planRevision: plan.plan.revision, briefRevision: saved.brief.revision,
      decision: 'approved', comment: 'ok'}, ADMIN);
    const moved = f.transfer.transfer(project.code, {planRevision: plan.plan.revision,
      briefRevision: saved.brief.revision}, ADMIN);
    return {project, postId: moved.posts[0].id};
  });
  f.db.prepare("UPDATE companies SET is_deleted=1 WHERE code='palitra-love'").run();
  assert.throws(() => f.mentor.get('palitra-love'), (error) => error.status === 404);
  assert.throws(() => f.transfer.status('palitra-love'), (error) => error.status === 404);
  assert.throws(() => f.transfer.context('palitra-love', prepared[2].postId), (error) => error.status === 404);
  // Пилотные проекты продолжают работать и чужого не получают.
  for (const item of prepared.slice(0, 2)) {
    const context = f.transfer.context(item.project.code, item.postId);
    assert.equal(context.brief.goal, `Цель ${item.project.mark}`);
    assert.doesNotMatch(JSON.stringify(context), /MARK-PALITRA/);
  }
});
