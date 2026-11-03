'use strict';
// spec092 cabinet view: jsdom, mocked API only.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const {JSDOM} = require('jsdom');
const source = fs.readFileSync(__dirname + '/vk-events.js', 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const settings = (companyCode, extra = {}) => ({companyCode, groupId: companyCode === 'palitra-love' ? '241948768' : '111', revision: 2, configured: true, group: null,
  callback: {enabled: true, secretConfigured: true, confirmationConfigured: true, endpointPath: '/public-vk-callback/' + 'A'.repeat(32), confirmedAt: null, lastEventAt: null, rejected: 0},
  longPoll: {enabled: true, tokenConfigured: true, checked: true, running: false, status: 'stopped', vkEnabled: true, apiVersion: '5.199', apiVersionMatches: true,
    vkEnabledEvents: ['message_new'], gaps: 0, invalidUpdates: 0},
  events: {documented: [{section: 'messages', types: [{type: 'message_new', longPollSetting: true}, {type: 'message_event', longPollSetting: false}]}], longPollSchemaOnly: ['message_reaction_event'], unknownSeen: []},
  capabilities: {callbackEvents: false, longPollEvents: false, market: false, statistics: false, design: false, outgoing: false}, ...extra});

function fixture(override, role = 'owner') {
  const dom = new JSDOM('<main></main>', {url: 'https://synapse.example', runScripts: 'outside-only'}), w = dom.window, container = w.document.querySelector('main'), calls = [];
  w.eval(source);
  let ctx = {identity: {role}, csrfOptions: (method, body) => ({method, body: JSON.stringify(body), headers: {'X-CSRF-Token': 'test'}}),
    async apiJson(url, options = {}) {
      const u = new URL(url, 'https://synapse.example'), call = {path: u.pathname.replace('/content/crm/vk-events', ''), companyCode: u.searchParams.get('companyCode'),
        query: Object.fromEntries(u.searchParams), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers};
      calls.push(call);
      if (call.method !== 'GET') assert.equal(call.headers['X-CSRF-Token'], 'test');
      if (override) { const value = await override(call); if (value !== undefined) return value; }
      if (call.path === '/settings') return settings(call.companyCode, call.method === 'PUT' ? {revision: 3} : {});
      if (call.path === '/journal') return {companyCode: call.companyCode, revision: 2, groupId: '241948768', items: [
        {id: 2, eventId: 'e2', type: '<img src=x onerror=alert(1)>', known: false, transports: ['callback'], receivedAt: '2026-10-06T10:00:00Z', duplicates: 0},
        {id: 1, eventId: 'e1', type: 'message_new', known: true, transports: ['callback', 'longpoll'], receivedAt: '2026-10-06T09:00:00Z', duplicates: 1}]};
      if (call.path === '/check') return {...settings(call.companyCode), ok: true, code: null};
      if (call.path === '/longpoll') return settings(call.companyCode, {longPoll: {...settings(call.companyCode).longPoll, running: call.body.action === 'start', status: call.body.action === 'start' ? 'listening' : 'stopped'}});
      if (call.path === '/revoke') return settings(call.companyCode, {revision: 3});
      assert.fail('unexpected ' + call.path);
    }};
  const ui = w.SbCabinet.mountVkEvents(container, ctx), node = id => container.querySelector('#vke-' + id);
  return {w, calls, container, node, ui, mount: (code = 'palitra-love') => ui.update(ctx, code),
    change(code, newRole = 'owner') { ctx = {...ctx, identity: {role: newRole}}; return ui.update(ctx, code); },
    input(id, value) { node(id).value = value; node(id).dispatchEvent(new w.Event('input', {bubbles: true})); },
    close() { ui.destroy(); w.close(); }};
}

test('mount reads only settings and journal; secrets are password fields; journal is text, not HTML', async () => {
  const f = fixture();
  try {
    await f.mount(); await settle();
    assert.deepEqual(f.calls.map(c => [c.method, c.path]), [['GET', '/settings'], ['GET', '/journal']]);
    for (const id of ['cb-secret', 'cb-confirm', 'lp-token']) { assert.equal(f.node(id).type, 'password'); assert.equal(f.node(id).value, ''); }
    assert.equal(f.container.querySelector('img'), null, 'event type never parsed as HTML');
    assert.match(f.node('journal').textContent, /неизвестный тип/); assert.match(f.node('journal').textContent, /Callback \+ Long Poll/);
    assert.equal(f.node('url').textContent, 'https://synapse.example/public-vk-callback/' + 'A'.repeat(32));
    assert.match(f.node('catalog-body').textContent, /message_event \(нет в настройках Long Poll/);
    assert.equal(f.node('lp-start').disabled, false); assert.equal(f.node('lp-stop').disabled, true);
  } finally { f.close(); }
});

test('save sends revision, CSRF and only typed secrets, then clears secret fields', async () => {
  const f = fixture();
  try {
    await f.mount(); await settle();
    f.input('cb-secret', 'FIXTURE_SECRET'); f.input('lp-token', 'FIXTURE_TOKEN');
    assert.equal(f.node('lp-start').disabled, true, 'unsaved edits block start');
    f.node('form').dispatchEvent(new f.w.Event('submit', {cancelable: true, bubbles: true})); await settle();
    const put = f.calls.find(c => c.method === 'PUT');
    assert.deepEqual(put.body, {revision: 2, groupId: '241948768', callback: {enabled: true, secret: 'FIXTURE_SECRET'}, longPoll: {enabled: true, communityToken: 'FIXTURE_TOKEN'}});
    assert.equal(f.node('cb-secret').value, ''); assert.equal(f.node('lp-token').value, '');
    assert.ok(!f.container.innerHTML.includes('FIXTURE_SECRET') && !f.container.innerHTML.includes('FIXTURE_TOKEN'));
  } finally { f.close(); }
});

test('start/stop and two-step revoke post the current revision', async () => {
  const f = fixture();
  try {
    await f.mount(); await settle();
    f.node('lp-start').click(); await settle();
    assert.deepEqual(f.calls.at(-1).body, {revision: 2, action: 'start'}); assert.equal(f.node('lp-stop').disabled, false);
    f.node('revoke-longpoll').click(); await settle();
    assert.equal(f.calls.at(-1).path, '/longpoll', 'first click only arms');
    f.node('revoke-longpoll').click(); await settle();
    assert.deepEqual([f.calls.at(-1).path, f.calls.at(-1).body], ['/revoke', {revision: 2, transport: 'longpoll'}]);
  } finally { f.close(); }
});

test('company switch discards late responses; losing owner role clears the view', async () => {
  let release;
  const f = fixture(call => call.companyCode === 'palitra-love' && call.path === '/settings' && call.method === 'GET' && !release
    ? new Promise(resolve => { release = () => resolve(settings('palitra-love', {groupId: '999'})); }) : undefined);
  try {
    const first = f.mount(); await settle();
    await f.change('alvi'); await settle();
    assert.equal(f.node('group').value, '111');
    await f.change('palitra-love'); await settle();   // same company again: only the epoch distinguishes the late reply
    release(); await first; await settle();
    assert.equal(f.node('group').value, '241948768');
    assert.notEqual(f.node('status').textContent, 'Загружаем настройки событий…');
    f.change('alvi', 'editor');
    assert.equal(f.container.children.length, 0);
  } finally { f.close(); }
});

test('stale revision reloads settings instead of applying the action', async () => {
  let conflict = true;
  const f = fixture(call => call.path === '/check' && conflict ? (conflict = false, Promise.reject(Object.assign(Error('x'), {code: 'SETTINGS_CHANGED'}))) : undefined);
  try {
    await f.mount(); await settle();
    f.node('check').click(); await settle();
    assert.deepEqual(f.calls.slice(-3).map(c => c.path), ['/check', '/settings', '/journal']);
  } finally { f.close(); }
});
