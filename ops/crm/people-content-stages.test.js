'use strict';
// specs/214-notification-delivery: действие people `contentStages` — этапы идей для рассылки по матрице.
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {createPeopleHandler}=require('./people-http');
const {createPeopleCrmClient}=require('../content/people-crm-client');

function handler({stages}={}) {
  const seen=[];
  const mentor={get:code=>({companyCode:code,plan:{days:[{ideaId:'i1',topic:'Первая\nтема',date:'2026-11-10'},{ideaId:'i2',topic:'Вторая',date:'2026-11-11'}]}})};
  const identity=request=>JSON.parse(request.headers.actor);
  const handle=createPeopleHandler({db:new DatabaseSync(':memory:'),taskCoordination:{},mentor,
    identity:request=>{const a=identity(request);return {...a,companyCodes:new Set(a.companyCodes),permissions:new Set(a.permissions)};},
    readJson:async()=>({}),send:(response,status,body)=>seen.push({status,body}),contentStages:stages});
  const call=async(actor,code='alpha',facts)=>{
    seen.length=0;
    const request={method:'GET',headers:{actor:JSON.stringify(actor),...(facts?{'x-synapse-shooting-facts':facts}:{})}};
    try{await handle(request,{},new URL(`http://crm/internal/people/contentStages?companyCode=${code}`));return seen[0];}
    catch(error){return {status:error.status,body:{error:error.message}};}
  };
  return {call};
}
const owner={userId:1,role:'owner',companyCodes:['alpha'],permissions:[]};
const facts=code=>Buffer.from(JSON.stringify({v:1,companyCode:code,reels:{i1:[0,0,1,0,null]}})).toString('base64url');

test('contentStages: только владелец, только своя компания, номер/тема/этап; факты съёмки передаются вычислителю',async()=>{
  const applied=[];
  const stages={apply:(snapshot,code,shooting)=>{applied.push({code,shooting});
    return {...snapshot,plan:{...snapshot.plan,days:snapshot.plan.days.map(d=>({...d,stage:d.ideaId==='i1'&&shooting?.get('i1')?.takes?'shot':'planned'}))}};}};
  const f=handler({stages});
  const r=await f.call(owner,'alpha',facts('alpha'));
  assert.equal(r.status,200);
  assert.deepEqual(r.body,{companyCode:'alpha',shooting:true,ideas:[{ideaId:'i1',number:1,topic:'Первая\nтема',date:'2026-11-10',stage:'shot'},
    {ideaId:'i2',number:2,topic:'Вторая',date:'2026-11-11',stage:'planned'}]});
  // Чужие факты (другая компания) не принимаются: этап считается без съёмки.
  const foreign=await f.call(owner,'alpha',facts('beta'));
  assert.equal(foreign.body.shooting,false);assert.equal(foreign.body.ideas[0].stage,'planned');
  const editor={userId:2,role:'editor',companyCodes:['alpha'],permissions:['content-plan.approve']};
  assert.equal((await f.call(editor)).status,403,'редактор с правом согласования этапы для рассылки не читает');
  assert.equal((await f.call({...owner,companyCodes:['beta']})).status,403,'идентичность другой компании');
  assert.equal((await handler().call(owner)).status,503,'без подключённых этапов — честный отказ');
});

test('реальный CRM: contentStages через клиент people — владелец 200, пустой план, редактор 403',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-content-stages-')),key=crypto.randomBytes(24).toString('hex');let child;
  t.after(async()=>{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}fs.rmSync(dir,{recursive:true,force:true});});
  const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  let output='';
  child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{SystemRoot:process.env.SystemRoot||'',PATH:process.env.PATH||'',PORT:String(port),DATABASE_PATH:path.join(dir,'crm.sqlite'),API_KEY:key},stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  for(let i=0;i<200&&!output.includes('слушает');i++)await new Promise(r=>setTimeout(r,25));assert.match(output,/слушает/);
  const base=`http://127.0.0.1:${port}`;
  const identity={v:1,userId:1,userName:'Владелец',role:'owner',companyCodes:['alpha'],permissions:['crm.edit']};
  const created=await fetch(base+'/companies',{method:'POST',headers:{'content-type':'application/json','x-api-key':key,'x-synapse-crm-identity':Buffer.from(JSON.stringify(identity)).toString('base64url')},body:JSON.stringify({code:'alpha',name:'alpha'})});
  assert.equal(created.status,201);
  const call=createPeopleCrmClient({crmUrl:base,apiKey:key});
  const ownerUser={id:1,displayName:'Владелец',role:'owner',companyCodes:['alpha'],permissions:[]};
  const result=await call('contentStages',{shootingFacts:facts('alpha')},ownerUser,'alpha');
  assert.equal(result.companyCode,'alpha');assert.equal(result.shooting,true);assert.deepEqual(result.ideas,[]);
  const editorUser={id:2,displayName:'Человек',role:'editor',companyCodes:['alpha'],permissions:['content-plan.approve']};
  await assert.rejects(call('contentStages',{},editorUser,'alpha'),{status:403});
});
