'use strict';
// CF26: общий разбор ошибки оболочки кабинета (cabinet.html → responseError). Исполняется НАСТОЯЩАЯ функция из cabinet.html.
// Форма ответа CRM — {error, details:{code}} (ops/crm/server.js); сервис контента — тот же разбор. Реальных API нет.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function shellResponseError() {
  const shell = fs.readFileSync(__dirname + '/../cabinet.html', 'utf8');
  const match = shell.match(/const responseError = \(response, body\) => \{[\s\S]*?\n  \};(?=\s*const apiJson)/);
  assert.ok(match, 'тест исполняет настоящую функцию оболочки');
  return vm.runInNewContext(match[0] + '\nresponseError;');
}
// Тело ответа ровно так, как его сериализует CRM: JSON.stringify → JSON.parse.
const crmBody = (error, code) => JSON.parse(JSON.stringify({error, ...(code === undefined ? {} : {details: {code}})}));

test('CF26: код отказа CRM из details.code доходит до раздела вместе со статусом и текстом сервера', () => {
  const responseError = shellResponseError();
  for (const code of ['STALE_VARIANT', 'STALE_PLAN', 'BRIEF_CHANGED', 'PROFILE_CHANGED', 'VARIANT_NOT_APPROVABLE',
    'VARIANT_NOT_APPROVED', 'IDEA_NOT_FOUND', 'PLAN_LINKED_POST']) {
    const error = responseError({status: code === 'IDEA_NOT_FOUND' ? 404 : 409}, crmBody('Версия площадки уже изменилась. Обновите план.', code));
    assert.equal(error.code, code);
    assert.equal(error.status, code === 'IDEA_NOT_FOUND' ? 404 : 409);
    assert.equal(error.message, 'Версия площадки уже изменилась. Обновите план.');
  }
});

test('CF26: верхний code сохраняет приоритет; details.code — только запасной путь', () => {
  const responseError = shellResponseError();
  const both = responseError({status: 409}, {error: 'Конфликт', code: 'SETTINGS_CHANGED', details: {code: 'STALE_PLAN'}});
  assert.equal(both.code, 'SETTINGS_CHANGED', 'верхний уровень важнее');
  const topOnly = responseError({status: 409}, {error: 'Конфликт', code: 'SETTINGS_CHANGED'});
  assert.equal(topOnly.code, 'SETTINGS_CHANGED', 'прежняя совместимость');
  const invalidTop = responseError({status: 409}, {error: 'Конфликт', code: 'settings_changed', details: {code: 'STALE_PLAN'}});
  assert.equal(invalidTop.code, 'STALE_PLAN', 'неверный верхний код не блокирует верный в details');
});

test('CF26: неверный или отсутствующий details.code не выставляется; 403 и 5xx — прежние тексты', () => {
  const responseError = shellResponseError();
  for (const invalid of [null, 5, '', 'stale_variant', 'STALE<script>', 'A'.repeat(65), {code: 'X'}, ['STALE_PLAN']]) {
    const error = responseError({status: 409}, {error: 'Ошибка запроса', details: {code: invalid}});
    assert.equal(Object.hasOwn(error, 'code'), false, JSON.stringify(invalid));
  }
  for (const body of [null, undefined, {}, {details: null}, {details: 'STALE_PLAN'}, crmBody('Не найдено')]) {
    const error = responseError({status: 404}, body);
    assert.equal(Object.hasOwn(error, 'code'), false);
  }
  const forbidden = responseError({status: 403}, crmBody('Только владелец', 'FORBIDDEN'));
  assert.equal(forbidden.message, 'Недостаточно прав'); assert.equal(forbidden.code, 'FORBIDDEN'); assert.equal(forbidden.status, 403);
  const failed = responseError({status: 502}, null);
  assert.equal(failed.message, 'Ошибка сервера, попробуйте позже'); assert.equal(Object.hasOwn(failed, 'code'), false);
  const plain = responseError({status: 400}, {});
  assert.equal(plain.message, 'Ошибка запроса');
});
