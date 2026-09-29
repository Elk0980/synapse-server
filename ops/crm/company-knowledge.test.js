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
const service={id:'massage/60',title:'Массаж 60 минут',price:3500,currency:'RUB',procedureCount:1,durationMinutes:60,description:'Одна процедура'};
const keys=Object.keys(service).filter(k=>k!=='id').map(k=>'services/massage%2F60/'+k);

test('quotes use current verified values and omit internal sources without promising a booking',t=>{
  const {api,confirm,save}=fixture(t);
  save('alvi',{services:[{...service,price:15700,procedureCount:5,bookingIntervalMinutes:90}]});
  confirm('alvi',[...keys,'services/massage%2F60/bookingIntervalMinutes']);
  const current=api.knowledge('alvi'),q=api.quote('alvi',service.id,current.knowledgeRevision);
  assert.equal(q.service.price,15700);assert.equal(q.service.procedureCount,5);
  assert.equal(q.service.durationMinutes,60);assert.equal(q.service.bookingIntervalMinutes,90);
  assert.equal(q.text,'Массаж 60 минут\n15700 ₽ за 5 процедур.\nПродолжительность одной процедуры: 60 мин.\nОдна процедура');
  assert.equal(q.availability,'not_checked');
  for(const privateField of ['sources','sourceRef','factId','checkedAt','supersedesId'])assert.ok(!JSON.stringify(q).includes(privateField));
  assert.throws(()=>api.quote('avokado',service.id,current.knowledgeRevision),e=>e.status===409);
  assert.throws(()=>api.quote('alvi','absent',current.knowledgeRevision),e=>e.details.code==='SERVICE_UNAVAILABLE');
  for(const rev of [null,'','fake'])assert.throws(()=>api.quote('alvi',service.id,rev),e=>e.status===400);
});

test('a price or proof change invalidates an in-flight selection; unverified replacement cannot be quoted',t=>{
  const {api,confirm,save}=fixture(t);save('alvi',{services:[service]});confirm('alvi',keys);
  const initial=api.knowledge('alvi');
  save('alvi',{services:[{...service,price:3600}]});
  assert.throws(()=>api.quote('alvi',service.id,initial.knowledgeRevision),e=>e.details.code==='KNOWLEDGE_CHANGED');
  const unverified=api.knowledge('alvi');
  assert.throws(()=>api.quote('alvi',service.id,unverified.knowledgeRevision),e=>e.details.code==='SERVICE_UNAVAILABLE');
  confirm('alvi',[keys.find(k=>k.endsWith('/price'))]);const refreshed=api.knowledge('alvi');
  assert.equal(api.quote('alvi',service.id,refreshed.knowledgeRevision).service.price,3600);
  confirm('alvi',[keys.find(k=>k.endsWith('/price'))]);
  assert.throws(()=>api.quote('alvi',service.id,refreshed.knowledgeRevision),e=>e.details.code==='KNOWLEDGE_CHANGED');
});

test('zero and fractional prices are not rounded or divided; procedure counts are explicit',t=>{
  const {api,confirm,save}=fixture(t);
  for(const [price,quantity,label] of [[0,1,'0 ₽ за 1 процедуру'],[12.345,2,'12,345 ₽ за 2 процедуры'],[123,11,'123 ₽ за 11 процедур']]){
    save('alvi',{services:[{...service,price,procedureCount:quantity}]});confirm('alvi',keys);
    assert.ok(api.quote('alvi',service.id,api.knowledge('alvi').knowledgeRevision).text.includes(label));
  }
});

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
  save('alvi',{services:[{id:'free',title:'Знакомство',price:0,currency:'RUB',procedureCount:1},{id:'unknown',title:'Сеанс',price:100,procedureCount:1}]});
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

test('course prices require an explicit verified procedure count; legacy rows do not imply one visit',t=>{
  const {api,confirm,save}=fixture(t);
  const course={id:'course',title:'Массаж',price:15700,currency:'RUB',durationMinutes:60};
  save('alvi',{services:[course]});
  const verify=()=>confirm('alvi',api.get('alvi').facts.filter(f=>f.key.startsWith('services/')).map(f=>f.key));
  verify();assert.deepEqual(api.knowledge('alvi').readiness.unavailableServices,[{id:'course',missingFields:['procedureCount']}]);
  for(const quantity of [0,-1,1.5,1001,'5'])assert.throws(()=>save('alvi',{services:[{...course,procedureCount:quantity}]}),e=>e.status===400);
  save('alvi',{services:[{...course,procedureCount:5}]});
  assert.equal(api.knowledge('alvi').services.length,0);verify();
  let result=api.knowledge('alvi').services[0];assert.equal(result.price,15700);assert.equal(result.procedureCount,5);
  assert.equal(result.durationMinutes,60,'duration describes one procedure, not the whole course');
  assert.ok(result.sources.procedureCount.factId);
  save('alvi',{services:[{...course,procedureCount:10}]});assert.equal(api.knowledge('alvi').services.length,0);
  verify();result=api.knowledge('alvi').services[0];assert.equal(result.procedureCount,10);assert.equal(result.price,15700);
});


