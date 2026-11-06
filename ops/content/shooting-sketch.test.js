'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createSketches} = require('./shooting-sketch');
const {createLocalStorage} = require('./shooting-storage');
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 1)]);

function setup(t, {provider = {name: 'openai', url: 'https://api.openai.com/v1', secret: 'sk-SAMPLE'}, reply, env = {}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sketch-')), db = new DatabaseSync(':memory:'), calls = [];
  t.after(() => { db.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const fetchImpl = async (url, options) => { calls.push({url, options, body: JSON.parse(options.body)});
    return reply ? reply() : {ok: true, status: 200, json: async () => ({data: [{b64_json: PNG.toString('base64')}]})}; };
  const storage = createLocalStorage(dir, {statfs: () => ({bavail: 1e6, bsize: 4096, blocks: 2e6})});
  return {calls, storage, api: createSketches({db, storage, env, providers: {runtimeProviders: () => provider ? [provider] : []}, fetchImpl, dailyLimit: 2})};
}
const actor = {name: 'SAMPLE СММ'};

test('эскиз: проверенный ключ OpenAI Хью, вертикальный кадр, файл только своей компании, суточный лимит', async (t) => {
  const s = setup(t);
  const made = await s.api.generate('avokado', 'r1', {frame: 1, shot: 'бариста у стойки', angle: 'средний план снизу'}, actor);
  assert.equal(s.calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(s.calls[0].options.headers.authorization, 'Bearer sk-SAMPLE');
  assert.equal(s.calls[0].body.model, 'gpt-image-1'); assert.equal(s.calls[0].body.size, '1024x1536');
  assert.match(s.calls[0].body.prompt, /Ракурс: средний план снизу/);
  assert.equal(s.storage.size('avokado', s.api.file('avokado', String(made.sketch.id)).disk_key), PNG.length);
  assert.throws(() => s.api.file('alvi', String(made.sketch.id)), (e) => e.status === 404);
  assert.deepEqual(Object.keys(s.api.latest('avokado', 'r1')), ['1']); assert.deepEqual(s.api.latest('alvi', 'r1'), {});
  await s.api.generate('avokado', 'r1', {frame: 2, shot: 'витрина'}, actor);
  await assert.rejects(s.api.generate('avokado', 'r1', {frame: 3, shot: 'x'}, actor), (e) => e.status === 429 && e.details.code === 'SKETCH_LIMIT');
  assert.equal(s.api.status('alvi').available, true, 'лимит считается по компании');
});

test('эскиз недоступен: нет ключа или у ключа нет права — понятная причина и что нужно от Влада', async (t) => {
  const none = setup(t, {provider: null});
  assert.equal(none.api.status('avokado').available, false); assert.match(none.api.status('avokado').reason, /Нужно от Влада/);
  await assert.rejects(none.api.generate('avokado', 'r1', {frame: 1, shot: 'x'}, actor), (e) => e.status === 503 && e.details.code === 'SKETCH_UNAVAILABLE');
  assert.equal(none.calls.length, 0);
  const denied = setup(t, {reply: () => ({ok: false, status: 403, json: async () => ({error: {message: 'Your organization must be verified'}})})});
  await assert.rejects(denied.api.generate('avokado', 'r1', {frame: 1, shot: 'x'}, actor), (e) => e.details.code === 'SKETCH_FORBIDDEN' && /нет права/.test(e.message));
  const foreign = setup(t, {provider: {name: 'openai', url: 'https://evil.example/v1', secret: 'x'}});
  assert.equal(foreign.api.status('avokado').available, false, 'только официальный хост');
  await assert.rejects(denied.api.generate('avokado', 'r1', {frame: 1}, actor), (e) => e.status === 400);
});

test('эскиз: ключ из окружения сервера, в ответ кабинету ключ не попадает, одновременные нажатия не обходят лимит', async (t) => {
  const env = {HUGH_FALLBACK_PROVIDERS: 'openai', HUGH_FALLBACK_OPENAI_URL: 'https://api.openai.com/v1',
    HUGH_FALLBACK_OPENAI_KEY: 'sk-ENV-SAMPLE', HUGH_FALLBACK_OPENAI_MODEL: 'gpt-4o-mini'};
  const s = setup(t, {provider: null, env});
  const state = s.api.status('avokado');
  assert.equal(state.available, true);
  assert.doesNotMatch(JSON.stringify(state), /sk-ENV-SAMPLE/);
  const results = await Promise.allSettled([1, 2, 3].map((frame) => s.api.generate('avokado', 'r1', {frame, shot: 'стойка'}, actor)));
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(results[2].reason.details.code, 'SKETCH_LIMIT');
  assert.equal(s.calls.length, 2); assert.equal(s.calls[0].options.headers.authorization, 'Bearer sk-ENV-SAMPLE');
  assert.doesNotMatch(JSON.stringify(results[0].value), /sk-ENV-SAMPLE/);
  assert.doesNotMatch(s.calls[0].body.prompt, /кафе/, 'описание кадра без привязки к виду бизнеса');
});
