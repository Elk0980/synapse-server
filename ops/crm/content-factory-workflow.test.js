'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createContentFactoryWorkflow} = require('./content-factory-workflow');

const DEFAULT = {releaseMode: 'manual', publisherName: '', hours: [], preparationDays: 0, reviewDays: 0};
const ACTOR = {userId: 7, userName: 'Владелец'};

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,is_deleted INTEGER NOT NULL DEFAULT 0);
    INSERT INTO companies(id,code) VALUES(1,'alpha'),(2,'beta');
    CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,payload TEXT);
    CREATE TABLE content_plan_jobs(id INTEGER PRIMARY KEY,payload TEXT);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,payload TEXT);
    INSERT INTO autoposting_posts VALUES(1,'Существующая карточка');
    INSERT INTO content_plan_jobs VALUES(1,'Существующее задание');
    INSERT INTO tasks VALUES(1,'Существующая задача');`);
  for (const table of ['autoposting_posts', 'content_plan_jobs', 'tasks']) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER forbid_${table}_${operation} BEFORE ${operation} ON ${table}
        BEGIN SELECT RAISE(ABORT,'Existing resources are readonly'); END;`);
    }
  }
  let clock = Date.parse('2026-10-01T05:00:00Z');
  const options = {now: () => clock};
  const api = createContentFactoryWorkflow(db, options);
  return {db, api, options, tick: (ms) => { clock += ms; }};
}
const expectStatus = (fn, status, code) => assert.throws(fn, (error) =>
  error.status === status && (!code || error.details?.code === code));
const versionCount = (db) => db.prepare('SELECT COUNT(*) count FROM content_factory_workflow_versions').get().count;
const audit = (db, companyId = 1) => db.prepare(`SELECT revision,fields,created_at,actor_id,actor_name
  FROM content_factory_workflow_versions WHERE company_id=? ORDER BY revision`).all(companyId).map((row) => ({...row}));

test('GET defaults: не создаёт настройки, не подтверждает configured, DTO не даёт изменить состояние', (t) => {
  const {api, db} = fixture(t);
  const value = api.get('ALPHA');
  assert.deepEqual(value, {companyCode: 'alpha', revision: 0, configured: false, fields: DEFAULT, approverRole: 'owner'});
  assert.equal(db.prepare('SELECT COUNT(*) count FROM content_factory_workflows').get().count, 0);
  assert.equal(versionCount(db), 0);
  value.fields.hours.push('10:00'); value.fields.releaseMode = 'scheduled';
  assert.deepEqual(api.get('alpha').fields, DEFAULT);
  assert.deepEqual(api.get('beta').fields, DEFAULT);
});

test('первое явное default/manual сохранение настраивает компанию; актуальный noop не создаёт историю', (t) => {
  const {api, db, tick} = fixture(t);
  const first = api.save('alpha', {revision: 0, fields: {releaseMode: 'manual'}}, ACTOR);
  assert.equal(first.configured, true); assert.equal(first.revision, 1);
  assert.deepEqual(first.fields, DEFAULT); assert.equal(first.approverRole, 'owner');
  const initialAudit = audit(db);
  tick(60000);
  const same = api.save('alpha', {revision: 1, fields: {...DEFAULT}}, {userId: 8, userName: 'Другой владелец'});
  assert.deepEqual(same, first);
  assert.deepEqual(audit(db), initialAudit, 'noop не меняет время или автора старой версии');
  expectStatus(() => api.save('alpha', {revision: 0, fields: {releaseMode: 'manual'}}, ACTOR), 409, 'REVISION_CONFLICT');
  assert.equal(versionCount(db), 1, 'stale одинаковый payload не принят как noop');
});

