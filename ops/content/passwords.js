'use strict';

const crypto = require('node:crypto');

const OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw Object.assign(new Error('Пароль должен содержать от 12 до 256 символов'), { status: 400 });
  }
  if (Buffer.byteLength(password, 'utf8') > 1024) {
    throw Object.assign(new Error('Пароль не должен превышать 1024 байта UTF-8'), { status: 400 });
  }
}

function isPasswordHash(value) {
  const match = /^scrypt\$16384\$8\$1\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(String(value));
  if (!match) return false;
  try {
    return Buffer.from(match[1], 'base64url').length === 16 && Buffer.from(match[2], 'base64url').length === 32;
  } catch {
    return false;
  }
}

function hashPassword(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, OPTIONS);
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || !isPasswordHash(encoded)) return false;
  const [, , , , salt, wanted] = encoded.split('$');
  try {
    const expected = Buffer.from(wanted, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, OPTIONS);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, isPasswordHash, validatePassword, verifyPassword };
