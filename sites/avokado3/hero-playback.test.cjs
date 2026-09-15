const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname + '/hero-playback.js', 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(plans = []) {
  const doc = new EventTarget(); doc.hidden = false;
  const video = new EventTarget();
  let count = 0, allowed = true;
  Object.assign(video, {ownerDocument:doc, paused:true, play() {
    count++;
    if (plans.length) return plans.shift()();
    video.paused=false;
    video.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }});
  const button = {hidden:true}, root = {};
  vm.runInNewContext(source, {window:root, Promise});
  const controller = root.AvokadoHeroPlayback.create(video, button, () => allowed, () => {});
  return {doc,video,button,controller,count:()=>count,disable:()=>{allowed=false}};
}
test('starts immediately, muted and inline; successful autoplay keeps the prompt hidden', async()=>{
  const f=fixture(); f.controller.play();
  assert.equal(f.count(),1); await flush();
  assert.equal(f.video.muted,true); assert.equal(f.video.playsInline,true);
  assert.equal(f.button.hidden,true);
});
test('denied autoplay exposes the prompt and a real gesture retries synchronously', async()=>{
  const f=fixture([()=>Promise.reject({name:'NotAllowedError'})]);
  f.controller.play(); await flush();
  assert.equal(f.button.hidden,false);
  for(let i=0;i<5;i++) f.controller.play();
  assert.equal(f.count(),1);
  f.doc.dispatchEvent(new Event('touchend'));
  assert.equal(f.count(),2); await flush(); assert.equal(f.button.hidden,true);
});
test('pending attempts do not duplicate; late rejection after cancellation cannot show prompt', async()=>{
  let reject; const f=fixture([()=>new Promise((_,no)=>{reject=no})]);
  f.controller.play(); f.doc.dispatchEvent(new Event('click'));
  assert.equal(f.count(),1); f.controller.cancel(); reject({name:'NotAllowedError'});
  await flush(); assert.equal(f.button.hidden,true);
});
test('gestures do not start reduced-motion/editor or hidden-page playback',()=>{
  const f=fixture(); f.disable(); f.doc.dispatchEvent(new Event('click'));
  assert.equal(f.count(),0);
  const hidden=fixture(); hidden.doc.hidden=true; hidden.controller.play();
  hidden.doc.dispatchEvent(new Event('touchend')); assert.equal(hidden.count(),0);
});
test('returning to a blocked page restores the prompt without a retry loop', async()=>{
  const f=fixture([()=>Promise.reject({name:'NotAllowedError'})]);
  f.controller.play(); await flush();
  f.doc.hidden=true; f.controller.cancel(); assert.equal(f.button.hidden,true);
  f.doc.hidden=false; f.controller.play(); assert.equal(f.button.hidden,false);
  assert.equal(f.count(),1);
});
