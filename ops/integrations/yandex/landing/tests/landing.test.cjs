'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const manifest = JSON.parse(read('BASE_MANIFEST.json'));
const price = JSON.parse(read('fixtures/public/price-live.json'));
function moduleFrom(name) {
  const module = {exports: {}};
  vm.runInNewContext(read(name), {module, URL, URLSearchParams, TextEncoder, console}, {filename: name});
  return module.exports;
}
const api = moduleFrom('avokado-yandex-landing.js');
const callback = moduleFrom('fixtures/public/callback.js');
const attribution = moduleFrom('fixtures/public/attribution.js');
const pages = ['turbo-massazh-irkutsk.html', 'apparatnyy-massazh-irkutsk.html'];
function offerItem(data) { return data.categories.find(c => c.id === 'first-visit').items.find(i => i.id === 'first-1'); }
function fakeDoc() {
  const nodes = new Map();
  return {nodes, querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {textContent: '', hidden: true, attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; },
      set innerHTML(_) { throw new Error('UNSAFE_HTML_WRITE'); }});
    return nodes.get(selector);
  }};
}

test('both pages contain the exact current callback section and distinct relevant H1', () => {
  const exact = read('fixtures/callback-section.html');
  for (const name of pages) {
    const html = read(name);
    assert.equal(html.match(/<section class="av-callback" id="callback"[\s\S]*?<\/section>/)[0], exact);
    assert.equal((html.match(/data-callback-form/g) || []).length, 1);
    assert.match(html, /<body data-company-code="avokado">/);
    assert.match(html, /src="\/callback\.js\?v=20261001-goals"/);
    assert.match(html, /src="\/attribution\.js\?v=20261001-goals"/);
    assert.doesNotMatch(html, /name="consent"[^>]*\bchecked\b/);
    assert.doesNotMatch(html, /500|2\s?100|<script(?![^>]*src=)[^>]*>/);
  }
  assert.match(read(pages[0]), /<h1 id="landing-title">ТУРБО-массаж в Иркутске<\/h1>/);
  assert.match(read(pages[1]), /<h1 id="landing-title">Аппаратный массаж в Иркутске<\/h1>/);
});

test('copied runtime bytes and callback section match the explicit BASE manifest', () => {
  for (const name of ['callback.js', 'attribution.js', 'price-live.json']) {
    const pin = manifest.files.find(file => file.name === name);
    const raw = fs.readFileSync(path.join(ROOT, 'fixtures/public', name));
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), pin.sha256);
    assert.equal(raw.length, pin.bytes);
  }
  assert.equal(crypto.createHash('sha256').update(read('fixtures/callback-section.html')).digest('hex'), manifest.callbackSectionSha256);
});

test('shared module accepts only the reviewed live first-visit/first-1 offer', async () => {
  const actual = await api.validateOffer(price, crypto.webcrypto.subtle);
  const source = offerItem(price);
  assert.equal(actual.price, source.price);
  assert.equal(actual.description, source.desc);
  assert.equal(actual.conditions, source.composition);
  assert.equal(actual.minutes, '45');
  assert.equal(api.PRICE_PATH, '/api/price');
  assert.equal(api.OFFER_CONTRACT_SHA, manifest.offerContractSha256);
  assert.equal(actual.priceLink, '/price.html#first-1');
});

test('price, duration, composition changes and duplicate/missing IDs fail closed', async () => {
  const variations = [
    data => { offerItem(data).price = '650 ₽'; },
    data => { offerItem(data).duration = '60 мин'; },
    data => { offerItem(data).desc += ' Гарантированное похудение.'; },
    data => { offerItem(data).composition = 'Для любого повторного визита'; },
    data => { data.categories.find(c => c.id === 'first-visit').items.push(clone(offerItem(data))); },
    data => { data.categories.find(c => c.id === 'first-visit').items = []; },
    data => { data.categories.push(clone(data.categories.find(c => c.id === 'first-visit'))); },
  ];
  for (const change of variations) {
    const data = clone(price); change(data);
    await assert.rejects(api.validateOffer(data, crypto.webcrypto.subtle));
  }
});

test('booking URL rejects executable, substituted tenant, credential and query URLs', async () => {
  const source = price.links.book;
  assert.equal(api.safeBooking(source), source);
  for (const value of ['javascript:alert(1)', '//n396010.yclients.com/', 'https://evil.example/',
    source + '?redirect=https://evil.example', source.replace('n396010', 'n999999'),
    source.replace('https://', 'https://user:password@'), source + '#x']) {
    assert.throws(() => api.safeBooking(value));
  }
  const data = clone(price); data.links.book = 'javascript:alert(1)';
  await assert.rejects(api.validateOffer(data, crypto.webcrypto.subtle));
});

test('HTML injected into an API field is rejected; successful rendering uses textContent', async () => {
  const data = clone(price); offerItem(data).price = '<img src=x onerror=alert(1)>';
  await assert.rejects(api.validateOffer(data, crypto.webcrypto.subtle));
  const doc = fakeDoc();
  api.render(doc, await api.validateOffer(price, crypto.webcrypto.subtle));
  assert.equal(doc.querySelector('[data-offer-price]').textContent, offerItem(price).price);
  assert.equal(doc.querySelector('[data-offer-content]').hidden, false);
  assert.equal(doc.querySelector('[data-offer-booking]').attrs.href, price.links.book);
});

