'use strict';
const {createHash,randomUUID}=require('node:crypto');
const fail=(code,message)=>{throw Object.assign(Error(message),{status:409,details:{code},code})};
const has=(db,t)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
function link(db,row){if(!row||!has(db,'media_mentor_publication_copy_links'))return null;return db.prepare('SELECT * FROM media_mentor_publication_copy_links WHERE company_id=? AND post_id=?').get(row.company_id,row.id)||null;}
function fingerprint(row){return createHash('sha256').update(JSON.stringify([row.content_revision,row.title,row.text,row.media_urls,row.media_sha256,row.expected_media_sha256,row.expected_media_file,row.platform_ids,row.captions,row.platform_options,row.meta])).digest('hex');}
function brief(db,id){return db.prepare('SELECT revision FROM media_mentor_briefs WHERE company_id=?').get(id)?.revision||0;}
function blocked(db,row){const bound=link(db,row);if(!bound)return '';const last=db.prepare('SELECT * FROM media_mentor_publication_copy_decisions WHERE company_id=? AND post_id=? ORDER BY sequence DESC LIMIT 1').get(row.company_id,row.id);return last&&last.decision==='approved'&&last.fingerprint===fingerprint(row)&&last.brief_revision===brief(db,row.company_id)?'':'PLAN_APPROVAL_REVOKED';}
function create(db){
 db.exec(`CREATE TABLE IF NOT EXISTS media_mentor_publication_copy_links(
 company_id INTEGER NOT NULL REFERENCES companies(id),post_id INTEGER PRIMARY KEY REFERENCES autoposting_posts(id),
 version_id TEXT NOT NULL UNIQUE,source_post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),source_revision INTEGER NOT NULL,
 source_content_revision INTEGER NOT NULL,source_plan TEXT NOT NULL,target_platform TEXT NOT NULL,
 original_snapshot TEXT NOT NULL,created_at TEXT NOT NULL,actor_id INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS media_mentor_publication_copy_decisions(
 company_id INTEGER NOT NULL REFERENCES companies(id),post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),sequence INTEGER NOT NULL,
 version_id TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('approved','withdrawn')),fingerprint TEXT NOT NULL,
 content_revision INTEGER NOT NULL,brief_revision INTEGER NOT NULL,snapshot TEXT NOT NULL,actor_id INTEGER NOT NULL,
 created_at TEXT NOT NULL,PRIMARY KEY(company_id,post_id,sequence));
 CREATE TRIGGER IF NOT EXISTS media_mentor_publication_copy_links_no_update BEFORE UPDATE ON media_mentor_publication_copy_links BEGIN SELECT RAISE(ABORT,'Immutable publication copy provenance'); END;
 CREATE TRIGGER IF NOT EXISTS media_mentor_publication_copy_links_no_delete BEFORE DELETE ON media_mentor_publication_copy_links BEGIN SELECT RAISE(ABORT,'Immutable publication copy provenance'); END;
 CREATE TRIGGER IF NOT EXISTS media_mentor_publication_copy_decisions_no_update BEFORE UPDATE ON media_mentor_publication_copy_decisions BEGIN SELECT RAISE(ABORT,'Immutable publication copy decision'); END;
 CREATE TRIGGER IF NOT EXISTS media_mentor_publication_copy_decisions_no_delete BEFORE DELETE ON media_mentor_publication_copy_decisions BEGIN SELECT RAISE(ABORT,'Immutable publication copy decision'); END;`);
 function capture(row,source,sourceLink,actor){
  if(!Number.isSafeInteger(actor?.userId)||!sourceLink)fail('PLAN_COPY_CONTEXT','Не найден источник версии плана');
  const historical=db.prepare('SELECT plan,brief_revision FROM media_mentor_plan_versions WHERE company_id=? AND revision=?').get(source.company_id,sourceLink.planRevision);
  if(!historical)fail('PLAN_COPY_SOURCE','Не найдена неизменяемая исходная версия плана');
  const idea=(JSON.parse(historical.plan).days||[]).find(x=>x.ideaId===sourceLink.ideaId),variant=idea?.variants?.[sourceLink.platform];
  if(!variant||variant.contentRevision!==sourceLink.contentRevision)fail('PLAN_COPY_SOURCE','Исходная версия площадки не найдена в истории плана');
  const targets=JSON.parse(row.platform_ids);if(targets.length!==1)fail('PLAN_COPY_TARGET','Выберите одну площадку для каждой копии');
  const versionId=randomUUID(),provenance={...sourceLink,briefRevision:historical.brief_revision,idea};
  db.prepare('INSERT INTO media_mentor_publication_copy_links(company_id,post_id,version_id,source_post_id,source_revision,source_content_revision,source_plan,target_platform,original_snapshot,created_at,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(row.company_id,row.id,versionId,source.id,source.revision,source.content_revision,JSON.stringify(provenance),targets[0],JSON.stringify(row),new Date().toISOString(),actor.userId);
  return {versionId,status:'pending',sourcePostId:source.id,sourceRevision:source.revision,sourceContentRevision:source.content_revision,sourcePlanRevision:sourceLink.planRevision,platform:targets[0]};
 }
 // Called from the existing owner approval transaction, NEVER from copy creation.
 // A fresh independent plan-version decision is appended; source/current accepted plan is not modified.
 function decide(row,approved,actor){const bound=link(db,row);if(!bound)return;
  if(actor?.role!=='owner'||!Number.isSafeInteger(actor.userId))throw Object.assign(Error('Новую версию плана согласовывает владелец'),{status:403,details:{code:'FORBIDDEN'}});
  const platforms=JSON.parse(row.platform_ids);if(platforms.length!==1||platforms[0]!==bound.target_platform)fail('PLAN_PLATFORM_MISMATCH','Создайте отдельную копию для другой площадки');
  const currentBrief=brief(db,row.company_id);if(!currentBrief)fail('BRIEF_REQUIRED','Сначала заполните действующий бриф компании');
  const seq=(db.prepare('SELECT MAX(sequence) n FROM media_mentor_publication_copy_decisions WHERE company_id=? AND post_id=?').get(row.company_id,row.id).n||0)+1;
  db.prepare('INSERT INTO media_mentor_publication_copy_decisions(company_id,post_id,sequence,version_id,decision,fingerprint,content_revision,brief_revision,snapshot,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(row.company_id,row.id,seq,bound.version_id,approved?'approved':'withdrawn',fingerprint(row),row.content_revision,currentBrief,JSON.stringify(row),actor.userId,new Date().toISOString());
 }
 return {capture,decide,link:row=>link(db,row),blocked:row=>blocked(db,row)};
}
module.exports={create,link,blocked,fingerprint};
