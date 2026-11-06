'use strict';
// Уведомление о cookie (z-index 100, fixed, снизу) перекрывало плавающую кнопку записи:
// клик попадал в уведомление, цель booking_click не отправлялась. Пока уведомление
// видно, кнопка должна стоять выше него.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('плавающая кнопка записи поднимается над видимым уведомлением о cookie', () => {
  const rules = html.match(/body:has\(\.cookie-notice:not\(\.hidden\)\)>#cta\{[^}]*bottom:[^}]*\}/g) || [];
  assert.strictEqual(rules.length, 2, 'нужны правила для десктопа и для узкого экрана');
});
