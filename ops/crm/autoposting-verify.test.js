'use strict';
/* specs/215-publish-verify: проверка выхода публикаций через Onlypult. Синтетика: все идентификаторы,
   ключи и ссылки искусственные, реальная сеть запрещена. Ни одна проверка не создаёт повторной публикации. */
const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createCompanyInformation} = require('./company-information');
const {createAutoposting} = require('./autoposting');
const {createAutopostingTransport} = require('./autoposting-transport');
const {createOnlypultProvider, contentDigest} = require('./onlypult-provider');
const {createContentStages} = require('./content-stages');

const PROFILE = 'fixture-ig-profile', TOKEN = 'op_' + 'e'.repeat(64);
const VIDEO = 'https://cdn.example.test/verify-reel.mp4';
const CAPTION = 'Тестовая подпись рилса: спокойное утро в студии, запись по ссылке в профиле';
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}});

/* Сценарий: карточка Instagram Reel → очередь → настоящий транспорт и адаптер Onlypult → заглушка сети.
   routes — обработчики по «METHOD path», которые тест меняет по ходу. */
async function reelFlow(t, {post, platform = 'instagram'} = {}) {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Реальная сеть в этом тесте запрещена'));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,
      timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'alvi','ALVI — тест','Asia/Irkutsk','[]');`);
  let clock = Date.parse('2026-11-07T03:00:00Z');
  const now = () => clock, calls = [];
  const routes = {
    'GET /v1/profiles': () => [{id: PROFILE, name: 'Тестовый профиль', platform: platform === 'vk' ? 'vk' : 'instagram_business', status: 'active'}],
    'GET /v1/account': () => ({plan_active: true}),
    'GET /v1/posts/limits': () => ({platform: {limits: {text: {charLimit: 2200}, media: {maxCount: 10}}}}),
    'POST /v1/posts': post,
  };
  const fetchImpl = async (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, 'https://api.onlypult.com');
    const call = {method: options.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: options.body ? JSON.parse(options.body) : null};
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (!route) assert.fail(`Непредусмотренный запрос: ${call.method} ${call.path}`);
    const out = await route(call);
    return out instanceof Response ? out : json({data: out});
  };
  const information = createCompanyInformation(db, {now});
  const transport = createAutopostingTransport(db, {apiKey: 'TEST_ONLY_VERIFY_KEY_NEVER_LIVE', now, fetchImpl});
  const api = createAutoposting(db, {information, transport, now, logger: {warn() {}}});
  transport.saveSettings('alvi', {channels: [{id: platform, revision: 0, enabled: true, provider: 'onlypult', target: PROFILE, token: TOKEN}]});
  assert.equal((await transport.checkChannel('alvi', platform)).ok, true);
  let card = api.create('alvi', {title: 'Рилс', text: CAPTION, dayKey: 'D5', format: 'reel', mediaUrls: [VIDEO], platformIds: [platform],
    platformOptions: {instagram: {is_reels: true}}, scheduledAt: new Date(clock + 60000).toISOString(), timezone: 'Asia/Irkutsk',
    profileRevision: information.get('alvi').revision}, 7);
  card = api.approve(card.id, 'alvi', {revision: card.revision, approved: true}, {userId: 1, userName: 'Тестовый владелец'});
  card = await api.schedule(card.id, 'alvi', {revision: card.revision});
  clock += 60000;
  await api.drain();
  const posts = () => calls.filter(call => call.method === 'POST');
  const forbidden = () => calls.filter(call => /\/(retry|publish)$|retry-all-failed/.test(call.path));
  return {db, api, calls, routes, posts, forbidden, id: card.id, get: () => api.get(card.id, 'alvi'), advance: ms => {clock += ms;}, now};
}
const submittedAt = flow => new Date(flow.now() - 60000).toISOString();
const createdNear = flow => new Date(flow.now() - 60000 + 5000).toISOString();

test('FR-1: 422 retryable:true на ушедший POST — неоднозначно, не failed; сверка находит задание, подтверждает выход и ссылку', async t => {
  const flow = await reelFlow(t, {post: () => json({error: {code: 'media_processing', retryable: true}}, 422)});
  let card = flow.get();
  assert.equal(flow.posts().length, 1);
  assert.equal(card.deliveries[0].status, 'needs_review', 'запрос ушёл — задание могло быть создано');
  assert.equal(card.deliveries[0].errorCode, 'PROVIDER_UNCONFIRMED');
  assert.equal(card.status, 'needs_review');

  const jobId = 'fixture-ig-reel-job';
  const publishedAt = '2026-11-07T03:02:30Z';
  flow.routes['GET /v1/posts'] = call => {
    assert.equal(call.query.profile_id, PROFILE, 'ищем только в своём профиле');
    return [
      {id: 'other-job', profile_ids: [PROFILE], status: 'published', content: 'Другая подпись', created_at: createdNear(flow)},
      {id: jobId, profile_ids: [PROFILE], status: 'scheduled', content: CAPTION + '\r\n', created_at: createdNear(flow)},
    ];
  };
  flow.routes[`GET /v1/posts/${jobId}`] = () => ({id: jobId, profile_ids: [PROFILE], status: 'published', platform: 'instagram_business', published_at: publishedAt});
  flow.routes['GET /v1/analytics/profiles'] = call => {
    assert.equal(call.query.platform, 'instagram');
    return [{id: 'an_fixture_other', platform: 'instagram', linked_publish_profile: {id: 'someone-else'}},
      {id: 'an_fixture_ig', platform: 'instagram', status: 'active', linked_publish_profile: {id: PROFILE}}];
  };
  flow.routes['GET /v1/analytics/an_fixture_ig/top-posts'] = () => ({items: [
    {id: 'x1', url: 'https://www.instagram.com/reel/FIXTUREOTHER/', published_at: Date.parse(publishedAt) - 5 * 3600000, caption: CAPTION},
    {id: 'x2', url: 'https://www.instagram.com/reel/FIXTURE1/', published_at: Date.parse(publishedAt) + 40000, caption: CAPTION.slice(0, 60) + '…'},
  ]});
  await flow.api.drain();
  assert.equal(flow.calls.filter(call => call.path === '/v1/posts' && call.method === 'GET').length, 0, 'до интервала сверки поиск не идёт');

  flow.advance(10 * 60000);
  await flow.api.drain();
  card = flow.get();
  const delivery = card.deliveries[0];
  assert.equal(delivery.providerPostId, jobId, 'принято ровно одно совпадение по профилю и отпечатку текста');
  assert.equal(delivery.status, 'published');
  assert.equal(delivery.url, 'https://www.instagram.com/reel/FIXTURE1/');
  assert.equal(delivery.confirmedVia, 'provider_permalink');
  assert.equal(delivery.errorCode, null);
  assert.equal(delivery.providerPublishedAt, '2026-11-07T03:02:30.000Z');
  assert.equal(card.status, 'published');
  assert.equal(flow.posts().length, 1, 'повторной публикации нет');
  assert.deepEqual(flow.forbidden(), [], 'retry/publish у сервиса не вызываются');

  const before = flow.calls.length;
  flow.advance(2 * 3600000);
  await flow.api.drain();
  assert.equal(flow.calls.length, before, 'идемпотентно: подтверждённая со ссылкой доставка больше не проверяется');
});

/* FR-1 (после ревью PR 607): документированный отказ на POST — задание точно не создано. Доставка failed с понятной
   причиной, поиск у сервиса не идёт, человек может исправить и отправить снова (ровно одна новая отправка). */
const REJECTIONS = [
  ['400', () => json({name: 'Bad Request', message: 'fixture validation', code: 0, status: 400}, 400), 'PROVIDER_REJECTED'],
  ['401', () => json({name: 'Unauthorized', message: 'fixture key revoked', code: 0, status: 401}, 401), 'AUTH_FAILED'],
  ['403', () => json({name: 'Forbidden', message: 'fixture forbidden', code: 0, status: 403}, 403), 'AUTH_FAILED'],
  ['404', () => json({name: 'Not Found', message: 'fixture profile gone', code: 0, status: 404}, 404), 'PROVIDER_REJECTED'],
  ['429', () => json({name: 'Too Many Requests', message: 'fixture rate', code: 0, status: 429}, 429), 'RATE_LIMITED'],
  ['422 retryable:false', () => json({error: {code: 'validation_error', message: 'fixture', retryable: false}}, 422), 'PROVIDER_REJECTED'],
];
for (const [name, reply, code] of REJECTIONS) test(`FR-1: отказ ${name} на POST — failed (${code}), повторная отправка разрешена`, async t => {
  const flow = await reelFlow(t, {post: reply});
  let card = flow.get();
  assert.equal(flow.posts().length, 1);
  assert.equal(card.deliveries[0].status, 'failed', 'задание точно не создано');
  assert.equal(card.deliveries[0].errorCode, code);
  assert.equal(card.status, 'failed');
  assert.equal(card.lastErrorCode, code);
  // Сверка не ищет то, чего точно нет, и ничего не отправляет сама — ни сразу, ни через окно N дней.
  flow.advance(8 * 24 * 3600000);
  await flow.api.drain();
  assert.equal(flow.calls.filter(call => call.method === 'GET' && call.path === '/v1/posts').length, 0);
  assert.equal(flow.posts().length, 1, 'автоповтора нет');
  assert.equal(flow.get().status, 'failed');
  // Человек исправил причину и отправил снова: блокировки PUBLICATION_REVIEW_REQUIRED нет.
  const job = `fixture-resend-${name.replace(/\W+/g, '-')}`;
  flow.routes['POST /v1/posts'] = () => ({id: job, profile_ids: [PROFILE], status: 'scheduled', platform: 'instagram_business'});
  card = await flow.api.schedule(flow.id, 'alvi', {revision: flow.get().revision, scheduledAt: new Date(flow.now() + 60000).toISOString()});
  assert.equal(card.status, 'scheduled');
  flow.advance(60000);
  await flow.api.drain();
  card = flow.get();
  assert.equal(flow.posts().length, 2, 'ровно одна новая отправка по решению человека');
  assert.equal(card.deliveries[0].providerPostId, job);
  assert.equal(card.deliveries[0].status, 'needs_review');
  assert.deepEqual(flow.forbidden(), []);
});

test('FR-1: 5xx на POST — неоднозначно: на проверке, повторная отправка закрыта', async t => {
  const flow = await reelFlow(t, {post: () => json({message: 'fixture gateway'}, 502)});
  const card = flow.get();
  assert.equal(card.deliveries[0].status, 'needs_review');
  assert.equal(card.deliveries[0].errorCode, 'PUBLICATION_UNCERTAIN');
  await assert.rejects(flow.api.schedule(flow.id, 'alvi', {revision: card.revision, scheduledAt: new Date(flow.now() + 60000).toISOString()}),
    error => error.details?.code === 'PUBLICATION_REVIEW_REQUIRED');
  assert.equal(flow.posts().length, 1);
});

test('FR-10: задание не найдено за окно N дней — failed PROVIDER_NOT_FOUND; ошибка поиска вердикта не даёт; затем отправка разрешена', async t => {
  const flow = await reelFlow(t, {post: () => {throw new TypeError('fixture network timeout');}});
  assert.equal(flow.get().deliveries[0].errorCode, 'PUBLICATION_UNCERTAIN');
  let mode = 'empty';
  flow.routes['GET /v1/posts'] = () => mode === 'down' ? json({message: 'fixture outage'}, 503)
    : json({data: [{id: 'unrelated', profile_ids: [PROFILE], status: 'published', content: 'Другое', created_at: createdNear(flow)}], meta: {total: 1, page: 1, limit: 100, pages: 1}});
  flow.advance(10 * 60000);
  await flow.api.drain();
  assert.equal(flow.get().deliveries[0].status, 'needs_review', 'в окне «не найдено» — ещё не вердикт');
  flow.advance(6 * 24 * 3600000);
  await flow.api.drain();
  assert.equal(flow.get().deliveries[0].status, 'needs_review');

  // Окно истекло, но поиск у сервиса не удался — вердикта нет, доставка остаётся на проверке.
  mode = 'down';
  flow.advance(2 * 24 * 3600000);
  await flow.api.drain();
  let card = flow.get();
  assert.equal(card.deliveries[0].status, 'needs_review');
  assert.equal(card.deliveries[0].errorCode, 'PUBLICATION_UNCERTAIN');

  // Ручная «Проверить статус» после восстановления: полный поиск без совпадения → failed, причина понятна.
  mode = 'empty';
  card = await flow.api.reconcile(flow.id, 'alvi', {revision: card.revision});
  assert.equal(card.deliveries[0].status, 'failed');
  assert.equal(card.deliveries[0].errorCode, 'PROVIDER_NOT_FOUND');
  assert.equal(card.status, 'failed');
  assert.equal(card.lastErrorCode, 'PROVIDER_NOT_FOUND');
  assert.equal(flow.posts().length, 1, 'сама система ничего не отправила повторно');
  const searches = flow.calls.filter(call => call.method === 'GET' && call.path === '/v1/posts').length;
  flow.advance(3600000);
  await flow.api.drain();
  assert.equal(flow.calls.filter(call => call.method === 'GET' && call.path === '/v1/posts').length, searches, 'после вердикта поиск прекращён');

  flow.routes['POST /v1/posts'] = () => ({id: 'fixture-after-not-found', profile_ids: [PROFILE], status: 'scheduled', platform: 'instagram_business'});
  card = await flow.api.schedule(flow.id, 'alvi', {revision: card.revision, scheduledAt: new Date(flow.now() + 60000).toISOString()});
  flow.advance(60000);
  await flow.api.drain();
  assert.equal(flow.posts().length, 2);
  assert.equal(flow.get().deliveries[0].providerPostId, 'fixture-after-not-found');
  assert.deepEqual(flow.forbidden(), []);
});

test('FR-10: задание нашлось последним поиском после окна — опубликовано, не failed', async t => {
  const flow = await reelFlow(t, {post: () => json({error: {code: 'validation_error', message: 'fixture', retryable: true}}, 422)});
  assert.equal(flow.get().deliveries[0].errorCode, 'PROVIDER_UNCONFIRMED');
  const job = 'fixture-late-found', created = createdNear(flow);
  flow.routes['GET /v1/posts'] = () => [];
  flow.advance(8 * 24 * 3600000);
  flow.routes['GET /v1/posts'] = () => [{id: job, profile_ids: [PROFILE], status: 'published', content: CAPTION, created_at: created}];
  flow.routes[`GET /v1/posts/${job}`] = () => ({id: job, profile_ids: [PROFILE], status: 'published', platform: 'instagram_business', published_at: created});
  flow.routes['GET /v1/analytics/profiles'] = () => json({status: 403, code: 403, message: 'analytics_not_available'}, 403);
  await flow.api.drain();
  const card = flow.get();
  assert.equal(card.deliveries[0].status, 'published');
  assert.equal(card.deliveries[0].providerPostId, job);
  assert.equal(card.status, 'published');
  assert.equal(flow.posts().length, 1, 'двойной публикации нет');
  await assert.rejects(flow.api.schedule(flow.id, 'alvi', {revision: card.revision, scheduledAt: new Date(flow.now() + 60000).toISOString()}),
    error => [409].includes(error.status));
});

test('FR-1: таймаут ответа на POST → на проверке; чужие и двойные совпадения не принимаются', async t => {
  const flow = await reelFlow(t, {post: () => {throw new TypeError('fixture network timeout');}});
  assert.equal(flow.get().deliveries[0].errorCode, 'PUBLICATION_UNCERTAIN');
  let listed = 0;
  flow.routes['GET /v1/posts'] = () => {
    listed++;
    return listed === 1
      ? [{id: 'j-old', profile_ids: [PROFILE], status: 'published', content: CAPTION, created_at: '2026-11-01T00:00:00Z'},
        {id: 'j-wrong-profile', profile_ids: ['another-profile'], status: 'published', content: CAPTION, created_at: createdNear(flow)}]
      : [{id: 'j-a', profile_ids: [PROFILE], status: 'published', content: CAPTION, created_at: createdNear(flow)},
        {id: 'j-b', profile_ids: [PROFILE], status: 'published', content: CAPTION, created_at: createdNear(flow)}];
  };
  flow.advance(10 * 60000);
  await flow.api.drain();
  assert.equal(flow.get().deliveries[0].providerPostId, null, 'старое задание и чужой профиль не подходят');
  flow.advance(10 * 60000);
  await flow.api.drain();
  const card = flow.get();
  assert.equal(listed, 2);
  assert.equal(card.deliveries[0].providerPostId, null, 'два одинаковых кандидата — неоднозначно, не угадываем');
  assert.equal(card.deliveries[0].status, 'needs_review');
  assert.equal(flow.posts().length, 1);
  assert.deepEqual(flow.forbidden(), []);
});

test('FR-1: сервис сначала сообщил failed, позже published — сверка подтверждает выход без retry', async t => {
  const job = 'fixture-ig-failed-first';
  const flow = await reelFlow(t, {post: () => ({id: job, profile_ids: [PROFILE], status: 'failed', platform: 'instagram_business'})});
  let card = flow.get();
  assert.equal(card.deliveries[0].status, 'needs_review');
  assert.equal(card.deliveries[0].errorCode, 'PROVIDER_FAILED');
  let status = 'failed';
  flow.routes[`GET /v1/posts/${job}`] = () => ({id: job, profile_ids: [PROFILE], status, platform: 'instagram_business', published_at: status === 'published' ? '2026-11-07T03:20:00Z' : null});
  flow.routes['GET /v1/analytics/profiles'] = () => json({status: 403, code: 403, message: 'analytics_not_available'}, 403);
  flow.advance(10 * 60000);
  await flow.api.drain();
  assert.equal(flow.get().deliveries[0].errorCode, 'PROVIDER_FAILED', 'пока сервис говорит failed — ждём, не публикуем заново');
  status = 'published';
  flow.advance(10 * 60000);
  await flow.api.drain();
  card = flow.get();
  assert.equal(card.status, 'published');
  assert.equal(card.deliveries[0].status, 'published');
  assert.equal(card.deliveries[0].url, null, 'аналитики нет в тарифе — ссылка не выдумывается');
  assert.equal(card.deliveries[0].errorCode, 'PROVIDER_LINK_UNAVAILABLE');
  assert.equal(card.deliveries[0].confirmedVia, 'provider_status');
  assert.equal(flow.posts().length, 1);
  assert.deepEqual(flow.forbidden(), []);
});

test('FR-3: сверка опубликованных за N дней дозаполняет ссылку позже; за окном не трогает; ручная проверка тоже только читает', async t => {
  const job = 'fixture-ig-link-later';
  const flow = await reelFlow(t, {post: () => ({id: job, profile_ids: [PROFILE], status: 'scheduled', platform: 'instagram_business'})});
  const publishedAt = '2026-11-07T03:05:00Z';
  flow.routes[`GET /v1/posts/${job}`] = () => ({id: job, profile_ids: [PROFILE], status: 'published', platform: 'instagram_business', published_at: publishedAt});
  flow.routes['GET /v1/analytics/profiles'] = () => [{id: 'an_fixture_ig', platform: 'instagram', linked_publish_profile: {id: PROFILE}}];
  let items = [];
  flow.routes['GET /v1/analytics/an_fixture_ig/top-posts'] = () => ({items});
  flow.advance(60000);
  await flow.api.drain();
  let card = flow.get();
  assert.equal(card.deliveries[0].status, 'published');
  assert.equal(card.deliveries[0].url, null, 'аналитика ещё не видит пост');

  flow.advance(20 * 60000);
  await flow.api.drain();
  const topCalls = () => flow.calls.filter(call => call.path.endsWith('/top-posts')).length;
  assert.equal(topCalls(), 1, 'повторный поиск ссылки не чаще раза в час');

  // Ручная «Проверить статус» не ждёт интервала и ничего не отправляет.
  items = [{id: 'p', url: 'https://www.instagram.com/reel/FIXTURE2/', published_at: Date.parse(publishedAt), caption: CAPTION}];
  card = await flow.api.reconcile(flow.id, 'alvi', {revision: card.revision});
  assert.equal(card.deliveries[0].url, 'https://www.instagram.com/reel/FIXTURE2/');
  assert.equal(card.deliveries[0].confirmedVia, 'provider_permalink');
  assert.equal(topCalls(), 2);
  flow.advance(3 * 3600000);
  await flow.api.drain();
  assert.equal(topCalls(), 2, 'ссылка есть — сверка её больше не ищет');

  // Публикация старше окна N дней не проверяется вовсе.
  flow.db.prepare("UPDATE autoposting_deliveries SET url=NULL,link_checked_at=NULL,provider_published_at='2026-10-01T00:00:00.000Z',finished_at='2026-10-01T00:00:00.000Z'").run();
  flow.advance(3 * 3600000);
  await flow.api.drain();
  assert.equal(topCalls(), 2);
  assert.equal(flow.posts().length, 1);
});

test('FR-2: ВК через Onlypult — ссылки на пост у сервиса нет; аналитика не запрашивается, url пустой с пометкой', async t => {
  const job = 'fixture-vk-job';
  const flow = await reelFlow(t, {platform: 'vk', post: () => ({id: job, profile_ids: [PROFILE], status: 'scheduled', platform: 'vk'})});
  flow.routes[`GET /v1/posts/${job}`] = () => ({id: job, profile_ids: [PROFILE], status: 'published', platform: 'vk', published_at: '2026-11-07T03:02:00Z'});
  flow.advance(60000);
  await flow.api.drain();
  const card = flow.get();
  assert.equal(card.deliveries[0].status, 'published');
  assert.equal(card.deliveries[0].url, null);
  assert.equal(card.deliveries[0].errorCode, 'PROVIDER_LINK_UNAVAILABLE');
  assert.equal(flow.calls.filter(call => call.path.startsWith('/v1/analytics')).length, 0);
});

test('Адаптер: permalink — только домен площадки, ровно один кандидат, иначе null; findSubmitted строгий', async () => {
  const failure = code => Object.assign(new Error(code), {code});
  let routes = {};
  const provider = createOnlypultProvider({failure, tokenFor: () => TOKEN, readResponse: async response => response.text(),
    fetchImpl: async address => {
      const url = new URL(address);
      const route = routes[url.pathname];
      if (!route) assert.fail('Непредусмотренный запрос ' + url.pathname);
      const out = route(url);
      return out instanceof Response ? out : json({data: out});
    }});
  const at = '2026-11-07T03:00:00Z', ms = Date.parse(at);
  const row = {id: 'instagram', target: PROFILE, revision: 1};
  routes['/v1/analytics/profiles'] = () => [{id: 'an_x', platform: 'instagram', linked_publish_profile: {id: PROFILE}}];
  routes['/v1/analytics/an_x/top-posts'] = () => ({items: [{url: 'https://evil.example/reel/1', published_at: ms, caption: CAPTION}]});
  assert.equal(await provider.permalink(row, {publishedAt: at, text: CAPTION}), null, 'чужой домен');
  routes['/v1/analytics/an_x/top-posts'] = () => ({items: [
    {url: 'https://www.instagram.com/reel/A/', published_at: ms, caption: CAPTION},
    {url: 'https://www.instagram.com/reel/B/', published_at: ms + 60000, caption: CAPTION}]});
  assert.equal(await provider.permalink(row, {publishedAt: at, text: CAPTION}), null, 'два кандидата');
  routes['/v1/analytics/an_x/top-posts'] = () => ({items: [{url: 'https://www.instagram.com/reel/A/', published_at: ms, caption: 'Короткий другой'}]});
  assert.equal(await provider.permalink(row, {publishedAt: at, text: CAPTION}), null, 'подпись не совпала');
  routes['/v1/analytics/an_x/top-posts'] = () => ({items: [{url: 'https://www.tiktok.com/@x/video/1', published_at: ms, caption: CAPTION}]});
  assert.equal(await provider.permalink({...row, id: 'tiktok'}, {publishedAt: at, text: CAPTION}), null, 'аналитика TikTok связана с другим профилем-платформой');
  assert.equal(await provider.permalink({...row, id: 'vk'}, {publishedAt: at, text: CAPTION}), null, 'для ВК permalink у сервиса нет');
  routes['/v1/analytics/profiles'] = () => json({status: 403, code: 403, message: 'analytics_not_available'}, 403);
  assert.equal(await provider.permalink(row, {publishedAt: at, text: CAPTION}), null, 'нет аналитики в тарифе');

  routes['/v1/posts'] = () => [{id: 'j1', profile_ids: [PROFILE], status: 'published', content: CAPTION, created_at: at}];
  const sha = contentDigest(CAPTION);
  assert.equal((await provider.findSubmitted(row, {contentSha: sha, submittedAt: at})).providerPostId, 'j1');
  assert.equal(await provider.findSubmitted(row, {contentSha: contentDigest('другое'), submittedAt: at}), null);
  assert.equal(await provider.findSubmitted(row, {contentSha: sha, submittedAt: '2026-11-08T03:00:00Z'}), null, 'вне окна попытки');
  await assert.rejects(provider.findSubmitted(row, {contentSha: 'bad', submittedAt: at}), error => error.code === 'PROVIDER_POST_REQUIRED');

  // Все страницы списка в пределах SEARCH_PAGES; неполный поиск — ошибка, а не «не найдено».
  const filler = n => Array.from({length: n}, (_, i) => ({id: `f${i}`, profile_ids: [PROFILE], status: 'published', content: 'Другое', created_at: at}));
  const pages = [];
  routes['/v1/posts'] = url => {
    pages.push(url.searchParams.get('page'));
    assert.equal(url.searchParams.get('limit'), '100');
    return url.searchParams.get('page') === '1' ? json({data: filler(100), meta: {total: 101, page: 1, limit: 100, pages: 2}})
      : json({data: [{id: 'j2', profile_ids: [PROFILE], status: 'published', content: CAPTION, created_at: at}], meta: {total: 101, page: 2, limit: 100, pages: 2}});
  };
  assert.equal((await provider.findSubmitted(row, {contentSha: sha, submittedAt: at})).providerPostId, 'j2', 'нужное задание на второй странице');
  assert.deepEqual(pages, ['1', '2']);
  routes['/v1/posts'] = url => json({data: filler(100), meta: {total: 1200, page: Number(url.searchParams.get('page')), limit: 100, pages: 12}});
  await assert.rejects(provider.findSubmitted(row, {contentSha: sha, submittedAt: at}), error => error.code === 'RESPONSE_UNCERTAIN', 'больше 10 страниц — поиск неполон');
  routes['/v1/posts'] = () => filler(100);
  await assert.rejects(provider.findSubmitted(row, {contentSha: sha, submittedAt: at}), error => error.code === 'RESPONSE_UNCERTAIN', 'полная страница без meta — продолжение неизвестно');
});

test('Этап идеи: задание принято сервисом и ждёт сверки — «Запланировано к выходу», не «Ошибка публикации»', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES(1,'alvi','Asia/Irkutsk',0);
    CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,company_id INTEGER,status TEXT,platform_ids TEXT,media_urls TEXT,
      content_revision INTEGER,approved_revision INTEGER,deleted_at TEXT,archived_at TEXT);
    CREATE TABLE autoposting_deliveries(post_id INTEGER,channel_id TEXT,status TEXT,url TEXT,error_code TEXT,finished_at TEXT);
    CREATE TABLE media_mentor_variant_transfers(company_id INTEGER,idea_id TEXT,post_id INTEGER);
    INSERT INTO autoposting_posts VALUES(1,1,'needs_review','["instagram"]','[]',1,1,NULL,NULL);
    INSERT INTO autoposting_deliveries VALUES(1,'instagram','needs_review',NULL,'PROVIDER_PENDING',NULL);
    INSERT INTO media_mentor_variant_transfers VALUES(1,'idea-1',1);`);
  const stages = createContentStages(db);
  const snapshot = {companyCode: 'alvi', plan: {days: [{ideaId: 'idea-1'}]}, variants: []};
  let day = stages.apply(snapshot, 'alvi', null).plan.days[0];
  assert.equal(day.stage, 'scheduled');
  assert.equal(day.publications[0].status, 'publishing');
  db.exec("UPDATE autoposting_deliveries SET error_code='PROVIDER_UNCONFIRMED'");
  day = stages.apply(snapshot, 'alvi', null).plan.days[0];
  assert.equal(day.stage, 'publish_error', 'неподтверждённое — честно ошибка, пока сверка не нашла выход');
  db.close();
});
