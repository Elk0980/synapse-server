'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createMediaMentor}=require('./media-mentor');
const actor={userId:7,userName:'SAMPLE'},day=(index,extra={})=>({ideaId:`sample-${index}`,date:new Date(Date.UTC(2026,10,index+1)).toISOString().slice(0,10),
  platform:'vk',format:'reel',role:'reach',topic:`SAMPLE ${index}`,variants:{vk:{text:'Подпись'}},...extra});
function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE,is_deleted INTEGER DEFAULT 0,timezone TEXT);
    INSERT INTO companies VALUES(1,'alpha',0,'UTC'),(2,'beta',0,'UTC');`);
  const api=createMediaMentor(db),save=(days,planRevision=0,code='alpha')=>api.savePlan(code,{days,planRevision,briefRevision:1},actor);
  for(const code of ['alpha','beta'])api.saveBrief(code,{revision:0,brief:{platforms:['vk']}},actor);
  return {db,api,save};
}
test('old plan roundtrip is a byte-preserving no-op without new default keys',t=>{
  const {db,save}=fixture(t),first=save(Array.from({length:7},(_,i)=>day(i)));
  const before=db.prepare('SELECT * FROM media_mentor_plans').all();
  const repeated=save(first.plan.days,first.plan.revision);
  assert.equal(repeated.plan.revision,first.plan.revision);assert.deepEqual(db.prepare('SELECT * FROM media_mentor_plans').all(),before);
  assert.equal(db.prepare('SELECT count(*) n FROM media_mentor_plan_versions').get().n,1);
  for(const key of ['script','filmingBy','productionStatus'])assert.equal(Object.hasOwn(repeated.plan.days[0],key),false);
});
test('full ordered script stays separate from caption; old clients retain it and script changes invalidate approval',t=>{
  const {api,save}=fixture(t),script='  Первый: реплика\r\n\nВторой: ответ\n  '.padEnd(20000,' '),first=save([day(0,{script,filmingBy:'SAMPLE оператор',productionStatus:'planned'})]);
  api.decideVariants('alpha',{planRevision:1,briefRevision:1,scope:'plan',decision:'approved',comment:''},actor);
  assert.equal(api.get('alpha').variants[0].status,'approved');
  const oldClient=first.plan.days.map(({script,filmingBy,productionStatus,...row})=>row);
  assert.equal(save(oldClient,1).plan.revision,1);assert.equal(api.get('alpha').plan.days[0].script,script);
  const changed=save(first.plan.days.map(row=>({...row,script:script.replace('Первый','Другой')})),1);
  assert.equal(changed.variants[0].status,'pending');assert.equal(changed.plan.days[0].variants.vk.text,'Подпись');
  assert.equal(changed.plan.days[0].filmingBy,'SAMPLE оператор');assert.equal(changed.plan.days[0].productionStatus,'planned');
  assert.equal(changed.plan.days[0].variants.vk.contentRevision,first.plan.days[0].variants.vk.contentRevision+1);
});
test('manual plans accept one to 31 days and 93 rows; validation/CAS stays atomic and company scoped',t=>{
  const {db,api,save}=fixture(t),single=save([day(0)]);
  const month=Array.from({length:31},(_,i)=>[0,1,2].map(n=>day(i,{ideaId:`sample-${i}-${n}`}))).flat();
  const full=save(month,single.plan.revision);assert.equal(full.plan.windowDays,31);assert.equal(full.plan.days.length,93);
  assert.equal(api.get('beta').plan,null);assert.equal(save([day(0)],0,'beta').plan.revision,1);
  assert.throws(()=>save(month,1),e=>e.status===409);
  const before=db.prepare('SELECT * FROM media_mentor_plans ORDER BY company_id').all();
  const revisions=()=>['media_mentor_plan_versions','media_mentor_variant_revisions'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY company_id`).all()),history=revisions();
  for(const days of [[day(0),day(30,{date:'2026-12-02'})],Array.from({length:4},(_,i)=>day(0,{ideaId:`dense-${i}`})),
    ...[{script:'x'.repeat(20001)},{script:7},{filmingBy:'x'.repeat(201)},{productionStatus:'approved'},{productionStatus:'rejected'}].map(patch=>[day(0,patch)])])
    assert.throws(()=>save(days,full.plan.revision),e=>e.status===400);
  assert.deepEqual(db.prepare('SELECT * FROM media_mentor_plans ORDER BY company_id').all(),before);
  assert.deepEqual(revisions(),history);
  assert.throws(()=>save([day(0)],0,'foreign'),e=>e.status===404);
});
