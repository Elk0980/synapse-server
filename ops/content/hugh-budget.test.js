'use strict';
/* Бюджетный стоп резервных провайдеров: резервирование до вызова, неизвестный расход,
   неверная конфигурация, параллельность, перезапуск и смена окна.
   Живых обращений нет: сеть подменена, ключи выдуманные и никуда не уходят. */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createHughBudget, readBudget, readPrice} = require('./hugh-budget');
const {createHughFallback} = require('./hugh-fallback');

const BASE = {
  HUGH_FALLBACK_PROVIDERS: 'primary,reserve',
  HUGH_FALLBACK_PRIMARY_URL: 'https://primary.test/v1',
  HUGH_FALLBACK_PRIMARY_KEY: 'test-key-primary',
  HUGH_FALLBACK_PRIMARY_MODEL: 'configured-primary-model',
  HUGH_FALLBACK_RESERVE_URL: 'https://reserve.test/v1',
  HUGH_FALLBACK_RESERVE_KEY: 'test-key-reserve',
  HUGH_FALLBACK_RESERVE_MODEL: 'configured-reserve-model',
};
// Цены обоих провайдеров, объявленные владельцем: 1 доллар за 1000 токенов.
const PRICED = {
  HUGH_FALLBACK_PRIMARY_USD_PER_1K_PROMPT: '1', HUGH_FALLBACK_PRIMARY_USD_PER_1K_COMPLETION: '1',
  HUGH_FALLBACK_RESERVE_USD_PER_1K_PROMPT: '1', HUGH_FALLBACK_RESERVE_USD_PER_1K_COMPLETION: '1',
};
const PAYLOAD = JSON.stringify({system: 'Системная подсказка', messages: [{role: 'user', content: 'Вопрос клиента'}]});
const ok = (text, usage) => ({ok: true, status: 200, headers: {get: () => null},
  json: async () => ({model: 'configured-primary-model', ...(usage ? {usage} : {}), choices: [{message: {content: text}}]})});
const fail = (status) => ({ok: false, status, headers: {get: () => null}, json: async () => ({})});

function fixture(env = {}) {
  const db = new DatabaseSync(':memory:');
  let time = Date.parse('2026-09-19T00:00:00Z');
  const calls = [];
  let responder = () => ok('Ответ провайдера', {prompt_tokens: 10, completion_tokens: 10});
  const fetchImpl = async (url, options) => { calls.push({url, body: JSON.parse(options.body)}); return responder(calls.length); };
  const fallback = createHughFallback({db, env: {...BASE, ...env}, fetchImpl, now: () => time});
  return {db, calls, fallback, env: {...BASE, ...env},
    setResponder: (value) => { responder = value; }, advance: (ms) => { time += ms; }, at: () => time};
}
const budgetOf = (f) => f.fallback.status().budget;

test('неверно заданная граница останавливает платный резерв, а не отключает границу', (t) => {
  const f = fixture({HUGH_FALLBACK_BUDGET_USD: 'сто долларов', ...PRICED});
  t.after(() => f.db.close());
  const status = budgetOf(f);
  assert.equal(status.blockedByConfig, true);
  assert.equal(status.stopped, true);
  assert.match(status.reason, /заданы неверно/);
  assert.equal(f.fallback.available().length, 0, 'ни один платный провайдер не предлагается');
  assert.ok(status.issues.some((issue) => /HUGH_FALLBACK_BUDGET_USD: значение не распознано/.test(issue)));
});

test('неверная цена провайдера тоже останавливает его, а не считается нулём', async (t) => {
  const f = fixture({HUGH_FALLBACK_BUDGET_USD: '100',
    HUGH_FALLBACK_PRIMARY_USD_PER_1K_PROMPT: 'дорого', HUGH_FALLBACK_PRIMARY_USD_PER_1K_COMPLETION: '1',
    HUGH_FALLBACK_RESERVE_USD_PER_1K_PROMPT: '1', HUGH_FALLBACK_RESERVE_USD_PER_1K_COMPLETION: '1'});
  t.after(() => f.db.close());
  const answer = await f.fallback.reply(PAYLOAD);
  assert.equal(answer.provider, 'reserve', 'запрос ушёл к провайдеру с корректной ценой');
  assert.equal(f.calls.length, 1, 'к провайдеру с неверной ценой обращения не было');
  assert.equal(f.calls[0].url, 'https://reserve.test/v1/chat/completions');
});

