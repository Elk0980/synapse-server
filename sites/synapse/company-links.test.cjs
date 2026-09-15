const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {safeUrl, destination, start} = require('./company-links.js');
const {start: routeContacts} = require('../avokado3/contact-route.js');
const {start: startAttribution} = require('../avokado3/attribution.js');

function setup({companyCode = 'avokado', responseCode = companyCode, links = {}, fail = false, status = 200, edit = false, missingCode = false} = {}) {
  const nodes = [], records = [], observers = [], handlers = new Map(), requests = [];
  let writes = 0, resolve;
  const response = new Promise(done => { resolve = done; });
  function anchor(key, href, label = 'Записаться', extras = {}) {
    const attrs = new Map(Object.entries({href, ...(key ? {'data-company-link': key} : {}), ...extras}));
    const styles = new Map();
    const node = {textContent: label, hidden: false, inert: false,
      style: {getPropertyValue: key => styles.get(key)?.value || '', getPropertyPriority: key => styles.get(key)?.priority || '',
        setProperty(key, value, priority = '') { styles.set(key, {value, priority}); records.push({type: 'attributes', target: node, attributeName: 'style'}); },
        removeProperty(key) { if (styles.delete(key)) records.push({type: 'attributes', target: node, attributeName: 'style'}); }},
      getAttribute: name => attrs.get(name) ?? null,
      hasAttribute: name => attrs.has(name),
      setAttribute(name, value) { if (attrs.get(name) !== value) { attrs.set(name, value); writes++; records.push({type: 'attributes', target: this, attributeName: name}); } },
      removeAttribute(name) { if (attrs.delete(name)) records.push({type: 'attributes', target: this, attributeName: name}); },
      matches(selector) { return selector.includes('data-company-link') ? attrs.has('data-company-link') : true; },
      querySelectorAll: () => [],
      closest(selector) { return selector.includes('a[') ? this : null; },
    };
    return node;
  }
  const doc = {
    body: {getAttribute: () => missingCode ? null : companyCode},
    getElementById: () => null,
    querySelectorAll: selector => selector.includes('data-company-link') ? nodes.filter(a => a.hasAttribute('data-company-link')) : nodes,
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
  };
  const win = {
    location: new URL(`https://example.test/price.html${edit ? '?edit=1' : ''}`),
    fetch: async (url, options) => { requests.push({url, options}); await response; if (fail) throw Error('offline'); return {ok: status === 200, json: async () => ({companyCode: responseCode, links})}; },
    MutationObserver: class {
      constructor(fn) { this.callback = fn; this.targets = []; observers.push(this); }
      observe(target, options) { this.targets.push({target, options}); }
    },
  };
  doc.defaultView = win;
  const api = start(win, doc);
  async function ready() { resolve(); if (api) await api.ready; records.length = 0; }
  function flush() {
    let iteration = 0;
    while (records.length) {
      assert.ok(++iteration < 10, 'href observers must settle without loops');
      const batch = records.splice(0);
      observers.forEach(observer => {
        const selected = batch.filter(record => observer.targets.some(({target, options}) => {
          if (target !== record.target && !(target === doc.body && options.subtree)) return false;
          return record.type === 'childList' ? options.childList : options.attributes && (!options.attributeFilter || options.attributeFilter.includes(record.attributeName));
        }));
        if (selected.length) observer.callback(selected);
      });
    }
  }
  function add(node) { nodes.push(node); records.push({type: 'childList', target: doc.body, addedNodes: [node]}); return node; }
  return {doc, win, api, anchor, add, ready, flush, requests, nodes, observers, get writes() { return writes; }, setLinks(value) { links = value; },
    click(node, type = 'click') { handlers.get(type)?.forEach(fn => fn({target: node, button: type === 'auxclick' ? 1 : 0})); },
  };
}

test('public URLs must be absolute HTTP(S), without credentials or invented handle conversion', () => {
  for (const value of [null, '', '@studio', 't.me/studio', '/contacts', '//example.com', 'javascript:alert(1)', 'data:text/html,test', 'tel:+79999999999', 'https://user:pass@example.com', 'https://example.com/\npath', 'https://example.com/\t', 'https://example.com/\u007f']) assert.equal(safeUrl(value), null, value);
  assert.equal(safeUrl(' https://t.me/studio ').href, 'https://t.me/studio');
  assert.equal(safeUrl('http://example.com').href, 'http://example.com/');
});

test('a changed booking base retains campaign tags but drops old service, contact and arbitrary query data', () => {
  const old = 'https://n396010.yclients.com/company/375899/personal/select-services?o=s19187795&utm_campaign=summer&yclid=123&entry_point=hero&phone=123&custom=old';
  const next = new URL(destination('https://booking.example/new?branch=2', old, true));
  assert.equal(next.origin, 'https://booking.example');
  assert.equal(next.pathname, '/new');
  assert.equal(next.searchParams.get('branch'), '2');
  for (const key of ['utm_campaign', 'yclid', 'entry_point']) assert.equal(next.searchParams.get(key), new URL(old).searchParams.get(key));
  for (const key of ['o', 'phone', 'custom']) assert.equal(next.searchParams.has(key), false);
});

