'use strict';
/* Доступ к измерениям YouTube: сеть без перенаправлений, предел тела, срок и отмена,
   области чтения, точная привязка канала (UC / ссылка / @ручка через forHandle) и CAS ревизии.
   Ответы — настоящие Response/ReadableStream Node 24 с синтетическими данными; сеть не вызывается. */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createSocialAnalyticsCredentials} = require('./social-analytics-credentials');
const {createSocialYoutubeAccess, youtubeChannelRef, YOUTUBE_ANALYTICS_PROVIDER, YOUTUBE_READONLY_SCOPES,
  YOUTUBE_OAUTH_TOKEN_URL: TOKEN_URL, YOUTUBE_DATA_API_CHANNELS: CHANNELS_URL,
  YOUTUBE_ANALYTICS_REPORTS: REPORTS_URL, YOUTUBE_MAX_RESPONSE_BYTES} = require('./social-youtube-access');

const CHANNEL = 'UCabcdefghijklmnopqrstuv';
const OTHER_CHANNEL = 'UCzyxwvutsrqponmlkjihgfe';
const SECRET = JSON.stringify({clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-secret-value', refreshToken: '1//refresh-token-value'});
const LEAKS = ['refresh-token-value', 'GOCSPX', 'client-123', 'ya29', 'evil.example', 'invalid_grant'];
const assertNoSecrets = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const leak of LEAKS) assert.equal(text.includes(leak), false, `утечка: ${leak}`);
};

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value),
  {status, headers: {'content-type': 'application/json', ...headers}});
const TOKEN = {access_token: 'ya29.token', expires_in: 3600, scope: YOUTUBE_READONLY_SCOPES.join(' '), token_type: 'Bearer'};
const channelsBody = (patch = {}) => ({items: [{
  id: patch.id || CHANNEL,
  snippet: {title: patch.title || 'ALVI Spa', customUrl: patch.customUrl === undefined ? '@alvispa' : patch.customUrl},
  statistics: {viewCount: '12345', ...(patch.hidden ? {hiddenSubscriberCount: true} : {subscriberCount: '1230'}), videoCount: '17'},
}]});
const params = (url) => new URL(url).searchParams;
function ok({url}) {
  if (url === TOKEN_URL) return json(TOKEN);
  if (url.startsWith(CHANNELS_URL)) return json(params(url).has('forHandle') ? {items: [{id: CHANNEL}]} : channelsBody());
  return json({}, 404);
}
// Свойства, которые Response не даёт задать конструктором (redirected/type), задаются на экземпляре.
const patched = (response, values) => {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(response, key, {value});
  return response;
};
async function waitFor(check) {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'ожидаемое состояние не наступило');
}

function fixture(t, {handler = ok, timeoutMs = 150} = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let clock = Date.parse('2026-09-30T18:00:00Z');
  const calls = [];
  const credentials = createSocialAnalyticsCredentials(db, {apiKey: 'server-key', now: () => clock});
  const f = {db, credentials, calls, handler};
  const fetchImpl = async (url, init = {}) => {
    calls.push({url: String(url), method: init.method || 'GET', redirect: init.redirect,
      authorization: init.headers?.authorization || '', body: String(init.body || '')});
    return f.handler({url: String(url), init, f});
  };
  f.access = createSocialYoutubeAccess(db, {credentials, fetchImpl, now: () => clock, timeoutMs});
  f.saved = () => f.access.saveAccess('alvi', {revision: f.access.get('alvi').revision, credential: SECRET},
    {userId: 1, userName: 'Владелец'});
  f.advance = (ms) => { clock += ms; };
  f.channelCalls = () => calls.filter((call) => call.url.startsWith(CHANNELS_URL)).map((call) => params(call.url));
  return f;
}

test('доступ хранится отдельно от публикаций и наружу не возвращается', (t) => {
  const f = fixture(t);
  const state = f.saved();
  assert.equal(state.configured, true);
  assert.equal(state.provider, YOUTUBE_ANALYTICS_PROVIDER);
  assert.equal(state.channelConfirmed, false, 'сохранённый доступ сам по себе канал не подтверждает');
  assertNoSecrets(state);
  assert.equal(f.credentials.get('alvi', 'onlypult_analytics').configured, false);
  const row = f.db.prepare("SELECT encrypted_credential FROM social_analytics_credentials WHERE company_code='alvi'").get();
  assert.equal(row.encrypted_credential.includes('refresh-token-value'), false);
  assert.equal(state.scopes.every((scope) => /readonly$/.test(scope)), true);
  assert.equal(f.calls.length, 0);
});

