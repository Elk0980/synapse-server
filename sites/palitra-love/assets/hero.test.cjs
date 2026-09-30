/* История по выбору посетителя: нет самопроизвольного воспроизведения,
   раскрытие запускает, сворачивание останавливает. Реальное декодирование видео — ручная приёмка. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('история не стартует при загрузке; ссылка открывает её; сворачивание останавливает видео', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://palitra-love.ru/', runScripts: 'outside-only' });
  const win = dom.window;
  const doc = win.document;
  win.matchMedia = () => ({ matches: false });
  win.HTMLElement.prototype.scrollIntoView = () => {};
  const video = doc.getElementById('hero-video');
  let plays = 0, paused = true;
  Object.defineProperty(video, 'paused', { get: () => paused });
  video.play = () => { plays += 1; paused = false; video.dispatchEvent(new win.Event('playing')); return Promise.resolve(); };
  video.pause = () => { paused = true; video.dispatchEvent(new win.Event('pause')); };
  video.load = () => {};
  win.eval(fs.readFileSync(path.join(__dirname, 'hero.js'), 'utf8'));
  assert.equal(video.hasAttribute('autoplay'), false);
  assert.equal(video.preload, 'none');
  assert.equal(plays, 0, 'покупатель сначала видит предложение, ролик не загружается автоматически');
  const story = doc.getElementById('brand-story');
  doc.querySelector('[data-story-open]').click();
  await new Promise(resolve => win.setTimeout(resolve, 10));
  assert.equal(story.open, true);
  assert.ok(plays >= 1);
  assert.equal(paused, false);
  assert.equal(video.hidden, false);
  assert.equal(doc.activeElement, story.querySelector('summary'));
  story.open = false;
  await new Promise(resolve => win.setTimeout(resolve, 10));
  assert.equal(paused, true, 'закрытый блок не продолжает воспроизведение');
  const cta = doc.querySelector('.signature-actions a');
  assert.equal(cta.getAttribute('href'), '/catalog');
  assert.equal(doc.querySelector('.signature-actions a.outline').getAttribute('href'), '#zayavka');
  win.close();
});
