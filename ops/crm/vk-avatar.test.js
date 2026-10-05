'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createVkAvatar, VK_AVATAR_ERRORS } = require('./vk-avatar');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=';
const CAPABILITIES = { applyEnabled: false, cropSupported: false };
const WARNINGS = ['AVATAR_MAY_CREATE_PUBLIC_POST', 'AVATAR_APPLY_DISABLED', 'AVATAR_CROP_UNVERIFIED'];
const group = { id: 12345, has_photo: 1, photo_200: 'https://sun1.userapi.com/200.jpg',
  photo_max: 'https://sun1.userapi.com/max.jpg', photo_max_orig: 'https://sun1.userapi.com/original.jpg' };
function fixture(t, extras = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES('demo-a',0),('demo-b',0),('deleted',1)");
  const settings = { companyCode: 'demo-a', groupId: '12345', revision: 1, tokenType: 'user', connected: true };
  let clock = Date.parse('2026-10-05T00:00:00Z'), handler;
  const calls = [], direct = {
    getSettings(code, purpose) { assert.equal(purpose, 'design'); return { ...settings, companyCode: code, groupId: code === 'demo-b' ? '22222' : settings.groupId }; },
    async request(code, purpose, revision, method, params) {
      const call = { code, purpose, revision, method, params }; calls.push(call);
      assert.equal(method, 'groups.getById');
      if (handler) return handler(call);
      return { groups: [{ ...group, id: Number(code === 'demo-b' ? '22222' : settings.groupId), access_token: 'FIXTURE_SECRET' }] };
    },
  };
  const options = { direct, now: () => clock, ...extras }, api = createVkAvatar(db, options);
  const preview = (body = {}, code = 'demo-a') => api.preview(code, { revision: settings.revision, image: { mime: 'image/png', base64: PNG }, ...body });
  const apply = (p, body = {}, code = 'demo-a') => api.apply(code, { revision: settings.revision, previewId: p.previewId, requestId: 'fixture_request_0001', confirmPublicPost: true, ...body });
  return { db, api, settings, options, direct, calls, preview, apply, setHandler: value => { handler = value; }, advance: ms => { clock += ms; } };
}
const code = expected => error => error.code === expected && !error.message.includes('FIXTURE_SECRET');

test('square preview makes exactly one scoped read and persists metadata only', async t => {
  const f = fixture(t), p = await f.preview({}, 'DEMO-A');
  assert.deepEqual(f.calls, [{ code: 'demo-a', purpose: 'design', revision: 1, method: 'groups.getById', params: { fields: 'photo_200,photo_max,photo_max_orig,has_photo' } }]);
  assert.equal(p.companyCode, 'demo-a'); assert.equal(p.groupId, '12345'); assert.equal(p.operation, 'avatar');
  assert.deepEqual(p.before, { hasPhoto: true, photo200: group.photo_200, photoMax: group.photo_max, photoMaxOrig: group.photo_max_orig });
  assert.deepEqual(Object.keys(p.after).sort(), ['height', 'mime', 'sourceHash', 'width']);
  assert.equal(p.after.width, 1); assert.equal(p.after.height, 1); assert.match(p.sourceHash, /^[a-f0-9]{64}$/); assert.equal(p.after.sourceHash, p.sourceHash);
  assert.deepEqual(p.capabilities, CAPABILITIES); assert.deepEqual(p.warnings, WARNINGS);
  assert.equal(Date.parse(p.expiresAt) - Date.parse(p.createdAt), 30 * 60 * 1000);
  const columns = f.db.prepare('PRAGMA table_info(vk_avatar_previews)').all(); assert.ok(columns.every(c => !/BLOB/i.test(c.type) && !/base64|image_bytes/.test(c.name)));
  const serialized = JSON.stringify({ p, rows: f.db.prepare('SELECT * FROM vk_avatar_previews').all() });
  for (const privateValue of [PNG, 'FIXTURE_SECRET', 'access_token', 'base64', 'image_bytes']) assert.ok(!serialized.includes(privateValue));
});

test('missing current photo fields remain unknown; returned capability objects cannot enable application', async t => {
  const f = fixture(t); f.setHandler(() => ({ groups: [{ id: 12345 }] }));
  const p = await f.preview(); assert.deepEqual(p.before, { hasPhoto: null, photo200: null, photoMax: null, photoMaxOrig: null });
  p.capabilities.applyEnabled = true; p.warnings.length = 0;
  const capabilities = f.api.getCapabilities(); capabilities.applyEnabled = true;
  assert.deepEqual(f.api.getCapabilities(), CAPABILITIES); assert.deepEqual(f.apply(p).capabilities, CAPABILITIES);
  assert.deepEqual(f.apply(p).warnings, WARNINGS);
});

