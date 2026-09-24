/* Согласованность 24 публичных страниц: единые версии ассетов, общая шапка/подвал/корзина,
   внутренние ссылки ведут на существующие файлы, нет ложных обещаний оплаты и статических цен.
   Визуальную проверку это не заменяет.
   node --test sites/palitra-love/pages.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const VERSION = '20260924darya1';
function pages(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'assets' && entry.name !== 'data') pages(full, out);
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}
const all = pages();
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
const read = (file) => fs.readFileSync(file, 'utf8');

test('найдены все публичные страницы', () => {
  assert.equal(all.length, 24, rel(all.join(', ')));
});

test('каждая страница подключает одну версию стилей и скриптов, включая рендер карточек и корзину', () => {
  for (const file of all) {
    const html = read(file);
    const name = rel(file);
    for (const asset of ['/assets/styles.css', '/assets/app.js', '/price-render.js', '/assets/order.js']) {
      assert.match(html, new RegExp(`${asset.replace(/[./]/g, '\\$&')}\\?v=${VERSION}"`), `${name}: ${asset}`);
    }
    for (const optional of ['catalog-live.js', 'quiz.js']) {
      if (html.includes(`/assets/${optional}?v=`)) assert.match(html, new RegExp(`${optional.replace('.', '\\.')}\\?v=${VERSION}"`), `${name}: ${optional}`);
    }
    assert.ok(html.indexOf('/price-render.js?v=') < html.indexOf('/assets/order.js?v='), `${name}: order.js после price-render.js`);
    for (const stale of ['styles.css?v=20260907type1', 'app.js?v=20260907brand1', 'price-render.js?v=20260908live1', '?v=20260917catalog1', '?v=20260917align1', '?v=20260917order1', '?v=20260917order2', '?v=20260918channel1', '?v=20260918channel2']) {
      assert.ok(!html.includes(stale), `${name}: старая версия ${stale}`);
    }
  }
});

test('общая шапка, меню, кнопка корзины, панель корзины и подвал присутствуют везде', () => {
  for (const file of all) {
    const html = read(file);
    const name = rel(file);
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/, name);
    assert.match(html, /<button class="menu" type="button" data-menu-toggle/, name);
    assert.match(html, /<div class="navlinks" id="mobile-navigation">/, name);
    assert.match(html, /<button class="cart-button" data-cart-open>Корзина · <span data-cart-count>0<\/span><\/button>/, name);
    assert.equal((html.match(/<aside class="cart" data-cart hidden aria-hidden="true"/g) || []).length, 1, `${name}: одна панель корзины`);
    assert.match(html, /<form data-order-form="cart">[\s\S]*name="consent"[\s\S]*Отправить заявку менеджеру/, name);
    assert.match(html, /<footer class="footer">/, name);
    if (/data-page="catalog"/.test(html)) assert.match(html, /<div class="grid" data-products><\/div>/, name);
  }
});

test('нет ложных обещаний: старых форм-заглушек, «ссылки на оплату», онлайн-оплаты и статических цен в JSON-LD', () => {
  for (const file of all) {
    const html = read(file);
    const name = rel(file);
    assert.ok(!/ссылк[а-яё]* на оплату/i.test(html), `${name}: «ссылка на оплату»`);
    assert.ok(!html.includes('Создать заказ'), `${name}: старая форма «Создать заказ»`);
    assert.ok(!html.includes('ORDER_ENDPOINT') && !html.includes('TELEGRAM_ENDPOINT'), name);
    for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const text = block[1];
      assert.ok(!/"@type":\s*"Product"/.test(text) && !/"@type":\s*"Offer"/.test(text) && !/"@type":\s*"ItemList"/.test(text), `${name}: статические цены в JSON-LD`);
      // FAQ-разметка совпадает с видимыми ответами.
      const data = JSON.parse(text);
      for (const node of Array.isArray(data) ? data : [data]) {
        if (node['@type'] !== 'FAQPage') continue;
        for (const question of node.mainEntity) assert.ok(html.includes(question.acceptedAnswer.text), `${name}: ответ FAQ «${question.name}» не совпадает с видимым`);
      }
    }
  }
  assert.ok(!read(path.join(ROOT, 'config.js')).includes('ENDPOINT'), 'config.js без пустых endpoint');
  assert.ok(!read(path.join(ROOT, 'assets', 'app.js')).includes('Заявка отправлена'), 'app.js без безусловного успеха');
});

test('внутренние ссылки и локальные ассеты существуют', () => {
  const missing = [];
  for (const file of all) {
    const html = read(file);
    const refs = [...html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)].map((m) => m[1]);
    for (const ref of new Set(refs)) {
      if (ref === '/') continue;
      const candidates = [path.join(ROOT, ref), path.join(ROOT, ref, 'index.html')];
      if (!candidates.some((candidate) => fs.existsSync(candidate))) missing.push(`${rel(file)} → ${ref}`);
    }
  }
  assert.deepEqual(missing, []);
});

/* Маршрут заказа сейчас — форма сайта (решение Хью до подтверждения получателя); Telegram-ссылки сайта
   ведут только в канал и подписаны как канал. Это проверка текущего маршрута и подписей, а не запрет
   на клиентские контакты: опубликованный в канале чат заказа `t.me/palitra_love` сайт пока не использует. */
const TELEGRAM_DESTINATIONS = { 'https://t.me/palitralovee': /Канал в Telegram|@palitralovee/ };
test('Telegram и заявка: ссылки сайта ведут в канал с честной подписью, заказ через форму сайта, квиз без прямого перехода в чат', () => {
  for (const file of all) {
    const html = read(file);
    const name = rel(file);
    assert.ok(!html.includes('Написать в Telegram'), name + ': канал подписан как личный чат');
    for (const link of html.matchAll(/<a [^>]*href="(https:\/\/t\.me\/[^"]*)"[^>]*>([^<]*)<\/a>/g)) {
      const label = TELEGRAM_DESTINATIONS[link[1]];
      assert.ok(label, name + ': ссылка Telegram вне текущего маршрута сайта: ' + link[1]);
      assert.match(link[2], label, name + ': подпись ссылки «' + link[2] + '» не соответствует назначению');
    }
    if (html.includes('data-occasion-quiz')) assert.match(html, /quiz\.js\?v=/, name);
  }
  const quiz = read(path.join(ROOT, 'assets', 'quiz.js'));
  assert.ok(!quiz.includes('?text='), 'quiz.js не передаёт ответы в чат напрямую — только в форму заявки');
  assert.match(quiz, /\/#zayavka/, 'quiz.js ведёт на форму заявки');
  assert.match(read(path.join(ROOT, 'index.html')), /<section class="band" id="zayavka">[\s\S]*<select name="occasion"[\s\S]*<input name="date" type="date" required>[\s\S]*name="consent" required/, 'форма заявки главной: повод, дата и согласие обязательны');
});
