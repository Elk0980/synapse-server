const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {start, anchorId} = require('./price-navigation.js');

function events(target = {}) {
  const handlers = new Map();
  target.addEventListener = (type, fn) => {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(fn);
  };
  target.emit = (type, event = {}) => {
    for (const fn of handlers.get(type) || []) fn(event);
  };
  return target;
}

function setup({hash = '#s1-10', embedded = false, restored = false, scrollY = 0, missing = false} = {}) {
  const frames = new Map(), targets = new Map(), members = new Set(), resize = [], mutations = [];
  const styles = new Map(), scrolls = [], histories = [];
  let serial = 0, resolveFonts;
  const content = {contains: node => members.has(node)};
  const header = {height: 68, css: {position: 'sticky', display: embedded ? 'none' : 'grid', visibility: 'visible', top: '0px'}, getBoundingClientRect() { return {height: this.height}; }};
  const fonts = events({ready: new Promise(resolve => { resolveFonts = resolve; })});
  const doc = events({
    body: {}, fonts,
    documentElement: {scrollHeight: 20000, classList: {contains: value => embedded && value === 'alvi-price-embedded'}, style: {
      getPropertyValue: key => styles.get(key) || '', setProperty: (key, value) => styles.set(key, value),
    }},
    querySelector: selector => selector === '.price-content' ? content : selector === '.price-header' ? header : null,
    getElementById: id => targets.get(id) || null,
  });
  const win = events({
    document: doc, location: new URL(`https://spaalvi-38.ru/price.html${embedded ? '?embedded=1' : ''}${hash}`),
    scrollY, innerHeight: 844,
    requestAnimationFrame(fn) { const id = ++serial; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    scrollTo(options) { this.scrollY = options.top; scrolls.push(options); },
    getComputedStyle: element => element.css,
    performance: {getEntriesByType: () => [{type: restored ? 'back_forward' : 'navigate'}]},
    ResizeObserver: class { constructor(fn) { resize.push(fn); } observe() {} },
    MutationObserver: class { constructor(fn) { mutations.push(fn); } observe() {} },
  });
  win.history = {state: {keep: 'overlay or browser state'}};
  for (const method of ['pushState', 'replaceState']) win.history[method] = (state, title, hash) => {
    histories.push({method, state, hash}); win.location = new URL(hash, win.location.href);
  };
  function addTarget(id = 's1-10', top = 6000, inside = true) {
    const attributes = new Map();
    const element = {id, top, focusCount: 0,
      hasAttribute: name => attributes.has(name), setAttribute: (name, value) => attributes.set(name, value),
      getBoundingClientRect() { return {top: this.top - win.scrollY}; },
      focus(options) { assert.equal(options.preventScroll, true); this.focusCount++; doc.activeElement = this; },
    };
    targets.set(id, element); if (inside) members.add(element);
    return element;
  }
  const target = missing ? null : addTarget();
  const api = start(win, doc);
  function flush() {
    let iterations = 0;
    while (frames.size) {
      assert.ok(++iterations < 10, 'layout alignment must not create a frame loop');
      const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn());
    }
  }
  function click(href = '#s1-10', extra = {}) {
    const link = {href: new URL(href, win.location.href).href, target: '', hasAttribute: () => false};
    const event = {button: 0, target: {closest: () => link}, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...extra};
    doc.emit('click', event);
    return {event, link};
  }
  return {win, doc, content, header, fonts, styles, scrolls, histories, target, targets, members, api, addTarget, flush, click,
    resize: () => resize.forEach(fn => fn()), mutate: () => mutations.forEach(fn => fn()), resolveFonts};
}

test('a cold programme anchor aligns below the measured sticky header and shares its exact CSS margin', () => {
  const page = setup(); page.flush();
  assert.equal(page.win.scrollY, 6000 - 68 - 16);
  assert.equal(page.styles.get('--alvi-price-anchor-offset'), '84px');
  assert.equal(page.target.getBoundingClientRect().top, 84);
  assert.equal(page.target.focusCount, 1);
  assert.deepEqual(page.histories, [], 'initial anchor does not create a history entry');
  assert.equal(page.scrolls[0].behavior, 'instant', 'smooth native scrolling cannot race layout updates');
});

test('catalogue replacement, images, fonts and header resizing keep the requested programme aligned', async () => {
  const page = setup(); page.flush();
  const replacement = page.addTarget('s1-10', 7200);
  page.doc.emit('alvi:price-ready'); page.flush();
  assert.equal(page.win.scrollY, 7200 - 84);
  assert.equal(replacement.focusCount, 1, 'new catalogue node receives accessible focus');
  replacement.top += 360;
  page.doc.emit('load', {target: {tagName: 'IMG'}}); page.flush();
  assert.equal(replacement.getBoundingClientRect().top, 84);
  replacement.top += 120;
  page.resolveFonts(); await Promise.resolve(); page.flush();
  assert.equal(replacement.getBoundingClientRect().top, 84);
  replacement.top += 80;
  page.fonts.emit('loadingdone'); page.flush();
  assert.equal(replacement.getBoundingClientRect().top, 84);
  page.header.height = 92; page.header.css.top = '6px'; page.resize(); page.flush();
  assert.equal(replacement.getBoundingClientRect().top, 114);
  assert.equal(page.styles.get('--alvi-price-anchor-offset'), '114px');
  assert.equal(replacement.focusCount, 1, 'layout updates do not repeatedly refocus a stable target');
});

