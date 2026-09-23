const test=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const script=fs.readFileSync(require.resolve('./mobile-install.js'),'utf8');
async function fixture(ua,installed=false) {
 const dom=new JSDOM('<div id="app"><div class="sidebar-footer"></div></div>',{url:'https://demo.test',runScripts:'outside-only'});
 const w=dom.window;let subscribed=0;
 Object.defineProperty(w.navigator,'userAgent',{value:ua});
 w.matchMedia=()=>({matches:installed});w.Notification={permission:'default'};w.PushManager=function(){};
 w.fetch=async()=>({ok:true,json:async()=>({ready:true,publicKey:'BA'})});
 const registration={pushManager:{getSubscription:async()=>null,subscribe:async()=>{subscribed++;return {toJSON:()=>({})};}}};
 Object.defineProperty(w,'isSecureContext',{value:true});
 Object.defineProperty(w.navigator,'serviceWorker',{value:{register:async()=>registration,ready:Promise.resolve(registration)}});
 w.eval(script);await w.SbCabinet.initMobileInstall({csrfToken:'test'});
 return {w,dom,getSubscribed:()=>subscribed,find:s=>w.document.querySelector(s)};
}
test('iPhone explains Home Screen prerequisite and never asks permission on load',async()=>{
 const f=await fixture('iPhone Safari');
 assert.match(f.find('ol').textContent,/На экран Домой/);
 assert.equal(f.find('[data-push]').disabled,true);assert.equal(f.getSubscribed(),0);f.dom.window.close();
});
test('Android enables opt-in, and Later hides the sheet',async()=>{
 const f=await fixture('Android Chrome');
 assert.equal(f.find('[data-push]').disabled,false);assert.equal(f.getSubscribed(),0);
 f.find('[data-later]').click();assert.equal(f.find('.mobile-install').hidden,true);
 assert.ok(f.w.localStorage.getItem('sb.mobile-install.snooze'));f.dom.window.close();
});
test('installed iPhone skips installation instructions',async()=>{
 const f=await fixture('iPhone Safari',true);
 assert.equal(f.find('ol').hidden,true);assert.equal(f.find('[data-push]').disabled,false);f.dom.window.close();
});
test('embedded browser gets external browser instructions',async()=>{
 const f=await fixture('Android Telegram');assert.match(f.find('ol').textContent,/Открыть в браузере/);f.dom.window.close();
});
