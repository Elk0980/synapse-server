'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createVkMaterials } = require('./vk-materials');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=';
const album = { id: 77, owner_id: -12345, title: 'Portfolio', size: 4 };
const photo = { id: 91, owner_id: -12345, album_id: 77, text: 'Caption' };
function fixture(t, extra = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES('demo-a',0),('demo-b',0),('deleted',1)");
  const settings = { companyCode: 'demo-a', groupId: '12345', revision: 1, tokenType: 'user', connected: true };
  const calls = [], uploads = []; let handler, uploadHandler, clock = Date.parse('2026-10-04T12:00:00Z');
  const direct = {
    getSettings(code) { return { ...settings, companyCode: code, groupId: code === 'demo-b' ? '222' : settings.groupId }; },
    async request(code, purpose, revision, method, params) {
      assert.equal(purpose, 'design'); assert.equal(revision, settings.revision);
      const call = { code, method, params }; calls.push(call);
      if (handler) { const result = await handler(call); if (result !== undefined) return result; }
      if (method === 'photos.getAlbums') return { count: 1, items: [{ ...album, owner_id: -Number(code === 'demo-b' ? 222 : settings.groupId) }] };
      if (method === 'photos.getUploadServer') return { upload_url: 'https://pu.vk.com/upload', album_id: 77 };
      if (method === 'photos.save' || method === 'photos.getById') return [photo];
      throw new Error('Unexpected method');
    },
  };
  const options = { direct, now: () => clock, timeoutMs: 30, fetchImpl: async (url, init) => {
    uploads.push({ url, init }); if (uploadHandler) return uploadHandler(url, init);
    return new Response(JSON.stringify({ server: 42, aid: 77, photos_list: 'FIXTURE_UPLOAD_PAYLOAD', hash: 'FIXTURE_UPLOAD_HASH' }));
  }, ...extra };
  const api = createVkMaterials(db, options);
  const preview = (body = {}, code = 'demo-a') => api.preview(code, { revision: 1, albumId: 77, caption: 'Caption', image: { mime: 'image/png', base64: PNG }, ...body });
  const apply = (p, body = {}, code = 'demo-a') => api.apply(code, { revision: 1, previewId: p.previewId, requestId: 'fixture_request_0001', ...body });
  return { db, api, options, settings, calls, uploads, preview, apply,
    handler: value => { handler = value; }, uploadHandler: value => { uploadHandler = value; }, advance: ms => { clock += ms; } };
}

test('album list is bounded, sanitized, paginated and rejects foreign-owner response', async t => {
  const f = fixture(t); f.handler(({ method }) => method === 'photos.getAlbums' ? { count: 201, items: [{ ...album, access_key: 'DO_NOT_LEAK' }] } : undefined);
  const result = await f.api.listAlbums('DEMO-A', { revision: 1, offset: 100 });
  assert.equal(result.companyCode, 'demo-a'); assert.equal(result.nextOffset, 101); assert.equal(result.total, 201);
  assert.deepEqual(result.albums, [{ id: 77, title: 'Portfolio', size: 4 }]);
  assert.deepEqual(f.calls[0].params, { offset: 100, count: 100 });
  f.handler(() => ({ count: 1, items: [{ ...album, owner_id: -999 }] }));
  await assert.rejects(f.api.listAlbums('demo-a'), { code: 'GROUP_MISMATCH' });
  await assert.rejects(f.api.listAlbums('demo-a', { offset: -1 }), { code: 'INVALID_INPUT' });
});

test('preview freezes local image/caption and checks album without any upload or mutation', async t => {
  const f = fixture(t), p = await f.preview();
  assert.equal(p.operation, 'album_photo'); assert.deepEqual(p.album, { id: 77, title: 'Portfolio' });
  assert.equal(p.caption, 'Caption'); assert.equal(p.image.width, 1); assert.equal(p.image.sourceHash.length, 64);
  assert.equal(Date.parse(p.expiresAt) - Date.parse(p.createdAt), 30 * 60 * 1000);
  assert.equal(f.uploads.length, 0); assert.deepEqual(f.calls.map(x => x.method), ['photos.getAlbums']);
  assert.ok(!JSON.stringify(p).includes(PNG)); assert.equal(f.db.prepare('SELECT length(image_bytes) n FROM vk_material_previews').get().n, Buffer.from(PNG, 'base64').length);
  await assert.rejects(f.apply(p, {}, 'demo-b'), { code: 'PREVIEW_NOT_FOUND' });
  assert.equal(f.api.history('demo-b').items.length, 0);
});

