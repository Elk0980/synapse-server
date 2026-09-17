const test = require('node:test');
const assert = require('node:assert/strict');
const { entries, card, schema, removeProductLists, mount } = require('./catalog-live.js');
const data = { categories: [
  { id: 'bukety', title: 'Букеты', items: [{ id: 'old', title: 'Букет', price: '3 290 руб.', photo: '/api/assets/a.jpg' }] },
  { id: 'dr-detyam', title: 'Детям', items: [{ id: 'new', title: 'Товар №001', price: '', photo: '/api/assets/b.jpg' }] },
  { id: 'prochee', title: 'Другое', items: [{ id: 'other', title: '<script>oops</script>', price: '', photo: 'javascript:bad' }] }
] };
test('catalog uses all saved products and category routes select the correct items', () => {
  assert.equal(entries(data, '/catalog/').length, 3);
  assert.deepEqual(entries(data, '/catalog/bukety/index.html').map(x => x.id), ['old']);
  assert.deepEqual(entries(data, '/catalog/shary').map(x => x.id), ['new']);
  assert.deepEqual(entries(data, '/catalog/den-rozhdeniya/').map(x => x.id), ['new']);
});
test('placeholder price remains unknown, existing exact price is preserved and content is escaped', () => {
  const list = entries(data, '/catalog');
  assert.match(card(list[0]), /3 290 руб\./);
  assert.match(card(list[1]), /Цена уточняется/);
  assert.doesNotMatch(card(list[2]), /<script>|javascript:/);
});
test('structured list matches saved product images without inventing availability or prices', () => {
  const result = schema(entries(data, '/catalog/shary'), 'https://palitra-love.synapsebusiness.ru', '/catalog/shary');
  assert.equal(result.numberOfItems, 1);
  assert.equal(result.itemListElement[0].item.image, 'https://palitra-love.synapsebusiness.ru/api/assets/b.jpg');
  assert.equal(result.itemListElement[0].item.offers, undefined);
  assert.deepEqual(removeProductLists([{ '@type': 'ItemList' }, { '@type': 'BreadcrumbList' }]), [{ '@type': 'BreadcrumbList' }]);
});
test('live catalog renders saved items in the actual catalog page and keeps filter/schema synchronized', async () => {
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs');
  const path = require('node:path');
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../catalog/index.html'), 'utf8'), {
    url: 'https://palitra-love.synapsebusiness.ru/catalog', runScripts: 'outside-only'
  });
  dom.window.PALITRA_CONFIG = { SITE_URL: dom.window.location.origin };
  dom.window.eval(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'));
  dom.window.PalitraPrice = { load: async () => data };
  await mount(dom.window);
  assert.equal(dom.window.document.querySelectorAll('[data-products] .card').length, 3);
  dom.window.document.querySelector('[data-filter="bukety"]').click();
  assert.equal(dom.window.document.querySelectorAll('[data-products] .card:not(.hidden)').length, 1);
  const savedSchema = JSON.parse(dom.window.document.getElementById('palitra-catalog-schema').textContent);
  assert.equal(savedSchema.numberOfItems, 1);
  assert.equal(savedSchema.itemListElement[0].item.name, 'Букет');
  dom.window.close();
});
