'use strict';

const IRKUTSK_DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Irkutsk',
  dateStyle: 'long',
  timeStyle: 'short',
});

function value(environment, name, fallback = '') {
  return (environment[name] === undefined ? fallback : environment[name]).trim();
}

function createEmailNotifications(environment = process.env, logger = console, createTransport) {
  const host = value(environment, 'LEADS_SMTP_HOST', 'smtp.yandex.ru');
  const user = value(environment, 'LEADS_SMTP_USER');
  if (!host || !user) {
    logger.info('email notifications disabled');
    return { enabled: false, notifyLead: () => Promise.resolve(false) };
  }

  const portText = value(environment, 'LEADS_SMTP_PORT', '465');
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('LEADS_SMTP_PORT должен быть целым числом от 1 до 65535');
  }
  const password = value(environment, 'LEADS_SMTP_PASSWORD');
  const from = value(environment, 'LEADS_MAIL_FROM') || user;
  const notifyEmail = value(environment, 'LEADS_NOTIFY_EMAIL');
  const notifyEmailAlvi = value(environment, 'LEADS_NOTIFY_EMAIL_ALVI');
  const transportFactory = createTransport || require('nodemailer').createTransport;
  const transport = transportFactory({
    host,
    port,
    secure: port === 465,
    auth: { user, pass: password },
  });

  async function notifyLead(lead) {
    const recipient = lead.company_code?.toLowerCase() === 'alvi' ? notifyEmailAlvi : notifyEmail;
    if (!recipient) throw new Error('Не задан адрес получателя уведомления о заявке');
    const fields = [
      ['Имя', lead.name],
      ['Контакт', lead.contact],
      ['Канал', lead.channel],
      ['Страница', lead.page],
      ['Источник (utm_source)', lead.utm_source],
      ['Метка', lead.tag],
      ['Дата и время (Иркутск)', IRKUTSK_DATE_TIME.format(new Date(lead.created_at))],
    ];
    const text = fields.filter(([, fieldValue]) => fieldValue !== null && fieldValue !== undefined && fieldValue !== '')
      .map(([label, fieldValue]) => `${label}: ${fieldValue}`).join('\n');
    await transport.sendMail({
      from,
      to: recipient,
      subject: `Новая заявка с сайта ALVI — ${lead.name}`,
      text,
    });
    return true;
  }

  return { enabled: true, notifyLead };
}

module.exports = { createEmailNotifications };
