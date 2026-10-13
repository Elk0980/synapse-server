'use strict';

/* Palitra PhaseE: один файл с сайта или из рабочего места в существующей переписке (14.10.2026).

   Один модуль и ОДНА добавленная таблица chat_web_uploads — журнал загрузки и сведения о приватном файле вместе.
   Это не вторая история переписки и не вторая очередь: сообщение — настоящая запись существующей истории
   (chat_thread_messages чата сайта или client_dialog_messages прежнего диалога бота), задания — прежняя client_bot_outbox.

   Правила:
   - `upload:<UUID>` — серверный идентификатор (UUID v4), не пропуск: доступ всегда проверяет вызывающий слой заново;
     прежние ссылки `thread:N` и числовые legacy-номера не меняются;
   - подготовка (prepare) — точное тело {requestId,name,size,sha256,caption}; автор, получатель, сайт и цель — только из
     текущего доступа и адреса запроса. Тот же автор + requestId с другим содержимым или целью — 409, тот же — та же запись;
   - байты (raw) — ровно заявленный размер и заявленный sha256 (сервер считает сам), тип — только по байтам; имя — только
     для показа (не путь), тип файла из браузера не используется;
   - файл — в принятом D приватном хранилище (createMediaStorage: temp wx + fsync → link без замены / COPYFILE_EXCL,
     обычный файл, проверка размера и хеша при чтении). ФС и SQLite не одна атомарная операция, поэтому журнал хранит
     стадию (prepared → receiving → ready → committed) и заранее назначенное имя; сбой/перезапуск завершает ТУ ЖЕ запись
     тем же UUID и теми же байтами, другие байты не перезаписывают файл;
   - учёт объёма: одна сумма L (прежние диалоги) + D (вложения Telegram чата сайта) + E (эти загрузки); незавершённая
     загрузка резервирует заявленный размер один раз, завершённая — фактические байты; отказ и истечение срока не
     «освобождают» уже записанные байты. Файлы этот модуль не удаляет. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const mediaKit = require('./customer-chat-media.cjs');

const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SRC}$`);
const UPLOAD_REF = new RegExp(`^upload:(${UUID_SRC})$`);
const ID_SRC = '([1-9]\\d{0,15})';
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;     // подпись: переводы строк и табуляция допустимы
const NAME_CONTROL = /[\x00-\x1f\x7f]/;
const MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_CAPTION = 4000;
const MAX_NAME = 180;
// Telegram Bot API (проверено Root по официальной документации): подпись медиа ≤ 1024, sendPhoto ≤ 10 МБ (консервативно
// 10 000 000 байт), ширина + высота ≤ 10000, соотношение сторон ≤ 20; иначе — sendDocument с исходными байтами.
const MEDIA_CAPTION = 1024;
const PHOTO_MAX_BYTES = 10000000;
const PHOTO_MAX_SIDES = 10000;
const PHOTO_MAX_RATIO = 20;
const UPLOAD_TTL = 30 * 60 * 1000;
const CLAIM_TTL = 2 * 60 * 1000;
const ACTIVE_PER_ACTOR = 5;
const ACTIVE = Object.freeze(['prepared', 'receiving', 'ready']);
const FILE_METHODS = Object.freeze({ sendPhoto: 'photo', sendDocument: 'document' });
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const AUDIO_TYPES = new Set(['audio/ogg', 'audio/mpeg', 'audio/mp4']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const sha256Text = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

/* ---------- ссылки и точные адреса ---------- */
function parseUploadRef(value) {
  const match = typeof value === 'string' ? UPLOAD_REF.exec(value) : null;
  return match ? match[1] : null;
}
const uploadRef = (uuid) => `upload:${uuid}`;
/* Три области и четыре действия: prepare — POST коллекции, status — GET, bytes — POST сырых байтов, file — GET/HEAD.
   Только точная форма: положительный номер без ведущих нулей, ровно UUID v4 строчными, без хвостов и %-кодирования.
   Разбор `upload:<UUID>` идёт до любого Number(): `thread:N` и числовые ссылки сюда не попадают. */
