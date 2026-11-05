'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateVapid } = require('./palitra-push.cjs');

/* Root-only one-time CLI; imported module does not generate keys or read environment. */
function privatePath(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.normalize(filename) !== filename) throw new Error('PRIVATE_ABSOLUTE_PATH_REQUIRED');
  let current = path.parse(filename).root;
  for (const part of path.relative(current,path.dirname(filename)).split(path.sep).filter(Boolean)) {
    current = path.join(current,part); const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('PRIVATE_PARENT_REFUSED');
  }
  const parent = fs.statSync(path.dirname(filename));
  if (process.platform !== 'win32' && (parent.uid !== 0 || (parent.mode & 0o077) !== 0)) throw new Error('PRIVATE_PARENT_MODE_REQUIRED');
}
function readVapid(filename) {
  privatePath(filename); const fd = fs.openSync(filename,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 2048 || info.size < 100 || (process.platform !== 'win32' && (info.uid !== 0 || (info.mode & 0o077) !== 0))) throw new Error('PRIVATE_KEY_FILE_REFUSED');
    const raw = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(filename);
    if (named.isSymbolicLink() || info.ino !== after.ino || info.dev !== after.dev || info.mtimeMs !== after.mtimeMs || info.size !== after.size || info.ino !== named.ino || info.dev !== named.dev) throw new Error('PRIVATE_KEY_FILE_CHANGED');
    return validateVapid(JSON.parse(raw));
  } finally { fs.closeSync(fd); }
}
function generate(filename, webpush) {
  if (process.platform === 'win32' || process.getuid() !== 0) throw new Error('NATIVE_ROOT_REQUIRED');
  privatePath(filename);
  const keys = webpush.generateVAPIDKeys();
  const value = validateVapid({schema:1,subject:'https://palitra-love.ru',...keys});
  const fd = fs.openSync(filename,fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),0o600);
  try { fs.writeFileSync(fd,JSON.stringify(value)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  readVapid(filename); return {status:'SERVER_PRIVATE_KEYS_CREATED',publicKey:value.publicKey};
}
if (require.main === module) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== 'generate') throw new Error('EXPLICIT_GENERATE_AND_PRIVATE_PATH_REQUIRED');
    const result = generate(process.argv[3],require('./palitra-push-deps/node_modules/web-push')); console.log(JSON.stringify(result));
  } catch { console.log(JSON.stringify({status:'REFUSED',code:'PRIVATE_KEY_SETUP_REFUSED'})); process.exitCode=2; }
}
module.exports = {readVapid,generate};