test('image and request validation rejects remote sources, nonsquare images, unsafe sizes and forged controls before reads', async t => {
  const f = fixture(t), rectangular = Buffer.from(PNG, 'base64'), huge = Buffer.from(PNG, 'base64');
  rectangular.writeUInt32BE(2, 16); huge.writeUInt32BE(20000, 16); huge.writeUInt32BE(20000, 20);
  for (const image of [null, { mime: 'image/svg+xml', base64: PNG }, { mime: 'image/jpeg', base64: PNG },
    { mime: 'image/png', base64: 'AAAA' }, { mime: 'image/png', base64: PNG + ' ' }, { mime: 'image/png', url: 'https://example.org/a.png' },
    { mime: 'image/png', base64: rectangular.toString('base64') }, { mime: 'image/png', base64: huge.toString('base64') },
    { mime: 'image/png', base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }]) await assert.rejects(f.preview({ image }), code('INVALID_IMAGE'));
  for (const body of [{ crop: {} }, { applyEnabled: true }, { groupId: '999' }, { companyCode: 'demo-b' }, { revision: '1' }, { revision: undefined }]) await assert.rejects(f.preview(body));
  assert.equal(f.calls.length, 0); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_avatar_previews').get().n, 0);
});

test('square JPEG structural fixture follows shared validation without an image decoder', async t => {
  const f = fixture(t), jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,0,0xff,0xd9]);
  const p = await f.preview({ image: { mime: 'image/jpeg', base64: jpeg.toString('base64') } }); assert.equal(p.after.mime, 'image/jpeg');
});

test('checked user binding, company existence and exact revision are required before any read', async t => {
  const f = fixture(t);
  for (const tokenType of ['group', 'service', undefined]) { f.settings.tokenType = tokenType; await assert.rejects(f.preview(), code('TOKEN_TYPE_MISMATCH')); }
  f.settings.tokenType = 'user'; f.settings.connected = false; await assert.rejects(f.preview(), code('CONNECTION_MISSING'));
  f.settings.connected = true; await assert.rejects(f.preview({ revision: 2 }), code('SETTINGS_CHANGED'));
  await assert.rejects(f.preview({}, 'deleted'), code('INVALID_INPUT')); await assert.rejects(f.preview({}, 'missing'), code('INVALID_INPUT'));
  f.settings.groupId = ''; await assert.rejects(f.preview(), code('CONNECTION_MISSING')); assert.equal(f.calls.length, 0);
});

