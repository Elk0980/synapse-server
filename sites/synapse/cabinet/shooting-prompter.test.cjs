'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const SCRIPT = 'Лена: Привет! Это Авокадо.\n[Вставка: витрина]\nТаня: А что нового?\nЛена: Новое меню!';

function page({share = null, coarse = false} = {}) {
  const dom = new JSDOM('<body></body>', {url: 'https://cabinet.test/cabinet.html', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window, frames = [], copied = [], shared = [];
  w.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  w.cancelAnimationFrame = () => { frames.length = 0; };
  w.matchMedia = (q) => ({matches: coarse && q.includes('coarse'), media: q});
  Object.defineProperty(w.navigator, 'clipboard', {value: {writeText: async (t) => copied.push(t)}});
  if (share) w.navigator.share = async (data) => { shared.push(data); };
  w.eval(read('shooting-script.js')); w.eval(read('shooting-prompter.js'));
  const parsed = w.SbShooting.script.parse(SCRIPT);
  let t = 1000;
  const run = (ms) => { for (let i = 0; i < ms / 16; i += 1) { const fn = frames.shift(); if (!fn) break; t += 16; fn(t); } };
  return {w, d: w.document, parsed, frames, copied, shared, run};
}
const transformY = (node) => Number(/translateY\((-?\d+)px\)/.exec(node.style.transform)?.[1] || 0);

test('суфлёр: весь сценарий и реплики актёра, старт/пауза касанием, скорость, стоп, назад, зеркало, шрифт', () => {
  const p = page(), prompter = p.w.SbShooting.prompter.open({parsed: p.parsed, title: 'Рилс №1'});
  const o = p.d.querySelector('.prompter'), text = o.querySelector('.prompter__text');
  assert.ok(o && o.getAttribute('role') === 'dialog'); assert.ok(p.d.body.classList.contains('prompter-open'));
  assert.equal(text.querySelectorAll('.prompter__line').length, 4, 'весь сценарий');
  const select = o.querySelector('.shoot-share__actor');
  assert.deepEqual([...select.options].map((x) => x.textContent), ['Весь сценарий', 'Лена', 'Таня']);
  select.value = 'Лена'; select.dispatchEvent(new p.w.Event('change'));
  assert.equal(text.querySelectorAll('.prompter__line').length, 2); assert.equal(text.querySelectorAll('.prompter__line--own').length, 2);
  assert.equal(text.querySelectorAll('.prompter__cue').length, 1, 'перед репликой — подсказка партнёра');
  Object.defineProperty(text, 'scrollHeight', {value: 5000}); Object.defineProperty(o.querySelector('.prompter__viewport'), 'clientHeight', {value: 800});
  o.querySelector('.prompter__viewport').click();
  assert.equal(prompter.state.playing, true); p.run(1000);
  const slow = transformY(text); assert.ok(slow < 0, 'текст поехал');
  o.querySelector('[data-act=faster]').click(); o.querySelector('[data-act=faster]').click();
  assert.match(o.textContent, /Скорость 6/);
  const before = transformY(text); p.run(1000); assert.ok(before - transformY(text) > -slow, 'быстрее прокручивает больше');
  o.querySelector('.prompter__viewport').click(); assert.equal(prompter.state.playing, false, 'пауза касанием');
  const paused = transformY(text); p.run(500); assert.equal(transformY(text), paused);
  o.querySelector('[data-act=back]').click(); assert.ok(transformY(text) > paused, 'назад');
  o.querySelector('[data-act=mirror]').click(); assert.match(text.style.transform, /scaleX\(-1\)/); assert.ok(o.classList.contains('is-mirror'));
  o.querySelector('[data-act=bigger]').click(); assert.equal(text.style.fontSize, '50px');
  o.querySelector('[data-act=stop]').click(); assert.equal(transformY(text), 0); assert.equal(prompter.state.playing, false);
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', {key: 'Escape'}));
  assert.equal(p.d.querySelector('.prompter'), null); assert.equal(p.frames.length, 0); assert.ok(!p.d.body.classList.contains('prompter-open'));
});

test('сценарий без ролей: весь текст, выбора актёра нет', () => {
  const p = page(), parsed = p.w.SbShooting.script.parse('Свободный текст сценария\nещё строка');
  p.w.SbShooting.prompter.open({parsed, title: 'Рилс'});
  assert.equal(p.d.querySelector('.shoot-share__actor'), null);
  assert.equal(p.d.querySelectorAll('.prompter__line').length, 2);
});

test('«Поделиться» на ПК: Telegram, WhatsApp, VK, копирование для MAX — реплики актёра жирным с ▶', async () => {
  const p = page(), controls = p.w.SbShooting.prompter.shareControls({parsed: p.parsed, title: 'Рилс №1'});
  p.d.body.append(controls);
  controls.querySelector('.shoot-share__button').click(); await new Promise((r) => setTimeout(r, 0));
  const menu = controls.querySelector('.shoot-share__menu'); assert.equal(menu.hidden, false);
  const tg = decodeURIComponent(menu.querySelector('[data-share=telegram]').href.split('url=')[1]);
  assert.match(tg, /\*\*▶ ЛЕНА: Привет! Это Авокадо\.\*\*/); assert.match(tg, /^Таня: А что нового\?$/m);
  assert.match(decodeURIComponent(menu.querySelector('[data-share=whatsapp]').href), /\*▶ ЛЕНА: Новое меню!\*/);
  assert.match(menu.querySelector('[data-share=vk]').href, /^https:\/\/vk\.com\/share\.php\?url=/);
  const select = controls.querySelector('.shoot-share__actor'); select.value = 'Таня'; select.dispatchEvent(new p.w.Event('change'));
  menu.querySelector('[data-share=copy]').click(); await new Promise((r) => setTimeout(r, 0));
  assert.match(p.copied[0], /\*\*▶ ТАНЯ: А что нового\?\*\*/); assert.match(controls.textContent, /вставьте в MAX/);
  menu.querySelector('[data-share=png]').click(); await new Promise((r) => setTimeout(r, 0));
  assert.match(controls.querySelector('.shoot-share__status').textContent, /Картинка недоступна/, 'jsdom без canvas — честный отказ');
});

test('«Поделиться» на телефоне — системное меню navigator.share с текстом', async () => {
  const p = page({share: true, coarse: true}), controls = p.w.SbShooting.prompter.shareControls({parsed: p.parsed, title: 'Рилс №1'});
  p.d.body.append(controls); controls.querySelector('.shoot-share__button').click(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.shared.length, 1); assert.match(p.shared[0].text, /\*\*▶ ЛЕНА/); assert.equal(controls.querySelector('.shoot-share__menu').hidden, true);
});

test('PDF из JPEG: корректная структура и таблица смещений', () => {
  const {pdfFromJpeg} = require('./shooting-prompter.js');
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const pdf = Buffer.from(pdfFromJpeg(jpeg, 1080, 2000)), text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4')); assert.ok(text.trimEnd().endsWith('%%EOF'));
  const start = Number(/startxref\n(\d+)/.exec(text)[1]); assert.equal(text.slice(start, start + 4), 'xref');
  const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((offset, i) => assert.equal(text.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  assert.match(text, /\/MediaBox \[0 0 595 1102\]/);
});
