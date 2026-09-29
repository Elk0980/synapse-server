'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createStudioCommerce}=require('./studio-commerce');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code) VALUES(1,'alvi'),(2,'avokado');
    CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,sale_amount REAL);
    INSERT INTO leads VALUES(1,'alvi','2026-01-01T00:00:00.000Z',99000),(2,'avokado','2026-01-01T00:00:00.000Z',55000),(3,'alvi','2026-01-01T00:00:00.000Z',0);
    CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,company_id INTEGER,title TEXT,status TEXT);
    INSERT INTO autoposting_posts VALUES(1,1,'Пост ALVI','published'),(2,2,'Пост Авокадо','published'),(3,1,'Черновик','draft');
    CREATE TABLE autoposting_publication_receipts(id INTEGER PRIMARY KEY,post_id INTEGER);`);
  const api=createStudioCommerce(db,{now:()=>Date.parse('2026-09-29T12:00:00Z')});let seq=0;
  const body=(more={})=>({revision:api.get('alvi',1).revision,requestId:'request-'+(++seq),type:'received',amount:1000,currency:'RUB',reference:'receipt-'+seq,evidence:'Чек кассы',occurredAt:'2026-09-29T10:00:00Z',...more});
  return {api,db,body};
}
test('publication attribution is company-scoped, proven and retains corrections',t=>{
  const {api}=fixture(t);const input={revision:0,requestId:'source-0001',postId:1,evidence:'Клиент указал публикацию'};
  assert.throws(()=>api.publication('alvi',1,{...input,postId:2}),e=>e.status===404);
  assert.throws(()=>api.publication('alvi',1,{...input,postId:3}),e=>e.status===409);
  assert.throws(()=>api.publication('avokado',1,input),e=>e.status===404);
  let value=api.publication('alvi',1,input,7);assert.equal(value.publication.title,'Пост ALVI');assert.equal(value.revision,1);
  assert.equal(api.publication('alvi',1,input,7).revision,1);
  assert.throws(()=>api.publication('alvi',1,{...input,evidence:'Изменили'}),e=>e.status===409);
  value=api.publication('alvi',1,{revision:1,requestId:'source-0002',postId:null,evidence:'Ошибочная привязка'},7);
  assert.equal(value.publication.postId,null);assert.equal(value.history.length,2);assert.equal(value.history[0].data.postId,1);
});
test('payment references and request IDs prevent double counting across retries and leads',t=>{
  const {api,body}=fixture(t);assert.deepEqual(api.get('alvi',1).totals,[]);
  const input=body({amount:1200.55});let value=api.payment('alvi',1,input,7);
  assert.deepEqual(value.totals,[{currency:'RUB',receivedCents:120055,refundedCents:0,netCents:120055}]);
  assert.equal(api.payment('alvi',1,input,7).revision,1);
  assert.throws(()=>api.payment('alvi',1,{...input,amount:2}),e=>e.status===409);
  assert.throws(()=>api.payment('alvi',3,{...input,requestId:'another-001'}),e=>e.status===409);
  assert.equal(api.get('alvi',3).history.length,0);
  assert.throws(()=>api.payment('avokado',1,input),e=>e.status===404);
  api.payment('avokado',2,input,8);assert.equal(api.get('avokado',2).totals[0].netCents,120055);
});
test('partial refunds retain original payment, respect remaining balance and separate currencies',t=>{
  const {api,body}=fixture(t);let value=api.payment('alvi',1,body());const original=value.payments[0].id;
  value=api.payment('alvi',1,body({type:'refund',refundOf:original,amount:250}));
  assert.equal(value.totals[0].netCents,75000);
  assert.throws(()=>api.payment('alvi',1,body({type:'refund',refundOf:original,amount:750.01})),e=>e.status===409);
  assert.throws(()=>api.payment('alvi',1,body({type:'refund',refundOf:original,currency:'USD'})),e=>e.status===409);
  assert.throws(()=>api.payment('alvi',1,body({type:'refund',refundOf:original,amount:50,occurredAt:'2026-09-28T00:00:00Z'})),e=>e.status===400);
  value=api.payment('alvi',1,body({amount:20,currency:'USD'}));
  assert.equal(value.totals.length,2);assert.equal(value.totals.find(row=>row.currency==='USD').netCents,2000);
  assert.equal(value.payments[0].data.amountCents,100000);
});
test('bad data and reference insertion failures roll back; no invented historic payments',t=>{
  const {api,db,body}=fixture(t);
  for(const patch of [{amount:0},{amount:1.001},{currency:''},{evidence:''},{reference:''},{occurredAt:'2026-02-30T00:00:00Z'},{occurredAt:'2027-01-01T00:00:00Z'}])
    assert.throws(()=>api.payment('alvi',1,body(patch)),e=>e.status===400);
  db.exec("CREATE TRIGGER reject_ref BEFORE INSERT ON studio_payment_references BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(()=>api.payment('alvi',1,body()),/test failure/);
  assert.equal(api.get('alvi',1).revision,0);assert.deepEqual(api.get('alvi',1).totals,[]);
  db.exec('DROP TRIGGER reject_ref');assert.equal(api.payment('alvi',1,body()).revision,1);
  assert.equal(db.prepare('SELECT sale_amount FROM leads WHERE id=1').get().sale_amount,99000);
});

test('cohort groups current attribution and ledger once, without importing old sales or foreign leads',t=>{
  const {api,body}=fixture(t);
  api.publication('alvi',1,{revision:0,requestId:'source-001',postId:1,evidence:'Подтверждение'});
  let result=api.payment('alvi',1,body({amount:800}));
  api.payment('alvi',1,body({type:'refund',refundOf:result.payments[0].id,amount:100}));
  api.payment('avokado',2,{...body({amount:999}),revision:0});
  const cohort=api.cohort('alvi',[{id:1},{id:3}],new Map([[1,['booked','rescheduled','visited']]]));
  assert.equal(cohort.length,2);const linked=cohort.find(row=>row.postId===1);
  assert.equal(linked.leads,1);assert.equal(linked.booked,1);assert.equal(linked.visited,1);assert.equal(linked.paidLeads,1);assert.equal(linked.totals[0].netCents,70000);
  assert.deepEqual(cohort.find(row=>row.postId===null).totals,[]);
  assert.deepEqual(api.cohort('alvi',[],new Map()),[]);
  assert.equal(api.get('alvi',1).publications.length,1);
});