test('при денежной границе провайдер без объявленной цены не используется', async (t) => {
  const f = fixture({HUGH_FALLBACK_BUDGET_USD: '100'});
  t.after(() => f.db.close());
  await assert.rejects(f.fallback.reply(PAYLOAD),
    (error) => error.budgetStopped === true && /Цена провайдера/.test(error.message));
  assert.equal(f.calls.length, 0, 'ни одного платного обращения с неизвестной ценой');
});

test('заданный ноль — это цена ноль, а не отсутствующая цена', async (t) => {
  const f = fixture({HUGH_FALLBACK_BUDGET_USD: '1',
    HUGH_FALLBACK_PRIMARY_USD_PER_1K_PROMPT: '0', HUGH_FALLBACK_PRIMARY_USD_PER_1K_COMPLETION: '0',
    HUGH_FALLBACK_RESERVE_USD_PER_1K_PROMPT: '0', HUGH_FALLBACK_RESERVE_USD_PER_1K_COMPLETION: '0'});
  t.after(() => f.db.close());
  assert.deepEqual(readPrice('primary', f.env), {promptMicroUsdPer1k: 0, completionMicroUsdPer1k: 0});
  assert.equal(readPrice('primary', BASE), null, 'не заданная цена остаётся неизвестной');
  const answer = await f.fallback.reply(PAYLOAD);
  assert.equal(answer.text, 'Ответ провайдера');
  assert.equal(budgetOf(f).spentUsd, 0, 'объявленный ноль расходует ноль');
  assert.equal(budgetOf(f).stopped, false);
});

test('бронируется верхняя оценка до вызова, потолок ответа уходит провайдеру', async (t) => {
  const f = fixture({HUGH_FALLBACK_BUDGET_USD: '100', HUGH_FALLBACK_BUDGET_MAX_OUTPUT_TOKENS: '500', ...PRICED});
  t.after(() => f.db.close());
  let duringCall = null;
  f.setResponder(() => { duringCall = budgetOf(f); return ok('Ответ провайдера', {prompt_tokens: 10, completion_tokens: 10}); });
  await f.fallback.reply(PAYLOAD);
  assert.equal(f.calls[0].body.max_tokens, 500, 'провайдеру ушёл тот же потолок, под который бронировали');
  assert.ok(duringCall.heldUsd >= 0.5, `во время вызова занята верхняя оценка: ${duringCall.heldUsd}`);
  assert.equal(duringCall.requests, 1, 'слот занят до ответа');
  const after = budgetOf(f);
  assert.equal(after.heldUsd, 0, 'бронь уточнена фактом');
  assert.equal(after.spentUsd, 0.02, 'списано ровно по usage: 10+10 токенов по 1 доллару за 1000');
});

test('неизвестный usage не освобождает бронь и продолжает занимать бюджет', async (t) => {
  const f = fixture({HUGH_FALLBACK_BUDGET_USD: '2', HUGH_FALLBACK_BUDGET_MAX_OUTPUT_TOKENS: '1000', ...PRICED});
  t.after(() => f.db.close());
  f.setResponder(() => ok('Ответ без usage'));
  const answer = await f.fallback.reply(PAYLOAD);
  assert.equal(answer.text, 'Ответ без usage');
  const status = budgetOf(f);
  assert.ok(status.spentUsd >= 1, `верхняя оценка осталась занятой: ${status.spentUsd}`);
  assert.equal(status.unknownRequests, 1);
  assert.ok(status.issues.some((issue) => /неизвестным фактическим расходом/.test(issue)));
  assert.ok(status.issues.some((issue) => /не потолок на стороне провайдера/.test(issue)),
    'строгий потолок не обещается');
  // Удержанная оценка съедает остаток: второй такой же запрос уже не помещается.
  const before = f.calls.length;
  await assert.rejects(f.fallback.reply(PAYLOAD), (error) => error.budgetStopped === true);
  assert.equal(f.calls.length, before, 'платных обращений больше нет');
});

