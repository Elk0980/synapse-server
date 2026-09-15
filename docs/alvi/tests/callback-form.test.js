'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '../../..');
const html = fs.readFileSync(path.join(repo, 'sites/alvi/index.html'), 'utf8');
const script = fs.readFileSync(path.join(repo, 'sites/alvi/callback.js'), 'utf8');
const caddy = fs.readFileSync(path.join(repo, 'caddy/Caddyfile'), 'utf8');

test('booking FAQ exposes Telegram, MAX and telephone links', () => {
  const answer = html.match(/<summary[^>]*>Как записаться\?<\/summary>\s*<p[^>]*>([\s\S]*?)<\/p>/)?.[1] || '';
  assert.match(answer, /href="https:\/\/t\.me\/\+79246180555"/);
  assert.match(answer, /href="https:\/\/max\.ru\/u\/f9LHodD0/);
  assert.match(answer, /href="tel:\+79246180555"/);
  assert.match(answer, /ежедневно 09:00–22:00 по предварительной записи/);
});

test('callback form requires consent and posts a company-scoped CRM lead', () => {
  assert.match(html, /id="callback-form"[\s\S]*?name="consent" type="checkbox" required/);
  assert.match(html, /<button type="submit" disabled>Перезвоните мне<\/button>/);
  assert.match(html, /href="politika\.html"/);
  assert.match(script, /validPhone\(phone\.value\)/);
  assert.match(script, /fetch\('\/api\/leads'/);
  assert.match(script, /companyCode: 'alvi'/);
  assert.match(script, /classList\.add\('is-success'\)/);
  assert.match(caddy, /path \/api\/leads[\s\S]*?rewrite \* \/leads[\s\S]*?reverse_proxy crm:8080/);
});

test('390px layout stacks full-width fields with a 48px button', () => {
  assert.match(html, /@media \(max-width: 600px\)[\s\S]*?\.callback-form__fields \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(html, /\.callback-form__fields button \{ width: 100%; height: 48px; \}/);
});

function fixture(fetchResponse) {
  const listeners = {}, timers = new Map(), requests = [];
  let timerId = 0;
  function element(value = '') {
    const classes = new Set(), attributes = new Map();
    return {
      value, checked: false, disabled: false, textContent: '', focused: false,
      classList: {add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key)},
      setAttribute: (key, value) => attributes.set(key, value),
      getAttribute: key => attributes.get(key), removeAttribute: key => attributes.delete(key),
      focus() { this.focused = true; },
    };
  }
  const name = element('Тестовая заявка'), phone = element('+7 924 618-05-55'), consent = element();
  consent.checked = true;
  const button = element(), status = element(), form = element();
  form.elements = {name, phone, consent};
  form.querySelector = selector => selector === '[type="submit"]' ? button : status;
  form.addEventListener = (type, listener) => { listeners[type] = listener; };
  vm.runInNewContext(script, {
    document: {getElementById: () => form, referrer: ''},
    location: {search: '?utm_source=test', pathname: '/', href: 'https://spaalvi-38.ru/?utm_source=test'},
    URLSearchParams, AbortController,
    setTimeout(callback, delay) { timers.set(++timerId, {callback, delay}); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch(url, options) {
      requests.push({url, options, body: JSON.parse(options.body)});
      return fetchResponse(url, options);
    },
  });
  return {name, phone, consent, button, status, form, requests, timers,
    input() { listeners.input(); },
    submit() { return listeners.submit({preventDefault() {}}); },
  };
}
const response = (status, body) => ({status, ok: status >= 200 && status < 300, async json() { return body; }});

test('pending callback cannot be unlocked by input or submitted twice; confirmed completion stays complete', async () => {
  let resolve;
  const view = fixture(() => new Promise(done => { resolve = done; }));
  const pending = view.submit();
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].url, '/api/leads');
  assert.equal(view.requests[0].body.companyCode, 'alvi');
  assert.equal(view.requests[0].body.source, 'test');
  assert.equal(view.form.getAttribute('aria-busy'), 'true');
  for (const control of [view.name, view.phone, view.consent, view.button]) assert.equal(control.disabled, true);
  view.name.value = 'Изменённое имя';
  view.input();
  assert.equal(view.button.disabled, true, 'input must not clear pending state');
  await view.submit();
  assert.equal(view.requests.length, 1, 'submit handler also guards against overlapping events');
  resolve(response(201, {id: 42, deduplicated: false}));
  await pending;
  assert.equal(view.form.classList.contains('is-success'), true);
  assert.equal(view.status.textContent, 'Заявка принята. Спасибо за обращение!');
  assert.equal(view.form.getAttribute('aria-busy'), 'false');
  assert.equal(view.timers.size, 0);
  view.input();
  await view.submit();
  assert.equal(view.requests.length, 1, 'a completed hidden form cannot submit again');
});

test('deduplicated callback preserves input and explains that an existing request was found', async () => {
  const view = fixture(async () => response(200, {id: 42, deduplicated: true, comment: 'Old server comment'}));
  const originalName = view.name.value, originalPhone = view.phone.value;
  await view.submit();
  assert.match(view.status.textContent, /Заявка с этим телефоном уже есть/);
  assert.match(view.status.textContent, /Чтобы уточнить запрос, позвоните/);
  assert.doesNotMatch(view.status.textContent, /Заявка принята|Заявка отправлена|Old server comment/);
  assert.equal(view.form.classList.contains('is-success'), false);
  assert.equal(view.name.value, originalName);
  assert.equal(view.phone.value, originalPhone);
  for (const control of [view.name, view.phone, view.consent, view.button]) assert.equal(control.disabled, false);
});

test('only the confirmed 201/new or 200/deduplicated contract can produce a positive result', async () => {
  const invalid = [
    response(200, {id: 1}), response(200, {id: 1, deduplicated: false}),
    response(201, {id: 1, deduplicated: true}), response(204, {id: 1}),
    ...[undefined, null, 0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1].map(id => response(201, {id})),
    {status: 201, ok: true, async json() { throw new Error('Invalid JSON with internal details'); }},
    response(500, {error: 'Internal server details'}),
  ];
  for (const result of invalid) {
    const view = fixture(async () => result);
    await view.submit();
    assert.equal(view.form.classList.contains('is-success'), false);
    assert.equal(view.status.classList.contains('is-error'), true);
    assert.match(view.status.textContent, /Не удалось подтвердить/);
    assert.doesNotMatch(view.status.textContent, /Internal|Invalid JSON/);
    assert.equal(view.name.value, 'Тестовая заявка');
    assert.equal(view.phone.value, '+7 924 618-05-55');
    assert.equal(view.button.disabled, false);
    assert.equal(view.form.getAttribute('aria-busy'), 'false');
    assert.equal(view.timers.size, 0);
  }
});

test('rate limiting and network failures keep the request editable and allow a deliberate retry', async () => {
  let attempts = 0;
  const view = fixture(async () => {
    attempts++;
    if (attempts === 1) return response(429, {});
    if (attempts === 2) throw new Error('offline');
    return response(201, {id: 73, deduplicated: false});
  });
  await view.submit();
  assert.match(view.status.textContent, /Подождите несколько минут/);
  assert.equal(view.button.disabled, false);
  await view.submit();
  assert.match(view.status.textContent, /Не удалось подтвердить/);
  assert.equal(view.button.disabled, false);
  await view.submit();
  assert.equal(view.form.classList.contains('is-success'), true);
  assert.equal(view.status.classList.contains('is-error'), false);
  assert.equal(attempts, 3);
});

test('an unanswered request times out without showing success or losing the entered contact', async () => {
  const view = fixture((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
  }));
  const pending = view.submit();
  const [timer] = view.timers.values();
  assert.equal(timer.delay, 15000);
  timer.callback();
  await pending;
  assert.equal(view.requests[0].options.signal.aborted, true);
  assert.equal(view.form.classList.contains('is-success'), false);
  assert.equal(view.button.disabled, false);
  assert.equal(view.phone.value, '+7 924 618-05-55');
  assert.equal(view.timers.size, 0);
});

test('submit validation also protects required consent, name and phone when native validation is disabled', async () => {
  for (const change of [view => { view.consent.checked = false; }, view => { view.name.value = ' '; },
    view => { view.name.value = 'x'.repeat(81); }, view => { view.phone.value = '123'; }]) {
    const view = fixture(async () => response(201, {id: 1, deduplicated: false}));
    change(view);
    await view.submit();
    assert.equal(view.requests.length, 0);
    assert.equal(view.status.classList.contains('is-error'), true);
  }
});
