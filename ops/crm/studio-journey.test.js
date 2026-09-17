'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createStudioJourney,createStudioJourneyHandler}=require('./studio-journey');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name,timezone) VALUES(1,'alvi','ALVI','Asia/Irkutsk'),(2,'avokado','Авокадо','Asia/Irkutsk');
    CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,name TEXT,contact TEXT,source TEXT,utm_source TEXT,stage TEXT,sale_amount REAL);
    INSERT INTO leads VALUES(1,'alvi','2026-09-16T00:00:00.000Z','Анна','+7111','vk','vk','продажа',90000),(2,'avokado','2026-09-16T00:00:00.000Z','Ольга','+7222','vk','vk','новая',NULL),(3,'alvi','2026-09-16T00:00:00.000Z','Ира','+7333','site','yandex','новая',NULL);`);
  let time=Date.parse('2026-09-17T08:00:00Z'),sequence=0;const api=createStudioJourney(db,{now:()=>time});
  const record=(type,more={},id=1,code='alvi')=>api.record(code,id,{revision:api.get(code,id).revision,requestId:'request-'+(++sequence),type,...more},9);
  return {db,api,record,advance:()=>time+=3600000};
}
test('journeys require the selected company and old sale marks do not manufacture visits or memberships',t=>{
  const f=fixture(t),metrics=f.api.list('alvi');assert.equal(metrics.summary.leads,2);assert.equal(metrics.summary.visited,0);assert.equal(metrics.summary.memberships,0);assert.equal(metrics.summary.noShowRate,null);
  assert.equal(f.api.get('alvi',1).state.status,'new');assert.throws(()=>f.api.get('avokado',1),e=>e.status===404);
  assert.throws(()=>f.api.record('avokado',1,{revision:0,requestId:'request-001',type:'booked',appointmentAt:'2026-09-18T08:00:00Z'}),e=>e.status===404);
  assert.equal(f.api.list('avokado').leads.length,1);assert.throws(()=>f.api.list(''),e=>e.status===400);
});
test('appointments, confirmations, attendance, paid membership and cohort source metrics are factual and separate from old fields',t=>{
  const f=fixture(t);f.record('booked',{appointmentAt:'2026-09-17T08:00:00Z'});f.record('confirmed');f.record('visited');
  assert.throws(()=>f.record('membership',{membershipName:'Курс',amount:3000}),e=>e.status===400);
  f.record('membership',{membershipName:'Курс',amount:3000.50,evidence:'Чек 7'});
  const m=f.api.list('alvi');assert.equal(m.summary.booked,1);assert.equal(m.summary.confirmed,1);assert.equal(m.summary.visited,1);assert.equal(m.summary.memberships,1);assert.equal(m.summary.membershipRate,100);
  assert.equal(m.sources.find(s=>s.source==='vk').memberships,1);assert.equal(m.sources.find(s=>s.source==='yandex').memberships,0);
  assert.equal(f.api.list('alvi',{source:'site'}).summary.memberships,0);
  assert.equal(f.api.list('alvi',{source:'site'}).summary.leads,1);
  assert.equal(f.api.get('alvi',1).events.at(-1).amountCents,300050);
  assert.equal(f.db.prepare('SELECT sale_amount FROM leads WHERE id=1').get().sale_amount,90000);
  assert.equal(f.api.list('alvi',{from:'2026-09-17T00:00:00Z'}).summary.leads,0);
});
test('rescheduling invalidates the confirmation; future visits cannot be marked attended or missed, and retries cannot duplicate events',t=>{
  const f=fixture(t);assert.throws(()=>f.record('visited'),e=>e.status===409);
  f.record('booked',{appointmentAt:'2026-09-18T08:00:00Z'});f.record('confirmed');
  assert.throws(()=>f.record('no_show',{note:'Неизвестна'}),e=>e.status===400);
  assert.throws(()=>f.record('visited'),e=>e.status===400);
  assert.throws(()=>f.record('rescheduled',{appointmentAt:'2026-09-19T08:00:00Z'}),e=>e.status===400);
  const p=f.record('rescheduled',{appointmentAt:'2026-09-17T08:00:00Z',note:'Попросила пораньше'});assert.equal(p.state.status,'rescheduled');
  const body={revision:p.revision,requestId:'duplicate-attempt',type:'no_show',note:'Не ответила'};
  const first=f.api.record('alvi',1,body);const retry=f.api.record('alvi',1,body);assert.equal(first.revision,retry.revision);
  const m=f.api.list('alvi').summary;assert.equal(m.noShows,1);assert.equal(m.noShowRate,100);assert.equal(m.reschedules,1);
  f.record('booked',{appointmentAt:'2026-09-17T08:00:00Z'});f.record('visited');
  assert.equal(f.api.list('alvi').summary.noShowRate,50);assert.equal(f.api.list('alvi').summary.visited,1);
});
test('revision conflicts and undo preserve an audit trail without breaking dependent later events',t=>{
  const f=fixture(t),booked=f.record('booked',{appointmentAt:'2026-09-17T08:00:00Z'}),confirmed=f.record('confirmed');
  assert.throws(()=>f.api.record('alvi',1,{revision:0,requestId:'stale-version',type:'visited'}),e=>e.status===409);
  assert.throws(()=>f.api.remove('alvi',1,booked.events[0].id,{revision:confirmed.revision,reason:'Ошибка'}),e=>e.status===409);
  const undone=f.api.remove('alvi',1,confirmed.events.at(-1).id,{revision:confirmed.revision,reason:'Клиент не подтвердил'},9);
  assert.equal(undone.state.status,'booked');assert.equal(undone.events.length,2);assert.equal(undone.events[1].voidReason,'Клиент не подтвердил');assert.equal(f.api.list('alvi').summary.confirmed,0);
  assert.throws(()=>f.api.remove('avokado',1,1,{revision:0,reason:'Ошибка'}),e=>e.status===404);
});
test('future tolerance on event entry does not permit recording a future attendance or ancient appointment',t=>{
  const f=fixture(t);
  assert.throws(()=>f.record('booked',{appointmentAt:'2000-01-01T00:00:00Z'}),e=>e.status===400);
  f.record('booked',{appointmentAt:'2026-09-17T08:00:30Z'});
  assert.throws(()=>f.record('visited',{occurredAt:'2026-09-17T08:01:00Z'}),e=>e.status===400);
  assert.throws(()=>f.record('no_show',{occurredAt:'2026-09-17T08:01:00Z',note:'Неизвестна'}),e=>e.status===400);
  assert.equal(f.api.get('alvi',1).state.status,'booked');
});
test('HTTP adapter authorizes company and permission before reading or mutating data',async t=>{
  const f=fixture(t),calls=[],responses=[];
  const handler=createStudioJourneyHandler({journey:f.api,companyModuleContext(req,code,permission){calls.push({code,permission});if(code!=='alvi')throw Object.assign(Error('Forbidden'),{status:403});return {identity:{userId:9}};},readJson:async req=>req.body,send:(_response,status,result,headers)=>responses.push({status,result,headers})});
  assert.equal(await handler({method:'GET'},{},new URL('https://test/other')),false);
  assert.equal(await handler({method:'GET'},{},new URL('https://test/studio-journey?companyCode=alvi')),true);
  assert.equal(calls.at(-1).permission,'crm.view');assert.equal(responses.at(-1).headers['cache-control'],'no-store');
  await assert.rejects(handler({method:'GET'},{},new URL('https://test/studio-journey/1?companyCode=avokado')),e=>e.status===403);
  await handler({method:'POST',body:{revision:0,requestId:'http-request-1',type:'booked',appointmentAt:'2026-09-17T08:00:00Z'}},{},new URL('https://test/studio-journey/1/events?companyCode=alvi'));
  assert.equal(calls.at(-1).permission,'crm.edit');assert.equal(responses.at(-1).status,201);
});
