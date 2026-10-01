'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { read, fakeClock, dom, setViewport, setVisibility, setRect, loadMetrika, click, ORIGIN } = require('./helpers.cjs');

const api = loadMetrika();
const HOME = ORIGIN + '/';

// Ссылки из реальной разметки; jsdom не умеет переходить по ним — гасим переход после нашей обработки.
function quiet(win) { win.document.addEventListener('click', e => e.preventDefault()); }

function anchor(win, href, attrs = {}) {
  const a = win.document.createElement('a');
  a.setAttribute('href', href);
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = 'ссылка';
  win.document.body.append(a);
  return a;
}

/* ======================= 1. Классификация ссылок ======================= */

test('реальный блок #contacts: контакт для записи и переход в канал различаются', () => {
  const { window } = dom(read('index.html'), HOME);
  const got = Array.from(window.document.querySelectorAll('#contacts a[href]')).map(a => {
    const hit = api.classifyLink(a, HOME);
    return [a.getAttribute('href'), hit && hit.goal, hit && hit.params && hit.params.network];
  });
  const by = Object.fromEntries(got.map(([href, goal, net]) => [href, [goal, net]]));
  assert.deepEqual(by['https://t.me/+79246180555'], ['click_telegram', undefined]);
  assert.deepEqual(by['tel:+79246180555'], ['click_phone', undefined]);
  assert.equal(by[Object.keys(by).find(h => h.startsWith('https://max.ru/u/'))][0], 'click_max');
  // Канал spa_stio_alvi стоит в #contacts, но остаётся переходом в канал.
  assert.deepEqual(by['https://t.me/spa_stio_alvi'], ['social_profile_click', 't.me']);
  assert.deepEqual(by['https://vk.com/spa_studio_alvi'], ['social_profile_click', 'vk.com']);
  assert.deepEqual(by['https://yandex.ru/maps/org/alvi/132486598882/'], ['social_profile_click', 'yandex.ru']);
  assert.deepEqual(by['https://2gis.ru/irkutsk/firm/70000001061502048'], ['social_profile_click', '2gis.ru']);
  // Ссылка на политику — не канал и не контакт.
  assert.deepEqual(by['politika.html'], [null, null]);
});

test('все ссылки «Записаться» (role=booking, href=#contacts) — переход к контактам, не запись', () => {
  const { window } = dom(read('index.html'), HOME);
  const booking = Array.from(window.document.querySelectorAll('a[data-company-link="booking"]'));
  // 9 ссылок в разметке; десятое вхождение — шаблон карточек квиза во встроенном скрипте (тоже #contacts).
  assert.equal(booking.length, 9);
  for (const a of booking) assert.equal(api.classifyLink(a, HOME).goal, 'contact_route_click');
});

test('company-links.js подменил href: решает текущий href, а не устаревший data-contact-route', () => {
  const { window } = dom('<body></body>', HOME);
  // Тестовый адрес Yclients — заведомо условный, в коде сайта не используется.
  const a = anchor(window, '#contacts', { 'data-contact-route': '', 'data-company-link': 'booking' });
  assert.equal(api.classifyLink(a, HOME).goal, 'contact_route_click');
  a.setAttribute('href', 'https://n000000.yclients.com/company/0/');
  assert.equal(api.classifyLink(a, HOME).goal, 'booking_click');
  a.setAttribute('href', 'https://t.me/+79246180555');
  assert.equal(api.classifyLink(a, HOME).goal, 'click_telegram');
});

test('Telegram: адресная ссылка — контакт; канал и неизвестное имя — переход в канал', () => {
  const { window } = dom('<body></body>', HOME);
  const cases = [
    ['https://t.me/+79246180555', {}, 'click_telegram'],
    ['https://t.me/spa_stio_alvi', { 'data-company-link': 'telegram' }, 'social_profile_click'],
    ['https://t.me/spa_stio_alvi', { 'data-company-link': 'telegram_channel' }, 'social_profile_click'],
    ['https://t.me/alvi_admin', { 'data-company-link': 'telegram' }, 'click_telegram'],
    ['https://t.me/alvi_admin', {}, 'social_profile_click'],
    ['https://t.me/s/spa_stio_alvi', {}, 'social_profile_click'],
    ['https://max.ru/u/abc', {}, 'click_max'],
    ['https://max.ru/alvi', {}, 'social_profile_click'],
    ['https://wa.me/79246180555', {}, 'click_whatsapp'],
    ['https://example.org/', {}, null]
  ];
  for (const [href, attrs, goal] of cases) {
    const hit = api.classifyLink(anchor(window, href, attrs), HOME);
    assert.equal(hit && hit.goal, goal, href + ' ' + JSON.stringify(attrs));
  }
});

