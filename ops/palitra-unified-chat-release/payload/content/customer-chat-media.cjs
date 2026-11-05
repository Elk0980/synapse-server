'use strict';

/* Palitra PhaseD1: вложения общего чата сайта (14.10.2026).

   Один модуль для всего, что касается файлов чата сайта:
   - единственный разбор типизированной ссылки `thread:<id>` и точных binary-адресов покупателя и владельца;
   - проверка фактических байтов (сигнатуры) и решение о показе: картинка/звук/видео встроенно только для
     распознанных безопасных растров/аудио/видео; всё прочее (документы, SVG, HTML, .tgs, неизвестное) — скачивание;
   - приватное хранение: заранее выбранное серверное UUID-имя, temp (wx) → fsync → link без перезаписи → проверка
     фактического файла. Готовый файл никогда не перезаписывается; другие байты под тем же именем — явный конфликт;
   - защищённая выдача: private/no-store, nosniff, sandbox-CSP, безопасный Content-Disposition, Range только для
     аудио/видео (ограниченный, проверяется на каждом запросе), HEAD без тела, поток без накопления в памяти.
   До первой операции с файлом модуль файловую систему не трогает (конструкторы и текстовый путь её не касаются).
   Telegram file_id, путь getFile, имя на диске, хеш и абсолютные пути наружу не выдаются. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KINDS = Object.freeze(['photo', 'voice', 'audio', 'video', 'video_note', 'animation', 'document', 'sticker']);
const STATUSES = Object.freeze(['pending', 'stored', 'too_large', 'unavailable', 'quota_exceeded']);
const DEFAULT_MAX_FILE = 20 * 1024 * 1024;
const DEFAULT_MAX_STORAGE = 1024 * 1024 * 1024;
const ID = '([1-9]\\d{0,15})';
const TYPED_REF = new RegExp(`^thread:${ID}$`);
const BUYER_PATH = new RegExp(`^/api/customer-chat/threads/${ID}/attachments/thread:${ID}$`);
const OWNER_PATH = new RegExp(`^/content/palitra/customer-threads/${ID}/attachments/thread:${ID}$`);
const DISK_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEMP_NAME = /^\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{16})\.part$/;
const TEMP_MAX_AGE = 60 * 60 * 1000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const AUDIO = new Set(['audio/ogg', 'audio/mpeg', 'audio/mp4']);
const VIDEO = new Set(['video/mp4', 'video/webm']);
const FILE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; sandbox";
const EXTENSIONS = Object.freeze({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'video/mp4': '.mp4', 'video/webm': '.webm', 'application/gzip': '.tgs' });

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const safeId = (text) => { const n = Number(text); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/* ---------- ссылки и адреса: один строгий разбор для всех слоёв ---------- */
function parseTypedRef(value) {
  const match = typeof value === 'string' ? TYPED_REF.exec(value) : null;
  return match ? safeId(match[1]) : null;
}
const typedRef = (id) => `thread:${id}`;
function parseBinaryPath(pathname, pattern) {
  const match = typeof pathname === 'string' ? pattern.exec(pathname) : null;
  if (!match) return null;
  const threadId = safeId(match[1]), attachmentId = safeId(match[2]);
  return threadId && attachmentId ? { threadId, attachmentId } : null;
}
const parseBuyerBinaryPath = (pathname) => parseBinaryPath(pathname, BUYER_PATH);
const parseOwnerBinaryPath = (pathname) => parseBinaryPath(pathname, OWNER_PATH);
const buyerBinaryPath = (threadId, attachmentId) => `/api/customer-chat/threads/${threadId}/attachments/${typedRef(attachmentId)}`;
const ownerBinaryPath = (threadId, attachmentId) => `/content/palitra/customer-threads/${threadId}/attachments/${typedRef(attachmentId)}`;