test('непригодный доступ отклоняется до шифрования', (t) => {
  const f = fixture(t);
  for (const credential of ['не json', JSON.stringify({clientId: 'a', clientSecret: 'b'}),
    JSON.stringify({clientId: 'a', clientSecret: 'b', refreshToken: 'c', apiKey: 'x'})]) {
    assert.throws(() => f.access.saveAccess('alvi', {revision: f.access.get('alvi').revision, credential}),
      (error) => error.code === 'CREDENTIAL_UNREADABLE');
  }
  assert.equal(f.access.get('alvi').configured, false);
  assert.deepEqual(f.calls, []);
});

test('перенаправление token endpoint не исполняется: один запрос, без секретов и Location', async (t) => {
  const f = fixture(t, {handler: ({url}) => (url === TOKEN_URL
    ? new Response(null, {status: 307, headers: {location: 'https://evil.example/steal'}}) : ok({url}))});
  f.saved();
  await assert.rejects(() => f.access.verify('alvi', {accountRef: CHANNEL}), (error) => {
    assert.equal(error.code, 'UPSTREAM_REDIRECT');
    assertNoSecrets({message: error.message, code: error.code});
    return true;
  });
  assert.equal(f.calls.length, 1, 'ровно один запрос');
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].redirect, 'error', 'fetch запрещено следовать перенаправлению');
  const state = f.access.get('alvi');
  assert.equal(state.status, 'unchecked', 'перенаправление — не отзыв доступа');
  assertNoSecrets(state);
});

test('перенаправление API: 3xx, redirected и opaqueredirect отклоняются даже от поддельного fetch', async (t) => {
  for (const make of [
    () => new Response(null, {status: 302, headers: {location: 'https://evil.example/x'}}),
    () => patched(json(channelsBody()), {redirected: true}),
    () => patched(new Response(null, {status: 200}), {type: 'opaqueredirect'}),
    () => patched(json(channelsBody()), {url: 'https://evil.example/youtube/v3/channels'}),
  ]) {
    const f = fixture(t, {handler: ({url}) => (url.startsWith(CHANNELS_URL) ? make() : ok({url}))});
    f.saved();
    await assert.rejects(() => f.access.verify('alvi', {accountRef: CHANNEL}), (error) => {
      assert.equal(error.code, 'UPSTREAM_REDIRECT');
      assertNoSecrets(error.message);
      return true;
    });
    assert.deepEqual(f.calls.map((call) => call.redirect), ['error', 'error']);
    assert.equal(f.channelCalls().length, 1, 'запрос по другому адресу не повторялся');
    assert.equal(f.access.get('alvi').channelConfirmed, false);
  }
});

test('адреса и параметры фиксированы: чужой хост, учётные данные в URL и второй фильтр отклоняются без сети', async (t) => {
  const f = fixture(t);
  for (const url of ['https://evil.example/youtube/v3/channels', 'https://user:pass@www.googleapis.com/youtube/v3/channels',
    `${CHANNELS_URL}?key=x`, `${CHANNELS_URL}/`, 'http://www.googleapis.com/youtube/v3/channels']) {
    await assert.rejects(() => f.access.callApi(url, 'ya29.token', {part: 'id', mine: 'true'}), {code: 'BAD_ENDPOINT'});
  }
  await assert.rejects(() => f.access.callApi(CHANNELS_URL, 'ya29.token', {part: 'id', mine: 'true', forHandle: '@x'}), {code: 'BAD_REQUEST'});
  await assert.rejects(() => f.access.callApi(CHANNELS_URL, 'ya29.token', {part: 'id'}), {code: 'BAD_REQUEST'});
  await assert.rejects(() => f.access.callApi(REPORTS_URL, 'ya29.token', {ids: `channel==${CHANNEL}`, access_token: 'x'}), {code: 'BAD_REQUEST'});
  await assert.rejects(() => f.access.callApi(REPORTS_URL, 'bad token\r\nx: y', {ids: `channel==${CHANNEL}`}), {code: 'BAD_REQUEST'});
  assert.equal(f.calls.length, 0);
});

