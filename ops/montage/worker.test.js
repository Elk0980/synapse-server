'use strict';
/* Сквозной тест автомонтажа без сети наружу: настоящий CRM-обработчик «Материалов» (SQLite в памяти) ←
   настоящий шлюз content (montage-gateway) ← воркер с настоящим ffmpeg. Клипы генерируются lavfi во временной папке.
   node --test ops/montage/worker.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {DatabaseSync} = require('node:sqlite');
const {createReelMaterials} = require('../crm/reel-materials');
const {createReelMaterialsHandler} = require('../crm/reel-materials-http');
const {createMontageGateway} = require('../content/montage-gateway');
const {createWorker, readConfig} = require('./worker');
const engine = require('./render');
const {hasFfmpeg, tmp, colorClip, colorAt, dominant, maxVolume} = require('./test-support');

const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'].find((file) => fs.existsSync(file));
const ORIGIN = 'https://synapse.synapsebusiness.ru';
const KEY = crypto.randomBytes(24).toString('hex');
const skip = !hasFfmpeg() && 'ffmpeg не установлен';

async function listen(handler) {
  const server = http.createServer(async (request, response) => {
    try { if (!(await handler(request, response, new URL(request.url, 'http://local')))) { response.writeHead(404); response.end(); } } catch (error) {
      if (!response.headersSent) { response.writeHead(error.status || 500, {'content-type': 'application/json'}); response.end(JSON.stringify({error: error.message, details: error.details})); }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {server, url: `http://127.0.0.1:${server.address().port}`};
}
const readJson = async (request) => { let raw = ''; for await (const chunk of request) raw += chunk; return raw ? JSON.parse(raw) : {}; };
const readRaw = async (request, limit) => { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > limit) throw Object.assign(Error('big'), {status: 413}); chunks.push(chunk); } return Buffer.concat(chunks); };
const sendJson = (response, status, body, headers) => { response.writeHead(status, {'content-type': 'application/json', ...headers}); response.end(JSON.stringify(body)); };

async function stand(t) {
  const dir = tmp('montage-e2e-');
  const assetsDir = path.join(dir, 'assets');
  // CRM: компании, план с идеей и сценарием по секундам (формат таблицы), ролик «Материалов».
  const crmDb = new DatabaseSync(':memory:');
  crmDb.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0,timezone TEXT);
    INSERT INTO companies(id,code) VALUES(1,'avokado'),(2,'alvi');
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT,updated_at TEXT,is_deleted INTEGER DEFAULT 0,title TEXT,description TEXT,company_code TEXT,
      assignee_role TEXT,assignee_name TEXT,status TEXT,priority TEXT DEFAULT 'normal',due_date TEXT DEFAULT '',source TEXT,source_ref TEXT,source_author TEXT,created_by TEXT);
    CREATE TABLE media_mentor_plans(company_id INTEGER PRIMARY KEY,revision INTEGER,brief_revision INTEGER,plan TEXT,updated_at TEXT);`);
  const script = ['ДО СЪЁМКИ: поставить свет', '0–1 с | Лена | Привет! | крупно | — | Скидка недели', '1–2 с | — | — | зал | панорама | ', '2–3 с | Лена | Ждём вас | общий | — | Запись в бот'].join('\n');
  crmDb.prepare('INSERT INTO media_mentor_plans VALUES(1,1,1,?,?)').run(JSON.stringify({days: [{ideaId: 'reel-7', date: '2026-11-12', platform: 'instagram', topic: 'Рилс недели', script, variants: {instagram: {}, vk: {}}}]}), 'x');
  crmDb.prepare('INSERT INTO media_mentor_plans VALUES(2,1,1,?,?)').run(JSON.stringify({days: [{ideaId: 'alvi-1', topic: 'Чужая', script: 'x'}]}), 'x');
  const materials = createReelMaterials(crmDb, {autoposting: {list: () => ({posts: []})}, information: {get: () => ({revision: 1})}});
  const crmHandle = createReelMaterialsHandler({materials, companyModuleContext: () => { throw Object.assign(Error('нет'), {status: 403}); }, readJson, send: sendJson,
    trustedService: (request) => request.headers['x-api-key'] === 'crm-key' && !request.headers['x-synapse-crm-identity']});
  const crm = await listen((request, response, url) => crmHandle(request, response, url));
  // Базовая версия ролика в хранилище публикаций компании (как загрузил бы монтажёр).
  const baseName = 'a'.repeat(32) + '.mp4';
  fs.mkdirSync(path.join(assetsDir, 'publishing', 'avokado'), {recursive: true});
  colorClip(path.join(assetsDir, 'publishing', 'avokado', baseName));
  const reel = materials.create('avokado', {title: 'Рилс №1', mediaUrl: `${ORIGIN}/content/publishing-assets/avokado/${baseName}`, durationMs: 4000}, {userId: 5, userName: 'СММ'});
  // Дубли «Съёмки»: сцена 1 — два дубля (берётся последний), сцена 2 — вставка без реплики, сцены 3 нет; плюс чужая компания.
  const takesDir = path.join(dir, 'takes');
  fs.mkdirSync(takesDir);
  const takeRows = [
    {id: 1, code: 'avokado', idea: 'reel-7', frame: 1, file: colorClip(path.join(takesDir, '1.mp4'), ['green', 'green', 'green'], {audio: 'speech'})},
    {id: 2, code: 'avokado', idea: 'reel-7', frame: 1, file: colorClip(path.join(takesDir, '2.mp4'), ['red', 'red', 'red'], {audio: 'speech'})},
    {id: 3, code: 'avokado', idea: 'reel-7', frame: 2, file: colorClip(path.join(takesDir, '3.mp4'), ['blue'], {audio: 'none'})},
    {id: 4, code: 'alvi', idea: 'alvi-1', frame: 1, file: colorClip(path.join(takesDir, '4.mp4'), ['white'])},
  ];
  const shooting = {
    actor: (request, code, edit) => { if (request.headers['x-test-user'] !== 'smm') throw Object.assign(Error('Требуется вход'), {status: 401}); return {name: 'СММ', canEdit: edit}; },
    takes: (code, idea) => takeRows.filter((item) => item.code === code && item.idea === idea).map((item) => ({id: item.id, frame: item.frame, mime: 'video/mp4', size: fs.statSync(item.file).size, sha256: ''})),
    openTake: (code, id) => { const item = takeRows.find((row) => row.code === code && row.id === Number(id)); if (!item) throw Object.assign(Error('Дубль не найден'), {status: 404});
      return {mime: 'video/mp4', size: fs.statSync(item.file).size, stream: () => fs.createReadStream(item.file)}; },
  };
  const contentDb = new DatabaseSync(':memory:');
  const gateway = createMontageGateway({db: contentDb, shooting, crmUrl: crm.url, crmKey: 'crm-key', assetsDir, publishingOrigin: ORIGIN, maxVideoBytes: 60 * 1024 * 1024,
    readJson, readRaw, sendJson, config: {enabled: true, keySha256: crypto.createHash('sha256').update(KEY).digest('hex'), companies: ['avokado']}});
  const content = await listen((request, response, url) => gateway.handle(request, response, url));
  const workDir = path.join(dir, 'work');
  fs.mkdirSync(workDir);
  const config = {...readConfig({CONTENT_URL: content.url, MONTAGE_WORKER_ENABLED: '1', MONTAGE_WORKER_KEY: KEY, MONTAGE_WORK_DIR: workDir, MONTAGE_MIN_FREE_MB: '64',
    MONTAGE_WIDTH: '160', MONTAGE_HEIGHT: '284', MONTAGE_FPS: '25', MONTAGE_THREADS: '1'}), font: FONT};
  const logs = [];
  const worker = createWorker(config, {log: (...args) => logs.push(args.join(' '))});
  t.after(() => { crm.server.close(); content.server.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const local = (url) => path.join(assetsDir, 'publishing', 'avokado', new URL(url).pathname.split('/').pop());
  return {dir, materials, reel, content, worker, workDir, logs, local, contentDb};
}

test('Правка kind:edl из окна «Редактировать» → ffmpeg → v2 в «Материалах», правка закрыта', {skip}, async (t) => {
  const s = await stand(t);
  const {edit} = s.materials.requestEdit('avokado', s.reel.id, {clientRequestId: 'e1', baseVersion: 1, kind: 'edl',
    edl: {v: 1, video: [{inMs: 3000, outMs: 4000}, {inMs: 1000, outMs: 2000}], audio: [{inMs: 0, outMs: 2000, gain: 1, muted: true}], captions: [{startMs: 0, endMs: 900, text: 'Титр правки'}], coverMs: 1200, speed: 1}}, {userId: 5, userName: 'СММ'});
  s.materials.requestEdit('avokado', s.reel.id, {clientRequestId: 'e2', baseVersion: 1, kind: 'request', comment: 'Хью, сделай динамичнее', startMs: 0, endMs: 1000}, {userId: 5, userName: 'СММ'});
  const done = await s.worker.runOnce();
  assert.deepEqual(done.map((item) => [item.edit ?? item.job, item.ok]), [[edit.id, true]], 'kind:request в первом срезе не берётся воркером');
  const reel = s.materials.get('avokado', s.reel.id);
  assert.equal(reel.versions.length, 2);
  const v2 = reel.versions[1];
  assert.equal(v2.editId, edit.id);
  assert.match(v2.note, /Автомонтаж по правке №\d+ \(EDL\); обложка: https:\/\/synapse\.synapsebusiness\.ru\/content\/publishing-assets\/avokado\/[a-f0-9]{32}\.jpg/);
  assert.equal(reel.edits.find((item) => item.id === edit.id).status, 'done');
  assert.equal(reel.edits.find((item) => item.kind === 'request').status, 'pending');
  const file = s.local(v2.mediaUrl);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), v2.sha256);
  assert.equal(dominant(colorAt(file, 0.3)), 'white');
  assert.equal(dominant(colorAt(file, 1.3)), 'green');
  assert.ok(maxVolume(file) < -60);
  assert.deepEqual(fs.readdirSync(s.workDir), [], 'рабочая папка задания удалена');
  assert.deepEqual(await s.worker.runOnce(), [], 'повторный проход ничего не делает');
});

test('Черновик из дублей по сценарию: последний дубль на сцену, обрезка тишины, титры, версия идеи → «Монтаж на согласовании»', {skip}, async (t) => {
  const s = await stand(t);
  const post = (body, user = 'smm') => fetch(`${s.content.url}/content/montage/drafts?companyCode=avokado`, {method: 'POST', headers: {'content-type': 'application/json', 'x-test-user': user}, body: JSON.stringify(body)});
  assert.equal((await post({ideaId: 'reel-7'}, 'nobody')).status, 401);
  assert.equal((await post({ideaId: 'нет дублей'})).status, 400);
  assert.equal((await post({ideaId: 'empty-idea'})).status, 409, 'без дублей задание не ставится');
  const created = await post({ideaId: 'reel-7'});
  assert.equal(created.status, 201);
  assert.equal((await (await post({ideaId: 'reel-7'})).json()).duplicate, true, 'повтор не ставит второе задание');
  const done = await s.worker.runOnce();
  assert.equal(done.length, 1, JSON.stringify(done)); assert.equal(done[0].ok, true, done[0].error);
  const reelId = done[0].result.reel.id;
  const reel = s.materials.get('avokado', reelId);
  assert.equal(reel.ideaId, 'reel-7'); assert.equal(reel.title, 'Рилс недели');
  assert.deepEqual(reel.platforms, ['instagram', 'vk']);
  assert.equal(reel.versions.length, 1);
  assert.match(reel.versions[0].note, /сцен 2 из 3; нет дубля: сцены 3; обрезана тишина: сцены 1; титры: 1/);
  const file = s.local(reel.versions[0].mediaUrl);
  const out = await engine.probe(file);
  // Сцена 1: дубль №2 (красный), тишина 0–1 с и 2–3 с обрезана → ~1,4 с; сцена 2: вставка 1 с без обрезки.
  assert.ok(out.durationMs > 1900 && out.durationMs < 2900, `длительность ${out.durationMs}`);
  assert.equal(dominant(colorAt(file, 0.4)), 'red', 'взят последний дубль сцены');
  assert.equal(dominant(colorAt(file, out.durationMs / 1000 - 0.3)), 'blue', 'вставка второй сцены');
  const status = await (await fetch(`${s.content.url}/content/montage/drafts?companyCode=avokado&ideaId=reel-7`, {headers: {'x-test-user': 'smm'}})).json();
  assert.equal(status.jobs[0].status, 'done'); assert.equal(status.jobs[0].reelId, reelId);
  // Повторная сборка — новая версия того же ролика идеи (vK+1), а не вторая карточка.
  await post({ideaId: 'reel-7'});
  const again = await s.worker.runOnce();
  assert.equal(again[0].result.reel.id, reelId); assert.equal(again[0].result.version.version, 2);
});

test('Изоляция шлюза: без ключа 401, чужая компания 403, чужой файл не отдаётся', {skip}, async (t) => {
  const s = await stand(t);
  const get = (route, key = KEY) => fetch(`${s.content.url}/content/internal/montage${route}`, {headers: {'x-api-key': key}});
  assert.equal((await get('/queue', 'wrong')).status, 401);
  assert.equal((await get('/queue', '')).status, 401);
  assert.equal((await get('/takes/4?companyCode=alvi')).status, 403);
  assert.equal((await get('/takes/4?companyCode=avokado')).status, 404, 'дубль другой компании не находится по своей');
  assert.equal((await get('/ideas/alvi-1?companyCode=alvi')).status, 403);
  assert.equal((await get('/ideas/alvi-1?companyCode=avokado')).status, 404, 'идея другой компании не читается');
  assert.equal((await get('/assets/alvi/' + 'a'.repeat(32) + '.mp4')).status, 403);
  assert.equal((await get('/assets/avokado/../alvi/x.mp4')).status, 404);
  const upload = await fetch(`${s.content.url}/content/internal/montage/assets?companyCode=avokado`, {method: 'POST', headers: {'x-api-key': KEY, 'content-type': 'video/mp4'}, body: 'not a video'});
  assert.equal(upload.status, 415);
});

test('Сбой рендера: правка помечается, после двух попыток не берётся снова', {skip}, async (t) => {
  const s = await stand(t);
  // Ролик-«заглушка»: в хранилище лежит не видео — ffprobe падает.
  const fake = 'b'.repeat(32) + '.mp4';
  fs.writeFileSync(s.local(`${ORIGIN}/x/${fake}`), Buffer.from('00000000ftypisomgarbage'));
  const bad = s.materials.create('avokado', {title: 'Битый', mediaUrl: `${ORIGIN}/content/publishing-assets/avokado/${fake}`, durationMs: 4000}, {userId: 5});
  s.materials.requestEdit('avokado', bad.id, {clientRequestId: 'b1', baseVersion: 1, kind: 'edl', edl: {v: 1, video: [{inMs: 0, outMs: 1000}]}}, {userId: 5, userName: 'СММ'});
  assert.equal((await s.worker.runOnce())[0].ok, false);
  assert.equal((await s.worker.runOnce())[0].ok, false);
  assert.deepEqual(await s.worker.runOnce(), [], 'после двух неудач правка ждёт человека');
  assert.equal(s.contentDb.prepare("SELECT status FROM montage_jobs WHERE kind='edl'").get().status, 'failed');
  assert.deepEqual(fs.readdirSync(s.workDir), []);
});
