// Локальная проверка настоящей оболочки. Все запросы перехватываются;
// роли, переписка, файл и ответы сервера — только синтетические.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const [base, frozen, candidate, output] = process.argv.slice(2);
if (![base, frozen, candidate, output].every(Boolean)) throw Error('base frozen candidate output required');
const pkg = createRequire('C:/Users/Vlad/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');
const { chromium } = pkg('playwright');
const require = createRequire(import.meta.url), R = require('./customer-reports.cjs');
const sha = raw => createHash('sha256').update(raw).digest('hex');
const files = {}, pins = {};
for (const root of [base, frozen, candidate]) {
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    if (!item.isFile() || !/\.(?:js|css|html)$/.test(item.name)) continue;
    const raw = await fs.readFile(path.join(root, item.name)); files[item.name] = raw; pins[item.name] = sha(raw);
  }
}
const manifest = JSON.parse(await fs.readFile(path.join(candidate, 'MANIFEST.json'), 'utf8'));
for (const file of manifest.files) assert.equal(pins[file.name], file.afterSha256);
await fs.mkdir(output, { recursive: true });
const entry = 'https://synapse.synapsebusiness.ru/cabinet/palitra-orders/cabinet.html';
const month = '#reports?company=alvi&mode=month&month=2026-10';
const day = '#reports?company=avokado&mode=day&day=2026-10-18';
const order = { id: 18, name: 'Синтетический клиент', createdAt: '2026-10-18T12:00:00Z', work: { status: 'new' }, items: [] };
const seed = { id: 1, orderId: 18 };
const conversation = { thread: seed, seedThread: seed, composeThread: seed,
  scope: { view: 'conversation-v1', kind: 'session-grants', key: 'a'.repeat(64), limited: false },
  messages: [{ id: 1, threadId: 1, orderId: 18, authorType: 'customer', createdAt: '2026-10-18T12:00:00Z', text: 'Синтетическая прежняя переписка', attachments: [] }],
  nextBefore: null, uploads: { enabled: true, maxBytes: 1048576 }, autoReplyQuestions: [] };
