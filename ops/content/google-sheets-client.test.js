'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createGoogleSheetsClient, extractSpreadsheetId, signJwt, parseCredentials, GoogleSheetsError} = require('./google-sheets-client');

const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
const privatePem = privateKey.export({type: 'pkcs8', format: 'pem'});
const EMAIL = 'sync-test@example-project.iam.gserviceaccount.com';
const credentials = JSON.stringify({type: 'service_account', client_email: EMAIL, private_key: privatePem});
const fromB64url = (part) => Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const json = (status, body) => ({ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body)});

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({url, init});
    if (url === 'https://oauth2.googleapis.com/token') return json(200, {access_token: 'tok-' + calls.filter((c) => c.url === url).length, expires_in: 3600});
    return handler(url, init);
  };
  return {calls, fetchImpl, tokenCalls: () => calls.filter((c) => c.url === 'https://oauth2.googleapis.com/token').length};
}

test('extractSpreadsheetId: берёт id из ссылки и отклоняет чужие адреса', () => {
  assert.equal(extractSpreadsheetId('https://docs.google.com/spreadsheets/d/TEST_ID-1_x/edit#gid=0'), 'TEST_ID-1_x');
  assert.equal(extractSpreadsheetId('https://docs.google.com/spreadsheets/d/TEST_ID'), 'TEST_ID');
  for (const bad of ['', null, 'not a url', 'http://docs.google.com/spreadsheets/d/X/edit', 'https://evil.example/spreadsheets/d/X',
    'https://user:pw@docs.google.com/spreadsheets/d/X', 'https://docs.google.com:8443/spreadsheets/d/X', 'https://docs.google.com/document/d/X']) {
    assert.equal(extractSpreadsheetId(bad), null, String(bad));
  }
});

test('JWT RS256: подпись проверяется публичным ключом тестовой пары, claims корректны', () => {
  const nowMs = Date.UTC(2026, 10, 7, 12, 0, 0);
  const jwt = signJwt(parseCredentials(credentials).credentials, nowMs);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(fromB64url(h)), {alg: 'RS256', typ: 'JWT'});
  const claims = JSON.parse(fromB64url(c));
  assert.equal(claims.iss, EMAIL);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.iat, nowMs / 1000);
  assert.equal(claims.exp, nowMs / 1000 + 3600);
  assert.match(claims.scope, /auth\/spreadsheets/);
  assert.match(claims.scope, /drive\.metadata\.readonly/);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(h + '.' + c), publicKey, fromB64url(s)), 'подпись валидна');
  const other = crypto.generateKeyPairSync('rsa', {modulusLength: 2048}).publicKey;
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(h + '.' + c), other, fromB64url(s)), false, 'чужой ключ не подходит');
});

test('без ключа: состояние «не подключено» и понятная ошибка без сетевых запросов', async () => {
  const stub = stubFetch(() => json(200, {}));
  for (const raw of [undefined, '', '{not json', JSON.stringify({client_email: EMAIL}), JSON.stringify({client_email: EMAIL, private_key: 'garbage'})]) {
    const client = createGoogleSheetsClient({credentials: raw, fetchImpl: stub.fetchImpl});
    const status = client.status();
    assert.equal(status.connected, false);
    assert.ok(status.reason);
    await assert.rejects(client.getModifiedTime('TEST_ID'), (error) => error instanceof GoogleSheetsError && error.code === 'NOT_CONNECTED' && /не подключены/.test(error.message));
  }
  assert.equal(stub.calls.length, 0);
  const ok = createGoogleSheetsClient({credentials, fetchImpl: stub.fetchImpl});
  assert.deepEqual(ok.status(), {connected: true, serviceAccountEmail: EMAIL});
});

