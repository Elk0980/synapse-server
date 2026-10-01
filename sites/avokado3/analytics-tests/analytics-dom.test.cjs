/* DOM-тесты аналитики Авокадо на jsdom по реальной разметке index.html / price.html
   из avokado-output и реальным скриптам attribution.js, callback.js, contact-route.js.
   Без сети: внешние ресурсы не загружаются, Яндекс Метрика заменена записью вызовов ym.

   Запуск (jsdom ставится вне папки вывода):
     NODE_PATH=<каталог>/node_modules node --test avokado-output/checks/analytics-dom.test.cjs

   Что эмулируется и почему — ограничения jsdom, а не упрощения проверки:
   - layout: jsdom не считает геометрию, поэтому видимость сцены задаётся
     getBoundingClientRect для конкретного элемента;
   - HTMLDialogElement.showModal и навигация iframe через location.replace в jsdom
     не реализованы, поэтому price-overlay.js не запускается; тест воспроизводит
     конечное состояние, которое он оставляет после открытия: dialog.av-price-dialog[open]
     с iframe и класс html.av-price-open, а iframe грузит настоящий price.html?embedded=1;
   - window.postMessage в jsdom не заполняет event.origin и event.source (TODO в
     исходниках jsdom), поэтому вызов из iframe доставляется родителю как в браузере:
     проверка targetOrigin, origin = origin кадра, source = окно кадра;
   - отрисовка каталога (catalog.js тянет /api/price) заменена вставкой секции
     .av-direction и событием avokado:catalog-ready, которое шлёт настоящий catalog.js. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {JSDOM, ResourceLoader, VirtualConsole} = require('jsdom');

// Изменённые файлы берутся из avokado-output, неизменённые (contact-route.js) —
// из соседней папки source с тем же main 327f241. Подмешивания чужих версий нет.
const SITE = path.join(__dirname, '..');
const SOURCE = SITE;
const ORIGIN = 'https://avokado38.ru';
const fileOf = name => fs.existsSync(path.join(SITE, name)) ? path.join(SITE, name) : path.join(SOURCE, name);
const read = name => fs.readFileSync(fileOf(name), 'utf8');
const attribution = require(path.join(SITE, 'attribution.js'));
const DWELL = attribution.stageDwell + 200;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Отдаёт только HTML-страницы сайта (нужно для iframe). Скрипты исполняются вручную
// в порядке страницы, всё остальное (CSS, видео, Метрика, CRM) не загружается.
class SiteLoader extends ResourceLoader {
  fetch(url) {
    const parsed = new URL(url);
    if (parsed.origin === ORIGIN && /^\/[a-z-]+\.html$/.test(parsed.pathname)) {
      return Promise.resolve(Buffer.from(read(parsed.pathname.slice(1))));
    }
    return null;
  }
}

function prepare(win, errors) {
  win.__ymCalls = [];
  win.ym = function () { win.__ymCalls.push(Array.from(arguments)); };
  win.HTMLElement.prototype.scrollIntoView = function () {};
  // Переходы по внешним ссылкам в тесте не нужны: jsdom их не умеет и только шумит.
  win.addEventListener('click', event => {
    const anchor = event.target.closest && event.target.closest('a[href]');
    if (anchor && !anchor.getAttribute('href').startsWith('#')) event.preventDefault();
  });
  win.addEventListener('error', event => errors.push(String(event.message)));
}

function run(win, names) {
  names.forEach(name => win.eval(read(name) + '\n//# sourceURL=' + name));
}

function open(file, options) {
  const settings = options || {};
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(String(error.message)));
  const dom = new JSDOM(read(file), {
    url: settings.url || ORIGIN + '/' + file,
    runScripts: 'outside-only',
    resources: new SiteLoader(),
    pretendToBeVisual: true,
    virtualConsole
  });
  const win = dom.window;
  prepare(win, errors);
  if (settings.before) settings.before(win);
  run(win, settings.scripts || ['contact-route.js', 'callback.js', 'attribution.js']);
  return {dom, win, doc: win.document, errors};
}

const goals = win => win.__ymCalls.filter(call => call[1] === 'reachGoal').map(call => call[2]);
const count = (list, name) => list.filter(item => item === name).length;

function show(element, top) {
  const y = top === undefined ? 0 : top;
  element.getBoundingClientRect = () => ({top: y, bottom: y + 500, left: 0, right: 1000, width: 1000, height: 500, x: 0, y});
}
function hide(element) {
  element.getBoundingClientRect = () => ({top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0});
}
function scroll(win, times) {
  for (let i = 0; i < (times || 1); i += 1) win.dispatchEvent(new win.Event('scroll'));
}
function renderCatalog(doc, link) {
  const content = doc.getElementById('av-catalog-content');
  content.innerHTML = '<section class="av-direction" id="subscriptions"><h2>Абонементы</h2>' +
    (link ? '<a class="av-button" href="' + link + '">Записаться</a>' : '') + '</section>';
  doc.dispatchEvent(new doc.defaultView.Event('avokado:catalog-ready'));
  return content;
}

/* ---------- Заявка: только подтверждённый 201 ---------- */

