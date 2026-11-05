'use strict';

// Только локальные файлы. Никаких команд, сети, рестарта, Docker, БД или выдачи прав.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const patches = require('./patches/release-patches.cjs');
const ROOT = __dirname;
const SHA = /^[a-f0-9]{64}$/;
const SERVER_NAMES = Object.freeze([
  'palitra-photo-feature.js', 'palitra-photo-model.js', 'palitra-image-check.js',
  'palitra-image-decoder.js', 'palitra-price-validate.js', 'palitra-occasions.js'
]);
const STATIC_NAMES = Object.freeze([
  'cabinet/palitra-editor.html', 'cabinet/palitra-editor.js', 'cabinet/editor-config.js',
  'cabinet/site-photos.html', 'cabinet/site-photos.js', 'cabinet/site-photos.css',
  'cabinet/site-photos-core.js', 'cabinet/site-photos-access.html', 'cabinet/site-photos-access.js',
  'cabinet/palitra-photo-model.js', 'price-editor-palitra.html', 'palitra-editor.css',
  'palitra-editor.js', 'palitra-editor-model.js', 'palitra-editor-session.js', 'palitra-occasions.js',
  'palitra-editor-fonts/nunito-sans-v19-cyrillic-ext.woff2',
  'palitra-editor-fonts/nunito-sans-v19-cyrillic.woff2',
  'palitra-editor-fonts/nunito-sans-v19-latin-ext.woff2',
  'palitra-editor-fonts/nunito-sans-v19-latin.woff2',
  'palitra-editor-fonts/NunitoSans-OFL.txt'
]);
const PAYLOAD = Object.freeze([
  ...SERVER_NAMES.map(name => ({ id: `server/${name}`, source: `payload/server/${name}`, group: 'server', relative: name })),
  ...STATIC_NAMES.map(name => ({ id: `static/${name}`, source: `payload/static/${name}`, group: 'static', relative: name }))
]);
const TARGET_IDS = Object.freeze(['server/server.js', ...PAYLOAD.map(x => x.id), 'preview']);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const within = (root, child) => {
  const relative = path.relative(root, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function assertPlainPath(file, { directory = false, allowMissing = false } = {}) {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  const pieces = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < pieces.length; i += 1) {
    cursor = path.join(cursor, pieces[i]);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return absolute;
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`Символическая ссылка запрещена: ${cursor}`);
    if (i < pieces.length - 1 && !stat.isDirectory()) fail(`Предок не каталог: ${cursor}`);
  }
  const stat = fs.lstatSync(absolute);
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail(`Неподходящий тип пути: ${absolute}`);
  return absolute;
}

function explicitAbsolute(value, label, directory = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) fail(`Нужен явный абсолютный ${label}`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) fail(`Корень диска не разрешён для ${label}`);
  return assertPlainPath(resolved, { directory });
}

function fileState(target) {
  assertPlainPath(target, { allowMissing: true });
  if (!fs.existsSync(target)) return { sha256: null, bytes: null, mode: null };
  const bytes = fs.readFileSync(target);
  const stat = fs.statSync(target);
  return { sha256: digest(bytes), bytes, mode: stat.mode & 0o777 };
}

function verifyPackage() {
  const manifestPath = assertPlainPath(path.join(ROOT, 'BUILD_MANIFEST.json'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || manifest.serverBaseSha256 !== patches.SERVER_SHA256 || !Array.isArray(manifest.files)) fail('Неверный BUILD_MANIFEST');
  const entries = new Map();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !SHA.test(entry.sha256) || entry.path.includes('\\') || entry.path.split('/').some(x => x === '..' || x === '')) fail('Неверный путь BUILD_MANIFEST');
    const source = path.resolve(ROOT, entry.path);
    if (!within(ROOT, source) || entries.has(entry.path)) fail('Повтор или выход за пакет в BUILD_MANIFEST');
    assertPlainPath(source);
    const bytes = fs.readFileSync(source);
    if (digest(bytes) !== entry.sha256 || bytes.length !== entry.bytes) fail(`SHA пакета не совпал: ${entry.path}`);
    entries.set(entry.path, entry);
  }
  for (const item of PAYLOAD) if (!entries.has(item.source)) fail(`Нет payload в BUILD_MANIFEST: ${item.source}`);
  for (const source of ['install.cjs', 'patches/release-patches.cjs', 'patches/upstream-patches.cjs']) if (!entries.has(source)) fail(`Нет обязательного файла в BUILD_MANIFEST: ${source}`);
  return { manifest, sha256: digest(fs.readFileSync(manifestPath)), entries };
}

