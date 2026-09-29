'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createClientIntakes,createClientIntakesHandler}=require('./client-intakes');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name) VALUES(1,'alvi','ALVI'),(2,'palitra-love','Palitra');
    CREATE TABLE leads(id INTEGER PRIMARY KEY,created_at TEXT,name TEXT,contact TEXT,normalized_contact TEXT,channel TEXT,source TEXT,first_question TEXT,comment TEXT,stage TEXT,company_code TEXT);
    CREATE TABLE stage_history(lead_id INTEGER,created_at TEXT,from_stage TEXT,to_stage TEXT);`);
  const api=createClientIntakes(db),body={botKey:'alvi',dialogId:7,telegramUserId:'12345',name:'Клиент',firstQuestion:'Хочу записаться',source:'tg'};
  return {db,api,body};
}
test('one dialog creates one CRM card, survives replay/restart, and never merges different companies by Telegram ID',t=>{
  const f=fixture(t),first=f.api.open('alvi',f.body,9);
  assert.equal(first.created,true);assert.equal(f.api.open('alvi',f.body,9).leadId,first.leadId);
  assert.equal(createClientIntakes(f.db).open('alvi',{...f.body,name:'Изменённое имя'},9).created,false);
  const other=f.api.open('palitra-love',{...f.body,botKey:'palitra'},9);assert.notEqual(other.leadId,first.leadId);
  assert.equal(f.db.prepare('SELECT count(*) n FROM leads').get().n,2);assert.equal(f.db.prepare('SELECT count(*) n FROM stage_history').get().n,2);
  const row=f.db.prepare('SELECT * FROM leads WHERE id=?').get(first.leadId);
  assert.equal(row.contact,'Telegram ID 12345');assert.equal(row.first_question,'Хочу записаться');assert.equal(row.stage,'новая');
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE '%outbox%'").get().n,0);
});
test('changed identity, deleted or moved linked lead, invalid input and disabled company cannot create replacement cards',t=>{
  const f=fixture(t),first=f.api.open('alvi',f.body,9);
  assert.throws(()=>f.api.open('alvi',{...f.body,telegramUserId:'999'},9),e=>e.status===409);
  f.db.prepare('UPDATE leads SET company_code=? WHERE id=?').run('palitra-love',first.leadId);
  assert.throws(()=>f.api.open('alvi',f.body,9),e=>e.status===409);
  f.db.prepare('DELETE FROM leads WHERE id=?').run(first.leadId);
  assert.throws(()=>f.api.open('alvi',f.body,9),e=>e.status===409);
  assert.throws(()=>f.api.open('alvi',{...f.body,dialogId:8,extra:'forged'},9),e=>e.status===400);
  f.db.exec('UPDATE companies SET is_deleted=1 WHERE id=1');assert.throws(()=>f.api.open('alvi',{...f.body,dialogId:8},9),e=>e.status===404);
  assert.equal(f.db.prepare('SELECT count(*) n FROM leads').get().n,0);
});
test('HTTP requires current owner identity and returns an idempotent receipt',async t=>{
  const f=fixture(t);let role='editor',revoked=false,result;
  const handler=createClientIntakesHandler({intakes:f.api,companyModuleContext(){if(revoked)throw Object.assign(Error('Forbidden'),{status:403});return {identity:{role,userId:9}};},readJson:async request=>{if(request.revoke)revoked=true;return f.body;},send:(_r,status,body)=>result={status,body}});
  const url=new URL('http://test/client-dialog-intakes?companyCode=alvi');
  await assert.rejects(handler({method:'POST'},{},url),e=>e.status===403);
  role='owner';await handler({method:'POST'},{},url);assert.equal(result.status,201);
  await handler({method:'POST'},{},url);assert.equal(result.status,200);
  await assert.rejects(handler({method:'POST',revoke:true},{},url),e=>e.status===403);
  assert.equal(f.db.prepare('SELECT count(*) n FROM leads').get().n,1);
});
