'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(__dirname + '/vk-community.js', 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const SECRET = 'FIXTURE_PRIVATE_VK_TOKEN';
const settings = (companyCode = 'avokado', extra = {}) => ({ companyCode, groupId: companyCode === 'avokado' ? '12345' : '67890', revision: 1,
  configured: true, tokenConfigured: true, connected: true, status: 'connected', checkedAt: '2026-09-17T12:00:00Z', errorCode: null,
  group: { id: '12345', name: companyCode === 'avokado' ? 'Авокадо ВК' : 'АЛВИ ВК', screenName: 'fixture' }, ...extra });
const dialog = (peerId = 101, extra = {}) => ({ peerId, title: 'Клиент <img src=x>', unreadCount: 1, canReply: true,
  lastMessage: { id: 10, peerId, fromId: peerId, text: 'Текст <script>test</script>', date: 1789640000, out: false }, ...extra });
function fixture({ role = 'owner', override } = {}) {
  const errors = [], calls = [], views = {}, vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<main id="view"></main>', { url: 'https://cabinet.example.test/cabinet.html#vk-community', runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window, d = w.document, container = d.getElementById('view');
  w.SbCabinet = { registerView(name, view) { views[name] = view; } }; w.eval(source);
  let ctx = { selectedProjectId: 'avokado', identity: { role, companies: [{ id: 'avokado', name: 'Авокадо' }, { id: 'alvi', name: 'АЛВИ' }] },
    csrfOptions: (method, body) => ({ method, body: JSON.stringify(body), headers: { 'X-CSRF-Token': 'fixture-csrf' } }),
    async apiJson(url, options = {}) {
      const parsed = new URL(url, 'https://cabinet.example.test');
      const call = { path: parsed.pathname, companyCode: parsed.searchParams.get('companyCode'), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers };
      calls.push(call);
      assert.ok(call.companyCode === 'avokado' || call.companyCode === 'alvi', 'every call must be scoped');
      if (call.method !== 'GET') assert.equal(call.headers['X-CSRF-Token'], 'fixture-csrf');
      if (override) { const value = await override(call); if (value !== undefined) return value; }
      const base = { companyCode: call.companyCode, revision: 1 };
      if (call.path.endsWith('/autoposting/settings')) return { channels: [] };
      if (call.path.endsWith('/settings')) return settings(call.companyCode, call.method === 'PUT' ? { revision: 2, connected: false, status: 'needs_check' } : {});
      if (call.path.endsWith('/check')) return { ...settings(call.companyCode), ok: true };
      if (call.path.endsWith('/conversations')) return { ...base, count: 1, offset: call.body.offset, rawPageSize: 1, items: [dialog()] };
      if (call.path.endsWith('/history')) return { ...base, peerId: call.body.peerId, count: 1, offset: 0, items: [dialog(call.body.peerId).lastMessage] };
      if (call.path.endsWith('/reply')) return { ...base, peerId: call.body.peerId, requestId: call.body.requestId, status: 'sent', messageId: 99, code: null };
      assert.fail('Unexpected mock route: ' + call.path);
    }
  };
  const node = id => container.querySelector('#vk-' + id);
  return { dom, w, d, errors, calls, container, node,
    mount() { return views['vk-community'].render(container, ctx); },
    change(companyCode, role = ctx.identity.role, render = false) {
      ctx = { ...ctx, selectedProjectId: companyCode, identity: { ...ctx.identity, role } };
      return render ? views['vk-community'].render(container, ctx) : views['vk-community'].onProjectChange(ctx);
    },
    input(id, value) { node(id).value = value; node(id).dispatchEvent(new w.Event('input', { bubbles: true })); },
    submit(id) { node(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); },
    async inbox() { node('sync').click(); await tick(); container.querySelector('[data-peer]').click(); await tick(); },
    close() { assert.deepEqual(errors, []); w.close(); }
  };
}

