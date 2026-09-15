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
  assert.equal(previous.publicationStatus, 'draft');
  assert.equal(previous.isActive, true);
  const second = sites.get(owner, 'avokado2');
  assert.equal(second.publicationStatus, 'draft');
  assert.equal(second.isActive, true);
  assert.equal(second.publicUrl, 'https://avokado2.synapsebusiness.ru/');
});

test('publication choice migrates existing Avokado cards without changing access or other sites', (t) => {
  const { db, owner, open } = fixture(t);
  open();
  // Simulate a registry created before the publication migration was introduced.
  db.prepare("DELETE FROM site_migrations WHERE id='avokado_publication_20260915'").run();
  db.prepare(`UPDATE managed_sites SET publication_status='published', updated_at='2026-09-14'
    WHERE id IN ('avokado','avokado2')`).run();
  db.prepare(`UPDATE managed_sites SET publication_status='draft', is_active=0, updated_at='2026-09-14'
    WHERE id='avokado3'`).run();
  const before = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  const sites = open();
  const desired = { avokado: 'draft', avokado2: 'draft', avokado3: 'published' };
  for (const row of before) {
    const after = db.prepare('SELECT * FROM managed_sites WHERE id=?').get(row.id);
    if (!desired[row.id]) {
      assert.deepEqual(after, row, 'unrelated companies and draft collections remain untouched');
      continue;
    }
    assert.deepEqual({ ...after, updated_at: row.updated_at }, {
      ...row, publication_status: desired[row.id],
    }, 'only publication status and its timestamp change');
    assert.notEqual(after.updated_at, row.updated_at);
    const card = sites.get(owner, row.id);
    assert.equal(card.capabilities.editSite, true);
    assert.equal(card.capabilities.editPrice, true);
    assert.equal(card.capabilities.delete, false, 'legacy drafts cannot be deleted');
  }
  const family = list => list.filter(site => Object.hasOwn(desired, site.id)).map(site => site.id).sort();
  assert.deepEqual(family(sites.list(owner, { state: 'published' })), ['avokado3']);
  assert.deepEqual(family(sites.list(owner, { state: 'draft' })), ['avokado', 'avokado2']);
  assert.deepEqual(family(sites.list(owner, { state: 'active' })), ['avokado', 'avokado2'],
    'activity remains independent of publication');
  const rows = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  open();
  assert.deepEqual(db.prepare('SELECT * FROM managed_sites ORDER BY id').all(), rows,
    'restarting does not repeatedly rewrite publication timestamps');
});

test('manual publication choices after migration survive subsequent starts', (t) => {
  const { db, owner, open } = fixture(t);
  open();
  const marker = db.prepare("SELECT * FROM site_migrations WHERE id='avokado_publication_20260915'").get();
  assert.ok(marker);
  db.prepare(`UPDATE managed_sites SET publication_status='published', updated_at='2026-09-16'
    WHERE id IN ('avokado','avokado2')`).run();
  db.prepare(`UPDATE managed_sites SET publication_status='draft', updated_at='2026-09-16'
    WHERE id='avokado3'`).run();
  const rows = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  const restarted = open();
  assert.deepEqual(db.prepare('SELECT * FROM managed_sites ORDER BY id').all(), rows);
  assert.equal(restarted.get(owner, 'avokado').publicationStatus, 'published');
  assert.equal(restarted.get(owner, 'avokado2').publicationStatus, 'published');
  assert.equal(restarted.get(owner, 'avokado3').publicationStatus, 'draft');
  assert.deepEqual(db.prepare("SELECT * FROM site_migrations WHERE id='avokado_publication_20260915'").get(), marker);
});

test('failed publication migration rolls back all status changes and its marker', (t) => {
  const { db, owner, open } = fixture(t);
  open();
  db.prepare("DELETE FROM site_migrations WHERE id='avokado_publication_20260915'").run();
  db.prepare("UPDATE managed_sites SET publication_status='published' WHERE id IN ('avokado','avokado2')").run();
  const rows = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  db.exec(`CREATE TRIGGER publication_failure BEFORE UPDATE OF publication_status ON managed_sites
    WHEN NEW.id='avokado2' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
  assert.throws(open, /simulated failure/);
  assert.deepEqual(db.prepare('SELECT * FROM managed_sites ORDER BY id').all(), rows);
  assert.equal(db.prepare("SELECT id FROM site_migrations WHERE id='avokado_publication_20260915'").get(), undefined);
  db.exec('DROP TRIGGER publication_failure');
  const retried = open();
  assert.equal(retried.get(owner, 'avokado').publicationStatus, 'draft');
  assert.equal(retried.get(owner, 'avokado2').publicationStatus, 'draft');
  assert.ok(db.prepare("SELECT id FROM site_migrations WHERE id='avokado_publication_20260915'").get());
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
  db.prepare("DELETE FROM site_migrations WHERE id='avokado_publication_20260915'").run();
  let before = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  open();
  assert.deepEqual(db.prepare('SELECT * FROM managed_sites ORDER BY id').all(), before);

  db.prepare(`UPDATE managed_sites SET name='Авокадо3', public_url='https://avokado3.synapsebusiness.ru/',
    source='managed' WHERE id='avokado3'`).run();
  db.prepare("UPDATE managed_sites SET name='Авокадо', company_code='alvi' WHERE id='avokado'").run();
  db.prepare("DELETE FROM site_migrations WHERE id='avokado_publication_20260915'").run();
  before = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  open();
  assert.deepEqual(db.prepare('SELECT * FROM managed_sites ORDER BY id').all(), before);
});
