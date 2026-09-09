'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../../sites/alvi');
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/price.json'), 'utf8'));
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'price-render.js'), 'utf8'), { window });
const booking = 'https://n1070017.yclients.com/';
const chat = 'https://t.me/+79246180555';
function links(html, label) {
  return [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)]
    .filter(m => m[2].trim() === label).map(m => m[1]);
}
function checkBookings(html) {
  const found = links(html, 'Записаться');
  assert.ok(found.length > 0, 'Booking actions must exist');
  assert.ok(found.every(url => url === booking));
}
test('legacy API booking links cannot restore Telegram in price or showcase actions', () => {
  const legacy = { ...data, links: { book: chat, chat } };
  for (const html of [window.AlviPrice.renderSections(legacy), window.AlviPrice.renderShowcase(legacy, 'self'), window.AlviPrice.renderShowcase(legacy, 'two')]) {
    checkBookings(html);
    const help = links(html, 'Помочь с выбором');
    assert.ok(help.length > 0);
    assert.ok(help.every(url => url === chat));
  }
  const cert = links(window.AlviPrice.renderSections(legacy), legacy.certificates.button || 'Оформить сертификат');
  assert.deepEqual(cert, [chat]);
});
test('static main, quiz and price actions work with JavaScript unavailable', () => {
  for (const name of ['index.html', 'price.html']) checkBookings(fs.readFileSync(path.join(root, name), 'utf8'));
  assert.equal(data.links.book, booking);
  assert.equal(data.links.chat, chat);
});
