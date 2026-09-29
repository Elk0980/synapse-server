'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createClientBotRegistry } = require('./client-bot-registry');
const first = { botKey: 'one', token: '100:first', expectedUsername: '@First_bot' };
const second = { botKey: 'two', token: '200:second', expectedUsername: 'Second_bot' };

test('регистрация проверяется целиком до создания мостов, секреты не попадают в ошибку', () => {
  for (const duplicate of [first, { ...second, expectedUsername: 'FIRST_BOT' },
    { ...second, token: first.token }, { ...second, token: '100:rotated' }]) {
    let created = 0;
    assert.throws(() => createClientBotRegistry({ configs: [first, duplicate], createBridge() { created++; } }),
      { message: 'Повторная регистрация клиентского бота' });
    assert.equal(created, 0);
  }
  assert.throws(() => createClientBotRegistry({ configs: [first], reservedTokens: ['100:synapse'] }), /Повторная/);
  assert.throws(() => createClientBotRegistry({ configs: [{ ...first, botKey: '../one' }] }), /Неполная/);
});

test('пустой реестр выключен; запуск и остановка каждого моста выполняются один раз', () => {
  const events = [];
  const registry = createClientBotRegistry({ configs: [first, second], createBridge: config => ({
    start() { events.push(`start:${config.botKey}`); }, stop() { events.push(`stop:${config.botKey}`); },
  }) });
  assert.equal(registry.get('constructor'), undefined);
  registry.start(); registry.start(); registry.stop(); registry.stop();
  assert.deepEqual(events, ['start:one', 'start:two', 'stop:one', 'stop:two']);
  const empty = createClientBotRegistry({ createBridge() { throw Error('не должен создаваться'); } });
  empty.start(); empty.stop(); assert.equal(empty.get('one'), undefined);
});

test('ошибка запуска останавливает уже затронутые мосты', () => {
  const stopped = [];
  const registry = createClientBotRegistry({ configs: [first, second], createBridge: config => ({
    start() { if (config.botKey === 'two') throw Error('start failed'); },
    stop() { stopped.push(config.botKey); },
  }) });
  assert.throws(() => registry.start(), /start failed/);
  assert.deepEqual(stopped, ['one', 'two']);
});

test('два настоящих моста сохраняют одинаковые update_id и независимые отметки опроса', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const registry = createClientBotRegistry({ configs: [first, second].map(config => ({
      ...config, db, contentUrl: 'http://content:8080', apiKey: 'test',
      fetchImpl() { throw Error('сеть не нужна'); },
    })) });
    const one = registry.get('one'); const two = registry.get('two');
    const update = { update_id: 15, message: { message_id: 10, chat: { id: 999, type: 'private' },
      from: { id: 999, is_bot: false }, text: 'Здравствуйте' } };
    assert.equal(one.enqueue(update), true); assert.equal(two.enqueue(update), true);
    assert.equal(one.enqueue(update), true); // Повтор подтверждается без второй записи.
    one.saveOffset(16); two.saveOffset(80);
    assert.equal(one.getOffset(), 16); assert.equal(two.getOffset(), 80);
    assert.equal(db.prepare('SELECT count(*) AS n FROM client_bot_inbox').get().n, 2);
  } finally { db.close(); }
});
