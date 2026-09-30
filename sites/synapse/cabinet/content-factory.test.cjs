const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync(path.join(__dirname,'../cabinet.html'),'utf8');
const parsed=new JSDOM(html);
const shell=[...parsed.window.document.querySelectorAll('script:not([src])')].map(n=>n.textContent).find(t=>t.includes('canonicalSiteEditors'));
parsed.window.close();
function page(hash='#content-factory',permissions=['autoposting.view'],role='client'){
 const errors=[],renders=[];
 const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html,{url:'https://cabinet.test/cabinet.html'+hash,runScripts:'outside-only',virtualConsole:vc,pretendToBeVisual:true});
 const w=dom.window,d=w.document;
 w.matchMedia=q=>({matches:false,media:q,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};
 const views={};
 for(const view of ['autoposting','media-mentor-rollout'])views[view]={render(node,ctx){renders.push([view,ctx.selectedProjectId]);if(!node.firstChild)node.innerHTML='<input aria-label="Черновик">';},onProjectChange(ctx){renders.push([view,ctx.selectedProjectId]);}};
 w.SbCabinet={views:new Proxy(views,{get:(o,k)=>o[k]||{render(){},initialize(){},updateSummary(){}}}),registerView(){},renderModuleGuide(){}};
 w.localStorage.setItem('sb-menu-v1:qa',JSON.stringify({favorites:['autoposting','media-mentor-rollout','content-factory']}));
 w.eval(fs.readFileSync(path.join(__dirname,'menu-preferences.js'),'utf8'));
 w.fetch=async()=>({ok:true,status:200,json:async()=>({login:'qa',displayName:'QA',role,permissions,csrfToken:'qa',companies:[{id:'one',name:'Первый'},{id:'two',name:'Второй'}]})});
 w.eval(shell);
 const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setTimeout(r,0));};
 return {w,d,errors,renders,settle,close:()=>w.close(),visible:id=>!d.getElementById(id).hidden};
}
test('один пункт, старое избранное, переходы и сохранение редактора',async()=>{
 const f=page();try{
 await f.settle();const {w,d}=f;
 assert.equal(w.location.hash,'#content-factory/materials');
 assert.equal(d.querySelectorAll('#marketing-menu [data-view-link="content-factory"]').length,1);
 assert.equal(d.querySelector('#autoposting-link'),null);assert.equal(d.querySelector('#media-mentor-rollout-link'),null);
 assert.equal(d.querySelectorAll('.menu-favorites a').length,1);
 assert.equal(d.querySelector('.menu-favorites a').textContent,'Контент завод');
 const input=d.querySelector('#autoposting-view input');input.value='Несохранённый материал';
 d.querySelector('[href="#content-factory/progress"]').click();await f.settle();
 assert.ok(f.visible('media-mentor-rollout-view'));assert.ok(!f.visible('autoposting-view'));
 assert.equal(d.getElementById('mobile-title').textContent,'Контент завод');assert.match(d.title,/^Контент завод — /);
 assert.equal(d.getElementById('content-factory-link').getAttribute('aria-current'),'page');
 w.history.back();await f.settle();assert.ok(f.visible('autoposting-view'));assert.equal(input.value,'Несохранённый материал');
 w.history.forward();await f.settle();assert.ok(f.visible('media-mentor-rollout-view'));
 d.querySelector('[href="#content-factory/materials"]').click();await f.settle();assert.equal(input,d.querySelector('#autoposting-view input'));
 assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
for(const [old,canonical,view] of [['autoposting','materials','autoposting'],['media-mentor-rollout','progress','media-mentor-rollout']])test('старая ссылка '+old,async()=>{
 const f=page('#'+old);try{await f.settle();assert.equal(f.w.location.hash,'#content-factory/'+canonical);assert.ok(f.visible(view+'-view'));assert.deepEqual(f.errors,[]);}finally{f.close();}
});
test('общее право не открывает материалы без прежнего разрешения',async()=>{
 const f=page('#content-factory',['content-factory.view']);try{
 await f.settle();assert.ok(f.visible('content-factory-view'));assert.equal(f.renders.length,0);
 assert.ok([...f.d.querySelectorAll('[data-factory-view]')].every(n=>n.hidden));
 f.w.location.hash='#content-factory/progress';await f.settle();assert.ok(f.visible('access-denied-view'));assert.equal(f.renders.length,0);
 }finally{f.close();}
});
test('без прав единый пункт скрыт и прямая ссылка закрыта',async()=>{
 const f=page('#content-factory/materials',[]);try{await f.settle();assert.ok(!f.visible('content-factory-link'));assert.ok(f.visible('access-denied-view'));assert.equal(f.renders.length,0);}finally{f.close();}
});
test('смена компании сохраняет вкладку и передаёт новый контекст',async()=>{
 const f=page('#content-factory/progress');try{await f.settle();[...f.d.querySelectorAll('#project-menu button')].find(n=>n.textContent.includes('Второй')).click();await f.settle();assert.equal(f.w.location.hash,'#content-factory/progress');assert.deepEqual(f.renders.at(-1),['media-mentor-rollout','two']);}finally{f.close();}
});
