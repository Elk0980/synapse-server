#!/usr/bin/env node
'use strict';
/* Проверка select kit в настоящем Chromium на странице сайта (без сети):
   клик по подписи, выбор мышью и клавиатурой, событие change доходит до кода сайта
   (palitra: Telegram показывает поле ника), программная смена value, required, сенсорный режим.
   node tools/site-kit/browser-check.js [--site palitra-love] [--page /]   Код 1 при ошибке. */
const path = require('node:path');
const assert = require('node:assert/strict');
const { serve } = require('./screenshots.js');

async function main() {
  const argv = process.argv.slice(2);
  const get = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const site = get('--site', 'palitra-love');
  const page = get('--page', '/');
  const { chromium } = require('playwright');
  const server = await serve(path.join(__dirname, '..', '..', 'sites', site));
  const url = `http://127.0.0.1:${server.address().port}${page}`;
  const browser = await chromium.launch();
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); }
  };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const tab = await ctx.newPage();
    const errors = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    await tab.goto(url, { waitUntil: 'load' });
    await tab.evaluate(() => { document.getElementById('page-loader')?.remove(); document.querySelector('.cookie')?.classList.add('hidden'); });
    // Список только в скрытой панели (корзина каталога) — раскрыть её, как сделал бы посетитель.
    if (!(await tab.locator('select:visible').count())) {
      const reveal = tab.locator('[data-kit-reveal]:visible, [data-cart-open]:visible').first();
      if (await reveal.count()) { await reveal.click(); await tab.waitForTimeout(300); }
    }
    const form = tab.locator('form:has(select):visible').first();
    const label = form.locator('label:has(.kit-select)').first();
    const button = form.locator('.kit-select__button');
    const list = form.locator('.kit-select__list');
    await check('select оформлен: appearance none у нативного и кнопки', async () => {
      const a = await tab.evaluate(() => [...document.querySelectorAll('select')].map((s) => getComputedStyle(s).appearance));
      assert.equal(await form.count(), 1, 'видимая форма со списком');
      assert.ok(a.length && a.every((v) => v === 'none'), JSON.stringify(a));
    });
    await check('клик по тексту подписи открывает список', async () => {
      await form.scrollIntoViewIfNeeded();
      const box = await label.boundingBox();
      await tab.mouse.click(box.x + 4, box.y + 6);
      assert.equal(await list.isVisible(), true);
      await tab.keyboard.press('Escape');
      assert.equal(await list.isVisible(), false);
    });
    await check('выбор мышью: значение нативного select и реакция кода сайта', async () => {
      await button.click();
      await list.locator('[role=option]', { hasText: 'Telegram' }).click();
      assert.equal(await list.isVisible(), false);
      assert.equal(await form.locator('select').inputValue(), 'telegram');
      assert.equal((await button.textContent()).trim(), 'Telegram');
      const tg = form.locator('[data-telegram-field]');
      if (await tg.count()) assert.equal(await tg.isVisible(), true, 'order.js показал поле ника Telegram');
    });
    await check('клавиатура: фокус виден, стрелки, Enter', async () => {
      await button.focus();
      const outline = await button.evaluate((b) => getComputedStyle(b).outlineStyle);
      await tab.keyboard.press('ArrowDown');
      await tab.keyboard.press('Home');
      await tab.keyboard.press('Enter');
      assert.equal(await form.locator('select').inputValue(), 'phone');
      assert.notEqual(outline, 'none', 'видимый фокус');
    });
    await check('программная смена select.value обновляет кнопку', async () => {
      await form.locator('select').evaluate((s) => { s.value = 'max'; });
      assert.equal((await button.textContent()).trim(), 'MAX');
    });
    await check('нативный select остаётся в FormData', async () => {
      const v = await form.evaluate((f) => new FormData(f).get('contactChannel'));
      assert.equal(v, 'max');
    });
    assert.deepEqual(errors, []);
    await ctx.close();
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const t = await touch.newPage();
    await t.goto(url, { waitUntil: 'load' });
    await check('телефон: системный список, контрол оформлен', async () => {
      assert.equal(await t.locator('.kit-select__button').count(), 0);
      const a = await t.evaluate(() => [...document.querySelectorAll('select')].map((s) => [getComputedStyle(s).appearance, s.dataset.kitSelect]));
      assert.ok(a.every(([ap, k]) => ap === 'none' && k === 'native'), JSON.stringify(a));
    });
    await touch.close();
  } finally {
    await browser.close();
    server.close();
  }
  for (const r of results) console.log(r.join(' — '));
  return results.some((r) => r[0] === 'FAIL') ? 1 : 0;
}
main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
