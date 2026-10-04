'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createVkDirect } = require('./vk-direct');
const reply = value => new Response(JSON.stringify({ response: value }), { status: 200 });
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(code) VALUES('demo-a'),('demo-b');`);
  const calls = [], behavior = { override: null };
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop(), params = new URLSearchParams(init.body);
    calls.push({ method, params, init, url });
    assert.equal(new URL(url).origin, 'https://api.vk.com');
    assert.equal(init.redirect, 'error'); assert.equal(params.has('access_token'), false);
    assert.ok(init.headers.Authorization.startsWith('Bearer fixture-'));
    if (behavior.override) { const result = await behavior.override(method, params, init); if (result) return result; }
    if (method === 'account.getProfileInfo') return reply({ id: 10 });
    if (method === 'groups.getTokenPermissions') return reply({ mask: 1, permissions: [] });
    if (method === 'groups.getById') return reply({ groups: [{ id: Number(params.get('group_id')), members_count: 8 }] });
    if (method === 'stats.get') return reply([{ visitors: { views: 20 }, reach: { reach: 12 }, activity: { likes: 3 } }]);
    return reply(1);
  };
  const direct = createVkDirect(db, { apiKey: 'fixture-storage-key', fetchImpl, now: () => Date.parse('2026-10-04T12:00:00Z'), ...options });
  const save = (code = 'demo-a', purpose = 'analytics', fields = {}) => direct.saveSettings(code, purpose,
    { revision: 0, groupId: '101', tokenType: 'user', accessToken: 'fixture-user-a', ...fields });
  return { db, direct, save, calls, behavior };
}
test('separate company/purpose encrypted storage, DTO redaction and exact revision', t => {
  const { db, direct, save } = fixture(t);
  save(); save('demo-a', 'design', { accessToken: 'fixture-design-a', tokenType: 'group' }); save('demo-b');
  assert.equal(db.prepare('SELECT count(*) n FROM vk_direct_connections').get().n, 3);
  const a = db.prepare("SELECT encrypted_token FROM vk_direct_connections WHERE company_code='demo-a' AND purpose='analytics'").get().encrypted_token;
  assert.ok(!a.includes('fixture-user-a'));
  assert.ok(!JSON.stringify(direct.getSettings('DEMO-A', 'analytics')).includes('fixture-'));
  assert.throws(() => save(), { code: 'SETTINGS_CHANGED' });
  assert.throws(() => save('demo-a', 'analytics', { revision: 1, groupId: '102', accessToken: '' }), { code: 'VALIDATION_ERROR' });
  const changed = save('demo-a', 'analytics', { revision: 1, accessToken: '', enabled: false });
  assert.equal(changed.status, 'disabled'); assert.equal(changed.revision, 2);
  assert.equal(direct.getSettings('demo-a', 'design').revision, 1);
});
test('encrypted envelopes cannot move across purpose, group or token type', async t => {
  const { db, direct, save } = fixture(t);
  save(); save('demo-a', 'design');
  db.exec("UPDATE vk_direct_connections SET encrypted_token=(SELECT encrypted_token FROM vk_direct_connections WHERE purpose='analytics') WHERE purpose='design'");
  assert.equal((await direct.checkConnection('demo-a', 'design')).code, 'TOKEN_UNREADABLE');
  db.exec("UPDATE vk_direct_connections SET group_id='102' WHERE purpose='analytics'");
  assert.equal((await direct.checkConnection('demo-a', 'analytics')).code, 'TOKEN_UNREADABLE');
});
test('analytics requires user type and probes actual user, group and statistics', async t => {
  const { direct, save, calls, behavior } = fixture(t);
  assert.throws(() => save('demo-a', 'analytics', { tokenType: 'group' }), { code: 'VALIDATION_ERROR' });
  save(); const checked = await direct.checkConnection('demo-a', 'analytics');
  assert.equal(checked.connected, true); assert.equal(checked.ok, true);
  assert.deepEqual(calls.map(x => x.method), ['account.getProfileInfo', 'groups.getById', 'stats.get']);
  behavior.override = method => method === 'account.getProfileInfo' ? reply({}) : null;
  assert.equal((await direct.checkConnection('demo-a', 'analytics')).code, 'TOKEN_TYPE_MISMATCH');
  assert.equal(direct.getSettings('demo-a', 'analytics').connected, false);
});
test('design verifies group type but never claims edit rights from read check', async t => {
  const { direct, save, calls } = fixture(t);
  save('demo-a', 'design', { tokenType: 'group', accessToken: 'fixture-group-a' });
  const state = await direct.checkConnection('demo-a', 'design');
  assert.equal(state.connected, true); assert.equal(state.capabilities.editingRightsVerified, false);
  assert.deepEqual(calls.map(x => x.method), ['groups.getTokenPermissions', 'groups.getById']);
});
test('foreign group and changes during check never connect or expose provider errors', async t => {
  const { direct, save, behavior } = fixture(t); save();
  behavior.override = method => method === 'groups.getById' ? reply({ groups: [{ id: 999 }] }) : null;
  assert.equal((await direct.checkConnection('demo-a', 'analytics')).code, 'GROUP_MISMATCH');
  behavior.override = method => {
    if (method === 'account.getProfileInfo') { save('demo-a', 'analytics', { revision: 1, accessToken: 'fixture-new' }); return reply({ id: 10 }); }
  };
  assert.equal((await direct.checkConnection('demo-a', 'analytics')).code, 'SETTINGS_CHANGED');
  assert.equal(direct.getSettings('demo-a', 'analytics').status, 'needs_check');
  behavior.override = () => new Response(JSON.stringify({ error: { error_code: 5, error_msg: 'fixture-new', request_params: [{ access_token: 'fixture-new' }] } }));
  const failure = await direct.checkConnection('demo-a', 'analytics');
  assert.equal(failure.code, 'ACCESS_DENIED'); assert.ok(!JSON.stringify(failure).includes('fixture-new'));
});
test('request uses checked revision, purpose allowlist and forcibly bound group', async t => {
  const { direct, save, calls } = fixture(t); save();
  await assert.rejects(direct.request('demo-a', 'analytics', 1, 'stats.get'), { code: 'CONNECTION_MISSING' });
  await direct.checkConnection('demo-a', 'analytics'); const before = calls.length;
  await assert.rejects(direct.request('demo-a', 'analytics', 1, 'groups.edit', { description: 'x' }), { code: 'METHOD_DENIED' });
  await assert.rejects(direct.request('demo-a', 'analytics', 0, 'stats.get'), { code: 'SETTINGS_CHANGED' });
  await assert.rejects(direct.request('demo-a', 'analytics', 1, 'stats.get', { group_id: '202' }), { code: 'GROUP_MISMATCH' });
  await assert.rejects(direct.request('demo-a', 'analytics', 1, 'stats.get', { access_token: 'fixture-wrong' }), { code: 'VALIDATION_ERROR' });
  assert.equal(calls.length, before);
  await direct.request('demo-a', 'analytics', 1, 'stats.get');
  assert.equal(calls.at(-1).params.get('group_id'), '101');
});
test('mutating timeout and malformed result are uncertain, rejection is definite, no retry', async t => {
  const { direct, save, behavior, calls } = fixture(t, { timeoutMs: 20 });
  save('demo-a', 'design'); await direct.checkConnection('demo-a', 'design');
  behavior.override = () => new Promise(() => {});
  const count = calls.length;
  await assert.rejects(direct.request('demo-a', 'design', 1, 'groups.edit', { description: 'x' }), e => e.uncertain && e.ambiguous && e.code === 'CONNECTION_UNCERTAIN');
  assert.equal(calls.length, count + 1);
  behavior.override = () => new Response('not json');
  await assert.rejects(direct.request('demo-a', 'design', 1, 'groups.edit', { description: 'x' }), e => e.uncertain && e.code === 'RESPONSE_INVALID');
  behavior.override = () => new Response(JSON.stringify({ error: { error_code: 15, error_msg: 'fixture-secret' } }));
  await assert.rejects(direct.request('demo-a', 'design', 1, 'groups.edit', { description: 'x' }), e => !e.uncertain && !e.message.includes('fixture-secret'));
});
test('bounded body and body timeout; save cover does not receive group_id', async t => {
  const { direct, save, behavior, calls } = fixture(t, { timeoutMs: 25 });
  save('demo-a', 'design'); await direct.checkConnection('demo-a', 'design');
  await direct.request('demo-a', 'design', 1, 'photos.saveOwnerCoverPhoto', { hash: 'fixture-hash', photo: 'fixture-photo' });
  assert.equal(calls.at(-1).params.has('group_id'), false);
  behavior.override = () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(direct.request('demo-a', 'design', 1, 'groups.getById'), { code: 'RESPONSE_INVALID' });
  behavior.override = () => new Response(new ReadableStream({ start() {} }));
  await assert.rejects(direct.request('demo-a', 'design', 1, 'groups.getById'), { code: 'CONNECTION_UNCERTAIN' });
});
test('accepted mutation receipt survives a concurrent rebind for caller journaling', async t => {
  const { direct, save, behavior } = fixture(t); save('demo-a', 'design'); await direct.checkConnection('demo-a', 'design');
  behavior.override = method => { if (method === 'groups.edit') { save('demo-a', 'design', { revision: 1, groupId: '202', accessToken: 'fixture-new' }); return reply(1); } };
  assert.equal(await direct.request('demo-a', 'design', 1, 'groups.edit', { description: 'x' }), 1);
  assert.equal(direct.getSettings('demo-a', 'design').revision, 2);
});
test('internal design transport cannot change other community fields or video cover', async t => {
  const { direct, save, calls } = fixture(t); save('demo-a', 'design'); await direct.checkConnection('demo-a', 'design');
  const before = calls.length;
  await assert.rejects(direct.request('demo-a', 'design', 1, 'groups.edit', { description: 'x', title: 'unapproved' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(direct.request('demo-a', 'design', 1, 'photos.getOwnerCoverPhotoUploadServer', { is_video_cover: 1 }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(direct.request('demo-a', 'design', 1, 'photos.saveOwnerCoverPhoto', { group_id: '101', hash: 'x', photo: 'y' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(direct.request('demo-a', 'design', 1, 'account.getProfileInfo'), { code: 'METHOD_DENIED' });
  assert.equal(calls.length, before);
});
test('applied mutation followed by 5xx, runtime, unknown or malformed error remains uncertain without retry', async t => {
  const { direct, save, behavior } = fixture(t); save('demo-a', 'design'); await direct.checkConnection('demo-a', 'design');
  let applies = 0;
  for (const [status, error] of [[500, { error_code: 10 }], [503, { error_code: 15 }],
    [200, { error_code: 1 }], [200, { error_code: 13 }], [200, {}], [200, { error_code: '15' }], [200, null]]) {
    behavior.override = method => {
      assert.equal(method, 'groups.edit'); applies += 1;
      return new Response(JSON.stringify({ error }), { status });
    };
    const before = applies;
    await assert.rejects(direct.request('demo-a', 'design', 1, 'groups.edit', { description: 'fixture-applied' }),
      e => e.code === 'CONNECTION_UNCERTAIN' && e.uncertain && e.ambiguous);
    assert.equal(applies, before + 1);
  }
  for (const code of [6, 100, 15]) {
    behavior.override = () => new Response(JSON.stringify({ error: { error_code: code } }), { status: 400 });
    await assert.rejects(direct.request('demo-a', 'design', 1, 'groups.edit', { description: 'fixture-rejected' }), e => !e.uncertain && !e.ambiguous);
  }
});
