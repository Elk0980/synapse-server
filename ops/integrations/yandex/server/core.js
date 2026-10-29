'use strict';

const crypto = require('node:crypto');

class IntegrationError extends Error {
  constructor(code) { super(code); this.name = 'IntegrationError'; this.code = code; }
}
const fail = (code) => { throw new IntegrationError(code); };
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some((key) => !keys.includes(key))) fail('INVALID_FIELDS');
  return value;
}
function text(value, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) fail('INVALID_TEXT');
  return value;
}
function key(value) {
  text(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value) || value in Object.prototype) fail('INVALID_KEY');
  return value;
}
function id(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail('INVALID_ID');
  return value;
}
function ids(value) {
  if (!Array.isArray(value) || value.length > 1000) fail('INVALID_IDS');
  const result = value.map(id);
  if (new Set(result).size !== result.length) fail('DUPLICATE_ID');
  return result.sort();
}
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  fail('NON_CANONICAL_VALUE');
}
const hash = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const clone = (value) => structuredClone(value);
const opaque = () => crypto.randomUUID();
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_TIME');
  return new Date(value).toISOString();
}
function period(value) {
  exact(value, ['from', 'to', 'timezone']);
  for (const date of [value.from, value.to]) {
    const parsed = typeof date === 'string' ? new Date(date + 'T00:00:00Z') : null;
    if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date) ||
        !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('INVALID_PERIOD');
  }
  if (value.from > value.to) fail('INVALID_PERIOD');
  if (typeof value.timezone !== 'string' || !value.timezone) fail('INVALID_TIMEZONE');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format(); } catch { fail('INVALID_TIMEZONE'); }
  return clone(value);
}
function money(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) fail('INVALID_MONEY');
  return value;
}
function authorize(actor, companyId, permission) {
  key(companyId);
  if (!actor || !['human', 'agent', 'service'].includes(actor.kind) ||
      !Array.isArray(actor.companyIds) || !actor.companyIds.includes(companyId) ||
      !Array.isArray(actor.permissions) || !actor.permissions.includes(permission)) fail('FORBIDDEN');
  key(actor.id);
}
function losslessParse(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body, (_key, value, context) => {
      if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
        if (!/^[0-9]+$/.test(context.source)) fail('UNSAFE_NUMBER');
        return context.source;
      }
      return value;
    });
  } catch { fail('INVALID_RESPONSE'); }
}
function directJson(value) {
  return JSON.stringify(value, (field, item) => {
    if ((field === 'Id' || field === 'Ids' || field === 'CampaignIds') && typeof item === 'string') return JSON.rawJSON(id(item));
    if (['Ids', 'CampaignIds'].includes(field) && Array.isArray(item)) return item.map((entry) => JSON.rawJSON(id(entry)));
    return item;
  });
}

module.exports = { IntegrationError, fail, exact, text, key, id, ids, canonical, hash, clone, opaque,
  instant, period, money, authorize, losslessParse, directJson };
