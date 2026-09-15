const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {start, priceUrl, ordinaryClick} = require('./price-overlay.js');
const base = 'https://spaalvi-38.ru/index.html';
test('only the same-origin full price opens over the existing audio document', () => {
  assert.equal(priceUrl('price.html#s1-1', base).href, 'https://spaalvi-38.ru/price.html#s1-1');
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
function fixture({search='',fullPrice=false,supportsDialog=true,music=true,restoredPrice,audioPaused=false}={}) {
  const calls=[], observers=[], pending=[];
  let doc, frame, dialog, bar, closeButton, musicStatus;
  function target() {
    const listeners=new Map();
    return {
      addEventListener(type,fn,options) { if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push({fn,capture:options===true||Boolean(options?.capture)}); },
      emit(type,extra={}) {
        const event={type,button:0,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...extra};
        for(const {fn} of [...listeners.get(type)||[]].sort((a,b)=>Number(b.capture)-Number(a.capture)))fn(event);
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
      classList:{add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value),toggle(value,on){if(on===undefined)on=!classes.has(value);if(on)classes.add(value);else classes.delete(value);return on;}},
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
  sourceMusic.setAttribute('id','alvi-music-toggle');sourceMusic.setAttribute('aria-controls','alvi-background-music');
  sourceMusic.setAttribute('aria-pressed','false');sourceMusic.setAttribute('aria-busy','false');
  sourceMusic.setAttribute('title','Включить музыку');sourceMusic.dataset.state='off';
  const sourceStatus=element('p');sourceStatus.textContent='';
  const audio=Object.freeze({currentTime:37,paused:audioPaused});
  sourceMusic.addEventListener('click',()=>{
    calls.push({kind:'music-click',audio});
    const on=sourceMusic.getAttribute('aria-pressed')!=='true';
    sourceMusic.setAttribute('aria-pressed',String(on));sourceMusic.dataset.state=on?'playing':'off';
    observers.forEach(observer=>observer.fn());
  });
  const win={...target(),location:new URL('https://spaalvi-38.ru/index.html'+search+'#price')};
  win.AlviContacts={cancel(){calls.push({kind:'cancel-navigation'});},navigate(hash){calls.push({kind:'navigate',hash,dialogOpen:dialog.open});return true;}};
  win.MutationObserver=class {constructor(fn){this.fn=fn;observers.push(this);}observe(){}};
  const entries=[{state:{retained:'home'},url:win.location.href}];
  let position=0;
  if(restoredPrice!==undefined){entries.push({state:{alviPriceOverlay:restoredPrice},url:win.location.href});position=1;}
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
    getElementById:id=>id==='alvi-music-toggle'&&music?sourceMusic:id==='alvi-background-music'?audio:id==='alvi-music-status'?sourceStatus:null,
    createElement(tag){
      assert.equal(tag,'dialog','opening a price must not recreate the page audio');
      dialog=element('dialog');dialog.open=false;
      if(supportsDialog)dialog.showModal=()=>{dialog.open=true;calls.push({kind:'show'});};
      dialog.close=()=>{dialog.open=false;calls.push({kind:'hide'});};
      bar=element('div');closeButton=element('button');bar.append(closeButton);
      musicStatus=element('p');
      frame=element('iframe');frame.contentDocument=innerDocument('about:blank');
      frame.contentWindow={
        location:{replace(url){calls.push({kind:'frame-replace',url});frame.contentDocument=innerDocument(url);}},
        history:{replaceState(state,unused,url){frame.contentDocument.location=new URL(url);calls.push({kind:'child-replace',url});}},
      };
      dialog.querySelector=selector=>selector==='iframe'?frame:selector==='button'?closeButton:selector==='.alvi-price-dialog__bar'?bar:selector==='.alvi-price-dialog__status'?musicStatus:null;
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
  function open(href='price.html#s1-1') {
    const opener=link(href);const event=doc.emit('click',{target:opener});
    if(dialog.open)frame.emit('load');
    return {opener,event};
  }
  return {win,doc,controller,audio,sourceMusic,sourceStatus,musicStatus,calls,entries,link,open,dialog,frame,bar,closeButton,
    makeElement:element,
    synchronizeMusic:()=>observers.forEach(observer=>observer.fn()),
    flush(){while(pending.length)pending.shift()();},
    innerClick(href,attrs={},extra={}){return frame.contentDocument.emit('click',{target:link(href,attrs),...extra});},
    addSection(id){const section={scrollIntoView(options){calls.push({kind:'section-scroll',id,options});}};frame.contentDocument.sections.set(id,section);return section;},
  };
}

test('opening price cancels anchor correction, keeps parent URL/audio, and mirrors the original music control',()=>{
  const s=fixture(), originalUrl=s.win.location.href;
  const {event}=s.open('price.html?campaign=test#s1-1');
  assert.equal(event.defaultPrevented,true);assert.equal(s.dialog.open,true);
  assert.equal(s.win.location.href,originalUrl);assert.equal(s.win.history.length,2);
  assert.equal(s.doc.getElementById('alvi-background-music'),s.audio);assert.equal(s.audio.currentTime,37);
  assert.deepEqual(s.calls.slice(0,3).map(call=>call.kind),['cancel-navigation','push','frame-replace']);
  assert.equal(s.frame.contentDocument.location.href,'https://spaalvi-38.ru/price.html?campaign=test&embedded=1#s1-1');
  assert.equal(s.doc.activeElement,s.closeButton);assert.equal(s.doc.documentElement.classList.contains('alvi-price-open'),true);
  const clonedMusic=s.bar.children[1];
  assert.equal(clonedMusic.hasAttribute('id'),false);assert.equal(clonedMusic.hasAttribute('aria-controls'),false);
  clonedMusic.click();
  assert.equal(clonedMusic.getAttribute('aria-pressed'),'true');assert.equal(clonedMusic.dataset.state,'playing');
  assert.equal(s.calls.find(call=>call.kind==='music-click').audio,s.audio);
});

test('opening price never starts audio; loading, playback and failures remain accessible inside the modal',()=>{
  const s=fixture({audioPaused:true});s.open();const clone=s.bar.children[1];
  assert.equal(clone.getAttribute('aria-pressed'),'false');assert.equal(clone.dataset.state,'off');
  assert.equal(s.calls.some(call=>call.kind==='music-click'),false);assert.equal(s.audio.paused,true);
  s.sourceMusic.setAttribute('aria-busy','true');s.sourceMusic.dataset.state='loading';s.synchronizeMusic();
  assert.equal(clone.getAttribute('aria-busy'),'true');assert.equal(clone.dataset.state,'loading');
  s.sourceMusic.setAttribute('aria-busy','false');s.sourceMusic.setAttribute('aria-pressed','true');s.sourceMusic.dataset.state='playing';
  s.sourceStatus.textContent='Музыка включена';s.synchronizeMusic();
  assert.equal(clone.dataset.state,'playing');assert.equal(s.musicStatus.textContent,'Музыка включена');
  s.sourceMusic.setAttribute('aria-pressed','false');s.sourceMusic.dataset.state='off';
  s.sourceMusic.removeAttribute('aria-busy');s.sourceStatus.textContent='Не удалось включить музыку. Нажмите «Музыка», чтобы попробовать снова.';s.synchronizeMusic();
  assert.equal(clone.getAttribute('aria-busy'),null);assert.equal(clone.getAttribute('aria-pressed'),'false');
  assert.equal(s.musicStatus.textContent,s.sourceStatus.textContent);
});

test('repeated initialization and another price target keep one dialog and one history entry',()=>{
  const s=fixture();assert.equal(start(s.win,s.doc),s.controller);assert.equal(s.doc.body.children.length,1);
  s.open();assert.equal(s.win.history.state.retained,'home');
  assert.equal(s.controller.open('price.html#s2'),true);assert.equal(s.win.history.length,2);
  assert.equal(s.win.history.state.alviPriceOverlay,'https://spaalvi-38.ru/price.html#s2');
  assert.equal(s.frame.contentDocument.location.hash,'#s2');
  assert.equal(s.controller.open('https://other.example/price.html'),false);
  s.controller.close();s.flush();assert.equal(s.dialog.open,false);
});

test('opening a price closes an existing promotion without restoring focus behind the dialog',()=>{
  const s=fixture();s.win.alviPromoClose=options=>s.calls.push({kind:'promo-close',options});
  s.open();assert.deepEqual(s.calls.find(call=>call.kind==='promo-close').options,{restoreFocus:false});
  assert.equal(s.doc.activeElement,s.closeButton);
});

test('Back closes and restores focus; Forward reopens without adding history or destroying audio',()=>{
  const s=fixture(), {opener}=s.open();
  s.win.history.back();s.flush();
  assert.equal(s.dialog.open,false);assert.equal(s.doc.activeElement,opener);
  assert.equal(s.doc.documentElement.classList.contains('alvi-price-open'),false);
  assert.equal(s.calls.filter(call=>call.kind==='video-pause').length,1);
  assert.notEqual(s.frame.contentDocument.location.href,'about:blank');
  s.win.history.forward();s.flush();
  assert.equal(s.dialog.open,true);assert.equal(s.win.history.length,2);assert.equal(s.doc.activeElement,s.closeButton);
  assert.equal(s.calls.filter(call=>call.kind==='push').length,1);
  assert.equal(s.doc.getElementById('alvi-background-music'),s.audio);
  s.closeButton.click();assert.equal(s.dialog.open,true,'history close waits for traversal');s.flush();
  assert.equal(s.dialog.open,false);assert.equal(s.doc.activeElement,opener);
});

test('reload restores a valid price history entry and one close returns to the preceding page state',()=>{
  const s=fixture({restoredPrice:'https://spaalvi-38.ru/price.html#s8'});
  assert.equal(s.dialog.open,true);assert.equal(s.doc.activeElement,s.closeButton);
  assert.equal(s.frame.contentDocument.location.hash,'#s8');
  assert.equal(s.win.history.length,2);assert.equal(s.calls.some(call=>call.kind==='push'),false);
  s.closeButton.click();s.flush();
  assert.equal(s.dialog.open,false);assert.deepEqual(s.win.history.state,{retained:'home'});
  s.open();s.closeButton.click();s.flush();assert.equal(s.dialog.open,false,'a later open must not require two closes');
  for(const restoredPrice of ['https://outside.example/price.html','javascript:alert(1)','politika.html']) {
    const invalid=fixture({restoredPrice});assert.equal(invalid.dialog.open,false);
    assert.equal(invalid.calls.some(call=>call.kind==='frame-replace'),false);
  }
});

test('Contacts and callback routes close first and invoke the requested parent anchor once',()=>{
  for(const hash of ['#contacts','#callback-form']) {
    const s=fixture();s.open();
    const event=s.innerClick('index.html'+hash);
    assert.equal(event.defaultPrevented,true);assert.equal(s.dialog.open,true);
    assert.equal(s.calls.some(call=>call.kind==='navigate'),false,'do not scroll a locked parent');
    s.flush();
    assert.deepEqual(s.calls.filter(call=>call.kind==='navigate'),[{kind:'navigate',hash,dialogOpen:false}]);
    assert.equal(s.doc.getElementById('alvi-background-music'),s.audio);
    s.win.history.forward();s.flush();s.closeButton.click();s.flush();
    assert.equal(s.calls.filter(call=>call.kind==='navigate').length,1,'destination does not leak into a later close');
  }
});

test('iframe section links replace child history so one close leaves the entire price view',()=>{
  const s=fixture();s.open();
  for(const id of ['s1-1','s8']) {
    s.addSection(id);
    const event=s.innerClick('price.html#'+id);assert.equal(event.defaultPrevented,true);
  }
  assert.equal(s.win.history.length,2);
  assert.deepEqual(s.calls.filter(call=>call.kind==='section-scroll').map(call=>call.id),['s1-1','s8']);
  assert.equal(s.frame.contentDocument.location.hash,'#s8');
  assert.equal(s.frame.contentDocument.location.search,'?embedded=1');
  s.closeButton.click();s.flush();assert.equal(s.dialog.open,false);
  assert.equal(s.calls.filter(call=>call.kind==='back').length,1);
});

test('section click while catalogue is loading stores the hash without adding a child history entry',()=>{
  const s=fixture();s.open();
  const event=s.innerClick('price.html#s8');
  assert.equal(event.defaultPrevented,true);assert.equal(s.win.history.length,2);
  assert.equal(s.frame.contentDocument.location.hash,'#s8','catalogue can resolve the target after rendering');
  assert.equal(s.calls.filter(call=>call.kind==='child-replace').length,1);
  assert.equal(s.calls.filter(call=>call.kind==='section-scroll').length,0);
  s.closeButton.click();s.flush();assert.equal(s.dialog.open,false);
});

test('price anchor controller receives replace navigation before the frames native click handler',()=>{
  const s=fixture();s.controller.open('price.html#s1');
  let nativeNavigation=0;
  s.frame.contentDocument.addEventListener('click',event=>{if(!event.defaultPrevented)nativeNavigation++;});
  s.frame.emit('load');
  s.frame.contentWindow.AlviPriceNavigation={navigate(hash,options){
    assert.equal(hash,'#s1-1');assert.deepEqual(options,{replace:true});
    s.calls.push({kind:'price-navigation',hash});
    s.frame.contentWindow.history.replaceState(null,'','https://spaalvi-38.ru/price.html?embedded=1'+hash);
    return true;
  }};
  s.addSection('s1-1');assert.equal(s.innerClick('price.html#s1-1').defaultPrevented,true);
  assert.equal(nativeNavigation,0);assert.equal(s.calls.filter(call=>call.kind==='price-navigation').length,1);
  assert.equal(s.calls.filter(call=>call.kind==='section-scroll').length,0,'the price controller owns alignment');
  assert.equal(s.win.history.length,2);s.closeButton.click();s.flush();assert.equal(s.dialog.open,false);
});

test('the actual mobile menu closes after overlay capture navigates, without a second navigation',()=>{
  const s=fixture();s.controller.open('price.html#s1');
  const inner=s.frame.contentDocument,nav=s.makeElement('nav'),list=s.makeElement('ul');
  const link=s.link('price.html#s1-1');link.hash='#s1-1';
  link.closest=selector=>selector==='a[href]'||selector==='a[href^="#"]'?link:null;
  const destination=s.makeElement('article');destination.focus=options=>{inner.activeElement=destination;destination.focusOptions=options;};
  inner.sections.set('s1-1',destination);
  inner.documentElement=s.makeElement('html');inner.documentElement.classList.add('alvi-price-embedded');
  inner.querySelector=selector=>selector==='.price-page .pnav'?nav:null;
  inner.createComment=()=>({});inner.createElement=s.makeElement;
  nav.querySelector=selector=>selector===':scope > ul'?list:null;
  list.querySelectorAll=()=>[];
  nav.before=()=>{};nav.insertBefore=node=>nav.children.push(node);
  nav.contains=node=>node===link||nav.children.includes(node);
  const win={matchMedia:()=>({matches:true,addEventListener(){}})};
  const Observer=class{observe(){}};
  // Run the real bubble handler, then attach the real parent capture handler.
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'price-mobile-nav.js'),'utf8'),{window:win,document:inner,MutationObserver:Observer});
  inner.addEventListener('click',event=>nav.emit('click',event));
  s.frame.emit('load');
  let navigations=0;
  s.frame.contentWindow.AlviPriceNavigation={navigate(hash,options){
    navigations++;assert.equal(hash,'#s1-1');assert.equal(options.replace,true);return true;
  }};
  const toggle=nav.children[0];toggle.click();
  assert.equal(nav.classList.contains('is-mobile-open'),true);assert.equal(toggle.getAttribute('aria-expanded'),'true');
  const event=inner.emit('click',{target:link});
  assert.equal(event.defaultPrevented,true);assert.equal(navigations,1);
  assert.equal(nav.classList.contains('is-mobile-open'),false);assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.equal(inner.activeElement,destination);assert.equal(destination.focusOptions.preventScroll,true);
  assert.equal(s.win.history.length,2);
});

test('returning from a legal document to a price hash replaces the document and retains embedded mode',()=>{
  const s=fixture();s.open();s.innerClick('politika.html');s.frame.emit('load');
  s.innerClick('price.html#s8');
  assert.equal(s.frame.contentDocument.location.href,'https://spaalvi-38.ru/price.html?embedded=1#s8');
  assert.equal(s.win.history.length,2);assert.equal(s.calls.filter(call=>call.kind==='child-replace').length,0);
});

test('same-origin legal page uses replacement, and its home link closes without a parent reload',()=>{
  const s=fixture();s.open();
  const event=s.innerClick('politika.html');assert.equal(event.defaultPrevented,true);
  assert.equal(s.frame.contentDocument.location.pathname,'/politika.html');assert.equal(s.win.history.length,2);
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
    ['index.html#contacts',{download:''},{}],['index.html#callback-form',{}, {ctrlKey:true}],
    ['index.html#callback-form',{}, {button:1}],['index.html#contacts',{}, {defaultPrevented:true}],
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
  s.open();delete s.win.AlviContacts;s.controller.close('#callback-form');s.flush();
  assert.equal(s.win.location.hash,'#callback-form');assert.equal(s.dialog.open,false);
  s.open();s.controller.close('https://other.example/');s.flush();
  assert.equal(s.win.location.origin,'https://spaalvi-38.ru');
  assert.equal(s.calls.some(call=>call.kind==='navigate'),false);
});

test('editor, standalone price and browsers without native dialog keep the original links',()=>{
  for(const options of [{search:'?edit=1'},{fullPrice:true},{supportsDialog:false}]) {
    const s=fixture(options);
    assert.equal(s.controller,undefined);assert.equal(s.doc.body.children.length,0);
    assert.equal(s.doc.emit('click',{target:s.link('price.html')}).defaultPrevented,false);
  }
});
