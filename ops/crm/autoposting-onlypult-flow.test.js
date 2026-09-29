'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createCompanyInformation} = require('./company-information');
const {createAutoposting} = require('./autoposting');
const {createAutopostingTransport} = require('./autoposting-transport');

test('очередь → реальный транспорт Onlypult → YouTube Shorts: одна отправка, затем только GET без ложного опубликования', async t => {
  // Все идентификаторы и ключи искусственные. Даже случайный обход внедрённого mock не выйдет в сеть.
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Реальная сеть в этом тесте запрещена'));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,
      timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials)
      VALUES(1,'alvi','ALVI — тест','Asia/Irkutsk','[]'),(2,'other','Другая тестовая компания','UTC','[]');`);

  const profileId = 742001;
  const providerPostId = 'fixture-youtube-job-01';
  const onlypultToken = 'op_' + 'a'.repeat(64);
  const calls = [];
  let clock = Date.parse('2026-09-29T00:00:00Z');
  const now = () => clock;
  const fetchImpl = async (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, 'https://api.onlypult.com');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, `Bearer ${onlypultToken}`);
    assert.ok(options.signal instanceof AbortSignal);
    const call = {method: options.method, path: url.pathname, body: options.body ? JSON.parse(options.body) : null};
    calls.push(call);
    let data;
    if (call.method === 'GET' && call.path === '/v1/profiles') {
      data = [
        {id: String(profileId), name: 'ALVI — тестовый YouTube', platform: 'youtube', status: 'active'},
        {id: '742002', name: 'Другой тестовый YouTube', platform: 'youtube', status: 'active'},
      ];
    } else if (call.method === 'GET' && call.path === '/v1/account') {
      data = {timezone: 'Asia/Irkutsk', plan_active: true};
    } else if (call.method === 'GET' && call.path === '/v1/posts/limits') {
      assert.equal(url.searchParams.get('profile_id'), String(profileId));
      data = {platform: {limits: {text: {charLimit: 5000}, media: {maxCount: 1}}}};
    } else if (call.method === 'POST' && call.path === '/v1/posts') {
      // Формат ответа провайдера: одиночный числовой profile_id, без массива profile_ids и permalink.
      data = {id: providerPostId, profile_id: profileId, status: 'draft', platform: 'youtube',
        is_shorts: true, publish_at: null, published_at: null};
    } else if (call.method === 'GET' && call.path === `/v1/posts/${providerPostId}`) {
      data = {id: providerPostId, profile_id: profileId, status: 'published', platform: 'youtube', is_shorts: true};
    } else {
      assert.fail(`Непредусмотренный запрос: ${call.method} ${call.path}`);
    }
    return new Response(JSON.stringify({data}), {status: 200, headers: {'content-type': 'application/json'}});
  };

  const information = createCompanyInformation(db, {now});
  const transport = createAutopostingTransport(db, {
    apiKey: 'TEST_ONLY_FLOW_ENCRYPTION_KEY_NEVER_LIVE', now, fetchImpl,
  });
  const api = createAutoposting(db, {information, transport, now, logger: {warn() {}}});
  transport.saveSettings('alvi', {channels: [{id: 'youtube_shorts', revision: 0, enabled: true,
    provider: 'onlypult', target: String(profileId), token: onlypultToken}]});
  assert.equal((await transport.checkChannel('alvi', 'youtube_shorts')).ok, true);

  const title = 'ALVI: спокойное утро';
  const caption = 'Согласованное описание именно для YouTube Shorts';
  const mediaUrl = 'https://cdn.example.test/onlypult-flow-short.mp4';
  let card = api.create('alvi', {title, text: 'Общий текст других площадок', dayKey: 'D1',
    captions: {youtube_shorts: caption}, mediaUrls: [mediaUrl], platformIds: ['youtube_shorts'],
    scheduledAt: new Date(clock + 60000).toISOString(), timezone: 'Asia/Irkutsk',
    profileRevision: information.get('alvi').revision}, 7);
  await assert.rejects(api.schedule(card.id, 'alvi', {revision: card.revision}),
    error => error.details?.code === 'APPROVAL_REQUIRED');
  card = api.approve(card.id, 'alvi', {revision: card.revision, approved: true},
    {userId: 1, userName: 'Тестовый владелец'});
  assert.equal(card.approval.approved, true);
  card = await api.schedule(card.id, 'alvi', {revision: card.revision});
  assert.equal(card.status, 'scheduled');
  await api.drain();
  assert.equal(calls.filter(call => call.method === 'POST').length, 0, 'до срока ни одного POST');

  clock += 60000;
  await api.drain();
  const writes = calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 1, 'через очередь прошла ровно одна отправка провайдеру');
  assert.equal(writes[0].path, '/v1/posts');
  assert.equal(writes[0].body.title, title, 'заголовок сохранился на всём пути от карточки');
  assert.equal(writes[0].body.content, caption, 'передана подпись YouTube, а не общий текст');
  assert.deepEqual(writes[0].body.profile_ids, [String(profileId)], 'выбран ровно нужный профиль');
  assert.deepEqual(writes[0].body.media_urls, [mediaUrl]);
  assert.deepEqual(writes[0].body.platform_options, {youtube: {privacy: 'public', is_shorts: true}});
  assert.equal(writes[0].body.publish_now, true);

  const checkPending = (value, providerStatus, errorCode) => {
    assert.equal(value.status, 'needs_review', 'статус провайдера не заменяет доказательство публикации');
    assert.equal(value.lastErrorCode, errorCode);
    assert.equal(value.deliveries.length, 1);
    const delivery = value.deliveries[0];
    assert.equal(delivery.channelId, 'youtube_shorts');
    assert.equal(delivery.providerPostId, providerPostId, 'числовой profile_id принят и задание сохранено');
    assert.equal(delivery.providerStatus, providerStatus);
    assert.equal(delivery.status, 'needs_review');
    assert.equal(delivery.externalId, null);
    assert.equal(delivery.url, null, 'социальная ссылка не выдумывается');
  };
  checkPending(api.get(card.id, 'alvi'), 'draft', 'PROVIDER_PENDING');
  const afterSubmission = calls.length;
  await api.drain();
  assert.equal(calls.length, afterSubmission, 'немедленный второй проход не отправляет заново и соблюдает интервал сверки');

  clock += 60000;
  await api.drain();
  card = api.get(card.id, 'alvi');
  checkPending(card, 'published', 'PROVIDER_LINK_UNAVAILABLE');
  card = await api.reconcile(card.id, 'alvi', {revision: card.revision});
  checkPending(card, 'published', 'PROVIDER_LINK_UNAVAILABLE');
  assert.deepEqual(calls.slice(afterSubmission).map(({method, path}) => ({method, path})), [
    {method: 'GET', path: `/v1/posts/${providerPostId}`},
    {method: 'GET', path: `/v1/posts/${providerPostId}`},
  ], 'автоматическая и ручная сверки только читают одно сохранённое задание');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1, 'сверки не создают повторную публикацию');
  assert.equal(api.list('other').posts.length, 0);
});
