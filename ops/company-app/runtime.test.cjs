'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {create}=require('./runtime.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const source=()=>({contract:'salon-client-aggregates/v1',source:'yclients-ui',companyCode:'alvi',branchId:989844,capturedAt:'2026-10-18T10:00:00.000Z',observedThrough:'2026-10-18T10:00:00.000Z',periods:[{from:'2026-10-01',to:'2026-10-18',newClients:5}]});
test('native runtime reads a saved actual period and keeps other native routes outside its scope',async()=>{
 const db=new DatabaseSync(':memory:'),runtime=create({db,clock:()=> '2026-10-19T00:00:00.000Z'});
 try{
  const owner={id:1,role:'owner',sessionVersion:1,companyCodes:['alvi','avokado']};let result;
  const context={request:{method:'GET',headers:{}},reply:(status,data)=>{result={status,data};},requireSession:()=>({user:owner}),requireCsrf:()=>{throw Error('Read must not require CSRF');}};
  const snapshot=source();
  runtime.cache.publish([{companyCode:'alvi',expectedRevision:0,snapshot}],{actorId:1,requestId:'runtime-source-1'});
  assert.equal(await runtime.handle({...context,url:new URL('https://cabinet.invalid/content/alvi/customer-reports?mode=month&month=2026-10')}),true);
  assert.equal(result.status,200);assert.equal(result.data.newClients.value,5);assert.equal(result.data.ltv.value,null);
  assert.equal(await runtime.handle({...context,url:new URL('https://cabinet.invalid/content/palitra/customer-threads')}),false);
  assert.equal(await runtime.handle({...context,url:new URL('https://cabinet.invalid/content/alvi/orders/1/renotify')}),false);
 }finally{runtime.close();}
});
test('dedicated runtime cache persists across process-style reopening without touching the chat database',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'salon-runtime-')),databasePath=path.join(folder,'salon-reports.sqlite'),chat=path.join(folder,'content.sqlite');
 fs.writeFileSync(chat,'untouched original chat database');let runtime;
 try{
  runtime=create({databasePath,clock:()=> '2026-10-19T00:00:00.000Z'});
  runtime.cache.publish([{companyCode:'alvi',expectedRevision:0,snapshot:source()}],{actorId:1,requestId:'disk-source-1'});runtime.close();runtime=null;
  runtime=create({databasePath,clock:()=> '2026-10-19T00:00:00.000Z'});
  assert.equal(runtime.cache.readForPeriod('alvi',{mode:'month',month:'2026-10'}).periods[0].newClients,5);
  assert.equal(runtime.cache.metadata('alvi').revision,1);assert.equal(runtime.cache.metadata('avokado'),null);
  assert.equal(fs.readFileSync(chat,'utf8'),'untouched original chat database');
  if(process.platform!=='win32')assert.equal(fs.statSync(databasePath).mode&0o777,0o600);
 }finally{runtime?.close();assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('salon-runtime-'));fs.rmSync(folder,{recursive:true,force:true});}
});
