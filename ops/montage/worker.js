'use strict';
/* Воркер автомонтажа Хью (specs/214-auto-montage). Отдельный контейнер с ffmpeg.
   Сеть: только служебный API content (CONTENT_URL, путь /content/internal/montage/*) по своему ключу.
   Он же проксирует очередь правок CRM, поэтому ключа CRM у воркера нет. Файлы: только каталог работы
   задания, который удаляется после задания. Включение: MONTAGE_WORKER_ENABLED=1 (по умолчанию выключен). */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const engine = require('./render');
const {planDraft, draftNote} = require('./draft');

const MiB = 1024 * 1024;
const AGENT = 'Хью · автомонтаж';
const ASSET = /^\/content\/publishing-assets\/([a-z0-9_-]{1,64})\/([a-f0-9]{32}\.(?:mp4|webm))$/;
const int = (value, fallback, min, max) => { const n = Number.parseInt(String(value ?? ''), 10); return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback; };

function readConfig(env = process.env) {
  const contentUrl = new URL(env.CONTENT_URL || 'http://content:8080');
  if (!['http:', 'https:'].includes(contentUrl.protocol) || contentUrl.username || contentUrl.password || contentUrl.pathname !== '/' || contentUrl.search)
    throw new Error('CONTENT_URL: только http(s)://хост[:порт]');
  return {
    enabled: env.MONTAGE_WORKER_ENABLED === '1',
    contentUrl: contentUrl.origin,
    key: String(env.MONTAGE_WORKER_KEY || '').trim(),
    workDir: path.resolve(env.MONTAGE_WORK_DIR || '/work'),
    pollMs: int(env.MONTAGE_POLL_MS, 60000, 1000, 3600000),
    threads: int(env.MONTAGE_THREADS, 2, 1, 16),
    timeoutMs: int(env.MONTAGE_JOB_TIMEOUT_MS, 20 * 60000, 10000, 3 * 3600000),
    maxInputBytes: int(env.MONTAGE_MAX_INPUT_MB, 4096, 1, 65536) * MiB,
    maxOutputBytes: int(env.MONTAGE_MAX_OUTPUT_MB, 60, 1, 2048) * MiB,
    minFreeBytes: int(env.MONTAGE_MIN_FREE_MB, 2048, 64, 1048576) * MiB,
    width: int(env.MONTAGE_WIDTH, 1080, 64, 4096), height: int(env.MONTAGE_HEIGHT, 1920, 64, 4096), fps: int(env.MONTAGE_FPS, 30, 1, 60),
    font: env.MONTAGE_FONT || '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    ffmpeg: env.MONTAGE_FFMPEG || 'ffmpeg', ffprobe: env.MONTAGE_FFPROBE || 'ffprobe',
  };
}

function createClient(config, fetchImpl = fetch) {
  const base = `${config.contentUrl}/content/internal/montage`;
  async function call(method, route, {body, raw, type} = {}) {
    const response = await fetchImpl(base + route, {method, redirect: 'error',
      headers: {'x-api-key': config.key, ...(body ? {'content-type': 'application/json'} : {}), ...(raw ? {'content-type': type} : {})},
      body: body ? JSON.stringify(body) : raw});
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(`content ${method} ${route.split('?')[0]}: ${response.status} ${data?.error || ''}`.trim()), {status: response.status});
    return data;
  }
  async function download(route, file, limit) {
    const response = await fetchImpl(base + route, {redirect: 'error', headers: {'x-api-key': config.key}});
    if (!response.ok || !response.body) throw Object.assign(new Error(`content GET ${route.split('?')[0]}: ${response.status}`), {status: response.status});
    let size = 0;
    const guard = async function* (source) { for await (const chunk of source) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Исходник больше лимита MONTAGE_MAX_INPUT_MB'), {code: 'TOO_BIG'}); yield chunk; } };
    await pipeline(Readable.fromWeb(response.body), guard, fs.createWriteStream(file, {mode: 0o600, flags: 'wx'}));
    return size;
  }
  return {call, download};
}

