'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const escapeHTML = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const snapshot = (date = '2026-09-17T12:00:00Z') => ({ sourceStats: [
  { source: 'vk-ads', external: { pageViews: 0 }, externalCapturedAt: date }
] });
function fixture(permissions = ['analytics.view', 'crm.view', 'crm.edit']) {
  const dom = new JSDOM('<p id="project-name">АЛВИ</p><section id="ad-platforms-content"></section>', {
    url: 'https://cabinet.example.test/cabinet.html#ad-platforms', runScripts: 'outside-only'
  });
  const w = dom.window, d = w.document, views = {}, calls = [];
  w.SbCabinet = { registerView(name, view) { views[name] = view; } };
  for (const name of ['analytics.js', 'ad-platforms.js']) w.eval(fs.readFileSync(__dirname + '/' + name, 'utf8'));
  const context = {
    identity: { permissions }, selectedProjectId: 'alvi', currentView: 'ad-platforms',
    byId: id => d.getElementById(id), escapeHTML,
    scopeParams: () => ({ companyCode: context.selectedProjectId }),
    periodDates: () => ({ from: '2026-08-18', to: '2026-09-17' }),
    csrfOptions: (method, body) => ({ method, headers: { 'X-CSRF-Token': 'mock-csrf' }, body: JSON.stringify(body) }),
    crmQuery: (path, params, options = {}) => new Promise((resolve, reject) => calls.push({
      path, params: JSON.parse(JSON.stringify(params)), options, body: options.body ? JSON.parse(options.body) : null, resolve, reject
    }))
  };
  const content = d.getElementById('ad-platforms-content');
  return {
    dom, w, d, calls, context, content,
    render() { views['ad-platforms'].render(content, context); },
    change(companyCode) {
      context.selectedProjectId = companyCode; d.getElementById('project-name').textContent = companyCode === 'avokado' ? 'Авокадо' : companyCode;
      views['ad-platforms'].onProjectChange(context);
    },
    async reply(index, payload) { calls[index].resolve(payload); await tick(); },
    async fail(index) { calls[index].reject(new Error('mock request failed')); await tick(); },
    open() { content.querySelector('[data-platform="vk"] button, button[data-platform="vk"]').click(); return content.querySelector('form'); },
    submit(form) { form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); },
    close() { w.close(); }
  };
}

test('external statistics remain a manual snapshot, including zero; overview keeps selected-company navigation', async () => {
  const f = fixture(); try {
    f.render(); await f.reply(0, snapshot());
    assert.match(f.content.textContent, /Реклама компании АЛВИ/);
    assert.match(f.content.textContent, /Объявление → заявка → запись → визит → абонемент/);
    assert.match(f.content.textContent, /Ручной снимок от 17\.09\.2026/);
    assert.equal(f.content.querySelector('.is-connected'), null);
    assert.doesNotMatch(f.content.textContent, /подключено/);
    assert.ok(f.content.querySelector('a[href="#crm"]'));
    assert.ok(f.content.querySelector('a[href="#analytics-through"]'));
    assert.match(f.content.textContent, /utm_source=vk/);
    assert.match(f.content.textContent, /Автоматическая загрузка статистики VK пока не реализована/);
    assert.equal(f.content.querySelector('input[type="password"]'), null);
    assert.deepEqual(f.calls[0].params, { from: '2026-08-18', to: '2026-09-17', companyCode: 'alvi' });
  } finally { f.close(); }
});

test('empty, loading and failed snapshots are distinct; failed loading offers a working retry', async () => {
  const f = fixture(); try {
    f.render(); assert.match(f.content.textContent, /Загружаем ручные снимки/);
    assert.doesNotMatch(f.content.textContent, /Нет ручного снимка/);
    await f.fail(0);
    assert.match(f.content.textContent, /Не удалось загрузить ручные снимки/);
    assert.doesNotMatch(f.content.textContent, /Нет ручного снимка/);
    f.content.querySelector('.retry-platforms').click();
    assert.equal(f.calls.length, 2); await f.reply(1, { sourceStats: [] });
    assert.match(f.content.textContent, /Нет ручного снимка/);
    assert.match(f.content.textContent, /не нулевой результат рекламы/);
    assert.doesNotMatch(f.content.textContent, /Не удалось загрузить/);
  } finally { f.close(); }
});

test('a snapshot without capture time is not reported as absent', async () => {
  const f = fixture(); try { f.render(); await f.reply(0, snapshot(null));
    assert.match(f.content.textContent, /Ручной снимок · дата не указана/);
  } finally { f.close(); }
});