test('partial и reset: имя trim, часы сортируются, пропущенные поля сохраняются', (t) => {
  const {api, db, tick} = fixture(t);
  const hours = ['18:30', '09:00'];
  let value = api.save('alpha', {revision: 0, fields: {releaseMode: 'scheduled', publisherName: '  Анна  ',
    hours, preparationDays: 30, reviewDays: 2}}, ACTOR);
  assert.deepEqual(value.fields, {releaseMode: 'scheduled', publisherName: 'Анна', hours: ['09:00', '18:30'], preparationDays: 30, reviewDays: 2});
  assert.deepEqual(hours, ['18:30', '09:00'], 'нормализация не сортирует входной массив по ссылке');
  const initialAudit = audit(db);
  tick(1000);
  value = api.save('alpha', {revision: 1, fields: {hours: ['18:30', '09:00'], publisherName: '\tАнна\n'}}, ACTOR);
  assert.equal(value.revision, 1); assert.deepEqual(audit(db), initialAudit, 'порядок часов и trim не меняют версию');
  value.fields.hours.push('22:00'); hours.push('00:00');
  assert.deepEqual(api.get('alpha').fields.hours, ['09:00', '18:30']);
  value = api.save('alpha', {revision: 1, fields: {reviewDays: 0}}, ACTOR);
  assert.equal(value.revision, 2); assert.equal(value.fields.preparationDays, 30);
  assert.equal(value.fields.publisherName, 'Анна'); assert.equal(value.fields.releaseMode, 'scheduled');
  value = api.save('alpha', {revision: 2, fields: {publisherName: '', hours: [], releaseMode: 'manual'}}, ACTOR);
  assert.equal(value.revision, 3); assert.equal(value.configured, true);
  assert.deepEqual(value.fields, {...DEFAULT, preparationDays: 30});
});

test('строгая валидация body/fields/revision: неизвестные поля и coercion запрещены, ошибок без writes', (t) => {
  const {api, db} = fixture(t);
  const invalidBodies = [null, [], {}, {revision: 0}, {revision: 0, fields: {}},
    {revision: 0, fields: [], extra: true}, {revision: 0, fields: {releaseMode: 'manual'}, actor: ACTOR},
    ...[-1, 0.5, '0', null, true, Number.MAX_SAFE_INTEGER + 1].map((revision) => ({revision, fields: {releaseMode: 'manual'}}))];
  for (const body of invalidBodies) expectStatus(() => api.save('alpha', body, ACTOR), 400);
  const invalidFields = [null, [], {approverRole: 'editor'}, {configured: true}, {publisherName: null},
    {publisherName: 123}, {publisherName: 'x'.repeat(201)}, {publisherName: 'A\u0000B'},
    ...['automatic', 'Manual', ' manual ', null, true].map((releaseMode) => ({releaseMode})),
    ...['09:00', null, ['9:00'], ['24:00'], ['23:60'], ['09:00 '], [900], ['09:00', '09:00'],
      Array.from({length: 25}, (_, index) => `00:${String(index).padStart(2, '0')}`)].map((hours) => ({hours})),
    ...[-1, 31, 0.5, '2', null, true, NaN].flatMap((value) => [{preparationDays: value}, {reviewDays: value}])];
  for (const fields of invalidFields) expectStatus(() => api.save('alpha', {revision: 0, fields}, ACTOR), 400);
  assert.equal(versionCount(db), 0); assert.equal(api.get('alpha').configured, false);
});

test('границы часов/сроков принимаются без расписания и изменения существующих ресурсов', (t) => {
  const {api, db} = fixture(t);
  const hours = ['23:59', ...Array.from({length: 23}, (_, index) => `${String(index).padStart(2, '0')}:00`)];
  const value = api.save('alpha', {revision: 0, fields: {releaseMode: 'scheduled', hours, preparationDays: 0, reviewDays: 30}}, ACTOR);
  assert.equal(value.fields.hours.length, 24); assert.equal(value.fields.hours[0], '00:00');
  assert.equal(value.fields.hours.at(-1), '23:59'); assert.equal(value.approverRole, 'owner');
  assert.deepEqual({...db.prepare('SELECT * FROM autoposting_posts').get()}, {id: 1, payload: 'Существующая карточка'});
  assert.deepEqual({...db.prepare('SELECT * FROM content_plan_jobs').get()}, {id: 1, payload: 'Существующее задание'});
  assert.deepEqual({...db.prepare('SELECT * FROM tasks').get()}, {id: 1, payload: 'Существующая задача'});
});

