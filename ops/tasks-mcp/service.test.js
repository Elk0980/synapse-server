'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {createTasksMcpServer, loadConfig, crmClient, MAX_BODY_BYTES, MAX_CRM_RESPONSE_BYTES} = require('./server');
const {TOOLS} = require('./tools');

function config(extra = {}) {
  return {...loadConfig({TASKS_MCP_TOKEN:'fixture-token-for-tests-only-000001', TASKS_MCP_OWNER_ID:'7',
    TASKS_MCP_PROJECTS:'synapse-business,palitra', CRM_API_KEY:'fixture-crm-key'}), ...extra};
}

async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-mcp-test-'));
  const docsDir = options.absentDocs ? path.join(temporary, 'missing', 'handoff') : temporary;
  t.after(() => fs.rm(temporary, {recursive:true, force:true}));
  const c = config({docsDir});
  const calls = [];
  const server = createTasksMcpServer(c, {callCrm:options.callCrm || (async (name, args) => {
    calls.push({name, args});
    if (name === 'task_create') return {task:{id:42,title:args.title,company_code:args.project},created:true};
    return {tasks:[], ...(name === 'session_start' ? {session_id:'fixture-session', agent:{name:args.agent}} : {})};
  })});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${origin}/mcp/${c.token}`;
  const rpc = async (method, params, overrides = {}) => {
    const response = await fetch(endpoint, {method:'POST', headers:{'content-type':'application/json',
      accept:'application/json, text/event-stream', ...overrides.headers},
      body:JSON.stringify({jsonrpc:'2.0', id:1, method, ...(params === undefined ? {} : {params})})});
    return {response, body:await response.json()};
  };
  return {c, origin, endpoint, rpc, calls, docsDir};
}

test('обязательные параметры закрыты по умолчанию; значения секретов не входят в ошибки', () => {
  assert.throws(() => loadConfig({}), /Нужны корректные/);
  assert.throws(() => loadConfig({TASKS_MCP_TOKEN:'short', CRM_API_KEY:'private'}), error =>
    !error.message.includes('short') && !error.message.includes('private'));
  const base = {TASKS_MCP_TOKEN:'x'.repeat(32), TASKS_MCP_OWNER_ID:'7', TASKS_MCP_PROJECTS:'synapse-business', CRM_API_KEY:'x'};
  for (const fields of [{CRM_URL:'https://foreign.example'}, {CRM_URL:'http://crm:8080/private'},
    {CRM_URL:'http://x:y@crm:8080'}, {TASKS_MCP_PUBLIC_ORIGIN:'http://tasks.example'},
    {TASKS_MCP_PROJECTS:'*'}, {TASKS_MCP_OWNER_ID:'0'}]) {
    assert.throws(() => loadConfig({...base, ...fields}));
  }
});

test('без секрета 401, health не раскрывает настройки; Host и Origin проверяются', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.origin}/mcp`)).status, 401);
  assert.equal((await fetch(`${f.origin}/mcp/incorrect`)).status, 401);
  assert.equal((await fetch(`${f.endpoint}?token=anything`)).status, 401);
  assert.deepEqual(await (await fetch(`${f.origin}/health`)).json(), {status:'ok'});
  assert.equal((await f.rpc('tools/list', undefined, {headers:{origin:'https://evil.example'}})).response.status, 403);
  for (const host of ['evil.example','owner@127.0.0.1','127.0.0.1/path']) {
    const hostileHostStatus = await new Promise((resolve,reject) => {
      const request = http.request(f.endpoint, {method:'POST',headers:{host,'content-type':'application/json'}}, response => {
        response.resume(); response.on('end',() => resolve(response.statusCode));
      });
      request.on('error',reject); request.end('{}');
    });
    assert.equal(hostileHostStatus, 403);
  }
  assert.equal(f.calls.length, 0);
});

test('официальный Streamable HTTP: initialize, tools/list, ping и ограничения транспорта', async t => {
  const f = await fixture(t);
  const init = await f.rpc('initialize', {protocolVersion:'2025-11-25', capabilities:{}, clientInfo:{name:'fixture',version:'1'}});
  assert.equal(init.response.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'synapse-tasks');
  const listed = await f.rpc('tools/list');
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body.result.tools.map(tool => tool.name), TOOLS.map(tool => tool.name));
  assert.equal(listed.body.result.tools.length, 13);
  assert.ok(listed.body.result.tools.every(tool => /[а-яА-Я]/.test(tool.description)));
  assert.equal((await f.rpc('ping')).response.status, 200);
  for (const method of ['GET','DELETE','PUT']) assert.equal((await fetch(f.endpoint, {method})).status, 405);
  assert.equal((await fetch(f.endpoint, {method:'POST',body:'{}'})).status, 415);
  assert.equal((await fetch(f.endpoint, {method:'POST',headers:{'content-type':'application/json'},body:'{'})).status, 400);
  assert.equal((await fetch(f.endpoint, {method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(MAX_BODY_BYTES+1)})).status, 413);
  const invalidVersion = await f.rpc('tools/list', undefined, {headers:{'mcp-protocol-version':'9999-99-99'}});
  assert.equal(invalidVersion.response.status, 400);
});

