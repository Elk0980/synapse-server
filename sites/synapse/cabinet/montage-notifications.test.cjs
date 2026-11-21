'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const script=fs.readFileSync(require.resolve('./module-registry.js'),'utf8');
function fixture(t){
 const dom=new JSDOM('<a data-view-link="content-materials">Монтаж</a>',{url:'https://cabinet.test',runScripts:'outside-only'});
 t.after(()=>dom.window.close());const w=dom.window,calls=[];
 let user={userId:7,role:'editor',permissions:['autoposting.view'],csrfToken:'SAMPLE'},company={id:'avokado'};
 let respond=async()=>({enabled:true,companyCode:company.id,count:2,reels:[{reelId:21,count:2,throughId:7,newVersion:1}]});
 w.fetch=async()=>({ok:true,json:async()=>({commit:'SAMPLE'})});w.eval(script);
 w.SynapseModules.attachShell({identity:()=>user,company:()=>company,apiJson:async(url,options)=>{calls.push({url,options});return respond(url,options);},escapeHTML:x=>x});
 return {w,calls,n:w.SynapseModules.montageNotifications,user:value=>user=value,company:value=>company=value,respond:fn=>respond=fn};
}
test('счётчик Монтаж работает вне экрана; mark-read использует существующую сессию/CSRF; logout и view-as очищают состояние',async t=>{
 const f=fixture(t);await f.n.refresh();assert.equal(f.w.document.querySelector('[data-montage-count]').textContent,'2');
 await f.n.read(21,7);const sent=f.calls.at(-1);assert.equal(sent.options.headers['X-CSRF-Token'],'SAMPLE');
 assert.deepEqual(JSON.parse(sent.options.body),{throughId:7});
 f.user({userId:7,role:'owner',viewAs:{userId:8}});await f.n.refresh();assert.equal(f.n.snapshot(),null);assert.equal(f.w.document.querySelector('[data-montage-count]'),null);
 f.user(null);await f.n.refresh();assert.equal(f.n.snapshot(),null);
});
test('поздний ответ старого проекта/аккаунта не возвращает чужой счётчик, OFF не показывает отметки',async t=>{
 const f=fixture(t);await f.n.refresh();let finish;
 f.respond(()=>new Promise(resolve=>finish=resolve));const old=f.n.refresh();
 f.company({id:'alvi'});f.respond(async()=>({enabled:false,companyCode:'alvi',count:0,reels:[]}));await f.n.refresh();
 finish({enabled:true,companyCode:'avokado',count:9,reels:[]});await old;
 assert.equal(f.n.snapshot(),null);assert.equal(f.w.document.querySelector('[data-montage-count]'),null);
 f.user({userId:8,role:'editor',permissions:[],csrfToken:'SAMPLE2'});await f.n.refresh();assert.equal(f.n.snapshot(),null);
});
test('сбой сети сохраняет непрочитанное; отзыв доступа очищает прежний счётчик',async t=>{
 const f=fixture(t);await f.n.refresh();f.respond(async()=>{throw Error('SAMPLE offline');});await f.n.refresh();
 assert.equal(f.n.snapshot().count,2);f.respond(async()=>{throw Object.assign(Error('SAMPLE revoked'),{status:403});});await f.n.refresh();
 assert.equal(f.n.snapshot(),null);assert.equal(f.w.document.querySelector('[data-montage-count]'),null);
});
test('старый GET после успешного mark-read не возвращает уже прочитанный badge',async t=>{
 const f=fixture(t);await f.n.refresh();let finish;
 f.respond((url,options)=>options?.method==='POST'?Promise.resolve({enabled:true,companyCode:'avokado',count:0,reels:[]}):new Promise(resolve=>finish=resolve));
 const old=f.n.refresh();await f.n.read(21,7);finish({enabled:true,companyCode:'avokado',count:2,reels:[{reelId:21,count:2,throughId:7}]});await old;
 assert.equal(f.n.snapshot().count,0);assert.equal(f.w.document.querySelector('[data-montage-count]'),null);
});
