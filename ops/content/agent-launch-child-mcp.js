'use strict';

// Локальная граница одного запуска. Owner endpoint остаётся только у родительского worker.
const http = require('node:http');
const {randomBytes, timingSafeEqual} = require('node:crypto');
const MAX_BODY = 64 * 1024;
// Похожие латинские буквы, невидимые символы и разделители не обходят запрет «КОД ПРИНЯТ».
const LOOKALIKE = {a:'а',b:'в',c:'с',e:'е',h:'н',k:'к',m:'м',n:'п',o:'о',p:'р',r:'г',t:'т',u:'и',x:'х',y:'у','0':'о','3':'з'};
function claimsAcceptance(value) {
  if (typeof value !== 'string') return false;
  const letters = value.normalize('NFKC').toLowerCase().replace(/\p{Cf}/gu,'')
    .replace(/[a-z03]/g, char => LOOKALIKE[char] || char).replace(/[^\p{L}]/gu,'');
  return letters.includes('кодпринят');
}
const fail = (message = 'Запрос вне разрешённой области запуска') => {
  throw Object.assign(Error(message),{code:'CHILD_SCOPE_REJECTED'});
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const str = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

async function startChildMcp({upstreamCall, job, agentName}) {
  if (typeof upstreamCall !== 'function' || !integer(job?.task_id, 1, Number.MAX_SAFE_INTEGER) ||
      !str(job?.run_id, 100) || !str(agentName, 200)) fail();
  const sessions = new Set(), documents = new Set();
  const task = {type:'integer', const:job.task_id};
  const text = maxLength => ({type:'string', minLength:1, maxLength});
  const tools = [
    ['session_start', 'Получить правила и документы только своей задачи.', {
      agent:{const:agentName,type:'string'}, kind:{const:'codex',type:'string'}, request:text(4000)
    }, ['agent','kind','request']],
    ['doc_read', 'Прочитать документ из карты текущего запуска.', {path:text(200)}, ['path']],
    ['task_get', 'Прочитать свою задачу и её комментарии.', {task_id:task,
      comments_limit:{type:'integer',minimum:1,maximum:20}, comments_offset:{type:'integer',minimum:0},
      subtasks_limit:{type:'integer',minimum:1,maximum:100}, subtasks_offset:{type:'integer',minimum:0}
    }, ['task_id']],
    ['task_update', 'Отметить работу или блокер своей задачи; приёмку выполняет проверяющий.', {task_id:task,
      status:{type:'string',const:'in_progress'}, blocker:{type:'string',maxLength:4000},
      next_step:{type:'string',maxLength:4000}, revision:{type:'integer',minimum:0}
    }, ['task_id']],
    ['task_comment', 'Записать результат или вопрос Claude в свою задачу.', {
      task_id:task, author:{type:'string',const:agentName}, text:text(10000)
    }, ['task_id','author','text']],
    ['agent_report', 'Сообщить состояние только своего агента.', {agent:{type:'string',const:agentName},
      kind:{type:'string',const:'codex'}, state:{type:'string',enum:['work','wait','idle','unknown','error']},
      last_event:text(2000)
    }, ['agent','state','last_event']],
    ['session_end', 'Завершить свою рабочую сессию без приёмки задачи.', {session_id:text(200),summary:text(10000),
      state:{type:'string',enum:['work','wait','idle','unknown','error']}
    }, ['session_id','summary']]
  ].map(([name,description,properties,required]) => ({name,description,
    annotations:{readOnlyHint:['task_get','doc_read'].includes(name),destructiveHint:false,
      idempotentHint:['task_get','doc_read','agent_report','task_update','session_start'].includes(name),openWorldHint:false},
    inputSchema:{type:'object',properties,required,additionalProperties:false}}));
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const scopedResult = data => {
    if (Array.isArray(data)) return data.map(scopedResult);
    if (!object(data)) return data;
    const result = Object.fromEntries(Object.entries(data).map(([key,value]) => [key,scopedResult(value)]));
    for (const key of ['tasks','active_tasks']) {
      if (Array.isArray(result[key])) result[key] = result[key].filter(item => (item?.id ?? item?.task_id) === job.task_id);
    }
    if (Array.isArray(result.active_tasks)) result.active_task_count = result.active_tasks.length;
    return result;
  };
  function validate(name, args) {
    const tool = byName.get(name);
    if (!tool || !object(args)) fail();
    const schema = tool.inputSchema;
    if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) ||
        schema.required.some(key => !Object.hasOwn(args,key))) fail();
    for (const [key,value] of Object.entries(args)) {
      const rule = schema.properties[key];
      if (rule.type === 'integer' && !integer(value,rule.minimum ?? 1,rule.maximum ?? Number.MAX_SAFE_INTEGER)) {
        fail(`Аргумент ${key}: нужно целое число от ${rule.minimum ?? 1} до ${rule.maximum ?? Number.MAX_SAFE_INTEGER}.`);
      }
      if ((rule.type === 'string' && (typeof value !== 'string' || value.length > (rule.maxLength ?? 200) ||
          (rule.minLength && !value.trim()))) ||
          (rule.type === 'integer' && !integer(value,rule.minimum ?? 1,rule.maximum ?? Number.MAX_SAFE_INTEGER)) ||
          ('const' in rule && value !== rule.const) || (rule.enum && !rule.enum.includes(value))) fail();
    }
    if (name === 'doc_read' && !documents.has(args.path)) fail();
    if (name === 'session_end' && !sessions.has(args.session_id)) fail();
    // №194: приёмку кода фиксирует только доверенный обработчик после проверки CI — ни в одном поле.
    if (Object.values(args).some(claimsAcceptance)) fail('«КОД ПРИНЯТ» оставляет только доверенный обработчик после зелёного CI.');
  }
  async function call(name,args) {
    validate(name,args);
    const forwarded = {...args};
    if (name === 'task_update') {
      const current = await upstreamCall('task_get',{task_id:job.task_id});
      if (['done','cancelled'].includes(current?.status)) fail();
      const revision = current?.coordination?.revision;
      if (Number.isSafeInteger(revision) && revision >= 0) {
        if (args.revision !== undefined && args.revision !== revision) fail();
        forwarded.revision = revision;
      }
    }
    if (name === 'session_start') forwarded.request = `${job.company_code} задача #${job.task_id}: ${job.title}`.slice(0,4000);
    if (name === 'agent_report') forwarded.chat = `codex://agent-runs/${job.run_id}`;
    const data = scopedResult(await upstreamCall(name,forwarded));
    if (name === 'session_start') {
      if (typeof data?.session_id === 'string') sessions.add(data.session_id);
      for (const doc of data?.documents || []) if (typeof doc?.path === 'string') documents.add(doc.path);
      // Старые открытые сессии не расширяют область этого запуска.
      return {...data, ...(Array.isArray(data?.tasks) ? {tasks:data.tasks.filter(item => (item.id ?? item.task_id) === job.task_id)} : {})};
    }
    if (name === 'session_end') sessions.delete(args.session_id);
    return data;
  }
  const secretPath = `/mcp/${randomBytes(32).toString('hex')}`;
  let expectedHost;
  const send = (response,status,data) => {
    response.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});
    response.end(data === undefined ? undefined : JSON.stringify(data));
  };
  const server = http.createServer(async (request,response) => {
    const pathBytes = Buffer.from(request.url || ''), expected = Buffer.from(secretPath);
    if (pathBytes.length !== expected.length || !timingSafeEqual(pathBytes,expected)) return send(response,404,{error:'Адрес не найден'});
    if (request.headers.host !== expectedHost || request.headers.origin) return send(response,403,{error:'Доступ запрещён'});
    if (request.method !== 'POST') return send(response,405,{error:'Требуется POST'});
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return send(response,415,{error:'Требуется JSON'});
    let id = null;
    try {
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) return send(response,413,{error:'Слишком большой запрос'});
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') fail();
      id = body.id ?? null;
      if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled') return send(response,202);
      let result;
      if (body.method === 'initialize') result = {protocolVersion:body.params?.protocolVersion || '2025-06-18',
        capabilities:{tools:{}},serverInfo:{name:'synapse-task-run',version:'1.0.0'}};
      else if (body.method === 'ping') result = {};
      else if (body.method === 'tools/list') result = {tools};
      else if (body.method === 'tools/call') {
        try {
          const data = await call(body.params?.name,body.params?.arguments);
          result = {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
        } catch (error) {
          const missingMap = error?.code === 'MAP_NOT_INSTALLED';
          result = {isError:true, ...(missingMap ? {structuredContent:{error:{status:503,message:'Карта не установлена'}}} : {}),
            content:[{type:'text',text:missingMap ? 'Карта не установлена' : error?.code === 'CHILD_SCOPE_REJECTED' ? error.message : 'Запрос отклонён или результат не подтверждён; проверьте состояние своей задачи.'}]};
        }
      } else return send(response,200,{jsonrpc:'2.0',id,error:{code:-32601,message:'Метод недоступен'}});
      send(response,200,{jsonrpc:'2.0',id,result});
    } catch { if (!response.headersSent) send(response,400,{jsonrpc:'2.0',id,error:{code:-32600,message:'Некорректный запрос'}}); }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  expectedHost = `127.0.0.1:${server.address().port}`;
  return {endpoint:`http://${expectedHost}${secretPath}`, close:async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }};
}

module.exports = {startChildMcp};
