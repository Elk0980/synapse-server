'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');
const {createContentPlanJobs}=require('./content-plan-jobs');
const {createContentPlanDrafts}=require('./content-plan-drafts');
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'alpha','Альфа','Asia/Irkutsk','[]'),(2,'beta','Бета','UTC','[]')");
 const information=createCompanyInformation(db),autoposting=createAutoposting(db,{information,transport:{getSettings:()=>({channels:[]}),publish:async()=>{throw Error('No sends')}}});
 const jobs=createContentPlanJobs(db),drafts=createContentPlanDrafts(db,{jobs,autoposting,allowTestResults:true});
 const job=jobs.enqueue('alpha',{clientRequestId:'draft_test_01',month:'2026-10',snapshot:{}}),lease=jobs.claim();
 jobs.setExecutor(lease.id,lease.token,{kind:'test',model:'synthetic-only'});
 const proposals=[1,2].map(i=>({ideaId:'proposal_'+i,date:'2026-10-0'+i,platform:'telegram',format:'post',role:'reach',topic:'Идея '+i,text:'Текст '+i,hook:'Начало',mentorNote:'Проверить факты',assetId:'',basis:[],warnings:[]}));
 jobs.complete(lease.id,lease.token,proposals);
 return {db,information,autoposting,jobs,drafts,job,proposals};
}
test('перенос атомарен и идемпотентен; плановая дата не ставит публикацию в расписание',async t=>{
 const f=fixture(t),before=f.autoposting.create('alpha',{title:'Существующая',text:'Ручной текст',platformIds:['telegram']},7);
 const input={proposalIds:f.proposals.map(p=>p.ideaId)},first=f.drafts.transfer('alpha',f.job.id,input,{userId:7});
 assert.equal(first.createdCount,2);const second=f.drafts.transfer('alpha',f.job.id,input,{userId:7});
 assert.equal(second.createdCount,0);assert.deepEqual(second.drafts,first.drafts);
 for(const ref of first.drafts){const p=f.autoposting.get(ref.postId,'alpha');assert.equal(p.status,'draft');assert.equal(p.scheduledAt,null);assert.equal(p.approval.approved,false);}
 const calendar=await f.autoposting.calendar('alpha',{from:'2026-10-01',to:'2026-10-31'});
 for(const [i,ref] of first.drafts.entries()){const p=calendar.posts.find(p=>p.id===ref.postId);assert.equal(p.effectiveDate,f.proposals[i].date);assert.equal(p.dateKind,'plan');assert.equal(p.publishDate,null);}
 assert.equal(f.autoposting.get(before.id,'alpha').text,'Ручной текст');
 assert.equal(f.db.prepare('SELECT count(*) n FROM autoposting_deliveries').get().n,0);
});
test('чужая компания, неизвестное предложение и тестовый результат блокируются',t=>{
 const f=fixture(t);
 assert.throws(()=>f.drafts.transfer('beta',f.job.id,{proposalIds:['proposal_1']}),e=>e.status===404);
 assert.throws(()=>f.drafts.transfer('alpha',f.job.id,{proposalIds:['proposal_1','missing']}),e=>e.status===404);
 assert.equal(f.db.prepare('SELECT count(*) n FROM autoposting_posts').get().n,0);
 const production=createContentPlanDrafts(f.db,{jobs:f.jobs,autoposting:f.autoposting});
 assert.throws(()=>production.transfer('alpha',f.job.id,{proposalIds:['proposal_1']}),e=>e.details.code==='TEST_RESULT');
});
test('ошибка второй карточки откатывает первую и карту переноса; последующий повтор создаёт ровно две',t=>{
 const f=fixture(t);let calls=0;
 const failing=createContentPlanDrafts(f.db,{jobs:f.jobs,allowTestResults:true,autoposting:{create(...args){if(++calls===2)throw Error('Disk test failure');return f.autoposting.create(...args)}}});
 const input={proposalIds:['proposal_1','proposal_2']};assert.throws(()=>failing.transfer('alpha',f.job.id,input),/Disk test/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM autoposting_posts').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM content_plan_drafts').get().n,0);
 assert.equal(f.drafts.transfer('alpha',f.job.id,input).createdCount,2);
});
