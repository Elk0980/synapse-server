'use strict';
// Флаг автомонтажа и границы шлюза (specs/214-auto-montage). Сквозной тест с ffmpeg — ops/montage/worker.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {createMontageGateway, readMontageConfig} = require('./montage-gateway');

const KEY = 'k'.repeat(40), HASH = crypto.createHash('sha256').update(KEY).digest('hex');

test('Флаг: по умолчанию выключено; включается только MONTAGE_ENABLED=1 + хеш ключа + известные компании', () => {
  assert.equal(readMontageConfig({}).enabled, false);
  assert.equal(readMontageConfig({MONTAGE_ENABLED: '1', MONTAGE_WORKER_KEY_SHA256: HASH}).enabled, false, 'без компаний не включается');
  assert.equal(readMontageConfig({MONTAGE_ENABLED: '1', MONTAGE_WORKER_COMPANIES: 'avokado'}).enabled, false, 'без ключа не включается');
  assert.equal(readMontageConfig({MONTAGE_ENABLED: 'true', MONTAGE_WORKER_KEY_SHA256: HASH, MONTAGE_WORKER_COMPANIES: 'avokado'}).enabled, false, 'только ровно 1');
  const on = readMontageConfig({MONTAGE_ENABLED: '1', MONTAGE_WORKER_KEY_SHA256: HASH.toUpperCase(), MONTAGE_WORKER_COMPANIES: 'avokado, unknown ,alvi'});
  assert.equal(on.enabled, true);
  assert.deepEqual(on.companies, ['avokado', 'alvi'], 'неизвестная компания отброшена');
});

function gateway(config) {
  const sent = [];
  const shooting = {actor: () => ({name: 'СММ'}), takes: () => [{id: 1, frame: 1}], openTake: () => { throw Error('нет'); }};
  const g = createMontageGateway({db: new DatabaseSync(':memory:'), shooting, crmUrl: 'http://crm', crmKey: 'x', assetsDir: '/nonexistent', publishingOrigin: 'https://h',
    maxVideoBytes: 1, readJson: async (request) => request.body || {}, readRaw: async () => Buffer.alloc(0), sendJson: (response, status, body) => sent.push({status, body}),
    config, fetchImpl: async () => { throw Error('сеть в этом тесте не нужна'); }});
  return {g, sent};
}
const url = (path) => new URL('http://content' + path);

test('Выключено: кабинет получает 503 MONTAGE_OFF, воркер с верным ключом — 503, с неверным — 401', async () => {
  const {g, sent} = gateway(readMontageConfig({MONTAGE_WORKER_KEY_SHA256: HASH, MONTAGE_WORKER_COMPANIES: 'avokado'}));
  await assert.rejects(g.handle({method: 'POST', headers: {}, body: {ideaId: 'r-1'}}, {}, url('/content/montage/drafts?companyCode=avokado')), (error) => error.status === 503 && error.details.code === 'MONTAGE_OFF');
  await g.handle({method: 'GET', headers: {}}, {}, url('/content/montage/drafts?companyCode=avokado&ideaId=r-1'));
  assert.deepEqual(sent.at(-1).body, {enabled: false, jobs: []});
  await assert.rejects(g.handle({method: 'GET', headers: {'x-api-key': KEY}}, {}, url('/content/internal/montage/queue')), {status: 503});
  await assert.rejects(g.handle({method: 'GET', headers: {'x-api-key': 'wrong'}}, {}, url('/content/internal/montage/queue')), {status: 401});
  assert.equal(await g.handle({method: 'GET', headers: {}}, {}, url('/content/shooting/reels')), false, 'чужие маршруты не перехватываются');
});

test('Включено: компания вне списка не ставит задание и не видна воркеру', async () => {
  const {g, sent} = gateway({enabled: true, keySha256: HASH, companies: ['avokado']});
  await assert.rejects(g.handle({method: 'POST', headers: {}, body: {ideaId: 'r-1'}}, {}, url('/content/montage/drafts?companyCode=alvi')), {status: 503});
  await g.handle({method: 'POST', headers: {}, body: {ideaId: 'r-1'}}, {}, url('/content/montage/drafts?companyCode=avokado'));
  assert.equal(sent.at(-1).status, 201);
  await assert.rejects(g.handle({method: 'POST', headers: {'x-api-key': KEY}}, {}, url(`/content/internal/montage/jobs/${sent.at(-1).body.job.id}/claim?companyCode=alvi`)), {status: 403});
  await g.handle({method: 'GET', headers: {'x-api-key': KEY}}, {}, url('/content/internal/montage/jobs'));
  assert.equal(sent.at(-1).body.jobs.length, 1);
});
