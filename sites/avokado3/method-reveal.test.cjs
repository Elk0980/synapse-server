const assert = require('node:assert/strict');
const { frameAt, panAt } = require('./method-reveal.js');
const frame = offset => frameAt(offset, 1000, 6, 3, 6);
assert.equal(frame(-500).index, 0);
for (const [x, expected] of [[0,0],[999,0],[1000,1],[2000,2],[3000,3],[7999,3],[8000,4],[9000,5],[1e8,5]]) assert.equal(frame(x).index,expected);
const offsetForPhase = phase => 3000 + phase / 1.36 * 1000;
for(let i=0;i<6;i++){
 const f=frame(offsetForPhase(i+.7));
 assert.equal(f.index,3);
 assert.equal(f.reveals.filter(p=>p===1).length,i+1);
 assert(f.reveals.slice(i+1).every(p=>p===0));
}
assert(frame(offsetForPhase(6.6)).reveals.every(p=>p===1),'reading hold before next slide');
const backwards=frame(offsetForPhase(2.7));
assert.deepEqual(backwards.reveals,[1,1,1,0,0,0]);
assert.deepEqual(frame(offsetForPhase(3.4)),frame(offsetForPhase(3.4)),'no time-dependent progress');
let last=Array(6).fill(0);
for(let x=3000;x<=7999;x+=13){const f=frame(x);f.reveals.forEach((p,i)=>{assert(p>=last[i]&&p>=0&&p<=1);if(i>0&&p>0)assert.equal(f.reveals[i-1],1)});last=f.reveals;}
const bottoms=[160,250,350,470,590,720];
assert.equal(panAt(frame(offsetForPhase(1.8)),bottoms,450,750),0);
assert.equal(panAt(frame(offsetForPhase(5.8)),bottoms,450,750),280);
assert.equal(panAt(frame(offsetForPhase(5.8)),bottoms,850,750),0);
assert(panAt(frame(offsetForPhase(5.2)),bottoms,450,750)<280);
console.log('PASS: slide timing, all six cumulative phases, reverse scroll, idle stability, final hold, short-screen pan');
