'use strict';

// Only the existing native workspace store writes site files/history/audit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hashPattern = /^[a-f0-9]{64}$/;

function noLinks(filename, kind) {
  const absolute = path.resolve(filename);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    assert(!stat.isSymbolicLink(), 'Symbolic link refused');
  }
  const stat = fs.lstatSync(absolute);
  assert(kind === 'directory' ? stat.isDirectory() : stat.isFile(), 'Wrong file type');
  return absolute;
}
function contained(root, relative, kind = 'file') {
  assert(typeof relative === 'string' && relative && !relative.includes('\\') && !relative.includes(':') &&
    !relative.startsWith('/') && relative.split('/').every(p => p && p !== '.' && p !== '..'), 'Invalid relative path');
  const filename = path.resolve(root, relative);
  assert(filename.startsWith(root + path.sep), 'Path escapes root');
  return noLinks(filename, kind);
}
function readBytes(filename, expected) {
  const bytes = fs.readFileSync(filename);
  assert(expected && hashPattern.test(expected.sha256) && Number.isSafeInteger(expected.bytes) &&
    expected.bytes >= 0 && bytes.length === expected.bytes && sha(bytes) === expected.sha256, 'File hash/size mismatch');
  const content = bytes.toString('utf8');
  assert(Buffer.from(content, 'utf8').equals(bytes), 'UTF-8 roundtrip failed');
  return { bytes, content };
}
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    assert(/^--[a-z-]+$/.test(name) && !(name.slice(2) in args), 'Invalid or duplicate argument');
    if (['--check', '--apply'].includes(name)) args[name.slice(2)] = true;
    else { assert(i + 1 < argv.length && !argv[i + 1].startsWith('--'), 'Missing argument'); args[name.slice(2)] = argv[++i]; }
  }
  const names = new Set(['check','apply','database','workspace-root','module-dir','store-sha256','auth-sha256',
    'site-id','company','owner-id','expected-version','expected-revision','candidate-dir','meta','meta-sha256',
    'expected-files','expected-changed','message']);
  assert(Object.keys(args).every(n => names.has(n)), 'Unknown argument');
  assert(Boolean(args.check) !== Boolean(args.apply), 'Choose exactly --check or --apply');
  for (const name of [...names].filter(n => !['check','apply','message'].includes(n))) assert(args[name], 'Missing --' + name);
  for (const name of ['store-sha256','auth-sha256','expected-revision','meta-sha256']) assert(hashPattern.test(args[name]), 'Invalid SHA-256');
  for (const name of ['owner-id','expected-version','expected-files','expected-changed']) {
    assert(/^[1-9][0-9]*$/.test(args[name]), 'Invalid positive integer'); args[name] = Number(args[name]);
    assert(Number.isSafeInteger(args[name]), 'Integer overflow');
  }
  assert(args.company === 'palitra-love' && /^site-[a-f0-9]{20}$/.test(args['site-id']), 'Wrong target/company');
  args.message ||= 'Root: Palitra — пакет принятых изменений';
  assert(args.message.startsWith('Root:') && args.message.length <= 240, 'Audit message must identify Root installer');
  return args;
}