function validateBaseline(baseline, states) {
  if (!baseline || baseline.schema !== 1 || !Array.isArray(baseline.files) || baseline.files.length !== TARGET_IDS.length) fail('Нужен полный --baseline с SHA или null для каждого разрешённого файла');
  const expected = new Map();
  for (const entry of baseline.files) {
    if (!entry || !TARGET_IDS.includes(entry.id) || expected.has(entry.id) || !(entry.sha256 === null || SHA.test(entry.sha256))) fail('Неверный или лишний target в baseline');
    expected.set(entry.id, entry.sha256);
  }
  for (const item of states) if (expected.get(item.id) !== item.beforeSha256) fail(`Изменился целевой файл: ${item.id}`);
}

function sharpInfo(sharpModule) {
  const directory = explicitAbsolute(sharpModule, '--sharp-module', true);
  const packagePath = assertPlainPath(path.join(directory, 'package.json'));
  const bytes = fs.readFileSync(packagePath);
  const info = JSON.parse(bytes.toString('utf8'));
  if (info.name !== 'sharp' || info.version !== '0.35.5' || typeof info.main !== 'string') fail('--sharp-module должен быть каталогом установленного пакета sharp 0.35.5');
  const main = path.resolve(directory, info.main);
  if (!within(directory, main)) fail('main пакета sharp вышел за его каталог');
  assertPlainPath(main);
  return { path: directory, name: info.name, version: info.version, packageJsonSha256: digest(bytes), runtimeDecodeVerified: false };
}

function makePlan(options, { inspect = false } = {}) {
  const verified = verifyPackage();
  const contentDir = explicitAbsolute(options.contentDir, '--content-dir', true);
  const staticDir = explicitAbsolute(options.staticDir, '--static-dir', true);
  const previewFile = explicitAbsolute(options.previewFile, '--preview-file');
  if (!['index.html', 'bot-preview-index.html'].includes(path.basename(previewFile))) fail('--preview-file: разрешён только index.html или bot-preview-index.html');
  if (!SHA.test(options.previewSha256 || '')) fail('Нужен явный --preview-sha256');
  const sharp = sharpInfo(options.sharpModule);
  const states = [];
  const add = (id, target, bytes, source) => {
    const before = fileState(target);
    const afterSha256 = digest(bytes);
    states.push({ id, target, source, beforeSha256: before.sha256, afterSha256, bytes, beforeBytes: before.bytes,
      beforeMode: before.mode, changed: before.sha256 !== afterSha256 });
  };
  const serverFile = path.join(contentDir, 'server.js');
  const server = fileState(serverFile);
  if (server.sha256 !== patches.SERVER_SHA256) fail(`Неизвестный SHA server.js: ${server.sha256 || 'absent'}; нужен ${patches.SERVER_SHA256}`);
  const patched = patches.patchServer(server.bytes.toString('utf8'), sharp.path);
  new vm.Script(patched.text, { filename: 'server.js (candidate)' });
  let reconstructed = patched.text;
  for (const inserted of patched.inserted) {
    if (reconstructed.split(inserted).length !== 2) fail('Вставка server.js не уникальна при обратной проверке');
    reconstructed = reconstructed.replace(inserted, '');
  }
  if (!Buffer.from(reconstructed).equals(server.bytes)) fail('Патч затронул прежние байты server.js');
  add('server/server.js', serverFile, Buffer.from(patched.text), 'patches/release-patches.cjs');
  for (const item of PAYLOAD) {
    const target = path.join(item.group === 'server' ? contentDir : staticDir, item.relative);
    add(item.id, target, fs.readFileSync(path.join(ROOT, item.source)), item.source);
  }
  const preview = fileState(previewFile);
  if (preview.sha256 !== options.previewSha256) fail('SHA preview-файла не совпал с --preview-sha256');
  add('preview', previewFile, Buffer.from(patches.applyPatch(preview.bytes.toString('utf8'), patches.BOT_PREVIEW_LINK).text), 'patches/upstream-patches.cjs#BOT_PREVIEW_LINK');
  for (let i = 0; i < states.length; i += 1) {
    if (within(ROOT, states[i].target)) fail('Цель установки внутри release-пакета запрещена');
    for (let j = 0; j < i; j += 1) if (samePath(states[i].target, states[j].target)) fail('Целевые пути пересекаются');
  }
  if (!inspect) validateBaseline(options.baseline, states);
  return { schema: 1, release: 'PALITRA-BOT-EDITOR-35+12-18', packageManifestSha256: verified.sha256,
    serverBaseSha256: patches.SERVER_SHA256, expectedPublicUrl: patches.EXPECTED_PUBLIC_URL,
    contentDir, staticDir, previewFile, sharp, states,
    baseline: { schema: 1, files: states.map(({ id, beforeSha256 }) => ({ id, sha256: beforeSha256 })) } };
}