test('ссылка index.html#contacts со страницы прайса — переход к контактам', () => {
  const { window } = dom('<body></body>', ORIGIN + '/price.html?embedded=1');
  const a = anchor(window, 'index.html#contacts', { 'data-company-link': 'booking' });
  assert.equal(api.classifyLink(a, window.location.href).goal, 'contact_route_click');
});

test('Yclients не выдумывается: на текущем сайте ни одна ссылка не даёт booking_click', () => {
  for (const [file, url] of [['index.html', HOME], ['price.html', ORIGIN + '/price.html']]) {
    const { window } = dom(read(file), url);
    const hits = Array.from(window.document.querySelectorAll('a[href]'))
      .map(a => api.classifyLink(a, url)).filter(h => h && h.goal === 'booking_click');
    assert.equal(hits.length, 0, file);
  }
});

/* ======================= 2. Этапы: фактическая видимость ======================= */

const FIXTURE = `<!doctype html><body>
  <div id="page-loader" aria-hidden="true"></div>
  <section id="for-self">для себя</section><section id="for-two">для двоих</section>
  <section id="gift">сертификат</section>
  <section id="contacts">контакты</section>
  <form id="callback-form"><input name="phone"></form>
  <section id="quiz-result" hidden>результат</section>
  <dialog id="promo">промо</dialog>
</body>`;

function ready(win) {
  return win.document.readyState === 'loading'
    ? new Promise(r => win.document.addEventListener('DOMContentLoaded', r, { once: true }))
    : Promise.resolve();
}

async function counter(html = FIXTURE, url = HOME) {
  const clock = fakeClock();
  const d = dom(html, url);
  const win = d.window;
  setViewport(win, 1000, 800);
  const sent = [];
  const ctl = api.start(win, { skipTag: true, send: (g, p) => sent.push(p ? [g, p] : [g]), now: clock.now, setTimeout: clock.setTimeout });
  // Все блоки по умолчанию далеко внизу — невидимы.
  for (const id of ['for-self', 'for-two', 'gift', 'contacts', 'callback-form', 'quiz-result']) {
    const el = win.document.getElementById(id);
    if (el) setRect(el, 5000, 400);
  }
  await ready(win);
  ctl.check();
  return { win, doc: win.document, clock, sent, ctl, goals: () => sent.map(s => s[0]) };
}

test('блок виден ≥1 с — одна цель; повторные проверки не дублируют', async () => {
  const c = await counter();
  setRect(c.doc.getElementById('contacts'), 100, 400);
  c.ctl.check();
  assert.deepEqual(c.goals(), []);
  c.clock.tick(500); c.ctl.check();
  assert.deepEqual(c.goals(), []);
  c.clock.tick(600); // сработает отложенная перепроверка
  assert.deepEqual(c.goals(), ['contact_view']);
  c.clock.tick(5000); c.ctl.check(); c.ctl.check();
  assert.deepEqual(c.goals(), ['contact_view']);
});

test('мелькнул меньше секунды — цели нет', async () => {
  const c = await counter();
  const el = c.doc.getElementById('contacts');
  setRect(el, 100, 400); c.ctl.check();
  c.clock.tick(500); setRect(el, 5000, 400); c.ctl.check();
  c.clock.tick(2000);
  assert.deepEqual(c.goals(), []);
});

test('высокий блок 3000 px: занимает весь экран — засчитан, хотя видно только 27% блока', async () => {
  const c = await counter();
  const el = c.doc.getElementById('for-self');
  setRect(el, -500, 3000);
  assert.ok(800 / 3000 < 0.5, 'старое правило «50% блока» здесь никогда бы не сработало');
  c.ctl.check(); c.clock.tick(1100);
  assert.deepEqual(c.goals(), ['service_view']);
});

