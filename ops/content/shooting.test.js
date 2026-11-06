'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {createShooting, readShootingConfig, DEFAULTS} = require('./shooting');
const {createLocalStorage} = require('./shooting-storage');

const GiB = 1024 ** 3;
const MOV = (size, fill = 7) => { const b = Buffer.alloc(size, fill); b.writeUInt32BE(20, 0); b.write('ftypqt  ', 4, 'ascii'); return b; };
const users = {
  1: {id: 1, role: 'owner', login: 'owner', sessionVersion: 1, companyCodes: [], permissions: []},
  2: {id: 2, role: 'editor', login: 'smm', displayName: 'SAMPLE СММ', sessionVersion: 1, companyCodes: ['avokado'], permissions: ['autoposting.view', 'autoposting.edit']},
  3: {id: 3, role: 'editor', login: 'viewer', sessionVersion: 1, companyCodes: ['avokado'], permissions: ['autoposting.view']},
  4: {id: 4, role: 'editor', login: 'alvi', sessionVersion: 1, companyCodes: ['alvi'], permissions: ['autoposting.view', 'autoposting.edit']},
};

async function setup(t, {disk = {free: 500 * GiB, total: 1000 * GiB}, config = {}, clock = {at: Date.parse('2026-11-05T00:00:00Z')}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooting-'));
  const db = new DatabaseSync(':memory:');
  const storage = createLocalStorage(path.join(dir, 'shooting'), {statfs: () => ({bavail: disk.free / 4096, bsize: 4096, blocks: disk.total / 4096})});
  const service = createShooting({db, assetsDir: dir, storage, now: () => new Date(clock.at),
    config: {companyQuotaBytes: 40 * GiB, minFreeBytes: 5 * GiB, minFreePercent: 15, sketchDailyLimit: 2, uploadTtlHours: 24, maxOpenUploads: 12, ...config},
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
  return {base, call, chunk, db, dir, server, disk, clock};
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
  assert.match(refused.body.error, /не хватает места.*Загрузка не начата/);
  assert.equal(full.db.prepare('SELECT COUNT(*) n FROM shooting_uploads').get().n, 0);
  const quota = await setup(t, {config: {companyQuotaBytes: 10000}});
  assert.equal((await quota.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'a.mov', size: 6000}})).status, 201);
  const over = await quota.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'b.mov', size: 6000}});
  assert.equal(over.status, 507); assert.match(over.body.error, /Место для съёмки компании закончилось/);
  assert.equal((await quota.call('GET', '/reels')).body.storage.usedBytes, 6000, 'незавершённая сессия резервирует квоту');
});

test('№119: резерв по умолчанию — фиксированный запас 2 ГБ плюс размер файла, а не 15 % диска', async (t) => {
  // Боевой 05.11: диск ~77 ГБ, свободно 9,2 ГБ — прежний резерв 11,5 ГБ запрещал даже файл в 1 КБ.
  const live = await setup(t, {disk: {free: 9.2 * GiB, total: 76.7 * GiB}, config: {...DEFAULTS}});
  const info = (await live.call('GET', '/reels', {user: 1})).body.storage;
  assert.equal(info.canUpload, true); assert.equal(info.refusal, ''); assert.equal(info.reserveBytes, 2 * GiB);
  assert.equal((await live.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'tiny.mov', size: 1024}})).status, 201);
  assert.equal((await live.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'take.mov', size: 1.8 * GiB | 0}})).status, 201, '4K-дубль 1,8 ГБ помещается');
  // Проверка не отключена: после файла должно остаться не меньше запаса.
  const tight = await setup(t, {disk: {free: 3.5 * GiB, total: 76.7 * GiB}, config: {...DEFAULTS}});
  const refused = await tight.call('POST', '/uploads', {user: 1, body: {ideaId: 'reel-a', name: 'big.mov', size: 1.8 * GiB | 0}});
  assert.equal(refused.status, 507); assert.equal(refused.body.details.code, 'STORAGE_FULL'); assert.match(refused.body.error, /не меньше 2,0 ГБ/);
  assert.equal((await tight.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'small.mov', size: 1 * GiB}})).status, 201);
  // Нулевой запас из настройки не выключает проверку: минимум 512 МБ.
  const zero = await setup(t, {disk: {free: 0.6 * GiB, total: 76.7 * GiB}, config: {...DEFAULTS, minFreeBytes: 0}});
  assert.equal((await zero.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'x.mov', size: 200 * 1024 ** 2}})).status, 507);
});

