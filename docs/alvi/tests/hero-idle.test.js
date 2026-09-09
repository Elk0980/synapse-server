/* Run: node --test docs/alvi/tests/hero-idle.test.js */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.resolve(__dirname, "../../../sites/alvi/hero-idle.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ eligible = true, isIOS = true, plans = [], canPlay, responsive = false, compact = true } = {}) {
  const win = new EventTarget();
  const timers = new Map();
  let timerId = 0;
  win.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  win.clearTimeout = (id) => timers.delete(id);
  const doc = new EventTarget();
  doc.hidden = false;
  doc.defaultView = win;
  const video = new EventTarget();
  Object.assign(video, {
    ownerDocument: doc,
    style: {},
    paused: true,
    readyState: 0,
    playCalls: 0,
    pauseCalls: 0,
    loadedSources: [],
    attributes: {},
    canPlayType: () => "probably",
    setAttribute(name, value) { this.attributes[name] = value; },
    load() {
      this.loadedSources.push(this.src);
      this.paused = true;
      this.readyState = 0;
    },
    pause() { this.pauseCalls += 1; this.paused = true; },
    play() {
      this.playCalls += 1;
      const plan = plans.shift();
      if (plan) return plan(this);
      this.paused = false;
      this.readyState = 4;
      this.dispatchEvent(new Event("playing"));
      return Promise.resolve();
    }
  });
  const state = { eligible, compact, scrolled: false, scrollY: 0, onPlayingCalls: 0 };
  vm.runInNewContext(script, { window: win, Promise });
  const factory = responsive ? win.AlviHeroIdle.createResponsive : win.AlviHeroIdle.create;
  const controller = factory({
    video,
    isIOS,
    sources: { webm: "video/alvi-idle.webm", mp4: "video/alvi-idle.mp4" },
    canPlay: canPlay || (() => state.eligible),
    isCompactMode: () => state.compact,
    hasUserScrolled: () => state.scrolled,
    scrollY: () => state.scrollY,
    onPlaying: () => { state.onPlayingCalls += 1; }
  });
  return { controller, video, win, doc, state, timers };
}

test("iOS starts muted inline MP4 and exposes it only after playback", async () => {
  const pending = deferred();
  const f = fixture({ plans: [() => pending.promise] });
  f.controller.sync();
  assert.deepEqual(f.video.loadedSources, ["video/alvi-idle.mp4"]);
  assert.equal(f.video.muted, true);
  assert.equal(f.video.defaultMuted, true);
  assert.equal(f.video.playsInline, true);
  assert.equal(f.video.controls, false);
  assert.equal(f.video.disablePictureInPicture, true);
  assert.equal(f.video.style.opacity, "0");
  assert.equal(f.state.onPlayingCalls, 0);
  // Small scroll/layout notifications while scene 0 is eligible must not cancel loading.
  for (let i = 0; i < 10; i += 1) f.controller.sync();
  assert.equal(f.video.playCalls, 1);
  f.video.paused = false;
  f.video.readyState = 4;
  f.video.dispatchEvent(new Event("playing"));
  pending.resolve();
  await flush();
  assert.equal(f.video.style.opacity, "1");
  assert.equal(f.state.onPlayingCalls, 1);
});

test("leaving the first scene pauses immediately; returning resumes the same source", async () => {
  const f = fixture();
  f.controller.sync();
  await flush();
  f.state.eligible = false;
  f.controller.sync();
  assert.equal(f.video.paused, true);
  assert.equal(f.video.style.opacity, "0");
  f.state.eligible = true;
  f.controller.sync();
  await flush();
  assert.equal(f.video.paused, false);
  assert.equal(f.video.style.opacity, "1");
  assert.equal(f.video.playCalls, 2);
  assert.equal(f.video.loadedSources.length, 1);
});

test("autoplay denial recovers on ordinary touch without repeated automatic attempts", async () => {
  const f = fixture({ plans: [() => Promise.reject({ name: "NotAllowedError" })] });
  f.controller.sync();
  await flush();
  assert.equal(f.video.style.opacity, "0");
  for (let i = 0; i < 5; i += 1) f.controller.sync();
  assert.equal(f.video.playCalls, 1);
  f.doc.dispatchEvent(new Event("touchend"));
  // The second play() must run within the ordinary touch, before any awaited work.
  assert.equal(f.video.playCalls, 2);
  await flush();
  assert.equal(f.video.style.opacity, "1");
});

test("ordinary click and keyboard interactions recover without duplicating a pending attempt", async () => {
  for (const type of ["click", "keydown"]) {
    const pending = deferred();
    const f = fixture({ plans: [() => Promise.reject({ name: "NotAllowedError" }), () => pending.promise] });
    f.controller.sync();
    await flush();
    f.doc.dispatchEvent(new Event(type));
    assert.equal(f.video.playCalls, 2);
    f.doc.dispatchEvent(new Event(type));
    assert.equal(f.video.playCalls, 2);
    f.video.paused = false;
    f.video.readyState = 4;
    pending.resolve();
    await flush();
    assert.equal(f.video.style.opacity, "1");
  }
});

