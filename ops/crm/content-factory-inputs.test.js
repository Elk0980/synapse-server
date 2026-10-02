'use strict';
// CF1: вводные контент-завода — постоянный профиль и пожелания месяца. Синтетические данные.
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createContentFactoryInputs, EMPTY_PROFILE, EMPTY_MONTH} = require('./content-factory-inputs');
const {createMediaMentor} = require('./media-mentor');

const ACTOR = {userId: 7, userName: 'Владелец'};

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,
      email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'alpha','Альфа','Asia/Irkutsk','[]'),(2,'beta','Бета','','[]');`);
  let clock = Date.parse('2026-10-01T05:00:00Z');
  const api = createContentFactoryInputs(db, {now: () => clock});
  return {db, api, tick: (ms) => { clock += ms; }};
}
const status = (fn) => { try { fn(); } catch (error) { return error.status; } return 200; };

test('пустое состояние: неизвестное остаётся пустым, пояс проекта отдаётся как есть', (t) => {
  const f = fixture(t);
  const a = f.api.get('ALPHA');
  assert.equal(a.companyCode, 'alpha');
  assert.equal(a.timezone, 'Asia/Irkutsk');
  assert.equal(a.profile.revision, 0);
  assert.deepEqual(a.profile.fields, EMPTY_PROFILE);
  assert.deepEqual(a.vocabulary.genders.map((item) => item.id), ['women', 'men']);
  assert.equal(f.api.get('beta').timezone, '', 'пустой пояс не подменяется');
});

test('пол: обе галочки, одна, ни одной; возраст пусто/от/до; от > до — 400', (t) => {
  const f = fixture(t);
  let r = f.api.saveProfile('alpha', {revision: 0, profile: {genders: ['women', 'men']}}, ACTOR);
  assert.deepEqual(r.profile.fields.genders, ['women', 'men']);
  r = f.api.saveProfile('alpha', {revision: 1, profile: {genders: ['men']}}, ACTOR);
  assert.deepEqual(r.profile.fields.genders, ['men']);
  r = f.api.saveProfile('alpha', {revision: 2, profile: {genders: []}}, ACTOR);
  assert.deepEqual(r.profile.fields.genders, []);
  for (const bad of [['both'], ['women', 'women'], 'women', ['female']])
    assert.equal(status(() => f.api.saveProfile('alpha', {revision: 3, profile: {genders: bad}}, ACTOR)), 400, JSON.stringify(bad));
  r = f.api.saveProfile('alpha', {revision: 3, profile: {ageFrom: 25}}, ACTOR);
  assert.equal(r.profile.fields.ageFrom, 25); assert.equal(r.profile.fields.ageTo, null);
  r = f.api.saveProfile('alpha', {revision: 4, profile: {ageTo: 45}}, ACTOR);
  assert.equal(r.profile.fields.ageTo, 45);
  assert.equal(status(() => f.api.saveProfile('alpha', {revision: 5, profile: {ageFrom: 50}}, ACTOR)), 400, 'от больше сохранённого до');
  for (const bad of [-1, 121, 25.5, '25'])
    assert.equal(status(() => f.api.saveProfile('alpha', {revision: 5, profile: {ageFrom: bad}}, ACTOR)), 400, String(bad));
  r = f.api.saveProfile('alpha', {revision: 5, profile: {ageFrom: null, ageTo: null}}, ACTOR);
  assert.equal(r.profile.fields.ageFrom, null); assert.equal(r.profile.fields.ageTo, null);
});

test('поля профиля: неизвестные — 400, ссылка только HTTP(S), списки без повторов', (t) => {
  const f = fixture(t);
  assert.equal(status(() => f.api.saveProfile('alpha', {revision: 0, profile: {income: 'высокий'}}, ACTOR)), 400);
  assert.equal(status(() => f.api.saveProfile('alpha', {revision: 0, profile: {}}, ACTOR)), 400);
  assert.equal(status(() => f.api.saveProfile('alpha', {revision: 0, profile: {targetUrl: 'javascript:alert(1)'}}, ACTOR)), 400);
  assert.equal(status(() => f.api.saveProfile('alpha', {revision: 0, profile: {occasions: ['День рождения', 'День рождения']}}, ACTOR)), 400);
  assert.equal(status(() => f.api.saveProfile('alpha', {revision: 0, profile: {}, extra: 1}, ACTOR)), 400);
  const r = f.api.saveProfile('alpha', {revision: 0, profile: {geography: '  Иркутск  ', targetAction: 'Запросить расчёт',
    targetUrl: 'https://example.test/order', occasions: ['День рождения'], questions: ['Сколько стоит?'], proofs: ['Фото работ из архива'],
    sourcesNote: 'Фото с прошлых праздников', styleNotes: 'Без лиц детей'}}, ACTOR);
  assert.equal(r.profile.fields.geography, 'Иркутск');
  assert.equal(r.profile.fields.targetUrl, 'https://example.test/order');
});

test('ревизии: 409 при расхождении, сохранение без изменений не создаёт версию, версии неизменяемы', (t) => {
  const f = fixture(t);
  const first = f.api.saveProfile('alpha', {revision: 0, profile: {geography: 'Иркутск'}}, ACTOR);
  assert.equal(first.profile.revision, 1);
  assert.equal(status(() => f.api.saveProfile('alpha', {revision: 0, profile: {geography: 'Ангарск'}}, ACTOR)), 409);
  const same = f.api.saveProfile('alpha', {revision: 1, profile: {geography: 'Иркутск'}}, ACTOR);
  assert.equal(same.profile.revision, 1, 'без изменений версия не создаётся');
  f.tick(1000);
  const second = f.api.saveProfile('alpha', {revision: 1, profile: {targetAction: 'Позвонить'}}, ACTOR);
  assert.equal(second.profile.revision, 2);
  assert.equal(second.profile.fields.geography, 'Иркутск', 'патч не теряет прежние поля');
  assert.deepEqual(second.profile.history.map((item) => [item.revision, item.actorName]), [[2, 'Владелец'], [1, 'Владелец']]);
  assert.throws(() => f.db.prepare("UPDATE content_factory_profile_versions SET profile='{}'").run(), /Immutable/);
  assert.throws(() => f.db.prepare('DELETE FROM content_factory_profile_versions').run(), /Immutable/);
});

test('изоляция компаний: профиль и месяц Альфы не видны Бете', (t) => {
  const f = fixture(t);
  f.api.saveProfile('alpha', {revision: 0, profile: {geography: 'Иркутск'}}, ACTOR);
  f.api.saveMonth('alpha', '2026-10', {revision: 0, inputs: {priorities: ['Шары']}}, ACTOR);
  assert.equal(f.api.get('beta').profile.revision, 0);
  assert.deepEqual(f.api.get('beta').profile.fields, EMPTY_PROFILE);
  assert.equal(f.api.month('beta', '2026-10').revision, 0);
  assert.deepEqual(f.api.month('beta', '2026-10').inputs, EMPTY_MONTH);
  assert.equal(status(() => f.api.get('gamma')), 404);
});

test('месяц: даты внутри месяца, площадки из словаря, объём 0–3, итоговое число публикаций', (t) => {
  const f = fixture(t);
  const empty = f.api.month('alpha', '2026-10');
  assert.equal(empty.daysInMonth, 31); assert.equal(empty.publicationCount, 0);
  const r = f.api.saveMonth('alpha', '2026-10', {revision: 0, inputs: {
    priorities: ['Оформление шарами'], platforms: ['telegram', 'vk'], perDay: {telegram: 1, vk: 2},
    excludedDays: ['2026-10-04', '2026-10-05'],
    events: [{title: 'Осенняя акция', date: '2026-10-15', conditions: 'Скидка 10% на шары', confirmed: true},
      {title: 'Хеллоуин', date: '', conditions: '', confirmed: false}]}}, ACTOR);
  assert.equal(r.revision, 1);
  assert.equal(r.publicationCount, (31 - 2) * 3);
  assert.equal(r.inputs.events[1].confirmed, false);
  for (const [label, inputs] of [
    ['дата события вне месяца', {events: [{title: 'X', date: '2026-11-01', conditions: '', confirmed: false}]}],
    ['исключение вне месяца', {excludedDays: ['2026-09-30']}],
    ['исключение повтор', {excludedDays: ['2026-10-04', '2026-10-04']}],
    ['несуществующая дата', {excludedDays: ['2026-10-32']}],
    ['площадка вне словаря', {platforms: ['myspace']}],
    ['объём 4', {perDay: {telegram: 4}}],
    ['объём дробный', {perDay: {telegram: 1.5}}],
    ['объём для невыбранной площадки', {perDay: {instagram: 1}}],
    ['подтверждение не булево', {events: [{title: 'X', date: '', conditions: '', confirmed: 'да'}]}],
    ['неизвестное поле', {budget: 1000}],
  ]) assert.equal(status(() => f.api.saveMonth('alpha', '2026-10', {revision: 1, inputs}, ACTOR)), 400, label);
  for (const bad of ['2026-13', '2026-1', 'октябрь', '2026-10-01'])
    assert.equal(status(() => f.api.month('alpha', bad)), 400, bad);
  assert.equal(f.api.month('alpha', '2026-11').revision, 0, 'другой месяц — отдельные пожелания');
  assert.equal(status(() => f.api.saveMonth('alpha', '2026-10', {revision: 0, inputs: {note: 'x'}}, ACTOR)), 409);
  const february = f.api.month('alpha', '2028-02');
  assert.equal(february.daysInMonth, 29, 'високосный февраль');
});

test('месяц и профиль не меняют бриф наставника', (t) => {
  const f = fixture(t);
  const mentor = createMediaMentor(f.db, {now: () => Date.parse('2026-10-01T05:00:00Z')});
  const brief = mentor.saveBrief('alpha', {revision: 0, brief: {product: 'Шары под ключ', pains: ['Нет времени на оформление']}}, ACTOR);
  const before = JSON.stringify(mentor.get('alpha').brief);
  f.api.saveProfile('alpha', {revision: 0, profile: {genders: ['women'], geography: 'Иркутск'}}, ACTOR);
  f.api.saveMonth('alpha', '2026-10', {revision: 0, inputs: {platforms: ['vk'], perDay: {vk: 1}}}, ACTOR);
  assert.equal(JSON.stringify(mentor.get('alpha').brief), before);
  assert.equal(mentor.get('alpha').brief.revision, brief.brief.revision);
  assert.ok(mentor.inputs, 'модуль вводных создаётся вместе с наставником на той же базе');
  assert.equal(mentor.inputs.get('alpha').profile.fields.geography, 'Иркутск');
});

test('выбор форматов и ОВП нормализуется, сохраняется отдельно по компании и месяцу и сбрасывается', t => {
  const f=fixture(t),inputs={platforms:['telegram'],perDay:{telegram:1},formats:['carousel','post'],roles:['sale','reach']};
  const saved=f.api.saveMonth('alpha','2026-10',{revision:0,inputs},ACTOR);
  assert.deepEqual(saved.inputs.formats,['post','carousel']);assert.deepEqual(saved.inputs.roles,['reach','sale']);
  assert.equal(saved.publicationCount,31);
  const same=f.api.saveMonth('alpha','2026-10',{revision:1,inputs:{formats:['carousel','post'],roles:['sale','reach']}},ACTOR);
  assert.equal(same.revision,1,'порядок выбранных значений не создаёт новую версию');
  for(const [code,month]of [['beta','2026-10'],['alpha','2026-11']]){
    assert.deepEqual(f.api.month(code,month).inputs.formats,[]);assert.deepEqual(f.api.month(code,month).inputs.roles,[]);
  }
  assert.equal(status(()=>f.api.saveMonth('alpha','2026-10',{revision:0,inputs:{formats:[]}},ACTOR)),409);
  const reset=f.api.saveMonth('alpha','2026-10',{revision:1,inputs:{formats:[],roles:[]}},ACTOR);
  assert.equal(reset.revision,2);assert.deepEqual(reset.inputs.formats,[]);assert.deepEqual(reset.inputs.roles,[]);
  assert.equal(reset.publicationCount,31);
  const vocabulary=f.api.get('alpha').vocabulary;
  assert.deepEqual(vocabulary.formats.map(item=>item.id),['post','story','reel','carousel']);
  assert.deepEqual(vocabulary.roles.map(item=>item.id),['reach','affection','sale']);
});

test('форматы и ОВП: неизвестные значения, повторы и неверные типы дают 400 без записи',t=>{
  const f=fixture(t);
  for(const [key,bad]of [
    ['formats',['video']],['formats',['post','post']],['formats','post'],['formats',null],['formats',[1]],
    ['roles',['awareness']],['roles',['sale','sale']],['roles',{sale:true}],['roles',[null]],['roles',['constructor']],
  ])assert.equal(status(()=>f.api.saveMonth('alpha','2026-10',{revision:0,inputs:{[key]:bad}},ACTOR)),400,`${key}: ${JSON.stringify(bad)}`);
  assert.equal(f.api.month('alpha','2026-10').revision,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM content_factory_month_versions').get().n,0);
});

test('старый JSON месяца без форматов и ОВП читается и обновляется без изменения прежней версии',t=>{
  const f=fixture(t),legacy={priorities:['Архив'],events:[],excludedDays:[],platforms:['vk'],perDay:{vk:1},note:''};
  const stored=JSON.stringify(legacy),at='2026-10-01T05:00:00Z';
  f.db.prepare('INSERT INTO content_factory_month_versions(company_id,month,revision,inputs,created_at) VALUES(?,?,?,?,?)').run(1,'2026-10',1,stored,at);
  f.db.prepare('INSERT INTO content_factory_months(company_id,month,revision,inputs,updated_at) VALUES(?,?,?,?,?)').run(1,'2026-10',1,stored,at);
  const old=f.api.month('alpha','2026-10');
  assert.deepEqual(old.inputs.formats,[]);assert.deepEqual(old.inputs.roles,[]);assert.equal(old.publicationCount,31);
  const next=f.api.saveMonth('alpha','2026-10',{revision:1,inputs:{formats:['reel']}},ACTOR);
  assert.deepEqual(next.inputs.formats,['reel']);assert.deepEqual(next.inputs.roles,[]);assert.deepEqual(next.inputs.priorities,['Архив']);
  assert.equal(f.db.prepare('SELECT inputs FROM content_factory_month_versions WHERE company_id=1 AND revision=1').get().inputs,stored);
});
