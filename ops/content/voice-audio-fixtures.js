'use strict';
/* Минимальные, но структурно корректные аудиофайлы для тестов (без внешних программ). */
const { oggCrc } = require('./audio-container');

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))); return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]); };
const zeros = n => Buffer.alloc(n);

function trak(handler, codec, { samples = [32, 32], duration = 44100 } = {}) {
  const mdhd = box('mdhd', zeros(12), u32(44100), u32(duration), zeros(4));
  const hdlr = box('hdlr', zeros(8), handler, zeros(12), '\0');
  const stsd = box('stsd', zeros(4), u32(1), u32(36), codec, zeros(28));
  const stsz = box('stsz', zeros(4), u32(0), u32(samples.length), ...samples.map(u32));
  return box('trak', box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd, stsz))));
}
function m4a({ tracks = [['soun', 'mp4a']], mdat = 64 } = {}) {
  return Buffer.concat([box('ftyp', 'M4A ', zeros(4), 'M4A isom'), box('moov', ...tracks.map(([h, c, o]) => trak(h, c, o))), box('mdat', zeros(mdat))]);
}

function oggPage(serial, seq, flags, granule, packet) {
  const head = Buffer.alloc(28);
  head.write('OggS', 0, 'latin1'); head[5] = flags; head.writeBigInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial, 14); head.writeUInt32LE(seq, 18); head[26] = 1; head[27] = packet.length;
  const page = Buffer.concat([head, packet]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}
const pad = (text, n) => Buffer.concat([Buffer.from(text, 'latin1'), zeros(n)]);
function ogg({ head = 'OpusHead', audio = true } = {}) {
  const pages = [oggPage(1, 0, 2, 0, pad(head, 11)), oggPage(1, 1, 0, 0, pad('OpusTags', 8))];
  if (audio) pages.push(oggPage(1, 2, 4, 960, zeros(60)));
  return Buffer.concat(pages);
}

function wav({ data = 400 } = {}) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(16000, 4); fmt.writeUInt32LE(32000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  const chunk = (id, body) => { const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('data', zeros(data))]);
  const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'latin1'); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

function mp3({ frames = 5 } = {}) {
  // MPEG-1 Layer III, 128 кбит/с, 44,1 кГц: кадр 417 байт.
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), zeros(413)]);
  return Buffer.concat([Buffer.from('ID3\x04\0\0\0\0\0\0', 'latin1'), ...Array(frames).fill(frame)]);
}

module.exports = { m4a, ogg, wav, mp3 };
