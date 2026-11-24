'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
// The deployed content image does not retain the editor helper modules.  This
// is the historical workspace store, copied alongside this one-off runner;
// the actual mutation remains its normal `store.save` path.
const { createWorkspaceStore } = require('/tmp/nebo324/site-workspaces');

const HOST = 'nebo-draft-1.synapsebusiness.ru';
const SITE_ID = 'site-77e4e3404d3af8980796';
const INDEX = '/data/tmp/nebo324-index-flat.html';
const mode = process.argv[2] || 'dry';

function main() {
  const db = new DatabaseSync('/data/crm.sqlite');
  db.exec('PRAGMA busy_timeout=10000');
  if (mode === 'tables') {
    console.log(JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%site%' OR name LIKE '%user%' OR name LIKE '%workspace%' OR name LIKE '%audit%') ORDER BY name").all()));
    return;
  }
  const user = db.prepare('SELECT id, login, role FROM auth_users WHERE login=?').get('vladislav');
  if (!user || user.role !== 'owner') throw new Error('RELEASE_OWNER_NOT_FOUND');
  user.companyCodes = [];
  user.permissions = [];
  const audit = (actorId, targetId, action, details = {}) => db.prepare(
    'INSERT INTO auth_audit (actor_user_id, target_user_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(actorId, targetId || null, action, JSON.stringify(details), new Date().toISOString());
  const store = createWorkspaceStore({
    db,
    root: '/data/projects',
    companies: { nebo: { name: 'Небо', contentSiteId: null } },
    audit,
    sources: {},
  });
  const row = db.prepare('SELECT * FROM site_workspaces WHERE hostname=?').get(HOST);
  if (!row || row.site_id !== SITE_ID) throw new Error('SITE_NOT_FOUND_OR_MISMATCH');
  const content = fs.readFileSync(INDEX, 'utf8');
  if (content.includes('__MEDIA__') || !content.includes('/tour-media/n24-img-') || !content.includes('/tour-media/n24-v-')) throw new Error('INDEX_MEDIA_PREFIX_INVALID');
  const facts = { mode, siteId: row.site_id, oldRevision: row.current_revision, fileCount: 1 };
  if (mode === 'dry') return console.log(JSON.stringify(facts));
  if (mode !== 'apply') throw new Error('MODE_MUST_BE_DRY_OR_APPLY');
  const result = store.save(user, row.site_id, { baseRevision: row.current_revision, files: [{ path: 'index.html', content }], message: 'Небо: публикация медиа-пакета 20261124 (#324)' });
  const now = db.prepare('SELECT current_revision FROM site_workspaces WHERE site_id=?').get(row.site_id).current_revision;
  console.log(JSON.stringify({ ...facts, newRevision: now, saved: !!result }));
}

try { main(); } catch (error) { console.error('RELEASE_ERROR', error.message); process.exitCode = 1; }
