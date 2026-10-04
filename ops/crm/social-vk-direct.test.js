'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createVkDirect } = require('./vk-direct');
const { createSocialAdapters } = require('./social-adapters');
const { createSocialStats } = require('./social-stats');
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE,name TEXT DEFAULT '',timezone TEXT DEFAULT 'Asia/Irkutsk',is_deleted INTEGER DEFAULT 0); INSERT INTO companies(code) VALUES('demo-a'),('demo-b');
    CREATE TABLE autoposting_channels(company_code TEXT,platform TEXT,provider TEXT,encrypted_token TEXT); INSERT INTO autoposting_channels VALUES('demo-a','vk','onlypult','fixture-publishing-opaque');`);
  const calls = [], behavior = { beforeStats: null, groupFailure: null };
  const vkDirect = createVkDirect(db, { apiKey: 'fixture-storage', timeoutMs: 25, fetchImpl: async (url, init) => {
    const method = url.split('/').pop(), params = new URLSearchParams(init.body); calls.push({ method, params });
    if (method === 'groups.getById' && behavior.groupFailure) return behavior.groupFailure();
    if (method === 'stats.get' && behavior.beforeStats) behavior.beforeStats();
    const response = method === 'account.getProfileInfo' ? { id: 1 } : method === 'groups.getById' ? { groups: [{ id: 101, members_count: 8 }] }
      : [{ visitors: { views: 20 }, reach: { reach: 11 }, activity: { likes: 0, comments: 2, copies: 1, subscribed: 3, unsubscribed: 1 } }];
    return new Response(JSON.stringify({ response }));
  } });
  const save = (extra = {}) => vkDirect.saveSettings('demo-a', 'analytics', { revision: 0, groupId: '101', tokenType: 'user', accessToken: 'fixture-analytics', ...extra });
  const transport = { readStats() { throw Error('publishing transport must never be touched'); }, connectionRevision() { throw Error('publishing fingerprint must never be read'); } };
  const adapters = createSocialAdapters({ vkDirect, transport });
  const context = { company: { code: 'demo-a' }, platform: 'vk', account: { account_ref: 'club101', kind: 'organic' }, date: '2026-10-03', timezone: 'Asia/Irkutsk' };
  return { db, vkDirect, save, adapters, context, calls, behavior, transport };
}
test('native metrics work alongside Onlypult, preserving its exact row and timezone', async t => {
  const f = fixture(t); const before = f.db.prepare('SELECT * FROM autoposting_channels').all();
  f.save(); await f.vkDirect.checkConnection('demo-a', 'analytics');
  for (const provider of ['direct', 'onlypult']) {
    const result = await f.adapters[provider].collect(f.context);
    assert.equal(result.status, 'ok');
    assert.deepEqual(Object.fromEntries(result.snapshots.map(x => [x.metric, x.value])), { followers: 8, views: 20, reach: 11, likes: 0, comments: 2, shares: 1, follower_change: 2 });
    assert.equal(f.calls.at(-1).params.get('timestamp_from'), String(Date.parse('2026-10-02T16:00:00Z') / 1000));
    assert.equal(f.adapters[provider].connectionRevision(f.context).provider, 'vk_direct');
  }
  assert.deepEqual(f.db.prepare('SELECT * FROM autoposting_channels').all(), before);
});
test('missing, invalid, foreign and stale binding fail closed without legacy fallback', async t => {
  const f = fixture(t);
  assert.equal((await f.adapters.onlypult.collect(f.context)).status, 'unsupported');
  f.save(); await f.vkDirect.checkConnection('demo-a', 'analytics'); const before = f.calls.length;
  for (const ref of ['', 'garbage', '102', 'https://vk.com/club101']) {
    const result = await f.adapters.onlypult.collect({ ...f.context, account: { account_ref: ref } });
    assert.equal(result.status, 'missing_access'); assert.equal(result.snapshots, undefined);
  }
  assert.equal(f.calls.length, before);
  assert.equal((await f.adapters.direct.collect({ ...f.context, company: { code: 'demo-b' } })).status, 'missing_access');
  f.behavior.beforeStats = () => f.save({ revision: 1, accessToken: 'fixture-revised' });
  const result = await f.adapters.onlypult.collect(f.context);
  assert.equal(result.status, 'failed'); assert.equal(result.snapshots, undefined);
});
test('without injection old Onlypult rejection and direct transport remain unchanged', async () => {
  const adapters = createSocialAdapters({ transport: { readStats: async (_code, _platform, method) => ({ result: method === 'groups.getById' ? [{ id: 101, members_count: 4 }] : [] }) } });
  const context = { company: { code: 'demo-a' }, platform: 'vk', account: { account_ref: '101' }, date: '2026-10-03' };
  assert.equal((await adapters.onlypult.collect(context)).status, 'unsupported');
  assert.equal((await adapters.direct.collect(context)).snapshots[0].value, 4);
});

test('temporary community read failure remains retryable while permission denial is missing access', async t => {
  const f = fixture(t); f.save(); await f.vkDirect.checkConnection('demo-a', 'analytics');
  for (const groupFailure of [
    () => new Promise(() => {}),
    () => new Response(JSON.stringify({ error: { error_code: 10 } }), { status: 503 }),
    () => new Response(JSON.stringify({ unexpected: true })),
  ]) {
    f.behavior.groupFailure = groupFailure;
    const result = await f.adapters.onlypult.collect(f.context);
    assert.equal(result.status, 'failed'); assert.equal(result.snapshots, undefined);
  }
  f.behavior.groupFailure = () => new Response(JSON.stringify({ error: { error_code: 15 } }));
  const denied = await f.adapters.onlypult.collect(f.context);
  assert.equal(denied.status, 'missing_access'); assert.equal(denied.snapshots, undefined);
});

test('global injection preserves legacy direct analytics only while the dedicated record is absent', async t => {
  const f = fixture(t), legacyCalls = [];
  f.transport.connectionRevision = () => ({ provider: 'direct', revision: 7, target: '101' });
  f.transport.readStats = async (_code, _platform, method) => {
    legacyCalls.push(method);
    return { result: method === 'groups.getById' ? [{ id: 101, members_count: 4 }] : [] };
  };
  const account = { ...f.context.account, company_code: 'demo-a' };
  assert.match(f.adapters.direct.describe('vk', account).missing.join(' '), /Автопостинг/);
  assert.equal(f.adapters.direct.connectionRevision(f.context), 'direct:7:101');
  const result = await f.adapters.direct.collect(f.context);
  assert.equal(result.status, 'partial'); assert.equal(result.snapshots[0].value, 4);
  assert.deepEqual(legacyCalls, ['groups.getById', 'stats.get']);
  assert.equal(f.calls.length, 0);
  assert.equal(f.vkDirect.getSettings('demo-a', 'analytics').configured, false);
});

test('configured unchecked or disabled dedicated connection never falls back to legacy credentials', async t => {
  const f = fixture(t); let legacyCalls = 0;
  f.transport.readStats = () => { legacyCalls++; throw Error('must not read legacy credential'); };
  f.transport.connectionRevision = () => { legacyCalls++; throw Error('must not read legacy binding'); };
  f.save();
  for (const enabled of [true, false]) {
    if (!enabled) f.save({ revision: 1, enabled: false, accessToken: '' });
    for (const provider of ['direct', 'onlypult']) {
      const result = await f.adapters[provider].collect(f.context);
      assert.equal(result.status, 'missing_access'); assert.equal(result.snapshots, undefined);
      assert.equal(f.adapters[provider].connectionRevision(f.context).provider, 'vk_direct');
      assert.match(f.adapters[provider].describe('vk', { ...f.context.account, companyCode: 'demo-a' }).missing.join(' '), /отдельное/);
    }
  }
  assert.equal(legacyCalls, 0); assert.equal(f.calls.length, 0);
});

test('creating a dedicated connection during a legacy request discards the old result', async t => {
  const f = fixture(t);
  f.transport.connectionRevision = () => ({ provider: 'direct', revision: 7, target: '101' });
  f.transport.readStats = async (_code, _platform, method) => {
    if (method === 'stats.get') f.save();
    return { result: method === 'groups.getById' ? [{ id: 101, members_count: 4 }] : [] };
  };
  const stats = createSocialStats(f.db, { adapters: f.adapters, now: () => Date.parse('2026-10-04T04:00:00Z'), logger: { warn() {} } });
  stats.saveAccounts('demo-a', { accounts: [{ platform: 'vk', provider: 'direct', accountRef: '101', enabled: true, timezone: 'Asia/Irkutsk', kind: 'organic' }] });
  const before = f.adapters.direct.connectionRevision(f.context);
  const result = await stats.collect('demo-a', 'vk', { date: '2026-10-03', trigger: 'manual' });
  assert.equal(result.status, 'failed'); assert.match(result.error, /изменилось/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_snapshots').get().n, 0);
  assert.notDeepEqual(f.adapters.direct.connectionRevision(f.context), before);
  assert.equal(f.calls.length, 0);
});

test('Onlypult VK without a dedicated record remains unsupported and never invokes legacy direct', async t => {
  const f = fixture(t); let legacyCalls = 0;
  f.transport.readStats = () => { legacyCalls++; throw Error('must not read legacy credential'); };
  f.transport.connectionRevision = () => { legacyCalls++; throw Error('must not read legacy binding'); };
  const account = { ...f.context.account, company_code: 'demo-a' };
  assert.equal(f.adapters.onlypult.describe('vk', account).status, 'unsupported');
  assert.equal(f.adapters.onlypult.connectionRevision(f.context), null);
  assert.equal((await f.adapters.onlypult.collect(f.context)).status, 'unsupported');
  assert.equal(legacyCalls, 0); assert.equal(f.calls.length, 0);
});

test('unreadable or malformed dedicated settings never imply an absent connection', async t => {
  const f = fixture(t); let legacyCalls = 0;
  f.transport.readStats = () => { legacyCalls++; throw Error('must not read legacy credential'); };
  f.transport.connectionRevision = () => { legacyCalls++; throw Error('must not read legacy binding'); };
  for (const read of [() => { throw Error('fixture settings read failure'); }, () => ({})]) {
    const adapters = createSocialAdapters({ transport: f.transport, vkDirect: { ...f.vkDirect, getSettings: read } });
    for (const provider of ['direct', 'onlypult']) {
      assert.equal(adapters[provider].describe('vk', { ...f.context.account, companyCode: 'demo-a' }).status, 'missing_access');
      assert.throws(() => adapters[provider].connectionRevision(f.context));
      assert.equal((await adapters[provider].collect(f.context)).status, 'failed');
    }
  }
  assert.equal(legacyCalls, 0);
});
