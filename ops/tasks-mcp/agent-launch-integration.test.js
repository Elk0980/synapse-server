'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {startFixture} = require('./test-fixture');
const {startChildMcp} = require('../content/agent-launch-child-mcp');
const {createMcpClient} = require('../content/agent-launch-local-worker');

test('real MCP → CRM → existing dispatch → worker claim, session resume and stop',async t => {
  const fixture = await startFixture({installDocuments:false});
  t.after(() => fixture.stop());
  async function call(name,args) {
    const r = await fixture.call(name,args);
    assert.equal(r.isError,false,JSON.stringify(r.data || r.error));
    return r.data;
  }
  const old = (await call('task_create',{client_ref:'old-task',title:'SAMPLE Существующая задача',project:'synapse-business',
    description:'Локальная проверка',executor:'Codex',reviewer:'Claude'})).task;
  const oldComment = await call('task_comment',{task_id:old.id,author:'Owner',text:'SAMPLE прежний комментарий'});
  const target = (await call('task_create',{client_ref:'test-code-task',title:'SAMPLE Исправить код',project:'synapse-business',
    description:'Добавить локальную проверку модуля',executor:'Codex',reviewer:'Claude'})).task;
  const result = await call('agent_launch',{task_id:target.id,client_ref:'test-launch'});
  assert.equal(result.run.state,'queued');
  assert.equal((await call('agent_launch',{task_id:target.id,client_ref:'test-launch'})).created,false);
  const worker_id = randomUUID();
  const {job} = await call('agent_worker_claim',{worker_id});
  assert.equal(job.run_id,result.run.run_id);
  const credentials = {worker_id,run_id:job.run_id,lease_token:job.lease_token};
  const session_id = randomUUID();
  await call('agent_worker_update',{...credentials,event:'started',session_id,log_tail:'spawned\nthread.started'});
  // The real missing-map response crosses CRM/MCP and the single-task child
  // proxy without exposing its Owner endpoint. It does not block local task tools.
  const agentName = `Codex — задача #${target.id}`;
  const proxy = await startChildMcp({job,agentName,upstreamCall:async (name,args) => {
    const value = await fixture.call(name,args);
    if (value.isError) {
      const missing = value.data?.error?.status === 503 && value.data?.error?.message === 'Карта не установлена';
      throw Object.assign(new Error('UPSTREAM_REJECTED'),{code:missing ? 'MAP_NOT_INSTALLED' : 'MCP_REJECTED'});
    }
    return value.data;
  }});
  t.after(proxy.close);
  const childCall = createMcpClient(proxy.endpoint);
  await assert.rejects(childCall('session_start',{agent:agentName,kind:'codex',request:'Локальная проверка'}),{code:'MAP_NOT_INSTALLED'});
  assert.equal((await childCall('task_get',{task_id:target.id})).id,target.id);
  await childCall('task_update',{task_id:target.id,status:'in_progress'});
  await childCall('task_comment',{task_id:target.id,author:agentName,text:'SAMPLE карта не установлена; выполняется локальная проверка'});
  await assert.rejects(childCall('task_get',{task_id:old.id}),{code:'MCP_REJECTED'});
  await assert.rejects(childCall('agent_launch',{task_id:old.id}),{code:'MCP_REJECTED'});
  const catalog = await call('agents_list',{});
  const agent = catalog.agents.find(a => a.name===`Codex — задача #${target.id}`);
  assert.equal(agent.state,'work');assert.equal(agent.active_tasks[0].id,target.id);
  await call('agent_worker_update',{...credentials,event:'complete',session_id,summary:'TURN_COMPLETE',exit_code:0});
  const message = await call('agent_message',{run_id:job.run_id,text:'SAMPLE исправить проверку',client_ref:'test-followup'});
  const continued = (await call('agent_worker_claim',{worker_id})).job;
  assert.equal(continued.session_id,session_id);assert.equal(continued.branch,job.branch);
  assert.equal(continued.message_id,message.message_id);
  assert.equal(continued.message,'SAMPLE исправить проверку');
  await call('agent_stop',{run_id:job.run_id});
  const heartbeat = await call('agent_worker_update',{worker_id,run_id:continued.run_id,lease_token:continued.lease_token,event:'heartbeat'});
  assert.equal(heartbeat.run.stop_requested,true);
  await call('agent_worker_update',{worker_id,run_id:continued.run_id,lease_token:continued.lease_token,event:'stopped',exit_code:0});
  const status = await call('agent_status',{run_id:job.run_id});
  assert.equal(status.run.state,'stopped');assert.equal('lease_token' in status.run,false);
  const original = await call('task_get',{task_id:old.id});
  assert.equal(original.comments[0].id,oldComment.comment.id);
  assert.equal(original.comments[0].text,'SAMPLE прежний комментарий');
  const audited = await call('task_get',{task_id:target.id});
  assert.equal(audited.status,'in_progress');
  assert.ok(audited.comments.some(c => c.text.includes('Продолжение')));
});
