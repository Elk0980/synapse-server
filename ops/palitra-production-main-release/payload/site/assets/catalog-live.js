/* Palitra: публичные поводы (категории витрины), основные 6 на главной и временные праздничные подборки.
   Один модуль для витрины (catalog-live.js, главная) и для редактора ЛК: одинаковые правила с обеих сторон.
   UMD: в браузере — window.PalitraOccasions, в Node — module.exports. Прайс не меняется: товар остаётся
   одним объектом в своём разделе прайса (category.items) со старым id; поводы — только метки при чтении. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PalitraOccasions = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  /* Тот же список и порядок, что DEFAULT_CATEGORIES в catalog-live.js (без «Весь каталог»).
     key — публичный ключ повода (адрес /catalog?cat=key); source — id разделов прайса (category.id),
     товары которых попадают в повод по старому правилу. Ключ повода и id раздела — разные вещи. */
  const DEFAULT_PUBLIC = Object.freeze([
    { key: 'vypiska', title: 'Выписка', source: ['vypiska'] },
    { key: 'dr-muzhchiny', title: 'День рождения мужчины', source: ['dr-muzhchine'] },
    { key: 'dr-devushki', title: 'День рождения девушки', source: ['dr-zhenschine'] },
    { key: 'dr-malyshey', title: 'День рождения малышей', source: ['dr-detyam'] },
    { key: 'gender-pati', title: 'Гендер пати', source: ['gender-pati'] },
    { key: 'devichnik', title: 'Девичник', source: ['devichnik'] },
    { key: 'malchishnik', title: 'Мальчишник', source: ['malchishnik'] },
    { key: 'dlya-mamy', title: 'Шары для мамы', source: ['dlya-mamy'] },
    { key: 'v-potolok', title: 'Шары в потолок', source: ['v-potolok'] },
    { key: 's-foto', title: 'Шары с фото', source: ['s-foto'] },
    { key: 'dlya-biznesa', title: 'Шары для бизнеса', source: ['dlya-biznesa'] }
  ].map(Object.freeze));
  /* Шесть основных Дарьи (12.10.2026): Выписка, ДР мужчины, ДР девушки, ДР малышей, Гендер пати, Девичник. */
  const DEFAULT_HOME = Object.freeze(['vypiska', 'dr-muzhchiny', 'dr-devushki', 'dr-malyshey', 'gender-pati', 'devichnik']);
  const HOME_MAX = 6;
  const HOLIDAYS_MAX = 12;
  const HOLIDAY_SPAN_MAX_DAYS = 366;
  const HOLIDAY_KEY = /^h-[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const PUBLIC_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const unique = (list) => list.filter((value, index) => list.indexOf(value) === index);

  /* Настоящая календарная дата YYYY-MM-DD (без 2027-02-30). */
  function isValidDate(value) {
    const m = DATE.exec(typeof value === 'string' ? value : '');
    if (!m) return false;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
    return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  }
  const dayNumber = (value) => { const m = DATE.exec(value); return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000; };

  /* Часовой пояс принимается только как подтверждённая настройка компании (сервер/хост), не из браузера.
     Пустое значение — пояса нет: расписание праздников выключено. */
  function isValidTimeZone(value) {
    if (typeof value !== 'string' || !value || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; } catch (_) { return false; }
  }
  /* Местная дата компании в момент now (учитывает летнее время через Intl). */
  function localDate(now, timeZone) {
    if (!isValidTimeZone(timeZone)) return '';
    const time = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(time)) return '';
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(time));
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    const y = get('year'), m = get('month'), d = get('day');
    return /^\d{4}$/.test(y) && /^\d{2}$/.test(m) && /^\d{2}$/.test(d) ? `${y}-${m}-${d}` : '';
  }

  function catalogOf(data) { return data && isObject(data.publicCatalog) ? data.publicCatalog : null; }
  function baseKeys(categories) {
    return (Array.isArray(categories) ? categories : DEFAULT_PUBLIC)
      .filter((cat) => cat && cat.key && cat.key !== 'all' && !cat.holiday).map((cat) => cat.key);
  }

  /* Проверка одной записи праздника. Возвращает список проблем (пусто — запись верна). */
  function holidayProblems(h, knownKeys, takenKeys) {
    const out = [];
    if (!isObject(h)) return ['Запись праздника должна быть объектом'];
    const name = typeof h.title === 'string' && h.title.trim() ? `«${h.title.trim()}»` : String(h.key || '?');
    if (typeof h.key !== 'string' || !HOLIDAY_KEY.test(h.key) || h.key.length > 40) out.push(`Праздник ${name}: ключ должен начинаться с h- и содержать латиницу, цифры и дефисы`);
    else if (takenKeys && takenKeys.has(h.key)) out.push(`Праздник ${name}: ключ ${h.key} уже занят`);
    if (typeof h.title !== 'string' || !h.title.trim() || h.title.length > 60) out.push(`Праздник ${name}: нужно название до 60 символов`);
    const startOk = isValidDate(h.start), endOk = isValidDate(h.end);
    if (!startOk) out.push(`Праздник ${name}: дата начала должна быть в виде ГГГГ-ММ-ДД`);
    if (!endOk) out.push(`Праздник ${name}: дата окончания должна быть в виде ГГГГ-ММ-ДД`);
    if (startOk && endOk) {
      const span = dayNumber(h.end) - dayNumber(h.start);
      if (span < 0) out.push(`Праздник ${name}: окончание раньше начала`);
      else if (span >= HOLIDAY_SPAN_MAX_DAYS) out.push(`Праздник ${name}: показ дольше ${HOLIDAY_SPAN_MAX_DAYS} дней`);
    }
    if (!Array.isArray(h.include) || !h.include.length) out.push(`Праздник ${name}: выберите хотя бы одну категорию`);
    else {
      const known = new Set(knownKeys);
      for (const key of h.include) {
        if (typeof key !== 'string') { out.push(`Праздник ${name}: неверная категория`); continue; }
        // Праздник собирается только из обычных поводов: вложенные праздники и ссылка на себя дали бы цикл.
        if (key === h.key || HOLIDAY_KEY.test(key)) out.push(`Праздник ${name}: нельзя включать праздник в праздник (${key})`);
        else if (!known.has(key)) out.push(`Праздник ${name}: категории ${key} нет на сайте`);
      }
      if (unique(h.include).length !== h.include.length) out.push(`Праздник ${name}: категория указана дважды`);
    }
    if (h.pinned !== undefined && typeof h.pinned !== 'boolean') out.push(`Праздник ${name}: «закрепить» должно быть да или нет`);
    return out;
  }
  function holidaysProblems(list, knownKeys) {
    if (list === undefined) return [];
    if (!Array.isArray(list)) return ['Праздники должны быть списком'];
    const out = [];
    if (list.length > HOLIDAYS_MAX) out.push(`Праздников больше ${HOLIDAYS_MAX}`);
    const taken = new Set();
    for (const h of list) {
      out.push(...holidayProblems(h, knownKeys, taken));
      if (isObject(h) && typeof h.key === 'string') taken.add(h.key);
    }
    return out;
  }
  function homeProblems(home, knownKeys) {
    if (home === undefined) return [];
    if (!Array.isArray(home)) return ['Основные категории должны быть списком'];
    const out = [];
    const known = new Set(knownKeys);
    if (home.length > HOME_MAX) out.push(`Основных категорий больше ${HOME_MAX}`);
    for (const key of home) if (typeof key !== 'string' || !known.has(key)) out.push(`Основная категория ${String(key)} не найдена на сайте`);
    if (unique(home).length !== home.length) out.push('Основная категория указана дважды');
    return out;
  }

  /* Статус праздника для показа: без подтверждённого пояса — 'no-timezone' (не показывается). */
  function holidayStatus(h, now, timeZone, knownKeys) {
    if (holidayProblems(h, knownKeys || baseKeys()).length) return 'invalid';
    if (!isValidTimeZone(timeZone)) return 'no-timezone';
    const today = localDate(now === undefined || now === null ? Date.now() : now, timeZone);
    if (!today) return 'no-timezone';
    if (today < h.start) return 'upcoming';
    if (today > h.end) return 'ended'; // окончание включительно: весь день end по местному времени ещё показ
    return 'active';
  }
  function activeHolidays(data, options = {}) {
    const known = baseKeys(options.categories);
    const list = catalogOf(data) && Array.isArray(catalogOf(data).holidays) ? catalogOf(data).holidays : [];
    const seen = new Set();
    return list.filter((h) => {
      if (!isObject(h) || seen.has(h.key)) return false;
      seen.add(h.key);
      return holidayStatus(h, options.now, options.timeZone, known) === 'active';
    }).sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))) || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }

  /* Основные категории: сохранённый порядок (только существующие, без повторов, не больше 6) или шесть Дарьи. */
  function homeKeys(data, categories) {
    const known = new Set(baseKeys(categories));
    const saved = catalogOf(data) && Array.isArray(catalogOf(data).home) ? catalogOf(data).home : null;
    return unique((saved || DEFAULT_HOME).filter((key) => typeof key === 'string' && known.has(key))).slice(0, HOME_MAX);
  }

  /* Поводы товара без праздников. Нет поля publicCategories — прежнее правило по разделу прайса (source);
     явный список — ровно эти поводы; явный [] — ни одного повода (товар остаётся во «Весь каталог»). */
  function basePublicKeys(item, ownerId, categories) {
    const list = Array.isArray(categories) ? categories : DEFAULT_PUBLIC;
    const known = new Set(baseKeys(list));
    if (item && Array.isArray(item.publicCategories)) {
      return unique(item.publicCategories.filter((key) => typeof key === 'string' && known.has(key)));
    }
    return list.filter((pub) => pub && pub.key !== 'all' && !pub.holiday && (pub.source || []).includes(ownerId)).map((pub) => pub.key);
  }
  /* Поводы товара вместе с активными праздниками (праздник = объединение своих категорий, без повторов). */
  function publicKeysOf(item, ownerId, categories) {
    const keys = basePublicKeys(item, ownerId, categories);
    const holidays = (Array.isArray(categories) ? categories : []).filter((pub) => pub && pub.holiday
      && Array.isArray(pub.include) && pub.include.some((key) => keys.includes(key)));
    return unique(keys.concat(holidays.map((pub) => pub.key)));
  }

  /* Список поводов для фильтра каталога: «Весь каталог», закреплённые активные праздники, основные (в выбранном
     порядке), остальные поводы (в прежнем порядке), затем незакреплённые активные праздники. */
  function publicCategories(baseCategories, data, options = {}) {
    const base = (Array.isArray(baseCategories) && baseCategories.length ? baseCategories : [{ key: 'all', title: 'Весь каталог', source: [] }].concat(DEFAULT_PUBLIC))
      .filter((cat) => cat && typeof cat.key === 'string' && !cat.holiday);
    const all = base.filter((cat) => cat.key === 'all');
    const plain = base.filter((cat) => cat.key !== 'all');
    const home = homeKeys(data, plain);
    const main = home.map((key) => plain.find((cat) => cat.key === key));
    const rest = plain.filter((cat) => !home.includes(cat.key));
    const holidays = activeHolidays(data, { now: options.now, timeZone: options.timeZone, categories: plain })
      .map((h) => ({ key: h.key, title: h.title.trim(), source: [], holiday: true, pinned: h.pinned === true, include: unique(h.include) }));
    return all.concat(holidays.filter((h) => h.pinned), main, rest, holidays.filter((h) => !h.pinned));
  }

  /* Раскладка главной: закреплённые праздники, основные (до 6) и «Показать ещё» (остальные поводы и
     незакреплённые праздники). Ключи — публичные ключи поводов. */
  function homeLayout(data, baseCategories, options = {}) {
    const cats = publicCategories(baseCategories, data, options);
    const plain = cats.filter((cat) => cat.key !== 'all' && !cat.holiday);
    const main = homeKeys(data, plain);
    return {
      pinned: cats.filter((cat) => cat.holiday && cat.pinned).map((cat) => ({ key: cat.key, title: cat.title })),
      main,
      more: plain.filter((cat) => !main.includes(cat.key)).map((cat) => cat.key),
      moreHolidays: cats.filter((cat) => cat.holiday && !cat.pinned).map((cat) => ({ key: cat.key, title: cat.title }))
    };
  }

  return {
    DEFAULT_PUBLIC, DEFAULT_HOME, HOME_MAX, HOLIDAYS_MAX, HOLIDAY_KEY, PUBLIC_KEY,
    isValidDate, isValidTimeZone, localDate, catalogOf, baseKeys,
    holidayProblems, holidaysProblems, homeProblems, holidayStatus, activeHolidays,
    homeKeys, basePublicKeys, publicKeysOf, publicCategories, homeLayout
  };
});

