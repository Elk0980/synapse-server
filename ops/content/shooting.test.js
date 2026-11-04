'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {createShooting} = require('./shooting');
const {createLocalStorage} = require('./shooting-storage');

const GiB = 1024 ** 3, KEY = 'editor-key-SAMPLE-0123456789abcdef';
const MOV = (size, fill = 7) => { const b = Buffer.alloc(size, fill); b.writeUInt32BE(20, 0); b.write('ftypqt  ', 4, 'ascii'); return b; };
const users = {
  1: {id: 1, role: 'owner', login: 'owner', sessionVersion: 1, companyCodes: [], permissions: []},
  2: {id: 2, role: 'editor', login: 'smm', displayName: 'SAMPLE СММ', sessionVersion: 1, companyCodes: ['avokado'], permissions: ['autoposting.view', 'autoposting.edit']},
  3: {id: 3, role: 'editor', login: 'viewer', sessionVersion: 1, companyCodes: ['avokado'], permissions: ['autoposting.view']},
  4: {id: 4, role: 'editor', login: 'alvi', sessionVersion: 1, companyCodes: ['alvi'], permissions: ['autoposting.view', 'autoposting.edit']},
};

async function setup(t, {disk = {free: 500 * GiB, total: 1000 * GiB}, config = {}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooting-'));
  const db = new DatabaseSync(':memory:');
  const storage = createLocalStorage(path.join(dir, 'shooting'), {statfs: () => ({bavail: disk.free / 4096, bsize: 4096, blocks: disk.total / 4096})});
  const service = createShooting({db, assetsDir: dir, storage,
    config: {companyQuotaBytes: 40 * GiB, minFreeBytes: 5 * GiB, minFreePercent: 15, sketchDailyLimit: 2,
      editors: [{name: 'Claude монтаж', keySha256: crypto.createHash('sha256').update(KEY).digest('hex'), companies: ['avokado']}], ...config},
    authStore: {getById: (id) => users[id]},
    requireSession: (req) => { const id = Number(req.headers['x-test-user']); if (!users[id]) throw Object.assign(new Error('Вход'), {status: 401}); return {user: {id, sessionVersion: 1}, csrf: 'csrf'}; },
    requireCsrf: (req, session) => { if (req.headers['x-csrf-token'] !== session.csrf) throw Object.assign(new Error('CSRF'), {status: 403}); },
    readJson: async (req) => { const parts = []; for await (const c of req) parts.push(c); return JSON.parse(Buffer.concat(parts).toString() || '{}'); },
    sendJson: (res, status, body, headers) => { res.writeHead(status, {'content-type': 'application/json', ...headers}); res.end(JSON.stringify(body)); }});
  const server = http.createServer(async (req, res) => {
    try { if (!(await service.handle(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end('{}'); } }
    catch (error) { if (!res.headersSent) { res.writeHead(error.status || 500, {'content-type': 'application/json'}); res.end(JSON.stringify({error: error.message, details: error.details})); } else res.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}/content/shooting`;
  const call = async (method, route, {user = 2, code = 'avokado', body, headers = {}, raw, csrf = true} = {}) => {
    const response = await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}companyCode=${code}`, {method,
      headers: {...(user ? {'x-test-user': String(user)} : {}), ...(csrf ? {'x-csrf-token': 'csrf'} : {}), ...(body ? {'content-type': 'application/json'} : {}), ...headers},
      body: raw ?? (body ? JSON.stringify(body) : undefined)});
    const type = response.headers.get('content-type') || '';
    return {status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())};
  };
  const chunk = (id, offset, bytes, options = {}) => call('PATCH', `/uploads/${id}`, {...options, raw: bytes,
    headers: {'content-type': 'application/offset+octet-stream', 'upload-offset': String(offset), ...(options.headers || {})}});
  return {base, call, chunk, db, dir, server};
}

test('загрузка частями продолжается после обрыва куска и после «перезагрузки» страницы', async (t) => {
  const s = await setup(t), file = MOV(300000), sum = crypto.createHash('sha256').update(file).digest('hex');
  const created = await s.call('POST', '/uploads', {body: {ideaId: 'idea-2026-11-10-01-1', frame: 2, name: 'IMG_0001.MOV', size: file.length, mime: '', fingerprint: 'IMG_0001.MOV:300000:1'}});
  assert.equal(created.status, 201); const id = created.body.upload.id;
  assert.equal(created.body.upload.mime, 'video/quicktime'); assert.equal(created.body.upload.offset, 0);
  assert.equal((await s.chunk(id, 0, file.subarray(0, 100000))).body.upload.offset, 100000);
  const wrong = await s.chunk(id, 0, file.subarray(0, 100000));
  assert.equal(wrong.status, 409); assert.equal(wrong.body.details.upload.offset, 100000);
  // Обрыв посреди куска: заявлено 100000 байт, пришло 40000 и соединение закрыто.
  await new Promise((resolve) => {
    const req = http.request(`${s.base}/uploads/${id}?companyCode=avokado`, {method: 'PATCH', headers: {'x-test-user': '2', 'x-csrf-token': 'csrf',
      'content-type': 'application/offset+octet-stream', 'upload-offset': '100000', 'content-length': '100000'}});
    req.on('error', () => resolve()); req.on('close', resolve);
    req.write(file.subarray(100000, 140000), () => setTimeout(() => req.destroy(), 50));
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await s.call('GET', `/uploads/${id}`)).body.upload.offset, 100000, 'оборванный кусок откатывается');
  const again = await s.call('POST', '/uploads', {body: {ideaId: 'idea-2026-11-10-01-1', frame: 2, name: 'IMG_0001.MOV', size: file.length, fingerprint: 'IMG_0001.MOV:300000:1'}});
  assert.equal(again.status, 200); assert.equal(again.body.upload.id, id); assert.equal(again.body.upload.offset, 100000);
  await s.chunk(id, 100000, file.subarray(100000, 200000));
  const done = await s.chunk(id, 200000, file.subarray(200000));
  assert.equal(done.body.upload.status, 'stored'); assert.equal(done.body.upload.sha256, sum);
  const part = await s.call('GET', `/files/${id}`, {user: 3, csrf: false, headers: {range: 'bytes=4-11'}});
  assert.equal(part.status, 206); assert.equal(part.body.toString('ascii'), 'ftypqt  '); assert.equal(part.headers.get('content-range'), 'bytes 4-11/300000');
  const full = await s.call('GET', `/files/${id}`, {user: 3, csrf: false});
  assert.equal(crypto.createHash('sha256').update(full.body).digest('hex'), sum);
  const list = await s.call('GET', '/reels', {user: 3});
  assert.deepEqual(list.body.reels['idea-2026-11-10-01-1'].status, 'shot'); assert.equal(list.body.canEdit, false);
});

test('изоляция компаний и права: чужая компания, просмотр без правки, CSRF', async (t) => {
  const s = await setup(t), file = MOV(5000);
  const {body: {upload}} = await s.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'a.mov', size: file.length}});
  await s.chunk(upload.id, 0, file);
  assert.equal((await s.call('GET', `/files/${upload.id}`, {user: 4})).status, 403, 'пользователь Алви не открывает Авокадо');
  assert.equal((await s.call('GET', `/files/${upload.id}`, {user: 4, code: 'alvi'})).status, 404, 'id чужой компании не находится');
  assert.equal((await s.call('GET', `/reels/reel-a`, {user: 4, code: 'alvi'})).body.uploads.length, 0);
  assert.equal((await s.call('POST', '/uploads', {user: 3, body: {ideaId: 'reel-a', name: 'b.mov', size: 10}})).status, 403);
  assert.equal((await s.call('POST', '/uploads', {csrf: false, body: {ideaId: 'reel-a', name: 'b.mov', size: 10}})).status, 403);
  assert.equal((await s.call('DELETE', `/uploads/${upload.id}`, {user: 4, code: 'alvi'})).status, 404);
  assert.equal((await s.call('GET', '/reels', {user: 0})).status, 401);
  assert.equal((await s.call('GET', '/reels', {code: 'foreign'})).status, 404);
  assert.equal((await s.call('GET', '/reels', {user: 1, code: 'alvi'})).status, 200, 'владелец видит любую компанию');
});

