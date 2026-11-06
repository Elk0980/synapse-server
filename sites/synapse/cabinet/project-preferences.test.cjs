'use strict';
/* №180: проект по умолчанию и порядок меню «Проект». Настоящие cabinet.html, view-as.js и menu-preferences.js,
   ответы API — заглушка (данные SAMPLE). cabinet.html не меняется. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../cabinet.html'), 'utf8');
const viewAs = fs.readFileSync(path.join(__dirname, 'view-as.js'), 'utf8');
const menuPrefs = fs.readFileSync(path.join(__dirname, 'menu-preferences.js'), 'utf8');
const parsed = new JSDOM(html);
const shell = [...parsed.window.document.querySelectorAll('script:not([src])')].map(n => n.textContent).find(t => t.includes('canonicalSiteEditors'));
parsed.window.close();
const COMPANIES = [{id: 'avokado', name: 'SAMPLE Авокадо'}, {id: 'alvi', name: 'SAMPLE ALVI'}, {id: 'synapse-business', name: 'SAMPLE Synapse'}];
const profile = (extra = {}) => ({login: 'lena', userId: 7, displayName: 'SAMPLE Лена', role: 'editor', permissions: [], csrfToken: 'csrf-sample', companies: COMPANIES, ...extra});
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0)); };

function cabinet({who, local = {}, session = {}, put = null}) {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', e => { if (!/navigation|reload/i.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(html, {url: 'https://cabinet.test/cabinet.html#home', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true});
  const w = dom.window, puts = [], names = [];
  for (const [k, v] of Object.entries(local)) w.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(session)) w.sessionStorage.setItem(k, v);
  w.matchMedia = q => ({matches: false, media: q, addEventListener() {}, removeEventListener() {}}); w.scrollTo = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.Headers = Headers; w.Request = Request;
  w.fetch = async (url, options = {}) => {
    if (String(url).includes('user-project-prefs')) {
      const headers = new Headers(options.headers);
      puts.push({method: options.method, body: JSON.parse(options.body), csrf: headers.get('x-csrf-token'), viewAs: headers.get('x-view-as')});
      if (put) return put(puts.at(-1));
      return {ok: false, status: 404, json: async () => ({error: 'Не найдено'})};
    }
    return {ok: true, status: 200, json: async () => who};
  };
  w.eval(viewAs);
  w.SbCabinet = {views: new Proxy({}, {get: () => ({render() {}, initialize() {}, updateSummary() {}})}), registerView() {}, renderModuleGuide() {}};
  w.eval(menuPrefs);
  new w.MutationObserver(() => names.push(w.document.getElementById('project-name').textContent))
    .observe(w.document.getElementById('project-name'), {childList: true, subtree: true, characterData: true});
  w.eval(shell);
  const d = w.document;
  const order = () => [...d.querySelectorAll('#project-menu [data-project-id]')].map(n => n.dataset.projectId);
  const pick = id => { d.getElementById('project-menu').hidden = false; d.querySelector(`#project-menu [data-project-id="${id}"]`).click(); };
  return {w, d, errors, puts, names, order, pick, close: () => w.close()};
}

test('№180: серверный последний выбор с другого устройства — до первого показа, меню по частоте за 30 дней', async () => {
  const prefs = {lastCompanyCode: 'synapse-business', companies: [
    {companyCode: 'synapse-business', picks30d: 1, lastPickedAt: 30}, {companyCode: 'alvi', picks30d: 5, lastPickedAt: 20}, {companyCode: 'foreign', picks30d: 99, lastPickedAt: 99}]};
  const c = cabinet({who: profile({projectPreferences: prefs}), local: {'synapse_cabinet_project_v2:7': 'avokado'},
    put: ({body}) => ({ok: true, status: 200, json: async () => ({preferences: {lastCompanyCode: body.companyCode, companies: [
      {companyCode: body.companyCode, picks30d: 6, lastPickedAt: 40}, {companyCode: 'synapse-business', picks30d: 1, lastPickedAt: 30}]}})})});
  await settle();
  assert.equal(c.d.getElementById('project-name').textContent, 'SAMPLE Synapse');
  assert.ok(c.names.every(n => n === 'SAMPLE Synapse'), 'прежний проект устройства не показывался');
  assert.deepEqual(c.order(), ['synapse-business', 'alvi', 'avokado']);
  assert.equal(c.puts.length, 0, 'без выбора запросов нет');
  c.pick('alvi'); await settle();
  assert.equal(c.puts.length, 1);
  assert.equal(c.puts[0].method, 'PUT'); assert.equal(c.puts[0].csrf, 'csrf-sample');
  assert.deepEqual(Object.keys(c.puts[0].body).sort(), ['companyCode', 'requestId']);
  assert.equal(c.puts[0].body.companyCode, 'alvi');
  assert.equal(c.d.getElementById('project-name').textContent, 'SAMPLE ALVI');
  assert.deepEqual(c.order(), ['alvi', 'synapse-business', 'avokado']);
  c.pick('alvi'); await settle();
  assert.equal(c.puts.length, 1, 'повторный клик по текущему проекту не считается выбором');
  assert.deepEqual(c.errors, []); c.close();
});

test('№180: неизвестный исход PUT повторяется с тем же requestId, второй выбор не теряется', async () => {
  let fail = true;
  const c = cabinet({who: profile({projectPreferences: {lastCompanyCode: 'avokado', companies: [{companyCode: 'avokado', picks30d: 1, lastPickedAt: 1}]}}),
    put: () => fail ? Promise.reject(new Error('сеть')) : {ok: true, status: 200, json: async () => ({preferences: {lastCompanyCode: 'alvi', companies: []}})}});
  await settle();
  c.pick('alvi'); await settle();
  assert.equal(c.puts.length, 1);
  fail = false; c.w.dispatchEvent(new c.w.Event('online')); await settle();
  assert.equal(c.puts.length, 2);
  assert.equal(c.puts[0].body.requestId, c.puts[1].body.requestId);
  assert.deepEqual(c.errors, []); c.close();
});

test('№180: старый сервер без projectPreferences — выбор и частота на этом устройстве, запросов и ошибок нет', async () => {
  const now = Date.now(), old = now - 40 * 86400000;
  const log = JSON.stringify([{c: 'synapse-business', t: old}, {c: 'synapse-business', t: old}, {c: 'synapse-business', t: old},
    {c: 'alvi', t: now - 3000}, {c: 'alvi', t: now - 2000}, {c: 'avokado', t: now - 1000}]);
  const c = cabinet({who: profile(), local: {'sb-project-picks-v1:7': log, 'synapse_cabinet_project_v2:7': 'avokado'}});
  await settle();
  assert.equal(c.d.getElementById('project-name').textContent, 'SAMPLE Авокадо');
  assert.deepEqual(c.order(), ['avokado', 'alvi', 'synapse-business'], 'выборы старше 30 дней не считаются');
  c.pick('synapse-business'); await settle();
  assert.equal(c.puts.length, 0, 'на старый сервер PUT не отправляется');
  assert.equal(c.w.localStorage.getItem('synapse_cabinet_project_v2:7'), 'synapse-business');
  assert.deepEqual(c.order(), ['synapse-business', 'alvi', 'avokado']);
  assert.deepEqual(c.errors, []); c.close();
});

test('№180: недоступная компания из настроек не выбирается; у сотрудника только его компании', async () => {
  const c = cabinet({who: profile({companies: [COMPANIES[1]], projectPreferences: {lastCompanyCode: 'avokado', companies: [{companyCode: 'avokado', picks30d: 9, lastPickedAt: 9}]}})});
  await settle();
  assert.equal(c.d.getElementById('project-name').textContent, 'SAMPLE ALVI');
  assert.deepEqual(c.order(), ['alvi']);
  assert.deepEqual(c.errors, []); c.close();
});

test('№180: «Посмотреть как» не читает и не пишет личные предпочтения', async () => {
  const c = cabinet({who: profile({projectPreferences: null, viewAs: {active: true, readOnly: true, userId: 7, name: 'SAMPLE Лена'}}),
    local: {'synapse_cabinet_project_v2:7': 'alvi'}, session: {'synapse-view-as': 'sample-token', 'synapse-view-as-company': 'synapse-business'}});
  await settle();
  assert.equal(c.d.getElementById('project-name').textContent, 'SAMPLE Synapse');
  c.pick('avokado'); await settle();
  assert.equal(c.puts.length, 0);
  assert.equal(c.w.localStorage.getItem('sb-project-picks-v1:7'), null);
  assert.equal(c.w.localStorage.getItem('synapse_cabinet_project_v2:7'), 'alvi');
  assert.deepEqual(c.errors, []); c.close();
});

test('№180: сортировка — текущий, частота, давность, исходный порядок', () => {
  const dom = new JSDOM('', {runScripts: 'outside-only'});
  dom.window.eval(menuPrefs);
  const {sortProjects} = dom.window.SbCabinet.projectPreferences;
  const p = {companies: [{companyCode: 'b', picks30d: 3, lastPickedAt: 9}, {companyCode: 'c', picks30d: 3, lastPickedAt: 10}, {companyCode: 'foreign', picks30d: 100, lastPickedAt: 100}]};
  assert.deepEqual([...sortProjects(['u', 'a', 'b', 'c', 'new'], 'a', p)], ['a', 'c', 'b', 'u', 'new']);
  dom.window.close();
});
