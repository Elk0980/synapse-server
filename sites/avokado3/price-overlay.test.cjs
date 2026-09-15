const test = require('node:test');
const assert = require('node:assert/strict');
const {start, priceUrl, ordinaryClick} = require('./price-overlay.js');
const base = 'https://avokado38.ru/index.html';
test('only the same-origin full price opens over the existing audio document', () => {
  assert.equal(priceUrl('price.html#laser-combo', base).href, 'https://avokado38.ru/price.html#laser-combo');
  for (const value of ['https://example.com/price.html', 'javascript:alert(1)', 'data:text/html,hello', 'contacts.html', 'price.html.evil', '/other/price.html']) {
    assert.equal(priceUrl(value, base), null);
  }
});
test('new tabs, downloads and modified clicks keep normal browser behavior', () => {
  const event = {button:0};
  const link = {target:'',hasAttribute:()=>false};
  assert.equal(ordinaryClick(event, link), true);
  for (const change of [{button:1},{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{defaultPrevented:true}]) {
    assert.equal(ordinaryClick({...event,...change}, link), false);
  }
  assert.equal(ordinaryClick(event,{...link,target:'_blank'}),false);
  assert.equal(ordinaryClick(event,{...link,hasAttribute:()=>true}),false);
});

// Exercise the actual controller. Child location/history replacements deliberately
// do not push parent entries; history traversal is asynchronous, like the browser.
function fixture({search='',fullPrice=false,supportsDialog=true,music=true,restoredPrice}={}) {
  const calls=[], observers=[], pending=[];
  let doc, frame, dialog, bar, closeButton;
  function target() {
    const listeners=new Map();
    return {
      addEventListener(type,fn) { if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn); },
      emit(type,extra={}) {
        const event={type,button:0,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...extra};
        for(const fn of listeners.get(type)||[])fn(event);
        return event;
      },
    };
  }
  function element(tag) {
    const attributes=new Map(), classes=new Set();
    return {
      ...target(),tagName:tag.toUpperCase(),children:[],dataset:{},isConnected:true,hidden:false,
      setAttribute(name,value){attributes.set(name,String(value));},
      getAttribute:name=>attributes.has(name)?attributes.get(name):null,
      hasAttribute:name=>attributes.has(name),removeAttribute:name=>attributes.delete(name),
      classList:{add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)},
      append(child){this.children.push(child);},
      focus(options){doc.activeElement=this;calls.push({kind:'focus',element:this,options});},
      click(){this.emit('click',{target:this});},
      cloneNode(){const copy=element(tag);for(const [key,value]of attributes)copy.setAttribute(key,value);Object.assign(copy.dataset,this.dataset);return copy;},
    };
  }
  function innerDocument(href) {
    const sections=new Map();
    const video={pause(){calls.push({kind:'video-pause'});}};
    return {...target(),location:new URL(href),video,sections,
      getElementById:id=>sections.get(id)||null,
      querySelectorAll:selector=>selector==='video'?[video]:[],
    };
  }
  const sourceMusic=element('button');
  sourceMusic.setAttribute('id','music-toggle');sourceMusic.setAttribute('aria-controls','background-music');
  sourceMusic.setAttribute('aria-pressed','false');sourceMusic.setAttribute('aria-busy','false');
  sourceMusic.setAttribute('title','Включить музыку');sourceMusic.dataset.state='off';
  const audio=Object.freeze({currentTime:37,paused:false});
  sourceMusic.addEventListener('click',()=>{
    calls.push({kind:'music-click',audio});
    const on=sourceMusic.getAttribute('aria-pressed')!=='true';
    sourceMusic.setAttribute('aria-pressed',String(on));sourceMusic.dataset.state=on?'on':'off';
    observers.forEach(observer=>observer.fn());
  });
  const win={...target(),location:new URL('https://avokado38.ru/index.html'+search+'#price')};
  win.AvokadoContacts={cancel(){calls.push({kind:'cancel-navigation'});},navigate(hash){calls.push({kind:'navigate',hash,dialogOpen:dialog.open});return true;}};
  win.MutationObserver=class {constructor(fn){this.fn=fn;observers.push(this);}observe(){}};
  const entries=[{state:{retained:'home'},url:win.location.href}];
  let position=0;
  if(restoredPrice!==undefined){entries.push({state:{avokadoPriceOverlay:restoredPrice},url:win.location.href});position=1;}
  win.history={
    get state(){return entries[position].state;},
    get length(){return entries.length;},
    pushState(state,unused,url){entries.splice(position+1);entries.push({state,url:new URL(url,win.location.href).href});position++;win.location=new URL(entries[position].url);calls.push({kind:'push'});},
    replaceState(state,unused,url){entries[position]={state,url:new URL(url,win.location.href).href};win.location=new URL(entries[position].url);},
    back(){calls.push({kind:'back'});pending.push(()=>traverse(-1));},
    forward(){pending.push(()=>traverse(1));},
  };
  function traverse(delta){const next=position+delta;if(next<0||next>=entries.length)return;position=next;win.location=new URL(entries[position].url);win.emit('popstate',{state:entries[position].state});}
  doc={...target(),body:element('body'),documentElement:element('html'),activeElement:null,
    getElementById:id=>id==='music-toggle'&&music?sourceMusic:id==='background-music'?audio:null,
    createElement(tag){
      assert.equal(tag,'dialog','opening a price must not recreate the page audio');
      dialog=element('dialog');dialog.open=false;
      if(supportsDialog)dialog.showModal=()=>{dialog.open=true;calls.push({kind:'show'});};
      dialog.close=()=>{dialog.open=false;calls.push({kind:'hide'});};
      bar=element('div');closeButton=element('button');bar.append(closeButton);
      frame=element('iframe');frame.contentDocument=innerDocument('about:blank');
      frame.contentWindow={
        location:{replace(url){calls.push({kind:'frame-replace',url});frame.contentDocument=innerDocument(url);}},
        history:{replaceState(state,unused,url){frame.contentDocument.location=new URL(url);calls.push({kind:'child-replace',url});}},
      };
      dialog.querySelector=selector=>selector==='iframe'?frame:selector==='button'?closeButton:selector==='.av-price-dialog__bar'?bar:null;
      return dialog;
    },
  };
  if(fullPrice)doc.body.setAttribute('data-full-price','');
  function link(href,attrs={}) {
    const anchor=element('a');anchor.href=new URL(href,win.location.href).href;anchor.target=attrs.target||'';
    for(const [name,value]of Object.entries(attrs))anchor.setAttribute(name,value);
    anchor.closest=selector=>selector==='a[href]'?anchor:null;
    return anchor;
  }
  const controller=start(win,doc);
  function open(href='price.html#laser-combo') {
    const opener=link(href);const event=doc.emit('click',{target:opener});
    if(dialog.open)frame.emit('load');
    return {opener,event};
  }
  return {win,doc,controller,audio,sourceMusic,calls,entries,link,open,dialog,frame,bar,closeButton,
    flush(){while(pending.length)pending.shift()();},
    innerClick(href,attrs={},extra={}){return frame.contentDocument.emit('click',{target:link(href,attrs),...extra});},
    addSection(id){const section={scrollIntoView(options){calls.push({kind:'section-scroll',id,options});}};frame.contentDocument.sections.set(id,section);return section;},
  };
}

