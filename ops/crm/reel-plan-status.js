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
  days=days.map(day=>day.productionStatus==='published'?{...day,productionStatus:'planned'}:day);
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
// Одноразовая сверка связей по данным базы. Точное совпадение темы публикации и файла
// в той же компании; неоднозначные связи и уже связанные пункты не перезаписываются.
function backfillPlanLinks(db,options={}){
  if(!options.apply)return scanPlanLinks(db,options);
  db.exec('BEGIN IMMEDIATE');
  try{const result=scanPlanLinks(db,options);db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
}
function scanPlanLinks(db,{companyId,apply=false}={}){
  if(!Number.isSafeInteger(companyId)||companyId<1)throw Object.assign(Error('Нужна компания'),{status:400});
  const row=db.prepare('SELECT plan FROM media_mentor_plans WHERE company_id=?').get(companyId);
  if(!row)return {linked:0,candidates:[],ambiguous:[],dryRun:!apply};
  const norm=value=>String(value||'').normalize('NFC').trim().toLocaleLowerCase('ru-RU');
  const materials=db.prepare(`SELECT r.id reelId,p.id postId,p.title,p.media_urls FROM reel_materials r JOIN autoposting_posts p ON p.id=r.post_id AND p.company_id=r.company_id
    WHERE r.company_id=? AND (EXISTS(SELECT 1 FROM autoposting_deliveries d WHERE d.post_id=p.id AND (d.status='published' OR d.provider_status='published'))
      OR EXISTS(SELECT 1 FROM autoposting_publication_receipts x WHERE x.post_id=p.id AND x.content_revision=p.content_revision))`).all(companyId);
  const candidates=[],ambiguous=[];
  const hasLinks=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reel_plan_links'").get();
  for(const day of JSON.parse(row.plan).days){
    const matches=materials.filter(m=>norm(m.title)===norm(day.topic)&&norm(day.topic)&&db.prepare('SELECT media_url FROM reel_versions WHERE reel_id=?').all(m.reelId).some(v=>JSON.parse(m.media_urls||'[]').includes(v.media_url)));
    if(matches.length!==1){if(matches.length)ambiguous.push(day.ideaId);continue;}
    const m=matches[0];
    const existing=hasLinks&&db.prepare('SELECT * FROM reel_plan_links WHERE company_id=? AND (idea_id=? OR reel_id=?)').all(companyId,day.ideaId,m.reelId);
    if(existing?.length){if(!existing.every(x=>x.idea_id===day.ideaId&&x.reel_id===m.reelId))ambiguous.push(day.ideaId);continue;}
    candidates.push({ideaId:day.ideaId,reelId:m.reelId,postId:m.postId});
  }
  const unique=candidates.filter(c=>{if(candidates.filter(x=>x.reelId===c.reelId).length===1)return true;ambiguous.push(c.ideaId);return false;});
  if(apply)for(const c of unique)link(db,companyId,c.ideaId,c.reelId);
  return {linked:apply?unique.length:0,candidates:unique,ambiguous,dryRun:!apply};
}
module.exports={init,link,statuses,backfillPlanLinks};
