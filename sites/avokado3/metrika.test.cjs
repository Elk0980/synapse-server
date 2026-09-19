'use strict';
// Счётчик Яндекс Метрики на сайте Авокадо. Проверяем то, на чём легко ошибиться:
// идемпотентность, совместимость с уже работающей атрибуцией, отсутствие чужого
// счётчика, а также поведение при сбоях — состояние после неудачной вставки
// загрузчика и устойчивость к чужому сломанному ym.
// Тест намеренно без jsdom — нужен минимальный поддельный документ, а не браузер.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, 'attribution.js');
const attribution = require('./attribution.js');

function fakeDocument() {
  const inserted = [];
  const firstScript = {parentNode: {insertBefore: node => inserted.push(node)}};
  return {
    inserted,
    head: {appendChild: node => inserted.push(node)},
    createElement: () => ({}),
    getElementsByTagName: name => (name === 'script' ? [firstScript] : [])
  };
}

function fakeWindow(extra) {
  return Object.assign({navigator: {}}, extra);
}

test('счётчик подключается один раз: один загрузчик и одна инициализация', () => {
  const win = fakeWindow();
  const doc = fakeDocument();

  assert.strictEqual(attribution.startCounter(win, doc), true, 'первый вызов должен подключить счётчик');
  assert.strictEqual(attribution.startCounter(win, doc), false, 'повторный вызов не должен ничего делать');
  assert.strictEqual(attribution.startCounter(win, doc), false, 'и третий тоже');

  assert.strictEqual(doc.inserted.length, 1, 'загрузчик вставлен ровно один раз');
  assert.strictEqual(doc.inserted[0].src, attribution.counterLoader);
  assert.strictEqual(win.__metrikaReady, true);

  const inits = (win.ym.a || []).filter(call => call[1] === 'init');
  assert.strictEqual(inits.length, 1, 'init вызван ровно один раз');
  assert.strictEqual(inits[0][0], attribution.counterId);
  assert.strictEqual(inits[0][2].webvisor, false, 'вебвизор должен быть выключен');
});

test('уже подключённый счётчик страницы не переинициализируется', () => {
  const win = fakeWindow({__metrikaReady: true});
  const doc = fakeDocument();
  assert.strictEqual(attribution.startCounter(win, doc), false);
  assert.strictEqual(doc.inserted.length, 0, 'чужой уже загруженный счётчик не трогаем');
});

test('отказ от отслеживания в браузере уважается', () => {
  const win = fakeWindow({navigator: {doNotTrack: '1'}});
  const doc = fakeDocument();
  assert.strictEqual(attribution.startCounter(win, doc), false);
  assert.strictEqual(doc.inserted.length, 0, 'при doNotTrack счётчик не подключается');
  assert.notStrictEqual(win.__metrikaReady, true, 'флаг не выставляется — отказ не кэшируется как «уже подключено»');
});

