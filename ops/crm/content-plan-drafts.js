'use strict';
const {company,object,fail}=require('./company-information');
function createContentPlanDrafts(db,{jobs,autoposting,allowTestResults=false}){
 db.exec(`CREATE TABLE IF NOT EXISTS content_plan_drafts (
  job_id TEXT NOT NULL REFERENCES content_plan_jobs(id),proposal_id TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),
  planned_date TEXT NOT NULL,platform TEXT NOT NULL,PRIMARY KEY(job_id,proposal_id),UNIQUE(post_id));`);
 function transfer(code,id,body,actor={}){
  object(body,['proposalIds']);
  if(!Array.isArray(body.proposalIds)||!body.proposalIds.length||body.proposalIds.length>651||body.proposalIds.some(x=>typeof x!=='string')||new Set(body.proposalIds).size!==body.proposalIds.length)fail(400,'Выберите разные предложения плана');
  db.exec('BEGIN IMMEDIATE');
  try{
   const owner=company(db,code),job=jobs.get(code,id).job;
   if(job.status!=='succeeded')fail(409,'Подготовка плана ещё не завершена','PLAN_NOT_READY');
   if(job.executor?.kind==='test'&&!allowTestResults)fail(409,'Тестовый результат нельзя переносить в рабочие материалы','TEST_RESULT');
   const selected=body.proposalIds.map(proposalId=>{const p=job.proposals.find(x=>x.ideaId===proposalId);if(!p)fail(404,'Предложение не найдено','NOT_FOUND');return p});
   const drafts=[];let createdCount=0;
   for(const p of selected){
    const existing=db.prepare('SELECT post_id FROM content_plan_drafts WHERE company_id=? AND job_id=? AND proposal_id=?').get(owner.id,id,p.ideaId);
    if(existing){const saved=db.prepare('SELECT archived_at FROM autoposting_posts WHERE id=? AND company_id=?').get(existing.post_id,owner.id);drafts.push({proposalId:p.ideaId,postId:existing.post_id,archivedAt:saved?.archived_at||null});continue}
    // A date in the proposal is not a publication time. Preserve it in the calendar mapping, never schedule.
    const post=autoposting.create(code,{title:p.topic.slice(0,200),text:p.text,mediaUrls:[],platformIds:[p.platform],scheduledAt:null,
     captions:{[p.platform]:p.text},format:p.format,role:p.role,hook:p.hook,idea:p.topic,hughNote:p.mentorNote,
     origin:`content-plan:${id}:${p.ideaId}`},actor.userId??null);
    db.prepare('INSERT INTO content_plan_drafts(job_id,proposal_id,company_id,post_id,planned_date,platform) VALUES(?,?,?,?,?,?)').run(id,p.ideaId,owner.id,post.id,p.date,p.platform);
    drafts.push({proposalId:p.ideaId,postId:post.id,archivedAt:null});createdCount++;
   }
   db.exec('COMMIT');return {companyCode:owner.code,jobId:id,drafts,createdCount};
  }catch(error){db.exec('ROLLBACK');throw error}
 }
 return {transfer};
}
module.exports={createContentPlanDrafts};
