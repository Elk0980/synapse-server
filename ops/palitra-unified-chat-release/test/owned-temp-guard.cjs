'use strict';
// Root QA: удаляется только временный каталог, созданный этим процессом.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const temp = fs.realpathSync(os.tmpdir());
const owned = new Map();
const inside = (root, value) => {
  const rel = path.relative(root, value);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
function remember(value) {
  const full = path.resolve(String(value)), real = fs.realpathSync(full);
  if (full !== temp && inside(temp, real)) owned.set(full, real);
  return value;
}
const makeSync = fs.mkdtempSync.bind(fs);
fs.mkdtempSync = (...args) => remember(makeSync(...args));
const makePromise = fs.promises.mkdtemp.bind(fs.promises);
fs.promises.mkdtemp = async (...args) => remember(await makePromise(...args));
const makeCallback = fs.mkdtemp.bind(fs);
fs.mkdtemp = (...args) => {
  const callback = args.pop();
  return makeCallback(...args, (error, value) => {
    if (error) return callback(error);
    try { remember(value); } catch (failure) { return callback(failure); }
    callback(null, value);
  });
};
function verify(target, options) {
  if (!options || !options.recursive) return;
  const full = path.resolve(String(target));
  const owner = [...owned].find(([root]) => inside(root, full));
  if (!owner || !inside(temp, full)) throw Error('Root QA cleanup refused: not an owned temporary path');
  let existing = full;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const real = fs.realpathSync(existing);
  if (!inside(owner[1], real)) throw Error('Root QA cleanup refused: resolved path escaped its temporary root');
}
const removeSync = fs.rmSync.bind(fs);
fs.rmSync = (target, options) => { verify(target, options); return removeSync(target, options); };
const removePromise = fs.promises.rm.bind(fs.promises);
fs.promises.rm = async (target, options) => { verify(target, options); return removePromise(target, options); };
module.exports = Object.freeze({ verify });
