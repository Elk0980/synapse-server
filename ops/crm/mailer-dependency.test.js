'use strict';
// Почтовая зависимость CRM закреплена точной версией не ниже проверенной.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIN = [10, 3, 1];
const parse = v => String(v).split('.').map(Number);
const atLeast = (v, min) => {
  for (let i = 0; i < min.length; i++) { if (v[i] !== min[i]) return v[i] > min[i]; }
  return true;
};

test('nodemailer pinned to an exact version not older than the reviewed one', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'package-lock.json'), 'utf8'));
  const wanted = pkg.dependencies.nodemailer;
  assert.match(wanted, /^\d+\.\d+\.\d+$/, 'точная версия без диапазона');
  assert.ok(atLeast(parse(wanted), MIN), `nodemailer ${wanted} старше ${MIN.join('.')}`);
  assert.equal(lock.packages[''].dependencies.nodemailer, wanted);
  assert.equal(lock.packages['node_modules/nodemailer'].version, wanted);
});