test('non-owner sees no connection controls and makes no API calls', async () => {
  const f = fixture({ role: 'editor' }); try {
    await f.mount(); assert.equal(f.calls.length, 0); assert.equal(f.container.children.length, 0);
    await f.change('alvi'); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('initial owner rendering only reads selected-company settings and never checks, syncs or sends automatically', async () => {
  const f = fixture(); try {
    await f.mount(); assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.method === 'GET' && call.companyCode === 'avokado'));
    assert.deepEqual(f.calls.map(call => call.path), ['/content/crm/vk-community/settings', '/content/crm/autoposting/settings']);
    assert.equal(f.node('token').type, 'password'); assert.equal(f.node('token').value, '');
    assert.equal(f.node('reply-panel').hidden, true);
    assert.ok(f.container.querySelector('a[href="#ad-platforms"]')); assert.match(f.container.textContent, /Ручные снимки/);
  } finally { f.close(); }
});

test('save sends only an explicit secret input with CSRF and clears it afterwards without automatic verification', async () => {
  const f = fixture(); try {
    await f.mount(); f.input('token', SECRET); assert.equal(f.node('check').disabled, true); f.submit('settings-form'); await tick();
    const saved = f.calls.at(-1); assert.equal(saved.method, 'PUT');
    assert.deepEqual(saved.body, { revision: 1, groupId: '12345', communityToken: SECRET });
    assert.equal(f.node('token').value, ''); assert.doesNotMatch(f.container.innerHTML + f.container.textContent, new RegExp(SECRET));
    assert.equal(f.node('sync').disabled, true); assert.equal(f.calls.length, 3); assert.match(f.node('status').textContent, /Теперь проверьте доступ/);
    f.submit('settings-form'); await tick(); assert.equal(Object.hasOwn(f.calls.at(-1).body, 'communityToken'), false);
  } finally { f.close(); }
});

test('manual check, sync and history are separate explicit actions; remote text renders as text and read never sends', async () => {
  const f = fixture(); try {
    await f.mount(); f.node('check').click(); await tick();
    assert.equal(f.calls.at(-1).path, '/content/crm/vk-community/check'); assert.equal(f.calls.at(-1).method, 'POST');
    await f.inbox();
    assert.deepEqual(f.calls.slice(3).map(call => call.path), ['/content/crm/vk-community/conversations', '/content/crm/vk-community/history']);
    assert.equal(f.calls.at(-1).body.peerId, 101); assert.equal(f.node('reply-panel').hidden, false);
    assert.equal(f.container.querySelector('img,script'), null); assert.match(f.node('messages').textContent, /<script>test<\/script>/);
    assert.equal(f.calls.some(call => call.path.endsWith('/reply')), false);
  } finally { f.close(); }
});

test('typing a reply sends nothing; explicit submit is scoped and the confirmed response is shown once', async () => {
  const f = fixture(); try {
    await f.mount(); await f.inbox(); const before = f.calls.length;
    f.input('reply', 'Ответ <img src=x>'); await tick(); assert.equal(f.calls.length, before);
    f.submit('reply-panel'); await tick(); const call = f.calls.at(-1);
    assert.equal(call.path, '/content/crm/vk-community/reply'); assert.equal(call.companyCode, 'avokado');
    assert.equal(call.body.revision, 1); assert.equal(call.body.peerId, 101); assert.equal(call.body.text, 'Ответ <img src=x>');
    assert.match(call.body.requestId, /^[a-zA-Z0-9_-]{16,100}$/);
    assert.equal(f.node('reply').value, ''); assert.equal(f.node('send').disabled, true);
    assert.match(f.node('status').textContent, /ВК подтвердил отправку/); assert.equal(f.node('messages').querySelector('img'), null);
    assert.equal(f.node('messages').querySelectorAll('.vk-message-out').length, 1);
  } finally { f.close(); }
});

test('denied conversations do not offer a reply and cannot be sent through form submission', async () => {
  const f = fixture({ override: call => call.path.endsWith('/conversations') ? { companyCode: call.companyCode, revision: 1, offset: 0, count: 1, rawPageSize: 1, items: [dialog(101, { canReply: false })] } : undefined });
  try {
    await f.mount(); await f.inbox(); assert.equal(f.node('reply-panel').hidden, true); f.input('reply', 'Test'); f.submit('reply-panel'); await tick();
    assert.equal(f.calls.some(call => call.path.endsWith('/reply')), false);
  } finally { f.close(); }
});

test('uncertain, sending and lost-response results block resubmission even after editing the text', async () => {
  for (const status of ['uncertain', 'sending', 'lost']) {
    const f = fixture({ override: call => {
      if (!call.path.endsWith('/reply')) return;
      if (status === 'lost') throw new Error(SECRET);
      return { companyCode: call.companyCode, revision: 1, peerId: call.body.peerId, requestId: call.body.requestId, status, messageId: null, code: null };
    } });
    try {
      await f.mount(); await f.inbox(); f.input('reply', 'Test reply'); f.submit('reply-panel'); await tick();
      assert.equal(f.node('reply').value, 'Test reply'); assert.equal(f.node('send').disabled, true, status);
      assert.doesNotMatch(f.node('status').textContent, new RegExp(SECRET));
      f.input('reply', 'Edited while unconfirmed'); f.submit('reply-panel'); await tick();
      assert.equal(f.calls.filter(call => call.path.endsWith('/reply')).length, 1, status);
      assert.equal(f.node('messages').querySelectorAll('.vk-message-out').length, 0);
    } finally { f.close(); }
  }
});

test('late settings from a previously selected company do not reveal its group or start further reads', async () => {
  let resolveOld;
  const f = fixture({ override: call => call.companyCode === 'avokado' && call.path.endsWith('/vk-community/settings') ? new Promise(resolve => { resolveOld = resolve; }) : undefined });
  try {
    const pending = f.mount(); await f.change('alvi');
    resolveOld(settings('avokado', { group: { name: 'PRIVATE OLD GROUP' } })); await pending;
    assert.equal(f.node('group').value, '67890'); assert.doesNotMatch(f.container.textContent, /PRIVATE OLD GROUP/);
    assert.equal(f.calls.filter(call => call.companyCode === 'avokado').length, 1);
  } finally { f.close(); }
});

test('company switch clears an entered secret, draft and conversations immediately', async () => {
  const f = fixture();
  try {
    await f.mount(); await f.inbox(); f.input('reply', 'OLD PRIVATE DRAFT'); f.input('token', SECRET);
    assert.equal(f.node('token').value, SECRET); assert.equal(f.node('reply').value, 'OLD PRIVATE DRAFT');
    const changed = f.change('alvi');
    assert.equal(f.node('token').value, ''); assert.equal(f.node('reply').value, ''); assert.equal(f.node('messages').children.length, 0);
    assert.equal(f.container.querySelector('[data-peer]'), null);
    await changed;
    assert.doesNotMatch(f.container.textContent, /OLD PRIVATE DRAFT/); assert.equal(f.node('group').value, '67890');
    assert.ok(f.calls.filter(call => call.companyCode === 'alvi').every(call => call.method === 'GET'));
  } finally { f.close(); }
});

test('late conversation history is discarded after changing company', async () => {
  let release;
  const f = fixture({ override: call => call.path.endsWith('/history') ? new Promise(resolve => { release = resolve; }) : undefined });
  try {
    await f.mount(); f.node('sync').click(); await tick(); f.container.querySelector('[data-peer]').click(); await tick();
    await f.change('alvi');
    release({ companyCode: 'avokado', revision: 1, peerId: 101, count: 1, items: [{ ...dialog().lastMessage, text: 'LATE PRIVATE HISTORY' }] }); await tick();
    assert.doesNotMatch(f.container.textContent, /LATE PRIVATE HISTORY/); assert.equal(f.node('group').value, '67890');
  } finally { f.close(); }
});

test('late send success from the old company cannot populate the new company conversation', async () => {
  let release;
  const f = fixture({ override: call => call.path.endsWith('/reply') ? new Promise(resolve => { release = () => resolve({ companyCode: call.companyCode, revision: 1, peerId: call.body.peerId, requestId: call.body.requestId, status: 'sent', messageId: 99 }); }) : undefined });
  try {
    await f.mount(); await f.inbox(); f.input('reply', 'OLD SENT TEXT'); f.submit('reply-panel'); await tick(); await f.change('alvi');
    release(); await tick(); assert.doesNotMatch(f.container.textContent, /OLD SENT TEXT|ВК подтвердил отправку/);
    assert.equal(f.node('messages').children.length, 0); assert.equal(f.node('reply-panel').hidden, true);
  } finally { f.close(); }
});

test('losing owner role during a request removes private UI and does not revive it after the response', async () => {
  let release;
  const f = fixture({ override: call => call.path.endsWith('/history') ? new Promise(resolve => { release = resolve; }) : undefined });
  try {
    await f.mount(); f.node('sync').click(); await tick(); f.container.querySelector('[data-peer]').click(); await tick();
    await f.change('avokado', 'editor', true); assert.equal(f.container.children.length, 0);
    release({ companyCode: 'avokado', revision: 1, peerId: 101, items: [{ ...dialog().lastMessage, text: 'PRIVATE AFTER ROLE LOST' }] }); await tick();
    assert.equal(f.container.children.length, 0); assert.equal(f.calls.filter(call => call.path.endsWith('/reply')).length, 0);
  } finally { f.close(); }
});

test('pagination advances by the raw 30-item page even when filtering leaves no personal dialogs', async () => {
  const f = fixture({ override: call => call.path.endsWith('/conversations') ? {
    companyCode: call.companyCode, revision: 1, offset: call.body.offset, count: 61, items: []
  } : undefined });
  try {
    await f.mount(); f.node('sync').click(); await tick();
    assert.equal(f.node('next').disabled, false); assert.equal(f.node('previous').disabled, true);
    assert.match(f.node('page-label').textContent, /Страница 1 из 3/);
    f.node('next').click(); await tick();
    assert.equal(f.calls.at(-1).body.offset, 30); assert.equal(f.node('next').disabled, false);
    assert.match(f.node('page-label').textContent, /Страница 2 из 3/);
    f.node('next').click(); await tick();
    assert.equal(f.calls.at(-1).body.offset, 60); assert.equal(f.node('next').disabled, true);
    assert.equal(f.node('previous').disabled, false); assert.match(f.node('page-label').textContent, /Страница 3 из 3/);
  } finally { f.close(); }
});

test('losing owner through render invalidates a pending reply without showing its later success or sending again', async () => {
  let release;
  const f = fixture({ override: call => call.path.endsWith('/reply') ? new Promise(resolve => {
    release = () => resolve({ companyCode: call.companyCode, revision: 1, peerId: call.body.peerId, requestId: call.body.requestId, status: 'sent', messageId: 99 });
  }) : undefined });
  try {
    await f.mount(); await f.inbox(); f.input('reply', 'PRIVATE PENDING SEND'); f.submit('reply-panel'); await tick();
    await f.change('avokado', 'editor', true); assert.equal(f.container.children.length, 0);
    release(); await tick(); assert.equal(f.container.children.length, 0);
    assert.equal(f.calls.filter(call => call.path.endsWith('/reply')).length, 1);
    await f.change('alvi', 'owner', true); assert.equal(f.node('group').value, '67890');
    assert.doesNotMatch(f.container.textContent, /PRIVATE PENDING SEND|ВК подтвердил отправку/);
    assert.equal(f.node('reply').value, ''); assert.equal(f.node('messages').children.length, 0);
  } finally { f.close(); }
});
