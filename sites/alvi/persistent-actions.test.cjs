'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./persistent-actions.js');

function setup({ width = 390, search = '', sourceVisible = true, sourceHidden = false, observers = true, noSource = false } = {}) {
  const timers = new Map(), events = {}, documentEvents = {}, observersByType = { mutation: [], intersection: [], resize: [] };
  let time = 0, timerId = 0, panelHeight = 88;
  class Element {
    constructor(tag = 'div', classes = '') {
      this.tagName = tag.toUpperCase(); this.className = classes; this.children = []; this.parentElement = null;
      this.attributes = new Map(); this.hidden = false; this.inert = false;
      this.computed = { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' };
      const properties = new Map();
      this.style = { getPropertyValue: name => properties.get(name) || '', setProperty: (name, value) => properties.set(name, value) };
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: name => { if (!this.classList.contains(name)) this.className = (this.className + ' ' + name).trim(); },
        remove: name => { this.className = this.className.split(/\s+/).filter(item => item !== name).join(' '); },
        toggle: (name, enabled) => this.classList[enabled ? 'add' : 'remove'](name),
      };
    }
    append(child) { child.parentElement = this; this.children.push(child); }
    replaceWith(next) {
      const parent = this.parentElement;
      parent.children.splice(parent.children.indexOf(this), 1, next);
      next.parentElement = parent; this.parentElement = null;
    }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === 'inert') this.inert = false;
      if (name === 'hidden') this.hidden = false;
    }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return descendants;
      if (selector === 'a') return descendants.filter(element => element.tagName === 'A');
      return descendants.filter(element => element.classList.contains(selector.slice(1)));
    }
    cloneNode(deep) {
      const copy = new Element(this.tagName, this.className);
      copy.attributes = new Map(this.attributes); copy.inert = this.inert; copy.hidden = this.hidden;
      copy.textContent = this.textContent;
      if (deep) this.children.forEach(child => copy.append(child.cloneNode(true)));
      return copy;
    }
    closest() {
      for (let element = this; element; element = element.parentElement) {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.getAttribute('contenteditable') === 'true') return element;
      }
      return null;
    }
    getBoundingClientRect() {
      if (this.classList.contains('alvi-persistent-actions')) return { height: panelHeight };
      return this.bounds || { top: 640, bottom: 728, left: 16, right: width - 16, width: width - 32, height: 88 };
    }
  }
  const html = new Element('html'), body = new Element('body'), scene = new Element('article', 'hero-scene');
  html.append(body); body.append(scene);
  const source = new Element('div', 'floating-cta'), row = new Element('div', 'floating-cta__row');
  source.setAttribute('id', 'original-actions'); source.setAttribute('data-edit', 'original-actions');
  for (const [href, label] of [['price.html', 'Программы и цены'], ['#contacts', 'Связаться с нами']]) {
    const link = new Element('a', 'floating-cta__button');
    link.setAttribute('href', href); link.setAttribute('id', href.slice(1) + '-cta'); link.setAttribute('data-edit', href);
    link.textContent = label; row.append(link);
  }
  source.append(row); scene.append(source);
  if (sourceHidden) {
    source.classList.add('is-hidden'); source.inert = true; source.hidden = true;
    source.setAttribute('inert', ''); source.setAttribute('hidden', '');
    source.setAttribute('aria-hidden', 'true'); source.setAttribute('style', 'opacity:0');
  }
  if (!sourceVisible) source.bounds = { top: -100, bottom: -12, left: 16, right: width - 16, width: width - 32, height: 88 };
  const promo = new Element('div', 'promo'), cookie = new Element('div', 'cookie-notice hidden'), dialog = new Element('dialog');
  body.append(promo); body.append(cookie); body.append(dialog);
  const doc = {
    body, documentElement: html, activeElement: null,
    createElement: tag => new Element(tag),
    addEventListener: (name, fn) => { documentEvents[name] = fn; },
    querySelector(selector) {
      if (selector === '.alvi-persistent-actions') return body.querySelectorAll(selector)[0] || null;
      if (selector === '.hero-scene[data-scene="0"] .floating-cta') return noSource ? null : source;
      if (selector.startsWith('dialog[open]')) return dialog.getAttribute('open') !== null ? dialog :
        promo.classList.contains('is-open') ? promo : !cookie.classList.contains('hidden') && !cookie.hidden ? cookie : null;
      return null;
    },
    querySelectorAll: () => [dialog, promo, cookie],
  };
  const win = {
    location: { search }, innerWidth: width, innerHeight: 800, scrollY: 0,
    getComputedStyle: element => element.computed,
    addEventListener: (name, fn) => { events[name] = fn; },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, at: time + delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  if (observers) for (const [name, type] of [['MutationObserver', 'mutation'], ['IntersectionObserver', 'intersection'], ['ResizeObserver', 'resize']]) {
    win[name] = class {
      constructor(callback) { this.callback = callback; this.targets = []; this.observations = new Map(); observersByType[type].push(this); }
      observe(target, options = {}) { this.targets.push(target); this.observations.set(target, options); }
    };
  }
  const panel = start(win, doc);
  const advance = ms => {
    time += ms;
    for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); }
  };
  const emit = type => events[type]?.();
  const focus = element => { doc.activeElement = element; documentEvents.focusin?.(); };
  const mutate = (target, record = { type: 'attributes', attributeName: 'class' }) => observersByType.mutation.forEach(observer => {
    const observed = [...observer.observations].some(([root, options]) =>
      (target === root || (options.subtree && root.contains(target))) && options[record.type] &&
      (record.type !== 'attributes' || !options.attributeFilter || options.attributeFilter.includes(record.attributeName)));
    if (observed) observer.callback([{ target, ...record }]);
  });
  return { win, doc, html, body, source, scene, panel, cookie, promo, dialog, Element, emit, focus, mutate, advance, documentEvents,
    observersByType, setPanelHeight: height => { panelHeight = height; } };
}