test('высокий блок выглядывает на 300 px из 800 — не засчитан', async () => {
  const c = await counter();
  setRect(c.doc.getElementById('for-self'), 500, 3000);
  c.ctl.check(); c.clock.tick(3000);
  assert.deepEqual(c.goals(), []);
});

test('скрытая сцена: hidden, прозрачный предок, display:none — не засчитываются', async () => {
  const c = await counter();
  const self = c.doc.getElementById('for-self');
  const two = c.doc.getElementById('for-two');
  setRect(self, 100, 300); setRect(two, 100, 300);
  self.hidden = true;
  two.style.opacity = '0';
  c.ctl.check(); c.clock.tick(3000);
  assert.deepEqual(c.goals(), []);
  two.style.opacity = '';
  two.style.display = 'none';
  c.ctl.check(); c.clock.tick(3000);
  assert.deepEqual(c.goals(), []);
  two.style.display = '';
  c.ctl.check(); c.clock.tick(1100);
  assert.deepEqual(c.goals(), ['service_view']);
});

test('вкладка в фоне — цели нет; вернулись на вкладку — засчитано после удержания', async () => {
  const c = await counter();
  setRect(c.doc.getElementById('contacts'), 100, 400);
  setVisibility(c.doc, 'hidden');
  c.ctl.check(); c.clock.tick(3000);
  assert.deepEqual(c.goals(), []);
  setVisibility(c.doc, 'visible'); // событие visibilitychange запускает перепроверку
  c.clock.tick(200); c.clock.tick(1100);
  assert.deepEqual(c.goals(), ['contact_view']);
});

test('перекрытие модалкой (открытое промо) — цели нет; закрыли — засчитано', async () => {
  const c = await counter();
  setRect(c.doc.getElementById('contacts'), 100, 400);
  c.doc.getElementById('promo').setAttribute('open', '');
  c.ctl.check(); c.clock.tick(3000);
  assert.deepEqual(c.goals(), []);
  c.doc.getElementById('promo').removeAttribute('open');
  c.ctl.check(); c.clock.tick(1100);
  assert.deepEqual(c.goals(), ['contact_view']);
});

test('экран загрузки поверх страницы — цели нет; загрузка завершена — засчитано', async () => {
  const c = await counter();
  const loader = c.doc.getElementById('page-loader');
  loader.className = 'is-visible';
  setRect(c.doc.getElementById('contacts'), 100, 400);
  c.ctl.check(); c.clock.tick(3000);
  assert.deepEqual(c.goals(), []);
  loader.className = 'is-visible is-complete';
  c.ctl.check(); c.clock.tick(1100);
  assert.deepEqual(c.goals(), ['contact_view']);
});

test('пять раз туда-обратно через контакты — одна цель contact_view', async () => {
  const c = await counter();
  const el = c.doc.getElementById('contacts');
  for (let i = 0; i < 5; i++) {
    setRect(el, 100, 400); c.ctl.check(); c.clock.tick(1100);
    setRect(el, 5000, 400); c.ctl.check(); c.clock.tick(500);
  }
  assert.deepEqual(c.goals(), ['contact_view']);
});

test('квиз: скрытый результат не засчитан; раскрытый и видимый — quiz_complete один раз', async () => {
  const c = await counter();
  const r = c.doc.getElementById('quiz-result');
  setRect(r, 100, 400);
  c.ctl.check(); c.clock.tick(3000);
  assert.deepEqual(c.goals(), []);
  r.hidden = false;
  c.ctl.check(); c.clock.tick(1100); c.ctl.check(); c.clock.tick(3000);
  assert.deepEqual(c.goals(), ['quiz_complete']);
});

test('#gift на главной — не просмотр прайса: price_view на главной сам по себе не приходит', async () => {
  const c = await counter();
  setRect(c.doc.getElementById('gift'), 100, 400);
  c.ctl.check(); c.clock.tick(3000);
  assert.ok(!c.goals().includes('price_view'));
});

test('отдельная страница прайса верхнего уровня — price_view по видимости содержимого', async () => {
  const c = await counter(read('price.html'), ORIGIN + '/price.html');
  const content = c.doc.querySelector('.price-content');
  assert.ok(content, 'в price.html есть .price-content');
  setRect(content, 50, 2000);
  c.ctl.check(); c.clock.tick(1100);
  assert.deepEqual(c.goals(), ['price_view']);
});

