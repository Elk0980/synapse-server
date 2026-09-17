'use strict';
const {createHash} = require('node:crypto');
const {isIP} = require('node:net');

const PLATFORMS = Object.freeze({
  two_gis: {name:'2ГИС', hosts:['2gis.ru','2gis.com'], cabinet:'https://account.2gis.com/',cabinetLabel:'Открыть кабинет'},
  yandex_maps: {name:'Яндекс Карты', hosts:['yandex.ru','yandex.com'], cabinet:'https://business.yandex.ru/',cabinetLabel:'Открыть кабинет'},
  vk: {name:'ВКонтакте', hosts:['vk.com','vk.ru'], cabinet:'https://vk.com/',cabinetLabel:'Открыть ВКонтакте'},
  flamp: {name:'Фламп', hosts:['flamp.ru'], cabinet:'https://flamp.ru/',cabinetLabel:'Открыть Flamp'},
  other: {name:'Другая площадка', hosts:[], cabinet:'',cabinetLabel:'Открыть площадку'},
});
const ERRORS = Object.freeze({
  VALIDATION_ERROR:'Проверьте поля отзыва и ссылки.',
  REVISION_CONFLICT:'Запись изменилась. Обновите список перед сохранением.',
  NOT_FOUND:'Запись не найдена в выбранной компании.',
  CONFIRMATION_REQUIRED:'Укажите опубликованный ответ и ссылку на него.',
  CABINET_LINK_INVALID:'Укажите HTTPS-ссылку на кабинет этой площадки без пароля, токена или параметров входа. Скопируйте обычную ссылку на раздел кабинета.',
});
const fail = (code='VALIDATION_ERROR',status=400) => {throw Object.assign(Error(ERRORS[code]),{code,status});};
const own = (value,key) => Object.hasOwn(value,key);
function object(value,fields) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!fields.includes(key))) fail();
}
function text(value,max,required=false) {
  if (typeof value!=='string' || value.length>max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail();
  const result=value.trim(); if (required&&!result) fail(); return result;
}
function platform(value) {if(typeof value!=='string'||!own(PLATFORMS,value))fail();return value;}
function revision(value) {if(!Number.isSafeInteger(value)||value<0)fail();return value;}
function id(value) {const n=Number(value);if(!Number.isSafeInteger(n)||n<1)fail();return n;}
const allowedQuery = new Set(['id','oid','orgpage','review','review_id','reviewId','sectionId','subsectionId','act','tab','lr','z','w','from','source','utm_source','utm_medium','utm_campaign','utm_content','utm_term']);
function link(value,key,{cabinet=false,optional=false}={}) {
  const invalid=()=>fail(cabinet?'CABINET_LINK_INVALID':'VALIDATION_ERROR');
  let raw;try{raw=text(value,2000,!optional);}catch{invalid();} if(!raw&&optional)return '';
  let url;try {url=new URL(raw);} catch {invalid();}
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.port||/[\\\s]/.test(raw)||isIP(host)||host.startsWith('[')||!host.includes('.')||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host))invalid();
  const hosts=PLATFORMS[key].hosts;
  if(hosts.length&&!hosts.some(base=>host===base||host.endsWith('.'+base)))invalid();
  // Permit public navigation and hash-router deep links, never login tokens.
  const checkParams=params=>{for(const [name,param]of params)if(!allowedQuery.has(name)||param.length>500||/[\u0000-\u001f]/.test(param))invalid();};
  checkParams(url.searchParams);
  if(url.hash) {
    let fragment;try{fragment=decodeURIComponent(url.hash.slice(1));}catch{invalid();}
    if(!/^[a-zA-Z0-9_./=?&-]{1,1000}$/.test(fragment))invalid();
    const query=fragment.includes('?')?fragment.slice(fragment.indexOf('?')+1):fragment.includes('=')?fragment:'';
    if(query)checkParams(new URLSearchParams(query));
  }
  return url.href;
}
function publishedDate(value) {
  if(value===null||value==='')return null;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value))fail();
  const date=new Date(value);if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value.slice(0,10))fail();
  return date.toISOString();
}
function createReviews(db,{now=()=>Date.now()}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS company_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, platform TEXT NOT NULL,
    external_id TEXT, dedup_key TEXT NOT NULL, author TEXT NOT NULL, rating INTEGER,
    text TEXT NOT NULL, published_at TEXT, source_url TEXT NOT NULL, search_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new', draft_reply TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    published_reply TEXT NOT NULL DEFAULT '', reply_url TEXT NOT NULL DEFAULT '', confirmed_at TEXT,
    confirmed_by INTEGER, confirmed_by_name TEXT,
    revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(company_code,platform,dedup_key));
    CREATE INDEX IF NOT EXISTS company_reviews_scope ON company_reviews(company_code,status,id);
    CREATE TABLE IF NOT EXISTS company_review_platforms (
      company_code TEXT NOT NULL, platform TEXT NOT NULL, cabinet_url TEXT NOT NULL, rules TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(company_code,platform));
    CREATE TABLE IF NOT EXISTS company_review_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, review_id INTEGER, platform TEXT NOT NULL,
      action TEXT NOT NULL, revision INTEGER NOT NULL, actor_id INTEGER, actor_name TEXT,
      payload TEXT NOT NULL, created_at TEXT NOT NULL);`);
  const stamp=()=>new Date(now()).toISOString();
  function transaction(run) {
    db.exec('BEGIN IMMEDIATE');try {const result=run();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
  }
  function audit(code,reviewId,key,action,rev,actor,payload,at) {
    db.prepare('INSERT INTO company_review_events(company_code,review_id,platform,action,revision,actor_id,actor_name,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(code,reviewId,key,action,rev,actor?.userId??null,actor?.userName??null,JSON.stringify(payload),at);
  }
  function company(code) {
    if(typeof code!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code))fail();
    const row=db.prepare('SELECT code,name,socials FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if(!row)fail('NOT_FOUND',404);return row;
  }
  function rowFor(code,reviewId) {
    const row=db.prepare('SELECT * FROM company_reviews WHERE company_code=? AND id=?').get(code,id(reviewId));
    if(!row)fail('NOT_FOUND',404);return row;
  }
  const dto=row=>({id:row.id,companyCode:row.company_code,platform:row.platform,externalId:row.external_id,
    author:row.author,rating:row.rating,text:row.text,publishedAt:row.published_at,sourceUrl:row.source_url,
    status:row.status,draftReply:row.draft_reply,note:row.note,publishedReply:row.published_reply,replyUrl:row.reply_url,
    confirmationMode:row.status==='answered'?'manual':null,confirmedAt:row.confirmed_at,
    confirmationBy:row.status==='answered'&&row.confirmed_by?{userId:row.confirmed_by,name:row.confirmed_by_name}:null,
    revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at});
  function platformDto(current,key) {
    const row=db.prepare('SELECT * FROM company_review_platforms WHERE company_code=? AND platform=?').get(current.code,key);
    let socials=current.socials;try {if(typeof socials==='string')socials=JSON.parse(socials);}catch {socials=[];}
    let publicUrl='';
    if(Array.isArray(socials))for(const social of socials) {
      if(social?.type!==key)continue;
      try{publicUrl=link(social.url,key);break;}catch{/* An unsafe legacy link is not exposed. */}
    }
    return {key,name:PLATFORMS[key].name,publicUrl,cabinetUrl:row?.cabinet_url??PLATFORMS[key].cabinet,cabinetLabel:PLATFORMS[key].cabinetLabel,
      rules:row?.rules??'',revision:row?.revision??0,syncMode:'manual',canSync:false,canReply:false,
      reason:'Автоматическое получение отзывов и публикация ответов не подключены. Добавляйте отзывы вручную и отвечайте в кабинете площадки.'};
  }
  function list(code,{limit=100,offset=0,q='',status='',platform:key=''}={}) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0)fail();
    const current=company(code),query=text(q,300),where=['company_code=?'],params=[current.code];
    if(status!==''){if(!['new','in_progress','answered'].includes(status))fail();where.push('status=?');params.push(status);}
    if(key!==''){platform(key);where.push('platform=?');params.push(key);}
    if(query){where.push('instr(search_text,?)>0');params.push(query.toLowerCase());}
    const scope=where.join(' AND '),items=db.prepare(`SELECT * FROM company_reviews WHERE ${scope} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset).map(dto);
    const total=db.prepare(`SELECT COUNT(*) AS n FROM company_reviews WHERE ${scope}`).get(...params).n;
    const counts={total:0,new:0,in_progress:0,answered:0};
    for(const row of db.prepare('SELECT status,COUNT(*) AS count FROM company_reviews WHERE company_code=? GROUP BY status').all(current.code)){counts[row.status]=row.count;counts.total+=row.count;}
    return {company:{code:current.code,name:current.name},items,platforms:Object.keys(PLATFORMS).map(key=>platformDto(current,key)),counts,
      pagination:{total,limit,offset,hasMore:offset+items.length<total}};
  }
  function create(code,body,actor) {
    const current=company(code);object(body,['platform','externalId','author','rating','text','publishedAt','sourceUrl']);
    const key=platform(body.platform),author=text(body.author,200,true),reviewText=text(body.text,12000,true);
    const externalId=body.externalId==null?null:text(body.externalId,200)||null;
    const rating=body.rating??null;if(rating!==null&&(!Number.isInteger(rating)||rating<1||rating>5))fail();
    const publishedAt=body.publishedAt===undefined?null:publishedDate(body.publishedAt),sourceUrl=link(body.sourceUrl,key);
    const dedupKey=createHash('sha256').update(JSON.stringify(externalId?['external',externalId]:['content',author,reviewText,publishedAt,sourceUrl])).digest('hex');
    const at=stamp();
    return transaction(()=>{
    const inserted=db.prepare(`INSERT INTO company_reviews(company_code,platform,external_id,dedup_key,author,rating,text,published_at,source_url,search_text,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_code,platform,dedup_key) DO NOTHING`)
      .run(current.code,key,externalId,dedupKey,author,rating,reviewText,publishedAt,sourceUrl,(author+'\n'+reviewText).toLowerCase(),at,at).changes;
    const row=db.prepare('SELECT * FROM company_reviews WHERE company_code=? AND platform=? AND dedup_key=?').get(current.code,key,dedupKey);
    if(inserted)audit(current.code,row.id,key,'created',row.revision,actor,{sourceUrl,externalId},at);
    return {item:dto(row),duplicate:!inserted};
    });
  }
  function update(code,reviewId,body,actor) {
    const current=company(code);object(body,['revision','status','draftReply','note','publishedReply','replyUrl']);revision(body.revision);
    const row=rowFor(current.code,reviewId);if(row.revision!==body.revision)fail('REVISION_CONFLICT',409);
    const status=own(body,'status')?body.status:row.status;if(!['new','in_progress','answered'].includes(status))fail();
    const draftReply=own(body,'draftReply')?text(body.draftReply,12000):row.draft_reply;
    const note=own(body,'note')?text(body.note,12000):row.note;
    const publishedReply=own(body,'publishedReply')?text(body.publishedReply,12000):row.published_reply;
    const replyUrl=own(body,'replyUrl')?link(body.replyUrl,row.platform,{optional:true}):row.reply_url;
    if(status==='answered'&&(!publishedReply||!replyUrl))fail('CONFIRMATION_REQUIRED');
    const confirmationChanged=status==='answered'&&(row.status!=='answered'||row.published_reply!==publishedReply||row.reply_url!==replyUrl);
    const at=stamp(),confirmedAt=status==='answered'?(confirmationChanged?at:row.confirmed_at):null;
    const confirmedBy=status==='answered'?(confirmationChanged?actor?.userId??null:row.confirmed_by):null;
    const confirmedByName=status==='answered'?(confirmationChanged?actor?.userName??null:row.confirmed_by_name):null;
    return transaction(()=>{
      const searchText=[row.author,row.text,draftReply].join('\n').toLowerCase();
      const changed=db.prepare(`UPDATE company_reviews SET status=?,draft_reply=?,note=?,published_reply=?,reply_url=?,confirmed_at=?,confirmed_by=?,confirmed_by_name=?,search_text=?,revision=revision+1,updated_at=?
        WHERE company_code=? AND id=? AND revision=?`).run(status,draftReply,note,publishedReply,replyUrl,confirmedAt,confirmedBy,confirmedByName,searchText,at,current.code,row.id,body.revision).changes;
      if(!changed)fail('REVISION_CONFLICT',409);
      audit(current.code,row.id,row.platform,confirmationChanged?'manual_confirmation':'updated',row.revision+1,actor,
        {previousStatus:row.status,status,...(confirmationChanged?{publishedReply,replyUrl}:{}),fields:Object.keys(body).filter(key=>key!=='revision')},at);
      return {item:dto(rowFor(current.code,row.id))};
    });
  }
  function savePlatform(code,key,body,actor) {
    const current=company(code);platform(key);object(body,['revision','cabinetUrl','rules']);revision(body.revision);
    const cabinetUrl=link(body.cabinetUrl,key,{cabinet:true,optional:key==='other'}),rules=text(body.rules,12000);
    return transaction(()=>{
      const previous=db.prepare('SELECT revision FROM company_review_platforms WHERE company_code=? AND platform=?').get(current.code,key);
      if(body.revision!==(previous?.revision??0))fail('REVISION_CONFLICT',409);
      db.prepare(`INSERT INTO company_review_platforms(company_code,platform,cabinet_url,rules,revision,updated_at) VALUES(?,?,?,?,1,?)
        ON CONFLICT(company_code,platform) DO UPDATE SET cabinet_url=excluded.cabinet_url,rules=excluded.rules,revision=company_review_platforms.revision+1,updated_at=excluded.updated_at`)
        .run(current.code,key,cabinetUrl,rules,stamp());
      audit(current.code,null,key,'platform_updated',body.revision+1,actor,{cabinetUrl,rules},stamp());
      return {platform:platformDto(current,key)};
    });
  }
  return {list,create,update,savePlatform};
}
module.exports={createReviews,REVIEW_ERRORS:ERRORS};
