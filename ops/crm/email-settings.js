'use strict';

const crypto = require('node:crypto');
const {createEmailNotifications, emailErrorCode} = require('./email-notifications');
const PROVIDERS = Object.freeze({yandex: 'smtp.yandex.ru', mailru: 'smtp.mail.ru', gmail: 'smtp.gmail.com'});
const PURPOSE = Buffer.from('synapse/crm/email-settings/v1');
const FIELDS = ['provider', 'user', 'password', 'alviRecipient', 'avokadoRecipient'];
const envValue = (env, name, fallback = '') => (env[name] === undefined ? fallback : env[name]).trim();
const fail = message => { throw Object.assign(new Error(message), {status: 400}); };

function mailbox(value, required = false) {
  if (typeof value !== 'string' || value.length > 512) fail('Укажите один корректный почтовый адрес в каждом поле');
  const clean = value.trim();
  if (!clean && !required) return '';
  const parts = clean.split('@');
  if (clean.length > 254 || parts.length !== 2 || parts[0].length > 64 ||
      !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(parts[0]) ||
      !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(parts[1])) {
    fail('Укажите один корректный почтовый адрес в каждом поле');
  }
  return clean;
}
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !FIELDS.includes(key)) ||
      FIELDS.filter(key => key !== 'password').some(key => !Object.hasOwn(body, key))) {
    fail('Переданы некорректные поля настроек почты');
  }
  if (typeof body.provider !== 'string' || !Object.hasOwn(PROVIDERS, body.provider.trim())) fail('Выберите Яндекс, Mail.ru или Google Workspace / Gmail');
  const config = {provider: body.provider.trim(), user: mailbox(body.user, true),
    alviRecipient: mailbox(body.alviRecipient), avokadoRecipient: mailbox(body.avokadoRecipient)};
  if (Object.hasOwn(body, 'password') && (typeof body.password !== 'string' || body.password.length > 512 || /[\r\n\x00]/.test(body.password))) {
    fail('Пароль приложения должен быть строкой не длиннее 512 символов без переноса строк');
  }
  config.password = (body.password || '').trim();
  return config;
}
function settingsEnvironment(config, environment) {
  return {LEADS_SMTP_HOST: PROVIDERS[config.provider], LEADS_SMTP_PORT: '465',
    LEADS_SMTP_USER: config.user, LEADS_SMTP_PASSWORD: config.password, LEADS_MAIL_FROM: config.user,
    LEADS_NOTIFY_EMAIL: envValue(environment, 'LEADS_NOTIFY_EMAIL'), LEADS_NOTIFY_EMAIL_ALVI: config.alviRecipient,
    LEADS_NOTIFY_EMAIL_AVOKADO: config.avokadoRecipient};
}
function disabledEnvironment() {
  return {LEADS_SMTP_HOST: '', LEADS_SMTP_PORT: '465', LEADS_SMTP_USER: '', LEADS_SMTP_PASSWORD: '',
    LEADS_MAIL_FROM: '', LEADS_NOTIFY_EMAIL: '', LEADS_NOTIFY_EMAIL_ALVI: '', LEADS_NOTIFY_EMAIL_AVOKADO: ''};
}

