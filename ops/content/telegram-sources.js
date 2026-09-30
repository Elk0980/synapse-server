'use strict';

/* Тихий приём новых исходников. Нет зависимости от чата, outbox, задач или моделей.
   Конфигурация локальная, по умолчанию выключена. Снятая привязка остаётся зарезервированной,
   чтобы исходный чат после перезапуска не попадал в legacy-обработчик команд. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { COMPANIES } = require('./auth-store');
const MAX_FILE = 20 * 1024 * 1024;
const DEFAULT_STORAGE = 512 * 1024 * 1024;
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'application/pdf']);
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const text = (value, max = 200) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max);
const chatId = value => { const id = String(value ?? ''); if (!/^-\d{1,20}$/.test(id)) fail(400, 'Некорректный источник'); return id; };
const messageId = value => { const id = String(value ?? ''); if (!/^[1-9]\d{0,19}$/.test(id)) fail(400, 'Некорректный номер сообщения'); return id; };
const company = value => { if (!Object.hasOwn(COMPANIES, value)) fail(400, 'Неизвестная компания'); return value; };
const telegramUrl = (chat, message) => /^-100\d+$/.test(chat) ? `https://t.me/c/${chat.slice(4)}/${message}` : null;

function readSourceConfig(file) {
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config || !Array.isArray(config.sources)) throw new Error('sources');
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return {enabled: false, sources: []};
    // Не раскрываем путь/содержимое конфигурации в ошибках.
    return {enabled: false, sources: [], invalid: true};
  }
}
function validBytes(mime, bytes) {
  if (mime === 'image/jpeg') return bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'video/mp4' || mime === 'video/quicktime') return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  if (mime === 'application/pdf') return bytes.toString('ascii', 0, 5) === '%PDF-';
  return false;
}

function createTelegramSources({db, assetsDir, config = {enabled: false, sources: []}, authStore, requireSession, sendJson}) {
  const storage = path.resolve(assetsDir, 'telegram-sources');
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_source_chats (
    chat_id TEXT PRIMARY KEY, company_code TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS telegram_source_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL, media_group_id TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '',
      file_id TEXT NOT NULL DEFAULT '', file_unique_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL DEFAULT '', declared_size INTEGER, size INTEGER, sha256 TEXT, disk_name TEXT,
      status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      UNIQUE(chat_id,message_id));
    CREATE INDEX IF NOT EXISTS telegram_source_items_company ON telegram_source_items(company_code,id);`);
  let healthy = !config.invalid;
  const maxStorage = Number.isSafeInteger(config.maxStorageBytes) && config.maxStorageBytes >= 0 ? Math.min(config.maxStorageBytes, 4 * 1024 ** 3) : DEFAULT_STORAGE;
  try {
    if (!Array.isArray(config.sources) || config.sources.length > 32) throw new Error('sources');
    const configured = config.sources.map(source => ({chat: chatId(source.chatId), code: company(source.companyCode), enabled: config.enabled === true && source.enabled === true}));
    if (new Set(configured.map(row => row.chat)).size !== configured.length) throw new Error('duplicates');
    for (const source of configured) {
      const old = db.prepare('SELECT company_code FROM telegram_source_chats WHERE chat_id=?').get(source.chat);
      if (old && old.company_code !== source.code) throw new Error('reassignment');
      const rooms = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_chat_rooms'").get();
      if (rooms && db.prepare('SELECT 1 FROM project_chat_rooms WHERE telegram_chat_id=?').get(source.chat)) throw new Error('room collision');
    }
    db.exec('BEGIN IMMEDIATE');
    db.exec('UPDATE telegram_source_chats SET enabled=0');
    for (const source of configured) db.prepare(`INSERT INTO telegram_source_chats(chat_id,company_code,enabled) VALUES(?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET enabled=excluded.enabled`).run(source.chat, source.code, source.enabled ? 1 : 0);
    db.exec('COMMIT');
  } catch { if (db.isTransaction) db.exec('ROLLBACK'); healthy = false; db.exec('UPDATE telegram_source_chats SET enabled=0'); }
  function binding(value) {
    const row = db.prepare('SELECT * FROM telegram_source_chats WHERE chat_id=?').get(String(value));
    const rooms = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_chat_rooms'").get();
    const room = rooms && db.prepare('SELECT 1 FROM project_chat_rooms WHERE telegram_chat_id=?').get(String(value));
    if (!healthy && !row && !room) fail(503, 'Настройки источников требуют проверки');
    // Настройки рабочей комнаты могли поменять уже после старта: источник остаётся тихим.
    return row ? {companyCode: row.company_code, enabled: healthy && row.enabled === 1 && !room} : null;
  }
  function migrate(oldValue, newValue) {
    const oldChat = chatId(oldValue), newChat = chatId(newValue);
    if (oldChat === newChat) fail(400, 'Источник не изменился');
    const source = db.prepare('SELECT * FROM telegram_source_chats WHERE chat_id=?').get(oldChat);
    if (!source) fail(404, 'Источник не настроен');
    const existing = db.prepare('SELECT * FROM telegram_source_chats WHERE chat_id=?').get(newChat);
    if (existing && existing.company_code !== source.company_code) fail(409, 'Источник уже закреплён за другой компанией');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Перенос в супергруппу резервирует новый id, но не включает его без проверки конфигурации.
      db.prepare('INSERT OR IGNORE INTO telegram_source_chats(chat_id,company_code,enabled) VALUES(?,?,0)').run(newChat,source.company_code);
      db.prepare('UPDATE telegram_source_chats SET enabled=0 WHERE chat_id=?').run(oldChat);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    return {source:binding(newChat)};
  }
  const json = row => row && ({id: row.id, companyCode: row.company_code, name: row.name, mime: row.mime,
    caption: row.caption, mediaGroupId: row.media_group_id, size: row.size ?? row.declared_size,
    status: row.status, reason: row.reason, createdAt: row.created_at,
    telegramUrl: telegramUrl(row.chat_id, row.message_id),
    fileUrl: row.status === 'stored' ? `/content/telegram-sources/${row.company_code}/${row.id}/file` : null});
  function receipt(chat, message) {
    return json(db.prepare('SELECT * FROM telegram_source_items WHERE chat_id=? AND message_id=?').get(chatId(chat), messageId(message)));
  }
  function receive(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail(400, 'Некорректный исходник');
    const chat = chatId(event.chatId), message = messageId(event.messageId), source = binding(chat);
    if (!source) fail(404, 'Источник не настроен');
    if (!source.enabled) fail(409, 'Приём источника выключен');
    const old = receipt(chat, message); if (old) return {item: old, duplicate: true};
    const file = event.file || null, caption = text(event.text, 12000), mediaGroup = text(event.mediaGroupId, 64);
    if (!file && !caption.trim()) fail(400, 'Пустой исходник');
    const name = text(file?.name || '', 180).replace(/[\\/\r\n]/g, '_');
    const mime = text(file?.mime || '', 80).toLowerCase();
    const declaredSize = Number.isSafeInteger(file?.size) && file.size >= 0 ? file.size : null;
    let status = file ? 'manual_import' : 'text', reason = file ? text(event.reason || 'Нужен ручной импорт', 300) : '', bytes = null, sha = null, disk = null;
    if (file && event.status === 'stored') {
      if (typeof event.base64 !== 'string' || event.base64.length > Math.ceil(MAX_FILE / 3) * 4) fail(413, 'Файл больше 20 МБ');
      bytes = Buffer.from(event.base64, 'base64');
      if (!bytes.length || bytes.length > MAX_FILE || declaredSize > MAX_FILE) { reason = 'Файл больше лимита облачного Telegram; нужен ручной импорт'; bytes = null; }
      else if (!MIME.has(mime) || !validBytes(mime, bytes)) { reason = 'Формат файла не распознан; нужен ручной импорт'; bytes = null; }
      else {
        sha = crypto.createHash('sha256').update(bytes).digest('hex'); disk = sha;
        const used = db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM (SELECT disk_name,MAX(size) AS size FROM telegram_source_items WHERE company_code=? AND disk_name IS NOT NULL GROUP BY disk_name)').get(source.companyCode).n;
        const exists = db.prepare('SELECT 1 FROM telegram_source_items WHERE company_code=? AND disk_name=?').get(source.companyCode, disk);
        if (!exists && used + bytes.length > maxStorage) { reason = 'Хранилище заполнено; нужен ручной импорт'; bytes = null; sha = null; disk = null; }
        else { status = 'stored'; reason = ''; }
      }
    }
    let createdFile = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (bytes) {
        const dir = path.join(storage, source.companyCode); fs.mkdirSync(dir, {recursive: true, mode: 0o700});
        const destination = path.join(dir, disk);
        if (!fs.existsSync(destination)) { fs.writeFileSync(destination, bytes, {flag: 'wx', mode: 0o600}); createdFile = destination; }
      }
      const result = db.prepare(`INSERT INTO telegram_source_items
        (company_code,chat_id,message_id,media_group_id,caption,file_id,file_unique_id,name,mime,declared_size,size,sha256,disk_name,status,reason,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(source.companyCode,chat,message,mediaGroup,caption,text(file?.fileId,250),text(file?.fileUniqueId,250),name,mime,
          declaredSize,bytes?.length ?? null,sha,disk,status,reason,new Date().toISOString());
      db.exec('COMMIT');
      return {item: json(db.prepare('SELECT * FROM telegram_source_items WHERE id=?').get(result.lastInsertRowid)), duplicate: false};
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); if (createdFile) fs.rmSync(createdFile, {force: true}); throw error; }
  }
  function access(request, code) {
    company(code);
    const session = requireSession(request), user = authStore.getById(session.user.id);
    if (!user || user.sessionVersion !== session.user.sessionVersion) fail(401, 'Требуется вход в кабинет');
    if (user.role !== 'owner' && (!user.companyCodes.includes(code) || !user.permissions.includes('autoposting.view'))) fail(403, 'Нет доступа к исходникам компании');
  }
  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/content/telegram-sources/')) return false;
    if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'Метод не поддерживается');
    const match = /^\/content\/telegram-sources\/([a-z0-9_-]+)(?:\/(\d+)\/file)?$/.exec(url.pathname);
    if (!match) fail(404, 'Исходник не найден');
    const code = match[1]; access(request, code);
    if (!match[2]) {
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      const rows = db.prepare('SELECT * FROM telegram_source_items WHERE company_code=? AND id<? ORDER BY id DESC LIMIT 51').all(code,before);
      sendJson(response, 200, {items: rows.slice(0,50).map(json), nextBefore: rows.length > 50 ? rows[49].id : null,
        enabled: healthy && db.prepare('SELECT chat_id FROM telegram_source_chats WHERE company_code=? AND enabled=1').all(code).some(row=>binding(row.chat_id).enabled)}, {'cache-control':'no-store'});
      return true;
    }
    const row = db.prepare('SELECT * FROM telegram_source_items WHERE id=? AND company_code=?').get(Number(match[2]),code);
    if (!row || row.status !== 'stored' || !/^[a-f0-9]{64}$/.test(row.disk_name)) fail(404, 'Файл не сохранён');
    const file = path.join(storage,code,row.disk_name);
    if (!fs.existsSync(file)) fail(404, 'Файл недоступен');
    response.writeHead(200, {'content-type':row.mime,'content-length':row.size,'cache-control':'private, no-store',
      'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",
      'content-disposition':`attachment; filename="source-${row.id}"; filename*=UTF-8''${encodeURIComponent(row.name || `source-${row.id}`)}`});
    response.end(request.method === 'HEAD' ? undefined : fs.readFileSync(file));
    return true;
  }
  return {binding,receipt,receive,migrate,handle,healthy};
}
module.exports = {createTelegramSources,readSourceConfig,MAX_FILE,DEFAULT_STORAGE};
