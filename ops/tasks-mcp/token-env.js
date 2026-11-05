'use strict';

// Operator-only preparation tool. Not imported by the MCP service and never runs Docker.
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomBytes} = require('node:crypto');
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const KEY = 'TASKS_MCP_TOKEN';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const codes = new Set(['INVALID_TARGET', 'INVALID_VERSION', 'UNSAFE_FILE', 'UNSAFE_DIRECTORY', 'INVALID_ENV',
  'INVALID_TOKEN', 'TOKEN_UNCHANGED', 'ROTATION_LOCKED', 'VERSION_CONFLICT', 'ROTATION_REFUSED', 'ENV_CHANGED_VERIFY_REQUIRED']);
const sameFile = (left, right) => ['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'].every(key => left[key] === right[key]);

function refused(code) { throw Object.assign(new Error('Операция с ключом не подтверждена; значение секрета скрыто.'), {code}); }
function requireSingleLineValues(lines) {
  for (const line of lines) {
    const body = line.replace(/^[\uFEFF \t]*/, '').replace(/\r$/, '');
    if (!body || body.startsWith('#')) continue;
    const assignment = /^(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*(.*)$/.exec(body);
    if (!assignment) refused('INVALID_ENV');
    const value = assignment[1], quote = value[0];
    if (quote !== "'" && quote !== '"') continue;
    let end = -1;
    for (let index = 1; index < value.length; index++) {
      if (value[index] === '\\') { index++; continue; }
      if (value[index] === quote) { end = index; break; }
    }
    if (end < 0 || !/^[ \t]*(?:#.*)?$/.test(value.slice(end + 1))) refused('INVALID_ENV');
  }
}
function tokenLine(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) refused('INVALID_ENV');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refused('INVALID_ENV');
  const lines = text.split('\n'), found = [];
  // Never mistake a line inside another variable's multiline value for the key.
  // Unsupported dotenv syntax is refused instead of parsing/re-serializing other values.
  requireSingleLineValues(lines);
  for (let index = 0; index < lines.length; index++) {
    const body = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    if (!/^[\uFEFF \t]*(?:export[ \t]+)?TASKS_MCP_TOKEN[ \t]*=/.test(body)) continue;
    const match = /^([\uFEFF \t]*(?:export[ \t]+)?TASKS_MCP_TOKEN[ \t]*=[ \t]*)(?:([A-Za-z0-9_-]{32,256})|'([A-Za-z0-9_-]{32,256})'|"([A-Za-z0-9_-]{32,256})")([ \t]*(?:#.*)?)$/.exec(body);
    if (!match) refused('INVALID_ENV');
    found.push({index, match, ending: lines[index].endsWith('\r') ? '\r' : ''});
  }
  if (found.length !== 1) refused('INVALID_ENV');
  return {lines, ...found[0]};
}

function replaceToken(bytes, replacement) {
  if (typeof replacement !== 'string' || !TOKEN.test(replacement)) refused('INVALID_TOKEN');
  const row = tokenLine(bytes), previous = row.match[2] || row.match[3] || row.match[4];
  if (previous === replacement) refused('TOKEN_UNCHANGED');
  const quote = row.match[3] ? "'" : row.match[4] ? '"' : '';
  row.lines[row.index] = row.match[1] + quote + replacement + quote + row.match[5] + row.ending;
  return Buffer.from(row.lines.join('\n'), 'utf8');
}

function target(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) refused('INVALID_TARGET');
  const absolute = path.resolve(file), parent = path.dirname(absolute), realParent = fs.realpathSync(parent);
  const equivalent = process.platform === 'win32' ? realParent.toLowerCase() === parent.toLowerCase() : realParent === parent;
  if (!equivalent) refused('UNSAFE_DIRECTORY');
  if (process.platform !== 'win32') {
    const directory = fs.statSync(parent);
    if ((directory.mode & 0o022) || directory.uid !== process.getuid()) refused('UNSAFE_DIRECTORY');
  }
  return {absolute, parent};
}

function snapshot(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) refused('UNSAFE_FILE');
  if (process.platform !== 'win32' && ((before.mode & 0o777) !== 0o600 || before.uid !== process.getuid())) refused('UNSAFE_FILE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !sameFile(stat, before)) refused('VERSION_CONFLICT');
    const bytes = fs.readFileSync(fd);
    if (!sameFile(stat, fs.fstatSync(fd))) refused('VERSION_CONFLICT');
    tokenLine(bytes);
    return {stat, bytes, sha256: digest(bytes)};
  } finally { fs.closeSync(fd); }
}

function inspectEnvFile(file) {
  try {
    const checked = target(file), value = snapshot(checked.absolute);
    return {state:'INSPECTED_NOT_CHANGED', sha256:value.sha256, secretValue:'REDACTED'};
  } catch (error) { refused(codes.has(error.code) ? error.code : 'ROTATION_REFUSED'); }
}

function rotateTokenFile(file, expectedSha256, options = {}) {
  let lockFd, tempFd, temporary, lock, tempOwned = false, committed = false;
  try {
    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) refused('INVALID_VERSION');
    const checked = target(file);
    lock = path.join(checked.parent, '.tasks-mcp-token-rotation.lock');
    try { lockFd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') refused('ROTATION_LOCKED'); throw error; }
    const old = snapshot(checked.absolute);
    if (old.sha256 !== expectedSha256) refused('VERSION_CONFLICT');
    // Injectable only for isolated tests; CLI always uses cryptographic server-side randomness.
    const replacement = options.tokenFactory ? options.tokenFactory() : randomBytes(32).toString('hex');
    const bytes = replaceToken(old.bytes, replacement);
    temporary = path.join(checked.parent, '.tasks-mcp-token-' + randomBytes(12).toString('hex') + '.tmp');
    tempFd = fs.openSync(temporary, 'wx', 0o600);
    tempOwned = true;
    if (process.platform !== 'win32') {
      const created = fs.fstatSync(tempFd);
      if (created.uid !== old.stat.uid || created.gid !== old.stat.gid) fs.fchownSync(tempFd, old.stat.uid, old.stat.gid);
      fs.fchmodSync(tempFd, 0o600);
    }
    fs.writeFileSync(tempFd, bytes); fs.fsyncSync(tempFd); fs.closeSync(tempFd); tempFd = undefined;
    options.beforeCommit?.(); // Tests exercise an unrelated writer between the two snapshots.
    const fresh = snapshot(checked.absolute);
    if (fresh.sha256 !== old.sha256 || !sameFile(fresh.stat, old.stat)) refused('VERSION_CONFLICT');
    fs.renameSync(temporary, checked.absolute); committed = true; temporary = undefined; tempOwned = false;
    if (process.platform !== 'win32') {
      const directoryFd = fs.openSync(checked.parent, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
    if (digest(fs.readFileSync(checked.absolute)) !== digest(bytes)) refused('ENV_CHANGED_VERIFY_REQUIRED');
    return {state:'ENV_CHANGED_RECREATE_REQUIRED', sha256:digest(bytes), secretValue:'REDACTED', generatedLength:replacement.length};
  } catch (error) {
    refused(committed ? 'ENV_CHANGED_VERIFY_REQUIRED' : codes.has(error.code) ? error.code : 'ROTATION_REFUSED');
  } finally {
    if (tempFd !== undefined) try { fs.closeSync(tempFd); } catch {}
    if (temporary && tempOwned) try { fs.unlinkSync(temporary); } catch {}
    if (lockFd !== undefined) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(lock); } catch {}
    }
  }
}

function main(args = process.argv.slice(2)) {
  try {
    // Native production operation only; Windows can run pure unit tests on synthetic files.
    if (process.platform !== 'linux') refused('ROTATION_REFUSED');
    const [operation, envFlag, file, hashFlag, hash] = args;
    if (envFlag !== '--env-file' || !['inspect','rotate'].includes(operation) ||
      (operation === 'inspect' && args.length !== 3) ||
      (operation === 'rotate' && (args.length !== 5 || hashFlag !== '--expected-sha256'))) refused('INVALID_TARGET');
    const result = operation === 'inspect' ? inspectEnvFile(file) : rotateTokenFile(file, hash);
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({state:error.code === 'ENV_CHANGED_VERIFY_REQUIRED' ? 'UNKNOWN_AFTER_ENV_CHANGE' : 'REFUSED',
      error:codes.has(error.code) ? error.code : 'ROTATION_REFUSED', secretValue:'REDACTED'}) + '\n');
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = {replaceToken, inspectEnvFile, rotateTokenFile};
