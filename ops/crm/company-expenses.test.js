'use strict';

/* Расходы по компании и ROMI (spec 111). Компании, суммы и даты синтетические. */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

async function startServer(context, databasePath) {
  const apiKey = randomBytes(24).toString('hex');
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, API_KEY: apiKey, DATABASE_PATH: databasePath, PORT: String(port), RATE_LIMIT_MAX: '10000' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  };
  context.after(stop);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/companies`, { headers: { 'X-API-Key': apiKey } });
      break;
    } catch {
      if (child.exitCode !== null || attempt > 200) throw new Error(stderr || 'server did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const request = async (method, pathname, body, authenticated = true) => {
    const headers = authenticated ? { 'X-API-Key': apiKey } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, stop };
}

test('старая база: бэкап до миграции, прежние расходы остаются общими', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crm-expenses-migrate-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'crm.sqlite');
  const first = await startServer(context, databasePath);
  await first.stop();
  assert.equal((await readdir(directory)).filter((name) => name.includes('before-expenses-company')).length, 0,
    'пустая таблица расходов не требует снимка');
  // Возвращаем базу к схеме до миграции 11: без колонки и с одним общим расходом.
  const db = new DatabaseSync(databasePath);
  db.exec('DROP INDEX IF EXISTS expenses_company_spent_idx');
  db.exec('ALTER TABLE expenses DROP COLUMN company_code');
  db.exec('DELETE FROM schema_migrations WHERE version = 11');
  db.prepare('INSERT INTO expenses (created_at, spent_at, source, amount, comment) VALUES (?, ?, ?, ?, ?)')
    .run('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'yandex', 700, 'старый общий');
  db.close();

  const second = await startServer(context, databasePath);
  const backups = (await readdir(directory)).filter((name) => name.includes('before-expenses-company-v11'));
  assert.equal(backups.length, 1, 'перед миграцией создан один снимок');
  const copy = new DatabaseSync(path.join(directory, backups[0]), { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM expenses').get().count, 1);
  assert.ok(!copy.prepare('PRAGMA table_info(expenses)').all().some((column) => column.name === 'company_code'));
  copy.close();

  const all = await second.request('GET', '/expenses');
  assert.equal(all.body.expenses.length, 1);
  assert.equal(all.body.expenses[0].companyCode, null, 'старый расход не приписан компании');
  await second.request('POST', '/companies', { code: 'expense_a', name: 'Expense A' });
  const scoped = await second.request('GET', '/expenses?companyCode=expense_a');
  assert.deepEqual(scoped.body.expenses, [], 'общий расход не попадает в компанию');
  assert.equal(scoped.body.expensesScope, 'company');
  await second.stop();

  // Повторный запуск не делает второй снимок и не повторяет миграцию.
  const third = await startServer(context, databasePath);
  await third.stop();
  assert.equal((await readdir(directory)).filter((name) => name.includes('before-expenses-company')).length, 1);
});

test('расходы компании дают ROMI по источнику и не смешиваются с другими компаниями', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crm-expenses-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { request } = await startServer(context, path.join(directory, 'crm.sqlite'));
  const today = new Date().toISOString().slice(0, 10);
  for (const code of ['expense_a', 'expense_b', 'expense_c']) {
    assert.equal((await request('POST', '/companies', { code, name: code })).status, 201);
  }
  const added = await request('POST', '/expenses?companyCode=expense_a', {
    date: today, source: ' Yandex-Direct ', amount: 1000, comment: 'ручной ввод',
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.companyCode, 'expense_a');
  assert.equal(added.body.source, 'yandex-direct');
  assert.equal((await request('POST', '/expenses', {
    date: today, source: 'yandex-direct', amount: 500, companyCode: 'EXPENSE_B',
  })).body.companyCode, 'expense_b');
  assert.equal((await request('POST', '/expenses', { date: today, source: 'yandex-direct', amount: 300 }))
    .body.companyCode, null, 'без компании расход общий, как раньше');
  const mismatch = await request('POST', '/expenses?companyCode=expense_a', {
    date: today, source: 'vk', amount: 1, companyCode: 'expense_b',
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.details.code, 'COMPANY_MISMATCH');
  const unknown = await request('POST', '/expenses?companyCode=missing_co', { date: today, source: 'vk', amount: 1 });
  assert.ok([400, 404].includes(unknown.status), 'расход неизвестной компании не записывается');

  const lead = await request('POST', '/leads', {
    name: 'Synthetic Lead', contact: '+70000000011', companyCode: 'expense_a', utmSource: 'yandex-direct',
  }, false);
  assert.equal(lead.status, 201);
  assert.equal((await request('PATCH', `/leads/${lead.body.id}/sale`, { amount: 3000 })).status, 200);

  const dashboard = await request('GET', `/dashboard?companyCode=expense_a&from=${today}&to=${today}`);
  assert.equal(dashboard.body.expensesScope, 'company');
  assert.equal(dashboard.body.summary.expenses, 1000, 'чужие и общие расходы не учтены');
  assert.equal(dashboard.body.summary.revenue, 3000);
  assert.equal(dashboard.body.summary.romi, 200);
  const direct = dashboard.body.sourceStats.find((row) => row.source === 'yandex-direct');
  assert.equal(direct.expenses, 1000);
  assert.equal(direct.romi, 200);
  assert.ok(dashboard.body.sources.includes('yandex-direct'));

  const summary = await request('GET', `/summary?companyCode=expense_a&from=${today}&to=${today}`);
  assert.equal(summary.body.expenses, 1000);
  assert.equal(summary.body.romi, 200);
  assert.equal(summary.body.expensesScope, 'company');

  const empty = await request('GET', `/dashboard?companyCode=expense_c&from=${today}&to=${today}`);
  assert.equal(empty.body.summary.expenses, null, 'расходы не внесены — не ноль');
  assert.equal(empty.body.summary.romi, null);
  const emptySummary = await request('GET', `/summary?companyCode=expense_c&from=${today}&to=${today}`);
  assert.equal(emptySummary.body.expenses, null);
  assert.equal(emptySummary.body.romi, null);

  const global = await request('GET', `/dashboard?from=${today}&to=${today}`);
  assert.equal(global.body.expensesScope, 'all');
  assert.equal(global.body.summary.expenses, 1800, 'без компании видны все расходы, как раньше');

  const listed = await request('GET', `/expenses?companyCode=expense_a&from=${today}&to=${today}`);
  assert.deepEqual(listed.body.expenses.map((row) => [row.companyCode, row.amount]), [['expense_a', 1000]]);
  assert.equal((await request('GET', '/expenses')).body.expenses.length, 3);
});