/* ======================= 3. iframe окна прайса и родитель ======================= */

async function parentWithOverlay({ open = true } = {}) {
  const c = await counter(`<!doctype html><body><section id="contacts"></section>
    <dialog class="alvi-price-dialog"${open ? ' open' : ''}><iframe class="alvi-price-dialog__frame"></iframe></dialog></body>`);
  const frame = c.doc.querySelector('iframe.alvi-price-dialog__frame');
  return Object.assign(c, { frame, dialog: c.doc.querySelector('dialog') });
}

const msg = (goal, extra) => Object.assign({ type: api.MESSAGE_TYPE, goal }, extra || {});

test('родитель: price_view из окна прайса принимается один раз на просмотр страницы', async () => {
  const p = await parentWithOverlay();
  const ev = { origin: ORIGIN, source: p.frame.contentWindow, data: msg('price_view') };
  assert.equal(p.ctl.handleMessage(ev), true);
  assert.equal(p.ctl.handleMessage(ev), false);
  assert.deepEqual(p.goals(), ['price_view']);
});

test('родитель: чужой origin, чужой source, неразрешённая цель, чужой тип — отклоняются', async () => {
  const p = await parentWithOverlay();
  const other = dom('<body></body>', 'https://evil.example/').window;
  const rejected = [
    { origin: 'https://evil.example', source: p.frame.contentWindow, data: msg('price_view') },
    { origin: ORIGIN, source: other, data: msg('price_view') },
    { origin: ORIGIN, source: p.win, data: msg('price_view') },
    { origin: ORIGIN, source: null, data: msg('price_view') },
    { origin: ORIGIN, source: p.frame.contentWindow, data: msg('callback_submit') },
    { origin: ORIGIN, source: p.frame.contentWindow, data: msg('service_view') },
    { origin: ORIGIN, source: p.frame.contentWindow, data: { type: 'other', goal: 'price_view' } },
    { origin: ORIGIN, source: p.frame.contentWindow, data: 'price_view' },
    { origin: ORIGIN, source: p.frame.contentWindow, data: msg('__proto__') }
  ];
  for (const ev of rejected) assert.equal(p.ctl.handleMessage(ev), false, JSON.stringify(ev.data) + ' ' + ev.origin);
  assert.deepEqual(p.goals(), []);
});

test('родитель: price_view при закрытом окне прайса или вкладке в фоне — отклоняется', async () => {
  const closed = await parentWithOverlay({ open: false });
  assert.equal(closed.ctl.handleMessage({ origin: ORIGIN, source: closed.frame.contentWindow, data: msg('price_view') }), false);
  const bg = await parentWithOverlay();
  setVisibility(bg.doc, 'hidden');
  assert.equal(bg.ctl.handleMessage({ origin: ORIGIN, source: bg.frame.contentWindow, data: msg('price_view') }), false);
  assert.deepEqual(closed.goals().concat(bg.goals()), []);
});

test('родитель: клики из окна прайса — без персональных данных, network только из списка, дребезг', async () => {
  const p = await parentWithOverlay();
  const src = p.frame.contentWindow;
  assert.equal(p.ctl.handleMessage({ origin: ORIGIN, source: src, data: msg('click_phone', { phone: '+79991234567', href: 'tel:+79991234567' }) }), true);
  assert.equal(p.ctl.handleMessage({ origin: ORIGIN, source: src, data: msg('click_phone') }), false); // дребезг 1,5 с
  p.clock.tick(1600);
  assert.equal(p.ctl.handleMessage({ origin: ORIGIN, source: src, data: msg('click_phone') }), true);
  p.ctl.handleMessage({ origin: ORIGIN, source: src, data: msg('social_profile_click', { network: 'evil.example', name: 'Анна' }) });
  p.ctl.handleMessage({ origin: ORIGIN, source: src, data: msg('booking_click') });
  assert.deepEqual(p.sent, [['click_phone'], ['click_phone'], ['social_profile_click', { network: 'other' }], ['booking_click']]);
  assert.ok(!JSON.stringify(p.sent).includes('7999') && !JSON.stringify(p.sent).includes('Анна'));
});

