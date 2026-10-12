'use strict';
// BASE читается в память. Все установочные записи ниже — только виртуальная FS в памяти.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const requirePackage = createRequire(path.join(ROOT, 'install.cjs'));
const real = requirePackage('./install.cjs');
const patches = requirePackage('./patches/release-patches.cjs');
const basePath = process.argv[2];
if (!basePath || !path.isAbsolute(basePath)) throw new Error('Нужен абсолютный путь к read-only BASE/server.js');
const base = fs.readFileSync(basePath);
assert.equal(real.digest(base), patches.SERVER_SHA256, 'Исходный BASE SHA');
const fakeRoot = path.join(path.parse(ROOT).root, '__palitra_test_package__');
const runtime = path.join(path.parse(ROOT).root, '__palitra_test_runtime__');
const normal = file => path.resolve(file);
const memoryError = code => Object.assign(new Error(code), { code });
const inside = (root, file) => { const r = path.relative(root, file); return r === '' || (!path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`)); };

function virtualFilesystem() {
  const nodes = new Map();
  const descriptors = new Map();
  let nextFd = 50;
  let writes = 0;
  let renames = 0;
  let failRenameAt = null;
  const directory = file => {
    const key = normal(file);
    const parent = path.dirname(key);
    if (parent !== key && !nodes.has(parent)) directory(parent);
    nodes.set(key, { type: 'dir', mode: 0o755 });
  };
  const file = (filename, bytes, mode = 0o644) => {
    const key = normal(filename);
    directory(path.dirname(key));
    nodes.set(key, { type: 'file', bytes: Buffer.from(bytes), mode });
  };
  directory(runtime);
  const source = filename => inside(fakeRoot, normal(filename)) ? path.join(ROOT, path.relative(fakeRoot, normal(filename))) : null;
  const get = filename => {
    const key = normal(filename);
    const packageSource = source(key);
    if (packageSource) {
      if (!fs.existsSync(packageSource)) throw memoryError('ENOENT');
      const stat = fs.lstatSync(packageSource);
      return { type: stat.isDirectory() ? 'dir' : 'file', mode: stat.mode, packageSource };
    }
    const node = nodes.get(key);
    if (!node) throw memoryError('ENOENT');
    return node;
  };
  const assertWritable = filename => {
    if (!inside(runtime, normal(filename))) throw new Error('Тест запретил запись вне virtual runtime');
  };
  const stat = filename => {
    const item = get(filename);
    return { mode: item.mode, isSymbolicLink: () => item.type === 'symlink', isFile: () => item.type === 'file', isDirectory: () => item.type === 'dir' };
  };
  const mock = {
    existsSync(filename) { try { get(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
    lstatSync: stat, statSync: stat,
    readFileSync(filename, encoding) {
      const item = get(filename);
      if (item.type !== 'file') throw memoryError('EISDIR');
      const bytes = item.packageSource ? fs.readFileSync(item.packageSource) : Buffer.from(item.bytes);
      return encoding ? bytes.toString(encoding) : bytes;
    },
    mkdirSync(filename, options = {}) {
      assertWritable(filename);
      if (mock.existsSync(filename)) throw memoryError('EEXIST');
      if (get(path.dirname(filename)).type !== 'dir') throw memoryError('ENOTDIR');
      nodes.set(normal(filename), { type: 'dir', mode: options.mode || 0o755 }); writes += 1;
    },
    openSync(filename, flag, mode) {
      assert.equal(flag, 'wx'); assertWritable(filename);
      if (mock.existsSync(filename)) throw memoryError('EEXIST');
      if (get(path.dirname(filename)).type !== 'dir') throw memoryError('ENOTDIR');
      file(filename, '', mode); writes += 1;
      const fd = nextFd++; descriptors.set(fd, normal(filename)); return fd;
    },
    writeFileSync(fd, bytes) {
      const target = descriptors.get(fd);
      assert.ok(target, 'Только открытый fd'); assertWritable(target);
      nodes.get(target).bytes = Buffer.from(bytes); writes += 1;
    },
    fchmodSync(fd, mode) { const target = descriptors.get(fd); assert.ok(target); nodes.get(target).mode = mode; writes += 1; },
    fsyncSync() {}, closeSync(fd) { descriptors.delete(fd); },
    renameSync(from, to) {
      assertWritable(from); assertWritable(to); renames += 1;
      if (renames === failRenameAt) throw memoryError('EIO');
      const value = get(from);
      get(path.dirname(to)); nodes.set(normal(to), value); nodes.delete(normal(from)); writes += 1;
    },
    unlinkSync(filename) { assertWritable(filename); if (get(filename).type !== 'file') throw memoryError('EISDIR'); nodes.delete(normal(filename)); writes += 1; },
    readdirSync(filename) {
      if (get(filename).type !== 'dir') throw memoryError('ENOTDIR');
      return [...nodes.keys()].filter(key => key !== normal(filename) && path.dirname(key) === normal(filename)).map(key => path.basename(key));
    },
    rmdirSync(filename) { assertWritable(filename); assert.equal(mock.readdirSync(filename).length, 0); nodes.delete(normal(filename)); writes += 1; }
  };
  // Предки fake package только читаются из физической файловой системы.
  let ancestor = path.dirname(fakeRoot);
  while (true) { if (!nodes.has(ancestor)) nodes.set(ancestor, { type: 'dir', mode: 0o755 }); const next = path.dirname(ancestor); if (next === ancestor) break; ancestor = next; }
  return { fs: mock, nodes, file, directory, writes: () => writes, failRename: count => { failRenameAt = count; }, renames: () => renames };
}

function world() {
  const memory = virtualFilesystem();
  const contentDir = path.join(runtime, 'content');
  const staticDir = path.join(runtime, 'static');
  const previewFile = path.join(runtime, 'preview', 'index.html');
  const sharpModule = path.join(runtime, 'deps', 'node_modules', 'sharp');
  const backupDir = path.join(runtime, 'backups');
  for (const directory of [contentDir, staticDir, path.dirname(previewFile), sharpModule, backupDir]) memory.directory(directory);
  memory.file(path.join(contentDir, 'server.js'), base, 0o640);
  const preview = Buffer.from('<!doctype html>\n  <div id="previewBanner" class="preview-banner" role="alert" hidden></div>\n');
  memory.file(previewFile, preview);
  memory.file(path.join(sharpModule, 'package.json'), JSON.stringify({ name: 'sharp', version: '0.35.5', main: 'lib/index.js' }));
  memory.file(path.join(sharpModule, 'lib/index.js'), 'module.exports = () => {};');
  memory.file(path.join(staticDir, 'palitra-editor.css'), 'old style', 0o640);
  const module = { exports: {} };
  const context = { require: id => id === 'node:fs' ? memory.fs : requirePackage(id), module, exports: module.exports,
    __dirname: fakeRoot, __filename: path.join(fakeRoot, 'install.cjs'), Buffer, process, console };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'install.cjs'), 'utf8'), context, { filename: 'install.cjs (virtual FS)' });
  const installer = module.exports;
  const options = { contentDir, staticDir, previewFile, previewSha256: real.digest(preview), sharpModule, backupDir };
  const inspect = installer.makePlan(options, { inspect: true });
  options.baseline = inspect.baseline;
  return { memory, installer, options, base, preview, inspect };
}

let passed = 0;
const test = (label, run) => { run(); passed += 1; process.stdout.write(`PASS ${label}\n`); };

test('manifest и code-only состав', () => {
  const verified = real.verifyPackage();
  assert.equal(verified.manifest.payloadFiles, 27);
  assert.equal(real.TARGET_IDS.length, 29);
  for (const entry of verified.manifest.files) assert.ok(!/(^|\/)(BASE|QA|price\.json|auth-store\.js|catalog-live\.js|index\.html|preview)(\/|$)/i.test(entry.path));
});
test('все JS/CJS проходят синтаксис Node 24', () => {
  for (const entry of real.verifyPackage().manifest.files.filter(x => /\.(?:js|cjs)$/.test(x.path))) new vm.Script(fs.readFileSync(path.join(ROOT, entry.path), 'utf8'), { filename: entry.path });
});
test('конечные имена require server/cabinet', () => {
  const { createPalitraPhotoFeature } = requirePackage('./payload/server/palitra-photo-feature.js');
  const disabled = createPalitraPhotoFeature({ log: { warn() {} } });
  assert.equal(disabled.enabled, false);
  assert.ok(requirePackage('./payload/static/cabinet/site-photos-core.js'));
  const validator = requirePackage('./payload/server/palitra-price-validate.js');
  assert.ok(validator.validatePriceProblems(null).length > 0);
  assert.ok(requirePackage('./payload/static/palitra-editor-model.js'));
  assert.ok(requirePackage('./payload/static/palitra-editor-session.js'));
});
test('официальные fonts: SHA/woff2', () => {
  const fontManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'FONT_MANIFEST.json')));
  assert.equal(fontManifest.files.length, 4);
  for (const entry of fontManifest.files) {
    assert.ok(entry.official_url.startsWith('https://fonts.gstatic.com/s/nunitosans/v19/'));
    const bytes = fs.readFileSync(path.join(ROOT, 'payload/static', entry.served_as));
    assert.equal(bytes.subarray(0, 4).toString(), 'wOF2'); assert.equal(real.digest(bytes), entry.sha256);
  }
  const license = fs.readFileSync(path.join(ROOT, 'payload/static/palitra-editor-fonts/NunitoSans-OFL.txt'));
  assert.equal(real.digest(license), 'efbb0c9e864cef973982d9a17567e6be5c3d1759695574586f3f18c7ecca064b');
  assert.ok(license.toString('utf8').includes('Copyright 2016 The Nunito Sans Project Authors'));
  assert.ok(license.toString('utf8').includes('SIL OPEN FONT LICENSE Version 1.1'));
});
test('decoder/url обязательные и fixed require', () => {
  assert.throws(() => patches.photoFeatureWithDecoder(null));
  assert.throws(() => patches.photoFeatureWithDecoder('sharp'));
  const sharp = path.join(runtime, 'deps', 'node_modules', 'sharp');
  const result = patches.patchServer(base.toString(), sharp);
  assert.ok(result.text.includes(`createSharpDecoder(require(${JSON.stringify(sharp)}))`));
  assert.ok(result.text.includes(patches.EXPECTED_PUBLIC_URL));
  assert.ok(!result.text.includes('decodeImage:null'));
  let reverse = result.text;
  for (const inserted of result.inserted) reverse = reverse.replace(inserted, '');
  assert.ok(Buffer.from(reverse).equals(base));
});
test('check-only 29 целей, записи 0', () => {
  const w = world(); const before = w.memory.writes();
  const plan = w.installer.makePlan(w.options);
  assert.equal(plan.states.length, 29);
  assert.ok(plan.baseline.files.some(x => x.id === 'static/palitra-editor-fonts/NunitoSans-OFL.txt' && x.sha256 === null));
  assert.equal(w.memory.writes(), before);
  for (const state of plan.states) assert.ok(!/auth-store|Caddy|price\.json/.test(state.target));
  assert.equal(w.installer.publicPlan(plan).runtimeActivationIncluded, false);
});
test('unknown server SHA / preview SHA: отказ до записи', () => {
  const w = world(); w.memory.file(path.join(w.options.contentDir, 'server.js'), '// unexpected');
  const before = w.memory.writes(); assert.throws(() => w.installer.makePlan(w.options), /Неизвестный SHA/); assert.equal(w.memory.writes(), before);
  const x = world(); x.options.previewSha256 = '0'.repeat(64); assert.throws(() => x.installer.makePlan(x.options), /SHA preview/);
});
test('baseline полный / SHA изменения / лишняя цель', () => {
  const w = world(); w.options.baseline.files.pop(); assert.throws(() => w.installer.makePlan(w.options), /полный/);
  const x = world(); x.memory.file(path.join(x.options.staticDir, 'palitra-editor.css'), 'external change'); assert.throws(() => x.installer.makePlan(x.options), /Изменился целевой файл/);
  const y = world(); y.options.baseline.files[0].id = 'server/auth-store.js'; assert.throws(() => y.installer.makePlan(y.options), /лишний target/);
});
test('symlink/неофициальный sharp/preview вне whitelist', () => {
  const w = world(); w.memory.nodes.set(path.join(w.options.contentDir, 'palitra-photo-feature.js'), { type: 'symlink' }); assert.throws(() => w.installer.makePlan(w.options), /Символическая ссылка/);
  const x = world(); x.memory.file(path.join(x.options.sharpModule, 'package.json'), JSON.stringify({ name: 'other', version: 'x', main: 'lib/index.js' })); assert.throws(() => x.installer.makePlan(x.options), /пакета sharp/);
  const pinned = world(); pinned.memory.file(path.join(pinned.options.sharpModule, 'package.json'), JSON.stringify({ name: 'sharp', version: '0.35.4', main: 'lib/index.js' })); assert.throws(() => pinned.installer.makePlan(pinned.options), /sharp 0\.35\.5/);
  const y = world(); y.memory.file(path.join(runtime, 'auth-store.js'), 'x'); y.options.previewFile = path.join(runtime, 'auth-store.js'); assert.throws(() => y.installer.makePlan(y.options), /index\.html/);
});
test('полный backup → atomic rename → rollback/idempotence', () => {
  const w = world(); const plan = w.installer.makePlan(w.options);
  const applied = w.installer.applyPlan(plan, w.options.backupDir);
  assert.equal(applied.replacedFiles, 29); assert.equal(applied.runtimeActivated, false);
  assert.equal(w.memory.fs.statSync(path.join(w.options.contentDir, 'server.js')).mode, 0o640);
  assert.equal(w.memory.fs.statSync(path.join(w.options.staticDir, 'palitra-editor.css')).mode, 0o640);
  const beforeCheck = w.memory.writes();
  assert.equal(w.installer.rollback(applied.manifest, { checkOnly: true }).files.length, 29);
  assert.equal(w.memory.writes(), beforeCheck);
  const journal = JSON.parse(w.memory.fs.readFileSync(applied.manifest, 'utf8'));
  assert.equal(real.digest(w.memory.fs.readFileSync(path.join(path.dirname(applied.manifest), journal.files[0].backup))), patches.SERVER_SHA256);
  assert.equal(w.installer.rollback(applied.manifest).restoredFiles, 29);
  assert.ok(w.memory.fs.readFileSync(path.join(w.options.contentDir, 'server.js')).equals(base));
  assert.ok(w.memory.fs.readFileSync(w.options.previewFile).equals(w.preview));
  assert.equal(w.memory.fs.readFileSync(path.join(w.options.staticDir, 'palitra-editor.css'), 'utf8'), 'old style');
  assert.equal(w.memory.fs.statSync(path.join(w.options.staticDir, 'palitra-editor.css')).mode, 0o640);
  assert.equal(w.memory.fs.existsSync(path.join(w.options.staticDir, 'cabinet')), false);
  assert.equal(w.memory.fs.existsSync(path.join(w.options.staticDir, 'palitra-editor-fonts')), false);
  assert.equal(w.installer.rollback(applied.manifest).restoredFiles, 0);
});
test('стороннее изменение останавливает apply/rollback до замены', () => {
  const w = world(); const plan = w.installer.makePlan(w.options); w.memory.file(path.join(w.options.staticDir, 'palitra-editor.css'), 'changed after check');
  const count = w.memory.writes(); assert.throws(() => w.installer.applyPlan(plan, w.options.backupDir), /Состояние изменилось/); assert.equal(w.memory.writes(), count);
  const x = world(); const applied = x.installer.applyPlan(x.installer.makePlan(x.options), x.options.backupDir);
  x.memory.file(path.join(x.options.staticDir, 'palitra-editor.css'), 'changed after install');
  const count2 = x.memory.writes(); assert.throws(() => x.installer.rollback(applied.manifest), /неизвестный SHA/); assert.equal(x.memory.writes(), count2);
});
test('tampered rollback target/backup SHA: отказ', () => {
  const w = world(); const applied = w.installer.applyPlan(w.installer.makePlan(w.options), w.options.backupDir);
  const journal = JSON.parse(w.memory.fs.readFileSync(applied.manifest, 'utf8'));
  journal.files[0].target = path.join(w.options.contentDir, 'auth-store.js');
  w.memory.file(applied.manifest, JSON.stringify(journal));
  assert.throws(() => w.installer.rollback(applied.manifest), /whitelist/);
  const x = world(); const result = x.installer.applyPlan(x.installer.makePlan(x.options), x.options.backupDir);
  const saved = JSON.parse(x.memory.fs.readFileSync(result.manifest, 'utf8'));
  x.memory.file(path.join(path.dirname(result.manifest), saved.files[0].backup), 'corrupt');
  assert.throws(() => x.installer.rollback(result.manifest), /Повреждён backup/);
});
test('частичный I/O отказ и последующий rollback', () => {
  const w = world(); const plan = w.installer.makePlan(w.options);
  // Первые два rename — manifest, следующие два — server и первый модуль; пятый отказ.
  w.memory.failRename(5);
  assert.throws(() => w.installer.applyPlan(plan, w.options.backupDir), /rollback/);
  const transaction = w.memory.fs.readdirSync(w.options.backupDir)[0];
  const manifest = path.join(w.options.backupDir, transaction, 'manifest.json');
  assert.equal(JSON.parse(w.memory.fs.readFileSync(manifest, 'utf8')).status, 'failed-needs-rollback');
  w.memory.failRename(null); w.installer.rollback(manifest);
  assert.ok(w.memory.fs.readFileSync(path.join(w.options.contentDir, 'server.js')).equals(base));
  assert.equal([...w.memory.nodes.keys()].filter(x => /\.tmp$/.test(x)).length, 0);
});
test('CLI без явного режима и путей не пишет', () => {
  assert.throws(() => real.main([]), /явный режим/);
  assert.throws(() => real.main(['--check-only']), /абсолютный/);
  assert.throws(() => real.main(['--check-only', '--apply']), /ровно один/);
  assert.throws(() => real.main(['--unknown']), /Неизвестный/);
});
process.stdout.write(`${JSON.stringify({ passed, liveWrites: 0, realInstallWrites: 0, networkCalls: 0, fullBaseCopied: false, productionSharpVerified: false, manifestSha256: real.verifyPackage().sha256 })}\n`);