test('desktop and embedded pages use the small content inset; mobile resize restores header clearance', () => {
  const desktop = setup(); desktop.header.css.position = 'relative'; desktop.flush();
  assert.equal(desktop.target.getBoundingClientRect().top, 24);
  desktop.header.css.position = 'sticky'; desktop.win.emit('resize'); desktop.flush();
  assert.equal(desktop.target.getBoundingClientRect().top, 84);
  const embedded = setup({embedded: true}); embedded.flush();
  assert.equal(embedded.target.getBoundingClientRect().top, 24);
  assert.equal(embedded.styles.get('--alvi-price-anchor-offset'), '24px');
});

test('a standard missing target can arrive asynchronously; unrelated or malformed anchors remain native', () => {
  const page = setup({missing: true}); page.flush(); assert.equal(page.scrolls.length, 0);
  const target = page.addTarget('s1-10', 3000); page.mutate(); page.flush();
  assert.equal(target.getBoundingClientRect().top, 84);
  page.addTarget('top', 0, false);
  for (const hash of ['#top', '#unknown', '#%', '#', '', 's1-10']) {
    assert.equal(page.api.navigate(hash), false, hash);
  }
  assert.equal(page.click('#top').event.defaultPrevented, false);
  assert.equal(anchorId('#s1%2D10'), 's1-10');
  assert.equal(anchorId('#%'), null);
});

test('only catalogue-contained targets are realigned after replacement', () => {
  const page = setup(); page.flush();
  page.addTarget('s1-10', 100, false);
  const before = page.win.scrollY;
  page.mutate(); page.flush();
  assert.equal(page.win.scrollY, before);
  assert.equal(page.api.navigate('#s1-10'), false);
});

test('a cold editor-created promotion anchor waits for asynchronous catalogue hydration', () => {
  const page = setup({hash: '#promo-1', missing: true});
  page.flush();
  assert.equal(page.scrolls.length, 0);
  const target = page.addTarget('promo-1', 1200);
  page.doc.emit('alvi:price-ready'); page.flush();
  assert.equal(target.getBoundingClientRect().top, 84);
  assert.equal(target.focusCount, 1);
  assert.equal(page.histories.length, 0, 'hydration keeps the original cold-link history entry');
  target.top += 160;
  page.doc.emit('load', {target: {tagName: 'IMG'}}); page.flush();
  assert.equal(target.getBoundingClientRect().top, 84);
});

for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'focusin']) {
  test(`${type} intent cancels late layout alignment and a fresh choice enables it again`, () => {
    const page = setup(); page.flush();
    const editable = {closest: () => ({})};
    if (type === 'focusin') page.doc.emit(type, {target: editable});
    else page.win.emit(type, {key: 'a', target: type === 'keydown' ? editable : {}});
    page.win.scrollY = 2000; page.target.top += 800;
    page.doc.emit('alvi:price-ready'); page.resize(); page.flush();
    assert.equal(page.win.scrollY, 2000);
    assert.equal(page.target.focusCount, 1);
    page.api.navigate('#s1-10'); page.flush();
    assert.equal(page.target.getBoundingClientRect().top, 84);
  });
}

test('keyboard navigation and cancellation before the first frame preserve the visitor position', () => {
  for (const key of ['Tab', 'Escape', 'PageDown', 'ArrowUp', 'Home', 'End', ' ']) {
    const page = setup({scrollY: 1234}); page.win.emit('keydown', {key}); page.flush();
    assert.equal(page.win.scrollY, 1234, key);
    assert.equal(page.target.focusCount, 0);
  }
});

test('Back/Forward and BFCache retain browser-restored scroll, while a new explicit choice works', () => {
  const page = setup(); page.flush();
  page.win.scrollY = 1800; page.win.emit('popstate'); page.win.emit('hashchange');
  page.target.top += 400; page.resize(); page.flush();
  assert.equal(page.win.scrollY, 1800);
  page.api.navigate('#s1-10'); page.flush();
  assert.equal(page.target.getBoundingClientRect().top, 84);
  page.win.emit('pagehide'); page.win.scrollY = 2900;
  page.win.emit('pageshow', {persisted: true}); page.win.emit('hashchange'); page.win.emit('load'); page.flush();
  assert.equal(page.win.scrollY, 2900);
  const coldRestored = setup({restored: true, scrollY: 2222}); coldRestored.flush();
  coldRestored.win.emit('hashchange'); coldRestored.resize(); coldRestored.flush();
  assert.equal(coldRestored.win.scrollY, 2222);
  assert.equal(coldRestored.target.focusCount, 0);
});

