'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createStudioJourney,createStudioJourneyHandler}=require('./studio-journey');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,socials) VALUES(1,'alvi','ALVI','[]'),(2,'avokado','Авокадо','[]');
    CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,name TEXT,contact TEXT,source TEXT,utm_source TEXT);
    INSERT INTO leads VALUES(1,'alvi','2026-09-28T00:00:00.000Z','Тест','','site',''),(2,'avokado','2026-09-28T00:00:00.000Z','Тест','','site','');`);
  const now=()=>Date.parse('2026-09-29T12:00:00Z'),info=createCompanyInformation(db,{now});
  const service={id:'course',title:'Проверенный курс',price:15700,currency:'RUB',procedureCount:5,durationMinutes:60};
  const update=(price,confirm=true)=>{
    info.save('alvi',{revision:info.get('alvi').revision,profile:{services:[{...service,price}]}});
    if(confirm){const data=info.get('alvi');info.save('alvi',{revision:data.revision,profile:{},factConfirmations:data.facts.filter(f=>f.key.startsWith('services/')).map(f=>({factId:f.id,source:'Прайс',sourceRef:'Строка 1',checkedAt:'2026-09-29T11:00:00Z'}))});}
  };
  update(15700);const api=createStudioJourney(db,{now,quoteService:(...args)=>info.quote(...args)});
  const body=()=>({revision:0,requestId:'booking-request-1',type:'booked',appointmentAt:'2026-09-30T12:00:00Z',serviceSelection:{id:'course',knowledgeRevision:info.knowledge('alvi').knowledgeRevision}});
  return {db,api,info,body,update,now};
}
test('booking captures the verified total and quantity; changes do not rewrite it, rescheduling and undo preserve conditions',t=>{
  const f=fixture(t),request=f.body(),booked=f.api.record('alvi',1,request,9);
  assert.equal(booked.state.serviceQuote.service.price,15700);assert.equal(booked.state.serviceQuote.service.procedureCount,5);
  assert.equal(booked.state.serviceQuote.availability,'not_checked');assert.ok(!JSON.stringify(booked.state.serviceQuote).includes('sourceRef'));
  f.update(18000);assert.equal(f.api.get('alvi',1).state.serviceQuote.service.price,15700);
  assert.equal(f.api.record('alvi',1,request,9).events.length,1);
  const moved=f.api.record('alvi',1,{revision:1,requestId:'move-request-1',type:'rescheduled',appointmentAt:'2026-10-01T12:00:00Z',note:'По просьбе клиента'},9);
  assert.deepEqual(moved.state.serviceQuote,booked.state.serviceQuote);
  const restored=f.api.remove('alvi',1,moved.events.at(-1).id,{revision:2,reason:'Ошибка'},9);
  assert.deepEqual(restored.state.serviceQuote,booked.state.serviceQuote);
  assert.equal(createStudioJourney(f.db,{now:f.now}).get('alvi',1).state.serviceQuote.service.price,15700);
});
test('stale, foreign, unverified and client-supplied prices cannot create a booking',t=>{
  const f=fixture(t),stale=f.body();f.update(18000,false);
  assert.throws(()=>f.api.record('alvi',1,stale),e=>e.status===409);
  assert.throws(()=>f.api.record('alvi',1,f.body()),e=>e.status===409);
  f.update(18000);
  assert.throws(()=>f.api.record('avokado',2,f.body()),e=>e.status===409);
  assert.throws(()=>f.api.record('avokado',1,f.body()),e=>e.status===404);
  const forged=f.body();forged.serviceSelection.price=1;
  assert.throws(()=>f.api.record('alvi',1,forged),e=>e.status===400);
  assert.equal(f.api.get('alvi',1).events.length,0);assert.equal(f.api.get('avokado',2).events.length,0);
});
test('catalog selection requires its existing permission; event writes recheck access after the body is read',async t=>{
  const f=fixture(t);let revoked=false,denyCatalog=true;
  const handler=createStudioJourneyHandler({journey:f.api,companyModuleContext(req,code,permission){if(revoked||(denyCatalog&&permission==='company-information.view'))throw Object.assign(Error('Forbidden'),{status:403});return {identity:{userId:9}};},readJson:async req=>{if(req.revoke)revoked=true;return f.body();},send:()=>assert.fail('No write allowed')});
  const url=new URL('https://test/studio-journey/1/events?companyCode=alvi');
  await assert.rejects(handler({method:'POST'},{},url),e=>e.status===403);
  denyCatalog=false;await assert.rejects(handler({method:'POST',revoke:true},{},url),e=>e.status===403);
  assert.equal(f.api.get('alvi',1).events.length,0);
});


test('program booking retains whole visit and guest count after catalog changes and restart',t=>{
  const f=fixture(t),program={id:'spa',title:'SPA',price:6900,currency:'RUB',priceUnit:'program',guestCount:2,visitDurationMinutes:90};
  f.info.importCatalog('alvi',{companyCode:'alvi',revision:f.info.get('alvi').revision,clientImportId:'program-booking-001',entries:[{service:program,source:'Прайс',sourceRef:'Строка программы',checkedAt:'2026-09-29T11:00:00Z'}]});
  const request={...f.body(),serviceSelection:{id:'spa',knowledgeRevision:f.info.knowledge('alvi').knowledgeRevision}};
  const booked=f.api.record('alvi',1,request,9);
  assert.deepEqual(booked.state.serviceQuote.service,program);
  f.update(18000);
  const restored=createStudioJourney(f.db,{now:f.now}).get('alvi',1);
  assert.deepEqual(restored.state.serviceQuote.service,program);
  assert.match(restored.state.serviceQuote.text,/6900 ₽ за программу целиком/);
  assert.doesNotMatch(restored.state.serviceQuote.text,/процедур/);
});

test('minute and two-guest procedure conditions survive catalog replacement and restart',t=>{
  for(const service of [
    {id:'minutes',title:'Тариф',price:990,currency:'RUB',priceUnit:'minutes',minuteCount:30},
    {id:'pair',title:'Массаж',price:5600,currency:'RUB',procedureCount:1,guestCount:2,durationMinutes:60}
  ]){
    const f=fixture(t);
    f.info.importCatalog('alvi',{companyCode:'alvi',revision:f.info.get('alvi').revision,clientImportId:'units-booking-001',entries:[{service,source:'Прайс',sourceRef:'Строка',checkedAt:'2026-09-29T11:00:00Z'}]});
    const request={...f.body(),serviceSelection:{id:service.id,knowledgeRevision:f.info.knowledge('alvi').knowledgeRevision}};
    const booked=f.api.record('alvi',1,request,9);assert.deepEqual(booked.state.serviceQuote.service,service);
    f.update(18000);
    assert.deepEqual(createStudioJourney(f.db,{now:f.now}).get('alvi',1).state.serviceQuote.service,service);
  }
});