test('opening price cancels anchor correction, keeps parent URL/audio, and mirrors the original music control',()=>{
  const s=fixture(), originalUrl=s.win.location.href;
  const {event}=s.open('price.html?campaign=test#laser-combo');
  assert.equal(event.defaultPrevented,true);assert.equal(s.dialog.open,true);
  assert.equal(s.win.location.href,originalUrl);assert.equal(s.win.history.length,2);
  assert.equal(s.doc.getElementById('background-music'),s.audio);assert.equal(s.audio.currentTime,37);
  assert.deepEqual(s.calls.slice(0,3).map(call=>call.kind),['cancel-navigation','push','frame-replace']);
  assert.equal(s.frame.contentDocument.location.href,'https://avokado38.ru/price.html?campaign=test&embedded=1#laser-combo');
  assert.equal(s.doc.activeElement,s.closeButton);assert.equal(s.doc.documentElement.classList.contains('av-price-open'),true);
  const clonedMusic=s.bar.children[1];
  assert.equal(clonedMusic.hasAttribute('id'),false);assert.equal(clonedMusic.hasAttribute('aria-controls'),false);
  clonedMusic.click();
  assert.equal(clonedMusic.getAttribute('aria-pressed'),'true');assert.equal(clonedMusic.dataset.state,'on');
  assert.equal(s.calls.find(call=>call.kind==='music-click').audio,s.audio);
});

