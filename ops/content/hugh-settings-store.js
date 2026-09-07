'use strict';

const ROLES = Object.freeze(['owner', 'client', 'visitor']);
const SOURCES = Object.freeze(['subscription', 'claude_api', 'gpt_api']);
const DEFAULT_SETTINGS = Object.freeze(Object.fromEntries(ROLES.map((role) => [role, 'subscription'])));

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function validate(settings) {
  if (!settings || Array.isArray(settings) || typeof settings !== 'object' ||
      Object.keys(settings).sort().join(',') !== [...ROLES].sort().join(',')) {
    fail(400, 'Нужно указать источник для каждой роли Хью');
  }
  for (const role of ROLES) {
    if (!SOURCES.includes(settings[role])) fail(400, `Неизвестный источник для роли ${role}`);
  }
  return Object.fromEntries(ROLES.map((role) => [role, settings[role]]));
}

function createHughSettingsStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hugh_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      settings_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by INTEGER
    );
  `);
  const get = () => {
    const row = db.prepare('SELECT settings_json, updated_at FROM hugh_settings WHERE singleton = 1').get();
    return row ? { settings: JSON.parse(row.settings_json), updatedAt: row.updated_at }
      : { settings: { ...DEFAULT_SETTINGS }, updatedAt: null };
  };
  return {
    get,
    save(settings, userId) {
      const clean = validate(settings);
      const updatedAt = new Date().toISOString();
      db.prepare(`INSERT INTO hugh_settings (singleton, settings_json, updated_at, updated_by)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET settings_json=excluded.settings_json,
          updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
        .run(JSON.stringify(clean), updatedAt, userId);
      return { settings: clean, updatedAt };
    },
  };
}

module.exports = { createHughSettingsStore, DEFAULT_SETTINGS, ROLES, SOURCES };
