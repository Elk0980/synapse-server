'use strict';
const { PALITRA_ORDER_ORIGINS } = require('./site-orders');

function clientCompanyConfig(env, companies) {
  const username = key => String(env[`${key}_CLIENT_BOT_USERNAME`] || '').trim().replace(/^@/, '');
  const policy = value => /^https:\/\/[\w.-]+\/[\w./-]*$/.test(value || '') ? value : '';
  return {
    orderSites: {
      palitra: { companyCode: companies.palitra, title: 'Palitra',
        origins: (env.PALITRA_ORDER_ORIGINS || PALITRA_ORDER_ORIGINS.join(',')).split(',').map(s => s.trim()).filter(Boolean) },
      // Получатель и диалоги доступны владельцу. Публичный приём заявок ALVI не включается.
      alvi: { companyCode: companies.alvi, title: 'ALVI', origins: [] },
    },
    bots: {
      palitra: { companyCode: companies.palitra, site: 'palitra', title: 'Palitra', username: username('PALITRA'),
        hours: '09:00–21:00', policyUrl: policy(env.PALITRA_CLIENT_BOT_POLICY_URL) || 'https://palitra-love.ru/privacy' },
      alvi: { companyCode: companies.alvi, site: 'alvi', title: 'ALVI', username: username('ALVI'),
        hours: String(env.ALVI_CLIENT_BOT_HOURS || '').trim(), policyUrl: policy(env.ALVI_CLIENT_BOT_POLICY_URL) },
    },
  };
}

module.exports = { clientCompanyConfig };
