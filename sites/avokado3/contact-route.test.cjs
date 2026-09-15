const test=require('node:test');
const assert=require('node:assert/strict');
const {isSocial,start,createNavigation}=require('./contact-route.js');
test('recognizes communication links without treating booking, maps or similar domains as social',()=>{
  for(const url of ['https://wa.me/79501001059','https://api.whatsapp.com/send?phone=79501001059','tg://resolve?domain=studio','https://vk.com/lasermkt','https://t.me/avocado_studio38','https://max.ru/u/example'])assert.ok(isSocial(url,'https://avokado3.synapsebusiness.ru/'));
  for(const url of ['https://n396010.yclients.com/company/375899/personal/menu','https://2gis.ru/irkutsk/firm/70000001045439507','https://wa.me.example.com/','tel:+79501001059','#contacts'])assert.ok(!isSocial(url,'https://avokado3.synapsebusiness.ru/'));
});

function navigationFixture({hash='#contacts',navigationType='navigate',sourceTop=1000,scrollY=0}={}){
  const events={},docEvents={},timers=new Map(),resizeObservers=[],mutationObservers=[],calls=[],history=[];
  let clock=0,id=0,top=sourceTop,fontDone;
  const add=(collection,type,fn)=>(collection[type]||=[]).push(fn);
  const emit=(collection,type,extra={})=>{const event={type,preventDefault(){this.defaultPrevented=true;},...extra};(collection[type]||[]).forEach(fn=>fn(event));return event;};
  const later=(fn,delay)=>{timers.set(++id,{fn,at:clock+delay});return id;};
  const win={
    location:new URL('https://avokado3.synapsebusiness.ru/index.html?utm_campaign=qa'+hash),
    scrollY,history:{state:{keep:'state'},pushState(state,_,url){history.push({state,url});win.location=new URL(url,win.location.href);}},
    performance:{getEntriesByType:()=>[{type:navigationType}]},
    getComputedStyle:()=>({scrollMarginTop:'60px'}),
    setTimeout:later,clearTimeout:n=>timers.delete(n),requestAnimationFrame:fn=>later(fn,16),cancelAnimationFrame:n=>timers.delete(n),
    addEventListener:(type,fn)=>add(events,type,fn),
  };
  function makeTarget(offset){
    const attrs=new Map();
    return {
      getBoundingClientRect:()=>({top:top+offset-win.scrollY}),
      scrollIntoView(options){calls.push({top:top+offset,options});win.scrollY=top+offset-60;},
      hasAttribute:name=>attrs.has(name),setAttribute:(name,value)=>attrs.set(name,value),
      closest:()=>null,
      focus(options){this.focused=options;doc.activeElement=this;emit(docEvents,'focusin',{target:this});},
    };
  }
  const target=makeTarget(0),callback=makeTarget(500);
  const body={},method={},price={};
  const doc={body,getElementById:name=>({contacts:target,callback}[name])||null,querySelectorAll:()=>[method,price,target,callback],
    addEventListener:(type,fn)=>add(docEvents,type,fn),
    fonts:{ready:new Promise(resolve=>{fontDone=resolve;}),addEventListener:(type,fn)=>add(docEvents,'fonts:'+type,fn)},
  };
  for(const [name,list]of [['ResizeObserver',resizeObservers],['MutationObserver',mutationObservers]])win[name]=class{
    constructor(fn){this.callback=fn;this.active=false;this.observed=[];list.push(this);}
    observe(element,options){this.active=true;this.observed.push({element,options});}
    disconnect(){this.active=false;}
  };
  const advance=ms=>{
    const end=clock+ms;
    while(true){
      const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)break;timers.delete(next[0]);clock=next[1].at;next[1].fn();
    }
    clock=end;
  };
  const controller=createNavigation(win,doc);
  return {win,doc,target,callback,calls,history,controller,advance,resizeObservers,mutationObservers,
    setTop:value=>{top=value;},fontDone,
    emit:(type,extra)=>emit(events,type,extra),emitDoc:(type,extra)=>emit(docEvents,type,extra),
    layout:()=>resizeObservers.forEach(observer=>{if(observer.active)observer.callback([]);}),
    hydrate:()=>mutationObservers.forEach(observer=>{if(observer.active)observer.callback([{type:'childList'}]);}),
  };
}

test('initial Contacts navigation follows the final catalogue, hydrated text, images and fonts',async()=>{
  const s=navigationFixture();s.advance(119);assert.equal(s.calls.length,0);
  s.setTop(4000);s.emitDoc('avokado:catalog-ready');s.layout();s.advance(151);assert.equal(s.calls.length,0);
  s.advance(1);assert.equal(s.win.scrollY,3940);
  s.setTop(4500);s.hydrate();s.advance(152);assert.equal(s.win.scrollY,4440);
  s.setTop(4800);s.emitDoc('load',{target:{tagName:'IMG'}});s.advance(152);assert.equal(s.win.scrollY,4740);
  s.setTop(5000);s.fontDone();await Promise.resolve();s.advance(152);assert.equal(s.win.scrollY,4940);
  assert.ok(s.calls.every(call=>call.options.behavior==='instant'&&call.options.block==='start'));
  s.layout();s.advance(152);assert.equal(s.calls.length,4,'unchanged layout does not issue another scroll');
});

