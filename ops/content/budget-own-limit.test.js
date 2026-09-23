'use strict';
/* Личный лимит провайдера из кабинета: проверяется на настоящих модулях бюджета и резерва. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createHughBudget } = require('./hugh-budget');
const { createHughFallback } = require('./hugh-fallback');

const PRICE = { HUGH_FALLBACK_DEEPSEEK_USD_PER_1K_PROMPT: '0.0003',
  HUGH_FALLBACK_DEEPSEEK_USD_PER_1K_COMPLETION: '0.0012' };
const budgetOf = (over = {}) => createHughBudget({ db: new DatabaseSync(':memory:'),
  env: { HUGH_FALLBACK_BUDGET_USD: '10', ...PRICE, ...over } });
const MICRO = 1000000;

test('без личного лимита провайдер работает как раньше', () => {
  const budget = budgetOf();
  const booking = budget.reserve('deepseek', { promptBytes: 1000 });
  assert.equal(booking.allowed, true);
  assert.equal(budget.providerState('deepseek', null).limitUsd, null);
});

test('личный лимит не даёт забронировать сверх себя', () => {
  const budget = budgetOf();
  // Бронь берёт верхнюю оценку: 1000 байт запроса и потолок ответа 1200 токенов.
  const first = budget.reserve('deepseek', { promptBytes: 1000, limitMicroUsd: 3000 });
  assert.equal(first.allowed, true);
  const second = budget.reserve('deepseek', { promptBytes: 1000, limitMicroUsd: 3000 });
  assert.equal(second.allowed, false);
  assert.equal(second.ownLimitReached, true);
  assert.match(second.reason, /личный лимит/);
});

test('исчерпанный личный лимит одного провайдера не трогает другого', () => {
  const budget = budgetOf({ HUGH_FALLBACK_ZAI_USD_PER_1K_PROMPT: '0.0003',
    HUGH_FALLBACK_ZAI_USD_PER_1K_COMPLETION: '0.0012' });
  budget.reserve('deepseek', { promptBytes: 1000, limitMicroUsd: 3000 });
  assert.equal(budget.reserve('deepseek', { promptBytes: 1000, limitMicroUsd: 3000 }).allowed, false);
  assert.equal(budget.reserve('zai', { promptBytes: 1000, limitMicroUsd: 3000 }).allowed, true);
});

test('личный лимит без объявленной цены не пропускает провайдера', () => {
  const budget = createHughBudget({ db: new DatabaseSync(':memory:'), env: {} });
  const booking = budget.reserve('unknown-provider', { promptBytes: 100, limitMicroUsd: 5 * MICRO });
  assert.equal(booking.allowed, false);
  assert.equal(booking.unpriced, true);
});

test('общая граница по-прежнему главнее и останавливает всех', () => {
  const budget = budgetOf({ HUGH_FALLBACK_BUDGET_USD: '0.000001' });
  assert.equal(budget.reserve('deepseek', { promptBytes: 1000, limitMicroUsd: 9 * MICRO }).allowed, false);
});

test('расход провайдера виден отдельно от общего', () => {
  const budget = budgetOf();
  budget.reserve('deepseek', { promptBytes: 1000 });
  const own = budget.providerState('deepseek', 5 * MICRO);
  assert.ok(own.spentUsd > 0);
  assert.equal(own.limitUsd, 5);
  assert.equal(own.stopped, false);
});

const fallbackOf = (budgetMicroUsd) => createHughFallback({
  db: new DatabaseSync(':memory:'),
  env: { HUGH_FALLBACK_BUDGET_USD: '10', ...PRICE },
  fetchImpl: async () => { throw Error('сеть не нужна'); },
  providerStore: { available: true, runtimeProviders: () => [{ name: 'deepseek',
    url: 'https://api.deepseek.com', secret: 'x', model: 'm', timeoutMs: 1000,
    pricePromptMicroUsdPer1k: 300, priceCompletionMicroUsdPer1k: 1200,
    maxOutputTokens: 1200, budgetMicroUsd }] },
});

test('кабинет видит расход и личный лимит провайдера', () => {
  const status = fallbackOf(5 * MICRO).status();
  const provider = status.providers[0];
  assert.equal(provider.ownLimitUsd, 5);
  assert.equal(provider.spentUsd, 0);
  assert.equal(provider.ownLimitReached, false);
});

test('провайдер с исчерпанным личным лимитом выбывает из доступных', () => {
  const fallback = fallbackOf(1);
  assert.equal(fallback.available().length, 1, 'при нулевом расходе провайдер доступен');
  fallback.budget.reserve('deepseek', { promptBytes: 1000 });
  assert.equal(fallback.available().length, 0, 'после расхода сверх лимита провайдер выбывает');
  assert.equal(fallback.status().providers[0].ownLimitReached, true);
});

test('лимит не задан — провайдер из доступных не выбывает', () => {
  const fallback = fallbackOf(null);
  fallback.budget.reserve('deepseek', { promptBytes: 1000 });
  assert.equal(fallback.available().length, 1);
});
