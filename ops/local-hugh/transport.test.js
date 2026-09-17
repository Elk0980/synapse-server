'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createTransport, validateEndpoint, TransportError, EndpointError, classifyError} = require('./transport');

const TOKEN = 'test-worker-key-0123456789abcdef0123456789abcdef';

function listen(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({method: request.method, url: request.url, headers: request.headers, raw});
      handler(request, response, raw, requests.length);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const endpoint = `http://127.0.0.1:${server.address().port}/content/project-chat-worker`;
      resolve({
        server,
        requests,
        endpoint,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

test('validateEndpoint: только HTTPS, фиксированный путь, без учётных данных и параметров', () => {
  assert.deepEqual(validateEndpoint('https://sb.example.com/content/project-chat-worker/'), {
    origin: 'https://sb.example.com',
    pathname: '/content/project-chat-worker',
    secure: true,
  });
  const reject = (value, reason, options) => {
    assert.throws(() => validateEndpoint(value, options), (error) => error instanceof EndpointError && error.reason === reason, reason);
  };
  reject('http://sb.example.com/content/project-chat-worker', 'endpoint_not_https');
  reject('http://sb.example.com/content/project-chat-worker', 'endpoint_not_https', {allowInsecureLoopback: true});
  reject('https://user:pass@sb.example.com/content/project-chat-worker', 'endpoint_has_credentials');
  reject('https://sb.example.com/content/project-chat-worker?x=1', 'endpoint_has_query');
  reject('https://sb.example.com/content/project-chat-worker#a', 'endpoint_has_query');
  reject('https://sb.example.com/content/other', 'endpoint_path_mismatch');
  reject('https://sb.example.com/', 'endpoint_path_mismatch');
  reject('ftp://sb.example.com/content/project-chat-worker', 'endpoint_not_https');
  reject('', 'endpoint_not_string');
  reject(42, 'endpoint_not_string');
  assert.equal(validateEndpoint('http://127.0.0.1:8080/content/project-chat-worker', {allowInsecureLoopback: true}).secure, false);
});

test('POST с Bearer на фиксированный путь операции, ответ разбирается как JSON', async () => {
  const site = await listen((request, response) => {
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({ok: true, echo: true}));
  });
  try {
    const transport = createTransport({endpoint: site.endpoint, token: TOKEN, allowInsecureLoopback: true});
    const result = await transport.post('heartbeat', {bootId: 'b', status: {state: 'connected'}});
    assert.deepEqual(result, {status: 200, body: {ok: true, echo: true}});
    const [received] = site.requests;
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/content/project-chat-worker/heartbeat');
    assert.equal(received.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(received.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(received.raw), {bootId: 'b', status: {state: 'connected'}});
    // Ключ не торчит наружу из объекта транспорта.
    assert.ok(!JSON.stringify(transport).includes(TOKEN));
    assert.ok(!Object.values(transport).some((value) => typeof value === 'string' && value.includes(TOKEN)));
    await assert.rejects(transport.post('shell', {}), TypeError);
  } finally {
    await site.close();
  }
});

test('не-2xx возвращается со статусом, редирект не выполняется и ключ не уходит по новому адресу', async () => {
  const site = await listen((request, response) => {
    if (request.url.endsWith('/claim')) {
      response.writeHead(302, {location: `${request.headers.host ? `http://${request.headers.host}` : ''}/content/project-chat-worker/elsewhere`});
      response.end();
      return;
    }
    if (request.url.endsWith('/renew')) {
      response.writeHead(401, {'content-type': 'application/json'});
      response.end('{"error":"Доступ запрещён"}');
      return;
    }
    response.writeHead(200);
    response.end('{}');
  });
  try {
    const transport = createTransport({endpoint: site.endpoint, token: TOKEN, allowInsecureLoopback: true});
    const denied = await transport.post('renew', {});
    assert.equal(denied.status, 401);
    await assert.rejects(transport.post('claim', {}), (error) => error instanceof TransportError && error.category === 'redirect_blocked' && error.status === 302);
    assert.equal(site.requests.filter((entry) => entry.url.includes('elsewhere')).length, 0);
  } finally {
    await site.close();
  }
});

test('слишком большое тело, некорректный JSON, пустое тело и таймаут дают только категорию', async () => {
  const site = await listen((request, response, raw, index) => {
    if (request.url.endsWith('/heartbeat')) {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end('x'.repeat(4096));
      return;
    }
    if (request.url.endsWith('/claim')) {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end('{not json');
      return;
    }
    if (request.url.endsWith('/renew')) {
      response.writeHead(204);
      response.end();
      return;
    }
    // complete: ответа нет
  });
  try {
    const transport = createTransport({endpoint: site.endpoint, token: TOKEN, allowInsecureLoopback: true, maxResponseBytes: 1024, timeoutMs: 200});
    await assert.rejects(transport.post('heartbeat', {}), (error) => error instanceof TransportError && error.category === 'body_too_large');
    await assert.rejects(transport.post('claim', {}), (error) => error instanceof TransportError && error.category === 'invalid_json');
    assert.deepEqual(await transport.post('renew', {}), {status: 204, body: null});
    await assert.rejects(transport.post('complete', {}), (error) => {
      assert.equal(error.message, 'transport_error');
      return error instanceof TransportError && error.category === 'timeout';
    });
  } finally {
    await site.close();
  }
});

test('таймаут — по настенным часам на весь запрос: капающее по байту тело не продлевает ожидание', async () => {
  const drips = [];
  const site = await listen((request, response) => {
    response.writeHead(200, {'content-type': 'application/json'});
    response.write('[');
    const timer = setInterval(() => {
      if (response.destroyed || response.writableEnded) {
        clearInterval(timer);
        return;
      }
      response.write('1,');
    }, 20);
    drips.push(timer);
    response.on('close', () => clearInterval(timer));
  });
  try {
    const transport = createTransport({endpoint: site.endpoint, token: TOKEN, allowInsecureLoopback: true, timeoutMs: 50});
    const started = Date.now();
    await assert.rejects(transport.post('claim', {}), (error) => error instanceof TransportError && error.category === 'timeout');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 400, `ожидалось около 50 мс, прошло ${elapsed} мс`);
    // Соединение действительно закрыто: сервер перестал получать подтверждения записи.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(site.requests.length === 1);
  } finally {
    for (const timer of drips) clearInterval(timer);
    await site.close();
  }
});

test('таймаут не срабатывает после успешного ответа и не держит процесс', async () => {
  const site = await listen((request, response) => {
    response.writeHead(200, {'content-type': 'application/json'});
    response.end('{"ok":true}');
  });
  try {
    const transport = createTransport({endpoint: site.endpoint, token: TOKEN, allowInsecureLoopback: true, timeoutMs: 30});
    assert.deepEqual(await transport.post('heartbeat', {}), {status: 200, body: {ok: true}});
    await new Promise((resolve) => setTimeout(resolve, 60)); // истёкший бы deadline ничего не меняет
  } finally {
    await site.close();
  }
});

test('недоступный сервер: категория network без адреса в ошибке', async () => {
  const site = await listen(() => {});
  const {endpoint} = site;
  await site.close();
  const transport = createTransport({endpoint, token: TOKEN, allowInsecureLoopback: true, timeoutMs: 2000});
  await assert.rejects(transport.post('heartbeat', {}), (error) => {
    assert.equal(error.message, 'transport_error');
    assert.ok(!JSON.stringify(error).includes('127.0.0.1'));
    return error instanceof TransportError && error.category === 'network';
  });
});

test('classifyError сводит коды сокета к закрытому набору категорий', () => {
  const cases = [
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNREFUSED', 'network'],
    ['ECONNRESET', 'network'],
    ['ETIMEDOUT', 'timeout'],
    ['HUGH_TIMEOUT', 'timeout'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
    ['SOMETHING_ELSE', 'unknown'],
  ];
  for (const [code, category] of cases) {
    const error = new Error('raw message with https://secret.example/?k=v');
    error.code = code;
    assert.equal(classifyError(error), category, code);
  }
  assert.equal(classifyError(null), 'unknown');
  assert.throws(() => createTransport({endpoint: 'https://sb.example.com/content/project-chat-worker', token: ''}), (error) => error.reason === 'token_missing');
});
