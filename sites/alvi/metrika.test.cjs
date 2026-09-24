const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'metrika.js'), 'utf8');
function run(embedded) {
  const inserted = [];
  const win = {location: {search: embedded ? '?embedded=1' : ''}};
  win.parent = embedded ? {} : win;
  const document = {scripts: [], createElement: () => ({}), getElementsByTagName: () => [{parentNode: {insertBefore: node => inserted.push(node)}}], addEventListener() {}};
  const context = {window: win, document, URLSearchParams, setTimeout, Date};
  Object.defineProperty(context, 'ym', {get: () => win.ym});
  vm.runInNewContext(source, context);
  return {win, inserted};
}
test('обычная страница загружает один счётчик и инициализирует его', () => {
  const {win, inserted} = run(false);
  assert.equal(inserted.length, 1);
  assert.equal(win.ym.a.filter(call => call[1] === 'init').length, 1);
  assert.equal(win.ym.a[0][0], win.ALVI_METRIKA_ID);
});
test('встроенный прайс кабинета не отправляет посещение в Метрику', () => {
  const {win, inserted} = run(true);
  assert.equal(inserted.length, 0);
  assert.equal(win.ym, undefined);
});
test('публичные главная и прайс подключают общий загрузчик', () => {
  for (const page of ['index.html', 'price.html']) {
    const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
    assert.match(html, /<script src="metrika\.js(?:\?[^"\s]+)?" defer><\/script>/);
  }
});
