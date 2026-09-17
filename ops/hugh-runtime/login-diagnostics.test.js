'use strict';

/* Разбор причины неудачного входа. Главное свойство проверяется на каждом случае:
   из сырого сообщения Codex наружу не переносится ни один символ — только категория и числа.
   Поэтому в сообщения-образцы намеренно засеяны «секреты»: токен, код устройства, адрес с
   параметром, почта и IP. Ни один из них не имеет права появиться ни в журнале, ни в тексте. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATEGORIES,
  classifyLoginFailure,
  formatLoginDiagnostics,
  loginFailureMessage,
  upstreamStatusOf,
} = require('./login-diagnostics');

const SEEDS = Object.freeze({
  token: 'sk-live-СЕКРЕТ-9f3a7c',
  userCode: 'ZXCV-8765',
  url: 'https://auth.openai.com/api/accounts/deviceauth/usercode?token=sk-live-СЕКРЕТ-9f3a7c',
  email: 'owner@example.com',
  address: '203.0.113.77',
  loginId: 'login-7f2c9d',
});

const rpc = (message, code = -32603) => {
  const error = new Error('app-server вернул ошибку');
  error.rpcCode = code;
  error.rpcMessage = message;
  return error;
};

/* Каждый образец собран из настоящих формулировок клиента Codex и засеян секретами. */
const CASES = [
  {
    name: 'нет доверенного корня: отказ TLS, а не «сеть недоступна»',
    error: rpc(`error sending request for url (${SEEDS.url}): invalid peer certificate: UnknownIssuer`),
    category: 'tls',
    upstreamStatus: null,
  },
  {
    name: 'рукопожатие не состоялось',
    error: rpc(`tls handshake eof while connecting to ${SEEDS.address}, loginId=${SEEDS.loginId}`),
    category: 'tls',
    upstreamStatus: null,
  },
  {
    name: 'имя не разрешилось',
    error: rpc(`error sending request for url (${SEEDS.url}): dns error: failed to lookup address information: Name or service not known`),
    category: 'dns',
    upstreamStatus: null,
  },
  {
    name: 'наблюдавшийся на проде отказ соединения',
    error: rpc(`error sending request for url (${SEEDS.url}): error trying to connect: tcp connect error: Connection timed out (os error 110)`),
    category: 'transport',
    upstreamStatus: null,
  },
  {
    name: 'соединение отвергнуто: число из os error кодом ответа не считается',
    error: rpc(`tcp connect error: Connection refused (os error 111) to ${SEEDS.address}`),
    category: 'transport',
    upstreamStatus: null,
  },
  {
    name: 'ответа не дождались, транспортных признаков нет',
    error: rpc(`request for ${SEEDS.userCode} timed out after 30s`),
    category: 'timeout',
    upstreamStatus: null,
  },
  {
    name: 'сервис входа ответил кодом ошибки',
    error: rpc(`request failed: unexpected status 503 Service Unavailable for ${SEEDS.url}`),
    category: 'http',
    upstreamStatus: 503,
  },
  {
    name: 'код ответа в форме HTTP/1.1',
    error: rpc(`HTTP/1.1 429 Too Many Requests (${SEEDS.email})`),
    category: 'http',
    upstreamStatus: 429,
  },
  {
    name: 'код ответа назван прямо',
    error: rpc(`server responded with status: 401, token=${SEEDS.token}`),
    category: 'http',
    upstreamStatus: 401,
  },
  {
    name: 'ничего не опознано: догадка не выдаётся за причину',
    error: rpc(`неведомая поломка, code=${SEEDS.userCode}`),
    category: 'unknown',
    upstreamStatus: null,
  },
  // Три случая ниже — разбор, на котором проверка ошибалась: параметр адреса и процитированное
  // тело выдавали себя за ответ сервиса входа.
  {
    name: 'параметр адреса не становится кодом ответа',
    error: rpc('error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode?status=403):' +
      ' tcp connect error: Connection timed out (os error 110)'),
    category: 'transport',
    upstreamStatus: null,
  },
  {
    name: 'параметр адреса не перебивает отказ сертификата',
    error: rpc('error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode?status=429):' +
      ' invalid peer certificate: UnknownIssuer'),
    category: 'tls',
    upstreamStatus: null,
  },
  {
    name: 'код берётся из формулировки отказа, а не из процитированного тела',
    error: rpc('request failed: unexpected status 503 Service Unavailable; body: HTTP/1.1 401 Unauthorized'),
    category: 'http',
    upstreamStatus: 503,
  },
];

test('категории определяются по настоящим формулировкам клиента Codex', () => {
  for (const item of CASES) {
    const detail = classifyLoginFailure(item.error);
    assert.equal(detail.category, item.category, item.name);
    assert.equal(detail.upstreamStatus, item.upstreamStatus, item.name);
    assert.equal(detail.rpcCode, -32603, item.name);
    assert.ok(CATEGORIES.includes(detail.category));
  }
});