test('missing/group/stale binding, deleted company and invalid source fail closed before provider read', async t => {
  const f = fixture(t);
  f.settings.tokenType = 'group'; await assert.rejects(f.preview(), { code: 'TOKEN_TYPE_MISMATCH' });
  await assert.rejects(f.api.listAlbums('demo-a'), { code: 'TOKEN_TYPE_MISMATCH' });
  f.settings.tokenType = 'user'; f.settings.connected = false; await assert.rejects(f.preview(), { code: 'CONNECTION_MISSING' });
  f.settings.connected = true; await assert.rejects(f.preview({ revision: 2 }), { code: 'SETTINGS_CHANGED' });
  await assert.rejects(f.preview({}, 'deleted'), { code: 'INVALID_INPUT' });
  for (const body of [{ albumId: 0 }, { albumId: -6 }, { albumId: '77' }, { caption: 'x'.repeat(2001) }, { caption: '\u0000' }, { image: { mime: 'image/png', url: 'https://example.org/a.png' } }, { image: { mime: 'image/svg+xml', base64: PNG } }, { image: { mime: 'image/png', base64: 'AAAA' } }, { groupId: '999' }]) {
    await assert.rejects(f.preview(body));
  }
  assert.equal(f.calls.length, 0);
});

test('album ownership and precise requested ID checked during preview', async t => {
  const f = fixture(t);
  for (const [item, code] of [[{ ...album, owner_id: -999 }, 'GROUP_MISMATCH'], [{ ...album, id: 88 }, 'ALBUM_NOT_FOUND']]) {
    f.handler(() => ({ count: 1, items: [item] })); await assert.rejects(f.preview(), { code });
  }
  f.handler(() => ({ count: 0, items: [] })); await assert.rejects(f.preview(), { code: 'ALBUM_NOT_FOUND' });
  assert.equal(f.uploads.length, 0);
});

test('confirmed upload saves exactly one scoped photo, verifies and drops bytes; duplicates survive restart', async t => {
  const f = fixture(t), p = await f.preview(), result = await f.apply(p);
  assert.equal(result.status, 'verified'); assert.deepEqual(result.photo, { id: 91, ownerId: -12345, albumId: 77 });
  assert.equal(f.uploads.length, 1); const { init } = f.uploads[0];
  assert.equal(init.redirect, 'error'); assert.equal(init.headers, undefined); assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual([...init.body.keys()], ['photo']); assert.equal(init.body.get('photo').type, 'image/png');
  assert.equal(init.body.get('photo').size, Buffer.from(PNG, 'base64').length);
  assert.deepEqual(f.calls.find(x => x.method === 'photos.save').params, { album_id: 77, caption: 'Caption', server: 42, photos_list: 'FIXTURE_UPLOAD_PAYLOAD', hash: 'FIXTURE_UPLOAD_HASH' });
  assert.equal(f.calls.at(-1).params.photos, '-12345_91');
  assert.equal(f.db.prepare('SELECT image_bytes FROM vk_material_previews').get().image_bytes, null);
  assert.deepEqual(await f.apply(p), result); assert.deepEqual(await f.apply(p, { requestId: 'fixture_request_0002' }), result);
  const restarted = createVkMaterials(f.db, f.options);
  assert.deepEqual(await restarted.apply('demo-a', { revision: 1, previewId: p.previewId, requestId: 'fixture_request_0001' }), result);
  assert.equal(f.uploads.length, 1); assert.equal(f.calls.filter(x => x.method === 'photos.save').length, 1);
  const history = f.api.history('demo-a'); assert.equal(history.items.length, 1); assert.ok(!JSON.stringify(history).includes('FIXTURE_UPLOAD_')); assert.ok(!JSON.stringify(history).includes(PNG));
  const second = await f.preview(); await assert.rejects(f.apply(second), { code: 'REQUEST_CONFLICT' });
});

test('durable claim precedes upload and concurrent confirmations cannot upload twice', async t => {
  const f = fixture(t), p = await f.preview(), p2 = await f.preview(); let release;
  f.uploadHandler(() => {
    assert.equal(f.db.prepare('SELECT status FROM vk_material_actions').get().status, 'applying');
    assert.equal(f.db.prepare('SELECT image_bytes FROM vk_material_previews WHERE preview_id=?').get(p.previewId).image_bytes, null);
    return new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ server: 42, photos_list: 'FIXTURE_UPLOAD_PAYLOAD', hash: 'FIXTURE_UPLOAD_HASH' }))); });
  });
  const pending = f.apply(p); while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.apply(p)).status, 'applying');
  await assert.rejects(f.apply(p2, { requestId: 'fixture_request_0002' }), { code: 'OPERATION_BUSY' });
  release(); assert.equal((await pending).status, 'verified'); assert.equal(f.uploads.length, 1);
});

test('expired previews purge source bytes without dispatch and active preview quota is bounded', async t => {
  const f = fixture(t), p = await f.preview(); f.advance(30 * 60 * 1000);
  await assert.rejects(f.apply(p), { code: 'PREVIEW_EXPIRED' });
  assert.equal(f.db.prepare('SELECT image_bytes FROM vk_material_previews').get().image_bytes, null); assert.equal(f.uploads.length, 0);
  for (let i = 0; i < 20; i++) await f.preview();
  await assert.rejects(f.preview(), { code: 'PREVIEW_LIMIT' });
  f.advance(30 * 60 * 1000); f.api.history('demo-a');
  assert.equal(f.db.prepare('SELECT count(*) n FROM vk_material_previews WHERE image_bytes IS NOT NULL').get().n, 0);
});

