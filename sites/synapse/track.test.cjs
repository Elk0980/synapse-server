const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tracker = fs.readFileSync(path.join(__dirname, 'track.js'), 'utf8');
function environment({framed = false, embedded = false, foreign = false, blocked = false, dnt = false, parentTouch} = {}) {
  const records = [], handlers = {}, scripts = [];
  const location = new URL('https://example.test/price.html' + (embedded ? '?embedded=1' : ''));
  const parent = {location: {origin: foreign ? 'https://cabinet.test' : location.origin},
    __synapseClientId: 'parent-cid', __synapseFirstTouch: parentTouch};
  const window = {parent, __synapseTrackLoaded: false, crypto: {randomUUID: () => 'new-cid'}};
  window.top = framed ? parent : window;
  const storage = new Map();
  const document = {referrer: framed ? 'https://example.test/' : 'https://link.2gis.ru/',
    currentScript: {getAttribute: () => 'alvi'},
    addEventListener: (type, fn) => {handlers[type] = fn;},
    createElement: () => ({setAttribute(k, v) {this[k] = v;}}),
    body: {appendChild(s) {scripts.push(s);}}};
  const navigator = {doNotTrack: dnt ? '1' : '0', sendBeacon(url, body) {
    records.push({url, body: JSON.parse(body.parts[0])}); return true;
  }};
  const localStorage = {getItem(key) {if (blocked) throw Error('blocked'); return storage.get(key) || null;},
    setItem(key, value) {if (blocked) throw Error('blocked'); storage.set(key, value);}};
  const context = {window, document, location, navigator, localStorage, URL, URLSearchParams,
    Date, Math, crypto: window.crypto, Blob: class {constructor(parts) {this.parts = parts;}}};
  return {context, records, scripts, handlers, window};
}
function click(env) {
  const link = {matches: () => false, hash: '', getAttribute: () => 'tel:+70000000000', textContent: '+70000000000'};
  env.handlers.click({target: {closest(selector) {return selector === 'a[href]' ? link : null;}}});
}

test('standalone traffic and contact click keep one identity and real referral source', () => {
  const env = environment({blocked: true}); vm.runInNewContext(tracker, env.context); click(env);
  assert.deepEqual(env.records.map(r => r.body.type), ['visit', 'click']);
  assert.ok(env.records.every(r => r.body.clientId === 'new-cid' && r.body.source === '2gis'));
  assert.equal(env.records[1].body.label, 'Телефон');
});
test('same-origin embedded price inherits parent identity and campaign without storage or duplicate visit', () => {
  const touch = {source: '2gis', utmSource: '2gis', utmMedium: 'paid_maps', utmCampaign: 'sample',
    landingPage: '/', referrer: 'https://link.2gis.ru/'};
  const env = environment({framed: true, embedded: true, blocked: true, parentTouch: touch});
  vm.runInNewContext(tracker, env.context); click(env);
  assert.equal(env.records.length, 1);
  const event = env.records[0].body;
  assert.equal(event.type, 'click'); assert.equal(event.clientId, 'parent-cid');
  assert.equal(event.utmCampaign, 'sample'); assert.equal(event.landingPage, '/');
  assert.equal(event.referrer, touch.referrer); assert.equal(event.source, '2gis');
});
test('cabinet preview, foreign frames and DNT emit no events', () => {
  for (const options of [{framed: true}, {framed: true, embedded: true, foreign: true}, {dnt: true}]) {
    const env = environment(options); vm.runInNewContext(tracker, env.context);
    assert.equal(env.records.length, 0); assert.equal(env.handlers.click, undefined);
  }
});
for (const company of ['alvi', 'avokado3']) {
  const html = fs.readFileSync(path.join(__dirname, '..', company, 'price.html'), 'utf8');
  const loader = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]).find(s => s.includes('synapse.synapsebusiness.ru/track.js'));
  test(`${company} real price loader enables own embedded clicks, blocks preview and foreign iframe`, () => {
    assert.ok(loader);
    for (const [options, expected] of [[{}, 1], [{framed: true, embedded: true}, 1],
      [{framed: true}, 0], [{framed: true, embedded: true, foreign: true}, 0]]) {
      const env = environment(options); vm.runInNewContext(loader, env.context);
      assert.equal(env.scripts.length, expected);
    }
  });
}
