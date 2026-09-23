'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const shell = fs.readFileSync(require.resolve('../cabinet.html'), 'utf8');
const ORIGIN = 'https://cabinet.test';
const MODEL_PATHS = ['/content/media-mentor-suggest', '/content/media-mentor-analyze',
  '/content/media-mentor-review', '/content/actor-workspace/messages', '/content/actor-workspace/retry'];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function extract(start, end) {
  const from = shell.indexOf(start), to = shell.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `исполняется настоящий код shell: ${start}`);
  return shell.slice(from, to);
}

function fixture({ fetchDelay = 0, jsonDelay = 0, jsonAbortName, jsonError, afterDeadline } = {}) {
  let time = 0, nextId = 0;
  const timers = new Map(), deadlines = [], calls = [];
  const schedule = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { at: time + delay, callback });
    return id;
  };
  const delayed = (delay, signal, value, abortName) => new Promise((resolve, reject) => {
    const failure = () => abortName ? new DOMException('Прервано чтение тела', abortName) : signal.reason;
    if (signal.aborted) { reject(failure()); return; }
    const aborted = () => { timers.delete(id); reject(failure()); };
    const id = schedule(() => {
      signal.removeEventListener('abort', aborted);
      resolve(value);
    }, delay);
    signal.addEventListener('abort', aborted, { once: true });
  });
  const context = {
    window: { location: new URL(`${ORIGIN}/cabinet.html`) }, URL, URLSearchParams,
    AbortSignal: {
      any: (signals) => AbortSignal.any(signals),
      timeout: (delay) => {
        deadlines.push(delay);
        const controller = new AbortController();
        schedule(() => {
          controller.abort(new DOMException('Истёк срок запроса', 'TimeoutError'));
          afterDeadline?.();
        }, delay);
        return controller.signal;
      },
    },
    fetch: (url, options) => {
      calls.push({ url: String(url), options });
      const response = { ok: true, status: 200, json: () => {
        if (jsonError) return Promise.reject(jsonError);
        return delayed(jsonDelay, options.signal, { answer: 'готово' }, jsonAbortName);
      } };
      return delayed(fetchDelay, options.signal, response);
    },
    CRM_API: '/content/crm', selectedProjectId: 'taisabai', scopeParams: () => ({ companyCode: 'taisabai' }),
  };
  const source = extract('const REQUEST_TIMEOUT_MS', 'const VIEW_TITLES') + '\n' +
    extract('const crmQuery =', 'const csrfOptions =');
  const api = vm.runInNewContext(source + '\n({ apiJson, crmQuery });', context);
  async function advance(ms) {
    const target = time + ms;
    await tick();
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
      await tick();
    }
    time = target;
    await tick();
  }
  return { ...api, advance, deadlines, calls };
}

function observe(promise) {
  const state = { settled: false };
  state.result = promise.then((value) => ({ value }), (error) => ({ error }))
    .then((result) => { state.settled = true; return result; });
  return state;
}

const request = (f, kind, options = {}) => kind === 'crm'
  ? f.crmQuery('/contacts', {}, options)
  : f.apiJson('/content/media-mentor-suggest?companyCode=taisabai', { method: 'POST', ...options });

test('пять точных POST-маршрутов дожидаются долгого ответа без повторной отправки', async () => {
  for (const path of MODEL_PATHS) {
    const f = fixture({ fetchDelay: 45000 });
    const pending = observe(f.apiJson(`${path}?companyCode=taisabai`, { method: 'POST' }));
    await f.advance(15001);
    assert.equal(pending.settled, false, path);
    assert.deepEqual(f.deadlines, [240000], path);
    await f.advance(29999);
    assert.equal((await pending.result).value.answer, 'готово', path);
    assert.equal(f.calls.length, 1, 'модельный запрос отправлен ровно один раз');
  }
});

test('абсолютный URL своего origin и нижний регистр метода сохраняют длинный срок', async () => {
  const f = fixture({ fetchDelay: 20000 });
  const pending = observe(f.apiJson(`${ORIGIN}/content/actor-workspace/retry`, { method: 'post' }));
  await f.advance(20000);
  assert.equal((await pending.result).value.answer, 'готово');
  assert.deepEqual(f.deadlines, [240000]);
});

test('модельный запрос имеет конечный срок 240 секунд и сообщает именно его', async () => {
  const f = fixture({ fetchDelay: 300000 });
  const pending = observe(request(f, 'api'));
  await f.advance(239999);
  assert.equal(pending.settled, false);
  await f.advance(1);
  assert.match((await pending.result).error.message, /240 секунд/);
  await f.advance(60000);
  assert.equal(f.calls.length, 1, 'после таймаута повтор не запускается');
});

