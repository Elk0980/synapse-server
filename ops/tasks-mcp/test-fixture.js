'use strict';

// Изолированный стенд: настоящие CRM и прокси кабинета, только временные данные.
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const root = path.resolve(__dirname, '../..');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function unusedPort() {
  const server = http.createServer();
  await listen(server);
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startFixture({installDocuments = true, installArchive = false,watchdogMode='observe',agentId=null} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-mcp-integration-'));
  const key = randomBytes(32).toString('hex');
  const token = randomBytes(32).toString('hex');
  const password = randomBytes(24).toString('hex');
  const children = [], servers = [];
  const stop = async () => {
    for (const server of servers.reverse()) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    for (const child of children.reverse()) {
      if (child.exitCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
    }
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir())) throw Error('Небезопасный временный путь');
    await fs.rm(dir, { recursive: true, force: true });
  };
  async function service(relative, env) {
    const port = await unusedPort();
    let output = '';
    const child = spawn(process.execPath, [path.join(root, relative, 'server.js')], {
      env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || '',
        NODE_PATH: process.env.NODE_PATH || path.join(__dirname, 'node_modules'),
        PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    children.push(child);
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw Error(`Стенд ${relative} завершился: ${output.slice(-2500)}`);
      if (relative === 'ops/crm' && output.includes('Мини-CRM слушает')) return url;
      if (relative !== 'ops/crm') {
        try { if ((await fetch(`${url}/health`, { headers: { 'x-api-key': key } })).ok) return url; } catch {}
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`Стенд ${relative} не запустился: ${output.slice(-2500)}`);
  }
  try {
    if (installArchive) {
      // Офлайн-схема на синтетической БД: сервис ещё не слушает порт и не имеет писателей.
      const databasePath = path.join(dir, 'crm.sqlite');
      const bootstrap = spawnSync(process.execPath, ['-e', "require('./server.js')"], {
        cwd:path.join(root, 'ops/crm'), windowsHide:true, timeout:15000,
        env:{SystemRoot:process.env.SystemRoot || '', PATH:process.env.PATH || '',
          NODE_PATH:process.env.NODE_PATH || path.join(__dirname, 'node_modules'),
          DATABASE_PATH:databasePath, API_KEY:key}, encoding:'utf8'
      });
      if (bootstrap.status !== 0) throw Error('Не подготовлена офлайн-схема тестовой CRM: ' + (bootstrap.error?.message || bootstrap.stderr).slice(-1000));
      await require('../crm/module-archive-migrate').migrateArchiveDatabase({databasePath,
        backupPath:path.join(dir, 'crm-before-archive.sqlite'), offlineConfirmation:'CRM_STOPPED'});
    }
    const crmUrl = await service('ops/crm', { DATABASE_PATH: path.join(dir, 'crm.sqlite'),
      API_KEY: key, RATE_LIMIT_MAX: '10000',TASK_WATCHDOG_MODE:watchdogMode });
    const owner = Buffer.from(JSON.stringify({ v: 1, userId: 1, userName: 'Owner fixture',
      role: 'owner', permissions: ['crm.edit'], companyCodes: ['synapse-business', 'palitra-love'] })).toString('base64url');
    async function crm(route, method = 'GET', body, identity = owner) {
      const response = await fetch(crmUrl + route, { method,
        headers: { 'x-api-key': key, 'x-synapse-crm-identity': identity, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json(), headers: response.headers };
    }
    for (const code of ['synapse-business', 'palitra-love', 'foreign']) {
      const result = await crm('/companies', 'POST', { code, name: `SAMPLE ${code}` });
      if (result.status !== 201) throw Error('Не создана временная компания');
    }
    const { hashPassword } = require('../content/passwords');
    const contentUrl = await service('ops/content', { DATABASE_PATH: path.join(dir, 'content.sqlite'),
      API_KEY: key, CRM_URL: crmUrl, CRM_API_KEY: key,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      AUTH_USERS: `owner:owner:${hashPassword(password)};editor:editor:${hashPassword(password)}` });
    async function login(name) {
      const response = await fetch(contentUrl + '/content/login', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: name, password }) });
      if (!response.ok) throw Error('Не выполнен вход во временный кабинет');
      const cookie = response.headers.get('set-cookie').split(';')[0];
      const who = await fetch(contentUrl + '/content/whoami', { headers: { cookie } });
      return { cookie, identity: await who.json() };
    }
    const account = await login('owner'), editor = await login('editor');
    async function cabinet(route, method = 'GET', body, auth = account) {
      const response = await fetch(contentUrl + '/content/crm' + route, { method,
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.identity.csrfToken, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json(), headers: response.headers };
    }
    const docs = path.join(dir, 'handoff');
    async function installSampleDocuments() {
      await fs.mkdir(docs, {recursive: true});
      const map = { always: ['CONSTITUTION.md', 'DIRECTION.md'], rules: [
        { match: ['сайт', 'вёрстка', 'палитр'], read: ['SITE.md'], why: 'Правила сайта' },
        { match: ['видео'], read: ['VIDEO.md'], why: 'Правила видео' }
      ] };
      await fs.writeFile(path.join(docs, 'MAP.json'), JSON.stringify(map));
      for (const name of ['CONSTITUTION.md', 'DIRECTION.md', 'SITE.md', 'VIDEO.md']) {
        await fs.writeFile(path.join(docs, name), `SAMPLE fixture ${name}`);
      }
    }
    if (installDocuments) await installSampleDocuments();
    const { createTasksMcpServer, loadConfig } = require('./server');
    const config = loadConfig({ PORT: '8080', CRM_URL: crmUrl, CRM_API_KEY: key,
      TASKS_MCP_TOKEN: token, TASKS_MCP_OWNER_ID: '1',...(agentId?{TASKS_MCP_AGENT_ID:String(agentId)}:{}),
      TASKS_MCP_PROJECTS: 'synapse-business,palitra-love',
      TASKS_MCP_PUBLIC_ORIGIN: 'https://tasks.example.test', TASKS_MCP_DOCS_DIR: docs });
    const mcp = createTasksMcpServer(config);
    servers.push(mcp);
    const mcpUrl = await listen(mcp);
    let requestId = 0, session;
    async function rpc(method, params) {
      const response = await fetch(`${mcpUrl}/mcp/${token}`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(session ? { 'mcp-session-id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, ...(params ? { params } : {}) }) });
      session = response.headers.get('mcp-session-id') || session;
      const raw = await response.text();
      const data = response.headers.get('content-type')?.includes('text/event-stream')
        ? JSON.parse(raw.split('\n').filter(line => line.startsWith('data:')).at(-1).slice(5)) : JSON.parse(raw);
      return { status: response.status, ...data };
    }
    async function call(name, args) {
      const result = await rpc('tools/call', { name, arguments: args });
      if (result.error) return { isError: true, error: result.error };
      const value = result.result;
      let data = value.structuredContent;
      if (!data) {
        const content = value.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
        try { data = JSON.parse(content); }
        catch { data = {error:{message:content}}; }
      }
      return { isError: Boolean(value.isError), data };
    }
    // Та же HTML-страница и ресурсы; только локальный маршрутизатор вместо Caddy.
    const front = http.createServer(async (request, response) => {
      if (request.url.startsWith('/content/')) {
        const proxy = http.request(contentUrl + request.url, { method: request.method, headers: request.headers }, upstream => {
          response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response);
        });
        proxy.on('error', () => { response.writeHead(502); response.end(); });
        request.pipe(proxy); return;
      }
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const target = path.resolve(root, 'sites/synapse', '.' + decodeURIComponent(pathname));
      const base = path.join(root, 'sites/synapse') + path.sep;
      if (!target.startsWith(base)) { response.writeHead(404); response.end(); return; }
      try {
        const bytes = await fs.readFile(target);
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(target)] || 'application/octet-stream';
        response.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-cache, must-revalidate' }); response.end(bytes);
      } catch { response.writeHead(404); response.end(); }
    });
    servers.push(front);
    const frontUrl = await listen(front);
    return { dir, docs, installSampleDocuments, crm, cabinet, account, editor, rpc, call, mcpUrl, frontUrl, stop };
  } catch (error) { await stop(); throw error; }
}

module.exports = { startFixture };
