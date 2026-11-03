'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {startChildMcp} = require('./agent-launch-child-mcp');

async function fixture(t) {
  const calls = [];
  const proxy = await startChildMcp({job:{task_id:40,run_id:'sample-run',company_code:'sample',title:'Локальная правка'},
    agentName:'Codex — задача #40', upstreamCall:async (name,args) => {
      calls.push({name,args});
      if (name === 'session_start') return {session_id:'own-session',documents:[{path:'RULES.md'}],tasks:[{id:40},{id:41}]};
      if (name === 'doc_read') return {path:args.path,text:'SAMPLE правила'};
      return {ok:true,agent:{active_tasks:[{id:40},{id:41}],active_task_count:2}};
    }});
  t.after(proxy.close);
  let id = 0;
  const rpc = async (method,params,headers={}) => {
    const r = await fetch(proxy.endpoint,{method:'POST',headers:{'content-type':'application/json',...headers},
      body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
    return {status:r.status,data:await r.json()};
  };
  const call = async (name,args) => (await rpc('tools/call',{name,arguments:args})).data.result;
  return {...proxy,rpc,call,calls};
}

test('child MCP exposes only own-task tools, no Owner launch/claim or cross-task writes', async t => {
  const f = await fixture(t);
  assert.equal((await f.rpc('initialize',{protocolVersion:'2025-06-18'})).data.result.serverInfo.name,'synapse-task-run');
  const listed = (await f.rpc('tools/list')).data.result.tools;
  assert.deepEqual(listed.map(x=>x.name),['session_start','doc_read','task_get','task_update','task_comment','agent_report','session_end']);
  for (const [name,args] of [
    ['agent_launch',{task_id:40}],['agent_worker_claim',{worker_id:'other'}],
    ['task_get',{task_id:41}],['task_update',{task_id:40,status:'done'}],
    ['task_update',{task_id:40,reviewer:'Codex'}],
    ['task_comment',{task_id:40,author:'Owner',text:'Подмена'}],
    ['session_end',{session_id:'foreign',summary:'Подмена'}],
    ['doc_read',{path:'RULES.md'}],
    ['agent_report',{agent:'Other',state:'work',last_event:'Подмена'}]
  ]) assert.equal((await f.call(name,args)).isError,true, name);
  assert.equal(f.calls.length,0);
  assert.equal((await f.call('task_get',{task_id:40,comments_offset:20})).isError,undefined);
  assert.equal(f.calls.length,1);
});

test('child MCP pins map selection and identity; sessions/documents cannot escape the run', async t => {
  const f = await fixture(t);
  const session = await f.call('session_start',{agent:'Codex — задача #40',kind:'codex',request:'Другая компания'});
  assert.deepEqual(session.structuredContent.tasks,[{id:40}]);
  assert.equal(f.calls[0].args.request,'sample задача #40: Локальная правка');
  assert.equal((await f.call('doc_read',{path:'RULES.md'})).structuredContent.text,'SAMPLE правила');
  assert.equal((await f.call('doc_read',{path:'../private.env'})).isError,true);
  assert.equal((await f.call('agent_report',{agent:'Codex — задача #40',state:'work',last_event:'Начал'})).isError,undefined);
  const report = await f.call('agent_report',{agent:'Codex — задача #40',state:'work',last_event:'Проверка области'});
  assert.deepEqual(report.structuredContent.agent.active_tasks,[{id:40}]);
  assert.equal(report.structuredContent.agent.active_task_count,1);
  assert.equal(f.calls.at(-1).args.chat,'codex://agent-runs/sample-run');
  assert.equal((await f.call('session_end',{session_id:'own-session',summary:'Готово'})).isError,undefined);
  assert.equal((await f.call('session_end',{session_id:'own-session',summary:'Повтор'})).isError,true);
});

test('child MCP rejects browser origins/foreign Host and never returns upstream exception secrets', async t => {
  const f = await fixture(t);
  assert.equal((await f.rpc('tools/list',{}, {origin:'https://foreign.example'})).status,403);
  const foreignHost = await new Promise((resolve,reject) => {
    const request = http.request(f.endpoint,{method:'POST',headers:{host:'foreign.example','content-type':'application/json'}},response => {
      response.resume(); response.on('end',()=>resolve(response.statusCode));
    });
    request.on('error',reject); request.end('{}');
  });
  assert.equal(foreignHost,403);
  assert.equal((await fetch(f.endpoint + '?extra')).status,404);
  const broken = await startChildMcp({job:{task_id:40,run_id:'sample',title:'Тест'},agentName:'Codex',
    upstreamCall:async () => {throw Error('https://tasks.example/mcp/SECRET_VALUE');}});
  t.after(broken.close);
  const response = await fetch(broken.endpoint,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'task_get',arguments:{task_id:40}}})});
  const body = await response.text();
  assert.doesNotMatch(body,/SECRET_VALUE|tasks.example/);
  assert.equal(JSON.parse(body).result.isError,true);
});

test('missing map retains only its static safe reason for work without tasks 24/25', async t => {
  const proxy = await startChildMcp({job:{task_id:40,run_id:'sample',title:'Тест'},agentName:'Codex',
    upstreamCall:async () => {throw Object.assign(Error('SECRET'),{code:'MAP_NOT_INSTALLED'});}});
  t.after(proxy.close);
  const response = await fetch(proxy.endpoint,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'session_start',arguments:{agent:'Codex',kind:'codex',request:'Тест'}}})});
  const result = (await response.json()).result;
  assert.deepEqual(result.structuredContent.error,{status:503,message:'Карта не установлена'});
  assert.doesNotMatch(JSON.stringify(result),/SECRET/);
});

test('child update cannot reopen a closed task or overwrite a newer revision', async t => {
  let status='done',revision=4; const writes=[];
  const proxy=await startChildMcp({job:{task_id:40,run_id:'sample',title:'Тест'},agentName:'Codex',
    upstreamCall:async(name,args)=>{
      if(name==='task_get') return {id:40,status,coordination:{revision}};
      writes.push(args);return {ok:true};
    }});
  t.after(proxy.close);
  const call=async args=>{
    const r=await fetch(proxy.endpoint,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'task_update',arguments:args}})});
    return (await r.json()).result;
  };
  assert.equal((await call({task_id:40,status:'in_progress'})).isError,true);
  status='planned';
  assert.equal((await call({task_id:40,status:'in_progress',revision:3})).isError,true);
  assert.equal(writes.length,0);
  assert.equal((await call({task_id:40,status:'in_progress'})).isError,undefined);
  assert.equal(writes[0].revision,4);
});