function createEmailSettings(db, {apiKey, environment = process.env, now = Date.now, createTransport} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Ключ сервиса для хранения настроек почты отсутствует');
  // A versioned authenticated envelope protects a database-only copy. The service
  // key remains outside SQLite; replacing it requires the owner to enter a new password.
  db.exec(`CREATE TABLE IF NOT EXISTS email_settings (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL, encrypted_json TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const select = db.prepare('SELECT revision, encrypted_json, updated_at FROM email_settings WHERE singleton = 1');
  const upsert = db.prepare(`INSERT INTO email_settings(singleton,revision,encrypted_json,updated_at) VALUES(1,1,?,?)
    ON CONFLICT(singleton) DO UPDATE SET revision=email_settings.revision+1,
      encrypted_json=excluded.encrypted_json, updated_at=excluded.updated_at`);
  const deriveKey = salt => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey), salt, PURPOSE, 32));
  function encrypt(config) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = deriveKey(salt);
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(PURPOSE);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
      return JSON.stringify({version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64')});
    } finally { key.fill(0); }
  }
  function decrypt(encrypted) {
    const envelope = JSON.parse(encrypted);
    if (envelope.version !== 1) throw new Error('Unsupported settings envelope');
    const salt = Buffer.from(envelope.salt, 'base64'), iv = Buffer.from(envelope.iv, 'base64'),
      tag = Buffer.from(envelope.tag, 'base64');
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid settings envelope');
    const key = deriveKey(salt);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(PURPOSE); decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      const config = validate(JSON.parse(plain.toString('utf8')));
      if (!config.password) throw new Error('Missing stored password');
      return config;
    } finally { key.fill(0); }
  }
  function readState() {
    const row = select.get();
    if (row) {
      const token = `${row.revision}:${row.encrypted_json}`;
      try {
        const config = decrypt(row.encrypted_json);
        return {token, config, environment: settingsEnvironment(config, environment), public: {
          provider: config.provider, user: config.user, alviRecipient: config.alviRecipient,
          avokadoRecipient: config.avokadoRecipient, passwordConfigured: true,
          source: 'cabinet', updatedAt: row.updated_at, needsPassword: false
        }};
      } catch {
        // No fallback to environment and no deletion of unreadable ciphertext.
        return {token, config: null, environment: disabledEnvironment(), public: {
          provider: 'yandex', user: '', alviRecipient: '', avokadoRecipient: '',
          passwordConfigured: false, source: 'cabinet', updatedAt: row.updated_at, needsPassword: true
        }};
      }
    }
    const host = envValue(environment, 'LEADS_SMTP_HOST', 'smtp.yandex.ru');
    const provider = Object.keys(PROVIDERS).find(key => PROVIDERS[key] === host);
    const user = envValue(environment, 'LEADS_SMTP_USER'), password = envValue(environment, 'LEADS_SMTP_PASSWORD');
    return {token: 'environment', config: null, environment, public: {
      provider: provider || 'yandex', user,
      alviRecipient: envValue(environment, 'LEADS_NOTIFY_EMAIL_ALVI'), avokadoRecipient: envValue(environment, 'LEADS_NOTIFY_EMAIL_AVOKADO'),
      passwordConfigured: Boolean(password), source: user || password ? 'environment' : 'none', updatedAt: null,
      needsPassword: true // The first cabinet save never silently copies an environment secret.
    }};
  }
  let activeToken, activeNotifier;
  function notifier() {
    const state = readState();
    if (state.token !== activeToken) {
      // Lazy construction: GET and PUT cannot open SMTP or send a message.
      const next = createEmailNotifications(state.environment, {info() {}}, createTransport);
      activeNotifier = next; activeToken = state.token;
    }
    return activeNotifier;
  }
  function save(body) {
    const config = validate(body), previous = readState();
    if (!config.password) {
      if (!previous.config || previous.config.provider !== config.provider || previous.config.user !== config.user) {
        fail('Введите пароль приложения для выбранного отправителя');
      }
      config.password = previous.config.password;
    }
    try { upsert.run(encrypt(config), new Date(now()).toISOString()); }
    catch { throw Object.assign(new Error('Не удалось сохранить настройки почты'), {status: 500}); }
    // Existing sends retain their original notifier reference until they finish.
    activeToken = undefined; activeNotifier = undefined;
    return readState().public;
  }
  async function check() {
    try {
      const state = readState();
      // The owner-facing check supports only the fixed provider TLS endpoints.
      if (!Object.values(PROVIDERS).includes(envValue(state.environment, 'LEADS_SMTP_HOST', 'smtp.yandex.ru')) ||
          envValue(state.environment, 'LEADS_SMTP_PORT', '465') !== '465') return {ok: false, code: 'SMTP_NOT_CONFIGURED'};
      const current = notifier();
      if (!current.enabled) return {ok: false, code: 'SMTP_NOT_CONFIGURED'};
      return await current.verify() ? {ok: true} : {ok: false, code: 'SMTP_CONNECTION'};
    } catch (error) { return {ok: false, code: emailErrorCode(error)}; }
  }
  return {getPublic: () => readState().public, getEnvironment: () => readState().environment, save, check,
    notifications: {notifyLead: (lead, notification) => notifier().notifyLead(lead, notification)}};
}

module.exports = {createEmailSettings};
