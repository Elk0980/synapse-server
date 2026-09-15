const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { clipForBounds, start } = require('./hero-background.js');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.classes = new Set();
    this.attrs = {};
    this.classWrites = 0;
    this.styleWrites = 0;
    this.classList = {
      contains: name => this.classes.has(name),
      toggle: (name, on) => { this.classWrites++; if (on) this.classes.add(name); else this.classes.delete(name); }
    };
    const styles = new Map();
    this.style = {
      getPropertyValue: name => styles.get(name) || '',
      setProperty: (name, value) => { this.styleWrites++; styles.set(name, value); }
    };
    this.clientHeight = 900;
  }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  setAttribute(name, value) { this.attrs[name] = value; }
  appendChild(node) { node.remove(); this.children.push(node); node.parentNode = this; return node; }
  insertBefore(node, before) { node.remove(); this.children.splice(this.children.indexOf(before), 0, node); node.parentNode = this; }
  replaceChild(node, previous) {
    node.remove();
    this.children.splice(this.children.indexOf(previous), 1, node);
    previous.parentNode = null;
    node.parentNode = this;
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.classList.contains(selector.slice(1))) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}

function setup({ compact = true, search = '' } = {}) {
  const body = new Element('body'), html = new Element('html'), hero = new Element('section');
  hero.className = compact ? 'hero is-compact-mode' : 'hero';
  const parent = new Element(), before = new Element(), media = new Element(), after = new Element();
  media.className = 'hero__media';
  const video = new Element('video');
  video.currentTime = 12.5;
  video.listener = () => 'existing listener';
  media.appendChild(video);
  parent.appendChild(before); parent.appendChild(media); parent.appendChild(after);
  hero.appendChild(parent); body.appendChild(hero);
  let bounds = { top: 0, bottom: 4000 };
  hero.getBoundingClientRect = () => bounds;
  const events = {}, documentEvents = {}, observers = [], frames = new Map();
  let nextFrame = 1;
  const doc = {
    body, documentElement: html, readyState: 'complete',
    getElementById: id => id === 'hero' ? hero : null,
    createElement: tag => new Element(tag), createComment: () => new Element('#comment'),
    addEventListener: (event, callback, options) => { documentEvents[event] = { callback, options }; }
  };
  const win = {
    document: doc, location: { search }, innerHeight: 800,
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (event, callback) => { events[event] = callback; },
    removeEventListener: event => { delete events[event]; },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
      observe(target, options) { this.targets.push({ target, options }); }
      disconnect() { this.disconnected = true; }
    }
  };
  return {
    body, html, hero, parent, before, media, after, video, doc, win, events, documentEvents, observers, frames,
    portal: () => body.children.find(node => node.classList.contains('alvi-hero-backdrop')),
    setBounds: value => { bounds = value; },
    flush() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); }
  };
}

test('clip geometry follows the visible hero area without translating the image', () => {
  assert.deepEqual(clipForBounds({ top: -1200, bottom: 2800 }, 900, 800), { top: 0, bottom: 0, visible: true });
  assert.deepEqual(clipForBounds({ top: 150, bottom: 4150 }, 900, 800), { top: 150, bottom: 0, visible: true });
  assert.deepEqual(clipForBounds({ top: -3400, bottom: 600 }, 900, 800), { top: 0, bottom: 300, visible: true });
  assert.deepEqual(clipForBounds({ top: -4100, bottom: -100 }, 900, 800), { top: 0, bottom: 900, visible: false });
  assert.deepEqual(clipForBounds({ top: 850, bottom: 4850 }, 900, 800), { top: 850, bottom: 0, visible: false });
});