/* ---------- фактический тип по байтам ---------- */
function sniff(bytes) {
  const b = bytes;
  if (!Buffer.isBuffer(b) || b.length < 2) return null;
  const at = (offset, text) => b.length >= offset + text.length && b.toString('latin1', offset, offset + text.length) === text;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG)) return 'image/png';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(0, 'OggS')) return 'audio/ogg';
  if (at(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return 'audio/mpeg';
  if (at(4, 'ftyp')) return /^M4[AB] $/.test(b.toString('latin1', 8, 12)) ? 'audio/mp4' : 'video/mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'application/gzip';   // .tgs — Lottie в gzip: никогда не исполняется
  return null;
}
/* Показ по native kind и проверенному типу; kind не меняется. Неподходящее — честное скачивание. */
function presentationOf(kind, type) {
  if (!type || kind === 'document') return 'download';
  if (kind === 'photo') return IMAGES.has(type) ? 'image' : 'download';
  if (kind === 'voice' || kind === 'audio') return AUDIO.has(type) ? 'audio' : 'download';
  if (kind === 'video' || kind === 'video_note') return VIDEO.has(type) ? 'video' : 'download';
  if (kind === 'animation') return type === 'image/gif' ? 'image' : VIDEO.has(type) ? 'video' : 'download';
  if (kind === 'sticker') return type === 'image/webp' || type === 'image/png' ? 'image' : type === 'video/webm' ? 'video' : 'download';
  return 'download';
}
/* Имя для Content-Disposition: без управляющих символов и путей; запасное имя стикера получает настоящее расширение. */
function downloadName(name, kind, type) {
  let value = String(name || '').replace(/[\u0000-\u001f\u007f\\/]/g, '_').trim().slice(0, 180) || `file${EXTENSIONS[type] || ''}`;
  if (kind === 'sticker' && /^sticker-\d+\.webp$/.test(value) && type && type !== 'image/webp' && EXTENSIONS[type]) value = value.replace(/\.webp$/, EXTENSIONS[type]);
  return value;
}
const encodeName = (name) => encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/* ---------- приватное хранилище ---------- */
function createMediaStorage({ root, now = Date.now } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('createMediaStorage: нужен абсолютный приватный каталог');
  const realRoot = () => { fs.mkdirSync(root, { recursive: true }); return fs.realpathSync(root); };
  const target = (base, diskName) => {
    if (!DISK_NAME.test(String(diskName || ''))) fail(500, 'Некорректное имя файла хранилища', 'DISK_NAME');
    return path.join(base, diskName);
  };
  /* Repair R5: файл вложения — ровно один обычный файл с этим UUID-именем прямо в каталоге хранилища. Символическая
     ссылка (даже на файл внутри каталога), каталог и прочие объекты под этим именем — не файл вложения (конфликт). */
  function existing(base, file) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile() || path.dirname(file) !== base) fail(409, 'Файл хранилища занят чужим объектом', 'CONFLICT');
    return { real: file, size: stat.size };
  }
  // Хеш файла по дескриптору, ограниченными порциями (без чтения всего файла в память).
  function digestFd(fd, size) {
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(Math.max(size, 1), 64 * 1024));
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
      offset += read;
    }
    return offset === size ? hash.digest('hex') : null;
  }
  /* Сведения о файле под именем вложения: { size, sha256 } обычного файла или null, если файла нет (для учёта объёма). */
  function inspect(diskName) {
    let base;
    try { base = fs.realpathSync(root); } catch (_) { return null; }
    const found = existing(base, target(base, diskName));
    if (!found) return null;
    const fd = fs.openSync(found.real, 'r');
    try { const size = fs.fstatSync(fd).size; return { size, sha256: digestFd(fd, size) }; }
    finally { fs.closeSync(fd); }
  }
  // Только свои давние временные файлы этого модуля; общий каталог и чужие файлы не трогаются.
  function sweep(base) {
    let names = [];
    try { names = fs.readdirSync(base); } catch (_) { return; }
    for (const name of names) {
      if (!TEMP_NAME.test(name)) continue;
      const file = path.join(base, name);
      try { const stat = fs.lstatSync(file); if (stat.isFile() && now() - stat.mtimeMs > TEMP_MAX_AGE) fs.unlinkSync(file); } catch (_) { /* уже нет */ }
    }
  }
  /* Сохранить байты под заранее выбранным именем. Повтор с теми же байтами возвращает тот же результат без второй копии. */
  function put(diskName, bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) fail(400, 'Пустой файл', 'EMPTY');
    const base = realRoot();
    const file = target(base, diskName);
    const digest = sha256(bytes);
    const same = (found) => {
      const actual = fs.readFileSync(found.real);
      if (actual.length !== bytes.length || sha256(actual) !== digest) fail(409, 'Под этим вложением уже сохранён другой файл', 'CONFLICT');
      return { sha256: digest, size: actual.length, reused: true };
    };
    const before = existing(base, file);
    if (before) return same(before);
    sweep(base);
    const temp = path.join(base, `.${diskName}.${crypto.randomBytes(8).toString('hex')}.part`);
    let fd = null;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      try { fs.linkSync(temp, file); }
      catch (error) {
        if (error.code === 'EEXIST') return same(existing(base, file));
        if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(error.code)) throw error;
        // Repair R5: нет жёстких ссылок — исключающее создание цели (COPYFILE_EXCL): существующий файл никогда не
        // заменяется, даже если он появился между проверкой и записью (тогда EEXIST и сравнение байтов).
        try { fs.copyFileSync(temp, file, fs.constants.COPYFILE_EXCL); }
        catch (copyError) { if (copyError.code === 'EEXIST') return same(existing(base, file)); throw copyError; }
      }
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* уже закрыт */ } }
      try { fs.unlinkSync(temp); } catch (_) { /* ссылка уже стала файлом или temp не создан */ }
    }
    const after = existing(base, file);
    if (!after) fail(500, 'Файл не сохранён', 'READBACK');
    const result = same(after);
    return { ...result, reused: false };
  }
  /* Открыть сохранённый файл для выдачи. Repair R5: обычный файл (не ссылка) с записанным в базе размером И хешем;
     возвращается открытый дескриптор — именно эти проверенные байты уходят в ответ (вызывающий обязан закрыть его через
     sendFile или closeOpened). Несовпадение — 404 без путей. */
  function open(diskName, expectedSize, expectedSha) {
    let base;
    try { base = fs.realpathSync(root); } catch (_) { fail(404, 'Файл не найден', 'MISSING'); }
    let found;
    try { found = existing(base, target(base, diskName)); } catch (_) { found = null; }
    if (!found) fail(404, 'Файл не найден', 'MISSING');
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    try { fd = fs.openSync(found.real, flags); } catch (_) { fail(404, 'Файл не найден', 'MISSING'); }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || !Number.isSafeInteger(expectedSize) || stat.size !== expectedSize) fail(404, 'Файл не найден', 'MISSING');
      if (typeof expectedSha !== 'string' || digestFd(fd, stat.size) !== expectedSha) fail(404, 'Файл не найден', 'MISSING');
      return { fd, size: stat.size };
    } catch (error) { try { fs.closeSync(fd); } catch (_) { /* уже закрыт */ } throw error; }
  }
  return Object.freeze({ put, open, inspect, root: () => root });
}