test('layout corrections stop immediately after wheel, touch, scrollbar or keyboard intent',()=>{
  for(const [type,event]of [['wheel',{}],['touchstart',{}],['pointerdown',{}],['keydown',{key:'PageDown'}],['keydown',{key:'Tab'}]]){
    const s=navigationFixture();s.advance(152);const before=s.calls.length;
    s.setTop(2500);s.hydrate();s.emit(type,event);s.win.scrollY=1234;
    s.advance(1000);s.layout();s.emitDoc('avokado:catalog-ready');s.emitDoc('load');s.advance(1000);
    assert.equal(s.calls.length,before,type);assert.equal(s.win.scrollY,1234,type);
    assert.ok(s.resizeObservers.every(observer=>!observer.active));
    assert.ok(s.mutationObservers.every(observer=>!observer.active));
  }
});

test('programmatic form focus cancels pending callback alignment before late layout can steal focus',()=>{
  for(const kind of ['input','textarea','select','button','contenteditable']) {
    const s=navigationFixture({hash:'#price'});
    const control={closest:selector=>selector.includes(kind==='contenteditable'?'[contenteditable]':kind)?control:null};
    s.controller.navigate('#callback');s.advance(140);
    // Filling/autofill may focus without pointerdown, while the final animation frame is pending.
    s.doc.activeElement=control;s.emitDoc('focusin',{target:control});
    s.win.scrollY=789;s.setTop(6000);s.hydrate();s.layout();s.emit('resize');s.emitDoc('load');s.advance(1000);
    assert.equal(s.doc.activeElement,control,kind);assert.equal(s.callback.focused,undefined,kind);
    assert.equal(s.win.scrollY,789,kind);assert.equal(s.calls.length,0,kind);
    assert.ok(s.resizeObservers.every(observer=>!observer.active));
    assert.ok(s.mutationObservers.every(observer=>!observer.active));
  }
});

test('typing in an already focused input cancels a newly requested alignment without consuming the key',()=>{
  const s=navigationFixture({hash:'#price'});
  const input={closest:selector=>selector.includes('input')?input:null};
  s.doc.activeElement=input;s.emitDoc('focusin',{target:input});
  s.controller.navigate('#callback');s.emit('resize');
  const typing=s.emit('keydown',{key:'7',target:input});
  s.setTop(3000);s.hydrate();s.advance(1000);
  assert.equal(typing.defaultPrevented,undefined);assert.equal(s.doc.activeElement,input);
  assert.equal(s.callback.focused,undefined);assert.equal(s.calls.length,0);
});

test('the controllers own section focus allows later layout corrections without focusing again',()=>{
  const s=navigationFixture({hash:'#price'});
  s.controller.navigate('#callback');s.advance(152);
  assert.equal(s.doc.activeElement,s.callback);assert.equal(s.win.scrollY,1440);
  assert.ok(s.resizeObservers.some(observer=>observer.active),'section focus must not cancel the anchor controller');
  const focusOptions=s.callback.focused;
  s.setTop(3500);s.hydrate();s.advance(152);
  assert.equal(s.win.scrollY,3940);assert.equal(s.callback.focused,focusOptions,'only the first alignment transfers focus');
});

test('overlay API keeps query/history state and can restart navigation after earlier user movement',()=>{
  const s=navigationFixture({hash:'#price'});s.advance(1000);assert.equal(s.calls.length,0);
  assert.equal(s.controller.navigate(),true);s.advance(152);
  assert.deepEqual(s.history,[{state:{keep:'state'},url:'/index.html?utm_campaign=qa#contacts'}]);
  assert.equal(s.win.scrollY,940);assert.deepEqual(s.target.focused,{preventScroll:true});
  s.emit('wheel');s.win.scrollY=300;s.setTop(3500);s.controller.navigate();s.advance(152);
  assert.equal(s.win.scrollY,3440);assert.equal(s.history.length,1,'repeating Contacts does not add duplicate history entries');
});

