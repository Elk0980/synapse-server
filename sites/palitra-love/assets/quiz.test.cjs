/* Квиз повода: итог ведёт в форму заявки сайта с черновиком ответов (без контактов), точный
   текст требований формы, честный fallback при отказе хранилища, цены только из live-прайса.
   node --test sites/palitra-love/assets/quiz.test.cjs (jsdom из среды проекта) */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const order = require('./order.js');

const CONFIG = { occasion: 'Выписка', source: '/vypiska', questions: [
  { title: 'Кого встречаете', options: ['Мальчика', 'Девочку'] },
  { title: 'Когда выписка', options: ['Завтра', 'Через неделю'] },
  { title: 'Бюджет', options: ['До 8 тысяч', '8–12 тысяч'] }
], products: [{ name: 'Выписка мальчика', price: 9270, image: 'vypiska-malchik.jpg', priceId: 'vypiska-1' }, { name: 'Шары для деток', price: 8390, image: 'shary-detkam.jpg' }] };
const LIVE = { categories: [{ id: 'vypiska', title: 'Выписка', items: [{ id: 'vypiska-1', title: 'Выписка мальчика', price: '9 500 руб.' }, { id: 'zero-1', title: 'Пусто', price: '' }] }] };
const plain = (text) => String(text).replace(/[  ]/g, ' ');
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

