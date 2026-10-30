'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const {JSDOM}=require('jsdom');
const helper=fs.readFileSync(path.join(__dirname,'profile-session-panel.js'),'utf8');
function unit(id='A') {
 const dom=new JSDOM('<main data-account-content style="display:grid"><form><input name="firstName" value="Начальное"><button>Сохранить</button></form></main>',{url:'http://fixture.invalid/account',runScripts:'outside-only'}),w=dom.window;
 let listener,reads=0,snapshot={status:'ready',user:{id:'A'}};
 w.PalitraAccountView={version:1,getSnapshot:()=>snapshot,subscribe:fn=>{listener=fn;}};
 w.eval(`const doc=document; function refreshMyOrdersAccount(){window.readRequested();} ${helper}; window.panel=bindProfileSessionPanel(document.querySelector('main'),${JSON.stringify(id)});`);
 w.readRequested=()=>{reads++;};
 return {w,dom,container:w.document.querySelector('main'),input:w.document.querySelector('input'),notice:w.document.querySelector('.sf-account-session-notice'),panel:w.panel,reads:()=>reads,emit(s){snapshot=s;listener(s);},close(){dom.window.close();}};
}
test('same verified account shows existing panel and restores its prior display',()=>{
 const f=unit();try{assert.equal(f.panel.isCurrent(),true);assert.equal(f.container.hidden,false);assert.equal(f.container.style.display,'grid');
 f.emit({status:'loading'});assert.equal(f.container.hidden,true);assert.equal(f.container.inert,true);
 f.emit({status:'ready',user:{id:'A'}});assert.equal(f.container.style.display,'grid');assert.equal(f.container.hasAttribute('aria-hidden'),false);
 }finally{f.close();}
});
test('logout and unavailable state hide personal panel while retaining manual draft in its own DOM',()=>{
 const f=unit();try{f.input.value='Не терять';f.input.dispatchEvent(new f.w.Event('input',{bubbles:true}));
 for(const snapshot of [{status:'unavailable'},{status:'changing'},{status:'ready',user:null}]){f.emit(snapshot);assert.equal(f.container.hidden,true);assert.equal(f.container.getAttribute('aria-hidden'),'true');assert.equal(f.input.value,'Не терять');assert.equal(f.panel.isCurrent(),false);}
 assert.match(f.notice.textContent,/Вы вышли/);assert.equal(f.notice.querySelector('a').target,'_blank');
 }finally{f.close();}
});
test('different account cannot reveal or inherit prior account form; same-account return restores it',()=>{
 const f=unit();try{f.input.value='Свой черновик';f.emit({status:'ready',user:{id:'B',firstName:'Другой'}});assert.equal(f.container.hidden,true);assert.match(f.notice.textContent,/Аккаунт изменился/);assert.equal(f.input.value,'Свой черновик');f.emit({status:'ready',user:{id:'A'}});assert.equal(f.container.hidden,false);assert.equal(f.input.value,'Свой черновик');}finally{f.close();}
});
test('explicit retry requests one read, loading disables retry and never writes',()=>{
 const f=unit();try{f.emit({status:'unavailable'});const b=f.notice.querySelector('button');b.click();assert.equal(f.reads(),1);f.emit({status:'loading'});b.click();assert.equal(f.reads(),1);assert.equal(b.disabled,true);}finally{f.close();}
});
test('dirty draft warns on leaving; confirmed save clears only that warning',()=>{
 const f=unit();try{f.input.dispatchEvent(new f.w.Event('input',{bubbles:true}));const event=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(event);assert.equal(event.defaultPrevented,true);f.panel.markSaved();const clean=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(clean);assert.equal(clean.defaultPrevented,false);}finally{f.close();}
});
test('missing identity and unknown view fail closed, including ready guest',()=>{
 const f=unit('');try{assert.equal(f.container.hidden,true);f.emit({status:'ready',user:null});assert.equal(f.panel.isCurrent(),false);}finally{f.close();}
});
const user=id=>({id,firstName:id==='A'?'Первый':'Второй',lastName:'',phone:'+79000000001',address:'Вымышленный адрес',email:'fixture@example.invalid'});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function integration(){
 const dom=new JSDOM('<main data-account-content></main>',{url:'http://fixture.invalid/account',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,events=[],listeners=[];
 const observers=[],NativeObserver=w.MutationObserver;w.MutationObserver=class extends NativeObserver{constructor(callback){super(callback);observers.push(this);}};
 const close=()=>{for(const observer of observers)observer.disconnect();dom.window.close();};
 let current=user('A'),csrf='a'.repeat(48),held=null;
 w.PalitraAttribution={fixture:true};w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});w.BroadcastChannel=class{addEventListener(t,fn){listeners.push(fn);}postMessage(){}};
 w.fetch=async(url,options={})=>{events.push({url,method:options.method||'GET',headers:options.headers,body:options.body});
  if(url.endsWith('/session'))return {status:200,ok:true,json:async()=>({user:current,csrf})};
  if(url.endsWith('/wishlist'))return {status:200,ok:true,json:async()=>({ids:[]})};
  if(url.includes('history-status'))return {status:200,ok:true,json:async()=>({ok:true,hasHistory:false})};
  if(url.endsWith('/profile')){if(held)return held.promise;current={...current,...JSON.parse(options.body)};return {status:200,ok:true,json:async()=>({user:current})};}
  throw Error('Unexpected fixture route '+url);
 };
 try{w.eval(fs.readFileSync(path.join(__dirname,'payload/assets/storefront.js'),'utf8'));}catch(error){close();throw error;}
 await flush();await flush();
 return {w,events,dom,get panel(){return w.document.querySelector('[data-account-content]');},get form(){return w.document.querySelector('[data-profile-form]');},async setAccount(u,newCsrf=csrf){current=u;csrf=newCsrf;for(const fn of listeners)fn({data:{version:1,type:'invalidate'}});await flush();await flush();},holdProfile(){let resolve;const promise=new Promise(r=>{resolve=r;});held={promise,resolve};return resolve;},close};
}
test('full current script blocks stale profile submit and logout after actual account read becomes guest',async()=>{
 const f=await integration();try{assert.ok(f.form);f.form.elements.firstName.value='Ручной ввод';f.form.elements.firstName.dispatchEvent(new f.w.Event('input',{bubbles:true}));await f.setAccount(null);assert.equal(f.panel.hidden,true);f.form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));f.panel.querySelector('[data-logout]').click();await flush();assert.equal(f.events.filter(x=>x.method!=='GET').length,0);assert.equal(f.form.elements.firstName.value,'Ручной ввод');}finally{f.close();}
});
test('full script refreshes CSRF from verified same-account read before explicit save',async()=>{
 const f=await integration();try{await f.setAccount(user('A'),'b'.repeat(48));assert.equal(f.panel.hidden,false);f.form.elements.firstName.value='Сохранить свой ввод';f.form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await flush();await flush();const writes=f.events.filter(x=>x.method==='PUT');assert.equal(writes.length,1);assert.equal(writes[0].headers['X-CSRF-Token'],'b'.repeat(48));assert.match(f.form.textContent,/Данные сохранены/);}finally{f.close();}
});
test('full script different-account response cannot reuse old form or start any write',async()=>{
 const f=await integration();try{await f.setAccount(user('B'));assert.equal(f.panel.hidden,true);f.form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));f.panel.querySelector('[data-logout]').click();await flush();assert.equal(f.events.filter(x=>x.method!=='GET').length,0);assert.match(f.w.document.querySelector('.sf-account-session-notice').textContent,/Аккаунт изменился/);}finally{f.close();}
});
test('late profile success after account switch is uncertain, never restores old identity or retries',async()=>{
 const f=await integration();try{const resolve=f.holdProfile();f.form.elements.firstName.value='Мой черновик';f.form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();await f.setAccount(user('B'));resolve({status:200,ok:true,json:async()=>({user:user('A')})});await flush();await flush();assert.equal(f.panel.hidden,true);assert.equal(f.w.PalitraAccountView.getSnapshot().user.id,'B');assert.equal(f.events.filter(x=>x.method==='PUT').length,1);assert.match(f.form.textContent,/Сохранение могло завершиться/);assert.doesNotMatch(f.form.textContent,/Данные сохранены/);assert.equal(f.form.elements.firstName.value,'Мой черновик');}finally{f.close();}
});
