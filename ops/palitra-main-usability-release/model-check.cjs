'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const model = require('./payload/content/palitra-photo-model.js');
const html = fs.readFileSync(process.argv[2], 'utf8');
let checks = 0;
const check = fn => { fn(); checks++; };
const modern = ['/catalog?max=5000', '/catalog?min=5000&amp;max=8000', '/catalog?min=8000'];
const legacy = ['/catalog?max=5000', '/catalog?min=5000.01&amp;max=8000', '/catalog?min=8000.01'];
const replace = (source, from, to) => { assert.ok(source.includes(`href="${from}"`)); return source.replace(`href="${from}"`, `href="${to}"`); };
const old = replace(replace(html, modern[1], legacy[1]), modern[2], legacy[2]);
check(() => assert.equal(model.parseSlots(html).budget.length, 3));
check(() => assert.equal(model.parseSlots(old).budget.length, 3));
for (const rejected of [
  replace(html, modern[1], '/catalog?min=1234&amp;max=8000'),
  replace(html, modern[1], legacy[1]),
  replace(html, modern[2], legacy[2]),
  replace(html, modern[2], modern[1]),
]) check(() => assert.throws(() => model.parseSlots(rejected), model.PhotoModelError));
const doc = model._internal.parseDocument(html);
const card = doc.budget[1];
const result = model.applyOperations(html, [{ type: 'budget.photo', index: 1,
  url: doc.budget[0].src, alt: card.alt, width: card.width, height: card.height }], model.TARGET);
check(() => {
  assert.equal(result.patches.length, 1);
  assert.equal(result.patches[0].slot, 'budget:1');
  assert.equal(result.html.slice(0, card.start), html.slice(0, card.start));
  assert.equal(result.html.slice(card.start + result.patches[0].length), html.slice(card.end));
});
check(() => {
  const after = model._internal.parseDocument(result.html);
  assert.deepEqual(after.budget.map(({ href, ariaLabel, label }) => ({ href, ariaLabel, label })),
    doc.budget.map(({ href, ariaLabel, label }) => ({ href, ariaLabel, label })));
});
console.log(JSON.stringify({ status: 'PASS', checks, actualModernFixture: true,
  legacyAccepted: true, mixedAndArbitraryRejected: true, imageOnlyBytesPreserved: true }));