function assertVisible(panel, expected) {
  assert.equal(panel.classList.contains('is-visible'), expected);
  assert.equal(panel.inert, !expected);
  assert.equal(panel.getAttribute('aria-hidden'), String(!expected));
}

test('one body-level portal preserves the inline actions and clones links without editor keys or IDs', () => {
  const s = setup();
  assert.equal(s.panel.parentElement, s.body); assert.equal(s.panel.tagName, 'NAV');
  assert.equal(s.panel.getAttribute('aria-label'), 'Быстрая запись в ALVI');
  assert.equal(s.panel.children[0].className, 'alvi-persistent-actions__content');
  assert.deepEqual(s.panel.querySelectorAll('a').map(link => link.getAttribute('href')), ['price.html', '#contacts']);
  assert.deepEqual(s.panel.querySelectorAll('a').map(link => link.textContent), ['Программы и цены', 'Связаться с нами']);
  for (const element of s.panel.querySelectorAll('*')) {
    assert.equal(element.getAttribute('id'), null); assert.equal(element.getAttribute('data-edit'), null);
  }
  assert.equal(s.source.getAttribute('id'), 'original-actions');
  assert.ok(s.source.querySelectorAll('a').every(link => link.getAttribute('data-edit')));
  assertVisible(s.panel, false);
  assert.equal(start(s.win, s.doc), s.panel);
  assert.equal(s.body.querySelectorAll('.alvi-persistent-actions').length, 1);
  assert.equal(s.observersByType.intersection.length, 1);
});

