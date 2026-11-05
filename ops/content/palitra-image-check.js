'use strict';
/* Palitra: структурная проверка загружаемого фото на сервере (PALITRA-BOT-EDITOR-35, проход 2, F02). Только Node.
   Принимаются JPEG, PNG и неанимированный WebP. Тип определяется по байтам, Content-Type клиента не доверяется.

   Что проверяется здесь (без внешних библиотек):
   - PNG: сигнатура, все блоки с длиной и CRC32, IHDR первым (13 байт, допустимые глубина/цвет/сжатие/фильтр/
     чересстрочность), PLTE для палитры, IDAT подряд, IEND последним без хвоста, критичные неизвестные блоки
     отклоняются; IDAT распаковывается с жёстким пределом размера и сверяется с ожидаемым объёмом строк,
     байт фильтра каждой строки 0–4.
   - JPEG: SOI, каждый сегмент в пределах файла, ровно один кадр SOF с согласованной длиной, хотя бы один SOS,
     данные скана до следующего маркера, обязательный EOI; EXIF-поворот 5–8 меняет местами ширину и высоту.
   - WebP: размер RIFF совпадает с файлом, все чанки в пределах, ровно одно изображение VP8/VP8L,
     VP8X без анимации и с тем же размером холста, ключевой кадр VP8, сигнатура и версия VP8L.

   Чего здесь НЕТ: полного декодирования пикселей JPEG/WebP (и цветовой проверки PNG). Для production
   обязателен доверенный декодер deps.decodeImage (см. server-adapter/DECODER.md); без него сервер не принимает
   новые фото. Эта проверка — первый фильтр и источник размеров, а не замена декодера. */
const zlib = require('node:zlib');

const LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, minSide: 200, maxSide: 10000, maxPixels: 40000000, maxRawBytes: 256 * 1024 * 1024 });

class ImageProbeError extends Error {
  constructor(message) { super(message); this.name = 'ImageProbeError'; this.code = 'image'; }
}
const fail = message => { throw new ImageProbeError(message); };

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));
const need = (b, n) => { if (n > b.length) fail('Файл повреждён или обрезан'); };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (b, start, end) => {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const checkSize = (width, height) => {
  if (!width || !height) fail('В файле нет размера кадра');
  if (width < LIMITS.minSide || height < LIMITS.minSide) fail(`Фото слишком маленькое: ${width}×${height}`);
  if (width > LIMITS.maxSide || height > LIMITS.maxSide || width * height > LIMITS.maxPixels) fail(`Фото слишком большое: ${width}×${height}`);
};

/* ---------- PNG ---------- */

const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function pngRows(width, height, bitsPerPixel, interlace) {
  const rowBytes = w => Math.ceil((w * bitsPerPixel) / 8);
  if (!interlace) return [{ count: height, bytes: rowBytes(width) }];
  return ADAM7.map(([x0, y0, dx, dy]) => {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    return { count: w && h ? h : 0, bytes: rowBytes(w) };
  }).filter(pass => pass.count);
}

function png(b) {
  let i = 8;
  let header = null, palette = false, ended = false, idatClosed = false, orientation = 1;
  const idat = [];
  while (i < b.length) {
    need(b, i + 12);
    const length = u32be(b, i);
    if (length > 0x7fffffff) fail('PNG повреждён');
    const type = ascii(b, i + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) fail('PNG повреждён: неверный тип блока');
    const dataStart = i + 8, dataEnd = dataStart + length;
    need(b, dataEnd + 4);
    if (crc32(b, i + 4, dataEnd) !== u32be(b, dataEnd)) fail(`PNG повреждён: неверная контрольная сумма блока ${type}`);
    if (!header) {
      if (type !== 'IHDR' || length !== 13) fail('PNG без заголовка IHDR');
      header = { width: u32be(b, dataStart), height: u32be(b, dataStart + 4), depth: b[dataStart + 8], color: b[dataStart + 9],
        compression: b[dataStart + 10], filter: b[dataStart + 11], interlace: b[dataStart + 12] };
    } else if (type === 'IHDR') fail('PNG: повтор IHDR');
    if (type === 'eXIf') orientation = exifOrientation(b, dataStart, dataEnd);
    if (type === 'PLTE') { if (idat.length) fail('PNG: палитра после данных'); palette = true; }
    if (type === 'IDAT') {
      if (idatClosed) fail('PNG: блоки данных не подряд');
      idat.push(b.subarray(dataStart, dataEnd));
    } else if (idat.length) idatClosed = true;
    if (type === 'IEND') {
      if (length !== 0) fail('PNG повреждён: неверный IEND');
      ended = true;
      i = dataEnd + 4;
      break;
    }
    // Критичный блок (заглавная первая буква) вне стандарта — декодер обязан отказать, отказываем и мы.
    if ((b[i + 4] & 0x20) === 0 && !['IHDR', 'PLTE', 'IDAT'].includes(type)) fail(`PNG: неизвестный обязательный блок ${type}`);
    i = dataEnd + 4;
  }
  if (!header) fail('PNG без заголовка IHDR');
  if (!ended) fail('PNG обрезан: нет IEND');
  if (i !== b.length) fail('PNG: данные после IEND');
  if (!idat.length) fail('PNG без данных изображения');
  const { width, height, depth, color, compression, filter, interlace } = header;
  if (!PNG_DEPTHS[color] || !PNG_DEPTHS[color].includes(depth) || compression !== 0 || filter !== 0 || interlace > 1) fail('PNG: недопустимый заголовок');
  if (color === 3 && !palette) fail('PNG: нет палитры');
  checkSize(width, height);
  const rows = pngRows(width, height, PNG_CHANNELS[color] * depth, interlace === 1);
  const expected = rows.reduce((sum, pass) => sum + pass.count * (pass.bytes + 1), 0);
  if (expected > LIMITS.maxRawBytes) fail('PNG слишком большой для проверки');
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }); }
  catch (_) { fail('PNG повреждён: данные изображения не распаковываются'); }
  if (raw.length !== expected) fail('PNG повреждён: объём данных не совпал с размером кадра');
  let at = 0;
  for (const pass of rows) {
    for (let row = 0; row < pass.count; row += 1) {
      if (raw[at] > 4) fail('PNG повреждён: неверный фильтр строки');
      at += pass.bytes + 1;
    }
  }
  return { mime: 'image/png', ext: 'png', width: orientation >= 5 ? height : width, height: orientation >= 5 ? width : height };
}

