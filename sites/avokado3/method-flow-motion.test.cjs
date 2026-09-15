const test = require('node:test');
const assert = require('node:assert/strict');
const {revealAt,workPlan} = require('./method-flow-motion.js');
test('paragraphs appear in reading order with scroll and reverse without timers',()=>{
  const tops=[250,440,640,840], bottom=620;
  assert.deepEqual(tops.map(top=>revealAt(top,160,bottom)),[1,1,0,0]);
  const next=tops.map(top=>revealAt(top-170,160,bottom));
  assert.equal(next[2],1);assert.equal(next[3],0);
  assert.deepEqual(tops.map(top=>revealAt(top,160,bottom)),[1,1,0,0]);
  assert.equal(revealAt(590,160,bottom),.3125);
});
test('scroll slider is enabled only when the full tallest card clears header and controls',()=>{
  assert.ok(workPlan(844,80,500,4,false).enabled);
  assert.ok(workPlan(575,90,360,4,false).enabled);
  assert.deepEqual(workPlan(575,90,600,4,false),{enabled:false,travel:0});
  assert.deepEqual(workPlan(844,80,500,4,true),{enabled:false,travel:0});
  assert.equal(workPlan(700,90,498,4,false).enabled,true);
  assert.equal(workPlan(700,90,499,4,false).enabled,false);
});
