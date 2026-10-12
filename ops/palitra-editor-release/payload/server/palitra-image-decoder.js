'use strict';
/* Palitra: доверенный полный декодер фото для native-feature (deps.decodeImage). НЕ УСТАНОВЛЕНО, НЕ ЗАПУСКАЛОСЬ.
   Модуль сам ничего не устанавливает и не требует: Root передаёт уже установленный официальный пакет sharp
   (npm: sharp) — createSharpDecoder(require('sharp')). Проверка на реальных файлах — задача Root (DECODER.md).

   Что делает decodeImage(bytes):
   - sharp(bytes, { failOn: 'warning', limitInputPixels, animated: false }) — предупреждение декодера = отказ;
   - metadata(): только jpeg/png/webp, одна страница (без анимации);
   - rotate() по EXIF + raw().toBuffer(): полное декодирование всех пикселей (metadata одна этого не делает);
   - возвращает { format, width, height } уже после поворота — их сверяют с image-probe. */

function createSharpDecoder(sharp, { limitInputPixels = 40000000 } = {}) {
  if (typeof sharp !== 'function') throw new Error('Нужен модуль sharp: createSharpDecoder(require("sharp"))');
  return async function decodeImage(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Нет байтов фото');
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels, animated: false });
    const meta = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format)) throw new Error('Неподдерживаемый формат');
    if (meta.pages && meta.pages > 1) throw new Error('Анимация не поддерживается');
    const { data, info } = await image.rotate().raw().toBuffer({ resolveWithObject: true });
    if (!info || !info.width || !info.height || data.length !== info.width * info.height * info.channels) throw new Error('Декодирование не завершено');
    return { format: meta.format, width: info.width, height: info.height };
  };
}

module.exports = { createSharpDecoder };
