'use strict';
// Общий набор деталей сайтов (sites/_kit, spec 097-site-kit).
// Правило владельца: правка, сделанная однажды, действует на всех сайтах, а новый сайт
// собирается с учётом прежних правок. Тест ловит три способа это нарушить:
//   1) копия kit внутри сайта разошлась с источником (правили копию или забыли sync);
//   2) на странице сайта появился <select> без подключённого kit — снова системный список;
//   3) появился новый сайт с <select>, который не подключён и не объяснён в sites.json.
// Запуск: NODE_PATH=<каталог с jsdom> node --test sites/site-kit.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const kit = require('../tools/site-kit/sync.js');

const SITES = __dirname;
const config = kit.readConfig();
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const siteDirs = fs.readdirSync(SITES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_') && e.name !== 'node_modules')
  .map((e) => e.name)
  .filter((name) => fs.existsSync(path.join(SITES, name, 'index.html')));

test('копии kit в сайтах побайтно совпадают с sites/_kit, версии ?v= актуальны', () => {
  const stale = kit.diff(kit.plan(config));
  assert.deepEqual(stale, [], 'Правьте sites/_kit и запустите node tools/site-kit/sync.js. Расходятся: ' + stale.join(', '));
});

test('каждый сайт с <select> либо подключён к kit, либо явно отложен с причиной', () => {
  const unknown = [];
  for (const site of siteDirs) {
    const pages = kit.htmlPages(path.join(SITES, site)).filter((p) => kit.hasSelect(read(p)));
    if (!pages.length) continue;
    if (config.sites[site]) continue;
    if (typeof config.notConnected?.[site] === 'string' && config.notConnected[site].length > 10) continue;
    unknown.push(site);
  }
  assert.deepEqual(unknown, [], 'Новый сайт с выпадающим списком: добавьте его в sites/_kit/sites.json → sites (или notConnected с причиной)');
});

for (const [site, opts] of Object.entries(config.sites)) {
  const siteDir = path.join(SITES, site);
  const pages = kit.htmlPages(siteDir, path.join(siteDir, opts.dest)).filter((p) => kit.hasSelect(read(p)));

  test(`${site}: на всех ${pages.length} страницах с <select> kit подключён после стилей сайта`, () => {
    assert.ok(pages.length > 0);
    for (const page of pages) {
      const rel = path.relative(SITES, page);
      const dom = new JSDOM(read(page));
      const d = dom.window.document;
      const sheets = [...d.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'));
      const at = (file) => sheets.findIndex((h) => h.startsWith(opts.url + file + '?v='));
      for (const file of kit.CSS_ORDER) assert.ok(at(file) >= 0, `${rel}: нет ${opts.url}${file}`);
      assert.ok(at('theme.css') < at('fields.css') && at('fields.css') < at('select.css'), `${rel}: порядок theme → fields → select`);
      const own = sheets.filter((h) => !h.startsWith(opts.url));
      assert.ok(own.every((h) => sheets.indexOf(h) < at('theme.css')), `${rel}: kit должен идти после собственных стилей сайта`);
      const script = d.querySelector(`script[src^="${opts.url}select.js?v="]`);
      assert.ok(script && script.defer, `${rel}: нет select.js с defer`);
      for (const file of [...kit.CSS_ORDER, kit.SCRIPT]) assert.ok(fs.existsSync(path.join(siteDir, opts.dest, file)), `${opts.dest}/${file} не опубликован`);
      dom.window.close();
    }
  });

  test(`${site}: стили сайта не возвращают системный вид select`, () => {
    const css = fs.readdirSync(path.join(siteDir, 'assets')).filter((f) => f.endsWith('.css'))
      .map((f) => read(siteDir, 'assets', f)).join('\n');
    // Любое appearance для select в стилях сайта перебило бы kit. Правило kit — единственное.
    const rules = [...css.matchAll(/([^{}]*select[^{}]*)\{([^}]*)\}/gi)].filter((m) => /appearance\s*:/i.test(m[2]));
    assert.deepEqual(rules.map((m) => m[1].trim()), []);
    const theme = read(siteDir, opts.dest, 'theme.css');
    for (const v of ['--kit-bg', '--kit-fg', '--kit-accent', '--kit-radius', '--kit-font']) assert.match(theme, new RegExp(v + ':'));
  });
}

test('select.css снимает системный вид и рисует стрелку переменной сайта', () => {
  const css = read(SITES, '_kit', 'select.css');
  const block = css.slice(css.indexOf('select:not([multiple]):not([size]),'), css.indexOf('}', css.indexOf('select:not([multiple]):not([size]),')));
  assert.match(block, /(^|\s)appearance:\s*none/);
  assert.match(block, /-webkit-appearance:\s*none/);
  assert.match(block, /var\(--kit-arrow/);
  for (const v of ['--kit-bg', '--kit-fg', '--kit-radius', '--kit-font', '--kit-border']) assert.match(block, new RegExp('var\\(' + v + ','), v + ' с запасным значением');
});

test('демо sites/_kit не индексируется и не раздаётся доменом', () => {
  const html = read(SITES, '_kit', 'index.html');
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  for (const site of siteDirs) {
    const map = path.join(SITES, site, 'sitemap.xml');
    if (fs.existsSync(map)) assert.doesNotMatch(read(map), /_kit/);
  }
  const caddy = path.join(SITES, '..', 'caddy', 'Caddyfile');
  if (fs.existsSync(caddy)) assert.doesNotMatch(read(caddy), /\/srv\/sites\/_kit/);
});

// ---- Поведение select.js в DOM ----

const SELECT_JS = read(SITES, '_kit', 'select.js');
async function mount(body, { coarse = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = (q) => ({ matches: coarse && q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {} });
  w.eval(SELECT_JS);
  if (w.document.readyState === 'loading') await new Promise((r) => w.document.addEventListener('DOMContentLoaded', r));
  return { w, d: w.document };
}
const FORM = `<form><label>Как с вами связаться<select name="contactChannel" required>
  <option value="phone">Позвонить</option><option value="telegram">Telegram</option>
  <option value="whatsapp" disabled>WhatsApp</option><option value="max">MAX</option></select></label>
  <label>Много<select name="many" multiple><option>a</option></select></label>
  <label data-kit-native>Свой<select name="own"><option>x</option></select></label>
  <button type="submit">Отправить</button></form>`;
const key = (w, el, k, extra = {}) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

test('select.js: нативный select остаётся в форме, рядом — доступный combobox', async () => {
  const { w, d } = await mount(FORM);
  const select = d.querySelector('[name=contactChannel]');
  const button = d.querySelector('.kit-select__button');
  assert.ok(button, 'кнопка создана');
  assert.equal(d.querySelectorAll('.kit-select__button').length, 1, 'multiple и data-kit-native не трогаются');
  assert.equal(button.getAttribute('role'), 'combobox');
  assert.equal(button.getAttribute('aria-label'), 'Как с вами связаться');
  assert.equal(button.getAttribute('aria-required'), 'true');
  assert.equal(button.textContent, 'Позвонить');
  assert.equal(select.form, d.querySelector('form'));
  assert.ok(select.required && select.name === 'contactChannel');
  assert.equal(select.labels.length, 0, 'подпись теперь у кнопки');
  assert.equal(d.querySelector('label').control, button, 'клик по подписи открывает список');
  assert.equal(new w.FormData(d.querySelector('form')).get('contactChannel'), 'phone');
  assert.equal(d.querySelector('[name=own]').dataset.kitSelect, undefined);
  w.close();
});

test('select.js: клавиатура — открыть, пропустить disabled, выбрать, Escape без изменений', async () => {
  const { w, d } = await mount(FORM);
  const select = d.querySelector('[name=contactChannel]');
  const button = d.querySelector('.kit-select__button');
  const list = d.querySelector('.kit-select__list');
  let changes = 0, inputs = 0;
  select.addEventListener('change', () => changes++);
  select.addEventListener('input', () => inputs++);
  key(w, button, 'ArrowDown');
  assert.equal(list.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(d.getElementById(button.getAttribute('aria-activedescendant')).textContent, 'Позвонить');
  key(w, button, 'ArrowDown');
  key(w, button, 'ArrowDown');
  assert.equal(d.getElementById(button.getAttribute('aria-activedescendant')).textContent, 'MAX', 'WhatsApp disabled пропущен');
  let outer = 0;
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') outer++; });
  key(w, button, 'Escape');
  assert.equal(list.hidden, true);
  assert.equal(outer, 0, 'Escape открытого списка не закрывает панель сайта (корзину)');
  key(w, button, 'Escape');
  assert.equal(outer, 1, 'закрытый список Escape не перехватывает');
  assert.equal(select.value, 'phone');
  assert.equal(changes, 0);
  key(w, button, 'Enter');
  key(w, button, 'End');
  key(w, button, 'Enter');
  assert.equal(select.value, 'max');
  assert.equal(button.textContent, 'MAX');
  assert.equal(changes, 1);
  assert.equal(inputs, 1);
  assert.equal(new w.FormData(d.querySelector('form')).get('contactChannel'), 'max');
  key(w, button, 't');
  assert.equal(select.value, 'telegram', 'набор первой буквы на закрытом списке');
  w.close();
});

test('select.js: мышь, программная смена значения, disabled и сброс формы', async () => {
  const { w, d } = await mount(FORM);
  const select = d.querySelector('[name=contactChannel]');
  const button = d.querySelector('.kit-select__button');
  button.click();
  const options = [...d.querySelectorAll('.kit-select__option')];
  assert.equal(options.length, 4);
  assert.equal(options[2].getAttribute('aria-disabled'), 'true');
  options[2].click();
  assert.equal(select.value, 'phone', 'disabled не выбирается');
  options[1].click();
  assert.equal(select.value, 'telegram');
  assert.equal(d.querySelector('.kit-select__list').hidden, true);
  // Программную смену select.value проверяет браузерный прогон (tools/site-kit/browser-check.js):
  // прокси jsdom для HTMLSelectElement не вызывает собственный сеттер элемента.
  select.options[3].selected = true;
  select.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(button.textContent, 'MAX', 'смена значения скриптом сайта с событием change — кнопка следует');
  select.disabled = true;
  await new Promise((r) => w.setTimeout(r, 0));
  assert.equal(button.disabled, true);
  select.disabled = false;
  d.querySelector('form').reset();
  await new Promise((r) => w.setTimeout(r, 5));
  assert.equal(button.textContent, 'Позвонить');
  select.dispatchEvent(new w.Event('invalid'));
  assert.equal(button.getAttribute('aria-invalid'), 'true');
  w.close();
});

test('select.js: на сенсорном экране остаётся системный список, динамические select тоже обрабатываются', async () => {
  const touch = await mount(FORM, { coarse: true });
  assert.equal(touch.d.querySelector('.kit-select__button'), null);
  assert.equal(touch.d.querySelector('[name=contactChannel]').dataset.kitSelect, 'native');
  touch.w.close();
  const { w, d } = await mount('<div id="x"></div>');
  d.getElementById('x').innerHTML = '<label>Повод<select name="occasion"><option>День рождения</option></select></label>';
  await new Promise((r) => w.setTimeout(r, 0));
  assert.ok(d.querySelector('.kit-select__button'), 'select, добавленный скриптом сайта (квиз), тоже оформлен');
  w.close();
});

test('select.js: поиск по буквам при скрытом выбранном пункте-подсказке не падает', async () => {
  const { w, d } = await mount(`<form><label>Повод<select name="r"><option value="" hidden selected>Выберите</option>
    <option value="b">Букет</option><option value="t">Телеграм</option><option value="tt">Тест</option></select></label></form>`);
  const select = d.querySelector('[name=r]');
  const button = d.querySelector('.kit-select__button');
  // Нет совпадения на первой букве — выбранным остаётся скрытый пункт, вторая буква раньше давала TypeError.
  // Исключение в обработчике события не всплывает в dispatchEvent — ловим его как ошибку окна.
  const errors = [];
  w.addEventListener('error', (e) => { errors.push(e.error || e.message); e.preventDefault(); });
  key(w, button, 'х'); key(w, button, 'х');
  assert.deepEqual(errors.map(String), []);
  assert.equal(select.value, '');
  w.close();
  const again = await mount(`<form><label>Повод<select name="r"><option value="" hidden selected>Выберите</option>
    <option value="b">Букет</option><option value="t">Телеграм</option><option value="tt">Тест</option></select></label></form>`);
  const b2 = again.d.querySelector('.kit-select__button');
  for (const k of ['т', 'е', 'с']) key(again.w, b2, k);
  assert.equal(again.d.querySelector('[name=r]').value, 'tt', 'быстрый набор «тес» находит «Тест»');
  again.w.close();
});

test('select.js: aria-label — подпись рядом или подсказка, но не техническое имя поля', async () => {
  const { w, d } = await mount(`<div><label>Способ связи</label><select name="contactChannel"><option>A</option></select></div>
    <div><select name="channel2" data-placeholder="Куда написать"><option>A</option></select></div>
    <div><select name="channel3"><option value="">Как связаться</option><option>A</option></select></div>
    <div><select name="channel4"><option>A</option></select></div>`);
  const labels = [...d.querySelectorAll('.kit-select__button')].map((b) => b.getAttribute('aria-label'));
  assert.deepEqual(labels, ['Способ связи', 'Куда написать', 'Как связаться', null]);
  w.close();
});