const browser = await chromium.launch({ headless: true }), results = [];
const diagnostics = [];
async function fixture({ role = 'owner', width = 390, height = 844, companies, permissions } = {}) {
  const context = await browser.newContext({ viewport: { width, height } }), page = await context.newPage();
  page.setDefaultTimeout(7000);
  let identity = { userId: role === 'owner' ? 1 : 2, role, displayName: 'Синтетическая проверка',
    companies: (companies || (role === 'owner' ? ['palitra-love', 'alvi', 'avokado'] : ['alvi', 'avokado'])).map(id => ({ id })),
    permissions: permissions || ['crm.view', 'crm.edit', 'analytics.view'], csrfToken: 'synthetic' };
  const requests = [], errors = []; page.on('pageerror', e => errors.push(e.message));
  diagnostics.push({ role, width, height, requests, errors });
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()); requests.push({ path: url.pathname, method: req.method(), document: req.isNavigationRequest() });
    if (req.method() !== 'GET') return route.abort('failed'); // неизвестный исход только в локальной модели
    const prefix = '/cabinet/palitra-orders/';
    if (url.pathname.startsWith(prefix)) {
      const name = url.pathname.slice(prefix.length), raw = files[name];
      return route.fulfill({ status: raw ? 200 : 404, body: raw || '', contentType: name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'application/javascript' });
    }
    let data;
    if (url.pathname === '/content/whoami') data = identity;
    else if (/^\/content\/(alvi|avokado)\/customer-reports$/.test(url.pathname)) {
      const companyCode = url.pathname.split('/')[2];
      if (!identity.companies.some(c => c.id === companyCode) || role !== 'owner' && !identity.permissions.includes('analytics.view')) return route.fulfill({ status: 403, json: { error: 'Нет доступа' } });
      data = R.report({ companyCode, query: Object.fromEntries(url.searchParams), now: '2026-10-19T01:00:00.000Z' });
    } else if (url.pathname === '/content/palitra/orders') data = { orders: [order], nextCursor: null };
    else if (url.pathname === '/content/palitra/orders/18/dialog') data = { threadId: 1, threadRef: 'thread:1' };
    else if (url.pathname === '/content/palitra/orders/18/checklist') data = { order };
    else if (url.pathname === '/content/palitra/customer-threads/1') data = conversation;
    return route.fulfill({ status: data ? 200 : 404, json: data || { error: 'Вне локальной модели' } });
  });
  const documents = () => requests.filter(r => r.document).length;
  const ready = async () => {
    await page.waitForFunction(() => document.querySelector('[data-company-nav]')?.getAttribute('aria-busy') === 'false' && document.querySelector('[data-company-nav] button'));
    const later = page.getByRole('button', { name: 'Позже', exact: true });
    if (await later.isVisible()) await later.click();
  };
  const reports = company => page.getByRole('heading', { name: `Отчёты · ${company}`, exact: true }).waitFor({ timeout: 5000 });
  const changeHash = hash => page.evaluate(value => { location.hash = value; }, hash);
  const switchTo = async name => { await page.locator('[data-company-nav]').getByRole('button', { name, exact: true }).click(); await ready(); };
  const finish = async (name, extra = {}) => { assert.deepEqual(errors, []); results.push({ name, role, width, height, servicesContacted: 0, ...extra }); await context.close(); };
  return { page, context, requests, documents, ready, reports, changeHash, switchTo, finish, setIdentity: value => { identity = { ...identity, ...value }; } };
}
async function chat(f) {
  await f.page.goto(entry + '#A04?order=native-order:18');
  await f.ready();
  await f.page.getByRole('button', { name: 'Чат клиента (сайт)', exact: true }).click();
  await f.page.locator('.chat__input').waitFor(); await f.ready();
}
async function assertPreserved(f, hash, draft, filename) {
  const before = f.documents(); await f.changeHash(hash);
  await f.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Черновик и файл сохранены'));
  assert.equal(f.documents(), before); assert.equal(await f.page.locator('.chat__input').inputValue(), draft);
  if (filename) await f.page.locator('.attachments__name').filter({ hasText: filename }).waitFor();
  assert.ok((await f.page.url()).includes('#A05'), 'адрес прежнего чата восстановлен');
  const geometry = await f.page.locator('.chat__dock').evaluate(dock => {
    const r = dock.getBoundingClientRect(), input = dock.querySelector('textarea').getBoundingClientRect();
    return { dockBottom: r.bottom, inputBottom: input.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.equal(geometry.overflow, false); assert.ok(geometry.dockBottom - geometry.inputBottom <= 8);
  return geometry;
}
try {
  for (const role of ['owner', 'editor']) for (const [width, height] of [[320, 420], [1280, 900]]) {
    const f = await fixture({ role, width, height }); await f.page.goto(entry); await f.ready();
    const initial = f.documents(), whoami = f.requests.filter(r => r.path === '/content/whoami').length;
    await f.changeHash(month); await f.reports('Алви'); await f.ready();
    assert.equal(f.documents(), initial + 1); assert.equal(f.requests.filter(r => r.path === '/content/whoami').length, whoami + 1);
    await f.changeHash(day); await f.reports('Авокадо'); await f.ready();
    assert.equal(f.documents(), initial + 2);
    assert.deepEqual(await f.page.locator('[data-company-nav] button').allTextContents(), role === 'owner' ? ['Палитра', 'Авокадо', 'Алви'] : ['Авокадо', 'Алви']);
    const before = f.documents(); await f.page.locator('.salon-reports input[type="date"]').first().fill('2026-10-17');
    await f.page.locator('.salon-reports input[type="date"]').first().dispatchEvent('change');
    await f.page.waitForFunction(() => document.querySelector('.salon-reports')?.getAttribute('aria-busy') === 'false' && location.hash.includes('2026-10-17'));
    await f.page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
    assert.equal(f.documents(), before, 'свой фильтр не должен перезагружать страницу');
    assert.equal(f.requests.some(r => r.method !== 'GET'), false);
    await f.finish('открытая страница: две компании, новая проверка сессии и фильтр', { cleanReloads: 2 });
  }
  for (const kind of ['draft', 'file', 'unknown']) {
    const f = await fixture({ width: 390, height: 420 }); await chat(f);
    const draft = 'Синтетический черновик'; await f.page.locator('.chat__input').fill(draft);
    if (kind === 'file') await f.page.locator('input[type="file"]').setInputFiles({ name: 'local-probe.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=', 'base64') });
    if (kind === 'unknown') {
      await f.page.locator('.chat__compose button[type="submit"]').click();
      await f.page.waitForFunction(() => document.querySelector('#toast')?.textContent.trim());
      const notice = await f.page.locator('#toast').textContent();
      assert.ok(f.requests.some(r => r.method === 'POST'), 'модель отправки дошла до транспорта: ' + notice);
      assert.match(notice, /неизвест|подтверд|сеть|соедин|Failed to fetch/i);
    }
    // Проверяем file/pending независимо: одного текстового черновика для
    // блокировки уже достаточно, поэтому в этих двух случаях его очищаем.
    if (kind !== 'draft') await f.page.locator('.chat__input').fill('');
    const geometry = await assertPreserved(f, month, kind === 'draft' ? draft : '', kind === 'file' ? 'local-probe.png' : null);
    await f.page.screenshot({ path: path.join(output, `preserved-${kind}.png`) });
    await f.finish('ссылка сохраняет ' + kind, { geometry, noReload: true });
  }
  {
    const f = await fixture(); await chat(f); await f.page.locator('.chat__input').fill('Черновик другой компании');
    await f.switchTo('Авокадо'); const before = f.documents(); await f.changeHash(month);
    await f.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Черновик и файл сохранены'));
    assert.equal(f.documents(), before); assert.equal(await f.page.locator('.app-title').innerText(), 'Авокадо');
    await f.switchTo('Палитра'); await f.page.locator('#body').getByRole('button', { name: /^Заказы/ }).click();
    await f.page.getByRole('button', { name: /Синтетический клиент/ }).click();
    await f.page.getByRole('button', { name: 'Чат клиента (сайт)', exact: true }).click();
    assert.equal(await f.page.locator('.chat__input').inputValue(), 'Черновик другой компании');
    await f.finish('сохраняется черновик ранее выбранной компании', { noReload: true });
  }
  for (const grant of ['membership', 'analytics']) {
    const f = await fixture({ role: 'editor' }); await f.page.goto(entry); await f.ready();
    f.setIdentity(grant === 'membership' ? { companies: [{ id: 'avokado' }] } : { permissions: ['crm.view'] });
    const before = f.requests.length;
    const identityResponse = f.page.waitForResponse(response => new URL(response.url()).pathname === '/content/whoami');
    await f.changeHash(month); await identityResponse;
    await f.page.waitForFunction(() => document.querySelector('[data-company-nav]')?.getAttribute('aria-busy') === 'false' && !document.querySelector('.salon-reports'));
    await f.page.waitForFunction(() => !document.querySelector('.auth-loading'));
    assert.equal(f.requests.slice(before).some(r => r.path === '/content/alvi/customer-reports'), false);
    await f.finish('отозванный доступ заново проверен: ' + grant, { reportRequests: 0 });
  }
  await fs.writeFile(path.join(output, 'RESULTS.json'), JSON.stringify({ passed: true, cases: results, manifest, pins, productionWrites: 0, actualRoleSessionsVerified: false, physicalPhoneVerified: false }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, cases: results.length, servicesContacted: 0, output }));
} catch (error) {
  const pages = browser.contexts().flatMap(c => c.pages());
  for (let i = 0; i < pages.length; i++) {
    await pages[i].screenshot({ path: path.join(output, `failed-${i}.png`) });
    diagnostics.push({ url: pages[i].url(), visible: await pages[i].locator('body').innerText() });
  }
  await fs.writeFile(path.join(output, 'FAILED.json'), JSON.stringify(diagnostics, null, 2));
  console.error(error); throw error;
}
finally { await browser.close(); }
