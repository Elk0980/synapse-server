'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createTaskCoordination} = require('./task-coordination');
const owner = {role:'owner',userId:7};
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE tasks(id INTEGER PRIMARY KEY,title TEXT,company_code TEXT,status TEXT,assignee_name TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO tasks VALUES(1,'Прайсы','alvi','in_progress','Codex',0),(2,'Каталог','palitra','planned','Claude',0),(3,'Удалена','alvi','done','',1);`);
  return {db, api:createTaskCoordination(db,{now:()=>Date.parse('2026-09-29T10:00:00Z')})};
}
test('existing tasks retain IDs; company filtering and independent evidence survive restart', t => {
  const {db,api} = fixture(t);
  assert.deepEqual(api.list({companyCode:'alvi'},owner).tasks.map(t=>t.taskId),[1]);
  const first = api.get(1,owner); assert.equal(first.revision,0);
  const saved = api.save(1,{revision:0,data:{module:'prices',ownerThreadId:'thread-1',ownerThreadName:'Прайсы',
    executorName:'Codex',result:'Файл доставлен',blocker:'Ожидается согласование',
    milestones:{connected:{state:'confirmed',evidence:'Квитанция №1',checkedAt:'2026-09-29T09:00:00Z'}}}},owner);
  assert.equal(saved.milestones.connected.state,'confirmed');
  assert.equal(saved.milestones.accepted.state,'pending');
  assert.equal(saved.taskStatus,'in_progress'); assert.equal(saved.tracking,'manual');
  assert.equal(createTaskCoordination(db).get(1,owner).result,'Файл доставлен');
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,3);
});
test('competing editors cannot overwrite a newer revision or its immutable evidence', t => {
  const {db,api}=fixture(t);
  api.save(1,{revision:0,data:{result:'Первый результат'}},owner);
  assert.throws(()=>api.save(1,{revision:0,data:{result:'Устаревший'}},owner),e=>e.status===409);
  assert.equal(api.get(1,owner).result,'Первый результат');
  assert.equal(db.prepare('SELECT count(*) n FROM task_coordination_history').get().n,1);
  assert.throws(()=>db.prepare("UPDATE task_coordination_history SET data='{}'").run(),/Immutable/);
  api.save(1,{revision:1,data:{result:'Новый результат'}},owner);
  assert.equal(db.prepare('SELECT count(*) n FROM task_coordination_history').get().n,2);
});
test('internal data rejects non-owner access, deleted tasks and evidence-free or future confirmations', t => {
  const {api}=fixture(t);
  for (const actor of [null,{role:'editor',userId:7}, {role:'owner'}]) {
    assert.throws(()=>api.list({},actor),e=>e.status===403);
    assert.throws(()=>api.get(1,actor),e=>e.status===403);
    assert.throws(()=>api.save(1,{revision:0,data:{}},actor),e=>e.status===403);
  }
  assert.throws(()=>api.get(3,owner),e=>e.status===404);
  for (const data of [
    {ownerThreadName:'Нельзя назначить по названию'},
    {milestones:{accepted:{state:'confirmed'}}},
    {milestones:{code:{state:'not_required',evidence:'Причина'}}},
    {milestones:{accepted:{state:'confirmed',evidence:'Ещё не произошло',checkedAt:'2099-01-01T00:00:00Z'}}},
    {verifiedModel:'Непроверенная модель'}, {unknown:'x'}
  ]) assert.throws(()=>api.save(1,{revision:0,data},owner),e=>e.status===400);
  assert.equal(api.get(1,owner).revision,0);
});