test('program quote keeps the whole price, guest count and visit time with verified evidence',t=>{
  const {api,confirm,save}=fixture(t);
  const program={id:'spa',title:'Программа для двоих',price:6900,currency:'RUB',priceUnit:'program',guestCount:2,visitDurationMinutes:90};
  const verify=()=>confirm('alvi',api.get('alvi').facts.filter(f=>f.key.startsWith('services/')).map(f=>f.key));
  save('alvi',{services:[program]});verify();
  let catalog=api.knowledge('alvi');
  const q=api.quote('alvi','spa',catalog.knowledgeRevision);
  assert.deepEqual(q.service,program);
  assert.equal(q.text,'Программа для двоих\n6900 ₽ за программу целиком (гостей: 2).\nОбщая длительность визита: 90 мин.');
  assert.equal(q.availability,'not_checked');
  for(const field of ['guestCount','visitDurationMinutes']) {
    const changed={...program,[field]:program[field]+1};
    save('alvi',{services:[changed]});
    assert.throws(()=>api.quote('alvi','spa',catalog.knowledgeRevision),e=>e.details.code==='KNOWLEDGE_CHANGED');
    assert.equal(api.knowledge('alvi').services.length,0);verify();catalog=api.knowledge('alvi');
    assert.equal(api.quote('alvi','spa',catalog.knowledgeRevision).service[field],changed[field]);
  }
  save('alvi',{services:[{...program,visitDurationMinutes:null}]});verify();
  assert.deepEqual(api.knowledge('alvi').readiness.unavailableServices,[{id:'spa',missingFields:['visitDurationMinutes']}]);
});

test('program fields reject mixed units and invalid quantities without guessing from the title',t=>{
  const {save}=fixture(t);
  const program={id:'spa',title:'Программа',price:500,currency:'RUB',priceUnit:'program',guestCount:1,visitDurationMinutes:90};
  for(const patch of [{priceUnit:'per_guest'},{procedureCount:1},{durationMinutes:60},{priceUnit:''},{priceUnit:'procedures'},
    {guestCount:0},{guestCount:1.5},{guestCount:'2'},{visitDurationMinutes:0},{visitDurationMinutes:-1},{visitDurationMinutes:10001}])
    assert.throws(()=>save('alvi',{services:[{...program,...patch}]}),e=>e.status===400);
});

test('paid minutes retain total price without inventing sessions, and changed quantities require evidence',t=>{
  const {api,confirm,save}=fixture(t);
  const service={id:'minutes',title:'Тариф',price:2900,currency:'RUB',priceUnit:'minutes',minuteCount:100};
  const verify=()=>confirm('alvi',api.get('alvi').facts.filter(f=>f.key.startsWith('services/')).map(f=>f.key));
  save('alvi',{services:[service]});verify();const revision=api.knowledge('alvi').knowledgeRevision;
  const quote=api.quote('alvi','minutes',revision);assert.deepEqual(quote.service,service);
  assert.match(quote.text,/2900 ₽ за 100 минут/);assert.match(quote.text,/суммарное оплаченное время/);
  assert.doesNotMatch(quote.text,/процедур|Общая длительность визита/);
  save('alvi',{services:[{...service,minuteCount:150}]});
  assert.throws(()=>api.quote('alvi','minutes',revision),e=>e.details.code==='KNOWLEDGE_CHANGED');
  assert.equal(api.knowledge('alvi').services.length,0);verify();
  assert.equal(api.quote('alvi','minutes',api.knowledge('alvi').knowledgeRevision).service.price,2900);
  for(const patch of [{procedureCount:1},{durationMinutes:100},{visitDurationMinutes:100},{minuteCount:0},{minuteCount:1.5},{minuteCount:'100'},{priceUnit:'procedures'},{priceUnit:'program'}])
    assert.throws(()=>save('alvi',{services:[{...service,...patch}]}),e=>e.status===400);
});

test('procedure for two keeps the full amount and requires verified guest count',t=>{
  const {api,confirm,save}=fixture(t);
  const service={id:'pair',title:'Массаж для двоих',price:5600,currency:'RUB',procedureCount:1,guestCount:2,durationMinutes:60};
  save('alvi',{services:[service]});
  const facts=api.get('alvi').facts.filter(f=>f.key.startsWith('services/'));
  confirm('alvi',facts.filter(f=>!f.key.endsWith('/guestCount')).map(f=>f.key));
  assert.equal(api.knowledge('alvi').services.length,0);
  confirm('alvi',facts.filter(f=>f.key.endsWith('/guestCount')).map(f=>f.key));
  const quote=api.quote('alvi','pair',api.knowledge('alvi').knowledgeRevision);
  assert.deepEqual(quote.service,service);assert.match(quote.text,/5600 ₽ за 1 процедуру \(гостей: 2\)/);
  assert.doesNotMatch(quote.text,/2800/);
});
