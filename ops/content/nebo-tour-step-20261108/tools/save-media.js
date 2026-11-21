// Небо · заставка-облака + автостарт (№247).
// Шаг 1 — штатный store.save: index.html (заставка) + assets/tour-step.js (новая версия).
// Шаг 2 — store.save не принимает mp4, поэтому видео облаков добавляются второй ревизией
//         тем же устройством хранения: копия папки ревизии шага 1 + два mp4, манифест
//         с sha256/bytes, строка в site_workspace_revisions, переключение current_revision.
// Запуск в контейнере content: node /tmp/nebo-save-media.js dry|apply|rollback <old>
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const HOST = 'nebo-draft-1.synapsebusiness.ru';
const VER = process.env.NEBO_V || '20261108c';
const TAG = `<script defer src="/assets/tour-step.js?v=${VER}"></script>`;
const TAG_RE = /<script defer src="\/assets\/tour-step\.js\?v=[^"]*"><\/script>/;
const L_START = '<!-- nebo-loader -->', L_END = '<!-- /nebo-loader -->';
const mode = process.argv[2] || 'dry';
const E = process.env, DB = E.NEBO_DB || '/data/content.sqlite', APP = E.NEBO_APP || '/app', ROOT = E.NEBO_ROOT || '/data/projects', TMPD = E.NEBO_TMP || '/tmp';
const MEDIA = [['tour-media/clouds-desktop.mp4', TMPD + '/nebo-clouds-desktop.mp4'],
               ['tour-media/clouds-mobile.mp4', TMPD + '/nebo-clouds-mobile.mp4']];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

const db = new DatabaseSync(DB); db.exec('PRAGMA busy_timeout=10000');
const { createAuthStore, COMPANIES } = require(APP + '/auth-store');
const auth = createAuthStore(db, '');
const user = auth.getByLogin('vladislav');
const { createWorkspaceStore } = require(APP + '/site-workspaces');
const store = createWorkspaceStore({ db, root: ROOT, companies: COMPANIES, audit: auth.audit, sources: {} });
const row = db.prepare('SELECT * FROM site_workspaces WHERE hostname=?').get(HOST);
if (!row) throw new Error('SITE_NOT_FOUND');
const siteId = row.site_id, rev0 = row.current_revision;
const verDir = r => path.join(ROOT, row.company_code || 'nebo', 'sites', siteId, 'versions', r);
const revRow = r => db.prepare('SELECT * FROM site_workspace_revisions WHERE site_id=? AND revision=?').get(siteId, r);

if (mode === 'rollback') {
  const old = process.argv[3];
  if (!/^[0-9a-f]{64}$/.test(old || '') || !revRow(old)) throw new Error('OLD_REVISION_UNKNOWN');
  const r = db.prepare('UPDATE site_workspaces SET current_revision=? WHERE site_id=? AND current_revision=?').run(old, siteId, rev0);
  console.log(JSON.stringify({ mode, from: rev0, to: old, changes: Number(r.changes) }));
  process.exit(0);
}

const html = fs.readFileSync(path.join(verDir(rev0), 'index.html'), 'utf8');
const js = fs.readFileSync(TMPD + '/nebo-tour-step.js', 'utf8');
const loader = L_START + '\n' + fs.readFileSync(TMPD + '/nebo-loader.html', 'utf8').trim() + '\n' + L_END;
const r0 = revRow(rev0);
const man0 = JSON.parse(r0.manifest_json);
const files0 = man0.files && typeof man0.files === 'object' ? man0.files : man0;
const sample = files0['tour-media/nebo-gemini-desktop-v9.mp4'];
const media = MEDIA.map(([p, src]) => { const b = fs.existsSync(src) ? fs.readFileSync(src) : null; return { p, src, b }; });
const facts = {
  siteId, revision: rev0, user: user && user.login, role: user && user.role,
  revColumns: Object.keys(r0), manifestTop: Object.keys(man0).slice(0, 5), sampleEntry: sample,
  binaryOnDisk: fs.existsSync(path.join(verDir(rev0), 'tour-media/nebo-gemini-desktop-v9.mp4')),
  bodyAnchor: html.includes('<body><div id="root">') || html.includes(L_START), hasTag: TAG_RE.test(html),
  media: media.map(m => ({ p: m.p, bytes: m.b && m.b.length })),
};
console.log(JSON.stringify(facts, null, 1));
const ok = user && user.role === 'owner' && facts.bodyAnchor && facts.hasTag && facts.binaryOnDisk
  && sample && sample.sha256 && media.every(m => m.b && m.b.length > 10000);
