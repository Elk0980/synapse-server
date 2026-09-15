const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./leads.js'), 'utf8');
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,
  character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));

async function openLead(lead) {
  let view;
  const calls = [];
  const elements = new Map();
  const byId = id => {
    if (!elements.has(id)) elements.set(id, {innerHTML: '', handlers: {},
      addEventListener(type, handler) {this.handlers[type] = handler;}});
    return elements.get(id);
  };
  const window = {SbCabinet: {registerView(name, descriptor) {assert.equal(name, 'crm'); view = descriptor;}}};
  vm.runInNewContext(source, {window, document: {querySelectorAll: () => []}});
  view.initialize({identity: {permissions: ['crm.view']}, byId, escapeHTML,
    crmQuery: async path => {calls.push(path); return lead;},
    csrfOptions() {throw Error('opening a lead must not write');}, scopeParams: () => ({}), formatMoney: String});
  await byId('crm-content').handlers.click({target: {closest: () => ({dataset: {crmLeadId: '42'}})}});
  return {html: byId('crm-lead-details').innerHTML, calls, window};
}

test('lead card exposes the stored callback comment as escaped multiline text without writes or analytics', async () => {
  const comment = 'После 17:00\n<img src=x onerror=alert(1)> & "спасибо"';
  const result = await openLead({name: 'Анна', comment, utmSource: 'yandex'});
  assert.deepEqual(result.calls, ['/leads/42']);
  assert.match(result.html, /Комментарий к заявке/);
  assert.ok(result.html.includes(escapeHTML(comment)));
  assert.ok(!result.html.includes('<img'));
  assert.match(result.html, /white-space:pre-wrap/);
  assert.match(result.html, /<dt>utmSource<\/dt><dd>yandex<\/dd>/);
  assert.equal(result.window.dataLayer, undefined);
});

test('lead cards without a comment do not invent one or lose attribution', async () => {
  for (const comment of [undefined, null, '   ']) {
    const {html} = await openLead({name: 'Анна', comment, utmCampaign: 'launch'});
    assert.doesNotMatch(html, /Комментарий к заявке/);
    assert.match(html, /<dt>utmCampaign<\/dt><dd>launch<\/dd>/);
  }
});