test('binding change or album rename after preview prevents upload', async t => {
  const f = fixture(t), p = await f.preview(); f.settings.revision = 2;
  await assert.rejects(f.apply(p), { code: 'SETTINGS_CHANGED' }); f.settings.revision = 1;
  f.handler(({ method }) => method === 'photos.getAlbums' ? { count: 1, items: [{ ...album, title: 'Changed' }] } : undefined);
  const result = await f.apply(p); assert.equal(result.status, 'failed'); assert.equal(result.code, 'STATE_CHANGED'); assert.equal(f.uploads.length, 0);
});

test('unsafe or wrong-album upload destinations never receive bytes', async t => {
  for (const destination of [{ upload_url: 'https://vk.com.evil.test/upload' }, { upload_url: 'http://pu.vk.com/upload' }, { upload_url: 'https://127.0.0.1/upload' }, { upload_url: 'https://u:p@pu.vk.com/upload' }, { upload_url: 'https://pu.vk.com/upload', album_id: 999 }]) {
    const f = fixture(t), p = await f.preview(); f.handler(({ method }) => method === 'photos.getUploadServer' ? destination : undefined);
    assert.equal((await f.apply(p)).status, 'failed'); assert.equal(f.uploads.length, 0); assert.ok(!f.calls.some(x => x.method === 'photos.save'));
  }
});

test('malformed, huge, stalled or redirected upload response is bounded and never saved/retried', async t => {
  for (const mode of ['json', 'large', 'timeout', 'stream', 'redirect', 'wrong-album']) {
    const f = fixture(t), p = await f.preview();
    f.uploadHandler(() => {
      if (mode === 'json') return new Response('DO_NOT_LEAK invalid');
      if (mode === 'large') return new Response('x'.repeat(2 * 1024 * 1024 + 1));
      if (mode === 'timeout') return new Promise(() => {});
      if (mode === 'stream') return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
      if (mode === 'redirect') return { ok: true, redirected: true };
      return new Response(JSON.stringify({ server: 42, aid: 999, photos_list: 'DO_NOT_LEAK', hash: 'DO_NOT_LEAK' }));
    });
    const result = await f.apply(p); assert.equal(result.status, 'uncertain');
    assert.ok(!JSON.stringify(result).includes('DO_NOT_LEAK')); assert.ok(!f.calls.some(x => x.method === 'photos.save'));
    await f.apply(p); assert.equal(f.uploads.length, 1); assert.equal(f.db.prepare('SELECT image_bytes FROM vk_material_previews').get().image_bytes, null);
  }
});

test('changed binding during upload prevents save and retains original company-scoped audit', async t => {
  const f = fixture(t), p = await f.preview(); f.uploadHandler(() => {
    f.settings.revision = 2; f.settings.groupId = '999';
    return new Response(JSON.stringify({ server: 42, photos_list: 'FIXTURE_UPLOAD_PAYLOAD', hash: 'FIXTURE_UPLOAD_HASH' }));
  });
  const result = await f.apply(p); assert.equal(result.code, 'SETTINGS_CHANGED'); assert.equal(result.groupId, '12345');
  assert.ok(!f.calls.some(x => x.method === 'photos.save')); assert.equal(f.api.history('demo-a', { revision: 2 }).items[0].revision, 1);
  assert.equal(f.api.history('demo-b').items.length, 0);
});

test('ambiguous save acceptance, foreign receipt, explicit rejection and missing readback remain distinct', async t => {
  for (const mode of ['timeout', 'malformed', 'foreign', 'reject', 'mismatch', 'read-fail', 'binding-change']) {
    const f = fixture(t), p = await f.preview();
    f.handler(({ method }) => {
      if (method === 'photos.save') {
        if (mode === 'timeout' || mode === 'reject') throw Object.assign(new Error('DO_NOT_LEAK'), { code: mode === 'reject' ? 'ACCESS_DENIED' : 'CONNECTION_UNCERTAIN', uncertain: mode === 'timeout' });
        if (mode === 'malformed') return 1;
        if (mode === 'foreign') return [{ ...photo, owner_id: -999 }];
        if (mode === 'binding-change') f.settings.revision = 2;
      }
      if (method === 'photos.getById') {
        if (mode === 'mismatch') return [{ ...photo, text: 'different' }];
        if (mode === 'read-fail') throw new Error('DO_NOT_LEAK');
      }
    });
    const result = await f.apply(p);
    assert.equal(result.status, mode === 'reject' ? 'failed' : ['mismatch', 'read-fail', 'binding-change'].includes(mode) ? 'applied_unverified' : 'uncertain');
    assert.ok(!JSON.stringify(result).includes('DO_NOT_LEAK'));
    if (mode !== 'binding-change') await f.apply(p);
    assert.equal(f.calls.filter(x => x.method === 'photos.save').length, 1);
  }
});