test('GET, похожие пути и чужие origin остаются ограничены 15 секундами', async () => {
  const cases = [
    ...MODEL_PATHS.map((path) => [path, 'GET']),
    ['/content/media-mentor-suggest', undefined], ['/content/media-mentor-suggest', 'PUT'],
    ['/content/media-mentor-suggest/', 'POST'], ['/content/media-mentor-suggest-extra', 'POST'],
    ['/content/actor-workspace/messages/extra', 'POST'], ['/content/actor-workspace/retry-more', 'POST'],
    ['/content/other?path=/content/media-mentor-suggest', 'POST'],
    ['https://other.test/content/media-mentor-suggest', 'POST'],
    ['//other.test/content/media-mentor-suggest', 'POST'],
    ['http://cabinet.test/content/media-mentor-suggest', 'POST'],
    ['https://cabinet.test:444/content/media-mentor-suggest', 'POST'],
  ];
  for (const [url, method] of cases) {
    const f = fixture({ fetchDelay: 20000 });
    const pending = observe(f.apiJson(url, method ? { method } : {}));
    await f.advance(15000);
    assert.match((await pending.result).error.message, /15 секунд/, `${method} ${url}`);
    assert.deepEqual(f.deadlines, [15000], `${method} ${url}`);
    assert.equal(f.calls.length, 1);
  }
});

test('CRM-запросы остаются ограничены 15 секундами', async () => {
  for (const path of ['/contacts', '/media-mentor-suggest']) {
    const f = fixture({ fetchDelay: 20000 });
    const pending = observe(f.crmQuery(path, {}, { method: 'POST' }));
    await f.advance(15000);
    assert.match((await pending.result).error.message, /15 секунд/);
    assert.deepEqual(f.deadlines, [15000]);
    assert.equal(f.calls.length, 1);
  }
});

test('внешняя отмена fetch сохраняет исходную причину для обоих помощников', async () => {
  for (const kind of ['api', 'crm']) {
    for (const reason of [new DOMException('Внешняя отмена', 'AbortError'),
      new Error('Раздел закрыт'), new DOMException('Внешний срок', 'TimeoutError'), 'Отмена', null]) {
      const controller = new AbortController(), f = fixture({ fetchDelay: 300000 });
      const pending = observe(request(f, kind, { signal: controller.signal }));
      controller.abort(reason);
      await f.advance(0);
      assert.equal((await pending.result).error, reason, kind);
      assert.equal(f.calls.length, 1);
    }
  }
});

test('уже отменённый внешний сигнал не превращается в успешный ответ', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Отменено до отправки'));
  const f = fixture();
  const result = await observe(request(f, 'api', { signal: controller.signal })).result;
  assert.equal(result.error, controller.signal.reason);
  assert.ok(f.calls.length <= 1);
});

test('поздняя внешняя отмена не подменяет уже сработавший локальный таймаут', async () => {
  for (const kind of ['api', 'crm']) {
    const controller = new AbortController();
    const f = fixture({ fetchDelay: 300000,
      afterDeadline: () => controller.abort(new Error('Отмена после таймаута')) });
    const pending = observe(request(f, kind, { signal: controller.signal }));
    await f.advance(kind === 'api' ? 240000 : 15000);
    assert.match((await pending.result).error.message, new RegExp(`${kind === 'api' ? 240 : 15} секунд`));
    assert.equal(f.calls.length, 1);
  }
});

test('таймаут во время JSON не возвращает пустой успешный объект', async () => {
  for (const kind of ['api', 'crm']) {
    for (const jsonAbortName of ['TimeoutError', 'AbortError']) {
      const f = fixture({ jsonDelay: 300000, jsonAbortName });
      const pending = observe(request(f, kind));
      const timeout = kind === 'api' ? 240000 : 15000;
      await f.advance(timeout);
      const result = await pending.result;
      assert.match(result.error?.message || '', new RegExp(`${timeout / 1000} секунд`), `${kind} ${jsonAbortName}`);
      assert.equal(f.calls.length, 1);
    }
  }
});

test('внешняя отмена чтения JSON сохраняется и не возвращает пустой объект', async () => {
  for (const kind of ['api', 'crm']) {
    const controller = new AbortController(), reason = new Error('Компания переключена');
    const f = fixture({ jsonDelay: 300000, jsonAbortName: 'AbortError' });
    const pending = observe(request(f, kind, { signal: controller.signal }));
    await f.advance(0);
    controller.abort(reason);
    const result = await pending.result;
    assert.equal(result.error, reason, kind);
    assert.equal(f.calls.length, 1);
  }
});

test('TimeoutError самого чтения JSON не подавляется даже до отмены сигнала', async () => {
  for (const kind of ['api', 'crm']) {
    const f = fixture({ jsonError: new DOMException('Таймаут JSON', 'TimeoutError') });
    const pending = observe(request(f, kind));
    await f.advance(0);
    assert.match((await pending.result).error?.message || '', new RegExp(`${kind === 'api' ? 240 : 15} секунд`));
    assert.equal(f.calls.length, 1);
  }
});