test('предел тела в байтах: бесконечный поток, объявленная длина и ответ без потока', async (t) => {
  let pulls = 0;
  const endless = () => new Response(new ReadableStream({pull(controller) {
    pulls += 1; controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
  }}), {status: 200});
  const f = fixture(t, {handler: ({url}) => (url.startsWith(CHANNELS_URL) ? endless() : ok({url}))});
  f.saved();
  await assert.rejects(() => f.access.verify('alvi', {accountRef: CHANNEL}), {code: 'RESPONSE_TOO_LARGE'});
  assert.ok(pulls * 64 * 1024 <= YOUTUBE_MAX_RESPONSE_BYTES + 4 * 64 * 1024, `прочитано кусков: ${pulls}`);
  assert.equal(f.access.get('alvi').status, 'unchecked', 'слишком большой ответ — не отзыв');

  let readerTaken = false;
  const declared = fixture(t, {handler: ({url}) => (url.startsWith(CHANNELS_URL)
    ? {status: 200, ok: true, headers: new Headers({'content-length': String(1024 * 1024)}),
      body: {getReader: () => { readerTaken = true; return {read: async () => ({done: true}), cancel: async () => {}}; }}}
    : ok({url}))});
  declared.saved();
  await assert.rejects(() => declared.access.verify('alvi', {accountRef: CHANNEL}), {code: 'RESPONSE_TOO_LARGE'});
  assert.equal(readerTaken, false, 'объявленная длина отклонена до чтения');

  let textCalls = 0;
  const legacy = fixture(t, {handler: ({url}) => (url.startsWith(CHANNELS_URL)
    ? {status: 200, ok: true, headers: new Headers(), body: null,
      text: async () => { textCalls += 1; return 'x'.repeat(10 * 1024 * 1024); }}
    : ok({url}))});
  legacy.saved();
  await assert.rejects(() => legacy.access.verify('alvi', {accountRef: CHANNEL}), {code: 'RESPONSE_UNCERTAIN'});
  assert.equal(textCalls, 0, 'response.text() без предела не вызывается');
});

test('зависшие fetch, поток и cancel, игнорирующие отмену, не держат вызов дольше срока', async (t) => {
  let cancelled = 0;
  const variants = {
    stream: () => new Response(new ReadableStream({pull: () => new Promise(() => {}), cancel: () => { cancelled += 1; }}), {status: 200}),
    deaf: () => ({status: 200, ok: true, headers: new Headers(),
      body: {getReader: () => ({read: () => new Promise(() => {}), cancel: () => new Promise(() => {})})}}),
    fetch: () => new Promise(() => {}),
  };
  for (const [name, make] of Object.entries(variants)) {
    const f = fixture(t, {timeoutMs: 150, handler: ({url}) => (url.startsWith(CHANNELS_URL) ? make() : ok({url}))});
    f.saved();
    const started = Date.now();
    await assert.rejects(() => f.access.verify('alvi', {accountRef: CHANNEL}), (error) => {
      assert.equal(error.code, 'TIMEOUT', name);
      return true;
    });
    assert.ok(Date.now() - started < 2000, `${name}: срок наступил`);
    assert.equal(f.access.get('alvi').status, 'unchecked', `${name}: таймаут — не отзыв`);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1, 'зависший поток отменён');
});

test('stop и внешний сигнал прерывают ожидание, новые запросы не начинаются', async (t) => {
  const hanging = ({url}) => (url.startsWith(CHANNELS_URL) ? new Promise(() => {}) : ok({url}));
  const f = fixture(t, {timeoutMs: 10000, handler: hanging});
  f.saved();
  const pending = f.access.verify('alvi', {accountRef: CHANNEL});
  await waitFor(() => f.channelCalls().length === 1);
  const started = Date.now();
  f.access.stop();
  await assert.rejects(pending, {code: 'STOPPED'});
  assert.ok(Date.now() - started < 1000);
  const before = f.calls.length;
  await assert.rejects(() => f.access.accessToken('alvi'), {code: 'STOPPED'});
  assert.equal(f.calls.length, before, 'после stop сеть не вызывается');

  const g = fixture(t, {timeoutMs: 10000, handler: hanging});
  g.saved();
  const controller = new AbortController();
  const aborted = g.access.verify('alvi', {accountRef: CHANNEL, signal: controller.signal});
  await waitFor(() => g.channelCalls().length === 1);
  controller.abort();
  await assert.rejects(aborted, {code: 'STOPPED'});
  assert.equal(g.access.get('alvi').status, 'unchecked');
});