async function frameSetup(parentLocation) {
  const clock = fakeClock();
  const posted = [];
  const fakeParent = { postMessage: (m, target) => posted.push([m, target]) };
  Object.defineProperty(fakeParent, 'location', { get: parentLocation });
  const { window: win } = dom(read('price.html'), ORIGIN + '/price.html?embedded=1');
  setViewport(win, 900, 700);
  quiet(win);
  const ctl = api.start(win, { parent: fakeParent, top: fakeParent, skipTag: true, now: clock.now, setTimeout: clock.setTimeout,
    send: () => { throw new Error('в iframe счётчик не должен отправлять цели напрямую'); } });
  await ready(win);
  return { win, doc: win.document, clock, posted, ctl };
}

test('iframe окна прайса: второго счётчика нет, тег Метрики не вставляется', async () => {
  const f = await frameSetup(() => ({ origin: ORIGIN }));
  assert.equal(f.ctl.mode, 'frame');
  assert.equal(f.win.ALVI_METRIKA_ID, undefined);
  assert.equal(f.win.ym, undefined);
  assert.equal(f.doc.querySelector('script[src*="mc.yandex.ru"]'), null);
  f.win.alviGoal('callback_submit'); // пустышка
  assert.deepEqual(f.posted, []);
});

test('iframe окна прайса: видимое содержимое → price_view родителю, targetOrigin = свой origin', async () => {
  const f = await frameSetup(() => ({ origin: ORIGIN }));
  setRect(f.doc.querySelector('.price-content'), 60, 1800);
  f.ctl.check(); f.clock.tick(1100);
  assert.deepEqual(f.posted, [[{ type: api.MESSAGE_TYPE, goal: 'price_view' }, ORIGIN]]);
});

test('iframe окна прайса: реальные клики уходят родителю без адреса ссылки и текста', async () => {
  const f = await frameSetup(() => ({ origin: ORIGIN }));
  const add = (href, attrs) => { const a = f.doc.createElement('a'); a.setAttribute('href', href); for (const [k, v] of Object.entries(attrs || {})) a.setAttribute(k, v); a.textContent = '+7 924 618-05-55'; f.doc.body.append(a); return a; };
  click(f.win, add('tel:+79246180555'));
  click(f.win, add('https://t.me/spa_stio_alvi'));
  click(f.win, add('index.html#contacts', { 'data-company-link': 'booking' }));
  click(f.win, add('https://example.org/'));
  assert.deepEqual(f.posted.map(p => p[0]), [
    { type: api.MESSAGE_TYPE, goal: 'click_phone' },
    { type: api.MESSAGE_TYPE, goal: 'social_profile_click', network: 't.me' },
    { type: api.MESSAGE_TYPE, goal: 'contact_route_click' }
  ]);
  assert.ok(f.posted.every(p => p[1] === ORIGIN));
  assert.ok(!JSON.stringify(f.posted).includes('618'));
});

test('чужой iframe (кабинет на другом домене): ни счётчика, ни сообщений', async () => {
  const f = await frameSetup(() => { throw new Error('SecurityError: cross-origin'); });
  assert.equal(f.ctl.mode, 'inert');
  setRect(f.doc.querySelector('.price-content'), 60, 1800);
  f.clock.tick(5000);
  assert.deepEqual(f.posted, []);
  assert.equal(f.win.ALVI_METRIKA_ID, undefined);
});

test('iframe без embedded=1 — инертен', () => {
  const posted = [];
  const fakeParent = { location: { origin: ORIGIN }, postMessage: (m) => posted.push(m) };
  const { window: win } = dom(read('price.html'), ORIGIN + '/price.html');
  const ctl = api.start(win, { parent: fakeParent, top: fakeParent, skipTag: true });
  assert.equal(ctl.mode, 'inert');
});

/* ======================= 4. Верхний уровень: тег, динамические ссылки ======================= */

test('верхний уровень: тег Метрики вставляется один раз, webvisor включён', () => {
  const { window: win } = dom('<!doctype html><head><script></script></head><body></body>', HOME);
  api.start(win, {});
  api.start(win, {}); // повторный вызов не вставляет второй тег
  assert.equal(win.document.querySelectorAll('script[src="https://mc.yandex.ru/metrika/tag.js"]').length, 1);
  const init = win.ym.a.find(args => args[1] === 'init');
  assert.equal(init[0], 112777602);
  assert.equal(init[2].webvisor, true);
  assert.equal(win.ALVI_METRIKA_ID, 112777602);
  win.close(); // реальные таймеры опроса этапов не должны держать процесс
});

