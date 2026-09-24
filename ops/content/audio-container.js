'use strict';
/* Разбор структуры голосовой записи без внешних программ (ffmpeg не нужен).
   Проверяется контейнер целиком: границы всех блоков, наличие аудиодорожки, отсутствие видео.
   Декодирование звука не выполняется — это проверка структуры, а не качества записи. */

class AudioReject extends Error {
  constructor(reason, detail) { super(detail || reason); this.reason = reason; }
}
const corrupt = detail => { throw new AudioReject('corrupt', detail); };

/* ---------- MP4 / M4A (ISO BMFF) ---------- */
const MP4_AUDIO_CODECS = new Set(['mp4a', 'alac', 'Opus', 'fLaC', 'ac-3', 'ec-3', 'samr', 'sawb', '.mp3']);
const MP4_VISUAL_HANDLERS = new Set(['vide', 'pict', 'auxv']);

function mp4Boxes(buf, start, end) {
  const out = [];
  let p = start;
  while (p < end) {
    if (end - p < 8) corrupt('mp4: обрезанный заголовок блока');
    let size = buf.readUInt32BE(p), header = 8;
    const type = buf.toString('latin1', p + 4, p + 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) corrupt('mp4: некорректный тип блока');
    if (size === 1) {
      if (end - p < 16) corrupt('mp4: обрезанный размер блока');
      const big = buf.readBigUInt64BE(p + 8);
      if (big > BigInt(end - p)) corrupt('mp4: блок выходит за конец файла');
      size = Number(big); header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) corrupt('mp4: блок выходит за конец файла');
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}
const child = (buf, box, type) => box && mp4Boxes(buf, box.start, box.end).find(b => b.type === type);

function inspectMp4(buf) {
  const top = mp4Boxes(buf, 0, buf.length);
  if (top[0]?.type !== 'ftyp') corrupt('mp4: нет ftyp в начале');
  const moov = top.filter(b => b.type === 'moov');
  if (moov.length !== 1) corrupt('mp4: нет единственного moov');
  const mdatBytes = top.filter(b => b.type === 'mdat').reduce((sum, b) => sum + (b.end - b.start), 0);
  if (!mdatBytes) throw new AudioReject('no-audio', 'mp4: нет данных mdat');
  const traks = mp4Boxes(buf, moov[0].start, moov[0].end).filter(b => b.type === 'trak');
  let audio = 0;
  for (const trak of traks) {
    const mdia = child(buf, trak, 'mdia'), hdlr = child(buf, mdia, 'hdlr'), mdhd = child(buf, mdia, 'mdhd');
    if (!hdlr || hdlr.end - hdlr.start < 12) corrupt('mp4: у дорожки нет hdlr');
    const handler = buf.toString('latin1', hdlr.start + 8, hdlr.start + 12);
    if (MP4_VISUAL_HANDLERS.has(handler)) throw new AudioReject('video', 'mp4: найдена видеодорожка');
    if (handler !== 'soun') continue;
    if (!mdhd || mdhd.end - mdhd.start < 24) corrupt('mp4: нет mdhd');
    const v1 = buf[mdhd.start] === 1;
    if (v1 && mdhd.end - mdhd.start < 36) corrupt('mp4: обрезанный mdhd');
    const timescale = buf.readUInt32BE(mdhd.start + (v1 ? 20 : 12));
    const duration = v1 ? Number(buf.readBigUInt64BE(mdhd.start + 24)) : buf.readUInt32BE(mdhd.start + 16);
    if (!timescale || !duration) throw new AudioReject('no-audio', 'mp4: пустая аудиодорожка');
    const stbl = child(buf, child(buf, mdia, 'minf'), 'stbl'), stsd = child(buf, stbl, 'stsd'), stsz = child(buf, stbl, 'stsz');
    if (!stsd || stsd.end - stsd.start < 16 || !buf.readUInt32BE(stsd.start + 4)) corrupt('mp4: нет описания кодека');
    const codec = buf.toString('latin1', stsd.start + 12, stsd.start + 16);
    if (!MP4_AUDIO_CODECS.has(codec)) throw new AudioReject('no-audio', `mp4: неподдерживаемый кодек ${codec}`);
    if (!stsz || stsz.end - stsz.start < 12) corrupt('mp4: нет таблицы размеров');
    const fixed = buf.readUInt32BE(stsz.start + 4), count = buf.readUInt32BE(stsz.start + 8);
    if (!count) throw new AudioReject('no-audio', 'mp4: нет аудиосэмплов');
    let total = fixed * count;
    if (!fixed) {
      if (stsz.end - stsz.start < 12 + count * 4) corrupt('mp4: обрезанная таблица размеров');
      total = 0;
      for (let i = 0; i < count; i++) total += buf.readUInt32BE(stsz.start + 12 + i * 4);
    }
    // Сэмплы должны помещаться в данные файла: иначе запись оборвана.
    if (total > mdatBytes) corrupt('mp4: данных меньше, чем заявлено в дорожке');
    audio++;
  }
  if (!audio) throw new AudioReject('no-audio', 'mp4: нет аудиодорожки');
  return 'm4a';
}

/* ---------- OGG ---------- */
const OGG_CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();
function oggCrc(page) {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : page[i];
    crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  }
  return crc;
}
function oggCodec(packet) {
  const head = packet.toString('latin1', 0, 8);
  if (head === 'OpusHead' || head.startsWith('\x01vorbis') || head.startsWith('\x7fFLAC') || head === 'Speex   ') return 'audio';
  if (head === 'fishead\0' || head === 'fisbone\0') return 'skeleton';
  if (head.startsWith('\x80theora') || head.startsWith('\x01video') || head.startsWith('BBCD') || head.startsWith('\x80daala')) return 'video';
  return 'unknown';
}

