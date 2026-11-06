'use strict';
// Только связь, без копирования статусов: факты каждый раз читаются из автопостинга.
function init(db){db.exec(`CREATE TABLE IF NOT EXISTS reel_plan_links(company_id INTEGER NOT NULL,idea_id TEXT NOT NULL,reel_id INTEGER NOT NULL REFERENCES reel_materials(id),PRIMARY KEY(company_id,idea_id),UNIQUE(company_id,reel_id))`);}
function link(db,companyId,ideaId,reelId){
  init(db);
  const row=db.prepare('SELECT plan FROM media_mentor_plans WHERE company_id=?').get(companyId);
  if(!row||!JSON.parse(row.plan).days.some(d=>d.ideaId===ideaId))throw Object.assign(Error('Пункт плана не найден'),{status:404});
  if(!db.prepare('SELECT id FROM reel_materials WHERE id=? AND company_id=?').get(reelId,companyId))throw Object.assign(Error('Рилс не найден'),{status:404});
  db.prepare('INSERT INTO reel_plan_links(company_id,idea_id,reel_id) VALUES(?,?,?) ON CONFLICT(company_id,idea_id) DO UPDATE SET reel_id=excluded.reel_id').run(companyId,ideaId,reelId);
}
function statuses(db,companyId,days){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reel_plan_links'").get())return days;
  return days.map(day=>{
    const link=db.prepare('SELECT reel_id FROM reel_plan_links WHERE company_id=? AND idea_id=?').get(companyId,day.ideaId);if(!link)return day;
    const a=db.prepare('SELECT * FROM reel_chat_approvals WHERE company_id=? AND reel_id=? ORDER BY id DESC LIMIT 1').get(companyId,link.reel_id);
    const postId=a?.post_id||db.prepare('SELECT post_id FROM reel_materials WHERE id=? AND company_id=?').get(link.reel_id,companyId)?.post_id;
    if(!postId)return {...day,reelId:link.reel_id};
    const p=db.prepare('SELECT * FROM autoposting_posts WHERE id=? AND company_id=?').get(postId,companyId);if(!p)return day;
    const items=db.prepare('SELECT channel_id platform,status,url,provider_status FROM autoposting_deliveries WHERE post_id=?').all(postId)
      .map(d=>({platform:d.platform,published:d.status==='published'||d.provider_status==='published',url:d.url||null}));
    for(const r of db.prepare('SELECT platform,url FROM autoposting_publication_receipts WHERE post_id=? AND content_revision=?').all(postId,p.content_revision)){const i=items.find(i=>i.platform===r.platform);if(i){i.published=true;i.url=r.url;}else items.push({platform:r.platform,published:true,url:r.url});}
    const selected=JSON.parse(p.platform_ids||'[]');
    const complete=selected.length&&selected.every(id=>items.some(i=>i.platform===id&&i.published));
    const same=a&&a.content_revision===p.content_revision;
    const reviews=db.prepare('SELECT * FROM autoposting_platform_reviews WHERE post_id=?').all(postId);
    const approved=same&&(p.approved_revision===p.content_revision||selected.every(id=>reviews.some(r=>r.platform_id===id&&r.state==='approved'&&r.content_revision===p.content_revision)));
    const review=reviews.find(r=>r.state==='approved'&&r.content_revision===p.content_revision);
    return {...day,reelId:link.reel_id,publication:{postId,version:a?.version||null,items,
      approved:Boolean(approved),approvedBy:p.approved_by_name||review?.actor_name||null,approvedAt:p.approved_at||review?.created_at||null},
      ...(complete?{productionStatus:'published'}:{})};
  });
}
// Разовая привязка №1: только точное совпадение названия и компании и единственный рилс.
// По умолчанию только план; apply разрешён выпускающему отдельно от этой задачи.
function backfillAvokado(db,{apply=false}={}){
  const c=db.prepare("SELECT id FROM companies WHERE code='avokado' COLLATE NOCASE").get();if(!c)return {linked:0,reason:'NO_COMPANY'};
  const matches=db.prepare("SELECT id,post_id FROM reel_materials WHERE company_id=? AND title='Массаж сжигает жир?' AND post_id IS NOT NULL").all(c.id);
  if(matches.length!==1)return {linked:0,reason:'AMBIGUOUS_OR_MISSING',candidates:matches.length};
  const id='import-2a058bbdfcc41317505dc4cb5eff62ce-1';
  if(apply)link(db,c.id,id,matches[0].id);
  return {linked:apply?1:0,ideaId:id,reelId:matches[0].id,postId:matches[0].post_id,dryRun:!apply};
}
module.exports={init,link,statuses,backfillAvokado};
