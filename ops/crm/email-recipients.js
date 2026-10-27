'use strict';

// Recipient lists for lead notifications: one documented format shared by the
// cabinet, the settings store and the delivery queue.
//   ""                                   -> notifications of the company are disabled
//   "owner@example.test"                 -> one recipient (the previous single-address meaning)
//   "owner@example.test, admin@example.test" -> up to MAX_RECIPIENTS addresses separated by commas
// Display names, semicolons, line breaks and arrays are not accepted.
const MAX_RECIPIENTS = 5;
const MAX_LIST_LENGTH = 1024;
const INVALID_MESSAGE = 'Укажите один или несколько корректных почтовых адресов через запятую (не больше 5)';
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function recipientError(message = INVALID_MESSAGE) {
  return Object.assign(new Error(message), {status: 400});
}

// One mailbox in canonical form: the local part is kept as typed, the domain is
// case-insensitive and is lower-cased. Returns '' for an invalid value.
function canonicalMailbox(value) {
  if (typeof value !== 'string') return '';
  const clean = value.trim();
  const parts = clean.split('@');
  if (clean.length > 254 || parts.length !== 2 || parts[0].length > 64 ||
      !LOCAL_PART.test(parts[0]) || !DOMAIN.test(parts[1])) return '';
  return parts[0] + '@' + parts[1].toLowerCase();
}

// Strict parser for values entered in the cabinet or API. Any invalid element
// rejects the whole value: nothing is partially saved or sent.
function parseRecipientList(value) {
  if (typeof value !== 'string' || value.length > MAX_LIST_LENGTH) throw recipientError();
  // CR/LF/NUL and other control characters would allow header injection.
  if (/[\x00-\x1F\x7F]/.test(value)) throw recipientError();
  const clean = value.trim();
  if (!clean) return [];
  const items = clean.split(',').map(item => item.trim());
  if (items.length > MAX_RECIPIENTS) throw recipientError('Можно указать не больше 5 адресов получателей');
  const result = [];
  for (const item of items) {
    const mailbox = canonicalMailbox(item);
    if (!mailbox) throw recipientError();
    // Safe de-duplication: the same mailbox typed twice (domain case ignored) is kept once.
    if (!result.includes(mailbox)) result.push(mailbox);
  }
  return result;
}

const formatRecipientList = list => list.join(', ');

// Address of one SMTP acknowledgement entry or of a requested destination, in canonical
// form for comparison. Strings and {address} objects are accepted explicitly; a display
// form "Name <a@b>" is reduced to its mailbox. Anything else yields '' (no confirmation).
function acknowledgedAddress(entry) {
  const value = typeof entry === 'string' ? entry
    : entry && typeof entry === 'object' && typeof entry.address === 'string' ? entry.address : '';
  if (!value || /[\x00-\x1F\x7F]/.test(value)) return '';
  const bracketed = /<([^<>]+)>\s*$/.exec(value);
  return canonicalMailbox(bracketed ? bracketed[1] : value);
}
// Normalized string stored in the database and returned by the API.
const normalizeRecipientList = value => formatRecipientList(parseRecipientList(value));

// Effective addresses from stored or environment configuration. Values written by
// the cabinet are already validated; an older single environment value that is
// not a plain mailbox keeps its previous single-recipient meaning.
function recipientsFromValue(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  try { return parseRecipientList(value); } catch {
    const clean = value.trim();
    return clean.includes(',') || /[\x00-\x1F\x7F]/.test(clean) ? [] : [clean];
  }
}

module.exports = {MAX_RECIPIENTS, MAX_LIST_LENGTH, canonicalMailbox, parseRecipientList, formatRecipientList,
  normalizeRecipientList, recipientsFromValue, recipientError, acknowledgedAddress};
