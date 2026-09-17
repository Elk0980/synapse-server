'use strict';

const {company,fail,object,revision}=require('./company-information');
const plan=require('./studio-content-plan-data.json');
const PLATFORMS=['vk','telegram'];
const REVIEW_NOTE='Это стартовые черновики. Перед публикацией сверьте услуги, длительность и условия с актуальными данными компании. Импорт не означает, что эта проверка выполнена. Изображения, каналы и даты публикаций нужно выбрать отдельно.';
const templates=new Map(plan.companies.map(item=>[item.key,item]));

function templateFor(code){return typeof code==='string'?templates.get(code.toLowerCase()):undefined;}

function createStudioContentPlan(db,{autoposting,information,now=Date.now}={}){
  if(!autoposting||typeof autoposting.get!=='function'||!information||typeof information.get!=='function')throw Error('Studio content plan requires autoposting and company information');
  db.exec(`CREATE TABLE IF NOT EXISTS studio_content_plan_imports (
    id INTEGER PRIMARY KEY,company_id INTEGER NOT NULL REFERENCES companies(id),
    platform TEXT NOT NULL CHECK(platform IN ('vk','telegram')),plan_version TEXT NOT NULL,
    profile_revision INTEGER NOT NULL,created_at TEXT NOT NULL,created_by INTEGER,
    UNIQUE(company_id,platform,plan_version));
    CREATE TABLE IF NOT EXISTS studio_content_plan_items (
    import_id INTEGER NOT NULL REFERENCES studio_content_plan_imports(id),
    template_id TEXT NOT NULL,post_id INTEGER NOT NULL UNIQUE REFERENCES autoposting_posts(id),
    ordinal INTEGER NOT NULL,PRIMARY KEY(import_id,template_id));`);

  function receipt(owner,platform){
    const row=db.prepare(`SELECT id,created_at importedAt,profile_revision profileRevision FROM studio_content_plan_imports
      WHERE company_id=? AND platform=? AND plan_version=?`).get(owner.id,platform,plan.planVersion);
    if(!row)return null;
    const items=db.prepare(`SELECT i.post_id postId FROM studio_content_plan_items i
      JOIN autoposting_posts p ON p.id=i.post_id AND p.company_id=?
      WHERE i.import_id=? ORDER BY i.ordinal`).all(owner.id,row.id);
    if(items.length!==7)fail(409,'Не удалось восстановить список черновиков. Проверьте предыдущий импорт.','STARTER_PLAN_INCOMPLETE');
    return {importedAt:row.importedAt,profileRevision:row.profileRevision,postIds:items.map(item=>item.postId)};
  }

  function get(code){
    const template=templateFor(code);
    if(!template)return {available:false,companyCode:typeof code==='string'?code.toLowerCase():null};
    const owner=company(db,code),current=information.get(code);
    return {available:true,companyCode:owner.code.toLowerCase(),planVersion:plan.planVersion,title:plan.title,
      timezone:plan.timezone,profileRevision:current.revision,requiresLiveCompanyReview:true,reviewNote:REVIEW_NOTE,
      platforms:[...PLATFORMS],topics:template.posts.map(post=>({id:post.id,title:post.title,dayOffset:post.dayOffset,
        localTime:post.localTime,goal:post.goal,format:post.format,mediaBrief:post.mediaBrief})),
      imports:Object.fromEntries(PLATFORMS.map(platform=>[platform,receipt(owner,platform)]))};
  }

  function importPlan(code,body,actorId=null){
    const template=templateFor(code);
    if(!template)fail(400,'Для этой компании стартовый план не подготовлен','STARTER_PLAN_UNAVAILABLE');
    object(body,['platform','profileRevision']);
    if(!PLATFORMS.includes(body.platform))fail(400,'Выберите ВКонтакте или Telegram');
    revision(body.profileRevision);
    const current=information.get(code);
    if(current.revision!==body.profileRevision)fail(409,'Данные компании изменились. Обновите план перед импортом.','PROFILE_CHANGED');
    let result,created=false;
    db.exec('BEGIN IMMEDIATE');
    try{
      const owner=company(db,code);
      const locked=db.prepare('SELECT revision FROM company_information WHERE company_id=?').get(owner.id);
      if(!locked||locked.revision!==body.profileRevision)fail(409,'Данные компании изменились. Обновите план перед импортом.','PROFILE_CHANGED');
      result=receipt(owner,body.platform);
      if(!result){
        if(template.posts.length!==7)throw Error('Starter plan must contain exactly seven posts');
        const timestamp=new Date(now()).toISOString();
        const importId=db.prepare(`INSERT INTO studio_content_plan_imports(company_id,platform,plan_version,profile_revision,created_at,created_by)
          VALUES(?,?,?,?,?,?)`).run(owner.id,body.platform,plan.planVersion,current.revision,timestamp,actorId).lastInsertRowid;
        const insert=db.prepare(`INSERT INTO autoposting_posts
          (company_id,status,title,text,media_urls,platform_ids,scheduled_at,timezone,profile_revision,created_at,updated_at,created_by)
          VALUES(?,'draft',?,?,'[]','[]',NULL,?,?,?,?,?)`);
        // information.get owns a transaction, so autoposting.create cannot run inside this transaction.
        // Insert only bundled, validated draft text here: no channels, attachments, schedule or delivery rows.
        // The import marker and all seven posts commit together, including on a retry after a lost response.
        for(const [ordinal,post]of template.posts.entries()){
          const text=post.channelVariants[body.platform]?.body;
          if(typeof post.title!=='string'||!post.title.trim()||post.title.length>200||typeof text!=='string'||!text.trim()||text.length>20000||/\x00/.test(post.title+text))throw Error('Invalid starter content');
          const postId=insert.run(owner.id,post.title,text,plan.timezone,current.revision,timestamp,timestamp,actorId).lastInsertRowid;
          db.prepare('INSERT INTO studio_content_plan_items(import_id,template_id,post_id,ordinal) VALUES(?,?,?,?)')
            .run(importId,post.id,postId,ordinal);
        }
        result=receipt(owner,body.platform);created=true;
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    // Read through the normal API after commit; it may refresh company information or invalidate schedules.
    return {companyCode:code.toLowerCase(),planVersion:plan.planVersion,platform:body.platform,created,alreadyImported:!created,
      ...result,posts:result.postIds.map(id=>autoposting.get(id,code)),requiresLiveCompanyReview:true,reviewNote:REVIEW_NOTE};
  }
  return {get,import:importPlan};
}

module.exports={createStudioContentPlan};