function fillForm(page, values) {
  const form = page.doc.querySelector('[data-callback-form]');
  const field = name => form.elements.namedItem(name);
  field('name').value = values.name;
  field('contact').value = values.contact;
  field('consent').checked = true;
  if (values.typing) ['name', 'contact'].forEach(name =>
    field(name).dispatchEvent(new page.win.Event('input', {bubbles: true})));
  return form;
}
async function submitWith(response, options) {
  const page = open('index.html', {before: win => {
    win.fetch = async () => {
      if (response instanceof Error) throw response;
      return {status: response.status, ok: response.status >= 200 && response.status < 300, json: async () => response.body};
    };
  }});
  const form = fillForm(page, Object.assign({name: 'Тестовая Анна', contact: '+7 950 000 00 00'}, options));
  form.requestSubmit();
  await sleep(60);
  const status = form.querySelector('[data-callback-status]');
  return {page, form, status, list: goals(page.win)};
}

test('201 + целый id>0 без признака дубля — ровно один callback_submit', async () => {
  const {page, status, list} = await submitWith({status: 201, body: {id: 101}}, {typing: true});
  assert.deepEqual(list, ['callback_start', 'callback_attempt', 'callback_submit']);
  assert.equal(status.dataset.state, 'success');
  const sent = JSON.stringify(page.win.__ymCalls) + JSON.stringify(page.win.dataLayer);
  assert.ok(!sent.includes('Анна') && !sent.includes('9500000000') && !sent.includes('950 000'),
    'имя и телефон не должны попадать ни в ym, ни в dataLayer');
  assert.ok(page.win.__ymCalls.filter(c => c[1] === 'reachGoal').every(c => c.length === 3),
    'reachGoal только с идентификатором цели, без параметров');
});

test('200 + deduplicated — callback_duplicate, лида нет', async () => {
  const {status, list} = await submitWith({status: 200, body: {id: 101, deduplicated: true}});
  assert.deepEqual(list, ['callback_attempt', 'callback_duplicate']);
  assert.equal(status.dataset.state, 'existing');
});

for (const [name, response] of [
  ['500', {status: 500, body: {}}],
  ['429', {status: 429, body: {}}],
  ['400', {status: 400, body: {}}],
  ['201 + deduplicated', {status: 201, body: {id: 7, deduplicated: true}}],
  ['201 + id = 0', {status: 201, body: {id: 0}}],
  ['201 + id = "7" строкой', {status: 201, body: {id: '7'}}],
  ['200 без признака дубля', {status: 200, body: {id: 7}}],
  ['обрыв сети', new Error('network down')]
]) {
  test('ошибка «' + name + '» — callback_error, лида нет', async () => {
    const {status, list} = await submitWith(response);
    assert.deepEqual(list, ['callback_attempt', 'callback_error']);
    assert.equal(status.dataset.state, 'error');
  });
}