test('compact mode moves the actual media after the original hero and restores its exact position', () => {
  const s = setup(), listener = s.video.listener;
  const control = start(s.win, s.doc), portal = s.portal();
  assert.ok(portal);
  assert.equal(portal.attrs['aria-hidden'], 'true');
  assert.equal(portal.attrs.id, undefined);
  assert.equal(s.body.querySelector('.hero'), s.hero);
  assert.equal(portal.children[0], s.media);
  assert.equal(s.media.children[0], s.video);
  assert.equal(s.video.currentTime, 12.5);
  assert.equal(s.video.listener, listener);
  assert.equal(s.hero.classList.contains('has-fixed-background'), true);
  s.hero.classList.toggle('is-compact-mode', false);
  control.sync();
  assert.equal(s.portal(), undefined);
  assert.deepEqual(s.parent.children, [s.before, s.media, s.after]);
  assert.equal(s.hero.classList.contains('has-fixed-background'), false);
  s.hero.classList.toggle('is-compact-mode', true);
  control.sync();
  assert.equal(s.portal().children[0], s.media);
  control.destroy();
  assert.deepEqual(s.parent.children, [s.before, s.media, s.after]);
});

test('desktop and editor keep original markup; an editor switch restores a mounted portal', () => {
  for (const options of [{ compact: false }, { search: '?edit=1' }]) {
    const s = setup(options);
    start(s.win, s.doc);
    assert.equal(s.portal(), undefined);
    assert.deepEqual(s.parent.children, [s.before, s.media, s.after]);
  }
  const s = setup(), control = start(s.win, s.doc);
  s.html.classList.toggle('edit-full', true);
  s.observers[0].callback(); s.flush();
  assert.equal(s.portal(), undefined);
  assert.deepEqual(s.parent.children, [s.before, s.media, s.after]);
  control.destroy();
});

test('class observation mirrors final tone and motion settings without repeated DOM writes', () => {
  const s = setup(), control = start(s.win, s.doc);
  s.hero.classList.toggle('is-compact-final', true);
  s.hero.classList.toggle('is-reduced-motion', true);
  s.observers[0].callback(); s.flush();
  const portal = s.portal();
  assert.ok(portal.classList.contains('is-compact-final'));
  assert.ok(portal.classList.contains('is-reduced-motion'));
  const writes = [s.hero.classWrites, portal.classWrites, portal.styleWrites];
  control.sync(); s.observers[0].callback(); s.flush();
  assert.deepEqual([s.hero.classWrites, portal.classWrites, portal.styleWrites], writes);
  s.hero.classList.toggle('is-compact-final', false);
  s.hero.classList.toggle('is-reduced-motion', false);
  control.sync();
  assert.equal(portal.classList.contains('is-compact-final'), false);
  assert.equal(portal.classList.contains('is-reduced-motion'), false);
});

test('scroll, resize and pageshow clip to hero bounds using the portal height and coalesce frames', () => {
  const s = setup(), control = start(s.win, s.doc), portal = s.portal();
  s.setBounds({ top: -3000, bottom: 600 });
  s.events.scroll(); s.events.resize(); s.events.pageshow();
  assert.equal(s.frames.size, 1);
  s.flush();
  assert.equal(portal.style.getPropertyValue('--alvi-hero-clip-bottom'), '300px');
  assert.equal(portal.style.getPropertyValue('--alvi-hero-clip-top'), '0px');
  portal.clientHeight = 960;
  s.events.resize(); s.flush();
  assert.equal(portal.style.getPropertyValue('--alvi-hero-clip-bottom'), '360px');
  s.setBounds({ top: -3700, bottom: -100 });
  s.events.scroll(); s.flush();
  assert.equal(portal.classList.contains('is-visible'), false);
  s.setBounds({ top: 0, bottom: 4000 });
  s.events.pageshow(); s.flush();
  assert.equal(portal.classList.contains('is-visible'), true);
  assert.equal(portal.style.getPropertyValue('--alvi-hero-clip-bottom'), '0px');
  control.destroy();
  assert.equal(s.observers[0].disconnected, true);
  assert.equal(Object.keys(s.events).length, 0);
});

test('browser bootstrap waits for DOMContentLoaded when needed', () => {
  const s = setup(); s.doc.readyState = 'loading';
  const source = fs.readFileSync(require.resolve('./hero-background.js'), 'utf8');
  vm.runInNewContext(source, { window: s.win, URLSearchParams });
  assert.equal(s.portal(), undefined);
  assert.equal(s.documentEvents.DOMContentLoaded.options.once, true);
  s.documentEvents.DOMContentLoaded.callback();
  assert.equal(s.portal().children[0], s.media);
});