test('области доступа: пустые, широкие или неполные права не допускают запросов к API', async (t) => {
  for (const [scope, code] of [['', 'SCOPE_UNCONFIRMED'], [undefined, 'SCOPE_UNCONFIRMED'],
    [[...YOUTUBE_READONLY_SCOPES, 'https://www.googleapis.com/auth/youtube'].join(' '), 'SCOPE_MISMATCH'],
    [YOUTUBE_READONLY_SCOPES[0], 'SCOPE_MISMATCH']]) {
    const token = {access_token: 'ya29.token', expires_in: 3600, ...(scope === undefined ? {} : {scope})};
    const f = fixture(t, {handler: ({url}) => (url === TOKEN_URL ? json(token) : ok({url}))});
    f.saved();
    await assert.rejects(() => f.access.verify('alvi', {accountRef: CHANNEL}), {code});
    assert.deepEqual(f.calls.map((call) => call.url), [TOKEN_URL], 'к API не обращались');
    const state = f.access.get('alvi');
    assert.equal(state.channelConfirmed, false);
    assert.equal(state.status, code === 'SCOPE_MISMATCH' ? 'error' : 'unchecked');
  }
});

test('пустая или непригодная запись канала не подтверждает «любой mine канал» и в сеть не ходит', async (t) => {
  for (const [accountRef, code] of [['', 'CHANNEL_REF_REQUIRED'], ['   ', 'CHANNEL_REF_REQUIRED'],
    ['ALVI Spa', 'CHANNEL_REF_INVALID'], [`https://evil.example/channel/${CHANNEL}`, 'CHANNEL_REF_INVALID'],
    [`http://www.youtube.com/channel/${CHANNEL}`, 'CHANNEL_REF_INVALID'], ['@x', 'CHANNEL_REF_INVALID']]) {
    const f = fixture(t);
    f.saved();
    await assert.rejects(() => f.access.verify('alvi', {accountRef}), {code});
    assert.equal(f.calls.length, 0, `${accountRef}: сеть не вызывалась`);
    const state = f.access.get('alvi');
    assert.equal(state.channelConfirmed, false);
    assert.equal(state.statusCode, code);
  }
});

test('UC-идентификатор и официальная ссылка канала подтверждаются по нативному ID одним запросом mine', async (t) => {
  for (const accountRef of [CHANNEL, `https://www.youtube.com/channel/${CHANNEL}`, `https://m.youtube.com/channel/${CHANNEL}/`]) {
    const f = fixture(t);
    f.saved();
    const state = await f.access.verify('alvi', {accountRef, actor: {userId: 1, userName: 'Владелец'}});
    assert.equal(state.channelConfirmed, true);
    assert.equal(state.channelId, CHANNEL);
    assert.equal(state.channelAccountRef, CHANNEL);
    assert.equal(state.checked, true);
    const calls = f.channelCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].get('mine'), 'true');
    assert.equal(calls[0].has('forHandle'), false);
    const api = f.calls.find((call) => call.url.startsWith(CHANNELS_URL));
    assert.equal(api.authorization, 'Bearer ya29.token');
    assertNoSecrets(api.url);
  }
  const g = fixture(t, {handler: ({url}) => (url.startsWith(CHANNELS_URL) ? json(channelsBody({id: OTHER_CHANNEL})) : ok({url}))});
  g.saved();
  await assert.rejects(() => g.access.verify('alvi', {accountRef: CHANNEL}), {code: 'CHANNEL_MISMATCH'});
  assert.equal(g.access.get('alvi').statusCode, 'CHANNEL_MISMATCH');
  assert.equal(g.access.ready('alvi').ok, false);
});