test('невалидный телефон — ни попытки, ни заявки', async () => {
  const {list} = await submitWith({status: 201, body: {id: 1}}, {contact: '123'});
  assert.deepEqual(list, []);
});

test('callback_start один раз на форму при многократном вводе', async () => {
  const page = open('index.html');
  const form = page.doc.querySelector('[data-callback-form]');
  for (let i = 0; i < 5; i += 1) form.elements.namedItem('name').dispatchEvent(new page.win.Event('input', {bubbles: true}));
  assert.equal(count(goals(page.win), 'callback_start'), 1);
});

/* ---------- Этапы: один раз и только при фактической видимости ---------- */

test('этапы не срабатывают без фактической видимости и без отрисованных услуг', async () => {
  const page = open('index.html');
  show(page.doc.getElementById('price'));        // блок виден, но в нём заглушка «Загружаем услуги»
  scroll(page.win, 3);
  await sleep(DWELL);
  assert.deepEqual(goals(page.win).filter(g => attribution.stageGoals.includes(g)), []);
});

test('service_view — один раз при многократной видимости', async () => {
  const page = open('index.html');
  renderCatalog(page.doc);
  show(page.doc.getElementById('price'));
  scroll(page.win, 5);
  await sleep(DWELL);
  scroll(page.win, 5);
  await sleep(DWELL);
  assert.equal(count(goals(page.win), 'service_view'), 1);
});

test('сцена под открытым модальным прайсом не засчитывается, после закрытия — один раз', async () => {
  const page = open('index.html');
  page.doc.documentElement.classList.add('av-price-open');
  show(page.doc.getElementById('contact-messengers'));
  scroll(page.win, 2);
  await sleep(DWELL);
  assert.equal(count(goals(page.win), 'contact_view'), 0);
  page.doc.documentElement.classList.remove('av-price-open');
  await sleep(DWELL);
  assert.equal(count(goals(page.win), 'contact_view'), 1);
});

test('неактивная вкладка не засчитывается, после возврата — один раз', async () => {
  // callback.js показывает форму только там, где есть fetch; в jsdom его нет — даём заглушку.
  const page = open('index.html', {before: win => { win.fetch = async () => ({status: 500, ok: false, json: async () => ({})}); }});
  assert.equal(page.doc.querySelector('[data-callback-form]').hidden, false, 'форма показана callback.js');
  let state = 'hidden';
  Object.defineProperty(page.doc, 'visibilityState', {configurable: true, get: () => state});
  show(page.doc.querySelector('[data-callback-form]'));
  scroll(page.win);
  await sleep(DWELL);
  assert.equal(count(goals(page.win), 'callback_open'), 0);
  state = 'visible';
  page.doc.dispatchEvent(new page.win.Event('visibilitychange'));
  await sleep(DWELL);
  assert.equal(count(goals(page.win), 'callback_open'), 1);
});

test('скрытая форма (браузер без fetch, форма осталась hidden) — callback_open не засчитан', async () => {
  const page = open('index.html');
  const form = page.doc.querySelector('[data-callback-form]');
  assert.equal(form.hidden, true);
  show(form);
  scroll(page.win, 2);
  await sleep(DWELL);
  assert.equal(count(goals(page.win), 'callback_open'), 0);
});

test('сцена, ушедшая из виду до истечения выдержки, не засчитывается', async () => {
  const page = open('index.html');
  const contacts = page.doc.getElementById('contact-messengers');
  show(contacts);
  scroll(page.win);
  await sleep(attribution.stageDwell / 3);
  hide(contacts);
  scroll(page.win);
  await sleep(DWELL);
  assert.equal(count(goals(page.win), 'contact_view'), 0);
});

/* ---------- Закрывающие экран окна: промо-баннер и лоадер ---------- */