test('схемы инструментов запрещают превышение лимита и произвольный proxy', async t => {
  const f = await fixture(t);
  for (const [name,args] of [['tasks_list',{limit:101}], ['task_get',{task_id:1,url:'http://crm/leads'}],
    ['task_create',{client_ref:'one',title:'тест',project:'palitra',source:'telegram'}],
    ['task_update',{task_id:1,due_date:'2026-02-31'}],
    ['task_update',{task_id:1,due_date:null}],
    ['session_start',{agent:'Codex',kind:'codex',request:'x'.repeat(4001)}],
    ['agent_report',{agent:'Codex',state:'work',last_event:'event',chat:'x'.repeat(501)}],
    ['task_get',{task_id:1,comments_limit:21}],
    ['task_get',{task_id:1,subtasks_limit:101}],
    ['task_get',{task_id:1,comments_offset:-1}]]) {
    const result = await f.rpc('tools/call', {name,arguments:args});
    assert.ok(result.body.error || result.body.result.isError);
  }
  assert.equal(f.calls.length, 0);
  const result = await f.rpc('tools/call', {name:'tasks_list',arguments:{project:'palitra',limit:100,today:true}});
  assert.equal(result.body.result.isError, undefined);
  assert.deepEqual(f.calls, [{name:'tasks_list',args:{project:'palitra',limit:100,today:true}}]);
  await f.rpc('tools/call', {name:'task_get',arguments:{task_id:1,comments_limit:20,comments_offset:20,subtasks_limit:100,subtasks_offset:100}});
  assert.deepEqual(f.calls[1], {name:'task_get',args:{task_id:1,comments_limit:20,comments_offset:20,subtasks_limit:100,subtasks_offset:100}});
});

test('отсутствующий канон не создаёт сессию; карта выбирает сайт Палитры без видео', async t => {
  const f = await fixture(t);
  let result = await f.rpc('tools/call', {name:'session_start',arguments:{agent:'Codex',kind:'codex',request:'правка сайта Палитры'}});
  assert.equal(result.body.result.structuredContent.error.status, 503);
  assert.equal(result.body.result.structuredContent.error.message, 'Карта не установлена');
  assert.equal(f.calls.length, 0);
  const map = {always:['CONSTITUTION.md','DIRECTION.md'],rules:[
    {match:['сайт','вёрстка','palitra'],read:['SITE.md'],why:'Правила сайта'},
    {match:['видео'],read:['VIDEO.md'],why:'Правила видео'}]};
  await fs.writeFile(path.join(f.docsDir,'MAP.json'), JSON.stringify(map));
  for (const name of ['CONSTITUTION.md','DIRECTION.md','SITE.md','VIDEO.md']) await fs.writeFile(path.join(f.docsDir,name),'SAMPLE fixture');
  result = await f.rpc('tools/call', {name:'session_start',arguments:{agent:'Codex',kind:'codex',request:'правка сайта Палитры'}});
  const payload = result.body.result.structuredContent;
  assert.equal(payload.session_id, 'fixture-session');
  assert.deepEqual(payload.documents.map(document => document.path), ['CONSTITUTION.md','DIRECTION.md','SITE.md']);
  assert.ok(payload.rules.some(rule => rule.includes('maker ≠ checker')));
  assert.equal(f.calls.length, 1);
  result = await f.rpc('tools/call', {name:'doc_read',arguments:{path:'SITE.md'}});
  assert.equal(result.body.result.structuredContent.text, 'SAMPLE fixture');
  assert.equal(f.calls.length, 1);
});

