'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.resolve(__dirname, '../../../sites/alvi/background-water.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ deny = false, reduced = false, saving = false, hero = false, contact = false, plan } = {}) {
  const doc = new EventTarget();
  doc.hidden = false;
  const win = new EventTarget();
  win.innerHeight = 800;
  win.scrollY = 0;
  win.requestAnimationFrame = callback => callback();
  const media = new EventTarget();
  media.matches = reduced;
  win.matchMedia = () => media;
  const connection = new EventTarget();
  connection.saveData = saving;
  const classes = new Set(contact ? ['water-surface'] : ['water-surface', 'page-water']);
  const video = new EventTarget();
  Object.assign(video, {
    paused: true, playCalls: 0, pauseCalls: 0, controls: true,
    play() {
      this.playCalls++;
      if (plan) return plan(this);
      if (deny) return Promise.reject(new Error('NotAllowedError'));
      this.paused = false;
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    },
    pause() { this.pauseCalls++; this.paused = true; this.dispatchEvent(new Event('pause')); }
  });
  const layer = {
    rect: { top: 0, bottom: 900 },
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }
    },
    getBoundingClientRect() { return this.rect; },
    querySelector: () => video
  };
  doc.querySelectorAll = () => [layer];
  doc.querySelector = () => hero ? { offsetHeight: 3000 } : null;
  vm.runInNewContext(script, { document: doc, window: win, navigator: { connection }, Promise });
  return { doc, win, video, layer, media, connection, classes, allow: () => { deny = false; } };
}

test('autoplay refusal leaves moving decoration and no player, then touch recovers playback', async () => {
  const f = fixture({ deny: true });
  await flush();
  assert.equal(f.video.playCalls, 1);
  assert.equal(f.video.controls, false);
  assert.equal(f.video.muted, true);
  assert.equal(f.video.defaultMuted, true);
  assert.equal(f.video.playsInline, true);
  assert.equal(f.classes.has('is-active'), true);
  assert.equal(f.classes.has('is-playing'), false);
  for (let i = 0; i < 20; i++) f.win.dispatchEvent(new Event('scroll'));
  assert.equal(f.video.playCalls, 1, 'scroll notifications must not cause a retry loop');
  f.allow();
  f.doc.dispatchEvent(new Event('touchend'));
  assert.equal(f.video.playCalls, 2, 'retry occurs synchronously in the gesture');
  await flush();
  assert.equal(f.classes.has('is-playing'), true);
});

test('a loading or waiting video remains hidden until it is actually playing', async () => {
  let resolve;
  const f = fixture({ plan: () => new Promise(done => { resolve = done; }) });
  assert.equal(f.classes.has('is-playing'), false);
  f.video.paused = false;
  f.video.dispatchEvent(new Event('playing'));
  assert.equal(f.classes.has('is-playing'), true);
  resolve(); await flush();
  f.video.dispatchEvent(new Event('waiting'));
  assert.equal(f.classes.has('is-playing'), false);
  f.video.dispatchEvent(new Event('playing'));
  assert.equal(f.classes.has('is-playing'), true);
  f.video.pause();
  assert.equal(f.classes.has('is-playing'), false);
});

test('hidden tabs pause decoration and resume when visible', async () => {
  const f = fixture(); await flush();
  f.doc.hidden = true;
  f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.video.paused, true);
  assert.equal(f.classes.has('is-active'), false);
  assert.equal(f.classes.has('is-playing'), false);
  f.doc.hidden = false;
  f.doc.dispatchEvent(new Event('visibilitychange'));
  await flush();
  assert.equal(f.classes.has('is-playing'), true);
});

test('reduced motion stays still while data saving keeps only the CSS fallback', async () => {
  const f = fixture({ reduced: true });
  f.doc.dispatchEvent(new Event('touchend'));
  assert.equal(f.video.playCalls, 0);
  assert.equal(f.classes.has('is-active'), false);
  f.media.matches = false;
  f.connection.saveData = true;
  f.media.dispatchEvent(new Event('change'));
  assert.equal(f.video.playCalls, 0);
  assert.equal(f.classes.has('is-active'), true);
  f.connection.saveData = false;
  f.connection.dispatchEvent(new Event('change'));
  await flush();
  assert.equal(f.classes.has('is-playing'), true);
});

test('main background starts after the hero and contact background stops offscreen', async () => {
  const f = fixture({ hero: true });
  assert.equal(f.video.playCalls, 0);
  f.win.scrollY = 2200;
  f.win.dispatchEvent(new Event('scroll'));
  await flush();
  assert.equal(f.classes.has('is-on'), true);
  assert.equal(f.classes.has('is-playing'), true);
  f.win.scrollY = 0;
  f.win.dispatchEvent(new Event('scroll'));
  assert.equal(f.video.paused, true);
  assert.equal(f.classes.has('is-on'), false);
  const c = fixture({ contact: true }); await flush();
  c.layer.rect = { top: 1000, bottom: 1800 };
  c.win.dispatchEvent(new Event('scroll'));
  assert.equal(c.video.paused, true);
  assert.equal(c.classes.has('is-active'), false);
});

test('a stale rejected play cannot hide a newer successful playback', async () => {
  let reject;
  let calls = 0;
  const f = fixture({ plan(video) {
    if (++calls === 1) return new Promise((_, fail) => { reject = fail; });
    video.paused = false;
    video.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  } });
  f.doc.hidden = true;
  f.doc.dispatchEvent(new Event('visibilitychange'));
  f.doc.hidden = false;
  f.doc.dispatchEvent(new Event('visibilitychange'));
  await flush();
  reject(new Error('old request'));
  await flush();
  assert.equal(f.classes.has('is-playing'), true);
});
