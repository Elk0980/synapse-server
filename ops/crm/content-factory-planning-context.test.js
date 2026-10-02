'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createPlanningInsights,UNAVAILABLE_LIMITATION}=require('./content-factory-planning-insights');
const {validatePlanningContext,planningPromptContext}=require('./content-factory-planning-context');
const {createMediaMentor}=require('./media-mentor');
const {createContentPlanJobs}=require('./content-plan-jobs');
const {createContentPlanService}=require('./content-plan-service');
const {promptFor}=require('./content-plan-worker');
const capture=()=>createPlanningInsights({now:()=>Date.parse('2026-10-01T12:00:00.000Z'),stats:{overview:()=>({companyCode:'alpha',from:'2026-09-01',to:'2026-09-30',timezone:'UTC',platforms:{}})}}).capture('alpha','2026-10');
test('снимок ограничен фиксированными текстами; model projection не содержит collector dates/timezone/ids',()=>{
 const context=capture(),saved=validatePlanningContext(context,'alpha','2026-10');assert.deepEqual(saved,context);context.source.capturedAt='2026-10-02T12:00:00.000Z';assert.notEqual(saved.source.capturedAt,context.source.capturedAt);
 const model=planningPromptContext(saved,'alpha','2026-10'),text=JSON.stringify(model);
 for(const forbidden of ['companyCode','planMonth','capturedAt','lastCollectedAt','timezone','accountRef','provider'])assert.equal(text.includes(forbidden),false,forbidden);
 for(const mutate of [c=>c.companyCode='beta',c=>c.planMonth='2026-11',c=>c.source.period.from='2026-08-01',c=>c.source.token='private',
   c=>c.limitations.push('upstream private failure'),c=>c.platforms[0].editorialRecommendations.push({code:'RANK_WINNER',text:'Частная тема'}),
   c=>c.platforms[0].editorialRecommendations.push({code:'CHECK_FRESHNESS',text:'https://private.invalid/account'}),c=>c.platforms[0].freshness.lastCollectedAt='not-date']){
   const bad=structuredClone(saved);mutate(bad);assert.throws(()=>validatePlanningContext(bad,'alpha','2026-10'),{status:400});
 }
});
test('ошибка сохранённой статистики не блокирует план, snapshot неизменен при replay и после restart',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,timezone TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0);INSERT INTO companies VALUES(1,'alpha','Альфа','UTC','[]',0)");
 const mentor=createMediaMentor(db),jobs=createContentPlanJobs(db),service=createContentPlanService({mentor,jobs});
 const context=createPlanningInsights({stats:{overview(){throw Error('private account/token');}}}).capture('alpha','2026-10');
 assert.deepEqual(context.limitations,[UNAVAILABLE_LIMITATION]);
 const request={clientRequestId:'planning-context-request',month:'2026-10'},result=service.create('alpha',request,null,context);
 const saved=db.prepare('SELECT snapshot,snapshot_hash FROM content_plan_jobs WHERE id=?').get(result.job.id);
 assert.deepEqual(JSON.parse(saved.snapshot).planningInsights,context);assert.equal(saved.snapshot.includes('private account/token'),false);
 assert.throws(()=>service.create('alpha',{...request,clientRequestId:'other',planningInsights:context}),{status:400});
 const throwing=new Proxy({}, {ownKeys(){throw Error('Should not recapture');}});
 assert.equal(createContentPlanService({mentor:{get(){throw Error('No reads');}},jobs:createContentPlanJobs(db)}).create('alpha',request,null,throwing).job.id,result.job.id);
 assert.deepEqual(db.prepare('SELECT snapshot,snapshot_hash FROM content_plan_jobs WHERE id=?').get(result.job.id),saved);
});
test('prompt использует только качество и фиксированные рекомендации, совместим со старой задачей',()=>{
 const snapshot={brief:{assets:[]},profile:{},monthInputs:{platforms:['telegram'],perDay:{telegram:1}},planningInsights:capture()},job={id:'test',companyCode:'alpha',month:'2026-10',snapshot};
 const prompt=promptFor(job,[{date:'2026-10-01',platform:'telegram'}]);assert.match(prompt[0].content,/не рейтинг тем/);assert.match(prompt[0].content,/missing не равно нулю/);
 assert.deepEqual(JSON.parse(prompt[1].content).planningInsights,planningPromptContext(snapshot.planningInsights,'alpha','2026-10'));
 const legacy={...job,snapshot:{...snapshot}};delete legacy.snapshot.planningInsights;assert.equal('planningInsights' in JSON.parse(promptFor(legacy,[{date:'2026-10-01',platform:'telegram'}])[1].content),false);
 const foreign={...job,snapshot:{...snapshot,planningInsights:{...snapshot.planningInsights,companyCode:'beta'}}};assert.throws(()=>promptFor(foreign),{code:'INVALID_RESULT'});
});
