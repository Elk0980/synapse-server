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

test('new registry publishes ALVI at its main domain with the existing editor identities', (t) => {
  const {owner, open} = fixture(t);
  const sites = open();
  const alvi = sites.get(owner, 'alvi');
  assert.equal(alvi.name, 'АЛВИ — основной сайт');
  assert.equal(alvi.publicUrl, 'https://spaalvi-38.ru/');
  assert.equal(alvi.publicationStatus, 'published');
  assert.equal(alvi.company.id, 'alvi');
  assert.equal(alvi.isActive, true);
  assert.deepEqual(alvi.editorUrls, {site: '/site-editor.html?site=alvi', price: '/price-editor.html?site=alvi'});
  assert.equal(alvi.capabilities.delete, false);
  assert.equal(sites.get(owner, 'drafts-alvi').publicationStatus, 'draft');
});

test('ALVI migration changes only its legacy name, domain and publication, leaving content and access intact', (t) => {
  const {db, owner, open} = fixture(t);
  open();
  db.prepare("DELETE FROM site_migrations WHERE id='alvi_publication_20260915'").run();
  db.prepare(`UPDATE managed_sites SET name='ALVI',public_url='https://alvi.synapsebusiness.ru/',
    publication_status='draft',is_active=0,created_by=?,created_at='2026-09-01',updated_at='2026-09-14'
    WHERE id='alvi'`).run(owner.id);
  db.exec('CREATE TABLE documents (key TEXT PRIMARY KEY, body TEXT)');
  db.prepare('INSERT INTO documents VALUES (?,?)').run('alvi/site', '{"text":"Owner site content"}');
  db.prepare('INSERT INTO documents VALUES (?,?)').run('alvi/price', '{"price":"Owner price"}');
  const documents = db.prepare('SELECT * FROM documents ORDER BY key').all();
  const before = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  const sites = open();
  for (const row of before) {
    const after = db.prepare('SELECT * FROM managed_sites WHERE id=?').get(row.id);
    if (row.id !== 'alvi') assert.deepEqual(after, row, 'other companies and draft collections stay untouched');
    else {
      assert.deepEqual({...after, updated_at: row.updated_at}, {...row,
        name: 'АЛВИ — основной сайт', public_url: 'https://spaalvi-38.ru/', publication_status: 'published'});
      assert.notEqual(after.updated_at, row.updated_at);
    }
  }
  assert.equal(sites.get(owner, 'alvi').isActive, false, 'publication does not silently change activity');
  assert.equal(sites.get(owner, 'alvi').capabilities.editSite, true);
  assert.equal(sites.get(owner, 'alvi').capabilities.editPrice, true);
  assert.deepEqual(db.prepare('SELECT * FROM documents ORDER BY key').all(), documents);
});

test('manual ALVI name, URL and publication changes after migration survive all later startups', (t) => {
  const {db, open} = fixture(t);
  open();
  const marker = db.prepare("SELECT * FROM site_migrations WHERE id='alvi_publication_20260915'").get();
  // Even a deliberate return to the former values must not re-run promotion.
  db.prepare(`UPDATE managed_sites SET name='ALVI',public_url='https://alvi.synapsebusiness.ru/',
    publication_status='draft',updated_at='2026-09-16' WHERE id='alvi'`).run();
  const before = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  open(); open();
  assert.deepEqual(db.prepare('SELECT * FROM managed_sites ORDER BY id').all(), before);
  assert.deepEqual(db.prepare("SELECT * FROM site_migrations WHERE id='alvi_publication_20260915'").get(), marker);
});

test('ALVI promotion rolls back all fields if its marker cannot be stored, then retries cleanly', (t) => {
  const {db, owner, open} = fixture(t);
  open();
  db.prepare("DELETE FROM site_migrations WHERE id='alvi_publication_20260915'").run();
  db.prepare(`UPDATE managed_sites SET name='ALVI',public_url='https://alvi.synapsebusiness.ru/',
    publication_status='draft',updated_at='2026-09-14' WHERE id='alvi'`).run();
  const before = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
  db.exec(`CREATE TRIGGER alvi_marker_failure BEFORE INSERT ON site_migrations
    WHEN NEW.id='alvi_publication_20260915' BEGIN SELECT RAISE(ABORT,'simulated marker failure'); END`);
  assert.throws(open, /simulated marker failure/);
  assert.deepEqual(db.prepare('SELECT * FROM managed_sites ORDER BY id').all(), before);
  assert.equal(db.prepare("SELECT id FROM site_migrations WHERE id='alvi_publication_20260915'").get(), undefined);
  db.exec('DROP TRIGGER alvi_marker_failure');
  assert.equal(open().get(owner, 'alvi').publicationStatus, 'published');
  assert.ok(db.prepare("SELECT id FROM site_migrations WHERE id='alvi_publication_20260915'").get());
});

test('ALVI promotion respects custom fields and skips deleted, managed or different-company records', (t) => {
  const {db, open} = fixture(t);
  open();
  const resetMarker = () => db.prepare("DELETE FROM site_migrations WHERE id='alvi_publication_20260915'").run();
  db.prepare("UPDATE managed_sites SET name='Owner name',public_url='https://custom.example/',publication_status='draft' WHERE id='alvi'").run();
  resetMarker(); open();
  const custom = db.prepare("SELECT * FROM managed_sites WHERE id='alvi'").get();
  assert.equal(custom.name, 'Owner name');
  assert.equal(custom.public_url, 'https://custom.example/');
  assert.equal(custom.publication_status, 'published');
  for (const override of ["deleted_at='2026-09-14'", "source='managed'", "company_code='avokado'"]) {
    db.prepare(`UPDATE managed_sites SET name='ALVI',public_url='https://alvi.synapsebusiness.ru/',publication_status='draft',
      source='legacy',company_code='alvi',deleted_at=NULL,${override} WHERE id='alvi'`).run();
    resetMarker();
    const before = db.prepare('SELECT * FROM managed_sites ORDER BY id').all();
    open();
    assert.deepEqual(db.prepare('SELECT * FROM managed_sites ORDER BY id').all(), before);
  }
});
