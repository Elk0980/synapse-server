'use strict';
// Проверка настоящего runtime Sharp. Только генерируемые в памяти изображения; нет сети/файловых записей.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createSharpDecoder } = require('./payload/server/palitra-image-decoder.js');
const probe = require('./payload/server/palitra-image-check.js');

async function verify(sharpModule) {
  if (typeof sharpModule !== 'string' || !path.isAbsolute(sharpModule)) throw new Error('Нужен явный абсолютный --sharp-module');
  const info = JSON.parse(fs.readFileSync(path.join(sharpModule, 'package.json'), 'utf8'));
  if (info.name !== 'sharp' || info.version !== '0.35.5') throw new Error('Требуется установленный sharp 0.35.5');
  const sharp = require(sharpModule);
  const decode = createSharpDecoder(sharp);
  const width = 320, height = 500, channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * channels;
    raw[offset] = (x * 7 + y) % 256;
    raw[offset + 1] = (y * 3 + x) % 256;
    raw[offset + 2] = (x + y * 5) % 256;
  }
  const cases = [];
  for (const format of ['jpeg', 'png', 'webp']) {
    for (const orientation of [1, 6]) {
      const pipeline = sharp(raw, { raw: { width, height, channels } }).withMetadata({ orientation });
      const bytes = await pipeline[format]().toBuffer();
      const structural = probe.inspect(bytes);
      const decoded = await decode(bytes);
      assert.equal(decoded.format, format);
      assert.equal(decoded.width, orientation === 6 ? height : width);
      assert.equal(decoded.height, orientation === 6 ? width : height);
      assert.equal(decoded.width, structural.width);
      assert.equal(decoded.height, structural.height);
      cases.push({ case: `${format}-orientation-${orientation}`, result: 'pass', width: decoded.width, height: decoded.height });
      if (orientation === 1) {
        const truncated = bytes.subarray(0, Math.floor(bytes.length * 0.65));
        await assert.rejects(() => decode(truncated));
        cases.push({ case: `${format}-truncated`, result: 'rejected' });
      }
    }
  }
  const png = await sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
  const damaged = Buffer.from(png);
  let chunk = 8;
  while (chunk + 12 <= damaged.length && damaged.toString('ascii', chunk + 4, chunk + 8) !== 'IDAT') chunk += damaged.readUInt32BE(chunk) + 12;
  assert.equal(damaged.toString('ascii', chunk + 4, chunk + 8), 'IDAT');
  const length = damaged.readUInt32BE(chunk);
  assert.ok(length > 2);
  damaged[chunk + 8] ^= 0xff; // Испорчен поток zlib; CRC контейнера пересчитывается.
  damaged.writeUInt32BE(probe.crc32(damaged, chunk + 4, chunk + 8 + length), chunk + 8 + length);
  assert.throws(() => probe.inspect(damaged)); // CRC правильный, но проверка zlib уже отклоняет повреждённые данные.
  await assert.rejects(() => decode(damaged));
  cases.push({ case: 'png-corrupt-IDAT-valid-CRC', result: 'rejected' });

  const largeHeader = Buffer.from(png);
  largeHeader.writeUInt32BE(6500, 16);
  largeHeader.writeUInt32BE(6500, 20);
  largeHeader.writeUInt32BE(probe.crc32(largeHeader, 12, 29), 29);
  await assert.rejects(() => decode(largeHeader), /pixel limit|pixels/i);
  cases.push({ case: 'header-over-40-megapixel-limit', result: 'rejected-before-pixel-allocation' });
  return { sharpVersion: info.version, generatedFixture: '320x500 coloured raw in memory', passed: cases.length,
    cases, fileWrites: 0, networkCalls: 0, liveEditorWrites: 0, realCustomerPhotosTested: false };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== '--sharp-module') {
    process.stderr.write('Использование: node verify-decoder.cjs --sharp-module ABS_INSTALLED_SHARP\n');
    process.exitCode = 1;
  } else verify(argv[1]).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
module.exports = { verify };
