'use strict';
/* Движок автомонтажа (specs/214-auto-montage): EDL → аргументы ffmpeg и запуск без оболочки.
   Один движок для правок «Редактировать» (kind:edl) и для черновика из дублей съёмки.
   Безопасность: ffmpeg/ffprobe получают только локальные файлы (-protocol_whitelist file),
   аргументы передаются массивом, текст титров — через textfile без раскрытия %-шаблонов. */
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SPEEDS = Object.freeze([1, 1.25, 1.5]);
const SAFE_PATH = /^[A-Za-z0-9_\/.-]+$/;
const sec = (ms) => (Math.max(0, ms) / 1000).toFixed(3);

function fail(message, code = 'RENDER_FAILED') { throw Object.assign(new Error(message), {code}); }
function safePath(file) { if (!SAFE_PATH.test(file)) fail('Недопустимый путь файла монтажа: ' + JSON.stringify(file), 'BAD_PATH'); return file; }

/* Запуск процесса: таймаут → SIGKILL, хвост stderr для честной причины ошибки. */
function run(bin, args, {timeoutMs = 20 * 60 * 1000, cwd} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8'}});
    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16 * 1024); });
    child.on('error', (error) => { clearTimeout(timer); reject(Object.assign(new Error(`${path.basename(bin)} не запустился: ${error.message}`), {code: 'NO_FFMPEG'})); });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (killed) return reject(Object.assign(new Error(`${path.basename(bin)}: превышено время ${Math.round(timeoutMs / 1000)} с`), {code: 'TIMEOUT'}));
      if (status !== 0) return reject(Object.assign(new Error(`${path.basename(bin)} завершился с кодом ${status}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`), {code: 'RENDER_FAILED'}));
      resolve({stdout, stderr});
    });
  });
}

async function probe(file, {ffprobe = 'ffprobe', timeoutMs = 60000} = {}) {
  const {stdout} = await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries',
    'format=duration:stream=codec_type,width,height', '-of', 'json', safePath(file)], {timeoutMs});
  let data;
  try { data = JSON.parse(stdout); } catch { fail('ffprobe вернул не JSON', 'PROBE_FAILED'); }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((item) => item.codec_type === 'video');
  if (!video) fail('В файле нет видеодорожки', 'NO_VIDEO');
  const durationMs = Math.round(Number(data.format?.duration) * 1000);
  if (!Number.isFinite(durationMs) || durationMs < 100) fail('Не удалось определить длительность файла', 'PROBE_FAILED');
  return {durationMs, width: Number(video.width) || 0, height: Number(video.height) || 0, hasAudio: streams.some((item) => item.codec_type === 'audio')};
}

/* Перенос строк для drawtext (сам он строки не переносит). */
function wrap(text, width) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > width) { lines.push(line); line = word; } else line = line ? line + ' ' + word : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 4).join('\n');
}

/* План рендера — общий вид для EDL и черновика:
   inputs: [{file, probe}], video: [{input, inMs, outMs}], audio: [{input, inMs, outMs, gain, muted}] (пусто = тишина),
   captions: [{startMs, endMs, text}] на шкале до ускорения, speed: 1|1.25|1.5. Клипы за пределами файла обрезаются по его длине. */
function normalizePlan(plan) {
  if (!Array.isArray(plan.inputs) || !plan.inputs.length) fail('Нет исходных файлов', 'BAD_PLAN');
  const speed = plan.speed ?? 1;
  if (!SPEEDS.includes(speed)) fail('Скорость: 1, 1.25 или 1.5', 'BAD_PLAN');
  const clamp = (clip) => {
    const source = plan.inputs[clip.input];
    if (!source) fail('Клип ссылается на несуществующий файл', 'BAD_PLAN');
    const outMs = Math.min(clip.outMs, source.probe.durationMs), inMs = Math.max(0, clip.inMs);
    return outMs - inMs >= 100 ? {...clip, inMs, outMs} : null;
  };
  const video = (plan.video || []).map(clamp).filter(Boolean);
  if (!video.length) fail('После обрезки по длине исходника на видеодорожке не осталось клипов', 'EMPTY_TIMELINE');
  const audio = (plan.audio || []).map(clamp).filter(Boolean);
  const totalMs = video.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0);
  const captions = (plan.captions || []).filter((item) => item.text && item.startMs < totalMs)
    .map((item) => ({...item, endMs: Math.min(item.endMs, totalMs)}));
  return {...plan, speed, video, audio, captions, totalMs, outputMs: Math.round(totalMs / speed)};
}

