'use strict';
/* №140: компания меняется только в блоке «Проект» левого меню; раздел «Контент» называется «Контент завод».
   Настоящие cabinet.html, module-guide.js и CSS; ответы API — заглушка (данные SAMPLE). */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../cabinet.html'), 'utf8');
const parsed = new JSDOM(html);
const shell = [...parsed.window.document.querySelectorAll('script:not([src])')].map(n => n.textContent).find(t => t.includes('canonicalSiteEditors'));
parsed.window.close();
const OWNER = {login: 'owner', userId: 1, displayName: 'SAMPLE Владелец', role: 'owner', permissions: [], csrfToken: 'qa',
  companies: [{id: 'avokado', name: 'SAMPLE Авокадо'}, {id: 'alvi', name: 'SAMPLE ALVI'}]};
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); };

function cabinet(hash, mobile = false) {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', e => { if (!/navigation|reload/i.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(html, {url: 'https://cabinet.test/cabinet.html' + hash, runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true});
  const w = dom.window, renders = [];
  w.matchMedia = q => ({matches: mobile && /max-width/.test(q), media: q, addEventListener() {}, removeEventListener() {}}); w.scrollTo = () => {};
  w.Headers = Headers; w.Request = Request;
  const view = {render(el, ctx) { renders.push(ctx.selectedProjectId); }, initialize() {}, updateSummary() {}};
  w.SbCabinet = {views: new Proxy({}, {get: () => view}), registerView() {}, renderModuleGuide() {}};
  w.fetch = async () => ({ok: true, status: 200, json: async () => OWNER});
  w.eval(shell);
  const text = (n) => n.textContent.replace(/\s+/g, ' ').trim();
  return {w, d: w.document, errors, renders, text, close: () => w.close()};
}

test('№140: плашки «Компания: … / Сменить компанию» нет ни в разметке, ни на страницах кабинета', async () => {
  assert.doesNotMatch(html, /workspace-scope"|workspace-change-company|>Сменить компанию</);
  for (const hash of ['#home', '#content/plan', '#crm', '#settings', '#system-settings', '#account', '#tasks']) {
    const f = cabinet(hash);
    try {
      await settle();
      assert.equal(f.d.getElementById('workspace-scope'), null, hash);
      assert.equal(f.d.getElementById('workspace-change-company'), null, hash);
      const main = f.text(f.d.getElementById('main-content'));
      assert.doesNotMatch(main, /Сменить компанию|Компания: SAMPLE/, hash);
      assert.ok(f.d.title.length > 0 && !/undefined/.test(f.d.title), `${hash}: заголовок вкладки «${f.d.title}»`);
      assert.deepEqual(f.errors, [], hash);
    } finally { f.close(); }
  }
});

test('№140: правило CSS страхует живой cabinet.html, где разметка плашки ещё есть до точечной вставки', () => {
  const css = fs.readFileSync(path.join(__dirname, 'commercial.css'), 'utf8');
  assert.match(css, /\.workspace-scope\{display:none!important\}/);
  assert.doesNotMatch(css, /\.workspace-scope\{display:flex/);
});

test('№140: раздел называется «Контент завод» в левом меню и в нижней панели; подпункты прежние', async () => {
  const f = cabinet('#content/plan');
  try {
    await settle();
    assert.equal(f.text(f.d.getElementById('content-category')), 'Контент завод');
    const bottom = f.d.getElementById('mobile-content');
    assert.equal(f.text(bottom), 'Контент завод');
    assert.equal(bottom.getAttribute('aria-label'), 'Открыть разделы Контент завода');
    assert.equal(bottom.dataset.openCategory, 'content-menu');
    assert.deepEqual([...f.d.querySelectorAll('#content-menu > a')].map(f.text),
      ['Контент-план', 'Съёмка', 'Материалы', 'Постинг', 'Подключения', 'Статистика']);
    const categories = [...f.d.querySelectorAll('.nav-category')].map(f.text);
    assert.equal(categories.filter(t => t === 'Контент завод').length, 1);
    assert.ok(!categories.includes('Контент'), 'старого названия «Контент» в меню нет');
    assert.equal(f.text(f.d.getElementById('mobile-shortcuts')).split('Контент завод').length, 2);
  } finally { f.close(); }
});

test('№140: компания выбирается в блоке «Проект» левого меню — и на ПК, и на телефоне', async () => {
  for (const mobile of [false, true]) {
    const f = cabinet('#home', mobile);
    try {
      await settle();
      assert.equal(f.d.getElementById('project-name').textContent, 'SAMPLE Авокадо');
      f.d.getElementById('project-trigger').click();
      assert.equal(f.d.getElementById('project-menu').hidden, false);
      const options = [...f.d.querySelectorAll('#project-menu [data-project-id]')];
      assert.deepEqual(options.map(f.text), ['SAMPLE Авокадо', 'SAMPLE ALVI']);
      const before = f.renders.length;
      options[1].click(); await settle();
      assert.equal(f.d.getElementById('project-name').textContent, 'SAMPLE ALVI');
      assert.equal(f.d.getElementById('mobile-project').textContent, 'SAMPLE ALVI');
      assert.equal(f.d.getElementById('project-menu').hidden, true);
      assert.equal(f.d.querySelector('#project-menu [aria-checked="true"]').dataset.projectId, 'alvi');
      assert.match(f.d.title, /— SAMPLE ALVI$/);
      assert.ok(f.renders.slice(before).includes('alvi'), 'активный раздел перерисован для новой компании');
      assert.deepEqual(f.errors, []);
    } finally { f.close(); }
  }
});

test('№140: на экране «Медиа-наставник» инструкция не повторяет название раздела «Контент завод»', () => {
  const dom = new JSDOM('<section id="v"></section>', {runScripts: 'outside-only'});
  try {
    dom.window.eval(fs.readFileSync(path.join(__dirname, 'module-guide.js'), 'utf8'));
    const v = dom.window.document.getElementById('v');
    dom.window.SbCabinet.renderModuleGuide(v, 'media-mentor-rollout', {canView: () => true, hasPermission: () => true, escapeHTML: String});
    assert.match(v.querySelector('.module-guide-caption').textContent, /^Медиа-наставник · /);
    for (const [view, [name]] of Object.entries(dom.window.SbCabinet.moduleGuides)) assert.notEqual(name, 'Контент завод', view);
  } finally { dom.window.close(); }
});
