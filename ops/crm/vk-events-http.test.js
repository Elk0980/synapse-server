'use strict';
// spec092: real node:http round-trips against the handler with a mock VK (no network).
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const {DatabaseSync} = require('node:sqlite');
const {createVkEvents} = require('./vk-events');
const {createVkEventsHandler} = require('./vk-events-http');

const SECRET = 'FixtureSecret_42', CONFIRM = 'a1b2c3d4', TOKEN = 'FIXTURE_COMMUNITY_TOKEN', GROUP = '241948768';
function send(response, status, payload, headers) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...(headers || {})});
  response.end(body);
}
async function readJson(request, maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw Object.assign(new Error('too large'), {status: 413}); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,is_deleted INTEGER NOT NULL DEFAULT 0); INSERT INTO companies VALUES('palitra-love',0),('alvi',0);`);
  const vkCalls = [];
  const events = createVkEvents(db, {apiKey: 'FIXTURE_KEY', fetchImpl: async (url, init) => { vkCalls.push(url); throw new Error('no network in HTTP tests'); }});
  let identityFor = () => ({role: 'owner', userId: 1}), contextCalls = 0;
  const companyModuleContext = (request, code) => {
    contextCalls++;
    const identity = identityFor(request, contextCalls);
    if (!['palitra-love', 'alvi'].includes(code)) throw Object.assign(new Error('Компания не найдена'), {status: 404});
    return {identity, company: {code}};
  };
  const handle = createVkEventsHandler({events, companyModuleContext, readJson, send});
  const server = http.createServer((req, res) => {
    handle(req, res, new URL(req.url, 'http://localhost')).then(done => { if (!done) send(res, 404, {error: 'next'}); })
      .catch(error => send(res, error.status || 500, {error: error.status ? error.message : 'internal'}));
  });
  await new Promise(resolve => server.listen(0, resolve));
  t.after(async () => { await events.close(); server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, {method = 'GET', body, raw} = {}) => {
    const response = await fetch(base + path, {method, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), headers: {'content-type': 'application/json'}});
    return {status: response.status, type: response.headers.get('content-type'), text: await response.text()};
  };
  return {events, request, vkCalls, setIdentity: value => { identityFor = value; }};
}

test('owner routes: settings round-trip without secrets; non-owner and unknown routes rejected; no generic proxy', async t => {
  const f = await fixture(t);
  const put = await f.request('/vk-events/settings?companyCode=palitra-love', {method: 'PUT', body: {companyCode: 'palitra-love', revision: 0, groupId: GROUP,
    callback: {enabled: true, secret: SECRET, confirmationCode: CONFIRM}, longPoll: {enabled: true, communityToken: TOKEN}}});
  assert.equal(put.status, 200);
  for (const s of [SECRET, CONFIRM, TOKEN, 'encrypted']) assert.ok(!put.text.includes(s), s);
  const saved = JSON.parse(put.text); assert.equal(saved.revision, 1); assert.equal(saved.callback.secretConfigured, true);
  assert.equal((await f.request('/vk-events/settings?companyCode=palitra-love', {method: 'PUT', body: {companyCode: 'alvi', revision: 1, groupId: GROUP}})).status, 400);
  for (const path of ['/vk-events/method/messages.send?companyCode=palitra-love', '/vk-events/proxy?companyCode=palitra-love'])
    assert.equal((await f.request(path, {method: 'POST', body: {}})).status, 405);
  assert.equal((await f.request('/vk-events/journal?companyCode=palitra-love&limit=1000')).status, 400);
  assert.equal((await f.request('/vk-events/journal?companyCode=palitra-love&limit=10')).status, 200);
  assert.equal((await f.request('/vk-events/check?companyCode=palitra-love', {method: 'POST', body: {revision: 1, extra: true}})).status, 400);
  const stale = await f.request('/vk-events/longpoll?companyCode=palitra-love', {method: 'POST', body: {revision: 0, action: 'start'}});
  assert.equal(stale.status, 409); assert.equal(JSON.parse(stale.text).code, 'SETTINGS_CHANGED');
  f.setIdentity(() => ({role: 'editor', userId: 2}));
  assert.equal((await f.request('/vk-events/settings?companyCode=palitra-love')).status, 403);
  assert.equal(f.vkCalls.length, 0);
});

test('scope revalidated after body read: role or user change during PUT is rejected', async t => {
  const f = await fixture(t);
  f.setIdentity((request, n) => n === 1 ? {role: 'owner', userId: 1} : {role: 'owner', userId: 9});
  const result = await f.request('/vk-events/settings?companyCode=palitra-love', {method: 'PUT', body: {revision: 0, groupId: GROUP}});
  assert.equal(result.status, 403);
  f.setIdentity(() => ({role: 'owner', userId: 1}));
  assert.equal(JSON.parse((await f.request('/vk-events/settings?companyCode=palitra-love')).text).configured, false);
});

test('callback route: plain text ok/confirmation, no identity required, strict method and size', async t => {
  const f = await fixture(t);
  const saved = f.events.saveSettings('palitra-love', {revision: 0, groupId: GROUP, callback: {enabled: true, secret: SECRET, confirmationCode: CONFIRM}});
  f.setIdentity(() => { throw Object.assign(new Error('no session'), {status: 403}); });
  const path = '/vk-events/callback/' + saved.callback.endpointPath.split('/').at(-1);
  const confirm = await f.request(path, {method: 'POST', body: {type: 'confirmation', group_id: Number(GROUP)}});
  assert.deepEqual([confirm.status, confirm.text], [200, CONFIRM]); assert.match(confirm.type, /^text\/plain/);
  const ok = await f.request(path, {method: 'POST', body: {type: 'group_join', event_id: 'evt1', v: '5.199', group_id: Number(GROUP), secret: SECRET, object: {user_id: 1}}});
  assert.deepEqual([ok.status, ok.text], [200, 'ok']);
  const wrong = await f.request(path, {method: 'POST', body: {type: 'group_join', event_id: 'evt2', group_id: Number(GROUP), secret: 'x'}});
  assert.deepEqual([wrong.status, wrong.text], [403, 'rejected']);
  assert.equal((await f.request(path)).status, 405);
  assert.equal((await f.request(path, {method: 'POST', raw: 'x'.repeat(300 * 1024)})).status, 413);
  assert.equal((await f.request('/vk-events/callback/short', {method: 'POST', body: {}})).status, 404);
  assert.equal(f.vkCalls.length, 0);
});