const SCOPES = Object.freeze({
  buyer: '/api/customer-chat/threads/',
  thread: '/content/palitra/customer-threads/',
  legacy: '/content/palitra/client-dialogs/',
});
const ROUTES = Object.freeze(Object.entries(SCOPES).flatMap(([scope, base]) => [
  ['prepare', new RegExp(`^${base}${ID_SRC}/uploads$`)],
  ['status', new RegExp(`^${base}${ID_SRC}/uploads/upload:(${UUID_SRC})$`)],
  ['bytes', new RegExp(`^${base}${ID_SRC}/uploads/upload:(${UUID_SRC})/bytes$`)],
  ['file', new RegExp(`^${base}${ID_SRC}/attachments/upload:(${UUID_SRC})$`)],
].map(([action, pattern]) => Object.freeze({ scope, action, pattern }))));
const METHODS = Object.freeze({ prepare: ['POST'], status: ['GET'], bytes: ['POST'], file: ['GET', 'HEAD'] });
function parseUploadPath(pathname, scope = null) {
  if (typeof pathname !== 'string') return null;
  for (const route of ROUTES) {
    if (scope && route.scope !== scope) continue;
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const targetId = Number(match[1]);
    if (!Number.isSafeInteger(targetId) || targetId < 1) return null;
    return Object.freeze({ scope: route.scope, action: route.action, targetId, uuid: match[2] || null, methods: METHODS[route.action] });
  }
  return null;
}
const uploadPath = (scope, targetId, action, uuid = '') => {
  const base = `${SCOPES[scope]}${targetId}`;
  return action === 'prepare' ? `${base}/uploads` : action === 'status' ? `${base}/uploads/${uploadRef(uuid)}`
    : action === 'bytes' ? `${base}/uploads/${uploadRef(uuid)}/bytes` : `${base}/attachments/${uploadRef(uuid)}`;
};

/* ---------- подготовка: точное тело ---------- */
/* Имя — только для показа: последний сегмент без путей, без служебных символов и ведущих точек; не путь на диске. */
function displayName(value) {
  if (typeof value !== 'string' || !value.trim()) fail(400, 'Нужно имя файла', 'VALIDATION');
  if (value.length > MAX_NAME || NAME_CONTROL.test(value)) fail(400, `Имя файла длиннее ${MAX_NAME} символов или содержит служебные символы`, 'VALIDATION');
  const name = value.split(/[\\/]/).pop().replace(/^[.\s]+/, '').trim();
  if (!name) fail(400, 'Нужно имя файла', 'VALIDATION');
  return name;
}
function prepareInput(body, { maxFile = MAX_UPLOAD } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'caption,name,requestId,sha256,size') {
    fail(400, 'Нужны только поля: requestId, name, size, sha256, caption', 'VALIDATION');
  }
  if (typeof body.requestId !== 'string' || !UUID.test(body.requestId)) fail(400, 'Некорректный requestId', 'VALIDATION');
  if (!Number.isSafeInteger(body.size) || body.size < 0) fail(400, 'Некорректный размер файла', 'VALIDATION');
  if (body.size === 0) fail(400, 'Файл пустой — выберите другой', 'EMPTY');
  if (body.size > maxFile) fail(413, `Файл больше ${Math.round(maxFile / 1024 / 1024)} МБ — выберите файл поменьше`, 'TOO_LARGE');
  if (typeof body.sha256 !== 'string' || !SHA256.test(body.sha256)) fail(400, 'Некорректный хеш файла', 'VALIDATION');
  const name = displayName(body.name);
  if (typeof body.caption !== 'string') fail(400, 'Подпись должна быть строкой', 'VALIDATION');
  if (body.caption.length > MAX_CAPTION) fail(400, `Подпись длиннее ${MAX_CAPTION} символов — сократите её`, 'TOO_LONG');
  if (CONTROL.test(body.caption)) fail(400, 'В подписи есть служебные символы', 'VALIDATION');
  return Object.freeze({ requestId: body.requestId, name, size: body.size, sha256: body.sha256, caption: body.caption.trim() ? body.caption : '' });
}
const fingerprintOf = (target, input) => sha256Text(JSON.stringify({ type: 'file', target, name: input.name, size: input.size, sha256: input.sha256, caption: input.caption }));

