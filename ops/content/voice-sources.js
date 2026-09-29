'use strict';
/* Голосовые исходники для монтажа роликов.
   Приватное хранилище: файл лежит вне публичных publishing-assets, читается только по сессии
   с правом autoposting.view в своей компании. Публичной ссылки нет, поэтому запись не может
   уйти в Onlypult/ВКонтакте и не заменяет основное видео карточки. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectAudio, AudioReject } = require('./audio-container');

const MAX_VOICE_SOURCE = 25 * 1024 * 1024;
const MAX_PER_POST = 20;
// Браузеры называют один формат по-разному (iOS — audio/x-m4a, Windows — audio/wav или audio/x-wav).
const VOICE_TYPES = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'audio/opus': 'ogg',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
};
const VOICE_MIME = { m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav' };

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

const REJECT_MESSAGES = {
  video: 'В файле есть видео. Загрузите только голосовую запись M4A, MP3, OGG или WAV',
  corrupt: 'Файл повреждён или записан не полностью. Сохраните запись заново',
  'no-audio': 'В файле нет звуковой дорожки',
  unknown: 'Файл не похож на голосовую запись M4A, MP3, OGG или WAV',
};

function cleanName(value, format) {
  const base = String(value || '').normalize('NFC').replace(/[\u0000-\u001f\u007f"\\/<>|:*?]/g, '').trim().slice(0, 120);
  return base || `voice.${format}`;
}

function canView(user, companyCode) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return (user.companyCodes || []).includes(companyCode)
    && (user.permissions || []).some(p => p === 'autoposting.view' || p === 'autoposting.edit' || p === 'autoposting.approve');
}

function canEdit(user, companyCode) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return (user.companyCodes || []).includes(companyCode) && (user.permissions || []).includes('autoposting.edit');
}

/* verifyPost(user, companyCode, postId) — доверенная проверка в CRM, что ролик существует и принадлежит компании.
   Без неё запись не сохраняется и не показывается (fail closed). */
