/* Palitra: чистая модель фото главной черновика site-44bbe13f1bad5e005b2a (PALITRA-BOT-EDITOR-35, 12.10.2026).
   Работает одинаково в браузере (window.PalitraPhotoModel) и на сервере (require).

   Принцип: пользователь никогда не присылает HTML. Он присылает операции из белого списка, модель находит
   ровно один слот по точной разметке BASE 221 и заменяет байты только этого слота. Любое отклонение
   разметки (нет слота, слот повторяется, другой формат) — ошибка malformed/ambiguous, а не «примерная» правка.

   Слоты (точные якоря из BASE/draft-index.html):
   - hero: значения ASSETS в inline-скрипте palitra-selected-five-player, 5 сцен × desktop/tablet/mobile.
     Тексты SLIDES, плеер и движение не трогаются; для сцены 01 mobile — также <noscript><img src> хиро.
   - categories: 11 строк .home-collection в .home-collections__grid. Замена фото снимает у этой карточки
     ролики (data-hover/touch-motion + img.home-collection__motion) и встроенный data-fallback-src старого
     набора, ставит data-motion-fallback="camera" (движение камеры по новому фото, как у «ДР мужчины»).
     <link rel="preload" as="image">, если он ссылается на старое фото этой карточки, переписывается.
   - budget: 3 строки .budget-card (src/alt/width/height).
   - gallery: список «Ваши праздники»: первые 4 с src, остальные hidden + data-story-src, id palitra-story-N,
     aria-controls кнопки «Показать ещё» = id скрытых. Диалог, заголовок, стили и скрипты не трогаются. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PalitraPhotoModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TARGET = Object.freeze({ siteId: 'site-44bbe13f1bad5e005b2a', companyId: 'palitra-love' });
  const HERO_SCENES = Object.freeze([
    { scene: '01', slug: 'vypiska', label: 'Выписка' },
    { scene: '02', slug: 'devushka', label: 'День рождения девушки' },
    { scene: '03', slug: 'muzhchina', label: 'День рождения мужчины' },
    { scene: '04', slug: 'deti', label: 'День рождения малышей' },
    { scene: '05', slug: 'mama', label: 'Шары для мамы' }
  ]);
  const HERO_FORMATS = Object.freeze(['desktop', 'tablet', 'mobile']);
  const CATEGORY_KEYS = Object.freeze(['vypiska', 'dr-muzhchiny', 'dr-devushki', 'dr-malyshey', 'gender-pati', 'devichnik',
    'malchishnik', 'dlya-mamy', 'v-potolok', 's-foto', 'dlya-biznesa']);
  /* Ссылки трёх бюджетных карточек (как в разметке, с &amp;) — только одна из двух ЦЕЛЫХ точных троек:
     прежняя (BASE 221) и принятая на основном сайте (Main 249). Смешанная тройка, другие адреса и числа — ошибка.
     BUDGET_HREFS оставлен прежним (первая тройка) для совместимости. */
  const BUDGET_HREF_SETS = Object.freeze([
    Object.freeze(['/catalog?max=5000', '/catalog?min=5000.01&amp;max=8000', '/catalog?min=8000.01']),
    Object.freeze(['/catalog?max=5000', '/catalog?min=5000&amp;max=8000', '/catalog?min=8000'])
  ]);
  const BUDGET_HREFS = BUDGET_HREF_SETS[0];
  const GALLERY_INITIAL = 4;
  /* 1–24 фото: первые min(4, n) с src, остальные hidden/lazy. При n ≤ 4 скрытых нет, кнопка «Показать ещё»
     остаётся hidden с пустым aria-controls (атрибут сохраняется, чтобы скрипт галереи не получил null).
     Убрать последнее фото нельзя: отдельной функции скрытия всего блока нет (проход 2, F04). */
  const GALLERY_MIN = 1;
  const GALLERY_MAX = 24;
  const MAX_OPERATIONS = 40;
  const ALT_MAX = 250;
  const DIM_MIN = 1;
  const DIM_MAX = 12000;
  const GIF_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

  /* Источники фото: публичное хранилище материалов Palitra (те же расширения, что отдаёт native-маршрут
     /content/publishing-assets: jpg|png|webp) и уже используемые на сайте /api/assets (palitra-love.ru и
     palitra-love.synapsebusiness.ru — сервер читает их локально из ASSETS_DIR/palitra, внешний URL не запрашивается).
     Никаких SVG, data:, file:, http:, портов, логинов, query/hash, других хостов и частных адресов. */
  const ALLOWED_SOURCES = Object.freeze([
    { host: 'synapse.synapsebusiness.ru', path: /^\/content\/publishing-assets\/palitra-love\/[a-f0-9]{32}\.(?:jpg|png|webp)$/ },
    { host: 'palitra-love.ru', path: /^\/api\/assets\/[a-z0-9][a-z0-9-]{0,120}\.(?:jpe?g|png|webp)$/ },
    { host: 'palitra-love.synapsebusiness.ru', path: /^\/api\/assets\/[a-z0-9][a-z0-9-]{0,120}\.(?:jpe?g|png|webp)$/ }
  ]);

  class PhotoModelError extends Error {
    constructor(code, message) { super(message); this.name = 'PhotoModelError'; this.code = code; }
  }
  const fail = (code, message) => { throw new PhotoModelError(code, message); };
  const count = (text, needle) => { let n = 0, i = -1; while ((i = text.indexOf(needle, i + 1)) !== -1) n += 1; return n; };
  const once = (text, needle, what) => {
    const n = count(text, needle);
    if (n === 0) fail('malformed', `Не найден слот: ${what}`);
    if (n > 1) fail('ambiguous', `Слот повторяется (${n}): ${what}`);
    return text.indexOf(needle);
  };

  const escAttr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const decodeAttr = value => String(value).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  function checkTarget(target) {
    if (!target || target.siteId !== TARGET.siteId || target.companyId !== TARGET.companyId) {
      fail('target', 'Редактор фото работает только с черновиком Palitra site-44bbe13f1bad5e005b2a');
    }
  }

  function checkUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 300 || /[\s"'<>\\`&]/.test(value)) fail('url', 'Недопустимый адрес фото');
    let url;
    try { url = new URL(value); } catch (_) { fail('url', 'Недопустимый адрес фото'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.href !== value) {
      fail('url', 'Нужен прямой адрес https без параметров, логина и порта');
    }
    if (!ALLOWED_SOURCES.some(source => source.host === url.hostname && source.path.test(url.pathname))) {
      fail('url', 'Фото должно лежать в хранилище материалов Palitra (jpg, png или webp)');
    }
    return value;
  }

  function checkDim(value, what) {
    if (!Number.isInteger(value) || value < DIM_MIN || value > DIM_MAX) fail('invalid', `Неверный размер фото: ${what}`);
    return value;
  }

  function checkAlt(value, required) {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') fail('invalid', 'Подпись фото должна быть текстом');
    const alt = value.trim().replace(/\s+/g, ' ');
    if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(alt)) fail('invalid', 'В подписи есть служебные символы');
    if (alt.length > ALT_MAX) fail('invalid', `Подпись длиннее ${ALT_MAX} символов`);
    if (required && !alt) fail('invalid', 'Нужна подпись фото: что на нём изображено');
    return alt;
  }

  const checkImage = (image, what) => {
    if (!image || typeof image !== 'object') fail('invalid', `Нет фото: ${what}`);
    return { url: checkUrl(image.url), width: checkDim(image.width, what), height: checkDim(image.height, what) };
  };
  const parseDim = raw => (/^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : fail('malformed', `Неверный размер в разметке: ${raw}`));

  /* ---------- Разбор ---------- */

  function parseHero(html) {
    const marker = 'const ASSETS=';
    const tail = '};const draftUrl=';
    const start = once(html, marker, 'ASSETS хиро') + marker.length;
    const end = once(html, tail, 'конец ASSETS хиро');
    if (end < start) fail('malformed', 'Порядок ASSETS хиро нарушен');
    const objectText = html.slice(start, end + 1);
    let assets;
    try { assets = JSON.parse(objectText); } catch (_) { fail('malformed', 'ASSETS хиро не JSON'); }
    const expected = [];
    for (const { scene, slug } of HERO_SCENES) {
      once(html, `{ n: '${scene}', slug: '${slug}'`, `сцена ${scene}`);
      for (const format of HERO_FORMATS) expected.push(`${scene}-${slug}-${format}.webp`);
    }
    const keys = Object.keys(assets);
    if (keys.length !== expected.length || expected.some(key => !Object.prototype.hasOwnProperty.call(assets, key))) {
      fail('malformed', 'Набор кадров хиро отличается от 5 сцен × 3 формата');
    }
    const ranges = {};
    for (const key of expected) {
      const value = assets[key];
      if (typeof value !== 'string' || /["\\]/.test(value)) fail('malformed', `Кадр хиро ${key} в неожиданном виде`);
      const pair = `"${key}":"${value}"`;
      if (count(objectText, `"${key}":`) !== 1) fail('ambiguous', `Кадр хиро ${key} повторяется`);
      const at = objectText.indexOf(pair);
      if (at < 0) fail('malformed', `Кадр хиро ${key} в неожиданном виде`);
      const valueStart = start + at + key.length + 4;
      ranges[key] = { start: valueStart, end: valueStart + value.length };
    }
    const scenes = HERO_SCENES.map(({ scene, slug, label }) => ({
      scene, slug, label,
      formats: Object.fromEntries(HERO_FORMATS.map(format => [format, assets[`${scene}-${slug}-${format}.webp`]]))
    }));
    // <noscript> хиро показывает кадр 01 mobile; связываем его только при точном совпадении адреса.
    const heroAt = once(html, ' id="hero" ', 'секция хиро');
    const heroEnd = html.indexOf('</section>', heroAt);
    const noscriptMarker = '<noscript><img src="';
    const heroPart = html.slice(heroAt, heroEnd);
    let noscript = null;
    if (count(heroPart, noscriptMarker) === 1) {
      const srcStart = heroAt + heroPart.indexOf(noscriptMarker) + noscriptMarker.length;
      const srcEnd = html.indexOf('"', srcStart);
      if (html.slice(srcStart, srcEnd) === scenes[0].formats.mobile) noscript = { start: srcStart, end: srcEnd };
    } else if (count(heroPart, noscriptMarker) > 1) fail('ambiguous', 'В хиро несколько noscript-фото');
    return { scenes, ranges, noscript };
  }

  const CARD_RE = /^ {2}<a class="home-collection"((?: id="home-collection-more-[1-9]" data-home-more)?)((?: data-hover-motion="[^"]+" data-touch-motion="[^"]+")|(?: data-motion-fallback="camera")) data-motion-duration="7" href="\/catalog\?cat=([a-z-]+)"><picture><source media="\(max-width:760px\)" data-mobile-srcset="([^"]+)" srcset="data:image\/gif;base64,R0lGODlhAQABAAD\/ACwAAAAAAQABAAACADs="><img src="([^"]+)" alt="([^"]*)" width="(\d+)" height="(\d+)" loading="lazy" fetchpriority="auto" decoding="async"((?: data-fallback-src="data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+")?)><\/picture>((?:<img class="home-collection__motion" alt="" aria-hidden="true"(?: width="640" height="640"| decoding="async")>)?)<span class="home-collection__title">([^<]+)<\/span><\/a>$/;
  const PRELOAD_RE = /^<link rel="preload" as="image" fetchpriority="high" imagesrcset="([^"]+)" imagesizes="([^"]+)" href="([^"]+)">$/;

  function parseCategories(html) {
    once(html, '<section class="home-collections" id="catalog"', 'секция категорий');
    const open = '<div class="home-collections__grid">\n';
    const close = '\n</div>\n<div class="home-collections__toggle">';
    const start = once(html, open, 'сетка категорий') + open.length;
    const end = once(html, close, 'конец сетки категорий');
    if (end < start) fail('malformed', 'Сетка категорий нарушена');
    const lines = html.slice(start, end).split('\n');
    if (lines.length !== CATEGORY_KEYS.length) fail('malformed', `Категорий ${lines.length}, ожидалось ${CATEGORY_KEYS.length}`);
    let offset = start;
    const cards = lines.map((line, index) => {
      const m = CARD_RE.exec(line);
      if (!m) fail('malformed', `Карточка категории №${index + 1} в неожиданном виде`);
      const card = {
        moreAttr: m[1], motionAttr: m[2], key: m[3], mobile: m[4], src: m[5], alt: decodeAttr(m[6]),
        width: parseDim(m[7]), height: parseDim(m[8]), fallbackAttr: m[9], motionImg: m[10], title: m[11],
        start: offset, end: offset + line.length
      };
      const hasRoller = card.motionAttr.startsWith(' data-hover-motion');
      if (hasRoller !== Boolean(card.motionImg)) fail('malformed', `Ролик категории ${card.key} без своего элемента`);
      if (card.key !== CATEGORY_KEYS[index]) fail('malformed', `Порядок категорий нарушен: ${card.key}`);
      offset += line.length + 1;
      return card;
    });
    // preload, ссылающийся на фото карточки, переписывается вместе с ней.
    let at = -1;
    while ((at = html.indexOf('<link rel="preload" as="image"', at + 1)) !== -1) {
      const lineEnd = html.indexOf('>', at) + 1;
      const tag = html.slice(at, lineEnd);
      const owner = cards.filter(card => tag.includes(card.src) || tag.includes(card.mobile));
      if (!owner.length) continue;
      if (owner.length > 1) fail('ambiguous', 'preload ссылается на несколько категорий');
      const m = PRELOAD_RE.exec(tag);
      if (!m) fail('malformed', 'preload категории в неожиданном виде');
      if (owner[0].preload) fail('ambiguous', `Несколько preload у категории ${owner[0].key}`);
      owner[0].preload = { start: at, end: lineEnd, sizes: m[2] };
    }
    return cards;
  }

  const serializeCard = card => `  <a class="home-collection"${card.moreAttr}${card.motionAttr} data-motion-duration="7" href="/catalog?cat=${card.key}"><picture><source media="(max-width:760px)" data-mobile-srcset="${card.mobile}" srcset="${GIF_PIXEL}"><img src="${card.src}" alt="${escAttr(card.alt)}" width="${card.width}" height="${card.height}" loading="lazy" fetchpriority="auto" decoding="async"${card.fallbackAttr}></picture>${card.motionImg}<span class="home-collection__title">${card.title}</span></a>`;

  const BUDGET_RE = /^<li><a class="budget-card" href="([^"]+)" aria-label="([^"]+)"><span class="budget-card__media"><img src="([^"]+)" alt="([^"]*)" loading="lazy" decoding="async" width="(\d+)" height="(\d+)"><\/span><span class="budget-card__label">(.+?)<\/span><\/a><\/li>$/;

  function parseBudget(html) {
    const sectionAt = once(html, '<section class="budget-collections" id="budget-collections"', 'секция «По стоимости»');
    const open = '<ul class="budget-collections__grid">\n';
    const start = once(html, open, 'сетка «По стоимости»') + open.length;
    const end = html.indexOf('\n</ul>', start);
    if (start < sectionAt || end < 0) fail('malformed', 'Сетка «По стоимости» нарушена');
    const lines = html.slice(start, end).split('\n');
    if (lines.length !== BUDGET_HREFS.length) fail('malformed', `Бюджетных карточек ${lines.length}, ожидалось 3`);
    let offset = start;
    const cards = lines.map((line, index) => {
      const m = BUDGET_RE.exec(line);
      if (!m) fail('malformed', `Бюджетная карточка №${index + 1} в неожиданном виде`);
      const card = { index, href: m[1], ariaLabel: m[2], src: m[3], alt: decodeAttr(m[4]), width: parseDim(m[5]), height: parseDim(m[6]), label: m[7], start: offset, end: offset + line.length };
      offset += line.length + 1;
      return card;
    });
    // Ссылки — ровно одна из разрешённых целых троек байт в байт; смешанная тройка, повтор или другой адрес — ошибка.
    const hrefs = cards.map(card => card.href);
    if (!BUDGET_HREF_SETS.some(set => set.every((href, i) => hrefs[i] === href))) {
      const at = hrefs.findIndex((href, i) => !BUDGET_HREF_SETS.some(set => set[i] === href));
      fail('malformed', at >= 0 ? `Бюджетная карточка №${at + 1} в неожиданном виде` : 'Ссылки «По стоимости» в неожиданном виде: смешаны разные наборы');
    }
    return cards;
  }

  const serializeBudget = card => `<li><a class="budget-card" href="${card.href}" aria-label="${card.ariaLabel}"><span class="budget-card__media"><img src="${card.src}" alt="${escAttr(card.alt)}" loading="lazy" decoding="async" width="${card.width}" height="${card.height}"></span><span class="budget-card__label">${card.label}</span></a></li>`;

  const STORY_INITIAL_RE = /^<li class="palitra-stories__item"><a class="palitra-stories__open" href="([^"]+)" data-story-open><img src="([^"]+)" alt="([^"]*)" width="(\d+)" height="(\d+)" loading="lazy" decoding="async"><\/a><\/li>$/;
  const STORY_MORE_RE = /^<li class="palitra-stories__item" id="palitra-story-(\d+)" data-story-more hidden><a class="palitra-stories__open" href="([^"]+)" data-story-open><img data-story-src="([^"]+)" alt="([^"]*)" width="(\d+)" height="(\d+)" loading="lazy" decoding="async"><\/a><\/li>$/;
  const TOGGLE_PREFIX = '<div class="palitra-stories__toggle"><button type="button" class="palitra-stories__more" data-stories-toggle aria-expanded="false" aria-controls="';
  const TOGGLE_SUFFIX = '" hidden><span data-stories-label>Показать ещё</span><span aria-hidden="true" data-stories-arrow>→</span></button></div>';
  const DIALOG_AFTER = '\n</div><dialog class="palitra-stories__dialog" data-story-dialog aria-label="Фото праздника целиком"><button type="button" class="palitra-stories__close" data-story-close aria-label="Закрыть фото">×</button><img class="palitra-stories__full" data-story-full alt=""></dialog></section>';

  function parseGallery(html) {
    const sectionAt = once(html, '<section class="palitra-stories" id="palitra-stories"', 'секция «Ваши праздники»');
    const open = '<ul class="palitra-stories__grid">\n';
    const start = once(html, open, 'сетка «Ваши праздники»') + open.length;
    const listEnd = html.indexOf('\n</ul>\n', start);
    if (start < sectionAt || listEnd < 0) fail('malformed', 'Сетка «Ваши праздники» нарушена');
    const toggleStart = listEnd + '\n</ul>\n'.length;
    if (!html.startsWith(TOGGLE_PREFIX, toggleStart)) fail('malformed', 'Кнопка «Показать ещё» в неожиданном виде');
    const idsStart = toggleStart + TOGGLE_PREFIX.length;
    const idsEnd = html.indexOf('"', idsStart);
    if (!html.startsWith(TOGGLE_SUFFIX, idsEnd)) fail('malformed', 'Кнопка «Показать ещё» в неожиданном виде');
    const end = idsEnd + TOGGLE_SUFFIX.length;
    if (!html.startsWith(DIALOG_AFTER, end)) fail('malformed', 'Окно фото галереи в неожиданном виде');
    once(html, 'data-story-dialog', 'окно фото галереи');
    const lines = html.slice(start, listEnd).split('\n');
    if (lines.length < GALLERY_MIN || lines.length > GALLERY_MAX) fail('malformed', `В галерее ${lines.length} фото`);
    const items = lines.map((line, index) => {
      if (index < GALLERY_INITIAL) {
        const m = STORY_INITIAL_RE.exec(line);
        if (!m || m[1] !== m[2]) fail('malformed', `Фото галереи №${index + 1} в неожиданном виде`);
        return { url: m[2], alt: decodeAttr(m[3]), width: parseDim(m[4]), height: parseDim(m[5]) };
      }
      const m = STORY_MORE_RE.exec(line);
      if (!m || Number(m[1]) !== index + 1 || m[2] !== m[3]) fail('malformed', `Скрытое фото галереи №${index + 1} в неожиданном виде`);
      return { url: m[3], alt: decodeAttr(m[4]), width: parseDim(m[5]), height: parseDim(m[6]) };
    });
    if (html.slice(idsStart, idsEnd) !== moreIds(items.length)) fail('malformed', 'aria-controls «Показать ещё» не совпадает со скрытыми фото');
    return { items, start, end };
  }

  const moreIds = total => Array.from({ length: Math.max(0, total - GALLERY_INITIAL) }, (_, i) => `palitra-story-${GALLERY_INITIAL + i + 1}`).join(' ');
  const serializeStory = (item, index) => {
    const alt = escAttr(item.alt);
    if (index < GALLERY_INITIAL) return `<li class="palitra-stories__item"><a class="palitra-stories__open" href="${item.url}" data-story-open><img src="${item.url}" alt="${alt}" width="${item.width}" height="${item.height}" loading="lazy" decoding="async"></a></li>`;
    return `<li class="palitra-stories__item" id="palitra-story-${index + 1}" data-story-more hidden><a class="palitra-stories__open" href="${item.url}" data-story-open><img data-story-src="${item.url}" alt="${alt}" width="${item.width}" height="${item.height}" loading="lazy" decoding="async"></a></li>`;
  };
  const serializeGallery = items => `${items.map(serializeStory).join('\n')}\n</ul>\n${TOGGLE_PREFIX}${moreIds(items.length)}${TOGGLE_SUFFIX}`;

  function parseDocument(html) {
    if (typeof html !== 'string' || !html.startsWith('<!doctype html>') || !html.trimEnd().endsWith('</html>')) fail('malformed', 'Это не index.html черновика');
    return { hero: parseHero(html), categories: parseCategories(html), budget: parseBudget(html), gallery: parseGallery(html) };
  }

  /* Публичное представление слотов — без диапазонов и служебных кусков разметки. Его видит редактор. */
  function publicSlots(doc) {
    return {
      hero: doc.hero.scenes.map(scene => ({ scene: scene.scene, slug: scene.slug, label: scene.label, formats: { ...scene.formats } })),
      categories: doc.categories.map(card => ({
        key: card.key, title: card.title, src: card.src, mobile: card.mobile, alt: card.alt, width: card.width, height: card.height,
        motion: card.motionAttr.startsWith(' data-hover-motion'), preload: Boolean(card.preload), more: Boolean(card.moreAttr)
      })),
      budget: doc.budget.map(card => ({ index: card.index, href: decodeAttr(card.href), ariaLabel: card.ariaLabel, src: card.src, alt: card.alt, width: card.width, height: card.height })),
      gallery: doc.gallery.items.map(item => ({ ...item }))
    };
  }

  const parseSlots = html => publicSlots(parseDocument(html));

  /* ---------- Операции ---------- */

  function normalizeOperation(op) {
    if (!op || typeof op !== 'object') fail('invalid', 'Пустая операция');
    switch (op.type) {
      case 'hero.scene': {
        const scene = HERO_SCENES.find(item => item.scene === op.scene);
        if (!scene) fail('invalid', 'Нет такой сцены хиро');
        const formats = {};
        for (const format of HERO_FORMATS) {
          const image = checkImage(op[format], `сцена ${op.scene}, ${format}`);
          // Формат кадра сохраняется: компьютер и планшет — горизонтальные, телефон — вертикальный.
          if (format === 'mobile' ? image.height <= image.width : image.width <= image.height) {
            fail('invalid', `Сцена ${op.scene}: для «${format}» нужен ${format === 'mobile' ? 'вертикальный' : 'горизонтальный'} кадр`);
          }
          formats[format] = image;
        }
        return { type: op.type, target: `hero:${op.scene}`, scene: op.scene, ...formats };
      }
      case 'category.photo': {
        if (!CATEGORY_KEYS.includes(op.category)) fail('invalid', 'Нет такой категории');
        const image = checkImage(op, `категория ${op.category}`);
        const mobile = op.mobile === undefined || op.mobile === null ? null : checkImage(op.mobile, `категория ${op.category}, телефон`);
        return { type: op.type, target: `category:${op.category}`, category: op.category, ...image, mobile, alt: checkAlt(op.alt, false) };
      }
      case 'budget.photo': {
        if (![0, 1, 2].includes(op.index)) fail('invalid', 'Нет такой бюджетной карточки');
        return { type: op.type, target: `budget:${op.index}`, index: op.index, ...checkImage(op, `бюджет ${op.index + 1}`), alt: checkAlt(op.alt, true) };
      }
      case 'gallery.set': {
        if (!Array.isArray(op.items) || op.items.length < GALLERY_MIN || op.items.length > GALLERY_MAX) {
          fail('invalid', `В галерее должно быть от ${GALLERY_MIN} до ${GALLERY_MAX} фото`);
        }
        const items = op.items.map((item, i) => ({ ...checkImage(item, `галерея №${i + 1}`), alt: checkAlt(item && item.alt, true) }));
        if (new Set(items.map(item => item.url)).size !== items.length) fail('invalid', 'Одно фото стоит в галерее дважды');
        return { type: op.type, target: 'gallery', items };
      }
      default:
        return fail('invalid', `Операция не разрешена: ${String(op.type)}`);
    }
  }

  function normalizeOperations(ops) {
    if (!Array.isArray(ops) || !ops.length) fail('invalid', 'Нет изменений');
    if (ops.length > MAX_OPERATIONS) fail('invalid', `Слишком много изменений за раз (больше ${MAX_OPERATIONS})`);
    const normalized = ops.map(normalizeOperation);
    const targets = new Set();
    for (const op of normalized) {
      if (targets.has(op.target)) fail('invalid', `Слот изменяется дважды: ${op.target}`);
      targets.add(op.target);
    }
    return normalized;
  }

  /* Категория: сменилось ли фото (F04). Тот же src и тот же/не переданный mobile — правка только подписи:
     ролик, встроенный запасной кадр и preload карточки остаются. Тот же адрес с другими размерами — ошибка. */
  function categoryChange(card, op) {
    const desktopSame = op.url === card.src;
    const mobileUrl = op.mobile ? op.mobile.url : desktopSame ? card.mobile : op.url;
    const changed = !desktopSame || mobileUrl !== card.mobile;
    if (desktopSame && (op.width !== card.width || op.height !== card.height)) fail('invalid', `Категория ${card.key}: у того же фото другие размеры`);
    const mobile = op.mobile || (desktopSame ? { url: card.mobile, width: null, height: null } : { url: op.url, width: op.width, height: op.height });
    return { changed, mobile };
  }

  /* Ожидаемые слоты после операций — для самопроверки модели, проверки сервера и readback в редакторе. */
  function projectSlots(slots, ops) {
    const next = JSON.parse(JSON.stringify(slots));
    for (const op of normalizeOperations(ops)) {
      if (op.type === 'hero.scene') {
        const scene = next.hero.find(item => item.scene === op.scene);
        for (const format of HERO_FORMATS) scene.formats[format] = op[format].url;
      } else if (op.type === 'category.photo') {
        const card = next.categories.find(item => item.key === op.category);
        const { changed, mobile } = categoryChange(card, op);
        Object.assign(card, { src: op.url, width: op.width, height: op.height, alt: op.alt, mobile: mobile.url, motion: changed ? false : card.motion });
      } else if (op.type === 'budget.photo') {
        Object.assign(next.budget[op.index], { src: op.url, width: op.width, height: op.height, alt: op.alt });
      } else if (op.type === 'gallery.set') {
        next.gallery = op.items.map(item => ({ url: item.url, alt: item.alt, width: item.width, height: item.height }));
      }
    }
    return next;
  }

  function applyOperations(html, ops, target) {
    checkTarget(target);
    const doc = parseDocument(html);
    const normalized = normalizeOperations(ops);
    const patches = [];
    const patch = (start, end, text, slot) => patches.push({ start, end, text, slot });
    for (const op of normalized) {
      if (op.type === 'hero.scene') {
        const scene = HERO_SCENES.find(item => item.scene === op.scene);
        for (const format of HERO_FORMATS) {
          const range = doc.hero.ranges[`${scene.scene}-${scene.slug}-${format}.webp`];
          patch(range.start, range.end, op[format].url, `hero:${op.scene}:${format}`);
        }
        if (op.scene === '01' && doc.hero.noscript) patch(doc.hero.noscript.start, doc.hero.noscript.end, op.mobile.url, 'hero:01:noscript');
      } else if (op.type === 'category.photo') {
        const card = doc.categories.find(item => item.key === op.category);
        const { changed, mobile } = categoryChange(card, op);
        if (!changed) {
          // Только подпись: ролик, data-fallback-src и preload этой карточки сохраняются байт в байт.
          patch(card.start, card.end, serializeCard({ ...card, alt: op.alt }), `category:${card.key}`);
          continue;
        }
        const next = { ...card, src: op.url, width: op.width, height: op.height, alt: op.alt, mobile: mobile.url,
          motionAttr: ' data-motion-fallback="camera"', motionImg: '', fallbackAttr: '' };
        patch(card.start, card.end, serializeCard(next), `category:${card.key}`);
        if (card.preload) {
          const srcset = mobile.url === op.url ? `${op.url} ${op.width}w` : `${mobile.url} ${mobile.width}w, ${op.url} ${op.width}w`;
          patch(card.preload.start, card.preload.end, `<link rel="preload" as="image" fetchpriority="high" imagesrcset="${srcset}" imagesizes="${card.preload.sizes}" href="${op.url}">`, `category:${card.key}:preload`);
        }
      } else if (op.type === 'budget.photo') {
        const card = doc.budget[op.index];
        patch(card.start, card.end, serializeBudget({ ...card, src: op.url, width: op.width, height: op.height, alt: op.alt }), `budget:${op.index}`);
      } else if (op.type === 'gallery.set') {
        patch(doc.gallery.start, doc.gallery.end, serializeGallery(op.items), 'gallery');
      }
    }
    patches.sort((a, b) => a.start - b.start);
    for (let i = 1; i < patches.length; i += 1) {
      if (patches[i].start < patches[i - 1].end) fail('ambiguous', 'Слоты пересекаются');
    }
    let result = html;
    for (let i = patches.length - 1; i >= 0; i -= 1) result = result.slice(0, patches[i].start) + patches[i].text + result.slice(patches[i].end);
    // Самопроверка: результат разбирается заново и совпадает с ожиданием по слотам.
    const after = parseSlots(result);
    const expected = projectSlots(publicSlots(doc), normalized);
    if (JSON.stringify(after) !== JSON.stringify(expected)) fail('malformed', 'Самопроверка модели не сошлась');
    return { html: result, slots: after, patches: patches.map(({ start, end, text, slot }) => ({ slot, start, end, length: text.length })) };
  }

  /* Совпадают ли прочитанные слоты с ожидаемыми — используется редактором после сохранения и после
     «неизвестного результата» (сначала чтение, не повтор). */
  const slotsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  return Object.freeze({
    TARGET, HERO_SCENES, HERO_FORMATS, CATEGORY_KEYS, BUDGET_HREFS, BUDGET_HREF_SETS, GALLERY_INITIAL, GALLERY_MIN, GALLERY_MAX, MAX_OPERATIONS, ALT_MAX,
    PhotoModelError, checkTarget, checkUrl, checkAlt, parseSlots, normalizeOperations, projectSlots, applyOperations, slotsEqual,
    _internal: { parseDocument, serializeCard, serializeBudget, serializeGallery, escAttr, decodeAttr }
  });
});