function quizPage({ live = LIVE, storage } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div data-occasion-quiz><script type="application/json">${JSON.stringify(CONFIG)}</script></div></body>`,
    { url: 'https://palitra-love.synapsebusiness.ru/vypiska', runScripts: 'outside-only' });
  const win = dom.window;
  const navigations = [];
  // jsdom не выполняет переходы: фиксируем неотменённые клики по ссылкам и гасим навигацию.
  win.addEventListener('click', (event) => { const a = event.target.closest('a'); if (a) { if (!event.defaultPrevented) navigations.push(a.getAttribute('href')); event.preventDefault(); } });
  if (storage) Object.defineProperty(win, 'sessionStorage', { value: storage, configurable: true });
  win.PalitraPrice = { load: async () => live };
  win.eval(fs.readFileSync(path.join(__dirname, 'quiz.js'), 'utf8'));
  return { win, doc: win.document, root: win.document.querySelector('[data-occasion-quiz]'), navigations };
}
const answerAll = (root) => { root.querySelector('[data-answer="Мальчика"]').click(); root.querySelector('[data-answer="Завтра"]').click(); root.querySelector('[data-answer="8–12 тысяч"]').click(); };

test('итог: цена только из live-прайса по priceId, иначе «Цена уточняется» (не 0); «Оставить заявку» ведёт на форму и кладёт черновик без контактов', async () => {
  const { win, root, navigations } = quizPage();
  const links = () => [...root.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
  assert.deepEqual(links(), [['Оставить заявку', '/#zayavka'], ['Канал в Telegram', 'https://t.me/palitralovee']]);
  answerAll(root); await tick();
  assert.match(root.textContent, /Вот что подойдёт/);
  assert.match(root.textContent, /имя, телефон, дату и согласие на обработку данных/, 'точный список полей формы');
  assert.doesNotMatch(root.textContent, /останется указать имя и телефон/);
  const prices = [...root.querySelectorAll('.price')].map((p) => [plain(p.textContent), p.dataset.priceKnown]);
  assert.deepEqual(prices, [['9 500 руб.', 'true'], ['Цена уточняется', 'false']], 'live-цена по id, без статических 9270/8390');
  assert.equal(root.innerHTML.includes('9 270'), false); assert.equal(root.innerHTML.includes('8 390'), false);
  assert.equal(root.innerHTML.includes('?text='), false);
  const orderLinks = [...root.querySelectorAll('[data-order-product]')];
  assert.ok(orderLinks.every((a) => a.getAttribute('href') === '/#zayavka' && a.textContent === 'Оставить заявку'));
  orderLinks[1].click();
  const draft = JSON.parse(plain(win.sessionStorage.getItem(order.DRAFT_KEY)));
  assert.deepEqual(draft, { occasion: 'Выписка', source: '/vypiska', lines: ['Кого встречаете: Мальчика', 'Когда выписка: Завтра', 'Бюджет: 8–12 тысяч', 'Выбранная позиция: Шары для деток — цена уточняется'] });
  assert.deepEqual(navigations, ['/#zayavka'], 'переход на форму состоялся');
  orderLinks[0].click();
  assert.match(plain(win.sessionStorage.getItem(order.DRAFT_KEY)), /Выписка мальчика — 9 500 руб\./, 'известная live-цена попадает в черновик как строка прайса');
  assert.ok(!/\b0 ₽|: 0\b/.test(win.sessionStorage.getItem(order.DRAFT_KEY)), 'ноль не подставляется');
  win.close();
});

test('прайс недоступен: цены «уточняется», в черновике нет чисел', async () => {
  const { win, root } = quizPage({ live: null });
  answerAll(root); await tick();
  assert.deepEqual([...root.querySelectorAll('.price')].map((p) => p.textContent), ['Цена уточняется', 'Цена уточняется']);
  root.querySelector('[data-order-product="0"]').click();
  assert.match(win.sessionStorage.getItem(order.DRAFT_KEY), /Выписка мальчика — цена уточняется/);
  win.close();
});

test('хранилище недоступно: переход не выполняется молча, ответы показаны для копирования, ссылка на форму остаётся', async () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  const { root, navigations } = quizPage({ storage: broken });
  answerAll(root); await tick();
  root.querySelector('[data-order-product="1"]').click();
  assert.deepEqual(navigations, [], 'переход отменён');
  const fallback = root.querySelector('[data-quiz-fallback]');
  assert.equal(fallback.hidden, false);
  assert.match(fallback.textContent, /Не удалось передать ответы в форму автоматически/);
  assert.equal(plain(fallback.querySelector('textarea').value), 'Повод: Выписка\nКого встречаете: Мальчика\nКогда выписка: Завтра\nБюджет: 8–12 тысяч\nВыбранная позиция: Шары для деток — цена уточняется');
  assert.equal(fallback.querySelector('a').getAttribute('href'), '/#zayavka');
});

test('черновик квиза подставляется в форму заявки главной один раз: повод в список, ответы в комментарий, контакты пустые', async () => {
  const html = `<!doctype html><body data-page="home"><section id="zayavka"><form><input name="name"><input name="phone"><select name="occasion"><option value="">Выберите повод</option><option>Выписка из роддома</option><option>День рождения ребёнка</option><option>Другое</option></select><input name="date"><textarea name="comment"></textarea><input type="checkbox" name="consent"><button>Оставить заявку</button></form></section></body>`;
  const dom = new JSDOM(html, { url: 'https://palitra-love.synapsebusiness.ru/#zayavka', runScripts: 'outside-only' });
  const win = dom.window;
  win.sessionStorage.setItem(order.DRAFT_KEY, JSON.stringify({ occasion: 'Выписка', source: '/vypiska', lines: ['Кого встречаете: Мальчика', 'Выбранная позиция: Шары для деток — цена уточняется'] }));
  win.PalitraPrice = { load: async () => ({ categories: [] }) };
  order.mount(win);
  const form = win.document.querySelector('#zayavka form');
  assert.equal(form.elements.occasion.value, 'Выписка из роддома', 'повод сопоставлен со списком');
  assert.equal(form.elements.comment.value, 'Повод: Выписка\nКого встречаете: Мальчика\nВыбранная позиция: Шары для деток — цена уточняется');
  assert.equal(form.elements.name.value, ''); assert.equal(form.elements.phone.value, '');
  assert.equal(win.sessionStorage.getItem(order.DRAFT_KEY), null, 'черновик использован один раз');
  win.sessionStorage.setItem(order.DRAFT_KEY, JSON.stringify({ occasion: 'Подарок мужчине', lines: ['Возраст: 40'] }));
  form.elements.comment.value = 'Хочу с шарами';
  assert.equal(order.applyRequestDraft(form, win.sessionStorage), true);
  assert.equal(form.elements.occasion.value, 'Другое');
  assert.equal(form.elements.comment.value, 'Хочу с шарами\nПовод: Подарок мужчине\nВозраст: 40');
  assert.equal(order.applyRequestDraft(form, win.sessionStorage), false, 'повторно ничего не подставляется');
  assert.equal(order.readRequestDraft({ getItem: () => '{"lines":"bad"}' }), null, 'некорректный черновик игнорируется');
  win.close();
});

test('главная: карточки-примеры без статических цен, «Цена уточняется» до live-сопоставления по priceId', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://palitra-love.synapsebusiness.ru/', runScripts: 'outside-only' });
  const win = dom.window;
  win.PALITRA_CONFIG = { SITE_URL: win.location.origin };
  win.eval(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'));
  const prices = [...win.document.querySelectorAll('[data-products] .price')];
  assert.equal(prices.length, 4);
  assert.ok(prices.every((p) => p.textContent === 'Цена уточняется' && p.dataset.priceKnown === 'false'));
  assert.equal(win.document.querySelector('[data-products]').textContent.includes('₽'), false, 'числовых от-цен нет');
  assert.ok(!fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').includes('p:9270'), 'старые числа удалены из app.js');
  win.close();
});