// В jsdom нет HTMLDialogElement.showModal/close. Эмуляция делает то же, что браузер
// с атрибутом open; всё остальное (is-open, html.promo-open, автопоказ через 350 мс,
// закрытие кнопкой) выполняет настоящий subscription-promo.js.
function dialogApi(win) {
  win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  win.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
}
function promoPage() {
  return open('index.html', {
    before: win => {
      dialogApi(win);
      win.fetch = async () => ({status: 500, ok: false, json: async () => ({})});   // форма показывается
    },
    scripts: ['contact-route.js', 'subscription-promo.js', 'callback.js', 'attribution.js']
  });
}
// Триггер автопоказа #method-4 по стилям страницы прозрачен до анимации method-reveal.js,
// которая в тесте не запускается, — делаем его раскрытым и видимым.
function revealPromoTrigger(doc) {
  const trigger = doc.querySelector(doc.getElementById('promo').dataset.promoTrigger);
  trigger.style.opacity = '1';
  show(trigger, 100);
}

test('промо-баннер (настоящий автопоказ 350 мс): под ним ни service_view, ни contact_view, ни callback_open', async () => {
  const page = promoPage();
  const {doc, win} = page;
  const promo = doc.getElementById('promo');
  renderCatalog(doc);
  show(doc.getElementById('price'));
  show(doc.getElementById('contact-messengers'));
  show(doc.querySelector('[data-callback-form]'));
  revealPromoTrigger(doc);
  scroll(win);                                         // стартуют и выдержка этапов, и таймер промо
  await sleep(450);
  assert.equal(promo.hasAttribute('open'), true, 'промо открыт через showModal');
  assert.equal(promo.classList.contains('is-open'), true);
  assert.equal(doc.documentElement.classList.contains('promo-open'), true);
  scroll(win, 3);
  await sleep(DWELL);
  const under = goals(win);
  assert.equal(count(under, 'service_view'), 0, 'service_view под промо');
  assert.equal(count(under, 'contact_view'), 0, 'contact_view под промо');
  assert.equal(count(under, 'callback_open'), 0, 'callback_open под промо');
  promo.querySelector('.promo__close').click();       // настоящее закрытие кнопкой
  assert.equal(doc.documentElement.classList.contains('promo-open'), false);
  assert.equal(promo.hasAttribute('open'), false);
  await sleep(DWELL);                                  // пересчёт по закрытию, без прокрутки
  const after = goals(win);
  assert.equal(count(after, 'service_view'), 1);
  assert.equal(count(after, 'contact_view'), 1);
  assert.equal(count(after, 'callback_open'), 1);
});

test('промо открылся до истечения выдержки — этап не засчитан, после закрытия — отсчёт заново', async () => {
  const page = promoPage();
  const {doc, win} = page;
  renderCatalog(doc);
  show(doc.getElementById('price'));
  scroll(win);
  await sleep(attribution.stageDwell / 3);
  win.SubscriptionPromo.open();                        // тот же open(), что вызывает автопоказ
  await sleep(attribution.stageDwell);                 // исходная выдержка истекла под промо
  assert.equal(count(goals(win), 'service_view'), 0);
  win.SubscriptionPromo.close();
  await sleep(attribution.stageDwell / 2);
  assert.equal(count(goals(win), 'service_view'), 0, 'после закрытия нужна полная новая выдержка');
  await sleep(DWELL);
  assert.equal(count(goals(win), 'service_view'), 1);
});

test('лоадер страницы закрывает экран, пока показан; после скрытия — этап один раз', async () => {
  const page = open('index.html');
  const {doc, win} = page;
  const loader = doc.getElementById('page-loader');
  loader.classList.add('is-visible');                  // как inline-скрипт лоадера через 300 мс
  renderCatalog(doc);
  show(doc.getElementById('price'));
  scroll(win, 2);
  await sleep(DWELL);
  assert.equal(count(goals(win), 'service_view'), 0, 'service_view под лоадером');
  loader.classList.add('is-complete');                 // finish(): затухание…
  setTimeout(() => { loader.style.display = 'none'; }, 50);   // …и display:none
  await sleep(DWELL + 100);
  assert.equal(count(goals(win), 'service_view'), 1);
});

