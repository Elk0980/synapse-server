'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function fixture(t) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://cabinet.test/' });
  t.after(() => dom.window.close());
  const w = dom.window, calls = [];
  const state = { user: { userId: 7, role: 'owner', csrfToken: 'csrf-alice' }, readOnly: false };
  let directFetches = 0;
  w.fetch = () => { directFetches++; throw Error('Прямой fetch запрещён'); };
  w.eval(fs.readFileSync(path.join(__dirname, 'module-registry.js'), 'utf8'));
  w.SynapseModules.attachShell({
    identity: () => state.user,
    company: () => ({ id: 'alvi', name: 'ALVI' }),
    apiJson: async (url, options) => {
      calls.push({ url, options });
      if (state.readOnly && options.method) throw Object.assign(Error('readonly'), { status: 403 });
      return { ok: true };
    },
    crmQuery() { throw Error('CRM не используется'); }, navigate() {}, escapeHTML: value => value
  });
  const abort = new w.AbortController();
  const ctx = w.SynapseModules.createContext('chats', { path: 'chats', query: '' }, abort.signal);
  return { ctx, calls, state, abort, directFetches: () => directFetches };
}

test('четвёртый аргумент закрепляет CSRF отправителя и сохраняет общий API, компанию, body и signal', async t => {
  const f = fixture(t), body = { text: 'Черновик Alice', room: 'common', clientMessageId: 'same-id' };
  f.state.user = { userId: 8, role: 'owner', csrfToken: 'csrf-bob' };
  await f.ctx.api.post('people/team-chat', body, { before: 9 }, { csrfToken: 'csrf-alice' });
  const { url, options } = f.calls[0];
  assert.equal(url, '/content/people/team-chat?companyCode=alvi&before=9');
  assert.equal(options.method, 'POST');
  assert.equal(options.signal, f.abort.signal);
  assert.equal(options.body, JSON.stringify(body));
  assert.equal(options.headers['X-CSRF-Token'], 'csrf-alice');
  assert.equal(f.directFetches(), 0);
});

test('явный пустой CSRF не заменяется текущим, унаследованное поле не считается явным', async t => {
  const f = fixture(t);
  await f.ctx.api.post('people/team-chat', {}, undefined, { csrfToken: '' });
  await f.ctx.api.post('people/team-chat', {}, undefined, Object.create({ csrfToken: 'foreign' }));
  assert.equal(f.calls[0].options.headers['X-CSRF-Token'], '');
  assert.equal(f.calls[1].options.headers['X-CSRF-Token'], 'csrf-alice');
});

test('прежние три аргумента используют текущий CSRF; GET и DELETE сохраняют контракт', async t => {
  const f = fixture(t);
  f.state.user = { userId: 8, role: 'editor', csrfToken: 'csrf-bob' };
  for (const method of ['post', 'put', 'patch']) await f.ctx.api[method]('content-settings', { n: 1 }, { version: 2 });
  await f.ctx.api.del('content-settings', { version: 2 });
  await f.ctx.api.get('whoami');
  assert.deepEqual(f.calls.slice(0, 4).map(call => call.options.method), ['POST', 'PUT', 'PATCH', 'DELETE']);
  for (const { url, options } of f.calls.slice(0, 4)) {
    assert.equal(url, '/content/content-settings?companyCode=alvi&version=2');
    assert.equal(options.headers['X-CSRF-Token'], 'csrf-bob');
    assert.equal(options.signal, f.abort.signal);
  }
  assert.equal(Object.hasOwn(f.calls[3].options, 'body'), false);
  assert.equal(f.calls[4].url, '/content/whoami?companyCode=alvi');
  assert.equal(Object.hasOwn(f.calls[4].options, 'method'), false);
});

test('закреплённый токен не обходит перехватчик записи оболочки', async t => {
  const f = fixture(t);
  f.state.readOnly = true;
  await assert.rejects(f.ctx.api.post('people/team-chat', { room: 'common' }, undefined, { csrfToken: 'csrf-alice' }), { status: 403 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.headers['X-CSRF-Token'], 'csrf-alice');
  assert.equal(f.directFetches(), 0);
});

test('ctx.company: код и название компании, часовой пояс только из оболочки (иначе null)', t => {
  const f = fixture(t);
  assert.equal(f.ctx.company.code, 'alvi');
  assert.equal(f.ctx.company.name, 'ALVI');
  assert.equal(f.ctx.company.timeZone, null, 'оболочка пояс не знает — не выдумываем');
  assert.ok(Object.isFrozen(f.ctx.company));
});
