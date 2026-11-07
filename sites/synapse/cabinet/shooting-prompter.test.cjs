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

test('суфлёр по макету 07.11: «← Съёмка», актёр «Все», сцены, выделение реплик, ▶/⏸, скорость 1×→2×, полоса прокрутки', () => {
  const p = page(), prompter = p.w.SbShooting.prompter.open({parsed: p.parsed, title: 'Суфлёр · №1', subtitle: 'Новое меню'});
  const o = p.d.querySelector('.prompter'), text = o.querySelector('.prompter__text');
  assert.ok(o && o.getAttribute('role') === 'dialog'); assert.ok(p.d.body.classList.contains('prompter-open'));
  assert.equal(o.querySelector('.prompter__back').textContent, '← Съёмка');
  assert.ok(o.querySelector('.shoot-share__button svg circle'), 'значок «Поделиться» — три точки');
  for (const gone of ['back', 'stop', 'mirror', 'slower', 'faster', 'smaller', 'bigger']) assert.equal(o.querySelector(`[data-act=${gone}]`), null, `нет кнопки ${gone}`);
  assert.doesNotMatch(o.textContent, /Весь сценарий|Только реплики|Зеркало|Стоп|Назад/);
  assert.equal(text.querySelectorAll('.prompter__line').length, 4, 'весь сценарий');
  assert.deepEqual([...text.querySelectorAll('.prompter__scene')].map((b) => b.textContent.trim()), ['Сцена №1', 'Сцена №2', 'Сцена №3', 'Сцена №4']);
  const select = o.querySelector('.shoot-share__actor');
  assert.deepEqual([...select.options].map((x) => x.textContent), ['Все', 'Лена', 'Таня']);
  assert.equal(text.querySelectorAll('.prompter__line--dim').length, 0, '«Все» — ничего не приглушено');
  select.value = 'Лена'; select.dispatchEvent(new p.w.Event('change'));
  assert.equal(text.querySelectorAll('.prompter__line').length, 4, 'сценарий остаётся целиком');
  assert.equal(text.querySelectorAll('.prompter__line--own').length, 2); assert.equal(text.querySelectorAll('.prompter__line--dim').length, 2);
  assert.match(text.querySelector('.prompter__line--own').textContent, /Сцена №1 ▶ ЛЕНА: Привет!/);
  const viewport = o.querySelector('.prompter__viewport');
  Object.defineProperty(text, 'scrollHeight', {value: 5000}); Object.defineProperty(viewport, 'clientHeight', {value: 800});
  const play = o.querySelector('[data-act=play]'), speed = o.querySelector('[data-act=speed]');
  assert.equal(play.textContent, '▶'); assert.equal(speed.textContent, '1×');
  play.click(); assert.equal(prompter.state.playing, true); assert.equal(play.textContent, '⏸');
  p.run(1000);
  const slow = transformY(text); assert.ok(slow < 0, 'текст поехал');
  const speeds = []; for (let i = 0; i < 4; i += 1) { speed.click(); speeds.push(speed.textContent); }
  assert.deepEqual(speeds, ['1.2×', '1.5×', '2×', '1×'], 'скорость по кругу');
  speed.click(); speed.click(); speed.click(); // 2×
  const before = transformY(text); p.run(1000); assert.ok(before - transformY(text) > -slow, 'быстрее прокручивает больше');
  viewport.click(); assert.equal(prompter.state.playing, false, 'пауза касанием текста'); assert.equal(play.textContent, '▶');
  const paused = transformY(text); p.run(500); assert.equal(transformY(text), paused);
  // Полоса прокрутки показывает место и тянется.
  const track = o.querySelector('.prompter__track'), thumb = o.querySelector('.prompter__thumb');
  assert.ok(Number(track.getAttribute('aria-valuenow')) > 0);
  track.getBoundingClientRect = () => ({top: 0, height: 400, left: 0, width: 14});
  const pointer = (type, y) => { const e = new p.w.MouseEvent(type, {clientY: y, bubbles: true}); track.dispatchEvent(e); };
  pointer('pointerdown', 0); assert.equal(transformY(text), 0, 'наверх');
  pointer('pointermove', 200); pointer('pointerup', 200);
  assert.equal(transformY(text), -2300, 'середина полосы — середина сценария'); assert.equal(track.getAttribute('aria-valuenow'), '50');
  assert.match(thumb.style.top, /%$/);
  pointer('pointermove', 400); assert.equal(transformY(text), -2300, 'после отпускания полоса не тянется');
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', {key: 'Escape'}));
  assert.equal(p.d.querySelector('.prompter'), null); assert.equal(p.frames.length, 0); assert.ok(!p.d.body.classList.contains('prompter-open'));
});

test('сценарий без ролей: весь текст, выбора актёра нет', () => {
  const p = page(), parsed = p.w.SbShooting.script.parse('Свободный текст сценария\nещё строка');
  p.w.SbShooting.prompter.open({parsed, title: 'Рилс'});
  assert.equal(p.d.querySelector('.shoot-share__actor'), null);
  assert.equal(p.d.querySelectorAll('.prompter__line').length, 2);
});

