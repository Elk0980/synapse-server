'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createSiteStore } = require('./site-store');
const { hashPassword } = require('./passwords');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const auth = createAuthStore(db, `owner:owner:${hashPassword('site registry test password')}`);
  const owner = auth.getByLogin('owner');
  const open = () => createSiteStore(db, auth, () => assert.fail('Migration must not rewrite content'));
  return { db, owner, open };
}

test('new registry exposes Avokado3 at the client domain with its existing editors', (t) => {
  const { owner, open } = fixture(t);
  const sites = open();
  const current = sites.get(owner, 'avokado3');
  assert.equal(current.name, 'АВОКАДО — основной сайт');
  assert.equal(current.publicUrl, 'https://avokado38.ru/');
  assert.equal(current.company.id, 'avokado');
  assert.equal(current.publicationStatus, 'published');
  assert.deepEqual(current.editorUrls, {
    site: '/site-editor.html?site=avokado3', price: '/price-editor.html?site=avokado',
  });
  const previous = sites.get(owner, 'avokado');
  assert.equal(previous.name, 'АВОКАДО — предыдущая версия');
  assert.equal(previous.publicUrl, 'https://avokado.synapsebusiness.ru/');
  assert.equal(previous.publicationStatus, 'published');
});

test('existing legacy cards migrate once while retaining identities, metadata and documents', (t) => {
  const { db, owner, open } = fixture(t);
  open();
  db.prepare("UPDATE managed_sites SET name='Авокадо' WHERE id='avokado'").run();
  db.prepare(`UPDATE managed_sites SET name='Авокадо3', public_url='https://avokado3.synapsebusiness.ru/',
    created_by=?, created_at='2026-09-01', updated_at='2026-09-14' WHERE id='avokado3'`).run(owner.id);
  db.exec("CREATE TABLE documents (key TEXT PRIMARY KEY, body TEXT)");
  db.prepare('INSERT INTO documents VALUES (?, ?)').run('avokado3/site', '{"sections":[{"text":"Client copy"}]}');
  const before = db.prepare("SELECT * FROM managed_sites WHERE id='avokado3'").get();
  const documents = db.prepare('SELECT * FROM documents').all();
  open();
  const migrated = db.prepare("SELECT * FROM managed_sites WHERE id='avokado3'").get();
  assert.deepEqual({ ...migrated }, {
    ...before, name: 'АВОКАДО — основной сайт', public_url: 'https://avokado38.ru/',
  });
  assert.equal(db.prepare("SELECT name FROM managed_sites WHERE id='avokado'").get().name,
    'АВОКАДО — предыдущая версия');
  const rows = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  open();
  assert.deepEqual(db.prepare('SELECT * FROM managed_sites ORDER BY id').all(), rows);
  assert.deepEqual(db.prepare('SELECT * FROM documents').all(), documents);
});

test('promotion preserves custom values and ignores records outside the legacy Avokado company', (t) => {
  const { db, open } = fixture(t);
  open();
  db.prepare(`UPDATE managed_sites SET name='Client name', public_url='https://custom.example/',
    is_active=0, publication_status='draft', deleted_at='2026-09-14' WHERE id='avokado3'`).run();
  db.prepare("UPDATE managed_sites SET name='Custom previous name' WHERE id='avokado'").run();
  let before = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  open();
  assert.deepEqual(db.prepare('SELECT * FROM managed_sites ORDER BY id').all(), before);

  db.prepare(`UPDATE managed_sites SET name='Авокадо3', public_url='https://avokado3.synapsebusiness.ru/',
    source='managed' WHERE id='avokado3'`).run();
  db.prepare("UPDATE managed_sites SET name='Авокадо', company_code='alvi' WHERE id='avokado'").run();
  before = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  open();
  assert.deepEqual(db.prepare('SELECT * FROM managed_sites ORDER BY id').all(), before);
});
