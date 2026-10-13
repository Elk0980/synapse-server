'use strict';

/* Только изолированный QA. Запускает Root; автор стенда его не запускал.
 * node cart-flow.test.cjs [absolute-candidate-directory]
 * По умолчанию candidate = ../payload. Другой каталог можно передать отдельным аргументом.
 * Никаких файлов результата/серверов/user-profile; все HTTP requests fulfilled/aborted.
 * Настоящие price-render.js/price-format.js/order.js исполняются без замены обработчиков.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PALITRA_QA_PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, 'baseline');
const CANDIDATE = path.resolve(process.argv[2] || path.join(ROOT, 'payload'));
const ORIGIN = 'https://palitra-cart-qa.invalid';
const CART_KEY = 'palitra-cart-v1';
const KNOWN = { id: 'qa-known', title: 'QA синтетический набор', price: '4000', desc: 'Только локальный fixture' };
const UNKNOWN = { id: 'qa-unknown', title: 'QA цена уточняется', price: '', desc: 'Цена не известна, id настоящий для fixture' };
const INVALID = { id: 'bad id', title: 'QA неверный идентификатор', price: '4000', desc: 'Нельзя добавить' };
const EMPTY_ID = { id: '', title: 'QA пустой идентификатор', price: '4000', desc: 'Нельзя добавить' };
const fillers = Array.from({ length: 30 }, (_, n) => ({ id: 'qa-fill-' + n, title: 'QA строка ' + n, price: '100' }));
const PRICE = { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', categories: [{ id: 'qa', title: 'QA синтетические товары', items: [KNOWN, UNKNOWN, ...fillers] }] };
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = (dir, filename, nested) => {
  const candidates = nested ? [path.join(dir, 'assets', filename), path.join(dir, filename)] : [path.join(dir, filename)];
  const found = candidates.find(name => fs.existsSync(name));
  if (!found) throw new Error('Отсутствует источник: ' + candidates.join(' или '));
  const bytes = fs.readFileSync(found);
  return { filename: found, bytes, sha256: digest(bytes) };
};
const format = source(BASE, 'price-format.js');
const variants = {
  baseline: { renderer: source(BASE, 'price-render.js'), order: source(BASE, 'order.js') },
  candidate: { renderer: source(CANDIDATE, 'price-render.js'), order: source(CANDIDATE, 'order.js', true) }
};
assert.equal(variants.baseline.renderer.sha256, '0b87c08ed5498bb667bf1bcf079afafcb8b441b5f5bc52366d2c6a4b3a24d215', 'BASE renderer должен быть свежим принятым источником');
assert.equal(variants.baseline.order.sha256, 'b9a12c33fa8129b3bcbb6fd84f098299c690e39f49c5bda15b235b9374aff293', 'BASE order должен быть свежим принятым источником');

const HTML = [
  '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>Изолированный cart QA</title><style>',
  '*{box-sizing:border-box}body{font:16px Arial;margin:16px}button,a,input,select,textarea{font:inherit}button,a{display:inline-block;margin:4px;padding:8px}',
  '.product-card{border:1px solid #aaa;padding:12px;margin:8px}.product-media{min-height:20px}.product-dialog{width:min(700px,95vw)}',
  '.product-dialog-layout{display:block}[hidden]{display:none!important}.cart{background:white;border:2px solid #555;padding:14px}label{display:block;margin:8px}input,select{display:block}',
  '</style><script>window.PALITRA_CONFIG={FLOWERS_VISIBLE:false,HIDE_UNNAMED:true};</script>',
  '<script src="/assets/price-format.js"></script><script src="/price-render.js"></script></head><body data-page="catalog">',
  '<main><h1>QA каталог</h1><button type="button" data-cart-open>Общая корзина</button><span data-cart-count>0</span><div id="qa-products"></div>',
  '<script>document.getElementById("qa-products").innerHTML=' + json([KNOWN, UNKNOWN, INVALID, EMPTY_ID]) + '.map(function(it){return window.PalitraPrice.productCard(it)}).join("");</script>',
  '<aside class="cart" data-cart hidden aria-hidden="true" aria-label="Корзина"><button type="button" data-cart-close>Закрыть</button><h2>Корзина</h2>',
  '<div data-cart-items></div><p data-cart-summary></p><p>Итого: <span data-total></span></p><form data-order-form="cart">',
  '<label>Имя<input name="name" maxlength="80" required></label>',
  '<label>Связь<select name="contactChannel"><option value="phone">Позвонить</option><option value="telegram">Telegram</option><option value="whatsapp">WhatsApp</option><option value="max">MAX</option></select></label>',
  '<label data-contact-field><span data-contact-label>Телефон</span><input name="contact" type="tel" maxlength="32" required></label>',
  '<label data-telegram-field hidden>Telegram<input name="telegramUsername" disabled></label>',
  '<fieldset><legend>Получение</legend><label><input type="radio" name="fulfillment" value="delivery">Доставка</label><label><input type="radio" name="fulfillment" value="pickup" checked>Самовывоз</label><label><input type="radio" name="fulfillment" value="courier">Курьер</label></fieldset>',
  '<label data-delivery-address-field hidden>Адрес<input name="deliveryAddress" disabled></label><p data-fulfillment-hint></p>',
  '<label>Дата<input name="deliveryDate" type="date" required></label><label>Время<select name="deliveryInterval" required><option value="">Выберите</option><option value="10-12">10–12</option><option value="12-14">12–14</option></select></label><p data-slot-hint></p>',
  '<label>Пожелания<textarea name="comment" maxlength="1000"></textarea></label><label><input name="consent" type="checkbox" required>Согласие</label>',
  '<button type="submit">Отправить QA заявку</button></form></aside></main>',
  '<script src="/assets/order.js"></script></body></html>'
].join('\n');

async function fixture(browser, variant, seed = [], response = 'success') {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, serviceWorkers: 'block', acceptDownloads: false });
  const state = { posts: [], requests: [], blocked: [], pageErrors: [], alerts: [] };
  try {
    await context.addInitScript(({ key, seed }) => {
      // Только новый непостоянный QA context. Повторная /cart навигация не перезаписывает корзину.
      if (localStorage.getItem('__qa_cart_initialized') !== '1') {
        localStorage.setItem(key, JSON.stringify({ items: seed }));
        localStorage.setItem('__qa_cart_initialized', '1');
      }
    }, { key: CART_KEY, seed });
    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket('**/*', socket => socket.close());
    }
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      state.requests.push({ method: request.method(), path: url.pathname, origin: url.origin });
      const reply = (status, contentType, body) => route.fulfill({ status, contentType, headers: { 'Cache-Control': 'no-store' }, body });
      if (url.origin !== ORIGIN) {
        state.blocked.push({ method: request.method(), url: url.href });
        await route.abort('blockedbyclient'); return;
      }
      if (request.method() === 'GET' && ['/', '/cart', '/cart/'].includes(url.pathname)) {
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'"
        }, body: HTML }); return;
      }
      const scripts = { '/assets/price-format.js': format.bytes, '/price-render.js': variants[variant].renderer.bytes, '/assets/order.js': variants[variant].order.bytes };
      if (request.method() === 'GET' && scripts[url.pathname]) { await reply(200, 'application/javascript; charset=utf-8', scripts[url.pathname]); return; }
      if (request.method() === 'GET' && ['/api/price', '/data/price.json'].includes(url.pathname)) { await reply(200, 'application/json', json(PRICE)); return; }
      if (request.method() === 'GET' && url.pathname === '/api/draft-account/session') { await reply(200, 'application/json', '{"user":null,"csrf":""}'); return; }
      if (request.method() === 'POST' && url.pathname === '/api/orders') {
        const body = request.postDataJSON();
        state.posts.push(body);
        const result = response === 'reject' ? { status: 400, body: { ok: false, code: 'VALIDATION' } }
          : response === 'no-order-id' ? { status: 201, body: { ok: true, message: 'QA: неполный receipt' } }
            : { status: 201, body: { ok: true, orderId: 990001, message: 'Только mock receipt' } };
        await reply(result.status, 'application/json', json(result.body)); return;
      }
      if (request.method() === 'GET' && url.pathname === '/assets/img/logo-mark.svg') {
        await reply(200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#ddd"/></svg>'); return;
      }
      if (request.method() === 'GET' && url.pathname === '/favicon.ico') { await reply(204, 'image/x-icon', ''); return; }
      state.blocked.push({ method: request.method(), url: url.href });
      await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => state.pageErrors.push(error.message));
    page.on('dialog', async dialog => { state.alerts.push(dialog.message()); await dialog.dismiss(); });
    await page.goto(ORIGIN + '/', { waitUntil: 'load' });
    await page.locator('[data-order-form="cart"][data-order-ready]').waitFor({ state: 'attached' });
    assert.deepEqual(state.pageErrors, [], 'Ошибка исполнения настоящих скриптов fixture');
    return { page, context, state };
  } catch (error) { await context.close(); throw error; }
}

