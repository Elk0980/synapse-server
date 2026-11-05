'use strict';
// №142: правила доски как механизм — проверка через настоящие CRM и tasks-mcp.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {startFixture}=require('./test-fixture');
const now=()=>new Date().toISOString();
const described='Точка А: нет экрана.\nТочка Б: Влад видит список.\nШаги приёмки:\n[ ] открыть страницу\n[ ] увидеть список';

test('enforce: anchor, verified evidence, done and task_create fields are rejected by the server',async t=>{
 const f=await startFixture({watchdogMode:'enforce',agentId:1});let db;t.after(async()=>{db?.close();await f.stop();});
 const registry=await f.cabinet('/coordination/mcp/agent_report','POST',{agent:'Codex fixture',kind:'codex',state:'work',last_event:'Регистрация'});
 assert.equal(registry.status,200,JSON.stringify(registry.body));
 db=new DatabaseSync(path.join(f.dir,'crm.sqlite'));
 db.prepare('UPDATE agent_access SET projects=? WHERE agent_id=?').run(JSON.stringify(['','palitra-love','synapse','synapse-business']),registry.body.agent.id);
 // Постановка без Точки Б и шагов отклоняется с понятной подсказкой; владелец из кабинета — нет.
 const bare=await f.call('task_create',{project:'palitra-love',client_ref:'rules-bare',title:'SAMPLE экран',description:'просто текст',executor:'Codex fixture',reviewer:'Влад'});
 assert.equal(bare.isError,true);assert.equal(bare.data.error.status,422);assert.match(bare.data.error.message,/Точка Б/);assert.match(bare.data.error.message,/Шаги/);
 const vladBare=await f.cabinet('/coordination/mcp/task_create','POST',{project:'palitra-love',client_ref:'rules-vlad',title:'SAMPLE от Влада',description:'без полей'});
 assert.equal(vladBare.status,200,JSON.stringify(vladBare.body));
 const module=await f.call('task_create',{project:'palitra-love',client_ref:'rules-module',title:'Модуль · Доска',description:'ЦКП: порядок',executor:'Codex fixture',reviewer:'Влад'});
 assert.equal(module.isError,false,JSON.stringify(module.data));
 const created=await f.call('task_create',{project:'palitra-love',client_ref:'rules-live',title:'SAMPLE экран',description:described,executor:'Codex fixture',reviewer:'Влад',status:'in_progress'});
 assert.equal(created.isError,false,JSON.stringify(created.data));const taskId=created.data.task.id;
 // Пока сервер не видел session_start, стадия просит выполнить его.
 const early=await f.call('task_update',{task_id:taskId,stage:'code',evidence:'https://github.com/Elk0980/synapse-server/pull/1',checked_at:now()});
 assert.equal(early.data.error.status,409);assert.match(early.data.error.message,/session_start/);
 const session=await f.call('session_start',{agent:'Codex fixture',kind:'codex',request:'правила'});
 assert.equal(session.isError,false,JSON.stringify(session.data));
 const code=session.data.rules_revision.slice(0,8);
 assert.equal(db.prepare("SELECT value FROM task_watchdog_settings WHERE key='rules_revision'").get().value,session.data.rules_revision);
 assert.equal((await f.call('task_get',{task_id:taskId})).data.rules_anchor.state,'missing');
 const noAnchor=await f.call('task_update',{task_id:taskId,stage:'code',evidence:'https://github.com/Elk0980/synapse-server/pull/1',checked_at:now()});
 assert.equal(noAnchor.data.error.status,409);assert.match(noAnchor.data.error.message,new RegExp(`нет якоря.*${code}`));
 await f.call('task_comment',{task_id:taskId,author:'Codex fixture',text:'Сэр · правила 1.0 · код 00000000\nТочка Б: …'});
 const stale=await f.call('task_update',{task_id:taskId,stage:'code',evidence:'https://github.com/Elk0980/synapse-server/pull/1',checked_at:now()});
 assert.equal(stale.data.error.status,409);assert.match(stale.data.error.message,/устарел/);
 assert.equal((await f.call('task_get',{task_id:taskId})).data.rules_anchor.state,'stale');
 await f.call('task_comment',{task_id:taskId,author:'Codex fixture',text:`Сэр · правила ${session.data.rules_version} · код ${code}\nТочка Б: виден список\nШаги: [ ] открыть`});
 assert.equal((await f.call('task_get',{task_id:taskId})).data.rules_anchor.state,'ok');
 // Якорь есть — дальше работает прежняя проверка доказательства (GitHub), а не правило якоря.
 const anchored=await f.call('task_update',{task_id:taskId,stage:'code',evidence:'https://invented.example/pr/1',checked_at:now()});
 assert.equal(anchored.data.error.status,422);
 // «Готово» без «проверено» и «проверено» без снимков — 409 с текстом, что добавить.
 const done=await f.call('task_update',{task_id:taskId,status:'done'});
 assert.equal(done.data.error.status,409);assert.match(done.data.error.message,/Готово без «проверено»/);
 const weak=await f.cabinet('/coordination/mcp/task_update','POST',{task_id:taskId,stage:'verified',evidence:'https://lk.example/page',checked_at:now()});
 assert.equal(weak.status,200,'владелец не ограничен');
 const other=await f.call('task_create',{project:'palitra-love',client_ref:'rules-verified',title:'SAMPLE проверка',description:described,executor:'GPT fixture',reviewer:'Codex fixture',status:'in_progress'});
 const otherId=other.data.task.id;
 const gpt=await f.crm('/coordination/mcp/task_comment','POST',{task_id:otherId,author:'GPT fixture',text:`Сэр · правила ${session.data.rules_version} · код ${code}`});assert.equal(gpt.status,200);
 const byReviewer=await f.call('task_update',{task_id:otherId,stage:'verified',evidence:'https://lk.example/page',checked_at:now()});
 assert.equal(byReviewer.data.error.status,409);assert.match(byReviewer.data.error.message,/390/);assert.match(byReviewer.data.error.message,/1440/);
 const full=await f.call('task_update',{task_id:otherId,stage:'verified',evidence:'https://lk.example/page https://img.example/lk-390.png https://img.example/lk-1440.png',checked_at:now()});
 assert.equal(full.isError,false,'якорь, другой проверяющий и доказательство — стадия принята: '+JSON.stringify(full.data).slice(0,300));
 assert.equal(full.data.task.coordination.milestones.verified.state,'confirmed');
 const digest=await f.crm('/coordination/watchdog');
 assert.equal(digest.status,200);assert.match(digest.body.text,/Не по правилам/);assert.match(digest.body.text,/Отклонено \(отказы\): [1-9]/);
 assert.equal(digest.body.rules.current.code,code);
});

test('observe: same operations pass, would-be rejections are counted in the digest',async t=>{
 const f=await startFixture({agentId:1});t.after(()=>f.stop());
 const bare=await f.call('task_create',{project:'palitra-love',client_ref:'rules-observe',title:'SAMPLE экран',description:'без полей',executor:'Codex fixture',reviewer:'Влад',status:'in_progress'});
 assert.equal(bare.isError,false,JSON.stringify(bare.data));const taskId=bare.data.task.id;
 const session=await f.call('session_start',{agent:'Codex fixture',kind:'codex',request:'правила'});assert.equal(session.isError,false,JSON.stringify(session.data));
 const done=await f.call('task_update',{task_id:taskId,status:'done'});
 assert.equal(done.isError,false,JSON.stringify(done.data));
 const digest=await f.crm('/coordination/watchdog');
 assert.equal(digest.body.rules.mode,'observe');assert.equal(digest.body.rules.rejected.length,0);
 assert.equal(digest.body.rules.would_reject.length,2,JSON.stringify(digest.body.rules.would_reject));
 assert.match(digest.body.text,/Отклонено бы \(наблюдение, за сутки\): 2/);
});