test('@ручка: forHandle и mine — отдельные запросы, сравнение только нативных UC ID, customUrl не используется', async (t) => {
  const f = fixture(t, {handler: ({url}) => (url.startsWith(CHANNELS_URL) && params(url).has('mine')
    ? json(channelsBody({customUrl: '@совсем-другая'})) : ok({url}))});
  f.saved();
  const state = await f.access.verify('alvi', {accountRef: '@AlviSpa'});
  assert.equal(state.channelConfirmed, true);
  assert.equal(state.channelAccountRef, '@alvispa');
  const [first, second] = f.channelCalls();
  assert.equal(first.get('forHandle'), '@AlviSpa');
  assert.equal(first.has('mine'), false, 'фильтры не смешиваются');
  assert.equal(second.get('mine'), 'true');
  assert.equal(second.has('forHandle'), false);
  assert.equal(youtubeChannelRef('https://www.youtube.com/@AlviSpa').key, '@alvispa');

  // Ручка указывает на другой канал, а доступ — на свой: это не подтверждение.
  const other = fixture(t, {handler: ({url}) => (url.startsWith(CHANNELS_URL) && params(url).has('forHandle')
    ? json({items: [{id: OTHER_CHANNEL}]}) : ok({url}))});
  other.saved();
  await assert.rejects(() => other.access.verify('alvi', {accountRef: '@AlviSpa'}), {code: 'CHANNEL_MISMATCH'});
  assert.equal(other.access.get('alvi').channelConfirmed, false);

  // Совпадение названия/customUrl без совпадения ID ничего не подтверждает.
  const lookalike = fixture(t, {handler: ({url}) => (url.startsWith(CHANNELS_URL) && params(url).has('mine')
    ? json(channelsBody({id: OTHER_CHANNEL, title: 'AlviSpa', customUrl: '@alvispa'})) : ok({url}))});
  lookalike.saved();
  await assert.rejects(() => lookalike.access.verify('alvi', {accountRef: '@AlviSpa'}), {code: 'CHANNEL_MISMATCH'});

  const unresolved = fixture(t, {handler: ({url}) => (url.startsWith(CHANNELS_URL) && params(url).has('forHandle')
    ? json({items: []}) : ok({url}))});
  unresolved.saved();
  await assert.rejects(() => unresolved.access.verify('alvi', {accountRef: '@AlviSpa'}), {code: 'CHANNEL_HANDLE_UNRESOLVED'});
  assert.equal(unresolved.channelCalls().length, 1, 'mine без разрешённой ручки не запрашивается');
  assert.equal(unresolved.access.get('alvi').statusCode, 'CHANNEL_HANDLE_UNRESOLVED');

  const many = fixture(t, {handler: ({url}) => (url.startsWith(CHANNELS_URL) && params(url).has('mine')
    ? json({items: [channelsBody().items[0], channelsBody({id: OTHER_CHANNEL}).items[0]]}) : ok({url}))});
  many.saved();
  await assert.rejects(() => many.access.verify('alvi', {accountRef: CHANNEL}), {code: 'CHANNEL_AMBIGUOUS'});
});

test('смена доступа или записи канала во время проверки не подтверждает ни старый, ни новый доступ', async (t) => {
  const f = fixture(t, {handler: ({url, f: self}) => {
    if (url.startsWith(CHANNELS_URL)) self.access.saveAccess('alvi', {revision: self.access.get('alvi').revision, credential: SECRET});
    return ok({url});
  }});
  f.saved();
  await assert.rejects(() => f.access.verify('alvi', {accountRef: CHANNEL}), {code: 'REVISION_CONFLICT'});
  const state = f.access.get('alvi');
  assert.equal(state.channelConfirmed, false);
  assert.equal(state.status, 'unchecked', 'новый доступ остаётся непроверенным, а не «подключённым»');

  const g = fixture(t);
  g.saved();
  await assert.rejects(() => g.access.verify('alvi', {accountRef: CHANNEL, accountRefNow: () => OTHER_CHANNEL}),
    {code: 'REVISION_CONFLICT'});
  assert.equal(g.access.get('alvi').channelConfirmed, false);
});

