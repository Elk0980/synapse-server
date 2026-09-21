'use strict';
/* Требования к материалу по площадке и формату: размеры и безопасные зоны. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'media-mentor-materials.js'), 'utf8');
const dom = new JSDOM('<div></div>', { runScripts: 'outside-only' });
dom.window.eval(source);
const M = dom.window.SbCabinet.mediaMentorMaterials;

const BRIEF = { product: 'Тайский массаж', shootingComfort: { level: 'hands_only', notes: '' } };
const day = (over = {}) => ({ date: '2026-09-21', platform: 'vk', format: 'post',
  role: 'reach', topic: 'Разминка спины', hook: '', assetId: '', mentorNote: '', ...over });
const one = (over, brief = BRIEF) => M.build({ days: [day(over)] }, brief).items[0];

test('позиции с материалом в заявку не попадают', () => {
  const out = M.build({ days: [day({ assetId: 'a1' }), day({ date: '2026-09-22' })] }, BRIEF);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].date, '2026-09-22');
});

test('одна и та же тема на разных площадках даёт разные требования', () => {
  const vk = one({ format: 'reel', platform: 'vk' });
  const tiktok = one({ format: 'reel', platform: 'tiktok' });
  const youtube = one({ format: 'reel', platform: 'youtube' });
  assert.notEqual(vk.safe.bottom, tiktok.safe.bottom);
  assert.notEqual(tiktok.safe.right, youtube.safe.right);
  assert.equal(vk.ratio, tiktok.ratio, 'вертикаль у всех одна');
});

test('TikTok режет кадр сильнее всех снизу и справа', () => {
  const item = one({ format: 'reel', platform: 'tiktok' });
  assert.ok(item.safe.bottom >= 0.19, 'реклама TikTok закрывает до 370 px снизу');
  assert.ok(item.safe.right > 0.1);
  assert.match(item.prompt, /снизу 19%/);
  assert.match(item.prompt, /справа 11%/);
});

test('лента ВКонтакте ждёт вертикальный пост, а не горизонтальный', () => {
  const item = one({ format: 'post', platform: 'vk' });
  assert.equal(item.ratio, '4:5');
  assert.equal(item.kind, 'image');
});

test('пост Telegram остаётся горизонтальным и без безопасной зоны', () => {
  const item = one({ format: 'post', platform: 'telegram' });
  assert.equal(item.ratio, '16:9');
  assert.equal(item.safeZone, '', 'в ленте канала интерфейс кадр не перекрывает');
});

test('формат вне стандарта площадки выносится владельцу, а не применяется молча', () => {
  const out = M.build({ days: [day({ format: 'post', platform: 'vk' })] }, BRIEF);
  assert.equal(out.items[0].beyondStandard, true);
  assert.ok(out.warnings.some((line) => line.includes('в стандарте материалов такого формата нет')));
});

test('неизвестная площадка получает самый строгий запас и предупреждение', () => {
  const out = M.build({ days: [day({ platform: 'max', format: 'story' })] }, BRIEF);
  assert.equal(out.items[0].safe.confirmed, false);
  assert.ok(out.items[0].safe.bottom >= 0.2);
  assert.ok(out.warnings.some((line) => line.includes('«max» не описана')));
});

test('неподтверждённая зона помечается как неподтверждённая', () => {
  const out = M.build({ days: [day({ platform: 'vk', format: 'reel' })] }, BRIEF);
  assert.equal(out.items[0].safe.confirmed, false);
  assert.ok(out.warnings.some((line) => line.includes('точными данными не подтверждена')));
});

test('подтверждённая зона Instagram предупреждения не вызывает', () => {
  const out = M.build({ days: [day({ platform: 'instagram', format: 'reel' })] }, BRIEF);
  assert.equal(out.items[0].safe.confirmed, true);
  assert.equal(out.warnings.length, 0);
});

test('формат вне словаря не получает выдуманных требований', () => {
  const out = M.build({ days: [day({ format: 'live' })] }, BRIEF);
  assert.equal(out.items.length, 0);
  assert.ok(out.skipped[0].includes('не описан в стандарте'));
});

test('в промте картинки стоят площадка, соотношение, разрешение и фон', () => {
  const prompt = one({ platform: 'instagram', format: 'post' }).prompt;
  assert.match(prompt, /Публикуется в Instagram/);
  assert.match(prompt, /строго 4:5/);
  assert.match(prompt, /PNG без потерь/);
  assert.match(prompt, /Фон однотонный контрастный/);
});

test('в промте видео обязательны первый и последний кадр', () => {
  const prompt = one({ format: 'reel', platform: 'tiktok' }).prompt;
  assert.match(prompt, /FIRST FRAME must exactly match the first attached image/);
  assert.match(prompt, /LAST FRAME must exactly match the second attached image/);
  assert.match(prompt, /без склеек/);
});

test('безопасная зона объясняет, зачем края оставлять фоном', () => {
  const prompt = one({ format: 'reel', platform: 'youtube' }).prompt;
  assert.match(prompt, /там будут кнопки и подписи площадки/);
});

test('готовность к съёмке из брифа попадает в промт', () => {
  assert.match(one({}).prompt, /только руки и процесс/);
  assert.match(one({}, { shootingComfort: { level: 'on_camera' } }).prompt, /лицо видно/);
});

test('невыясненная готовность не притворяется согласием сниматься', () => {
  const prompt = one({}, {}).prompt;
  assert.match(prompt, /не выяснена/);
  assert.ok(!prompt.includes('лицо видно'));
});

test('видео ведёт на рабочий аккаунт и напоминает про параллельные чаты', () => {
  const howTo = one({ format: 'reel' }).howTo.join(' ');
  assert.match(howTo, /gemini\.google\.com\/u\/1\//);
  assert.match(howTo, /столько же чатов/);
  assert.match(howTo, /выбирается в интерфейсе/);
});

test('для картинок требуется 3.1 Pro, а не Flash-Lite', () => {
  assert.match(one({}).howTo.join(' '), /3\.1 Pro, не Flash-Lite/);
});

test('предел апскейла назван в каждой позиции', () => {
  assert.match(one({}).upscaleNote, /1,5 раза/);
});

test('пакет больше двух роликов предупреждает про лимит аккаунта', () => {
  const days = ['2026-09-21', '2026-09-22', '2026-09-23'].map((date) => day({ date, format: 'reel' }));
  const out = M.build({ days }, BRIEF);
  assert.equal(out.videos, 3);
  assert.match(out.batchNote, /примерно два ролика в окно/);
});

test('имя файла различает площадки, иначе материалы перепутаются', () => {
  const vk = one({ format: 'reel', platform: 'vk' }).fileName;
  const tiktok = one({ format: 'reel', platform: 'tiktok' }).fileName;
  assert.notEqual(vk, tiktok);
  assert.match(vk, /_vk_2026-09-21_/);
});

test('пустой план не ломает заявку', () => {
  const out = M.build(null, BRIEF);
  assert.equal(out.items.length, 0);
  assert.equal(out.warnings.length, 0);
});

test('заявка честно говорит, что материал приносит человек', () => {
  assert.match(M.build({ days: [day()] }, BRIEF).notice, /загружается в карточку вручную/);
});
