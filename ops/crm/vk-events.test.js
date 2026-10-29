'use strict';
// spec092-vk-events: mock-only tests. No real VK endpoint, key or community is contacted.
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createVkEvents, lpServerUrl, DOCS_EVENTS} = require('./vk-events');

const KEY = 'FIXTURE_ENCRYPTION_KEY', TOKEN = 'FIXTURE_COMMUNITY_TOKEN', SECRET = 'FixtureSecret_42', CONFIRM = 'a1b2c3d4', LPKEY = 'FIXTURE_LP_SESSION_KEY';
const GROUP = '241948768';
const wire = response => new Response(JSON.stringify({response}), {status: 200});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(check, label = 'condition') {
  for (let i = 0; i < 400; i++) { if (check()) return; await tick(); }
  assert.fail('timeout waiting for ' + label);
}
const event = (id, changes = {}) => ({type: 'message_new', event_id: id, v: '5.199', group_id: Number(GROUP), object: {message: {text: 'PRIVATE_MESSAGE_TEXT'}}, ...changes});

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,is_deleted INTEGER NOT NULL DEFAULT 0);
    INSERT INTO companies VALUES('palitra-love',0),('alvi',0),('deleted',1);`);
  const calls = [], polls = [], sleeps = [], errors = [];
  let lpQueue = [], apiOverride = null, lpCount = 0, serverCount = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    if (url.startsWith('https://api.vk.com/method/')) {
      assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.ok(!url.includes(TOKEN) && !init.body.includes(TOKEN));
      const method = url.split('/').at(-1), params = Object.fromEntries(new URLSearchParams(init.body));
      assert.equal(params.v, '5.199'); calls.push({method, params});
      if (apiOverride) { const value = await apiOverride(method, params); if (value !== undefined) return value; }
      if (method === 'groups.getLongPollServer') { serverCount++; return wire({key: LPKEY + serverCount, server: 'https://lp.vk.com/whp/' + GROUP, ts: String(100 + serverCount * 1000)}); }
      return wire({'groups.getTokenPermissions': {mask: 262144, permissions: [{name: 'manage', setting: 262144}]},
        'groups.getById': {groups: [{id: Number(params.group_id), name: 'Palitra Love'}]},
        'groups.getLongPollSettings': {is_enabled: true, api_version: '5.199', events: {message_new: 1, photo_new: true, wall_post_new: 0}}}[method]);
    }
    const u = new URL(url); assert.equal(u.origin, 'https://lp.vk.com'); assert.equal(init.method, 'GET');
    const poll = {key: u.searchParams.get('key'), ts: u.searchParams.get('ts'), act: u.searchParams.get('act'), wait: u.searchParams.get('wait'), signal: init.signal};
    polls.push(poll); lpCount++;
    const next = lpQueue.shift();
    if (!next) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
    return typeof next === 'function' ? next(poll) : new Response(JSON.stringify(next), {status: 200});
  };
  const instances = [];
  // A second instance on the same database models another CRM process.
  const make = () => { const value = createVkEvents(db, {apiKey: KEY, fetchImpl, now: () => clock.now,
    sleep: async (ms) => { sleeps.push(ms); await tick(); }, onError: (...args) => errors.push(args), ...options}); instances.push(value); return value; };
  const clock = {now: Date.parse('2026-10-06T12:00:00Z')};
  const api = make();
  t.after(async () => { for (const value of instances) await value.close(); db.close(); });
  const save = (changes = {}, code = 'palitra-love') => api.saveSettings(code, {revision: api.getSettings(code).revision, groupId: GROUP,
    callback: {enabled: true, secret: SECRET, confirmationCode: CONFIRM}, longPoll: {enabled: true, communityToken: TOKEN}, ...changes});
  const endpoint = (code = 'palitra-love') => api.getSettings(code).callback.endpointPath.split('/').at(-1);
  const post = (body, code = 'palitra-love', id = endpoint(code)) => api.handleCallback(id, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
  const ready = async (code = 'palitra-love') => { save({}, code); const checked = await api.checkConnection(code); assert.equal(checked.ok, true); return checked; };
  return {db, api, make, clock, calls, polls, sleeps, errors, save, endpoint, post, ready,
    queue: (...items) => lpQueue.push(...items), apiOverride: value => { apiOverride = value; }, counts: () => ({lpCount, serverCount})};
}
function safe(value) { const text = JSON.stringify(value); for (const s of [KEY, TOKEN, SECRET, CONFIRM, LPKEY, 'PRIVATE_MESSAGE_TEXT', 'encrypted_']) assert.ok(!text.includes(s), s); }

test('private settings: encrypted per company/group/field, DTO exposes flags only, saved ≠ checked', async t => {
  const f = fixture(t);
  assert.equal(f.api.getSettings('palitra-love').configured, false);
  const saved = f.save(); safe(saved);
  assert.equal(saved.revision, 1); assert.equal(saved.callback.secretConfigured, true); assert.equal(saved.callback.confirmationConfigured, true);
  assert.equal(saved.longPoll.tokenConfigured, true); assert.equal(saved.longPoll.checked, false); assert.equal(saved.capabilities.callbackEvents, false);
  assert.deepEqual(Object.fromEntries(Object.entries(saved.capabilities).filter(([k]) => ['market', 'statistics', 'design', 'outgoing'].includes(k))),
    {market: false, statistics: false, design: false, outgoing: false});
  assert.match(saved.callback.endpointPath, /^\/public-vk-callback\/[A-Za-z0-9_-]{32}$/);
  const row = f.db.prepare('SELECT * FROM vk_events_bindings').get();
  for (const column of ['encrypted_secret', 'encrypted_confirmation', 'encrypted_token']) for (const s of [SECRET, CONFIRM, TOKEN]) assert.ok(!row[column].includes(s));
  f.save({}, 'alvi');
  assert.notEqual(f.endpoint('alvi'), f.endpoint('palitra-love'));
  // ciphertext moved to another company or field does not decrypt
  f.db.prepare("UPDATE vk_events_bindings SET encrypted_token=(SELECT encrypted_token FROM vk_events_bindings WHERE company_code='palitra-love') WHERE company_code='alvi'").run();
  assert.equal(f.api.getSettings('alvi').longPoll.tokenConfigured, false);
  f.db.prepare("UPDATE vk_events_bindings SET encrypted_secret=encrypted_token WHERE company_code='palitra-love'").run();
  assert.equal(f.api.getSettings('palitra-love').callback.secretConfigured, false);
  assert.equal(f.calls.length, 0, 'saving never calls VK');
});

test('validation: strict keys, stale revision, group change needs new secrets, deleted/unknown companies', t => {
  const f = fixture(t); f.save();
  for (const code of ['missing', 'deleted']) assert.throws(() => f.api.getSettings(code), e => e.status === 404);
  assert.throws(() => f.api.saveSettings('palitra-love', {revision: 0, groupId: GROUP}), e => e.code === 'SETTINGS_CHANGED' && e.status === 409);
  assert.throws(() => f.api.saveSettings('palitra-love', {revision: 1, groupId: GROUP, extra: 1}), e => e.code === 'INVALID_SETTINGS');
  for (const groupId of ['https://vk.com/club1', '0', '-5', 241948768]) assert.throws(() => f.api.saveSettings('palitra-love', {revision: 1, groupId}), e => e.code === 'INVALID_SETTINGS');
  assert.throws(() => f.api.saveSettings('palitra-love', {revision: 1, groupId: GROUP, callback: {enabled: true, secret: 'with space'}}), e => e.code === 'INVALID_SETTINGS');
  const kept = f.api.saveSettings('palitra-love', {revision: 1, groupId: GROUP, callback: {enabled: true}, longPoll: {enabled: true}});
  assert.equal(kept.callback.secretConfigured, true); assert.equal(kept.longPoll.tokenConfigured, true); assert.equal(kept.revision, 2);
  const before = f.endpoint();
  assert.throws(() => f.api.saveSettings('palitra-love', {revision: 2, groupId: '777', callback: {enabled: true}}), e => e.code === 'SECRET_REQUIRED');
  assert.throws(() => f.api.saveSettings('palitra-love', {revision: 2, groupId: '777', longPoll: {enabled: true}}), e => e.code === 'TOKEN_REQUIRED');
  const moved = f.api.saveSettings('palitra-love', {revision: 2, groupId: '777'});
  assert.equal(moved.callback.secretConfigured, false); assert.equal(moved.longPoll.tokenConfigured, false); assert.notEqual(f.endpoint(), before);
});

test('callback: exact endpoint, group and secret; confirmation returns private code; ok only after durable write', t => {
  const f = fixture(t); f.save();
  assert.deepEqual(f.post({type: 'confirmation', group_id: Number(GROUP)}), {status: 200, body: CONFIRM});
  assert.deepEqual(f.post({type: 'confirmation', group_id: Number(GROUP), secret: SECRET}), {status: 200, body: CONFIRM});
  assert.equal(f.post({type: 'confirmation', group_id: Number(GROUP), secret: 'wrong'}).status, 403);
  assert.equal(f.post({type: 'confirmation', group_id: 1}).status, 403);
  assert.equal(f.api.handleCallback('A'.repeat(32), Buffer.from('{}')).status, 404);
  assert.equal(f.api.handleCallback('../x', Buffer.from('{}')).status, 404);
  for (const [body, status] of [[{...event('e1'), secret: 'nope'}, 403], [{...event('e1')}, 403], [{...event('e1', {group_id: 5}), secret: SECRET}, 403],
    [{...event('bad id!'), secret: SECRET}, 400], [{...event('e1', {type: 'Bad-Type'}), secret: SECRET}, 400], ['not json', 400], ['[1]', 400]]) {
    const result = f.post(body); assert.equal(result.status, status, JSON.stringify(body)); assert.equal(result.body, 'rejected'); safe(result);
  }
  assert.equal(f.api.handleCallback(f.endpoint(), Buffer.alloc(f.api.CALLBACK_MAX_BYTES + 1, 32)).status, 413);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vk_events_journal').get().n, 0);
  assert.deepEqual(f.post({...event('e1'), secret: SECRET}), {status: 200, body: 'ok'});
  const row = f.db.prepare('SELECT * FROM vk_events_journal').get();
  assert.equal(row.type, 'message_new'); assert.equal(row.first_transport, 'callback'); assert.ok(!row.encrypted_payload.includes('PRIVATE_MESSAGE_TEXT'));
  assert.ok(!row.encrypted_payload.includes(SECRET));
  const s = f.api.getSettings('palitra-love'); safe(s);
  assert.ok(s.callback.confirmedAt); assert.ok(s.callback.lastEventAt); assert.equal(s.capabilities.callbackEvents, true);
  assert.ok(s.callback.rejected >= 5); assert.equal(typeof s.callback.lastRejectCode, 'string');
  // disabled callback stops accepting at the same endpoint
  f.api.saveSettings('palitra-love', {revision: s.revision, groupId: GROUP, callback: {enabled: false}, longPoll: {enabled: true}});
  assert.equal(f.post({...event('e2'), secret: SECRET}).status, 404);
});

test('callback durable failure: storage error returns retry, never ok, and VK retry later succeeds once', t => {
  const f = fixture(t); f.save();
  f.db.exec(`CREATE TRIGGER fail_once BEFORE INSERT ON vk_events_journal WHEN (SELECT COUNT(*) FROM vk_events_journal)=0 AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name='passed')
    BEGIN SELECT RAISE(ABORT,'disk full'); END;`);
  const first = f.post({...event('d1'), secret: SECRET});
  assert.deepEqual(first, {status: 503, body: 'retry'}); assert.equal(f.errors[0][0], 'callback_store_failed');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vk_events_journal').get().n, 0);
  f.db.exec('CREATE TABLE passed(x)');
  assert.deepEqual(f.post({...event('d1'), secret: SECRET}), {status: 200, body: 'ok'});
  assert.deepEqual(f.post({...event('d1'), secret: SECRET}), {status: 200, body: 'ok'});
  const row = f.db.prepare('SELECT * FROM vk_events_journal').get();
  assert.equal(row.duplicate_count, 1); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vk_events_journal').get().n, 1);
});

test('check: token, exact group and Long Poll settings; no LP start before check or when disabled in VK', async t => {
  const f = fixture(t); f.save();
  const rev = f.api.getSettings('palitra-love').revision;
  await assert.rejects(f.api.longPoll('palitra-love', {revision: rev, action: 'start'}), e => e.code === 'NOT_CHECKED');
  f.apiOverride(method => method === 'groups.getById' ? wire({groups: [{id: 1, name: 'Other'}]}) : undefined);
  const wrong = await f.api.checkConnection('palitra-love'); assert.equal(wrong.ok, false); assert.equal(wrong.code, 'GROUP_MISMATCH');
  f.apiOverride(method => method === 'groups.getLongPollSettings' ? wire({is_enabled: false, api_version: '5.131', events: {}}) : undefined);
  const off = await f.api.checkConnection('palitra-love'); safe(off);
  assert.equal(off.ok, true); assert.equal(off.longPoll.vkEnabled, false); assert.equal(off.longPoll.apiVersionMatches, false);
  await assert.rejects(f.api.longPoll('palitra-love', {revision: rev, action: 'start'}), e => e.code === 'LONGPOLL_DISABLED_IN_VK');
  f.apiOverride(method => method === 'groups.getTokenPermissions' ? new Response(JSON.stringify({error: {error_code: 27, error_msg: 'PRIVATE'}})) : undefined);
  const denied = await f.api.checkConnection('palitra-love'); assert.equal(denied.code, 'ACCESS_DENIED'); safe(denied);
  f.apiOverride(null);
  const good = await f.api.checkConnection('palitra-love');
  assert.deepEqual(good.longPoll.vkEnabledEvents, ['message_new', 'photo_new']); assert.equal(good.group.name, 'Palitra Love');
  assert.deepEqual(f.calls.filter(c => c.method === 'groups.getById').map(c => c.params.group_id).at(-1), GROUP);
  assert.ok(!f.calls.some(c => !['groups.getTokenPermissions', 'groups.getById', 'groups.getLongPollSettings'].includes(c.method)), 'check is read-only');
});

test('long poll: cursor persisted with events atomically, dedup with callback in both orders, single session', async t => {
  const f = fixture(t); await f.ready();
  assert.deepEqual(f.post({...event('cb-first'), secret: SECRET}), {status: 200, body: 'ok'});
  f.queue({ts: '1101', updates: [event('cb-first'), event('lp-first', {type: 'photo_new'}), event('alien', {group_id: 999}), {type: 'x'}]});
  const rev = f.api.getSettings('palitra-love').revision;
  await f.api.longPoll('palitra-love', {revision: rev, action: 'start'});
  await f.api.longPoll('palitra-love', {revision: rev, action: 'start'}); // concurrent start: still one session
  await waitFor(() => f.polls.length >= 2, 'second poll');
  assert.equal(f.counts().serverCount, 1, 'one getLongPollServer for one session');
  assert.equal(f.polls[0].ts, '1100'); assert.equal(f.polls[0].act, 'a_check'); assert.equal(f.polls[0].wait, '25');
  assert.equal(f.polls[1].ts, '1101', 'cursor advanced after durable batch');
  assert.deepEqual(f.post({...event('lp-first', {type: 'photo_new'}), secret: SECRET}), {status: 200, body: 'ok'});
  const rows = f.db.prepare('SELECT event_id,transports,duplicate_count,first_transport FROM vk_events_journal ORDER BY id').all().map(r => ({...r}));
  assert.deepEqual(rows, [{event_id: 'cb-first', transports: 3, duplicate_count: 1, first_transport: 'callback'},
    {event_id: 'lp-first', transports: 3, duplicate_count: 1, first_transport: 'longpoll'}]);
  const s = f.api.getSettings('palitra-love'); safe(s);
  assert.equal(s.longPoll.invalidUpdates, 2); assert.equal(s.longPoll.running, true); assert.equal(s.longPoll.status, 'listening'); assert.equal(s.capabilities.longPollEvents, true);
  const journal = f.api.journal('palitra-love'); safe(journal);
  assert.deepEqual(journal.items.map(i => [i.eventId, i.transports.join('+')]), [['lp-first', 'callback+longpoll'], ['cb-first', 'callback+longpoll']]);
  await f.api.longPoll('palitra-love', {revision: rev, action: 'stop'});
  assert.ok(f.polls.at(-1).signal.aborted, 'in-flight poll aborted on stop');
  assert.equal(f.api.getSettings('palitra-love').longPoll.running, false);
  assert.equal(f.db.prepare('SELECT lp_lease_id FROM vk_events_bindings').get().lp_lease_id, null, 'lease released');
});

test('long poll failed 1/2/3 follow the official contract', async t => {
  const f = fixture(t); await f.ready();
  f.queue({failed: 1, ts: '5000'}, {ts: '5001', updates: []}, {failed: 2}, {ts: '5002', updates: []}, {failed: 3}, {ts: '9999', updates: [event('after-gap')]});
  await f.api.longPoll('palitra-love', {revision: f.api.getSettings('palitra-love').revision, action: 'start'});
  await waitFor(() => f.polls.length >= 7, 'seven polls');
  const seq = f.polls.slice(0, 7).map(p => [p.key, p.ts]);
  assert.deepEqual(seq, [[LPKEY + 1, '1100'], [LPKEY + 1, '5000'], [LPKEY + 1, '5001'], [LPKEY + 2, '5001'], [LPKEY + 2, '5002'], [LPKEY + 3, '3100'], [LPKEY + 3, '9999']]);
  const s = f.api.getSettings('palitra-love');
  assert.equal(s.longPoll.gaps, 2, 'failed 1 and failed 3 are recorded as possible gaps');
  assert.equal(f.api.journal('palitra-love').items[0].eventId, 'after-gap');
});

test('restart resumes from saved cursor with a fresh key; storage failure does not advance cursor', async t => {
  const f = fixture(t); await f.ready();
  f.queue({ts: '1200', updates: [event('one')]});
  const rev = f.api.getSettings('palitra-love').revision;
  await f.api.longPoll('palitra-love', {revision: rev, action: 'start'});
  await waitFor(() => f.polls.length >= 2);
  await f.api.close();
  assert.equal(f.db.prepare('SELECT lp_ts,longpoll_enabled FROM vk_events_bindings').get().lp_ts, '1200');
  f.db.exec(`CREATE TRIGGER fail_two BEFORE INSERT ON vk_events_journal WHEN NEW.event_id='two' AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name='ok2')
    BEGIN SELECT RAISE(ABORT,'disk'); END;`);
  f.queue({ts: '1300', updates: [event('two')]}, poll => { f.db.exec('CREATE TABLE IF NOT EXISTS ok2(x)'); return new Response(JSON.stringify({ts: '1300', updates: [event('two')]})); });
  const resumed = f.api.resume();
  assert.deepEqual(resumed.map(r => [r.companyCode, r.started]), [['palitra-love', true]]);
  await waitFor(() => f.polls.length >= 5);
  assert.deepEqual(f.polls.slice(2, 5).map(p => [p.key, p.ts]), [[LPKEY + 2, '1200'], [LPKEY + 2, '1200'], [LPKEY + 2, '1300']]);
  assert.ok(f.sleeps.length >= 1, 'backoff after storage failure');
  assert.deepEqual(f.api.journal('palitra-love').items.map(i => i.eventId), ['two', 'one']);
});

test('lease: a second process cannot start the same binding; revision change ends session without writing batch', async t => {
  const f = fixture(t); await f.ready();
  const rev = f.api.getSettings('palitra-love').revision;
  f.db.prepare("UPDATE vk_events_bindings SET lp_lease_id='other-process',lp_lease_until=?").run(Date.parse('2026-10-06T12:00:00Z') + 60000);
  await assert.rejects(f.api.longPoll('palitra-love', {revision: rev, action: 'start'}), e => e.code === 'LEASE_HELD');
  f.db.prepare("UPDATE vk_events_bindings SET lp_lease_id=NULL,lp_lease_until=NULL").run();
  let release;
  f.queue(() => new Promise(resolve => { release = resolve; }));
  await f.api.longPoll('palitra-love', {revision: rev, action: 'start'});
  await waitFor(() => release, 'poll in flight');
  f.db.prepare('UPDATE vk_events_bindings SET revision=revision+1').run(); // concurrent settings change
  release(new Response(JSON.stringify({ts: '7777', updates: [event('stale')]})));
  await waitFor(() => !f.api._sessions.size, 'session ended');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vk_events_journal').get().n, 0);
  assert.notEqual(f.db.prepare('SELECT lp_ts FROM vk_events_bindings').get().lp_ts, '7777');
});

test('access denied and untrusted LP server stop the session (no retry storm, no SSRF)', async t => {
  for (const mode of ['denied', 'untrusted']) {
    const f = fixture(t); await f.ready();
    f.apiOverride(method => method !== 'groups.getLongPollServer' ? undefined
      : mode === 'denied' ? new Response(JSON.stringify({error: {error_code: 15}})) : wire({key: LPKEY, server: 'https://evil.example/whp', ts: '1'}));
    await f.api.longPoll('palitra-love', {revision: f.api.getSettings('palitra-love').revision, action: 'start'});
    await waitFor(() => !f.api._sessions.size, mode);
    const s = f.api.getSettings('palitra-love'); safe(s);
    assert.equal(s.longPoll.status, 'error'); assert.equal(s.longPoll.error, mode === 'denied' ? 'ACCESS_DENIED' : 'LP_SERVER_UNTRUSTED');
    assert.equal(f.polls.length, 0);
  }
  for (const value of ['http://lp.vk.com/x', 'https://lp.vk.com.evil.io/x', 'https://user@lp.vk.com/x', 'https://lp.vk.com:8443/x', 'https://lp.vk.com/x?key=1', 'https://169.254.169.254/'])
    assert.equal(lpServerUrl(value), null, value);
  assert.equal(lpServerUrl('lp.vk.com/whp/1').href, 'https://lp.vk.com/whp/1');
});

test('network errors back off and continue; revoke clears token, stops and rotates callback endpoint', async t => {
  const f = fixture(t); await f.ready();
  f.queue(() => { throw new Error('ECONNRESET'); }, () => new Response('oops', {status: 502}), {ts: '1101', updates: [event('back')]});
  const rev = f.api.getSettings('palitra-love').revision;
  await f.api.longPoll('palitra-love', {revision: rev, action: 'start'});
  await waitFor(() => f.api.journal('palitra-love').items.length === 1, 'recovered');
  assert.deepEqual(f.sleeps.slice(0, 2), [1000, 2000]);
  const oldEndpoint = f.endpoint();
  const revoked = await f.api.revoke('palitra-love', {revision: rev, transport: 'longpoll'}); safe(revoked);
  assert.equal(revoked.longPoll.tokenConfigured, false); assert.equal(revoked.longPoll.running, false); assert.equal(revoked.longPoll.enabled, false);
  const cb = await f.api.revoke('palitra-love', {revision: revoked.revision, transport: 'callback'});
  assert.equal(cb.callback.secretConfigured, false); assert.notEqual(f.endpoint(), oldEndpoint);
  assert.equal(f.post({...event('late'), secret: SECRET}, 'palitra-love', oldEndpoint).status, 404);
  await assert.rejects(f.api.revoke('palitra-love', {revision: 1, transport: 'callback'}), e => e.code === 'SETTINGS_CHANGED');
});

test('company isolation: same event id in two companies, journal never crosses; unknown types flagged', async t => {
  const f = fixture(t); f.save(); f.save({}, 'alvi');
  assert.equal(f.post({...event('same'), secret: SECRET}).status, 200);
  assert.equal(f.post({...event('same', {type: 'brand_new_event'}), secret: SECRET}, 'alvi').status, 200);
  assert.deepEqual(f.api.journal('palitra-love').items.map(i => [i.eventId, i.type, i.known]), [['same', 'message_new', true]]);
  const alvi = f.api.journal('alvi');
  assert.deepEqual(alvi.items.map(i => [i.type, i.known, i.section]), [['brand_new_event', false, 'unknown']]);
  assert.deepEqual(f.api.getSettings('alvi').events.unknownSeen, ['brand_new_event']);
  assert.deepEqual(f.api.getSettings('palitra-love').events.longPollSchemaOnly, ['message_reaction_event']);
  assert.ok(Object.values(DOCS_EVENTS).flat().includes('market_order_new'));
  assert.throws(() => f.api.journal('palitra-love', {limit: 500}), e => e.code === 'INVALID_REQUEST');
});

const start = (api, code = 'palitra-love') => api.longPoll(code, {revision: api.getSettings(code).revision, action: 'start'});
const stop = (api, code = 'palitra-love') => api.longPoll(code, {revision: api.getSettings(code).revision, action: 'stop'});

test('review 1: one Long Poll consumer per VK group across companies and processes; journals stay separate', async t => {
  const f = fixture(t); await f.ready('palitra-love'); await f.ready('alvi');   // both companies bound to the same community
  await start(f.api, 'palitra-love');
  await waitFor(() => f.polls.length === 1, 'palitra polling');
  await assert.rejects(start(f.api, 'alvi'), e => e.code === 'LEASE_HELD');
  assert.equal(f.api.getSettings('alvi').longPoll.desired, false, 'failed start does not leave a pending wish');
  const other = f.make();                                                     // another process, same company and group
  await assert.rejects(start(other, 'palitra-love'), e => e.code === 'LEASE_HELD');
  assert.deepEqual(other.resume().map(r => [r.companyCode, r.started, r.code]), [['palitra-love', false, 'LEASE_HELD']]);
  assert.equal(f.counts().serverCount, 1, 'only one getLongPollServer for the group');
  assert.deepEqual(f.db.prepare('SELECT group_id,company_code FROM vk_events_lp_leases').all().map(r => ({...r})), [{group_id: GROUP, company_code: 'palitra-love'}]);
  await stop(f.api, 'palitra-love');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vk_events_lp_leases').get().n, 0, 'group lease released on stop');
  f.queue({ts: '2101', updates: [event('for-alvi')]});
  await start(f.api, 'alvi');
  await waitFor(() => f.api.journal('alvi').items.length === 1, 'alvi stored');
  assert.deepEqual(f.api.journal('palitra-love').items, [], 'no cross-company journal writes');
  // an expired lease of a crashed process is taken over atomically
  await stop(f.api, 'alvi');
  f.db.prepare("INSERT INTO vk_events_lp_leases VALUES(?, 'alvi', 'crashed', ?)").run(GROUP, f.clock.now - 1);
  await start(f.api, 'palitra-love');
  assert.equal(f.db.prepare('SELECT company_code FROM vk_events_lp_leases').get().company_code, 'palitra-love');
});

test('review 2: explicit stop survives close and resume until an explicit start; stop from another process ends the consumer', async t => {
  const f = fixture(t); await f.ready();
  await start(f.api); await waitFor(() => f.polls.length === 1);
  assert.equal(f.api.getSettings('palitra-love').longPoll.desired, true);
  await stop(f.api);
  await f.api.close();
  const restarted = f.make();
  assert.deepEqual(restarted.resume(), [], 'stopped binding is not resumed');
  assert.equal(f.counts().serverCount, 1); assert.equal(restarted.getSettings('palitra-love').longPoll.running, false);
  assert.equal(restarted.getSettings('palitra-love').longPoll.desired, false);
  await start(restarted); await waitFor(() => f.polls.length === 2, 'explicit start polls again');
  // a crash/restart (close without stop) keeps the wish to run
  await restarted.close();
  let release;
  f.queue(() => new Promise(resolve => { release = resolve; }));
  const third = f.make();
  assert.deepEqual(third.resume().map(r => [r.companyCode, r.started]), [['palitra-love', true]]);
  await waitFor(() => release, 'third process polling');
  // stop issued by another process: persisted pause ends this consumer at its next renewal, batch not stored
  const fourth = f.make();
  const stopped = await stop(fourth);
  assert.equal(stopped.longPoll.desired, false);
  const servers = f.counts().serverCount, polls = f.polls.length;
  // failed:2 would normally re-request the key; a paused binding must stop at renewal instead
  release(new Response(JSON.stringify({failed: 2})));
  await waitFor(() => !third._sessions.size, 'third process consumer ended');
  assert.equal(f.counts().serverCount, servers, 'no new getLongPollServer after remote stop');
  assert.equal(f.polls.length, polls, 'no further polls after remote stop');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vk_events_journal').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vk_events_lp_leases').get().n, 0);
  assert.deepEqual(f.make().resume(), []);
});

test('review 3: deleting the company during a poll stops the consumer and the batch is not written', async t => {
  const f = fixture(t); await f.ready();
  const endpoint = f.endpoint();
  let release;
  f.queue(() => new Promise(resolve => { release = resolve; }));
  await start(f.api);
  await waitFor(() => release, 'poll in flight');
  f.db.prepare("UPDATE companies SET is_deleted=1 WHERE code='palitra-love'").run();
  release(new Response(JSON.stringify({ts: '1101', updates: [event('after-delete')]})));
  await waitFor(() => !f.api._sessions.size, 'consumer stopped');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vk_events_journal').get().n, 0);
  assert.equal(f.db.prepare('SELECT lp_ts FROM vk_events_bindings').get().lp_ts, '1100', 'cursor not advanced');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vk_events_lp_leases').get().n, 0, 'lease released');
  assert.deepEqual(f.make().resume(), [], 'deleted company is never resumed');
  assert.equal(f.post({...event('cb'), secret: SECRET}, 'palitra-love', endpoint).status, 404, 'callback for deleted company rejected');
  assert.throws(() => f.api.getSettings('palitra-love'), e => e.status === 404);
});

test('review 3b: deletion is caught at renewal too (failed:1 does not move the cursor of a deleted company)', async t => {
  const f = fixture(t); await f.ready();
  let release;
  f.queue(() => new Promise(resolve => { release = resolve; }));
  await start(f.api);
  await waitFor(() => release, 'poll in flight');
  f.db.prepare("UPDATE companies SET is_deleted=1 WHERE code='palitra-love'").run();
  release(new Response(JSON.stringify({failed: 1, ts: '5000'})));
  await waitFor(() => !f.api._sessions.size, 'consumer stopped');
  assert.equal(f.db.prepare('SELECT lp_ts FROM vk_events_bindings').get().lp_ts, '1100');
  assert.equal(f.polls.length, 1, 'no poll after deletion');
});
