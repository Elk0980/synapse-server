const test = require('node:test');
const assert = require('node:assert/strict');
const {storageKey, lifetime, readAttribution, decorateUrl, classify, start} = require('./attribution.js');
const now = Date.parse('2026-09-15T12:00:00Z');
const base = 'https://avokado38.ru/';
const booking = 'https://n396010.yclients.com/company/375899/personal/menu';
function memory(value) {
  const data = new Map(value ? [[storageKey, JSON.stringify(value)]] : []);
  return {getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key)};
}
test('current campaign replaces old tags and stays usable when storage is blocked', () => {
  const storage = {getItem() {throw Error();}, setItem() {throw Error();}};
  const result = readAttribution(new URL(base + '?utm_source=yandex&utm_content=creative-17&yclid=123'), '', storage, now);
  assert.equal(result.utm_source, 'yandex');
  assert.equal(result.utm_content, 'creative-17');
  assert.equal(result.yclid, '123');
  const saved = memory({...result, utm_campaign: 'old'});
  const next = readAttribution(new URL(base + '?utm_source=vk'), '', saved, now);
  assert.equal(next.utm_source, 'vk');
  assert.equal(next.utm_campaign, undefined);
  assert.equal(next.yclid, undefined);
});
test('campaign survives internal navigation for 30 days, then expires; internal referrals are ignored', () => {
  const original = {utm_source: 'yandex', utm_content: 'creative', first_seen: new Date(now).toISOString()};
  assert.deepEqual(readAttribution(new URL(base + 'price.html'), base, memory(original), now + 1000), original);
  assert.deepEqual(readAttribution(new URL(base + 'price.html?utm_source=yandex&utm_content=creative'), base, memory(original), now + 1000), original);
  assert.deepEqual(readAttribution(new URL(base), base + 'price.html', memory(original), now + lifetime), {});
  assert.deepEqual(readAttribution(new URL(base), base + 'price.html', memory(), now), {});
  assert.equal(readAttribution(new URL(base), 'https://avokado38.ru.example.com/path', memory(), now).utm_source, 'avokado38.ru.example.com');
});
test('booking keeps campaign content separate from entry point and preserves booking parameters', () => {
  const url = new URL(decorateUrl(booking + '?staff=23&utm_content=sticky_cta#choose', base,
    {utm_source: 'yandex', utm_content: 'banner-A', yclid: '123'}, 'sticky_cta'));
  assert.equal(url.searchParams.get('utm_content'), 'banner-A');
  assert.equal(url.searchParams.get('entry_point'), 'sticky_cta');
  assert.equal(url.searchParams.get('staff'), '23');
  assert.equal(url.searchParams.get('yclid'), '123');
  assert.equal(url.hash, '#choose');
});
test('internal page links carry tags without modifying messengers, unrelated sites or same-page anchors', () => {
  const tags = {utm_source: 'yandex', utm_campaign: 'launch'};
  const price = new URL(decorateUrl('price.html#laser', base, tags, ''));
  assert.equal(price.searchParams.get('utm_campaign'), 'launch');
  assert.equal(price.hash, '#laser');
  for (const href of ['#contacts', 'https://wa.me/123', booking.replace('yclients.com', 'yclients.com.evil.example'), 'privacy.html', 'tel:+79331901059']) {
    assert.equal(decorateUrl(href, base, tags, 'x'), href);
  }
});
test('conversion classification uses exact destinations and no contact values in events', () => {
  assert.deepEqual(classify(booking, base), {event: 'booking_click', channel: 'yclients'});
  assert.deepEqual(classify('tel:+79331901059', base), {event: 'phone_click', channel: 'phone'});
  assert.deepEqual(classify('https://vk.com/lasermkt', base), {event: 'messenger_click', channel: 'vk'});
  assert.deepEqual(classify('price.html#laser', base), {event: 'price_click'});
  assert.equal(classify('#laser', base + 'price.html'), null);
  assert.equal(classify('https://t.me.evil.example/person', base), null);
});
test('dynamic catalogue and CMS updates are attributed; one delegated event per click with no pageview duplicate', () => {
  const handlers = {}; let onMutation;
  function anchor(href, point = '') {
    return {attrs: {href, 'data-entry-point': point}, getAttribute(k) {return this.attrs[k];}, setAttribute(k, v) {this.attrs[k] = v;},
      matches: () => true, closest() {return this;}};
  }
  const initial = anchor(booking, 'sticky_cta');
  const win = {location: new URL(base + '?utm_source=yandex&utm_content=creative'), localStorage: memory(), navigator: {},
    MutationObserver: class {constructor(fn) {onMutation = fn;} observe() {}}};
  const doc = {body: {}, referrer: '', querySelectorAll: () => [initial], addEventListener: (k, fn) => {handlers[k] = fn;}};
  start(win, doc); start(win, doc);
  assert.equal(win.dataLayer, undefined);
  const added = anchor(booking, 'catalog_laser');
  onMutation([{type: 'childList', addedNodes: [added]}]);
  assert.equal(new URL(added.attrs.href).searchParams.get('utm_content'), 'creative');
  added.attrs.href = booking + '?staff=2';
  onMutation([{type: 'attributes', target: added}]);
  handlers.click({target: added, button: 0});
  assert.deepEqual(win.dataLayer, [{event: 'booking_click', channel: 'yclients', entry_point: 'catalog_laser'}]);
  assert.equal(new URL(added.attrs.href).searchParams.get('staff'), '2');
  const beforeMutation = anchor(booking, 'catalog_new');
  handlers.auxclick({target: beforeMutation, button: 1});
  assert.equal(new URL(beforeMutation.attrs.href).searchParams.get('utm_source'), 'yandex');
  assert.equal(win.dataLayer.length, 2);
  handlers.auxclick({target: beforeMutation, button: 2});
  assert.equal(win.dataLayer.length, 2);
});
test('full-price view is emitted once; do-not-track suppresses events while navigation still works', () => {
  for (const doNotTrack of [undefined, '1']) {
    const handlers = {};
    const win = {location: new URL(base + 'price.html'), localStorage: memory(), navigator: {doNotTrack}};
    const doc = {body: {}, referrer: base, querySelectorAll: () => [], addEventListener: (k, fn) => {handlers[k] = fn;}};
    start(win, doc); start(win, doc);
    assert.deepEqual(win.dataLayer, doNotTrack ? undefined : [{event: 'price_view', entry_point: 'price_page'}]);
  }
});