test('отказ по месту до приёма байтов: резерв диска 15 % и квота компании', async (t) => {
  const full = await setup(t, {disk: {free: 16 * GiB, total: 100 * GiB}});
  const refused = await full.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'big.mov', size: 1.8 * GiB | 0}});
  assert.equal(refused.status, 507); assert.equal(refused.body.details.code, 'STORAGE_FULL');
  assert.match(refused.body.error, /мало свободного места.*Загрузка не начата/);
  assert.equal(full.db.prepare('SELECT COUNT(*) n FROM shooting_uploads').get().n, 0);
  const quota = await setup(t, {config: {companyQuotaBytes: 10000}});
  assert.equal((await quota.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'a.mov', size: 6000}})).status, 201);
  const over = await quota.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'b.mov', size: 6000}});
  assert.equal(over.status, 507); assert.match(over.body.error, /Место для съёмки компании закончилось/);
  assert.equal((await quota.call('GET', '/reels')).body.storage.usedBytes, 6000, 'незавершённая сессия резервирует квоту');
});

test('подмена содержимого отклоняется; раскадровка сохраняется с проверкой версии', async (t) => {
  const s = await setup(t), fake = Buffer.alloc(64, 1);
  const {body: {upload}} = await s.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'x.mov', size: fake.length}});
  const bad = await s.chunk(upload.id, 0, fake);
  assert.equal(bad.status, 422); assert.equal(fs.readdirSync(path.join(s.dir, 'shooting', 'avokado')).length, 0);
  const saved = await s.call('PUT', '/reels/reel-a/board', {body: {revision: 0, frames: [{shot: 'Лена у стойки', angle: 'средний', transition: 'склейка', notes: 'свет слева', extra: 'x'}]}});
  assert.equal(saved.status, 200); assert.equal(saved.body.reel.boardRevision, 1); assert.deepEqual(Object.keys(saved.body.reel.board[0]), ['shot', 'angle', 'transition', 'notes']);
  assert.equal((await s.call('PUT', '/reels/reel-a/board', {body: {revision: 0, frames: []}})).status, 409);
  assert.equal((await s.call('PUT', '/reels/reel-a/board', {user: 3, body: {revision: 1, frames: []}})).status, 403);
});