test('late dashboard success or failure cannot replace the new company result', async () => {
  for (const failed of [false, true]) {
    const f = fixture(); try {
      f.render(); f.change('avokado');
      assert.equal(f.calls[0].params.companyCode, 'alvi'); assert.equal(f.calls[1].params.companyCode, 'avokado');
      await f.reply(1, { sourceStats: [] });
      if (failed) await f.fail(0); else await f.reply(0, snapshot());
      assert.match(f.content.textContent, /Реклама компании Авокадо/);
      assert.doesNotMatch(f.content.textContent, /Ручной снимок от|Не удалось загрузить|АЛВИ/);
    } finally { f.close(); }
  }
});

test('manual save sends only entered metrics for the form company with CSRF; unknown is not converted to zero', async () => {
  const f = fixture(); try {
    f.render(); await f.reply(0, { sourceStats: [] }); const form = f.open();
    assert.equal(f.calls[1].path, '/external-stats'); assert.equal(f.calls[1].params.companyCode, 'alvi');
    await f.reply(1, { rows: [] });
    const row = form.querySelector('tbody tr'); row.querySelector('[name="pageViews"]').value = '0';
    row.querySelector('[name="siteClicks"]').value = '7'; form.elements.note.value = 'Вручную из отчёта';
    f.submit(form);
    assert.equal(f.calls[2].path, '/external-stats'); assert.equal(f.calls[2].options.method, 'POST');
    assert.equal(f.calls[2].options.headers['X-CSRF-Token'], 'mock-csrf');
    assert.deepEqual(f.calls[2].body, { source: 'vk', companyCode: 'alvi', note: 'Вручную из отчёта', rows: [
      { date: row.querySelector('[name="date"]').value, pageViews: 0, siteClicks: 7 }
    ] });
    await f.reply(2, { upserted: 1 }); assert.match(form.textContent, /Сохранено: 1 день/);
    await f.reply(3, snapshot());
    assert.match(f.content.textContent, /Сохранено: 1 день/); assert.match(f.content.textContent, /Ручной снимок/);
  } finally { f.close(); }
});

test('an in-flight save for the old company cannot reset a new company form or trigger its refresh', async () => {
  const f = fixture(); try {
    f.render(); await f.reply(0, { sourceStats: [] }); const form = f.open(); await f.reply(1, { rows: [] });
    form.querySelector('[name="pageViews"]').value = '10'; f.submit(form);
    assert.equal(f.calls[2].body.companyCode, 'alvi');
    f.change('avokado'); await f.reply(3, { sourceStats: [] }); const current = f.open();
    current.elements.note.value = 'Keep current input'; await f.reply(4, { rows: [] });
    await f.reply(2, { upserted: 1 });
    assert.equal(f.calls.length, 5); assert.equal(current.elements.note.value, 'Keep current input');
    assert.doesNotMatch(current.textContent, /Сохранено/); assert.equal(current.dataset.companyCode, 'avokado');
  } finally { f.close(); }
});

test('old existing values are discarded after company change', async () => {
  const f = fixture(); try {
    f.render(); await f.reply(0, { sourceStats: [] }); const old = f.open();
    const date = old.querySelector('[name="date"]').value;
    f.change('avokado'); await f.reply(2, { sourceStats: [] }); f.open();
    await f.reply(3, { rows: [{ date, metrics: { pageViews: 12 } }] });
    await f.reply(1, { rows: [{ date, metrics: { pageViews: 987654 } }] });
    assert.match(f.content.textContent, /12 — будет заменено/); assert.doesNotMatch(f.content.textContent, /987654/);
  } finally { f.close(); }
});

test('permissions and missing company prevent unscoped requests and clear prior data', async () => {
  const f = fixture(['analytics.view']); try {
    f.render(); await f.reply(0, snapshot());
    assert.equal(f.content.querySelector('a[href="#crm"]'), null);
    assert.ok([...f.content.querySelectorAll('.manual-open')].every(button => button.disabled));
    f.content.querySelector('.manual-open').click(); assert.equal(f.calls.length, 1);
    f.context.identity.permissions = []; f.render();
    assert.equal(f.content.textContent, 'Нет доступа к рекламным площадкам.');
    assert.equal(f.calls.length, 1);
    f.context.identity.permissions = ['analytics.view']; f.change('');
    assert.match(f.content.textContent, /Выберите компанию/); assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});
