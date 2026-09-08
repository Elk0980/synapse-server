// QA dependency only: npm install --prefix /tmp/palitra-dom-qa jsdom
// NODE_PATH=/tmp/palitra-dom-qa/node_modules node --test sites/synapse/price-editor-palitra-sections.test.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, 'price-editor-palitra.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, 'price-render-palitra.js'), 'utf8');
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../palitra-love/data/price.json'), 'utf8'));

test('editor lists all categories and adds an item to each existing empty category', async () => {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {url: 'https://cabinet.test/price-editor-palitra.html', runScripts: 'outside-only', virtualConsole: vc});
  const w = dom.window;
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.CSS = {escape: value => value};
  w.prompt = () => { throw new Error('Creating a duplicate category must not be necessary'); };
  w.fetch = async (url, opts = {}) => {
    assert.equal(opts.method || 'GET', 'GET', 'this test must never save client data');
    const body = url === '/content/whoami'
      ? {role: 'owner', csrfToken: 'synthetic-csrf-only'}
      : structuredClone(seed);
    return {ok: true, status: 200, json: async () => body};
  };
  try {
    w.eval(renderer);
    w.eval(code);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    const d = w.document;
    function assertCategories() {
      const sections = [...d.querySelectorAll('#ed-content section[data-cat]')];
      assert.deepEqual(sections.map(section => section.dataset.cat), seed.categories.map(category => category.id));
      for (const category of seed.categories) {
        const links = d.querySelectorAll('#ed-nav a[href="#' + category.id + '"]');
        assert.equal(links.length, 1, category.id + ' has exactly one menu entry');
        assert.ok(links[0].textContent.startsWith(category.title));
      }
    }
    assertCategories();
    for (const category of seed.categories.filter(category => !category.items.length)) {
      const section = d.querySelector('[data-cat="' + category.id + '"]');
      assert.match(section.textContent, /В этом разделе пока нет позиций/);
      section.querySelector('[data-additem="' + category.id + '"]').click();
      const updated = d.querySelector('[data-cat="' + category.id + '"]');
      assert.equal(updated.querySelectorAll('article[data-id]').length, 1);
      assert.ok(updated.querySelector('form[data-form]'), 'new item opens for editing in ' + category.id);
      assertCategories();
    }
    // Public rendering still hides empty categories; only editor navigation changes.
    const publicNav = d.createElement('ul');
    publicNav.innerHTML = w.PalitraPrice.renderNav(seed);
    assert.equal(publicNav.querySelectorAll('a').length, seed.categories.filter(category => category.items.length).length);
    assert.deepEqual(errors, []);
  } finally { w.close(); }
});
