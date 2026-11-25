'use strict';
// ТайСабай · черновик сайта v4 (25.11.2026) → taisabai-draft-1.synapsebusiness.ru. Задача №329.
// Запускается ВНУТРИ контейнера content (его вызывает install.py): node release.cjs <inspect|apply|rollback> <payload> [state]
//
// Штатный путь черновиков: site_workspaces (тот же, что nebo-draft-1).
//  1. Если у ТайСабай ещё нет черновика — создаём его функцией clone() из /app/site-workspaces
//     (та же, что кнопка «Клонировать» в ЛК); адрес назначает сервер: taisabai-draft-<N>.
//     Исходник клона — файлы старого сайта taisabai (В2) ТОЛЬКО ЧИТАЮТСЯ; taisabai.synapsebusiness.ru не меняется.
//  2. Новая ревизия = ровно файлы payload (полная замена набора, бинарные видео тоже) — как save(),
//     но без ограничения «только текст». Прежние ревизии остаются на диске: откат = вернуть указатель.
// Ничего не удаляет, ключи, права, Caddy и другие сайты не трогает.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');

const COMPANY = 'taisabai';
const SOURCE_SITE_ID = 'taisabai';
const WANT_HOST = 'taisabai-draft-1.synapsebusiness.ru';
const RELEASE_LOGIN = 'vladislav';
const MESSAGE = 'ТайСабай: черновик сайта v4 от 25.11.2026 (№329)';
const REQUEST_ID = '2b6f0c1e-5a7d-4c3e-9f21-329000000426'; // постоянный: повтор apply не создаёт второй черновик
const DB_PATH = '/data/content.sqlite';
const ROOT = '/data/projects';

const [mode = 'inspect', payload, statePath] = process.argv.slice(2);
const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
const out = (o) => console.log(JSON.stringify(o, null, 2));

function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(path.join(dir, e.name), rel);
    if (!e.isFile()) throw new Error(`PAYLOAD_NOT_REGULAR:${rel}`);
    return [rel];
  });
}

function payloadManifest(validPath) {
  if (!payload || !fs.existsSync(path.join(payload, 'index.html'))) throw new Error('PAYLOAD_INDEX_MISSING');
  const files = walk(payload).filter((f) => f !== 'SHA256SUMS');
  const bad = files.filter((f) => !validPath(f));
  if (bad.length) throw new Error('PAYLOAD_BAD_PATHS:' + bad.join(','));
  const manifest = {};
  for (const f of files) {
    const bytes = fs.readFileSync(path.join(payload, f));
    manifest[f] = { bytes: bytes.length, sha256: digest(bytes) };
  }
  // Сверка с SHA256SUMS из ветки: файлы дошли до сервера без порчи.
  const sums = fs.readFileSync(path.join(payload, 'SHA256SUMS'), 'utf8').trim().split('\n')
    .map((l) => l.match(/^([a-f0-9]{64}) {2}(.+)$/)).filter(Boolean);
  if (sums.length !== files.length) throw new Error(`SHA256SUMS_COUNT:${sums.length}!=${files.length}`);
  for (const [, sha, f] of sums) if (!manifest[f] || manifest[f].sha256 !== sha) throw new Error('SHA256_MISMATCH:' + f);
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
}

