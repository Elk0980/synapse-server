#!/usr/bin/env node
'use strict';

const { hashPassword } = require('./passwords');

const [login, role] = process.argv.slice(2);
if (!/^[a-z0-9_-]+$/.test(login || '') || !['owner', 'editor'].includes(role)) {
  console.error('Использование: node ops/content/make-password.js <login> <owner|editor>');
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error('Пароль нужно вводить в терминале (TTY).');
  process.exit(1);
}

process.stderr.write('Пароль: ');
process.stdin.setRawMode(true);
process.stdin.resume();
let password = '';
process.stdin.on('data', (chunk) => {
  for (const value of chunk.toString()) {
    if (value === '\u0003') process.exit(130);
    if (value !== '\r' && value !== '\n') {
      if (value === '\u007f') password = password.slice(0, -1);
      else password += value;
      continue;
    }
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write('\n');
    try {
      console.log(`${login}:${role}:${hashPassword(password)}`);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    return;
  }
});
