'use strict';
/* Отдельный доступ к аналитике. Ключи здесь искусственные, сети нет. */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createSocialAnalyticsCredentials} = require('./social-analytics-credentials');

const KEY = 'TEST_ONLY_ANALYTICS_STORAGE_KEY_NOT_LIVE';
const SECRET = 'TEST_ONLY_ANALYTICS_TOKEN_abcdef123456';
const OTHER = 'TEST_ONLY_ANALYTICS_TOKEN_zzzzzz999999';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const api = createSocialAnalyticsCredentials(db, {apiKey: KEY, now: () => Date.parse('2026-09-29T10:00:00Z')});
  return {db, api};
}

test('доступ аналитики хранится зашифрованным и наружу не выходит ни в каком виде', (t) => {
  const f = fixture(t);
  const saved = f.api.save('alvi', 'onlypult_analytics', {revision: 0, credential: SECRET}, {userId: 1, userName: 'Влад'});
  assert.equal(saved.configured, true);
  assert.equal(saved.status, 'unchecked');
  assert.equal(saved.revision, 1);
  assert.equal(JSON.stringify(saved).includes(SECRET), false, 'секрет не попадает в DTO');
  const stored = f.db.prepare('SELECT encrypted_credential FROM social_analytics_credentials').get().encrypted_credential;
  assert.equal(stored.includes(SECRET), false, 'секрет не лежит в базе открытым текстом');
  assert.equal(f.api.resolve('alvi').credential, SECRET, 'резолвер получает ключ');
  assert.equal(JSON.stringify(f.api.get('alvi')).includes(SECRET), false);
  assert.equal(JSON.stringify(f.api.connectionRevision('alvi')).includes(SECRET), false);
});

test('это не подключение публикаций: своя таблица и свой конверт', (t) => {
  const f = fixture(t);
  f.api.save('alvi', 'onlypult_analytics', {revision: 0, credential: SECRET});
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  assert.deepEqual(tables, ['social_analytics_credentials'], 'модуль не создаёт и не трогает таблицы публикаций');
  // Конверт привязан к компании и источнику: чужой AAD его не расшифрует.
  const row = f.db.prepare('SELECT encrypted_credential FROM social_analytics_credentials').get();
  f.db.prepare("INSERT INTO social_analytics_credentials(company_code,provider,encrypted_credential,revision,status,updated_at) VALUES('avokado','onlypult_analytics',?,1,'unchecked','2026-09-29T10:00:00Z')")
    .run(row.encrypted_credential);
  const alien = f.api.resolve('avokado');
  assert.equal(alien.credential, null);
  assert.equal(alien.unreadable, true, 'ключ другой компании не читается');
});

test('пустой ввод сохраняет прежний доступ, новый сбрасывает проверку, удаление — отдельное действие', (t) => {
  const f = fixture(t);
  const first = f.api.save('alvi', 'onlypult_analytics', {revision: 0, credential: SECRET});
  f.api.markChecked('alvi', 'onlypult_analytics', {revision: first.revision, status: 'connected'});
  assert.equal(f.api.get('alvi').checked, true);
  // Пустой ввод: ключ цел, но проверка к новой ревизии уже не относится.
  const kept = f.api.save('alvi', 'onlypult_analytics', {revision: first.revision, credential: ''});
  assert.equal(kept.configured, true);
  assert.equal(f.api.resolve('alvi').credential, SECRET, 'прежний ключ не стёрт');
  assert.equal(kept.checked, false, 'проверка прежней ревизии новую не подтверждает');
  // Новый ключ сбрасывает состояние проверки целиком.
  const replaced = f.api.save('alvi', 'onlypult_analytics', {revision: kept.revision, credential: OTHER});
  assert.equal(replaced.status, 'unchecked');
  assert.equal(replaced.checkedRevision, null);
  assert.equal(f.api.resolve('alvi').credential, OTHER);
  // Удалить доступ можно только явно.
  const removed = f.api.remove('alvi', 'onlypult_analytics', {revision: replaced.revision});
  assert.equal(removed.configured, false);
  assert.equal(f.api.resolve('alvi'), null);
});

test('устаревшая ревизия, чужой источник и мусорные поля отклоняются', (t) => {
  const f = fixture(t);
  const saved = f.api.save('alvi', 'onlypult_analytics', {revision: 0, credential: SECRET});
  assert.throws(() => f.api.save('alvi', 'onlypult_analytics', {revision: 0, credential: OTHER}),
    (error) => error.status === 409 && error.code === 'REVISION_CONFLICT');
  assert.throws(() => f.api.save('alvi', 'publishing', {revision: saved.revision, credential: OTHER}), (error) => error.status === 400);
  assert.throws(() => f.api.save('alvi', 'onlypult_analytics', {revision: saved.revision, credential: SECRET, target: 'x'}), (error) => error.status === 400);
  assert.throws(() => f.api.save('alvi', 'onlypult_analytics', {revision: saved.revision, credential: 'с пробелом'}), (error) => error.status === 400);
  assert.throws(() => f.api.save('нет такой', 'onlypult_analytics', {revision: 0, credential: SECRET}), (error) => error.status === 404);
  // Результат проверки устаревшей ревизии не применяется.
  const late = f.api.markChecked('alvi', 'onlypult_analytics', {revision: saved.revision - 1, status: 'connected'});
  assert.equal(late.applied, false);
  assert.equal(f.api.get('alvi').checked, false);
});

test('компании не смешиваются даже при одном аккаунте владельца', (t) => {
  const f = fixture(t);
  f.api.save('alvi', 'onlypult_analytics', {revision: 0, credential: SECRET});
  f.api.save('avokado', 'onlypult_analytics', {revision: 0, credential: OTHER});
  assert.equal(f.api.resolve('alvi').credential, SECRET);
  assert.equal(f.api.resolve('avokado').credential, OTHER);
  assert.notEqual(f.db.prepare("SELECT encrypted_credential FROM social_analytics_credentials WHERE company_code='alvi'").get().encrypted_credential,
    f.db.prepare("SELECT encrypted_credential FROM social_analytics_credentials WHERE company_code='avokado'").get().encrypted_credential);
});
