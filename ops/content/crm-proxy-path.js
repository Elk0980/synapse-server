'use strict';

/* Нормализация пути прокси /content/crm до проверок маршрутов.
   Проверки прав и запрос в CRM используют одну и ту же строку, которую возвращает эта функция. */

// Символы pchar (RFC 3986), которые encodeURIComponent кодирует, а в сегменте пути они допустимы как есть.
const PCHAR_RESTORE = { '%24': '$', '%26': '&', '%2B': '+', '%2C': ',', '%3B': ';', '%3D': '=', '%3A': ':', '%40': '@' };

function encodeSegment(value) {
  return encodeURIComponent(value).replace(/%(?:24|26|2B|2C|3B|3D|3A|40)/g, (code) => PCHAR_RESTORE[code]);
}

/**
 * @param {string} rawPath путь после префикса /content/crm (в виде url.pathname)
 * @returns {{ok:true, path:string} | {ok:false, status:number}}
 */
function normalizeCrmPath(rawPath) {
  const collapsed = `/${String(rawPath || '')}`.replace(/\/{2,}/g, '/');
  const segments = collapsed.split('/').slice(1);
  const normalized = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return { ok: false, status: 404 };
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return { ok: false, status: 404 }; }
    // Раскодирование не должно менять границы сегментов, давать «.»/«..», управляющие символы
    // или ещё один слой кодирования.
    if (decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f\u007f]/.test(decoded) ||
      /%[0-9a-f]{2}/i.test(decoded)) return { ok: false, status: 404 };
    normalized.push(decoded);
  }
  if (normalized.length && normalized[0].toLowerCase() === 'internal') return { ok: false, status: 403 };
  return { ok: true, path: '/' + normalized.map(encodeSegment).join('/') };
}

module.exports = { normalizeCrmPath };
