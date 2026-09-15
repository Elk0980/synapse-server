'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The fixture supplies only DOM structure and measurements. All scene, paper and
// photograph state changes run through the production modules in a fresh window.
function flowAtViewport(width, height) {
  // Read the production CSS switch, so these viewport cases also cover its media query.
  const css = fs.readFileSync(path.join(__dirname, 'mobile-method.css'), 'utf8');
  const query = css.match(/@media([^{}]+)\{\s*#metod\{--mobile-method-flow:1\}/)?.[1];
  assert.ok(query, 'the natural-flow switch must have a media query');
  return query.split(',').some(clause => {
    const conditions = [...clause.matchAll(/\((min|max)-(width|height)\s*:\s*(\d+)px\)/g)];
    assert.ok(conditions.length, 'each clause must specify viewport dimensions');
    return conditions.every(([, bound, dimension, limit]) => bound === 'max'
      ? ({width,height}[dimension] <= Number(limit)) : ({width,height}[dimension] >= Number(limit)));
  });
}

function fixture({ flow = false, stickyHeight = 600, width = 1280, height = 575 } = {}) {
  const geometry = { flow, stickyHeight, width, height, paperViewportHeight: 400, copyHeight: 800, measurementReads: 0 };
  function style() {
    const properties = Object.create(null);
    return new Proxy({
      setProperty(name, value) { properties[name] = String(value); },
      getPropertyValue(name) { return properties[name] || ''; },
      removeProperty(name) { const previous = properties[name] || ''; delete properties[name]; return previous; },
    }, {
      get(target, name) { return name in target ? target[name] : properties[name] || ''; },
      set(_target, name, value) { properties[name] = String(value); return true; },
    });
  }
  class Element {
    constructor(tag = 'div', classes = '') {
      this.tagName = tag.toUpperCase();
      this.className = classes;
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.attributes = new Map();
      this.style = style();
      this.inert = false;
      this.hidden = false;
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
        toggle: (name, force) => {
          const enabled = force === undefined ? !this.classList.contains(name) : force;
          this.classList[enabled ? 'add' : 'remove'](name);
          return enabled;
        },
      };
    }
    append(...nodes) {
      for (const node of nodes) {
        node.remove();
        node.parentNode = this;
        this.children.push(node);
      }
    }
    before(node) {
      const parent = this.parentNode;
      node.remove();
      node.parentNode = parent;
      parent.children.splice(parent.children.indexOf(this), 0, node);
    }
    remove() {
      if (!this.parentNode) return;
      const siblings = this.parentNode.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'id') this.id = String(value);
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    matches(selector) {
      return selector.split(',').some(part => {
        const simple = part.trim();
        if (simple[0] === '#') return this.id === simple.slice(1);
        if (simple[0] === '.') return this.classList.contains(simple.slice(1));
        return this.tagName === simple.toUpperCase();
      });
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    get offsetParent() { return this.parentNode; }
    get offsetTop() { return this.topOffset ?? Math.max(0, this.parentNode?.children.indexOf(this) || 0) * 140; }
    get offsetHeight() {
      if (this.classList.contains('paper-layout')) {
        geometry.measurementReads += 1;
        return geometry.copyHeight;
      }
      return 100;
    }
    get clientHeight() {
      if (this.classList.contains('method-sticky')) return geometry.stickyHeight;
      if (this.classList.contains('paper-viewport')) return geometry.paperViewportHeight;
      return 400;
    }
    get scrollHeight() { return 400; }
    getBoundingClientRect() {
      const top = this.pageTop || 0;
      return { top, bottom: top + (Number.parseFloat(this.style.height) || 9000), height: 9000 };
    }
  }
  const root = new Element('section', 'method-scroll');
  root.style.height = '6000px';
  const sticky = new Element('div', 'method-sticky');
  root.append(sticky);
  const scenes = ['method-0', 'method-1', 'method-2', 'method-3', 'method-results', 'method-4', 'method-5'].map(id => {
    const scene = new Element('article', 'method-scene');
    scene.id = id;
    scene.inert = true;
    scene.setAttribute('aria-hidden', 'true');
    sticky.append(scene);
    return scene;
  });
  for (const scene of scenes.filter(scene => !['method-3', 'method-5'].includes(scene.id))) {
    const copy = new Element('div', 'scene-copy');
    copy.append(new Element('h2'), new Element('p'));
    scene.append(copy);
  }
  const paperCopy = new Element('div', 'scene-copy scene-two');
  const questions = new Element(), answers = new Element();
  questions.topOffset = 0;
  answers.topOffset = 0;
  questions.append(new Element('h2'), new Element('p'));
  answers.append(new Element('h3'), ...Array.from({ length: 4 }, () => new Element('p')));
  paperCopy.append(questions, answers);
  scenes[3].append(paperCopy);
  const workCopy = new Element('div', 'scene-copy scene-wide');
  const steps = new Element('div', 'method-steps');
  for (let i = 0; i < 4; i += 1) {
    const card = new Element();
    card.append(new Element('b'), new Element('p'));
    steps.append(card);
  }
  const nextLink = new Element('a', 'flow-next');
  nextLink.style.visibility = 'hidden';
  nextLink.inert = true;
  workCopy.append(new Element('h2'), steps, nextLink);
  scenes[6].append(workCopy);

  const document = { createElement: tag => new Element(tag) };
  const window = { document };
  const context = vm.createContext({
    window, document, URLSearchParams, location: { search: '' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: () => ({
      getPropertyValue(name) {
        if (name === '--mobile-method-flow') return (geometry.flow ?? flowAtViewport(geometry.width, geometry.height)) ? '1' : '0';
        if (['--paper-style-ready', '--work-steps-style-ready'].includes(name)) return '1';
        return '0';
      },
    }),
  });
  for (const file of ['work-steps.js', 'mobile-method.js', 'method-reveal.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
  }
  const update = () => window.AvokadoMethod.update(root, scenes);
  return { root, scenes, paperCopy, nextLink, geometry, update };
}

function assertFlowVisible(f) {
  assert.equal(f.root.style.height, '', 'natural flow must release the artificial scroll height');
  assert.equal(f.root.classList.contains('method-leaving'), false);
  assert.equal(f.scenes.length, 7);
  for (const scene of f.scenes) {
    assert.equal(scene.classList.contains('active'), true, scene.id);
    assert.equal(scene.getAttribute('aria-hidden'), 'false', scene.id);
    assert.equal(scene.inert, false, scene.id);
  }
  const papers = f.root.querySelectorAll('.paper-sheet');
  assert.equal(papers.length, 6);
  papers.forEach(paper => assert.equal(paper.getAttribute('aria-hidden'), 'false'));
  const pairs = f.root.querySelectorAll('.work-pair');
  assert.equal(pairs.length, 4);
  pairs.forEach(pair => {
    assert.equal(pair.getAttribute('aria-hidden'), 'false');
    assert.equal(pair.inert, false);
  });
  assert.notEqual(f.nextLink.style.visibility, 'hidden');
  assert.equal(f.nextLink.inert, false);
}

function assertOnlyScene(f, index) {
  f.scenes.forEach((scene, i) => {
    assert.equal(scene.classList.contains('active'), i === index, scene.id);
    assert.equal(scene.getAttribute('aria-hidden'), String(i !== index), scene.id);
    assert.equal(scene.inert, i !== index, scene.id);
  });
}

test('mobile first render exposes seven scenes, all paper text and all four visit pairs even without sticky height', () => {
  const f = fixture({ flow: true, stickyHeight: 0 });
  f.root.classList.add('method-leaving');
  assert.equal(f.update(), true);
  assertFlowVisible(f);
  f.root.pageTop = -12000;
  assert.equal(f.update(), true);
  assertFlowVisible(f);
  assert.equal(f.geometry.measurementReads, 0, 'natural flow does not need the desktop panning geometry');
});

test('short desktop media exposes every card and paper panel, while tall desktop restores animation and mobile stays in flow', () => {
  const f = fixture({flow:null,width:1280,height:575,stickyHeight:575});
  f.update();assertFlowVisible(f);
  for (const height of [800,575]) {
    f.geometry.height=height;f.update();assertFlowVisible(f);
  }
  f.geometry.height=801;f.geometry.stickyHeight=801;f.update();
  assert.equal(f.root.classList.contains('method-flow'),false);
  assert.match(f.root.style.height,/^\d+px$/);assertOnlyScene(f,0);
  f.geometry.width=1918;f.geometry.height=860;f.update();
  assert.equal(f.root.classList.contains('method-flow'),false);
  f.geometry.width=390;f.geometry.height=844;f.update();assertFlowVisible(f);
});

test('desktop to mobile to the same desktop visit frame restores exclusive scene and photo-pair access', () => {
  const f = fixture();
  f.root.pageTop = -(10 + 1.5 * 1.15) * 500;
  assert.equal(f.update(), true);
  assertOnlyScene(f, 6);
  assert.equal(f.root.querySelectorAll('.work-pair').filter(pair => !pair.inert).length, 1);
  assert.equal(f.nextLink.style.visibility, 'hidden');
  f.geometry.flow = true;
  assert.equal(f.update(), true);
  assertFlowVisible(f);
  f.geometry.flow = false;
  assert.equal(f.update(), true);
  assert.match(f.root.style.height, /^\d+px$/);
  assertOnlyScene(f, 6);
  f.root.querySelectorAll('.work-pair').forEach((pair, index) => {
    assert.equal(pair.getAttribute('aria-hidden'), String(index !== 1));
    assert.equal(pair.inert, index !== 1);
  });
  assert.equal(f.nextLink.style.visibility, 'hidden');
  assert.equal(f.nextLink.inert, true);
  f.root.pageTop = -(10 + 3.5 * 1.15) * 500;
  f.update();
  assert.equal(f.nextLink.style.visibility, 'visible');
  assert.equal(f.nextLink.inert, false);
});

test('returning from mobile remeasures paper geometry and restores hidden future text on reverse scroll', () => {
  const f = fixture();
  f.root.pageTop = -(3 + 6.6 / 1.36) * 500;
  assert.equal(f.update(), true);
  assertOnlyScene(f, 3);
  assert.equal(Number.parseFloat(f.paperCopy.style.getPropertyValue('--paper-pan')), -270);
  f.geometry.flow = true;
  f.update();
  assertFlowVisible(f);
  f.geometry.copyHeight = 1200;
  f.geometry.paperViewportHeight = 250;
  f.geometry.measurementReads = 0;
  f.geometry.flow = false;
  f.update();
  assertOnlyScene(f, 3);
  assert.ok(f.geometry.measurementReads > 0, 'desktop must measure the resized copy again');
  assert.equal(Number.parseFloat(f.paperCopy.style.getPropertyValue('--paper-pan')), -420);
  f.root.pageTop = -(3 + .7 / 1.36) * 500;
  f.update();
  const papers = f.root.querySelectorAll('.paper-sheet');
  assert.equal(papers.filter(paper => paper.getAttribute('aria-hidden') === 'false').length, 1);
  assert.equal(Number.parseFloat(f.paperCopy.style.getPropertyValue('--paper-pan')), 0);
});