test('динамические ссылки: добавленная после старта и подменённая ссылка считаются по текущему href', async () => {
  const c = await counter('<body></body>');
  quiet(c.win);
  const late = anchor(c.win, '#contacts', { 'data-contact-route': '' });
  click(c.win, late);
  c.clock.tick(1600);
  late.setAttribute('href', 'https://n000000.yclients.com/company/0/');
  click(c.win, late);
  c.clock.tick(1600);
  late.setAttribute('href', 'https://t.me/spa_stio_alvi');
  click(c.win, late);
  assert.deepEqual(c.sent, [['contact_route_click'], ['booking_click'], ['social_profile_click', { network: 't.me' }]]);
});

test('двойной клик по телефону — одна цель (дребезг 1,5 с)', async () => {
  const c = await counter('<body></body>');
  quiet(c.win);
  const tel = anchor(c.win, 'tel:+79246180555');
  click(c.win, tel); click(c.win, tel);
  c.clock.tick(1600); click(c.win, tel);
  assert.deepEqual(c.goals(), ['click_phone', 'click_phone']);
});

test('alviGoal чистит параметры: персональные поля отбрасываются, reason только технический', async () => {
  const c = await counter('<body></body>');
  c.win.alviGoal('callback_error', { reason: '429', phone: '+79991234567', name: 'Анна' });
  c.win.alviGoal('callback_error', { reason: '+7 999 123-45-67' });
  assert.deepEqual(c.sent, [['callback_error', { reason: '429' }], ['callback_error']]);
});

/* ======================= 5. Дополнительно: реальная разметка, опрос, окно прайса ======================= */

test('реальная index.html: целевые блоки этапов не лежат внутри hidden / aria-hidden / inert', () => {
  const { window } = dom(read('index.html'), HOME);
  for (const id of ['for-self', 'for-two', 'contacts', 'callback-form', 'quiz-result']) {
    const el = window.document.getElementById(id);
    assert.ok(el, id + ' есть в разметке');
    for (let n = el.parentElement; n; n = n.parentElement) {
      assert.ok(!n.hidden && n.getAttribute('aria-hidden') !== 'true' && !n.hasAttribute('inert'), id + ' внутри скрытого предка ' + n.tagName);
    }
  }
  // Результат квиза в исходной разметке скрыт — до прохождения квиза цели быть не должно.
  assert.equal(window.document.getElementById('quiz-result').hidden, true);
});

test('раскрытие сцены стилем без прокрутки и событий — ловится опросом раз в секунду', async () => {
  const c = await counter();
  const el = c.doc.getElementById('contacts');
  setRect(el, 100, 400);
  el.style.opacity = '0';
  c.clock.tick(3000);
  assert.deepEqual(c.goals(), []);
  el.style.opacity = '1'; // MutationObserver за style не следит — сработать должен опрос
  c.clock.tick(2100);
  assert.deepEqual(c.goals(), ['contact_view']);
});

test('открытое окно прайса перекрывает страницу: этапы главной на паузе, пока прайс открыт', async () => {
  const p = await parentWithOverlay({ open: true });
  setRect(p.doc.getElementById('contacts'), 100, 400);
  p.ctl.check(); p.clock.tick(3000);
  assert.deepEqual(p.goals(), []);
  p.dialog.removeAttribute('open');
  p.clock.tick(2100);
  assert.deepEqual(p.goals(), ['contact_view']);
});

test('регрессия: счётчик больше не перехватывает window.fetch', async () => {
  const d = dom('<body></body>', HOME);
  const original = function fetchStub() {};
  d.window.fetch = original;
  api.start(d.window, { skipTag: true, send: () => {}, now: () => 0, setTimeout: () => 0 });
  assert.equal(d.window.fetch, original);
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'metrika.js'), 'utf8');
  assert.ok(!/window\.fetch\s*=|win\.fetch\s*=/.test(src), 'в metrika.js нет присваивания fetch');
});