function publicPlan(plan) {
  const { states, baseline, ...rest } = plan;
  return { ...rest, mode: 'check-only', fileCount: states.length,
    files: states.map(({ id, target, source, beforeSha256, afterSha256, changed }) => ({ id, target, source, beforeSha256, afterSha256, changed })),
    runtimeActivationIncluded: false, restartIncluded: false, databaseWritesIncluded: false, baseline };
}

function durableWrite(file, bytes, mode = 0o600) {
  const fd = fs.openSync(file, 'wx', mode);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function saveJournal(file, journal) {
  const temp = `${file}.${crypto.randomUUID()}.next`;
  try {
    durableWrite(temp, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`));
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function recheckStates(states, field) {
  for (const item of states) if (fileState(item.target).sha256 !== item[field]) fail(`Состояние изменилось: ${item.id}`);
}

function atomicReplace(target, bytes, mode, token, index, expectedSha256) {
  const temp = path.join(path.dirname(target), `.palitra-editor-release-${token}-${index}.tmp`);
  try {
    durableWrite(temp, bytes, mode ?? 0o644);
    if (digest(fs.readFileSync(temp)) !== digest(bytes)) fail('SHA временного файла не совпал');
    if (fileState(target).sha256 !== expectedSha256) fail(`Состояние изменилось перед atomic rename: ${target}`);
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function applyPlan(plan, backupDir) {
  const backupRoot = explicitAbsolute(backupDir, '--backup-dir', true);
  if (within(plan.contentDir, backupRoot) || within(plan.staticDir, backupRoot) || within(ROOT, backupRoot)) fail('Backup должен находиться вне content/static/release');
  for (const item of plan.states) if (within(backupRoot, item.target)) fail('Цель установки внутри backup запрещена');
  recheckStates(plan.states, 'beforeSha256');
  const currentSharp = sharpInfo(plan.sharp.path);
  if (currentSharp.packageJsonSha256 !== plan.sharp.packageJsonSha256) fail('Пакет sharp изменился после проверки');
  const token = crypto.randomUUID();
  const transactionDir = path.join(backupRoot, `palitra-editor-release-${token}`);
  fs.mkdirSync(transactionDir, { mode: 0o700 });
  const journalPath = path.join(transactionDir, 'manifest.json');
  const entries = plan.states.filter(x => x.changed).map((item, index) => ({
    id: item.id, target: item.target, beforeSha256: item.beforeSha256, afterSha256: item.afterSha256,
    beforeMode: item.beforeMode, backup: item.beforeSha256 === null ? null : `${index}.before`, temporaryName: `.palitra-editor-release-${token}-${index}.tmp`
  }));
  const journal = { schema: 1, token, status: 'backing-up', packageManifestSha256: plan.packageManifestSha256,
    serverBaseSha256: patches.SERVER_SHA256, contentDir: plan.contentDir, staticDir: plan.staticDir, previewFile: plan.previewFile,
    expectedPublicUrl: patches.EXPECTED_PUBLIC_URL, sharp: plan.sharp, createdDirectories: [], files: entries };
  durableWrite(journalPath, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`));
  const changed = plan.states.filter(x => x.changed);
  for (let index = 0; index < changed.length; index += 1) {
    if (changed[index].beforeSha256 !== null) durableWrite(path.join(transactionDir, entries[index].backup), changed[index].beforeBytes);
  }
  for (const entry of entries) if (entry.backup && digest(fs.readFileSync(path.join(transactionDir, entry.backup))) !== entry.beforeSha256) fail('SHA резервной копии не совпал');
  journal.status = 'prepared';
  saveJournal(journalPath, journal);
  // Весь backup записан до первой замены. После сбоя manifest позволяет определить фактический исход.
  recheckStates(plan.states, 'beforeSha256');
  try {
    for (const directory of [path.join(plan.staticDir, 'cabinet'), path.join(plan.staticDir, 'palitra-editor-fonts')]) {
      assertPlainPath(directory, { directory: true, allowMissing: true });
      if (!fs.existsSync(directory)) {
        journal.createdDirectories.push(directory);
        saveJournal(journalPath, journal);
        fs.mkdirSync(directory, { mode: 0o755 });
      }
    }
    journal.status = 'applying';
    saveJournal(journalPath, journal);
    for (let index = 0; index < changed.length; index += 1) {
      const item = changed[index];
      if (fileState(item.target).sha256 !== item.beforeSha256) fail(`Состояние изменилось перед заменой: ${item.id}`);
      atomicReplace(item.target, item.bytes, item.beforeMode, token, index, item.beforeSha256);
    }
    recheckStates(changed, 'afterSha256');
    journal.status = 'applied-files-only';
    saveJournal(journalPath, journal);
    return { mode: 'apply', status: journal.status, manifest: journalPath, replacedFiles: changed.length, runtimeActivated: false };
  } catch (error) {
    journal.status = 'failed-needs-rollback';
    saveJournal(journalPath, journal);
    error.message += `; проверьте фактические SHA и используйте --rollback ${journalPath}`;
    throw error;
  }
}

function validateJournal(journal, directory) {
  if (!journal || journal.schema !== 1 || typeof journal.token !== 'string' || !/^[a-f0-9-]{36}$/.test(journal.token) || journal.serverBaseSha256 !== patches.SERVER_SHA256 || !Array.isArray(journal.files) || !Array.isArray(journal.createdDirectories)) fail('Неверный rollback manifest');
  const content = explicitAbsolute(journal.contentDir, 'manifest contentDir', true);
  const statics = explicitAbsolute(journal.staticDir, 'manifest staticDir', true);
  if (typeof journal.previewFile !== 'string' || !path.isAbsolute(journal.previewFile)) fail('Неверный manifest previewFile');
  const preview = path.resolve(journal.previewFile);
  if (!['index.html', 'bot-preview-index.html'].includes(path.basename(preview))) fail('Неверное имя preview в rollback manifest');
  const allowed = new Map([
    ['server/server.js', path.join(content, 'server.js')],
    ...PAYLOAD.map(item => [item.id, path.join(item.group === 'server' ? content : statics, item.relative)]), ['preview', preview]
  ]);
  const seen = new Set();
  for (let index = 0; index < journal.files.length; index += 1) {
    const entry = journal.files[index];
    if (!entry || !allowed.has(entry.id) || seen.has(entry.id) || !samePath(entry.target, allowed.get(entry.id)) || !SHA.test(entry.afterSha256) || !(entry.beforeSha256 === null || SHA.test(entry.beforeSha256))) fail('Rollback содержит цель вне whitelist');
    if (entry.id === 'server/server.js' && entry.beforeSha256 !== patches.SERVER_SHA256) fail('Rollback server.js не имеет нужный BASE SHA');
    seen.add(entry.id);
    if (entry.backup !== (entry.beforeSha256 === null ? null : `${index}.before`)) fail('Неверное имя backup');
    if (entry.temporaryName !== `.palitra-editor-release-${journal.token}-${index}.tmp`) fail('Неверное имя временного файла');
    if (entry.backup) {
      const backup = assertPlainPath(path.join(directory, entry.backup));
      if (digest(fs.readFileSync(backup)) !== entry.beforeSha256) fail(`Повреждён backup ${entry.id}`);
    }
    if (entry.beforeMode !== null && (!Number.isInteger(entry.beforeMode) || entry.beforeMode < 0 || entry.beforeMode > 0o777)) fail('Неверный mode в manifest');
  }
  for (const created of journal.createdDirectories) if (![path.join(statics, 'cabinet'), path.join(statics, 'palitra-editor-fonts')].some(x => samePath(x, created))) fail('Лишний каталог в rollback manifest');
  if (within(content, directory) || within(statics, directory) || within(ROOT, directory)) fail('Backup расположен внутри управляемого ресурса');
}

function rollback(manifestFile, { checkOnly = false } = {}) {
  const manifest = explicitAbsolute(manifestFile, '--rollback');
  const directory = path.dirname(manifest);
  const journal = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  validateJournal(journal, directory);
  const actions = [];
  for (const entry of journal.files) {
    const state = fileState(entry.target);
    // Разрешён и уже восстановленный файл: это делает повтор после сбоя безопасным.
    if (state.sha256 !== entry.afterSha256 && state.sha256 !== entry.beforeSha256) fail(`Rollback остановлен: неизвестный SHA ${entry.id}`);
    actions.push({ ...entry, restore: state.sha256 === entry.afterSha256 && state.sha256 !== entry.beforeSha256 });
  }
  if (checkOnly) return { mode: 'rollback-check-only', status: journal.status, files: actions.map(({ id, target, restore }) => ({ id, target, restore })) };
  journal.status = 'rolling-back';
  saveJournal(manifest, journal);
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    const state = fileState(action.target);
    if (state.sha256 !== action.beforeSha256 && state.sha256 !== action.afterSha256) fail(`Rollback остановлен перед записью: ${action.id}`);
    if (state.sha256 === action.beforeSha256) continue;
    if (action.beforeSha256 === null) fs.unlinkSync(action.target);
    else atomicReplace(action.target, fs.readFileSync(path.join(directory, action.backup)), action.beforeMode, journal.token, index, action.afterSha256);
    if (fileState(action.target).sha256 !== action.beforeSha256) fail(`Readback rollback не совпал: ${action.id}`);
  }
  for (const entry of journal.files) {
    const temp = path.join(path.dirname(entry.target), entry.temporaryName);
    assertPlainPath(temp, { allowMissing: true });
    if (fs.existsSync(temp)) {
      if (digest(fs.readFileSync(temp)) !== entry.afterSha256 && digest(fs.readFileSync(temp)) !== entry.beforeSha256) fail('Неизвестный временный файл: уборка остановлена');
      fs.unlinkSync(temp);
    }
  }
  for (const directoryPath of [...journal.createdDirectories].reverse()) {
    assertPlainPath(directoryPath, { directory: true, allowMissing: true });
    if (fs.existsSync(directoryPath) && fs.readdirSync(directoryPath).length === 0) fs.rmdirSync(directoryPath);
  }
  journal.status = 'rolled-back-files-only';
  saveJournal(manifest, journal);
  return { mode: 'rollback', status: journal.status, manifest, restoredFiles: actions.filter(x => x.restore).length, runtimeActivated: false };
}