test('malformed and foreign avatar reads fail closed and never store raw provider data', async t => {
  const f = fixture(t);
  for (const result of [null, {}, { groups: [] }, { groups: [group, group] }, { groups: [{ ...group, id: 999 }] }, { groups: [{ ...group, has_photo: '1' }] },
    ...['http://sun1.userapi.com/a.jpg', 'https://vk.com.evil.test/a.jpg', 'https://127.0.0.1/a', 'https://u:p@vk.com/a', 'javascript:alert(1)',
      'https://vk.com/a?access_token=FIXTURE_SECRET'].map(url => ({ groups: [{ ...group, photo_200: url }] }))]) {
    f.setHandler(() => result); await assert.rejects(f.preview());
  }
  f.setHandler(() => { throw Object.assign(new Error('FIXTURE_SECRET'), { code: 'ACCESS_DENIED' }); });
  await assert.rejects(f.preview(), code('ACCESS_DENIED'));
  f.setHandler(() => { throw new Error('FIXTURE_SECRET'); }); await assert.rejects(f.preview(), code('CONNECTION_UNCERTAIN'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_avatar_previews').get().n, 0);
});

test('binding changes during readonly lookup discard stale preview', async t => {
  const f = fixture(t); f.setHandler(() => { f.settings.revision++; return { groups: [group] }; });
  await assert.rejects(f.preview(), code('SETTINGS_CHANGED')); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_avatar_previews').get().n, 0);
});

test('mutable connector settings cannot change the binding snapshot during the read', async t => {
  const f = fixture(t); f.direct.getSettings = () => f.settings;
  f.setHandler(() => { f.settings.groupId = '999'; return { groups: [group] }; });
  await assert.rejects(f.preview(), code('SETTINGS_CHANGED'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_avatar_previews').get().n, 0);
  assert.equal(f.calls.length, 1);
});

test('loss of checked user connection during readonly lookup discards the preview', async t => {
  const f = fixture(t);
  f.setHandler(() => { f.settings.connected = false; return { groups: [group] }; });
  await assert.rejects(f.preview(), code('CONNECTION_MISSING'));
  f.settings.connected = true;
  f.setHandler(() => { f.settings.tokenType = 'group'; return { groups: [group] }; });
  await assert.rejects(f.preview(), code('TOKEN_TYPE_MISMATCH'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_avatar_previews').get().n, 0);
});

test('twenty active previews are bounded per company and expiry releases quota', async t => {
  const f = fixture(t); for (let i = 0; i < 20; i++) await f.preview();
  const before = f.calls.length; await assert.rejects(f.preview(), code('PREVIEW_LIMIT')); assert.equal(f.calls.length, before);
  await f.preview({}, 'demo-b'); f.advance(30 * 60 * 1000); const p = await f.preview(); assert.equal(p.companyCode, 'demo-a');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM vk_avatar_previews WHERE company_code='demo-a'").get().n, 1);
});

test('valid confirmed apply is always blocked, audited once and replayable after restart and expiry with zero provider calls', async t => {
  const f = fixture(t, { applyEnabled: true }), p = await f.preview(), before = f.calls.length, result = f.apply(p);
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'AVATAR_APPLY_DISABLED'); assert.equal(result.previewId, p.previewId);
  assert.equal(result.sourceHash, p.sourceHash); assert.deepEqual(result.capabilities, CAPABILITIES); assert.equal(f.calls.length, before);
  assert.deepEqual(f.apply(p), result); assert.deepEqual(f.apply(p, { requestId: 'fixture_request_0002' }), result);
  f.advance(30 * 60 * 1000);
  const restarted = createVkAvatar(f.db, f.options);
  assert.deepEqual(restarted.apply('demo-a', { revision: 1, previewId: p.previewId, requestId: result.requestId, confirmPublicPost: true }), result);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_avatar_actions').get().n, 1);
  assert.equal(f.calls.length, before); assert.deepEqual(restarted.history('demo-a', { revision: 1 }).items, [result]);
});

test('lazy expiry cleanup preserves blocked audit and its exact replay metadata', async t => {
  const f = fixture(t), p = await f.preview(), blocked = f.apply(p);
  await f.preview(); f.advance(30 * 60 * 1000);
  const fresh = await f.preview(), before = f.calls.length;
  assert.deepEqual(f.apply(p), blocked); assert.deepEqual(f.api.history('demo-a').items, [blocked]);
  assert.equal(f.calls.length, before);
  const previews = f.db.prepare('SELECT preview_id FROM vk_avatar_previews').all().map(row => row.preview_id).sort();
  assert.deepEqual(previews, [p.previewId, fresh.previewId].sort());
});

test('false/missing confirmation and forged flags cannot enable apply or produce an external call', async t => {
  const f = fixture(t), p = await f.preview(), before = f.calls.length;
  for (const body of [{ confirmPublicPost: false }, { confirmPublicPost: undefined }, { confirmPublicPost: 'true' }, { applyEnabled: true },
    { force: true }, { allowPublicPost: true }, { crop: {} }, { image: { mime: 'image/png', base64: PNG } }, { token: 'FIXTURE_SECRET' }, { groupId: '999' }]) assert.throws(() => f.apply(p, body), code('INVALID_INPUT'));
  assert.equal(f.calls.length, before); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_avatar_actions').get().n, 0);
});

test('foreign previews, stale group/revision and request conflicts fail closed with no external calls', async t => {
  const f = fixture(t), p = await f.preview(), p2 = await f.preview(), before = f.calls.length;
  assert.throws(() => f.apply(p, {}, 'demo-b'), code('PREVIEW_NOT_FOUND'));
  assert.throws(() => f.apply({ previewId: 'fixture_missing_id' }), code('PREVIEW_NOT_FOUND'));
  f.apply(p); assert.throws(() => f.apply(p2), code('REQUEST_CONFLICT'));
  f.settings.revision = 2; assert.throws(() => f.apply(p), code('SETTINGS_CHANGED'));
  f.settings.revision = 1; f.settings.groupId = '999'; assert.throws(() => f.apply(p), code('SETTINGS_CHANGED'));
  assert.equal(f.calls.length, before);
});

test('expired unused preview cannot create blocked action; history isolates current binding and company', async t => {
  const f = fixture(t), p = await f.preview(); f.advance(30 * 60 * 1000);
  assert.throws(() => f.apply(p), code('PREVIEW_EXPIRED')); assert.equal(f.api.history('demo-a').items.length, 0);
  const p2 = await f.preview(); f.apply(p2); assert.equal(f.api.history('DEMO-A', { revision: 1 }).items.length, 1);
  assert.equal(f.api.history('demo-b').items.length, 0);
  f.settings.revision = 2; assert.equal(f.api.history('demo-a', { revision: 2 }).items.length, 0);
  assert.throws(() => f.api.history('demo-a', { revision: 1 }), code('SETTINGS_CHANGED'));
  f.settings.revision = 1; f.settings.groupId = '999'; assert.equal(f.api.history('demo-a').items.length, 0);
  assert.throws(() => f.api.history('deleted'), code('INVALID_INPUT'));
  assert.throws(() => f.api.history('demo-a', { groupId: '12345' }), code('INVALID_INPUT'));
});

test('parallel metadata previews enforce quota after awaited reads', async t => {
  const f = fixture(t), results = await Promise.allSettled(Array.from({ length: 21 }, () => f.preview()));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 20);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'PREVIEW_LIMIT').length, 1);
});

test('avatar error messages are fixed public text', () => {
  assert.equal(typeof VK_AVATAR_ERRORS.AVATAR_APPLY_DISABLED, 'string'); assert.ok(Object.isFrozen(VK_AVATAR_ERRORS));
});
