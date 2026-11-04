'use strict';
// node --test caddy/caddy-frame-headers.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'Caddyfile'), 'utf8');

function siteBlock(host) {
  const start = source.search(new RegExp(`^${host.replace(/\./g, '\\.')}\\s*\\{`, 'm'));
  assert.ok(start >= 0, `блок ${host} не найден`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`блок ${host} не закрыт`);
}

test('кабинет встраивается только своим доменом и панелью черновиков', () => {
  const block = siteBlock('synapse.synapsebusiness.ru');
  assert.match(block, /@not_miniapp not path \/miniapp\.html/);
  const line = /header @not_miniapp (.+)/.exec(block);
  assert.ok(line, 'нет заголовка для страниц кабинета');
  assert.equal(line[1].trim(), `Content-Security-Policy "frame-ancestors 'self' https://panel.synapsebusiness.ru"`);
  // X-Frame-Options не умеет список доменов и сломал бы превью панели.
  assert.doesNotMatch(block, /^\s*(header .*)?X-Frame-Options \S/m);
});

test('превью панели встраивает именно разрешённый домен', () => {
  const panel = fs.readFileSync(path.join(__dirname, '..', 'panel', 'index.html'), 'utf8');
  assert.match(panel, /<iframe src="https:\/\/synapse\.synapsebusiness\.ru\//);
  assert.ok(siteBlock('panel.synapsebusiness.ru'));
});

test('мини-приложение Telegram сохраняет собственные рамки', () => {
  const block = siteBlock('synapse.synapsebusiness.ru');
  const miniapp = /header @miniapp \{([\s\S]*?)\n  \}/.exec(block);
  assert.ok(miniapp);
  assert.match(miniapp[1], /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.doesNotMatch(miniapp[1], /X-Frame-Options/);
});

test('чат остаётся встраиваемым в кабинет', () => {
  assert.doesNotMatch(siteBlock('chat.synapsebusiness.ru'), /X-Frame-Options|frame-ancestors/);
});
