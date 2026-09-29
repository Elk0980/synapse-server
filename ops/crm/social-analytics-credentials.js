'use strict';
/* Отдельный доступ к аналитике соцсетей. Это НЕ подключение публикаций: своя таблица,
   свой ключ шифрования (собственный HKDF/AAD namespace) и своя ревизия. Модуль ничего
   не знает о autoposting_channels и никогда их не читает и не меняет — иначе ключ публикаций
   и ключ аналитики стали бы одним доступом, а отзыв одного молча отзывал бы другой.

   Наружу отдаются только configured/status/revision. Сам credential не покидает модуль:
   его получает только резолвер, который вызывает коллектор. */
const crypto = require('node:crypto');

const PROVIDERS = Object.freeze({onlypult_analytics: 'Onlypult Analytics'});
const STATUSES = Object.freeze(['not_configured', 'unchecked', 'connected', 'error']);
const MAX_CREDENTIAL = 4096;

const fail = (message, status = 400, code = 'VALIDATION_ERROR') =>
  { throw Object.assign(new Error(message), {status, code}); };

const companyCode = (value) => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) fail('Компания не найдена', 404, 'NOT_FOUND');
  return value.toLowerCase();
};
const providerOf = (value) => {
  if (typeof value !== 'string' || !Object.hasOwn(PROVIDERS, value)) fail('Неизвестный источник аналитики');
  return value;
};
const revisionOf = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) fail('Укажите текущую ревизию доступа');
  return value;
};

