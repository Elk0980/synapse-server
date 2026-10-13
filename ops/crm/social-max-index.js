'use strict';
// Только индекс native постов своего канала и курсор их повторного чтения. Не люди/деньги.
const {createHash}=require('node:crypto');
const {normalizeMaxId}=require('./social-max-access');
const company=value=>{if(typeof value!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value))throw Object.assign(new Error('Неверный контекст MAX'),{code:'MAX_INDEX_CONTEXT'});return value.toLowerCase();};
const id=value=>{const n=normalizeMaxId(value);if(n===null)throw Object.assign(new Error('Неверный канал MAX'),{code:'MAX_INDEX_CONTEXT'});return n;};
const mid=value=>{if(typeof value!=='string'||value.length>204||!/^(?:mid\.)?[A-Za-z0-9_-]+$/.test(value))throw Object.assign(new Error('Неверный native ID поста'),{code:'MAX_INDEX_CONTEXT'});return value;};
const timestamp=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value)))throw Object.assign(new Error('Неверное native время поста'),{code:'MAX_INDEX_CONTEXT'});return new Date(value).toISOString();};
const postKey=(code,chat,native)=>'max:'+createHash('sha256').update(code+'\0'+chat+'\0'+native).digest('hex');
function createSocialMaxIndex(db){
 db.exec(`CREATE TABLE IF NOT EXISTS social_max_post_index(company_code TEXT NOT NULL COLLATE NOCASE,chat_id TEXT NOT NULL,native_post_id TEXT NOT NULL,post_key TEXT NOT NULL,published_at TEXT NOT NULL,observed_at TEXT NOT NULL,run_id INTEGER,PRIMARY KEY(company_code,chat_id,native_post_id),UNIQUE(company_code,post_key));
 CREATE TABLE IF NOT EXISTS social_max_refresh_cursor(company_code TEXT NOT NULL COLLATE NOCASE,chat_id TEXT NOT NULL,after_key TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT,PRIMARY KEY(company_code,chat_id));`);
 function batch(code,chatId,limit=1000){
  const c=company(code),chat=id(chatId);if(!Number.isSafeInteger(limit)||limit<1||limit>2000)throw Object.assign(new Error('Неверный размер обновления MAX'),{code:'MAX_INDEX_CONTEXT'});
  const cursor=db.prepare('SELECT * FROM social_max_refresh_cursor WHERE company_code=? COLLATE NOCASE AND chat_id=?').get(c,chat)||{after_key:'',revision:0};
  const query=db.prepare('SELECT native_post_id,published_at FROM social_max_post_index WHERE company_code=? COLLATE NOCASE AND chat_id=? AND native_post_id>? ORDER BY native_post_id LIMIT ?');
  let rows=query.all(c,chat,cursor.after_key,limit+1),wrapped=false;
  if(!rows.length&&cursor.after_key){rows=query.all(c,chat,'',limit+1);wrapped=true;}
  const more=rows.length>limit;rows=rows.slice(0,limit);
  return {companyCode:c,chatId:chat,cursorRevision:cursor.revision,afterKey:cursor.after_key,nextAfterKey:more?rows.at(-1).native_post_id:'',wrapped,hasMore:more,
   knownPosts:rows.map(r=>({platformPostId:r.native_post_id,publishedAt:r.published_at}))};
 }
 function prepare(code,chatId,posts){
  const c=company(code),chat=id(chatId);if(!Array.isArray(posts))throw Object.assign(new Error('Неверный список native постов'),{code:'MAX_INDEX_CONTEXT'});
  const entries=[],seen=new Set();
  const mapped=posts.map(post=>{const native=mid(post.platformPostId),published=timestamp(post.publishedAt),key=postKey(c,chat,native);if(seen.has(native))throw Object.assign(new Error('Повтор native ID в результате'),{code:'MAX_INDEX_CONTEXT'});seen.add(native);
   entries.push({nativePostId:native,postKey:key,publishedAt:published});return {...post,platformPostId:key};});
  return {companyCode:c,chatId:chat,entries,posts:mapped};
 }
 function commit(prepared,{runId,collectedAt,refreshBatch=null,advanceRefresh=false}={}){
  if(db.isTransaction!==true)throw Object.assign(new Error('Индекс MAX записывается с принятым снимком'),{code:'MAX_INDEX_TRANSACTION'});
  const c=company(prepared.companyCode),chat=id(prepared.chatId),at=timestamp(collectedAt);
  for(const entry of prepared.entries){const native=mid(entry.nativePostId),published=timestamp(entry.publishedAt);if(entry.postKey!==postKey(c,chat,native))throw Object.assign(new Error('Чужой ключ native поста'),{code:'MAX_INDEX_CONTEXT'});
   const before=db.prepare('SELECT published_at FROM social_max_post_index WHERE company_code=? COLLATE NOCASE AND chat_id=? AND native_post_id=?').get(c,chat,native);
   if(before&&before.published_at!==published)throw Object.assign(new Error('Изменилось native время поста'),{code:'MAX_POST_IDENTITY_CONFLICT'});
   db.prepare(`INSERT INTO social_max_post_index VALUES(?,?,?,?,?,?,?) ON CONFLICT(company_code,chat_id,native_post_id) DO UPDATE SET observed_at=excluded.observed_at,run_id=excluded.run_id WHERE excluded.observed_at>=social_max_post_index.observed_at`).run(c,chat,native,entry.postKey,published,at,runId??null);
  }
  if(refreshBatch&&advanceRefresh){
   if(refreshBatch.companyCode!==c||refreshBatch.chatId!==chat)throw Object.assign(new Error('Чужой курсор native постов'),{code:'MAX_INDEX_CONTEXT'});
   db.prepare('INSERT OR IGNORE INTO social_max_refresh_cursor(company_code,chat_id) VALUES(?,?)').run(c,chat);
   db.prepare('UPDATE social_max_refresh_cursor SET after_key=?,revision=revision+1,updated_at=? WHERE company_code=? COLLATE NOCASE AND chat_id=? AND revision=? AND after_key=?')
    .run(refreshBatch.nextAfterKey,at,c,chat,refreshBatch.cursorRevision,refreshBatch.afterKey);
  }
 }
 return {batch,prepare,commit};
}
module.exports={createSocialMaxIndex};
