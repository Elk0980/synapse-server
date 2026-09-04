'use strict';

const { isPasswordHash } = require('./passwords');

const COMPANIES = Object.freeze({
  'synapse-business': { name: 'Synapse Бизнес', contentSiteId: null },
  taisabai: { name: 'ТайСабай', contentSiteId: null },
  'novyi-etap': { name: 'НовыйЭтап', contentSiteId: null },
  alvi: { name: 'Алви', contentSiteId: 'alvi' },
  avokado: { name: 'Авокадо', contentSiteId: 'avokado' },
  'palitra-love': { name: 'Палитра лав', contentSiteId: 'palitra' },
});
const PERMISSIONS = Object.freeze([
  'analytics.view', 'crm.view', 'crm.edit', 'sites.view', 'sites.create', 'sites.delete',
  'site_editor.view', 'site_editor.edit', 'price.view', 'price.edit', 'chat.view', 'chat.reply',
  'settings.view', 'settings.edit', 'account.view',
]);
const DEPENDENCIES = Object.freeze({
  'crm.edit': ['crm.view'],
  'sites.create': ['sites.view', 'site_editor.view', 'site_editor.edit'],
  'sites.delete': ['sites.view'],
  'site_editor.edit': ['site_editor.view'],
  'price.edit': ['price.view'],
  'chat.reply': ['chat.view'],
  'settings.edit': ['settings.view'],
});
const TATYANA_PERMISSIONS = ['sites.view', 'site_editor.view', 'site_editor.edit', 'price.view', 'price.edit'];

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function now() {
  return new Date().toISOString();
}