test("gesture recovery does not play offscreen, in a hidden tab or after destruction", async () => {
  const f = fixture({ plans: [() => Promise.reject({ name: "NotAllowedError" })] });
  f.controller.sync();
  await flush();
  f.state.eligible = false;
  f.controller.sync();
  f.doc.dispatchEvent(new Event("touchend"));
  assert.equal(f.video.playCalls, 1);
  f.state.eligible = true;
  f.doc.hidden = true;
  f.doc.dispatchEvent(new Event("click"));
  assert.equal(f.video.playCalls, 1);
  f.doc.hidden = false;
  f.controller.destroy();
  for (const type of ["touchend", "click", "keydown"]) f.doc.dispatchEvent(new Event(type));
  assert.equal(f.video.playCalls, 1);
});

test("repeated refusal leaves the fallback, but a later ordinary interaction can recover", async () => {
  const f = fixture({ plans: [
    () => Promise.reject({ name: "NotAllowedError" }),
    () => Promise.reject({ name: "NotAllowedError" })
  ] });
  f.controller.sync();
  await flush();
  f.doc.dispatchEvent(new Event("touchend"));
  await flush();
  assert.equal(f.video.style.opacity, "0");
  f.controller.sync();
  assert.equal(f.video.playCalls, 2);
  f.doc.dispatchEvent(new Event("click"));
  await flush();
  assert.equal(f.video.playCalls, 3);
  assert.equal(f.video.style.opacity, "1");
});

test("an unsupported MP4 advances to WebM, while complete media failure keeps the fallback", async () => {
  const f = fixture({ plans: [() => Promise.reject({ name: "NotSupportedError" })] });
  f.controller.sync();
  await flush();
  assert.deepEqual(f.video.loadedSources, ["video/alvi-idle.mp4", "video/alvi-idle.webm"]);
  assert.equal(f.video.style.opacity, "1");
  f.video.dispatchEvent(new Event("error"));
  assert.equal(f.video.style.opacity, "0");
  f.controller.sync();
  assert.equal(f.video.loadedSources.length, 2);
});

test("a source error also falls back when the original play promise is still pending", async () => {
  const pending = deferred();
  const f = fixture({ plans: [() => pending.promise] });
  f.controller.sync();
  f.video.dispatchEvent(new Event("error"));
  pending.reject({ name: "AbortError" });
  await flush();
  assert.equal(f.video.src, "video/alvi-idle.webm");
  assert.equal(f.video.style.opacity, "1");
});

test("an old play promise cannot hide or pause a newly resumed video", async () => {
  const pending = deferred();
  const f = fixture({ plans: [() => pending.promise] });
  f.controller.sync();
  f.state.eligible = false;
  f.controller.sync();
  f.state.eligible = true;
  f.controller.sync();
  pending.reject({ name: "NotAllowedError" });
  await flush();
  assert.equal(f.video.paused, false);
  assert.equal(f.video.style.opacity, "1");
});

test("visibility and page restoration pause and resume without reloading the source", async () => {
  const f = fixture();
  f.controller.sync();
  await flush();
  f.doc.hidden = true;
  f.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(f.video.paused, true);
  f.doc.hidden = false;
  f.doc.dispatchEvent(new Event("visibilitychange"));
  await flush();
  assert.equal(f.video.paused, false);
  f.win.dispatchEvent(new Event("pagehide"));
  assert.equal(f.video.paused, true);
  f.win.dispatchEvent(new Event("pageshow"));
  await flush();
  assert.equal(f.video.paused, false);
  assert.equal(f.video.loadedSources.length, 1);
});

test("ineligible/reduced-motion state never loads video and can recover when re-enabled", async () => {
  const f = fixture({ eligible: false });
  f.controller.sync();
  assert.equal(f.video.loadedSources.length, 0);
  assert.equal(f.video.playCalls, 0);
  f.state.eligible = true;
  f.controller.sync();
  await flush();
  assert.equal(f.video.style.opacity, "1");
  f.state.eligible = false;
  f.controller.sync();
  assert.equal(f.video.paused, true);
  assert.equal(f.video.style.opacity, "0");
});

