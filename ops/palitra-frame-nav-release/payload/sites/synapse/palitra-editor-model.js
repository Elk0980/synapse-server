/* Palitra: модель редактора прайса — чистые функции без DOM и сети (браузер и Node).
   Прайс — общий документ /content/palitra/price. Правила:
   - товар остаётся одним объектом в своём разделе прайса (category.items) со старым id;
   - меняются только поля, которые владелец изменил в форме; неизвестные поля, blocks/showcase/links
     и порядок остаются байт-в-байт (сохранение без правок — тот же документ);
   - публичные поводы товара — item.publicCategories (нет поля — прежнее правило по разделу);
   - основные 6 и праздники — document.publicCatalog { home, holidays }.
   Невидимые символы в исходнике записаны только escape-последовательностями (\u{…}, \x..): буквальные
   U+2028/U+2029 внутри регулярного выражения — SyntaxError. */
(function (root, factory) {
  'use strict';
  const occasions = typeof module === 'object' && module.exports ? require('./palitra-occasions.js') : root.PalitraOccasions;
  const api = factory(occasions);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PalitraEditorModel = api;
})(typeof window === 'undefined' ? globalThis : window, function (O) {
  'use strict';
  if (!O) throw new Error('PalitraOccasions не загружен');
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
  const PF = PALITRA_PHOTO_FRAME;

  const MAX_GALLERY = 8;               // дополнительных фото, как в прежнем редакторе
  const MAX_PHOTOS = 1 + MAX_GALLERY;  // основное + дополнительные
  const MAX_DOCUMENT = 1024 * 1024;    // тот же предел, что у импорта
  const ITEM_ID = /^[a-zA-Z0-9_-]{1,80}$/;
  const TEXT_FIELDS = ['title', 'price', 'desc', 'note', 'composition', 'card', 'duration', 'who'];
  const MULTILINE = new Set(['desc', 'composition', 'note']);
  const LIMITS = { title: 200, price: 60, desc: 4000, note: 1000, composition: 4000, card: 200, duration: 120, who: 200 };
  /* Поля товара, которыми управляет форма. Остальные поля (oldPrice, quizEnabled, будущие) форма не трогает. */
  const EDITABLE = new Set(TEXT_FIELDS.concat(['items', 'photo', 'gallery', 'publicCategories', 'photoFrames']));

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  function withoutMeta(doc) {
    const copy = clone(doc) || {};
    delete copy.version; delete copy.updatedAt;
    return copy;
  }
  /* Обход без исключений: документ с сервера или из файла может быть любой формы. Разделы — только объекты,
     товары — только объекты из массива items; остальное пропускается (и попадает в shapeProblems). */
  const catsOf = (doc) => (isObject(doc) && Array.isArray(doc.categories) ? doc.categories.filter(isObject) : []);
  const itemsOf = (cat) => (isObject(cat) && Array.isArray(cat.items) ? cat.items.filter(isObject) : []);
  const idList = (value) => (Array.isArray(value) ? value : []);

  /* ---------- текст ---------- */
  // Управляющие символы убираются; в многострочных полях остаются переводы строк. HTML не трогается:
  // текст хранится как есть и всегда выводится экранированным (textContent / esc).
  // Невидимые символы направления текста и BOM (подмена отображения) убираются; ZWJ в эмодзи остаётся.
  const INVISIBLE = /[\u{200b}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu;
  const CONTROL_MULTILINE = /[\x00-\x09\x0b-\x1f\x7f\u{2028}\u{2029}]/gu;
  const CONTROL_LINE = /[\x00-\x1f\x7f\u{2028}\u{2029}]/gu;
  function cleanText(value, multiline) {
    let s = String(value ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLE, '');
    s = multiline ? s.replace(CONTROL_MULTILINE, '') : s.replace(CONTROL_LINE, ' ');
    s = multiline ? s.split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n').trim() : s.replace(/\s+/g, ' ').trim();
    return s;
  }
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normSearch = (value) => String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

  /* Цена — как в прежнем редакторе: однозначное число приводится к «7 720 руб.», текст сохраняется как есть. */
  const PRICE_INPUT = /^\s*(\d[\d\s]*)(?:[.,](\d{1,2}))?\s*(?:руб\.?|р\.?|₽)?\s*$/i;
  function normalizePrice(raw) {
    const text = String(raw ?? '').replace(/[\xa0\u{202f}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return { value: '', kind: 'empty' };
    const m = PRICE_INPUT.exec(text);
    if (!m) return { value: text, kind: 'text' };
    const digits = m[1].replace(/\s+/g, '');
    if (!/^\d{1,13}$/.test(digits)) return { value: text, kind: 'text' };
    const rub = digits.replace(/^0+(?=\d)/, '');
    const kop = (m[2] || '').padEnd(2, '0');
    if (rub === '0' && kop === '00') return { value: text, kind: 'text' };
    const grouped = rub.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return { value: `${grouped}${kop === '00' ? '' : ',' + kop} руб.`, kind: 'number' };
  }

  /* ---------- адреса фото ---------- */
  // Новые адреса: только загруженные файлы кабинета (/api/assets/<имя>) или фото сайта (/assets/img/…).
  // javascript:, data:, внешние сайты, //хост, обратные слеши, «..», пробелы и кавычки — запрещены.
  const ASSET_PATH = /^\/api\/assets\/[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/;
  const SITE_IMG_PATH = /^\/assets\/img\/[A-Za-z0-9_-][A-Za-z0-9_.\/-]{0,200}$/;
  function isSafePhotoPath(value) {
    if (typeof value !== 'string' || value.length > 240) return false;
    if (value.includes('..') || value.includes('//')) return false;
    return ASSET_PATH.test(value) || SITE_IMG_PATH.test(value);
  }
  const isUploadedAsset = (value) => typeof value === 'string' && ASSET_PATH.test(value) && !value.includes('..');

  /* ---------- индекс ---------- */
  function findItem(doc, id) {
    for (const cat of catsOf(doc)) {
      const list = Array.isArray(cat.items) ? cat.items : [];
      const index = list.findIndex((it) => isObject(it) && it.id === id);
      if (index >= 0) return { cat, item: list[index], index };
    }
    return null;
  }
  function itemCount(doc) { return catsOf(doc).reduce((n, cat) => n + itemsOf(cat).length, 0); }
  function usedIds(doc) {
    const ids = new Set();
    for (const cat of catsOf(doc)) { ids.add(cat.id); for (const it of itemsOf(cat)) ids.add(it.id); }
    return ids;
  }
  function galleryOf(item) { return Array.isArray(item && item.gallery) ? item.gallery.filter((p) => typeof p === 'string' && p.trim()) : []; }
  function photosOf(item) {
    const cover = typeof item?.photo === 'string' ? item.photo.trim() : '';
    const list = (cover ? [cover] : []).concat(galleryOf(item).map((p) => p.trim()));
    return list.filter((p, i) => list.indexOf(p) === i);
  }

  /* ---------- список и поиск ---------- */
  function listItems(doc, categories) {
    const out = [];
    for (const cat of catsOf(doc)) {
      for (const it of itemsOf(cat)) {
        out.push({
          id: it.id, title: String(it.title ?? ''), price: String(it.price ?? ''), ownerId: cat.id, ownerTitle: String(cat.title ?? ''),
          photo: photosOf(it)[0] || '', photos: photosOf(it).length,
          explicit: Array.isArray(it.publicCategories), publicKeys: O.basePublicKeys(it, cat.id, categories)
        });
      }
    }
    return out;
  }
  /* Поиск: все слова запроса должны встретиться в названии, номере (id), цене, описании, составе или разделе. */
  function searchItems(doc, query, options = {}) {
    const words = normSearch(query).split(' ').filter(Boolean);
    const digits = String(query ?? '').replace(/\D/g, '');
    return listItems(doc, options.categories).filter((row) => {
      if (options.ownerId && row.ownerId !== options.ownerId) return false;
      if (options.publicKey && !row.publicKeys.includes(options.publicKey)) return false;
      if (!words.length) return true;
      const it = findItem(doc, row.id).item;
      const hay = normSearch([row.title, row.id, row.price, it.desc, it.composition, it.note, row.ownerTitle].join(' '));
      const priceDigits = row.price.replace(/\D/g, '');
      return words.every((w) => hay.includes(w)) || (digits.length >= 3 && words.length === 1 && priceDigits === digits);
    });
  }

  /* ---------- новый товар ---------- */
  function newItemId(doc, ownerId) {
    const used = usedIds(doc);
    const cat = catsOf(doc).find((c) => c.id === ownerId);
    let n = (cat && Array.isArray(cat.items) ? cat.items.length : 0) + 1;
    while (used.has(`${ownerId}-${n}`)) n += 1;
    return `${ownerId}-${n}`;
  }
  /* Возвращает { doc, id }: новый документ (исходный не меняется) с товаром в конце раздела. */
  function addItem(doc, ownerId, title) {
    const next = clone(doc);
    const cat = catsOf(next).find((c) => c.id === ownerId);
    if (!cat) throw new Error('Раздел прайса не найден');
    if (cat.items !== undefined && !Array.isArray(cat.items)) throw new Error('Раздел прайса повреждён — товар не добавлен');
    const name = cleanText(title, false);
    if (!name) throw new Error('Введите название товара');
    const id = newItemId(next, ownerId);
    if (!ITEM_ID.test(id)) throw new Error('Не удалось составить номер товара');
    const it = { id, title: name.slice(0, LIMITS.title), card: '', desc: '', composition: '', who: '', duration: '', price: '' };
    if (cat.kind !== 'table') it.items = [];
    (cat.items ||= []).push(it);
    return { doc: next, id };
  }
  function deleteItem(doc, id) {
    const next = clone(doc);
    const f = findItem(next, id);
    if (!f) return { doc: next, deleted: false };
    f.cat.items.splice(f.index, 1);
    // Скрытые витрины не редактируются, но ссылка на удалённый товар нарушила бы проверку сервера.
    for (const block of ['self', 'two']) {
      if (Array.isArray(next.showcase?.[block]) && next.showcase[block].includes(id)) next.showcase[block] = next.showcase[block].filter((x) => x !== id);
    }
    return { doc: next, deleted: true };
  }

  /* ---------- черновик формы товара ---------- */
  function draftOf(doc, id) {
    const f = findItem(doc, id);
    if (!f) return null;
    const it = f.item;
    const draft = { id, ownerId: f.cat.id, photos: photosOf(it), photosTouched: false, frames: Object.fromEntries(PF.framesOf(it)), framesTouched: false,
      manualCategories: Array.isArray(it.publicCategories), publicCategories: Array.isArray(it.publicCategories) ? it.publicCategories.filter((k) => typeof k === 'string') : [],
      itemsText: Array.isArray(it.items) ? it.items.map((x) => String(x ?? '')).join('\n') : '' };
    for (const k of TEXT_FIELDS) draft[k] = typeof it[k] === 'string' ? it[k] : it[k] == null ? '' : String(it[k]);
    return draft;
  }

  /* ---------- операции с фото (списком: [0] — основное) ---------- */
  const photoOps = {
    add(list, url) {
      if (!isUploadedAsset(url)) throw new Error('Адрес загруженного фото не подтверждён');
      if (list.includes(url)) return list.slice();
      if (list.length >= MAX_PHOTOS) throw new Error(`Не больше ${MAX_PHOTOS} фото: основное и ${MAX_GALLERY} дополнительных`);
      return list.concat(url);
    },
    replace(list, index, url) {
      if (!isUploadedAsset(url)) throw new Error('Адрес загруженного фото не подтверждён');
      if (!(index >= 0 && index < list.length)) return list.slice();
      const next = list.slice(); next[index] = url;
      return next.filter((p, i) => next.indexOf(p) === i);
    },
    // Как в прежнем редакторе: выбранное фото меняется местами с основным, порядок остальных не меняется.
    makeCover(list, index) {
      if (!(index > 0 && index < list.length)) return list.slice();
      const next = list.slice(); [next[0], next[index]] = [next[index], next[0]];
      return next;
    },
    // Порядок дополнительных: двигаются только позиции 1…n, основное не задевается.
    move(list, index, delta) {
      const j = index + delta;
      if (index < 1 || j < 1 || index >= list.length || j >= list.length) return list.slice();
      const next = list.slice(); [next[index], next[j]] = [next[j], next[index]];
      return next;
    },
    remove(list, index) {
      if (!(index >= 0 && index < list.length)) return list.slice();
      return list.filter((_, i) => i !== index);
    }
  };

  /* ---------- применение черновика («Готово») ---------- */
  /* Возвращает { doc, changed, errors, warnings }. При ошибках doc — исходный документ (без изменений).
     Пишутся только изменённые значения; отсутствующее поле не превращается в пустую строку. */
  function applyDraft(doc, draft, options = {}) {
    const errors = [], warnings = [];
    const base = findItem(doc, draft && draft.id);
    if (!base) return { doc, changed: false, errors: ['Товар не найден — возможно, он удалён'], warnings };
    const next = clone(doc);
    const f = findItem(next, draft.id);
    const it = f.item, orig = base.item;
    const write = (key, value, absentEmpty) => {
      const before = has(orig, key) ? orig[key] : undefined;
      const beforeText = typeof before === 'string' ? before : before == null ? '' : String(before);
      if (value === beforeText) return; // не тронуто — исходное значение и тип остаются
      if (value === '' && before === undefined && absentEmpty) return;
      it[key] = value;
    };
    for (const key of TEXT_FIELDS) {
      if (key === 'price') continue;
      const raw = String(draft[key] ?? '');
      const original = typeof orig[key] === 'string' ? orig[key] : orig[key] == null ? '' : String(orig[key]);
      if (raw === original) continue;
      const value = cleanText(raw, MULTILINE.has(key));
      if (value.length > LIMITS[key]) { errors.push(`Поле «${key}» длиннее ${LIMITS[key]} символов`); continue; }
      write(key, value, true);
    }
    if (!cleanText(draft.title, false)) errors.push('Название товара обязательно');
    const rawPrice = String(draft.price ?? '');
    const origPrice = typeof orig.price === 'string' ? orig.price : orig.price == null ? '' : String(orig.price);
    if (rawPrice !== origPrice) {
      const price = normalizePrice(cleanText(rawPrice, false));
      if (price.value.length > LIMITS.price) errors.push('Цена слишком длинная');
      else {
        write('price', price.value, true);
        if (price.kind === 'text') warnings.push(`Цена «${price.value}» сохранится текстом: корзина посчитает её как «цена уточняется».`);
      }
    }
    // Состав по пунктам (старое поле items) — только если изменён.
    const origItemsText = Array.isArray(orig.items) ? orig.items.map((x) => String(x ?? '')).join('\n') : '';
    if (String(draft.itemsText ?? '') !== origItemsText) {
      const lines = String(draft.itemsText ?? '').replace(/\r\n?/g, '\n').split('\n').map((s) => cleanText(s, false)).filter(Boolean);
      if (lines.length > 60) errors.push('В составе больше 60 пунктов');
      else if (!(lines.length === 0 && orig.items === undefined)) it.items = lines;
    }
    // Фото — только если владелец что-то делал с фото.
    if (draft.photosTouched) {
      const list = (Array.isArray(draft.photos) ? draft.photos : []).filter((p) => typeof p === 'string' && p);
      const old = new Set(photosOf(orig));
      if (list.length > MAX_PHOTOS) errors.push(`Не больше ${MAX_PHOTOS} фото`);
      if (new Set(list).size !== list.length) errors.push('Одно и то же фото добавлено дважды');
      for (const p of list) if (!old.has(p) && !isSafePhotoPath(p)) errors.push('Недопустимый адрес фото: разрешены только загруженные файлы кабинета');
      const cover = list[0] || '', gallery = list.slice(1);
      const origCover = typeof orig.photo === 'string' ? orig.photo.trim() : '';
      if (cover !== origCover) { if (cover || has(orig, 'photo')) it.photo = cover; }
      if (!same(gallery, galleryOf(orig).map((p) => p.trim()))) { if (gallery.length) it.gallery = gallery; else delete it.gallery; }
    }
    // Кадр фото (photoFrames) — только по явному «Настроить кадр» или когда менялся сам список фото: кадр удалённого
    // или заменённого снимка не переносится на другой. Без этих действий поле не создаётся и не пересобирается.
    if (draft.framesTouched || (draft.photosTouched && has(orig, 'photoFrames'))) {
      const entries = PF.toEntries(photosOf(it), isObject(draft.frames) ? draft.frames : {});
      if (entries.length) { if (!same(entries, orig.photoFrames)) it.photoFrames = entries; }
      else if (has(it, 'photoFrames')) delete it.photoFrames;
      errors.push(...PF.itemProblems(it));
    }
    // Поводы на сайте.
    const known = new Set(O.baseKeys(options.categories));
    if (draft.manualCategories) {
      const order = O.baseKeys(options.categories);
      const chosen = (Array.isArray(draft.publicCategories) ? draft.publicCategories : []);
      for (const key of chosen) if (!known.has(key)) errors.push(`Повода ${String(key)} нет на сайте`);
      const list = order.filter((key) => chosen.includes(key));
      if (!same(list, orig.publicCategories)) it.publicCategories = list;
      if (!list.length) warnings.push('Товар не выбран ни в один повод: он останется только во «Весь каталог».');
    } else if (has(orig, 'publicCategories')) delete it.publicCategories; // «как раньше» — по разделу прайса
    // Раздел прайса (старый адрес /catalog/<раздел>) — перенос только по явному выбору.
    if (draft.ownerId && draft.ownerId !== base.cat.id) {
      const target = catsOf(next).find((c) => c.id === draft.ownerId);
      if (!target) errors.push('Раздел прайса не найден');
      else if (target.items !== undefined && !Array.isArray(target.items)) errors.push(`Раздел «${String(target.title)}» повреждён`);
      else if (target.kind !== f.cat.kind) errors.push(`Раздел «${String(target.title)}» другого вида`);
      else { f.cat.items.splice(f.index, 1); (target.items ||= []).push(it); }
    }
    if (errors.length) return { doc, changed: false, errors, warnings };
    return { doc: next, changed: !same(next, doc), errors, warnings };
  }

  /* ---------- разделы прайса (управление отдельно от товаров) ---------- */
  function addSection(doc, title) {
    const name = cleanText(title, false);
    if (!name || name.length > 80) throw new Error('Название раздела: от 1 до 80 символов');
    const next = clone(doc);
    const ids = usedIds(next); ids.add('s8'); // s8 занят сертификатами на странице прайса
    let n = next.categories.length + 1;
    while (ids.has(`s${n}`)) n += 1;
    next.categories.push({ id: `s${n}`, title: name, kind: 'programs', block: 'self', items: [] });
    return { doc: next, id: `s${n}` };
  }
  function renameSection(doc, id, title) {
    const name = cleanText(title, false);
    if (!name || name.length > 80) throw new Error('Название раздела: от 1 до 80 символов');
    const next = clone(doc);
    const cat = catsOf(next).find((c) => c.id === id);
    if (!cat) throw new Error('Раздел не найден');
    if (cat.title !== name) cat.title = name;
    return { doc: next };
  }
  function deleteSection(doc, id) {
    const next = clone(doc);
    const cat = catsOf(next).find((c) => c.id === id);
    if (!cat) throw new Error('Раздел не найден');
    if (cat.items !== undefined && (!Array.isArray(cat.items) || cat.items.length)) throw new Error('В разделе есть товары — сначала перенесите или удалите их');
    next.categories = next.categories.filter((c) => c !== cat);
    return { doc: next };
  }

  /* ---------- основные категории (до 6) ---------- */
  function homeOf(doc, categories) { return O.homeKeys(doc, (categories || O.DEFAULT_PUBLIC).filter((c) => c.key !== 'all')); }
  /* Записывает порядок. Если документ ещё без publicCatalog и порядок равен шести Дарьи — документ не меняется. */
  function setHome(doc, keys, categories) {
    const problems = O.homeProblems(keys, O.baseKeys(categories));
    if (problems.length) throw new Error(problems[0]);
    const next = clone(doc);
    const catalog = isObject(next.publicCatalog) ? next.publicCatalog : null;
    if (!catalog && same(keys, O.DEFAULT_HOME)) return { doc: next };
    if (catalog && same(catalog.home, keys)) return { doc: next };
    if (!catalog && next.publicCatalog !== undefined) throw new Error('Поле publicCatalog повреждено — изменение не записано');
    next.publicCatalog = catalog || {};
    next.publicCatalog.home = keys.slice();
    return { doc: next };
  }
  const homeOps = {
    up(keys, i) { if (i < 1 || i >= keys.length) return keys.slice(); const n = keys.slice(); [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; },
    down(keys, i) { if (i < 0 || i >= keys.length - 1) return keys.slice(); const n = keys.slice(); [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; },
    remove(keys, i) { return keys.filter((_, j) => j !== i); },
    add(keys, key) {
      if (keys.includes(key)) return keys.slice();
      if (keys.length >= O.HOME_MAX) throw new Error(`Основных категорий не больше ${O.HOME_MAX}. Сначала уберите одну.`);
      return keys.concat(key);
    }
  };

  /* ---------- праздники ---------- */
  const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  function holidayKey(title, taken) {
    const slug = String(title ?? '').toLowerCase().split('').map((c) => (has(TRANSLIT, c) ? TRANSLIT[c] : c)).join('')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'prazdnik';
    let key = `h-${slug}`.replace(/-+$/, ''), n = 2;
    while (taken && taken.has(key)) key = `h-${slug}-${n++}`;
    return key;
  }
  function holidaysOf(doc) { return isObject(doc && doc.publicCatalog) && Array.isArray(doc.publicCatalog.holidays) ? doc.publicCatalog.holidays : []; }
  /* Добавить или заменить праздник (по originalKey). Неизвестные поля записи сохраняются. */
  function upsertHoliday(doc, record, originalKey, categories) {
    const next = clone(doc);
    if (next.publicCatalog !== undefined && !isObject(next.publicCatalog)) throw new Error('Поле publicCatalog повреждено — изменение не записано');
    if (isObject(next.publicCatalog) && next.publicCatalog.holidays !== undefined && !Array.isArray(next.publicCatalog.holidays)) throw new Error('Список праздников повреждён — изменение не записано');
    const list = holidaysOf(next).slice();
    const index = originalKey ? list.findIndex((h) => isObject(h) && h.key === originalKey) : -1;
    const prev = index >= 0 ? list[index] : {};
    const include = Array.isArray(record.include) ? record.include : [];
    const h = Object.assign({}, prev, {
      key: record.key, title: cleanText(record.title, false), start: record.start, end: record.end,
      include: O.baseKeys(categories).filter((key) => include.includes(key)).concat(include.filter((key) => !O.baseKeys(categories).includes(key))),
      pinned: record.pinned === true
    });
    const taken = new Set(list.filter((_, i) => i !== index).map((x) => x && x.key));
    const problems = O.holidayProblems(h, O.baseKeys(categories), taken);
    if (problems.length) return { doc, errors: problems };
    if (index >= 0) list[index] = h; else list.push(h);
    if (list.length > O.HOLIDAYS_MAX) return { doc, errors: [`Праздников не больше ${O.HOLIDAYS_MAX}`] };
    next.publicCatalog = isObject(next.publicCatalog) ? next.publicCatalog : {};
    next.publicCatalog.holidays = list;
    return { doc: next, errors: [] };
  }
  function removeHoliday(doc, key) {
    const next = clone(doc);
    if (!isObject(next.publicCatalog) || !Array.isArray(next.publicCatalog.holidays)) return { doc: next };
    next.publicCatalog.holidays = next.publicCatalog.holidays.filter((h) => !(isObject(h) && h.key === key));
    return { doc: next };
  }
  /* Товары праздника: объединение товаров выбранных поводов, каждый id один раз. */
  function holidayItemIds(doc, include, categories) {
    const ids = [];
    const keys = Array.isArray(include) ? include : [];
    for (const cat of catsOf(doc)) for (const it of itemsOf(cat)) {
      if (O.basePublicKeys(it, cat.id, categories).some((k) => keys.includes(k)) && !ids.includes(it.id)) ids.push(it.id);
    }
    return ids;
  }
  function publicKeyCounts(doc, categories) {
    const counts = Object.fromEntries(O.baseKeys(categories).map((k) => [k, 0]));
    for (const cat of catsOf(doc)) for (const it of itemsOf(cat)) {
      for (const k of O.basePublicKeys(it, cat.id, categories)) counts[k] += 1;
    }
    return counts;
  }

  /* ---------- проверка документа ---------- */
  /* Форма документа, без которой редактор не может безопасно работать (обход разделов/товаров/витрин).
     Пустой список — форма верна. Ни при какой входной форме не бросает исключение. */
  function shapeProblems(doc) {
    if (!isObject(doc)) return ['Документ прайса не объект'];
    if (!Array.isArray(doc.categories)) return ['Нет списка разделов categories'];
    const out = [];
    doc.categories.forEach((cat, i) => {
      if (!isObject(cat)) { out.push(`Раздел №${i + 1}: не объект`); return; }
      if (cat.items !== undefined && !Array.isArray(cat.items)) { out.push(`Раздел ${String(cat.id)}: items должен быть списком`); return; }
      (cat.items || []).forEach((it, j) => { if (!isObject(it)) out.push(`Раздел ${String(cat.id)}: позиция №${j + 1} не объект`); });
    });
    if (doc.showcase !== undefined && doc.showcase !== null && !isObject(doc.showcase)) out.push('Витрины showcase должны быть объектом');
    if (doc.blocks !== undefined && doc.blocks !== null && !isObject(doc.blocks)) out.push('Блоки blocks должны быть объектом');
    return out;
  }
  /* Прежние правила сервера (validatePrice) + проверки расширений. Возвращает список проблем; не бросает
     исключений на любой форме JSON (объект/массив/строка/null на месте раздела, товара, витрины). */
  function validateDocument(doc, options = {}) {
    if (!isObject(doc)) return ['Документ прайса не объект'];
    if (!Array.isArray(doc.categories)) return ['Нет списка разделов categories'];
    const problems = [];
    const known = O.baseKeys(options.categories);
    const ids = new Set();
    for (const cat of doc.categories) {
      if (!isObject(cat) || typeof cat.id !== 'string' || !cat.id.trim()) { problems.push('У раздела нет id'); continue; }
      if (typeof cat.title !== 'string' || !cat.title.trim()) problems.push(`Раздел ${cat.id}: пустое название`);
      if (!['programs', 'table'].includes(cat.kind)) problems.push(`Раздел ${cat.id}: неизвестный тип ${String(cat.kind)}`);
      if (!['self', 'two'].includes(cat.block)) problems.push(`Раздел ${cat.id}: блок главной должен быть self или two`);
      if (ids.has(cat.id)) problems.push(`Повторяющийся id ${cat.id}`);
      ids.add(cat.id);
      if (cat.items !== undefined && !Array.isArray(cat.items)) { problems.push(`Раздел ${cat.id}: items должен быть списком`); continue; }
      for (const it of cat.items || []) {
        if (!isObject(it) || typeof it.id !== 'string' || !it.id.trim()) { problems.push(`Раздел ${cat.id}: у позиции нет id`); continue; }
        if (ids.has(it.id)) problems.push(`Повторяющийся id ${it.id}`);
        ids.add(it.id);
        if (typeof it.title !== 'string' || !it.title.trim()) problems.push(`Позиция ${it.id}: пустое название`);
        if (it.oldPrice != null && typeof it.oldPrice !== 'string') problems.push(`Позиция ${it.id}: старая цена должна быть строкой`);
        if (it.gallery !== undefined) {
          if (!Array.isArray(it.gallery) || it.gallery.some((p) => typeof p !== 'string')) problems.push(`Позиция ${it.id}: gallery должен быть списком адресов`);
          else if (it.gallery.length > MAX_GALLERY) problems.push(`Позиция ${it.id}: больше ${MAX_GALLERY} дополнительных фото`);
        }
        if (it.publicCategories !== undefined) {
          if (!Array.isArray(it.publicCategories)) problems.push(`Позиция ${it.id}: publicCategories должен быть списком`);
          else {
            for (const k of it.publicCategories) if (typeof k !== 'string' || !known.includes(k)) problems.push(`Позиция ${it.id}: повода ${String(k)} нет на сайте`);
            if (new Set(it.publicCategories).size !== it.publicCategories.length) problems.push(`Позиция ${it.id}: повод указан дважды`);
          }
        }
        problems.push(...PF.itemProblems(it));
      }
    }
    if (doc.showcase !== undefined && doc.showcase !== null && !isObject(doc.showcase)) problems.push('Витрины showcase должны быть объектом');
    const showcase = isObject(doc.showcase) ? doc.showcase : {};
    const blocks = isObject(doc.blocks) ? doc.blocks : {};
    for (const block of ['self', 'two']) {
      const list = showcase[block] ?? [];
      if (!Array.isArray(list)) { problems.push(`Витрина ${block} должна быть списком id`); continue; }
      const max = Number(isObject(blocks[block]) ? blocks[block].max : undefined) || 8;
      if (list.length > max) problems.push(`Витрина ${block}: больше ${max} позиций (${list.length})`);
      for (const id of list) if (!ids.has(id)) problems.push(`Витрина ${block}: позиции ${String(id)} нет в прайсе`);
      if (new Set(list).size !== list.length) problems.push(`Витрина ${block}: позиции повторяются`);
    }
    const marked = idList(showcase.self).concat(idList(showcase.two));
    for (const cat of doc.categories) {
      if (!isObject(cat) || !Array.isArray(cat.items)) continue;
      const popular = cat.items.filter((it) => isObject(it) && marked.includes(it.id));
      if (popular.length > 8) problems.push(`Раздел ${String(cat.id)}: отмечено больше 8 популярных (${popular.length})`);
    }
    if (doc.publicCatalog !== undefined) {
      if (!isObject(doc.publicCatalog)) problems.push('publicCatalog должен быть объектом');
      else {
        problems.push(...O.homeProblems(doc.publicCatalog.home, known));
        problems.push(...O.holidaysProblems(doc.publicCatalog.holidays, known));
      }
    }
    try { if (new TextEncoder().encode(JSON.stringify(doc)).length > MAX_DOCUMENT) problems.push('Документ прайса больше 1 МБ'); } catch (_) { /* без TextEncoder размер не проверяется */ }
    return problems;
  }

  /* ---------- изменения относительно загруженной версии ---------- */
  function itemMap(doc) {
    const map = new Map();
    for (const cat of catsOf(doc)) for (const it of itemsOf(cat)) map.set(it.id, { item: it, ownerId: cat.id });
    return map;
  }
  function diffDocs(base, local) {
    const a = itemMap(base), b = itemMap(local);
    const changed = [], added = [], deleted = [];
    for (const [id, entry] of b) {
      if (!a.has(id)) added.push(id);
      else if (!same(a.get(id).item, entry.item) || a.get(id).ownerId !== entry.ownerId) changed.push(id);
    }
    for (const id of a.keys()) if (!b.has(id)) deleted.push(id);
    const catA = new Map(catsOf(base).map((c) => [c.id, c])), catB = new Map(catsOf(local).map((c) => [c.id, c]));
    const sections = { added: [...catB.keys()].filter((id) => !catA.has(id)), deleted: [...catA.keys()].filter((id) => !catB.has(id)),
      renamed: [...catB.keys()].filter((id) => catA.has(id) && catA.get(id).title !== catB.get(id).title) };
    const rest = (doc) => { const c = withoutMeta(doc); delete c.categories; delete c.publicCatalog; return c; };
    return { changed, added, deleted, sections, publicCatalog: !same(base.publicCatalog, local.publicCatalog), other: !same(rest(base), rest(local)) };
  }
  function hasChanges(base, local) { return !same(withoutMeta(base), withoutMeta(local)); }
  /* Проверка правки перед сохранением: скрытые данные (витрины, блоки, ссылки, неизвестные поля) не изменены,
     неизвестные поля изменённых товаров сохранены, новые адреса фото безопасны. */
  function validateDelta(base, local, options = {}) {
    const problems = [];
    const d = diffDocs(base, local);
    if (d.other) {
      // Витрины меняются только удалением ссылки на удалённый товар.
      const strip = (doc) => { const c = withoutMeta(doc); delete c.categories; delete c.publicCatalog; if (isObject(c.showcase)) for (const b of ['self', 'two']) if (Array.isArray(c.showcase[b])) c.showcase[b] = c.showcase[b].filter((id) => !d.deleted.includes(id)); return c; };
      if (!same(strip(base), strip(local))) problems.push('Изменились скрытые данные прайса (витрины, блоки или ссылки) — редактор их не меняет');
    }
    if (isObject(base.publicCatalog) && isObject(local.publicCatalog)) {
      for (const k of Object.keys(base.publicCatalog)) if (!['home', 'holidays'].includes(k) && !same(base.publicCatalog[k], local.publicCatalog[k])) problems.push(`Изменилось неизвестное поле publicCatalog.${k}`);
    } else if (base.publicCatalog !== undefined && !same(base.publicCatalog, local.publicCatalog)) problems.push('publicCatalog удалён или заменён');
    const a = itemMap(base), b = itemMap(local);
    for (const id of d.changed) {
      const before = a.get(id).item, after = b.get(id).item;
      for (const key of Object.keys(before)) if (!EDITABLE.has(key) && !same(before[key], after[key])) problems.push(`Товар ${id}: изменилось служебное поле ${key}`);
      for (const key of Object.keys(after)) if (!EDITABLE.has(key) && !has(before, key)) problems.push(`Товар ${id}: появилось неизвестное поле ${key}`);
      const old = new Set(photosOf(before));
      for (const p of photosOf(after)) if (!old.has(p) && !isSafePhotoPath(p)) problems.push(`Товар ${id}: недопустимый адрес фото`);
      if (after.id !== id) problems.push(`Товар ${id}: изменился номер`);
    }
    for (const id of d.added) {
      const it = b.get(id).item;
      if (!ITEM_ID.test(String(id))) problems.push(`Новый товар: недопустимый номер ${String(id)}`);
      for (const p of photosOf(it)) if (!isSafePhotoPath(p)) problems.push(`Товар ${id}: недопустимый адрес фото`);
      for (const key of Object.keys(it)) if (!EDITABLE.has(key) && key !== 'id') problems.push(`Новый товар ${id}: неизвестное поле ${key}`);
    }
    for (const id of d.sections.deleted) {
      const cat = catsOf(base).find((c) => c.id === id);
      // Удалять можно только пустой раздел; перенесённые в другой раздел товары не считаются потерей.
      if (cat && itemsOf(cat).some((it) => d.deleted.includes(it.id))) problems.push(`Раздел ${id} удалён вместе с товарами`);
    }
    if (options.expectedDeleted) for (const id of d.deleted) if (!options.expectedDeleted.includes(id)) problems.push(`Товар ${id} пропал без явного удаления`);
    return problems;
  }

  /* Перенос своих правок на свежую версию (после конфликта). Чужие изменения не затираются: если тот же
     товар/запись поменял кто-то другой — конфликт, ничего не переносится. */
  function rebase(latest, base, local) {
    const shape = shapeProblems(latest);
    if (shape.length) return { doc: null, conflicts: ['Свежая версия прайса в неожиданном виде: ' + shape[0]] };
    const d = diffDocs(base, local);
    const conflicts = [];
    const next = clone(latest);
    const nb = itemMap(next), bb = itemMap(base), lb = itemMap(local);
    const catOf = (doc, id) => catsOf(doc).find((c) => c.id === id);
    if (d.other) conflicts.push('Изменены скрытые данные — перенос невозможен');
    for (const id of d.sections.added) { if (catOf(next, id)) conflicts.push(`Раздел ${id} уже существует`); else next.categories.push(clone(catOf(local, id))); }
    for (const id of d.sections.renamed) {
      const cat = catOf(next, id);
      if (!cat || cat.title !== catOf(base, id).title) conflicts.push(`Раздел ${id} изменён другим редактором`); else cat.title = catOf(local, id).title;
    }
    // Новые разделы переносятся пустыми, товары добавляются ниже.
    for (const id of d.sections.added) { const cat = catOf(next, id); if (cat) cat.items = []; }
    for (const id of d.changed.concat(d.deleted)) {
      const now = nb.get(id);
      if (!now || !same(now.item, bb.get(id).item) || now.ownerId !== bb.get(id).ownerId) conflicts.push(`Товар ${id} изменён или удалён другим редактором`);
    }
    for (const id of d.added) if (nb.has(id)) conflicts.push(`Номер ${id} уже занят в свежей версии`);
    if (d.publicCatalog && !same(latest.publicCatalog, base.publicCatalog)) conflicts.push('Основные категории или праздники изменены другим редактором');
    if (conflicts.length) return { doc: null, conflicts };
    const removeFrom = (doc, id) => { for (const cat of catsOf(doc)) { const i = (Array.isArray(cat.items) ? cat.items : []).findIndex((it) => isObject(it) && it.id === id); if (i >= 0) { cat.items.splice(i, 1); return { cat, i }; } } return null; };
    for (const id of d.deleted) removeFrom(next, id);
    for (const id of d.changed) {
      const target = lb.get(id);
      const at = removeFrom(next, id);
      const sameOwner = at && at.cat.id === target.ownerId;
      if (sameOwner) at.cat.items.splice(at.i, 0, clone(target.item));
      else { const cat = catOf(next, target.ownerId); if (!cat) return { doc: null, conflicts: [`Раздел ${target.ownerId} удалён в свежей версии`] }; (cat.items ||= []).push(clone(target.item)); }
    }
    for (const id of d.added) {
      const target = lb.get(id); const cat = catOf(next, target.ownerId);
      if (!cat) return { doc: null, conflicts: [`Раздел ${target.ownerId} удалён в свежей версии`] };
      (cat.items ||= []).push(clone(target.item));
    }
    for (const id of d.sections.deleted) {
      const cat = catOf(next, id);
      if (cat && itemsOf(cat).length) return { doc: null, conflicts: [`В разделе ${id} появились товары — удаление не перенесено`] };
      next.categories = next.categories.filter((c) => !(isObject(c) && c.id === id));
    }
    if (d.publicCatalog) { if (local.publicCatalog === undefined) delete next.publicCatalog; else next.publicCatalog = clone(local.publicCatalog); }
    for (const block of ['self', 'two']) if (Array.isArray(next.showcase?.[block])) next.showcase[block] = next.showcase[block].filter((x) => !d.deleted.includes(x));
    return { doc: next, conflicts: [] };
  }

  /* Исход сохранения без ответа сервера: решается только по свежему GET. Повтор — только по явному нажатию
     и только при доказанном 'not-saved'. */
  function saveOutcome(base, sent, latest) {
    if (!isObject(latest) || !Array.isArray(latest.categories)) return 'unknown';
    if (same(withoutMeta(latest), withoutMeta(sent))) return 'saved';
    if (latest.version === base.version && same(withoutMeta(latest), withoutMeta(base))) return 'not-saved';
    return 'conflict';
  }
  /* Классификация ответа PUT: что делать редактору. */
  function classifyPut(status) {
    if (status >= 200 && status < 300) return 'saved';
    if (status === 409 || status === 412) return 'conflict';
    if (status === 401 || status === 403) return 'auth';       // точно не сохранено, правки остаются в окне
    if (status === 400 || status === 413 || status === 415 || status === 422 || status === 428) return 'rejected';
    return 'unknown';                                         // 0 (сеть), 5xx, 408, 502/504 — исход неизвестен
  }

  return {
    MAX_GALLERY, MAX_PHOTOS, MAX_DOCUMENT, EDITABLE, LIMITS, ITEM_ID,
    clone, same, withoutMeta, cleanText, esc, normSearch, normalizePrice, isSafePhotoPath, isUploadedAsset,
    findItem, itemCount, usedIds, photosOf, galleryOf, listItems, searchItems,
    newItemId, addItem, deleteItem, draftOf, photoOps, applyDraft,
    addSection, renameSection, deleteSection,
    homeOf, setHome, homeOps, holidayKey, holidaysOf, upsertHoliday, removeHoliday, holidayItemIds, publicKeyCounts,
    shapeProblems, validateDocument, diffDocs, hasChanges, validateDelta, rebase, saveOutcome, classifyPut,
    occasions: O, photoFrame: PF
  };
});
