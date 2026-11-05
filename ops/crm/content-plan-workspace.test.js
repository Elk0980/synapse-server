'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createMediaMentor}=require('./media-mentor');
const {createContentPlanWorkspace}=require('./content-plan-workspace');
const {createMediaMentorHandler}=require('./media-mentor-http');
const {fridaySummary}=require('../content/people-friday');

const OWNER={userId:1,userName:'SAMPLE владелец',role:'owner',permissions:new Set()};
const APPROVER={userId:5,userName:'SAMPLE согласующий',role:'editor',permissions:new Set(['autoposting.edit','content-plan.approve'])};
const WHO={userId:1,userName:'SAMPLE владелец'};
const EDITOR={userId:6,userName:'SAMPLE редактор',role:'editor',permissions:new Set(['autoposting.edit'])};
const day=(i,extra={})=>({ideaId:`s-${i}`,date:`2026-11-${String(9+i).padStart(2,'0')}`,platform:'vk',format:'reel',role:'reach',
  topic:`SAMPLE ${i}`,hook:'SAMPLE хук',variants:{vk:{text:'SAMPLE подпись'}},...extra});

function fixture(t,approvers) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,is_deleted INTEGER DEFAULT 0,timezone TEXT);
    INSERT INTO companies VALUES(1,'alpha',0,'UTC'),(2,'beta',0,'UTC');`);
  const mentor=createMediaMentor(db),ws=createContentPlanWorkspace(db,{mentor,approvers});
  for(const code of ['alpha','beta'])mentor.saveBrief(code,{revision:0,brief:{platforms:['vk']}},WHO);
  const plan=(days,rev=0)=>mentor.savePlan('alpha',{planRevision:rev,briefRevision:1,days},WHO);
  return {db,mentor,ws,plan};
}
const week=snap=>fridaySummary(snap,{now:'2026-11-06T10:00:00Z',timezone:'UTC',metric:'approvedIdeas',weekStart:'2026-11-09'});

test('questionnaire saves partially, keeps other fields, rejects stale revision and stays company scoped',t=>{
  const {ws}=fixture(t);
  assert.equal(ws.questionnaire('alpha').revision,0);
  const a=ws.saveQuestionnaire('alpha',{revision:0,fields:{goals:'SAMPLE цель'}},OWNER);
  const b=ws.saveQuestionnaire('alpha',{revision:1,fields:{platforms:['vk','telegram'],tone:'SAMPLE тон'}},OWNER);
  assert.equal(a.filled,1);assert.equal(b.revision,2);assert.equal(b.fields.goals,'SAMPLE цель');
  assert.deepEqual([...b.fields.platforms].sort(),['telegram','vk']);
  assert.equal(ws.saveQuestionnaire('alpha',{revision:2,fields:{tone:'SAMPLE тон'}},OWNER).revision,2,'no-op save keeps revision');
  assert.throws(()=>ws.saveQuestionnaire('alpha',{revision:1,fields:{tone:'x'}},OWNER),e=>e.status===409);
  for(const fields of [{},{unknown:'x'},{platforms:['myspace']},{goals:'x'.repeat(2001)}])
    assert.throws(()=>ws.saveQuestionnaire('alpha',{revision:2,fields},OWNER),e=>e.status===400);
  assert.equal(ws.questionnaire('beta').revision,0);assert.equal(ws.questionnaire('beta').fields.goals,'');
  assert.throws(()=>ws.questionnaire('foreign'),e=>e.status===404);
});

test('stub owner checkmark approves the whole plan, moves it to SMM and into the Friday counter',t=>{
  const {ws,mentor,plan}=fixture(t);
  plan(Array.from({length:7},(_,i)=>day(i)));
  let state=ws.signoffs('alpha',OWNER);
  assert.equal(state.approversSource,'stub');assert.equal(state.stage,'approval');assert.equal(state.approvers[0].canCheck,true);
  assert.equal(week(mentor.get('alpha')).approvedIdeas,0);
  assert.equal(ws.signoffs('alpha',EDITOR).approvers[0].canCheck,false);
  assert.throws(()=>ws.signoff('alpha',{planRevision:1,briefRevision:1,slot:'owner',checked:true},EDITOR),e=>e.status===403);
  state=ws.signoff('alpha',{planRevision:1,briefRevision:1,slot:'owner',checked:true},OWNER);
  assert.equal(state.stage,'smm');assert.equal(state.approvedIdeas,7);
  assert.equal(week(mentor.get('alpha')).approvedIdeas,7,'Friday ≥7 counts checkmark-approved plan');
  // Снятие отметки отзывает согласование; другая компания не затронута.
  state=ws.signoff('alpha',{planRevision:1,briefRevision:1,slot:'owner',checked:false},OWNER);
  assert.equal(state.stage,'approval');assert.equal(week(mentor.get('alpha')).approvedIdeas,0);
  assert.equal(ws.signoffs('beta',OWNER).stage,'none');
  assert.throws(()=>ws.signoff('alpha',{planRevision:2,briefRevision:1,slot:'owner',checked:true},OWNER),e=>e.status===409);
});

test('configured approvers: every person ticks only their own box; editing the plan returns it to approval',t=>{
  const {ws,mentor,plan}=fixture(t,code=>code==='alpha'?[{role:'owner',label:'Влад'},{userId:5,label:'Таня'}]:null);
  plan([day(0,{broll:'SAMPLE руки, аппарат',props:'SAMPLE халат'})]);
  assert.equal(ws.signoffs('alpha',OWNER).approversSource,'settings');
  assert.throws(()=>ws.signoff('alpha',{planRevision:1,briefRevision:1,slot:'user:5',checked:true},OWNER),e=>e.status===403);
  let state=ws.signoff('alpha',{planRevision:1,briefRevision:1,slot:'user:5',checked:true},APPROVER);
  assert.equal(state.stage,'approval');assert.equal(state.approvers.find(a=>a.slot==='user:5').actorName,'SAMPLE согласующий');
  state=ws.signoff('alpha',{planRevision:1,briefRevision:1,slot:'owner',checked:true},OWNER);
  assert.equal(state.stage,'smm');assert.equal(mentor.get('alpha').variants[0].status,'approved');
  const saved=mentor.get('alpha').plan.days;
  assert.equal(saved[0].broll,'SAMPLE руки, аппарат');assert.equal(saved[0].props,'SAMPLE халат');
  plan(saved.map(d=>({...d,broll:'SAMPLE другая вставка'})),1);
  state=ws.signoffs('alpha',OWNER);
  assert.equal(state.stage,'approval');assert.equal(state.allChecked,false);assert.equal(mentor.get('alpha').variants[0].status,'pending');
});

test('empty captions cannot be approved by checkmarks and are reported',t=>{
  const {ws,plan}=fixture(t);
  plan([day(0,{variants:{vk:{text:''}}})]);
  assert.deepEqual(ws.signoffs('alpha',OWNER).emptyIdeas,['s-0']);
  assert.throws(()=>ws.signoff('alpha',{planRevision:1,briefRevision:1,slot:'owner',checked:true},OWNER),e=>e.status===409);
});

test('HTTP: questionnaire and signoffs use company guard, edit permission and fresh identity',async t=>{
  const {mentor,ws}=fixture(t);
  const transfer={status:()=>({}),variantStatus:()=>({})};
  const handler=createMediaMentorHandler({mentor,transfer,workspace:ws,readJson:async r=>r.body,
    companyModuleContext:(request,code,permission)=>{
      const id=request.identity;
      if(id.role!=='owner'&&!id.permissions.has(permission))throw Object.assign(Error('Недостаточно прав'),{status:403});
      return {identity:id,company:{code}};
    },send:(res,status,body)=>{res.status=status;res.body=body;}});
  const call=async(method,path,identity,body)=>{const res={};await handler({method,identity,body},res,new URL(`http://x${path}?companyCode=alpha`));return res;};
  const viewer={...EDITOR,permissions:new Set(['autoposting.view'])};
  assert.equal((await call('GET','/media-mentor/questionnaire',viewer)).body.revision,0);
  await assert.rejects(call('PUT','/media-mentor/questionnaire',viewer,{revision:0,fields:{goals:'x'}}),e=>e.status===403);
  assert.equal((await call('PUT','/media-mentor/questionnaire',EDITOR,{revision:0,fields:{goals:'SAMPLE'}})).body.revision,1);
  assert.equal((await call('GET','/media-mentor',viewer)).body.questionnaire.goals,'SAMPLE');
  assert.equal((await call('GET','/media-mentor/plan/signoffs',viewer)).body.stage,'none');
  await assert.rejects(call('DELETE','/media-mentor/plan/signoffs',OWNER),e=>e.status===405);
});