/* ---------- JPEG ---------- */

function exifOrientation(b, start, end) {
  const tiff = ascii(b, start, 6) === 'Exif\0\0' ? start + 6 : start;
  if (tiff + 8 > end) return 1;
  const order = ascii(b, tiff, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const r16 = i => (order === 'II' ? u16le(b, i) : u16be(b, i));
  const r32 = i => (order === 'II' ? u32le(b, i) : u32be(b, i));
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const entries = r16(ifd);
  for (let n = 0; n < entries; n += 1) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > end) return 1;
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

const isSof = m => (m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf);

function jpeg(b) {
  let i = 2, orientation = 1, frame = null, scans = 0, eoi = false;
  while (i < b.length) {
    if (b[i] !== 0xff) fail('JPEG повреждён: ожидался маркер');
    while (b[i + 1] === 0xff) i += 1;
    need(b, i + 2);
    const marker = b[i + 1];
    if (marker === 0xd9) { eoi = true; break; }
    if (marker === 0x01) { i += 2; continue; }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) fail('JPEG повреждён: маркер не на своём месте');
    need(b, i + 4);
    const length = u16be(b, i + 2);
    if (length < 2) fail('JPEG повреждён: неверная длина сегмента');
    const end = i + 2 + length;
    need(b, end);
    if (marker === 0xe1 && length >= 8 && ascii(b, i + 4, 6) === 'Exif\0\0') orientation = exifOrientation(b, i + 4, end);
    if (isSof(marker)) {
      if (frame) fail('JPEG: больше одного кадра');
      if (length < 8) fail('JPEG повреждён: короткий заголовок кадра');
      const components = b[i + 9];
      if (!components || length !== 8 + 3 * components) fail('JPEG повреждён: заголовок кадра не совпал');
      frame = { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    if (marker === 0xda) {
      if (!frame) fail('JPEG: данные до заголовка кадра');
      const components = b[i + 4];
      if (!components || length !== 6 + 2 * components) fail('JPEG повреждён: заголовок скана не совпал');
      scans += 1;
      // Данные скана идут до первого маркера, не являющегося байтом-заполнителем (FF00) или RSTn.
      let j = end;
      for (;;) {
        if (j + 1 >= b.length) fail('JPEG обрезан: нет конца данных');
        if (b[j] === 0xff) {
          const next = b[j + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { j += 2; continue; }
          if (next === 0xff) { j += 1; continue; }
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    i = end;
  }
  if (!frame) fail('В JPEG не найден размер кадра');
  if (!scans) fail('JPEG без данных изображения');
  if (!eoi) fail('JPEG обрезан: нет маркера конца');
  const rotated = orientation >= 5;
  const width = rotated ? frame.height : frame.width;
  const height = rotated ? frame.width : frame.height;
  checkSize(width, height);
  return { mime: 'image/jpeg', ext: 'jpg', width, height, orientation };
}

/* ---------- WebP ---------- */

function vp8(b, chunk) {
  if (chunk.size < 10) fail('WebP повреждён: короткий кадр VP8');
  const s = chunk.start;
  const tag = b[s] | (b[s + 1] << 8) | (b[s + 2] << 16);
  if ((tag & 1) !== 0) fail('WebP: кадр VP8 не ключевой');
  if (((tag >> 1) & 7) > 3 || ((tag >> 4) & 1) !== 1) fail('WebP повреждён: заголовок VP8');
  if ((tag >>> 5) > chunk.size - 10) fail('WebP обрезан: раздел VP8 больше файла');
  if (b[s + 3] !== 0x9d || b[s + 4] !== 0x01 || b[s + 5] !== 0x2a) fail('WebP повреждён: нет сигнатуры VP8');
  return { width: u16le(b, s + 6) & 0x3fff, height: u16le(b, s + 8) & 0x3fff };
}

function vp8l(b, chunk) {
  if (chunk.size < 5) fail('WebP повреждён: короткий кадр VP8L');
  const s = chunk.start;
  if (b[s] !== 0x2f) fail('WebP повреждён: нет сигнатуры VP8L');
  const bits = u32le(b, s + 1);
  if ((bits >>> 29) !== 0) fail('WebP: неизвестная версия VP8L');
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

function webp(b) {
  need(b, 20);
  if (u32le(b, 4) + 8 !== b.length) fail('WebP повреждён: размер RIFF не совпал с файлом');
  const chunks = [];
  let i = 12;
  while (i < b.length) {
    need(b, i + 8);
    const type = ascii(b, i, 4), size = u32le(b, i + 4), start = i + 8;
    need(b, start + size);
    chunks.push({ type, size, start });
    i = start + size + (size & 1);
  }
  if (i !== b.length) fail('WebP повреждён: чанк выходит за файл');
  const images = chunks.filter(c => c.type === 'VP8 ' || c.type === 'VP8L');
  if (images.length !== 1) fail('WebP: нужен ровно один кадр');
  const image = images[0];
  const size = image.type === 'VP8 ' ? vp8(b, image) : vp8l(b, image);
  const first = chunks[0];
  if (first.type === 'VP8X') {
    if (first.size < 10) fail('WebP повреждён: короткий VP8X');
    if (b[first.start] & 0x02) fail('Анимированный WebP не подходит');
    const canvas = { width: 1 + u24le(b, first.start + 4), height: 1 + u24le(b, first.start + 7) };
    if (canvas.width !== size.width || canvas.height !== size.height) fail('WebP повреждён: размер холста не совпал с кадром');
  } else if (first !== image) fail('WebP повреждён: неверный порядок чанков');
  if (chunks.some(c => c.type === 'ANIM' || c.type === 'ANMF')) fail('Анимированный WebP не подходит');
  checkSize(size.width, size.height);
  const exif = chunks.find(c => c.type === 'EXIF');
  const orientation = exif ? exifOrientation(b, exif.start, exif.start + exif.size) : 1;
  return { mime: 'image/webp', ext: 'webp', width: orientation >= 5 ? size.height : size.width, height: orientation >= 5 ? size.width : size.height };
}

function inspect(input) {
  const b = input instanceof Uint8Array ? input : fail('Нужны байты файла');
  if (!b.length) fail('Файл пустой');
  if (b.length > LIMITS.maxBytes) fail('Файл больше 8 МБ');
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return png(b);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b);
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
  return fail('Подходят только фото JPEG, PNG или WebP');
}

module.exports = { LIMITS, ImageProbeError, inspect, probe: inspect, crc32 };