test('прозрачный лоадер без класса is-visible экран не закрывает', async () => {
  const page = open('index.html');
  renderCatalog(page.doc);
  show(page.doc.getElementById('price'));
  scroll(page.win);
  await sleep(DWELL);
  assert.equal(count(goals(page.win), 'service_view'), 1);
});

test('модальная галерея результатов (dialog[open]) тоже закрывает сцены', async () => {
  const page = open('index.html', {before: dialogApi});
  const {doc, win} = page;
  renderCatalog(doc);
  show(doc.getElementById('price'));
  doc.getElementById('results-dialog').showModal();
  scroll(win);
  await sleep(DWELL);
  assert.equal(count(goals(win), 'service_view'), 0);
  doc.getElementById('results-dialog').close();
  await sleep(DWELL);
  assert.equal(count(goals(win), 'service_view'), 1);
});

/* ---------- Fallback «написать нам»: намерение, а не просмотр ---------- */

test('fallback-клик даёт contact_choice; contact_view — только после видимости контактов', async () => {
  const page = open('index.html', {before: win => {
    // Ссылка на мессенджер вне блока контактов (так её мог вставить редактор сайта).
    const hero = win.document.getElementById('top');
    const link = win.document.createElement('a');
    link.id = 'test-fallback'; link.href = 'https://wa.me/79501001059'; link.textContent = 'Написать';
    hero.appendChild(link);
  }});
  const link = page.doc.getElementById('test-fallback');
  assert.equal(link.getAttribute('href'), '#contacts', 'contact-route.js переписал ссылку на fallback');
  assert.ok(link.hasAttribute('data-contact-route'));
  link.click();
  await sleep(DWELL);
  let list = goals(page.win);
  assert.equal(count(list, 'contact_choice'), 1);
  assert.equal(count(list, 'contact_view'), 0, 'клик не равен просмотру контактов');
  assert.equal(count(list, 'messenger_click'), 0, 'fallback не является обращением в мессенджер');
  show(page.doc.getElementById('contact-messengers'));
  scroll(page.win);
  await sleep(DWELL);
  list = goals(page.win);
  assert.equal(count(list, 'contact_view'), 1);
});

/* ---------- Реальные ссылки контактов и динамическая подмена ---------- */

test('реальные ссылки блока контактов: запись, мессенджеры, сообщество, телефон', () => {
  const page = open('index.html');
  const pick = selector => page.doc.querySelector('#contact-messengers ' + selector);
  ['[data-company-link="booking"]', '[data-company-link="whatsapp"]', '[data-company-link="telegram"]',
    '[data-company-link="max"]', '[data-company-link="vk"]'].forEach(selector => pick(selector).click());
  page.doc.querySelector('#contacts .contact-links a[href^="tel:"]').click();
  assert.deepEqual(goals(page.win),
    ['booking_click', 'messenger_click', 'messenger_click', 'messenger_click', 'social_click', 'phone_click']);
});

test('динамическая подмена ссылок (company-links.js из CRM) и сохранение атрибуции', async () => {
  const page = open('index.html', {url: ORIGIN + '/index.html?utm_source=test_src&utm_medium=cpc'});
  const vk = page.doc.querySelector('#contact-messengers [data-company-link="vk"]');
  const booking = page.doc.querySelector('#contact-messengers [data-company-link="booking"]');
  vk.click();
  vk.setAttribute('href', 'https://vk.me/lasermkt');
  vk.click();
  booking.setAttribute('href', 'https://n396010.yclients.com/company/375899/personal/menu');
  await sleep(10);                                   // MutationObserver размечает новую ссылку
  const decorated = new URL(booking.getAttribute('href'));
  assert.equal(decorated.searchParams.get('utm_source'), 'test_src');
  assert.equal(decorated.searchParams.get('entry_point'), 'contacts_booking');
  booking.click();
  booking.setAttribute('href', 'https://example.com/booking');
  booking.click();
  const added = page.doc.createElement('a');
  added.href = 'tel:+79331901059';
  page.doc.getElementById('contacts').appendChild(added);
  added.click();                                     // клик раньше, чем отработал наблюдатель
  assert.deepEqual(goals(page.win), ['social_click', 'messenger_click', 'booking_click', 'phone_click']);
});