function freeBytes(dir) { const stat = fs.statfsSync(dir); return Number(stat.bavail) * Number(stat.bsize); }
const sha256 = async (file) => { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
const q = (code) => `?companyCode=${encodeURIComponent(code)}`;

function createWorker(config, {client = createClient(config), log = (...args) => console.log(...args)} = {}) {
  async function workspace(name) {
    fs.mkdirSync(config.workDir, {recursive: true, mode: 0o700});
    const dir = await fsp.mkdtemp(path.join(config.workDir, name + '-'));
    return dir;
  }
  function needSpace(bytes) {
    const free = freeBytes(config.workDir);
    if (free - bytes * 3 < config.minFreeBytes) throw Object.assign(new Error(`Мало места для монтажа: свободно ${Math.round(free / MiB)} МБ, нужно ~${Math.round((bytes * 3 + config.minFreeBytes) / MiB)} МБ`), {code: 'NO_SPACE'});
  }
  const renderOptions = (dir, extra = {}) => ({output: path.join(dir, 'out.mp4'), workDir: dir, ffmpeg: config.ffmpeg, timeoutMs: config.timeoutMs,
    font: config.font, width: config.width, height: config.height, fps: config.fps, threads: config.threads, ...extra});
  async function publish(code, result) {
    const size = fs.statSync(result.output).size;
    if (size > config.maxOutputBytes) throw Object.assign(new Error(`Результат ${Math.round(size / MiB)} МБ больше лимита хранилища ${Math.round(config.maxOutputBytes / MiB)} МБ`), {code: 'TOO_BIG'});
    const video = await client.call('POST', '/assets' + q(code), {raw: await fsp.readFile(result.output), type: 'video/mp4'});
    let cover = null;
    try { cover = await client.call('POST', '/assets' + q(code), {raw: await fsp.readFile(result.cover), type: 'image/jpeg'}); } catch (error) { log('montage: обложка не загружена:', error.message); }
    return {video, cover};
  }

  /* Правка kind:edl → новая версия ролика (v+1) через существующий служебный API «Материалов». */
  async function processEdit(edit) {
    const code = edit.companyCode;
    const match = ASSET.exec(new URL(edit.base.mediaUrl).pathname);
    if (!match || match[1] !== code) throw Object.assign(new Error('Базовая версия не из хранилища публикаций своей компании'), {code: 'FORBIDDEN'});
    await client.call('POST', `/edits/${edit.id}/claim${q(code)}`);
    const dir = await workspace('edit-' + edit.id);
    try {
      needSpace(0);
      const source = path.join(dir, 'base' + path.extname(match[2]));
      await client.download(`/assets/${code}/${match[2]}`, source, config.maxInputBytes);
      const info = await engine.probe(source, {ffprobe: config.ffprobe});
      const result = await engine.render(engine.planFromEdl(edit.edl, source, info), renderOptions(dir, {coverMs: edit.edl.coverMs}));
      const {video, cover} = await publish(code, result);
      const note = [`Автомонтаж по правке №${edit.id} (EDL)`, cover ? `обложка: ${cover.url}` : 'обложка не загружена'].join('; ');
      const saved = await client.call('POST', `/reels/${edit.reelId}/versions${q(code)}`,
        {body: {mediaUrl: video.url, sha256: video.sha256, durationMs: Math.max(100, result.outputMs), editId: edit.id, note}});
      log(`montage: правка №${edit.id} → v${saved.version?.version}`);
      return saved;
    } finally { await fsp.rm(dir, {recursive: true, force: true}); }
  }

  /* Черновик из дублей: последняя загрузка на сцену, обрезка тишины у реплик, титры сценария. */
  async function processDraft(job) {
    const code = job.companyCode;
    await client.call('POST', `/jobs/${job.id}/claim${q(code)}`);
    const dir = await workspace('draft-' + job.id);
    try {
      const info = await client.call('GET', `/ideas/${encodeURIComponent(job.ideaId)}${q(code)}`);
      const latest = new Map();
      for (const take of info.takes || []) if (Number.isSafeInteger(take.frame) && (!latest.has(take.frame) || latest.get(take.frame).id < take.id)) latest.set(take.frame, take);
      const chosen = [...latest.values()];
      if (!chosen.length) throw Object.assign(new Error('Нет дублей с номером сцены'), {code: 'NO_TAKES'});
      needSpace(chosen.reduce((sum, take) => sum + take.size, 0));
      const takes = [];
      for (const take of chosen) {
        const file = path.join(dir, `take-${take.id}${take.mime === 'video/quicktime' ? '.mov' : '.mp4'}`);
        await client.download(`/takes/${take.id}${q(code)}`, file, config.maxInputBytes);
        const probe = await engine.probe(file, {ffprobe: config.ffprobe});
        const bounds = await engine.detectSpeech(file, probe, {ffmpeg: config.ffmpeg, timeoutMs: config.timeoutMs});
        takes.push({id: take.id, frame: take.frame, file, probe, bounds});
      }
      const draft = planDraft(info.idea, takes);
      if (!draft.plan.video.length) throw Object.assign(new Error('Ни одна сцена сценария не совпала с номером кадра дублей'), {code: 'NO_SCENES'});
      const result = await engine.render(draft.plan, renderOptions(dir));
      const {video, cover} = await publish(code, result);
      const note = draftNote(draft, [cover ? `обложка: ${cover.url}` : 'обложка не загружена']);
      const saved = await client.call('POST', `/ideas/${encodeURIComponent(job.ideaId)}/versions${q(code)}`,
        {body: {mediaUrl: video.url, sha256: video.sha256, durationMs: Math.max(100, result.outputMs), note}});
      await client.call('POST', `/jobs/${job.id}/done${q(code)}`, {body: {reelId: saved.reel.id, version: saved.version.version, note}});
      log(`montage: черновик ${job.ideaId} → ролик №${saved.reel.id} v${saved.version.version}`);
      return saved;
    } finally { await fsp.rm(dir, {recursive: true, force: true}); }
  }

  /* Один проход: сначала правки (ими ждут люди), затем черновики. По одному заданию за раз — CPU сервера общий. */
  async function runOnce() {
    const done = [];
    const {edits = []} = await client.call('GET', '/queue');
    for (const edit of edits.filter((item) => item.kind === 'edl')) {
      try { done.push({edit: edit.id, ok: true, result: await processEdit(edit)}); } catch (error) {
        log(`montage: правка №${edit.id} не собрана: ${error.message}`);
        await client.call('POST', `/edits/${edit.id}/fail${q(edit.companyCode)}`, {body: {error: String(error.message).slice(0, 500)}}).catch(() => {});
        done.push({edit: edit.id, ok: false, error: error.message});
      }
    }
    const {jobs = []} = await client.call('GET', '/jobs');
    for (const job of jobs) {
      try { done.push({job: job.id, ok: true, result: await processDraft(job)}); } catch (error) {
        log(`montage: черновик ${job.ideaId} не собран: ${error.message}`);
        await client.call('POST', `/jobs/${job.id}/fail${q(job.companyCode)}`, {body: {error: String(error.message).slice(0, 500)}}).catch(() => {});
        done.push({job: job.id, ok: false, error: error.message});
      }
    }
    return done;
  }
  return {runOnce, processEdit, processDraft};
}

async function main() {
  const config = readConfig();
  if (!config.enabled) { console.log('montage: выключен (MONTAGE_WORKER_ENABLED≠1), заданий не беру'); setInterval(() => {}, 1 << 30); return; }
  if (!config.key) throw new Error('MONTAGE_WORKER_KEY не задан');
  const worker = createWorker(config);
  let stop = false;
  process.on('SIGTERM', () => { stop = true; });
  console.log(`montage: включён, опрос ${config.contentUrl} раз в ${Math.round(config.pollMs / 1000)} с`);
  while (!stop) {
    try { await worker.runOnce(); } catch (error) { console.error('montage: проход не удался:', error.message); }
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
}

if (require.main === module) main().catch((error) => { console.error('montage:', error.message); process.exit(1); });
module.exports = {readConfig, createClient, createWorker, AGENT};
