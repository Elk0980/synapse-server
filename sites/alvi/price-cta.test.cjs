const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(__dirname + '/price.html', 'utf8');
const source = html.match(/\(\(\) => \{\s*const cta = document\.querySelector\('\.floating-cta'\);[\s\S]*?\}\)\(\);/)[0];

function setup({footerTop = 1000, height = 800, focused = false} = {}) {
  const events = {}, timers = [], classes = new Set(), attributes = new Map();
  const first = {}, second = {};
  const cta = {
    inert: false,
    contains: element => element === first || element === second,
    classList: {toggle(name, active) { active ? classes.add(name) : classes.delete(name); }},
    setAttribute: (name, value) => attributes.set(name, value),
    addEventListener: (name, callback) => { events[name] = callback; },
  };
  const document = {
    activeElement: focused ? first : {},
    querySelector: selector => selector === '.floating-cta' ? cta : {getBoundingClientRect: () => ({top: footerTop})},
  };
  const window = {innerHeight: height};
  vm.runInNewContext(source, {document, window,
    addEventListener: (name, callback) => { events[name] = callback; },
    setTimeout: callback => timers.push(callback),
  });
  return {cta, classes, attributes, events, document, window, first, second,
    moveFooter(top) { footerTop = top; events.scroll(); },
    flush() { while (timers.length) timers.shift()(); },
  };
}

test('price actions near the footer are visually hidden, inert and absent from the accessibility tree', () => {
  assert.match(html, /\.floating-cta\.is-hidden\s*\{[^}]*visibility:\s*hidden/);
  const page = setup({footerTop: 500});
  assert.equal(page.classes.has('is-hidden'), true);
  assert.equal(page.cta.inert, true);
  assert.equal(page.attributes.get('aria-hidden'), 'true');
  page.moveFooter(1000);
  assert.equal(page.classes.has('is-hidden'), false);
  assert.equal(page.cta.inert, false);
  assert.equal(page.attributes.get('aria-hidden'), 'false');
  page.window.innerHeight = 1200;
  page.events.resize();
  assert.equal(page.cta.inert, true, 'resize recomputes footer overlap');
});

test('a focused price action stays visible through scrolling and tabbing within its group', () => {
  const page = setup({focused: true});
  page.moveFooter(500);
  assert.equal(page.classes.has('is-hidden'), false);
  assert.equal(page.cta.inert, false);
  page.events.focusout();
  page.document.activeElement = page.second;
  page.events.focusin();
  page.flush();
  assert.equal(page.cta.inert, false, 'tabbing between actions must not hide the destination');
  page.events.focusout();
  page.document.activeElement = {};
  page.flush();
  assert.equal(page.classes.has('is-hidden'), true);
  assert.equal(page.cta.inert, true, 'leaving the group hides it without stealing focus');
  assert.equal(page.attributes.get('aria-hidden'), 'true');
});

test('restored keyboard focus at a footer position is preserved during initialization', () => {
  const page = setup({footerTop: 500, focused: true});
  assert.equal(page.cta.inert, false);
  assert.equal(page.classes.has('is-hidden'), false);
  assert.equal(page.document.activeElement, page.first);
  assert.match(html, /href="https:\/\/n1070017\.yclients\.com\/"[^>]*>Записаться/);
  assert.match(html, /href="index\.html#contacts"[^>]*>Связаться с нами/);
});