function facts(db) {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_workspaces'").get();
  if (!hasTable) {
    const source = db.prepare('SELECT id, company_code, public_url, deleted_at FROM managed_sites WHERE id = ?').get(SOURCE_SITE_ID) || null;
    return { workspaces: [], source, sourceFiles: fs.existsSync('/site-sources/taisabai/index.html'), hostTaken: null, workspaceTable: false };
  }
  const ws = db.prepare(`SELECT w.*, m.company_code, m.publication_status, m.is_active, m.deleted_at, m.name
    FROM site_workspaces w JOIN managed_sites m ON m.id = w.site_id WHERE m.company_code = ? ORDER BY w.hostname`).all(COMPANY);
  const source = db.prepare('SELECT id, company_code, public_url, deleted_at FROM managed_sites WHERE id = ?').get(SOURCE_SITE_ID) || null;
  const other = db.prepare('SELECT site_id FROM site_workspaces WHERE hostname = ?').get(WANT_HOST) || null;
  return { workspaces: ws.map((w) => ({ siteId: w.site_id, hostname: w.hostname, revision: w.current_revision,
    status: w.publication_status, active: w.is_active, deleted: w.deleted_at, name: w.name })),
  source, sourceFiles: fs.existsSync('/site-sources/taisabai/index.html'), hostTaken: other };
}

