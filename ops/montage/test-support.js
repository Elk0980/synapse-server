'use strict';
/* Синтетические клипы для тестов автомонтажа: генерируются ffmpeg (lavfi) во временной папке, в репозиторий не попадают. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const hasFfmpeg = () => spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], {encoding: 'utf8'});
  if (result.status !== 0) throw new Error('ffmpeg: ' + result.stderr);
  return result;
}
/* Ролик из цветных секунд (red, green, blue, white…) и тона 440 Гц — по цвету кадра видно порядок вырезок. */
function colorClip(file, colors = ['red', 'green', 'blue', 'white'], {size = '160x284', audio = 'tone'} = {}) {
  const inputs = colors.flatMap((color) => ['-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=25:d=1`]);
  const n = colors.length;
  const audioInput = audio === 'tone' ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${n}`]
    : audio === 'speech' ? ['-f', 'lavfi', '-i', `aevalsrc=if(between(t\\,1\\,${n - 1})\\,0.5*sin(2*PI*440*t)\\,0):s=48000:d=${n}`] : [];
  const graph = `${colors.map((_, i) => `[${i}:v]`).join('')}concat=n=${n}:v=1:a=0[v]`;
  ffmpeg([...inputs, ...audioInput, '-filter_complex', graph, '-map', '[v]', ...(audioInput.length ? ['-map', `${n}:a`, '-c:a', 'aac'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-t', String(n), file]);
  return file;
}
/* Средний цвет кадра в момент t (с): [r, g, b]. */
function colorAt(file, t) {
  const result = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {maxBuffer: 1024});
  return [...result.stdout.subarray(0, 3)];
}
function dominant([r, g, b]) {
  if (r > 200 && g > 200 && b > 200) return 'white';
  if (r > 150 && g < 100 && b < 100) return 'red';
  if (g > 90 && r < 100 && b < 100) return 'green';
  if (b > 150 && r < 100 && g < 100) return 'blue';
  if (r < 40 && g < 40 && b < 40) return 'black';
  return `rgb(${r},${g},${b})`;
}
function maxVolume(file) {
  const result = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], {encoding: 'utf8'});
  const match = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(result.stderr);
  return match ? (match[1] === '-inf' ? -Infinity : Number(match[1])) : null;
}
module.exports = {hasFfmpeg, tmp, ffmpeg, colorClip, colorAt, dominant, maxVolume};
