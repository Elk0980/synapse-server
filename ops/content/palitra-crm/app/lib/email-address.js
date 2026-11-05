'use strict';
// Единая проверка адреса почты: одна и та же функция в настройках собственника и в SMTP-адаптере,
// чтобы сохранённый адрес не оказался «готовым» в настройках и отвергнутым при отправке.

function validDomain(value) {
  if (typeof value !== 'string' || value.length > 253 || !value.includes('.')) return false;
  return value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

/** Один адрес без имени, запятых, пробелов и управляющих символов; точки только между частями локальной части. */
function validEmailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\x00-\x20\x7f<>,;]/.test(value)) return false;
  const parts = value.split('@');
  return parts.length === 2 && parts[0].length >= 1 && parts[0].length <= 64
    && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(parts[0])
    && validDomain(parts[1]) && /\.[A-Za-z]{2,63}$/.test(parts[1]);
}

module.exports = { validEmailAddress, validDomain };
