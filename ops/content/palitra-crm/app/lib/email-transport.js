'use strict';

const { createHash } = require('node:crypto');

const SITE = 'palitra';
const COMPANY = 'palitra-love';
const FIELDS = new Set(['to', 'subject', 'text', 'site', 'companyCode', 'inquiryId', 'event', 'channel', 'idempotencyKey', 'signal']);
const permanent = (code) => ({ ok: false, permanent: true, uncertain: false, code });
const uncertain = (code = 'EMAIL_DELIVERY_UNKNOWN') => ({ ok: false, uncertain: true, code });
const refused = (code) => code >= 400 && code <= 499
  ? { ok: false, retryable: true, uncertain: false, code: 'SMTP_TEMPORARY_REFUSAL' }
  : permanent('SMTP_PERMANENT_REFUSAL');

// Та же проверка адреса, что в настройках резервной почты (email-address.js).
const { validEmailAddress: address, validDomain: domain } = require('./email-address');

// A complete SMTP reply has one final line. Mixed codes or an unfinished continuation
// do not constitute a receipt. The raw reply is never returned or logged.
function smtpCode(response) {
  if (typeof response !== 'string' || !response || response.length > 4096) return null;
  const lines = response.replace(/\r\n/g, '\n').split('\n');
  let code = null;
  for (let i = 0; i < lines.length; i++) {
    const match = /^([245]\d{2})([ -]|$)[^\x00-\x1f\x7f]*$/.exec(lines[i]);
    if (!match || (code !== null && Number(match[1]) !== code)) return null;
    if (i < lines.length - 1 ? match[2] !== '-' : match[2] === '-') return null;
    code = Number(match[1]);
  }
  return code;
}

function errorResult(error) {
  // Losing the connection after DATA can mean the server already accepted the mail.
  // In particular ECONNRESET/ETIMEDOUT alone must never trigger an automatic retry.
  const reply = smtpCode(error?.response);
  const explicit = Number.isInteger(error?.responseCode) ? error.responseCode : reply;
  if (/^QUIT\b/i.test(String(error?.command || ''))) return uncertain();
  if (explicit >= 400 && explicit <= 599
    && (error?.response === undefined || reply === explicit)) return refused(explicit);
  return uncertain();
}

/** Returns the sendEmail function consumed by email-fallback.js.
 * The caller injects an already configured SMTP transport; this module never reads
 * environment variables, creates a connection, closes a shared transport, or retries.
 * A deterministic Message-ID is correlation, not an SMTP deduplication guarantee.
 * The durable outbox remains responsible for attempts and its timeout/AbortSignal.
 */
function createInquiryEmailTransport({ transport, from, messageIdDomain } = {}) {
  if (!transport || typeof transport.sendMail !== 'function') throw new TypeError('Требуется настроенный почтовый транспорт');
  if (!address(from)) throw new TypeError('Некорректный адрес отправителя');
  // email-fallback stores receipts up to 256 characters, including the fixed ID prefix.
  if (!domain(messageIdDomain) || messageIdDomain.length > 182) throw new TypeError('Некорректный домен идентификатора письма');
  const idDomain = messageIdDomain.toLowerCase();

  return async function sendEmail(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !FIELDS.has(key))) return permanent('EMAIL_INVALID_REQUEST');
    if (input.site !== SITE || input.companyCode !== COMPANY || input.event !== 'new_inquiry' || input.channel !== 'email') {
      return permanent('EMAIL_SCOPE_DENIED');
    }
    if (!Number.isSafeInteger(input.inquiryId) || input.inquiryId < 1
      || input.idempotencyKey !== `${SITE}:inquiry:${input.inquiryId}:new_inquiry:email`) return permanent('EMAIL_INVALID_REQUEST');
    if (!address(input.to)) return permanent('EMAIL_INVALID_RECIPIENT');
    if (typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > 200
      || /[\x00-\x1f\x7f]/.test(input.subject)) return permanent('EMAIL_INVALID_SUBJECT');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 10000
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)) return permanent('EMAIL_INVALID_TEXT');
    const signal = input.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return permanent('EMAIL_INVALID_SIGNAL');
    // Known not sent, terminal for this cancelled attempt. Retry decisions stay in the outbox.
    if (signal?.aborted) return permanent('EMAIL_ABORTED_BEFORE_SEND');
    const messageId = `<palitra-${createHash('sha256').update(input.idempotencyKey).digest('hex')}@${idDomain}>`;
    const mail = { from, to: input.to, subject: input.subject, text: input.text, messageId,
      envelope: { from, to: [input.to] }, disableFileAccess: true, disableUrlAccess: true };

    return new Promise((resolve) => {
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      // Once sendMail has started, cancellation cannot establish whether SMTP accepted DATA.
      const onAbort = () => finish(uncertain('EMAIL_ABORTED_AFTER_SEND'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { finish(permanent('EMAIL_ABORTED_BEFORE_SEND')); return; }
      let pending;
      try { pending = transport.sendMail(mail); }
      catch (error) { finish(errorResult(error)); return; }
      Promise.resolve(pending).then((info) => {
        if (finished) return;
        if (info?.uncertain === true) { finish(uncertain()); return; }
        const code = smtpCode(info?.response);
        if (code >= 400 && code <= 599) { finish(refused(code)); return; }
        const accepted = Array.isArray(info?.accepted) && info.accepted.length === 1 && info.accepted[0] === input.to;
        const rejected = Array.isArray(info?.rejected) && info.rejected.length === 0;
        if (code !== 250 || !accepted || !rejected || info?.messageId !== messageId
          || info?.pending?.length) { finish(uncertain('SMTP_RECEIPT_UNCONFIRMED')); return; }
        finish({ ok: true, messageId });
      }, (error) => finish(errorResult(error)));
    });
  };
}

module.exports = { createInquiryEmailTransport };