test('t.me/joinchat и t.me/+код — приглашения в группу, не личное сообщение', () => {
  const page = open('index.html');
  const telegram = page.doc.querySelector('[data-company-link="telegram"]');
  telegram.setAttribute('href', 'https://t.me/joinchat/AbCdEfGh');
  telegram.click();
  telegram.setAttribute('href', 'https://t.me/+AbCdEfGh12345');
  telegram.click();
  telegram.setAttribute('href', 'https://t.me/+79501001059');
  telegram.click();
  assert.deepEqual(goals(page.win), ['social_click', 'social_click', 'messenger_click']);
});

/* ---------- Встроенный прайс ---------- */

async function overlay(options) {
  const settings = options || {};
  const parent = open('index.html');
  const doc = parent.doc;
  const dialog = doc.createElement('dialog');
  dialog.className = 'av-price-dialog';
  const frame = doc.createElement('iframe');
  frame.className = 'av-price-dialog__frame';
  dialog.appendChild(frame);
  doc.body.appendChild(dialog);
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, {once: true}));
  frame.src = 'price.html?embedded=1';
  await loaded;
  const child = frame.contentWindow;
  const errors = [];
  prepare(child, errors);
  // Доставка postMessage как в браузере: targetOrigin проверяется, origin и source
  // заполняются по отправителю. jsdom эти поля не заполняет.
  parent.win.postMessage = function (message, targetOrigin) {
    if (targetOrigin !== '*' && targetOrigin !== parent.win.location.origin) return;
    const event = new parent.win.MessageEvent('message', {data: message, origin: child.location.origin, source: child});
    setTimeout(() => parent.win.dispatchEvent(event), 0);
  };
  const inline = child.document.querySelector('script:not([src])');
  child.eval(inline.textContent);                    // ставит html.av-price-embedded, как в браузере
  run(child, ['contact-route.js', 'attribution.js']);
  if (settings.open !== false) {
    dialog.setAttribute('open', '');
    doc.documentElement.classList.add('av-price-open');
  }
  return {parent, dialog, frame, child, errors};
}

test('iframe прайса: второй счётчик не подключается, загрузка кадра ничего не засчитывает', async () => {
  const {parent, child} = await overlay();
  assert.equal(child.document.documentElement.classList.contains('av-price-embedded'), true);
  assert.equal(child.__metrikaReady, undefined);
  assert.equal(child.document.querySelector('script[src*="mc.yandex.ru"]'), null);
  assert.equal(parent.doc.querySelectorAll('script[src*="mc.yandex.ru"]').length, 1, 'счётчик только в родителе');
  assert.equal(parent.win.__ymCalls.filter(c => c[1] === 'init').length, 1);
  scroll(child, 2);
  await sleep(DWELL);
  assert.deepEqual(child.__ymCalls, [], 'в кадре ym не вызывается ни разу');
  assert.deepEqual(goals(parent.win), [], 'пустой каркас прайса не засчитан');
});

test('iframe прайса: фактический просмотр прайса и клик доходят до родителя один раз', async () => {
  const {parent, child} = await overlay();
  const content = renderCatalog(child.document, 'https://n396010.yclients.com/company/375899/personal/menu');
  show(content);
  scroll(child, 3);
  await sleep(DWELL);
  scroll(child, 3);
  await sleep(DWELL);
  const link = child.document.querySelector('#av-catalog-content a');
  assert.equal(new URL(link.getAttribute('href')).searchParams.get('entry_point'), 'price_booking');
  link.click();
  await sleep(20);
  assert.deepEqual(goals(parent.win), ['price_view', 'booking_click']);
  child.document.querySelector('.av-shell-back').click();   // «← Вернуться на сайт» — не намерение
  await sleep(20);
  assert.deepEqual(goals(parent.win), ['price_view', 'booking_click']);
  assert.deepEqual(child.__ymCalls, []);
  assert.equal(count(goals(parent.win), 'service_view'), 0, 'кадр не даёт этапов главной');
});

