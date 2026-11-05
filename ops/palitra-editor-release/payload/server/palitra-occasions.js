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