test('счётчик только свой: номер, домен загрузчика и отсутствие чужих идентификаторов', () => {
  assert.strictEqual(attribution.counterId, 112772817, 'номер счётчика Авокадо');
  assert.strictEqual(attribution.counterLoader, 'https://mc.yandex.ru/metrika/tag.js?id=112772817');

  const source = fs.readFileSync(SOURCE, 'utf8');

  // Номер счётчика задаётся в файле ровно один раз и только как counterId.
  const declarations = source.match(/const counterId\s*=\s*(\d+)/g) || [];
  assert.strictEqual(declarations.length, 1, 'номер счётчика объявляется один раз');
  assert.ok(declarations[0].includes(String(attribution.counterId)));

  // Инициализация счётчика — только по этой константе, без числа в вызове
  // (числовой литерал в ym(...) означал бы второй, чужой счётчик, как у ALVI 112777602).
  const inits = source.match(/ym\(([^,]+),\s*'init'/g) || [];
  assert.deepStrictEqual(inits, ["ym(counterId, 'init'"], 'init вызывается один раз и только по counterId');
  assert.ok(!source.includes('112777602'), 'в файле Авокадо не должно быть счётчика ALVI');

  // Загрузчик только официальный, и только один.
  const loaders = source.match(/https:\/\/[^'"]*yandex[^'"]*/g) || [];
  assert.deepStrictEqual(loaders, ['https://mc.yandex.ru/metrika/tag.js?id='], 'единственный загрузчик — официальный mc.yandex.ru');

  // Никаких сторонних аналитик в этом файле.
  for (const foreign of ['googletagmanager', 'google-analytics', 'gtag(', 'fbq(', 'vk.com/rtrg', 'top-fwz1']) {
    assert.ok(!source.includes(foreign), `в файле не должно быть стороннего счётчика: ${foreign}`);
  }
});

test('счётчик не ломает существующую атрибуцию', () => {
  // Публичный API атрибуции остался прежним.
  for (const name of ['storageKey', 'lifetime', 'readAttribution', 'decorateUrl', 'classify', 'start']) {
    assert.ok(name in attribution, `потерян экспорт ${name}`);
  }

  const base = 'https://avokado38.ru/index.html';
  const tags = {utm_source: 'vk', utm_medium: 'cpc'};

  // Разметка ссылки на онлайн-запись работает как раньше.
  const booking = attribution.decorateUrl('https://n396010.yclients.com/company/375899', base, tags, 'sticky_cta');
  assert.ok(booking.includes('utm_source=vk'), 'метки кампании остаются на ссылке записи');
  assert.ok(booking.includes('entry_point=sticky_cta'), 'точка входа остаётся на ссылке записи');

  // Классификация событий не изменилась.
  assert.deepStrictEqual(attribution.classify('tel:+79001234567', base), {event: 'phone_click', channel: 'phone'});
  assert.deepStrictEqual(attribution.classify('https://avokado38.ru/price.html', base), {event: 'price_click'});
  assert.strictEqual(attribution.classify('https://example.com/', base), null);

  // Чтение меток из адреса не зависит от счётчика.
  const storage = new Map();
  const read = attribution.readAttribution(
    new URL('https://avokado38.ru/?utm_source=vk&utm_medium=cpc'),
    '',
    {getItem: key => (storage.has(key) ? storage.get(key) : null), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k)},
    Date.parse('2026-09-19T00:00:00Z')
  );
  assert.strictEqual(read.utm_source, 'vk');
  assert.strictEqual(read.utm_medium, 'cpc');
});

// --- followup 19.09: состояние при сбое и устойчивость к чужому ym ---

test('сбой вставки загрузчика не запирает счётчик навсегда', () => {
  const win = fakeWindow();
  const brokenDoc = {createElement: () => { throw new Error('createElement недоступен'); }};

  assert.strictEqual(attribution.startCounter(win, brokenDoc), false, 'при сбое возвращается false');
  assert.notStrictEqual(win.__metrikaReady, true, 'состояние «подключено» не выставляется до реальной вставки');

  // Тот же window, но уже рабочий документ — счётчик обязан подняться.
  const doc = fakeDocument();
  assert.strictEqual(attribution.startCounter(win, doc), true, 'повтор с рабочим документом подключает счётчик');
  assert.strictEqual(doc.inserted.length, 1, 'загрузчик вставлен ровно один раз');
  assert.strictEqual(win.__metrikaReady, true);

  const inits = (win.ym.a || []).filter(call => call[1] === 'init');
  assert.strictEqual(inits.length, 1, 'init тоже ровно один');
});

test('исключение в существующем ym не роняет подключение и не вставляет второй загрузчик', () => {
  const win = fakeWindow();
  win.ym = function () { throw new Error('чужой ym сломан'); };
  const doc = fakeDocument();

  let result;
  assert.doesNotThrow(() => { result = attribution.startCounter(win, doc); }, 'исключение не должно выходить наружу');
  assert.strictEqual(result, false, 'init не прошёл — успехом это не считается');
  assert.strictEqual(doc.inserted.length, 1, 'загрузчик уже на странице');
  assert.strictEqual(win.__metrikaReady, true, 'повторно вставлять загрузчик нельзя');
  assert.strictEqual(attribution.startCounter(win, doc), false, 'повтор ничего не делает');
  assert.strictEqual(doc.inserted.length, 1, 'второго загрузчика не появилось');
});

test('аналитика не обрывает атрибуцию: start размечает ссылки при сломанном счётчике', () => {
  const links = [];
  function anchor(href) {
    const attrs = {href};
    const node = {
      getAttribute: name => (name in attrs ? attrs[name] : null),
      setAttribute: (name, value) => { attrs[name] = value; },
      matches: () => true
    };
    links.push(node);
    return node;
  }
  const booking = anchor('https://n396010.yclients.com/company/375899');

  const doc = {
    referrer: '',
    createElement: () => { throw new Error('счётчик недоступен'); },
    body: {},
    querySelectorAll: () => links,
    matches: () => false,
    addEventListener: () => {}
  };
  const win = {
    navigator: {},
    location: new URL('https://avokado38.ru/index.html?utm_source=vk'),
    document: doc,
    localStorage: undefined
  };
  win.location.href = 'https://avokado38.ru/index.html?utm_source=vk';

  assert.doesNotThrow(() => attribution.start(win, doc), 'сбой счётчика не должен ронять start');
  assert.ok(booking.getAttribute('href').includes('utm_source=vk'), 'ссылка записи всё равно размечена');
});