/* ---------- защищённая выдача ---------- */
/* Repair R5: байты — из переданного открытого дескриптора fd (проверенного storage.open); путь file — только для
   локальных стендов. Дескриптор закрывается всегда: HEAD, 416, пустой файл, ошибка чтения, обрыв клиента. */
const closeFd = (fd) => { try { fs.closeSync(fd); } catch (_) { /* уже закрыт */ } };
function sendFile(request, response, { fd: givenFd = null, file = null, size, contentType, presentation, name, kind }) {
  const fd = givenFd !== null ? givenFd : fs.openSync(file, 'r');
  let streaming = false;
  try { return sendFromFd(request, response, fd, { size, contentType, presentation, name, kind }, () => { streaming = true; }); }
  finally { if (!streaming) closeFd(fd); }
}
function sendFromFd(request, response, fd, { size, contentType, presentation, name, kind }, started) {
  const inline = presentation === 'image' || presentation === 'audio' || presentation === 'video';
  const media = presentation === 'audio' || presentation === 'video';
  const headers = {
    'Content-Type': inline ? contentType : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeName(downloadName(name, kind, contentType))}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': FILE_CSP,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
  };
  let start = 0, end = size - 1, status = 200;
  if (media) headers['Accept-Ranges'] = 'bytes';
  const range = request.headers && request.headers.range;
  if (media && typeof range === 'string' && range.trim()) {
    const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(range.trim());
    let valid = Boolean(match) && Boolean(match[1] || match[2]) && size > 0;
    if (valid && match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
    else if (valid) { const suffix = Number(match[2]); valid = suffix > 0; start = Math.max(0, size - suffix); end = size - 1; }
    if (!valid || start > end || start >= size) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': 0 });
      return response.end();   // дескриптор закрывает sendFile (поток не начинался)
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size > 0 ? end - start + 1 : 0;
  response.writeHead(status, headers);
  if (request.method === 'HEAD' || size === 0) return response.end();
  // Поток владеет дескриптором с этого момента (autoClose): закрывается по окончании, ошибке или destroy при обрыве.
  const stream = fs.createReadStream(null, { fd, start, end, autoClose: true });
  started();
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
  return undefined;
}
/* Выдача после проверки доступа: resolve() — синхронная проверка сессии/доступа/записи; вызывается до открытия файла и
   ещё раз непосредственно перед заголовками и байтами. Неизвестное, чужое, не сохранённое — отказ до файловой системы.
   Отказ второй проверки закрывает уже открытый дескриптор. */
function serveProtected({ request, response, resolve, open }) {
  if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'Метод не поддерживается', 'METHOD');
  const first = resolve();
  const opened = open(first);
  let fresh;
  try {
    fresh = resolve();
    if (fresh.id !== first.id || fresh.diskName !== first.diskName || fresh.size !== first.size || fresh.sha256 !== first.sha256) fail(404, 'Файл не найден', 'NOT_FOUND');
  } catch (error) { closeFd(opened.fd); throw error; }
  return sendFile(request, response, { ...fresh, fd: opened.fd, size: opened.size });
}

module.exports = { KINDS, STATUSES, DEFAULT_MAX_FILE, DEFAULT_MAX_STORAGE, FILE_CSP, parseTypedRef, typedRef, parseBuyerBinaryPath,
  parseOwnerBinaryPath, buyerBinaryPath, ownerBinaryPath, sniff, presentationOf, downloadName, createMediaStorage, sendFile, serveProtected, sha256 };