;
/* Catalog cards use the same saved price document as the client editor. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./price-format.js') : root.PalitraPriceFormat);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.mount(root);
}(typeof window === 'undefined' ? null : window, function (priceFormat) {
  'use strict';
  const aliases = {
    vypiska: ['vypiska', 'shary', 'malysham'],
    'dr-detyam': ['den-rozhdeniya', 'malysham', 'shary'],
    'dr-muzhchine': ['den-rozhdeniya', 'muzhchinam', 'shary'],
    'dr-zhenschine': ['den-rozhdeniya', 'shary'],
    bukety: ['bukety'], korziny: ['korziny', 'bukety'],
    dofaminovye: ['dofaminovye', 'shary'],
    giganty: ['shary-giganty', 'shary'], devichnik: ['devichnik', 'shary']
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function safeImage(value) {
    const url = String(value || '');
    return /^\/(?!\/)/.test(url) || /^https:\/\//i.test(url) ? url : '';
  }
  /* Публичные категории Дарьи (05.10.2026) — из config.js; здесь запасной список того же порядка. */
  const DEFAULT_CATEGORIES = [
    { key: 'all', title: 'Весь каталог', source: [] },
    { key: 'vypiska', title: 'Выписка', source: ['vypiska'] },
    { key: 'dr-muzhchiny', title: 'День рождения мужчины', source: ['dr-muzhchine'] },
    { key: 'dr-devushki', title: 'День рождения девушки', source: ['dr-zhenschine'] },
    { key: 'dr-malyshey', title: 'День рождения малышей', source: ['dr-detyam'] },
    { key: 'gender-pati', title: 'Гендер пати', source: ['gender-pati'] },
    { key: 'devichnik', title: 'Девичник', source: ['devichnik'] },
    { key: 'malchishnik', title: 'Мальчишник', source: ['malchishnik'] },
    { key: 'dlya-mamy', title: 'Шары для мамы', source: ['dlya-mamy'] },
    { key: 'v-potolok', title: 'Шары в потолок', source: ['v-potolok'] },
    { key: 's-foto', title: 'Шары с фото', source: ['s-foto'] },
    { key: 'dlya-biznesa', title: 'Шары для бизнеса', source: ['dlya-biznesa'] }
  ];
  const publicCategories = (config) => (Array.isArray(config?.PUBLIC_CATEGORIES) && config.PUBLIC_CATEGORIES.length ? config.PUBLIC_CATEGORIES : DEFAULT_CATEGORIES);
  /* Товар получает теги прежних разделов (адреса /catalog/<раздел> работают как раньше) и метки публичных
     категорий pk-<ключ> по id категории прайса. Данные прайса не меняются и не перекладываются. */
  function entries(data, pathname, categories = DEFAULT_CATEGORIES, occasions = null) {
    const selected = pathname.replace(/\/(?:index\.html)?$/, '').split('/')[2] || '';
    return (data.categories || []).flatMap(category => (category.items || []).map(item => ({
      ...item, category: category.title, categoryId: category.id,
      tags: [...new Set([category.id, ...(aliases[category.id] || []),
        ...(occasions ? occasions.publicKeysOf(item, category.id, categories) : categories.filter(pub => pub.key !== 'all' && (pub.source || []).includes(category.id)).map(pub => pub.key)).map(key => 'pk-' + key)])]
    }))).filter(item => !selected || item.tags.includes(selected));
  }
  const filterByCategory = (list, key) => (!key || key === 'all' ? list : list.filter(item => item.tags.includes('pk-' + key)));
  /* Навигация категорий: ссылки с понятным адресом (/catalog?cat=…), число товаров у каждой —
     пустая категория видна честно (0), а не скрыта и не заполнена чужими товарами. */
  function categoryNav(categories, list, active, base = '/catalog') {
    return '<ul class="shop-categories__list">' + categories.map(cat => {
      const count = filterByCategory(list, cat.key).length;
      const href = cat.key === 'all' ? base : `${base}?cat=${encodeURIComponent(cat.key)}`;
      return `<li><a class="shop-category${count ? '' : ' shop-category--empty'}" href="${esc(href)}" data-category="${esc(cat.key)}"${cat.key === active ? ' aria-current="true"' : ''}><span>${esc(cat.title)}</span><span class="shop-category__count" aria-label="${count ? `товаров: ${count}` : 'пока нет товаров'}">${count}</span></a></li>`;
    }).join('') + '</ul>';
  }
  /* Карточка каталога — та же карточка прайса (price-render.js), с тегами раздела для фильтра.
     Небезопасные адреса фото отбрасываются до рендера: остаётся заглушка. */
  function card(item, render) {
    const draw = typeof render === 'function' ? render : fallbackCard;
    return draw({ ...item, photo: safeImage(item.photo) }, { extraClass: 'card', tags: item.tags });
  }
  /* Служебные примечания импорта не показываются (то же правило, что в price-render.js). */
  const AUTO_PRICE_NOTE = /^\s*цена\s+(?:из|на\s+момент)\s+публикации(?=[\s,;.:]|$)[\s\S]*актуальн/i;
  const isAutoPriceNote = note => AUTO_PRICE_NOTE.test(String(note ?? ''));
  const DETAILS_MISSING = 'Описание этого товара ещё не добавлено. Состав и стоимость менеджер подтвердит при заказе.';
  const CART_ICON = '<svg class="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="22" height="22"><path d="M3 4h2.2l2.1 10.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 1.9-1.4L21 8H6.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="19.5" r="1.4" fill="currentColor"/><circle cx="17" cy="19.5" r="1.4" fill="currentColor"/></svg>';
  /* Запасная разметка на случай отсутствия price-render.js: та же структура и классы —
     кнопка цены (открывает состав) + значок корзины, без ссылок Telegram и второй кнопки заявки. */
  function fallbackCard(item, opts) {
    const image = safeImage(item.photo);
    const priceText = priceFormat ? priceFormat.format(item.price) : String(item.price ?? '').trim();
    const media = image
      ? `<div class="product-media"><img class="price-card__photo photo" src="${esc(image)}" alt="${esc(item.title)}" loading="lazy" decoding="async" width="800" height="1000"></div>`
      : '<div class="product-media product-media--empty" aria-hidden="true"><img src="/assets/img/logo-mark.svg" alt="" width="64" height="64" loading="lazy"></div>';
    const note = item.note && !isAutoPriceNote(item.note) ? `<p class="note">${esc(item.note)}</p>` : '';
    // Та же честная строка, что в price-render.js, когда описания и видимого примечания нет.
    const missing = item.desc || note ? '' : `<p class="note product-details__missing" data-details-missing>${DETAILS_MISSING}</p>`;
    const priceShown = priceText || 'Цена уточняется';
    return `<article class="pc price-card product-card${opts.extraClass ? ' ' + esc(opts.extraClass) : ''}" id="${esc(item.id)}" data-id="${esc(item.id)}"${opts.tags ? ` data-cat="${esc(opts.tags.join(' '))}"` : ''}>${media}<div class="price-card__body"><h3 class="pc__title">${esc(item.title)}</h3><div class="product-details" data-product-details hidden>${item.desc ? `<p class="price-card__description">${esc(item.desc)}</p>` : ''}${note}${missing}</div><div class="product-footer"><div class="product-purchase"><button class="pc__price price product-price" type="button" data-product-open data-price-known="${priceText ? 'true' : 'false'}" aria-label="${esc(priceShown + ' — состав и подробности: ' + item.title)}">${esc(priceShown)}</button><button class="button product-add" type="button" data-add data-add-icon data-id="${esc(item.id)}" data-title="${esc(item.title)}" aria-label="${esc('Добавить в корзину: ' + item.title)}">${CART_ICON}</button></div></div></div></article>`;
  }
  /* Обложка и дополнительные фото (gallery) в разметке товара: одно фото — строкой, как раньше; несколько — списком. */
  function imageField(item, origin) {
    const urls = [item.photo].concat(Array.isArray(item.gallery) ? item.gallery : []).map(safeImage).filter(Boolean)
      .map(url => new URL(url, origin).href).filter((url, index, all) => all.indexOf(url) === index).slice(0, 9);
    return urls.length > 1 ? { image: urls } : urls.length ? { image: urls[0] } : {};
  }
  function schema(list, origin, pathname) {
    return { '@context': 'https://schema.org', '@type': 'ItemList', name: 'Каталог Palitra',
      numberOfItems: list.length,
      itemListElement: list.map((item, index) => ({ '@type': 'ListItem', position: index + 1,
        item: { '@type': 'Product', name: item.title, url: `${origin}${pathname}#${encodeURIComponent(item.id)}`,
          ...imageField(item, origin),
          ...(item.desc ? { description: item.desc } : {}) }
      })) };
  }
  /* ---------- Фильтры каталога (12.10.2026): Повод × Цена × Кому, условия складываются через И ----------
     Цена — только полная фиксированная стоимость набора, тот же строгий разбор, что parsePrice в order.js:
     «от 5 000», «550 руб./шт», пустая цена в ценовой отбор не попадают (в «Все» остаются как раньше). */
  const SET_PRICE = /^\s*(\d[\d\s ]*)(?:[.,](\d{1,2}))?\s*(?:руб\.?|р\.?|₽)?\s*$/i;
  function setPrice(item) {
    const value = item && item.price;
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
    const match = SET_PRICE.exec(String(value ?? ''));
    if (!match) return null;
    const rubles = Number(match[1].replace(/[\s ]/g, ''));
    const kopecks = rubles * 100 + Number((match[2] || '0').padEnd(2, '0'));
    return Number.isSafeInteger(kopecks) && kopecks > 0 ? kopecks : null;
  }
  /* Сумма из адреса или поля: положительное число рублей, до двух знаков копеек (точка или запятая). */
  function parseRub(value) {
    const match = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*$/.exec(String(value ?? '').replace(/[\s ]/g, ''));
    if (!match) return null;
    const kopecks = Number(match[1]) * 100 + Number((match[2] || '0').padEnd(2, '0'));
    return kopecks > 0 ? kopecks : null;
  }
  const rubText = kopecks => `${Math.floor(kopecks / 100)}${kopecks % 100 ? '.' + String(kopecks % 100).padStart(2, '0') : ''}`;
  /* Кому: в прайсе нет меток получателя, поэтому только прозрачные правила — явное слово в названии, затем
     категория прайса. Цвет и фото не используются; «девушка» — взрослый получатель, не ребёнок. */
  const RECIPIENTS = [
    { key: 'all', title: 'Все' }, { key: 'boy', title: 'Мальчику' }, { key: 'girl', title: 'Девочке' },
    { key: 'man', title: 'Мужчине' }, { key: 'woman', title: 'Женщине' }
  ];
  // Без lookbehind: старый Safari не разбирает его и не выполнил бы весь файл. \b в JS не знает кириллицу.
  const WORD_BOY = /(?:^|[^а-яё])мальчик(?:а|у|ом|е)?(?![а-яё])/i;
  const WORD_GIRL = /(?:^|[^а-яё])девочк(?:а|и|е|у|ой)(?![а-яё])/i;
  function recipientsOf(item) {
    const title = String(item && item.title || '');
    const boy = WORD_BOY.test(title), girl = WORD_GIRL.test(title);
    if (boy || girl) return [...(boy ? ['boy'] : []), ...(girl ? ['girl'] : [])];
    const category = item && item.categoryId;
    if (category === 'vypiska' || category === 'dr-detyam') return ['boy', 'girl'];
    if (category === 'dr-muzhchine') return ['man'];
    if (category === 'dr-zhenschine' || category === 'devichnik') return ['woman'];
    return [];
  }
  /* Подборки «По стоимости»: подписи, ссылки и включительные границы 5 000 / 8 000 ₽
     согласованы с принятой главной. Цены товаров не меняются. */
  const BUDGET_RANGES = [
    { key: 'up-to-5000', title: 'До 5 000 ₽', min: null, max: 500000, href: '/catalog?max=5000' },
    { key: '5000-8000', title: 'От 5 000 до 8 000 ₽', min: 500000, max: 800000, href: '/catalog?min=5000&max=8000' },
    { key: 'over-8000', title: 'От 8 000 ₽', min: 800000, max: null, href: '/catalog?min=8000' }
  ];
  const FILTER_PARAMS = ['cat', 'min', 'max', 'to', 'budget', 'sort'];
  /* Порядок цен (Дарья 12.10.2026, 18:25): по полной фиксированной цене набора (setPrice). Сортируется копия, входной
     список не меняется; одинаковые цены сохраняют прежний порядок. Товары без полной цены («от», за штуку, пустая)
     не считаются нулевыми и идут после цен в исходном порядке при обоих направлениях. */
  const SORTS = [{ key: 'price-asc', title: 'По возрастанию' }, { key: 'price-desc', title: 'По убыванию' }];
  const sortKey = (value) => (SORTS.some(sort => sort.key === value) ? value : '');
  function sortCatalog(list, sort) {
    const key = sortKey(sort);
    const items = Array.isArray(list) ? list.slice() : [];
    if (!key) return items;
    const direction = key === 'price-desc' ? -1 : 1;
    const priced = [], rest = [];
    items.forEach((item, index) => { const price = setPrice(item); (price === null ? rest : priced).push({ item, index, price }); });
    priced.sort((a, b) => (a.price - b.price) * direction || a.index - b.index);
    return [...priced.map(entry => entry.item), ...rest.map(entry => entry.item)];
  }
  /* Отбор: { cat, to, min, max } (min/max — копейки включительно, null — без границы). */
  function filterCatalog(list, filters = {}) {
    const { cat = 'all', to = 'all', min = null, max = null } = filters;
    const priced = min !== null || max !== null;
    return filterByCategory(list, cat).filter(item => {
      if (to && to !== 'all' && !recipientsOf(item).includes(to)) return false;
      if (!priced) return true;
      const price = setPrice(item);
      return price !== null && (min === null || price >= min) && (max === null || price <= max);
    });
  }
  /* Состояние из адреса. Неверная сумма не применяется; «от» больше «до» — цена не применяется, с ошибкой. */
  function readFilters(params, categoryKeys) {
    const cat = params.get('cat');
    const to = params.get('to');
    const rawMin = params.get('min'), rawMax = params.get('max');
    let min = rawMin === null || rawMin === '' ? null : parseRub(rawMin);
    let max = rawMax === null || rawMax === '' ? null : parseRub(rawMax);
    let error = '';
    if ((rawMin && min === null) || (rawMax && max === null)) error = 'Сумма в адресе не распознана — цена не применена.';
    if (min !== null && max !== null && min > max) { error = 'Сумма «от» больше суммы «до» — цена не применена.'; min = max = null; }
    // sort — дополнительное поле: неизвестное значение игнорируется (исходный порядок), прежние поля не меняются.
    return { cat: categoryKeys.has(cat) ? cat : 'all', to: RECIPIENTS.some(r => r.key === to) ? to : 'all', min, max, error, sort: sortKey(params.get('sort')) };
  }
  /* Адрес с нашими параметрами; прочие параметры и якорь сохраняются. */
  function filterQuery(href, filters) {
    const url = new URL(href);
    FILTER_PARAMS.forEach(key => url.searchParams.delete(key));
    if (filters.cat && filters.cat !== 'all') url.searchParams.set('cat', filters.cat);
    if (filters.min !== null && filters.min !== undefined) url.searchParams.set('min', rubText(filters.min));
    if (filters.max !== null && filters.max !== undefined) url.searchParams.set('max', rubText(filters.max));
    if (filters.to && filters.to !== 'all') url.searchParams.set('to', filters.to);
    if (sortKey(filters.sort)) url.searchParams.set('sort', filters.sort);
    return url.pathname + url.search + url.hash;
  }
  const plural = (n, forms) => { const a = n % 100, b = n % 10; return forms[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b > 1 && b < 5 ? 1 : 2]; };
  const rubLabel = value => (value / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  /* Быстрый вариант цены, точно совпадающий с отбором (по кнопке, по адресу или введённый вручную), или null. */
  const budgetOf = (min, max) => BUDGET_RANGES.find(range => range.min === min && range.max === max) || null;
  const rangeSummary = (min, max) => (min === null && max === null ? 'Любая'
    : budgetOf(min, max) ? budgetOf(min, max).title
    : min !== null && max !== null ? `${rubLabel(min)}–${rubLabel(max)} ₽` : min !== null ? `от ${rubLabel(min)} ₽` : `до ${rubLabel(max)} ₽`);
  // Заголовок «Цены»: диапазон и, если выбран, порядок («Любая · по возрастанию»); длинный текст обрезается многоточием.
  const priceSummary = (min, max, sort) => {
    const order = SORTS.find(item => item.key === sortKey(sort));
    return order ? `${rangeSummary(min, max)} · ${order.title.toLowerCase()}` : rangeSummary(min, max);
  };
  // Одна и та же стрелка у «Повод», «Цена» и «Кому»: встроенный SVG 18×18 (не data:-картинка — не зависит от CSP img-src).
  const CHEVRON = '<svg class="catalog-chevron" aria-hidden="true" focusable="false" viewBox="0 0 18 18" width="18" height="18"><path d="M4.5 6.75 9 11.25l4.5-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const nbspNumbers = text => text.replace(/(\d) (\d)/g, '$1 $2').replace(/ ₽/g, ' ₽');
  /* Разметка фильтров строится один раз; дальше меняются только значения, счётчик и ошибка — фокус и
     введённые суммы не теряются. «Повод», «Цена» и «Кому» — одинаковые панели details/summary (12.10.2026: родной
     список select браузер рисует по-своему). Выбор в «Повод»/«Кому» — кнопки с aria-pressed (Tab + Enter/Пробел). */
  const categoryTitle = cat => (cat.key === 'all' ? 'Все' : cat.title);
  function dropdownHtml(name, label, summaryHtml, panelHtml, extraClass = '') {
    return `<div class="catalog-filter"><span class="catalog-filter__label" id="catalog-filter-${name}-label">${label}</span>`
      + `<details class="catalog-dropdown${extraClass ? ` ${extraClass}` : ''}" data-filter-dropdown="${name}"><summary class="catalog-filter__control catalog-dropdown__summary${extraClass ? ` ${extraClass}__summary` : ''}" aria-labelledby="catalog-filter-${name}-label catalog-filter-${name}-value">`
      + `<span class="catalog-dropdown__value${extraClass ? ` ${extraClass}__value` : ''}" id="catalog-filter-${name}-value" data-dropdown-value>${summaryHtml}</span>${CHEVRON}</summary>`
      + `<div class="catalog-dropdown__panel${extraClass ? ` ${extraClass}__panel` : ''}">${panelHtml}</div></details></div>`;
  }
  function optionsHtml(name, label, options) {
    return `<div class="catalog-dropdown__options" role="group" aria-label="${esc(label)}">`
      + options.map(option => `<button type="button" class="catalog-dropdown__option" data-${name}-option="${esc(option.key)}" aria-pressed="false">`
        + `<span class="catalog-dropdown__text">${esc(option.title)}</span>${option.count === undefined ? '' : `<span class="catalog-dropdown__count">${option.count}</span>`}</button>`).join('')
      + '</div>';
  }
  function filtersHtml(categories, list) {
    const cats = categories.map(cat => ({ key: cat.key, title: categoryTitle(cat), count: filterByCategory(list, cat.key).length }));
    const first = cats[0] || { title: 'Все', count: list.length };
    return '<div class="catalog-filters" role="group" aria-label="Фильтры каталога">'
      + dropdownHtml('cat', 'Повод', `${esc(first.title)} (${first.count})`, optionsHtml('cat', 'Повод', cats))
      + dropdownHtml('price', 'Цена', 'Любая', '<div class="catalog-price__order" role="group" aria-labelledby="catalog-price-order-label">'
      + '<p class="catalog-price__order-label" id="catalog-price-order-label">Порядок цен</p>'
      + SORTS.map(sort => `<button type="button" class="catalog-dropdown__option catalog-price__sort" data-price-sort="${esc(sort.key)}" aria-pressed="false"><span class="catalog-dropdown__text">${esc(sort.title)}</span></button>`).join('')
      + '</div><div class="catalog-price__fields">'
      + '<label class="catalog-price__field">От, ₽<input type="text" inputmode="decimal" autocomplete="off" maxlength="12" data-price-min></label>'
      + '<label class="catalog-price__field">До, ₽<input type="text" inputmode="decimal" autocomplete="off" maxlength="12" data-price-max></label></div>'
      + '<p class="catalog-price__error" data-price-error role="alert" hidden></p>'
      + '<button type="button" class="catalog-price__apply" data-price-apply>Применить</button>', 'catalog-price')
      + dropdownHtml('to', 'Кому', esc(RECIPIENTS[0].title), optionsHtml('to', 'Кому', RECIPIENTS))
      + '<button type="button" class="catalog-filters__reset" data-filter-reset>Сбросить фильтры</button></div>'
      + '<p class="catalog-filters__count" data-filter-count aria-live="polite"></p>';
  }
  function removeProductLists(node) {
    if (Array.isArray(node)) return node.map(removeProductLists).filter(Boolean);
    if (!node || typeof node !== 'object') return node;
    if (['Product', 'ItemList'].includes(node['@type'])) return null;
    const copy = { ...node };
    if (copy['@graph']) copy['@graph'] = removeProductLists(copy['@graph']);
    return copy;
  }
  /* Описание/состав — только DOM-текст, без изменения item и штатного renderer. */
  function appendComposition(container, items, doc) {
    const byId = new Map(items.map(item => [String(item.id), item]));
    const textOf = value => typeof value === 'string' ? value.trim() : '';
    for (const card of container.querySelectorAll('.product-card[data-id]')) {
      const item = byId.get(card.getAttribute('data-id'));
      const details = card.querySelector('[data-product-details]');
      if (!item || !details) continue;
      const description = Object.prototype.hasOwnProperty.call(item, 'description') ? textOf(item.description) : textOf(item.desc);
      const fields = [['description', 'Описание', description], ['composition', 'Состав', textOf(item.composition)]];
      for (const old of details.querySelectorAll('.price-card__description')) old.remove();
      let missing = details.querySelector('[data-details-missing]');
      let added = false;
      for (const [key, label, text] of fields) {
        if (!text) continue;
        const paragraph = doc.createElement('p'); paragraph.className = 'price-card__description';
        paragraph.setAttribute('data-product-' + key, '');
        paragraph.textContent = label + ': ' + text;
        details.append(paragraph); added = true;
      }
      if (added && missing) missing.remove();
      else if (!added && !missing && !details.querySelector('.note')) {
        missing = doc.createElement('p'); missing.className = 'note product-details__missing';
        missing.setAttribute('data-details-missing', ''); missing.textContent = DETAILS_MISSING;
        details.append(missing);
      }
    }
  }
  async function mount(win) {
    const doc = win.document;
    const container = doc.querySelector('[data-products]');
    if (!container || !win.PalitraPrice) return;
    const live = container.hasAttribute('data-live-catalog');
    if (doc.body.dataset.page !== 'catalog' && !live) return;
    const config = win.PALITRA_CONFIG || {};
    let categories = publicCategories(config);
    const data = await win.PalitraPrice.load(['/api/price', '/data/price.json']);
    const request = live && doc.body.dataset.page === 'home' ? '#zayavka' : '/#zayavka';
    if (!data) {
      container.innerHTML = `<p class="catalog-empty">Не удалось загрузить каталог. Обновите страницу или <a href="${request}">оставьте заявку на подбор</a>.</p>`;
      return;
    }
    const visibleData = win.PalitraPrice.publicData ? win.PalitraPrice.publicData(data) : data;
    const occasions = win.PalitraOccasions || null;
    if (occasions) categories = occasions.publicCategories(categories, visibleData, { timeZone: config.COMPANY_TIMEZONE, now: Date.now() });
    const path = win.location.pathname;
    const sectionPage = /^\/catalog\/[^/]+/.test(path);
    // Источник — категории прайса (страницы dofaminovye, shary-giganty), иначе прежний раздел адреса.
    const sources = (container.dataset.source || '').split(',').map(x => x.trim()).filter(Boolean);
    const all = entries(visibleData, '/catalog', categories, occasions);
    const pageList = sources.length ? all.filter(item => sources.includes(item.categoryId)) : entries(visibleData, path, categories, occasions);
    const render = win.PalitraPrice.productCard;
    const nav = doc.querySelector('[data-category-nav]');
    const filtering = Boolean(nav) && !sectionPage && !sources.length;
    const keys = new Set(categories.map(cat => cat.key));
    const legacy = (path.replace(/\/(?:index\.html)?$/, '').split('/')[2]) || '';
    // Верхний /catalog — фильтры Повод/Цена/Кому из адреса; прежние разделы /catalog/<раздел> — как раньше.
    const state = filtering ? readFilters(new URL(win.location.href).searchParams, keys)
      : { cat: (config.LEGACY_SECTION_CATEGORY || {})[legacy] || '', to: 'all', min: null, max: null, error: '', sort: '' };
    const limit = Number(container.dataset.limit) || 0;
    const more = doc.querySelector('[data-catalog-more]');
    let list = pageList;
    doc.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try { script.textContent = JSON.stringify(removeProductLists(JSON.parse(script.textContent))); } catch (_) {}
    });
    const structured = doc.createElement('script');
    structured.type = 'application/ld+json';
    structured.id = 'palitra-catalog-schema';
    doc.head.append(structured);
    let controls = null;
    if (nav && filtering) {
      nav.classList.add('shop-categories--filters');
      nav.innerHTML = filtersHtml(categories, all);
      const q = (selector) => nav.querySelector(selector);
      const panel = (name) => q(`[data-filter-dropdown="${name}"]`);
      controls = { cat: panel('cat'), to: panel('to'), price: panel('price'),
        catOptions: [...nav.querySelectorAll('[data-cat-option]')], toOptions: [...nav.querySelectorAll('[data-to-option]')],
        min: q('[data-price-min]'), max: q('[data-price-max]'), error: q('[data-price-error]'), apply: q('[data-price-apply]'),
        reset: q('[data-filter-reset]'), count: q('[data-filter-count]'), sorts: [...nav.querySelectorAll('[data-price-sort]')] };
      controls.dropdowns = [controls.cat, controls.price, controls.to];
    }
    const catCounts = new Map(categories.map(cat => [cat.key, filterByCategory(all, cat.key).length]));
    const valueOf = (dropdown) => dropdown.querySelector('[data-dropdown-value]');
    const summaryOf = (dropdown) => dropdown.querySelector('summary');
    const anyFilter = () => state.cat !== 'all' || state.to !== 'all' || state.min !== null || state.max !== null;
    const showError = (text) => { if (!controls) return; controls.error.textContent = text; controls.error.hidden = !text; };
    // Значения контролов — из состояния; поля цены переписываются только при загрузке, применении и сбросе.
    const syncControls = (fields) => {
      if (!controls) return;
      const cat = categories.find(item => item.key === state.cat) || categories[0];
      valueOf(controls.cat).textContent = cat ? `${categoryTitle(cat)} (${catCounts.get(cat.key) ?? 0})` : 'Все';
      valueOf(controls.to).textContent = (RECIPIENTS.find(item => item.key === state.to) || RECIPIENTS[0]).title;
      valueOf(controls.price).textContent = priceSummary(state.min, state.max, state.sort);
      for (const button of controls.catOptions) button.setAttribute('aria-pressed', String(button.dataset.catOption === state.cat));
      for (const button of controls.toOptions) button.setAttribute('aria-pressed', String(button.dataset.toOption === state.to));
      for (const button of controls.sorts) button.setAttribute('aria-pressed', String(button.dataset.priceSort === state.sort));
      if (fields) { controls.min.value = state.min === null ? '' : rubText(state.min); controls.max.value = state.max === null ? '' : rubText(state.max); }
    };
    const draw = () => {
      // Порядок — уже отфильтрованного списка, до ограничения, карточек и JSON-LD.
      list = filtering ? sortCatalog(filterCatalog(pageList, state), state.sort) : pageList;
      const plain = filtering && !anyFilter();
      const shown = plain && limit ? list.slice(0, limit) : list;
      const title = (categories.find(cat => cat.key === state.cat) || {}).title || '';
      const reason = !filtering ? 'В этом разделе пока нет товаров.'
        : state.to !== 'all' || state.min !== null || state.max !== null ? 'По выбранным фильтрам товаров пока нет — измените условия или сбросьте фильтры.'
        : state.cat !== 'all' ? `В разделе «${esc(title)}» пока нет товаров на сайте.` : 'В этом разделе пока нет товаров.';
      container.innerHTML = shown.length ? shown.map(item => card(item, render)).join('')
        : `<p class="catalog-empty" data-category-empty>${reason} Трудно выбрать? <a href="${request}">Подберите за меня набор</a> — менеджер свяжется и объяснит варианты.</p>`;
      appendComposition(container, shown, doc);
      if (more) more.hidden = !(plain && limit && list.length > limit);
      if (nav && !filtering) nav.innerHTML = categoryNav(categories, all, state.cat, nav.dataset.base || '/catalog');
      if (controls) controls.count.textContent = `Найдено: ${list.length} ${plural(list.length, ['товар', 'товара', 'товаров'])}`;
      structured.textContent = JSON.stringify(schema(shown, win.location.origin, path));
    };
    const remember = () => { try { win.history.replaceState(null, '', filterQuery(win.location.href, state)); } catch (_) {} };
    if (controls) {
      syncControls(true);
      if (state.error) { showError(state.error); controls.price.open = true; }
      /* Три панели — одно поведение: открыта только одна; Escape закрывает и возвращает фокус на её заголовок;
         клик вне фильтров закрывает. Tab не перехватывается. Обработчики ставятся один раз за mount. */
      const closePanel = (dropdown, focus) => { if (!dropdown.open) return; dropdown.open = false; if (focus) summaryOf(dropdown).focus(); };
      for (const dropdown of controls.dropdowns) dropdown.addEventListener('toggle', () => {
        if (dropdown.open) for (const other of controls.dropdowns) if (other !== dropdown) closePanel(other, false);
      });
      nav.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        const open = controls.dropdowns.find(dropdown => dropdown.open);
        if (!open) return;
        event.preventDefault();
        closePanel(open, true);
      });
      // Клик вне конкретной панели (в том числе «Сбросить», счётчик, пустое место фильтров) закрывает её без переноса фокуса.
      doc.addEventListener('click', event => {
        for (const dropdown of controls.dropdowns) if (!dropdown.contains(event.target)) closePanel(dropdown, false);
      });
      // Уход фокуса из панели к элементу вне её (Tab, Shift+Tab, фокус в другой фильтр) закрывает её без переноса фокуса.
      // relatedTarget=null (клик по нефокусируемому месту, Safari не фокусирует кнопки при клике, уход из окна)
      // панель не закрывает: такие клики обрабатывает обработчик выше. Переходы внутри панели не закрывают.
      for (const dropdown of controls.dropdowns) dropdown.addEventListener('focusout', event => {
        const next = event.relatedTarget;
        if (next && typeof next.nodeType === 'number' && !dropdown.contains(next)) closePanel(dropdown, false);
      });
      // Выбор «Повод»/«Кому»: сразу отбор и адрес (И с другими фильтрами), затем панель закрывается, фокус — на заголовок.
      const choose = (dropdown, apply) => { apply(); syncControls(false); draw(); remember(); closePanel(dropdown, true); };
      for (const button of controls.catOptions) button.addEventListener('click', () => choose(controls.cat, () => {
        state.cat = keys.has(button.dataset.catOption) ? button.dataset.catOption : 'all';
      }));
      for (const button of controls.toOptions) button.addEventListener('click', () => choose(controls.to, () => {
        state.to = RECIPIENTS.some(r => r.key === button.dataset.toOption) ? button.dataset.toOption : 'all';
      }));
      const apply = () => {
        const rawMin = controls.min.value.trim(), rawMax = controls.max.value.trim();
        const min = rawMin ? parseRub(rawMin) : null, max = rawMax ? parseRub(rawMax) : null;
        if ((rawMin && min === null) || (rawMax && max === null)) { showError('Введите сумму числом в рублях, например 5000 или 5000,50.'); return; }
        if (min !== null && max !== null && min > max) { showError('Сумма «от» больше суммы «до» — исправьте одно из полей.'); return; }
        showError('');
        state.min = min; state.max = max;
        syncControls(true); draw(); remember();
        controls.price.open = false;
        controls.price.querySelector('summary').focus(); // фокус не остаётся в закрытой панели
      };
      controls.apply.addEventListener('click', apply);
      // Порядок цен: повторное нажатие выбранного возвращает исходный порядок. Диапазон, Повод, Кому и ещё не
      // применённые поля «От/До» не меняются; панель остаётся открытой, фокус — на кнопке.
      for (const button of controls.sorts) button.addEventListener('click', () => {
        const key = sortKey(button.dataset.priceSort);
        state.sort = state.sort === key ? '' : key;
        syncControls(false); draw(); remember();
      });
      for (const input of [controls.min, controls.max]) input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); apply(); } });
      controls.reset.addEventListener('click', () => {
        Object.assign(state, { cat: 'all', to: 'all', min: null, max: null, error: '', sort: '' });
        showError(''); syncControls(true); draw(); remember();
      });
    }
    draw();
  }
  return { entries, card, fallbackCard, appendComposition, isAutoPriceNote, schema, removeProductLists, mount, DETAILS_MISSING, DEFAULT_CATEGORIES, publicCategories, filterByCategory, categoryNav,
    setPrice, parseRub, recipientsOf, filterCatalog, readFilters, filterQuery, RECIPIENTS, BUDGET_RANGES, FILTER_PARAMS, budgetOf, SORTS, sortCatalog, priceSummary, filtersHtml };
}));

