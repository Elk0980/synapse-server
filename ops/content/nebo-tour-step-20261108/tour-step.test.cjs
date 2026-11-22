// node --test ops/content/nebo-tour-step-20261108/tour-step.test.cjs
// Проверка логики шагов без браузера: страница, видео и кадры анимации подменены.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'tour-step.js'), 'utf8');
const STOPS = [0, 2247, 4761, 6272, 8385, 10070, 12263, 13868];
const IDS = ['tour-sky','tour-building','tour-entrance','tour-reception','tour-prices','tour-doctor','tour-care','tour-microscope'];
const FILM_H = 15152, INNER_H = 631, DURATION = 94.4;

function page({ playable = true } = {}) {
  let now = 0, rafQ = [], listeners = {};
  const win = {
    scrollY: 0, innerHeight: INNER_H,
    scrollTo(o) { win.scrollY = Math.max(0, Math.min(FILM_H + 5000, typeof o === 'object' ? o.top : arguments[1])); },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    matchMedia: () => ({ matches: false }),
  };
  class HTMLMediaElement {}
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true, get() { return this._t; }, set(v) { this._t = v; this.sets.push(v); },
  });
  const video = Object.assign(Object.create(HTMLMediaElement.prototype), {
    _t: 0, sets: [], duration: DURATION, readyState: playable ? 4 : 0, paused: true, ended: false, playbackRate: 1,
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
  });
  const el = (top, h) => ({ offsetHeight: h, getBoundingClientRect: () => ({ top: top - win.scrollY }) });
  const els = { 'tour-film': el(0, FILM_H) };
  IDS.forEach((id, i) => { els[id] = el(STOPS[i], 1500); });
  const document = { getElementById: id => els[id] || null, querySelector: s => (s.includes('video') ? video : null) };
  const ctx = {
    window: win, document, HTMLMediaElement, matchMedia: win.matchMedia,
    performance: { now: () => now }, requestAnimationFrame: fn => { rafQ.push(fn); return rafQ.length; },
    cancelAnimationFrame: () => {}, setTimeout: () => 0, Object, Math, Promise,
  };
  ctx.window.window = ctx.window;
  vm.runInNewContext(SRC, ctx);
  const fire = (t, e) => { for (const fn of listeners[t] || []) fn(Object.assign({ preventDefault() {}, stopImmediatePropagation() {} }, e)); };
  // «время идёт»: видео играет с текущей скоростью, кадры анимации отрабатывают
  const tick = (ms) => {
    for (let i = 0; i < ms / 16; i++) {
      now += 16;
      if (!video.paused) video._t = Math.min(DURATION, video._t + 0.016 * video.playbackRate);
      const q = rafQ; rafQ = []; q.forEach(fn => fn(now));
    }
  };
  const wheel = (dy) => { now += 400; fire('wheel', { deltaY: dy, deltaX: 0 }); };
  return { win, video, tick, wheel, fire };
}

test('один щелчок вниз: видео играет и встаёт ровно на следующем блоке', () => {
  const p = page();
  p.wheel(100);
  assert.equal(p.video.paused, false, 'видео запущено');
  p.tick(14000);
  assert.equal(p.win.scrollY, 2247);
  assert.equal(p.video.paused, true);
  assert.ok(Math.abs(p.video._t - 2247 / FILM_H * DURATION) < 0.05, 'кадр блока');
});

test('хвост того же жеста (инерция тачпада) не уводит дальше одного блока', () => {
  const p = page();
  p.wheel(100);
  for (let i = 0; i < 30; i++) { p.fire('wheel', { deltaY: 40, deltaX: 0 }); p.tick(16); }
  p.tick(14000);
  assert.equal(p.win.scrollY, 2247);
});

test('второй шаг ведёт к третьему блоку, шаг вверх — к предыдущему', () => {
  const p = page();
  p.wheel(100); p.tick(14000);
  p.wheel(100); p.tick(20000);
  assert.equal(p.win.scrollY, 4761);
  p.wheel(-100); p.tick(4000);
  assert.equal(p.win.scrollY, 2247);
});

test('пока видео играет, перемотка сайта не дёргает кадр', () => {
  const p = page();
  p.wheel(100); p.tick(2000);
  const before = p.video.sets.length;
  p.video.currentTime = 0;                // сайт пытается перемотать
  assert.equal(p.video.sets.length, before);
  assert.ok(p.video._t > 1);
});

test('после последнего блока шаг вниз выводит из экскурсии, ниже — обычная прокрутка', () => {
  const p = page();
  p.win.scrollTo(0, 13868);
  p.wheel(100); p.tick(15000);
  assert.equal(p.win.scrollY, FILM_H - INNER_H);
  p.win.scrollTo(0, FILM_H + 1000);
  let prevented = false;
  p.fire('wheel', { deltaY: 100, deltaX: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'ниже экскурсии колесо не перехватывается');
});

test('если видео не готово — плавная прокрутка к блоку без проигрывания', () => {
  const p = page({ playable: false });
  p.wheel(100); p.tick(4000);
  assert.equal(p.win.scrollY, 2247);
  assert.equal(p.video.paused, true);
});

// ── 15.11.2026: «после одного свайпа сразу начался двигаться кадр» ──
test('шаг с блока: видео стартует без лишней перемотки (кадр уже на месте)', () => {
  const p = page();
  p.wheel(100); p.tick(14000);                     // стоим на втором блоке, кадр выставлен
  const before = p.video.sets.length;
  p.wheel(100);
  assert.equal(p.video.paused, false, 'видео запущено тем же событием');
  assert.equal(p.video.sets.length, before, 'перемотки перед стартом нет');
  assert.equal(p.video.playbackRate, 2);
});

test('палец: шаг начинается на движении 24 px, отпускание не даёт второй шаг', () => {
  const p = page();
  const t = (y) => ({ touches: [{ clientY: y, clientX: 100 }], changedTouches: [{ clientY: y, clientX: 100 }] });
  p.fire('touchstart', t(500));
  p.fire('touchmove', t(490));
  assert.equal(p.video.paused, true, '10 px — ещё не шаг');
  p.fire('touchmove', t(470));
  assert.equal(p.video.paused, false, '30 px — видео пошло, палец ещё на экране');
  p.fire('touchmove', t(300));
  p.fire('touchend', t(300));
  p.tick(20000);
  assert.equal(p.win.scrollY, 2247, 'ровно один блок');
});

test('новый свайп на хвосте инерции срабатывает, сама инерция — нет', () => {
  const p = page();
  p.wheel(100); p.tick(14000);                     // на втором блоке
  p.wheel(100);                                    // свайп к третьему
  for (const d of [80, 60, 40, 25, 15, 8]) { p.tick(48); p.fire('wheel', { deltaY: d, deltaX: 0 }); }   // затухание
  p.tick(300);
  for (const d of [6, 5, 4]) { p.tick(48); p.fire('wheel', { deltaY: d, deltaX: 0 }); }
  p.tick(48); p.fire('wheel', { deltaY: 90, deltaX: 0 });   // новый свайп без паузы 300 мс
  p.tick(30000);
  assert.equal(p.win.scrollY, 6272, 'ушли к четвёртому блоку');
});
