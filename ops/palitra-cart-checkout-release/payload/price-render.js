/* Palitra: рендер прайса для страницы сайта и редактора Synapse. */
(function () {
  'use strict';
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
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const PRICE_UNKNOWN = 'Цена уточняется';
  // Значок корзины: доступное имя задаёт aria-label кнопки, сам рисунок скрыт от чтения.
  const CART_ICON = '<svg class="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="22" height="22"><path d="M3 4h2.2l2.1 10.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 1.9-1.4L21 8H6.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="19.5" r="1.4" fill="currentColor"/><circle cx="17" cy="19.5" r="1.4" fill="currentColor"/></svg>';
  /* Карточка без описания и без видимого примечания (на 02.10.2026 — 60 из 65 публичных карточек:
     у импортированных позиций описания нет, служебное примечание о цене скрыто). Раньше «Подробнее»
     открывало пустой блок и окно только с названием и ценой. Теперь — честная строка о том, что
     описания нет; состав, название и цену это не подменяет и не придумывает (specs/084). */
  const DETAILS_MISSING = 'Описание этого товара ещё не добавлено. Состав и стоимость менеджер подтвердит при заказе.';
  /* Служебные примечания импорта («Цена из публикации от 01.01.2026; актуальность уточняется при заказе»,
     «Цена на момент публикации, актуальную подтверждаем при заказе») на публичном сайте не показываются
     (замечание Дарьи 20.09.2026). Строки прайса не меняются: в редакторе ЛК примечание видно как есть,
     а любое другое примечание владельца (состав, размер, срок) остаётся на карточке. */
  // Без \b: в JS граница слова не работает для кириллицы.
  const AUTO_PRICE_NOTE = /^\s*цена\s+(?:из|на\s+момент)\s+публикации(?=[\s,;.:]|$)[\s\S]*актуальн/i;
  const isAutoPriceNote = (note) => AUTO_PRICE_NOTE.test(String(note ?? ''));
  /* Дарья 05.10.2026: «карточки без названия убрать». Без названия — пустое название или автоматическое
     название импорта «Товар №…» или «Товар 1» (оно не настоящее название, его не переименовываем). Это только публичное
     исключение: прайс, редактор ЛК и история не меняются; config.HIDE_UNNAMED = false возвращает показ,
     UNNAMED_SHOW_IDS — отдельные позиции. Пустое описание поводом для скрытия не является. */
  const UNNAMED_TITLE = /^\s*(?:товар\s*(?:№\s*[\w-]*|\d+))?\s*$/i;
  const isUnnamed = (item) => UNNAMED_TITLE.test(String(item?.title ?? ''));
  /* Черновик, 12.10.2026: точные полные фото отдельных товаров вместо обрезанных в источнике обложек — без
     изменения общего прайса. config.SHOWCASE_PHOTO_OVERRIDES = { '<id товара>': { sourcePhoto: '/…', photo: 'https://…', gallery: ['https://…'] } }
     действует только при SHOWCASE_PHOTO_OVERRIDES is configured. Адрес — https:// или путь сайта «/…» (не «//»), без управляющих символов
     и обратной косой черты; неверное значение пропускается, исходное фото товара остаётся. gallery задаётся только
     непустым списком допустимых адресов без повторов. Остальные поля товара (название, цена, описание) не меняются. */
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  function overridePhotoUrl(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(raw)) return '';
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
    if (!/^https:\/\//i.test(raw)) return '';
    try { return new URL(raw).protocol === 'https:' ? raw : ''; } catch (_) { return ''; }
  }
  /* sourcePhoto (необязательно): исходная обложка товара в общем прайсе, для которой задана подмена. Подмена
     применяется, только пока item.photo точно равен ей; если Дарья поставила в прайсе другую обложку, товар
     показывается как в свежем прайсе (её photo и gallery). Заданный не строкой или пустой sourcePhoto — запись
     пропускается. Без sourcePhoto — прежнее поведение. Сам sourcePhoto в копию товара не попадает. */
  function draftPhotoOverrides(config) {
    if (!config || !isPlainObject(config.SHOWCASE_PHOTO_OVERRIDES)) return null;
    const out = new Map();
    for (const [id, entry] of Object.entries(config.SHOWCASE_PHOTO_OVERRIDES)) {
      if (!isPlainObject(entry)) continue;
      const hasSource = Object.prototype.hasOwnProperty.call(entry, 'sourcePhoto') && entry.sourcePhoto !== undefined;
      if (hasSource && (typeof entry.sourcePhoto !== 'string' || !entry.sourcePhoto.trim())) continue;
      const patch = {};
      const photo = overridePhotoUrl(entry.photo);
      if (photo) patch.photo = photo;
      if (Array.isArray(entry.gallery)) {
        const gallery = [...new Set(entry.gallery.map(overridePhotoUrl).filter(Boolean))].slice(0, 8);
        if (gallery.length) patch.gallery = gallery;
      }
      if (Object.keys(patch).length) out.set(id, { patch, source: hasSource ? entry.sourcePhoto : null });
    }
    return out.size ? out : null;
  }
  function publicData(data, opts = {}) {
    const config = window.PALITRA_CONFIG || {};
    if (opts.editor) return data;
    const hideFlowers = config.FLOWERS_VISIBLE === false;
    const hideUnnamed = config.HIDE_UNNAMED !== false;
    const overrides = draftPhotoOverrides(config);
    if (!hideFlowers && !hideUnnamed && !overrides) return data;
    const categories = new Set(hideFlowers ? config.FLOWER_CATEGORY_IDS || ['bukety', 'korziny'] : []);
    const items = new Set(hideFlowers ? config.FLOWER_ITEM_IDS || [] : []);
    const photos = new Set(hideFlowers ? config.FLOWER_PHOTO_PATHS || [] : []);
    const shown = new Set(config.UNNAMED_SHOW_IDS || []);
    let removed = 0, replaced = 0;
    const visible = (data.categories || []).filter(cat => { const keep = !categories.has(cat.id); if (!keep) removed++; return keep; })
      .map(cat => {
        // Отбор — по исходным данным (в том числе исходному photo); подмена фото — только видимым товарам, копией.
        const list = (cat.items || []).filter(item => !items.has(item.id) && !photos.has(item.photo)
          && !(hideUnnamed && isUnnamed(item) && !shown.has(item.id)));
        removed += (cat.items || []).length - list.length;
        const shownItems = overrides ? list.map(item => {
          const override = item && overrides.get(item.id);
          // Обложка в прайсе уже другая (её заменила Дарья) — подмена черновика этого товара не действует.
          if (!override || (override.source !== null && item.photo !== override.source)) return item;
          // PALITRA36: у исходной обложки есть явный кадр photoFrames для этого src (всё поле валидно) — свежее решение
          // в редакторе; временная подмена черновика не применяется: фото прайса и их кадры (кадр не переносится на чужой снимок).
          if (typeof item.photo === 'string' && !PF.itemProblems(item).length && PF.framesOf(item).has(item.photo.trim())) return item;
          replaced++;
          return { ...item, ...override.patch };
        }) : list;
        return { ...cat, items: shownItems };
      });
    // Ничего не скрыто и не подменено — тот же объект прайса (как при выключенных правилах).
    return removed || replaced ? { ...data, categories: visible } : data;
  }
  /* Отчёт для владельца: какие позиции прайса сейчас без названия (по всем категориям, включая скрытые). */
  function unnamedItems(data) {
    return (data?.categories || []).flatMap(cat => (cat.items || []).filter(isUnnamed)
      .map(item => ({ category: cat.id, id: item.id, title: String(item.title ?? ''), price: String(item.price ?? '') })));
  }
  function findItem(data, id) {
    for (const cat of data.categories || []) {
      const it = (cat.items || []).find((item) => item.id === id);
      if (it) return { cat, it };
    }
    return null;
  }
  function isPopular(data, id) {
    return ['self', 'two'].some((block) => (data.showcase?.[block] || []).includes(id));
  }
  function imageUrl(photo) {
    if (!photo) return '';
    // Draft clone: preserve the original public Palitra media URLs.
    if (photo.startsWith('/api/assets/')) return 'https://palitra-love.ru' + photo;
    if (/^(https?:)?\/\//.test(photo) || photo.startsWith('/')) return photo;
    return '/' + photo.replace(/^\.\//, '');
  }
  /* Несколько фото у товара (замечание Дарьи: «несколько фото у каждого товара»).
     Обложка — прежнее поле photo; дополнительные — необязательный список gallery. Товар без gallery
     выглядит и размечается как раньше. Только локальные пути сайта и https; повторы убираются; не больше 9. */
  const MAX_PHOTOS = 9;
  const safePhoto = (photo) => (typeof photo === 'string' && (/^\/(?!\/)/.test(photo) || /^https:\/\//i.test(photo)) ? photo : '');
  /* Фото товара с исходным адресом прайса (raw, после trim) — для кадра photoFrames по src; url — прежний результат photosOf. */
  function photoEntries(item) {
    // Обложка обрабатывается ровно как раньше (совместимость одиночного фото); дополнительные — строже.
    const cover = imageUrl(item.photo);
    const out = cover ? [{ raw: String(item.photo).trim(), url: cover }] : [];
    for (const photo of Array.isArray(item.gallery) ? item.gallery : []) {
      if (out.length >= MAX_PHOTOS) break;
      // Дополнительные фото принимаются только как путь сайта или https — как проверяет сервер при сохранении.
      const raw = safePhoto(typeof photo === 'string' ? photo.trim() : '');
      const url = imageUrl(raw);
      if (url && !out.some((entry) => entry.url === url)) out.push({ raw, url });
    }
    return out;
  }
  function photosOf(item) { return photoEntries(item).map((entry) => entry.url); }
  /* Лента с прокруткой и привязкой к кадру: на телефоне листается пальцем, на компьютере — кнопками
     и стрелками клавиатуры. Первое фото грузится как раньше, остальные — лениво. */
  function galleryHtml(item, images, frameAttr = () => '') {
    const total = images.length;
    const slides = images.map((entry, index) => {
      const src = typeof entry === 'string' ? entry : entry.url;
      const attr = typeof entry === 'string' ? '' : frameAttr(entry);
      const img = `<img class="price-card__photo photo" src="${esc(src)}" alt="${esc(item.title)} — фото ${index + 1} из ${total}" loading="lazy" decoding="async" width="800" height="1000"${attr}>`;
      // Снимок с сохранённым кадром — в своей рамке размером со слайд; остальные слайды размечаются как раньше.
      return attr ? `<span class="product-gallery__frame" data-photo-frame-box>${img}</span>` : img;
    }).join('');
    return `<div class="product-media product-gallery" data-gallery role="group" aria-roledescription="галерея" aria-label="Фото товара: ${esc(item.title)}">`
      + `<div class="product-gallery__track" data-gallery-track tabindex="0" aria-label="Листайте фото: стрелки влево и вправо">${slides}</div>`
      + '<button class="product-gallery__nav product-gallery__nav--prev" type="button" data-gallery-prev aria-label="Предыдущее фото" disabled>‹</button>'
      + '<button class="product-gallery__nav product-gallery__nav--next" type="button" data-gallery-next aria-label="Следующее фото">›</button>'
      + `<p class="product-gallery__count" data-gallery-count aria-live="polite">1 / ${total}</p></div>`;
  }
  function galleryState(gallery) {
    const track = gallery.querySelector('[data-gallery-track]');
    const total = track ? track.children.length : 0;
    const width = track ? track.clientWidth : 0;
    const index = total && width ? Math.min(total - 1, Math.max(0, Math.round(track.scrollLeft / width))) : 0;
    return { track, total, index };
  }
  function syncGallery(gallery) {
    const { total, index } = galleryState(gallery);
    const count = gallery.querySelector('[data-gallery-count]');
    if (count) count.textContent = `${index + 1} / ${total}`;
    const prev = gallery.querySelector('[data-gallery-prev]');
    const next = gallery.querySelector('[data-gallery-next]');
    if (prev) prev.disabled = index <= 0;
    if (next) next.disabled = index >= total - 1;
  }
  function stepGallery(gallery, delta) {
    const { track, total, index } = galleryState(gallery);
    if (!track || !total) return;
    const target = Math.min(total - 1, Math.max(0, index + delta));
    const left = target * track.clientWidth;
    if (typeof track.scrollTo === 'function') track.scrollTo({ left, behavior: 'smooth' });
    else track.scrollLeft = left;
    syncGallery(gallery);
  }
  function installGallery(doc) {
    if (!doc || doc.__palitraGallery) return;
    doc.__palitraGallery = true;
    doc.addEventListener('click', (event) => {
      const button = event.target.closest && event.target.closest('[data-gallery-prev],[data-gallery-next]');
      if (!button) return;
      const gallery = button.closest('[data-gallery]');
      if (gallery) stepGallery(gallery, button.hasAttribute('data-gallery-next') ? 1 : -1);
    });
    doc.addEventListener('keydown', (event) => {
      const track = event.target.closest && event.target.closest('[data-gallery-track]');
      if (!track || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      stepGallery(track.closest('[data-gallery]'), event.key === 'ArrowRight' ? 1 : -1);
    });
    // scroll не всплывает — слушаем на этапе перехвата, чтобы счётчик шёл за пальцем.
    doc.addEventListener('scroll', (event) => {
      const track = event.target && event.target.closest && event.target.closest('[data-gallery-track]');
      if (track) syncGallery(track.closest('[data-gallery]'));
    }, true);
  }
  function installDetails(doc) {
    if (!doc || doc.__palitraDetails) return;
    doc.__palitraDetails = true;
    let dialog, opener;
    const close = (restoreFocus = true) => {
      if (!dialog) return;
      if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
      doc.body.classList.remove('product-dialog-open');
      if (restoreFocus) opener?.focus();
    };
    /* «Перейти к оформлению» (14.10.2026): товар кладёт в корзину order.js и затем просит закрыть окно этим событием.
       detail.focusCart — фокус забирает открытая корзина, к кнопке цены он не возвращается. */
    doc.addEventListener('palitra:product-dialog-close', event => close(!(event && event.detail && event.detail.focusCart)));
    doc.addEventListener('click', event => {
      if (event.target.closest('[data-product-close]')) { close(); return; }
      if (event.target.closest('.product-dialog [data-cart-open]')) { close(); return; }
      // Кнопку оформления обрабатывает order.js (doc.__palitraCheckout); без него на странице — прежнее закрытие окна.
      if (event.target.closest('.product-dialog [data-checkout-id]')) { if (!doc.__palitraCheckout) close(); return; }
      const card = event.target.closest('.product-card');
      if (!card || card.closest('.product-dialog')) return;
      const direct = event.target.closest('[data-product-open]');
      // Корзина, избранное и управление галереей имеют своё действие.
      if (!direct && event.target.closest('button,a,input,select,textarea,[role="button"]')) return;
      const summary = direct || card.querySelector('[data-product-open]');
      if (!summary) return;
      event.preventDefault();
      if (!dialog) {
        dialog = doc.createElement('dialog');
        dialog.className = 'product-dialog';
        dialog.setAttribute('aria-labelledby', 'product-dialog-title');
        doc.body.append(dialog);
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
      }
      opener = summary;
      dialog.innerHTML = '<button type="button" class="product-dialog-close" data-product-close aria-label="Закрыть товар">×</button><div class="product-dialog-layout"></div>';
      const layout = dialog.querySelector('.product-dialog-layout');
      const media = card.querySelector('.product-media')?.cloneNode(true);
      if (media) layout.append(media);
      const body = doc.createElement('div'); body.className = 'product-dialog-body';
      const title = doc.createElement('h2'); title.id = 'product-dialog-title'; title.textContent = card.querySelector('h3')?.textContent || 'Товар';
      body.append(title);
      for (const field of card.querySelectorAll('[data-product-details] .price-card__description,[data-product-details] .note')) body.append(field.cloneNode(true));
      const footer = card.querySelector('.product-footer').cloneNode(true);
      /* В окне цена — просто цена (окно уже открыто), значок корзины — та же кнопка добавления.
         Копия не наследует временную отметку «добавлено»: исходные подпись и доступное имя. */
      for (const open of footer.querySelectorAll('[data-product-open]')) {
        const price = doc.createElement('p');
        price.className = 'pc__price price product-price';
        price.dataset.priceKnown = open.dataset.priceKnown;
        price.textContent = open.textContent;
        open.replaceWith(price);
      }
      for (const add of footer.querySelectorAll('[data-add]')) {
        add.classList.remove('is-added');
        if (add.hasAttribute('data-add-icon')) { if (add.dataset.ariaLabel) add.setAttribute('aria-label', add.dataset.ariaLabel); }
        else add.textContent = add.dataset.label || 'Купить';
      }
      body.append(footer);
      /* Оформление начинается с товара этого окна: настоящий id из data-id штатной карточки (productCard), не из
         названия, цены или порядка. Добавление и открытие корзины делает order.js только по нажатию этой кнопки. */
      const checkout = doc.createElement('button'); checkout.type = 'button'; checkout.className = 'button outline';
      checkout.setAttribute('data-checkout-id', card.getAttribute('data-id') || ''); checkout.textContent = 'Перейти к оформлению'; body.append(checkout);
      layout.append(body);
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      dialog.querySelectorAll('[data-gallery]').forEach(syncGallery);
      doc.body.classList.add('product-dialog-open');
      dialog.querySelector('[data-product-close]').focus();
    });
    doc.addEventListener('keydown', event => { if (event.key === 'Escape' && dialog?.open) { event.preventDefault(); close(); } });
  }
  /* Одна структура карточки для прайса и каталога: медиа-блок 4:5 (фото или заглушка),
     название, описание и примечание владельца — в содержимом; внизу у всех карточек ряда
     один и тот же компактный блок: цена + «Купить» (добавляет в корзину; онлайн-оплаты нет).
     Ссылок в Telegram и второй кнопки заявки в карточке нет (замечание Дарьи 20.09.2026).
     Пустая цена показывается словами, не нулём; тексты не обрезаются. */
  function productCard(item, opts = {}) {
    const editor = opts.editor || false;
    const images = photoEntries(item);
    // Кадр фото (photoFrames) — только у фото с сохранённой настройкой; остальные фото размечаются как раньше.
    const frames = PF.framesOf(item);
    const frameAttr = (entry) => (frames.has(entry.raw) ? ` data-photo-frame="${esc(PF.formatAttr(frames.get(entry.raw)))}"` : '');
    const media = images.length > 1
      ? galleryHtml(item, images, frameAttr)
      : images.length
        ? `<div class="product-media"><img class="price-card__photo photo" src="${esc(images[0].url)}" alt="${esc(item.title)}" loading="lazy" decoding="async" width="800" height="1000"${frameAttr(images[0])}></div>`
        : '<div class="product-media product-media--empty" aria-hidden="true"><img src="/assets/img/logo-mark.svg" alt="" width="64" height="64" loading="lazy"></div>';
    const description = item.desc ? `<p class="price-card__description">${esc(item.desc)}</p>` : '';
    // Редактор ЛК видит примечание как есть; публичная карточка скрывает служебное примечание импорта.
    const noteShown = Boolean(item.note) && (editor || !isAutoPriceNote(item.note));
    const note = noteShown ? `<p class="note">${esc(item.note)}</p>` : '';
    const star = editor ? opts.starHtml(item) : '';
    const priceText = !editor && window.PalitraPriceFormat ? window.PalitraPriceFormat.format(item.price) : String(item.price ?? '').trim();
    const known = Boolean(priceText);
    const price = `<p class="pc__price price" data-price-known="${known ? 'true' : 'false'}">${known ? esc(priceText) : PRICE_UNKNOWN}</p>`;
    /* Дарья 05.10.2026: под фото и названием две округлые кнопки с белым текстом — цена и значок корзины,
       без «Подробнее» и «Купить». Цена — настоящая кнопка: открывает окно с фото, описанием и составом;
       значок ведёт в корзину; data-add сохраняет штатное добавление, когда обработчик доступен. */
    const priceButton = `<button class="pc__price price product-price" type="button" data-product-open data-price-known="${known ? 'true' : 'false'}" aria-label="${esc((known ? priceText : PRICE_UNKNOWN) + ' — состав и подробности: ' + item.title)}">${known ? esc(priceText) : PRICE_UNKNOWN}</button>`;
    const footer = editor
      ? `<div class="product-footer"><div class="product-purchase">${price}</div>${opts.editHtml(item)}</div>`
      : `<div class="product-footer"><div class="product-purchase">${priceButton}<a class="button product-add" href="/cart" data-add data-add-icon data-id="${esc(item.id)}" data-title="${esc(item.title)}" aria-label="${esc('В корзину: ' + item.title)}">${CART_ICON}</a></div></div>`;
    const classes = ['pc', 'price-card', 'product-card'].concat(opts.extraClass ? [opts.extraClass] : []).join(' ');
    const dataCat = Array.isArray(opts.tags) && opts.tags.length ? ` data-cat="${esc(opts.tags.join(' '))}"` : '';
    const missing = description || note ? '' : `<p class="note product-details__missing" data-details-missing>${DETAILS_MISSING}</p>`;
    // Состав и описание остаются в карточке (скрытым блоком) и показываются в окне по кнопке цены.
    const details = editor ? description + note : `<div class="product-details" data-product-details hidden>${description}${note}${missing}</div>`;
    return `<article class="${classes}" id="${esc(item.id)}" data-id="${esc(item.id)}"${dataCat}>${star}${media}<div class="price-card__body"><h3 class="pc__title">${esc(item.title)}</h3>${details}${footer}</div></article>`;
  }
  function renderSections(data, opts = {}) {
    return (publicData(data, opts).categories || []).filter((cat) => opts.editor || (cat.items || []).length).map((cat) => {
      const extra = opts.editor && opts.titleExtra ? opts.titleExtra(cat) : '';
      const cards = (cat.items || []).map((item) => productCard(item, opts)).join('\n');
      const empty = opts.editor && !cards ? '<p class="ps__note">В этом разделе пока нет позиций.</p>' : '';
      const tools = opts.editor && opts.addCardHtml ? opts.addCardHtml(cat) : '';
      return `<section class="ps" id="${esc(cat.id)}" data-cat="${esc(cat.id)}"><h2 class="ps__title">${esc(cat.title)}${extra}</h2><div class="price-grid">${cards}</div>${empty}${tools}</section>`;
    }).join('\n');
  }
  function renderNav(data, opts = {}) {
    const prefix = opts.prefix || '';
    return prefix + (publicData(data, opts).categories || []).filter((cat) => opts.editor || (cat.items || []).length).map((cat) => `<li><a class="pnav__top" href="#${esc(cat.id)}">${esc(cat.title)}</a></li>`).join('\n');
  }
  const CACHE_KEY = 'palitra-public-price-v1';
  const validPrice = (data) => data && Array.isArray(data.categories) && data.categories.every((cat) =>
    cat && typeof cat.id === 'string' && typeof cat.title === 'string' && Array.isArray(cat.items) &&
    cat.items.every((item) => item && typeof item.id === 'string' && typeof item.title === 'string'));
  function readCachedPrice() {
    try {
      const data = JSON.parse(localStorage.getItem(CACHE_KEY));
      return validPrice(data) ? data : null;
    } catch (_) { return null; }
  }
  async function fetchPrice(source) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      // Public document only: no session, API key or CSRF token leaves this page.
      const response = await fetch(source, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (!response.ok) return null;
      const data = await response.json();
      return validPrice(data) ? data : null;
    } catch (_) { return null; }
    finally { clearTimeout(timeout); }
  }
  async function loadPrice(paths) {
    const cached = readCachedPrice();
    const latest = await fetchPrice(paths[0]);
    if (latest) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(latest)); } catch (_) { /* Storage can be disabled. */ }
      return latest;
    }
    if (cached) return cached;
    for (const source of paths.slice(1)) {
      const fallback = await fetchPrice(source);
      if (fallback) return fallback;
    }
    return null;
  }
  async function load(paths) {
    const data = await loadPrice(paths);
    if (data) rememberFrames(data);
    return data;
  }
  /* ---------- кадр фото товара (PALITRA-PHOTO-COMPOSITION-36) ----------
     Карточка, лента фото и окно товара: img[data-photo-frame] из productCard (только у фото с сохранённым кадром).
     Корзина (order.js не меняется): .cart-photo__img в строке [data-cart-line="<id>"] — кадр того же адреса фото
     из последнего загруженного прайса. Фото без кадра не трогаются: показ как раньше по CSS сайта.
     Стили задаются через CSSOM (style.setProperty), не inline-разметкой: CSP не ослабляется. */
  let frameItems = null;
  const framedBoxes = new WeakMap();
  const frameRuns = new WeakMap();
  let frameResize = null;
  function rememberFrames(data) {
    const map = new Map();
    for (const cat of (data && data.categories) || []) {
      for (const item of (cat && Array.isArray(cat.items) ? cat.items : [])) if (item && typeof item.id === 'string' && !map.has(item.id)) map.set(item.id, item);
    }
    frameItems = map;
    if (typeof document !== 'undefined' && document.querySelectorAll) document.querySelectorAll('.cart-photo__img').forEach(frameCartPhoto);
  }
  function runFrame(img, box, frame, displayUrl) {
    if (framedBoxes.get(img) === box) return;
    framedBoxes.set(img, box);
    const run = () => { if (img.isConnected && box.isConnected) PF.applyImg(img, box, frame, displayUrl); };
    frameRuns.set(box, run);
    if (!frameResize && typeof ResizeObserver === 'function') {
      frameResize = new ResizeObserver((entries) => { for (const entry of entries) { const again = frameRuns.get(entry.target); if (again) again(); } });
    }
    if (frameResize) frameResize.observe(box);
    img.addEventListener('load', run);
    if (img.complete && img.naturalWidth) run();
  }
  /* Кадр в ленте фото: у такого снимка своя рамка размером со слайд (span из galleryHtml). */
  function styleSlide(box) {
    const set = (key, value) => box.style.setProperty(key, value);
    set('display', 'block'); set('position', 'relative'); set('flex', '0 0 100%'); set('width', '100%'); set('height', '100%');
    set('overflow', 'hidden'); set('scroll-snap-align', 'start');
  }
  function frameImg(img) {
    const frame = PF.parseAttr(img.getAttribute('data-photo-frame'));
    const box = img.parentElement;
    if (!frame || !box) return;
    if (box.hasAttribute('data-photo-frame-box')) styleSlide(box);
    runFrame(img, box, frame, img.getAttribute('src'));
  }
  function frameCartPhoto(img) {
    const line = img.closest ? img.closest('[data-cart-line]') : null;
    const item = line && frameItems ? frameItems.get(line.getAttribute('data-cart-line')) : null;
    if (!item || !img.parentElement) return;
    const frames = PF.framesOf(item);
    const shown = img.getAttribute('src');
    for (const raw of PF.sourcesOf(item)) {
      if (frames.has(raw) && imageUrl(raw) === shown) { runFrame(img, img.parentElement, frames.get(raw), shown); return; }
    }
  }
  function applyFrames(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches('img[data-photo-frame]')) frameImg(root);
    else if (root.matches('.cart-photo__img')) frameCartPhoto(root);
    root.querySelectorAll('img[data-photo-frame]').forEach(frameImg);
    root.querySelectorAll('.cart-photo__img').forEach(frameCartPhoto);
  }
  function installFrames(doc) {
    if (!doc || doc.__palitraFrames || !doc.documentElement) return;
    doc.__palitraFrames = true;
    if (typeof MutationObserver === 'function') {
      new MutationObserver((records) => { for (const record of records) record.addedNodes.forEach(applyFrames); })
        .observe(doc.documentElement, { childList: true, subtree: true });
    }
    const start = () => applyFrames(doc.documentElement);
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  }
  if (typeof document !== 'undefined') { installGallery(document); installDetails(document); installFrames(document); }
  window.PalitraPrice = { esc, findItem, isPopular, isAutoPriceNote, isUnnamed, unnamedItems, productCard, renderSections, renderNav, load, publicData, photosOf, syncGallery, PRICE_UNKNOWN, DETAILS_MISSING, CART_ICON, photoEntries, photoFrame: PF, applyFrames };
}());
