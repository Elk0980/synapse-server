'use strict';

// UI test for the company recipient card (AVOCADO-MULTI-RECIPIENT-20261027).
// Uses jsdom when it is available in the test environment; the repository package.json is not changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM;
try { ({JSDOM} = require('jsdom')); } catch { JSDOM = null; }
const SOURCE = fs.readFileSync(path.join(__dirname, 'settings.js'), 'utf8');
const A = 'owner@example.test', B = 'admin@example.test';

function cabinet(apiJson, {role = 'owner'} = {}) {
  const dom = new JSDOM('<!doctype html><main id="view"></main>', {runScripts: 'outside-only', url: 'https://cabinet.example.test/'});
  const views = {};
  dom.window.SbCabinet = {registerView: (name, view) => { views[name] = view; }};
  dom.window.eval(SOURCE);
  const context = {selectedProjectId: 'avokado', apiJson, escapeHTML: value => String(value).replace(/[&<>"']/g, ''),
    identity: {role, csrfToken: 'csrf-fixture', companies: [{id: 'avokado', name: 'Авокадо'}, {id: 'alvi', name: 'ALVI'}]},
    byId: id => dom.window.document.getElementById(id)};
  const container = dom.window.document.getElementById('view');
  const render = async code => { context.selectedProjectId = code; container.replaceChildren(); await views.settings.render(container, context); };
  return {dom, container, render, input: () => container.querySelector('input[name=recipient]'),
    status: () => container.querySelector('[role=status]').textContent, form: () => container.querySelector('form')};
}
const list = value => value.split(',').map(item => item.trim()).filter(Boolean);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const companyData = (recipient, recipients) => ({companyCode: 'avokado', recipient, recipients, senderConfigured: true,
  status: {smtp: {}, companies: [{code: 'avokado', recipientConfigured: Boolean(recipient), queued: 0, sending: 0, sent: 0, errors: []}]}});

test('the card documents the list format, saves the whole list and shows it again after reload', {skip: !JSDOM && 'jsdom is not installed'}, async () => {
  let stored = companyData(A, [A]);
  const calls = [];
  const ui = cabinet(async (url, options = {}) => {
    calls.push({url, method: options.method || 'GET', body: options.body, csrf: options.headers?.['X-CSRF-Token']});
    if (options.method === 'PUT') {
      const recipient = JSON.parse(options.body).recipient.split(',').map(item => item.trim()).filter(Boolean).join(', ');
      stored = companyData(recipient, recipient ? recipient.split(', ') : []);
    }
    return stored;
  });
  await ui.render('avokado');
  assert.match(ui.container.textContent, /до 5 адресов через запятую/);
  assert.equal(ui.input().value, A);
  assert.equal(ui.input().multiple, true);
  assert.equal(ui.input().maxLength, 1024);
  ui.input().value = `${A},   ${B} `;
  ui.form().dispatchEvent(new ui.dom.window.Event('submit', {cancelable: true}));
  await settle();
  const put = calls.find(call => call.method === 'PUT');
  assert.equal(put.url, '/content/crm/company-email?companyCode=avokado');
  // type=email multiple: the browser itself strips spaces around commas (HTML value sanitization).
  assert.deepEqual(JSON.parse(put.body), {recipient: `${A},${B}`});
  assert.equal(put.csrf, 'csrf-fixture');
  assert.deepEqual(list(ui.input().value), [A, B], 'the list returned by the server is shown (the browser renders it without spaces)');
  assert.match(ui.status(), /Получатели сохранены для Авокадо: 2/);
  await ui.render('avokado');
  assert.deepEqual(list(ui.input().value), [A, B], 'the full list is shown after reload');
  ui.input().value = '';
  ui.form().dispatchEvent(new ui.dom.window.Event('submit', {cancelable: true}));
  await settle();
  assert.equal(JSON.parse(calls.filter(call => call.method === 'PUT').at(-1).body).recipient, '');
  assert.match(ui.status(), /отключены/);
});

test('a malformed list is not sent; a server refusal shows the format without private details', {skip: !JSDOM && 'jsdom is not installed'}, async () => {
  const calls = [];
  const ui = cabinet(async (url, options = {}) => {
    calls.push(options.method || 'GET');
    if (options.method === 'PUT') throw Object.assign(new Error('SENTINEL owner@example.test'), {status: 400});
    return companyData(A, [A]);
  });
  await ui.render('avokado');
  ui.input().value = `${A}; ${B}`;
  ui.form().dispatchEvent(new ui.dom.window.Event('submit', {cancelable: true}));
  await settle();
  assert.deepEqual(calls, ['GET'], 'the browser check stops a value that is not an address list');
  ui.input().value = `${A}, ${B}`;
  ui.form().dispatchEvent(new ui.dom.window.Event('submit', {cancelable: true}));
  await settle();
  assert.deepEqual(calls, ['GET', 'PUT']);
  assert.match(ui.status(), /до 5 корректных адресов через запятую/);
  assert.doesNotMatch(ui.status(), /SENTINEL|owner@/);
});

test('a late response of the previously selected company never overwrites the current one', {skip: !JSDOM && 'jsdom is not installed'}, async () => {
  let releaseAvokado;
  const ui = cabinet(url => url.includes('avokado')
    ? new Promise(resolve => { releaseAvokado = () => resolve(companyData(`${A}, ${B}`, [A, B])); })
    : Promise.resolve({...companyData('alvi@example.test', ['alvi@example.test']), companyCode: 'alvi'}));
  const first = ui.render('avokado');
  await ui.render('alvi');
  assert.equal(ui.input().value, 'alvi@example.test');
  releaseAvokado(); await first; await settle();
  assert.equal(ui.input().value, 'alvi@example.test');
});

test('only the owner sees the recipient form', {skip: !JSDOM && 'jsdom is not installed'}, async () => {
  const ui = cabinet(async () => assert.fail('no request for a non-owner'), {role: 'manager'});
  await ui.render('avokado');
  assert.equal(ui.form(), null);
});