function buildArgs(input, {output, captionFiles = [], font, width = 1080, height = 1920, fps = 30, threads = 2, crf = 23}) {
  const plan = normalizePlan(input);
  if (captionFiles.length !== plan.captions.length) fail('Файлы титров не совпадают с титрами', 'BAD_PLAN');
  if (plan.captions.length && !font) fail('Не задан шрифт титров (MONTAGE_FONT)', 'NO_FONT');
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  for (const item of plan.inputs) args.push('-protocol_whitelist', 'file', '-i', safePath(item.file));
  const norm = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`;
  const graph = [];
  plan.video.forEach((clip, i) => graph.push(`[${clip.input}:v]trim=start=${sec(clip.inMs)}:end=${sec(clip.outMs)},setpts=PTS-STARTPTS,${norm}[v${i}]`));
  graph.push(`${plan.video.map((_, i) => `[v${i}]`).join('')}concat=n=${plan.video.length}:v=1:a=0[vc]`);
  let last = 'vc';
  const fontSize = Math.max(12, Math.round(height / 28));
  plan.captions.forEach((caption, i) => {
    graph.push(`[${last}]drawtext=fontfile=${safePath(font)}:textfile=${safePath(captionFiles[i])}:expansion=none:fontsize=${fontSize}:fontcolor=white:` +
      `borderw=${Math.max(1, Math.round(fontSize / 10))}:bordercolor=black:line_spacing=${Math.round(fontSize / 4)}:x=(w-text_w)/2:y=h*0.70:` +
      `enable='between(t,${sec(caption.startMs)},${sec(caption.endMs)})'[t${i}]`);
    last = `t${i}`;
  });
  graph.push(`[${last}]setpts=PTS/${plan.speed}[vout]`);
  const audioFormat = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const audio = plan.audio.map((clip, i) => {
    const length = sec(clip.outMs - clip.inMs);
    if (!plan.inputs[clip.input].probe.hasAudio) graph.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${length},${audioFormat}[a${i}]`);
    else graph.push(`[${clip.input}:a]atrim=start=${sec(clip.inMs)}:end=${sec(clip.outMs)},asetpts=PTS-STARTPTS,${audioFormat},volume=${clip.muted ? 0 : clip.gain ?? 1}[a${i}]`);
    return `[a${i}]`;
  });
  if (audio.length) graph.push(`${audio.join('')}concat=n=${audio.length}:v=0:a=1[ac]`);
  else graph.push(`anullsrc=channel_layout=stereo:sample_rate=48000,${audioFormat}[ac]`);
  // Звук выравнивается по длине видео: короче — тишина в конце, длиннее — обрезка.
  graph.push(`[ac]apad,atrim=end=${sec(plan.totalMs)}${plan.speed === 1 ? '' : `,atempo=${plan.speed}`}[aout]`);
  args.push('-filter_complex', graph.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-maxrate', '6M', '-bufsize', '12M', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', '-threads', String(threads), safePath(output));
  return {args, plan};
}