const readCart = page => page.evaluate(key => {
  const raw = JSON.parse(localStorage.getItem(key) || '{}'); return raw.items || [];
}, CART_KEY);
const panelVisible = page => page.locator('[data-cart]').evaluate(el => !el.hidden && el.getAttribute('aria-hidden') === 'false');
const openProduct = async (page, id = KNOWN.id) => {
  // Селектор ищет реальную карточку, в том числе намеренно invalid/empty id.
  const selector = '#qa-products .product-card[data-id=' + JSON.stringify(id) + '] [data-product-open]';
  await page.locator(selector).click();
  await page.locator('.product-dialog[open]').waitFor({ state: 'visible' });
};
const checkout = async page => {
  const button = page.locator('.product-dialog button').filter({ hasText: /^Перейти к оформлению$/ });
  // Отключённая CTA для invalid/full допустима; positive cases всё равно требуют добавления.
  if (await button.isDisabled()) return;
  await button.click();
};
const assertSelected = async (page, id, qty) => {
  const items = await readCart(page);
  assert.deepEqual(items.filter(item => item.id === id), [{ id, qty }]);
  assert.equal(await panelVisible(page), true, 'Открыта настоящая корзина с формой');
  assert.equal(await page.locator('.product-dialog[open]').count(), 0, 'Товарная модалка закрыта перед оформлением');
  assert.equal(await page.locator('[data-cart-line=' + JSON.stringify(id) + ']').count(), 1);
  assert.equal(await page.locator('[data-cart] form[data-order-ready]').isVisible(), true);
};
async function fillForm(page) {
  const form = page.locator('[data-order-form="cart"]');
  await form.locator('[name=name]').fill('QA вымышленный покупатель');
  await form.locator('[name=contact]').fill('+70000000000');
  await form.locator('[name=comment]').fill('Изолированный mock, не реальная заявка');
  const tomorrow = await page.evaluate(() => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  });
  await form.locator('[name=deliveryDate]').fill(tomorrow);
  await form.locator('[name=deliveryInterval]').selectOption('10-12');
  await form.locator('[name=consent]').check();
  assert.equal(await form.evaluate(el => el.checkValidity()), true, 'Fixture форма валидна до submit');
}
async function submit(page) { await page.locator('[data-order-form="cart"] button[type=submit]').click(); }

