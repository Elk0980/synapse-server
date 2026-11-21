'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createGoogleSheetsClient} = require('./google-sheets-client');
const {createGoogleSheetsSync, SHEET_TITLE, HEADER} = require('./google-sheets-sync');

// Заглушка Google API для тестов google-sheets-*: токен, Drive files.get, Sheets values/batchGet/batchUpdate/addSheet.
const crypto = require('node:crypto');

function keyPair() {
  const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  return {
    privatePem: privateKey.export({type: 'pkcs8', format: 'pem'}),
    publicKey,
    credentials(email = 'sync-test@example-project.iam.gserviceaccount.com') {
      return JSON.stringify({type: 'service_account', client_email: email, private_key: this.privatePem});
    },
  };
}

function colIndex(letter) { return letter.charCodeAt(0) - 65; }

function parseRange(range) {
  const match = /^'((?:[^']|'')+)'!([A-Z])(\d*)(?::([A-Z])(\d*))?$/.exec(range);
  if (!match) throw new Error('bad range ' + range);
  return {title: match[1].replace(/''/g, "'"), c1: colIndex(match[2]), r1: match[3] ? Number(match[3]) : 1,
    c2: match[4] ? colIndex(match[4]) : colIndex(match[2]), r2: match[5] ? Number(match[5]) : Infinity};
}

function fakeGoogle({spreadsheetId = 'TEST_SHEET_ID', sheets = {'Лист1': [['ручная', 'запись']]}} = {}) {
  const state = {sheets: JSON.parse(JSON.stringify(sheets)), modifiedTime: 1, calls: [], tokenCalls: 0, failNext: [], writes: []};
  const touch = () => { state.modifiedTime++; };
  const reply = (status, body) => ({ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body)});

  function read(range) {
    const r = parseRange(range);
    const grid = state.sheets[r.title];
    if (!grid) throw Object.assign(new Error('no sheet'), {status: 400});
    const out = [];
    for (let row = r.r1; row <= Math.min(r.r2, grid.length); row++) {
      const src = grid[row - 1] || [];
      const values = src.slice(r.c1, r.c2 + 1).map((v) => v ?? '');
      while (values.length && values[values.length - 1] === '') values.pop();
      out.push(values);
    }
    while (out.length && !out[out.length - 1].length) out.pop();
    return out;
  }

  function write(range, values) {
    const r = parseRange(range);
    const grid = state.sheets[r.title];
    values.forEach((rowValues, i) => {
      const rowIndex = r.r1 - 1 + i;
      while (grid.length <= rowIndex) grid.push([]);
      rowValues.forEach((value, j) => { grid[rowIndex][r.c1 + j] = value; });
    });
  }

  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET';
    state.calls.push({method, url});
    if (state.failNext.length) {
      const failure = state.failNext.shift();
      if (failure === 'network') throw new Error('ECONNRESET');
      return reply(failure, {error: {message: 'fake failure ' + failure}});
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      state.tokenCalls++;
      state.lastAssertion = new URLSearchParams(init.body).get('assertion');
      return reply(200, {access_token: 'token-' + state.tokenCalls, expires_in: 3600, token_type: 'Bearer'});
    }
    if (!/^Bearer token-\d+$/.test(init.headers && init.headers.authorization || '')) return reply(401, {error: {message: 'no auth'}});
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    if (u.hostname === 'www.googleapis.com' && path === '/drive/v3/files/' + spreadsheetId) {
      return reply(200, {modifiedTime: '2026-11-07T00:00:' + String(state.modifiedTime).padStart(2, '0') + 'Z'});
    }
    const base = '/v4/spreadsheets/' + spreadsheetId;
    if (u.hostname !== 'sheets.googleapis.com' || !path.startsWith(base)) return reply(404, {error: {message: 'not found'}});
    const rest = path.slice(base.length);
    if (rest === '' && method === 'GET') {
      return reply(200, {sheets: Object.keys(state.sheets).map((title, i) => ({properties: {sheetId: i, title}}))});
    }
    if (rest === ':batchUpdate' && method === 'POST') {
      const body = JSON.parse(init.body);
      const replies = body.requests.map((request) => {
        const title = request.addSheet.properties.title;
        if (state.sheets[title]) throw new Error('duplicate sheet');
        state.sheets[title] = [];
        touch();
        return {addSheet: {properties: {sheetId: Object.keys(state.sheets).length - 1, title}}};
      });
      return reply(200, {replies});
    }
    if (rest === '/values:batchGet') {
      return reply(200, {valueRanges: u.searchParams.getAll('ranges').map((range) => ({range, values: read(range)}))});
    }
    if (rest === '/values:batchUpdate' && method === 'POST') {
      const body = JSON.parse(init.body);
      state.writes.push(body.data);
      body.data.forEach((item) => write(item.range, item.values));
      touch();
      return reply(200, {totalUpdatedRows: body.data.length});
    }
    if (rest.startsWith('/values/')) {
      return reply(200, {values: read(rest.slice('/values/'.length))});
    }
    return reply(404, {error: {message: 'unknown ' + rest}});
  }

  return {state, fetchImpl, spreadsheetId, url: 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit#gid=0',
    teamEdit(title, row, col, value) { const grid = state.sheets[title]; grid[row - 1] = grid[row - 1] || []; grid[row - 1][col] = value; touch(); }};
}


