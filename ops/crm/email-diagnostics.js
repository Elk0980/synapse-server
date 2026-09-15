'use strict';

const ERROR_CODES = new Set([
  'SMTP_NOT_CONFIGURED', 'EMAIL_RECIPIENT_MISSING', 'EMAIL_RECIPIENT_REJECTED',
  'SMTP_AUTH', 'SMTP_CONNECTION', 'SMTP_SENDER', 'SMTP_RECIPIENT',
  'SMTP_ENVELOPE', 'SMTP_SEND_FAILED',
]);
const value = (environment, name, fallback = '') =>
  (environment[name] === undefined ? fallback : environment[name]).trim();

function createEmailDiagnostics(db, {environment = process.env, getEnvironment = () => environment, now = Date.now} = {}) {
  // Read the currently effective settings without constructing a transport.
  const configFlags = () => {
    const environment = getEnvironment();
    const host = Boolean(value(environment, 'LEADS_SMTP_HOST', 'smtp.yandex.ru'));
    const portNumber = Number.parseInt(value(environment, 'LEADS_SMTP_PORT', '465'), 10);
    const port = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
    const user = Boolean(value(environment, 'LEADS_SMTP_USER'));
    const password = Boolean(value(environment, 'LEADS_SMTP_PASSWORD'));
    const from = Boolean(value(environment, 'LEADS_MAIL_FROM') || value(environment, 'LEADS_SMTP_USER'));
    const smtp = {host, port, user, password, from, configured: host && port && user && password};
    const recipients = {
      alvi: Boolean(value(environment, 'LEADS_NOTIFY_EMAIL_ALVI')),
      avokado: Boolean(value(environment, 'LEADS_NOTIFY_EMAIL_AVOKADO')),
    };
    return {smtp, recipients};
  };
  const counts = db.prepare(`SELECT lower(leads.company_code) AS company,
    outbox.status, outbox.last_error_code AS error, COUNT(*) AS count
    FROM lead_email_outbox AS outbox JOIN leads ON leads.id = outbox.lead_id
    WHERE lower(leads.company_code) IN ('alvi', 'avokado')
    GROUP BY lower(leads.company_code), outbox.status, outbox.last_error_code`);

  function getStatus() {
    const {smtp, recipients} = configFlags();
    const companies = ['alvi', 'avokado'].map(code => ({code,
      recipientConfigured: recipients[code], queued: 0, sending: 0, sent: 0, errors: []}));
    const errors = new Map(companies.map(company => [company.code, new Map()]));
    for (const row of counts.all()) {
      const company = companies.find(item => item.code === row.company);
      const field = {pending: 'queued', sending: 'sending', sent: 'sent'}[row.status];
      if (field) company[field] += row.count;
      if (row.error) {
        const code = ERROR_CODES.has(row.error) ? row.error : 'SMTP_SEND_FAILED';
        const grouped = errors.get(company.code);
        grouped.set(code, (grouped.get(code) || 0) + row.count);
      }
    }
    for (const company of companies) {
      company.errors = [...errors.get(company.code)].sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({code, count}));
    }
    return {checkedAt: new Date(now()).toISOString(), smtp: {...smtp}, companies};
  }
  return {getStatus};
}

module.exports = {createEmailDiagnostics};
