'use strict';
/* Серверная проверка и сохранение прайса Palitra (подготовлено, НЕ установлено). Применяется ТОЛЬКО к
   документу palitra/price (isPalitraPrice); остальные компании и документы остаются на прежнем validator и
   прежнем saveVersion без изменений.
   - validatePriceProblems(doc) — прежние правила validatePrice (разделы programs/table, блоки self/two,
     уникальные id, витрины self/two ≤ max, ≤ 8 популярных в разделе) + проверки новых необязательных полей.
     На любой форме JSON возвращает список проблем (→ 422), исключений нет.
   - saveWithCas(db, key, doc, author, ifMatch) — версия проверяется и записывается в одной транзакции SQLite
     BEGIN IMMEDIATE … COMMIT (повторное чтение версии внутри транзакции), при ошибке ROLLBACK.
   - CAS_HEADER — заголовок ответа GET palitra/price: «сервер проверяет If-Match». Редактор без него не сохраняет. */
let O;
try { O = require('./palitra-occasions.js'); } catch (_) { O = require('../reader/palitra-occasions.js'); }

const MAX_GALLERY = 8;
const CAS_HEADER = 'x-palitra-price-cas';
const CAS_HEADER_VALUE = '1';
const TEXT_FIELDS = ['title', 'price', 'desc', 'note', 'composition', 'card', 'duration', 'who'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

/* Строго один документ: /content/palitra/price. */
function isPalitraPrice(parts) { return Array.isArray(parts) && parts[1] === 'palitra' && parts[2] === 'price'; }

/* Тот же допуск, что у публичного рендера (safePhoto/safeImage): путь сайта «/…» (не «//») или https://.
   Управляющие символы, обратный слеш, кавычки и угловые скобки запрещены. */
function isSafeStoredPhoto(value) {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  if (value.length > 2048 || /[\x00-\x1f\x7f\\"'<>\s]/.test(value)) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  if (!/^https:\/\//i.test(value)) return false;
  try { return new URL(value).protocol === 'https:'; } catch (_) { return false; }
}

/* Форма документа: всё, что прежний validatePrice обходил бы с исключением (TypeError → 500). */
function shapeProblems(doc) {
  if (!isObject(doc)) return ['Документ прайса должен быть объектом'];
  if (!Array.isArray(doc.categories)) return ['Нет списка разделов categories'];
  const problems = [];
  doc.categories.forEach((cat, i) => {
    if (!isObject(cat)) { problems.push(`Раздел №${i + 1}: должен быть объектом`); return; }
    if (cat.items !== undefined && !Array.isArray(cat.items)) problems.push(`Раздел ${String(cat.id)}: items должен быть списком`);
    else list(cat.items).forEach((it, j) => { if (!isObject(it)) problems.push(`Раздел ${String(cat.id)}: позиция №${j + 1} должна быть объектом`); });
  });
  if (doc.showcase !== undefined && doc.showcase !== null && !isObject(doc.showcase)) problems.push('Витрины showcase должны быть объектом');
  if (doc.blocks !== undefined && doc.blocks !== null && !isObject(doc.blocks)) problems.push('Блоки blocks должны быть объектом');
  return problems;
}

/* Прежние правила validatePrice — те же сообщения на правильной форме; неверная форма уже отсеяна shapeProblems,
   но обход всё равно защищён (только объекты, только массивы). */
function legacyProblems(doc) {
  const problems = [];
  if (!isObject(doc) || !Array.isArray(doc.categories)) return ['Нет списка разделов categories'];
  const ids = new Set();
  for (const cat of doc.categories) {
    if (!isObject(cat) || typeof cat.id !== 'string' || !cat.id.trim()) { problems.push('У раздела нет id'); continue; }
    if (typeof cat.title !== 'string' || !cat.title.trim()) problems.push(`Раздел ${cat.id}: пустое название`);
    if (!['programs', 'table'].includes(cat.kind)) problems.push(`Раздел ${cat.id}: неизвестный тип ${String(cat.kind)}`);
    if (!['self', 'two'].includes(cat.block)) problems.push(`Раздел ${cat.id}: блок главной должен быть self или two`);
    if (ids.has(cat.id)) problems.push(`Повторяющийся id ${cat.id}`);
    ids.add(cat.id);
    for (const it of list(cat.items)) {
      if (!isObject(it) || typeof it.id !== 'string' || !it.id.trim()) { problems.push(`Раздел ${cat.id}: у позиции нет id`); continue; }
      if (ids.has(it.id)) problems.push(`Повторяющийся id ${it.id}`);
      ids.add(it.id);
      if (typeof it.title !== 'string' || !it.title.trim()) problems.push(`Позиция ${it.id}: пустое название`);
      if (it.oldPrice != null && typeof it.oldPrice !== 'string') problems.push(`Позиция ${it.id}: старая цена должна быть строкой`);
    }
  }
  const showcase = isObject(doc.showcase) ? doc.showcase : {};
  const blocks = isObject(doc.blocks) ? doc.blocks : {};
  for (const block of ['self', 'two']) {
    const ids2 = showcase[block] ?? [];
    if (!Array.isArray(ids2)) { problems.push(`Витрина ${block} должна быть списком id`); continue; }
    const max = Number(isObject(blocks[block]) ? blocks[block].max : undefined) || 8;
    if (ids2.length > max) problems.push(`Витрина ${block}: больше ${max} позиций (${ids2.length})`);
    for (const id of ids2) if (!ids.has(id)) problems.push(`Витрина ${block}: позиции ${String(id)} нет в прайсе`);
    if (new Set(ids2).size !== ids2.length) problems.push(`Витрина ${block}: позиции повторяются`);
  }
  const marked = list(showcase.self).concat(list(showcase.two));
  for (const cat of doc.categories) {
    if (!isObject(cat)) continue;
    const popular = list(cat.items).filter((it) => isObject(it) && marked.includes(it.id));
    if (popular.length > 8) problems.push(`Раздел ${String(cat.id)}: отмечено больше 8 популярных (${popular.length})`);
  }
  return problems;
}

function extensionProblems(doc, knownKeys) {
  const problems = [];
  if (!isObject(doc)) return problems;
  const known = knownKeys || O.baseKeys();
  for (const cat of list(doc.categories)) {
    if (!isObject(cat)) continue;
    for (const it of list(cat.items)) {
      if (!isObject(it) || typeof it.id !== 'string') continue;
      if (it.photo !== undefined && !isSafeStoredPhoto(it.photo)) problems.push(`Позиция ${it.id}: недопустимый адрес фото`);
      if (it.gallery !== undefined) {
        if (!Array.isArray(it.gallery)) problems.push(`Позиция ${it.id}: gallery должен быть списком`);
        else {
          if (it.gallery.length > MAX_GALLERY) problems.push(`Позиция ${it.id}: больше ${MAX_GALLERY} дополнительных фото`);
          if (it.gallery.some((p) => typeof p !== 'string' || !p || !isSafeStoredPhoto(p))) problems.push(`Позиция ${it.id}: недопустимый адрес в gallery`);
          if (new Set(it.gallery).size !== it.gallery.length) problems.push(`Позиция ${it.id}: фото в gallery повторяются`);
        }
      }
      if (it.publicCategories !== undefined) {
        if (!Array.isArray(it.publicCategories)) problems.push(`Позиция ${it.id}: publicCategories должен быть списком`);
        else {
          for (const k of it.publicCategories) if (typeof k !== 'string' || !known.includes(k)) problems.push(`Позиция ${it.id}: неизвестный повод ${String(k)}`);
          if (new Set(it.publicCategories).size !== it.publicCategories.length) problems.push(`Позиция ${it.id}: повод повторяется`);
        }
      }
      for (const k of TEXT_FIELDS) {
        if (it[k] != null && typeof it[k] !== 'string') problems.push(`Позиция ${it.id}: поле ${k} должно быть строкой`);
      }
    }
  }
  if (doc.publicCatalog !== undefined) {
    if (!isObject(doc.publicCatalog)) problems.push('publicCatalog должен быть объектом');
    else {
      problems.push(...O.homeProblems(doc.publicCatalog.home, known));
      problems.push(...O.holidaysProblems(doc.publicCatalog.holidays, known));
    }
  }
  return problems;
}

function validatePriceProblems(doc, options = {}) {
  try {
    const shape = shapeProblems(doc);
    if (shape.length) return shape;
    return legacyProblems(doc).concat(extensionProblems(doc, options.knownKeys));
  } catch (error) {
    // Страховка: проверка не должна превращать необычный документ в 500. Документ при этом не принимается.
    return ['Документ не удалось проверить: ' + String(error && error.message || error)];
  }
}

function httpError(status, message, details) { return Object.assign(new Error(message), { status, details }); }

/* If-Match: "<версия>" (как ETag ответа GET). Нет заголовка — прежние клиенты: { ok: true, cas: false }.
   strict: true — заголовок обязателен (428). Несовпадение — 409, документ не сохраняется. */
function checkIfMatch(header, latestVersion, options = {}) {
  const parsed = parseIfMatch(header);
  if (parsed.missing) return options.strict ? { ok: false, status: 428, error: 'Нужна версия прайса (If-Match)' } : { ok: true, cas: false };
  if (parsed.error) return { ok: false, status: 400, error: parsed.error };
  if (parsed.version !== Number(latestVersion || 0)) {
    return { ok: false, status: 409, error: `Прайс уже изменён: на сервере версия ${latestVersion}, правка сделана по версии ${parsed.version}`, currentVersion: latestVersion };
  }
  return { ok: true, cas: true };
}
function parseIfMatch(header) {
  if (header === undefined || header === null || header === '') return { missing: true };
  const m = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(String(header));
  if (!m) return { error: 'Неверный заголовок If-Match' };
  return { version: Number(m[1]) };
}

const LATEST_SQL = 'SELECT version FROM documents WHERE key = ? ORDER BY version DESC LIMIT 1';
const INSERT_SQL = 'INSERT INTO documents (key, version, created_at, author, body) VALUES (?, ?, ?, ?, ?)';
/* Сохранение palitra/price с проверкой версии в одной транзакции SQLite (node:sqlite DatabaseSync).
   BEGIN IMMEDIATE берёт блокировку записи до чтения версии: другой процесс/реплика с той же БД не может
   вставить версию между проверкой и записью. Версия перечитывается внутри транзакции. При любой ошибке — ROLLBACK.
   Занятая БД (SQLITE_BUSY) — 503: ничего не записано, редактор проверит исход свежим GET. */
function saveWithCas(db, key, doc, author, ifMatchHeader, options = {}) {
  const parsed = parseIfMatch(ifMatchHeader);
  if (parsed.missing && options.strict) throw httpError(428, 'Нужна версия прайса (If-Match)');
  if (parsed.error) throw httpError(400, parsed.error);
  try { db.exec('BEGIN IMMEDIATE'); } catch (error) {
    throw httpError(503, 'Прайс сейчас сохраняется в другом месте — ничего не записано, повторите позже');
  }
  let committed = false;
  try {
    const latest = db.prepare(LATEST_SQL).get(key);
    const current = latest ? Number(latest.version) : 0;
    if (!parsed.missing && parsed.version !== current) {
      throw httpError(409, `Прайс уже изменён: на сервере версия ${current}, правка сделана по версии ${parsed.version}`, [`currentVersion:${current}`]);
    }
    const version = current + 1;
    const now = (options.now ? new Date(options.now()) : new Date()).toISOString();
    const body = JSON.stringify({ ...doc, version, updatedAt: now });
    if (typeof options.beforeInsert === 'function') options.beforeInsert(); // только для тестов отказа
    db.prepare(INSERT_SQL).run(key, version, now, author || null, body);
    db.exec('COMMIT');
    committed = true;
    return { version, updatedAt: now, cas: !parsed.missing };
  } finally {
    if (!committed) { try { db.exec('ROLLBACK'); } catch (_) { /* транзакция уже закрыта */ } }
  }
}

module.exports = {
  validatePriceProblems, shapeProblems, legacyProblems, extensionProblems, checkIfMatch, parseIfMatch, saveWithCas,
  isPalitraPrice, isSafeStoredPhoto, MAX_GALLERY, CAS_HEADER, CAS_HEADER_VALUE
};