const KEYS = keyPair();
const SAMPLE_PLAN = () => [
  {ideaId: 'idea-a', date: '2026-11-10', topic: 'SAMPLE тема A', format: 'Рилс', platforms: ['Instagram', 'VK'], status: 'draft', comments: ''},
  {ideaId: 'idea-b', date: '2026-11-11', topic: 'SAMPLE тема B', format: 'Пост', platforms: ['Telegram'], status: 'approved', comments: 'ок'},
  {ideaId: 'idea-c', date: '2026-11-12', topic: 'SAMPLE тема C', format: 'Сторис', platforms: [], status: 'draft', comments: ''},
];

function setup({credentials = KEYS.credentials(), plan = SAMPLE_PLAN(), startMs = Date.UTC(2026, 10, 7, 5, 0, 0), ...options} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsheets-sync-'));
  const db = new DatabaseSync(path.join(dir, 'test.sqlite'));
  const google = fakeGoogle();
  const ctx = {nowMs: startMs, plan, proposals: [], google, db, dir, sheetUrl: google.url};
  const client = createGoogleSheetsClient({credentials, fetchImpl: google.fetchImpl, now: () => ctx.nowMs});
  ctx.sync = createGoogleSheetsSync({
    db, client, now: () => ctx.nowMs,
    getPlan: async (code) => { assert.equal(code, 'demo'); return {items: JSON.parse(JSON.stringify(ctx.plan))}; },
    getSheetUrl: async () => ctx.sheetUrl,
    onProposal: async (proposal) => { if (ctx.failProposal) throw new Error('proposal store down'); ctx.proposals.push(proposal); },
    ...options,
  });
  ctx.sheet = () => google.state.sheets[SHEET_TITLE];
  ctx.writtenRanges = () => google.state.writes.flat().map((item) => item.range);
  ctx.close = () => { db.close(); fs.rmSync(dir, {recursive: true, force: true}); };
  return ctx;
}

test('первая выгрузка: создаёт служебный лист, заголовок и строки; ручной лист не тронут', async (t) => {
  const ctx = setup(); t.after(ctx.close);
  ctx.sync.enqueue('demo');
  const result = await ctx.sync.tick();
  assert.equal(result.pushed[0].written, 3);
  assert.deepEqual(ctx.sheet()[0], HEADER);
  assert.deepEqual(ctx.sheet()[1], ['idea-a', '1', '2026-11-10', 'SAMPLE тема A', 'Рилс', 'Instagram, VK', 'draft', '']);
  assert.equal(ctx.sheet()[3][0], 'idea-c');
  assert.deepEqual(ctx.google.state.sheets['Лист1'], [['ручная', 'запись']]);
  assert.ok(ctx.writtenRanges().every((range) => range.startsWith("'" + SHEET_TITLE + "'!")));
  assert.equal(ctx.sync.status('demo').queued, false);
});

test('дифф: пишется только изменённая строка, без изменений — ни одной записи', async (t) => {
  const ctx = setup(); t.after(ctx.close);
  ctx.sync.enqueue('demo'); await ctx.sync.processQueue();
  ctx.google.state.writes.length = 0;
  ctx.sync.enqueue('demo');
  const same = await ctx.sync.processQueue();
  assert.equal(same[0].written, 0);
  assert.equal(ctx.google.state.writes.length, 0, 'пустая пачка не отправлена');
  ctx.plan[1].topic = 'SAMPLE тема B (новая)';
  ctx.plan.push({ideaId: 'idea-d', date: '2026-11-13', topic: 'SAMPLE D', format: 'Пост', platforms: 'VK', status: 'draft'});
  ctx.sync.enqueue('demo');
  const changed = await ctx.sync.processQueue();
  assert.equal(changed[0].written, 2);
  assert.deepEqual(ctx.writtenRanges(), ["'" + SHEET_TITLE + "'!A3:H3", "'" + SHEET_TITLE + "'!A5:H5"]);
  assert.equal(ctx.sheet()[2][3], 'SAMPLE тема B (новая)');
  assert.equal(ctx.sheet()[4][0], 'idea-d');
});

