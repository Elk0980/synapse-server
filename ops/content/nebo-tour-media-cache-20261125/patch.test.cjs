'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { applyPatch, state } = require('./patch.cjs');

// Снимок боевого обработчика 05.11 (origin/snapshot/server-live-20261105-v2), побайтно.
const BEFORE = fs.readFileSync(path.join(__dirname, 'fixture', 'site-workspace-http.snapshot-20261105.js'), 'utf8');
// TYPES и validPath — те же строки, что в site-workspaces.js того же снимка (сокращённый TYPES).
const STORE_STUB = `'use strict';
const path=require('node:path');
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.jpg':'image/jpeg',
  '.png':'image/png','.webp':'image/webp','.mp4':'video/mp4','.json':'application/json; charset=utf-8'};
const validPath = value => typeof value === 'string' && value.length > 0 && value.length <= 240 &&
  !value.includes('\\\\') && !value.includes('\\0') && !value.startsWith('/') &&
  value.split('/').every(part => part && !part.startsWith('.') && /^[\\w .@()\\u0400-\\u04ff-]+$/.test(part)) &&
  Boolean(TYPES[path.extname(value).toLowerCase()]);
module.exports={TYPES,validPath};
`;

const HOST = 'nebo-draft-1.synapsebusiness.ru';
const VIDEO = Buffer.alloc(4096, 7);

async function startServer(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-media-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'site-workspaces.js'), STORE_STUB);
  fs.writeFileSync(path.join(dir, 'site-workspace-http.js'), source);
  const root = path.join(dir, 'versions', 'rev1');
  fs.mkdirSync(path.join(root, 'tour-media'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Небо</title>');
  fs.writeFileSync(path.join(root, 'tour-media', 'pk26.mp4'), VIDEO);
  fs.writeFileSync(path.join(root, 'tour-media', 'n26-img-g2.jpg'), 'jpg');
  fs.writeFileSync(path.join(root, 'tour-media', 'data.json'), '{}');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'void 0');
  fs.writeFileSync(path.join(dir, 'secret.jpg'), 'outside');
  const draft = { id: 'site-x', company_code: 'nebo', hostname: HOST, runtime: 'static', root };
  const workspaces = { publishedHost: h => (h === HOST ? draft : null) };
  const { createDraftHostHandler } = require(path.join(dir, 'site-workspace-http.js'));
  const handle = createDraftHostHandler(workspaces, {});
  const server = http.createServer(async (req, res) => {
    if (!(await handle(req, res))) { res.writeHead(418); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return (p, headers = {}, host = HOST, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method,
      headers: { host, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

const LONG = 'public, max-age=31536000, immutable';

test('патч применяется к снимку ровно один раз и идемпотентен', () => {
  assert.equal(state(BEFORE), 'ready');
  const patched = applyPatch(BEFORE);
  assert.equal(state(patched), 'applied');
  assert.equal(applyPatch(patched), patched);
  assert.throws(() => applyPatch(BEFORE.replace("'Cache-Control':'no-store'};", "'Cache-Control':'x'};")), /ANCHOR_MISMATCH/);
  assert.equal(state(BEFORE.replace(/\r\n/g, '\n')), 'ready', 'LF-вариант файла тоже распознаётся');
});

test('diff ограничен двумя добавленными строками и одной изменённой', () => {
  const before = BEFORE.split('\r\n'), after = applyPatch(BEFORE).split('\r\n');
  assert.ok(!applyPatch(BEFORE).replace(/\r\n/g, '').includes('\n'), 'CRLF сохранён во всех строках');
  assert.equal(after.length, before.length + 2);
  const removed = before.filter(line => !after.includes(line));
  assert.deepEqual(removed, ["      'Content-Length':stat.size,'Cache-Control':'no-store'};"]);
});

test('до патча медиа отдаются с no-store (воспроизведение)', async t => {
  const get = await startServer(t, BEFORE);
  const res = await get('/tour-media/pk26.mp4?v=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('после патча: /tour-media долгий кэш, Range/206 сохранён, остальное no-store', async t => {
  const get = await startServer(t, applyPatch(BEFORE));

  const full = await get('/tour-media/pk26.mp4?v=1');
  assert.equal(full.status, 200);
  assert.equal(full.headers['cache-control'], LONG);
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.equal(full.body.length, VIDEO.length);
  assert.equal(full.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(full.headers['content-security-policy'], /media-src 'self'/);

  const part = await get('/tour-media/pk26.mp4?v=1', { range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 100-199/${VIDEO.length}`);
  assert.equal(part.headers['accept-ranges'], 'bytes');
  assert.equal(part.body.length, 100);
  assert.equal(part.headers['cache-control'], LONG);

  const bad = await get('/tour-media/pk26.mp4', { range: 'bytes=999999-' });
  assert.equal(bad.status, 416);

  const head = await get('/tour-media/n26-img-g2.jpg?v=1', {}, HOST, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers['cache-control'], LONG);

  for (const p of ['/', '/index.html', '/assets/app.js', '/tour-media/data.json']) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers['cache-control'], 'no-store', p);
  }
});

test('после патча проверки пути, хоста и метода не ослаблены', async t => {
  const get = await startServer(t, applyPatch(BEFORE));
  const missing = await get('/tour-media/none.mp4');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['cache-control'], 'no-store');
  assert.equal((await get('/tour-media/..%2F..%2F..%2Fsecret.jpg')).status, 404);
  assert.equal((await get('/tour-media/.hidden.jpg')).status, 404);
  assert.equal((await get('/tour-media/pk26.mp4', {}, HOST, 'POST')).status, 403);
  assert.equal((await get('/tour-media/pk26.mp4', {}, 'other-draft-1.synapsebusiness.ru')).status, 404);
  assert.equal((await get('/tour-media/pk26.mp4', {}, 'example.com')).status, 418);
});