/* Рендер плана в MP4 и кадр обложки JPEG. Титры пишутся во временные файлы рядом с результатом. */
async function render(plan, options) {
  const {output, workDir, ffmpeg = 'ffmpeg', timeoutMs, coverMs = null} = options;
  const normalized = normalizePlan(plan);
  // Ширина символа жирного шрифта ≈ 0,7 кегля; поле 88 % ширины кадра — титр не вылезает за края.
  const charsPerLine = Math.max(8, Math.floor((options.width || 1080) * 0.88 / (Math.max(12, Math.round((options.height || 1920) / 28)) * 0.7)));
  const captionFiles = normalized.captions.map((caption, i) => {
    const file = path.join(workDir, `caption-${i}.txt`);
    fs.writeFileSync(file, wrap(caption.text, charsPerLine), {mode: 0o600});
    return file;
  });
  const {args} = buildArgs(normalized, {...options, captionFiles});
  await run(ffmpeg, args, {timeoutMs});
  const cover = output.replace(/\.mp4$/, '') + '-cover.jpg';
  const at = coverMs === null || coverMs === undefined ? Math.min(1000, normalized.totalMs / 2) : Math.min(coverMs, normalized.totalMs - 50);
  await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file', '-ss', sec(at / normalized.speed),
    '-i', safePath(output), '-frames:v', '1', '-q:v', '3', safePath(cover)], {timeoutMs});
  return {output, cover, plan: normalized, outputMs: normalized.outputMs};
}

/* Правка EDL v1 «Материалов» → план рендера по одному исходнику (базовой версии ролика). */
function planFromEdl(edl, file, info) {
  if (!edl || edl.v !== 1 || !Array.isArray(edl.video)) fail('EDL: поддерживается версия 1', 'BAD_EDL');
  return {inputs: [{file, probe: info}], video: edl.video.map((clip) => ({input: 0, inMs: clip.inMs, outMs: clip.outMs})),
    audio: (edl.audio || []).map((clip) => ({input: 0, inMs: clip.inMs, outMs: clip.outMs, gain: clip.gain ?? 1, muted: Boolean(clip.muted)})),
    captions: (edl.captions || []).map((item) => ({startMs: item.startMs, endMs: item.endMs, text: String(item.text || '')})), speed: edl.speed ?? 1};
}

/* Обрезка «мёртвого» начала и хвоста дубля по тишине (silencedetect). Только для реплик: у вставок тишина — норма. */
function parseSilence(stderr) {
  const marks = [];
  for (const line of String(stderr).split('\n')) {
    let match;
    if ((match = /silence_start:\s*(-?[\d.]+)/.exec(line))) marks.push({start: Math.max(0, Number(match[1]) * 1000)});
    else if ((match = /silence_end:\s*([\d.]+)/.exec(line)) && marks.length) marks[marks.length - 1].end = Number(match[1]) * 1000;
  }
  return marks;
}
function speechBounds(silences, durationMs, {lead = 150, tail = 250, minMs = 500} = {}) {
  let inMs = 0, outMs = durationMs;
  const first = silences[0], final = silences[silences.length - 1];
  if (first && first.start <= 50 && first.end !== undefined) inMs = Math.max(0, first.end - lead);
  if (final && (final.end === undefined || final.end >= durationMs - 50) && final.start > inMs) outMs = Math.min(durationMs, final.start + tail);
  if (outMs - inMs < minMs) return {inMs: 0, outMs: durationMs, trimmed: false};
  return {inMs: Math.round(inMs), outMs: Math.round(outMs), trimmed: inMs > 0 || outMs < durationMs};
}
async function detectSpeech(file, info, {ffmpeg = 'ffmpeg', timeoutMs} = {}) {
  if (!info.hasAudio) return {inMs: 0, outMs: info.durationMs, trimmed: false};
  const {stderr} = await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'info', '-protocol_whitelist', 'file', '-i', safePath(file),
    '-vn', '-af', 'silencedetect=noise=-35dB:d=0.35', '-f', 'null', '-'], {timeoutMs});
  return speechBounds(parseSilence(stderr), info.durationMs);
}

module.exports = {run, probe, wrap, normalizePlan, buildArgs, render, planFromEdl, parseSilence, speechBounds, detectSpeech, SPEEDS};
