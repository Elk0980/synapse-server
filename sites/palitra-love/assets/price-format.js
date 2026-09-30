/* Только отображение: не парсер стоимости для расчёта заявки. Неизвестные и условные
   цены нельзя превращать в фиксированные суммы. Исходные строки остаются в прайсе. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PalitraPriceFormat = api;
}(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const NUMBER = '(?:\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+|\\d{1,3}(?:\\.\\d{3})+|\\d+)(?:[,.]\\d{1,2})?';
  const PRICE = new RegExp('^(от\\s+)?(' + NUMBER + ')\\s*(?:руб\\.?|р\\.?|₽)?(\\s*/\\s*[а-яёa-z²³.]+)?$', 'i');
  const grouped = digits => digits.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  function format(value) {
    const text = String(value ?? '').trim(), match = PRICE.exec(text);
    if (!match) return text;
    const fraction = /[,.](\d{1,2})$/.exec(match[2]);
    const integer = fraction ? match[2].slice(0, fraction.index) : match[2];
    const cents = fraction ? fraction[1].padEnd(2, '0') : '00';
    return `${match[1] ? match[1].trim() + ' ' : ''}${grouped(integer.replace(/[ .\u00a0\u202f]/g, ''))}${cents === '00' ? '' : ',' + cents} ₽${match[3] ? ' ' + match[3].trim() : ''}`;
  }
  function formatRub(kopecks) {
    if (!Number.isSafeInteger(kopecks) || kopecks < 0) return 'Цена уточняется';
    const cents = kopecks % 100;
    return `${grouped(String(Math.floor(kopecks / 100)))}${cents ? ',' + String(cents).padStart(2, '0') : ''} ₽`;
  }
  return { format, formatRub };
}));
