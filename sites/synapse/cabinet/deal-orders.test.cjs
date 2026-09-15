const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setImmediate(r));
test('funnel editor preserves separate instruction lines, colors, ordering and criteria',async()=>{
 const dom=new JSDOM('<div id="view"><div id="order-workspace"></div><div id="deals-legacy"></div></div>',{url:'https://example.test/#deals',runScripts:'outside-only'}),w=dom.window;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 let saved;const stages=[{code:'new',label:'Новый',kind:'open',color:'#aabbcc',rules:{required:[],manual:['Первое','Второе']},steps:['Позвонить','Согласовать'],done:'Готово'}];
 w.SbCabinet={registerView:(key,v)=>w.view=v};w.eval(fs.readFileSync(__dirname+'/deal-orders.js','utf8'));
 const ctx={identity:{role:'owner'},hasPermission:()=>true,escapeHTML:s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),scopeParams:()=>({companyCode:'qa'}),csrfOptions:(method,body)=>({method,body}),crmQuery:async(path,p,o)=>{if(o.method==='PUT'){saved=o.body;return {stages};}return path==='/deals/criteria'?{stages,criterionLabels:{receipt:'Чек'}}:{deals:[],total:0,stages,pipelines:[{code:'sale',label:'Продажи'}]};}};
 await w.view.render(w.document.querySelector('#view'),ctx);w.document.querySelector('[data-order-rules]').click();await tick();
 assert.equal(w.document.querySelector('[data-key=steps]').value,'Позвонить\nСогласовать');w.document.querySelector('[data-key=color]').value='#112233';w.document.querySelector('dialog form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(saved.stages[0].color,'#112233');assert.deepEqual(Array.from(saved.stages[0].manual),['Первое','Второе']);assert.deepEqual(Array.from(saved.stages[0].steps),['Позвонить','Согласовать']);dom.window.close();
});
