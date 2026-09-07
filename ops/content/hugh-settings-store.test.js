'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createHughSettingsStore, DEFAULT_SETTINGS } = require('./hugh-settings-store');

test('Hugh settings default to subscription and persist in SQLite', () => {
  const db = new DatabaseSync(':memory:');
  const store = createHughSettingsStore(db);
  assert.deepEqual(store.get(), { settings: DEFAULT_SETTINGS, updatedAt: null });
  const settings = { owner: 'claude_api', client: 'gpt_api', visitor: 'subscription' };
  const saved = store.save(settings, 42);
  assert.deepEqual(store.get(), saved);
  assert.equal(db.prepare('SELECT updated_by FROM hugh_settings').get().updated_by, 42);
});

test('Hugh settings reject missing roles, extra fields, and unknown sources', () => {
  const store = createHughSettingsStore(new DatabaseSync(':memory:'));
  for (const settings of [
    { owner: 'subscription', client: 'subscription' },
    { owner: 'subscription', client: 'subscription', visitor: 'subscription', extra: true },
    { owner: 'other', client: 'subscription', visitor: 'subscription' },
  ]) assert.throws(() => store.save(settings, 1), (error) => error.status === 400);
});
