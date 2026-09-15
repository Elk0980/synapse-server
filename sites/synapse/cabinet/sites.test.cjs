'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Small DOM fixture: keeps node order, classes, text, links and event listeners.
// Network is always a manually resolved promise; these tests never call the API.
const decode = value => String(value).replace(/&(amp|lt|gt|quot|#39);/g,
  (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]);
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = {};
    this.value = ''; this.hidden = false; this.open = false; this.dataset = {};
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: name => { this.className = this.className.split(/\s+/).filter(x => x !== name).join(' '); },
      toggle: (name, force) => { const add = force ?? !this.classList.contains(name); this.classList[add ? 'add' : 'remove'](name); return add; }
    };
  }
  get className() { return this.attributes.class || ''; }
  set className(value) { this.attributes.class = value; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children = []; this.text = String(value); }
  set innerHTML(value) {
    this.replaceChildren();
    const stack = [this];
    for (const token of String(value).matchAll(/<\/(\w+)>|<(\w+)([^>]*)>|([^<]+)/g)) {
      if (token[1]) { if (stack.length > 1) stack.pop(); }
      else if (token[2]) {
        const node = new Element(token[2]);
        for (const attr of token[3].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], decode(attr[2]));
        stack.at(-1).append(node);
        if (!['br', 'img', 'input'].includes(token[2])) stack.push(node);
      } else {
        const text = new Element('#text'); text.textContent = decode(token[4]); stack.at(-1).append(text);
      }
    }
  }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this; } }
  replaceChildren(...nodes) { this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  emit(type, properties = {}) { for (const callback of this.listeners[type] || []) callback({ type, target: this, currentTarget: this, preventDefault() {}, ...properties }); }
  querySelectorAll(selector) {
    const result = [];
    const matches = node => selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tagName === selector.toUpperCase();
    const walk = node => { for (const child of node.children) { if (matches(child)) result.push(child); walk(child); } };
    walk(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(permissions = ['sites.view']) {
  const nodes = new Map(), requests = [], document = new Element('document'), window = new Element('window');
  const byId = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  document.hidden = false;
  document.createElement = tag => new Element(tag);
  document.querySelector = () => byId('close-dialog');
  byId('site-create-form').elements = { companyCode: { value: '' } };
  let view;
  window.SbCabinet = { registerView(name, definition) { if (name === 'sites') view = definition; } };
  const context = {
    identity: { permissions, companies: [], csrfToken: 'fixture-token' }, currentView: 'sites', byId,
    escapeHTML: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
    apiJson: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }))
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'sites.js'), 'utf8'), { window, document, URL, URLSearchParams });
  return {
    view, context, byId, requests, document, window, content: byId('sites-content'),
    initialize() { view.initialize(context); },
    render() { view.render(byId('sites-content'), context); },
    async reply(index, sites) { requests[index].resolve({ sites }); await settle(); }
  };
}
function site(id, status = 'draft', extra = {}) {
  return { id, name: id, company: { name: 'Fixture company' }, publicationStatus: status, isActive: true,
    publicUrl: `https://${id}.example.test/`, editorUrls: { site: `/site-editor.html?site=${id}`, price: `/price-editor.html?site=${id}` },
    capabilities: { editSite: true, editPrice: true, delete: false }, ...extra };
}

test('published sites appear first in their own group; draft never receives published styling or badge', async () => {
  const f = fixture(); f.initialize(); f.render();
  await f.reply(0, [site('draft-one'), site('live-one', 'published'), site('draft-two'), site('live-two', 'published', { isActive: false })]);
  const groups = f.content.querySelectorAll('.site-group');
  assert.equal(groups.length, 2);
  const published = groups[0].querySelector('.site-grid--published');
  assert.ok(published);
  assert.deepEqual(published.querySelectorAll('.site-card').map(card => card.querySelector('h3').textContent), ['live-one', 'live-two']);
  for (const card of published.querySelectorAll('.site-card')) {
    assert.ok(card.classList.contains('site-card--published'));
    assert.equal(card.querySelector('.site-badge--published').textContent, 'Чистовой · Опубликован');
  }
  for (const card of groups[1].querySelectorAll('.site-card')) {
    assert.equal(card.classList.contains('site-card--published'), false);
    assert.equal(card.querySelector('.site-badge--published'), null);
  }
});