test('таймаут и ошибка сервера считаются консервативно, явный отказ освобождает бронь', async (t) => {
  const timeout = fixture({HUGH_FALLBACK_BUDGET_USD: '100', HUGH_FALLBACK_BUDGET_MAX_OUTPUT_TOKENS: '1000', ...PRICED});
  t.after(() => timeout.db.close());
  timeout.setResponder(() => { throw Object.assign(new Error('таймаут'), {name: 'TimeoutError'}); });
  await assert.rejects(timeout.fallback.reply(PAYLOAD), (error) => error.allUnavailable === true);
  const afterTimeout = budgetOf(timeout);
  assert.equal(afterTimeout.unknownRequests, 2, 'оба таймаута удержаны как неизвестный расход');
  assert.ok(afterTimeout.spentUsd >= 2);

  const refused = fixture({HUGH_FALLBACK_BUDGET_USD: '100', ...PRICED});
  t.after(() => refused.db.close());
  refused.setResponder(() => fail(429));
  await assert.rejects(refused.fallback.reply(PAYLOAD), (error) => error.allUnavailable === true);
  const afterRefusal = budgetOf(refused);
  assert.equal(afterRefusal.spentUsd, 0, 'явный отказ обрабатывать запрос расхода не создал');
  assert.equal(afterRefusal.unknownRequests, 0);
  assert.equal(afterRefusal.requests, 0);
});

test('параллельные брони не дают вместе перескочить границу', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const now = () => Date.parse('2026-09-19T00:00:00Z');
  // Граница 3 доллара, верхняя оценка каждого запроса — 1 доллар по 1000 токенов ответа.
  const env = {HUGH_FALLBACK_BUDGET_USD: '3', HUGH_FALLBACK_BUDGET_MAX_OUTPUT_TOKENS: '1000',
    HUGH_FALLBACK_PRIMARY_USD_PER_1K_PROMPT: '0', HUGH_FALLBACK_PRIMARY_USD_PER_1K_COMPLETION: '1'};
  const first = createHughBudget({db, env, now}), second = createHughBudget({db, env, now});
  const booked = [first.reserve('primary'), second.reserve('primary'), first.reserve('primary'),
    second.reserve('primary'), first.reserve('primary')];
  assert.deepEqual(booked.map((item) => item.allowed), [true, true, true, false, false],
    'после трёх броней по доллару четвёртая не помещается');
  assert.equal(second.state().spentUsd, 3);
  assert.equal(second.state().stopped, true);
  // Освобождение одной брони возвращает место ровно на неё.
  first.release(booked[0].id);
  assert.equal(second.state().spentUsd, 2);
  assert.equal(second.reserve('primary').allowed, true);
});

test('граница числа обращений тоже резервируется, а не проверяется задним числом', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const now = () => Date.parse('2026-09-19T00:00:00Z');
  const budget = createHughBudget({db, env: {HUGH_FALLBACK_BUDGET_MAX_REQUESTS: '2'}, now});
  const first = budget.reserve('primary'), second = budget.reserve('primary');
  assert.deepEqual([first.allowed, second.allowed], [true, true]);
  assert.equal(budget.reserve('primary').allowed, false, 'третий слот не выдан');
  assert.equal(budget.state().requests, 2);
  // Без денежной границы провайдер без цены допускается: ограничение считается по числу.
  assert.equal(first.priced, false);
});

test('после перезапуска зависшая бронь не освобождается, а становится неизвестным расходом', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let time = Date.parse('2026-09-19T00:00:00Z');
  const env = {HUGH_FALLBACK_BUDGET_USD: '2', HUGH_FALLBACK_BUDGET_MAX_OUTPUT_TOKENS: '1000',
    HUGH_FALLBACK_PRIMARY_USD_PER_1K_PROMPT: '0', HUGH_FALLBACK_PRIMARY_USD_PER_1K_COMPLETION: '1'};
  const before = createHughBudget({db, env, now: () => time});
  const booking = before.reserve('primary');
  assert.equal(booking.allowed, true);
  assert.equal(before.state().heldUsd, 1);
  // Процесс упал во время обращения; прошло больше срока зависшей брони.
  time += 20 * 60 * 1000;
  const after = createHughBudget({db, env, now: () => time});
  assert.deepEqual(after.recover(), {kept: 1});
  const status = after.state();
  assert.equal(status.spentUsd, 1, 'расход не занижен после аварии');
  assert.equal(status.unknownRequests, 1);
  assert.equal(after.settle(booking.id, {promptTokens: 1, completionTokens: 1}).settled, false,
    'удержанная бронь уже не уточняется задним числом');
  assert.equal(after.state().spentUsd, 1);
});

