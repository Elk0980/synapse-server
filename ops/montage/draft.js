'use strict';
/* Черновик ролика из дублей съёмки по сценарию (specs/214-auto-montage, FR-5…FR-7).
   Сцена = кадр сценария (тот же разбор, что у экрана «Съёмка» и суфлёра); дубль сцены — последняя
   загрузка kind=take с этим номером кадра. Сцены без дубля пропускаются и перечисляются в заметке версии.
   Титры — колонка «Титр» сценария на время своей сцены. */
const path = require('node:path');

function loadScriptParser() {
  for (const candidate of ['./shooting-script.js', '../../sites/synapse/cabinet/shooting-script.js']) {
    try { return require(path.join(__dirname, candidate)); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw Object.assign(new Error('Не найден разбор сценария shooting-script.js'), {code: 'NO_PARSER'});
}

/* Чистое планирование без ffmpeg: takes = [{id, frame, file, probe, bounds?}] (bounds — обрезка тишины). */
function planDraft({script, hook = '', topic = ''}, takes, {parser = loadScriptParser()} = {}) {
  const {frames} = parser.parse(script, {hook, topic});
  const inputs = [], video = [], audio = [], captions = [], scenes = [], missing = [];
  let offset = 0;
  for (const frame of frames) {
    const take = takes.filter((item) => item.frame === frame.n).sort((a, b) => b.id - a.id)[0];
    if (!take) { missing.push(frame.n); continue; }
    const input = inputs.push({file: take.file, probe: take.probe}) - 1;
    const bounds = frame.type === 'line' && take.bounds ? take.bounds : {inMs: 0, outMs: take.probe.durationMs, trimmed: false};
    const length = bounds.outMs - bounds.inMs;
    if (length < 100) { missing.push(frame.n); inputs.pop(); continue; }
    video.push({input, inMs: bounds.inMs, outMs: bounds.outMs});
    audio.push({input, inMs: bounds.inMs, outMs: bounds.outMs, gain: 1, muted: false});
    const title = String(frame.title || '').trim();
    if (title) captions.push({startMs: offset, endMs: offset + length, text: title.slice(0, 120)});
    scenes.push({n: frame.n, takeId: take.id, inMs: bounds.inMs, outMs: bounds.outMs, trimmed: Boolean(bounds.trimmed), title});
    offset += length;
  }
  return {plan: {inputs, video, audio, captions, speed: 1}, scenes, missing, sceneCount: frames.length};
}

function draftNote({scenes, missing, sceneCount}, extra = []) {
  const parts = [`Автомонтаж: черновик из дублей, сцен ${scenes.length} из ${sceneCount}`];
  if (missing.length) parts.push(`нет дубля: сцены ${missing.join(', ')}`);
  const trimmed = scenes.filter((item) => item.trimmed).map((item) => item.n);
  if (trimmed.length) parts.push(`обрезана тишина: сцены ${trimmed.join(', ')}`);
  const titled = scenes.filter((item) => item.title).length;
  parts.push(titled ? `титры: ${titled}` : 'титров в сценарии нет');
  return [...parts, ...extra].join('; ').slice(0, 1000);
}

module.exports = {planDraft, draftNote, loadScriptParser};
