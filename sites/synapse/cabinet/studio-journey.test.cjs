const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const scripts=['company-information.js','studio-journey.js'].map(file=>fs.readFileSync(require.resolve('./'+file),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const card=()=>({companyCode:'alvi',leadId:1,name:'Анна <img src=x>',contact:'+7111',createdAt:'2026-09-16T00:00:00Z',source:'vk',revision:0,timezone:'Asia/Irkutsk',state:{status:'new',appointmentAt:null},events:[]});
const commerce=()=>({companyCode:'alvi',leadId:1,revision:0,publication:null,payments:[],totals:[],history:[],publications:[{id:1,title:'Пост <img src=x>'}],basis:'Ручной учёт с основанием'});
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

test('commerce shows read-only history safely and never writes while opening',async()=>{
  const data=commerce();data.publication={postId:1,title:'Пост <img src=x>'};
  const f=fixture({edit:false,query:()=>data});try{
    await f.api.mountCommerce(f.node,f.ctx,1,'Asia/Irkutsk',()=>{});
    assert.equal(f.node.querySelector('form'),null);assert.equal(f.node.querySelector('img'),null);
    assert.match(f.node.textContent,/Пост <img src=x>/);assert.match(f.node.textContent,/Нет записей/);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
  }finally{f.close();}
});

test('payment form retries the identical request after timeout and converts company time',async()=>{
  let attempts=0;const f=fixture({query:call=>{if(call.method==='GET')return commerce();if(++attempts===1)throw Error('Timeout');return {...commerce(),revision:1};}});
  try{await f.api.mountCommerce(f.node,f.ctx,1,'Asia/Irkutsk',()=>{});
    const form=f.node.querySelector('[data-commerce-payment]');
    Object.assign(form.elements.amount,{value:'1500.25'});form.elements.reference.value='receipt-7';form.elements.evidence.value='Кассовый чек';form.elements.occurredAt.value='2026-09-29T17:00';
    const submit=()=>form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));submit();await tick();assert.match(f.node.textContent,/Timeout/);submit();await tick();
    const writes=f.calls.filter(c=>c.method==='POST');assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);
    assert.equal(writes[0].body.amount,1500.25);assert.equal(writes[0].body.occurredAt,'2026-09-29T09:00:00.000Z');assert.equal(writes[0].body.refundOf,undefined);assert.match(f.node.textContent,/Запись сохранена/);
  }finally{f.close();}
});

test('commerce discards late data after a company switch and supports retrying failed reads',async()=>{
  let resolve;const f=fixture({query:()=>new Promise(done=>resolve=done)});try{const pending=f.api.mountCommerce(f.node,f.ctx,1,'Asia/Irkutsk',()=>{});f.ctx.selectedProjectId='avokado';resolve({...commerce(),basis:'PRIVATE COMPANY'});await pending;assert.doesNotMatch(f.node.textContent,/PRIVATE COMPANY/);}finally{f.close();}
  let reads=0;const g=fixture({query:()=>{if(++reads===1)throw Error('Offline');return commerce();}});try{await g.api.mountCommerce(g.node,g.ctx,1,'Asia/Irkutsk',()=>{});g.node.querySelector('[data-retry]').click();await tick();assert.equal(reads,2);assert.ok(g.node.querySelector('[data-commerce-payment]'));}finally{g.close();}
});
