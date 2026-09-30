const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('подтверждённые растения и безымянный букет из Прочего скрыты, шары остаются, редактор сохраняет оригинал', () => {
  const context = {window: {}};
  for (const file of ['config.js', 'price-render.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  // Регрессия по восьми пропущенным публичным товарам; каталог содержит и общие названия.
  const plants = [
    ['import-tg-372-1', 'Фикус 40 см'], ['import-tg-372-2', 'Фикус 20 см'],
    ['import-tg-372-4', 'Антуриум'], ['import-tg-372-5', 'Суккулент'],
    ['import-tg-372-6', 'Драцена'], ['import-tg-372-7', 'Гузмания'],
    ['import-tg-379-1', 'Луковица амариллиса'], ['import-tg-389-1', 'Товар №111']
  ].map(([id, title]) => ({id, title, photo: `/api/assets/${id}.webp`, price: 'Цена уточняется'}));
  const balloons = [{id: 'balloon-bouquet', title: 'Букет шаров'}, {id: 'balloon-flower', title: 'Цветок из шаров'},
    {id: 'import-tg-366-3', title: 'Товар №110'}];
  const price = {categories: [{id: 'prochee', title: 'Прочее', items: [...plants, ...balloons]}]};
  const before = JSON.stringify(price), api = context.window.PalitraPrice;
  assert.deepEqual(Array.from(api.publicData(price).categories[0].items, item => item.id), balloons.map(item => item.id));
  const html = api.renderSections(price);
  for (const item of plants) assert.ok(!html.includes(item.id), item.id + ' не показывается');
  for (const item of balloons) assert.ok(html.includes(item.id), item.id + ' сохраняется');
  assert.equal(api.publicData(price, {editor: true}), price);
  context.window.PALITRA_CONFIG.FLOWERS_VISIBLE = true;
  assert.equal(api.publicData(price), price);
  assert.equal(JSON.stringify(price), before);
});

test('смешанный заказ import-tg-753-1 (шары + букет роз в кадре) скрыт обратимо, соседние шары остаются', () => {
  const context = {window: {}};
  for (const file of ['config.js', 'price-render.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  const mixed = {id: 'import-tg-753-1', title: 'Шары на день рождения', price: '6 290 руб.', photo: '/api/assets/mu57htwc-import-tg-753-1.webp'};
  const balloons = [{id: 'import-tg-674-1', title: 'Шары на День рождения девушке', price: '8 990 руб.', photo: '/api/assets/import-tg-674-1.webp'},
    {id: 'import-tg-713-1', title: 'Индивидуальный заказ шариков на день рождения', price: '26 870 руб.', photo: '/api/assets/import-tg-713-1.webp'}];
  const price = {categories: [{id: 'dr-zhenschine', title: 'День рождения женщине', items: [mixed, balloons[0]]},
    {id: 'dr-muzhchine', title: 'День рождения мужчине', items: [balloons[1]]}]};
  const before = JSON.stringify(price), api = context.window.PalitraPrice;
  const visible = api.publicData(price).categories.flatMap(cat => cat.items.map(item => item.id));
  assert.deepEqual(visible, balloons.map(item => item.id));
  assert.ok(!api.renderSections(price).includes('import-tg-753-1'), 'смешанный товар не показывается');
  assert.equal(api.publicData(price, {editor: true}), price, 'редактор видит исходный прайс');
  context.window.PALITRA_CONFIG.FLOWERS_VISIBLE = true;
  assert.equal(api.publicData(price), price, 'обратимо через FLOWERS_VISIBLE');
  assert.equal(JSON.stringify(price), before, 'исходные данные и цена не меняются');
});
