'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {startFixture}=require('./test-fixture');
test('enforce: real cabinet owner acceptance, credential-bound agent and no-code completion',async t=>{
 const f=await startFixture({watchdogMode:'enforce',agentId:1});let db;t.after(async()=>{db?.close();await f.stop();});
 const registry=await f.cabinet('/coordination/mcp/agent_report','POST',{agent:'Codex fixture',kind:'codex',state:'work',last_event:'Административная регистрация'});
 assert.equal(registry.status,200,JSON.stringify(registry.body));
 db=new DatabaseSync(path.join(f.dir,'crm.sqlite'));
 const id=registry.body.agent.id;assert.equal(id,1);
 // Explicit fixture grant for this credential's exact owner/projects, not a user-supplied name.
 db.prepare('UPDATE agent_access SET projects=? WHERE agent_id=?').run(JSON.stringify(['','palitra-love','synapse','synapse-business']),id);
 const created=await f.call('task_create',{project:'palitra-love',client_ref:'watchdog-live',title:'SAMPLE watchdog',executor:'Codex fixture',reviewer:'Влад',status:'in_progress'});
 assert.equal(created.isError,false,JSON.stringify(created));const taskId=created.data.task.id;
 db.prepare("UPDATE tasks SET created_at='2020-01-01T00:00:00Z' WHERE id=?").run(taskId);
 assert.equal((await f.call('task_get',{task_id:taskId})).data.no_report,true);
 // Legacy Owner headers and arbitrary author are not a principal and cannot hide silence.
 const forged=await f.crm('/coordination/mcp/task_comment','POST',{task_id:taskId,author:'Codex fixture',text:'Поддельный отчёт'});assert.equal(forged.status,200);
 assert.equal((await f.call('task_get',{task_id:taskId})).data.no_report,true);
 const report=await f.call('task_comment',{task_id:taskId,author:'Влад',text:'Тест выполнен под ключом исполнителя'});
 assert.equal(report.isError,false);assert.equal(report.data.comment.author,'Codex fixture');
 assert.equal((await f.call('task_get',{task_id:taskId})).data.no_report,false);
 const fake=await f.call('task_update',{task_id:taskId,stage:'code',evidence:'https://invented.example/pr/1',checked_at:new Date().toISOString()});assert.equal(fake.data.error.status,422);
 const connected=await f.call('task_update',{task_id:taskId,stage:'connected',evidence:'a'.repeat(40),checked_at:new Date().toISOString()});assert.equal(connected.data.error.status,403);
 const spoof=await f.call('agent_report',{agent:'Влад',kind:'owner',state:'work',last_event:`#${taskId} готово`});assert.equal(spoof.isError,true);
 assert.equal((await f.call('task_update',{task_id:taskId,status:'done'})).isError,true);
 const accepted=await f.cabinet('/coordination/mcp/task_update','POST',{task_id:taskId,stage:'accepted',evidence:'Принимаю результат',checked_at:new Date().toISOString(),status:'done'});
 assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.task.status,'done');
 assert.equal(db.prepare('SELECT principal FROM task_watchdog_acceptance WHERE task_id=?').get(taskId).principal,'person:1');
 // No-code exception requires an explicit owner flag, verified stage and authenticated owner comment.
 const other=await f.call('task_create',{project:'palitra-love',client_ref:'watchdog-no-code',title:'SAMPLE документ',executor:'Codex fixture',reviewer:'Влад'});
 const noCodeId=other.data.task.id;
 let current=(await f.call('task_get',{task_id:noCodeId})).data;
 const mark=await f.cabinet(`/coordination/tasks/${noCodeId}`,'PUT',{revision:current.coordination.revision,data:{codeRequired:false}});assert.equal(mark.status,200,JSON.stringify(mark.body));
 const verified=await f.cabinet('/coordination/mcp/task_update','POST',{task_id:noCodeId,stage:'verified',evidence:'https://example.test/evidence',checked_at:new Date().toISOString()});assert.equal(verified.status,200,JSON.stringify(verified.body));
 assert.equal((await f.call('task_update',{task_id:noCodeId,status:'done'})).isError,true);
 const decision=await f.cabinet('/coordination/mcp/task_comment','POST',{task_id:noCodeId,author:'Codex fixture',text:'Документ без кода принимаю'});assert.equal(decision.body.comment.author,'Влад');
 assert.equal((await f.call('task_update',{task_id:noCodeId,status:'done'})).isError,false);
 // Actual accept button invokes owner acceptance before done, in the dispatch transaction.
 const dispatch=await f.call('task_create',{project:'palitra-love',client_ref:'watchdog-dispatch',title:'SAMPLE разбор',executor:'Codex fixture',reviewer:'Влад'});const dispatchId=dispatch.data.task.id;
 db.prepare("INSERT INTO task_dispatch(task_id,company_code,state,updated_at,created_at) VALUES(?,'palitra-love','review',?,?)").run(dispatchId,new Date().toISOString(),new Date().toISOString());
 const action=await f.cabinet(`/coordination/dispatch/${dispatchId}/action`,'POST',{revision:1,action:'accept'});assert.equal(action.status,200,JSON.stringify(action.body));
 assert.equal((await f.call('task_get',{task_id:dispatchId})).data.status,'done');
 // Revocation of the registry grant invalidates the very same still-open MCP client.
 db.prepare('DELETE FROM agent_access WHERE agent_id=?').run(id);
 const revoked=await f.call('task_update',{task_id:taskId,stage:'accepted',evidence:'Не разрешено',checked_at:new Date().toISOString()});assert.equal(revoked.isError,true);assert.equal(revoked.data.error.status,403);
});
