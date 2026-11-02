'use strict';

const http = require('node:http');
const path = require('node:path');
const {createHash, timingSafeEqual} = require('node:crypto');
const {McpServer} = require('@modelcontextprotocol/server');
const {NodeStreamableHTTPServerTransport} = require('@modelcontextprotocol/node');
const {TOOLS, SESSION_RULES} = require('./tools');
const {sessionDocuments, readDocument} = require('./documents');
const MAX_BODY_BYTES = 128 * 1024;
const MAX_CRM_RESPONSE_BYTES = 32 * 1024 * 1024;
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };

function loadConfig(env = process.env) {
  const port = Number(env.PORT || 8080);
  const ownerId = Number(env.TASKS_MCP_OWNER_ID);
  const token = env.TASKS_MCP_TOKEN || '';
  const crmKey = env.CRM_API_KEY || '';
  const projects = [...new Set((env.TASKS_MCP_PROJECTS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean))];
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(ownerId) || ownerId < 1 ||
      !/^[a-zA-Z0-9_-]{32,256}$/.test(token) || !crmKey.trim() || projects.length < 1 || projects.length > 100 ||
      projects.some(value => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value))) {
    throw new Error('Нужны корректные PORT, Owner ID, секретный токен, CRM-ключ и явный список проектов');
  }
  let crmUrl, publicOrigin;
  try {
    crmUrl = new URL(env.CRM_URL || 'http://crm:8080');
    publicOrigin = new URL(env.TASKS_MCP_PUBLIC_ORIGIN || 'https://tasks.synapsebusiness.ru');
  } catch { throw new Error('Некорректная конфигурация адресов сервиса'); }
  if (crmUrl.protocol !== 'http:' || !['crm', '127.0.0.1', 'localhost', '[::1]'].includes(crmUrl.hostname) ||
      crmUrl.username || crmUrl.password || crmUrl.pathname !== '/' || crmUrl.search || crmUrl.hash ||
      publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password ||
      publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash) {
    throw new Error('CRM должен быть внутренним, а публичный адрес — HTTPS origin');
  }
  return Object.freeze({port, ownerId, token, crmKey, projects, crmUrl:crmUrl.origin,
    publicOrigin:publicOrigin.origin, docsDir:path.resolve(env.TASKS_MCP_DOCS_DIR || '/app/docs/handoff')});
}

function safeMessage(error, config) {
  if (error.code === 'MAP_NOT_INSTALLED') return 'Карта не установлена';
  if (!Number.isInteger(error.status) || error.status >= 500) return 'Сервис временно недоступен; результат операции не подтверждён';
  let message = String(error.message || 'Запрос отклонён').slice(0, 400);
  for (const secret of [config.token, config.crmKey]) if (secret) message = message.split(secret).join('REDACTED');
  return message;
}

function crmClient(config, fetchImpl = fetch) {
  const identity = Buffer.from(JSON.stringify({v:1, userId:config.ownerId, userName:'Owner', role:'owner',
    permissions:['crm.view', 'crm.edit'], companyCodes:config.projects})).toString('base64url');
  const allowed = new Set(TOOLS.filter(tool => tool.name !== 'doc_read').map(tool => tool.name));
  return async (name, args) => {
    if (!allowed.has(name)) fail(404, 'Инструмент не найден');
    let response;
    try {
      response = await fetchImpl(`${config.crmUrl}/coordination/mcp/${name}`, {
        method:'POST', headers:{'content-type':'application/json', 'x-api-key':config.crmKey,
          'x-synapse-crm-identity':identity}, body:JSON.stringify(args),
        redirect:'error', signal:AbortSignal.timeout(15000)
      });
    } catch { fail(503, 'CRM недоступна; результат операции не подтверждён'); }
    let data;
    try {
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_CRM_RESPONSE_BYTES) {
        await response.body?.cancel();
        fail(502, 'Ответ CRM слишком большой');
      }
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_CRM_RESPONSE_BYTES) { await reader.cancel(); fail(502, 'Ответ CRM слишком большой'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error.status) throw error;
      fail(502, 'Некорректный ответ CRM; результат операции не подтверждён');
    }
    if (!response.ok) {
      const message = typeof data.error === 'string' ? data.error : data.error?.message || data.message;
      fail(response.status, message || 'CRM отклонила запрос');
    }
    return data;
  };
}

