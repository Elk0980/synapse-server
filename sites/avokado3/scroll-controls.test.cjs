const test=require('node:test'),assert=require('node:assert/strict');
const {start}=require('./scroll-controls.js');
function setup(isMobile=true,{intersectionObserver=true,initialSection}={}){
 const events={},timers=new Map(),classes=new Set();let clock=5000,id=0;
 const media={matches:isMobile,addEventListener(_,fn){this.change=fn;}};
 const panelEvents={};
 const panel={classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)},contains:element=>element===panel||Boolean(element?.inPanel),addEventListener:(name,fn)=>panelEvents[name]=fn,emit:name=>panelEvents[name]?.()};
 const top={setAttribute(){},focus(){this.focused=true;}};
 const sections=Object.fromEntries(['price','contacts'].map(id=>[id,{id,bounds:initialSection===id?{top:100,bottom:900}:{top:900,bottom:1300},getBoundingClientRect(){return this.bounds;}}]));
 const doc={activeElement:null,scrollingElement:{scrollHeight:5000},querySelector(){return this.modal?{}:null;},getElementById:id=>({cta:panel,top,...sections}[id])||null};
 const win={scrollY:0,innerHeight:800,matchMedia:()=>media,performance:{now:()=>clock},location:{pathname:'/index.html',search:'?v=release',hash:'#contacts'},history:{state:{keep:1},replaceState(state,_,url){this.updated={state,url};}},addEventListener:(name,fn)=>events[name]=fn,clearTimeout:n=>timers.delete(n),setTimeout:(fn,ms)=>{timers.set(++id,{fn,time:clock+ms});return id;},scrollTo(pos){this.scrollY=pos.top;this.calls=(this.calls||0)+1;}};
 let observer;
 if(intersectionObserver)win.IntersectionObserver=class{
  constructor(callback,options){this.callback=callback;this.options=options;this.observed=[];observer=this;}
  observe(section){this.observed.push(section);}
 };
 const emit=(type,extra={})=>{const e={type,cancelable:type!=='touchend',target:{closest:()=>null},preventDefault(){this.prevented=true;},...extra};events[type](e);return e;};
 const advance=ms=>{clock+=ms;for(const [n,t]of timers)if(t.time<=clock){timers.delete(n);t.fn();}};
 const intersect=(id,visible)=>{
  const section=sections[id];section.bounds=visible?{top:100,bottom:900}:{top:900,bottom:1300};
  observer?.callback([{target:section,isIntersecting:visible}]);
 };
 start(win,doc);return {win,doc,classes,emit,advance,media,top,panel,sections,observer,intersect};
}
test('phone and desktop actions hide throughout movement and return 220ms after the last movement',()=>{
 const s=setup();s.win.scrollY=100;s.emit('scroll');assert.ok(s.classes.has('is-scrolling'));
 s.advance(150);s.win.scrollY=200;s.emit('scroll');s.advance(219);assert.ok(s.classes.has('is-scrolling'));
 s.advance(1);assert.ok(!s.classes.has('is-scrolling'));
 s.win.scrollY=300;s.emit('scroll');s.media.matches=false;s.media.change();assert.ok(!s.classes.has('is-scrolling'));
 s.win.scrollY=400;s.emit('scroll');assert.ok(s.classes.has('is-scrolling'));s.advance(220);assert.ok(!s.classes.has('is-scrolling'));
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

test('mobile hides floating actions while catalog or contacts is visible and restores them after both leave',()=>{
 const s=setup();assert.deepEqual(s.observer.observed,[s.sections.price,s.sections.contacts]);
 assert.equal(s.classes.has('content-actions-visible'),false);
 s.classes.add('on');s.classes.add('finale-hidden');
 s.intersect('price',true);assert.equal(s.classes.has('content-actions-visible'),true);
 s.intersect('contacts',true);s.intersect('price',false);assert.equal(s.classes.has('content-actions-visible'),true);
 s.intersect('contacts',false);assert.equal(s.classes.has('content-actions-visible'),false);
 assert.equal(s.classes.has('on'),true);assert.equal(s.classes.has('finale-hidden'),true);
 s.observer.callback([{target:{id:'method'},isIntersecting:true}]);
 assert.equal(s.classes.has('content-actions-visible'),false,'unrelated sections never suppress floating actions');
});

test('media changes use current section geometry, and desktop keeps floating actions available',()=>{
 const s=setup(true,{initialSection:'price'});assert.equal(s.classes.has('content-actions-visible'),true);
 s.media.matches=false;s.media.change();assert.equal(s.classes.has('content-actions-visible'),false);
 s.intersect('contacts',true);assert.equal(s.classes.has('content-actions-visible'),false);
 s.sections.price.bounds={top:900,bottom:1300};s.sections.contacts.bounds={top:900,bottom:1300};
 s.media.matches=true;s.media.change();assert.equal(s.classes.has('content-actions-visible'),false,'stale observer records must not hide actions after resize');
 s.sections.contacts.bounds={top:100,bottom:900};s.media.change();assert.equal(s.classes.has('content-actions-visible'),true);
});

test('focus inside floating actions prevents hiding until focus moves outside the panel',()=>{
 const s=setup();s.doc.activeElement={inPanel:true,matches:()=>true};s.panel.emit('focusin');
 s.intersect('price',true);assert.equal(s.classes.has('content-actions-visible'),false);
 s.doc.activeElement={inPanel:true,matches:()=>true};s.panel.emit('focusout');s.advance(0);
 assert.equal(s.classes.has('content-actions-visible'),false,'tabbing to another CTA link must not hide it');
 s.panel.emit('focusout');s.doc.activeElement=null;s.advance(0);
 assert.equal(s.classes.has('content-actions-visible'),true);
 s.doc.activeElement={inPanel:true,matches:()=>true};s.panel.emit('focusin');
 assert.equal(s.classes.has('content-actions-visible'),false);
});

test('without IntersectionObserver scroll and resize detect visible actions and preserve the page loop',()=>{
 const s=setup(true,{intersectionObserver:false});assert.equal(s.classes.has('content-actions-visible'),false);
 s.sections.price.bounds={top:799,bottom:1100};s.emit('scroll');assert.equal(s.classes.has('content-actions-visible'),true);
 s.sections.price.bounds={top:-500,bottom:0};s.emit('scroll');assert.equal(s.classes.has('content-actions-visible'),false);
 s.sections.contacts.bounds={top:850,bottom:1300};s.win.innerHeight=900;s.emit('resize');
 assert.equal(s.classes.has('content-actions-visible'),true);
 s.media.matches=false;s.media.change();assert.equal(s.classes.has('content-actions-visible'),false);
 s.win.innerHeight=800;s.win.scrollY=4200;s.emit('scroll');s.advance(1000);
 const e=s.emit('wheel',{deltaY:60});assert.ok(e.prevented);assert.equal(s.win.scrollY,0);assert.equal(s.win.calls,1);
});