test('iframe прайса: повторное открытие прайса за тот же просмотр главной — price_view один раз', async () => {
  const {parent, frame, child} = await overlay();
  renderCatalog(child.document);
  show(child.document.getElementById('av-catalog-content'));
  scroll(child);
  await sleep(DWELL);
  // Повторное открытие: price-overlay.js перезагружает кадр, новый документ снова сообщает о просмотре.
  const reloaded = new Promise(resolve => frame.addEventListener('load', resolve, {once: true}));
  frame.src = 'price.html?embedded=1&again=1';
  await reloaded;
  const again = frame.contentWindow;
  prepare(again, []);
  parent.win.postMessage = function (message, targetOrigin) {
    if (targetOrigin !== parent.win.location.origin) return;
    const event = new parent.win.MessageEvent('message', {data: message, origin: again.location.origin, source: again});
    setTimeout(() => parent.win.dispatchEvent(event), 0);
  };
  again.eval(again.document.querySelector('script:not([src])').textContent);
  run(again, ['contact-route.js', 'attribution.js']);
  renderCatalog(again.document);
  show(again.document.getElementById('av-catalog-content'));
  scroll(again);
  await sleep(DWELL);
  assert.equal(count(goals(parent.win), 'price_view'), 1);
  assert.deepEqual(again.__ymCalls, []);
});

test('iframe прайса: price_view при закрытом диалоге не принимается', async () => {
  const {parent, child} = await overlay({open: false});
  const content = renderCatalog(child.document);
  show(content);
  scroll(child);
  await sleep(DWELL + 30);
  assert.deepEqual(goals(parent.win), []);
});

test('мост родителя: чужой origin, чужой кадр, неизвестная цель и этап главной отклоняются', async () => {
  const {parent, child} = await overlay();
  const stranger = parent.doc.createElement('iframe');
  parent.doc.body.appendChild(stranger);
  const deliver = (data, origin, source) => parent.win.dispatchEvent(
    new parent.win.MessageEvent('message', {data, origin, source}));
  const from = goal => ({source: attribution.bridgeToken, goal});
  deliver(from('booking_click'), 'https://evil.example', child);
  deliver(from('booking_click'), ORIGIN, stranger.contentWindow);
  deliver(from('booking_click'), ORIGIN, null);
  deliver(from('lead_created'), ORIGIN, child);
  deliver(from('contact_view'), ORIGIN, child);
  deliver(from('service_view'), ORIGIN, child);
  deliver({goal: 'booking_click'}, ORIGIN, child);
  assert.deepEqual(goals(parent.win), []);
  deliver(from('phone_click'), ORIGIN, child);
  assert.deepEqual(goals(parent.win), ['phone_click'], 'контрольное сообщение своего кадра принято');
});

test('price.html как самостоятельная страница: счётчик подключён, price_view после отрисовки каталога', async () => {
  const page = open('price.html', {scripts: ['contact-route.js', 'attribution.js']});
  assert.equal(page.doc.documentElement.classList.contains('av-price-embedded'), false);
  assert.equal(page.win.__ymCalls.filter(c => c[1] === 'init').length, 1);
  const content = page.doc.getElementById('av-catalog-content');
  show(content);
  scroll(page.win);
  await sleep(DWELL);
  assert.equal(count(goals(page.win), 'price_view'), 0, 'заглушка «Загружаем прайс» — не просмотр');
  renderCatalog(page.doc);
  show(content);
  scroll(page.win, 3);
  await sleep(DWELL);
  assert.equal(count(goals(page.win), 'price_view'), 1);
});

test('вебвизор выключен в init', () => {
  const page = open('index.html');
  const init = page.win.__ymCalls.find(c => c[1] === 'init');
  assert.equal(init[0], 112772817);
  assert.equal(init[2].webvisor, false);
});
