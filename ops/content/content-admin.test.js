'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore, PERMISSIONS } = require('./auth-store');
const { createSiteStore } = require('./site-store');
const { hashPassword, verifyPassword } = require('./passwords');

const OWNER_PASSWORD = 'correct horse battery';
const OWNER = () => `owner:owner:${hashPassword(OWNER_PASSWORD)}`;
const database = () => new DatabaseSync(':memory:');

test('empty database imports an owner once and enables foreign keys', () => {
  const db = database();
  const store = createAuthStore(db, OWNER());
  assert.equal(store.list().length, 1);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  createAuthStore(db, `different:owner:${hashPassword('another secure pass')}`);
  assert.equal(store.list().length, 1);
});

test('existing documents survive auth schema migration', () => {
  const db = database();
  db.exec('CREATE TABLE documents (body TEXT)');
  db.prepare('INSERT INTO documents VALUES (?)').run('{"safe":true}');
  createAuthStore(db, OWNER());
  assert.equal(db.prepare('SELECT body FROM documents').get().body, '{"safe":true}');
});

test('migration without an owner rolls back without marker or users', () => {
  const db = database();
  assert.throws(() => createAuthStore(db, `editor:editor:${hashPassword('editor secure pass')}`));
  assert.equal(db.prepare('SELECT count(*) AS count FROM auth_users').get().count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM auth_meta').get().count, 0);
});

test('plaintext password is not stored and scrypt verifies safely', () => {
  const db = database();
  const store = createAuthStore(db, OWNER());
  const row = db.prepare('SELECT password_hash FROM auth_users').get();
  assert.equal(row.password_hash.includes(OWNER_PASSWORD), false);
  assert.equal(verifyPassword(OWNER_PASSWORD, row.password_hash), true);
  assert.equal(store.public(store.list()[0]).passwordHash, undefined);
});

test('legacy Tatyana receives only ALVI/Avokado editor access', () => {
  const db = database();
  const users = `${OWNER()};tatyana:editor:${hashPassword('tatyana secure pass')}`;
  const user = createAuthStore(db, users).getByLogin('TATYANA');
  assert.deepEqual(user.companyCodes.sort(), ['alvi', 'avokado']);
  assert.deepEqual(user.permissions.sort(),
    ['price.edit', 'price.view', 'site_editor.edit', 'site_editor.view', 'sites.view']);
});

test('new account is editor with default deny and duplicate login is conflict', () => {
  const store = createAuthStore(database(), OWNER());
  const owner = store.getByLogin('owner');
  const body = { login: 'user', displayName: 'User', password: 'not persisted here' };
  const user = store.create(owner.id, body, hashPassword('new user secure pass'));
  assert.equal(user.role, 'editor');
  assert.deepEqual(user.companyCodes, []);
  assert.deepEqual(user.permissions, []);
  assert.throws(() => store.create(owner.id, { ...body, login: 'USER' },
    hashPassword('another secure pass')), (error) => error.status === 409);
});

test('login and password changes invalidate sessions', () => {
  const store = createAuthStore(database(), OWNER());
  const owner = store.getByLogin('owner');
  const user = store.create(owner.id, { login: 'user', displayName: 'User', password: 'request-only' },
    hashPassword('new user secure pass'));
  store.updateProfile(owner.id, user.id, { login: 'renamed', displayName: 'Renamed' });
  const afterLogin = store.getById(user.id);
  assert.equal(afterLogin.sessionVersion, user.sessionVersion + 1);
  const nextHash = hashPassword('replacement password');
  store.updatePassword(owner.id, user.id, nextHash);
  assert.equal(store.getById(user.id).sessionVersion, afterLogin.sessionVersion + 1);
  assert.equal(verifyPassword('replacement password', nextHash), true);
});

test('access validation rejects unknown values and dependency gaps atomically', () => {
  const store = createAuthStore(database(), OWNER());
  const owner = store.getByLogin('owner');
  const user = store.create(owner.id, { login: 'user', displayName: 'User', password: 'request-only' },
    hashPassword('new user secure pass'));
  assert.throws(() => store.updateAccess(owner.id, user.id, ['unknown'], []), (error) => error.status === 400);
  assert.throws(() => store.updateAccess(owner.id, user.id, ['alvi'], ['price.edit']),
    (error) => error.status === 400);
  assert.deepEqual(store.getById(user.id).companyCodes, []);
});

test('owner effective access cannot be reduced', () => {
  const store = createAuthStore(database(), OWNER());
  const owner = store.getByLogin('owner');
  assert.deepEqual(owner.permissions, PERMISSIONS);
  assert.throws(() => store.updateAccess(owner.id, owner.id, [], []), (error) => error.status === 400);
});

test('site registry scopes, filters, creates blank draft and soft-deletes', () => {
  const db = database();
  db.exec(`CREATE TABLE documents (key TEXT, version INTEGER, created_at TEXT, author TEXT, body TEXT,
    UNIQUE(key, version))`);
  const auth = createAuthStore(db, OWNER());
  const owner = auth.getByLogin('owner');
  const save = (key, document, author) => db.prepare('INSERT INTO documents VALUES (?,?,?,?,?)')
    .run(key, 1, new Date().toISOString(), author, JSON.stringify(document));
  const sites = createSiteStore(db, auth, save);
  assert.equal(sites.list(owner, { state: 'published' }).some((site) => site.id === 'avokado'), true);
  assert.equal(sites.list(owner, { state: 'draft' }).some((site) => site.id === 'alvi'), true);
  const created = sites.create(owner, { name: 'Draft', companyCode: 'alvi' });
  assert.equal(created.publicationStatus, 'draft');
  assert.deepEqual(JSON.parse(db.prepare('SELECT body FROM documents WHERE key=?').get(`${created.id}/site`).body),
    { sections: [] });
  sites.remove(owner, created.id);
  assert.throws(() => sites.get(owner, created.id), (error) => error.status === 404);
  assert.throws(() => sites.remove(owner, 'avokado'), (error) => error.status === 409);
});

test('audit contains no password, hash or CSRF material', () => {
  const db = database();
  const store = createAuthStore(db, OWNER());
  const owner = store.getByLogin('owner');
  store.create(owner.id, { login: 'safe', displayName: 'Safe', password: 'plaintext-marker' },
    hashPassword('password marker secure'));
  const dump = JSON.stringify(db.prepare('SELECT * FROM auth_audit').all());
  assert.equal(/plaintext-marker|password marker secure|scrypt\$|csrf/i.test(dump), false);
});
