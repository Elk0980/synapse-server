'use strict';

const { createClientBotBridge } = require('./client-bot-bridge');

// Проверяем весь набор до создания мостов: ошибочная настройка не запускает часть ботов.
function createClientBotRegistry({ configs = [], reservedTokens = [], createBridge = createClientBotBridge }) {
  const keys = new Set();
  const names = new Set();
  const tokens = new Set(reservedTokens.map(value => String(value).trim()).filter(Boolean));
  const identities = new Set([...tokens].map(token => token.split(':')[0]));
  const normalized = configs.map(config => {
    const botKey = String(config.botKey || '');
    const token = String(config.token || '').trim();
    const expectedUsername = String(config.expectedUsername || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(botKey) || !token || !expectedUsername) {
      throw new Error('Неполная настройка клиентского бота');
    }
    const identity = token.split(':')[0];
    if (keys.has(botKey) || names.has(expectedUsername) || tokens.has(token) || identities.has(identity)) {
      throw new Error('Повторная регистрация клиентского бота');
    }
    keys.add(botKey); names.add(expectedUsername); tokens.add(token); identities.add(identity);
    return { ...config, botKey, token, expectedUsername };
  });
  const bridges = new Map(normalized.map(config => [config.botKey, createBridge(config)]));
  let started = false;
  return {
    get: key => bridges.get(key),
    start() {
      if (started) return;
      const active = [];
      try {
        for (const bridge of bridges.values()) { active.push(bridge); bridge.start(); }
        started = true;
      } catch (error) {
        for (const bridge of active) bridge.stop();
        throw error;
      }
    },
    stop() {
      if (!started) return;
      started = false;
      for (const bridge of bridges.values()) bridge.stop();
    },
  };
}

module.exports = { createClientBotRegistry };
