'use strict';
/* Расходы на ИИ в существующих Финансах: расчёты, дубли, валюты, нулевая и неизвестная
   стоимость, разделение подписки и API, оплата клиента.
   Выдуманных настоящих платежей здесь нет: все записи синтетические и техничные. */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createCommercial} = require('./commercial');
const {createFinanceAi} = require('./finance-ai');

const fail = (status, message, details) => {
  throw Object.assign(new Error(message), {status, details});
};
const ACTOR = {userName: 'Владелец'};

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,is_deleted INTEGER DEFAULT 0);
    CREATE TABLE deal_orders(id INTEGER PRIMARY KEY,owner_scope TEXT NOT NULL);
    INSERT INTO companies(id,code,name) VALUES(1,'alvi','ALVI'),(2,'avokado','Авокадо');`);
  return {db, api: createCommercial({db, fail}), ai: createFinanceAi({fail})};
}
const base = (patch = {}) => ({type: 'expense', state: 'actual', date: '2026-09-19', amount: 900,
  category: 'ИИ', counterparty: '', note: '', dealId: null, ...patch});
const apiSpend = (patch = {}) => ({service: 'openrouter', accountLabel: 'рабочий аккаунт',
  client: 'codex-cli', modelId: 'vendor/model-1', mode: 'api', movement: 'consumption',
  costKnown: true, costBasis: 'invoice', sourceCurrency: 'USD', sourceAmount: 10,
  rate: {value: 90, at: '2026-09-19', source: 'Курс банка на дату счёта'},
  usage: {input: 1000, output: 500}, confirmation: 'Счёт провайдера от 19.09.2026', ...patch});

test('блок ИИ сохраняется в тех же Финансах и попадает в сводку периода', (t) => {
  const f = fixture(t);
  const saved = f.api.saveEntry(null, 'alvi', {...base(), requestId: 'ai-entry-1', ai: apiSpend()}, ACTOR);
  assert.equal(saved.ai.service, 'openrouter');
  assert.equal(saved.ai.modelId, 'vendor/model-1');
  assert.equal(saved.ai.client, 'codex-cli', 'клиент и модель — разные поля');
  const report = f.api.finance('alvi', '2026-09-01', '2026-09-30');
  assert.equal(report.total, 1);
  assert.equal(report.totals.expense, 900, 'обычная сводка Финансов не изменилась');
  assert.equal(report.ai.actual.consumption, 900);
  assert.equal(report.ai.actual.spend, 900);
  assert.equal(report.ai.planned.spend, 0, 'план и факт не смешаны');
  assert.deepEqual(report.ai.currencies, {USD: {actual: 10, planned: 0}}, 'исходная валюта сохранена');
  assert.equal(report.ai.actual.invoiced, 900);
  assert.equal(report.ai.actual.estimated, 0);
  // Второй компании ничего не видно: журнал остался по компании.
  assert.equal(f.api.finance('avokado', '2026-09-01', '2026-09-30').ai.entries, 0);
});

test('пополнение баланса и потребление не складываются в один расход', (t) => {
  const f = fixture(t);
  f.api.saveEntry(null, 'alvi', {...base({amount: 9000}), requestId: 'ai-topup-1',
    ai: apiSpend({movement: 'topup', sourceAmount: 100, usage: null,
      confirmation: 'Чек пополнения баланса'})}, ACTOR);
  f.api.saveEntry(null, 'alvi', {...base({amount: 900}), requestId: 'ai-use-1', ai: apiSpend()}, ACTOR);
  const report = f.api.finance('alvi', '2026-09-01', '2026-09-30');
  assert.equal(report.ai.topups.actual, 9000);
  assert.equal(report.ai.actual.consumption, 900);
  assert.equal(report.ai.actual.spend, 900, 'пополнение в наш расход на ИИ не входит');
  assert.match(report.ai.basis, /Пополнение баланса — движение денег/);
  assert.throws(() => f.api.saveEntry(null, 'alvi', {...base(), requestId: 'ai-topup-2',
    ai: apiSpend({movement: 'topup', usage: {input: 10}})}, ACTOR),
  (error) => /не описывает потребление токенов/.test(error.message));
});

test('неизвестная стоимость не равна нулю и не проводится как фактический расход', (t) => {
  const f = fixture(t);
  assert.throws(() => f.api.saveEntry(null, 'alvi', {...base({state: 'actual'}), requestId: 'ai-unknown-1',
    ai: apiSpend({costKnown: false, costBasis: null, sourceAmount: null, confirmation: ''})}, ACTOR),
  (error) => /Неизвестную стоимость нельзя провести как фактическую/.test(error.message));
  const planned = f.api.saveEntry(null, 'alvi', {...base({state: 'planned'}), requestId: 'ai-unknown-2',
    ai: apiSpend({costKnown: false, costBasis: 'estimate', sourceAmount: null, confirmation: ''})}, ACTOR);
  assert.equal(planned.ai.costKnown, false);
  assert.equal(planned.ai.sourceAmount, null, 'неизвестная сумма осталась неизвестной, а не нулём');
  const report = f.api.finance('alvi', '2026-09-01', '2026-09-30');
  assert.equal(report.ai.unknown.count, 1);
  assert.equal(report.ai.actual.spend, 0, 'оценка не попала в фактически потрачено');
  assert.equal(report.ai.planned.estimated, 900, 'оценка отделена от счёта провайдера');
  assert.equal(report.ai.unknown.withoutAmount, 0, 'это оценка с суммой, а не пустая неизвестность');
});

test('неподтверждённая стоимость записывается нулём и не маскируется заглушкой', (t) => {
  const f = fixture(t);
  const unknown = (patch = {}) => apiSpend({costKnown: false, costBasis: null, sourceAmount: null,
    confirmation: '', rate: null, ...patch});
  // Положительная сумма без основания — это и есть заглушка: она не принимается.
  assert.throws(() => f.api.saveEntry(null, 'alvi', {...base({state: 'planned', amount: 900}),
    requestId: 'ai-zero-1', ai: unknown()}, ACTOR),
  (error) => /записывается нулевой суммой/.test(error.message));
  const saved = f.api.saveEntry(null, 'alvi', {...base({state: 'planned', amount: 0}),
    requestId: 'ai-zero-2', ai: unknown()}, ACTOR);
  assert.equal(saved.amount, 0);
  assert.equal(saved.ai.costBasis, null);
  const report = f.api.finance('alvi', '2026-09-01', '2026-09-30');
  assert.deepEqual([report.ai.unknown.count, report.ai.unknown.withoutAmount], [1, 1]);
  assert.equal(report.ai.actual.spend, 0);
  assert.equal(report.ai.planned.spend, 0, 'неизвестность не превратилась в сумму');
  assert.match(report.ai.basis, /без суммы и не подменяется заглушкой/);
  // Обычные операции по-прежнему требуют положительной суммы.
  assert.throws(() => f.api.saveEntry(null, 'alvi', {...base({amount: 0}), requestId: 'plain-zero'}, ACTOR),
    (error) => /положительную сумму/.test(error.message));
});

test('план и факт считаются раздельно и не складываются', (t) => {
  const f = fixture(t);
  f.api.saveEntry(null, 'alvi', {...base({amount: 300, state: 'actual'}), requestId: 'ai-fact-1',
    ai: apiSpend({sourceAmount: 3})}, ACTOR);
  f.api.saveEntry(null, 'alvi', {...base({amount: 700, state: 'planned'}), requestId: 'ai-plan-1',
    ai: apiSpend({sourceAmount: 7})}, ACTOR);
  const report = f.api.finance('alvi', '2026-09-01', '2026-09-30');
  assert.equal(report.ai.actual.spend, 300, 'фактически потрачено — только факт');
  assert.equal(report.ai.planned.spend, 700);
  assert.equal(report.ai.entries, 2);
  assert.deepEqual(report.ai.currencies.USD, {actual: 3, planned: 7});
  assert.match(report.ai.basis, /Фактически потрачено — только actual\.spend/);
});

test('расчётная оценка отличается от счёта провайдера', (t) => {
  const f = fixture(t);
  f.api.saveEntry(null, 'alvi', {...base({amount: 100}), requestId: 'ai-estimate-1',
    ai: apiSpend({costBasis: 'estimate', sourceAmount: 1.11,
      tariff: {input: 0.5, output: 1.5, currency: 'USD', at: '2026-09-19', source: 'Прайс провайдера'},
      confirmation: ''})}, ACTOR);
  f.api.saveEntry(null, 'alvi', {...base({amount: 120}), requestId: 'ai-invoice-1',
    ai: apiSpend({sourceAmount: 1.33})}, ACTOR);
  const report = f.api.finance('alvi', '2026-09-01', '2026-09-30');
  assert.equal(report.ai.actual.estimated, 100);
  assert.equal(report.ai.actual.invoiced, 120);
  assert.equal(report.ai.actual.spend, 220);
  assert.equal(report.ai.currencies.USD.actual, 2.44);
});

test('валюта источника требует явного курса с датой и источником', (t) => {
  const f = fixture(t);
  assert.throws(() => f.api.saveEntry(null, 'alvi', {...base(), requestId: 'ai-currency-1',
    ai: apiSpend({rate: null})}, ACTOR), (error) => /укажите курс/.test(error.message));
  // Рубли курса не требуют.
  const rubles = f.api.saveEntry(null, 'alvi', {...base(), requestId: 'ai-currency-2',
    ai: apiSpend({sourceCurrency: 'RUB', sourceAmount: 900, rate: null})}, ACTOR);
  assert.equal(rubles.ai.rate, null);
  assert.equal(rubles.ai.sourceCurrency, 'RUB');
  for (const bad of ['доллары', 'US', 'usd1']) {
    assert.throws(() => f.api.saveEntry(null, 'alvi', {...base(), requestId: `ai-currency-${bad}`,
      ai: apiSpend({sourceCurrency: bad})}, ACTOR), (error) => error.status === 400, bad);
  }
  // Строчные буквы приводятся к верхнему регистру, а не отвергаются.
  assert.equal(f.api.saveEntry(null, 'alvi', {...base(), requestId: 'ai-currency-4',
    ai: apiSpend({sourceCurrency: 'usd'})}, ACTOR).ai.sourceCurrency, 'USD');
});

test('подписка описывается периодом и не заводится дважды за тот же период', (t) => {
  const f = fixture(t);
  const subscription = {service: 'vendor-subscription', accountLabel: 'основной аккаунт',
    client: 'cli-client', modelId: null, mode: 'subscription', costKnown: true, costBasis: 'invoice',
    sourceCurrency: 'USD', sourceAmount: 20, rate: {value: 90, at: '2026-09-01', source: 'Курс банка'},
    periodFrom: '2026-09-01', periodTo: '2026-09-30', confirmation: 'Счёт подписки'};
  const key = f.api.aiRequestId(subscription);
  assert.match(key, /^ai-vendor-subscription/);
  const first = f.api.saveEntry(null, 'alvi', {...base({amount: 1800}), requestId: key, ai: subscription}, ACTOR);
  // Повтор по тому же ключу возвращает ту же операцию: подписка не записывается заново.
  const again = f.api.saveEntry(null, 'alvi', {...base({amount: 1800}), requestId: key, ai: subscription}, ACTOR);
  assert.equal(again.id, first.id);
  assert.equal(f.api.finance('alvi', '2026-09-01', '2026-09-30').total, 1);
  assert.equal(first.ai.modelId, null, 'модель подписки не выводится из названия клиента');
  assert.equal(first.ai.movement, null);
  // Другой период — другой ключ и другая операция.
  const next = {...subscription, periodFrom: '2026-10-01', periodTo: '2026-10-31'};
  assert.notEqual(f.api.aiRequestId(next), key);
  assert.throws(() => f.api.saveEntry(null, 'alvi', {...base(), requestId: 'ai-sub-bad',
    ai: {...subscription, periodTo: '2026-08-01'}}, ACTOR), (error) => /раньше начала/.test(error.message));
});

test('идемпотентность импорта по провайдеру, аккаунту и номеру запроса', (t) => {
  const f = fixture(t);
  const usage = {...apiSpend(), providerRequestId: 'req-000123'};
  const key = f.api.aiRequestId(usage);
  const first = f.api.saveEntry(null, 'alvi', {...base(), requestId: key, ai: apiSpend()}, ACTOR);
  const again = f.api.saveEntry(null, 'alvi', {...base(), requestId: key, ai: apiSpend()}, ACTOR);
  assert.equal(again.id, first.id, 'повторный импорт не создаёт вторую запись');
  assert.equal(f.api.finance('alvi', '2026-09-01', '2026-09-30').total, 1);
  assert.notEqual(f.api.aiRequestId({...usage, providerRequestId: 'req-000124'}), key);
  // Ключ одной компании не занимает номер в другой: журналы разделены по компании.
  const other = f.api.saveEntry(null, 'avokado', {...base(), requestId: key, ai: apiSpend()}, ACTOR);
  assert.notEqual(other.id, first.id);
});

test('оплата клиента не становится нашим расходом', (t) => {
  const f = fixture(t);
  // Заявленная клиентом сумма не подтверждена нашим счётом, поэтому она не «фактическая».
  f.api.saveEntry(null, 'alvi', {...base({amount: 2500, state: 'planned'}), requestId: 'onlypult-declared-1',
    ai: {service: 'onlypult', accountLabel: 'аккаунт компании', client: null, modelId: null,
      mode: 'subscription', paidBy: 'client', costKnown: false, costBasis: 'estimate',
      sourceCurrency: 'RUB', sourceAmount: null, periodFrom: '2026-09-01', periodTo: '2026-09-30',
      confirmation: 'Заявлено клиентом, нашего счёта нет'}}, ACTOR);
  const report = f.api.finance('alvi', '2026-09-01', '2026-09-30');
  assert.equal(report.ai.clientPaid.planned, 2500);
  assert.equal(report.ai.actual.spend, 0, 'оплата клиента в наш расход не входит');
  assert.equal(report.ai.unknown.count, 1, 'наша стоимость не подтверждена');
  assert.throws(() => f.api.saveEntry(null, 'alvi', {...base({state: 'planned'}), requestId: 'onlypult-bad-1',
    ai: {service: 'onlypult', accountLabel: 'аккаунт', mode: 'subscription', paidBy: 'client',
      costKnown: false, sourceCurrency: 'RUB', periodFrom: '2026-09-01', periodTo: '2026-09-30',
      confirmation: ''}}, ACTOR), (error) => /чем она подтверждена/.test(error.message));
});

test('секреты и лишние поля в блок ИИ не проходят', (t) => {
  const f = fixture(t);
  for (const patch of [
    {accountLabel: 'sk-0123456789abcdef'},
    {confirmation: 'Bearer abcdef'},
    {modelId: 'op_0123456789abcdef'},
    {mode: 'unknown'},
    {movement: 'unknown'},
    {usage: {input: -1}},
    {usage: {unknownKey: 1}},
    {costKnown: 'да'},
  ]) {
    assert.throws(() => f.api.saveEntry(null, 'alvi', {...base(), requestId: `ai-bad-${Math.random()}`,
      ai: apiSpend(patch)}, ACTOR), (error) => error.status === 400, JSON.stringify(patch));
  }
  assert.throws(() => f.api.saveEntry(null, 'alvi', {...base(), requestId: 'ai-bad-extra',
    ai: {...apiSpend(), unexpected: 'x'}}, ACTOR), (error) => /Неизвестные поля/.test(error.message));
  // Доход с блоком ИИ не принимается: расход на ИИ записывается расходом.
  assert.throws(() => f.api.saveEntry(null, 'alvi', {...base({type: 'income'}), requestId: 'ai-bad-income',
    ai: apiSpend()}, ACTOR), (error) => /записывается расходом/.test(error.message));
});

test('операции без блока ИИ работают как прежде', (t) => {
  const f = fixture(t);
  const plain = f.api.saveEntry(null, 'alvi', {...base({category: 'Аренда'}), requestId: 'plain-1'}, ACTOR);
  assert.equal(plain.ai, undefined);
  const report = f.api.finance('alvi', '2026-09-01', '2026-09-30');
  assert.equal(report.totals.expense, 900);
  assert.equal(report.ai.entries, 0);
  assert.equal(report.ai.actual.spend, 0);
});

test('отменённая операция из сводки по ИИ исключается', (t) => {
  const f = fixture(t);
  const saved = f.api.saveEntry(null, 'alvi', {...base(), requestId: 'ai-void-1', ai: apiSpend()}, ACTOR);
  assert.equal(f.api.finance('alvi', '2026-09-01', '2026-09-30').ai.actual.spend, 900);
  f.api.saveEntry(saved.id, 'alvi', {...base({state: 'void'}), version: saved.version, ai: apiSpend()}, ACTOR);
  const report = f.api.finance('alvi', '2026-09-01', '2026-09-30');
  assert.equal(report.ai.actual.spend, 0);
  assert.equal(report.ai.entries, 0);
});
