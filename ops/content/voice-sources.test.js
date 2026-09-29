'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createVoiceSources } = require('./voice-sources');
const { inspectAudio } = require('./audio-container');
const audio = require('./voice-audio-fixtures');

const COMPANIES = { alvi: 'АЛВИ', avokado: 'Авокадо' };
const SAMPLES = { 'audio/x-m4a': audio.m4a(), 'audio/mpeg': audio.mp3(), 'audio/ogg': audio.ogg(), 'audio/wav': audio.wav() };
const owner = { role: 'owner', login: 'owner', companyCodes: [], permissions: [] };
const editor = { role: 'user', login: 'editor', companyCodes: ['avokado'], permissions: ['autoposting.view', 'autoposting.edit'] };
const viewer = { role: 'user', login: 'viewer', companyCodes: ['avokado'], permissions: ['autoposting.view'] };
const stranger = { role: 'user', login: 'alvi-editor', companyCodes: ['alvi'], permissions: ['autoposting.view', 'autoposting.edit'] };
const noModule = { role: 'user', login: 'info', companyCodes: ['avokado'], permissions: ['company-information.view', 'company-information.edit'] };
// Заглушка CRM: существующие ролики по компаниям.
const POSTS = new Set(['avokado:1', 'avokado:3', 'avokado:5', 'avokado:7', 'avokado:8', 'alvi:4']);
const crm = { calls: 0, down: false };
async function verifyPost(user, code, post) {
  crm.calls++;
  if (crm.down) throw Object.assign(Error('CRM недоступна'), { status: 502 });
  if (!POSTS.has(`${code}:${post}`)) throw Object.assign(Error('Ролик не найден'), { status: 404 });
}

function setup(t, options = { verifyPost }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-sources-'));
  const db = new DatabaseSync(path.join(dir, 'content.sqlite'));
  crm.down = false;
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, voices: createVoiceSources({ db, assetsDir: path.join(dir, 'assets'), companies: COMPANIES, ...options }) };
}
const rejects = (promise, code, pattern) => assert.rejects(promise, error => error.status === code && (!pattern || pattern.test(error.message)));
const stored = dir => { const root = path.join(dir, 'assets', 'voice-sources'); return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter(n => /\.\w+$/.test(n)) : []; };

test('разбор контейнера: корректные записи четырёх форматов', () => {
  assert.equal(inspectAudio(SAMPLES['audio/x-m4a']), 'm4a');
  assert.equal(inspectAudio(SAMPLES['audio/mpeg']), 'mp3');
  assert.equal(inspectAudio(SAMPLES['audio/ogg']), 'ogg');
  assert.equal(inspectAudio(audio.ogg({ head: '\x01vorbis' })), 'ogg');
  assert.equal(inspectAudio(SAMPLES['audio/wav']), 'wav');
});

test('разбор контейнера: видео, пустые и повреждённые файлы отклоняются', () => {
  const reason = (bytes, expected) => assert.throws(() => inspectAudio(bytes), error => error.reason === expected, expected);
  reason(audio.m4a({ tracks: [['soun', 'mp4a'], ['vide', 'avc1']] }), 'video');
  reason(audio.m4a({ tracks: [['vide', 'avc1']] }), 'video');
  reason(audio.m4a({ tracks: [] }), 'no-audio');
  reason(audio.m4a({ tracks: [['soun', 'mp4a', { samples: [64, 64] }]] }), 'corrupt');
  reason(audio.m4a().subarray(0, audio.m4a().length - 10), 'corrupt');
  reason(audio.ogg({ head: '\x80theora' }), 'video');
  reason(audio.ogg({ audio: false }), 'no-audio');
  reason(audio.ogg({ head: 'unknown!' }), 'no-audio');
  const badCrc = Buffer.from(SAMPLES['audio/ogg']); badCrc[badCrc.length - 1] ^= 1;
  reason(badCrc, 'corrupt');
  reason(SAMPLES['audio/ogg'].subarray(0, SAMPLES['audio/ogg'].length - 5), 'corrupt');
  reason(SAMPLES['audio/wav'].subarray(0, 300), 'corrupt');
  reason(audio.wav({ data: 0 }), 'no-audio');
  reason(SAMPLES['audio/mpeg'].subarray(0, SAMPLES['audio/mpeg'].length - 100), 'corrupt');
  reason(audio.mp3({ frames: 1 }), 'no-audio');
  reason(Buffer.concat([Buffer.from('\0\0\0\x20ftypisom'), Buffer.alloc(64)]), 'corrupt');
  reason(Buffer.from('%PDF-1.7 ....................'), 'unknown');
});

