'use strict';
/* Маршрут счётчика подписчиков в запущенном chat: проверяются ключ, метод и параметры.
   Сеть наружу заблокирована: ни Telegram, ни CRM в этом тесте не вызываются по-настоящему.
   Все ключи, коды компаний и каналы вымышленные. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn } = require('node:child_process'), { once } = require('node:events'), { randomBytes } = require('node:crypto');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('счётчик подписчиков: ключ, метод и параметры проверяются до любого обращения наружу', { timeout: 60000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-tg-stats-'));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const serviceKey = randomBytes(24).toString('hex');
  const outboundLog = path.join(directory, 'outbound.log');
  const preload = path.join(directory, 'no-network.cjs');
  // Любой исходящий вызов записывается и отклоняется: маршрут обязан отказать раньше него.
  await fs.writeFile(preload, `
  'use strict';
  const fs = require('node:fs');
  globalThis.fetch = async (input) => {
    fs.appendFileSync(${JSON.stringify(outboundLog)}, String(typeof input === 'string' ? input : input.url) + '\\n');
    if (String(input).endsWith('/company-links/transient')) return new Response('{}', { status: 503 });
    throw new Error('сеть в этом тесте запрещена');
  };
  `);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(directory, 'chat.sqlite'),
      CHAT_API_KEY: randomBytes(16).toString('hex'), CRM_API_KEY: serviceKey,
      CRM_URL: 'http://127.0.0.1:1/leads', TELEGRAM_BOT_TOKEN: '', TELEGRAM_POLLING: '',
      PROJECT_CONTENT_URL: '', MODEL_API_URL: '', CLIENT_BOARD_SECRET: '', CONSENT_SERVICE_KEY: '',
      PALITRA_CLIENT_BOT_TOKEN: '', ALLOWED_ORIGINS: '' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  children.push(child);
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const route = '/internal/telegram/channel-members';
  const call = async (query = '?companyCode=alvi', options = {}) => {
    const response = await fetch(base + route + query, { signal: AbortSignal.timeout(5000), ...options });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error('chat не запустился: ' + errors);
    try { await call('?companyCode=alvi'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  const withKey = (extra = {}) => ({ headers: { 'x-api-key': serviceKey, ...extra } });

  // Без ключа и с неверным ключом — отказ, и ни одного обращения наружу.
  assert.equal((await call('?companyCode=alvi')).status, 401);
  assert.equal((await call('?companyCode=alvi', { headers: { 'x-api-key': 'wrong' } })).status, 401);
  assert.equal((await call('?companyCode=alvi', { headers: { 'x-api-key': serviceKey + 'x' } })).status, 401);
  assert.equal((await call('?companyCode=alvi', { headers: { 'x-api-key': '' } })).status, 401);
  /* Ключ той же длины в символах, но вдвое длиннее в байтах: «é» — один символ и два байта
     UTF-8. Сравнение по длине строки отдало бы такие буферы в timingSafeEqual и упало бы
     необработанной ошибкой; сравнение по байтам просто отказывает. */
  const widened = '\u00e9'.repeat(serviceKey.length);
  assert.equal(widened.length, serviceKey.length);
  assert.notEqual(Buffer.byteLength(widened, 'utf8'), Buffer.byteLength(serviceKey, 'utf8'));
  const unicode = await call('?companyCode=alvi', { headers: { 'x-api-key': widened } });
  assert.equal(unicode.status, 401, 'ключ иной байтовой длины отклонён, а не приводит к сбою');
  assert.equal(typeof unicode.body.error, 'string');
  await assert.rejects(fs.readFile(outboundLog), 'без верного ключа наружу не ходим');

  // Метод и параметры: POST и произвольные параметры не принимаются.
  assert.equal((await call('?companyCode=alvi', { method: 'POST', ...withKey() })).status, 405);
  assert.equal((await call('?companyCode=alvi&chat_id=-1001', withKey())).status, 400, 'чужой параметр не принимается');
  assert.equal((await call('?companyCode=alvi&method=getChat', withKey())).status, 400);
  assert.equal((await call('?companyCode=', withKey())).status, 400);
  assert.equal((await call('?companyCode=не%20код', withKey())).status, 400);
  // Ровно один companyCode: повторённый параметр контракту не соответствует.
  const duplicated = await call('?companyCode=alvi&companyCode=avokado', withKey());
  assert.equal(duplicated.status, 400, 'повторный companyCode не принимается');
  assert.match(duplicated.body.error, /ровно один параметр companyCode/);
  await assert.rejects(fs.readFile(outboundLog), 'отклонённые запросы наружу не ходят');

  // Верный ключ и верный код: маршрут идёт в CRM за привязкой — и честно отказывает, а не возвращает ноль.
  const answer = await call('?companyCode=alvi', withKey());
  assert.ok([409, 502, 404].includes(answer.status), JSON.stringify(answer));
  assert.equal(typeof answer.body.error, 'string');
  assert.doesNotMatch(JSON.stringify(answer.body), new RegExp(serviceKey), 'ключ наружу не выходит');
  assert.doesNotMatch(JSON.stringify(answer.body), /\b0\b/, 'отказ не подменяется нулём подписчиков');
  const outbound = await fs.readFile(outboundLog, 'utf8').catch(() => '');
  assert.match(outbound, /company-links\/alvi/, 'привязка берётся с защищённого маршрута CRM');
  assert.doesNotMatch(outbound, new RegExp(serviceKey), 'ключ не уходит в адрес');
  assert.doesNotMatch(outbound, /api\.telegram\.org/, 'без подтверждённой привязки Bot API не вызывается');
  const transient = await call('?companyCode=transient', withKey());
  assert.equal(transient.status, 503, 'временный сбой CRM не выдаётся за отсутствие привязки');
  assert.match(transient.body.error, /временно недоступны/);
});