test('the named TURBO offer keeps its selection only for the same Yclients account and generic CRM entry', () => {
  const old = 'https://n396010.yclients.com/company/375899/personal/select-services?o=s19187795&phone=123&utm_content=hero';
  const base = 'https://n396010.yclients.com/company/375899/personal/menu';
  const same = new URL(destination(base, old, true));
  assert.equal(same.pathname, '/company/375899/personal/select-services');
  assert.equal(same.searchParams.get('o'), 's19187795');
  assert.equal(same.searchParams.has('phone'), false);
  assert.equal(new URL(destination(base, old)).searchParams.has('o'), false, 'generic catalogue links use the saved base');
  const other = new URL(destination(base.replace('375899', '999999'), old, true));
  assert.equal(other.searchParams.has('o'), false);
  const specific = new URL(destination(base.replace('menu', 'select-services') + '?o=s777', old, true));
  assert.equal(specific.searchParams.get('o'), 's777', 'an explicit new CRM selection wins');
});

test('matching-company settings update marked anchors and make missing or invalid named channels unavailable', async () => {
  const page = setup({links: {telegram: 'https://t.me/new_chat', telegram_channel: 'https://t.me/new_channel', booking: 'https://booking.example/', max: null, vk: 'javascript:alert(1)', secret: 'https://secret.example'}});
  const chat = page.add(page.anchor('telegram', 'https://t.me/old', 'Telegram'));
  const channel = page.add(page.anchor('telegram_channel', 'https://t.me/old_channel', 'Канал'));
  const max = page.add(page.anchor('max', 'https://max.ru/old', 'MAX'));
  const vk = page.add(page.anchor('vk', 'https://vk.com/old', 'ВКонтакте'));
  const unmarked = page.add(page.anchor(null, 'https://booking.old/'));
  await page.ready();
  assert.equal(chat.getAttribute('href'), 'https://t.me/new_chat');
  assert.equal(channel.getAttribute('href'), 'https://t.me/new_channel');
  for (const missing of [max, vk]) {
    assert.equal(missing.getAttribute('href'), null);
    assert.equal(missing.hidden, true);
    assert.equal(missing.inert, true);
    assert.equal(missing.getAttribute('aria-hidden'), 'true');
    assert.equal(missing.style.getPropertyValue('display'), 'none');
    assert.equal(missing.style.getPropertyPriority('display'), 'important');
  }
  assert.equal(unmarked.getAttribute('href'), 'https://booking.old/');
  assert.equal(page.api.get('telegram'), 'https://t.me/new_chat');
  assert.equal(page.api.get('max'), null, 'successful omission is distinct from an unavailable API');
  assert.equal(page.api.get('secret'), undefined);
  assert.deepEqual(page.requests, [{url: '/api/company-links', options: {credentials: 'omit', cache: 'no-store'}}]);
  assert.equal(start(page.win, page.doc), page.api, 'one request and observer per page');
});

test('clearing CRM links survives reload and subsequent CMS rewrites; missing booking goes to Contacts in the same window', async () => {
  for (const main of [true, false]) {
    const page = setup({links: {}});
    page.doc.getElementById = id => main && id === 'contacts' ? {} : null;
    const book = page.add(page.anchor('booking', 'https://old.yclients.com/', 'Записаться', {target: '_blank'}));
    const chat = page.add(page.anchor('telegram', 'https://t.me/old', 'Telegram'));
    await page.ready();
    assert.equal(book.getAttribute('href'), main ? '#contacts' : 'index.html#contacts');
    assert.equal(book.getAttribute('target'), null);
    assert.equal(chat.getAttribute('href'), null);
    assert.equal(chat.inert, true);
    chat.setAttribute('href', 'https://t.me/old_cms');
    book.setAttribute('href', 'https://old.yclients.com/'); page.flush();
    assert.equal(chat.getAttribute('href'), null);
    assert.equal(book.getAttribute('href'), main ? '#contacts' : 'index.html#contacts');
  }
});

