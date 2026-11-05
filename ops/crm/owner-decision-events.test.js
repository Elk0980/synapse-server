 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{createTaskCoordination}=require('./task-coordination');
const {waiting,ownerDecisionEvent}=require('./owner-decision-events');
test('old tasks, unchanged blockers, change-back, done, fake names, and legacy owner task',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE tasks(id INTEGER PRIMARY KEY,title,company_code,status,assignee_name,is_deleted DEFAULT 0);INSERT INTO tasks VALUES(1,'Выбор','alvi','planned','Codex',0)");
 const api=createTaskCoordination(db),actor={role:'owner',userId:1};
 const event=()=>ownerDecisionEvent(db,db.prepare('SELECT * FROM tasks WHERE id=1').get());
 assert.equal(event(),null);api.save(1,{revision:0,data:{blocker:'ЖДЁТ ВЛАДА: ответ'}},actor);const first=event();
 api.save(1,{revision:1,data:{result:'отчёт'}},actor);assert.equal(event().eventKey,first.eventKey);
 api.save(1,{revision:2,data:{blocker:'ждёт Влада: новое'}},actor);assert.notEqual(event().eventKey,first.eventKey);
 api.save(1,{revision:3,data:{blocker:'ЖДЁТ ВЛАДА: ответ'}},actor);assert.notEqual(event().eventKey,first.eventKey);
 db.prepare("UPDATE tasks SET status='done' WHERE id=1").run();assert.equal(event(),null);
 for(const text of ['Не ждёт Влада','ждёт Владислава','ждетвлада'])assert.equal(waiting(text),false);
 db.exec("INSERT INTO tasks VALUES(2,'Старая задача','alvi','planned','Влад',0)");assert.equal(ownerDecisionEvent(db,db.prepare('SELECT * FROM tasks WHERE id=2').get()).eventKey,'owner-decision:2:created');
});
