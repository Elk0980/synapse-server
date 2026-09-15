const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {JSDOM, VirtualConsole} = require('jsdom');
const {createEmailSettings} = require('../../../ops/crm/email-settings');
const html = fs.readFileSync(path.join(__dirname, '../cabinet.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, 'settings.js'), 'utf8');
const password = 'UI_SENTINEL_APP_PASSWORD';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture({provider = 'gmail', role = 'owner', checkError} = {}) {
  const db = new DatabaseSync(':memory:'), calls = [], connections = [], errors = [], views = {};
  const store = createEmailSettings(db, {apiKey: 'fixture-encryption-key', environment: {}, createTransport: options => {
    connections.push(options);
    return {verify: async () => {if (checkError) throw checkError; return true;},
      sendMail() { assert.fail('settings UI must never send email'); }};
  }});
  store.save({provider, user: 'notifications@synapsebusiness.test', password,
    alviRecipient: 'alvi@example.test', avokadoRecipient: 'avokado@example.test'});
  const vc = new VirtualConsole();vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {url: 'https://cabinet.test/cabinet.html', runScripts: 'outside-only', virtualConsole: vc});
  const w = dom.window, d = w.document;
  w.SbCabinet = {registerView: (name, view) => {views[name] = view;}};
  w.eval(script);
  const apiJson = async (url, options = {}) => {
    calls.push({url, method: options.method || 'GET', body: options.body, headers: options.headers});
    if (url === '/content/admin/hugh-settings') return {settings: {owner:'subscription', client:'subscription', visitor:'subscription'}};
    if (url === '/content/crm/email-status') return {checkedAt: '2026-09-15T00:00:00Z',
      smtp: {configured:true, host:true, port:true, user:true, password:true, from:true}, companies: []};
    if (options.method && options.method !== 'GET') assert.equal(options.headers['X-CSRF-Token'], 'fixture-csrf');
    if (url === '/content/crm/email-settings/check') return store.check();
    if (url === '/content/crm/email-settings' && options.method === 'PUT') return store.save(JSON.parse(options.body));
    if (url === '/content/crm/email-settings') return store.getPublic();
    throw new Error('Unexpected fixture route');
  };
  await views.settings.render(null, {identity: {role, csrfToken: 'fixture-csrf'}, byId: id => d.getElementById(id), apiJson});
  return {w, d, store, calls, connections, errors,
    field: id => d.getElementById(`email-${id}`),
    settle: async () => {for (let i = 0; i < 5; i++) await tick();},
    close: () => {w.close();db.close();}};
}

test('actual settings UI loads Google and both existing providers and saves recipient edits without exposing or replacing the password', async () => {
  for (const provider of ['gmail', 'yandex', 'mailru']) {
    const f = await fixture({provider});
    try {
      assert.equal(f.field('provider').value, provider);
      assert.ok([...f.field('provider').options].some(option => option.value === 'gmail' && option.textContent.includes('Google Workspace')));
      assert.equal(f.field('password').value, '');
      assert.equal(f.field('password').required, false);
      assert.equal(f.connections.length, 0, 'opening settings must not contact SMTP');
      f.field('alvi-recipient').value = 'updated@example.test';
      f.field('alvi-recipient').dispatchEvent(new f.w.Event('input', {bubbles:true}));
      f.d.getElementById('email-settings-save').click();await f.settle();
      const saved = f.calls.find(call => call.method === 'PUT');
      assert.ok(saved);
      assert.equal(JSON.parse(saved.body).provider, provider);
      assert.equal(Object.hasOwn(JSON.parse(saved.body), 'password'), false);
      assert.equal(f.store.getPublic().alviRecipient, 'updated@example.test');
      assert.equal(f.store.getEnvironment().LEADS_SMTP_PASSWORD, password);
      assert.equal(f.field('password').value, '');
      assert.equal(f.connections.length, 0);
      assert.deepEqual(f.errors, []);
    } finally { f.close(); }
  }
});

test('switching to Workspace requires a new app password, retains Gmail on refresh, and checks only the saved sender', async () => {
  const f = await fixture({provider:'mailru'});
  try {
    f.field('provider').value = 'gmail';
    f.field('provider').dispatchEvent(new f.w.Event('input', {bubbles:true}));
    f.d.getElementById('email-settings-form').dispatchEvent(new f.w.Event('submit', {bubbles:true, cancelable:true}));
    await f.settle();
    assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
    assert.match(f.d.getElementById('email-settings-status').textContent, /Введите пароль приложения/);
    f.field('password').value = 'NEW_UI_SENTINEL_PASSWORD';
    f.d.getElementById('email-settings-save').click();await f.settle();
    assert.equal(f.store.getPublic().provider, 'gmail');
    assert.equal(f.field('provider').value, 'gmail');
    assert.equal(f.field('password').value, '');
    assert.equal(f.field('password').required, false);
    assert.equal(f.connections.length, 0);
    f.d.getElementById('email-settings-check').click();await f.settle();
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0].host, 'smtp.gmail.com');
    assert.equal(f.connections[0].port, 465);
    assert.equal(f.connections[0].secure, true);
    assert.match(f.d.getElementById('email-settings-status').textContent, /подтверждено/);
    assert.match(f.d.getElementById('email-settings-status').textContent, /не отправляет письма/);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('Google authentication failures show a safe message; nonowners cannot load mail settings', async () => {
  const f = await fixture({checkError:Object.assign(new Error('PRIVATE_SMTP_RESPONSE UI_SENTINEL_APP_PASSWORD'), {code:'EAUTH'})});
  try {
    f.d.getElementById('email-settings-check').click();await f.settle();
    const status = f.d.getElementById('email-settings-status').textContent;
    assert.match(status, /Не удалось войти в почтовый ящик/);
    assert.doesNotMatch(status, /PRIVATE|SENTINEL/);
    assert.equal(f.field('password').value, '');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
  const nonowner = await fixture({role:'admin'});
  try {
    assert.equal(nonowner.calls.length, 0);
    assert.equal(nonowner.connections.length, 0);
    assert.equal(nonowner.d.getElementById('settings-email').hidden, true);
  } finally { nonowner.close(); }
});