test('удалённая в ЛК идея очищается, строка добавленная командой вручную остаётся', async (t) => {
  const ctx = setup(); t.after(ctx.close);
  ctx.sync.enqueue('demo'); await ctx.sync.processQueue();
  ctx.google.teamEdit(SHEET_TITLE, 6, 0, 'manual-row');
  ctx.plan = ctx.plan.filter((item) => item.ideaId !== 'idea-b');
  ctx.sync.enqueue('demo');
  const [result] = await ctx.sync.processQueue();
  assert.equal(result.cleared, 1);
  assert.deepEqual(ctx.sheet()[2], ['', '', '', '', '', '', '', '']);
  assert.equal(ctx.sheet()[5][0], 'manual-row');
});

test('Таблица → ЛК: статус и комментарий команды приходят предложением, эталон не переписан', async (t) => {
  const ctx = setup(); t.after(ctx.close);
  ctx.sync.enqueue('demo'); await ctx.sync.processQueue();
  const before = JSON.stringify(ctx.plan);
  ctx.google.teamEdit(SHEET_TITLE, 2, 6, 'approved');
  ctx.google.teamEdit(SHEET_TITLE, 3, 7, 'ок, но заменить музыку');
  const result = await ctx.sync.importCompany('demo');
  assert.equal(result.proposals, 2);
  assert.deepEqual(ctx.proposals.map(({companyCode, ideaId, field, value, source, conflict}) => ({companyCode, ideaId, field, value, source, conflict})), [
    {companyCode: 'demo', ideaId: 'idea-a', field: 'status', value: 'approved', source: 'google-sheet', conflict: false},
    {companyCode: 'demo', ideaId: 'idea-b', field: 'comment', value: 'ок, но заменить музыку', source: 'google-sheet', conflict: false},
  ]);
  assert.equal(JSON.stringify(ctx.plan), before, 'план ЛК не изменён');
  const calls = ctx.google.state.calls.length;
  assert.deepEqual(await ctx.sync.importCompany('demo'), {companyCode: 'demo', unchanged: true, proposals: 0});
  assert.equal(ctx.google.state.calls.length - calls, 1, 'при прежнем modifiedTime — только запрос Drive');
  ctx.google.teamEdit('Лист1', 5, 0, 'другая правка');
  assert.equal((await ctx.sync.importCompany('demo')).proposals, 0, 'повторно то же предложение не отправляется');
  const read = ctx.google.state.calls.filter((c) => c.url.includes('values:batchGet')).at(-1).url;
  assert.match(decodeURIComponent(read), /A2:A/);
  assert.match(decodeURIComponent(read), /G2:H/);
  // Неизменённая в ЛК строка не перетирает правку команды до решения
  ctx.sync.enqueue('demo'); await ctx.sync.processQueue();
  assert.equal(ctx.sheet()[1][6], 'approved');
});

test('конфликт: ЛК побеждает, правка листа уходит предложением с conflict=true', async (t) => {
  const ctx = setup(); t.after(ctx.close);
  ctx.sync.enqueue('demo'); await ctx.sync.processQueue();
  ctx.google.teamEdit(SHEET_TITLE, 2, 6, 'published');
  ctx.plan[0].status = 'review';
  ctx.sync.enqueue('demo');
  const [result] = await ctx.sync.processQueue();
  assert.equal(result.proposals, 1);
  assert.deepEqual({...ctx.proposals[0]}, {companyCode: 'demo', ideaId: 'idea-a', field: 'status', value: 'published', source: 'google-sheet', lkValue: 'review', conflict: true});
  assert.equal(ctx.sheet()[1][6], 'review', 'в листе значение ЛК');
  await ctx.sync.importCompany('demo');
  assert.equal(ctx.proposals.length, 1, 'наша запись не порождает предложений');
});

test('ошибка onProposal: предложение не теряется и придёт при следующем импорте', async (t) => {
  const ctx = setup(); t.after(ctx.close);
  ctx.sync.enqueue('demo'); await ctx.sync.processQueue();
  ctx.google.teamEdit(SHEET_TITLE, 4, 7, 'нужна правка');
  ctx.failProposal = true;
  await assert.rejects(ctx.sync.importCompany('demo'), /proposal store down/);
  ctx.failProposal = false;
  assert.equal((await ctx.sync.importCompany('demo')).proposals, 1);
  assert.equal(ctx.proposals[0].value, 'нужна правка');
});

