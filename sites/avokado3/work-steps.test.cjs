const assert = require('node:assert/strict');
const { frameAt } = require('./method-reveal.js');
const { framesAt } = require('./work-steps.js');
const sequence = { target: 5, count: 4, unitSpan: 1.15 };
const legacy = x => frameAt(x, 1000, 6, 3, 6);
const extended = x => frameAt(x, 1000, 6, 3, 6, sequence);

// The old objections and review scenes must preserve their original scroll positions.
for (let x = -500; x < 9000; x += 41) {
  const before = legacy(x), after = extended(x);
  assert.equal(after.index, before.index);
  assert.equal(after.phase, before.phase);
  assert.deepEqual(after.reveals, before.reveals);
}
assert.equal(extended(0).totalUnits, 13.6);
for (let step = 0; step < 4; step++) {
  const x = 9000 + (step + .5) * 1150;
  const frame = extended(x);
  assert.equal(frame.index, 5);
  const pairs = framesAt(frame.workPhase, 4, false);
  assert.equal(pairs[step].opacity, 1, 'reading interval is fully visible');
  assert.equal(pairs.filter(pair => pair.active).length, 1);
  assert(pairs.every((pair, i) => i === step || pair.opacity === 0));
}
// Reversing or repeating the scroll position must reproduce the same pair state.
const early = framesAt(1.46, 4, false);
framesAt(3.7, 4, false);
assert.deepEqual(framesAt(1.46, 4, false), early);
for (let phase = 0; phase <= 4; phase += .013) {
  const pairs = framesAt(phase, 4, false);
  assert.equal(pairs.filter(pair => pair.active).length, 1);
  assert(pairs.every(pair => pair.opacity >= 0 && pair.opacity <= 1));
  assert(pairs.reduce((sum, pair) => sum + pair.opacity, 0) > 0, 'no entirely empty transition');
  const reduced = framesAt(phase, 4, true);
  assert.equal(reduced.filter(pair => pair.opacity === 1).length, 1);
  assert(reduced.every(pair => pair.y === 0 && pair.scale === 1));
}
assert.equal(framesAt(extended(1e8).workPhase, 4, false)[3].opacity, 1, 'last pair stays visible until price');
console.log('PASS: earlier scene timing, four reading holds, synchronized pair states, reverse/idle, nonempty transitions, reduced motion and final hold');
