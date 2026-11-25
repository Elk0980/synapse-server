'use strict';
// Точечная правка site-workspace-http.js (обработчик публичных адресов managed-сайтов *-draft-N):
// версионные медиа /tour-media/* отдаются с долгим кэшем, всё остальное — прежний no-store.
// Файл обработчика есть только в managed source tree сервера (в main его нет), поэтому правка
// переносится по якорю, а не копией файла. Range/206, проверки пути и остальные заголовки не меняются.
//
//   node patch.cjs check <site-workspace-http.js>          — только чтение: состояние и SHA256
//   node patch.cjs apply <site-workspace-http.js> <out.js>  — записать исправленную копию в out.js
const fs = require('node:fs');
const crypto = require('node:crypto');

const MARKER = '// TOUR-MEDIA-CACHE-20261125';
// Окончание строки (LF или CRLF) берётся из самого файла: снимок 05.11 хранится с CRLF.
const ANCHOR = /^( {6}'Content-Length':stat\.size,'Cache-Control':)'no-store'(\};)(\r?\n)/m;
const CONST_ANCHOR = /^(const \{TYPES,validPath\}=require\('\.\/site-workspaces'\);)(\r?\n)/m;
const CONST_LINE = "const TOUR_MEDIA=/^tour-media\\/(?:[^/]+\\/)*[^/]+\\.(?:mp4|webm|jpe?g|png|webp|avif)$/i;";
const LONG_CACHE = 'public, max-age=31536000, immutable';

const count = (text, re) => (text.match(new RegExp(re.source, 'gm')) || []).length;
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

function state(source) {
  if (source.includes(MARKER)) return 'applied';
  if (count(source, ANCHOR) === 1 && count(source, CONST_ANCHOR) === 1 && !source.includes('TOUR_MEDIA')) return 'ready';
  return 'anchor-mismatch';
}

function applyPatch(source) {
  const current = state(source);
  if (current === 'applied') return source;
  if (current !== 'ready') throw new Error('ANCHOR_MISMATCH: файл отличается от ожидаемого, правку переносить вручную');
  return source
    .replace(CONST_ANCHOR, (_, line, eol) => line + eol + CONST_LINE + eol)
    .replace(ANCHOR, (_, head, tail, eol) =>
      `      ${MARKER}: версионные медиа /tour-media/* (имя меняется при замене файла) кэшируются надолго.` + eol +
      `${head}TOUR_MEDIA.test(relative)?'${LONG_CACHE}':'no-store'${tail}${eol}`);
}

module.exports = { applyPatch, state, MARKER };

if (require.main === module) {
  const [mode, file, out] = process.argv.slice(2);
  if (!['check', 'apply'].includes(mode) || !file || (mode === 'apply' && !out)) {
    console.error('usage: node patch.cjs check FILE | apply FILE OUT'); process.exit(2);
  }
  const source = fs.readFileSync(file, 'utf8');
  if (mode === 'check') {
    console.log(JSON.stringify({ file, sha256: sha(source), state: state(source) }));
    process.exit(state(source) === 'anchor-mismatch' ? 1 : 0);
  }
  const patched = applyPatch(source);
  fs.writeFileSync(out, patched);
  console.log(JSON.stringify({ file, before: sha(source), out, after: sha(patched), state: state(patched) }));
}