test('новое окно снимает остановку, прошлый расход в него не переносится', async (t) => {
  const f = fixture({HUGH_FALLBACK_BUDGET_USD: '2', HUGH_FALLBACK_BUDGET_WINDOW_DAYS: '1',
    HUGH_FALLBACK_BUDGET_MAX_OUTPUT_TOKENS: '1000', ...PRICED});
  t.after(() => f.db.close());
  f.setResponder(() => ok('Ответ без usage'));
  await f.fallback.reply(PAYLOAD);
  assert.ok(budgetOf(f).spentUsd >= 1);
  await assert.rejects(f.fallback.reply(PAYLOAD), (error) => error.budgetStopped === true);
  f.advance(24 * 60 * 60 * 1000);
  const next = budgetOf(f);
  assert.equal(next.stopped, false);
  assert.equal(next.spentUsd, 0, 'окно считается заново');
  assert.equal((await f.fallback.reply(PAYLOAD)).text, 'Ответ без usage', 'в новом окне обращение проходит');
});

test('границы и цены читаются только из явной конфигурации', () => {
  const empty = readBudget({});
  assert.deepEqual([empty.configured, empty.limitMicroUsd, empty.invalid.length], [false, 0, 0]);
  assert.equal(empty.maxOutputTokens, 1200);
  const broken = readBudget({HUGH_FALLBACK_BUDGET_MAX_REQUESTS: '-5'});
  assert.deepEqual(broken.invalid, ['HUGH_FALLBACK_BUDGET_MAX_REQUESTS']);
  const real = readBudget({HUGH_FALLBACK_BUDGET_USD: '100', HUGH_FALLBACK_BUDGET_MAX_OUTPUT_TOKENS: '800'});
  assert.deepEqual([real.configured, real.limitMicroUsd, real.windowDays, real.maxOutputTokens],
    [true, 100000000, 30, 800]);
  assert.deepEqual(readPrice('../evil', {}), {invalid: true, reason: 'Недопустимое имя провайдера'});
  assert.equal(readPrice('primary', {HUGH_FALLBACK_PRIMARY_USD_PER_1K_PROMPT: 'нет'}).invalid, true);
});

const PLAN_LIMITS={...PRICED,HUGH_FALLBACK_BUDGET_USD:'100',HUGH_FALLBACK_BUDGET_MAX_REQUESTS:'20',
 CONTENT_PLAN_JOB_BUDGET_USD:'10',CONTENT_PLAN_COMPANY_BUDGET_USD:'20',
 CONTENT_PLAN_JOB_MAX_REQUESTS:'2',CONTENT_PLAN_COMPANY_MAX_REQUESTS:'3',
 CONTENT_PLAN_CHAT_RESERVE_USD:'10',CONTENT_PLAN_CHAT_RESERVE_REQUESTS:'5'};
