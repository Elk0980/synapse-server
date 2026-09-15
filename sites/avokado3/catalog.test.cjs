const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');

const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const defaults = JSON.parse(read('data/price.json'));
const copy = value => JSON.parse(JSON.stringify(value));
const items = doc => doc.categories.flatMap(cat => cat.items);
const item = (doc, id) => items(doc).find(it => it.id === id);
const context = vm.createContext({window: {}, URL, location: {href: 'https://avokado3.synapsebusiness.ru/'}, document: {getElementById() { return null; }}});
vm.runInContext(read('price-render.js'), context);
context.AlviPrice = context.window.AlviPrice;
vm.runInContext(read('catalog.js'), context);
const {prepare, render} = context.window.AvokadoCatalog;

test('help and certificate actions open Contacts on the correct page', () => {
  for (const full of [false,true]) {
    const html=render(defaults,full);
    const links=[...html.matchAll(/<a\b[^>]*data-contact-route[^>]*>/g)].map(m=>m[0]);
    assert.ok(links.length>=7);
    for(const link of links){
      assert.equal(link.match(/href="([^"]+)"/)[1],full?'index.html#contacts':'#contacts');
      assert.ok(!link.includes('target="_blank"'));
    }
  }
});

test('all services and selected cards remain reachable; prices propagate to both pages', () => {
  const home = render(defaults, false), full = render(defaults, true);
  assert.equal(items(defaults).length, 48);
  assert.equal((home.match(/data-service=/g) || []).length, 6);
  assert.equal((full.match(/data-service=/g) || []).length, 48);
  const ids = [...full.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const group of ['laser','apparatus','manual','certificate']) assert.ok(ids.includes(group));
  const changed = copy(defaults);item(changed, 'first-1').price = '777 ₽';
  assert.ok(render(changed, false).includes('777 ₽'));
  assert.ok(render(changed, true).includes('777 ₽'));
  changed.showcase.self = changed.showcase.self.filter(id => id !== 'first-1');
  changed.showcase.two = changed.showcase.two.filter(id => id !== 'first-1');
  assert.ok(!render(changed, false).includes('data-service="first-1"'));
  assert.ok(render(changed, true).includes('data-service="first-1"'));
});

test('laser duration is hidden in cards and tables; massage keeps it', () => {
  for (const full of [false, true]) {
    const html = render(defaults, full);
    const laser = html.slice(html.indexOf('id="laser"'), html.indexOf('id="apparatus"'));
    assert.ok(!laser.includes('<dt>Время</dt>'));
    assert.ok(!laser.includes('<th>Время</th>'));
    assert.ok(!laser.includes('45 мин'));
    const massage = html.slice(html.indexOf('id="apparatus"'), html.indexOf('id="manual"'));
    assert.ok(massage.includes('<dt>Время</dt><dd>45 мин</dd>'));
    if (full) assert.ok(laser.includes('av-table--no-duration'));
  }
});

test('legacy promotions become 45 minutes without altering regular services or prices', () => {
  const legacy = copy(defaults);legacy.catalogVersion = 2;
  item(legacy, 'first-1').duration = '60 мин';item(legacy, 'first-1').title = 'ТУРБО-массаж всего тела · 60 мин';
  item(legacy, 'first-3').duration = '60 мин';item(legacy, 'first-3').title = 'Ручной массаж · 60 мин';
  item(legacy, 'laser-offers-1').duration = '';
  item(legacy, 'first-1').price = '555 ₽';
  const before = JSON.stringify(legacy);
  const prepared = prepare(legacy, defaults);
  assert.equal(JSON.stringify(legacy), before, 'input is not mutated');
  assert.equal(prepared.catalogVersion, 3);
  assert.equal(items(prepared).filter(it => it.promo).length, 8);
  for (const it of items(prepared).filter(it => it.promo)) assert.equal(it.duration, '45 мин');
  for (const it of items(legacy).filter(it => !it.promo)) assert.equal(JSON.stringify(item(prepared, it.id)), JSON.stringify(it));
  assert.equal(item(prepared, 'first-1').price, '555 ₽');
  assert.equal(item(prepared, 'first-1').title, 'ТУРБО-массаж всего тела · 45 мин');
  assert.equal(item(prepared, 'first-3').title, 'Ручной массаж · 45 мин');
});

test('the correction also works for older API data and without static fallback', () => {
  const legacy = copy(defaults);delete legacy.catalogVersion;
  for (const it of items(legacy)) { delete it.photo;delete it.promo;delete it.direction; }
  item(legacy, 'first-1').duration = '60 мин';
  item(legacy, 'first-1').title = 'ТУРБО-массаж всего тела · 60 мин';
  const prepared = prepare(legacy, defaults);
  assert.equal(item(prepared, 'first-1').duration, '45 мин');
  assert.equal(item(prepared, 'first-1').promo, true);
  assert.equal(item(prepared, 'first-1').photo, item(defaults, 'first-1').photo);
  assert.equal(item(prepare(legacy, null), 'first-1').duration, '45 мин');
  assert.equal(prepare(null, defaults), defaults);
  assert.equal(prepare(null, null), null);
});

test('future saved edits survive reloads after the one-time correction', () => {
  const saved = copy(defaults);item(saved, 'first-1').duration = '50 мин';
  item(saved, 'first-1').title = 'Обновлённая процедура · 50 мин';
  assert.equal(prepare(saved, defaults), saved);
  assert.ok(render(prepare(saved, defaults), false).includes('<dd>50 мин</dd>'));
});

test('edited content is escaped and an empty certificate has a usable fallback', () => {
  const changed = copy(defaults);item(changed, 'first-1').title = '<img src=x onerror=alert(1)>';
  item(changed, 'first-1').card = '<img src=x onerror=alert(1)>';
  for (const full of [false, true]) {
    const html = render(changed, full);
    assert.ok(html.includes('&lt;img'));
    assert.ok(!html.includes('<img src=x'));
  }
  changed.certificates = {};
  assert.ok(render(changed, true).includes('Обсудить сертификат'));
});
