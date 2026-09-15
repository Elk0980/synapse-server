const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/index.html','utf8');
const source=html.match(/<script>\s*\/\* Баннер после блока отзывов:[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g,'');
function setup({edit=false,hasContacts=true}={}){
 const events={},order=[],rootClasses=new Set(),promoClasses=new Set();
 const classList=set=>({add:x=>set.add(x),remove:x=>set.delete(x),contains:x=>set.has(x)});
 const previous={isConnected:true,focus(){order.push('previous-focus');}};
 const closeButton={addEventListener:(name,fn)=>events['close:'+name]=fn,focus(){order.push('close-focus');},blur(){order.push('close-blur');}};
 const body={};
 const promo={classList:classList(promoClasses),querySelector:s=>s==='.promo__body'?body:closeButton,querySelectorAll:()=>[],addEventListener:(name,fn)=>events['promo:'+name]=fn};
 const contacts={setAttribute(){},focus(){order.push('contacts-focus');},scrollIntoView(){assert.equal(promoClasses.has('is-open'),false);assert.equal(rootClasses.has('promo-open'),false);order.push('contacts-scroll');}};
 const document={activeElement:previous,documentElement:{classList:classList(rootClasses)},getElementById:id=>({promo,trust:{},contacts:hasContacts?contacts:null}[id]),querySelector(){return this.priceOpen?{}:null;},addEventListener:(name,fn)=>events[name]=fn};
 const location={search:edit?'?edit=1':'',hash:'#after-hero'};
 const history={state:{keep:true},pushState(state,_,hash){this.calls=(this.calls||0)+1;assert.deepEqual(state,{keep:true});location.hash=hash;}};
 const window={};
 vm.runInNewContext(source,{document,location,history,window,URLSearchParams,sessionStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:true,addEventListener(){}}),setTimeout});
 const click=(hash='#contacts',options={})=>{
  const e={target:{closest:()=>hash==='#contacts'?{}:null},button:0,preventDefault(){this.defaultPrevented=true;},...options};events['promo:click'](e);return e;
 };
 return {events,order,rootClasses,promoClasses,location,history,window,document,click};
}
test('subscription action closes the popup and unlocks the page before focusing and scrolling to contacts',()=>{
 const s=setup();s.window.alviPromoOpen();s.order.length=0;
 const event=s.click();assert.equal(event.defaultPrevented,true);
 assert.equal(s.location.hash,'#contacts');assert.equal(s.history.calls,1);
 assert.deepEqual(s.order,['close-blur','contacts-focus','contacts-scroll']);
 s.events.keydown({key:'Escape'});assert.deepEqual(s.order,['close-blur','contacts-focus','contacts-scroll'],'Escape outside the popup must not steal focus');
});
test('normal closing restores focus; modified clicks and external destinations keep native navigation',()=>{
 const s=setup();s.window.alviPromoOpen();s.order.length=0;
 for(const options of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}])assert.equal(s.click('#contacts',options).defaultPrevented,undefined);
 assert.equal(s.click('https://example.org').defaultPrevented,undefined);
 assert.equal(s.promoClasses.has('is-open'),true);
 s.events['close:click']({});assert.deepEqual(s.order,['previous-focus']);
});
test('editor links and a missing contact section are not intercepted; repeated contact entry does not add history',()=>{
 for(const options of [{edit:true},{hasContacts:false}]){const s=setup(options);s.window.alviPromoOpen();assert.equal(s.click().defaultPrevented,undefined);}
 const s=setup();s.location.hash='#contacts';s.window.alviPromoOpen();s.click();assert.equal(s.history.calls,undefined);
});
test('a delayed promo cannot open behind the full price dialog and closing for price navigation does not restore stale focus',()=>{
 const s=setup();s.document.priceOpen=true;s.window.alviPromoOpen();assert.equal(s.promoClasses.has('is-open'),false);
 s.document.priceOpen=false;s.window.alviPromoOpen();s.order.length=0;s.window.alviPromoClose({restoreFocus:false});
 assert.equal(s.rootClasses.has('promo-open'),false);assert.deepEqual(s.order,['close-blur']);
});
