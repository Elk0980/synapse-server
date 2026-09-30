'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decision } = require('./hugh-api-assistant');
test('решения строго ограничены ответом, молчанием и задачей', () => {
  assert.deepEqual(decision('{"action":"reply","text":" Да "}'), { action: 'reply', text: 'Да' });
  assert.deepEqual(decision('{"action":"ignore"}'), { action: 'ignore' });
  assert.equal(decision(JSON.stringify({ action:'escalate', task:{ title:'Исправить макет', note:'Проверить перенос', existingTaskId:12 } })).existingTaskId, 12);
  for (const value of ['текст', '{}', '{"action":"execute","command":"rm"}', '{"action":"reply","text":""}',
    '{"action":"ignore","text":"скрытый ответ"}', '{"action":"escalate","task":{"title":"x","note":"y","companyCode":"other"}}',
    '{"action":"escalate","task":{"title":"x","note":"y","existingTaskId":-1}}']) {
    assert.throws(() => decision(value), e => e.terminal === true);
  }
});