test('card links keep their destinations and capabilities; names remain text', async () => {
  const f = fixture(); f.initialize(); f.render();
  await f.reply(0, [site('owner', 'published', { name: 'Owner <script>test</script>', capabilities: { editSite: true, editPrice: true, delete: true } }),
    site('client', 'draft', { capabilities: { editSite: false, editPrice: true, delete: false } })]);
  const cards = f.content.querySelectorAll('.site-card');
  assert.equal(cards[0].querySelector('h3').textContent, 'Owner <script>test</script>');
  assert.equal(cards[0].querySelector('script'), null);
  assert.deepEqual(cards[0].querySelectorAll('a').map(a => [a.textContent, a.href]), [
    ['Редактировать сайт', '/site-editor.html?site=owner'], ['Прайс', '/price-editor.html?site=owner'], ['Открыть сайт', 'https://owner.example.test/']
  ]);
  assert.deepEqual(cards[1].querySelectorAll('a').map(a => [a.textContent, a.href]), [
    ['Прайс', '/price-editor.html?site=client'], ['Открыть сайт', 'https://client.example.test/']
  ]);
  for (const link of f.content.querySelectorAll('a')) { assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener'); }
  assert.equal(cards[0].querySelectorAll('button').filter(button => button.textContent === 'Удалить').length, 1);
  assert.equal(cards[1].querySelectorAll('button').length, 0);
});

test('opening the view fetches fresh data each time; initialize does not prefetch twice', async () => {
  const f = fixture(); f.initialize();
  assert.equal(f.requests.length, 0);
  f.render(); await f.reply(0, [site('old')]);
  f.render(); assert.equal(f.requests.length, 2);
  await f.reply(1, [site('new', 'published')]);
  assert.equal(f.content.querySelector('h3').textContent, 'new');
});

test('an older filter response cannot overwrite the newer result', async () => {
  const f = fixture(); f.initialize();
  f.byId('sites-company').value = 'alvi'; f.render();
  f.byId('sites-company').value = 'avokado'; f.byId('sites-company').emit('change');
  assert.match(f.requests[0].url, /companyCode=alvi/); assert.match(f.requests[1].url, /companyCode=avokado/);
  await f.reply(1, [site('current-avokado', 'published')]);
  await f.reply(0, [site('old-alvi')]);
  assert.equal(f.content.querySelector('h3').textContent, 'current-avokado');
});

test('an older request failure cannot erase the newer successful result', async () => {
  const f = fixture(); f.initialize(); f.render(); f.render();
  await f.reply(1, [site('new', 'published')]);
  f.requests[0].reject(new Error('old request failed')); await settle();
  assert.equal(f.content.querySelector('h3').textContent, 'new');
});

test('without sites.view there is no request and no previously rendered site access', async () => {
  const f = fixture([]); f.initialize(); f.render(); await settle();
  assert.equal(f.requests.length, 0);
  assert.equal(f.content.textContent, 'Нет доступа к каталогу сайтов');
  assert.equal(f.content.querySelectorAll('a').length, 0);
});

test('returning to an active visible view refreshes once; hidden views and an open creation dialog stay untouched', async () => {
  const f = fixture(); f.initialize(); f.initialize(); f.render();
  await f.reply(0, [site('old')]);
  f.document.hidden = true; f.document.emit('visibilitychange');
  f.document.hidden = false; f.context.currentView = 'home'; f.document.emit('visibilitychange');
  f.context.currentView = 'sites'; f.byId('site-create-dialog').open = true; f.document.emit('visibilitychange');
  f.window.emit('pageshow', { persisted: true });
  assert.equal(f.requests.length, 1);
  f.byId('site-create-dialog').open = false;
  f.window.emit('pageshow', { persisted: false });
  assert.equal(f.requests.length, 1);
  f.document.emit('visibilitychange');
  assert.equal(f.requests.length, 2, 'initialize must not duplicate visibility listeners');
  assert.equal(f.content.querySelector('h3').textContent, 'old', 'background loading keeps the current cards visible');
  await f.reply(1, [site('new', 'published')]);
  assert.equal(f.content.querySelector('h3').textContent, 'new');
  f.window.emit('pageshow', { persisted: true });
  assert.equal(f.requests.length, 3);
  await f.reply(2, [site('restored', 'published')]);
  assert.equal(f.content.querySelector('h3').textContent, 'restored');
});

test('manual refresh keeps cards visible on failure and reports the failure alongside them', async () => {
  const f = fixture(); f.initialize(); f.render();
  await f.reply(0, [site('live', 'published')]);
  f.byId('refresh-sites').emit('click');
  assert.equal(f.byId('refresh-sites').disabled, true);
  assert.equal(f.content.getAttribute('aria-busy'), 'true');
  assert.equal(f.content.querySelector('h3').textContent, 'live');
  f.requests[1].reject(new Error('network unavailable')); await settle();
  assert.equal(f.content.querySelector('h3').textContent, 'live');
  assert.match(f.byId('sites-refresh-status').textContent, /Не удалось обновить список/);
  assert.equal(f.byId('refresh-sites').disabled, false);
  assert.equal(f.content.getAttribute('aria-busy'), 'false');
});