test('отзыв снимает подтверждение этой ревизии, квота — нет; тексты Google наружу не уходят', async (t) => {
  let mode = 'ok';
  const f = fixture(t, {handler: ({url}) => {
    if (mode === 'revoked' && url === TOKEN_URL)
      return json({error: 'invalid_grant', error_description: 'Token has been expired or revoked.'}, 400);
    if (mode === 'quota' && url.startsWith(CHANNELS_URL))
      return json({error: {code: 403, message: 'quota text', errors: [{reason: 'quotaExceeded', domain: 'youtube.quota', message: 'daily limit'}]}}, 403);
    return ok({url});
  }});
  f.saved();
  await f.access.verify('alvi', {accountRef: CHANNEL});
  mode = 'quota';
  await assert.rejects(() => f.access.verify('alvi', {accountRef: CHANNEL}), (error) => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(/quota text|daily limit|youtube\.quota/.test(error.message), false);
    return true;
  });
  assert.equal(f.access.get('alvi').channelConfirmed, true, 'квота не равна отзыву');
  mode = 'revoked';
  f.advance(2 * 3600 * 1000);
  await assert.rejects(() => f.access.verify('alvi', {accountRef: CHANNEL}), (error) => {
    assert.equal(error.code, 'ACCESS_DENIED');
    assertNoSecrets(error.message);
    assert.equal(/expired or revoked/.test(error.message), false);
    return true;
  });
  const state = f.access.get('alvi');
  assert.equal(state.status, 'error');
  assert.equal(state.statusCode, 'ACCESS_DENIED');
  assert.equal(state.channelConfirmed, false);
  assert.match(state.channelReason, /ACCESS_DENIED/);
});

test('отметка отказа сбора: CAS по ревизии и только постоянные причины', async (t) => {
  const f = fixture(t);
  f.saved();
  await f.access.verify('alvi', {accountRef: CHANNEL});
  const old = f.access.get('alvi').revision;
  f.access.saveAccess('alvi', {revision: old, credential: SECRET});
  const stale = f.access.markCollectFailure('alvi', old, 'ACCESS_DENIED');
  assert.equal(stale.applied, false);
  assert.equal(f.access.get('alvi').status, 'unchecked', 'новый доступ не испорчен');
  await f.access.verify('alvi', {accountRef: CHANNEL});
  const current = f.access.get('alvi').revision;
  assert.equal(f.access.markCollectFailure('alvi', current, 'RATE_LIMITED').applied, false);
  assert.equal(f.access.markCollectFailure('alvi', current, 'TIMEOUT').applied, false);
  assert.equal(f.access.get('alvi').channelConfirmed, true);
  const revoked = f.access.markCollectFailure('alvi', current, 'ACCESS_DENIED');
  assert.equal(revoked.applied, true);
  assert.equal(revoked.channelConfirmed, false);
  assert.equal(f.access.ready('alvi').ok, false);
});

test('обновление токена под одним замком и переиспользуется до истечения', async (t) => {
  let tokens = 0;
  const f = fixture(t, {handler: async ({url}) => {
    if (url === TOKEN_URL) { tokens += 1; await new Promise((resolve) => setImmediate(resolve)); return json({...TOKEN, access_token: `ya29.n${tokens}`}); }
    return ok({url});
  }});
  f.saved();
  await Promise.all([f.access.accessToken('alvi'), f.access.accessToken('alvi'), f.access.accessToken('alvi')]);
  assert.equal(tokens, 1);
  await f.access.accessToken('alvi');
  assert.equal(tokens, 1);
  f.advance(3600 * 1000);
  await f.access.accessToken('alvi');
  assert.equal(tokens, 2);
  f.access.saveAccess('alvi', {revision: f.access.get('alvi').revision, credential: SECRET});
  await f.access.accessToken('alvi');
  assert.equal(tokens, 3, 'после смены доступа прежний токен не переиспользуется');
});

test('удаление доступа и другая компания: подтверждение не переносится', async (t) => {
  const f = fixture(t);
  f.saved();
  await f.access.verify('alvi', {accountRef: CHANNEL});
  assert.equal(f.access.get('avokado').configured, false);
  assert.equal(f.access.bindingFingerprint('avokado'), null);
  assert.ok(f.access.bindingFingerprint('alvi').includes(`:${CHANNEL}:`));
  const after = f.access.removeAccess('alvi', {revision: f.access.get('alvi').revision});
  assert.equal(after.configured, false);
  assert.equal(after.channelConfirmed, false);
});
