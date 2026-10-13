'use strict';
const {createSocialMaxStats}=require('./social-max-stats');
const {createSocialMaxIndex}=require('./social-max-index');
// Общий native access, изолированный контекст known batch на каждый collect.
function createSocialMaxService(db,{access,now=Date.now}={}){
 const index=createSocialMaxIndex(db),active=new Set();let closing=false;
 async function collectDate(input){
  if(closing)throw Object.assign(new Error('Сервер останавливается'),{code:'STOPPED'});
  const ready=access.ready(input.companyCode);
  const batch=ready.ok?index.batch(input.companyCode,ready.chatId):null;
  const requested=new Set();
  const scopedAccess={...access,readMessages:async(code,query,options)=>{
    const answer=await access.readMessages(code,query,options);
    for(const nativeId of query.messageIds||[])requested.add(nativeId);
    return answer;
  }};
  const reader=createSocialMaxStats({access:scopedAccess,now,maxPosts:5000,knownPosts:()=>batch?.knownPosts||[]});
  const operation=reader.collectDate(input);const record={reader,operation};active.add(record);
  try{
   const result=await operation;if(closing)throw Object.assign(new Error('Сервер останавливается'),{code:'STOPPED'});
   if(result.status!=='partial'&&result.status!=='ok')return result;
   const prepared=index.prepare(input.companyCode,ready.chatId,result.posts||[]);
   return {...result,posts:prepared.posts,maxIndexPrepared:prepared,maxRefreshBatch:batch,
    // partial known response не застревает навечно на одном недоступном ID:
    // курсор идёт дальше, но полнота/последний view для него не выдумываются.
    maxAdvanceRefresh:Boolean(batch&&!result.retryable&&batch.knownPosts.every(p=>requested.has(p.platformPostId)||(result.posts||[]).some(post=>post.platformPostId===p.platformPostId))),
    coverage:{...result.coverage,knownPostRefresh:batch?.hasMore?'partial':result.coverage.knownPostRefresh},
    missing:[...(result.missing||[]),...(batch?.hasMore?['обновлена очередная часть сохранённого индекса MAX; остальные посты обновляются следующими запусками']:[])]};
  }finally{active.delete(record);}
 }
 function stop(){closing=true;return Promise.allSettled([...active].map(async r=>{await r.reader.stop();await r.operation})).then(()=>undefined);}
 return {ready:code=>access.ready(code),bindingFingerprint:code=>access.bindingFingerprint(code),collectDate,stop,index};
}
module.exports={createSocialMaxService};