test('mobile and desktop actions hide during movement and return 220ms after the final scroll', () => {
  for (const width of [390, 1440]) {
    const s = setup({ width, sourceVisible: false }); assertVisible(s.panel, true);
    s.win.scrollY = 100; s.emit('scroll'); assertVisible(s.panel, false);
    assert.equal(s.panel.classList.contains('is-scrolling'), true);
    s.advance(150); s.win.scrollY = 200; s.emit('scroll'); s.advance(219); assertVisible(s.panel, false);
    s.advance(1); assertVisible(s.panel, true); assert.equal(s.panel.classList.contains('is-scrolling'), false);
    s.source.bounds = null; s.win.scrollY = 0; s.emit('scroll'); s.advance(220); assertVisible(s.panel, false);
  }
});

test('initializing on a deep link does not copy the old source hiding state into the new controls', () => {
  const s = setup({ sourceHidden: true }), content = s.panel.children[0];
  assertVisible(s.panel, true);
  assert.equal(content.inert, false); assert.equal(content.hidden, false);
  assert.equal(content.classList.contains('is-hidden'), false);
  for (const attribute of ['style', 'hidden', 'inert', 'aria-hidden']) assert.equal(content.getAttribute(attribute), null);
  assert.equal(s.source.inert, true); assert.equal(s.source.hidden, true);
});

test('source intersection and ancestor opacity changes prevent duplicates in the sticky desktop hero', () => {
  const s = setup(); assertVisible(s.panel, false);
  s.scene.computed.opacity = '0'; s.mutate(s.scene); assertVisible(s.panel, true);
  s.scene.computed.opacity = '1'; s.mutate(s.scene); assertVisible(s.panel, false);
  s.source.inert = true; s.mutate(s.source); assertVisible(s.panel, true);
  s.source.inert = false; s.source.bounds = { top: -100, bottom: -12, left: 16, right: 374, width: 358, height: 88 };
  s.observersByType.intersection[0].callback([]); assertVisible(s.panel, true);
  s.source.bounds = null; s.observersByType.intersection[0].callback([]); assertVisible(s.panel, false);
});

test('a pointer-events override on the source stays visible beneath a noninteractive ancestor', () => {
  const s = setup();
  s.scene.computed.pointerEvents = 'none'; s.source.computed.pointerEvents = 'auto';
  s.mutate(s.scene); assertVisible(s.panel, false);
  s.source.computed.pointerEvents = 'none'; s.mutate(s.source); assertVisible(s.panel, true);
  s.source.computed.pointerEvents = 'auto'; s.mutate(s.source); assertVisible(s.panel, false);
});

test('late CMS text and destination updates refresh the clone while stripping editor metadata again', () => {
  const s = setup({ sourceVisible: false }), original = s.source.querySelectorAll('a')[0];
  original.textContent = 'Выбрать SPA';
  s.mutate(original, { type: 'childList' });
  assert.equal(s.panel.querySelectorAll('a')[0].textContent, 'Выбрать SPA');
  original.setAttribute('href', '#for-self');
  s.mutate(original, { type: 'attributes', attributeName: 'href' });
  assert.equal(s.panel.querySelectorAll('a')[0].getAttribute('href'), '#for-self');
  for (const element of s.panel.querySelectorAll('*')) {
    assert.equal(element.getAttribute('id'), null); assert.equal(element.getAttribute('data-edit'), null);
  }
  assert.equal(s.source.getAttribute('id'), 'original-actions');
  assertVisible(s.panel, true);
});

test('CMS updates keep a focused CTA link intact and apply the latest source after focus leaves the panel', () => {
  const s = setup({ sourceVisible: false }), original = s.source.querySelectorAll('a')[0];
  const focusedLink = s.panel.querySelectorAll('a')[0]; s.focus(focusedLink);
  original.textContent = 'Выбрать SPA'; s.mutate(original, { type: 'childList' });
  original.setAttribute('href', '#for-self'); s.mutate(original, { type: 'attributes', attributeName: 'href' });
  assert.equal(s.panel.querySelectorAll('a')[0], focusedLink);
  assert.equal(focusedLink.textContent, 'Программы и цены');
  s.documentEvents.focusout(); s.doc.activeElement = s.panel.querySelectorAll('a')[1]; s.advance(0);
  assert.equal(s.panel.querySelectorAll('a')[0], focusedLink, 'tabbing inside the panel must not replace its controls');
  s.documentEvents.focusout(); s.doc.activeElement = null; s.advance(0);
  assert.notEqual(s.panel.querySelectorAll('a')[0], focusedLink);
  assert.equal(s.panel.querySelectorAll('a')[0].textContent, 'Выбрать SPA');
  assert.equal(s.panel.querySelectorAll('a')[0].getAttribute('href'), '#for-self');
  assertVisible(s.panel, true);
});