test('Back closes and restores focus; Forward reopens without adding history or destroying audio',()=>{
  const s=fixture(), {opener}=s.open();
  s.win.history.back();s.flush();
  assert.equal(s.dialog.open,false);assert.equal(s.doc.activeElement,opener);
  assert.equal(s.doc.documentElement.classList.contains('av-price-open'),false);
  assert.equal(s.calls.filter(call=>call.kind==='video-pause').length,1);
  assert.notEqual(s.frame.contentDocument.location.href,'about:blank');
  s.win.history.forward();s.flush();
  assert.equal(s.dialog.open,true);assert.equal(s.win.history.length,2);assert.equal(s.doc.activeElement,s.closeButton);
  assert.equal(s.calls.filter(call=>call.kind==='push').length,1);
  assert.equal(s.doc.getElementById('background-music'),s.audio);
  s.closeButton.click();assert.equal(s.dialog.open,true,'history close waits for traversal');s.flush();
  assert.equal(s.dialog.open,false);assert.equal(s.doc.activeElement,opener);
});

test('reload restores a valid price history entry and one close returns to the preceding page state',()=>{
  const s=fixture({restoredPrice:'https://avokado38.ru/price.html#certificate'});
  assert.equal(s.dialog.open,true);assert.equal(s.doc.activeElement,s.closeButton);
  assert.equal(s.frame.contentDocument.location.hash,'#certificate');
  assert.equal(s.win.history.length,2);assert.equal(s.calls.some(call=>call.kind==='push'),false);
  s.closeButton.click();s.flush();
  assert.equal(s.dialog.open,false);assert.deepEqual(s.win.history.state,{retained:'home'});
  s.open();s.closeButton.click();s.flush();assert.equal(s.dialog.open,false,'a later open must not require two closes');
  for(const restoredPrice of ['https://outside.example/price.html','javascript:alert(1)','privacy.html']) {
    const invalid=fixture({restoredPrice});assert.equal(invalid.dialog.open,false);
    assert.equal(invalid.calls.some(call=>call.kind==='frame-replace'),false);
  }
});

test('Contacts and callback routes close first and invoke the requested parent anchor once',()=>{
  for(const hash of ['#contacts','#callback']) {
    const s=fixture();s.open();
    const event=s.innerClick('index.html'+hash);
    assert.equal(event.defaultPrevented,true);assert.equal(s.dialog.open,true);
    assert.equal(s.calls.some(call=>call.kind==='navigate'),false,'do not scroll a locked parent');
    s.flush();
    assert.deepEqual(s.calls.filter(call=>call.kind==='navigate'),[{kind:'navigate',hash,dialogOpen:false}]);
    assert.equal(s.doc.getElementById('background-music'),s.audio);
    s.win.history.forward();s.flush();s.closeButton.click();s.flush();
    assert.equal(s.calls.filter(call=>call.kind==='navigate').length,1,'destination does not leak into a later close');
  }
});

test('iframe section links replace child history so one close leaves the entire price view',()=>{
  const s=fixture();s.open();
  for(const id of ['laser-combo','certificate']) {
    s.addSection(id);
    const event=s.innerClick('price.html#'+id);assert.equal(event.defaultPrevented,true);
  }
  assert.equal(s.win.history.length,2);
  assert.deepEqual(s.calls.filter(call=>call.kind==='section-scroll').map(call=>call.id),['laser-combo','certificate']);
  assert.equal(s.frame.contentDocument.location.hash,'#certificate');
  assert.equal(s.frame.contentDocument.location.search,'?embedded=1');
  s.closeButton.click();s.flush();assert.equal(s.dialog.open,false);
  assert.equal(s.calls.filter(call=>call.kind==='back').length,1);
});

