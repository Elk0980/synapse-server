'use strict';
// Общие помощники детерминированных тестов Метрики ALVI. Запуск: см. tests/README в QA.md.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SITE = path.join(__dirname, '..');
const ORIGIN = 'https://alvi.synapsebusiness.ru';

function read(name) { return fs.readFileSync(path.join(SITE, name), 'utf8'); }

// Поддельные часы: время двигается только вручную, таймеры срабатывают по tick().
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + (ms || 0), fn }); return id; },
    tick(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    }
  };
}

function dom(html, url, extra) {
  return new JSDOM(html, Object.assign({ url, pretendToBeVisual: true }, extra || {}));
}

function setViewport(win, width, height) {
  Object.defineProperty(win, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: height, configurable: true });
}

function setVisibility(doc, state) {
  Object.defineProperty(doc, 'visibilityState', { get: () => state, configurable: true });
  doc.dispatchEvent(new doc.defaultView.Event('visibilitychange'));
}

function setRect(el, top, height, left = 0, width = 1000) {
  el.getBoundingClientRect = () => ({ top, bottom: top + height, left, right: left + width, width, height, x: left, y: top });
}

function loadMetrika() {
  const file = path.join(SITE, 'metrika.js');
  delete require.cache[require.resolve(file)];
  return require(file);
}

function click(win, el) {
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

module.exports = { read, fakeClock, dom, setViewport, setVisibility, setRect, loadMetrika, click, ORIGIN, SITE };