if (!ok) throw new Error('PRECHECK_FAILED');
if (mode !== 'apply') { console.log('DRY_OK: для выкладки запустите с apply'); process.exit(0); }

const newHtml = (html.includes(L_START)
  ? html.replace(new RegExp(L_START + '[\\s\\S]*?' + L_END), loader)
  : html.replace('<body><div id="root">', '<body>' + loader + '<div id="root">')).replace(TAG_RE, TAG);

const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
const bak = `${path.dirname(DB)}/content-before-nebo-clouds-${stamp}.sqlite`;
backup(db, bak).then(() => {
  fs.chmodSync(bak, 0o600);
  // шаг 1: штатное сохранение текстов
  store.save(user, siteId, { baseRevision: rev0, files: [{ path: 'index.html', content: newHtml }, { path: 'assets/tour-step.js', content: js }],
    message: 'Небо: заставка-облака и автостарт до первого блока (№247)' });
  const rev1 = db.prepare('SELECT current_revision FROM site_workspaces WHERE site_id=?').get(siteId).current_revision;
  if (rev1 === rev0) throw new Error('STEP1_NOT_SAVED');
  // шаг 2: ревизия с видео облаков
  const r1 = revRow(rev1), man = JSON.parse(r1.manifest_json);
  const files = man.files && typeof man.files === 'object' ? man.files : man;
  for (const m of media) files[m.p] = { ...files[m.p], bytes: m.b.length, sha256: sha(m.b) };
  const ordered = Object.fromEntries(Object.keys(files).sort().map(k => [k, files[k]]));
  if (man.files) man.files = ordered;
  const manifest = man.files ? man : ordered;
  const rev2 = sha(Buffer.from(JSON.stringify(ordered) + '\n' + rev1));
  const tmp = verDir(rev2) + '.tmp';
  fs.cpSync(verDir(rev1), tmp, { recursive: true });
  for (const m of media) { fs.mkdirSync(path.join(tmp, path.dirname(m.p)), { recursive: true }); fs.writeFileSync(path.join(tmp, m.p), m.b); }
  fs.renameSync(tmp, verDir(rev2));
  const r2 = { ...r1, revision: rev2, manifest_json: JSON.stringify(manifest), message: 'Небо: видео облаков для заставки (№247)' };
  if ('version' in r2) r2.version = Number(r1.version) + 1;
  if ('created_at' in r2) r2.created_at = typeof r1.created_at === 'number' ? Date.now() : new Date().toISOString();
  for (const k of Object.keys(r2)) if (/base/.test(k) && r1[k] !== undefined) r2[k] = rev1;
  const cols = Object.keys(r2);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO site_workspace_revisions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => r2[c]));
    const u = db.prepare('UPDATE site_workspaces SET current_revision=? WHERE site_id=? AND current_revision=?').run(rev2, siteId, rev1);
    if (Number(u.changes) !== 1) throw new Error('SWITCH_RACE');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  console.log(JSON.stringify({ mode, backup: bak, before: rev0, textRevision: rev1, mediaRevision: rev2 }, null, 1));
  console.log('ОТКАТ: sh nebo2.sh rollback ' + rev0);
}).catch(e => { console.error('ОШИБКА', e.message); process.exitCode = 1; });