test('план без явных лимитов не расходует API; обычный ответ доступен',async t=>{
 const f=fixture({...PRICED});t.after(()=>f.db.close());
 await assert.rejects(f.fallback.reply(PAYLOAD,{contentPlan:{company:'alpha',job:'job1'}}),e=>e.budgetStopped===true);
 assert.equal(f.calls.length,0);await f.fallback.reply(PAYLOAD);assert.equal(f.calls.length,1);
});
test('план использует общий журнал: неизвестный исход, новый worker, лимит задачи и проекта',t=>{
 const f=fixture(PLAN_LIMITS);t.after(()=>f.db.close());let b=f.fallback.budget;
 const book=(job='job1',company='alpha')=>b.reserve('primary',{promptBytes:10,maxOutputTokens:10,contentPlan:{company,job}});
 const first=book();assert.equal(first.allowed,true);b.keep(first.id);
 b=createHughBudget({db:f.db,env:{...BASE,...PLAN_LIMITS},now:f.at});
 const second=book();assert.equal(second.allowed,true);b.settle(second.id,{promptTokens:2,completionTokens:2});
 assert.equal(book().allowed,false);assert.equal(book('job2').allowed,true);assert.equal(book('job3').allowed,false);
 assert.equal(book('job1','beta').allowed,true);
 assert.equal(b.planTotals('alpha','job1',null).requests,2);assert.equal(b.totals().requests,4);
});
test('резерв ответов клиентам сохраняется; явный отказ провайдера освобождает и лимит плана',t=>{
 const f=fixture({...PLAN_LIMITS,HUGH_FALLBACK_BUDGET_MAX_REQUESTS:'6'});t.after(()=>f.db.close());const b=f.fallback.budget;
 const reserve=()=>b.reserve('primary',{promptBytes:1,maxOutputTokens:1,contentPlan:{company:'alpha',job:'job1'}});
 const first=reserve();assert.equal(first.allowed,true);assert.equal(reserve().allowed,false);
 b.release(first.id);const next=reserve();assert.equal(next.allowed,true);
 assert.equal(b.reserve('primary',{promptBytes:1,maxOutputTokens:1}).allowed,true);
 assert.equal(b.planTotals('alpha','job1',null).requests,1);
});
test('денежный лимит плана учитывает верхнюю оценку до вызова и не затрагивает клиентский ответ',t=>{
 const f=fixture({...PLAN_LIMITS,CONTENT_PLAN_JOB_BUDGET_USD:'0.01'});t.after(()=>f.db.close());const b=f.fallback.budget;
 assert.equal(b.reserve('primary',{promptBytes:100,maxOutputTokens:100,contentPlan:{company:'alpha',job:'job1'}}).allowed,false);
 assert.equal(b.totals().requests,0);assert.equal(b.reserve('primary',{promptBytes:100,maxOutputTokens:100}).allowed,true);
});
test('реальный fallback считает каждую попытку провайдера в лимит плана',async t=>{
 const f=fixture({...PLAN_LIMITS,CONTENT_PLAN_JOB_MAX_REQUESTS:'1'});t.after(()=>f.db.close());
 f.setResponder(()=>{throw Error('Синтетический обрыв соединения')});
 await assert.rejects(f.fallback.reply(PAYLOAD,{contentPlan:{company:'alpha',job:'job1'}}),e=>e.budgetStopped===true);
 assert.equal(f.calls.length,1);assert.equal(f.fallback.budget.planTotals('alpha','job1',null).requests,1);
 assert.equal(f.fallback.budget.totals().unknownRequests,1);
});
test('денежный резерв клиентских ответов запрещает план до общего бюджетного стопа',t=>{
 const f=fixture({...PLAN_LIMITS,HUGH_FALLBACK_BUDGET_USD:'1',CONTENT_PLAN_CHAT_RESERVE_USD:'0.9'});t.after(()=>f.db.close());
 const b=f.fallback.budget;
 assert.equal(b.reserve('primary',{promptBytes:100,maxOutputTokens:100,contentPlan:{company:'alpha',job:'job1'}}).allowed,false);
 assert.equal(b.stopped(),false);assert.equal(b.reserve('primary',{promptBytes:100,maxOutputTokens:100}).allowed,true);
});


test('таймаут плана не отключает ответы клиентам; ошибка ключа остаётся общей',async t=>{
 const f=fixture({...PLAN_LIMITS,HUGH_FALLBACK_PROVIDERS:'primary'});t.after(()=>f.db.close());
 f.setResponder(()=>{throw Object.assign(Error('Synthetic timeout'),{name:'TimeoutError'})});
 await assert.rejects(f.fallback.reply(PAYLOAD,{contentPlan:{company:'alpha',job:'job1'}}));
 assert.equal(f.calls.length,1);assert.equal(f.fallback.available().length,1);
 f.setResponder(()=>ok('Ответ клиенту',{prompt_tokens:1,completion_tokens:1}));
 await f.fallback.reply(PAYLOAD);assert.equal(f.calls.length,2);
 await assert.rejects(f.fallback.reply(PAYLOAD,{contentPlan:{company:'alpha',job:'job1'}}));
 assert.equal(f.calls.length,2,'успех клиентского ответа не снимает паузу плана');
 f.advance(1000000);f.setResponder(()=>fail(401));
 await assert.rejects(f.fallback.reply(PAYLOAD,{contentPlan:{company:'alpha',job:'job2'}}));
 assert.equal(f.fallback.available().length,0,'явно отклонённый ключ нельзя повторять в клиентском чате');
});
