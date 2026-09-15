const test = require('node:test');
const assert = require('node:assert/strict');
const {campaign, payload, send, bind} = require('./callback.js');
const location = new URL('https://avokado38.ru/contacts.html');
const values = {name: '  Анна  ', contact: '+7 (933) 190-10-59', comment: 'После 17:00', consent: true};
const now = Date.parse('2026-09-15T12:00:00Z');
const stored = tags => ({getItem: () => JSON.stringify({...tags, first_seen: new Date(now).toISOString()})});
function transport(fetch) { return {fetch, AbortController, setTimeout: () => 1, clearTimeout() {}}; }

test('callback validates consent and fields before creating a request', () => {
  for (const [field, value] of [['name', '   '], ['name', 'я'.repeat(81)], ['contact', 'hello'],
    ['contact', '123'], ['contact', '123456789'], ['contact', '1'.repeat(16)], ['comment', 'я'.repeat(1001)], ['consent', false]]) {
    assert.throws(() => payload({...values, [field]: value}, location), error => error.field === field);
  }
  const result = payload(values, location);
  assert.equal(result.name, 'Анна');
  assert.equal(result.companyCode, 'avokado');
  assert.equal(result.channel, 'Обратный звонок');
  assert.equal(result.source, 'Сайт АВОКАДО');
  assert.equal(result.comment, values.comment);
});

test('current UTM replaces an earlier campaign; payload excludes unrelated query values', () => {
  const url = new URL(location.href + '?utm_source=yandex&utm_campaign=launch&name=Private&email=private@example.com');
  const body = payload(values, url, stored({utm_source: 'old', utm_medium: 'old-medium'}), now);
  assert.equal(body.source, 'yandex');
  assert.equal(body.utmCampaign, 'launch');
  assert.equal(body.utmMedium, undefined);
  assert.equal(body.landingPage, location.href);
  assert.ok(!JSON.stringify(body).includes('private@example.com'));
  assert.ok(!JSON.stringify(body).includes('Private'));
});

test('saved UTM survives page navigation for 30 days and denied storage does not block callbacks', () => {
  const storage = stored({utm_source: 'yandex', utm_content: 'creative'});
  assert.equal(payload(values, location, storage, now + 1000).utmContent, 'creative');
  assert.deepEqual(campaign(location, storage, now + 30 * 86400000), {});
  assert.equal(payload(values, location, {getItem() {throw Error('private mode');}}, now).source, 'Сайт АВОКАДО');
});

test('only CRM 201 with a positive id confirms a new callback; deduplication is a distinct result', async () => {
  let request;
  const result = await send(transport(async (...args) => {
    request = args;
    return {status: 201, ok: true, json: async () => ({id: 12, deduplicated: false})};
  }), payload(values, location));
  assert.deepEqual(result, {id: 12, repeated: false});
  assert.equal(request[0], '/api/leads');
  assert.equal(request[1].method, 'POST');
  assert.equal(request[1].credentials, 'omit');
  assert.equal(request[1].headers['Content-Type'], 'application/json');
  assert.deepEqual(await send(transport(async () => ({status: 200, ok: true,
    json: async () => ({id: 12, deduplicated: true})})), {}), {id: 12, repeated: true});
  for (const result of [{}, {id: 0}, {id: -1}, {id: '12'}, {id: 12, deduplicated: true}, {emailDelivered: true}]) {
    await assert.rejects(send(transport(async () => ({status: 201, ok: true, json: async () => result})), {}));
  }
  for (const status of [200, 202, 204]) {
    await assert.rejects(send(transport(async () => ({status, ok: true, json: async () => ({id: 12})})), {}));
  }
  await assert.rejects(send(transport(async () => ({status: 500, ok: false, json: async () => ({id: 12})})), {}));
  await assert.rejects(send(transport(async () => ({status: 429, ok: false})), {}), error => error.status === 429);
  await assert.rejects(send(transport(async () => ({status: 201, ok: true, json: async () => {throw Error('HTML response');}})), {}));
});

