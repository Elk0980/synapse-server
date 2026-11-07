'use strict';
/* specs/226: переключатель проектов строится из ответа API (whoami), «+ Новый клиент» видно только
   с правом companies.create или владельцу; форма отправляет код/название/город/часовой пояс
   и делает новую компанию выбранной. Настоящий cabinet.html; ответы API — заглушка (SAMPLE). */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../cabinet.html'), 'utf8');
const parsed = new JSDOM(html);
const shell = [...parsed.window.document.querySelectorAll('script:not([src])')].map(n => n.textContent).find(t => t.includes('canonicalSiteEditors'));
parsed.window.close();
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); };
const profile = (extra) => ({login: 'lena', userId: 7, displayName: 'SAMPLE Лена', role: 'editor', csrfToken: 'qa-csrf',
  permissions: ['autoposting.view'], companies: [{id: 'alvi', name: 'SAMPLE ALVI'}, {id: 'qa-new-client', name: 'SAMPLE Новый клиент', city: '', timezone: 'Asia/Irkutsk', modules: ['content-factory']}], ...extra});

function cabinet(me, onPost) {
  const vc = new VirtualConsole(), errors = [], requests = [];
  vc.on('jsdomError', e => { if (!/navigation|reload/i.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(html, {url: 'https://cabinet.test/cabinet.html#home', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true});
  const w = dom.window;
  w.matchMedia = q => ({matches: false, media: q, addEventListener() {}, removeEventListener() {}}); w.scrollTo = () => {};
  w.Headers = Headers; w.Request = Request;
  const view = {render() {}, initialize() {}, updateSummary() {}};
  w.SbCabinet = {views: new Proxy({}, {get: () => view}), registerView() {}, renderModuleGuide() {}};
  w.fetch = async (url, init = {}) => {
    requests.push({url: String(url), init});
    if (init.method === 'POST' && String(url) === '/content/companies') return onPost(JSON.parse(init.body), init);
    return {ok: true, status: 200, json: async () => me};
  };
  w.eval(shell);
  return {w, d: w.document, errors, requests, close: () => w.close()};
}

test('switcher lists exactly the companies from the API, including a company that is not in any static list', async () => {
  const f = cabinet(profile(), () => { throw Error('no POST expected'); });
  try {
    await settle();
    f.d.getElementById('project-trigger').click();
    assert.deepEqual([...f.d.querySelectorAll('#project-menu [data-project-id]')].map(n => n.dataset.projectId), ['alvi', 'qa-new-client']);
    assert.equal(f.d.querySelector('#project-menu [data-project-create]'), null, 'без права кнопки нет');
    f.d.querySelector('[data-project-id="qa-new-client"]').click(); await settle();
    assert.equal(f.d.getElementById('project-name').textContent, 'SAMPLE Новый клиент');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('«+ Новый клиент» with companies.create: form validates, posts with CSRF, selects the new company and opens the content plan', async () => {
  let posted = null;
  const f = cabinet(profile({permissions: ['autoposting.view', 'companies.create']}), (body, init) => {
    posted = {body, csrf: init.headers['x-csrf-token']};
    if (body.code === 'taken') return {ok: false, status: 409, json: async () => ({error: 'Компания с таким кодом уже есть'})};
    return {ok: true, status: 201, json: async () => ({company: {id: body.code, name: body.name}, addedPermissions: []})};
  });
  try {
    await settle();
    f.d.getElementById('project-trigger').click();
    const create = f.d.querySelector('#project-menu [data-project-create]');
    assert.equal(create.textContent, '+ Новый клиент');
    create.click(); await settle();
    const dialog = f.d.getElementById('company-create-dialog'), form = f.d.getElementById('company-create-form');
    assert.ok(dialog.open || dialog.hasAttribute('open'));
    assert.equal(f.d.getElementById('project-menu').hidden, true);
    assert.equal(form.elements.timezone.value, 'Asia/Irkutsk');
    form.elements.name.value = 'Студия Мята'; form.elements.name.dispatchEvent(new f.w.Event('input'));
    assert.equal(form.elements.code.value, 'studiya-myata', 'код предлагается из названия');
    form.elements.code.value = 'Bad Code'; form.elements.code.dispatchEvent(new f.w.Event('input'));
    form.requestSubmit(); await settle();
    assert.equal(posted, null, 'некорректный код не отправляется');
    assert.match(f.d.getElementById('company-create-error').textContent, /латиница/);
    form.elements.code.value = 'taken'; form.requestSubmit(); await settle();
    assert.equal(f.d.getElementById('company-create-error').textContent, 'Компания с таким кодом уже есть');
    form.elements.code.value = 'studiya-myata'; form.elements.city.value = 'Иркутск'; form.elements.timezone.value = 'Asia/Bangkok';
    form.requestSubmit(); await settle();
    assert.deepEqual(posted, {body: {code: 'studiya-myata', name: 'Студия Мята', city: 'Иркутск', timezone: 'Asia/Bangkok'}, csrf: 'qa-csrf'});
    assert.equal(f.w.localStorage.getItem('synapse_cabinet_project_v2:7'), 'studiya-myata');
    assert.equal(f.w.location.hash, '#content/plan');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('owner always sees «+ Новый клиент»; editor without the right does not, even with an empty company list', async () => {
  const owner = cabinet(profile({role: 'owner', permissions: []}), () => ({}));
  try { await settle(); owner.d.getElementById('project-trigger').click(); assert.ok(owner.d.querySelector('[data-project-create]')); } finally { owner.close(); }
  const empty = cabinet(profile({companies: [], permissions: []}), () => ({}));
  try { await settle(); assert.equal(empty.d.querySelector('[data-project-create]'), null); } finally { empty.close(); }
});
