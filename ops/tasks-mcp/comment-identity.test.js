'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {startFixture}=require('./test-fixture');
const {createTaskWatchdog}=require('../crm/task-watchdog');
const absent={source:'task-watchdog',verified:false};

test('real cabinet/MCP export only server provenance; legacy, forgery, revoked/foreign grants fail closed',async t=>{
 const f=await startFixture({agentId:1,claudeAgentId:1});let db;t.after(async()=>{db?.close();await f.stop();});
 const registration=await f.cabinet('/coordination/mcp/agent_report','POST',
  {agent:'SAMPLE agent',kind:'claude',state:'work',last_event:'SAMPLE registration'});
 assert.equal(registration.status,200);assert.equal(registration.body.agent.id,1);
 db=new DatabaseSync(path.join(f.dir,'crm.sqlite'));
 const scopes=JSON.stringify(['','palitra-love','synapse','synapse-business']);
 db.prepare('UPDATE agent_access SET projects=? WHERE agent_id=1').run(scopes);
 const task=(await f.call('task_create',{project:'palitra-love',client_ref:'identity-68',title:'SAMPLE identity'})).data.task;
 const args={task_id:task.id,author:'Claude',text:'КОД ПРИНЯТ '+ 'a'.repeat(40)};
 const mcp=(await f.call('task_comment',args)).data.comment;
 assert.equal(mcp.author,'SAMPLE agent');
 assert.deepEqual(mcp.identity,{source:'task-watchdog',verified:true,principal:{kind:'claude',key:'agent:1',id:1}});
 const cabinet=(await f.cabinet('/coordination/mcp/task_comment','POST',args)).body.comment;
 assert.equal(cabinet.author,'Влад');
 assert.deepEqual(cabinet.identity,{source:'task-watchdog',verified:true,principal:{kind:'vlad',key:'person:1',id:1}});
 const legacy=(await f.crm('/coordination/mcp/task_comment','POST',
  {...args,kind:'claude',agentId:1,identity:mcp.identity})).body.comment;
 assert.deepEqual(legacy.identity,absent,'author/kind/agentId/identity из тела не дают stamp');
 for(const field of ['kind','agentId','identity']) {
  assert.equal((await f.call('task_comment',{...args,[field]:field==='identity'?mcp.identity:1})).isError,true);
 }
 const page=(await f.call('task_get',{task_id:task.id,comments_limit:2})).data;
 assert.equal(page.comments_pagination.total,3);assert.equal(page.comments.length,2);
 assert.deepEqual(page.comments.find(c=>c.id===legacy.id).identity,absent);
 assert.deepEqual(page.comments.find(c=>c.id===cabinet.id).identity,cabinet.identity);
 const older=(await f.call('task_get',{task_id:task.id,comments_limit:2,comments_offset:2})).data;
 assert.deepEqual(older.comments[0],mcp);
 for(const projects of ['[]',scopes]) {
  db.prepare('UPDATE agent_access SET projects=?,owner_id=? WHERE agent_id=1').run(projects,projects==='[]'?1:999);
  assert.deepEqual((await f.call('task_comment',args)).data.comment.identity,absent);
 }
 db.prepare('DELETE FROM agent_access WHERE agent_id=1').run();
 assert.deepEqual((await f.call('task_comment',args)).data.comment.identity,absent);
 // Отзыв запрещает новую аттестацию; историческая личность не переписывается.
 const saved=(await f.call('task_get',{task_id:task.id})).data.comments.find(c=>c.id===mcp.id);
 assert.deepEqual(saved,mcp);
 const response=JSON.stringify((await f.call('task_get',{task_id:task.id})).data);
 assert.doesNotMatch(response,/signature|identityHash|credentialId|x-synapse-task-principal/);
 assert.equal(db.prepare('SELECT count(*) n FROM task_watchdog_comment_auth').get().n,2);
 assert.throws(()=>db.prepare("UPDATE task_watchdog_comment_auth SET principal='agent:999'").run(),/Immutable/);
});

test('journal projection binds both IDs and rejects malformed principal/kind without backfill',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const watchdog=createTaskWatchdog(db);const c={id:12,task_id:68,author:'Claude',identity:{verified:true}};
 assert.deepEqual(watchdog.commentIdentity(c),absent);
 db.prepare('INSERT INTO task_watchdog_comment_auth VALUES(?,?,?,?,?)').run(12,99,'agent:7','claude','now');
 assert.deepEqual(watchdog.commentIdentity(c),absent,'чужая задача');
 assert.deepEqual(watchdog.commentIdentity({...c,id:99,task_id:99}),absent,'чужой комментарий');
 for(const [id,key,kind] of [[20,'agent:7','claude'],[21,'person:1','vlad'],[22,'agent:1','vlad'],
  [23,'person:1','claude'],[24,'agent:01','claude'],[25,'agent:9007199254740992','claude'],[26,'secret.signature','claude']]) {
  db.prepare('INSERT INTO task_watchdog_comment_auth VALUES(?,?,?,?,?)').run(id,68,key,kind,'now');
  const result=watchdog.commentIdentity({...c,id});
  assert.equal(result.verified,id<=21);
  if(id>21)assert.deepEqual(result,absent);
 }
 assert.equal(db.prepare('SELECT count(*) n FROM task_watchdog_comment_auth').get().n,8,'чтение не backfill');
});