test('API монтажёра: только дубли своей компании на чтение, черновик в ту же карточку', async (t) => {
  const s = await setup(t), take = MOV(4000), draft = MOV(3000, 9);
  const {body: {upload}} = await s.call('POST', '/uploads', {body: {ideaId: 'reel-a', frame: 1, name: 'take.mov', size: take.length}});
  await s.chunk(upload.id, 0, take);
  const bearer = {authorization: `Bearer ${KEY}`};
  const ed = (method, route, options = {}) => s.call(method, `/editor${route}`, {user: 0, csrf: false, ...options, headers: {...bearer, ...(options.headers || {})}});
  const takes = await ed('GET', '/reels/reel-a/takes');
  assert.equal(takes.status, 200); assert.equal(takes.body.takes.length, 1); assert.match(takes.body.takes[0].fileUrl, /^\/content\/shooting\/editor\/files\//);
  assert.equal((await ed('GET', `/files/${upload.id}`)).body.length, take.length);
  assert.equal((await ed('GET', '/reels/reel-a/takes', {code: 'alvi'})).status, 403);
  assert.equal((await ed('GET', '/reels/reel-a/takes', {headers: {authorization: 'Bearer wrong-key-000000000000000000'}})).status, 401);
  assert.equal((await ed('DELETE', `/uploads/${upload.id}`)).status, 404, 'монтажёр не удаляет');
  assert.equal((await ed('POST', '/uploads', {body: {ideaId: 'reel-a', kind: 'take', name: 'd.mp4', size: 10}})).status, 403);
  assert.equal((await ed('PUT', '/reels/reel-a/status', {body: {status: 'editing'}})).body.reel.status, 'editing');
  const created = await ed('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'draft.mp4', size: draft.length}});
  assert.equal(created.body.upload.kind, 'draft');
  const done = await ed('PATCH', `/uploads/${created.body.upload.id}`, {raw: draft, headers: {'content-type': 'application/offset+octet-stream', 'upload-offset': '0'}});
  assert.equal(done.body.upload.status, 'stored');
  assert.equal((await ed('GET', `/files/${created.body.upload.id}`)).status, 404, 'черновик не отдаётся как дубль');
  const card = await s.call('GET', '/reels/reel-a', {user: 3});
  assert.deepEqual(card.body.uploads.map((item) => item.kind), ['take', 'draft']); assert.equal(card.body.reel.status, 'editing');
  await s.call('PUT', '/reels/reel-a/status', {body: {status: 'draft'}});
  assert.equal((await s.call('GET', '/reels', {user: 3})).body.reels['reel-a'].status, 'draft');
});