test('standalone clicks push one entry and embedded clicks replace one entry without destroying state', () => {
  for (const embedded of [false, true]) {
    const page = setup({embedded, hash: ''}); page.flush();
    const state = page.win.history.state;
    assert.equal(page.click().event.defaultPrevented, true); page.flush();
    assert.equal(page.histories.length, 1);
    assert.equal(page.histories[0].method, embedded ? 'replaceState' : 'pushState');
    assert.equal(page.histories[0].state, state);
    page.api.navigate('#s1-10', {replace: true}); page.flush();
    assert.equal(page.histories.length, 1, 'choosing current target only realigns');
    page.addTarget('s2', 8000); page.api.navigate('#s2', {replace: true}); page.flush();
    assert.equal(page.histories[1].method, 'replaceState');
    assert.equal(page.win.location.search, embedded ? '?embedded=1' : '');
  }
});

test('new native hash navigation aligns, but already handled, modified and external clicks are left alone', () => {
  const page = setup({hash: ''}); page.flush();
  page.win.location.hash = '#s1-10'; page.win.emit('hashchange'); page.flush();
  assert.equal(page.target.getBoundingClientRect().top, 84);
  for (const extra of [{defaultPrevented: true}, {ctrlKey: true}, {metaKey: true}, {shiftKey: true}, {altKey: true}, {button: 1}]) {
    page.click('#s1-10', extra);
  }
  assert.equal(page.click('index.html#contacts').event.defaultPrevented, false);
  assert.equal(page.click('https://example.com/price.html#s1-10').event.defaultPrevented, false);
  assert.equal(page.histories.length, 0);
});

test('alignment coalesces layout events, respects document limits, and start is idempotent', () => {
  const page = setup();
  page.doc.documentElement.scrollHeight = 5000;
  page.resize(); page.mutate(); page.api.refresh(); page.flush();
  assert.equal(page.scrolls.length, 1);
  assert.equal(page.win.scrollY, 5000 - 844);
  assert.equal(start(page.win, page.doc), page.api);
  page.target.top = 10; page.api.refresh(); page.flush(); assert.equal(page.win.scrollY, 0);
});

test('a parent-handled price anchor closes the mobile menu without a second navigation or scroll', () => {
  const page = setup({embedded: true, hash: ''}); page.flush();
  const source = fs.readFileSync(__dirname + '/price-mobile-nav.js', 'utf8');
  const handler = source.slice(source.indexOf("nav.addEventListener('click'"), source.indexOf("nav.addEventListener('keydown'"));
  const link = {hash: '#s1-10'}, nav = events({contains: node => node === link});
  let open = true;
  vm.runInNewContext(handler, {nav, mobile: {matches: true}, document: page.doc, setOpen: value => { open = value; }});
  const event = {button: 0, defaultPrevented: true, target: {closest: selector => selector.startsWith('a') ? link : null}};
  page.api.navigate('#s1-10', {replace: true}); // Parent capture handler already handled this click.
  const histories = page.histories.length;
  nav.emit('click', event); page.doc.emit('click', event); page.flush();
  assert.equal(open, false);
  assert.equal(page.histories.length, histories);
  assert.equal(page.scrolls.length, 1);
  assert.equal(page.target.getBoundingClientRect().top, 24);
});

test('price bootstrap embeds only a real iframe, preserves standalone header and loads navigation before hydration', () => {
  const html = fs.readFileSync(__dirname + '/price.html', 'utf8');
  const bootstrap = html.match(/<script>(if \(window\.parent[\s\S]*?)<\/script>/)[1];
  for (const [iframe, query, expected] of [[true, '?embedded=1', true], [false, '?embedded=1', false], [true, '', false]]) {
    const classes = new Set(), window = {};
    window.parent = iframe ? {} : window;
    vm.runInNewContext(bootstrap, {window, location: {search: query}, URLSearchParams,
      document: {documentElement: {classList: {add: name => classes.add(name)}}}});
    assert.equal(classes.has('alvi-price-embedded'), expected);
  }
  assert.match(html, /<body class="price-page" data-full-price>/);
  assert.match(html, /html\.alvi-price-embedded \.price-header\s*\{\s*display:\s*none/);
  assert.ok(html.indexOf('price-navigation.js?v=20260915-price-flow') < html.indexOf('async function hydratePrice'));
  assert.match(html, /document\.dispatchEvent\(new Event\('alvi:price-ready'\)\)/);
  assert.match(html, /contact-route\.js\?v=20260915-price-flow/);
  const helpers = [...html.matchAll(/<a\b([^>]+)>(Помочь с выбором|Оформить сертификат|Связаться с нами)<\/a>/g)];
  assert.ok(helpers.length > 20);
  for (const [, attributes] of helpers) {
    assert.match(attributes, /href="index\.html#contacts"/);
    assert.doesNotMatch(attributes, /target=/);
  }
});
