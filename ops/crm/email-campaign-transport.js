'use strict';

const {emailErrorCode} = require('./email-notifications');
const HOSTS = new Set(['smtp.yandex.ru', 'smtp.mail.ru', 'smtp.gmail.com']);
const CONTROL = /[\u0000-\u001f\u007f]/;
const clean = (env, key, fallback = '') => typeof env[key] === 'string' ? env[key].trim() :
  env[key] === undefined ? fallback : '';
const mailbox = value => typeof value === 'string' && value.length <= 254 &&
  /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/.test(value) && !CONTROL.test(value);
const failure = code => Object.assign(new Error(code === 'SMTP_NOT_CONFIGURED'
  ? 'Почта отправителя не настроена' : 'Не удалось отправить письмо рассылки'), {code});

function createCampaignTransport({getEnvironment, createTransport} = {}) {
  if (typeof getEnvironment !== 'function') throw new TypeError('Требуется источник настроек почты');
  function settings() {
    const env = getEnvironment() || {};
    const host = clean(env, 'LEADS_SMTP_HOST', 'smtp.yandex.ru');
    const port = clean(env, 'LEADS_SMTP_PORT', '465');
    const user = clean(env, 'LEADS_SMTP_USER'), password = clean(env, 'LEADS_SMTP_PASSWORD');
    const from = clean(env, 'LEADS_MAIL_FROM') || user;
    if (!HOSTS.has(host) || port !== '465' || !mailbox(user) || !mailbox(from) || !password || CONTROL.test(password)) return null;
    return {from, options: {host, port: 465, secure: true, auth: {user, pass: password},
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000}};
  }
  function current() {
    try { return settings(); } catch { return null; }
  }
  async function send({to, subject, text, messageId, unsubscribeUrl, companyCode} = {}) {
    const state = current();
    if (!state) throw failure('SMTP_NOT_CONFIGURED');
    let unsubscribe;
    try {
      const url = new URL(unsubscribeUrl);
      if (typeof unsubscribeUrl !== 'string' || unsubscribeUrl.length > 2000 || CONTROL.test(unsubscribeUrl) ||
          url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid unsubscribe URL');
      unsubscribe = url.href;
    } catch { throw failure('SMTP_SEND_FAILED'); }
    if (!mailbox(to) || typeof subject !== 'string' || !subject.trim() || subject.length > 500 || CONTROL.test(subject) ||
        typeof text !== 'string' || !text.trim() || text.length > 100000 || /\u0000/.test(text) ||
        typeof companyCode !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(companyCode) ||
        typeof messageId !== 'string' || messageId.length > 254 || !/^<[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+>$/.test(messageId)) {
      throw failure('SMTP_SEND_FAILED');
    }
    const message = {from: state.from, to, subject: subject.trim(),
      text: `${text.trimEnd()}\n\n---\nОтписаться от рассылки: ${unsubscribe}\n`, messageId,
      headers: {'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'List-ID': `<${companyCode}.synapsebusiness.ru>`}};
    try {
      // Read effective settings on every send. An in-flight message keeps its
      // original snapshot when the owner changes the sender in the cabinet.
      const transport = (createTransport || require('nodemailer').createTransport)(state.options);
      const result = await transport.sendMail(message);
      if (!Array.isArray(result?.accepted) || !result.accepted.some(address =>
        typeof address === 'string' && address.toLowerCase() === to.toLowerCase())) {
        throw failure('EMAIL_RECIPIENT_REJECTED');
      }
      return true;
    } catch (error) {
      throw failure(emailErrorCode(error));
    }
  }
  return {configured: () => Boolean(current()), sender: () => current()?.from || '', send};
}

module.exports = {createCampaignTransport};