function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function createAuthStore(db, authUsers = '') {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS auth_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','editor')),
      password_hash TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_user_companies (
      user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      company_code TEXT NOT NULL,
      PRIMARY KEY (user_id, company_code)
    );
    CREATE TABLE IF NOT EXISTS auth_user_permissions (
      user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      PRIMARY KEY (user_id, permission)
    );
    CREATE TABLE IF NOT EXISTS auth_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER NOT NULL,
      target_user_id INTEGER,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  if (!db.prepare("SELECT value FROM auth_meta WHERE key = 'auth_users_imported_v1'").get()) {
    transaction(db, () => {
      const entries = String(authUsers).split(';').filter(Boolean).map((item) => {
        const [login, role, ...hashParts] = item.split(':');
        return { login, role, passwordHash: hashParts.join(':') };
      });
      if (!entries.length || !entries.some((entry) => entry.role === 'owner')) {
        fail(500, 'Первичный импорт аккаунтов требует хотя бы одного владельца');
      }
      const insert = db.prepare(`
        INSERT INTO auth_users (login, display_name, role, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        if (!/^[a-z0-9_-]{1,64}$/.test(entry.login || '') ||
            !['owner', 'editor'].includes(entry.role) || !isPasswordHash(entry.passwordHash)) {
          fail(500, 'Первичный импорт аккаунтов содержит некорректную запись');
        }
        const stamp = now();
        const displayName = entry.login === 'tatyana' ? 'Татьяна' : entry.login;
        const result = insert.run(entry.login, displayName, entry.role, entry.passwordHash, stamp, stamp);
        const userId = Number(result.lastInsertRowid);
        if (entry.login === 'tatyana') {
          for (const code of ['alvi', 'avokado']) {
            db.prepare('INSERT INTO auth_user_companies VALUES (?, ?)').run(userId, code);
          }
          for (const permission of TATYANA_PERMISSIONS) {
            db.prepare('INSERT INTO auth_user_permissions VALUES (?, ?)').run(userId, permission);
          }
        }
      }
      db.prepare("INSERT INTO auth_meta VALUES ('auth_users_imported_v1', ?)").run(now());
    });
  }

  const getUser = (id) => db.prepare('SELECT * FROM auth_users WHERE id = ?').get(id);
  const decorate = (row) => {
    if (!row) return null;
    const owner = row.role === 'owner';
    const companyCodes = owner
      ? Object.keys(COMPANIES)
      : db.prepare('SELECT company_code FROM auth_user_companies WHERE user_id = ? ORDER BY company_code')
        .all(row.id).map((item) => item.company_code);
    const permissions = owner
      ? [...PERMISSIONS]
      : db.prepare('SELECT permission FROM auth_user_permissions WHERE user_id = ? ORDER BY permission')
        .all(row.id).map((item) => item.permission);
    return {
      id: row.id,
      login: row.login,
      displayName: row.display_name,
      role: row.role,
      passwordHash: row.password_hash,
      sessionVersion: row.session_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      companyCodes,
      companies: companyCodes.map((code) => ({ id: code, ...COMPANIES[code] })),
      permissions,
    };
  };
  const audit = (actorId, targetId, action, details = {}) => {
    db.prepare(`INSERT INTO auth_audit (actor_user_id, target_user_id, action, details_json, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(actorId, targetId || null, action, JSON.stringify(details), now());
  };
  const validateAccess = (companies, permissions) => {
    if (!Array.isArray(companies) || !Array.isArray(permissions) ||
        new Set(companies).size !== companies.length || new Set(permissions).size !== permissions.length) {
      fail(400, 'Компании и права должны быть списками без повторов');
    }
    if (companies.some((code) => !COMPANIES[code])) fail(400, 'Неизвестная компания');
    if (permissions.some((code) => !PERMISSIONS.includes(code))) fail(400, 'Неизвестное право');
    for (const [permission, dependencies] of Object.entries(DEPENDENCIES)) {
      if (permissions.includes(permission) && dependencies.some((item) => !permissions.includes(item))) {
        fail(400, `Право ${permission} требует: ${dependencies.join(', ')}`);
      }
    }
  };
  return {
    db,
    getById(id) { return decorate(getUser(id)); },
    getByLogin(login) {
      return decorate(db.prepare('SELECT * FROM auth_users WHERE login = ? COLLATE NOCASE').get(login));
    },
    list() { return db.prepare('SELECT * FROM auth_users ORDER BY login').all().map(decorate); },
    public(user) {
      const { passwordHash, sessionVersion, companyCodes, ...safe } = user;
      return safe;
    },
    create(actorId, input, passwordHash) {
      const keys = Object.keys(input).sort().join(',');
      if (keys !== 'displayName,login,password') fail(400, 'Переданы лишние или отсутствуют обязательные поля');
      if (typeof input.login === 'string' && this.getByLogin(input.login)) fail(409, 'Этот login уже занят');
      if (!/^[a-z0-9_-]{1,64}$/.test(input.login)) fail(400, 'Некорректный login');
      if (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 120) {
        fail(400, 'Некорректное имя');
      }
      try {
        return transaction(db, () => {
          const stamp = now();
          const result = db.prepare(`INSERT INTO auth_users
            (login, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, 'editor', ?, ?, ?)`)
            .run(input.login, input.displayName.trim(), passwordHash, stamp, stamp);
          const id = Number(result.lastInsertRowid);
          audit(actorId, id, 'ACCOUNT_CREATED', { login: input.login });
          return decorate(getUser(id));
        });
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) fail(409, 'Этот login уже занят');
        throw error;
      }
    },
    updateProfile(actorId, id, input) {
      if (Object.keys(input).sort().join(',') !== 'displayName,login') fail(400, 'Переданы лишние поля');
      const current = decorate(getUser(id));
      if (!current) fail(404, 'Пользователь не найден');
      if (current.role === 'owner') fail(400, 'Учётную запись владельца нельзя изменять здесь');
      if (!/^[a-z0-9_-]{1,64}$/.test(input.login)) fail(400, 'Некорректный login');
      if (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 120) {
        fail(400, 'Некорректное имя');
      }
      try {
        return transaction(db, () => {
          const loginChanged = current.login !== input.login;
          db.prepare(`UPDATE auth_users SET login=?, display_name=?, updated_at=?,
            session_version=session_version + ? WHERE id=?`)
            .run(input.login, input.displayName.trim(), now(), loginChanged ? 1 : 0, id);
          if (loginChanged) audit(actorId, id, 'LOGIN_CHANGED', { login: input.login });
          if (current.displayName !== input.displayName.trim()) {
            audit(actorId, id, 'DISPLAY_NAME_CHANGED');
          }
          return decorate(getUser(id));
        });
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) fail(409, 'Этот login уже занят');
        throw error;
      }
    },
    updatePassword(actorId, id, passwordHash) {
      const current = decorate(getUser(id));
      if (!current) fail(404, 'Пользователь не найден');
      if (current.role === 'owner' && actorId !== id) fail(400, 'Пароль другого владельца нельзя менять');
      db.prepare(`UPDATE auth_users SET password_hash=?, session_version=session_version+1, updated_at=? WHERE id=?`)
        .run(passwordHash, now(), id);
      audit(actorId, id, 'PASSWORD_CHANGED');
      return decorate(getUser(id));
    },
    updateAccess(actorId, id, companies, permissions) {
      validateAccess(companies, permissions);
      const current = decorate(getUser(id));
      if (!current) fail(404, 'Пользователь не найден');
      if (current.role === 'owner') fail(400, 'Доступ владельца нельзя уменьшить');
      return transaction(db, () => {
        db.prepare('DELETE FROM auth_user_companies WHERE user_id=?').run(id);
        db.prepare('DELETE FROM auth_user_permissions WHERE user_id=?').run(id);
        for (const code of companies) db.prepare('INSERT INTO auth_user_companies VALUES (?,?)').run(id, code);
        for (const permission of permissions) {
          db.prepare('INSERT INTO auth_user_permissions VALUES (?,?)').run(id, permission);
        }
        db.prepare('UPDATE auth_users SET updated_at=? WHERE id=?').run(now(), id);
        audit(actorId, id, 'ACCESS_CHANGED', { companies, permissions });
        return decorate(getUser(id));
      });
    },
    audit,
  };
}

module.exports = { COMPANIES, DEPENDENCIES, PERMISSIONS, TATYANA_PERMISSIONS, createAuthStore, transaction };