test('keyboard focus keeps actions available while scrolling; dialogs still take priority', () => {
  const s = setup({ sourceVisible: false }), link = s.panel.querySelectorAll('a')[0];
  s.focus(link); s.win.scrollY = 100; s.emit('scroll'); assertVisible(s.panel, true);
  assert.equal(s.panel.classList.contains('is-scrolling'), false);
  s.dialog.setAttribute('open', ''); s.mutate(s.dialog); assertVisible(s.panel, false);
  s.dialog.removeAttribute('open'); s.mutate(s.dialog); assertVisible(s.panel, true);
  s.documentEvents.focusout(); s.doc.activeElement = null; s.advance(0); assertVisible(s.panel, false);
  s.advance(220); assertVisible(s.panel, true);
});

test('cookie notices, promo dialogs and focused form fields suppress the portal until dismissed', () => {
  const s = setup({ sourceVisible: false });
  s.cookie.classList.remove('hidden'); s.mutate(s.cookie); assertVisible(s.panel, false);
  s.cookie.classList.add('hidden'); s.mutate(s.cookie); assertVisible(s.panel, true);
  s.promo.classList.add('is-open'); s.mutate(s.promo); assertVisible(s.panel, false);
  s.promo.classList.remove('is-open'); s.mutate(s.promo); assertVisible(s.panel, true);
  for (const field of ['input', 'textarea', 'select']) {
    s.focus(new s.Element(field)); assertVisible(s.panel, false);
    s.documentEvents.focusout(); s.doc.activeElement = null; s.advance(0); assertVisible(s.panel, true);
  }
  const editable = new s.Element(); editable.setAttribute('contenteditable', 'true');
  s.focus(editable); assertVisible(s.panel, false);
});

test('measured footer reservation remains stable during hiding and adapts to resized buttons', () => {
  const s = setup({ sourceVisible: false }), name = '--alvi-persistent-actions-height';
  assert.equal(s.html.style.getPropertyValue(name), '88px');
  s.win.scrollY = 100; s.emit('scroll'); assert.equal(s.html.style.getPropertyValue(name), '88px');
  s.setPanelHeight(112); s.observersByType.resize[0].callback([]);
  assert.equal(s.html.style.getPropertyValue(name), '112px');
  s.setPanelHeight(0); s.emit('resize'); assert.equal(s.html.style.getPropertyValue(name), '112px');
});

test('scroll and resize work without observer APIs and normal scroll events are never intercepted', () => {
  const s = setup({ sourceVisible: false, observers: false }); assertVisible(s.panel, true);
  s.win.scrollY = 50; s.emit('scroll'); assertVisible(s.panel, false); s.advance(220); assertVisible(s.panel, true);
  s.source.bounds = null; s.emit('resize'); assertVisible(s.panel, false);
  assert.equal(s.win.scrollY, 50);
});

test('editor mode and pages without opening actions remain untouched', () => {
  for (const options of [{ search: '?edit=1' }, { noSource: true }]) {
    const s = setup(options); assert.equal(s.panel, null);
    assert.equal(s.body.querySelectorAll('.alvi-persistent-actions').length, 0);
    assert.equal(s.html.style.getPropertyValue('--alvi-persistent-actions-height'), '');
  }
});