test("actual page eligibility keeps the mobile first scene playing after a small scroll", async () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../../../sites/alvi/index.html"), "utf8");
  const match = html.match(/canPlay:\s*(\(\)\s*=>[\s\S]*?),\s*onPlaying:\s*hidePoster/);
  assert.ok(match, "The page must pass its eligibility callback to the controller");
  const context = {
    ALVI_MEDIA: { idle: { enabled: true } },
    reducedMotionQuery: { matches: false },
    compactModeActive: true,
    activeCompactSceneId: "0",
    hasUserScrolled: false
  };
  const canPlay = vm.runInNewContext("(" + match[1] + ")", context);
  const f = fixture({ canPlay });
  f.controller.sync();
  await flush();
  context.hasUserScrolled = true;
  f.controller.sync();
  assert.equal(f.video.paused, false);
  assert.equal(f.video.playCalls, 1);
  context.activeCompactSceneId = "1";
  f.controller.sync();
  assert.equal(f.video.paused, true);
  context.activeCompactSceneId = "0";
  f.controller.sync();
  await flush();
  assert.equal(f.video.paused, false);
  context.reducedMotionQuery.matches = true;
  f.controller.sync();
  assert.equal(f.video.paused, true);
});


test("approved desktop waits for canplay and preserves the 4px/500ms retirement", async () => {
  const f = fixture({ responsive: true, compact: false });
  f.controller.sync();
  assert.deepEqual(f.video.loadedSources, ["video/alvi-idle.webm"]);
  assert.equal(f.video.playCalls, 0);
  f.video.dispatchEvent(new Event("canplay"));
  await flush();
  assert.equal(f.video.style.opacity, "1");
  f.state.scrolled = true;
  f.state.scrollY = 4;
  f.controller.sync();
  assert.equal(f.video.paused, false);
  assert.equal(f.video.style.opacity, "1");
  f.state.scrollY = 5;
  f.controller.sync();
  assert.equal(f.video.style.opacity, "0");
  assert.equal(f.video.paused, false);
  assert.equal(f.timers.size, 1);
  const timer = [...f.timers.values()][0];
  assert.equal(timer.delay, 500);
  timer.callback();
  assert.equal(f.video.paused, true);
  f.state.scrollY = 0;
  f.controller.sync();
  assert.equal(f.video.playCalls, 1);
});

test("desktop autoplay denial stays on its poster without a new action or lifecycle retries", async () => {
  const f = fixture({ responsive: true, compact: false, plans: [() => Promise.reject({ name: "NotAllowedError" })] });
  f.controller.sync();
  f.video.dispatchEvent(new Event("canplay"));
  await flush();
  f.doc.hidden = true;
  f.doc.dispatchEvent(new Event("visibilitychange"));
  f.doc.hidden = false;
  f.doc.dispatchEvent(new Event("visibilitychange"));
  f.win.dispatchEvent(new Event("pageshow"));
  f.doc.dispatchEvent(new Event("touchend"));
  f.controller.sync();
  assert.equal(f.video.playCalls, 1);
  assert.equal(f.state.onPlayingCalls, 0);
});

test("desktop falls back to MP4 after a source error and does not start at a scrolled entry", async () => {
  const f = fixture({ responsive: true, compact: false });
  f.controller.sync();
  f.video.dispatchEvent(new Event("error"));
  assert.deepEqual(f.video.loadedSources, ["video/alvi-idle.webm", "video/alvi-idle.mp4"]);
  f.video.dispatchEvent(new Event("canplay"));
  await flush();
  assert.equal(f.video.style.opacity, "1");
  const scrolled = fixture({ responsive: true, compact: false });
  scrolled.state.scrolled = true;
  scrolled.state.scrollY = 100;
  scrolled.controller.sync();
  assert.equal(scrolled.video.loadedSources.length, 0);
  assert.equal(scrolled.video.playCalls, 0);
});

test("desktop to mobile switches preserve mobile autoplay recovery and cancel the old fade timer", async () => {
  const f = fixture({ responsive: true, compact: false });
  f.controller.sync();
  f.video.dispatchEvent(new Event("canplay"));
  await flush();
  f.state.scrolled = true;
  f.state.scrollY = 10;
  f.controller.sync();
  assert.equal(f.timers.size, 1);
  f.state.compact = true;
  f.controller.sync();
  await flush();
  assert.equal(f.timers.size, 0);
  assert.equal(f.video.src, "video/alvi-idle.mp4");
  assert.equal(f.video.paused, false);
  f.state.eligible = false;
  f.controller.sync();
  assert.equal(f.video.paused, true);
  f.state.eligible = true;
  f.controller.sync();
  await flush();
  assert.equal(f.video.paused, false);
});

test("leaving mobile removes its handlers and stale promises cannot interrupt desktop", async () => {
  const pending = deferred();
  const f = fixture({ responsive: true, plans: [() => pending.promise] });
  f.controller.sync();
  f.state.compact = false;
  f.controller.sync();
  f.video.dispatchEvent(new Event("canplay"));
  await flush();
  assert.equal(f.video.style.opacity, "1");
  pending.reject({ name: "NotAllowedError" });
  await flush();
  f.doc.hidden = true;
  f.doc.dispatchEvent(new Event("visibilitychange"));
  f.win.dispatchEvent(new Event("pagehide"));
  assert.equal(f.video.paused, false);
  assert.equal(f.video.style.opacity, "1");
});