/* ---------- тип, показ и метод Telegram ---------- */
function kindOfType(type) {
  if (IMAGE_TYPES.has(type)) return 'photo';
  if (AUDIO_TYPES.has(type)) return 'audio';
  if (VIDEO_TYPES.has(type)) return 'video';
  return 'document';
}
/* Размеры растра из заголовка (PNG IHDR, JPEG SOFn); не распознано — null (тогда только sendDocument). */
function imageSize(bytes, type) {
  const dims = (width, height) => (width > 0 && height > 0 ? { width, height } : null);
  if (!Buffer.isBuffer(bytes)) return null;
  if (type === 'image/png') {
    if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
    return dims(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (type !== 'image/jpeg') return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return null;
      return dims(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    offset += 2 + length;
  }
  return null;
}
/* sendPhoto — только проверенный по байтам JPEG/PNG в пределах фото Telegram; всё прочее — sendDocument тех же байтов.
   Метод выбирается до первой отправки и записывается в задание: после неизвестного исхода другой метод не пробуется. */
function telegramMethodOf({ type, size, width, height }) {
  const photo = (type === 'image/jpeg' || type === 'image/png') && Number.isSafeInteger(size) && size > 0 && size <= PHOTO_MAX_BYTES
    && Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && width + height <= PHOTO_MAX_SIDES && Math.max(width / height, height / width) <= PHOTO_MAX_RATIO;
  return photo ? 'sendPhoto' : 'sendDocument';
}
/* Подпись копии: текст ≤ 1024 — подпись файла (один раз), шапка источника — отдельным sendMessage; длиннее — шапка и
   текст одним прежним текстовым заданием (делится как обычно), файл без подписи. Ничего не обрезается и не дублируется. */
function captionPlan(body, { header = '' } = {}) {
  const value = String(body || '');
  if (value.length <= MEDIA_CAPTION) return Object.freeze({ caption: value, text: header });
  return Object.freeze({ caption: '', text: header ? `${header}\n${value}` : value });
}

const DDL = `
  CREATE TABLE IF NOT EXISTS chat_web_uploads (
    upload_uuid TEXT PRIMARY KEY,
    disk_name TEXT NOT NULL UNIQUE,
    site TEXT NOT NULL, company_code TEXT NOT NULL, bot_key TEXT,
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('web','owner')),
    actor_ref TEXT NOT NULL, owner_session_version INTEGER,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK(target_kind IN ('thread','legacy')),
    thread_id INTEGER, dialog_id INTEGER,
    caption TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
    declared_size INTEGER NOT NULL CHECK(declared_size > 0), declared_sha256 TEXT NOT NULL,
    actual_size INTEGER, actual_sha256 TEXT, content_type TEXT, presentation TEXT, kind TEXT, width INTEGER, height INTEGER,
    state TEXT NOT NULL CHECK(state IN ('prepared','receiving','ready','committed','rejected','expired')),
    claim TEXT, claim_until TEXT, error TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, committed_at TEXT,
    thread_message_id INTEGER UNIQUE REFERENCES chat_thread_messages(id),
    legacy_message_id INTEGER UNIQUE REFERENCES client_dialog_messages(id),
    UNIQUE(actor_kind, actor_ref, request_id),
    CHECK((target_kind = 'thread' AND thread_id IS NOT NULL AND dialog_id IS NULL) OR (target_kind = 'legacy' AND dialog_id IS NOT NULL AND thread_id IS NULL)),
    CHECK(CASE WHEN state = 'committed' THEN (thread_message_id IS NULL) <> (legacy_message_id IS NULL)
      ELSE thread_message_id IS NULL AND legacy_message_id IS NULL END),
    CHECK(thread_message_id IS NULL OR target_kind = 'thread'),
    CHECK(legacy_message_id IS NULL OR target_kind = 'legacy')
  );
  CREATE INDEX IF NOT EXISTS chat_web_uploads_actor ON chat_web_uploads(actor_kind, actor_ref, state);
  CREATE INDEX IF NOT EXISTS chat_web_uploads_state ON chat_web_uploads(state, expires_at);
`;

/**
 * Журнал загрузок. Создаётся один раз серверным адаптером ПОСЛЕ таблиц ядра чата и прежних диалогов (ссылки FK).
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db  та же центральная SQLite
 * @param {(fn:Function)=>any} o.transact             та же общая транзакция хоста (вложенный вызов — внутри неё)
 * @param {object} o.storage                          createMediaStorage принятого D приватного каталога
 * @param {() => number} o.otherBytes                 L + D: байты прежних диалогов и вложений Telegram чата сайта
 */
function createWebUploads({ db, transact, storage, now = Date.now, maxFile = MAX_UPLOAD, maxStorage = mediaKit.DEFAULT_MAX_STORAGE,
  otherBytes = () => 0, randomUUID = () => crypto.randomUUID(), ttlMs = UPLOAD_TTL, claimMs = CLAIM_TTL } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof transact !== 'function') throw new TypeError('createWebUploads: нужны db и общая транзакция');
  if (!storage || typeof storage.put !== 'function' || typeof storage.open !== 'function' || typeof storage.inspect !== 'function') {
    throw new TypeError('createWebUploads: нужно приватное хранилище D');
  }
  const limitFile = Number.isSafeInteger(maxFile) && maxFile > 0 ? Math.min(maxFile, MAX_UPLOAD) : MAX_UPLOAD;
  const limitStorage = Number.isSafeInteger(maxStorage) && maxStorage >= 0 ? maxStorage : mediaKit.DEFAULT_MAX_STORAGE;
  db.exec(DDL);
  const tx = transact;
  const stamp = (at = now()) => new Date(at).toISOString();
  const rowOf = (uuid) => (typeof uuid === 'string' && UUID.test(uuid) ? db.prepare('SELECT * FROM chat_web_uploads WHERE upload_uuid=?').get(uuid) || null : null);
  const safeOther = () => { try { const n = Number(otherBytes()); return Number.isFinite(n) && n > 0 ? n : 0; } catch (_) { return 0; } };

  /* E: незавершённая — max(заявленный резерв, фактические байты); завершённая, отклонённая, истёкшая — фактически
     записанные байты (у отклонённой без файла — 0). Резерв заменяется своими фактическими байтами, а не прибавляется. */
  function bytes(exceptUuid = '') {
    const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN state IN ('prepared','receiving','ready')
        THEN MAX(declared_size, COALESCE(actual_size,0)) ELSE COALESCE(actual_size,0) END),0) AS n
      FROM chat_web_uploads WHERE upload_uuid<>?`).get(String(exceptUuid || ''));
    return Number(row.n) || 0;
  }
  function stateOf(row, at = now()) {
    if (['committed', 'rejected', 'expired'].includes(row.state)) return row.state;
    if (!(Date.parse(row.expires_at) > at)) return 'expired';
    if (row.state === 'receiving') return Date.parse(row.claim_until || '') > at ? 'receiving' : 'uncertain';
    return row.state;
  }
  const targetOf = (row) => (row.target_kind === 'thread' ? `thread:${row.thread_id}` : `legacy:${row.dialog_id}`);
  /* Сведения о загрузке для её автора: без имени на диске, путей и номеров сессий. sha256 — заявленный самим автором
     (по нему страница сверяет повторно выбранный файл). */
  function view(row) {
    const state = stateOf(row);
    return Object.freeze({ ref: uploadRef(row.upload_uuid), requestId: row.request_id, target: targetOf(row), state, name: row.name,
      size: row.declared_size, sha256: row.declared_sha256, caption: row.caption, expiresAt: row.expires_at,
      error: state === 'committed' ? '' : row.error || '' });
  }
  /* Своя загрузка: тот же автор, та же цель (вид и номер), тот же сайт и компания. Чужая — как несуществующая. */
  function scoped(uuid, scope) {
    const row = rowOf(uuid);
    const targetId = scope && (scope.targetKind === 'thread' ? row && row.thread_id : row && row.dialog_id);
    if (!row || !scope || row.actor_kind !== scope.actorKind || row.actor_ref !== scope.actorRef || row.target_kind !== scope.targetKind
      || targetId !== scope.targetId || row.site !== scope.site || row.company_code !== scope.companyCode) fail(404, 'Загрузка не найдена', 'NOT_FOUND');
    return row;
  }
  // Истёкшая незавершённая: учёт — по тому, что фактически лежит под заранее назначенным именем (файл не удаляется).
  function expireRow(row) {
    let found = null;
    try { found = storage.inspect(row.disk_name); } catch (_) { found = { size: row.declared_size, sha256: null }; }
    db.prepare(`UPDATE chat_web_uploads SET state='expired', actual_size=?, actual_sha256=COALESCE(?, actual_sha256), claim=NULL, claim_until=NULL,
      error=?, updated_at=? WHERE upload_uuid=? AND state IN ('prepared','receiving','ready')`)
      .run(found ? found.size : null, found ? found.sha256 : null, 'Срок загрузки истёк', stamp(), row.upload_uuid);
  }
  function expireStale(limit = 5) {
    const rows = db.prepare(`SELECT * FROM chat_web_uploads WHERE state IN ('prepared','receiving','ready') AND expires_at<=? ORDER BY expires_at LIMIT ?`).all(stamp(), limit);
    for (const row of rows) expireRow(row);
    return rows.length;
  }
  const requestUsed = (actorKind, actorRef, requestId) => Boolean(db.prepare('SELECT 1 FROM chat_web_uploads WHERE actor_kind=? AND actor_ref=? AND request_id=?')
    .get(actorKind, actorRef, String(requestId || '').toLowerCase()));

  /* Подготовка — в транзакции вызывающего, после его проверки доступа и цели. scope: { site, companyCode, botKey,
     actorKind, actorRef, ownerSessionVersion, targetKind, targetId }. crossUsed() — занят ли requestId текстовой квитанцией
     этого автора (общее пространство requestId текста и файла). */
  function prepare({ scope, input, crossUsed = () => false }) {
    const target = scope.targetKind === 'thread' ? `thread:${scope.targetId}` : `legacy:${scope.targetId}`;
    const fingerprint = fingerprintOf(target, input);
    const existing = db.prepare('SELECT * FROM chat_web_uploads WHERE actor_kind=? AND actor_ref=? AND request_id=?').get(scope.actorKind, scope.actorRef, input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.site !== scope.site || existing.company_code !== scope.companyCode) {
        fail(409, 'Этот requestId уже использован для другой отправки', 'REQUEST_MISMATCH');
      }
      return { row: existing, duplicate: true };
    }
    if (crossUsed()) fail(409, 'Этот requestId уже использован для другой отправки', 'REQUEST_MISMATCH');
    expireStale();
    const active = db.prepare(`SELECT count(*) AS n FROM chat_web_uploads WHERE actor_kind=? AND actor_ref=? AND state IN ('prepared','receiving','ready') AND expires_at>?`)
      .get(scope.actorKind, scope.actorRef, stamp()).n;
    if (active >= ACTIVE_PER_ACTOR) fail(429, 'Слишком много незавершённых загрузок — проверьте прежние отправки или подождите', 'RATE_LIMITED');
    if (input.size > limitFile) fail(413, `Файл больше ${Math.round(limitFile / 1024 / 1024)} МБ — выберите файл поменьше`, 'TOO_LARGE');
    if (safeOther() + bytes() + input.size > limitStorage) fail(409, 'Хранилище файлов заполнено: файл не сохранён', 'QUOTA_EXCEEDED');
    const uuid = String(randomUUID()), disk = String(randomUUID());
    if (!UUID.test(uuid) || !UUID.test(disk) || uuid === disk) fail(500, 'Не удалось создать загрузку', 'RANDOM');
    const at = stamp();
    db.prepare(`INSERT INTO chat_web_uploads(upload_uuid,disk_name,site,company_code,bot_key,actor_kind,actor_ref,owner_session_version,request_id,fingerprint,
      target_kind,thread_id,dialog_id,caption,name,declared_size,declared_sha256,state,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?)`).run(uuid, disk, scope.site, scope.companyCode, scope.botKey || null, scope.actorKind,
      scope.actorRef, scope.ownerSessionVersion ?? null, input.requestId, fingerprint, scope.targetKind,
      scope.targetKind === 'thread' ? scope.targetId : null, scope.targetKind === 'legacy' ? scope.targetId : null,
      input.caption, input.name, input.size, input.sha256, stamp(now() + ttlMs), at, at);
    return { row: rowOf(uuid), duplicate: false };
  }

  /* Начало приёма байтов (своя транзакция; доступ вызывающий проверил до этого). Возвращает заявленный размер — предел
     чтения тела. Уже завершённая — тело сверяется с сохранёнными байтами (повтор потерянного ответа). Идущий приём —
     409 IN_PROGRESS; истёкшая — 410; отклонённая — 409. */
  function begin(uuid, scope) {
    const outcome = tx(() => {
      const row = scoped(uuid, scope);
      const state = stateOf(row);
      if (state === 'committed') return { committed: true, declaredSize: row.actual_size || row.declared_size };
      if (state === 'expired') { expireRow(row); return { expired: true }; }
      if (state === 'rejected') return { rejected: true };
      if (state === 'receiving') return { busy: true };
      const claim = crypto.randomBytes(16).toString('hex');
      db.prepare(`UPDATE chat_web_uploads SET state=CASE WHEN state='ready' THEN 'ready' ELSE 'receiving' END, claim=?, claim_until=?, updated_at=? WHERE upload_uuid=?`)
        .run(claim, stamp(now() + claimMs), stamp(), row.upload_uuid);
      return { claim, declaredSize: row.declared_size, ready: row.state === 'ready' };
    });
    if (outcome.expired) fail(410, 'Срок загрузки истёк — выберите файл и отправьте заново', 'EXPIRED');
    if (outcome.rejected) fail(409, 'Эта загрузка отклонена — выберите файл и отправьте заново', 'REJECTED');
    if (outcome.busy) fail(409, 'Этот файл сейчас загружается — проверьте отправку чуть позже', 'IN_PROGRESS');
    return outcome;
  }
  // Сбой до готовности: приём освобождается, запись снова ждёт тех же байтов; учёт (резерв) не меняется.
  function release(uuid, claim, error) {
    try {
      tx(() => db.prepare(`UPDATE chat_web_uploads SET state='prepared', claim=NULL, claim_until=NULL, error=?, updated_at=?
        WHERE upload_uuid=? AND state='receiving' AND claim=?`).run(String(error || '').slice(0, 200), stamp(), uuid, claim));
    } catch (_) { /* резерв остаётся с запасом; запись дождётся срока */ }
  }
  /* Байты прочитаны (вызывающий читал ровно до заявленного размера + 1). authorize() — свежая проверка доступа (после
     await): перед работой с диском и внутри итоговой транзакции. commit(row) — в той же транзакции создаёт настоящее
     сообщение, связывает его (link) и ставит прежние задания; receipt(row) — квитанция уже завершённой записи. */
  function finish({ uuid, scope, claim = null, bytes: body, authorize, commit, receipt }) {
    if (!Buffer.isBuffer(body)) fail(400, 'Нет байтов файла', 'EMPTY');
    const current = tx(() => scoped(uuid, scope));
    const digest = body.length ? mediaKit.sha256(body) : '';
    if (stateOf(current) === 'committed') {
      if (body.length !== current.actual_size || digest !== current.actual_sha256) fail(409, 'Под этой загрузкой уже сохранён другой файл', 'CONFLICT');
      return tx(() => { authorize(); return { duplicate: true, ...receipt(scoped(uuid, scope)) }; });
    }
    const problem = !body.length ? [400, 'Файл пустой — выберите другой', 'EMPTY']
      : body.length !== current.declared_size ? [422, 'Размер файла не совпал с выбранным — выберите тот же файл', 'SIZE_MISMATCH']
        : digest !== current.declared_sha256 ? [422, 'Файл не совпал с выбранным — выберите тот же файл', 'HASH_MISMATCH'] : null;
    if (problem) { if (claim) release(uuid, claim, problem[1]); fail(...problem); }
    if (current.state === 'ready') {
      if (digest !== current.actual_sha256) fail(409, 'Под этой загрузкой уже сохранён другой файл', 'CONFLICT');
    } else {
      tx(() => {
        const row = scoped(uuid, scope);
        if (row.state !== 'receiving' || row.claim !== claim || stateOf(row) === 'expired') fail(409, 'Загрузка изменилась — проверьте отправку', 'CLAIM');
      });
      try { authorize(); } catch (error) { release(uuid, claim, 'Доступ изменился'); throw error; }
      const type = mediaKit.sniff(body);
      const kind = kindOfType(type);
      const size = imageSize(body, type);
      let saved;
      try { saved = storage.put(current.disk_name, body); }
      catch (error) { release(uuid, claim, 'Файл не записан — повторите ту же отправку'); throw error; }
      if (saved.sha256 !== digest || saved.size !== body.length) { release(uuid, claim, 'Файл не записан'); fail(500, 'Файл не записан', 'READBACK'); }
      tx(() => {
        const row = scoped(uuid, scope);
        if (row.state !== 'receiving' || row.claim !== claim) fail(409, 'Загрузка изменилась — проверьте отправку', 'CLAIM');
        db.prepare(`UPDATE chat_web_uploads SET state='ready', actual_size=?, actual_sha256=?, content_type=?, presentation=?, kind=?, width=?, height=?,
          claim=NULL, claim_until=NULL, error='', updated_at=? WHERE upload_uuid=?`)
          .run(saved.size, saved.sha256, type || 'application/octet-stream', mediaKit.presentationOf(kind, type), kind,
            size ? size.width : null, size ? size.height : null, stamp(), uuid);
      });
    }
    // Итог — одна общая транзакция: свежий доступ, срок, настоящая запись истории, связь, квитанция и задания.
    return tx(() => {
      authorize();
      const row = scoped(uuid, scope);
      const state = stateOf(row);
      if (state === 'committed') return { duplicate: true, ...receipt(row) };
      if (state === 'expired') fail(410, 'Срок загрузки истёк — файл сохранён, но сообщение не создано. Выберите файл и отправьте заново', 'EXPIRED');
      if (row.state !== 'ready') fail(409, 'Загрузка изменилась — проверьте отправку', 'CLAIM');
      return { duplicate: false, ...commit(row) };
    });
  }
  /* Связь с настоящим сообщением (в транзакции commit): ровно одна ссылка, только из готовой записи. */
  function link(uuid, { threadMessageId = null, legacyMessageId = null, ownerSessionVersion = null } = {}) {
    const changed = db.prepare(`UPDATE chat_web_uploads SET state='committed', thread_message_id=?, legacy_message_id=?, committed_at=?, updated_at=?,
      owner_session_version=COALESCE(?, owner_session_version), claim=NULL, claim_until=NULL WHERE upload_uuid=? AND state='ready'`)
      .run(threadMessageId, legacyMessageId, stamp(), stamp(), ownerSessionVersion, uuid).changes;
    if (Number(changed) !== 1) fail(409, 'Загрузка изменилась — проверьте отправку', 'CLAIM');
    return rowOf(uuid);
  }
  /* Только чтение: состояние и (после завершения) точная квитанция. Ничего не завершает и не меняет. */
  function status(uuid, scope, receipt) {
    const row = scoped(uuid, scope);
    return { ok: true, upload: view(row), ...(stateOf(row) === 'committed' ? receipt(row) : {}) };
  }

  /* ---------- чтение сохранённого файла ---------- */
  const committedRow = (uuid) => { const row = rowOf(uuid); return row && row.state === 'committed' ? row : null; };
  const forThreadMessage = (messageId) => db.prepare("SELECT * FROM chat_web_uploads WHERE thread_message_id=? AND state='committed'").get(messageId) || null;
  const forLegacyMessage = (messageId) => db.prepare("SELECT * FROM chat_web_uploads WHERE legacy_message_id=? AND state='committed'").get(messageId) || null;
  // Публичные сведения о файле сообщения — та же форма, что у вложений D (ref другого вида), без имени на диске и хеша.
  function attachmentView(row) {
    return Object.freeze({ ref: uploadRef(row.upload_uuid), kind: row.kind || 'document', mime: row.content_type || 'application/octet-stream',
      name: mediaKit.downloadName(row.name, row.kind, row.content_type), size: row.actual_size, storageStatus: 'stored', error: '',
      presentation: row.presentation || 'download' });
  }
  /* Сведения для защищённой выдачи: только завершённая загрузка именно этой цели (чат или диалог), только серверу. */
  function fileMeta(uuid, { targetKind, targetId, site, companyCode }) {
    const row = committedRow(uuid);
    const id = row && (targetKind === 'thread' ? row.thread_id : row.dialog_id);
    if (!row || row.target_kind !== targetKind || id !== targetId || row.site !== site || row.company_code !== companyCode
      || !SHA256.test(String(row.actual_sha256 || '')) || !Number.isSafeInteger(row.actual_size)) fail(404, 'Файл не найден', 'NOT_FOUND');
    return Object.freeze({ id: row.upload_uuid, diskName: row.disk_name, size: row.actual_size, sha256: row.actual_sha256,
      contentType: row.content_type || 'application/octet-stream', presentation: row.presentation || 'download',
      name: row.name, kind: row.kind || 'document', threadMessageId: row.thread_message_id, legacyMessageId: row.legacy_message_id });
  }
  const open = (meta) => storage.open(meta.diskName, meta.size, meta.sha256);
  /* Байты для моста: тот же проверенный дескриптор (обычный файл, размер и хеш записи), чтение ограничено размером. */
  function readSource(row) {
    const opened = storage.open(row.disk_name, row.actual_size, row.actual_sha256);
    try {
      const buffer = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < opened.size) {
        const read = fs.readSync(opened.fd, buffer, offset, opened.size - offset, offset);
        if (read <= 0) break;
        offset += read;
      }
      if (offset !== opened.size || mediaKit.sha256(buffer) !== row.actual_sha256) fail(404, 'Файл не найден', 'MISSING');
      return buffer;
    } finally { try { fs.closeSync(opened.fd); } catch (_) { /* уже закрыт */ } }
  }

  /* ---------- часть задания очереди ---------- */
  /* Часть файла для прежней очереди: метод и сведения о байтах — только из журнала, адресат — проверенный вызывающим.
     В части нет URL, пути, имени на диске и Telegram file_id: мост получает байты по фиксированному внутреннему маршруту. */
  function filePart(row, { chatId, caption = '' }) {
    const method = telegramMethodOf({ type: row.content_type, size: row.actual_size, width: row.width, height: row.height });
    return { method, params: { chat_id: chatId, ...(caption ? { caption } : {}) },
      upload: { ref: uploadRef(row.upload_uuid), size: row.actual_size, sha256: row.actual_sha256,
        name: mediaKit.downloadName(row.name, row.kind, row.content_type), type: row.content_type || 'application/octet-stream' } };
  }
  /* Часть задания соответствует завершённой загрузке: тот же метод (из журнала), размер, хеш, имя и тип; подпись ≤ 1024. */
  function partMatches(part, row) {
    if (!part || !row || row.state !== 'committed' || !Object.hasOwn(FILE_METHODS, part.method) || !part.upload || typeof part.upload !== 'object') return false;
    const expected = filePart(row, { chatId: part.params && part.params.chat_id, caption: '' });
    const caption = part.params && part.params.caption;
    const keys = Object.keys(part.params || {}).filter((key) => key !== 'disable_notification').sort().join(',');
    return part.method === expected.method && part.upload.ref === expected.upload.ref && part.upload.size === expected.upload.size
      && part.upload.sha256 === expected.upload.sha256 && part.upload.name === expected.upload.name && part.upload.type === expected.upload.type
      && (caption === undefined || (typeof caption === 'string' && caption.length > 0 && caption.length <= MEDIA_CAPTION))
      && (keys === 'chat_id' || keys === 'caption,chat_id');
  }

  return Object.freeze({ bytes, prepare, begin, finish, link, status, release, view, stateOf, requestUsed, expireStale,
    committedRow, forThreadMessage, forLegacyMessage, attachmentView, fileMeta, open, readSource, filePart, partMatches,
    maxFile: limitFile, row: rowOf });
}

module.exports = { createWebUploads, parseUploadRef, uploadRef, parseUploadPath, uploadPath, prepareInput, displayName, fingerprintOf,
  kindOfType, imageSize, telegramMethodOf, captionPlan, UPLOAD_DDL: DDL, FILE_METHODS, MAX_UPLOAD, MAX_CAPTION, MEDIA_CAPTION,
  PHOTO_MAX_BYTES, UPLOAD_TTL, ACTIVE_PER_ACTOR };
