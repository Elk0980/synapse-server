'use strict';

const IRKUTSK_DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Irkutsk',
  dateStyle: 'long',
  timeStyle: 'short',
});

function value(environment, name, fallback = '') {
  return (environment[name] === undefined ? fallback : environment[name]).trim();
}

// Persist/log categories only: SMTP responses can contain addresses and credentials.
function emailErrorCode(error) {
  const code = String(error?.code || '').toUpperCase();
  if (['SMTP_NOT_CONFIGURED', 'EMAIL_RECIPIENT_MISSING', 'EMAIL_RECIPIENT_REJECTED'].includes(code)) return code;
  if (['EAUTH', 'ENOAUTH', 'EOAUTH2'].includes(code) || error?.responseCode === 535) return 'SMTP_AUTH';
  if (['ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKET', 'ENOTFOUND', 'EAI_AGAIN', 'EDNS', 'ETLS'].includes(code)) return 'SMTP_CONNECTION';
  if (/^MAIL FROM\b/i.test(error?.command || '')) return 'SMTP_SENDER';
  if (/^RCPT TO\b/i.test(error?.command || '')) return 'SMTP_RECIPIENT';
  if (code === 'EENVELOPE') return 'SMTP_ENVELOPE';
  return 'SMTP_SEND_FAILED';
}

function notificationError(code, message) {
  return Object.assign(new Error(message), {code});
}

function companyRecipient(environment, code) {
  const raw=String(code||'synapse-business').toLowerCase();
  const company=raw==='synapse'?'synapse-business':raw;
  if(Object.hasOwn(environment.LEADS_COMPANY_RECIPIENTS||{},company)) return environment.LEADS_COMPANY_RECIPIENTS[company];
  if(company==='alvi'||company==='avokado') return value(environment,'LEADS_NOTIFY_EMAIL_'+company.toUpperCase());
  // Legacy unscoped Synapse enquiries keep their destination; unrelated companies never inherit it.
  return !company || company==='synapse-business' || company==='synapse' ? value(environment,'LEADS_NOTIFY_EMAIL') : '';
}
function emailNotificationReady(lead, environment) {
  const company = lead.company_code?.toLowerCase();
  return Boolean(value(environment, 'LEADS_SMTP_HOST', 'smtp.yandex.ru') &&
    value(environment, 'LEADS_SMTP_USER') && value(environment, 'LEADS_SMTP_PASSWORD') && companyRecipient(environment, company));
}

function createEmailNotifications(environment = process.env, logger = console, createTransport) {
  const host = value(environment, 'LEADS_SMTP_HOST', 'smtp.yandex.ru');
  const user = value(environment, 'LEADS_SMTP_USER');
  const password = value(environment, 'LEADS_SMTP_PASSWORD');
  if (!host || !user || !password) {
    logger.info('email notifications disabled');
    return { enabled: false, notifyLead: () => Promise.resolve(false), verify: () => Promise.resolve(false) };
  }

  const portText = value(environment, 'LEADS_SMTP_PORT', '465');
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('LEADS_SMTP_PORT должен быть целым числом от 1 до 65535');
  }
  const from = value(environment, 'LEADS_MAIL_FROM') || user;
  const transportFactory = createTransport || require('nodemailer').createTransport;
  const transport = transportFactory({
    host,
    port,
    secure: port === 465,
    auth: { user, pass: password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });

  async function notifyLead(lead, notification = {}) {
    const company = lead.company_code?.toLowerCase();
    // Explicit destinations prevent one studio's enquiries reaching another studio.
    const recipient = companyRecipient(environment, company);
    const brand = company === 'alvi' ? 'ALVI' : company === 'avokado' ? 'АВОКАДО' : !company || ['synapse','synapse-business'].includes(company) ? 'Synapse' : company;
    if (!recipient) throw notificationError('EMAIL_RECIPIENT_MISSING', 'Не задан адрес получателя уведомления о заявке');
    const fields = [
      ['Имя', lead.name],
      ['Контакт', lead.contact],
      ['Канал', lead.channel],
      ['Страница', lead.page],
      ['Источник (utm_source)', lead.utm_source],
      ['Канал рекламы (utm_medium)', lead.utm_medium],
      ['Кампания (utm_campaign)', lead.utm_campaign],
      ['Объявление (utm_content)', lead.utm_content],
      ['Ключевая фраза (utm_term)', lead.utm_term],
      ['Метка', lead.tag],
      ['Комментарий', lead.comment],
      ['Дата и время (Иркутск)', IRKUTSK_DATE_TIME.format(new Date(lead.created_at))],
      ['Повторное обращение (Иркутск)', notification.repeatedAt ? IRKUTSK_DATE_TIME.format(new Date(notification.repeatedAt)) : null],
    ];
    const text = fields.filter(([, fieldValue]) => fieldValue !== null && fieldValue !== undefined && fieldValue !== '')
      .map(([label, fieldValue]) => `${label}: ${fieldValue}`).join('\n');
    const result = await transport.sendMail({
      from,
      to: recipient,
      subject: `Новая заявка с сайта ${brand} — ${lead.name}`,
      text,
      ...(notification.messageId ? {messageId: notification.messageId} : {}),
    });
    if (Array.isArray(result?.accepted) && result.accepted.length === 0) {
      throw notificationError('EMAIL_RECIPIENT_REJECTED', 'SMTP не принял получателя уведомления');
    }
    return true;
  }

  return { enabled: true, notifyLead, verify: () => transport.verify() };
}

module.exports = { createEmailNotifications, emailErrorCode, emailNotificationReady, companyRecipient };
