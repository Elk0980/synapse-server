'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createVkDirect } = require('./vk-direct');
function fixture(t, tokenType = 'user') {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec("CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,is_deleted INTEGER DEFAULT 0); INSERT INTO companies(code) VALUES('demo-a'),('demo-b')");
  const calls = []; let override;
  const direct = createVkDirect(db, { apiKey: 'fixture-storage-key', timeoutMs: 20, fetchImpl: async (url, init) => {
    const method = url.split('/').pop(), params = new URLSearchParams(init.body); calls.push({ method, params, init });
    if (override) return override(method);
    const response = method === 'account.getProfileInfo' ? { id: 10 } : method === 'groups.getTokenPermissions' ? { mask: 0, permissions: [] } : method === 'groups.getById' ? { groups: [{ id: 12345 }] } : [];
    return new Response(JSON.stringify({ response }));
  } });
  direct.saveSettings('demo-a', 'design', { revision: 0, groupId: '12345', tokenType, accessToken: 'fixture-token' });
  return { direct, calls, override: value => { override = value; } };
}
const saveParams = { album_id: 77, caption: 'caption', server: 42, photos_list: 'fixture-list', hash: 'fixture-hash' };

test('album methods inject exact owner/group and never create extra owner parameters for getById', async t => {
  const f = fixture(t); await f.direct.checkConnection('demo-a', 'design');
  await f.direct.request('demo-a', 'design', 1, 'photos.getAlbums', { count: 100, offset: 0 });
  assert.equal(f.calls.at(-1).params.get('owner_id'), '-12345'); assert.equal(f.calls.at(-1).params.has('group_id'), false);
  await f.direct.request('demo-a', 'design', 1, 'photos.getUploadServer', { album_id: 77 });
  assert.equal(f.calls.at(-1).params.get('group_id'), '12345');
  await f.direct.request('demo-a', 'design', 1, 'photos.save', saveParams);
  assert.equal(f.calls.at(-1).params.get('group_id'), '12345');
  await f.direct.request('demo-a', 'design', 1, 'photos.getById', { photos: '-12345_91' });
  assert.deepEqual([...f.calls.at(-1).params.keys()], ['photos', 'v']);
  assert.equal(f.calls.at(-1).init.redirect, 'error'); assert.equal(f.calls.at(-1).init.headers.Authorization, 'Bearer fixture-token');
});

test('album transport rejects group tokens, analytics purpose, foreign ownership and opaque reference injection before network', async t => {
  const f = fixture(t); await f.direct.checkConnection('demo-a', 'design'); const before = f.calls.length;
  const attempts = [
    ['photos.getAlbums', { owner_id: -999 }], ['photos.getAlbums', { group_id: '12345' }], ['photos.getAlbums', { album_ids: '77,88' }],
    ['photos.getAlbums', { count: 101 }], ['photos.getAlbums', { offset: -1 }], ['photos.getUploadServer', { album_id: 0 }],
    ['photos.save', { ...saveParams, group_id: '999' }], ['photos.save', { ...saveParams, caption: 'x'.repeat(2001) }],
    ['photos.getById', { photos: '-999_91' }], ['photos.getById', { photos: '-12345_91_accesskey' }],
    ['photos.getById', { photos: '-12345_91,-12345_92' }], ['photos.getById', { photos: '-12345_91', access_key: 'fixture' }],
    ['photos.saveOwnerPhoto', saveParams], ['wall.post', {}],
  ];
  for (const [method, params] of attempts) await assert.rejects(f.direct.request('demo-a', 'design', 1, method, params));
  await assert.rejects(f.direct.request('demo-a', 'analytics', 1, 'photos.getAlbums'), { code: 'METHOD_DENIED' });
  assert.equal(f.calls.length, before);
  const group = fixture(t, 'group'); await group.direct.checkConnection('demo-a', 'design'); const groupBefore = group.calls.length;
  for (const method of ['photos.getAlbums', 'photos.getUploadServer', 'photos.save', 'photos.getById']) {
    await assert.rejects(group.direct.request('demo-a', 'design', 1, method), { code: 'TOKEN_TYPE_MISMATCH' });
  }
  assert.equal(group.calls.length, groupBefore);
});

test('photo save marks malformed/5xx/timeouts ambiguous and never retries or leaks provider message', async t => {
  const f = fixture(t); await f.direct.checkConnection('demo-a', 'design');
  for (const mode of ['timeout', 'json', 'server']) {
    f.override(() => mode === 'timeout' ? new Promise(() => {}) : mode === 'json' ? new Response('fixture-secret') : new Response(JSON.stringify({ error: { error_code: 15, error_msg: 'fixture-secret' } }), { status: 503 }));
    const before = f.calls.length;
    await assert.rejects(f.direct.request('demo-a', 'design', 1, 'photos.save', saveParams), error => {
      assert.equal(error.uncertain, true); assert.equal(error.ambiguous, true); assert.ok(!error.message.includes('fixture-secret')); return true;
    });
    assert.equal(f.calls.length, before + 1);
  }
});
