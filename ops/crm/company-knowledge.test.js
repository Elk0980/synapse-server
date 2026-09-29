'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,socials) VALUES(1,'alvi','ALVI','[]'),(2,'avokado','Авокадо','[]');`);
  const now=()=>Date.parse('2026-09-29T12:00:00Z'),api=createCompanyInformation(db,{now});
  function confirm(code,keys){
    const data=api.get(code);
    return api.save(code,{revision:data.revision,profile:{},factConfirmations:data.facts.filter(f=>keys.includes(f.key)).map(f=>({factId:f.id,
      source:'Документ клиента',sourceRef:'Прайс, строка 1',checkedAt:'2026-09-29T11:00:00Z'}))});
  }
  function save(code,profile){return api.save(code,{revision:api.get(code).revision,profile});}
  return {api,db,confirm,save};
}
const service={id:'massage/60',title:'Массаж 60 минут',price:3500,currency:'RUB',durationMinutes:60,description:'Одна процедура'};
const keys=Object.keys(service).filter(k=>k!=='id').map(k=>'services/massage%2F60/'+k);

test('legacy values stay outside knowledge; source-only confirmation changes knowledge revision',t=>{
  const {api,confirm,save}=fixture(t);
  save('alvi',{phone:'+7 private unverified',websiteUrl:'https://example.test/'});
  const before=api.knowledge('alvi');assert.deepEqual(before.profile,{});assert.equal(before.readiness.catalog,'unavailable');
  assert.ok(!JSON.stringify(before).includes('+7 private unverified'));
  confirm('alvi',['websiteUrl']);const after=api.knowledge('alvi');
  assert.deepEqual(after.profile,{websiteUrl:'https://example.test/'});
  assert.equal(after.profileRevision,before.profileRevision);assert.notEqual(after.knowledgeRevision,before.knowledgeRevision);
  assert.equal(after.sources.websiteUrl.sourceRef,'Прайс, строка 1');assert.ok(after.sources.websiteUrl.factId);
  assert.equal(api.knowledge('alvi').knowledgeRevision,after.knowledgeRevision);
  assert.deepEqual(api.knowledge('avokado').profile,{});
});
test('catalog requires the whole service context; a changed price removes the service until checked',t=>{
  const {api,confirm,save}=fixture(t);save('alvi',{services:[service]});
  confirm('alvi',keys.filter(key=>!key.endsWith('/description')));
  let data=api.knowledge('alvi');assert.deepEqual(data.services,[]);
  assert.deepEqual(data.readiness.unavailableServices,[{id:service.id,missingFields:['description']}]);
  assert.ok(!JSON.stringify(data).includes('3500'));
  confirm('alvi',keys.filter(key=>key.endsWith('/description')));data=api.knowledge('alvi');
  assert.equal(data.services[0].price,3500);assert.equal(data.services[0].durationMinutes,60);
  assert.equal(data.services[0].description,'Одна процедура');assert.equal(data.readiness.catalog,'verified');
  assert.ok(data.services[0].sources.price.factId);const old=data.knowledgeRevision;
  save('alvi',{services:[{...service,price:3600}]});data=api.knowledge('alvi');
  assert.deepEqual(data.services,[]);assert.notEqual(data.knowledgeRevision,old);
  assert.ok(!/3500|3600/.test(JSON.stringify(data)));
  confirm('alvi',[keys.find(k=>k.endsWith('/price'))]);assert.equal(api.knowledge('alvi').services[0].price,3600);
  save('alvi',{services:[]});assert.deepEqual(api.knowledge('alvi').services,[]);
});
test('missing currency does not become RUB; zero price is retained; partial and empty catalogs are explicit',t=>{
  const {api,confirm,save}=fixture(t);
  save('alvi',{services:[{id:'free',title:'Знакомство',price:0,currency:'RUB'},{id:'unknown',title:'Сеанс',price:100}]});
  confirm('alvi',api.get('alvi').facts.filter(f=>f.key.startsWith('services/')).map(f=>f.key));
  const data=api.knowledge('alvi');assert.equal(data.services.length,1);assert.equal(data.services[0].price,0);
  assert.equal(data.readiness.catalog,'partial');assert.deepEqual(data.readiness.unavailableServices,[{id:'unknown',missingFields:['currency']}]);
  assert.equal(api.knowledge('avokado').readiness.catalog,'unavailable');
});
test('external CRM changes invalidate proof and deleted companies fail',t=>{
  const {api,db,confirm,save}=fixture(t);save('alvi',{phone:'first'});confirm('alvi',['phone']);
  db.prepare("UPDATE companies SET phone='second' WHERE code='alvi'").run();
  assert.ok(!Object.hasOwn(api.knowledge('alvi').profile,'phone'));
  db.prepare("UPDATE companies SET is_deleted=1 WHERE code='alvi'").run();
  assert.throws(()=>api.knowledge('alvi'),e=>e.status===404);
  assert.throws(()=>api.knowledge('missing'),e=>e.status===404);
});
