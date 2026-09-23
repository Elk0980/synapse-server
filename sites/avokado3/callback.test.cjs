const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
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

test('callback reuses the visit identifier without creating one and honors DoNotTrack', () => {
  const storage = {getItem: key => key === 'synapse_cid' ? 'existing-visitor' : JSON.stringify({utm_source:'vk',first_seen:new Date(now).toISOString()})};
  assert.equal(payload(values,location,storage,now).clientId,'existing-visitor');
  assert.equal(payload(values,location,storage,now).utmSource,'vk');
  const privateBody=payload(values,location,storage,now,true);
  assert.equal(privateBody.clientId,undefined);assert.equal(privateBody.utmSource,undefined);
  assert.equal(payload(values,location,{getItem(){throw Error('denied');}},now).clientId,undefined);
  assert.equal(payload(values,location,{getItem:()=>null},now).clientId,undefined);
  const current=payload(values,new URL(location+'?utm_source=yandex'),storage,now,true);
  assert.equal(current.utmSource,'yandex');assert.equal(current.clientId,undefined);
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

const settle = () => new Promise(resolve => setImmediate(resolve));
function commentFixture(page, fetch) {
  const html = fs.readFileSync(__dirname + '/' + page, 'utf8');
  const markup = html.match(/<form data-callback-form[\s\S]*?<\/form>/)?.[0];
  assert.ok(markup, page + ' must contain its actual callback form');
  const dom = new JSDOM(markup, {url: 'https://avokado38.ru/' + page, runScripts: 'outside-only'});
  const win = dom.window, form = win.document.querySelector('form'), controls = form.elements;
  win.fetch = fetch; bind(win, form);
  controls.name.value = values.name; controls.contact.value = values.contact; controls.consent.checked = true;
  return {dom, form, controls, field: form.querySelector('.av-callback-comment'),
    toggle() {controls.addComment.click();},
    async submit() {form.dispatchEvent(new win.Event('submit', {bubbles: true, cancelable: true})); await settle();},
    close() {win.close();}
  };
}

test('both public forms start with a compact disabled comment hidden behind the accessible optional checkbox', () => {
  for (const page of ['index.html', 'contacts.html']) {
    let calls = 0; const f = commentFixture(page, () => {calls++;});
    try {
      assert.equal(f.controls.comment.rows, 2); assert.equal(f.controls.comment.required, false);
      assert.equal(f.controls.addComment.checked, false); assert.equal(f.field.hidden, true); assert.equal(f.controls.comment.disabled, true);
      assert.equal(f.controls.addComment.getAttribute('aria-controls'), f.field.id);
      assert.equal(f.controls.addComment.getAttribute('aria-expanded'), 'false');
      f.toggle(); assert.equal(f.field.hidden, false); assert.equal(f.controls.comment.disabled, false);
      assert.equal(f.controls.addComment.getAttribute('aria-expanded'), 'true');
      assert.equal(f.dom.window.document.activeElement, f.controls.comment);
      assert.equal(calls, 0);
    } finally {f.close();}
  }
});

test('enabled multiline comment is sent and CRM acceptance collapses and clears the comment on both pages', async () => {
  for (const page of ['index.html', 'contacts.html']) {
    let body;
    const f = commentFixture(page, async(url, options) => {body = JSON.parse(options.body); return {ok: true, status: 201, json: async() => ({id: 42})};});
    try {
      f.toggle(); f.controls.comment.value = '  Интересует процедура.\nУдобно после 18:00.  '; await f.submit();
      assert.equal(body.comment, 'Интересует процедура.\nУдобно после 18:00.'); assert.equal(body.companyCode, 'avokado');
      assert.equal(Object.hasOwn(body, 'addComment'), false);
      assert.equal(f.controls.addComment.checked, false); assert.equal(f.controls.comment.value, '');
      assert.equal(f.controls.comment.disabled, true); assert.equal(f.field.hidden, true);
      assert.equal(f.controls.addComment.getAttribute('aria-expanded'), 'false'); assert.equal(f.controls.consent.checked, false);
      assert.match(f.form.querySelector('[data-callback-status]').textContent, /^Заявка сохранена/);
    } finally {f.close();}
  }
});

test('unchecking the comment excludes its old text and old validation error from the submitted callback', async () => {
  let body, calls = 0;
  const f = commentFixture('index.html', async(url, options) => {calls++; body = JSON.parse(options.body); return {ok: true, status: 201, json: async() => ({id: 42})};});
  try {
    f.toggle(); f.controls.comment.value = 'я'.repeat(1001); await f.submit();
    assert.equal(calls, 0); assert.equal(f.controls.comment.validity.customError, true);
    f.toggle(); assert.equal(f.controls.comment.value.length, 1001); assert.equal(f.controls.comment.disabled, true);
    assert.equal(f.controls.comment.validity.customError, false); await f.submit();
    assert.equal(calls, 1); assert.equal(body.comment, ''); assert.ok(!JSON.stringify(body).includes('я'.repeat(1001)));
  } finally {f.close();}
});

test('failed and duplicate requests keep the selected comment; a later unchecked retry sends none of that text', async () => {
  for (const duplicate of [false, true]) {
    const bodies = [];
    const f = commentFixture('contacts.html', async(url, options) => {
      bodies.push(JSON.parse(options.body));
      if (!duplicate) throw Error('offline');
      return {ok: true, status: 200, json: async() => ({id: 42, deduplicated: true})};
    });
    try {
      f.toggle(); f.controls.comment.value = 'Перезвонить после 18:00'; await f.submit();
      assert.equal(f.controls.comment.value, 'Перезвонить после 18:00'); assert.equal(f.controls.addComment.checked, true);
      assert.equal(f.field.hidden, false); assert.equal(f.controls.comment.disabled, false);
      assert.equal(f.controls.consent.checked, true);
      assert.equal(f.form.querySelector('[data-callback-status]').dataset.state, duplicate ? 'existing' : 'error');
      f.toggle(); await f.submit();
      assert.equal(bodies[0].comment, 'Перезвонить после 18:00'); assert.equal(bodies[1].comment, '');
      assert.equal(f.controls.comment.value, 'Перезвонить после 18:00'); assert.equal(f.field.hidden, true);
    } finally {f.close();}
  }
});

test('native form reset restores the collapsed comment after resetting checkbox defaults', async () => {
  const f = commentFixture('index.html', () => assert.fail('reset must never submit'));
  try {
    f.toggle(); f.controls.comment.value = 'Old draft'; f.form.reset(); await settle();
    assert.equal(f.controls.addComment.checked, false); assert.equal(f.controls.comment.value, '');
    assert.equal(f.controls.comment.disabled, true); assert.equal(f.field.hidden, true);
    assert.equal(f.controls.addComment.getAttribute('aria-expanded'), 'false');
  } finally {f.close();}
});
