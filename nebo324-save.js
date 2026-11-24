'use strict';

// One-off controlled release for task #324.  The new revision is created only
// through the same workspace store used by the site editor.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { createAuthStore, COMPANIES } = require('/app/auth-store');
const { createWorkspaceStore } = require('/app/site-workspaces');

const HOST = 'nebo-draft-1.synapsebusiness.ru';
const SITE_ID = 'site-77e4e3404d3af8980796';
const PAYLOAD = '/tmp/nebo324-payload';
const mode = process.argv[2] || 'dry';

function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, rel);
    if (!entry.isFile()) throw new Error(`PAYLOAD_NOT_REGULAR:${rel}`);
    return [{ path: rel, content: fs.readFileSync(full) }];
  });
}

async function main() {
  const db = new DatabaseSync('/data/content.sqlite');
  db.exec('PRAGMA busy_timeout=10000');
  const auth = createAuthStore(db, '');
  const user = auth.getByLogin('vladislav');
  if (!user) throw new Error('RELEASE_USER_NOT_FOUND');
  const store = createWorkspaceStore({ db, root: '/data/projects', companies: COMPANIES, audit: auth.audit, sources: {} });
  const row = db.prepare('SELECT * FROM site_workspaces WHERE hostname=?').get(HOST);
  if (!row || row.site_id !== SITE_ID) throw new Error('SITE_NOT_FOUND_OR_MISMATCH');
  const files = walk(PAYLOAD).sort((a, b) => a.path.localeCompare(b.path));
  if (files.length !== 32 || files.some((file) => file.path === 'SHA256SUMS' || !/^(index\.html|img\/[a-z0-9-]+\.(?:jpg|png|svg)|v\/[a-z0-9-]+\.mp4)$/.test(file.path))) {
    throw new Error(`PAYLOAD_INVALID:${files.length}`);
  }
  const facts = { mode, siteId: row.site_id, oldRevision: row.current_revision, fileCount: files.length };
  if (mode === 'dry') { console.log(JSON.stringify(facts)); return; }
  if (mode !== 'apply') throw new Error('MODE_MUST_BE_DRY_OR_APPLY');
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const backupPath = `/data/content-before-nebo324-${stamp}.sqlite`;
  await backup(db, backupPath);
  fs.chmodSync(backupPath, 0o600);
  const result = store.save(user, row.site_id, {
    baseRevision: row.current_revision,
    files,
    message: 'Небо: публикация пакета 20261124 (#324)',
  });
  const now = db.prepare('SELECT current_revision FROM site_workspaces WHERE site_id=?').get(row.site_id).current_revision;
  console.log(JSON.stringify({ ...facts, backup: backupPath, newRevision: now, saved: !!result }));
}

main().catch((error) => { console.error('RELEASE_ERROR', error.message); process.exitCode = 1; });
