'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { clientCompanyConfig } = require('./client-bot-config');
const { clientBotConfigs } = require('../chat/client-bot-config');
const { createClientBotRegistry } = require('../chat/client-bot-registry');
const companies = { palitra: 'palitra-love', alvi: 'alvi' };
const shared = { contentUrl: 'http://content:8080', apiKey: 'test' };

test('пустые настройки не запускают ботов и не копируют факты Palitra в ALVI', () => {
  const config = clientCompanyConfig({}, companies);
  assert.deepEqual(clientBotConfigs({}, shared), []);
  assert.equal(config.bots.alvi.username, '');
  assert.equal(config.bots.alvi.hours, '');
  assert.equal(config.bots.alvi.policyUrl, '');
  assert.deepEqual(config.orderSites.alvi.origins, []);
  assert.equal(config.bots.palitra.policyUrl, 'https://palitra-love.ru/privacy');
  assert.equal(config.bots.palitra.companyCode, 'palitra-love');
});

test('ALVI получает только собственные настройки, content не получает токен', () => {
  const env = { ALVI_CLIENT_BOT_TOKEN: '222:synthetic', ALVI_CLIENT_BOT_USERNAME: '@Alvi_test_bot',
    ALVI_CLIENT_BOT_WEBHOOK_SECRET: 'alvi-secret', ALVI_CLIENT_BOT_POLLING: '1',
    ALVI_CLIENT_BOT_HOURS: '10:00–18:00', ALVI_CLIENT_BOT_POLICY_URL: 'https://example.test/privacy',
    PALITRA_CLIENT_BOT_TOKEN: '111:synthetic', PALITRA_CLIENT_BOT_USERNAME: 'palitra_test_bot' };
  const config = clientCompanyConfig(env, companies);
  const transports = clientBotConfigs(env, shared);
  assert.equal(config.bots.alvi.companyCode, 'alvi');
  assert.equal(config.bots.alvi.username, 'Alvi_test_bot');
  assert.equal(config.bots.alvi.hours, env.ALVI_CLIENT_BOT_HOURS);
  assert.equal(JSON.stringify(config).includes('synthetic'), false);
  assert.deepEqual(config.orderSites.alvi.origins, []);
  assert.deepEqual(transports.map(bot => [bot.botKey, bot.token, bot.polling]), [
    ['palitra', '111:synthetic', false], ['alvi', '222:synthetic', true],
  ]);
  assert.equal(transports[1].webhookSecret, 'alvi-secret');
  assert.throws(() => createClientBotRegistry({ configs: clientBotConfigs({ ...env, ALVI_CLIENT_BOT_TOKEN: env.PALITRA_CLIENT_BOT_TOKEN }, shared) }), /Повторная/);
});

test('неполная настройка ALVI остаётся выключенной; ошибка не содержит токена', () => {
  const warnings = [];
  const log = { warn: message => warnings.push(message) };
  assert.deepEqual(clientBotConfigs({ ALVI_CLIENT_BOT_TOKEN: '222:secret' }, shared, log), []);
  assert.deepEqual(clientBotConfigs({ ALVI_CLIENT_BOT_TOKEN: '222:secret', ALVI_CLIENT_BOT_USERNAME: 'alvi_test_bot' }, {}, log), []);
  assert.equal(warnings.length, 2);
  assert.equal(warnings.join('').includes('secret'), false);
  assert.equal(clientCompanyConfig({ ALVI_CLIENT_BOT_POLICY_URL: 'javascript:alert(1)' }, companies).bots.alvi.policyUrl, '');
});
