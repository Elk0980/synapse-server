'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { read, dom, loadMetrika, SITE, ORIGIN } = require('./helpers.cjs');

const api = loadMetrika();
const CALLBACK = fs.readFileSync(path.join(SITE, 'callback.js'), 'utf8');

// Форма берётся из реальной разметки index.html, чтобы тест ловил расхождение имён полей.
function formMarkup() {
  const html = read('index.html');
  const start = html.indexOf('<form class="callback-form" id="callback-form"');
  const end = html.indexOf('</form>', start) + '</form>'.length;
  assert.ok(start > 0 && end > start, 'форма обратного звонка найдена в index.html');
  return html.slice(start, end);
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function flush(win) {
  for (let i = 0; i < 6; i++) await new Promise(r => win.setTimeout(r, 0));
}

// Счётчик верхнего уровня (без сети) + реальный callback.js, исполненный в окне jsdom.
async function submitWith(fetchImpl, { phone = '+7 999 123-45-67', name = 'Анна', comment = '' } = {}) {
  const d = dom(`<!doctype html><body>${formMarkup()}</body>`, ORIGIN + '/?utm_source=test', { runScripts: 'outside-only' });
  const win = d.window;
  const sent = [];
  api.start(win, { skipTag: true, send: (g, p) => sent.push(p ? [g, p] : [g]), now: () => 0, setTimeout: () => 0 });
  const requests = [];
  win.fetch = (url, init) => { requests.push({ url, init }); return fetchImpl(url, init, win); };
  win.eval(CALLBACK);
  const form = win.document.getElementById('callback-form');
  const fire = (el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }));
  form.elements.name.value = name; fire(form.elements.name, 'input');
  form.elements.phone.value = phone; fire(form.elements.phone, 'input');
  form.elements.consent.checked = true; fire(form.elements.consent, 'input');
  if (comment) {
    form.elements.addComment.checked = true; fire(form.elements.addComment, 'change');
    form.elements.comment.value = comment; fire(form.elements.comment, 'input');
  }
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await flush(win);
  const status = form.querySelector('.callback-form__status').textContent;
  return { sent, goals: sent.map(s => s[0]), requests, form, status, win };
}

test('201 + положительный id — одна новая заявка callback_submit', async () => {
  const r = await submitWith(async () => response(201, { id: 42 }));
  assert.deepEqual(r.goals, ['callback_start', 'callback_attempt', 'callback_submit']);
  assert.equal(r.requests.length, 1);
  assert.ok(r.form.classList.contains('is-success'));
});

test('200 + deduplicated — повтор, а не новый лид: callback_duplicate без callback_submit', async () => {
  const r = await submitWith(async () => response(200, { id: 42, deduplicated: true }));
  assert.deepEqual(r.goals, ['callback_start', 'callback_attempt', 'callback_duplicate']);
  assert.ok(!r.form.classList.contains('is-success'));
});

const failures = [
  ['429', async () => response(429, { error: 'rate' }), '429'],
  ['500', async () => response(500, {}), '500'],
  ['сеть оборвана', async () => { throw new TypeError('Failed to fetch'); }, 'network'],
  ['таймаут', async (u, i, win) => { const e = new win.DOMException('aborted', 'AbortError'); throw e; }, 'timeout'],
  ['201 без id', async () => response(201, {}), 'bad_id'],
  ['201 с id = 0', async () => response(201, { id: 0 }), 'bad_id'],
  ['201 с дробным id', async () => response(201, { id: 1.5 }), 'bad_id'],
  ['201 + deduplicated', async () => response(201, { id: 7, deduplicated: true }), 'not_created'],
  ['200 без deduplicated', async () => response(200, { id: 7 }), 'not_created']
];

for (const [label, impl, reason] of failures) {
  test(`ошибка: ${label} → callback_error {reason: ${reason}}, новой заявки нет`, async () => {
    const r = await submitWith(impl);
    assert.deepEqual(r.sent, [['callback_start'], ['callback_attempt'], ['callback_error', { reason }]]);
    assert.ok(!r.goals.includes('callback_submit'));
  });
}

test('ввод в несколько полей — один callback_start; невалидный телефон — без попытки и без запроса', async () => {
  const r = await submitWith(async () => response(201, { id: 1 }), { phone: '12' });
  assert.deepEqual(r.goals, ['callback_start']);
  assert.equal(r.requests.length, 0);
});

test('персональные данные не попадают в цели; поля помечены ym-disable-keys', async () => {
  const r = await submitWith(async () => response(201, { id: 9 }), { phone: '+7 999 123-45-67', name: 'Анна', comment: 'Позвоните после 18' });
  const dump = JSON.stringify(r.sent);
  for (const piece of ['999', '123-45', 'Анна', 'Позвоните', 'utm_source', ORIGIN]) assert.ok(!dump.includes(piece), piece);
  for (const field of ['name', 'phone', 'comment']) assert.ok(r.form.elements[field].classList.contains('ym-disable-keys'), field);
  // Сама заявка на сервер по-прежнему уходит с телефоном — это работа формы, не Метрики.
  assert.ok(JSON.parse(r.requests[0].init.body).contact.includes('999'));
});

test('повторная отправка во время ожидания ответа не создаёт второй попытки', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const d = dom(`<!doctype html><body>${formMarkup()}</body>`, ORIGIN + '/', { runScripts: 'outside-only' });
  const win = d.window;
  const sent = [];
  api.start(win, { skipTag: true, send: (g) => sent.push(g), now: () => 0, setTimeout: () => 0 });
  let calls = 0;
  win.fetch = async () => { calls++; await gate; return response(201, { id: 5 }); };
  win.eval(CALLBACK);
  const form = win.document.getElementById('callback-form');
  form.elements.name.value = 'Анна';
  form.elements.phone.value = '+7 999 123-45-67';
  form.elements.consent.checked = true;
  form.dispatchEvent(new win.Event('input', { bubbles: true }));
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  release();
  await flush(win);
  assert.equal(calls, 1);
  assert.deepEqual(sent, ['callback_start', 'callback_attempt', 'callback_submit']);
});
