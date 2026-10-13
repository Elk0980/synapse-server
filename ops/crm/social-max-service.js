'use strict';
const {createSocialMaxStats}=require('./social-max-stats');
const {createSocialMaxIndex}=require('./social-max-index');
const {createSocialMaxBackfill}=require('./social-max-backfill');
const {normalizeMaxId}=require('./social-max-access');
// Общий native access, изолированный контекст known batch на каждый collect.
function createSocialMaxService(db,{access,now=Date.now,backfillOptions={}}={}){
 const nativeIndex=createSocialMaxIndex(db),backfill=createSocialMaxBackfill(db,{...backfillOptions,access,now});
 const active=new Set();let closing=false;
 const index={...nativeIndex,historyCoverage(code,accountRef){
  const ready=access.ready(code);
  if(!ready.ok||normalizeMaxId(accountRef)!==ready.chatId)return null;
  return {...backfill.coverage(code,ready.chatId),indexedPosts:db.prepare(`SELECT count(*) n FROM social_max_post_index
   WHERE company_code=? COLLATE NOCASE AND chat_id=?`).get(code,ready.chatId).n};
 },commit(prepared,options){
  nativeIndex.commit(prepared,options);
  if(prepared.backfillPrepared)backfill.commit(prepared.backfillPrepared,options);
 }};
 function collectDate(input){
  if(closing)throw Object.assign(new Error('Сервер останавливается'),{code:'STOPPED'});
  const controller=new AbortController();
  const abort=()=>controller.abort();
  if(input.signal?.aborted)abort();else input.signal?.addEventListener('abort',abort,{once:true});
  const ready=access.ready(input.companyCode);
  const batch=ready.ok?nativeIndex.batch(input.companyCode,ready.chatId):null;
  const requested=new Set();
  const scopedAccess={...access,readMessages:async(code,query,options)=>{
    const answer=await access.readMessages(code,query,options);
    for(const nativeId of query.messageIds||[])requested.add(nativeId);
    return answer;
  }};
  const reader=createSocialMaxStats({access:scopedAccess,now,maxPosts:5000,knownPosts:()=>batch?.knownPosts||[]});
  const record={reader,controller,operation:null};active.add(record);
  record.operation=(async()=>{try{
   const result=await reader.collectDate({...input,signal:controller.signal});
   if(closing||controller.signal.aborted)throw Object.assign(new Error('Сервер останавливается'),{code:'STOPPED'});
   if(result.status!=='partial'&&result.status!=='ok')return result;
   // Каждый штатный проход продвигает отдельную сохранённую историю, включая
   // посты старше выбранного дня и всех уже известных IDs.
   const history=ready.ok&&!result.retryable
    ?await backfill.collectStep({companyCode:input.companyCode,timezone:input.timezone,signal:controller.signal})
    :null;
   if(closing||controller.signal.aborted)throw Object.assign(new Error('Сервер останавливается'),{code:'STOPPED'});
   if(history&&history.status!=='partial'&&history.status!=='ok')
    return {...result,status:history.status,snapshots:[],posts:[],retryable:history.retryable,
      missing:history.missing||[],coverage:{...result.coverage,historyIndex:history.coverage}};
   const posts=new Map((result.posts||[]).map(p=>[p.platformPostId,p]));
   for(const post of history?.posts||[]){
    const previous=posts.get(post.platformPostId);
    if(previous&&Date.parse(previous.publishedAt)!==Date.parse(post.publishedAt))
     throw Object.assign(new Error('Изменилось native время поста'),{code:'MAX_POST_IDENTITY_CONFLICT'});
    // Более позднее чтение текущего lifetime не складывается с дневным проходом.
    posts.set(post.platformPostId,post);
   }
   const prepared=nativeIndex.prepare(input.companyCode,ready.chatId,[...posts.values()]);
   if(history?.prepared)prepared.backfillPrepared=history.prepared;
   return {...result,posts:prepared.posts,maxIndexPrepared:prepared,maxRefreshBatch:batch,
    // partial known response не застревает навечно на одном недоступном ID:
    // курсор идёт дальше, но полнота/последний view для него не выдумываются.
    maxAdvanceRefresh:Boolean(batch&&!result.retryable&&batch.knownPosts.every(p=>requested.has(p.platformPostId)||posts.has(p.platformPostId))),
    retryable:result.retryable||history?.retryable||false,
    coverage:{...result.coverage,historyIndex:history?.coverage||backfill.coverage(input.companyCode,ready.chatId),knownPostRefresh:batch?.hasMore?'partial':result.coverage.knownPostRefresh},
    missing:[...(result.missing||[]),...(history?.missing||[]),...(batch?.hasMore?['обновлена очередная часть сохранённого индекса MAX; остальные посты обновляются следующими запусками']:[])]};
  }catch(error){
   if(closing)throw Object.assign(new Error('Сервер останавливается'),{code:'STOPPED'});
   throw error;
  }finally{input.signal?.removeEventListener('abort',abort);active.delete(record);}})();
  return record.operation;
 }
 function stop(){
  closing=true;const pending=[...active];for(const r of pending)r.controller.abort();
  return Promise.allSettled([backfill.stop(),...pending.map(async r=>{await r.reader.stop();await r.operation})]).then(()=>undefined);
 }
 return {ready:code=>access.ready(code),bindingFingerprint:code=>access.bindingFingerprint(code),collectDate,stop,index};
}
module.exports={createSocialMaxService};
