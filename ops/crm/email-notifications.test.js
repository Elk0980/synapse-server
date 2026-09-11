'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createEmailNotifications } = require('./email-notifications');

test('notifications are disabled once when SMTP host or user is empty', () => {
  const messages = [];
  const notifications = createEmailNotifications({ LEADS_SMTP_HOST: '' }, { info: (message) => messages.push(message) });
  assert.equal(notifications.enabled, false);
  assert.deepEqual(messages, ['email notifications disabled']);
});

test('ALVI notification uses its recipient and only populated lead fields', async () => {
  const sent = [];
  const environment = {
    LEADS_SMTP_HOST: 'smtp.example.test', LEADS_SMTP_PORT: '465',
    LEADS_SMTP_USER: 'crm@example.test', LEADS_SMTP_PASSWORD: 'secret',
    LEADS_MAIL_FROM: 'leads@example.test', LEADS_NOTIFY_EMAIL: 'default@example.test',
    LEADS_NOTIFY_EMAIL_ALVI: 'owner@example.test',
  };
  const notifications = createEmailNotifications(environment, console, (options) => {
    assert.deepEqual(options, { host: 'smtp.example.test', port: 465, secure: true,
      auth: { user: 'crm@example.test', pass: 'secret' } });
    return { sendMail: async (message) => sent.push(message) };
  });
  await notifications.notifyLead({
    company_code: 'ALVI', name: 'Анна', contact: '+7 900 000-00-00', channel: 'quiz',
    page: '/price', utm_source: 'yandex', tag: null, created_at: '2026-09-11T00:30:00.000Z',
  });
  assert.deepEqual(sent, [{
    from: 'leads@example.test', to: 'owner@example.test',
    subject: 'Новая заявка с сайта ALVI — Анна',
    text: [
      'Имя: Анна', 'Контакт: +7 900 000-00-00', 'Канал: quiz', 'Страница: /price',
      'Источник (utm_source): yandex', 'Дата и время (Иркутск): 11 сентября 2026 г. в 08:30',
    ].join('\n'),
  }]);
});

test('non-ALVI notification uses the common recipient', async () => {
  const sent = [];
  const notifications = createEmailNotifications({
    LEADS_SMTP_USER: 'crm@example.test', LEADS_NOTIFY_EMAIL: 'default@example.test',
    LEADS_NOTIFY_EMAIL_ALVI: 'owner@example.test',
  }, console, () => ({ sendMail: async (message) => sent.push(message) }));
  await notifications.notifyLead({ company_code: 'other', name: 'Иван', contact: 'ivan@example.test',
    created_at: '2026-09-11T00:00:00.000Z' });
  assert.equal(sent[0].to, 'default@example.test');
});