async function main() {
  const { createWorkspaceStore, validPath } = require('/app/site-workspaces');
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout=10000');
  const manifest = payloadManifest(validPath);
  const total = Object.values(manifest).reduce((n, f) => n + f.bytes, 0);
  const before = facts(db);
  const base = { mode, payloadFiles: Object.keys(manifest).length, payloadBytes: total, ...before };

  if (mode === 'inspect') {
    const draft = before.workspaces.find((w) => w.hostname === WANT_HOST);
    base.plan = draft ? `новая ревизия поверх ${WANT_HOST} (прежняя ${draft.revision} остаётся для отката)`
      : before.hostTaken ? 'STOP: адрес занят сайтом другого проекта'
      : (before.source && before.sourceFiles) ? `создать черновик клоном taisabai → ${WANT_HOST}, затем ревизия с payload`
      : 'STOP: нет исходника taisabai для клона — нужна кнопка «Клонировать» в ЛК';
    return out(base);
  }

  if (mode === 'rollback') {
    const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const cur = db.prepare('SELECT current_revision FROM site_workspaces WHERE site_id=? AND hostname=?').get(st.siteId, st.hostname);
    if (!cur || cur.current_revision !== st.newRevision) throw new Error('ROLLBACK_STATE_MISMATCH');
    if (!st.oldRevision) {
      // Черновик создан этим выпуском: прячем его (is_active=0), файлы и записи остаются.
      db.prepare('UPDATE managed_sites SET is_active=0, updated_at=? WHERE id=? AND company_code=?').run(new Date().toISOString(), st.siteId, COMPANY);
      return out({ mode, siteId: st.siteId, hostname: st.hostname, deactivated: true });
    }
    db.prepare('UPDATE site_workspaces SET current_revision=? WHERE site_id=? AND current_revision=?').run(st.oldRevision, st.siteId, st.newRevision);
    return out({ mode, siteId: st.siteId, hostname: st.hostname, revision: st.oldRevision });
  }

  if (mode !== 'apply') throw new Error('MODE_MUST_BE_INSPECT_APPLY_ROLLBACK');
  if (before.hostTaken && !before.workspaces.some((w) => w.hostname === WANT_HOST)) throw new Error('HOST_TAKEN_BY_OTHER_PROJECT');

  // Повтор apply без изменений пакета — ничего не делаем (ни бэкапа, ни новой ревизии).
  const existing = before.workspaces.find((w) => w.hostname === WANT_HOST);
  if (existing) {
    const rev = db.prepare('SELECT manifest_json FROM site_workspace_revisions WHERE site_id=? AND revision=?').get(existing.siteId, existing.revision);
    if (rev && rev.manifest_json === JSON.stringify(manifest)) {
      return out({ ...base, unchanged: true, siteId: existing.siteId, hostname: WANT_HOST, newRevision: existing.revision, url: `https://${WANT_HOST}/` });
    }
  }

  // 1. Бэкап базы до любых изменений.
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const backupPath = `/data/content-before-taisabai-draft-${stamp}.sqlite`;
  await backup(db, backupPath);
  fs.chmodSync(backupPath, 0o600);

  const { createAuthStore, COMPANIES } = require('/app/auth-store');
  const auth = createAuthStore(db, '');
  const user = auth.getByLogin(RELEASE_LOGIN);
  if (!user) throw new Error('RELEASE_USER_NOT_FOUND');

  // 2. Черновик: существующий taisabai-draft-1 или новый штатным клоном.
  const sources = { [SOURCE_SITE_ID]: { root: '/site-sources/taisabai', companyCode: COMPANY } };
  const store = createWorkspaceStore({ db, root: ROOT, sources, companies: COMPANIES, audit: auth.audit });
  let ws = db.prepare('SELECT * FROM site_workspaces WHERE hostname=?').get(WANT_HOST);
  let created = false;
  if (!ws) {
    const site = store.clone(user, { sourceSiteId: SOURCE_SITE_ID, companyCode: COMPANY, name: 'ТайСабай — черновик v4', requestId: REQUEST_ID });
    ws = db.prepare('SELECT * FROM site_workspaces WHERE site_id=?').get(site.id);
    created = true;
    if (ws.hostname !== WANT_HOST) console.error(`ВНИМАНИЕ: сервер назначил адрес ${ws.hostname} (не ${WANT_HOST})`);
  }
  const site = db.prepare('SELECT * FROM managed_sites WHERE id=?').get(ws.site_id);
  if (site.company_code !== COMPANY || site.publication_status !== 'draft' || site.deleted_at) throw new Error('DRAFT_NOT_TAISABAI_OR_NOT_DRAFT');

  // 3. Ревизия = файлы payload. Формат каталога и записей — как в save() из site-workspaces.
  const oldRevision = ws.current_revision;
  const revision = digest(JSON.stringify(manifest) + '\n' + oldRevision);
  const siteDir = path.join(ROOT, COMPANY, 'sites', ws.site_id);
  const target = path.join(siteDir, 'versions', revision);
  if (!fs.existsSync(target)) {
    const staging = path.join(siteDir, 'staging-' + crypto.randomBytes(8).toString('hex'));
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const f of Object.keys(manifest)) {
      const dst = path.join(staging, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(payload, f), dst, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dst, 0o600);
      if (digest(fs.readFileSync(dst)) !== manifest[f].sha256) throw new Error('COPY_MISMATCH:' + f);
    }
    fs.renameSync(staging, target);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = db.prepare('SELECT current_revision FROM site_workspaces WHERE site_id=?').get(ws.site_id).current_revision;
    if (cur !== oldRevision) throw new Error('CONCURRENT_CHANGE');
    const now = new Date().toISOString();
    if (!db.prepare('SELECT 1 FROM site_workspace_revisions WHERE site_id=? AND revision=?').get(ws.site_id, revision)) {
      const prev = db.prepare('SELECT max(version) AS v FROM site_workspace_revisions WHERE site_id=?').get(ws.site_id).v || 0;
      db.prepare('INSERT INTO site_workspace_revisions VALUES(?,?,?,?,?,?,?)')
        .run(ws.site_id, revision, prev + 1, JSON.stringify(manifest), user.id, now, MESSAGE);
    }
    db.prepare('UPDATE site_workspaces SET current_revision=? WHERE site_id=?').run(revision, ws.site_id);
    db.prepare('UPDATE managed_sites SET updated_at=? WHERE id=?').run(now, ws.site_id);
    auth.audit(user.id, null, 'SITE_FILES_SAVED', { siteId: ws.site_id, companyCode: COMPANY, revision, files: ['payload:' + Object.keys(manifest).length] });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const state = { siteId: ws.site_id, hostname: ws.hostname, created, oldRevision: created ? null : oldRevision,
    cloneRevision: created ? oldRevision : null, newRevision: revision, backup: backupPath, at: new Date().toISOString() };
  if (statePath) fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  out({ ...base, ...state, url: `https://${ws.hostname}/` });
}

main().catch((e) => { console.error('RELEASE_ERROR', e.message); process.exitCode = 1; });