function formFixture(fetch) {
  const handlers = {};
  const inputs = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, {
    value, checked: value === true, validity: '', handlers: {},
    addEventListener(type, fn) {this.handlers[type] = fn;}, setCustomValidity(value) {this.validity = value;},
  }]));
  const button = {disabled: false, textContent: 'Заказать обратный звонок'};
  const fieldset = {disabled: false};
  const status = {textContent: '', dataset: {}, focus() {this.focused = true;}};
  const form = {
    dataset: {}, hidden: true, attributes: {}, resetCount: 0,
    elements: {namedItem: name => inputs[name]},
    querySelector: selector => selector === 'fieldset' ? fieldset : selector === '[type="submit"]' ? button : status,
    setAttribute(name, value) {this.attributes[name] = value;},
    addEventListener(type, fn) {handlers[type] = fn;},
    reportValidity() {return !Object.values(inputs).some(input => input.validity) && inputs.consent.checked;},
    reset() {this.resetCount++; for (const input of Object.values(inputs)) {input.value = ''; input.checked = false;}},
  };
  const win = {...transport(fetch), location};
  bind(win, form);
  return {win, form, inputs, button, fieldset, status, submit: () => handlers.submit({preventDefault() {}})};
}

test('form requires explicit consent; merely loading it makes no request', async () => {
  let calls = 0;
  const fixture = formFixture(async () => {calls++;});
  assert.equal(fixture.form.hidden, false);
  assert.equal(calls, 0);
  fixture.inputs.consent.checked = false;
  await fixture.submit();
  assert.equal(calls, 0);
  assert.match(fixture.inputs.consent.validity, /согласие/);
  fixture.inputs.consent.handlers.input();
  assert.equal(fixture.inputs.consent.validity, '');
});

test('pending prevents duplicate requests; accepted callback resets the form without email claims or analytics PII', async () => {
  let resolve, calls = 0;
  const fixture = formFixture(() => {calls++; return new Promise(done => {resolve = done;});});
  const pending = fixture.submit();
  assert.equal(fixture.button.disabled, true);
  assert.equal(fixture.fieldset.disabled, true);
  await fixture.submit();
  assert.equal(calls, 1);
  resolve({ok: true, status: 201, json: async () => ({id: 8})});
  await pending;
  assert.equal(fixture.button.disabled, false);
  assert.equal(fixture.fieldset.disabled, false);
  assert.equal(fixture.form.resetCount, 1);
  assert.equal(fixture.inputs.consent.checked, false);
  assert.match(fixture.status.textContent, /^Заявка сохранена/);
  assert.doesNotMatch(fixture.status.textContent, /почт|email|доставлен/i);
  assert.equal(fixture.win.dataLayer, undefined);
});

test('existing phone keeps new text and consent without pretending the request was saved again', async () => {
  const fixture = formFixture(async () => ({status: 200, ok: true,
    json: async () => ({id: 5, deduplicated: true, comment: 'Old comment must not replace the new text'})}));
  await fixture.submit();
  assert.equal(fixture.form.resetCount, 0);
  for (const [name, value] of Object.entries(values)) assert.equal(fixture.inputs[name].value, value);
  assert.equal(fixture.inputs.consent.checked, true);
  assert.equal(fixture.status.dataset.state, 'existing');
  assert.equal(fixture.status.textContent, 'Заявка с этим телефоном уже есть. Чтобы уточнить запрос, позвоните в студию или напишите нам.');
  assert.equal(fixture.button.disabled, false);
  assert.equal(fixture.status.focused, true);
  assert.equal(fixture.form.attributes['aria-busy'], 'false');
});

test('request timeout aborts the request, retains inputs and restores the button', async () => {
  let timeout, cleared = false, signal;
  const fixture = formFixture((url, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  fixture.win.setTimeout = (callback, delay) => {assert.equal(delay, 15000); timeout = callback; return 7;};
  fixture.win.clearTimeout = id => {assert.equal(id, 7); cleared = true;};
  const pending = fixture.submit();
  timeout();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(cleared, true);
  assert.equal(fixture.form.resetCount, 0);
  assert.equal(fixture.inputs.comment.value, values.comment);
  assert.equal(fixture.button.disabled, false);
  assert.equal(fixture.status.dataset.state, 'error');
  assert.match(fixture.status.textContent, /сохранены в форме/);
});

test('rate limits, offline failures and unconfirmed responses preserve every entered value and allow retry', async () => {
  for (const fetch of [async () => ({ok: false, status: 429}), async () => {throw TypeError('offline');},
    async () => ({ok: true, status: 200, json: async () => ({})})]) {
    const fixture = formFixture(fetch);
    await fixture.submit();
    assert.equal(fixture.form.resetCount, 0);
    for (const [name, value] of Object.entries(values)) assert.equal(fixture.inputs[name].value, value);
    assert.equal(fixture.inputs.consent.checked, true);
    assert.equal(fixture.button.disabled, false);
    assert.equal(fixture.fieldset.disabled, false);
    assert.equal(fixture.status.dataset.state, 'error');
    assert.match(fixture.status.textContent, /позвоните/);
    assert.match(fixture.status.textContent, /сохранены в форме/);
  }
});
