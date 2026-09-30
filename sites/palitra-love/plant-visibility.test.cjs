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