const tests = [];
const test = (name, variant, seed, response, run) => tests.push({ name, variant, seed, response, run });
test('BASE: открытый товар → CTA → пустая корзина; заполненная форма не делает POST', 'baseline', [], 'success', async ({ page, state }) => {
  await openProduct(page); await checkout(page);
  assert.equal(await panelVisible(page), true); assert.deepEqual(await readCart(page), []);
  await fillForm(page); await submit(page);
  await page.waitForFunction(() => document.querySelector('[data-order-status]')?.dataset.state === 'error');
  assert.match(await page.locator('[data-order-status]').textContent(), /Корзина пуста/);
  assert.equal(state.posts.length, 0, 'BASE блокер возникает до POST');
});
test('CANDIDATE: товар → CTA добавляет ровно1 и открывает форму', 'candidate', [], 'success', async ({ page, state }) => {
  await openProduct(page); await checkout(page); await assertSelected(page, KNOWN.id, 1); assert.equal(state.posts.length, 0);
});
test('CANDIDATE: значок в модалке → штатный /cart → CTA не удваивает', 'candidate', [], 'success', async ({ page }) => {
  await openProduct(page);
  await Promise.all([page.waitForURL(ORIGIN + '/cart'), page.locator('.product-dialog [data-add]').click()]);
  assert.equal(new URL(page.url()).pathname, '/cart');
  assert.deepEqual(await readCart(page), [{ id: KNOWN.id, qty: 1 }]);
  await openProduct(page); await checkout(page); await assertSelected(page, KNOWN.id, 1);
});
test('CANDIDATE: имеющееся количество4 сохраняется', 'candidate', [{ id: KNOWN.id, qty: 4 }], 'success', async ({ page }) => {
  await openProduct(page); await checkout(page); await assertSelected(page, KNOWN.id, 4);
});
test('CANDIDATE: повторный CTA не удваивает и не теряет чужую строку', 'candidate', [{ id: UNKNOWN.id, qty: 2 }], 'success', async ({ page }) => {
  await openProduct(page); await checkout(page); await assertSelected(page, KNOWN.id, 1);
  await page.locator('[data-cart-close]').click(); await openProduct(page); await checkout(page);
  await assertSelected(page, KNOWN.id, 1);
  assert.deepEqual(await readCart(page), [{ id: UNKNOWN.id, qty: 2 }, { id: KNOWN.id, qty: 1 }]);
});
test('CANDIDATE: неизвестная цена разрешена', 'candidate', [], 'success', async ({ page }) => {
  await openProduct(page, UNKNOWN.id);
  assert.equal(await page.locator('.product-dialog [data-price-known]').getAttribute('data-price-known'), 'false');
  await checkout(page); await assertSelected(page, UNKNOWN.id, 1);
  await page.waitForFunction(() => document.querySelector('[data-cart-line="qa-unknown"]')?.textContent.includes('Цена уточняется'));
});
test('CANDIDATE: открыть/закрыть/открыть товар не добавляет его', 'candidate', [], 'success', async ({ page }) => {
  await openProduct(page); assert.deepEqual(await readCart(page), []);
  await page.locator('[data-product-close]').click(); assert.deepEqual(await readCart(page), []);
  await openProduct(page); assert.deepEqual(await readCart(page), []);
});
for (const item of [INVALID, EMPTY_ID]) test('CANDIDATE: неверный id ' + JSON.stringify(item.id) + ' не объявляет добавление', 'candidate', [], 'success', async ({ page, state }) => {
  await openProduct(page, item.id); await checkout(page);
  assert.deepEqual(await readCart(page), []); assert.equal(await panelVisible(page), false);
  assert.equal(await page.locator('.palitra-order-success[open]').count(), 0); assert.equal(state.posts.length, 0);
});
test('CANDIDATE: корзина30 строк не теряет состав и не открывает оформление не добавленного товара', 'candidate', fillers.map(item => ({ id: item.id, qty: 1 })), 'success', async ({ page, state }) => {
  const before = await readCart(page); await openProduct(page); await checkout(page);
  assert.deepEqual(await readCart(page), before); assert.equal(await panelVisible(page), false); assert.equal(state.posts.length, 0);
});
for (const item of [KNOWN, UNKNOWN]) test('CANDIDATE: mock201 после CTA содержит выбранный ' + item.id, 'candidate', [], 'success', async ({ page, state }) => {
  await openProduct(page, item.id); await checkout(page); await assertSelected(page, item.id, 1);
  await fillForm(page); await submit(page); await page.locator('.palitra-order-success[open]').waitFor({ state: 'visible' });
  assert.equal(state.posts.length, 1); assert.equal(state.posts[0].kind, 'cart');
  assert.deepEqual(state.posts[0].items, [{ id: item.id, qty: 1 }]);
  assert.match(state.posts[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(await page.locator('.palitra-order-success__title').textContent(), /990001/);
  assert.deepEqual(await readCart(page), []);
});
for (const response of ['reject', 'no-order-id']) test('CANDIDATE: ' + response + ' сохраняет корзину и поля, успеха нет', 'candidate', [], response, async ({ page, state }) => {
  await openProduct(page); await checkout(page); await fillForm(page); await submit(page);
  await page.waitForFunction(() => document.querySelector('[data-order-status]')?.dataset.state === 'error');
  assert.equal(state.posts.length, 1); assert.deepEqual(state.posts[0].items, [{ id: KNOWN.id, qty: 1 }]);
  assert.deepEqual(await readCart(page), [{ id: KNOWN.id, qty: 1 }]);
  assert.equal(await page.locator('[name=name]').inputValue(), 'QA вымышленный покупатель');
  assert.equal(await page.locator('[name=contact]').inputValue(), '+70000000000');
  assert.equal(await page.locator('[name=consent]').isChecked(), true);
  assert.equal(await page.locator('.palitra-order-success[open]').count(), 0);
  assert.equal(await page.locator('[data-order-form="cart"] button[type=submit]').isEnabled(), true);
});

(async () => {
  const results = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PALITRA_QA_CHROME ? { executablePath: process.env.PALITRA_QA_CHROME } : {}), args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--metrics-recording-only'] });
    for (const spec of tests) {
      let fx;
      try {
        fx = await fixture(browser, spec.variant, spec.seed, spec.response);
        await spec.run(fx);
        assert.deepEqual(fx.state.pageErrors, [], 'Не скрывать script errors');
        assert.deepEqual(fx.state.blocked, [], 'Неожиданные запросы abort, наружу ничего не отправлено');
        results.push({ name: spec.name, status: 'PASS', variant: spec.variant, mockPosts: fx.state.posts.length });
      } catch (error) {
        results.push({ name: spec.name, status: 'FAIL', error: error.message, variant: spec.variant, mockPosts: fx?.state.posts.length || 0, pageErrors: fx?.state.pageErrors || [], blocked: fx?.state.blocked || [] });
      } finally { if (fx) await fx.context.close(); }
    }
  } finally { if (browser) await browser.close(); }
  const report = {
    isolated: true, publicUiAcceptance: false, networkPolicy: 'Все page/context HTTP requests fulfilled/aborted; serviceWorkers blocked; no user profile',
    sources: { format: { path: format.filename, sha256: format.sha256 }, ...Object.fromEntries(Object.entries(variants).map(([key, value]) => [key, { renderer: { path: value.renderer.filename, sha256: value.renderer.sha256 }, order: { path: value.order.filename, sha256: value.order.sha256 } }])) },
    passed: results.filter(item => item.status === 'PASS').length, failed: results.filter(item => item.status === 'FAIL').length, results
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.failed) process.exitCode = 1;
})().catch(error => { console.error('QA HARNESS ERROR: ' + error.stack); process.exitCode = 1; });
