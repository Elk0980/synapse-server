const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM, VirtualConsole} = require('jsdom');
const source = fs.readFileSync(require.resolve('./campaigns.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const campaign = (changes = {}) => ({id: 1, companyCode: 'avokado', name: 'Сентябрь', subject: 'Приглашение', text: 'Здравствуйте!\nТекст письма.', status: 'draft',
  counts: {pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0}, ...changes});

async function fixture({role = 'owner', entries = [campaign()], sender = true, eligible = 1, override, subscriptions = []} = {}) {
  const views = {}, calls = [], errors = [], stored = entries.map(clone);
  const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<main><section id="campaigns-view"></section></main>', {url: 'https://cabinet.test/cabinet.html#campaigns', runScripts: 'outside-only', virtualConsole: vc});
  const w = dom.window, d = w.document;
  w.SbCabinet = {registerView: (name, view) => {views[name] = view;}};
  w.eval(source);
  const apiJson = async (url, options = {}) => {
    const parsed = new URL(url, 'https://cabinet.test');
    const call = {url, path: parsed.pathname, companyCode: parsed.searchParams.get('companyCode'), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers};
    calls.push(call);
    if (call.method !== 'GET') assert.equal(call.headers['X-CSRF-Token'], 'fixture-csrf');
    if (override) {const result = await override(call); if (result !== undefined) return clone(result);}
    if (call.path === '/content/crm/email-subscriptions') {
      if (call.method === 'PUT') {
        const item = {id: 9, ...call.body};
        subscriptions = [item, ...subscriptions.filter(row => row.email !== item.email)];
        return clone(item);
      }
      return {subscriptions: clone(subscriptions)};
    }
    if (call.path === '/content/crm/email-campaigns') {
      if (call.method === 'POST') {
        const item = campaign({...call.body, id: 100}); stored.push(item); return clone(item);
      }
      return {campaigns: clone(stored.filter(item => item.companyCode === call.companyCode))};
    }
    const match = call.path.match(/^\/content\/crm\/email-campaigns\/(\d+)(?:\/(preview|launch|pause))?$/);
    assert.ok(match, 'unexpected route ' + call.path);
    const item = stored.find(row => row.id === Number(match[1]) && row.companyCode === call.companyCode);
    assert.ok(item, 'campaign must belong to requested company');
    if (match[2] === 'preview') return {campaign: clone(item), recipients: [{email: 'subscribed@example.test', name: '<img src=x onerror=1>', status: 'subscribed'}],
      previewToken: 'fixture-reviewed-state', counts: {eligible, unknown: 7, unsubscribed: 2, invalid: 1, duplicate: 3}, sender: {address: 'sender@example.test', configured: sender}, canLaunch: sender && eligible > 0};
    if (match[2] === 'launch') {assert.deepEqual(call.body, {confirm: true, previewToken: 'fixture-reviewed-state'}); item.status = 'running'; item.counts.pending = eligible;}
    else if (match[2] === 'pause') item.status = 'paused';
    else if (call.method === 'PATCH') Object.assign(item, call.body);
    return clone(item);
  };
  const context = {identity: {role, companies: [{id: 'avokado', name: 'Авокадо'}, {id: 'alvi', name: 'АЛВИ'}]}, selectedProjectId: 'avokado', apiJson,
    csrfOptions: (method, body) => ({method, headers: {'X-CSRF-Token': 'fixture-csrf'}, body: JSON.stringify(body)})};
  await views.campaigns.render(d.getElementById('campaigns-view'), context);
  const f = {w, d, calls, errors, stored, views, context, node: id => d.getElementById(id),
    settle: async () => {for (let i = 0; i < 8; i++) await tick();},
    set(id, value, type = 'input') {const node = d.getElementById(id); node.value = value; node.dispatchEvent(new w.Event(type, {bubbles: true}));},
    async click(id) {d.getElementById(id).click(); await f.settle();},
    async select(id = '1') {f.set('campaign-select', id, 'change'); await f.settle();},
    close() {w.close();}};
  return f;
}

test('owner view loads only scoped reads; other roles cannot initialize the form or call APIs', async () => {
  for (const role of ['owner', 'admin', 'marketer']) {
    const f = await fixture({role});
    try {
      assert.equal(f.calls.length, role === 'owner' ? 2 : 0);
      assert.equal(!!f.node('campaign-form'), role === 'owner');
      assert.ok(f.calls.every(call => call.method === 'GET' && call.companyCode === 'avokado'));
      if (role === 'owner') {
        assert.equal(f.node('campaign-launch').disabled, true);
        assert.equal(f.node('subscription-state').value, 'unknown');
        assert.equal(f.node('subscription-date').value, '', 'never invent a consent date');
      }
      assert.deepEqual(f.errors, []);
    } finally {f.close();}
  }
});

