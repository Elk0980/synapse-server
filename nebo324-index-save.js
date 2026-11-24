'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore, COMPANIES } = require('/app/auth-store');
const { createWorkspaceStore } = require('/app/site-workspaces');

const HOST = 'nebo-draft-1.synapsebusiness.ru';
const SITE_ID = 'site-77e4e3404d3af8980796';
const INDEX = '/tmp/nebo324-index-media.html';
const mode = process.argv[2] || 'dry';

function main() {
  const db = new DatabaseSync('/data/content.sqlite');
  db.exec('PRAGMA busy_timeout=10000');
  const auth = createAuthStore(db, '');
  const user = auth.getByLogin('vladislav');
  if (!user) throw new Error('RELEASE_USER_NOT_FOUND');
  const store = createWorkspaceStore({ db, root: '/data/projects', companies: COMPANIES, audit: auth.audit, sources: {} });
  const row = db.prepare('SELECT * FROM site_workspaces WHERE hostname=?').get(HOST);
  if (!row || row.site_id !== SITE_ID) throw new Error('SITE_NOT_FOUND_OR_MISMATCH');
  const content = fs.readFileSync(INDEX, 'utf8');
  if (content.includes('__MEDIA__') || !content.includes('/tour-media/nebo-20261124/')) throw new Error('INDEX_MEDIA_PREFIX_INVALID');
  const facts = { mode, siteId: row.site_id, oldRevision: row.current_revision, fileCount: 1 };
  if (mode === 'dry') return console.log(JSON.stringify(facts));
  if (mode !== 'apply') throw new Error('MODE_MUST_BE_DRY_OR_APPLY');
  const result = store.save(user, row.site_id, { baseRevision: row.current_revision, files: [{ path: 'index.html', content }], message: 'Небо: публикация медиа-пакета 20261124 (#324)' });
  const now = db.prepare('SELECT current_revision FROM site_workspaces WHERE site_id=?').get(row.site_id).current_revision;
  console.log(JSON.stringify({ ...facts, newRevision: now, saved: !!result }));
}

try { main(); } catch (error) { console.error('RELEASE_ERROR', error.message); process.exitCode = 1; }