test('ни один засеянный секрет не попадает ни в журнал, ни в текст для владельца', () => {
  for (const item of CASES) {
    const detail = classifyLoginFailure(item.error);
    const line = formatLoginDiagnostics(detail);
    const message = loginFailureMessage(detail);
    for (const [name, seed] of Object.entries(SEEDS)) {
      assert.ok(!line.includes(seed), `${item.name}: ${name} утёк в журнал`);
      assert.ok(!message.includes(seed), `${item.name}: ${name} утёк в текст`);
    }
    // Сильнее, чем поиск конкретных строк: в журнале только имя категории и числа.
    assert.match(line, /^category=(?:tls|dns|transport|http|timeout|unknown)(?: upstreamStatus=\d{3})?(?: rpcCode=-?\d+)?$/,
      `${item.name}: посторонние данные в строке журнала «${line}»`);
    // В тексте нет латиницы: она бывает только в сообщении Codex, а оно никуда не переносится.
    assert.doesNotMatch(message, /[A-Za-z]/, `${item.name}: латиница в тексте «${message}»`);
    // Числа в тексте допустимы ровно одно и только как код ответа сервиса входа.
    assert.deepEqual(message.match(/\d+/g) || [],
      item.upstreamStatus === null ? [] : [String(item.upstreamStatus)], item.name);
  }
});

test('служебные исходы клиента различаются, нечисловой код RPC не журналируется', () => {
  const timeout = new Error('app-server не ответил вовремя');
  timeout.rpcCode = 'timeout';
  const timedOut = classifyLoginFailure(timeout);
  assert.deepEqual(timedOut, {category: 'timeout', upstreamStatus: null, rpcCode: null});
  assert.equal(formatLoginDiagnostics(timedOut), 'category=timeout');

  const gone = new Error('app-server завершился');
  gone.rpcCode = 'process_exit';
  assert.deepEqual(classifyLoginFailure(gone), {category: 'transport', upstreamStatus: null, rpcCode: null});

  // Ошибка без полей RPC вообще: причина неизвестна, и это так и называется.
  const bare = classifyLoginFailure(new Error('нет полей'));
  assert.deepEqual(bare, {category: 'unknown', upstreamStatus: null, rpcCode: null});
  assert.equal(classifyLoginFailure(null).category, 'unknown');
  assert.equal(formatLoginDiagnostics(bare), 'category=unknown');
});

test('кодом ответа считается только названное кодом ответа число', () => {
  assert.equal(upstreamStatusOf('unexpected status 500'), 500);
  assert.equal(upstreamStatusOf('status code: 404'), 404);
  assert.equal(upstreamStatusOf('returned 502 while connecting'), 502);
  assert.equal(upstreamStatusOf('HTTP status client error (429 Too Many Requests)'), 429);
  for (const text of [
    'tcp connect error: Connection timed out (os error 110)',
    'failed after 30000 ms',
    'status: 42',
    'status: 9999',
    'device code ZXCV-8765 rejected',
    '',
  ]) {
    assert.equal(upstreamStatusOf(text), null, text);
  }
});

test('адрес, строка запроса и тело ответа не просматриваются вовсе', () => {
  // Параметр в адресе — не формулировка отказа, чем бы он ни назывался.
  assert.equal(upstreamStatusOf('error sending request for url (https://auth.openai.com/codex/device?status=403)'), null);
  assert.equal(upstreamStatusOf('connect error to auth.openai.com/api?status=429&status_code=500'), null);
  // Знак равенства не принимается: так пишут параметры, а не отказ.
  assert.equal(upstreamStatusOf('status=403'), null);
  // Из двух чисел берётся то, что названо отказом раньше, а тело не читается вообще.
  assert.equal(upstreamStatusOf('unexpected status 503 Service Unavailable; body: HTTP/1.1 401 Unauthorized'), 503);
  assert.equal(upstreamStatusOf('request failed; response body: status: 418'), null);
  // Отказ TLS остаётся отказом TLS, даже если рядом в адресе есть похожее на код число.
  const tls = classifyLoginFailure(rpc('error sending request for url (https://a.example/x?status=429): invalid peer certificate'));
  assert.deepEqual(tls, {category: 'tls', upstreamStatus: null, rpcCode: -32603});
});

test('неизвестная причина не подменяется утверждением о временном сбое сети', () => {
  const message = loginFailureMessage({category: 'unknown', upstreamStatus: null, rpcCode: null});
  assert.match(message, /Причина не определена/);
  assert.doesNotMatch(message, /временн|позже|повторите|сеть|регион/i);
  // Известный числовой код объясняется нейтрально: без догадок про регион и учётную запись.
  const http = loginFailureMessage({category: 'http', upstreamStatus: 403, rpcCode: -32603});
  assert.equal(http, 'Сервис входа ответил кодом 403');
  assert.doesNotMatch(http, /регион|страна|VPN|пароль|учётн/i);
});