test('saving a new draft is an explicit CSRF POST; changing fields alone never saves or sends', async () => {
  const f = await fixture();
  try {
    f.set('campaign-name', 'Новый черновик'); f.set('campaign-subject', 'Тема'); f.set('campaign-text', 'Обычный текст <b>без HTML</b>');
    assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
    await f.click('campaign-save');
    const writes = f.calls.filter(call => call.method !== 'GET');
    assert.equal(writes.length, 1); assert.equal(writes[0].method, 'POST');
    assert.equal(writes[0].body.companyCode, 'avokado');
    assert.equal(writes[0].body.text, 'Обычный текст <b>без HTML</b>');
    assert.equal(f.node('campaign-select').value, '100');
    assert.equal(f.node('campaign-preview').disabled, false);
    assert.equal(f.node('campaign-launch').disabled, true);
    assert.equal(f.node('campaign-name').maxLength, 120);
    assert.equal(f.node('campaign-subject').maxLength, 180);
  } finally {f.close();}
});

test('review displays saved plain text and exclusions, escapes recipient data, and requires explicit confirmation', async () => {
  const f = await fixture({entries: [campaign({text: '<script>bad()</script>\nТекст'})]});
  try {
    await f.select(); await f.click('campaign-preview');
    const review = f.node('campaign-review');
    assert.equal(review.querySelector('.campaigns-message').textContent, '<script>bad()</script>\nТекст');
    assert.equal(review.querySelector('script, img'), null);
    assert.match(review.textContent, /Могут получить письмо1/);
    assert.match(review.textContent, /согласие неизвестно7/);
    assert.match(review.textContent, /отписались2/);
    assert.equal(f.node('campaign-confirm').checked, false);
    assert.equal(f.node('campaign-launch').disabled, true);
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
    await f.click('campaign-confirm'); await f.click('campaign-launch');
    assert.equal(f.calls.filter(call => call.path.endsWith('/launch')).length, 1);
    assert.equal(f.node('campaign-state').textContent, 'Отправляется');
    assert.equal(f.node('campaign-launch').disabled, true);
    assert.equal(f.node('campaign-pause').hidden, false);
  } finally {f.close();}
});

test('missing SMTP or eligible recipients blocks launch even when checkbox is set programmatically', async () => {
  for (const configuration of [{sender: false}, {eligible: 0}]) {
    const f = await fixture(configuration);
    try {
      await f.select(); await f.click('campaign-preview');
      f.node('campaign-confirm').checked = true;
      f.node('campaign-launch').dispatchEvent(new f.w.Event('click'));
      await f.settle();
      assert.equal(f.node('campaign-launch').disabled, true);
      assert.equal(f.calls.some(call => call.path.endsWith('/launch')), false);
    } finally {f.close();}
  }
});

test('editing a reviewed draft invalidates confirmation and requires saving then a fresh preview', async () => {
  const f = await fixture();
  try {
    await f.select(); await f.click('campaign-preview'); await f.click('campaign-confirm');
    assert.equal(f.node('campaign-launch').disabled, false);
    f.set('campaign-text', 'Изменённый текст');
    assert.equal(f.node('campaign-confirm').checked, false);
    assert.equal(f.node('campaign-preview').disabled, true);
    assert.equal(f.node('campaign-launch').disabled, true);
    await f.click('campaign-save'); await f.click('campaign-preview');
    assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
    assert.equal(f.node('campaign-review').querySelector('pre').textContent, 'Изменённый текст');
    assert.equal(f.node('campaign-confirm').checked, false);
  } finally {f.close();}
});

test('subscription changes require a source and actual past consent date, never automatically subscribe CRM contacts', async () => {
  const f = await fixture();
  try {
    await f.select(); await f.click('campaign-preview'); await f.click('campaign-confirm');
    f.set('subscription-email', 'client@example.test');
    f.set('subscription-state', 'subscribed', 'change');
    await f.click('subscription-save');
    assert.equal(f.calls.some(call => call.method === 'PUT'), false);
    f.set('subscription-source', 'Подписанная форма от 01.01.2020');
    f.set('subscription-date', '2099-01-01T10:00'); await f.click('subscription-save');
    assert.equal(f.calls.some(call => call.method === 'PUT'), false);
    f.set('subscription-date', '2020-01-01T10:00'); await f.click('subscription-save');
    const writes = f.calls.filter(call => call.method === 'PUT');
    assert.equal(writes.length, 1); assert.equal(writes[0].body.status, 'subscribed');
    assert.equal(writes[0].body.source, 'Подписанная форма от 01.01.2020');
    assert.ok(!Number.isNaN(new Date(writes[0].body.consentedAt).getTime()));
    assert.equal(f.node('campaign-launch').disabled, true);
    assert.equal(f.node('campaign-confirm').checked, false);
    assert.equal(f.node('subscription-state').value, 'unknown');
    assert.match(f.node('campaign-subscriptions').textContent, /client@example.test/);
    f.set('subscription-email', 'client@example.test'); f.set('subscription-state', 'unsubscribed', 'change');
    f.set('subscription-source', 'Просьба клиента'); await f.click('subscription-save');
    const optout = f.calls.filter(call => call.method === 'PUT')[1];
    assert.equal(optout.body.status, 'unsubscribed');
    assert.equal('consentedAt' in optout.body, false);
  } finally {f.close();}
});

