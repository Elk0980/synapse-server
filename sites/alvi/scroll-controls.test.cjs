const test=require('node:test'),assert=require('node:assert/strict');
const {start}=require('./scroll-controls.js');
function setup(){
 const events={};let clock=5000;
 const hero={setAttribute(){},focus(){this.focused=true;}};
 const doc={activeElement:null,scrollingElement:{scrollHeight:5000},querySelector(selector){return this.modal&&selector.includes(this.modal)?{}:null;},getElementById:id=>id==='hero'?hero:null};
 const win={scrollY:0,innerHeight:800,performance:{now:()=>clock},location:{pathname:'/index.html',search:'?v=release',hash:'#contacts'},history:{state:{keep:1},replaceState(state,_,url){this.updated={state,url};}},addEventListener:(name,fn)=>events[name]=fn,scrollTo(pos){this.scrollY=pos.top;this.calls=(this.calls||0)+1;this.lastScroll=pos;}};
 const emit=(type,extra={})=>{const e={type,cancelable:type!=='touchend',target:{closest:()=>null},preventDefault(){this.prevented=true;},...extra};events[type](e);return e;};
 const advance=ms=>{clock+=ms;};
 const bottom=()=>{win.scrollY=4200;emit('scroll');};
 start(win,doc);return {win,doc,emit,advance,hero,bottom};
}
const point=(x,y)=>({touches:[{clientX:x,clientY:y}]});

test('arrival, a long footer visit and anchor navigation never loop without new downward input',()=>{
 const s=setup();s.bottom();s.advance(30000);s.emit('scroll');assert.equal(s.win.calls,undefined);
 s.emit('wheel',{deltaY:-60});s.advance(300);s.emit('wheel',{deltaY:20,deltaX:50});
 s.advance(300);s.emit('wheel',{deltaY:60,ctrlKey:true});assert.equal(s.win.calls,undefined);
 s.advance(300);const e=s.emit('wheel',{deltaY:60});
 assert.ok(e.prevented);assert.deepEqual(s.win.lastScroll,{top:0,left:0,behavior:'instant'});
 assert.deepEqual(s.win.history.updated,{state:{keep:1},url:'/index.html?v=release'});
});

test('trackpad momentum reaching the footer stays put until a fresh downward gesture',()=>{
 const s=setup();s.win.scrollY=4100;s.emit('wheel',{deltaY:60});s.bottom();
 for(let i=0;i<12;i++){s.advance(60);s.emit('wheel',{deltaY:10});}
 assert.equal(s.win.calls,undefined);s.advance(300);s.emit('wheel',{deltaY:60});assert.equal(s.win.calls,1);
});

test('an immediate second wheel event gives the footer time to appear and lock prevents repeated jumps',()=>{
 const s=setup();s.bottom();s.emit('wheel',{deltaY:60});assert.equal(s.win.calls,undefined);
 s.advance(350);s.emit('wheel',{deltaY:60});assert.equal(s.win.calls,1);
 s.bottom();s.advance(400);s.emit('wheel',{deltaY:60});assert.equal(s.win.calls,1);
 s.advance(900);s.emit('wheel',{deltaY:60});assert.equal(s.win.calls,2);
});

test('a touch gesture that arrives at the footer cannot loop; a subsequent upward swipe can',()=>{
 const s=setup();s.win.scrollY=4100;s.emit('touchstart',point(100,500));s.bottom();s.advance(500);
 s.emit('touchmove',point(100,400));s.emit('touchend');assert.equal(s.win.calls,undefined);
 s.emit('touchstart',point(100,500));s.emit('touchmove',point(100,440));assert.equal(s.win.calls,undefined);
 s.emit('touchend');assert.equal(s.win.calls,1);
});

test('touch taps, sideways/upward movement, multitouch and cancelled gestures do not loop',()=>{
 for(const gesture of ['tap','sideways','upward','multitouch','cancelled']){
  const s=setup();s.bottom();s.advance(500);s.emit('touchstart',point(100,500));
  if(gesture==='sideways')s.emit('touchmove',point(200,470));
  if(gesture==='upward')s.emit('touchmove',point(100,550));
  if(gesture==='multitouch')s.emit('touchmove',{touches:[{clientX:100,clientY:440},{clientX:120,clientY:440}]});
  if(gesture==='cancelled'){s.emit('touchmove',point(100,440));s.emit('touchcancel');}
  s.emit('touchend');assert.equal(s.win.calls,undefined,gesture);
 }
});

test('open native dialogs and the ALVI promo retain their own scroll behavior',()=>{
 for(const modal of ['dialog[open]','.promo.is-open']){
  const s=setup();s.bottom();s.advance(500);s.doc.modal=modal;
  const e=s.emit('wheel',{deltaY:60});assert.equal(s.win.calls,undefined);assert.ok(!e.prevented);
  s.doc.modal=null;s.advance(300);s.emit('wheel',{deltaY:60});assert.equal(s.win.calls,1);
 }
});

test('forms and editable fields are excluded through either the target or keyboard focus',()=>{
 for(const field of ['form','input','textarea','select','[contenteditable]']){
  for(const place of ['target','focus']){
   const s=setup();s.bottom();s.advance(500);
   const element={closest:selector=>selector.includes(field)?{}:null};
   if(place==='focus')s.doc.activeElement=element;
   const e=s.emit('wheel',{deltaY:60,...(place==='target'?{target:element}:{})});
   assert.equal(s.win.calls,undefined,field+' '+place);assert.ok(!e.prevented);
  }
 }
});

test('keyboard controls preserve footer interactions and held keys; a fresh PageDown returns focus to the hero',()=>{
 const s=setup();s.bottom();s.advance(500);
 for(const key of ['ArrowDown','PageDown',' ']){
  s.emit('keydown',{key,repeat:true});
  for(const tag of ['a','button','summary','[role="button"]','[role="link"]'])s.emit('keydown',{key,target:{closest:selector=>selector.split(',').includes(tag)?{}:null}});
  s.emit('keydown',{key,shiftKey:true});
 }
 assert.equal(s.win.calls,undefined);
 const e=s.emit('keydown',{key:'PageDown'});assert.equal(s.win.calls,1);assert.ok(e.prevented);assert.ok(s.hero.focused);
});

test('ordinary page scrolling, resized short pages and already-handled events are untouched',()=>{
 const s=setup();s.win.scrollY=2000;s.emit('scroll');s.advance(500);s.emit('wheel',{deltaY:60});assert.equal(s.win.calls,undefined);
 s.bottom();s.advance(500);s.emit('wheel',{deltaY:60,defaultPrevented:true});assert.equal(s.win.calls,undefined);
 s.doc.scrollingElement.scrollHeight=1500;s.win.scrollY=700;s.emit('resize');s.advance(500);
 s.emit('wheel',{deltaY:60});assert.equal(s.win.calls,undefined);
});