function createVoiceSources({ db, assetsDir, companies, verifyPost, now = () => new Date().toISOString() }) {
  const storage = path.resolve(assetsDir, 'voice-sources');
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_code TEXT NOT NULL,
      post_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      format TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      disk_name TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS voice_sources_post ON voice_sources(company_code, post_id, id);
  `);

  const company = code => {
    const value = String(code || '');
    if (!value || !Object.hasOwn(companies, value)) fail(400, 'Выберите компанию');
    return value;
  };
  const postId = value => {
    const id = Number(value);
    if (!/^\d{1,15}$/.test(String(value || '')) || !Number.isSafeInteger(id) || id < 1) fail(400, 'Укажите ролик');
    return id;
  };
  const json = row => ({ id: row.id, companyCode: row.company_code, postId: row.post_id, name: row.name,
    mime: VOICE_MIME[row.format], size: row.size, sha256: row.sha256, createdBy: row.created_by, createdAt: row.created_at,
    url: `/content/voice-sources/${row.id}?companyCode=${encodeURIComponent(row.company_code)}` });

  async function checkPost(user, code, post) {
    if (typeof verifyPost !== 'function') fail(503, 'Проверка ролика недоступна: запись не принимается');
    await verifyPost(user, code, post);
  }

  async function list({ user, companyCode, postId: rawPost }) {
    const code = company(companyCode), post = postId(rawPost);
    if (!canView(user, code)) fail(403, 'Нет доступа к компании');
    await checkPost(user, code, post);
    return db.prepare('SELECT * FROM voice_sources WHERE company_code=? AND post_id=? ORDER BY id DESC').all(code, post).map(json);
  }

  async function store({ user, companyCode, postId: rawPost, name, mime, bytes }) {
    const code = company(companyCode), post = postId(rawPost);
    if (!canEdit(user, code)) fail(403, 'Недостаточно прав');
    const declared = VOICE_TYPES[String(mime || '').split(';')[0].trim().toLowerCase()];
    if (!declared) fail(415, 'Допустимы голосовые записи M4A, MP3, OGG и WAV');
    if (!Buffer.isBuffer(bytes) || !bytes.length) fail(400, 'Файл пустой');
    if (bytes.length > MAX_VOICE_SOURCE) fail(413, 'Запись не должна превышать 25 МБ');
    let format;
    try { format = inspectAudio(bytes); } catch (error) {
      if (error instanceof AudioReject) fail(415, REJECT_MESSAGES[error.reason] || REJECT_MESSAGES.unknown);
      throw error;
    }
    if (format !== declared) fail(415, 'Формат файла не совпадает с расширением записи');
    await checkPost(user, code, post);
    const count = db.prepare('SELECT COUNT(*) AS n FROM voice_sources WHERE company_code=? AND post_id=?').get(code, post).n;
    if (count >= MAX_PER_POST) fail(409, 'К ролику уже добавлено 20 записей');
    const directory = path.join(storage, code);
    fs.mkdirSync(directory, { recursive: true });
    const diskName = `${crypto.randomBytes(16).toString('hex')}.${format}`, file = path.join(directory, diskName);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    try {
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const id = Number(db.prepare(`INSERT INTO voice_sources (company_code, post_id, name, format, size, sha256, disk_name, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, post, cleanName(name, format), format, bytes.length, sha256, diskName,
        String(user.login || user.displayName || user.role || 'unknown').slice(0, 80), now()).lastInsertRowid);
      return json(db.prepare('SELECT * FROM voice_sources WHERE id=?').get(id));
    } catch (error) {
      fs.rmSync(file, { force: true });
      throw error;
    }
  }

  function open({ user, companyCode, id }) {
    const code = company(companyCode);
    // Чужая компания и отсутствующая запись неразличимы, чтобы не раскрывать идентификаторы.
    if (!canView(user, code)) fail(404, 'Запись не найдена');
    const row = /^\d{1,15}$/.test(String(id || '')) ? db.prepare('SELECT * FROM voice_sources WHERE id=? AND company_code=?').get(Number(id), code) : null;
    if (!row) fail(404, 'Запись не найдена');
    const file = path.join(storage, code, row.disk_name);
    if (!fs.existsSync(file)) fail(404, 'Запись не найдена');
    return { ...json(row), file, diskSize: fs.statSync(file).size };
  }

  /* HTTP-маршруты. Возвращает true, если запрос обработан. */
  async function handle(request, response, url, { requireSession, requireCsrf, readRaw, reply }) {
    if (url.pathname === '/content/voice-sources') {
      const session = requireSession(request), query = url.searchParams;
      if (request.method === 'GET') {
        reply(200, { companyCode: query.get('companyCode'), postId: Number(query.get('postId')),
          items: await list({ user: session.user, companyCode: query.get('companyCode'), postId: query.get('postId') }) }, { 'cache-control': 'no-store' });
        return true;
      }
      if (request.method === 'POST') {
        const code = company(query.get('companyCode'));
        const post = postId(query.get('postId'));
        if (!canEdit(session.user, code)) fail(403, 'Недостаточно прав');
        requireCsrf(request, session);
        // Ролик проверяется до приёма тела: без подтверждения CRM файл даже не читается.
        await checkPost(session.user, code, post);
        const bytes = await readRaw(request, MAX_VOICE_SOURCE);
        reply(201, { item: await store({ user: session.user, companyCode: code, postId: query.get('postId'), name: query.get('name'),
          mime: request.headers['content-type'], bytes }) });
        return true;
      }
      fail(405, 'Метод не поддерживается');
    }
    const match = /^\/content\/voice-sources\/(\d{1,15})$/.exec(url.pathname);
    if (!match) return false;
    if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'Метод не поддерживается');
    const session = requireSession(request);
    const item = open({ user: session.user, companyCode: url.searchParams.get('companyCode'), id: match[1] });
    const size = item.diskSize;
    const headers = { 'content-type': item.mime, 'cache-control': 'private, no-store', 'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': `inline; filename="voice"; filename*=UTF-8''${encodeURIComponent(item.name)}` };
    // Safari на iPhone воспроизводит аудио только при поддержке диапазонов.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''));
    let start = 0, end = size - 1, status = 200;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : end;
      if (start > end || start >= size) {
        response.writeHead(416, { 'content-range': `bytes */${size}` });
        response.end();
        return true;
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = end - start + 1;
    response.writeHead(status, headers);
    if (request.method === 'HEAD') { response.end(); return true; }
    const stream = fs.createReadStream(item.file, { start, end });
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
    return true;
  }

  return { list, store, open, handle };
}

module.exports = { createVoiceSources, MAX_VOICE_SOURCE, VOICE_TYPES };