test('same-page contact links navigate without reloading and modified clicks keep browser defaults',()=>{
  const anchor=(href,target='')=>({getAttribute:name=>name==='href'?href:target,hasAttribute:()=>false});
  const s=navigationFixture({hash:''}),link=anchor('#contacts');
  const modified=s.emitDoc('click',{target:{closest:()=>link},ctrlKey:true,button:0});
  assert.ok(!modified.defaultPrevented);s.advance(200);assert.equal(s.calls.length,0);
  const external=s.emitDoc('click',{target:{closest:()=>anchor('https://example.test/#contacts')},button:0});
  assert.ok(!external.defaultPrevented);
  const click=s.emitDoc('click',{target:{closest:()=>link},button:0});assert.ok(click.defaultPrevented);
  s.advance(152);assert.equal(s.win.scrollY,940);
});

test('back-forward document loads, history traversal and BFCache preserve the browser-restored position',()=>{
  const restored=navigationFixture({navigationType:'back_forward',scrollY:321});
  restored.emit('load');restored.emitDoc('avokado:catalog-ready');restored.advance(500);
  assert.equal(restored.calls.length,0);assert.equal(restored.win.scrollY,321);
  const s=navigationFixture();s.emit('popstate');s.emit('hashchange');s.win.scrollY=432;
  s.advance(1000);assert.equal(s.calls.length,0);assert.equal(s.win.scrollY,432);
  s.controller.navigate();s.emit('pageshow',{persisted:true});s.win.scrollY=567;
  s.layout();s.advance(1000);assert.equal(s.calls.length,0);assert.equal(s.win.scrollY,567);
});

test('ordinary fragment changes and resizes update Contacts only while that navigation is active',()=>{
  const s=navigationFixture({hash:'#price'});
  s.win.location.hash='#contacts';s.emit('hashchange');s.advance(152);assert.equal(s.win.scrollY,940);
  s.setTop(2200);s.emit('resize');s.advance(152);assert.equal(s.win.scrollY,2140);
  s.win.location.hash='#faq';s.emit('hashchange');s.win.scrollY=2800;
  s.setTop(3000);s.hydrate();s.emit('resize');s.advance(1000);assert.equal(s.win.scrollY,2800);
  assert.equal(createNavigation(s.win,s.doc),s.controller,'controller listeners are initialized once');
});

test('callback links and overlay navigation stabilize the form separately and reject unrelated destinations',()=>{
  const s=navigationFixture({hash:'#callback'});s.advance(152);assert.equal(s.win.scrollY,1440);
  s.setTop(4000);s.hydrate();s.advance(152);assert.equal(s.win.scrollY,4440);
  s.emit('wheel');s.win.scrollY=100;
  assert.equal(s.controller.navigate('#callback'),true);s.advance(152);
  assert.equal(s.win.scrollY,4440);assert.deepEqual(s.callback.focused,{preventScroll:true});
  assert.equal(s.target.focused,undefined,'form navigation does not focus its parent Contacts section');
  assert.equal(s.controller.navigate('#price'),false);assert.equal(s.win.location.hash,'#callback');
  const link={getAttribute:name=>name==='href'?'#contacts':'',hasAttribute:()=>false};
  const event=s.emitDoc('click',{target:{closest:()=>link},button:0});assert.ok(event.defaultPrevented);
  s.advance(152);assert.equal(s.win.scrollY,3940);
  link.getAttribute=name=>name==='href'?'#callback':'';
  assert.ok(s.emitDoc('click',{target:{closest:()=>link},button:0}).defaultPrevented);
  s.advance(152);assert.equal(s.win.scrollY,4440);
});
test('reroutes initial, added and CMS-updated links while contact choices stay direct',()=>{
  let onMutation;
  const saved=global.MutationObserver;
  global.MutationObserver=class{constructor(fn){onMutation=fn;}observe(){}};
  function anchor(href,choice=false){return {attrs:{href,target:'_blank'},closest(){return choice?{}:null;},getAttribute(k){return this.attrs[k];},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},matches(){return true;}};}
  try{
    for(const main of [false,true]){
      const outside=anchor('https://wa.me/79501001059'),choice=anchor('https://wa.me/79501001059',true);
      const doc={body:{},getElementById(){return main?{}:null;},querySelectorAll(){return [outside,choice];}};
      start(doc,{href:'https://avokado3.synapsebusiness.ru/'+(main?'':'price.html'),pathname:main?'/':'/price.html'});
      const expected=main?'#contacts':'index.html#contacts';
      assert.equal(outside.attrs.href,expected);assert.equal(outside.attrs.target,undefined);
      assert.equal(choice.attrs.href,'https://wa.me/79501001059');assert.equal(choice.attrs.target,'_blank');
      outside.attrs.href='https://vk.com/lasermkt';onMutation([{type:'attributes',target:outside}]);
      assert.equal(outside.attrs.href,expected);
      const added=anchor('https://t.me/avocado_studio38');onMutation([{type:'childList',addedNodes:[added]}]);
      assert.equal(added.attrs.href,expected);
    }
    start({},{pathname:'/contacts.html'});
  }finally{global.MutationObserver=saved;}
});