function parseArguments(argv) {
  const options = {};
  const values = new Map([
    ['--content-dir', 'contentDir'], ['--static-dir', 'staticDir'], ['--preview-file', 'previewFile'],
    ['--preview-sha256', 'previewSha256'], ['--sharp-module', 'sharpModule'], ['--baseline', 'baselineFile'],
    ['--backup-dir', 'backupDir'], ['--rollback', 'rollbackFile']
  ]);
  const flags = new Map([['--check-only', 'checkOnly'], ['--inspect-only', 'inspectOnly'], ['--apply', 'apply'], ['--help', 'help']]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const key = flags.get(arg) || values.get(arg);
    if (!key || options[key] !== undefined) fail(`Неизвестный или повторный параметр ${arg}`);
    if (flags.has(arg)) options[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(`Нет значения ${arg}`);
      options[key] = argv[++i];
    }
  }
  return options;
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) return { usage: 'node install.cjs (--inspect-only | --check-only | --apply) --content-dir ABS --static-dir ABS --preview-file ABS --preview-sha256 SHA --sharp-module ABS [--baseline ABS] [--backup-dir ABS]; node install.cjs --rollback ABS [--check-only]', defaults: 'none', writes: 'только whitelist файлов, временные соседи, два каталогa static и отдельный backup; без runtime/БД/прав' };
  if (options.rollbackFile) {
    if (options.apply || options.inspectOnly || options.baselineFile || options.backupDir || options.contentDir || options.staticDir || options.previewFile || options.previewSha256 || options.sharpModule) fail('Rollback нельзя смешивать с установкой');
    verifyPackage();
    return rollback(options.rollbackFile, { checkOnly: !!options.checkOnly });
  }
  if ([options.inspectOnly, options.checkOnly, options.apply].filter(Boolean).length !== 1) fail('Нужен ровно один явный режим --inspect-only / --check-only / --apply');
  if (!options.inspectOnly) {
    const baselinePath = explicitAbsolute(options.baselineFile, '--baseline');
    options.baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } else if (options.baselineFile || options.backupDir) fail('--inspect-only не принимает baseline/backup');
  if (!options.apply && options.backupDir) fail('--backup-dir только для --apply');
  const plan = makePlan(options, { inspect: !!options.inspectOnly });
  if (options.inspectOnly) return plan.baseline;
  if (options.checkOnly) return publicPlan(plan);
  return applyPlan(plan, options.backupDir);
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { SERVER_NAMES, STATIC_NAMES, PAYLOAD, TARGET_IDS, digest, makePlan, publicPlan, applyPlan, rollback, main, verifyPackage, validateJournal };
