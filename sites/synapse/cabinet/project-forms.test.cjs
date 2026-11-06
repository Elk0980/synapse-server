'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function mount() {
  const dom = new JSDOM('<!doctype html><body><div id="sidebar"></div><section id="v"></section></body>', { url: 'https://example.test/cabinet.html', runScripts: 'outside-only' });
  const w = dom.window; let view = null;
  w.matchMedia = () => ({ matches: false });
  w.SbCabinet = { registerView(name, def) { if (name === 'project-forms') view = def; } };
  w.eval(fs.readFileSync(require.resolve('./project-forms.js'), 'utf8'));
  return { dom, w, view, root: w.document.getElementById('v') };
}

test('Авокадо: владелец видит референс экранов Контент-завода', () => {
  const { dom, view, root } = mount();
  view.render(root, { identity: { role: 'owner' }, selectedProjectId: 'avokado' });
  const frame = root.querySelector('iframe');
  assert.equal(frame.getAttribute('src'), '/cabinet/content-factory-reference.html');
  assert.match(root.textContent, /Авокадо → Контент-завод/);
  view.onLeave(); dom.window.close();
});

test('Palitra Love: прежний редактор форм не изменился', () => {
  const { dom, view, root } = mount();
  view.render(root, { identity: { role: 'owner' }, selectedProjectId: 'palitra-love' });
  assert.equal(root.querySelector('iframe').getAttribute('src'), '/cabinet/project-forms/index.html?company=palitra-love&board=palitra-orders');
  view.onLeave(); dom.window.close();
});

test('другой проект и не владелец — без iframe', () => {
  const { dom, view, root } = mount();
  view.render(root, { identity: { role: 'owner' }, selectedProjectId: 'alvi' });
  assert.equal(root.querySelector('iframe'), null);
  assert.match(root.textContent, /не перенесены/);
  view.render(root, { identity: { role: 'manager' }, selectedProjectId: 'avokado' });
  assert.equal(root.querySelector('iframe'), null);
  assert.match(root.textContent, /доступен владельцу/);
  dom.window.close();
});