function mcpServer(config, callCrm) {
  const server = new McpServer({name:'synapse-tasks', version:'1.0.0'}, {
    instructions:'Единый реестр задач Owner. Начните с session_start, прочитайте карту через doc_read, обновляйте задачи и завершайте session_end.'
  });
  for (const tool of TOOLS) {
    server.registerTool(tool.name, {description:tool.description, inputSchema:tool.inputSchema}, async args => {
      try {
        let result;
        if (tool.name === 'doc_read') result = await readDocument(config.docsDir, args.path);
        else if (tool.name === 'session_start') {
          const documents = await sessionDocuments(config.docsDir, args.request);
          result = {...await callCrm(tool.name, args), rules:SESSION_RULES, documents};
        } else result = await callCrm(tool.name, args);
        return {content:[{type:'text', text:JSON.stringify(result)}], structuredContent:result};
      } catch (error) {
        const result = {error:{status:error.status || 500, message:safeMessage(error, config)}};
        return {content:[{type:'text', text:JSON.stringify(result)}], structuredContent:result, isError:true};
      }
    });
  }
  return server;
}

function sendJson(response, status, data) {
  response.writeHead(status, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store',
    'x-content-type-options':'nosniff'});
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail(413, 'Запрос слишком большой');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Некорректный JSON'); }
}

function createTasksMcpServer(config, {fetchImpl, callCrm = crmClient(config, fetchImpl)} = {}) {
  const expected = createHash('sha256').update(`/mcp/${config.token}`).digest();
  const publicUrl = new URL(config.publicOrigin);
  const server = http.createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    let instance, transport;
    try {
      // Сравнение фиксированных хешей исключает ранний выход по длине секрета.
      const candidate = createHash('sha256').update(request.url || '').digest();
      if (request.url === '/health' && request.method === 'GET') return sendJson(response, 200, {status:'ok'});
      if (!timingSafeEqual(candidate, expected)) return sendJson(response, 401, {error:'Требуется авторизация Owner'});
      let hostUrl;
      try { hostUrl = new URL(`http://${request.headers.host}`); }
      catch { return sendJson(response, 403, {error:'Недопустимый Host'}); }
      if (hostUrl.username || hostUrl.password || hostUrl.pathname !== '/' || hostUrl.search || hostUrl.hash ||
          (hostUrl.host !== publicUrl.host && !['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname))) {
        return sendJson(response, 403, {error:'Недопустимый Host'});
      }
      const origin = request.headers.origin;
      if (origin && origin !== config.publicOrigin) return sendJson(response, 403, {error:'Недопустимый Origin'});
      if (!['POST', 'GET', 'DELETE'].includes(request.method)) return sendJson(response, 405, {error:'Метод не поддерживается'});
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        return sendJson(response, 405, {error:'Сервис работает без транспортных сессий; используйте POST'});
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
        return sendJson(response, 415, {error:'Требуется application/json'});
      }
      const body = await readBody(request);
      instance = mcpServer(config, callCrm);
      transport = new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined, enableJsonResponse:true});
      await instance.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.status || 500, {error:safeMessage(error, config)});
      else if (!response.writableEnded) response.end();
    } finally {
      if (instance) await instance.close().catch(() => {});
      if (transport) await transport.close().catch(() => {});
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (require.main === module) {
  try {
    const config = loadConfig();
    const server = createTasksMcpServer(config);
    server.listen(config.port, '0.0.0.0', () => process.stdout.write('Synapse Tasks MCP запущен\n'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
  } catch {
    process.stderr.write('Tasks MCP не запущен: проверьте обязательные переменные окружения\n');
    process.exitCode = 1;
  }
}

module.exports = {createTasksMcpServer, loadConfig, crmClient, MAX_BODY_BYTES, MAX_CRM_RESPONSE_BYTES};