test('section click while catalogue is loading stores the hash without adding a child history entry',()=>{
  const s=fixture();s.open();
  const event=s.innerClick('price.html#certificate');
  assert.equal(event.defaultPrevented,true);assert.equal(s.win.history.length,2);
  assert.equal(s.frame.contentDocument.location.hash,'#certificate','catalogue can resolve the target after rendering');
  assert.equal(s.calls.filter(call=>call.kind==='child-replace').length,1);
  assert.equal(s.calls.filter(call=>call.kind==='section-scroll').length,0);
  s.closeButton.click();s.flush();assert.equal(s.dialog.open,false);
});

test('same-origin legal page uses replacement, and its home link closes without a parent reload',()=>{
  const s=fixture();s.open();
  const event=s.innerClick('privacy.html');assert.equal(event.defaultPrevented,true);
  assert.equal(s.frame.contentDocument.location.pathname,'/privacy.html');assert.equal(s.win.history.length,2);
  s.frame.emit('load');
  const home=s.innerClick('index.html#price');assert.equal(home.defaultPrevented,true);s.flush();
  assert.equal(s.dialog.open,false);assert.equal(s.win.location.pathname,'/index.html');
  assert.equal(s.calls.some(call=>call.kind==='navigate'),false);
});

test('external, telephone, modified and download links retain native behavior in both documents',()=>{
  const s=fixture();s.open();
  const cases=[
    ['https://booking.example/price.html',{},{}],['https://other.example/index.html#contacts',{},{}],
    ['tel:+79331901059',{},{}],['index.html#contacts',{target:'_blank'},{}],
    ['index.html#contacts',{download:''},{}],['index.html#callback',{}, {ctrlKey:true}],
    ['index.html#callback',{}, {button:1}],['index.html#contacts',{}, {defaultPrevented:true}],
  ];
  const count=s.calls.length;
  for(const [href,attrs,extra]of cases){const event=s.innerClick(href,attrs,extra);assert.equal(event.defaultPrevented,Boolean(extra.defaultPrevented),href);}
  assert.equal(s.calls.length,count);assert.equal(s.dialog.open,true);
  for(const [href,attrs,extra]of [['https://other.example/price.html',{},{}],['contacts.html',{},{}],['price.html',{target:'_blank'},{}],['price.html',{}, {metaKey:true}]]) {
    assert.equal(s.doc.emit('click',{target:s.link(href,attrs),...extra}).defaultPrevented,false);
  }
  assert.equal(s.calls.length,count);
});

test('cross-origin or unavailable iframe documents cannot install handlers or prevent closing',()=>{
  for(const throws of [true,false]) {
    const s=fixture();s.open();
    Object.defineProperty(s.frame,'contentDocument',{get(){if(throws)throw new Error('SecurityError');return null;}});
    assert.doesNotThrow(()=>s.frame.emit('load'));
    assert.doesNotThrow(()=>{s.controller.close();s.flush();});
    assert.equal(s.dialog.open,false);
  }
});

test('Escape closes safely and missing Contacts API falls back only to an allowed hash',()=>{
  const s=fixture();s.open();
  const cancel=s.dialog.emit('cancel');assert.equal(cancel.defaultPrevented,true);s.flush();assert.equal(s.dialog.open,false);
  s.open();delete s.win.AvokadoContacts;s.controller.close('#callback');s.flush();
  assert.equal(s.win.location.hash,'#callback');assert.equal(s.dialog.open,false);
  s.open();s.controller.close('https://other.example/');s.flush();
  assert.equal(s.win.location.origin,'https://avokado38.ru');
  assert.equal(s.calls.some(call=>call.kind==='navigate'),false);
});

test('editor, standalone price and browsers without native dialog keep the original links',()=>{
  for(const options of [{search:'?edit=1'},{fullPrice:true},{supportsDialog:false}]) {
    const s=fixture(options);
    assert.equal(s.controller,undefined);assert.equal(s.doc.body.children.length,0);
    assert.equal(s.doc.emit('click',{target:s.link('price.html')}).defaultPrevented,false);
  }
});
