'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = __dirname;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const paths = [];
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'BUILD_MANIFEST.json' || entry.name.startsWith('.')) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Символические ссылки в пакете запрещены');
    if (entry.isDirectory()) scan(absolute);
    else if (entry.isFile()) paths.push(path.relative(ROOT, absolute).split(path.sep).join('/'));
    else throw new Error('Недопустимый тип файла');
  }
}
scan(ROOT);
const files = paths.sort().map(relative => {
  const bytes = fs.readFileSync(path.join(ROOT, relative));
  return { path: relative, bytes: bytes.length, sha256: digest(bytes) };
});
const manifest = { schema: 1, release: 'PALITRA-BOT-EDITOR-35+12-18',
  serverBaseSha256: require('./patches/upstream-patches.cjs').SERVER_SHA256,
  expectedPublicUrl: 'https://palitra-love-draft-1.synapsebusiness.ru/',
  payloadFiles: files.filter(x => x.path.startsWith('payload/')).length, files };
fs.writeFileSync(path.join(ROOT, 'BUILD_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ files: files.length, payloadFiles: manifest.payloadFiles, manifestSha256: digest(fs.readFileSync(path.join(ROOT, 'BUILD_MANIFEST.json'))) })}\n`);