function inspectOgg(buf) {
  const streams = new Map();
  let p = 0;
  while (p < buf.length) {
    if (buf.length - p < 27 || buf.toString('latin1', p, p + 4) !== 'OggS') corrupt('ogg: нарушена граница страницы');
    if (buf[p + 4] !== 0) corrupt('ogg: неизвестная версия');
    const flags = buf[p + 5], granule = buf.readBigInt64LE(p + 6), serial = buf.readUInt32LE(p + 14), seq = buf.readUInt32LE(p + 18);
    const segments = buf[p + 26];
    if (buf.length - p < 27 + segments) corrupt('ogg: обрезанная таблица сегментов');
    let bodySize = 0, firstPacket = 0, packetEnded = false;
    for (let i = 0; i < segments; i++) {
      const lace = buf[p + 27 + i];
      bodySize += lace;
      if (!packetEnded) { firstPacket += lace; if (lace < 255) packetEnded = true; }
    }
    const end = p + 27 + segments + bodySize;
    if (end > buf.length) corrupt('ogg: страница выходит за конец файла');
    if (oggCrc(buf.subarray(p, end)) !== buf.readUInt32LE(p + 22)) corrupt('ogg: неверная контрольная сумма');
    let stream = streams.get(serial);
    if (!stream) {
      if (!(flags & 0x02)) corrupt('ogg: поток без начальной страницы');
      const body = p + 27 + segments;
      stream = { kind: oggCodec(buf.subarray(body, body + firstPacket)), seq, data: false };
      streams.set(serial, stream);
    } else if (seq !== stream.seq + 1) corrupt('ogg: пропущена страница');
    stream.seq = seq;
    if (granule > 0n && bodySize > 0) stream.data = true;
    p = end;
  }
  const kinds = [...streams.values()];
  if (kinds.some(s => s.kind === 'video')) throw new AudioReject('video', 'ogg: найден видеопоток');
  if (kinds.some(s => s.kind === 'unknown')) throw new AudioReject('no-audio', 'ogg: неизвестный поток');
  if (!kinds.some(s => s.kind === 'audio' && s.data)) throw new AudioReject('no-audio', 'ogg: нет аудиоданных');
  return 'ogg';
}

