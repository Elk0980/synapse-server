const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const scripts=['company-information.js','studio-journey.js'].map(file=>fs.readFileSync(require.resolve('./'+file),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const card=()=>({companyCode:'alvi',leadId:1,name:'Анна <img src=x>',contact:'+7111',createdAt:'2026-09-16T00:00:00Z',source:'vk',revision:0,timezone:'Asia/Irkutsk',state:{status:'new',appointmentAt:null},events:[]});
function fixture({edit=true,query}={}){
  const dom=new JSDOM('<section id="view" class="studio-journey"></section>',{url:'https://test.local',runScripts:'outside-only'}),w=dom.window,node=w.document.getElementById('view'),calls=[];
  w.SbCabinet={registerView(){}};scripts.forEach(script=>w.eval(script));
  const ctx={identity:{role:edit?'owner':'editor',permissions:['crm.view'],companies:[{id:'alvi',name:'АЛВИ'},{id:'avokado',name:'Авокадо'}]},selectedProjectId:'alvi',scopeParams:()=>({companyCode:ctx.selectedProjectId}),
    csrfOptions:(method,body)=>({method,body:JSON.stringify(body)}),crmQuery:async(path,params,options={})=>{const call={path,params,method:options.method||'GET',body:options.body?JSON.parse(options.body):null};calls.push(call);return query?query(call):card();}};
  return {dom,w,node,calls,ctx,api:w.SbCabinet.studioJourney,close:()=>w.close()};
}
test('read-only card provides manual reminder drafts without writes or invented contact links',async()=>{
  const f=fixture({edit:false});try{await f.api.mountCard(f.node,f.ctx,1);assert.equal(f.node.querySelector('form'),null);f.node.querySelector('[data-draft=confirm]').click();
    assert.match(f.node.querySelector('[data-reminder]').value,/АЛВИ/);assert.equal(f.node.querySelector('img'),null);assert.equal(f.calls.length,1);assert.equal(f.calls[0].params.companyCode,'alvi');assert.equal(f.calls[0].method,'GET');
  }finally{f.close();}
});
test('appointment form converts the company time to UTC and never writes to the old lead status',async()=>{
  const f=fixture({query:call=>{const result=card();if(call.method==='POST'){result.revision=1;result.state={status:'booked',appointmentAt:call.body.appointmentAt};}return result;}});
  try{await f.api.mountCard(f.node,f.ctx,1);const form=f.node.querySelector('[data-journey-form]');form.elements.appointmentAt.value='2026-09-18T18:00';form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
    const write=f.calls.find(c=>c.method==='POST');assert.equal(write.path,'/studio-journey/1/events');assert.equal(write.params.companyCode,'alvi');assert.equal(write.body.appointmentAt,'2026-09-18T10:00:00.000Z');assert.equal(write.body.occurredAt,undefined);assert.equal(write.body.type,'booked');assert.equal(write.body.revision,0);assert.ok(write.body.requestId);assert.match(f.node.textContent,/Отметка сохранена/);assert.ok(f.calls.every(c=>!c.path.startsWith('/leads')));
  }finally{f.close();}
});
test('stale card responses are discarded after the selected company changes',async()=>{
  let finish;const f=fixture({query:()=>new Promise(resolve=>finish=resolve)});try{const pending=f.api.mountCard(f.node,f.ctx,1);f.ctx.selectedProjectId='avokado';finish({...card(),name:'PRIVATE ALVI'});await pending;assert.doesNotMatch(f.node.textContent,/PRIVATE ALVI/);assert.equal(f.node.querySelector('form'),null);}finally{f.close();}
});
test('membership requires paid amount and evidence; a reschedule requires a reason',async()=>{
  for(const state of ['visited','confirmed']){
    const f=fixture({query:()=>({...card(),state:{status:state,appointmentAt:'2026-09-16T12:00:00.000Z'}})});try{await f.api.mountCard(f.node,f.ctx,1);const form=f.node.querySelector('form');
      if(state==='visited'){assert.equal(form.elements.type.value,'membership');assert.equal(form.elements.amount.required,true);assert.equal(form.elements.evidence.required,true);assert.match(f.node.textContent,/Проверка чека и финансовый учёт выполняются отдельно/);}
      else{form.elements.type.value='rescheduled';form.elements.type.dispatchEvent(new f.w.Event('change'));assert.equal(form.elements.note.required,true);assert.equal(form.elements.appointmentAt.required,true);}
    }finally{f.close();}
  }
});
test('summary shares the dashboard period and source, and ignores superseded replies',async()=>{
  const pending=[],summary={leads:2,booked:1,confirmed:1,visited:1,memberships:0,noShows:0,reschedules:0,noShowRate:0};
  const f=fixture({query:()=>new Promise(resolve=>pending.push(resolve))});try{
    const range={from:'2026-09-16T21:00:00.000Z',to:'2026-09-17T09:00:00.000Z'};
    const first=f.api.mountSummary(f.node,f.ctx,{source:'vk',range});const second=f.api.mountSummary(f.node,f.ctx,{source:'site',range});
    assert.equal(f.calls[1].params.from,range.from);assert.equal(f.calls[1].params.to,range.to);assert.equal(f.calls[1].params.source,'site');
    pending[1]({summary,timezone:'Asia/Irkutsk',sources:[{...summary,source:'CURRENT'}]});await second;
    pending[0]({summary,timezone:'Asia/Irkutsk',sources:[{...summary,source:'STALE'}]});await first;
    assert.match(f.node.textContent,/CURRENT/);assert.doesNotMatch(f.node.textContent,/STALE/);assert.match(f.node.textContent,/Каждая заявка считается один раз/);
  }finally{f.close();}
});