function createSocialAnalyticsCredentials(db, {apiKey, now = () => Date.now()} = {}) {
  if (!apiKey) throw new Error('Ключ хранения доступов аналитики отсутствует');
  db.exec(`CREATE TABLE IF NOT EXISTS social_analytics_credentials (
    company_code TEXT NOT NULL COLLATE NOCASE, provider TEXT NOT NULL,
    encrypted_credential TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
    checked_revision INTEGER, status TEXT NOT NULL DEFAULT 'not_configured',
    status_code TEXT NOT NULL DEFAULT '', checked_at TEXT, updated_at TEXT NOT NULL,
    actor_id INTEGER, actor_name TEXT,
    PRIMARY KEY(company_code, provider));`);

  const stamp = () => new Date(now()).toISOString();
  /* AAD и namespace специально отличаются от публикаций: тот же серверный ключ не расшифрует
     чужой конверт, а перепутать доступ аналитики с доступом публикации нельзя даже случайно. */
  function crypt(code, provider, value, decrypt = false) {
    const aad = Buffer.from(`synapse/social-analytics/v1/${code}/${provider}`);
    const envelope = decrypt ? JSON.parse(value)
      : {v: 1, salt: crypto.randomBytes(16).toString('base64'), iv: crypto.randomBytes(12).toString('base64')};
    if (envelope.v !== 1) throw new Error('Invalid analytics credential envelope');
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey), Buffer.from(envelope.salt, 'base64'), aad, 32));
    const cipher = decrypt
      ? crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
      : crypto.createCipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    cipher.setAAD(aad);
    if (decrypt) {
      cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8');
    }
    envelope.data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
    envelope.tag = cipher.getAuthTag().toString('base64');
    return JSON.stringify(envelope);
  }

  const rowFor = (code, provider) => db.prepare(
    'SELECT * FROM social_analytics_credentials WHERE company_code=? COLLATE NOCASE AND provider=?').get(code, provider);

  /* Публичный вид доступа. Ни одного поля, по которому можно восстановить ключ:
     ни длины, ни хвоста, ни отпечатка. Только «настроен или нет» и состояние проверки. */
  const dto = (code, provider, row) => ({
    companyCode: code, provider, providerLabel: PROVIDERS[provider],
    configured: Boolean(row?.encrypted_credential),
    status: row?.status || 'not_configured',
    statusCode: row?.status_code || '',
    revision: row?.revision ?? 0,
    checkedRevision: row?.checked_revision ?? null,
    // Проверка относится к текущему ключу только если она сделана на его ревизии.
    checked: Boolean(row && row.checked_revision !== null && row.checked_revision === row.revision && row.status === 'connected'),
    checkedAt: row?.checked_at || null,
    updatedAt: row?.updated_at || null,
  });

  const get = (code, provider = 'onlypult_analytics') => {
    const current = companyCode(code), name = providerOf(provider);
    return dto(current, name, rowFor(current, name));
  };

  /* Сохранение доступа. Пустой ввод НЕ стирает ключ — он оставляет прежний: владелец,
     открывший форму и нажавший «Сохранить», не должен случайно обрубить сбор.
     Новый ключ всегда сбрасывает проверку: прежнее «подключено» к нему не относится.
     Чтобы убрать доступ, есть отдельное действие remove. */
  function save(code, provider, body, actor = {}) {
    const current = companyCode(code), name = providerOf(provider);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Проверьте поля доступа');
    const keys = Object.keys(body).filter((key) => !['revision', 'credential'].includes(key));
    if (keys.length) fail(`Неизвестное поле доступа «${keys[0]}»`);
    revisionOf(body.revision);
    const row = rowFor(current, name);
    if ((row?.revision ?? 0) !== body.revision) fail('Доступ к аналитике изменился. Обновите страницу и повторите.', 409, 'REVISION_CONFLICT');
    const raw = body.credential === undefined || body.credential === null ? '' : body.credential;
    if (typeof raw !== 'string') fail('Ключ доступа передаётся строкой');
    const credential = raw.trim();
    if (credential.length > MAX_CREDENTIAL) fail('Ключ доступа слишком длинный');
    if (credential && /[\u0000-\u001f\u007f\s]/.test(credential)) fail('Ключ доступа не должен содержать пробелов и управляющих символов');
    if (!credential && !row?.encrypted_credential) fail('Введите ключ доступа к аналитике');
    const at = stamp();
    if (!credential) {
      // Прежний ключ и его проверка остаются как были; меняется только отметка времени и ревизия.
      db.prepare(`UPDATE social_analytics_credentials SET revision=revision+1,updated_at=?,actor_id=?,actor_name=?
        WHERE company_code=? COLLATE NOCASE AND provider=? AND revision=?`)
        .run(at, actor.userId ?? null, actor.userName ?? null, current, name, body.revision);
      /* Ревизия выросла, а проверка относилась к прежней: значит «подключено» больше
         не подтверждено текущей ревизией — это видно в dto.checked, ключ при этом цел. */
      return get(current, name);
    }
    const envelope = crypt(current, name, credential);
    db.prepare(`INSERT INTO social_analytics_credentials(company_code,provider,encrypted_credential,revision,checked_revision,status,status_code,checked_at,updated_at,actor_id,actor_name)
      VALUES(?,?,?,1,NULL,'unchecked','',NULL,?,?,?)
      ON CONFLICT(company_code,provider) DO UPDATE SET encrypted_credential=excluded.encrypted_credential,
        revision=social_analytics_credentials.revision+1,checked_revision=NULL,status='unchecked',status_code='',checked_at=NULL,
        updated_at=excluded.updated_at,actor_id=excluded.actor_id,actor_name=excluded.actor_name`)
      .run(current, name, envelope, at, actor.userId ?? null, actor.userName ?? null);
    return get(current, name);
  }

  /* Явное удаление доступа: сбор останавливается, но история измерений и доказательств
     не трогается — они остаются как есть. */
  function remove(code, provider, body, actor = {}) {
    const current = companyCode(code), name = providerOf(provider);
    revisionOf(body?.revision);
    const row = rowFor(current, name);
    if (!row) fail('Доступ не настроен', 404, 'NOT_FOUND');
    if (row.revision !== body.revision) fail('Доступ к аналитике изменился. Обновите страницу и повторите.', 409, 'REVISION_CONFLICT');
    db.prepare(`UPDATE social_analytics_credentials SET encrypted_credential='',revision=revision+1,checked_revision=NULL,
      status='not_configured',status_code='',checked_at=NULL,updated_at=?,actor_id=?,actor_name=?
      WHERE company_code=? COLLATE NOCASE AND provider=? AND revision=?`)
      .run(stamp(), actor.userId ?? null, actor.userName ?? null, current, name, body.revision);
    return get(current, name);
  }

  /* Отметка результата проверки. Пишется только если ревизия не изменилась: результат
     проверки прежнего ключа не должен подтверждать новый. */
  function markChecked(code, provider, {revision, status, code: statusCode = ''} = {}) {
    const current = companyCode(code), name = providerOf(provider);
    revisionOf(revision);
    if (!STATUSES.includes(status)) fail('Неизвестное состояние доступа');
    const changed = db.prepare(`UPDATE social_analytics_credentials
      SET status=?,status_code=?,checked_revision=CASE WHEN ?='connected' THEN revision ELSE NULL END,checked_at=?
      WHERE company_code=? COLLATE NOCASE AND provider=? AND revision=?`)
      .run(status, String(statusCode || '').slice(0, 60), status, stamp(), current, name, revision).changes;
    return {...get(current, name), applied: Boolean(changed)};
  }

  /* Резолвер для коллектора. Возвращает ключ и ревизию, на которой он взят: коллектор
     обязан сверить ревизию после сетевого вызова и не записывать результат, если она
     изменилась. Ключ в журналы, DTO и ошибки не попадает. */
  function resolve(code, provider = 'onlypult_analytics') {
    const current = companyCode(code), name = providerOf(provider);
    const row = rowFor(current, name);
    if (!row || !row.encrypted_credential) return null;
    let credential;
    try { credential = crypt(current, name, row.encrypted_credential, true); }
    catch { return {companyCode: current, provider: name, revision: row.revision, credential: null, unreadable: true}; }
    return {companyCode: current, provider: name, revision: row.revision, credential, unreadable: false};
  }

  // Отпечаток привязки без секрета: по нему запоздавший ответ отбрасывается.
  const connectionRevision = (code, provider = 'onlypult_analytics') => {
    const row = rowFor(companyCode(code), providerOf(provider));
    return row && row.encrypted_credential ? {revision: row.revision, provider} : null;
  };

  return {get, save, remove, markChecked, resolve, connectionRevision};
}

module.exports = {createSocialAnalyticsCredentials, ANALYTICS_PROVIDERS: PROVIDERS, ANALYTICS_STATUSES: STATUSES};
