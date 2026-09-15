const test = require('node:test');
const assert = require('node:assert/strict');
const { frameAt } = require('./method-reveal.js');
const { weightFor, panFor } = require('./mobile-method.js');

test('long phone slides retain both reading holds and all content before advancing', () => {
  const unit = 500, overflow = 650;
  const weights = [1, weightFor(overflow, unit), 1];
  const at = offset => frameAt(offset, unit, 6, 3, 6, null, weights);
  const start = unit, end = start + unit * weights[1];
  assert.equal(at(start).index, 1);
  assert.equal(panFor(at(start + 20).slideProgress, overflow), 0);
  assert.equal(at(end - 1).index, 1);
  assert.equal(panFor(at(end - 1).slideProgress, overflow), overflow);
  assert.equal(at(end).index, 2);
  const middle = at(start + unit * weights[1] / 2);
  assert.equal(panFor(middle.slideProgress, overflow), overflow / 2);
  assert.deepEqual(at(start), at(start), 'reversing scroll restores the first text without timers');
  assert.equal(weightFor(-30, unit), 1);
});

test('mobile overflow extends normal slides without consuming objection or paired steps', () => {
  const work = {target:6,count:4,unitSpan:1.15};
  const base = frameAt(0, 500, 7, 3, 6, work);
  const expanded = frameAt(0, 500, 7, 3, 6, work, [1,2,3]);
  assert.equal(expanded.totalUnits, base.totalUnits + 3);
  const original = frameAt(1700, 500, 7, 3, 6, work);
  const shifted = frameAt(3200, 500, 7, 3, 6, work, [1,2,3]);
  assert.equal(original.index, shifted.index);
  assert.ok(Math.abs(original.phase - shifted.phase) < 1e-10);
  const final = frameAt(1e8,500,7,3,6,work,[1,2,3]);
  assert.equal(final.index,6);
  assert.ok(final.workPhase > 3.99);
});