test('№119: запас задаётся env SHOOTING_MIN_FREE_MB поверх файла; мусор игнорируется', () => {
  const missing = path.join(os.tmpdir(), 'no-such-shooting-config.json');
  assert.equal(readShootingConfig(missing, {}).minFreeBytes, 2 * GiB);
  assert.equal(readShootingConfig(missing, {}).minFreePercent, 0);
  assert.equal(readShootingConfig(missing, {SHOOTING_MIN_FREE_MB: '3072'}).minFreeBytes, 3 * GiB);
  assert.equal(readShootingConfig(missing, {SHOOTING_MIN_FREE_MB: 'много'}).minFreeBytes, 2 * GiB);
  assert.equal(readShootingConfig(missing, {SHOOTING_MIN_FREE_MB: '-5'}).minFreeBytes, 2 * GiB);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooting-cfg-')), file = path.join(dir, 'shooting.json');
  fs.writeFileSync(file, JSON.stringify({minFreeBytes: 4 * GiB}));
  try {
    assert.equal(readShootingConfig(file, {}).minFreeBytes, 4 * GiB);
    assert.equal(readShootingConfig(file, {SHOOTING_MIN_FREE_MB: '1024'}).minFreeBytes, 1 * GiB, 'env важнее файла');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
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

test('монтажёр — Claude-агент по сессии с autoposting.edit своей компании: дубли, черновик, «в монтаже»; без отдельного ключа', async (t) => {
  const s = await setup(t), take = MOV(4000), draft = MOV(3000, 9);
  const {body: {upload}} = await s.call('POST', '/uploads', {body: {ideaId: 'reel-a', frame: 1, name: 'take.mov', size: take.length}});
  await s.chunk(upload.id, 0, take);
  const card = await s.call('GET', '/reels/reel-a');
  assert.equal(card.body.uploads[0].kind, 'take');
  assert.equal((await s.call('GET', card.body.uploads[0].fileUrl.replace('/content/shooting', '').replace(/\?.*$/, ''))).body.length, take.length);
  assert.equal((await s.call('PUT', '/reels/reel-a/status', {body: {status: 'editing'}})).body.reel.status, 'editing');
  const created = await s.call('POST', '/uploads', {body: {ideaId: 'reel-a', kind: 'draft', name: 'draft.mp4', size: draft.length}});
  assert.equal(created.body.upload.kind, 'draft');
  assert.equal((await s.chunk(created.body.upload.id, 0, draft)).body.upload.status, 'stored');
  assert.deepEqual((await s.call('GET', '/reels/reel-a', {user: 3})).body.uploads.map((item) => item.kind), ['take', 'draft']);
  assert.equal((await s.call('GET', '/editor/reels/reel-a/takes', {headers: {authorization: 'Bearer anything-0000000000000000000'}})).status, 404, 'маршрутов по ключу нет');
  assert.equal((await s.call('GET', '/reels/reel-a', {user: 0, headers: {authorization: 'Bearer anything-0000000000000000000'}})).status, 401);
  assert.equal((await s.call('PUT', '/reels/reel-a/status', {user: 3, body: {status: 'draft'}})).status, 403, 'без autoposting.edit монтажёр не работает');
  assert.equal((await s.call('PUT', '/reels/reel-a/status', {user: 4, code: 'alvi', body: {status: 'draft'}})).body.reel.status, 'draft');
  assert.equal((await s.call('GET', '/reels/reel-a', {user: 3})).body.reel.status, 'editing', 'статус Алви не трогает Авокадо');
});

test('безопасность места: брошенные загрузки истекают через 24 ч, предел открытых, чужие сессии не блокируют, диск видит только владелец', async (t) => {
  const s = await setup(t, {disk: {free: 20 * GiB, total: 100 * GiB}, config: {maxOpenUploads: 2}});
  const big = 1.8 * GiB | 0, file = MOV(10000);
  // Алви бросает две недокачанные сессии по 1,8 ГБ — Авокадо по-прежнему загружает (резерв 15 ГБ).
  assert.equal((await s.call('POST', '/uploads', {user: 4, code: 'alvi', body: {ideaId: 'r', name: 'a1.mov', size: big}})).status, 201);
  assert.equal((await s.call('POST', '/uploads', {user: 4, code: 'alvi', body: {ideaId: 'r', name: 'a2.mov', size: big}})).status, 201);
  const third = await s.call('POST', '/uploads', {user: 4, code: 'alvi', body: {ideaId: 'r', name: 'a3.mov', size: 100}});
  assert.equal(third.status, 429); assert.equal(third.body.details.code, 'TOO_MANY_OPEN');
  const mine = await s.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'b.mov', size: file.length}});
  assert.equal(mine.status, 201, 'чужие брошенные сессии не занимают общий резерв');
  await s.chunk(mine.body.upload.id, 0, file.subarray(0, 4000));
  // Владелец видит цифры диска, остальные — только «хватает / не хватает».
  const smm = (await s.call('GET', '/reels')).body.storage, owner = (await s.call('GET', '/reels', {user: 1})).body.storage;
  assert.equal(smm.server, 'enough'); assert.equal('freeBytes' in smm, false); assert.equal('reserveBytes' in smm, false); assert.equal('adapter' in smm, false);
  assert.equal(typeof owner.freeBytes, 'number'); assert.equal(typeof owner.reserveBytes, 'number');
  // Диск заполнился во время загрузки: кусок не принимается, принятое сохраняется; цифр у не-владельца нет.
  s.disk.free = 15 * GiB;
  const paused = await s.chunk(mine.body.upload.id, 4000, file.subarray(4000));
  assert.equal(paused.status, 507); assert.equal(paused.body.details.upload.offset, 4000); assert.doesNotMatch(paused.body.error, /ГБ/);
  const low = await s.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'c.mov', size: 1000}});
  assert.equal(low.status, 507); assert.doesNotMatch(low.body.error, /\d/); assert.equal('freeBytes' in low.body.details.storage, false);
  assert.match((await s.call('POST', '/uploads', {user: 1, body: {ideaId: 'reel-a', name: 'c.mov', size: 1000}})).body.error, /ГБ/);
  s.disk.free = 20 * GiB;
  // Через 24 ч без кусков сессии истекают: файлы удалены, квота и предел освобождены.
  s.clock.at += 25 * 3600000;
  assert.equal((await s.call('GET', '/reels', {user: 4, code: 'alvi'})).body.storage.openUploads, 0);
  const rows = s.db.prepare('SELECT company_code, status FROM shooting_uploads ORDER BY id').all().map((r) => `${r.company_code}:${r.status}`);
  assert.deepEqual(rows, ['alvi:expired', 'alvi:expired', 'avokado:expired']);
  assert.equal(fs.readdirSync(path.join(s.dir, 'shooting', 'avokado')).length, 0, 'недокачанный файл удалён');
  const gone = await s.chunk(mine.body.upload.id, 4000, file.subarray(4000));
  assert.equal(gone.status, 410); assert.equal(gone.body.details.code, 'UPLOAD_EXPIRED');
  const fresh = await s.call('POST', '/uploads', {body: {ideaId: 'reel-a', name: 'b.mov', size: file.length}});
  assert.equal(fresh.status, 201); assert.notEqual(fresh.body.upload.id, mine.body.upload.id);
  assert.equal((await s.call('GET', '/reels')).body.storage.usedBytes, file.length, 'квота считает только живые сессии');
});

