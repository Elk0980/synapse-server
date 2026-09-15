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
  assert.equal(items(defaults).length, 47);
  assert.equal((home.match(/data-service=/g) || []).length, 6);
  assert.equal((full.match(/data-service=/g) || []).length, 47);
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

test('saved offer terms remain visible next to the price when mobile details are closed', () => {
  for (const full of [false, true]) {
    const trialCard = data => render(data, full).match(/<article\b[^>]*data-service="first-1"[\s\S]*?<\/article>/)[0];
    const html = trialCard(defaults);
    const terms = item(defaults, 'first-1').composition;
    const visible = html.replace(/<details\b[\s\S]*?<\/details>/g, '');
    assert.ok(visible.includes(terms), 'first-visit condition survives collapsed details');
    assert.ok(visible.indexOf('500 ₽') < visible.indexOf(terms), 'condition follows its price');
    assert.equal(html.split(terms).length - 1, 1, 'no repeated condition inside details');
    const changed = copy(defaults);
    item(changed, 'first-1').composition = 'Условия владельца <акция>';
    item(changed, 'first-1').price = '777 ₽';
    const updated = trialCard(changed);
    assert.ok(updated.includes('Условия владельца &lt;акция&gt;'));
    assert.ok(updated.includes('777 ₽'));
    assert.ok(!updated.includes(terms), 'does not replace saved terms with hardcoded first-visit copy');
    item(changed, 'first-1').composition = '';
    assert.ok(!trialCard(changed).includes('av-offer-terms'), 'owner can remove the field');
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

// Public Yclients company 375899: service IDs 16141950, 16141952, 16141953,
// 16141954, 16141957, 16141955, 16141956, 16141958 (2026-09-15).
const verifiedCombos = [
  ['laser-combo-1', 'Подмышки + тотальное бикини.'],
  ['laser-combo-2', 'Голени + тотальное бикини.'],
  ['laser-combo-3', 'Голени + подмышки.'],
  ['laser-combo-4', 'Подмышки + ноги полностью.'],
  ['laser-combo-5', 'Руки полностью + подмышки.'],
  ['laser-combo-6', 'Подмышки + голени + тотальное бикини.'],
  ['laser-combo-7', 'Подмышки + ноги полностью + тотальное бикини.'],
  ['laser-combo-8', 'Безлимит по зонам.'],
];

test('all eight verified combo descriptions sit with table names and follow selected home cards', () => {
  const selected = copy(defaults);
  selected.showcase = {self: verifiedCombos.map(([id]) => id), two: []};
  const full = render(selected, true), home = render(selected, false);
  for (const [id, desc] of verifiedCombos) {
    const service = item(defaults, id);
    assert.equal(service.desc, desc, id);
    const row = full.match(new RegExp(`<tr\\b[^>]*data-service="${id}"[\\s\\S]*?<\\/tr>`))[0];
    assert.ok(row.includes(`${service.title}<small>${desc}</small></th>`), `${id}: description belongs to the service name`);
    assert.ok(row.includes(`<td>${service.price}</td>`), `${id}: price is unchanged`);
    const card = home.match(new RegExp(`<article\\b[^>]*data-service="${id}"[\\s\\S]*?<\\/article>`))[0];
    assert.ok(card.includes(`<p class="av-description">${desc}</p>`), `${id}: same description on the home showcase`);
  }
});

test('saved v3 and newer catalogues backfill only empty combo descriptions without static fallback or input mutation', () => {
  for (const version of [3, 4]) {
    const saved = copy(defaults); saved.catalogVersion = version;
    for (const [index, [id]] of verifiedCombos.entries()) {
      const service = item(saved, id);
      if (index % 4 === 0) delete service.desc;
      else service.desc = [null, '', ' \n\t'][index % 4 - 1];
      service.price = `${700 + index} ₽`;
    }
    item(saved, 'first-1').duration = '50 мин';
    const before = JSON.stringify(saved), prepared = prepare(saved, null);
    assert.equal(JSON.stringify(saved), before, 'input remains intact');
    assert.equal(prepared.catalogVersion, version);
    for (const service of items(saved)) {
      const found = verifiedCombos.find(([id]) => id === service.id);
      const expected = found ? {...service, desc: found[1]} : service;
      assert.equal(JSON.stringify(item(prepared, service.id)), JSON.stringify(expected), service.id);
    }
    assert.equal(prepare(prepared, defaults), prepared, 'completed backfill does not rewrite future reloads');
  }
});

test('combo backfill respects owner descriptions, renamed services, custom IDs and other categories', () => {
  const saved = copy(defaults);
  item(saved, 'laser-combo-1').desc = 'Мой состав <текст владельца>';
  item(saved, 'laser-combo-2').title = 'Мой новый комплекс';
  item(saved, 'laser-combo-2').desc = '';
  item(saved, 'laser-combo-3').id = 'owner-combo';
  item(saved, 'owner-combo').desc = '';
  const moved = item(saved, 'laser-combo-4');
  moved.desc = '';
  saved.categories.find(cat => cat.id === 'laser-combo').items = saved.categories.find(cat => cat.id === 'laser-combo').items.filter(service => service !== moved);
  saved.categories.push({id: 'owner-category', title: 'Мой раздел', kind: 'table', block: 'self', items: [moved]});
  assert.equal(prepare(saved, defaults), saved, 'no matching empty standard service needs backfill');
  const html = render(prepare(saved, defaults), true);
  assert.ok(html.includes('Мой состав &lt;текст владельца&gt;'));
  assert.ok(!html.includes(verifiedCombos[0][1]));
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
  assert.ok(render(changed, true).includes('Выбрать сертификат'));
});

test('certificate action uses the approved label in defaults, legacy API documents and renderer fallback', () => {
  assert.equal(defaults.certificates.button, 'Выбрать сертификат');
  const legacy = copy(defaults); legacy.certificates.button = 'Обсудить сертификат';
  legacy.certificates.note = 'Сохранённые условия владельца';
  const before = JSON.stringify(legacy), prepared = prepare(legacy, null);
  assert.equal(JSON.stringify(legacy), before, 'legacy API input is not mutated');
  assert.equal(prepared.certificates.button, 'Выбрать сертификат');
  assert.equal(prepared.certificates.note, legacy.certificates.note);
  assert.equal(prepared.categories, legacy.categories, 'service names and prices remain untouched');
  for (const full of [false, true]) {
    assert.match(giftSection(legacy, full), /data-entry-point="catalog_certificate">Выбрать сертификат<\/a>/);
    assert.ok(!giftSection(prepared, full).includes('Обсудить сертификат'));
  }
  for (const button of ['Подарить SPA', 'Выбрать <свой> подарок']) {
    const edited = copy(defaults); edited.certificates.button = button;
    assert.equal(prepare(edited, defaults), edited, 'later custom captions are preserved');
    assert.ok(giftSection(edited, true).includes(context.AlviPrice.esc(button)));
  }
});

function legacyWithBuccal(){
  const legacy=copy(defaults),face=legacy.categories.find(cat=>cat.id==='face');
  face.items.splice(5,0,{id:'face-6',title:'Буккальный массаж',duration:'',price:'2 800 ₽'});
  legacy.showcase.self=legacy.showcase.self.map(id=>id==='face-7'?'face-6':id);
  return legacy;
}

test('only the former buccal service is removed and its showcase slot uses the existing chiroplastic massage',()=>{
  assert.equal(item(defaults,'face-6'),undefined);
  assert.equal(items(defaults).filter(it=>it.id==='face-7').length,1);
  assert.equal(item(defaults,'face-7').price,'2 800 ₽');
  for(const version of [2,3,4]){
    const legacy=legacyWithBuccal();legacy.catalogVersion=version;
    item(legacy,'face-7').price='Цена владельца';
    const before=JSON.stringify(legacy),prepared=prepare(legacy,null);
    assert.equal(JSON.stringify(legacy),before);
    assert.equal(item(prepared,'face-6'),undefined);
    assert.equal(item(prepared,'face-7').price,'Цена владельца');
    assert.deepEqual([...prepared.showcase.self],[...legacy.showcase.self.map(id=>id==='face-6'?'face-7':id)]);
    assert.equal(items(prepared).filter(it=>it.id==='face-7').length,1);
    for(const it of items(legacy).filter(it=>it.id!=='face-6'))assert.deepEqual(JSON.parse(JSON.stringify(item(prepared,it.id))),it);
    for(const full of [false,true]){
      const html=render(prepared,full);
      assert.ok(!html.includes('Буккальный массаж'));assert.ok(html.includes('Хиропластический массаж лица'));
    }
  }
  assert.ok(!read('index.html').includes('"name":"Буккальный массаж"'),'search metadata matches the public catalogue');
});

test('buccal removal preserves owner-renamed services, other IDs and categories without duplicating a selected replacement',()=>{
  for(const change of [
    doc=>{item(doc,'face-6').title='Новая услуга владельца';},
    doc=>{item(doc,'face-6').id='owner-face';doc.showcase.self=doc.showcase.self.filter(id=>id!=='face-6');},
    doc=>{doc.categories.find(cat=>cat.id==='face').id='owner-category';},
  ]){
    const doc=legacyWithBuccal();change(doc);assert.equal(prepare(doc,defaults),doc);
  }
  const alreadySelected=legacyWithBuccal();alreadySelected.showcase.two=['face-7'];
  const prepared=prepare(alreadySelected,null);
  assert.ok(!prepared.showcase.self.includes('face-6'));assert.ok(!prepared.showcase.self.includes('face-7'));
  assert.deepEqual([...prepared.showcase.two],['face-7']);
  const renamedReplacement=legacyWithBuccal();item(renamedReplacement,'face-7').title='Услуга владельца';
  const renamed=prepare(renamedReplacement,null);
  assert.ok(!renamed.showcase.self.includes('face-7'));assert.equal(item(renamed,'face-7').title,'Услуга владельца');
});

const giftSection = (data, full) => render(data, full).match(/<section class="av-direction av-gift"[\s\S]*?<\/section>/)[0];
const certificateSides = html => [...html.matchAll(/<figure class="av-certificate-side">[\s\S]*?<\/figure>/g)].map(match => match[0]);
const imageSource = html => html.match(/<img\b[^>]*src="([^"]+)"/)[1].replaceAll('&amp;', '&');

test('both catalogue pages expose two labelled certificate faces with matching full-size links', () => {
  for (const full of [false, true]) {
    const html = giftSection(defaults, full), sides = certificateSides(html);
    assert.equal(sides.length, 2);
    assert.ok(sides[0].includes('<span>Лицевая сторона</span>'));
    assert.ok(sides[1].includes('<span>Обратная сторона · запись и сайт</span>'));
    const expected = [
      'https://avokado3.synapsebusiness.ru/assets/certificate-avokado-light.svg?v=20260915-qr',
      'https://avokado3.synapsebusiness.ru/assets/certificate-avokado-back.svg?v=20260915-qr',
    ];
    sides.forEach((side, index) => {
      assert.equal(imageSource(side), expected[index]);
      const link = side.match(/<a\b[^>]*class="av-certificate-open"[^>]*>/)[0];
      assert.equal(link.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'), imageSource(side));
      assert.match(link, /target="_blank"/);
      assert.match(link, /rel="noopener"/);
      assert.ok(side.includes('Открыть крупно'));
      assert.doesNotMatch(side, /<(?:figure|img)\b[^>]*\s(?:hidden(?:\s|=|>)|aria-hidden="true")/, 'neither certificate face depends on a flip or disclosure');
    });
    assert.ok(html.includes(defaults.certificates.note));
    assert.ok(html.includes(defaults.certificates.types[0].text));
  }
});

test('custom certificate photos and their URL parameters survive while an absent back uses the new default', () => {
  const changed = copy(defaults);
  changed.certificates.photo = 'assets/owner-front.webp?edition=owner&name=gift';
  changed.certificates.backPhoto = 'https://images.example.test/owner-back.png?v=owner';
  for (const full of [false, true]) {
    const sides = certificateSides(giftSection(changed, full));
    assert.equal(imageSource(sides[0]), 'https://avokado3.synapsebusiness.ru/assets/owner-front.webp?edition=owner&name=gift');
    assert.equal(imageSource(sides[1]), changed.certificates.backPhoto);
    assert.ok(!sides.join('').includes('certificate-avokado-'));
  }
  delete changed.certificates.backPhoto;
  assert.ok(imageSource(certificateSides(giftSection(changed, true))[1]).endsWith('/certificate-avokado-back.svg?v=20260915-qr'));
  changed.certificates.photo = 'assets/certificate-avokado-light.svg?v=old&edition=gift';
  const refreshed = new URL(imageSource(certificateSides(giftSection(changed, true))[0]));
  assert.equal(refreshed.searchParams.get('v'), '20260915-qr');
  assert.equal(refreshed.searchParams.get('edition'), 'gift');
});

test('empty and unsafe certificate images fall back independently without unsafe enlargement links', () => {
  for (const value of ['', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'tel:+79331901059', 'file:///private/image.svg', 'https://[']) {
    const changed = copy(defaults);
    changed.certificates.photo = value;
    changed.certificates.backPhoto = value;
    for (const full of [false, true]) {
      const sides = certificateSides(giftSection(changed, full));
      assert.ok(imageSource(sides[0]).endsWith('/certificate-avokado-light.svg?v=20260915-qr'));
      assert.ok(imageSource(sides[1]).endsWith('/certificate-avokado-back.svg?v=20260915-qr'));
      assert.doesNotMatch(sides.join(''), /(?:src|href)="(?:javascript|data|tel|file):/i);
    }
  }
});
