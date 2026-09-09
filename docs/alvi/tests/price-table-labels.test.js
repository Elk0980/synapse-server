'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../../sites/alvi');
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/price.json'), 'utf8'));
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'price-render.js'), 'utf8'), { window });

// Responsive row labels must preserve the different units used by each category.
for (const [name, html] of [
  ['hydrated API/local data', window.AlviPrice.renderSections(data)],
  ['HTML fallback', fs.readFileSync(path.join(root, 'price.html'), 'utf8')]
]) {
  test(`${name}: every table cell keeps its actual column meaning`, () => {
    const tables = [...html.matchAll(/<table\b[^>]*class="pt"[^>]*>([\s\S]*?)<\/table>/g)];
    assert.equal(tables.length, 4);
    const expected = [
      [20, 'Длительность', 'Цена'],
      [4, 'Длительность', 'Цена'],
      [7, 'Длительность', 'Для одного / для двоих'],
      [5, 'Стоимость минуты', 'Цена']
    ];
    tables.forEach((table, i) => {
      const rows = [...table[1].matchAll(/<tr\b[^>]*\bid="[^"]+"[^>]*>([\s\S]*?)<\/tr>/g)];
      assert.equal(rows.length, expected[i][0]);
      for (const row of rows) {
        const cells = [...row[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)];
        assert.equal(cells.length, 3);
        assert.ok(cells[1][1].includes(`data-label="${expected[i][1]}"`));
        assert.ok(cells[2][1].includes(`data-label="${expected[i][2]}"`));
      }
    });
  });
}