test('кеш токена: один обмен до истечения, новый — после, параллельные запросы делят один обмен', async () => {
  let nowMs = 1_000_000;
  const stub = stubFetch((url) => json(200, {modifiedTime: '2026-11-07T00:00:00Z'}));
  const client = createGoogleSheetsClient({credentials, fetchImpl: stub.fetchImpl, now: () => nowMs});
  await Promise.all([client.getModifiedTime('TEST_ID'), client.getModifiedTime('TEST_ID'), client.getModifiedTime('TEST_ID')]);
  assert.equal(stub.tokenCalls(), 1);
  nowMs += 50 * 60_000;
  await client.getModifiedTime('TEST_ID');
  assert.equal(stub.tokenCalls(), 1, 'в пределах срока');
  nowMs += 10 * 60_000; // осталось меньше минуты запаса
  await client.getModifiedTime('TEST_ID');
  assert.equal(stub.tokenCalls(), 2, 'обновлён перед истечением');
  const tokenCall = stub.calls.find((c) => c.url === 'https://oauth2.googleapis.com/token');
  const form = new URLSearchParams(tokenCall.init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(form.get('assertion').split('.').length, 3);
});

test('getModifiedTime/getValues/batchUpdateValues: правильные адреса Drive v3 и Sheets v4', async () => {
  const stub = stubFetch((url, init) => {
    if (url.includes('/drive/v3/files/')) return json(200, {modifiedTime: 'T1'});
    if (url.includes(':batchUpdate')) return json(200, {totalUpdatedRows: 1});
    return json(200, {values: [['a', 'b']]});
  });
  const client = createGoogleSheetsClient({credentials, fetchImpl: stub.fetchImpl});
  assert.equal(await client.getModifiedTime('TEST_ID'), 'T1');
  assert.deepEqual(await client.getValues('TEST_ID', "'Synapse · план'!A1:H"), [['a', 'b']]);
  await client.batchUpdateValues('TEST_ID', [{range: "'Synapse · план'!A2:H2", values: [['x']]}]);
  const urls = stub.calls.filter((c) => !c.url.includes('oauth2')).map((c) => c.url);
  assert.equal(urls[0], 'https://www.googleapis.com/drive/v3/files/TEST_ID?fields=modifiedTime&supportsAllDrives=true');
  assert.ok(urls[1].startsWith('https://sheets.googleapis.com/v4/spreadsheets/TEST_ID/values/' + encodeURIComponent("'Synapse · план'!A1:H")));
  assert.equal(urls[2], 'https://sheets.googleapis.com/v4/spreadsheets/TEST_ID/values:batchUpdate');
  const body = JSON.parse(stub.calls.at(-1).init.body);
  assert.equal(body.valueInputOption, 'RAW');
  assert.equal(stub.calls.at(-1).init.headers.authorization, 'Bearer tok-1');
  await client.batchUpdateValues('TEST_ID', []);
  assert.equal(stub.calls.length, 4, 'пустая пачка не отправляется');
  await assert.rejects(client.getValues('../x', 'A1'), {code: 'BAD_ID'});
});

test('ensureSheet: создаёт лист только если его нет', async () => {
  const titles = ['Лист1'];
  const stub = stubFetch((url, init) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      titles.push(body.requests[0].addSheet.properties.title);
      return json(200, {replies: [{addSheet: {properties: {sheetId: 77, title: titles.at(-1)}}}]});
    }
    return json(200, {sheets: titles.map((title, i) => ({properties: {sheetId: i, title}}))});
  });
  const client = createGoogleSheetsClient({credentials, fetchImpl: stub.fetchImpl});
  assert.deepEqual(await client.ensureSheet('TEST_ID', 'Synapse · план'), {sheetId: 77, created: true});
  assert.deepEqual(await client.ensureSheet('TEST_ID', 'Synapse · план'), {sheetId: 1, created: false});
  assert.deepEqual(titles, ['Лист1', 'Synapse · план']);
  assert.equal(stub.calls.filter((c) => c.init.method === 'POST' && c.url.includes(':batchUpdate')).length, 1);
});

test('ошибки транспорта: 429/5xx/сеть повторяемы, 403/404 — нет, 401 сбрасывает токен', async () => {
  const queue = [503, 429, 'network', 403, 404, 401];
  const stub = stubFetch(async () => {
    const next = queue.shift();
    if (next === 'network') throw new Error('ECONNRESET');
    if (next) return json(next, {error: {message: 'fail ' + next}});
    return json(200, {modifiedTime: 'T'});
  });
  const client = createGoogleSheetsClient({credentials, fetchImpl: stub.fetchImpl});
  const expected = [[503, true], [429, true], ['NETWORK', true], ['FORBIDDEN', false], ['NOT_FOUND', false], ['UNAUTHORIZED', false]];
  for (const [mark, retryable] of expected) {
    await assert.rejects(client.getModifiedTime('TEST_ID'), (error) => error.retryable === retryable && (error.status === mark || error.code === mark));
  }
  assert.equal(await client.getModifiedTime('TEST_ID'), 'T');
  assert.equal(stub.tokenCalls(), 2, 'после 401 токен получен заново');
});
