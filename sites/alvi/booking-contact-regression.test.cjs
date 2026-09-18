const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { start } = require('../synapse/company-links.js');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');

for (const page of ['index.html', 'price.html']) {
  test(`${page}: booking buttons keep contact destinations after rendering and CRM refresh`, async t => {
    const dom = new JSDOM(read(page), { url: `https://spaalvi-38.ru/${page}`, runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const w = dom.window;
    const expected = page === 'index.html' ? '#contacts' : 'index.html#contacts';
    const check = () => {
      const buttons = [...w.document.querySelectorAll('a[data-company-link="booking"]')];
      assert.ok(buttons.length >= 9);
      for (const button of buttons) {
        assert.equal(button.getAttribute('href'), expected);
        assert.notEqual(button.getAttribute('target'), '_blank');
      }
    };
    check();
    const data = JSON.parse(read('data/price.json'));
    data.links = { ...data.links, book: 'https://n1070017.yclients.com/' };
    w.eval(read('price-render.js'));
    const rendered = w.document.createElement('div');
    rendered.innerHTML = w.AlviPrice.renderSections(data);
    w.document.body.append(rendered);
    check();
    w.fetch = async () => ({ ok: true, json: async () => ({
      companyCode: 'alvi', links: { booking: 'https://n1070017.yclients.com/' }
    }) });
    start(w, w.document);
    await new Promise(resolve => w.setTimeout(resolve, 0));
    check();
  });
}
