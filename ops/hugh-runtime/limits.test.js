'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {LIMITS, validateReplyPayload, canonicalPayload, capOutput} = require('./limits');

const base = () => ({
  jobId: 'job-1',
  companyCode: 'palitra',
  system: 'Отвечай кратко.',
  messages: [{role: 'user', content: 'Привет'}],
});

test('корректное тело разбирается и нормализуется', () => {
  const payload = validateReplyPayload({...base(), jobId: ' job-1 ', companyCode: ' palitra '});
  assert.deepEqual(payload, base());
});

test('сообщение ровно на границе принимается, на символ длиннее — отказ', () => {
  const exact = 'я'.repeat(LIMITS.maxMessageChars);
  assert.doesNotThrow(() => validateReplyPayload({...base(), messages: [{role: 'user', content: exact}]}));
  assert.throws(
    () => validateReplyPayload({...base(), messages: [{role: 'user', content: `${exact}я`}]}),
    (error) => error.status === 400 && error.code === 'INVALID_BODY',
  );
});

test('байтовый предел считается по UTF-8, а не по символам', () => {
  // 6000 эмодзи — это 6000 кодовых точек и 24000 байт: на границе оба предела выполняются.
  const emoji = '🙂'.repeat(LIMITS.maxMessageChars);
  assert.equal(Array.from(emoji).length, LIMITS.maxMessageChars);
  assert.equal(Buffer.byteLength(emoji, 'utf8'), LIMITS.maxMessageBytes);
  assert.doesNotThrow(() => validateReplyPayload({...base(), messages: [{role: 'user', content: emoji}]}));
});

test('совокупная переписка длиннее предела отклоняется целиком', () => {
  const chunk = 'a'.repeat(LIMITS.maxMessageChars);
  const messages = Array.from({length: 9}, () => ({role: 'user', content: chunk}));
  assert.doesNotThrow(() => validateReplyPayload({...base(), messages: messages.slice(0, 8)}));
  assert.throws(() => validateReplyPayload({...base(), messages}), (error) => error.status === 400);
});

test('слишком много сообщений отклоняется, а не обрезается', () => {
  const messages = Array.from({length: LIMITS.maxMessages + 1}, () => ({role: 'user', content: 'x'}));
  assert.throws(() => validateReplyPayload({...base(), messages}), (error) => error.status === 400);
});

test('неизвестные поля, роли и типы отклоняются', () => {
  const cases = [
    {...base(), extra: 1},
    {...base(), messages: [{role: 'system', content: 'x'}]},
    {...base(), messages: [{role: 'user', content: 'x', attachments: []}]},
    {...base(), messages: [{role: 'user', content: ''}]},
    {...base(), messages: []},
    {...base(), messages: {}},
    {...base(), system: ''},
    {...base(), system: 5},
    {...base(), jobId: 'job 1'},
    {...base(), jobId: ''},
    {...base(), companyCode: '../etc'},
    'строка',
    null,
    [],
  ];
  for (const value of cases) {
    assert.throws(() => validateReplyPayload(value), (error) => error.status === 400, JSON.stringify(value));
  }
});

test('системная инструкция длиннее 8000 символов отклоняется', () => {
  assert.doesNotThrow(() => validateReplyPayload({...base(), system: 'с'.repeat(LIMITS.maxSystemChars)}));
  assert.throws(() => validateReplyPayload({...base(), system: 'с'.repeat(LIMITS.maxSystemChars + 1)}));
});

test('канонический вид не зависит от порядка ключей', () => {
  const left = validateReplyPayload(base());
  const right = validateReplyPayload({messages: base().messages, system: base().system, companyCode: 'palitra', jobId: 'job-1'});
  assert.equal(canonicalPayload(left), canonicalPayload(right));
});

test('ответ модели обрезается по верхней границе', () => {
  const long = 'о'.repeat(LIMITS.maxOutputChars + 500);
  const capped = capOutput(long);
  assert.equal(Array.from(capped.text).length, LIMITS.maxOutputChars);
  assert.equal(capped.truncated, true);
  assert.equal(capOutput('  привет  ').text, 'привет');
});