test('fallback clears previously rendered price and removes booking URL', async () => {
  const doc = fakeDoc();
  api.render(doc, await api.validateOffer(price, crypto.webcrypto.subtle));
  api.unavailable(doc);
  assert.equal(doc.querySelector('[data-offer-price]').textContent, '');
  assert.equal(doc.querySelector('[data-offer-description]').textContent, '');
  assert.equal(doc.querySelector('[data-offer-content]').hidden, true);
  assert.equal(doc.querySelector('[data-offer-fallback]').hidden, false);
  assert.equal(doc.querySelector('[data-offer-booking]').attrs.href, undefined);
});

test('price fetch is GET-only, same-origin, no credentials, and clears its timeout', async () => {
  const calls = []; let cleared = 0;
  const win = {crypto: crypto.webcrypto, AbortController, setTimeout: () => 99,
    clearTimeout: token => { assert.equal(token, 99); cleared++; },
    fetch: async (...args) => { calls.push(args); return {ok: true, text: async () => JSON.stringify(price)}; }};
  await api.loadOffer(win);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/price');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(cleared, 1);
});

test('unavailable/invalid API response never exposes a static price', async () => {
  for (const response of [{ok: false}, {ok: true, text: async () => '<html>error</html>'},
    {ok: true, text: async () => JSON.stringify({categories: []})}]) {
    const doc = fakeDoc(); let cleared = false;
    const win = {crypto: crypto.webcrypto, AbortController, setTimeout: () => 1,
      clearTimeout: () => { cleared = true; }, fetch: async () => response};
    await api.start(win, doc);
    assert.equal(doc.querySelector('[data-offer-content]').hidden, true);
    assert.equal(doc.querySelector('[data-offer-price]').textContent, '');
    assert.equal(cleared, true);
  }
});

test('existing attribution propagates all five UTM and yclid without duplication', () => {
  const href = 'https://avokado38.ru/turbo-massazh-irkutsk.html?utm_source=yandex&utm_medium=cpc&utm_campaign=local_fixture&utm_content=t01a&utm_term=turbo&yclid=local_fixture_click';
  const storage = {getItem: () => null, setItem() {}};
  const tags = attribution.readAttribution({href}, '', storage, Date.now());
  const next = new URL(attribution.decorateUrl(price.links.book, href, tags, 'landing-booking'));
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'yclid']) {
    assert.equal(next.searchParams.get(key), new URL(href).searchParams.get(key));
    assert.equal(next.searchParams.getAll(key).length, 1);
  }
});

test('exact existing callback keeps company/source/UTM and explicit consent contract', () => {
  const location = {href: 'https://avokado38.ru/apparatnyy-massazh-irkutsk.html?utm_source=yandex&utm_medium=cpc&utm_campaign=local_fixture&utm_content=t02a&utm_term=apparatus&yclid=local_fixture_click',
    origin: 'https://avokado38.ru', pathname: '/apparatnyy-massazh-irkutsk.html'};
  const values = {name: 'LOCAL_FIXTURE_ONLY', contact: '+7 000 000-00-00', comment: '', consent: true};
  const payload = callback.payload(values, location, {getItem: () => null});
  assert.equal(payload.companyCode, 'avokado');
  assert.equal(payload.source, 'yandex');
  assert.equal(payload.utmContent, 't02a');
  assert.equal(payload.utmTerm, 'apparatus');
  assert.equal(payload.landingPage, 'https://avokado38.ru/apparatnyy-massazh-irkutsk.html');
  assert.equal(payload.yclid, undefined); // Documented existing limitation, not invented support.
  assert.throws(() => callback.payload({...values, consent: false}, location, {getItem: () => null}));
  assert.equal(callback.outcomeGoal({id: 1, repeated: false}), 'callback_submit');
  assert.equal(callback.outcomeGoal({id: 1, repeated: true}), 'callback_duplicate');
});

test('all static links are same-site/legal/telephone and no fixture hooks enter production', () => {
  for (const name of pages) {
    const html = read(name);
    for (const match of html.matchAll(/\bhref="([^"]*)"/g)) {
      const url = new URL(match[1], 'https://avokado38.ru/' + name);
      assert.ok(url.protocol === 'tel:' || (url.protocol === 'https:' && url.origin === 'https://avokado38.ru'));
    }
    assert.doesNotMatch(html, /__fixture__|__metrikaReady|local_fixture/i);
  }
  assert.doesNotMatch(read('avokado-yandex-landing.js'), /__fixture__|__metrikaReady|fetch\(['"]\/api\/leads/);
});

test('all same-page anchors, including the exact callback fallback link, exist once', () => {
  for (const name of pages) {
    const html = read(name);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const match of html.matchAll(/\bhref="#([^"]+)"/g)) {
      assert.equal(ids.filter(id => id === match[1]).length, 1, name + ': #' + match[1]);
    }
    assert.ok(ids.includes('callback'));
    assert.ok(ids.includes('contact-messengers'));
  }
});
