'use strict';
/* Контент → Съёмка (№98 · В). Загрузка дублей частями с продолжением, раскадровка,
   статус рилса и API монтажёра. План рилсов здесь не хранится и не меняется: он в CRM
   (media_mentor_plans), экран читает его через существующий прокси. Публикаций, сообщений,
   изменения прав и ключей модуль не выполняет. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {COMPANIES} = require('./auth-store');
const {createLocalStorage} = require('./shooting-storage');
const {createSketches} = require('./shooting-sketch');

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const MAX_FILE = 2 * GiB, CHUNK = 8 * MiB, MAX_CHUNK = 16 * MiB;
const TYPES = Object.freeze({'video/quicktime': '.mov', 'video/mp4': '.mp4', 'image/jpeg': '.jpg', 'image/png': '.png'});
const BY_EXT = Object.freeze({'.mov': 'video/quicktime', '.qt': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png'});
const STATUSES = ['approved', 'shot', 'editing', 'draft'];
const BOARD_FIELDS = ['shot', 'angle', 'transition', 'notes'];
const DEFAULTS = Object.freeze({companyQuotaBytes: 40 * GiB, minFreeBytes: 5 * GiB, minFreePercent: 15, sketchDailyLimit: 20});

const fail = (status, message, extra) => { throw Object.assign(new Error(message), {status}, extra ? {details: extra} : {}); };
const text = (value, max) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);
const gb = (bytes) => (Math.max(0, bytes) / GiB).toFixed(1).replace('.', ',') + ' ГБ';
const company = (code) => { if (!Object.hasOwn(COMPANIES, code || '')) fail(404, 'Компания не найдена'); return code; };
const ideaId = (value) => { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(String(value ?? ''))) fail(400, 'Некорректный рилс'); return String(value); };
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function readShootingConfig(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const editors = (Array.isArray(raw.editors) ? raw.editors : []).filter((item) => item && /^[a-f0-9]{64}$/.test(item.keySha256)
      && Array.isArray(item.companies)).map((item) => ({name: text(item.name || 'Монтажёр', 80), keySha256: item.keySha256,
      companies: item.companies.filter((code) => Object.hasOwn(COMPANIES, code))}));
    const number = (key) => Number.isSafeInteger(raw[key]) && raw[key] >= 0 ? raw[key] : DEFAULTS[key];
    return {editors, companyQuotaBytes: number('companyQuotaBytes'), minFreeBytes: number('minFreeBytes'),
      minFreePercent: Math.min(90, number('minFreePercent')), sketchDailyLimit: number('sketchDailyLimit')};
  } catch {
    // Нет файла или он повреждён: API монтажёра выключен, лимиты по умолчанию.
    return {...DEFAULTS, editors: []};
  }
}

function signatureOk(mime, head) {
  if (mime === 'video/quicktime' || mime === 'video/mp4') {
    const box = head.toString('ascii', 4, 8);
    return head.length >= 8 && ['ftyp', 'moov', 'wide', 'mdat', 'free', 'skip'].includes(box);
  }
  if (mime === 'image/jpeg') return head.length > 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mime === 'image/png') return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return false;
}

function createShooting({db, authStore, assetsDir, requireSession, requireCsrf, readJson, sendJson,
  config = {...DEFAULTS, editors: []}, storage = createLocalStorage(path.join(assetsDir, 'shooting')), now = () => new Date(), providers = null, fetchImpl}) {
  db.exec(`CREATE TABLE IF NOT EXISTS shooting_uploads(
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, idea_id TEXT NOT NULL, frame INTEGER,
      kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, disk_key TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, sha256 TEXT, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, completed_at TEXT);
    CREATE INDEX IF NOT EXISTS shooting_uploads_idea ON shooting_uploads(company_code, idea_id, id);
    CREATE TABLE IF NOT EXISTS shooting_reels(
      company_code TEXT NOT NULL, idea_id TEXT NOT NULL, status TEXT, board TEXT NOT NULL DEFAULT '[]',
      board_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT, updated_by TEXT, PRIMARY KEY(company_code, idea_id));`);
  const busy = new Set();
  const sketches = createSketches({db, storage, providers, fetchImpl, dailyLimit: config.sketchDailyLimit ?? DEFAULTS.sketchDailyLimit, now});
  const iso = () => now().toISOString();

  function cabinet(request, code, edit) {
    company(code);
    const session = requireSession(request), user = authStore.getById(session.user.id);
    if (!user || user.sessionVersion !== session.user.sessionVersion) fail(401, 'Требуется вход в кабинет');
    const allowed = (permission) => user.role === 'owner' || (user.companyCodes.includes(code) && user.permissions.includes(permission));
    if (!allowed('autoposting.view')) fail(403, 'Нет доступа к съёмке этой компании');
    if (edit) {
      if (!allowed('autoposting.edit')) fail(403, 'Нет права загружать материалы и менять съёмку');
      requireCsrf(request, session);
    }
    return {kind: 'user', name: text(user.displayName || user.login, 80), canEdit: allowed('autoposting.edit')};
  }
  function editor(request, code) {
    const match = /^Bearer\s+([A-Za-z0-9._~-]{24,200})$/.exec(String(request.headers.authorization || ''));
    if (!match) fail(401, 'Нужен ключ монтажёра');
    const digest = Buffer.from(sha(match[1]), 'hex');
    const found = config.editors.find((item) => crypto.timingSafeEqual(Buffer.from(item.keySha256, 'hex'), digest));
    if (!found) fail(401, 'Ключ монтажёра не распознан');
    company(code);
    if (!found.companies.includes(code)) fail(403, 'Ключ монтажёра не относится к этой компании');
    return {kind: 'editor', name: found.name, canEdit: false};
  }

  const row = (code, id) => {
    const found = /^\d{1,15}$/.test(id) && db.prepare('SELECT * FROM shooting_uploads WHERE id=? AND company_code=?').get(Number(id), code);
    if (!found) fail(404, 'Материал не найден');
    return found;
  };
  const view = (item, prefix = '/content/shooting') => ({id: item.id, ideaId: item.idea_id, frame: item.frame, kind: item.kind,
    name: item.name, mime: item.mime, size: item.size, status: item.status, createdBy: item.created_by,
    createdAt: item.created_at, completedAt: item.completed_at, sha256: item.sha256, chunkBytes: CHUNK,
    offset: item.status === 'uploading' ? storage.size(item.company_code, item.disk_key) : item.status === 'stored' ? item.size : 0,
    fileUrl: item.status === 'stored' ? `${prefix}/files/${item.id}?companyCode=${encodeURIComponent(item.company_code)}` : null});

  /* Место проверяется ДО приёма байтов: квота компании и резерв диска с учётом ещё не
     докачанных сессий всех компаний. Сервер заполнен примерно на 81 %, поэтому резерв строгий. */
  function storageInfo(code, extra = 0) {
    const used = db.prepare("SELECT COALESCE(SUM(size),0) n FROM shooting_uploads WHERE company_code=? AND status IN ('stored','uploading')").get(code).n;
    const pending = db.prepare("SELECT company_code, disk_key, size FROM shooting_uploads WHERE status='uploading'").all()
      .reduce((sum, item) => sum + Math.max(0, item.size - storage.size(item.company_code, item.disk_key)), 0);
    const disk = storage.disk();
    const reserve = Math.max(config.minFreeBytes, Math.ceil(disk.total * config.minFreePercent / 100));
    const freeAfter = disk.free - pending - extra;
    let reason = '';
    if (used + extra > config.companyQuotaBytes) reason = `Место для съёмки компании закончилось: занято ${gb(used)} из ${gb(config.companyQuotaBytes)}. Удалите лишние дубли или попросите администратора увеличить квоту. Загрузка не начата.`;
    else if (freeAfter < reserve) reason = `На сервере мало свободного места: свободно ${gb(disk.free - pending)}, а после загрузки должно остаться не меньше ${gb(reserve)}. Загрузка не начата — сообщите администратору Synapse.`;
    return {usedBytes: used, quotaBytes: config.companyQuotaBytes, freeBytes: Math.max(0, disk.free - pending), reserveBytes: reserve,
      maxFileBytes: MAX_FILE, chunkBytes: CHUNK, canUpload: !reason, reason, adapter: storage.kind};
  }

  function createUpload(code, body, actor, kinds) {
    const idea = ideaId(body.ideaId);
    const frame = body.frame === null || body.frame === undefined || body.frame === '' ? null : Number(body.frame);
    if (frame !== null && (!Number.isSafeInteger(frame) || frame < 1 || frame > 500)) fail(400, 'Номер кадра 1–500 или «Другое»');
    const kind = body.kind || kinds[0];
    if (!kinds.includes(kind)) fail(403, 'Этот вид материала здесь загрузить нельзя');
    const name = text(body.name, 180).replace(/[\\/]/g, '_') || 'material';
    const declared = text(body.mime, 80).toLowerCase();
    const mime = Object.hasOwn(TYPES, declared) ? declared : BY_EXT[path.extname(name).toLowerCase()];
    if (!mime) fail(415, 'Поддерживаются MOV, MP4, JPEG и PNG');
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 1) fail(400, 'Неизвестный размер файла');
    if (size > MAX_FILE) fail(413, `Файл больше ${gb(MAX_FILE)}; разделите запись`);
    const fingerprint = text(body.fingerprint, 200);
    if (fingerprint) {
      const open = db.prepare(`SELECT * FROM shooting_uploads WHERE company_code=? AND idea_id=? AND fingerprint=? AND size=? AND kind=?
        AND status='uploading' ORDER BY id DESC LIMIT 1`).get(code, idea, fingerprint, size, kind);
      if (open) return {status: 200, upload: view(open)};
    }
    const space = storageInfo(code, size);
    if (!space.canUpload) fail(507, space.reason, {code: 'STORAGE_FULL', storage: space});
    const result = db.prepare(`INSERT INTO shooting_uploads(company_code,idea_id,frame,kind,name,mime,size,disk_key,fingerprint,status,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'uploading',?,?)`).run(code, idea, frame, kind, name, mime, size, crypto.randomBytes(16).toString('hex'),
      fingerprint, actor.name, iso());
    return {status: 201, upload: view(db.prepare('SELECT * FROM shooting_uploads WHERE id=?').get(result.lastInsertRowid))};
  }

  async function appendChunk(request, code, id) {
    const item = row(code, id);
    if (item.status !== 'uploading') fail(409, 'Загрузка уже завершена', {upload: view(item)});
    if (!/^application\/offset\+octet-stream\b/i.test(String(request.headers['content-type'] || ''))) fail(415, 'Ожидался кусок файла');
    const offset = Number(request.headers['upload-offset']);
    const current = storage.size(code, item.disk_key);
    if (!Number.isSafeInteger(offset) || offset !== current) fail(409, 'Смещение не совпало; продолжите с принятого байта', {upload: view(item)});
    const length = Number(request.headers['content-length']);
    const limit = Math.min(MAX_CHUNK, item.size - offset);
    if (Number.isFinite(length) && length > limit) fail(413, 'Кусок больше допустимого');
    if (busy.has(item.id)) fail(409, 'Этот файл уже принимается в другом окне', {upload: view(item)});
    busy.add(item.id);
    try {
      await storage.append(code, item.disk_key, offset, request, limit);
      if (storage.size(code, item.disk_key) === item.size) {
        const head = await storage.head(code, item.disk_key);
        if (!signatureOk(item.mime, head)) {
          storage.remove(code, item.disk_key);
          db.prepare("UPDATE shooting_uploads SET status='rejected', completed_at=? WHERE id=?").run(iso(), item.id);
          fail(422, 'Содержимое не похоже на заявленный видео- или фотоформат; файл не сохранён');
        }
        const digest = await storage.sha256(code, item.disk_key);
        db.prepare("UPDATE shooting_uploads SET status='stored', sha256=?, completed_at=? WHERE id=?").run(digest, iso(), item.id);
      }
    } finally { busy.delete(item.id); }
    return view(row(code, id));
  }

  async function sendFile(request, response, item) {
    if (item.status !== 'stored') fail(404, 'Файл ещё не загружен');
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''));
    let start = 0, end = item.size - 1, status = 200;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, item.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), item.size - 1) : item.size - 1;
      if (start > end || start >= item.size) {
        response.writeHead(416, {'content-range': `bytes */${item.size}`}); response.end(); return true;
      }
      status = 206;
    }
    response.writeHead(status, {'content-type': item.mime, 'content-length': end - start + 1, 'accept-ranges': 'bytes',
      ...(status === 206 ? {'content-range': `bytes ${start}-${end}/${item.size}`} : {}),
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': `inline; filename="shooting-${item.id}${TYPES[item.mime]}"; filename*=UTF-8''${encodeURIComponent(item.name)}`});
    if (request.method === 'HEAD') { response.end(); return true; }
    try { await pipeline(storage.read(item.company_code, item.disk_key, {start, end}), response); } catch { response.destroy(); }
    return true;
  }

  const reelState = (code, idea) => db.prepare('SELECT * FROM shooting_reels WHERE company_code=? AND idea_id=?').get(code, idea);
  function summary(code, idea) {
    const counts = db.prepare(`SELECT kind, COUNT(*) n FROM shooting_uploads WHERE company_code=? AND idea_id=? AND status='stored' GROUP BY kind`).all(code, idea);
    const takes = counts.find((item) => item.kind === 'take')?.n || 0, drafts = counts.find((item) => item.kind === 'draft')?.n || 0;
    const state = reelState(code, idea);
    const status = state?.status || (drafts ? 'draft' : takes ? 'shot' : 'approved');
    return {status, manualStatus: state?.status || null, takes, drafts, boardRevision: state?.board_revision || 0};
  }
  function setStatus(code, idea, value, actor) {
    if (!STATUSES.includes(value)) fail(400, 'Статус: approved, shot, editing или draft');
    db.prepare(`INSERT INTO shooting_reels(company_code,idea_id,status,updated_at,updated_by) VALUES(?,?,?,?,?)
      ON CONFLICT(company_code,idea_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(code, idea, value, iso(), actor.name);
    return summary(code, idea);
  }
  function saveBoard(code, idea, body, actor) {
    if (!Number.isSafeInteger(body.revision) || !Array.isArray(body.frames) || body.frames.length > 200) fail(400, 'Раскадровка: revision и frames');
    const frames = body.frames.map((frame) => {
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) fail(400, 'Некорректный кадр раскадровки');
      return Object.fromEntries(BOARD_FIELDS.map((key) => [key, text(frame[key], 1000)]));
    });
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = reelState(code, idea)?.board_revision || 0;
      if (body.revision !== current) fail(409, 'Раскадровку уже изменили. Обновите карточку.', {code: 'REVISION_CONFLICT'});
      db.prepare(`INSERT INTO shooting_reels(company_code,idea_id,board,board_revision,updated_at,updated_by) VALUES(?,?,?,?,?,?)
        ON CONFLICT(company_code,idea_id) DO UPDATE SET board=excluded.board,board_revision=excluded.board_revision,
        updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(code, idea, JSON.stringify(frames), current + 1, iso(), actor.name);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    return reelDetail(code, idea);
  }
  function reelDetail(code, idea) {
    const state = reelState(code, idea);
    const uploads = db.prepare("SELECT * FROM shooting_uploads WHERE company_code=? AND idea_id=? AND status IN ('stored','uploading') ORDER BY id")
      .all(code, idea).map((item) => view(item));
    return {reel: {ideaId: idea, ...summary(code, idea), board: JSON.parse(state?.board || '[]'), updatedAt: state?.updated_at || null,
      updatedBy: state?.updated_by || '', sketches: sketches.latest(code, idea), sketchStatus: sketches.status(code)}, uploads};
  }

  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/content/shooting/')) return false;
    const code = url.searchParams.get('companyCode') || '';
    const route = url.pathname.slice('/content/shooting'.length);
    const reply = (status, body) => { sendJson(response, status, body, {'cache-control': 'no-store'}); return true; };
    const method = request.method;
    let match;
    if (route.startsWith('/editor/')) {
      const actor = editor(request, code), rest = route.slice('/editor'.length);
      if ((match = /^\/reels\/([^/]+)\/takes$/.exec(rest)) && method === 'GET') {
        const takes = db.prepare("SELECT * FROM shooting_uploads WHERE company_code=? AND idea_id=? AND kind='take' AND status='stored' ORDER BY frame IS NULL, frame, id")
          .all(code, ideaId(match[1])).map((item) => view(item, '/content/shooting/editor'));
        return reply(200, {companyCode: code, ideaId: match[1], takes});
      }
      if ((match = /^\/files\/(\d+)$/.exec(rest)) && ['GET', 'HEAD'].includes(method)) {
        const item = row(code, match[1]);
        if (item.kind !== 'take') fail(404, 'Материал не найден');
        return sendFile(request, response, item);
      }
      if (rest === '/uploads' && method === 'POST') {
        const result = createUpload(code, await readJson(request), actor, ['draft']);
        return reply(result.status, {upload: result.upload});
      }
      if ((match = /^\/uploads\/(\d+)$/.exec(rest))) {
        const item = row(code, match[1]);
        if (item.kind !== 'draft') fail(404, 'Материал не найден');
        if (method === 'GET') return reply(200, {upload: view(item)});
        if (method === 'PATCH') return reply(200, {upload: await appendChunk(request, code, match[1])});
      }
      if ((match = /^\/reels\/([^/]+)\/status$/.exec(rest)) && method === 'PUT') {
        const body = await readJson(request);
        if (!['editing', 'draft'].includes(body.status)) fail(400, 'Монтажёр ставит только editing или draft');
        return reply(200, {reel: setStatus(code, ideaId(match[1]), body.status, actor)});
      }
      fail(404, 'Адрес не найден');
    }
    const write = !['GET', 'HEAD'].includes(method);
    const actor = cabinet(request, code, write);
    if (route === '/reels' && method === 'GET') {
      const ids = db.prepare(`SELECT idea_id FROM shooting_uploads WHERE company_code=? AND status='stored'
        UNION SELECT idea_id FROM shooting_reels WHERE company_code=?`).all(code, code).map((item) => item.idea_id);
      return reply(200, {companyCode: code, canEdit: actor.canEdit, storage: storageInfo(code),
        reels: Object.fromEntries(ids.map((id) => [id, summary(code, id)]))});
    }
    if ((match = /^\/reels\/([^/]+)$/.exec(route)) && method === 'GET') {
      return reply(200, {companyCode: code, canEdit: actor.canEdit, storage: storageInfo(code), ...reelDetail(code, ideaId(match[1]))});
    }
    if ((match = /^\/reels\/([^/]+)\/board$/.exec(route)) && method === 'PUT') {
      return reply(200, saveBoard(code, ideaId(match[1]), await readJson(request), actor));
    }
    if ((match = /^\/reels\/([^/]+)\/status$/.exec(route)) && method === 'PUT') {
      return reply(200, {reel: setStatus(code, ideaId(match[1]), (await readJson(request)).status, actor)});
    }
    if ((match = /^\/reels\/([^/]+)\/sketch$/.exec(route)) && method === 'POST') {
      return reply(201, await sketches.generate(code, ideaId(match[1]), await readJson(request), actor));
    }
    if ((match = /^\/sketches\/(\d+)$/.exec(route)) && ['GET', 'HEAD'].includes(method)) return sendFile(request, response, sketches.file(code, match[1]));
    if (route === '/uploads' && method === 'POST') {
      const result = createUpload(code, await readJson(request), actor, ['take', 'draft']);
      return reply(result.status, {upload: result.upload});
    }
    if ((match = /^\/uploads\/(\d+)$/.exec(route))) {
      if (method === 'GET') return reply(200, {upload: view(row(code, match[1]))});
      if (method === 'PATCH') return reply(200, {upload: await appendChunk(request, code, match[1])});
      if (method === 'DELETE') {
        const item = row(code, match[1]);
        if (busy.has(item.id)) fail(409, 'Файл сейчас принимается');
        storage.remove(code, item.disk_key);
        db.prepare("UPDATE shooting_uploads SET status='deleted', completed_at=? WHERE id=?").run(iso(), item.id);
        return reply(200, {deleted: true});
      }
    }
    if ((match = /^\/files\/(\d+)$/.exec(route)) && ['GET', 'HEAD'].includes(method)) return sendFile(request, response, row(code, match[1]));
    fail(404, 'Адрес не найден');
  }
  return {handle, storageInfo};
}

module.exports = {createShooting, readShootingConfig, signatureOk, MAX_FILE, CHUNK, MAX_CHUNK};