test('HTTP: approvers from Настройки → Контент — Лена and Таня with content-plan.approve; plan is approved only when all tick',async t=>{
  const {mentor,ws,plan}=fixture(t);
  plan(Array.from({length:7},(_,i)=>day(i)));
  const transfer={status:()=>({}),variantStatus:()=>({})};
  const handler=createMediaMentorHandler({mentor,transfer,workspace:ws,readJson:async r=>r.body,
    companyModuleContext:(request,code,permission)=>{
      const id=request.identity;
      if(id.role!=='owner'&&!id.permissions.has(permission))throw Object.assign(Error('Недостаточно прав'),{status:403});
      return {identity:id,company:{code}};
    },send:(res,status,body)=>{res.status=status;res.body=body;}});
  const header=list=>Buffer.from(JSON.stringify(list)).toString('base64url');
  const settings=header([{userId:5,label:'SAMPLE Лена'},{userId:7,label:'SAMPLE Таня'}]);
  const call=async(method,identity,body,approvers=settings)=>{const res={};
    await handler({method,identity,body,headers:approvers===null?{}:{'x-synapse-content-approvers':approvers}},res,new URL('http://x/media-mentor/plan/signoffs?companyCode=alpha'));return res.body;};
  // Согласующим не нужно право правки плана: только просмотр и content-plan.approve.
  const lena={userId:5,userName:'SAMPLE Лена',role:'editor',permissions:new Set(['autoposting.view','content-plan.approve'])};
  const tanya={userId:7,userName:'SAMPLE Таня',role:'editor',permissions:new Set(['autoposting.view','content-plan.approve'])};
  const outsider={userId:9,userName:'SAMPLE другой',role:'editor',permissions:new Set(['autoposting.edit','content-plan.approve'])};
  let state=await call('GET',lena);
  assert.equal(state.approversSource,'settings');
  assert.deepEqual(state.approvers.map(a=>[a.slot,a.canCheck]),[['user:5',true],['user:7',false]]);
  const tick=(who,slot,checked=true)=>call('POST',who,{planRevision:1,briefRevision:1,slot,checked});
  await assert.rejects(tick(EDITOR,'user:5'),e=>e.status===403,'без content-plan.approve отметку не поставить');
  await assert.rejects(tick(outsider,'user:5'),e=>e.status===403,'не из списка — только свой слот, а его нет');
  await assert.rejects(tick(OWNER,'owner'),e=>e.status===404,'при назначенных согласующих владелец не утверждает отметкой в обход списка');
  state=await tick(lena,'user:5');
  assert.equal(state.stage,'approval');assert.equal(state.approvedIdeas,0,'одна отметка из двух план не утверждает');
  assert.equal(week(mentor.get('alpha')).approvedIdeas,0);
  state=await tick(tanya,'user:7');
  assert.equal(state.stage,'smm');assert.equal(week(mentor.get('alpha')).approvedIdeas,7);
  // Без заголовка (настройки не выпущены или никто не выбран) — согласует владелец; битый заголовок — 400.
  assert.equal((await call('GET',lena,undefined,null)).approvers[0].slot,'owner');
  await assert.rejects(call('GET',lena,undefined,'не-json'),e=>e.status===400);
  await assert.rejects(call('GET',lena,undefined,header([{userId:-1}])),e=>e.status===400);
});