test('«Поделиться» на ПК: Telegram, WhatsApp, VK, «MAX · Скопировать», форматы Текст/PNG/PDF — реплики актёра жирным с ▶', async () => {
  const p = page(), controls = p.w.SbShooting.prompter.shareControls({parsed: p.parsed, title: 'Рилс №1', state: {actor: 'Лена'}});
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
  assert.deepEqual([...menu.querySelectorAll('[data-share]')].map((b) => b.textContent), ['Telegram', 'WhatsApp', 'VK', 'MAX · Скопировать', 'Текст', 'PNG', 'PDF']);
  menu.querySelector('[data-share=text]').click(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.copied.length, 2);
  menu.querySelector('[data-share=png]').click(); await new Promise((r) => setTimeout(r, 0));
  assert.match(controls.querySelector('.shoot-share__status').textContent, /Картинка недоступна/, 'jsdom без canvas — честный отказ');
});

test('«Поделиться» на телефоне — системное меню navigator.share с текстом', async () => {
  const p = page({share: true, coarse: true}), controls = p.w.SbShooting.prompter.shareControls({parsed: p.parsed, title: 'Рилс №1', state: {actor: 'Лена'}});
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

test('замечание Влада 07.11: «Aa» по кругу S → M → L → XL, выбор запоминается; без большого отступа и линии поверх текста', () => {
  const p = page();
  const o1 = p.w.SbShooting.prompter.open({parsed: p.parsed, title: 'Суфлёр №3'}).overlay;
  const font = o1.querySelector('[data-act=font]'), text = o1.querySelector('.prompter__text');
  assert.ok(font, 'кнопка «Aa» есть');
  assert.equal(font.nextElementSibling, o1.querySelector('[data-act=speed]'), '«Aa» рядом с «1×»');
  assert.match(font.textContent, /^AaM$/); assert.equal(font.getAttribute('aria-label'), 'Размер текста: M');
  const sizes = [];
  for (let i = 0; i < 4; i += 1) { font.click(); sizes.push([font.querySelector('.prompter__font-id').textContent, text.style.fontSize]); }
  assert.deepEqual(sizes.map((s) => s[0]), ['L', 'XL', 'S', 'M'], 'размер по кругу');
  const px = sizes.map((s) => parseInt(s[1], 10)); assert.ok(px[0] < px[1] && px[2] < px[3] && px[3] < px[0], 'шрифт действительно меняется');
  font.click(); // L
  assert.equal(p.w.localStorage.getItem('sb.prompter.font'), 'L');
  o1.querySelector('[data-act=close]').click();
  const o2 = p.w.SbShooting.prompter.open({parsed: p.parsed, title: 'Суфлёр №3'}).overlay;
  assert.equal(o2.querySelector('.prompter__font-id').textContent, 'L', 'выбор восстановлен при следующем открытии');
  assert.equal(o2.style.getPropertyValue('--prompter-font'), o2.querySelector('.prompter__text').style.fontSize, 'полоса-ориентир по высоте строки');
  o2.querySelector('[data-act=close]').click();
  // localStorage недоступен (приватный режим) — суфлёр всё равно открывается с M и не падает.
  Object.defineProperty(p.w, 'localStorage', {get() { throw new Error('blocked'); }});
  const o3 = p.w.SbShooting.prompter.open({parsed: p.parsed, title: 'Суфлёр №3'}).overlay;
  assert.equal(o3.querySelector('.prompter__font-id').textContent, 'M');
  o3.querySelector('[data-act=font]').click();
  assert.equal(o3.querySelector('.prompter__font-id').textContent, 'L');
  o3.querySelector('[data-act=close]').click();
  // CSS: нет 30vh сверху и нет линии border-top поверх букв; полоса — позади текста.
  const css = read('shooting.css');
  assert.doesNotMatch(css, /\.prompter__text \{[^}]*padding: 30vh/);
  assert.doesNotMatch(css, /\.prompter__viewport::after[^}]*border-top/);
  assert.match(css, /\.prompter__viewport::before \{[^}]*z-index: 0[^}]*background: rgba\(159, 212, 255, \.07\)/);
  assert.match(css, /\.prompter__text \{[^}]*z-index: 1/);
});

test('замечание Влада 07.11: шапка суфлёра на телефоне — «←», «Суфлёр №N» и роль без обрезания', () => {
  const p = page(), o = p.w.SbShooting.prompter.open({parsed: p.parsed, title: 'Суфлёр №3'}).overlay;
  const back = o.querySelector('.prompter__back');
  assert.equal(back.textContent, '← Съёмка'); assert.equal(back.getAttribute('aria-label'), 'Назад: Съёмка');
  assert.ok(back.querySelector('.prompter__back-text'));
  const css = read('shooting.css');
  const narrow = css.slice(css.indexOf('@media (max-width: 599px)'));
  assert.match(narrow, /\.prompter__back-text \{ display: none; \}/);
  assert.match(css, /\.prompter \.shoot-share__actor \{ max-width: none;/, 'роль не режется max-width: 34vw');
  assert.match(read('shooting.js'), /title: `Суфлёр №\$\{reel\.number\}`/);
});