test('запись каждого формата сохраняется, привязывается к ролику и переживает перезапуск', async t => {
  const { dir, db, voices } = setup(t);
  for (const [mime, bytes] of Object.entries(SAMPLES)) {
    const item = await voices.store({ user: editor, companyCode: 'avokado', postId: '7', name: 'голос.' + mime.split('/')[1], mime, bytes });
    assert.equal(item.postId, 7);
    assert.match(item.url, /^\/content\/voice-sources\/\d+\?companyCode=avokado$/);
  }
  await voices.store({ user: owner, companyCode: 'avokado', postId: 8, name: 'b.mp3', mime: 'audio/mpeg', bytes: SAMPLES['audio/mpeg'] });
  const again = createVoiceSources({ db, assetsDir: path.join(dir, 'assets'), companies: COMPANIES, verifyPost });
  const listed = await again.list({ user: viewer, companyCode: 'avokado', postId: 7 });
  assert.deepEqual(listed.map(item => item.mime).sort(), ['audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav']);
  const opened = again.open({ user: viewer, companyCode: 'avokado', id: listed[0].id });
  assert.ok(fs.readFileSync(opened.file).equals(SAMPLES['audio/wav']));
});

test('неверные файлы: видео под audio/mp4, OGG без звука, повреждённые — ничего не сохраняется', async t => {
  const { dir, voices } = setup(t);
  const base = { user: editor, companyCode: 'avokado', postId: 1, name: 'x' };
  await rejects(voices.store({ ...base, mime: 'audio/mp4', bytes: audio.m4a({ tracks: [['soun', 'mp4a'], ['vide', 'avc1']] }) }), 415, /видео/);
  await rejects(voices.store({ ...base, mime: 'audio/ogg', bytes: audio.ogg({ audio: false }) }), 415, /нет звуковой/);
  await rejects(voices.store({ ...base, mime: 'audio/ogg', bytes: audio.ogg({ head: '\x80theora' }) }), 415, /видео/);
  await rejects(voices.store({ ...base, mime: 'audio/wav', bytes: SAMPLES['audio/wav'].subarray(0, 200) }), 415, /повреждён/);
  await rejects(voices.store({ ...base, mime: 'audio/ogg', bytes: SAMPLES['audio/wav'] }), 415, /не совпадает/);
  await rejects(voices.store({ ...base, mime: 'video/mp4', bytes: SAMPLES['audio/x-m4a'] }), 415);
  await rejects(voices.store({ ...base, mime: 'audio/mpeg', bytes: Buffer.alloc(0) }), 400);
  await rejects(voices.store({ ...base, mime: 'audio/mpeg', bytes: Buffer.alloc(25 * 1024 * 1024 + 1) }), 413);
  await rejects(voices.store({ ...base, postId: '1; DROP', mime: 'audio/mpeg', bytes: SAMPLES['audio/mpeg'] }), 400);
  assert.deepEqual(stored(dir), []);
});

test('ролик проверяется в CRM: несуществующий, чужой, сбой CRM и отсутствие проверки — отказ', async t => {
  const { dir, voices } = setup(t);
  const body = { user: owner, name: 'a.mp3', mime: 'audio/mpeg', bytes: SAMPLES['audio/mpeg'] };
  await rejects(voices.store({ ...body, companyCode: 'avokado', postId: 999 }), 404);
  await rejects(voices.store({ ...body, companyCode: 'avokado', postId: 4 }), 404, /не найден/); // ролик 4 принадлежит alvi
  await rejects(voices.list({ user: owner, companyCode: 'avokado', postId: 4 }), 404);
  crm.down = true;
  await rejects(voices.store({ ...body, companyCode: 'avokado', postId: 7 }), 502);
  await rejects(voices.list({ user: owner, companyCode: 'avokado', postId: 7 }), 502);
  assert.deepEqual(stored(dir), []);
  const { dir: other, voices: unchecked } = setup(t, {});
  await rejects(unchecked.store({ ...body, companyCode: 'avokado', postId: 7 }), 503);
  assert.deepEqual(stored(other), []);
});