test('launch sends one reviewed token, locks controls while pending, and permits pause then reviewed resume', async () => {
  let resolveLaunch;
  const f = await fixture({override: call => call.path.endsWith('/launch') && !resolveLaunch ? new Promise(resolve => {resolveLaunch = resolve;}) : undefined});
  try {
    await f.select(); await f.click('campaign-preview'); await f.click('campaign-confirm');
    f.node('campaign-launch').click(); await f.settle();
    assert.equal(f.node('campaign-company').disabled, true);
    assert.equal(f.node('subscription-email').disabled, true);
    f.node('campaign-launch').dispatchEvent(new f.w.Event('click'));
    assert.equal(f.calls.filter(call => call.path.endsWith('/launch')).length, 1);
    const launch = f.calls.find(call => call.path.endsWith('/launch'));
    assert.equal(launch.body.previewToken, 'fixture-reviewed-state');
    Object.assign(f.stored[0], {status: 'running'});
    resolveLaunch(f.stored[0]); await f.settle();
    await f.click('campaign-pause');
    assert.equal(f.node('campaign-state').textContent, 'Приостановлена');
    assert.equal(f.node('campaign-launch').textContent, 'Продолжить рассылку');
    assert.equal(f.node('campaign-text').disabled, true);
    await f.click('campaign-preview'); await f.click('campaign-confirm'); await f.click('campaign-launch');
    assert.equal(f.calls.filter(call => call.path.endsWith('/launch')).length, 2);
  } finally {f.close();}
});

test('ambiguous launch failure clears review and does not display raw server errors or retry automatically', async () => {
  const f = await fixture({override: call => {if (call.path.endsWith('/launch')) throw new Error('SMTP credential PRIVATE_SENTINEL recipient@private.test');}});
  try {
    await f.select(); await f.click('campaign-preview'); await f.click('campaign-confirm'); await f.click('campaign-launch');
    assert.equal(f.calls.filter(call => call.path.endsWith('/launch')).length, 1);
    assert.equal(f.node('campaign-confirm').checked, false);
    assert.equal(f.node('campaign-launch').disabled, true);
    assert.match(f.node('campaign-status').textContent, /Обновите статусы/);
    assert.doesNotMatch(f.d.body.textContent, /PRIVATE_SENTINEL|recipient@private/);
  } finally {f.close();}
});

test('draft text survives a failed save and switching companies without being sent to a different company', async () => {
  const f = await fixture({override: call => {if (call.method === 'PATCH') throw new Error('network failure');}});
  try {
    await f.select(); f.set('campaign-text', 'Несохранённый текст Авокадо'); await f.click('campaign-save');
    assert.equal(f.node('campaign-text').value, 'Несохранённый текст Авокадо');
    f.set('campaign-company', 'alvi', 'change'); await f.settle();
    assert.equal(f.node('campaign-text').value, '');
    f.set('campaign-text', 'Отдельный черновик АЛВИ');
    f.set('campaign-company', 'avokado', 'change'); await f.settle(); await f.select();
    assert.equal(f.node('campaign-text').value, 'Несохранённый текст Авокадо');
    assert.ok(f.calls.filter(call => call.method !== 'GET').every(call => call.companyCode === 'avokado'));
  } finally {f.close();}
});

test('late response from the previously selected company cannot replace the current company view', async () => {
  let resolveAlvi;
  const f = await fixture({override: call => call.companyCode === 'alvi' && call.path.endsWith('/email-campaigns') ? new Promise(resolve => {resolveAlvi = resolve;}) : undefined});
  try {
    const switchAlvi = f.views.campaigns.onProjectChange({...f.context, selectedProjectId: 'alvi'});
    await f.settle();
    await f.views.campaigns.onProjectChange(f.context);
    resolveAlvi({campaigns: [campaign({id: 999, companyCode: 'alvi', name: 'Не текущая компания'})]});
    await switchAlvi;
    assert.equal(f.node('campaign-company').value, 'avokado');
    assert.doesNotMatch(f.node('campaign-select').textContent, /Не текущая компания/);
    assert.equal(f.node('campaign-company').disabled, false);
  } finally {f.close();}
});

test('paused SMTP failures show safe actionable reasons and settings link without exposing unknown server text', async () => {
  for (const [code, expected] of [['SMTP_AUTH', /Не удалось войти/], ['SMTP_SENDER', /отклонил отправителя/],
    ['SMTP_NOT_CONFIGURED', /не заполнены или изменились/], ['PRIVATE_RAW_SMTP_PASSWORD', /Произошла ошибка отправки/]]) {
    const f = await fixture({entries: [campaign({status: 'paused', lastErrorCode: code})]});
    try {
      await f.select();
      const reason = f.node('campaign-reason');
      assert.equal(reason.hidden, false); assert.match(reason.textContent, expected);
      assert.equal(reason.querySelector('a').getAttribute('href'), '#settings');
      assert.doesNotMatch(f.d.body.textContent, /PRIVATE_RAW_SMTP_PASSWORD/);
      assert.equal(f.calls.some(call => call.method !== 'GET'), false);
    } finally {f.close();}
  }
});
