'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createReviewNotes}=require('./autoposting-review-notes');
const {createReviewTasks}=require('./autoposting-review-tasks');
test('история: пакетные выборки ограничены числом блоков и не смешивают компании',t=>{
 const real=new DatabaseSync(':memory:');t.after(()=>real.close());let queries=0;
 real.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT);INSERT INTO companies VALUES(1,'a'),(2,'b');
 CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY);
 CREATE TABLE tasks(id INTEGER PRIMARY KEY,status TEXT,assignee_name TEXT,due_date TEXT,company_code TEXT,is_deleted INTEGER);`);
 const db={exec:sql=>real.exec(sql),prepare:sql=>{if(/^SELECT/.test(sql))queries++;return real.prepare(sql)}};
 const notes=createReviewNotes(db),tasks=createReviewTasks(db);
 const rows=Array.from({length:205},(_,i)=>({id:i+1}));
 for(const row of rows){real.prepare('INSERT INTO autoposting_posts VALUES(?)').run(row.id);notes.save({...row,company_id:1,content_revision:1,media_urls:'[]'},[{comment:'заметка'}],{},'2026-10-01');}
 real.exec('INSERT INTO autoposting_posts VALUES(206)');
 notes.save({id:206,company_id:2,content_revision:1,media_urls:'[]'},[{comment:'чужое'}],{},'2026-10-01');
 real.exec("INSERT INTO tasks VALUES(1,'inbox','','','a',0),(2,'inbox','','','b',0),(3,'inbox','','','a',1);");
 real.exec('INSERT INTO autoposting_review_tasks VALUES(1,1,1,1,1),(1,2,1,1,2),(1,3,1,1,3)');
 queries=0;const n=notes.listMany([...rows,{id:206}],1),q=tasks.listMany(rows,1);
 assert.equal(queries,4,'по две выборки на 205+ ID вместо одной на каждую карточку');
 assert.equal(n.get(1)[0].annotations[0].comment,'заметка');assert.deepEqual(n.get(206),[]);
 assert.deepEqual(q.get(1).map(x=>x.taskId),[1],'перенесённые и удалённые задачи скрыты');
 assert.deepEqual(n.get(1),notes.list({id:1,company_id:1}));assert.deepEqual(q.get(1),tasks.list({id:1,company_id:1}).map(x=>({...x})));
 queries=0;assert.equal(notes.listMany([],1).size,0);assert.equal(tasks.listMany([],1).size,0);assert.equal(queries,0);
});
