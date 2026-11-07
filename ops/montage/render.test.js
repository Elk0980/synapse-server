'use strict';
// node --test ops/montage/render.test.js — нужен ffmpeg; клипы генерируются lavfi во временной папке.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('./render');
const {hasFfmpeg, tmp, colorClip, colorAt, dominant, maxVolume} = require('./test-support');

const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'].find((file) => fs.existsSync(file));
const skip = !hasFfmpeg() && 'ffmpeg не установлен';
const small = {width: 160, height: 284, fps: 25, threads: 1};

test('Аргументы: только локальные файлы, без оболочки, титр через textfile без раскрытия шаблонов', () => {
  const info = {durationMs: 4000, width: 160, height: 284, hasAudio: true};
  const {args, plan} = engine.buildArgs(engine.planFromEdl({v: 1, video: [{inMs: 2000, outMs: 3000}, {inMs: 0, outMs: 9000}], audio: [], captions: [{startMs: 0, endMs: 500, text: '%{pts} x'}], speed: 1.5},
    '/work/a/base.mp4', info), {output: '/work/a/out.mp4', captionFiles: ['/work/a/caption-0.txt'], font: '/f/font.ttf', ...small});
  assert.equal(plan.totalMs, 5000, 'клип за концом исходника обрезан по его длине');
  assert.equal(plan.outputMs, Math.round(5000 / 1.5));
  assert.deepEqual(args.filter((item, i) => args[i - 1] === '-protocol_whitelist'), ['file']);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /textfile=\/work\/a\/caption-0\.txt:expansion=none/);
  assert.match(graph, /atempo=1\.5/);
  assert.ok(!graph.includes('%{pts}'), 'текст титра не попадает в граф фильтров');
  assert.throws(() => engine.buildArgs(engine.planFromEdl({v: 1, video: [{inMs: 0, outMs: 1000}]}, '/work/a/b;rm -rf.mp4', info), {output: '/work/o.mp4'}), {code: 'BAD_PATH'});
  assert.throws(() => engine.planFromEdl({v: 2, video: []}, '/w/a.mp4', info), {code: 'BAD_EDL'});
  assert.throws(() => engine.normalizePlan(engine.planFromEdl({v: 1, video: [{inMs: 5000, outMs: 6000}]}, '/w/a.mp4', info)), {code: 'EMPTY_TIMELINE'});
});

test('Тишина: обрезка начала и хвоста реплики, полностью тихий дубль не режется', () => {
  const marks = engine.parseSilence('[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 1.02 | silence_duration: 1.02\n[silencedetect @ 0x1] silence_start: 3.01\n');
  assert.deepEqual(engine.speechBounds(marks, 4000), {inMs: 870, outMs: 3260, trimmed: true});
  assert.deepEqual(engine.speechBounds([{start: 0}], 4000), {inMs: 0, outMs: 4000, trimmed: false});
  assert.deepEqual(engine.speechBounds([], 4000), {inMs: 0, outMs: 4000, trimmed: false});
});

test('EDL ffmpeg-ом: перестановка, вырезка, без звука, скорость, титр и обложка', {skip}, async () => {
  const dir = tmp('montage-render-');
  try {
    const source = colorClip(path.join(dir, 'base.mp4'));
    const info = await engine.probe(source);
    assert.equal(info.hasAudio, true);
    // Синий (2–3 с) → красный (0–1 с) → белый (3–4 с), звук выключен, скорость 1.25.
    const edl = {v: 1, video: [{inMs: 2000, outMs: 3000}, {inMs: 0, outMs: 1000}, {inMs: 3000, outMs: 4000}],
      audio: [{inMs: 0, outMs: 3000, gain: 1, muted: true}], captions: [{startMs: 0, endMs: 1000, text: 'Первая сцена — титр'}], coverMs: 1500, speed: 1.25};
    const result = await engine.render(engine.planFromEdl(edl, source, info), {output: path.join(dir, 'out.mp4'), workDir: dir, font: FONT, ...small, coverMs: edl.coverMs});
    const out = await engine.probe(result.output);
    assert.ok(Math.abs(out.durationMs - 2400) < 150, `длительность ${out.durationMs} ≈ 3000/1.25`);
    assert.equal(out.width, 160); assert.equal(out.height, 284);
    assert.equal(dominant(colorAt(result.output, 0.2)), 'blue');
    assert.equal(dominant(colorAt(result.output, 1.2)), 'red');
    assert.equal(dominant(colorAt(result.output, 2.0)), 'white');
    assert.ok(maxVolume(result.output) < -60, 'звук выключен');
    assert.ok(fs.statSync(result.cover).size > 100, 'обложка JPEG создана');
    assert.equal(fs.readFileSync(result.cover).subarray(0, 2).toString('hex'), 'ffd8');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('EDL: громкость 0.5 тише исходника, исходник без звука даёт тихую дорожку', {skip}, async () => {
  const dir = tmp('montage-gain-');
  try {
    const source = colorClip(path.join(dir, 'base.mp4'), ['red', 'green']);
    const info = await engine.probe(source);
    const loud = await engine.render(engine.planFromEdl({v: 1, video: [{inMs: 0, outMs: 2000}], audio: [{inMs: 0, outMs: 2000, gain: 1}]}, source, info), {output: path.join(dir, 'a.mp4'), workDir: dir, ...small});
    const quiet = await engine.render(engine.planFromEdl({v: 1, video: [{inMs: 0, outMs: 2000}], audio: [{inMs: 0, outMs: 2000, gain: 0.5}]}, source, info), {output: path.join(dir, 'b.mp4'), workDir: dir, ...small});
    const delta = maxVolume(loud.output) - maxVolume(quiet.output);
    assert.ok(delta > 4 && delta < 8, `−6 дБ ожидается, получено ${delta}`);
    const mute = colorClip(path.join(dir, 'mute.mp4'), ['blue'], {audio: 'none'});
    const muteInfo = await engine.probe(mute);
    assert.equal(muteInfo.hasAudio, false);
    const out = await engine.render(engine.planFromEdl({v: 1, video: [{inMs: 0, outMs: 1000}], audio: [{inMs: 0, outMs: 1000}]}, mute, muteInfo), {output: path.join(dir, 'c.mp4'), workDir: dir, ...small});
    assert.equal((await engine.probe(out.output)).hasAudio, true, 'в ролике есть дорожка звука (тишина) для площадок');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