test('HTTP работает без каталога документов; поздняя тестовая карта подключается без перезапуска', async t => {
  const f = await fixture(t, {absentDocs:true});
  assert.deepEqual(await (await fetch(`${f.origin}/health`)).json(), {status:'ok'});
  const listed = await f.rpc('tools/list');
  assert.equal(listed.response.status,200);
  assert.equal(listed.body.result.tools.length,13);
  let result = await f.rpc('tools/call', {name:'tasks_list',arguments:{project:'synapse-business'}});
  assert.equal(result.body.result.isError,undefined);
  assert.deepEqual(result.body.result.structuredContent.tasks,[]);
  result = await f.rpc('tools/call', {name:'task_create',arguments:{client_ref:'without-docs',title:'SAMPLE без карты',project:'synapse-business'}});
  assert.equal(result.body.result.isError,undefined);
  assert.equal(result.body.result.structuredContent.created,true);
  assert.equal(result.body.result.structuredContent.task.id,42);
  assert.deepEqual(f.calls.map(call => call.name), ['tasks_list','task_create']);
  const start = {name:'session_start',arguments:{agent:'Codex fixture',kind:'codex',request:'правка сайта'}};
  result = await f.rpc('tools/call',start);
  assert.equal(result.body.result.isError,true);
  assert.deepEqual(result.body.result.structuredContent.error,{status:503,message:'Карта не установлена'});
  result = await f.rpc('tools/call',{name:'doc_read',arguments:{path:'RULES.md'}});
  assert.deepEqual(result.body.result.structuredContent.error,{status:503,message:'Карта не установлена'});
  result = await f.rpc('tools/call',{name:'doc_read',arguments:{path:'../PRIVATE.md'}});
  assert.equal(result.body.result.structuredContent.error.status,400);
  assert.deepEqual(f.calls.map(call => call.name), ['tasks_list','task_create']);
  await assert.rejects(fs.stat(f.docsDir), error => error.code === 'ENOENT');
  await fs.mkdir(f.docsDir,{recursive:true});
  await fs.writeFile(path.join(f.docsDir,'MAP.json'),'{');
  result = await f.rpc('tools/call',start);
  assert.equal(result.body.result.structuredContent.error.status,503);
  assert.notEqual(result.body.result.structuredContent.error.message,'Карта не установлена');
  await fs.writeFile(path.join(f.docsDir,'MAP.json'),JSON.stringify({always:['RULES.md'],rules:[]}));
  result = await f.rpc('tools/call',start);
  assert.equal(result.body.result.structuredContent.error.status,503);
  assert.notEqual(result.body.result.structuredContent.error.message,'Карта не установлена');
  assert.deepEqual(f.calls.map(call => call.name), ['tasks_list','task_create']);
  await fs.writeFile(path.join(f.docsDir,'RULES.md'),'SAMPLE поздняя карта');
  result = await f.rpc('tools/call',start);
  assert.equal(result.body.result.isError,undefined);
  assert.equal(result.body.result.structuredContent.session_id,'fixture-session');
  assert.deepEqual(result.body.result.structuredContent.documents.map(document => document.path),['RULES.md']);
  assert.deepEqual(f.calls.map(call => call.name), ['tasks_list','task_create','session_start']);
  result = await f.rpc('tools/call',{name:'doc_read',arguments:{path:'RULES.md'}});
  assert.equal(result.body.result.structuredContent.text,'SAMPLE поздняя карта');
});

test('CRM identity содержит только Owner и allowlist; upstream ошибки не раскрывают секреты', async t => {
  const c = config();
  const calls = [];
  const call = crmClient(c, async (url, options) => {
    calls.push({url,options});
    return new Response(JSON.stringify({error:`Чужая компания ${c.token} ${c.crmKey}`}), {status:404});
  });
  await assert.rejects(call('task_get',{task_id:99}), error => error.status === 404);
  const identity = JSON.parse(Buffer.from(calls[0].options.headers['x-synapse-crm-identity'],'base64url'));
  assert.equal(identity.role, 'owner');
  assert.equal(identity.userId, 7);
  assert.deepEqual(identity.companyCodes, ['synapse-business','palitra']);
  assert.equal(calls[0].options.headers['x-api-key'], c.crmKey);
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(call('leads_list', {}), error => error.status === 404);
  const f = await fixture(t, {callCrm:async (name,args) => {
    throw Object.assign(new Error(`${c.token} ${c.crmKey} /private/path`), {status:args.task_id === 99 ? 404 : 503});
  }});
  const result = await f.rpc('tools/call',{name:'task_get',arguments:{task_id:99}});
  assert.equal(result.body.result.structuredContent.error.status, 404);
  const serialized = JSON.stringify(result.body);
  assert.ok(!serialized.includes(c.token) && !serialized.includes(c.crmKey));
  const unavailable = await f.rpc('tools/call',{name:'task_get',arguments:{task_id:100}});
  assert.equal(unavailable.body.result.structuredContent.error.status,503);
  assert.equal(unavailable.body.result.structuredContent.error.message,'Сервис временно недоступен; результат операции не подтверждён');
  assert.ok(!JSON.stringify(unavailable.body).includes('/private/path'));
});

test('CRM читает допустимый большой ответ и отменяет поток выше32MiB без повтора', async () => {
  const c = config();
  const largeText = 'S'.repeat(3 * 1024 * 1024);
  const allowed = crmClient(c, async () => new Response(JSON.stringify({tasks:[{description:largeText}]})));
  assert.equal((await allowed('tasks_list',{})).tasks[0].description.length,largeText.length);
  let cancelled = 0, calls = 0;
  const streaming = crmClient(c, async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_CRM_RESPONSE_BYTES + 1)); },
      cancel() { cancelled++; }
    }));
  });
  await assert.rejects(streaming('tasks_list',{}), error => error.status === 502);
  assert.equal(cancelled,1); assert.equal(calls,1);
  const declared = crmClient(c, async () => new Response(new ReadableStream({
    cancel() { cancelled++; }
  }), {headers:{'content-length':String(MAX_CRM_RESPONSE_BYTES + 1)}}));
  await assert.rejects(declared('tasks_list',{}),error => error.status === 502);
  assert.equal(cancelled,2);
});
