'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,socials) VALUES(1,'alvi','ALVI','[]'),(2,'avokado','Авокадо','[]');`);
  const options={now:()=>Date.parse('2026-09-29T12:00:00Z')},api=createCompanyInformation(db,options);
  const entry=id=>({service:{id,title:'Массаж '+id,price:15700,currency:'RUB',procedureCount:5,durationMinutes:60},
    source:'Прайс клиента',sourceRef:'Документ, строка '+id,checkedAt:'2026-09-29T10:00:00.000Z'});
  const body=(ids=['one'])=>({companyCode:'alvi',revision:api.get('alvi').revision,clientImportId:'catalog-test-001',entries:ids.map(entry)});
  return {db,api,options,entry,body};
}
test('preview does not import; atomic import preserves existing rows and records every nonempty field source',t=>{
  const {api,body}=fixture(t);let initial=api.get('alvi');
  api.save('alvi',{revision:initial.revision,profile:{phone:'keep',services:[{id:'old',title:'Старая услуга',price:123}]}});
  const request=body(),before=api.get('alvi');const preview=api.importPreview('alvi',request);
  assert.equal(preview.added,1);assert.equal(api.get('alvi').revision,before.revision);assert.equal(api.get('alvi').profile.services.length,1);
  const result=api.importCatalog('alvi',request,7);assert.equal(result.importResult.added,1);assert.equal(result.profile.phone,'keep');
  assert.deepEqual(result.profile.services[0],before.profile.services[0]);
  assert.equal(result.facts.find(f=>f.key==='services/one/price').sourceRef,'Документ, строка one');
  assert.equal(result.facts.find(f=>f.key==='services/one/procedureCount').actorId,7);
  assert.equal(api.knowledge('alvi').services[0].procedureCount,5);assert.equal(api.knowledge('alvi').services[0].price,15700);
  assert.deepEqual(api.get('avokado').profile.services,[]);
});
test('receipt survives restart and replay never restores catalog after a later edit',t=>{
  const {api,db,options,body}=fixture(t),request=body();const result=api.importCatalog('alvi',request,7);
  const service={...result.profile.services[0],price:17000};api.save('alvi',{revision:result.revision,profile:{services:[service]}});
  const restarted=createCompanyInformation(db,options),replay=restarted.importCatalog('alvi',request,7);
  assert.equal(replay.importResult.duplicate,true);assert.equal(replay.profile.services[0].price,17000);
  assert.equal(restarted.importCatalog('alvi',{...request,revision:replay.revision},7).importResult.duplicate,true);
  assert.equal(replay.facts.find(f=>f.key==='services/one/price').status,'unverified');
  assert.throws(()=>restarted.importCatalog('alvi',{...request,entries:[{...request.entries[0],source:'changed'}]},7),e=>e.status===409);
});
test('wrong company, stale revision, conflicting IDs, duplicates, invalid count and invalid dates do not partly import',t=>{
  const {api,body,entry}=fixture(t),request=body();
  for(const bad of [{...request,companyCode:'avokado'}, {...request,revision:0}, {...request,entries:[entry('one'),entry('one')]},
    {...request,entries:[entry('one'),{...entry('two'),source:''}]},
    {...request,entries:[{...entry('one'),service:{...entry('one').service,procedureCount:1.5}}]},
    {...request,entries:[{...entry('one'),checkedAt:'2026-02-31T10:00:00.000Z'}]},
    {...request,entries:[{...entry('one'),checkedAt:'2026-09-30T10:00:00.000Z'}]}]){
    assert.throws(()=>api.importCatalog('alvi',bad));assert.deepEqual(api.get('alvi').profile.services,[]);
  }
  const saved=api.importCatalog('alvi',request);
  assert.throws(()=>api.importCatalog('alvi',{...body(),clientImportId:'catalog-test-002',entries:[{...entry('one'),service:{...entry('one').service,price:1}},entry('two')]}),e=>e.status===409);
  assert.deepEqual(api.get('alvi').profile.services,saved.profile.services);
});
test('more than 200 facts are confirmed within one import and a late database failure rolls back everything',t=>{
  const {api,db,body}=fixture(t),request=body(Array.from({length:77},(_,i)=>'row-'+i));
  const before=api.get('alvi');
  db.exec("CREATE TRIGGER reject_test BEFORE INSERT ON company_fact_versions WHEN NEW.fact_key='services/row-76/price' AND NEW.status='confirmed' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(()=>api.importCatalog('alvi',request),/test failure/);
  assert.deepEqual(api.get('alvi').profile.services,[]);assert.equal(api.get('alvi').revision,before.revision);
  assert.equal(db.prepare('SELECT count(*) n FROM company_catalog_imports').get().n,0);
  db.exec('DROP TRIGGER reject_test');const result=api.importCatalog('alvi',request);
  assert.equal(result.importResult.added,77);assert.equal(api.knowledge('alvi').services.length,77);
  assert.equal(result.facts.filter(f=>f.key.startsWith('services/')&&f.status==='confirmed').length,77*5);
});


test('program import verifies units and guests, replays safely, and rejects missing program context atomically',t=>{
  const {api,body,entry}=fixture(t);
  const service={id:'spa',title:'Программа',price:6900,currency:'RUB',priceUnit:'program',guestCount:2,visitDurationMinutes:90};
  const request={...body(),entries:[{...entry('spa'),service}]};
  for(const field of ['guestCount','visitDurationMinutes']) {
    const bad={...service};delete bad[field];
    assert.throws(()=>api.importCatalog('alvi',{...request,entries:[entry('course'),{...request.entries[0],service:bad}]}),e=>e.status===400);
    assert.equal(api.get('alvi').profile.services.length,0);
  }
  assert.equal(api.importPreview('alvi',request).added,1);
  const result=api.importCatalog('alvi',request,7);
  assert.deepEqual(result.profile.services,[service]);
  for(const key of ['priceUnit','guestCount','visitDurationMinutes'])assert.equal(result.facts.find(f=>f.key==='services/spa/'+key).status,'confirmed');
  assert.deepEqual(api.quote('alvi','spa',api.knowledge('alvi').knowledgeRevision).service,service);
  assert.equal(api.importCatalog('alvi',request,7).importResult.duplicate,true);
});

test('minute import rejects incomplete context atomically and keeps verified program facts intact',t=>{
  const {api,db,options,body,entry}=fixture(t);
  const program={id:'spa',title:'SPA',price:500,currency:'RUB',priceUnit:'program',guestCount:2,visitDurationMinutes:90};
  api.importCatalog('alvi',{...body(),entries:[{...entry('spa'),service:program}]});
  const proof=api.get('alvi').facts.find(f=>f.key==='services/spa/guestCount');
  assert.equal(proof.label,'Услуги · SPA · Число гостей в программе');
  const service={id:'minutes',title:'Минуты',price:990,currency:'RUB',priceUnit:'minutes',minuteCount:30};
  const request={...body(),clientImportId:'minutes-import-001',entries:[entry('pair'),{...entry('minutes'),service}]};
  assert.throws(()=>api.importCatalog('alvi',{...request,entries:[entry('pair'),{...entry('minutes'),service:{...service,minuteCount:null}}]}),e=>e.status===400);
  assert.equal(api.get('alvi').profile.services.length,1);
  api.importCatalog('alvi',request);const restarted=createCompanyInformation(db,options);
  assert.equal(restarted.get('alvi').facts.find(f=>f.key==='services/spa/guestCount').id,proof.id);
  assert.equal(restarted.knowledge('alvi').services.length,3);
  assert.equal(restarted.importCatalog('alvi',request).importResult.duplicate,true);
  assert.equal(restarted.quote('alvi','minutes',restarted.knowledge('alvi').knowledgeRevision).service.minuteCount,30);
});
