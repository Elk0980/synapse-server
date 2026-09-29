'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,phone,socials) VALUES(1,'alvi','ALVI','old','[]'),(2,'avokado','Авокадо','other','[]');`);
  const now=()=>Date.parse('2026-09-29T12:00:00Z'),api=createCompanyInformation(db,{now});
  const proof=fact=>({factId:fact.id,source:'Прайс клиента',sourceRef:'Документ 29.09, строка 1',checkedAt:'2026-09-29T11:00:00Z'});
  const find=(data,key)=>data.facts.find(f=>f.key===key);
  return {api,db,now,proof,find};
}
test('import is unverified; evidence binds to a value and replacement forms an immutable chain',t=>{
  const {api,db,now,proof,find}=fixture(t);let data=api.get('alvi'),original=find(data,'phone');
  assert.equal(original.status,'unverified');assert.equal(original.checkedAt,'');assert.equal(original.supersedesId,null);
  data=api.save('alvi',{revision:data.revision,profile:{},factConfirmations:[proof(original)]},7);
  assert.equal(data.revision,1,'source verification does not change the content revision or stale a scheduled publication');
  const checked=find(data,'phone');assert.equal(checked.status,'confirmed');assert.equal(checked.supersedesId,original.id);
  data=api.save('alvi',{revision:data.revision,profile:{phone:'new'}},7);
  const changed=find(data,'phone');assert.equal(changed.status,'unverified');assert.equal(changed.source,'');assert.equal(changed.supersedesId,checked.id);
  assert.throws(()=>api.save('alvi',{revision:data.revision,profile:{},factConfirmations:[proof(checked)]},7),e=>e.status===409);
  const restored=createCompanyInformation(db,{now}).get('alvi');assert.equal(restored.revision,data.revision);
  const history=api.factHistory('alvi','phone').facts;assert.equal(history.length,3);assert.equal(history[1].value,'old');assert.equal(history[1].source,'Прайс клиента');
  assert.equal(find(restored,'phone').id,changed.id);
  assert.throws(()=>db.prepare("UPDATE company_fact_versions SET source='fake'").run(),/Immutable/);
  assert.throws(()=>db.prepare('DELETE FROM company_fact_versions').run(),/Immutable/);
});
test('service IDs preserve evidence on reorder; changed price and deleted service require new proof',t=>{
  const {api,proof,find}=fixture(t);let data=api.get('alvi');
  const services=[{id:'a/b',title:'Массаж',price:3500},{id:'b',title:'Уход',price:490}];
  data=api.save('alvi',{revision:data.revision,profile:{services}},7);
  const key='services/a%2Fb/price';data=api.save('alvi',{revision:data.revision,profile:{},factConfirmations:[proof(find(data,key))]},7);
  const checked=find(data,key);data=api.save('alvi',{revision:data.revision,profile:{services:[services[1],services[0]]}},7);
  assert.equal(find(data,key).id,checked.id);
  data=api.save('alvi',{revision:data.revision,profile:{services:[{...services[0],price:3600},services[1]]}},7);
  assert.equal(find(data,key).status,'unverified');assert.equal(find(data,key).value,3600);
  data=api.save('alvi',{revision:data.revision,profile:{services:[services[1]]}},7);
  assert.equal(find(data,key).removed,true);assert.equal(find(data,key).status,'unverified');assert.equal(find(data,'services/b/price').value,490);
});
test('foreign evidence, future dates and invalid batches cannot partly mutate profile or confirmations',t=>{
  const {api,proof,find}=fixture(t);let data=api.get('alvi');const other=find(api.get('avokado'),'phone');
  const original=find(data,'phone'),valid=proof(original);
  for(const entries of [[proof(other)],[{...valid,sourceRef:''}],[{...valid,checkedAt:'2026-09-30T00:00:00Z'}],
    [{...valid,checkedAt:'2026-02-31T00:00:00Z'}],[valid,{...proof(find(data,'name')),source:''}],[valid,valid]]) {
    assert.throws(()=>api.save('alvi',{revision:data.revision,profile:{city:'Нельзя сохранить'},factConfirmations:entries},7));
    const next=api.get('alvi');assert.equal(next.revision,data.revision);assert.equal(next.profile.city,'');assert.equal(find(next,'phone').id,original.id);
  }
  assert.deepEqual(api.factHistory('avokado','services/a/price').facts,[]);
});
