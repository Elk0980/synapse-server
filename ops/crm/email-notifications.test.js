'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createEmailNotifications, emailErrorCode } = require('./email-notifications');

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
      auth: { user: 'crm@example.test', pass: 'secret' },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
    return { sendMail: async (message) => sent.push(message) };
  });
  await notifications.notifyLead({
    company_code: 'ALVI', name: 'Анна', contact: '+7 900 000-00-00', channel: 'quiz',
    page: '/price', utm_source: 'yandex', tag: null, created_at: '2026-09-11T00:30:00.000Z',
    utm_medium: 'cpc', utm_campaign: 'launch', utm_content: 'creative', utm_term: 'массаж',
    comment: 'Перезвонить после 18:00', referrer: 'https://example.test/private-do-not-include',
  });
  assert.deepEqual(sent, [{
    from: 'leads@example.test', to: 'owner@example.test',
    subject: 'Новая заявка с сайта ALVI — Анна',
    text: [
      'Имя: Анна', 'Контакт: +7 900 000-00-00', 'Канал: quiz', 'Страница: /price',
      'Источник (utm_source): yandex', 'Канал рекламы (utm_medium): cpc',
      'Кампания (utm_campaign): launch', 'Объявление (utm_content): creative',
      'Ключевая фраза (utm_term): массаж', 'Комментарий: Перезвонить после 18:00',
      'Дата и время (Иркутск): 11 сентября 2026 г. в 08:30',
    ].join('\n'),
  }]);
});

test('Synapse notification uses its legacy recipient', async () => {
  const sent = [];
  const notifications = createEmailNotifications({
    LEADS_SMTP_USER: 'crm@example.test', LEADS_SMTP_PASSWORD: 'test-password', LEADS_NOTIFY_EMAIL: 'default@example.test',
    LEADS_NOTIFY_EMAIL_ALVI: 'owner@example.test',
  }, console, () => ({ sendMail: async (message) => sent.push(message) }));
  await notifications.notifyLead({ company_code: 'synapse-business', name: 'Иван', contact: 'ivan@example.test',
    created_at: '2026-09-11T00:00:00.000Z' });
  assert.equal(sent[0].to, 'default@example.test');
  assert.equal(sent[0].subject, 'Новая заявка с сайта Synapse — Иван');
});

test('Avokado has a separate recipient and brand and never falls back to another company address', async () => {
  const sent = [];
  const environment = {LEADS_SMTP_USER: 'crm@example.test', LEADS_SMTP_PASSWORD: 'test-password',
    LEADS_NOTIFY_EMAIL: 'default@example.test', LEADS_NOTIFY_EMAIL_ALVI: 'alvi@example.test',
    LEADS_NOTIFY_EMAIL_AVOKADO: 'avokado@example.test'};
  const make = env => createEmailNotifications(env, console, () => ({sendMail: async message => sent.push(message)}));
  const lead = {company_code: 'AVOKADO', name: 'Анна', contact: '+7 900 000 00 00', created_at: '2026-09-15T00:00:00Z'};
  await make(environment).notifyLead(lead, {messageId: '<stable@example.test>', repeatedAt: '2026-09-16T00:00:00Z'});
  assert.equal(sent[0].to, 'avokado@example.test');
  assert.equal(sent[0].subject, 'Новая заявка с сайта АВОКАДО — Анна');
  assert.equal(sent[0].messageId, '<stable@example.test>');
  assert.match(sent[0].text, /Повторное обращение \(Иркутск\):/);
  await assert.rejects(make({...environment, LEADS_NOTIFY_EMAIL_AVOKADO: ''}).notifyLead(lead), {code: 'EMAIL_RECIPIENT_MISSING'});
  await assert.rejects(make({...environment, LEADS_NOTIFY_EMAIL_ALVI: ''}).notifyLead({...lead, company_code: 'alvi'}), {code: 'EMAIL_RECIPIENT_MISSING'});
  assert.equal(sent.length, 1);
});

test('missing SMTP password stays disabled and rejected recipients are not reported as sent', async () => {
  const disabled = createEmailNotifications({LEADS_SMTP_USER: 'crm@example.test'}, {info() {}}, () => assert.fail('no transport without password'));
  assert.equal(disabled.enabled, false);
  assert.equal(await disabled.notifyLead({}), false);
  const rejected = createEmailNotifications({LEADS_SMTP_USER: 'crm@example.test', LEADS_SMTP_PASSWORD: 'test-password',
    LEADS_NOTIFY_EMAIL_ALVI: 'alvi@example.test'}, console, () => ({sendMail: async () => ({accepted: [], rejected: ['alvi@example.test']})}));
  await assert.rejects(rejected.notifyLead({company_code: 'alvi', name: 'Test', created_at: '2026-09-15T00:00:00Z'}), {code: 'EMAIL_RECIPIENT_REJECTED'});
});

test('only a fixed diagnostic code is retained from SMTP failures', () => {
  for (const [error, expected] of [
    [{code: 'EAUTH', message: 'secret account'}, 'SMTP_AUTH'],
    [{code: 'ETIMEDOUT', message: 'private address'}, 'SMTP_CONNECTION'],
    [{code: 'EENVELOPE'}, 'SMTP_ENVELOPE'],
    [{code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550}, 'SMTP_SENDER'],
    [{code: 'EENVELOPE', command: 'RCPT TO', responseCode: 553}, 'SMTP_RECIPIENT'],
    [{code: 'EDNS'}, 'SMTP_CONNECTION'],
    [{code: 'EMAIL_RECIPIENT_MISSING'}, 'EMAIL_RECIPIENT_MISSING'],
    [{code: 'unknown-secret', message: 'private payload'}, 'SMTP_SEND_FAILED'],
  ]) assert.equal(emailErrorCode(error), expected);
});
