const test=require('node:test'),assert=require('node:assert/strict');
const {start}=require('./scroll-controls.js');
function setup(isMobile=true){
 const events={},timers=new Map(),classes=new Set();let clock=5000,id=0;
 const media={matches:isMobile,addEventListener(_,fn){this.change=fn;}};
 const panel={classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},contains:()=>false};
 const top={setAttribute(){},focus(){this.focused=true;}};
 const doc={activeElement:null,scrollingElement:{scrollHeight:5000},querySelector(){return this.modal?{}:null;},getElementById:id=>id==='cta'?panel:top};
 const win={scrollY:0,innerHeight:800,matchMedia:()=>media,performance:{now:()=>clock},location:{pathname:'/index.html',search:'?v=release',hash:'#contacts'},history:{state:{keep:1},replaceState(state,_,url){this.updated={state,url};}},addEventListener:(name,fn)=>events[name]=fn,clearTimeout:n=>timers.delete(n),setTimeout:(fn,ms)=>{timers.set(++id,{fn,time:clock+ms});return id;},scrollTo(pos){this.scrollY=pos.top;this.calls=(this.calls||0)+1;}};
 const emit=(type,extra={})=>{const e={type,cancelable:type!=='touchend',target:{closest:()=>null},preventDefault(){this.prevented=true;},...extra};events[type](e);return e;};
 const advance=ms=>{clock+=ms;for(const [n,t]of timers)if(t.time<=clock){timers.delete(n);t.fn();}};
 start(win,doc);return {win,doc,classes,emit,advance,media,top};
}
test('mobile actions hide throughout movement and return 220ms after the last movement; desktop stays visible',()=>{
 const s=setup();s.win.scrollY=100;s.emit('scroll');assert.ok(s.classes.has('is-scrolling'));
 s.advance(150);s.win.scrollY=200;s.emit('scroll');s.advance(219);assert.ok(s.classes.has('is-scrolling'));
 s.advance(1);assert.ok(!s.classes.has('is-scrolling'));
 s.win.scrollY=300;s.emit('scroll');s.media.matches=false;s.media.change();assert.ok(!s.classes.has('is-scrolling'));
 s.win.scrollY=400;s.emit('scroll');assert.ok(!s.classes.has('is-scrolling'));
});
test('footer arrival and anchor navigation stay put; continued downward input starts the next lap',()=>{
 const s=setup();s.win.scrollY=4200;s.emit('scroll');s.advance(1000);assert.equal(s.win.calls,undefined);
 s.emit('wheel',{deltaY:-60});assert.equal(s.win.calls,undefined);
 s.emit('wheel',{deltaY:20,deltaX:50});assert.equal(s.win.calls,undefined);
 const e=s.emit('wheel',{deltaY:60});assert.ok(e.prevented);assert.equal(s.win.scrollY,0);
 assert.deepEqual(s.win.history.updated,{state:{keep:1},url:'/index.html?v=release'});
 s.win.scrollY=4200;s.emit('wheel',{deltaY:60});assert.equal(s.win.calls,1);
 s.advance(1201);s.emit('keydown',{key:'PageDown'});assert.equal(s.win.calls,2);assert.ok(s.top.focused);
});
test('touch continuation loops on release; dialogs, inputs and upward gestures keep their normal behavior',()=>{
 const s=setup();s.win.scrollY=4200;
 s.emit('touchstart',{touches:[{clientX:100,clientY:500}]});s.emit('touchmove',{touches:[{clientX:100,clientY:450}]});assert.equal(s.win.calls,undefined);s.emit('touchend');assert.equal(s.win.scrollY,0);
 s.advance(1300);s.win.scrollY=4200;s.doc.modal=true;s.emit('wheel',{deltaY:60});assert.equal(s.win.calls,1);
 s.doc.modal=false;s.emit('keydown',{key:' ',target:{closest:()=>({})}});assert.equal(s.win.calls,1);
 s.emit('touchstart',{touches:[{clientX:100,clientY:400}]});s.emit('touchmove',{touches:[{clientX:100,clientY:450}]});s.emit('touchend');assert.equal(s.win.calls,1);
});
