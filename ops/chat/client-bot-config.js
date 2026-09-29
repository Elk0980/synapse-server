'use strict';

// Только известные компании. Пользовательское сообщение не может выбрать токен или компанию.
function clientBotConfigs(env, shared, log = console) {
  return ['palitra', 'alvi'].flatMap(botKey => {
    const prefix = `${botKey.toUpperCase()}_CLIENT_BOT_`;
    const value = suffix => String(env[prefix + suffix] || '').trim();
    const token = value('TOKEN');
    const expectedUsername = value('USERNAME').replace(/^@/, '');
    if (!token) return [];
    if (!expectedUsername || !shared.contentUrl || !shared.apiKey) {
      log.warn?.(`Клиентский бот ${botKey} выключен: нужны имя, адрес content и служебный ключ`);
      return [];
    }
    return [{ ...shared, botKey, token, expectedUsername, webhookSecret: value('WEBHOOK_SECRET'),
      polling: value('POLLING') === '1', limits: {
        perChatMinute: Number.parseInt(value('LIMIT_CHAT_MINUTE'), 10),
        perChatDay: Number.parseInt(value('LIMIT_CHAT_DAY'), 10),
        perBotHour: Number.parseInt(value('LIMIT_BOT_HOUR'), 10),
      } }];
  });
}

module.exports = { clientBotConfigs };
