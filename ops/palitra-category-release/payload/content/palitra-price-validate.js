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

/* PALITRA_PHOTO_FRAME_V1 BEGIN — общий модуль кадра фото товара (PALITRA-PHOTO-COMPOSITION-36, 13.10.2026).
   Один и тот же текст (побайтно) вставляется сборкой WORK/build.cjs в: публичный /price-render.js, редактор
   palitra-editor-model.js и серверный palitra-price-validate.js. Поэтому превью редактора, карточка, окно товара
   и корзина считают кадр одинаково, а сервер проверяет те же правила, что и модель.

   Данные (необязательное поле товара): item.photoFrames = [{ v: 1, src, x, y, scale }, …], не больше 9.
   - src — адрес фото из прайса до преобразования (item.photo или элемент item.gallery, после trim), не индекс;
   - x, y — точка снимка (0…1 внутри полезной части снимка), которая стоит в центре рамки;
   - scale — 1…4, увеличение относительно «фото целиком» (contain) полезной части снимка.
   Без записи для фото — показ как раньше (contain по центру; 8 снимков с рамкой телефона — их прежняя маска).
   Исходный файл никогда не перерисовывается: меняется только положение/масштаб элемента img в рамке. */
const PALITRA_PHOTO_FRAME = (function () {
  'use strict';
  const VERSION = 1;
  const MAX_FRAMES = 9;
  const MIN_SCALE = 1;
  const MAX_SCALE = 4;
  const DEFAULT = Object.freeze({ x: 0.5, y: 0.5, scale: 1 });
  const KEYS = 'scale,src,v,x,y';
  const PHOTO_ORIGIN = 'https://palitra-love.ru';
  /* 8 подтверждённых снимков с рамкой телефона: полезная часть в смысле object-fit:cover —
     [ширина/высота полезной части, позиция по X, позиция по Y]. Значения взяты из storefront.css
     ALL_PHONE_FRAMES_20261013 (черновик 229), поэтому кадр по умолчанию совпадает с маской сайта. */
  const PHONE = Object.freeze({
    'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/b298da647f10164319be4f522545b46c.jpg': Object.freeze([1290 / 2293, 0.5, 0.49900596421]),
    'https://palitra-love.ru/api/assets/mu57hpv8-import-drive-manual-017.webp': Object.freeze([738 / 1313, 0.5, 0.49825783972]),
    'https://palitra-love.ru/api/assets/mu57hqwj-import-drive-manual-007.webp': Object.freeze([740 / 1326, 0.5, 0.5]),
    'https://palitra-love.ru/api/assets/mu57hrnk-import-tg-366-5.webp': Object.freeze([738 / 1313, 0.5, 0.49825783972]),
    'https://palitra-love.ru/api/assets/mu57hruk-import-tg-366-6.webp': Object.freeze([738 / 1313, 0.5, 0.49825783972]),
    'https://palitra-love.ru/api/assets/mu57htdm-import-tg-310-2.webp': Object.freeze([738 / 1313, 0.5, 0.49825783972]),
    'https://palitra-love.ru/api/assets/mu57ilxc-import-tg-503-2.webp': Object.freeze([738 / 1313, 0.5, 0.49825783972]),
    'https://palitra-love.ru/api/assets/mu57imni-import-drive-manual-012.webp': Object.freeze([738 / 1313, 0.5, 0.49825783972])
  });
  const STYLE_KEYS = ['position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
    'margin', 'padding', 'aspect-ratio', 'object-fit', 'object-position', 'transform', 'translate', 'scale', 'clip-path'];

  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const unit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  const scaleOk = (v) => typeof v === 'number' && Number.isFinite(v) && v >= MIN_SCALE && v <= MAX_SCALE;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = (v) => Math.round(v * 10000) / 10000;
  const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

  /* Публичный адрес фото — как imageUrl в price-render.js и photoUrl корзины: /api/assets/ — с palitra-love.ru. */
  function publicUrl(raw) {
    const photo = typeof raw === 'string' ? raw.trim() : '';
    if (!photo) return '';
    return photo.startsWith('/api/assets/') ? PHOTO_ORIGIN + photo : photo;
  }
  /* Фото товара в порядке показа: обложка, затем gallery; после trim, без повторов. */
  function sourcesOf(item) {
    const out = [];
    const add = (p) => { const s = typeof p === 'string' ? p.trim() : ''; if (s && !out.includes(s)) out.push(s); };
    if (isPlain(item)) { add(item.photo); if (Array.isArray(item.gallery)) item.gallery.forEach(add); }
    return out;
  }

  /* Адрес фото в записи кадра — те же правила, что isSafeStoredPhoto сервера и safePhoto рендера, строже по краям:
     путь сайта «/…» (не «//») или https://; без управляющих символов, пробелов, обратной косой черты, кавычек и <>.
     Проверяется даже если адрес совпадает с item.photo: небезопасный src нового кадра не принимается. */
  const UNSAFE_SRC = /[\u0000-\u001f\u007f\s\\"'<>`]/;
  function safeSrc(value) {
    if (typeof value !== 'string' || !value || value.length > 2048 || UNSAFE_SRC.test(value)) return false;
    if (value.startsWith('/')) return !value.startsWith('//');
    if (!/^https:\/\//i.test(value)) return false;
    try { return new URL(value).protocol === 'https:'; } catch (_) { return false; }
  }

  /* ---------- проверка данных (модель редактора и сервер — одни правила) ---------- */
  function entryProblem(entry, sources) {
    if (!isPlain(entry)) return 'настройка кадра должна быть объектом';
    if (Object.keys(entry).sort().join(',') !== KEYS) return 'в настройке кадра неизвестные или пропущенные поля';
    if (entry.v !== VERSION) return 'неизвестная версия настройки кадра';
    if (!safeSrc(entry.src)) return 'недопустимый адрес фото в настройке кадра';
    if (!sources.includes(entry.src)) return 'кадр задан для фото, которого нет у этого товара';
    if (!unit(entry.x) || !unit(entry.y)) return 'положение кадра должно быть числом от 0 до 1';
    if (!scaleOk(entry.scale)) return `масштаб кадра должен быть числом от ${MIN_SCALE} до ${MAX_SCALE}`;
    return '';
  }
  /* Список проблем поля photoFrames товара; нет поля — проблем нет (прежние товары проходят как раньше). */
  function itemProblems(item) {
    if (!isPlain(item) || item.photoFrames === undefined) return [];
    const id = String(item.id);
    const list = item.photoFrames;
    if (!Array.isArray(list)) return [`Позиция ${id}: photoFrames должен быть списком`];
    const out = [];
    if (list.length > MAX_FRAMES) out.push(`Позиция ${id}: больше ${MAX_FRAMES} настроек кадра`);
    const sources = sourcesOf(item);
    const seen = new Set();
    list.slice(0, MAX_FRAMES + 1).forEach((entry, i) => {
      const problem = entryProblem(entry, sources);
      if (problem) out.push(`Позиция ${id}: кадр №${i + 1}: ${problem}`);
      else if (seen.has(entry.src)) out.push(`Позиция ${id}: кадр №${i + 1}: фото указано дважды`);
      else seen.add(entry.src);
    });
    return out;
  }
  function normalize(frame) {
    const f = isPlain(frame) ? frame : {};
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    return { x: round(clamp(num(f.x, DEFAULT.x), 0, 1)), y: round(clamp(num(f.y, DEFAULT.y), 0, 1)),
      scale: round(clamp(num(f.scale, DEFAULT.scale), MIN_SCALE, MAX_SCALE)) };
  }
  const isDefault = (frame) => { const f = normalize(frame); return f.x === DEFAULT.x && f.y === DEFAULT.y && f.scale === DEFAULT.scale; };
  /* Сохранённые кадры товара: src → { x, y, scale }. Неверные записи пропускаются (показ по умолчанию). */
  function framesOf(item) {
    const out = new Map();
    if (!isPlain(item) || !Array.isArray(item.photoFrames)) return out;
    const sources = sourcesOf(item);
    for (const entry of item.photoFrames.slice(0, MAX_FRAMES)) {
      if (entryProblem(entry, sources) || out.has(entry.src)) continue;
      out.set(entry.src, normalize(entry));
    }
    return out;
  }
  /* Записи для товара в порядке фото: только для фото товара и только отличные от «по умолчанию». */
  function toEntries(photos, frames) {
    const out = [];
    for (const src of Array.isArray(photos) ? photos : []) {
      if (typeof src !== 'string' || !isPlain(frames) || !Object.prototype.hasOwnProperty.call(frames, src)) continue;
      const f = normalize(frames[src]);
      if (!isDefault(f) && !out.some((e) => e.src === src) && out.length < MAX_FRAMES) out.push({ v: VERSION, src, x: f.x, y: f.y, scale: f.scale });
    }
    return out;
  }
  /* Значение атрибута data-photo-frame в разметке карточки: «x y scale». */
  function formatAttr(frame) { const f = normalize(frame); return `${f.x} ${f.y} ${f.scale}`; }
  function parseAttr(value) {
    const m = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)$/.exec(String(value || ''));
    if (!m) return null;
    const f = { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
    return unit(f.x) && unit(f.y) && scaleOk(f.scale) ? normalize(f) : null;
  }

  /* ---------- геометрия ---------- */
  /* Полезная часть снимка в пикселях исходника: у 8 снимков с рамкой телефона — без интерфейса телефона, иначе весь снимок. */
  function usefulRect(displayUrl, natW, natH) {
    if (!positive(natW) || !positive(natH)) return null;
    const phone = Object.prototype.hasOwnProperty.call(PHONE, displayUrl) ? PHONE[displayUrl] : null;
    if (!phone) return { x: 0, y: 0, w: natW, h: natH };
    const [aspect, px, py] = phone;
    if (natW / natH > aspect) { const w = natH * aspect; return { x: px * (natW - w), y: 0, w, h: natH }; }
    const h = natW / aspect;
    return { x: 0, y: py * (natH - h), w: natW, h };
  }
  /* Сдвиг по одной оси: больше рамки — без пустых полей; меньше — целиком внутри рамки. */
  function axis(box, size, focus) {
    const want = box / 2 - focus * size;
    return size >= box ? clamp(want, box - size, 0) : clamp(want, 0, box - size);
  }
  /* Раскладка в пикселях рамки boxW×boxH: положение и размер всего элемента img и обрезка до полезной части. */
  function layout(boxW, boxH, natW, natH, useful, frame) {
    if (![boxW, boxH, natW, natH].every(positive)) return null;
    const u = isPlain(useful) && positive(useful.w) && positive(useful.h) ? useful : { x: 0, y: 0, w: natW, h: natH };
    const f = normalize(frame);
    const k = Math.min(boxW / u.w, boxH / u.h) * f.scale;
    const dw = u.w * k, dh = u.h * k;
    const ox = axis(boxW, dw, f.x), oy = axis(boxH, dh, f.y);
    return { k, left: ox - u.x * k, top: oy - u.y * k, width: natW * k, height: natH * k,
      visible: { x: ox, y: oy, w: dw, h: dh },
      clip: { top: u.y / natH, right: (natW - u.x - u.w) / natW, bottom: (natH - u.y - u.h) / natH, left: u.x / natW } };
  }
  const pct = (fraction) => `${Math.round(fraction * 1000000) / 10000}%`;
  /* Те же числа в процентах рамки — не зависят от абсолютного размера рамки, только от её пропорции. */
  function css(L, boxW, boxH) {
    return { left: pct(L.left / boxW), top: pct(L.top / boxH), width: pct(L.width / boxW), height: pct(L.height / boxH),
      clip: `inset(${pct(L.clip.top)} ${pct(L.clip.right)} ${pct(L.clip.bottom)} ${pct(L.clip.left)})` };
  }
  /* Перетаскивание на dx, dy пикселей рамки: новая точка в центре с учётом тех же ограничений, что у показа. */
  function pan(frame, dx, dy, boxW, boxH, natW, natH, useful) {
    const f = normalize(frame);
    const L = layout(boxW, boxH, natW, natH, useful, f);
    if (!L || !Number.isFinite(dx) || !Number.isFinite(dy)) return f;
    const v = L.visible;
    const ox = axis(boxW, v.w, (boxW / 2 - (v.x + dx)) / v.w);
    const oy = axis(boxH, v.h, (boxH / 2 - (v.y + dy)) / v.h);
    return normalize({ x: (boxW / 2 - ox) / v.w, y: (boxH / 2 - oy) / v.h, scale: f.scale });
  }
  function zoom(frame, scale) { return normalize({ ...normalize(frame), scale }); }

  /* Применение к элементу img внутри рамки box (публичная карточка, окно товара, корзина и превью редактора).
     Меняются только inline-стили img (с important — выше масок storefront.css) и overflow рамки. */
  function applyImg(img, box, frame, displayUrl) {
    if (!img || !box || !img.style || !box.style) return false;
    const w = img.naturalWidth, h = img.naturalHeight, bw = box.clientWidth, bh = box.clientHeight;
    const L = layout(bw, bh, w, h, usefulRect(displayUrl, w, h), frame || DEFAULT);
    if (!L) return false;
    const c = css(L, bw, bh);
    const set = (key, value) => img.style.setProperty(key, value, 'important');
    set('position', 'absolute'); set('left', c.left); set('top', c.top); set('right', 'auto'); set('bottom', 'auto');
    set('width', c.width); set('height', c.height); set('max-width', 'none'); set('max-height', 'none');
    set('min-width', '0'); set('min-height', '0'); set('margin', '0'); set('padding', '0'); set('aspect-ratio', 'auto');
    set('object-fit', 'fill'); set('object-position', '50% 50%'); set('transform', 'none'); set('translate', 'none');
    set('scale', 'none'); set('clip-path', c.clip);
    box.style.setProperty('overflow', 'hidden');
    return true;
  }
  function clearImg(img) { if (img && img.style) for (const key of STYLE_KEYS) img.style.removeProperty(key); }

  return Object.freeze({ VERSION, MAX_FRAMES, MIN_SCALE, MAX_SCALE, DEFAULT, PHONE, STYLE_KEYS,
    publicUrl, sourcesOf, safeSrc, entryProblem, itemProblems, normalize, isDefault, framesOf, toEntries, formatAttr, parseAttr,
    usefulRect, layout, css, pan, zoom, applyImg, clearImg });
})();
/* PALITRA_PHOTO_FRAME_V1 END */

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
  // Поводы товара: постоянные + принятые свои категории документа (PALITRA-CATEGORY-LINK) — тот же резолвер,
  // что у редактора и витрины. Основные 6 и праздники — только постоянные категории.
  const known = knownKeys || O.baseKeys(O.categoriesOf(doc));
  const core = known.filter((k) => !O.isCustomKey(k));
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
      // Кадр фото (PALITRA-PHOTO-COMPOSITION-36): числа и пределы, известная версия, только фото этого товара.
      problems.push(...PALITRA_PHOTO_FRAME.itemProblems(it));
    }
  }
  if (doc.publicCatalog !== undefined) {
    if (!isObject(doc.publicCatalog)) problems.push('publicCatalog должен быть объектом');
    else {
      problems.push(...O.homeProblems(doc.publicCatalog.home, core));
      problems.push(...O.holidaysProblems(doc.publicCatalog.holidays, core));
      problems.push(...O.customCategoriesProblems(doc.publicCatalog.categories, doc));
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
  isPalitraPrice, isSafeStoredPhoto, MAX_GALLERY, CAS_HEADER, CAS_HEADER_VALUE, photoFrame: PALITRA_PHOTO_FRAME
};