test('без ключа: «не подключено», очередь сохраняется, сети нет', async (t) => {
  const ctx = setup({credentials: ''}); t.after(ctx.close);
  ctx.sync.enqueue('demo');
  const result = await ctx.sync.tick();
  assert.equal(result.connected, false);
  assert.match(result.reason, /GOOGLE_SHEETS_SA_JSON/);
  assert.equal(ctx.google.state.calls.length, 0);
  const status = ctx.sync.status('demo');
  assert.equal(status.connected, false);
  assert.equal(status.queued, true);
  const failed = await ctx.sync.processQueue();
  assert.equal(failed[0].error, 'NOT_CONNECTED');
  assert.equal(ctx.sync.status('demo').queued, true, 'задача осталась в очереди');
  assert.equal(ctx.google.state.calls.length, 0);
});

test('ретраи: экспоненциальная задержка, очередь не теряется, затем успешная выгрузка', async (t) => {
  const ctx = setup({retryBaseMs: 1000, retryMaxMs: 8000}); t.after(ctx.close);
  ctx.sync.enqueue('demo');
  const delays = [];
  for (let i = 0; i < 5; i++) {
    ctx.google.state.failNext.push(i % 2 ? 'network' : 503);
    const [result] = await ctx.sync.processQueue();
    assert.equal(result.companyCode, 'demo');
    assert.ok(result.error);
    delays.push(result.retryInMs);
    assert.equal(ctx.sync.status('demo').queued, true);
    assert.ok(ctx.sync.status('demo').lastError);
    assert.deepEqual(await ctx.sync.processQueue(), [], 'до срока повтор не запускается');
    ctx.nowMs += result.retryInMs;
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000]);
  const [ok] = await ctx.sync.processQueue();
  assert.equal(ok.written, 3);
  assert.equal(ctx.sync.status('demo').queued, false);
});

test('ночная полная сверка: раз в сутки уплотняет лист и возвращает значения ЛК', async (t) => {
  const ctx = setup(); t.after(ctx.close);
  ctx.sync.enqueue('demo'); await ctx.sync.processQueue();
  ctx.google.teamEdit(SHEET_TITLE, 3, 3, 'тему испортили');
  ctx.google.teamEdit(SHEET_TITLE, 3, 6, 'published');
  ctx.plan = ctx.plan.filter((item) => item.ideaId !== 'idea-a');
  ctx.nowMs = Date.UTC(2026, 10, 7, 20, 5, 0);
  const result = await ctx.sync.tick();
  assert.equal(result.nightly, 1);
  assert.equal(result.pushed[0].full, true);
  assert.equal(ctx.proposals.length, 1, 'правка статуса сохранена предложением до перезаписи');
  assert.deepEqual(ctx.sheet().slice(1, 4).map((row) => row[0]), ['idea-b', 'idea-c', '']);
  assert.equal(ctx.sheet()[1][3], 'SAMPLE тема B');
  assert.equal(ctx.sheet()[1][6], 'approved');
  ctx.nowMs += 30 * 60_000;
  assert.equal((await ctx.sync.tick()).nightly, 0, 'вторая сверка в ту же ночь не ставится');
});

test('tick: импорт не чаще раза в 5 минут; смена таблицы и пустая ссылка', async (t) => {
  const ctx = setup(); t.after(ctx.close);
  ctx.sync.enqueue('demo'); await ctx.sync.tick();
  const drive = () => ctx.google.state.calls.filter((c) => c.url.includes('/drive/v3/')).length;
  const first = drive();
  ctx.nowMs += 60_000; await ctx.sync.tick();
  assert.equal(drive(), first, 'через минуту не проверяет');
  ctx.nowMs += 5 * 60_000; await ctx.sync.tick();
  assert.equal(drive(), first + 1);
  ctx.sheetUrl = 'https://docs.google.com/spreadsheets/d/OTHER_ID/edit';
  ctx.sync.enqueue('demo');
  const [result] = await ctx.sync.processQueue();
  assert.equal(result.error, 'NOT_FOUND', 'другая таблица в заглушке не существует');
  ctx.sheetUrl = '';
  ctx.nowMs += 60 * 60_000;
  const [skipped] = await ctx.sync.processQueue();
  assert.equal(skipped.skipped, 'no_sheet');
});
