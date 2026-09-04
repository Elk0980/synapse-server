#!/usr/bin/env node
'use strict';

const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./passwords');

const login = process.argv[2];
if (!process.stdin.isTTY || !/^[a-z0-9_-]{1,64}$/.test(login || '') || process.argv.length !== 3) {
  console.error('Использование из TTY: node reset-password.js <login>');
  process.exit(1);
}
process.stderr.write('Новый пароль: ');
process.stdin.setRawMode(true);
process.stdin.resume();
let password = '';
process.stdin.on('data', (chunk) => {
  for (const value of chunk.toString()) {
    if (value === '\u0003') process.exit(130);
    if (value !== '\r' && value !== '\n') {
      password = value === '\u007f' ? password.slice(0, -1) : password + value;
      continue;
    }
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write('\n');
    try {
      const db = new DatabaseSync(process.env.DATABASE_PATH || '/data/content.sqlite');
      const result = db.prepare(`UPDATE auth_users SET password_hash=?, session_version=session_version+1,
        updated_at=? WHERE login=? COLLATE NOCASE`).run(hashPassword(password), new Date().toISOString(), login);
      if (!result.changes) throw new Error('Учётная запись не найдена');
      console.log('Пароль обновлён, старые сессии отозваны.');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    return;
  }
});