function run(args) {
  const database = noLinks(args.database, 'file');
  const workspaceRoot = noLinks(args['workspace-root'], 'directory');
  assert(workspaceRoot === path.resolve(path.dirname(database), 'projects'), 'Workspace root differs from native server contract');
  const moduleDir = noLinks(args['module-dir'], 'directory');
  const storeFile = contained(moduleDir, 'site-workspaces.js');
  const authFile = contained(moduleDir, 'auth-store.js');
  assert(sha(fs.readFileSync(storeFile)) === args['store-sha256'], 'Native workspace module changed');
  assert(sha(fs.readFileSync(authFile)) === args['auth-sha256'], 'Native auth module changed');
  const candidateRoot = noLinks(args['candidate-dir'], 'directory');
  const metaFile = noLinks(args.meta, 'file');
  assert(metaFile.startsWith(candidateRoot + path.sep), 'META must be inside candidate directory');
  const metaBytes = fs.readFileSync(metaFile);
  assert(sha(metaBytes) === args['meta-sha256'], 'Candidate META changed');
  const meta = JSON.parse(metaBytes.toString('utf8'));
  assert(Array.isArray(meta.files) && meta.files.length === args['expected-files'], 'Wrong file count');
  assert(meta.baseHomepageVersion === args['expected-version'], 'META base version differs');
  const { createWorkspaceStore, validPath } = require(storeFile);
  const { createAuthStore, COMPANIES } = require(authFile);
  assert(typeof createWorkspaceStore === 'function' && typeof validPath === 'function' &&
    typeof createAuthStore === 'function' && COMPANIES[args.company], 'Native exports differ');
  const seen = new Set(), files = [], rows = [];
  let total = 0;
  for (const row of meta.files) {
    assert(row && validPath(row.path) && /\.(?:html|js|css)$/.test(row.path) && !seen.has(row.path), 'Invalid/duplicate/unapproved file');
    seen.add(row.path);
    assert(typeof row.changed === 'boolean' && row.base && row.candidate &&
      hashPattern.test(row.base.sha256) && Number.isSafeInteger(row.base.bytes) && row.base.bytes >= 0 &&
      row.changed === (row.base.sha256 !== row.candidate.sha256 || row.base.bytes !== row.candidate.bytes), 'Invalid META row');
    const value = readBytes(contained(candidateRoot, row.path), row.candidate);
    rows.push(row);
    if (row.changed) { assert(value.bytes.length <= 2 * 1024 * 1024, 'Native per-file limit'); total += value.bytes.length; files.push({ path: row.path, content: value.content }); }
  }
  assert(files.length === args['expected-changed'] && files.length <= 100 && total <= 8 * 1024 * 1024, 'Wrong changed count or native limit');
  // Derived META aliases are deliberately not submitted.
  const db = new DatabaseSync(database, { readOnly: Boolean(args.check) });
  let committed = false, expectedAfter = null;
  try {
    for (const name of ['auth_users','auth_user_companies','auth_user_permissions','auth_meta','auth_audit',
      'managed_sites','site_workspaces','site_workspace_revisions']) {
      assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name), 'Native schema incomplete');
    }
    assert(db.prepare("SELECT 1 FROM auth_meta WHERE key='auth_users_imported_v1'").get(), 'Auth import marker absent; refuse bootstrap');
    const readOwner = () => db.prepare('SELECT id, role, session_version FROM auth_users WHERE id=?').get(args['owner-id']);
    const owner = readOwner();
    assert(owner && owner.role === 'owner', 'Existing owner required');
    const siteId = args['site-id'];
    const checkAuthority = () => {
      const fresh = readOwner();
      assert(fresh && fresh.role === 'owner' && fresh.session_version === owner.session_version, 'Owner changed/revoked');
      const site = db.prepare('SELECT id, company_code, publication_status, deleted_at FROM managed_sites WHERE id=?').get(siteId);
      assert(site && !site.deleted_at && site.company_code === args.company && site.publication_status === 'draft', 'Target must remain this company draft');
    };
    checkAuthority();
    const current = db.prepare('SELECT current_revision FROM site_workspaces WHERE site_id=?').get(siteId);
    assert(current && current.current_revision === args['expected-revision'], 'Workspace CAS revision changed');
    const revision = db.prepare('SELECT revision,version,manifest_json FROM site_workspace_revisions WHERE site_id=? AND revision=?').get(siteId, current.current_revision);
    assert(revision && revision.version === args['expected-version'], 'Workspace version changed');
    assert(db.prepare('SELECT max(version) AS version FROM site_workspace_revisions WHERE site_id=?').get(siteId).version === revision.version,
      'Expected base is not latest native history version');
    const baseManifest = JSON.parse(revision.manifest_json);
    const revisionRoot = contained(workspaceRoot, `${args.company}/sites/${siteId}/versions/${current.current_revision}`, 'directory');
    // Validate the whole native snapshot for path safety and immutable base consistency.
    for (const [relative, entry] of Object.entries(baseManifest)) {
      assert(validPath(relative), 'Unsafe native manifest path');
      const nativeBytes = fs.readFileSync(contained(revisionRoot, relative));
      assert(nativeBytes.length === entry.bytes && sha(nativeBytes) === entry.sha256, 'Native snapshot mismatch');
    }
    for (const row of rows) {
      const base = baseManifest[row.path];
      assert(base && base.sha256 === row.base.sha256 && base.bytes === row.base.bytes, 'Fresh BASE differs: ' + row.path);
      readBytes(contained(revisionRoot, row.path), row.base);
    }
    checkAuthority();
    assert(db.prepare('SELECT current_revision FROM site_workspaces WHERE site_id=?').get(siteId).current_revision === current.current_revision, 'Workspace changed during preflight');
    const ordered = Object.fromEntries(Object.entries({ ...baseManifest,
      ...Object.fromEntries(rows.filter(r => r.changed).map(r => [r.path, { bytes: r.candidate.bytes, sha256: r.candidate.sha256 }]))
    }).sort(([a], [b]) => a.localeCompare(b)));
    expectedAfter = sha(JSON.stringify(ordered) + '\n' + current.current_revision);
    const afterDirectory = path.resolve(workspaceRoot, args.company, 'sites', siteId, 'versions', expectedAfter);
    assert(!fs.existsSync(afterDirectory), 'Planned revision directory already exists; inspect previous attempt before retry');
    const plan = { siteId, company: args.company, baseVersion: revision.version, baseRevision: current.current_revision,
      expectedAfterRevision: expectedAfter, filesChecked: rows.length, changedFiles: files.length, changedBytes: total };
    if (args.check) { process.stdout.write(JSON.stringify({ status: 'CHECK_OK', ...plan }) + '\n'); return; }
    // No environment import, session extraction, direct head update or direct filesystem write.
    const authStore = createAuthStore(db, '');
    const user = { id: owner.id, role: 'owner', companyCodes: [args.company], permissions: [] };
    const store = createWorkspaceStore({ db, root: workspaceRoot, sources: {}, companies: COMPANIES,
      audit(actor, target, action, details) {
        checkAuthority(); // Revalidate inside the native transaction before its commit.
        assert(actor === owner.id && target === null && action === 'SITE_FILES_SAVED' &&
          details.siteId === siteId && details.companyCode === args.company && details.revision === expectedAfter,
        'Unexpected native audit');
        authStore.audit(actor, target, action, details);
      }
    });
    checkAuthority();
    const result = store.save(user, siteId, { baseRevision: current.current_revision, files, message: args.message });
    committed = true;
    process.stdout.write(JSON.stringify({ status: 'COMMITTED', ...plan, version: result.version, revision: result.revision }) + '\n');
    assert(result.revision === expectedAfter && result.version === revision.version + 1, 'Native result differs after commit');
    const readback = store.workspace(user, siteId);
    assert(readback.revision === expectedAfter && readback.version === revision.version + 1 &&
      readback.files.length === Object.keys(ordered).length, 'Readback head/manifest differs');
    for (const entry of readback.files) {
      const expected = ordered[entry.path];
      assert(expected && expected.sha256 === entry.sha256 && expected.bytes === entry.bytes, 'Readback manifest differs');
    }
    for (const row of rows) {
      const value = store.file(user, siteId, row.path);
      assert(value.revision === expectedAfter && Buffer.byteLength(value.content) === row.candidate.bytes &&
        sha(Buffer.from(value.content)) === row.candidate.sha256, 'Readback bytes differ');
    }
    assert(store.history(user, siteId).some(h => h.revision === current.current_revision && h.version === revision.version), 'Immutable base history absent');
    process.stdout.write(JSON.stringify({ status: 'READBACK_OK', ...plan, version: readback.version, revision: readback.revision }) + '\n');
  } catch (error) {
    // A native save may commit then throw during its own return/readback. Never report it as definitely unwritten.
    if (!args.check && expectedAfter) {
      try { committed ||= db.prepare('SELECT current_revision FROM site_workspaces WHERE site_id=?').get(args['site-id'])?.current_revision === expectedAfter; }
      catch (_) { /* Unknown outcome: operator must inspect native head/history before retry. */ }
    }
    error.committed = committed;
    error.expectedAfterRevision = expectedAfter;
    throw error;
  } finally { db.close(); }
}

module.exports = { run, parseArgs };
if (require.main === module) {
  try { run(parseArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(JSON.stringify({ status: 'REFUSED_OR_FAILED', committed: Boolean(error.committed),
    expectedAfterRevision: error.expectedAfterRevision || null, message: error.message }) + '\n'); process.exitCode = 1; }
}