test('изоляция компаний и права: без новых ролей', async t => {
  const { voices } = setup(t);
  const item = await voices.store({ user: editor, companyCode: 'avokado', postId: 3, name: 'a.mp3', mime: 'audio/mpeg', bytes: SAMPLES['audio/mpeg'] });
  for (const user of [viewer, stranger, noModule]) {
    await rejects(voices.store({ user, companyCode: 'avokado', postId: 3, name: 'b', mime: 'audio/mpeg', bytes: SAMPLES['audio/mpeg'] }), 403);
  }
  await rejects(voices.list({ user: stranger, companyCode: 'avokado', postId: 3 }), 403);
  await rejects(voices.list({ user: noModule, companyCode: 'avokado', postId: 3 }), 403);
  assert.throws(() => voices.open({ user: stranger, companyCode: 'avokado', id: item.id }), e => e.status === 404);
  assert.throws(() => voices.open({ user: stranger, companyCode: 'alvi', id: item.id }), e => e.status === 404);
});

test('HTTP: CRM проверяется до чтения тела, CSRF, плеер с диапазонами', async t => {
  const { voices } = setup(t);
  const sessions = { editor: { user: editor, csrf: 'e' }, stranger: { user: stranger, csrf: 's' } };
  let bodiesRead = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://local');
    const reply = (code, payload, extra = {}) => { response.writeHead(code, { 'content-type': 'application/json', ...extra }); response.end(JSON.stringify(payload)); };
    try {
      const handled = await voices.handle(request, response, url, {
        requireSession: req => sessions[req.headers['x-test-user']] || (() => { throw Object.assign(Error('login'), { status: 401 }); })(),
        requireCsrf: (req, session) => { if (req.headers['x-csrf-token'] !== session.csrf) throw Object.assign(Error('csrf'), { status: 403 }); },
        readRaw: async req => { bodiesRead++; const parts = []; for await (const chunk of req) parts.push(chunk); return Buffer.concat(parts); },
        reply,
      });
      if (!handled) reply(404, { error: 'not found' });
    } catch (error) { if (!response.headersSent) reply(error.status || 500, { error: error.message }); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (user, csrf, type, body, postId = 5) => fetch(`${base}/content/voice-sources?companyCode=avokado&postId=${postId}&name=${encodeURIComponent('Таня.m4a')}`,
    { method: 'POST', headers: { 'x-test-user': user, 'x-csrf-token': csrf, 'content-type': type }, body });

  assert.equal((await fetch(`${base}/content/voice-sources?companyCode=avokado&postId=5`)).status, 401);
  assert.equal((await post('editor', 'wrong', 'audio/x-m4a', SAMPLES['audio/x-m4a'])).status, 403);
  assert.equal((await post('editor', 'e', 'audio/x-m4a', SAMPLES['audio/x-m4a'], 404)).status, 404);
  assert.equal(bodiesRead, 0, 'тело не читается без подтверждения ролика');
  assert.equal((await post('editor', 'e', 'audio/mp4', audio.m4a({ tracks: [['soun', 'mp4a'], ['vide', 'avc1']] }))).status, 415);
  const created = await post('editor', 'e', 'audio/x-m4a', SAMPLES['audio/x-m4a']);
  assert.equal(created.status, 201);
  const { item } = await created.json();
  const audioResponse = await fetch(base + item.url, { headers: { 'x-test-user': 'editor' } });
  assert.equal(audioResponse.status, 200);
  assert.equal(audioResponse.headers.get('content-type'), 'audio/mp4');
  assert.match(audioResponse.headers.get('cache-control'), /private/);
  assert.ok(Buffer.from(await audioResponse.arrayBuffer()).equals(SAMPLES['audio/x-m4a']));
  const part = await fetch(base + item.url, { headers: { 'x-test-user': 'editor', range: 'bytes=4-7' } });
  assert.equal(part.status, 206);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString('latin1'), 'ftyp');
  assert.equal((await fetch(base + item.url)).status, 401);
  assert.equal((await fetch(base + item.url, { headers: { 'x-test-user': 'stranger' } })).status, 404);
  assert.equal((await post('stranger', 's', 'audio/x-m4a', SAMPLES['audio/x-m4a'])).status, 403);
});
