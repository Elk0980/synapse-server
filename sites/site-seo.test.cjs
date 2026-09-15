const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const norm = s => s.replace(/\s+/g, ' ').trim();
for (const [site, origin] of [['alvi', 'https://spaalvi-38.ru'], ['avokado3', 'https://avokado38.ru']]) {
  const read = file => fs.readFileSync(path.join(__dirname, site, file), 'utf8');
  for (const page of ['index.html', 'price.html']) {
    test(`${site}/${page}: indexable metadata, single H1 and correct canonical`, () => {
      const dom = new JSDOM(read(page), { url: origin });
      const d = dom.window.document;
      assert.equal(d.documentElement.lang, 'ru');
      assert.equal(d.querySelectorAll('h1').length, 1);
      assert.match(d.title, /Иркутск/);
      assert.ok(d.querySelector('meta[name="description"]').content.length > 60);
      assert.equal(d.querySelectorAll('link[rel="canonical"]').length, 1);
      assert.equal(d.querySelector('link[rel="canonical"]').href, origin + (page === 'index.html' ? '/' : '/price.html'));
      assert.doesNotMatch(d.querySelector('meta[name="robots"]')?.content || '', /noindex/);
      const image = new URL(d.querySelector('meta[property="og:image"]').content);
      assert.equal(image.origin, origin);
      assert.ok(fs.existsSync(path.join(__dirname, site, image.pathname)));
      dom.window.close();
    });
  }
  test(`${site}: all default FAQ answers and schema agree before JS`, () => {
    const dom = new JSDOM(read('index.html'));
    const d = dom.window.document;
    const nodes = [...d.querySelectorAll('script[type="application/ld+json"]')].flatMap(el => {
      const value = JSON.parse(el.textContent); return value['@graph'] || [value];
    });
    const faq = nodes.filter(node => node['@type'] === 'FAQPage');
    assert.equal(faq.length, 1);
    const details = [...d.querySelectorAll('#faq details')];
    assert.equal(faq[0].mainEntity.length, details.length);
    const fields = new Map(JSON.parse(read('data/site.json')).sections.flatMap(s => s.fields || []).map(f => [f.key, f.value]));
    details.forEach((el, i) => {
      assert.equal(faq[0].mainEntity[i].name, norm(el.querySelector('summary').textContent));
      assert.equal(faq[0].mainEntity[i].acceptedAnswer.text, norm(el.querySelector('p').textContent));
      for (const field of el.querySelectorAll('[data-edit]')) assert.equal(fields.get(field.dataset.edit), norm(field.textContent));
    });
    assert.ok(details.length >= 10);
    assert.ok(nodes.every(n => !n.aggregateRating && !n.hasOfferCatalog), 'no independent copies of third-party ratings or current prices');
    dom.window.close();
  });
  test(`${site}: edited, hidden and deleted FAQ answers update JSON-LD`, async () => {
    const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: origin });
    const w = dom.window, d = w.document;
    w.eval(read('faq-schema.js'));
    const result = () => JSON.parse(d.getElementById('faq-schema').textContent).mainEntity;
    const details = [...d.querySelectorAll('#faq details')];
    details[0].querySelector('p').textContent = 'Условия изменены владельцем.';
    details[1].hidden = true;
    details[2].querySelector('p').textContent = '';
    details[3].remove();
    await new Promise(resolve => w.setTimeout(resolve, 0));
    assert.equal(result().length, details.length - 3);
    assert.equal(result()[0].acceptedAnswer.text, 'Условия изменены владельцем.');
    details[1].hidden = false;
    await new Promise(resolve => w.setTimeout(resolve, 0));
    assert.equal(result().length, details.length - 2);
    assert.equal(JSON.parse(d.getElementById('faq-schema').textContent)['@id'], origin + '/#faq');
    w.close();
  });
  test(`${site}: sitemap URLs have existing pages on the published domain`, () => {
    assert.match(read('robots.txt'), new RegExp('Sitemap: ' + origin.replaceAll('.', '\\.') + '/sitemap.xml'));
    const urls = [...read('sitemap.xml').matchAll(/<loc>(.*?)<\/loc>/g)].map(m => new URL(m[1]));
    for (const url of urls) {
      assert.equal(url.origin, origin);
      assert.ok(fs.existsSync(path.join(__dirname, site, url.pathname === '/' ? 'index.html' : url.pathname)));
    }
  });
}