/* ---------- WAV ---------- */
const WAV_FORMATS = new Set([1, 2, 3, 6, 7, 0x11, 0x55, 0xfffe]);
function inspectWav(buf) {
  const riffEnd = buf.readUInt32LE(4) + 8;
  if (riffEnd > buf.length || riffEnd < 12) corrupt('wav: размер RIFF не совпадает с файлом');
  let p = 12, fmt = null, data = 0;
  while (p + 8 <= riffEnd) {
    const id = buf.toString('latin1', p, p + 4), size = buf.readUInt32LE(p + 4), start = p + 8;
    if (start + size > riffEnd) corrupt(`wav: блок ${id} выходит за конец файла`);
    if (id === 'fmt ') {
      if (size < 16) corrupt('wav: короткий fmt');
      fmt = { format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4),
        align: buf.readUInt16LE(start + 12), bits: buf.readUInt16LE(start + 14) };
    } else if (id === 'data') {
      if (!fmt) corrupt('wav: данные раньше описания формата');
      data += size;
    }
    p = start + size + (size & 1);
  }
  if (!fmt) corrupt('wav: нет fmt');
  if (!WAV_FORMATS.has(fmt.format) || fmt.channels < 1 || fmt.channels > 8 || fmt.rate < 1000 || fmt.rate > 384000) corrupt('wav: неверные параметры звука');
  if ([1, 3].includes(fmt.format) && (![8, 16, 24, 32, 64].includes(fmt.bits) || fmt.align !== fmt.channels * fmt.bits / 8)) corrupt('wav: неверный размер сэмпла');
  if (!data) throw new AudioReject('no-audio', 'wav: нет аудиоданных');
  return 'wav';
}

/* ---------- MP3 ---------- */
const MP3_BITRATES = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3Frame(buf, p) {
  if (p + 4 > buf.length || buf[p] !== 0xff || (buf[p + 1] & 0xe0) !== 0xe0) return 0;
  const version = (buf[p + 1] >> 3) & 3, layerBits = (buf[p + 1] >> 1) & 3;
  const bitrateIndex = buf[p + 2] >> 4, rateIndex = (buf[p + 2] >> 2) & 3, padding = (buf[p + 2] >> 1) & 1;
  if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return 0;
  const layer = 4 - layerBits, rate = MP3_RATES[version][rateIndex];
  const kbps = MP3_BITRATES[`${version === 3 ? 1 : 2}-${version === 3 ? layer : Math.min(layer, 2)}`][bitrateIndex];
  if (layer === 1) return (Math.floor(12000 * kbps / rate) + padding) * 4;
  return Math.floor((layer === 3 && version !== 3 ? 72000 : 144000) * kbps / rate) + padding;
}
function inspectMp3(buf) {
  let p = 0;
  if (buf.toString('latin1', 0, 3) === 'ID3') {
    if (buf.length < 10 || [6, 7, 8, 9].some(i => buf[i] & 0x80)) corrupt('mp3: неверный ID3');
    p = 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]) + (buf[5] & 0x10 ? 10 : 0);
    if (p >= buf.length) throw new AudioReject('no-audio', 'mp3: только теги без звука');
  }
  // Некоторые программы оставляют нули между тегом и первым кадром.
  const limit = Math.min(buf.length, p + 4096);
  while (p < limit && buf[p] === 0) p++;
  let frames = 0;
  while (p < buf.length) {
    const size = mp3Frame(buf, p);
    if (!size) {
      const rest = buf.toString('latin1', p, p + 11);
      if ((rest.startsWith('TAG') && buf.length - p === 128) || rest.startsWith('APETAGEX') || rest.startsWith('LYRICSBEGIN')) break;
      corrupt(frames ? 'mp3: нарушена последовательность кадров' : 'mp3: нет аудиокадров');
    }
    if (p + size > buf.length) corrupt('mp3: последний кадр обрезан');
    p += size; frames++;
  }
  if (frames < 3) throw new AudioReject('no-audio', 'mp3: слишком мало аудиокадров');
  return 'mp3';
}

/* Возвращает формат (m4a|mp3|ogg|wav) или бросает AudioReject с reason: video | corrupt | no-audio | unknown. */
function inspectAudio(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) throw new AudioReject('unknown', 'слишком короткий файл');
  try {
    if (bytes.toString('latin1', 4, 8) === 'ftyp') return inspectMp4(bytes);
    if (bytes.toString('latin1', 0, 4) === 'OggS') return inspectOgg(bytes);
    if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE') return inspectWav(bytes);
    if (bytes.toString('latin1', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return inspectMp3(bytes);
  } catch (error) {
    if (error instanceof AudioReject) throw error;
    // Любая ошибка чтения границ буфера означает повреждённую структуру.
    throw new AudioReject('corrupt', error.message);
  }
  throw new AudioReject('unknown', 'неизвестный формат');
}

module.exports = { inspectAudio, AudioReject, oggCrc };
