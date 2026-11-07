'use strict';
/* Шлюз автомонтажа Хью (specs/214-auto-montage).
   1) Кабинет: POST/GET /content/montage/drafts — поставить сборку черновика из дублей идеи в очередь и узнать статус
      (права «Съёмки»: autoposting.edit + CSRF на запись, autoposting.view на чтение).
   2) Воркер: /content/internal/montage/* — только по ключу воркера (сравнивается SHA-256 из MONTAGE_WORKER_KEY_SHA256)
      и только для компаний из MONTAGE_WORKER_COMPANIES. Воркер не получает ключ CRM: очередь правок, взятие правки
      и запись версии проксируются сюда же. Чужая компания → 403, выключенный флаг → 503.
   Ничего не публикует и не отправляет: новая версия попадает в «Материалы» → «Монтаж на согласовании». */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {COMPANIES} = require('./auth-store');

const AGENT_HEADER = 'hugh-automontage';
const MAX_ATTEMPTS = 2;
const IDEA = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const ASSET = /^([a-z0-9_-]{1,64})\/([a-f0-9]{32}\.(?:mp4|webm|jpg))$/;
const UPLOAD_TYPES = Object.freeze({'video/mp4': '.mp4', 'image/jpeg': '.jpg'});
const fail = (status, message, code) => { throw Object.assign(new Error(message), {status}, code ? {details: {code}} : {}); };

function readMontageConfig(env = process.env) {
  const hash = String(env.MONTAGE_WORKER_KEY_SHA256 || '').trim().toLowerCase();
  const companies = String(env.MONTAGE_WORKER_COMPANIES || '').split(',').map((item) => item.trim()).filter((code) => Object.hasOwn(COMPANIES, code));
  return {enabled: env.MONTAGE_ENABLED === '1' && /^[a-f0-9]{64}$/.test(hash) && companies.length > 0, keySha256: /^[a-f0-9]{64}$/.test(hash) ? hash : '', companies};
}

