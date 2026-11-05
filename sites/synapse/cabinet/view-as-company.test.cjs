'use strict';
/* №137: «Посмотреть как» не переключает и не перезаписывает сохранённую компанию владельца.
   Настоящие cabinet.html и view-as.js, ответы API — заглушка (данные SAMPLE). */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../cabinet.html'), 'utf8');
const viewAs = fs.readFileSync(path.join(__dirname, 'view-as.js'), 'utf8');
const parsed = new JSDOM(html);
const shell = [...parsed.window.document.querySelectorAll('script:not([src])')].map(n => n.textContent).find(t => t.includes('canonicalSiteEditors'));
parsed.window.close();
const OWNER = {login: 'owner', userId: 1, displayName: 'SAMPLE Владелец', role: 'owner', permissions: [], csrfToken: 'qa',
  companies: [{id: 'alvi', name: 'SAMPLE Алви'}, {id: 'synapse-business', name: 'SAMPLE Synapse Бизнес'}]};
const LENA = (companies) => ({login: 'lena', userId: 7, displayName: 'SAMPLE Лена', role: 'editor', permissions: ['autoposting.view'], csrfToken: 'qa',
  companies, viewAs: {active: true, readOnly: true, userId: 7, name: 'SAMPLE Лена'}});
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); };

function cabinet({who, local = {}, session = {}, shellToo = true}) {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', e => { if (!/navigation|reload/i.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(html, {url: 'https://cabinet.test/cabinet.html#home', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true});
  const w = dom.window, posts = [];
  for (const [k, v] of Object.entries(local)) w.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(session)) w.sessionStorage.setItem(k, v);
  w.matchMedia = q => ({matches: false, media: q, addEventListener() {}, removeEventListener() {}}); w.scrollTo = () => {};
  w.Headers = Headers; w.Request = Request;
  w.SbCabinet = {views: new Proxy({}, {get: () => ({render() {}, initialize() {}, updateSummary() {}})}), registerView() {}, renderModuleGuide() {}};
  w.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.endsWith('/content/view-as') && options.method === 'POST') { posts.push(JSON.parse(options.body)); return {ok: true, status: 200, json: async () => ({token: 'synthetic-token'})}; }
    if (u.endsWith('/content/view-as')) return {ok: true, status: 200, json: async () => ({users: [{id: 7, name: 'SAMPLE Лена'}]})};
    return {ok: true, status: 200, json: async () => who};
  };
  w.eval(viewAs);
  if (shellToo) w.eval(shell);
  const storage = () => Object.fromEntries(Object.keys(w.localStorage).map(k => [k, w.localStorage.getItem(k)]));
  return {w, d: w.document, posts, errors, storage, close: () => w.close()};
}
const OWNER_KEY = 'synapse_cabinet_project_v2:1';

test('№137: вход в режим запоминает компанию владельца только в этой вкладке', async () => {
  const f = cabinet({who: OWNER, local: {[OWNER_KEY]: 'synapse-business'}});
  try {
    await settle();
    assert.equal(f.d.getElementById('project-name').textContent, 'SAMPLE Synapse Бизнес');
    f.d.getElementById('view-as-start').click(); await settle();
    [...f.d.querySelectorAll('dialog button')].find(b => b.textContent === 'SAMPLE Лена').click(); await settle();
    assert.deepEqual(f.posts, [{userId: 7}]);
    assert.equal(f.w.sessionStorage.getItem('synapse-view-as'), 'synthetic-token');
    assert.equal(f.w.sessionStorage.getItem('synapse-view-as-company'), 'synapse-business');
    assert.deepEqual(f.storage(), {[OWNER_KEY]: 'synapse-business'}, 'сохранённый выбор владельца не тронут');
  } finally { f.close(); }
});

test('№137: у сотрудника есть доступ к компании владельца — остаёмся в ней; смена компании не пишет в localStorage', async () => {
  const f = cabinet({who: LENA([{id: 'alvi', name: 'SAMPLE Алви'}, {id: 'synapse-business', name: 'SAMPLE Synapse Бизнес'}]),
    local: {[OWNER_KEY]: 'synapse-business'}, session: {'synapse-view-as': 'synthetic-token', 'synapse-view-as-company': 'synapse-business'}});
  try {
    await settle();
    assert.equal(f.d.getElementById('project-name').textContent, 'SAMPLE Synapse Бизнес', 'не переключилось на первую компанию сотрудника');
    assert.match(f.d.getElementById('view-as-banner').textContent, /SAMPLE Лена — только просмотр/);
    f.d.getElementById('project-trigger').click(); await settle();
    const alvi = [...f.d.querySelectorAll('#project-menu button')].find(b => b.textContent.includes('Алви'));
    alvi.click(); await settle();
    assert.equal(f.d.getElementById('project-name').textContent, 'SAMPLE Алви');
    assert.equal(f.w.sessionStorage.getItem('synapse-view-as-company'), 'alvi');
    assert.deepEqual(f.storage(), {[OWNER_KEY]: 'synapse-business'}, 'выбор в режиме просмотра не сохраняется для других вкладок');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('№137: у сотрудника нет доступа к компании владельца — первая доступная, выбор владельца не меняется', async () => {
  const f = cabinet({who: LENA([{id: 'alvi', name: 'SAMPLE Алви'}]),
    local: {[OWNER_KEY]: 'synapse-business'}, session: {'synapse-view-as': 'synthetic-token', 'synapse-view-as-company': 'synapse-business'}});
  try {
    await settle();
    assert.equal(f.d.getElementById('project-name').textContent, 'SAMPLE Алви');
    assert.deepEqual(f.storage(), {[OWNER_KEY]: 'synapse-business'});
  } finally { f.close(); }
});

test('№137: «Выйти» убирает режим, владелец снова видит свою компанию', async () => {
  const f = cabinet({who: LENA([{id: 'alvi', name: 'SAMPLE Алви'}]),
    local: {[OWNER_KEY]: 'synapse-business'}, session: {'synapse-view-as': 'synthetic-token', 'synapse-view-as-company': 'synapse-business'}});
  let session;
  try {
    await settle();
    [...f.d.querySelectorAll('#view-as-banner button')].find(b => b.textContent === 'Выйти').click();
    assert.equal(f.w.sessionStorage.getItem('synapse-view-as'), null);
    assert.equal(f.w.sessionStorage.getItem('synapse-view-as-company'), null);
    session = Object.fromEntries(Object.keys(f.w.sessionStorage).map(k => [k, f.w.sessionStorage.getItem(k)]));
  } finally { f.close(); }
  const back = cabinet({who: OWNER, local: {[OWNER_KEY]: 'synapse-business'}, session});
  try {
    await settle();
    assert.equal(back.d.getElementById('project-name').textContent, 'SAMPLE Synapse Бизнес');
    assert.deepEqual(back.storage(), {[OWNER_KEY]: 'synapse-business'});
  } finally { back.close(); }
});