test('компании изолированы: body не меняет scope, неизвестная/удалённая компания недоступна', (t) => {
  const {api, db} = fixture(t);
  api.save('ALPHA', {revision: 0, fields: {publisherName: 'Анна', releaseMode: 'scheduled'}}, ACTOR);
  assert.deepEqual(api.get('beta'), {companyCode: 'beta', revision: 0, configured: false, fields: DEFAULT, approverRole: 'owner'});
  api.save('beta', {revision: 0, fields: {publisherName: 'Борис'}}, ACTOR);
  assert.equal(api.get('alpha').fields.publisherName, 'Анна'); assert.equal(api.get('beta').fields.publisherName, 'Борис');
  expectStatus(() => api.save('alpha', {revision: 1, fields: {publisherName: 'Борис'}, companyCode: 'beta'}, ACTOR), 400);
  for (const bad of ['', null, 'alpha/beta']) expectStatus(() => api.get(bad), 400);
  expectStatus(() => api.get('gamma'), 404);
  expectStatus(() => api.save('gamma', {revision: 0, fields: {releaseMode: 'manual'}}, ACTOR), 404);
  db.prepare('UPDATE companies SET is_deleted=1 WHERE id=1').run();
  expectStatus(() => api.get('alpha'), 404);
  expectStatus(() => api.save('alpha', {revision: 1, fields: {releaseMode: 'manual'}}, ACTOR), 404);
  assert.equal(versionCount(db), 2, 'отказ не пишет историю чужой/удалённой компании');
});

test('история хранит полный snapshot/actor/UTC; фабрика повторно открывает данные без перезаписи', (t) => {
  const {api, db, options, tick} = fixture(t);
  const first = api.save('alpha', {revision: 0, fields: {publisherName: 'Анна'}}, ACTOR);
  tick(1000);
  const second = api.save('alpha', {revision: 1, fields: {releaseMode: 'scheduled'}}, {userId: 8, userName: 'Редактор'});
  const history = audit(db);
  assert.deepEqual(history.map(({revision, created_at, actor_id, actor_name}) => ({revision, created_at, actor_id, actor_name})), [
    {revision: 1, created_at: '2026-10-01T05:00:00.000Z', actor_id: 7, actor_name: 'Владелец'},
    {revision: 2, created_at: '2026-10-01T05:00:01.000Z', actor_id: 8, actor_name: 'Редактор'}]);
  assert.deepEqual(JSON.parse(history[0].fields), first.fields); assert.deepEqual(JSON.parse(history[1].fields), second.fields);
  const reopened = createContentFactoryWorkflow(db, options);
  assert.deepEqual(reopened.get('alpha'), second); assert.deepEqual(audit(db), history);
  assert.throws(() => db.prepare("UPDATE content_factory_workflow_versions SET fields='{}' WHERE company_id=1 AND revision=1").run(), /Immutable/);
  assert.throws(() => db.prepare('DELETE FROM content_factory_workflow_versions WHERE company_id=1 AND revision=1').run(), /Immutable/);
  assert.deepEqual(audit(db), history);
});

test('сбой current pointer откатывает INSERT версии и оставляет исходное состояние доступным', (t) => {
  const {api, db} = fixture(t);
  db.exec(`CREATE TRIGGER synthetic_first_failure BEFORE INSERT ON content_factory_workflows
    BEGIN SELECT RAISE(ABORT,'Synthetic pointer failure'); END;`);
  assert.throws(() => api.save('alpha', {revision: 0, fields: {releaseMode: 'manual'}}, ACTOR), /Synthetic pointer failure/);
  assert.equal(versionCount(db), 0); assert.equal(api.get('alpha').configured, false);
  db.exec('DROP TRIGGER synthetic_first_failure');
  const first = api.save('alpha', {revision: 0, fields: {releaseMode: 'manual'}}, ACTOR);
  const history = audit(db);
  db.exec(`CREATE TRIGGER synthetic_update_failure BEFORE UPDATE ON content_factory_workflows
    BEGIN SELECT RAISE(ABORT,'Synthetic pointer failure'); END;`);
  assert.throws(() => api.save('alpha', {revision: 1, fields: {releaseMode: 'scheduled'}}, ACTOR), /Synthetic pointer failure/);
  assert.deepEqual(api.get('alpha'), first); assert.deepEqual(audit(db), history);
  db.exec('DROP TRIGGER synthetic_update_failure');
  const recovered = api.save('alpha', {revision: 1, fields: {releaseMode: 'scheduled'}}, ACTOR);
  assert.equal(recovered.revision, 2, 'после rollback нет пропуска версии или зависшей транзакции');
});