function createMontageGateway({db, shooting, crmUrl, crmKey, assetsDir, publishingOrigin, maxVideoBytes, readJson, readRaw, sendJson,
  config = readMontageConfig(), fetchImpl = fetch, now = () => new Date()}) {
  db.exec(`CREATE TABLE IF NOT EXISTS montage_jobs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('draft','edl')),
      idea_id TEXT, edit_id INTEGER, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
      reel_id INTEGER, version INTEGER, note TEXT NOT NULL DEFAULT '', requested_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS montage_jobs_open ON montage_jobs(status, company_code);
    CREATE UNIQUE INDEX IF NOT EXISTS montage_jobs_edit ON montage_jobs(company_code, edit_id) WHERE kind='edl';`);
  const iso = () => now().toISOString();
  const allowed = new Set(config.companies);
  const view = (job) => ({id: job.id, kind: job.kind, companyCode: job.company_code, ideaId: job.idea_id, editId: job.edit_id, status: job.status,
    attempts: job.attempts, error: job.error, reelId: job.reel_id, version: job.version, note: job.note, requestedBy: job.requested_by, createdAt: job.created_at, updatedAt: job.updated_at});

  function workerAuth(request) {
    const supplied = String(request.headers['x-api-key'] || '');
    const digest = crypto.createHash('sha256').update(supplied).digest();
    if (!config.keySha256 || !supplied || !crypto.timingSafeEqual(digest, Buffer.from(config.keySha256, 'hex'))) fail(401, 'Нет доступа');
    if (!config.enabled) fail(503, 'Автомонтаж выключен', 'MONTAGE_OFF');
  }
  const scoped = (code) => { if (!allowed.has(code)) fail(403, 'Компания не обслуживается автомонтажом', 'FORBIDDEN'); return code; };

  async function crm(method, route, body) {
    if (!crmKey) fail(503, 'CRM не настроен');
    let upstream;
    try {
      upstream = await fetchImpl(crmUrl + route, {method, redirect: 'error', headers: {'x-api-key': crmKey, 'x-agent-name': AGENT_HEADER,
        ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    } catch { fail(502, 'CRM недоступен'); }
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) fail(upstream.status, data?.error || 'Ошибка CRM', data?.details?.code);
    return data;
  }

  function edlState(code, editId) { return db.prepare("SELECT * FROM montage_jobs WHERE kind='edl' AND company_code=? AND edit_id=?").get(code, editId); }
  function recordEdlFailure(code, editId, error) {
    const at = iso();
    db.prepare(`INSERT INTO montage_jobs(company_code,kind,edit_id,status,attempts,error,created_at,updated_at) VALUES(?, 'edl', ?, ?, 1, ?, ?, ?)
      ON CONFLICT(company_code, edit_id) WHERE kind='edl' DO UPDATE SET attempts=attempts+1, error=excluded.error, updated_at=excluded.updated_at,
      status=CASE WHEN attempts+1>=${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END`)
      .run(code, editId, MAX_ATTEMPTS <= 1 ? 'failed' : 'pending', String(error || '').slice(0, 500), at, at);
    return view(edlState(code, editId));
  }
  const job = (code, id) => {
    const found = /^\d{1,15}$/.test(id) && db.prepare("SELECT * FROM montage_jobs WHERE id=? AND company_code=? AND kind='draft'").get(Number(id), code);
    if (!found) fail(404, 'Задание не найдено');
    return found;
  };

  function storeAsset(code, type, bytes) {
    const valid = type === 'video/mp4' ? bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' : bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!valid) fail(415, 'Файл не соответствует формату');
    const name = crypto.randomBytes(16).toString('hex') + UPLOAD_TYPES[type];
    const directory = path.join(assetsDir, 'publishing', code);
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, name), bytes, {flag: 'wx'});
    return {url: `${publishingOrigin}/content/publishing-assets/${code}/${name}`, size: bytes.length, type, sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
  }
  async function stream(response, mime, size, open) {
    response.writeHead(200, {'content-type': mime, 'content-length': size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
    try { await pipeline(open(), response); } catch { response.destroy(); }
    return true;
  }

  async function internal(request, response, url, reply) {
    workerAuth(request);
    const route = url.pathname.slice('/content/internal/montage'.length);
    const code = url.searchParams.get('companyCode') || '';
    const method = request.method;
    let match;
    if (route === '/queue' && method === 'GET') {
      const {edits = []} = await crm('GET', '/internal/reel-materials/queue');
      return reply(200, {edits: edits.filter((edit) => allowed.has(edit.companyCode) && edit.kind === 'edl' && edlState(edit.companyCode, edit.id)?.status !== 'failed')});
    }
    if (route === '/jobs' && method === 'GET') {
      const list = db.prepare(`SELECT * FROM montage_jobs WHERE kind='draft' AND status='pending' ORDER BY id LIMIT 20`).all().filter((item) => allowed.has(item.company_code));
      return reply(200, {jobs: list.map(view)});
    }
    if ((match = /^\/edits\/(\d{1,15})\/(claim|fail)$/.exec(route)) && method === 'POST') {
      scoped(code);
      if (match[2] === 'fail') return reply(200, {job: recordEdlFailure(code, Number(match[1]), (await readJson(request)).error)});
      return reply(200, await crm('POST', `/internal/reel-materials/edits/${match[1]}/claim?companyCode=${encodeURIComponent(code)}`));
    }
    if ((match = /^\/reels\/(\d{1,15})\/versions$/.exec(route)) && method === 'POST') {
      scoped(code);
      const body = await readJson(request);
      const result = await crm('POST', `/internal/reel-materials/reels/${match[1]}/versions?companyCode=${encodeURIComponent(code)}`, body);
      if (Number.isSafeInteger(body.editId)) db.prepare("UPDATE montage_jobs SET status='done', reel_id=?, version=?, updated_at=? WHERE kind='edl' AND company_code=? AND edit_id=?")
        .run(Number(match[1]), result.version?.version ?? null, iso(), code, body.editId);
      return reply(200, result);
    }
    if ((match = /^\/jobs\/(\d{1,15})\/(claim|done|fail)$/.exec(route)) && method === 'POST') {
      const item = job(scoped(code), match[1]), at = iso();
      if (match[2] === 'claim') {
        if (item.status !== 'pending') fail(409, 'Задание уже взято или закрыто');
        db.prepare("UPDATE montage_jobs SET status='in_progress', attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'").run(at, item.id);
      } else {
        if (item.status !== 'in_progress') fail(409, 'Задание не в работе');
        const body = await readJson(request);
        if (match[2] === 'done') db.prepare("UPDATE montage_jobs SET status='done', reel_id=?, version=?, note=?, error='', updated_at=? WHERE id=?")
          .run(Number.isSafeInteger(body.reelId) ? body.reelId : null, Number.isSafeInteger(body.version) ? body.version : null, String(body.note || '').slice(0, 1000), at, item.id);
        else db.prepare('UPDATE montage_jobs SET status=?, error=?, updated_at=? WHERE id=?')
          .run(item.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', String(body.error || '').slice(0, 500), at, item.id);
      }
      return reply(200, {job: view(job(code, match[1]))});
    }
    if ((match = /^\/ideas\/([^/]+)(\/versions)?$/.exec(route))) {
      scoped(code);
      const idea = decodeURIComponent(match[1]);
      if (!IDEA.test(idea)) fail(400, 'Некорректный рилс');
      const target = `/internal/reel-materials/ideas/${idea}${match[2] || ''}?companyCode=${encodeURIComponent(code)}`;
      if (!match[2] && method === 'GET') return reply(200, {...(await crm('GET', target)), takes: shooting.takes(code, idea)});
      if (match[2] && method === 'POST') return reply(200, await crm('POST', target, await readJson(request)));
    }
    if ((match = /^\/takes\/(\d{1,15})$/.exec(route)) && method === 'GET') {
      const take = shooting.openTake(scoped(code), match[1]);
      return stream(response, take.mime, take.size, take.stream);
    }
    if ((match = /^\/assets\/(.+)$/.exec(route)) && method === 'GET') {
      const asset = ASSET.exec(match[1]);
      if (!asset) fail(404, 'Материал не найден');
      const file = path.join(assetsDir, 'publishing', scoped(asset[1]), asset[2]);
      if (!fs.existsSync(file)) fail(404, 'Материал не найден');
      return stream(response, asset[2].endsWith('.jpg') ? 'image/jpeg' : asset[2].endsWith('.webm') ? 'video/webm' : 'video/mp4', fs.statSync(file).size, () => fs.createReadStream(file));
    }
    if (route === '/assets' && method === 'POST') {
      scoped(code);
      const type = String(request.headers['content-type'] || '').split(';')[0].trim();
      if (!Object.hasOwn(UPLOAD_TYPES, type)) fail(415, 'Допустимы MP4 и JPEG');
      return reply(201, storeAsset(code, type, await readRaw(request, maxVideoBytes)));
    }
    fail(404, 'Адрес не найден');
  }

  async function cabinet(request, response, url, reply) {
    const code = url.searchParams.get('companyCode') || '';
    const write = request.method === 'POST';
    if (!['GET', 'POST'].includes(request.method)) fail(405, 'Метод не поддерживается');
    const actor = shooting.actor(request, code, write);
    const state = {enabled: config.enabled && allowed.has(code)};
    if (!write) {
      const idea = url.searchParams.get('ideaId') || '';
      if (!IDEA.test(idea)) fail(400, 'Некорректный рилс');
      const jobs = db.prepare("SELECT * FROM montage_jobs WHERE kind='draft' AND company_code=? AND idea_id=? ORDER BY id DESC LIMIT 5").all(code, idea).map(view);
      return reply(200, {...state, jobs});
    }
    const body = await readJson(request);
    const idea = String(body.ideaId || '');
    if (!IDEA.test(idea)) fail(400, 'Некорректный рилс');
    if (!state.enabled) fail(503, 'Автомонтаж для этой компании не подключён', 'MONTAGE_OFF');
    if (!shooting.takes(code, idea).some((take) => Number.isSafeInteger(take.frame))) fail(409, 'Нет дублей с номером сцены: собирать не из чего', 'NO_TAKES');
    const open = db.prepare("SELECT * FROM montage_jobs WHERE kind='draft' AND company_code=? AND idea_id=? AND status IN ('pending','in_progress') ORDER BY id DESC LIMIT 1").get(code, idea);
    if (open) return reply(200, {...state, job: view(open), duplicate: true});
    const at = iso();
    const id = Number(db.prepare(`INSERT INTO montage_jobs(company_code,kind,idea_id,status,requested_by,created_at,updated_at) VALUES(?, 'draft', ?, 'pending', ?, ?, ?)`)
      .run(code, idea, String(actor.name || ''), at, at).lastInsertRowid);
    return reply(201, {...state, job: view(db.prepare('SELECT * FROM montage_jobs WHERE id=?').get(id)), duplicate: false});
  }

  async function handle(request, response, url) {
    const reply = (status, body) => { sendJson(response, status, body, {'cache-control': 'no-store'}); return true; };
    if (url.pathname.startsWith('/content/internal/montage/')) return internal(request, response, url, reply);
    if (url.pathname === '/content/montage/drafts') return cabinet(request, response, url, reply);
    return false;
  }
  return {handle, config};
}

module.exports = {createMontageGateway, readMontageConfig, MAX_ATTEMPTS};