test('факты съёмки для этапа идеи (specs/209-cf-stages): кадры раскадровки, снятые кадры, дубли, черновики; только своя компания', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooting-facts-'));
  const db = new DatabaseSync(':memory:');
  t.after(() => { db.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const service = createShooting({db, assetsDir: dir, storage: createLocalStorage(path.join(dir, 'shooting')), authStore: {getById: () => null},
    requireSession: () => { throw new Error('нет'); }, requireCsrf: () => {}, readJson: async () => ({}), sendJson: () => {}});
  const put = db.prepare(`INSERT INTO shooting_uploads(company_code,idea_id,frame,kind,name,mime,size,disk_key,status,created_by,created_at)
    VALUES(?,?,?,?,'f.mov','video/quicktime',1,?,?,'t','t')`);
  let n = 0;
  put.run('avokado', 'i1', 1, 'take', `k${++n}`, 'stored'); put.run('avokado', 'i1', 2, 'take', `k${++n}`, 'stored');
  put.run('avokado', 'i1', 2, 'take', `k${++n}`, 'stored'); put.run('avokado', 'i1', 3, 'take', `k${++n}`, 'uploading');
  put.run('avokado', 'i2', null, 'draft', `k${++n}`, 'stored'); put.run('alvi', 'i1', 1, 'take', `k${++n}`, 'stored');
  db.prepare(`INSERT INTO shooting_reels(company_code,idea_id,status,board,board_revision) VALUES('avokado','i1',NULL,?,1),('avokado','i3','editing','[]',0)`)
    .run(JSON.stringify([{shot: 'a'}, {shot: 'b'}, {shot: 'c'}]));
  assert.deepEqual(service.facts('avokado'), {v: 1, companyCode: 'avokado', reels: {i1: [3, 2, 3, 0, null], i2: [0, 0, 0, 1, null], i3: [0, 0, 0, 0, 'editing']}});
  assert.equal(service.facts('unknown'), null);
  const decoded = JSON.parse(Buffer.from(service.factsHeader('alvi'), 'base64url').toString('utf8'));
  assert.deepEqual(decoded, {v: 1, companyCode: 'alvi', reels: {i1: [0, 0, 1, 0, null]}});
});
