// Небо · выкладка tour-step.js штатным сохранением хранилища сайтов (store.save),
// тем же путём, что и редактор сайта: новая ревизия + строка в site_workspace_revisions.
// Запуск в контейнере content: node /tmp/nebo-save.js dry|apply|rollback <old-revision>
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const HOST = 'nebo-draft-1.synapsebusiness.ru';
const ANCHOR = '<link rel="stylesheet" crossorigin href="/assets/index-DMNisL_8.css">';
const TAG = '<script defer src="/assets/tour-step.js?v=20261108"></script>';
const mode = process.argv[2] || 'dry';
const db = new DatabaseSync('/data/content.sqlite'); db.exec('PRAGMA busy_timeout=10000');
const { createAuthStore, COMPANIES } = require('/app/auth-store');
const auth = createAuthStore(db, '');
const user = auth.getByLogin('vladislav');
const { createWorkspaceStore } = require('/app/site-workspaces');
const store = createWorkspaceStore({ db, root: '/data/projects', companies: COMPANIES, audit: auth.audit, sources: {} });
const row = db.prepare('SELECT * FROM site_workspaces WHERE hostname=?').get(HOST);
if (!row) throw new Error('SITE_NOT_FOUND');
const siteId = row.site_id, rev = row.current_revision;
const dir = path.join('/data/projects', row.company_code || 'nebo', 'sites', siteId, 'versions', rev);
const idxPath = fs.existsSync(path.join(dir, 'index.html')) ? path.join(dir, 'index.html')
  : path.join('/data/projects/nebo/sites', siteId, 'versions', rev, 'index.html');
const html = fs.readFileSync(idxPath, 'utf8');
const js = fs.readFileSync('/tmp/nebo-tour-step.js', 'utf8');
const facts = { siteId, revision: rev, user: user && user.login, role: user && user.role,
  anchorCount: html.split(ANCHOR).length - 1, alreadyHasTag: html.includes('tour-step.js'), jsBytes: js.length };

if (mode === 'rollback') {
  const old = process.argv[3];
  if (!/^[0-9a-f]{64}$/.test(old || '')) throw new Error('OLD_REVISION_REQUIRED');
  if (!db.prepare('SELECT 1 FROM site_workspace_revisions WHERE site_id=? AND revision=?').get(siteId, old)) throw new Error('OLD_REVISION_UNKNOWN');
  const r = db.prepare('UPDATE site_workspaces SET current_revision=? WHERE site_id=? AND current_revision=?').run(old, siteId, rev);
  console.log(JSON.stringify({ mode, from: rev, to: old, changes: Number(r.changes) }));
  process.exit(0);
}

console.log(JSON.stringify(facts, null, 1));
if (facts.anchorCount !== 1 || facts.alreadyHasTag || !user || user.role !== 'owner') throw new Error('PRECHECK_FAILED');
if (mode !== 'apply') { console.log('DRY_OK: для выкладки запустите с apply'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
const bak = `/data/content-before-nebo-tourstep-${stamp}.sqlite`;
backup(db, bak).then(() => {
  fs.chmodSync(bak, 0o600);
  const newHtml = html.replace(ANCHOR, ANCHOR + '\n  ' + TAG);
  const result = store.save(user, siteId, {
    baseRevision: rev,
    files: [{ path: 'index.html', content: newHtml }, { path: 'assets/tour-step.js', content: js }],
    message: 'Небо: экскурсия — один свайп = видео до следующего блока (№239)',
  });
  const now = db.prepare('SELECT current_revision FROM site_workspaces WHERE site_id=?').get(siteId).current_revision;
  console.log(JSON.stringify({ mode, backup: bak, oldRevision: rev, newRevision: now, saved: !!result }, null, 1));
  console.log('ОТКАТ: sh nebo.sh rollback ' + rev);
}).catch(e => { console.error('ОШИБКА', e.message); process.exitCode = 1; });