test('refreshing cleared and refilled links restores only the state changed by the consumer', async () => {
  const page = setup({links: {telegram: 'https://t.me/first', booking: 'https://booking.example/'}});
  const chat = page.add(page.anchor('telegram', 'https://t.me/original', 'Telegram', {target: '_blank', tabindex: '0'}));
  chat.style.setProperty('display', 'inline-flex');
  const hidden = page.add(page.anchor('vk', 'https://vk.com/original', 'ВКонтакте', {'aria-hidden': 'true'}));
  hidden.hidden = true; hidden.inert = true; hidden.style.setProperty('display', 'none', 'important');
  const book = page.add(page.anchor('booking', 'https://booking.old/', 'Записаться', {target: '_blank'}));
  await page.ready();
  page.setLinks({}); await page.api.refresh(); page.flush();
  assert.equal(chat.getAttribute('href'), null);
  assert.equal(book.getAttribute('href'), 'index.html#contacts');
  page.setLinks({telegram: 'https://t.me/second', vk: 'https://vk.com/new', booking: 'https://booking.new/'});
  await page.api.refresh(); page.flush();
  assert.equal(chat.getAttribute('href'), 'https://t.me/second');
  assert.equal(chat.hidden, false); assert.equal(chat.inert, false);
  assert.equal(chat.style.getPropertyValue('display'), 'inline-flex');
  assert.equal(chat.getAttribute('target'), '_blank'); assert.equal(chat.getAttribute('tabindex'), '0');
  assert.equal(hidden.getAttribute('href'), 'https://vk.com/new');
  assert.equal(hidden.hidden, true); assert.equal(hidden.inert, true);
  assert.equal(hidden.style.getPropertyPriority('display'), 'important');
  assert.equal(book.getAttribute('href'), 'https://booking.new/'); assert.equal(book.getAttribute('target'), '_blank');
  assert.equal(page.observers.length, 2, 'refresh reuses the body observer and the scoped style guard');
});

test('late CMS display resets cannot reveal a cleared link and scoped style correction settles without an observer loop', async () => {
  const page = setup({links: {}});
  const map = page.add(page.anchor('yandex_maps', 'https://yandex.ru/maps/old', 'Яндекс Карты'));
  await page.ready();
  map.style.removeProperty('display'); // site-apply.applyLayout() after a slower API load or resize.
  page.flush();
  assert.equal(map.style.getPropertyValue('display'), 'none');
  assert.equal(map.style.getPropertyPriority('display'), 'important');
  assert.equal(map.getAttribute('href'), null);
  assert.equal(map.inert, true);
  const count = page.writes; page.flush(); assert.equal(page.writes, count);
  const guard = page.observers.find(observer => observer.targets.some(({options}) => options.attributeFilter?.includes('style')));
  assert.ok(guard.targets.every(({target}) => target === map), 'hero animation styles are never observed');
});

test('help, Contacts, callback, phone, printed images and cross-company references remain untouched', async () => {
  const page = setup({links: {booking: 'https://booking.example', telegram: 'https://t.me/new', website: 'https://new.example'}});
  const cases = [
    page.anchor('telegram', 'https://t.me/old', 'Помочь с выбором'),
    page.anchor('booking', '#contacts'), page.anchor('booking', 'index.html#callback'),
    page.anchor('website', 'contacts.html'), page.anchor('telegram', 'tel:+79999999999'),
    page.anchor('booking', 'https://old.example', 'Помощь', {'data-contact-route': ''}),
    page.anchor(null, 'assets/certificate.svg', 'Открыть крупно'),
    page.anchor(null, 'https://avokado38.ru/', 'Другая студия'),
  ];
  const original = cases.map(a => a.getAttribute('href')); cases.forEach(page.add);
  await page.ready();
  assert.deepEqual(cases.map(a => a.getAttribute('href')), original);
});

test('late catalogue insertion, CMS href replacement, FAQ replacement and persistent clones remain reactive', async () => {
  const page = setup({links: {booking: 'https://booking.example/', max: 'https://max.ru/new'}});
  await page.ready();
  const book = page.add(page.anchor('booking', 'https://old.example')); page.flush();
  assert.equal(book.getAttribute('href'), 'https://booking.example/');
  book.setAttribute('href', 'https://old-cms.example/?utm_source=ad'); page.flush();
  assert.equal(book.getAttribute('href'), 'https://booking.example/?utm_source=ad');
  const faq = page.add(page.anchor('max', 'https://max.ru/old', 'MAX')); page.flush();
  assert.equal(faq.getAttribute('href'), 'https://max.ru/new');
  const clone = page.add(page.anchor('booking', book.getAttribute('href'))); page.flush();
  assert.equal(clone.getAttribute('href'), book.getAttribute('href'));
  const count = page.writes; page.flush(); assert.equal(page.writes, count);
});

test('a just-created link is corrected before ordinary or middle-click navigation without consuming the event', async () => {
  const page = setup({links: {booking: 'https://booking.example/'}}); await page.ready();
  for (const type of ['click', 'auxclick']) {
    const link = page.anchor('booking', 'https://old.example/');
    page.click(link, type); assert.equal(link.getAttribute('href'), 'https://booking.example/');
  }
});

