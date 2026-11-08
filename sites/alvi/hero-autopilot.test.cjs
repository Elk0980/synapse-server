'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {stopsFrom}=require('./hero-autopilot.js');

function scene(start,end,breath){
  return {dataset:{rangeStart:String(start),rangeEnd:String(end)},classList:{contains:c=>Boolean(breath)&&c==='hero-scene--breath'}};
}

test('stops: opening, middle of each text scene, inside the final scene; breaths skipped',()=>{
  const stops=stopsFrom([scene(0,0.11),scene(0.11,0.22),scene(0.22,0.26,true),scene(0.26,0.37),scene(0.37,0.41,true),scene(0.41,0.52),scene(0.52,0.56,true),scene(0.56,1)]);
  assert.deepEqual(stops.map(s=>Math.round(s*1000)/1000),[0,0.165,0.315,0.465,0.595]);
});

test('index.html loads the autopilot after scroll controls',()=>{
  const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  const a=html.indexOf('scroll-controls.js'),b=html.indexOf('hero-autopilot.js');
  assert.ok(a>0&&b>a);
});
