'use strict';
// №126: плавающая кнопка Хью не перекрывает поле ввода и «Отправить» на ПК.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const css = fs.readFileSync(path.join(__dirname, 'shell.css'), 'utf8');

function cabinet(t) {
  const dom = new JSDOM(`<!doctype html><head><style>${css}</style></head><body><main class="main"></main></body>`,
    { runScripts: 'outside-only', url: 'https://cabinet.test/', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(__dirname, 'module-registry.js'), 'utf8'));
  w.SynapseModules.attachShell({ identity: () => ({ userId: 1, role: 'owner', csrfToken: 'x' }), company: () => ({ id: 'alvi', name: 'ALVI' }),
    apiJson: async () => ({}), crmQuery() {}, navigate() {}, escapeHTML: v => v });
  return w;
}

test('на «Чатах» и в чате проекта кнопка Хью скрыта на любой ширине, на других экранах видна', t => {
  const w = cabinet(t), fab = w.document.getElementById('hugh-chat-fab');
  assert.ok(fab, 'кнопка создана реестром');
  for (const view of ['chats', 'hugh']) {
    w.document.body.dataset.cabinetView = view;
    assert.equal(w.getComputedStyle(fab).display, 'none', `экран ${view}`);
  }
  for (const view of ['tasks', 'home', 'content-plan']) {
    w.document.body.dataset.cabinetView = view;
    assert.notEqual(w.getComputedStyle(fab).display, 'none', `экран ${view}`);
  }
});

test('на ПК конец экрана не уходит под кнопку: нижний отступ .main больше кнопки с её отступом', () => {
  const block = /@media\s*\(min-width:\s*761px\)\s*\{([^}]*\})/.exec(css);
  assert.ok(block, 'есть правило для ПК');
  const pad = /\.main\s*\{[^}]*padding-bottom:\s*(\d+)px/.exec(block[1]);
  assert.ok(pad, 'нижний отступ .main на ПК');
  const fab = /\.sb-chat-fab\s*\{[^}]*bottom:\s*(\d+)px[^}]*height:\s*(\d+)px/s.exec(css);
  assert.ok(Number(pad[1]) >= Number(fab[1]) + Number(fab[2]), `${pad[1]} ≥ ${fab[1]}+${fab[2]}`);
});
