'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_DOCUMENT_BYTES = 512 * 1024;
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };

function documentPath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 ||
      value !== value.normalize('NFC') || /[\\\x00-\x1f:%?#]/u.test(value) ||
      path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail(400, 'Нужен относительный путь документа из карты');
  }
  return value;
}

async function readBounded(root, relative, {map = false} = {}) {
  documentPath(relative);
  try {
    const absoluteRoot = path.resolve(root);
    const rootInfo = await fs.lstat(absoluteRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail(503, 'Каталог документов недоступен');
    const canonicalRoot = await fs.realpath(absoluteRoot);
    let current = absoluteRoot;
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
        fail(400, 'Ссылки вне каталога документов запрещены');
      }
    }
    const real = await fs.realpath(current);
    if (!real.startsWith(canonicalRoot + path.sep)) fail(400, 'Документ вне разрешённого каталога');
    const handle = await fs.open(current, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) fail(413, 'Документ слишком большой');
      const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      if (bytesRead > MAX_DOCUMENT_BYTES) fail(413, 'Документ слишком большой');
      return new TextDecoder('utf-8', {fatal:true}).decode(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.status) throw error;
    if (map && ['ENOENT', 'ENOTDIR'].includes(error.code)) {
      throw Object.assign(new Error('Карта не установлена'), {status:503, code:'MAP_NOT_INSTALLED'});
    }
    fail(503, 'Документ карты отсутствует или недоступен; канон должен предоставить постановщик');
  }
}

async function readMap(root) {
  let map;
  try { map = JSON.parse(await readBounded(root, 'MAP.json', {map:true})); }
  catch (error) {
    if (error.status) throw error;
    fail(503, 'Карта документов повреждена');
  }
  if (!map || typeof map !== 'object' || Array.isArray(map) ||
      !Array.isArray(map.always) || !map.always.length || !Array.isArray(map.rules) ||
      map.rules.length > 200 || map.always.length > 50) fail(503, 'Некорректная карта документов');
  const validateList = values => Array.isArray(values) && values.length > 0 && values.length <= 50 &&
    values.every(value => { try { documentPath(value); return value !== 'MAP.json'; } catch { return false; } });
  if (!validateList(map.always) || map.rules.some(rule => !rule || typeof rule !== 'object' ||
      !validateList(rule.read) || !Array.isArray(rule.match) || !rule.match.length || rule.match.length > 50 ||
      rule.match.some(term => typeof term !== 'string' || !term.trim() || term.length > 100) ||
      typeof rule.why !== 'string' || !rule.why.trim() || rule.why.length > 2000)) {
    fail(503, 'Некорректная карта документов');
  }
  return map;
}

function selectedDocuments(map, request) {
  const selected = new Map(map.always.map(item => [item, {path:item, reasons:['Обязательный документ для каждой сессии']} ]));
  const query = request.toLocaleLowerCase('ru');
  for (const rule of map.rules) {
    if (!rule.match.some(term => query.includes(term.trim().toLocaleLowerCase('ru')))) continue;
    for (const item of rule.read) {
      if (!selected.has(item)) selected.set(item, {path:item, reasons:[]});
      if (!selected.get(item).reasons.includes(rule.why)) selected.get(item).reasons.push(rule.why);
    }
  }
  return [...selected.values()];
}

async function sessionDocuments(root, request) {
  const map = await readMap(root);
  const documents = selectedDocuments(map, request);
  // Проверяем поставленный канон до регистрации сессии и изменения состояния агента.
  for (const document of documents) await readBounded(root, document.path);
  return documents;
}

async function readDocument(root, relative) {
  documentPath(relative);
  const map = await readMap(root);
  const allowed = new Set([...map.always, ...map.rules.flatMap(rule => rule.read)]);
  if (!allowed.has(relative)) fail(404, 'Документ не включён в карту');
  return {path:relative, text:await readBounded(root, relative)};
}

module.exports = {sessionDocuments, readDocument, documentPath, readMap, MAX_DOCUMENT_BYTES};
