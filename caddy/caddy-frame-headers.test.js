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

test('кабинет запрещает встраивание чужими доменами', () => {
  const block = siteBlock('synapse.synapsebusiness.ru');
  assert.match(block, /@not_miniapp not path \/miniapp\.html/);
  const headers = /header @not_miniapp \{([\s\S]*?)\}/.exec(block);
  assert.ok(headers, 'нет заголовков для страниц кабинета');
  assert.match(headers[1], /X-Frame-Options SAMEORIGIN/);
  assert.match(headers[1], /Content-Security-Policy "frame-ancestors 'self'"/);
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