test('campaign decoration and company correction settle, preserving the latest campaign', async () => {
  const page = setup({links: {booking: 'https://new.yclients.com/'}});
  const link = page.add(page.anchor('booking', 'https://old.yclients.com/?utm_source=ad&entry_point=hero'));
  await page.ready();
  link.setAttribute('href', 'https://new.yclients.com/?utm_source=updated&entry_point=hero'); page.flush();
  assert.equal(link.getAttribute('href'), 'https://new.yclients.com/?utm_source=updated&entry_point=hero');
  const writes = page.writes; page.click(link); page.flush(); assert.equal(page.writes, writes);
});

test('missing booking and the real Avokado attribution observer settle on one Contacts URL with campaign tags', async () => {
  for (const pathname of ['contacts.html', 'price.html']) {
    const page = setup({links: {}});
    page.win.location = new URL('https://example.test/' + pathname + '?utm_source=yandex&utm_campaign=summer&yclid=123');
    const book = page.add(page.anchor('booking', 'https://n396010.yclients.com/company/375899/personal/menu', 'Записаться онлайн', {target: '_blank'}));
    await page.ready();
    startAttribution(page.win, page.doc);
    page.flush();
    const url = new URL(book.getAttribute('href'));
    assert.equal(url.origin, 'https://example.test');
    assert.equal(url.pathname, '/index.html');
    assert.equal(url.hash, '#contacts');
    assert.equal(url.searchParams.get('utm_source'), 'yandex');
    assert.equal(url.searchParams.get('utm_campaign'), 'summer');
    assert.equal(url.searchParams.get('yclid'), '123');
    assert.equal(book.getAttribute('target'), null);
    const before = page.writes;
    page.click(book); page.flush();
    assert.equal(page.writes, before, 'click and queued href observers must not restart a rewrite cycle');
  }
});

test('Avokado contact routing cannot turn explicitly marked booking or named channels into help links', async () => {
  const page = setup({links: {booking: 'https://booking.example/'}});
  const book = page.add(page.anchor('booking', 'https://t.me/old_saved_link'));
  const help = page.add(page.anchor(null, 'https://t.me/old_help', 'Помочь с выбором'));
  routeContacts(page.doc, page.win.location, page.win);
  assert.equal(book.getAttribute('href'), 'https://t.me/old_saved_link');
  assert.equal(help.getAttribute('href'), 'index.html#contacts');
  await page.ready(); page.flush();
  assert.equal(book.getAttribute('href'), 'https://booking.example/');
  assert.equal(help.getAttribute('href'), 'index.html#contacts');
});

test('editor previews, a missing site binding, cross-company responses and unavailable API never override fallbacks', async () => {
  for (const options of [{edit: true}, {missingCode: true}, {responseCode: 'alvi'}, {status: 404}, {fail: true}]) {
    const page = setup({...options, links: {booking: 'https://booking.example/'}});
    const book = page.add(page.anchor('booking', 'https://old.example/'));
    await page.ready();
    assert.equal(book.getAttribute('href'), 'https://old.example/');
    if (options.edit || options.missingCode) assert.equal(page.requests.length, 0);
  }
});

test('all five public pages bind the correct company and mark named channels without marking help or telephone links', () => {
  const root = path.resolve(__dirname, '..');
  for (const [name, code] of [['alvi/index.html', 'alvi'], ['alvi/price.html', 'alvi'], ['avokado3/index.html', 'avokado'], ['avokado3/price.html', 'avokado'], ['avokado3/contacts.html', 'avokado']]) {
    const html = fs.readFileSync(path.join(root, name), 'utf8');
    assert.match(html, new RegExp('<body\\b[^>]*data-company-code="' + code + '"'));
    assert.equal((html.match(/src="https:\/\/synapse\.synapsebusiness\.ru\/company-links\.js\?v=20260915-crm-links"/g) || []).length, 1);
    for (const match of html.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/g)) {
      const [, attrs, content] = match;
      if (/href="tel:/.test(attrs) || /href="(?:index\.html)?#(?:contacts|callback)/.test(attrs)) assert.doesNotMatch(attrs, /data-company-link/);
      if (/href="https:\/\/[^/]+\.yclients\.com\//.test(attrs)) assert.match(attrs, /data-company-link="booking"/);
      if (/^(Помочь с выбором|Оформить сертификат|Связаться с нами)$/.test(content)) assert.doesNotMatch(attrs, /data-company-link/);
    }
  }
  const faq = fs.readFileSync(path.join(root, 'alvi/site-apply.js'), 'utf8');
  assert.match(faq, /html = 'Напишите в <a data-company-link="telegram"/);
  assert.match(faq, /или <a data-company-link="max"/);
  for (const name of ['alvi/price-render.js', 'avokado3/catalog.js', 'avokado3/price-render.js']) {
    assert.match(fs.readFileSync(path.join(root, name), 'utf8'), /data-company-link="booking"/);
  }
});
