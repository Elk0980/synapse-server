'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '../../..');
const html = fs.readFileSync(path.join(repo, 'sites/alvi/index.html'), 'utf8');
const script = fs.readFileSync(path.join(repo, 'sites/alvi/callback.js'), 'utf8');
const caddy = fs.readFileSync(path.join(repo, 'caddy/Caddyfile'), 'utf8');

test('booking FAQ exposes Telegram, MAX and telephone links', () => {
  const answer = html.match(/<summary[^>]*>Как записаться\?<\/summary>\s*<p[^>]*>([\s\S]*?)<\/p>/)?.[1] || '';
  assert.match(answer, /href="https:\/\/t\.me\/\+79246180555"/);
  assert.match(answer, /href="https:\/\/max\.ru\/u\/f9LHodD0/);
  assert.match(answer, /href="tel:\+79246180555"/);
  assert.match(answer, /ежедневно 09:00–22:00 по предварительной записи/);
});

test('callback form requires consent and posts a company-scoped CRM lead', () => {
  assert.match(html, /id="callback-form"[\s\S]*?name="consent" type="checkbox" required/);
  assert.match(html, /<button type="submit" disabled>Перезвоните мне<\/button>/);
  assert.match(html, /href="politika\.html"/);
  assert.match(script, /validPhone\(phone\.value\)/);
  assert.match(script, /fetch\('\/api\/leads'/);
  assert.match(script, /companyCode: 'alvi'/);
  assert.match(script, /classList\.add\('is-success'\)/);
  assert.match(caddy, /path \/api\/leads[\s\S]*?rewrite \* \/leads[\s\S]*?reverse_proxy crm:8080/);
});

test('390px layout stacks full-width fields with a 48px button', () => {
  assert.match(html, /@media \(max-width: 600px\)[\s\S]*?\.callback-form__fields \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(html, /\.callback-form__fields button \{ width: 100%; height: 48px; \}/);
});
