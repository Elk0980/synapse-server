'use strict';
const INTERNAL=new Set(['crm','hugh-runtime','localhost','127.0.0.1','[::1]']);
function endpoint(value){
  let url;try{url=new URL(value);}catch{throw Error('INVALID_ENDPOINT');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash
    ||(url.protocol==='http:'&&!INTERNAL.has(url.hostname)))throw Error('INVALID_ENDPOINT');
  return url.href.replace(/\/$/,'');
}
function createJsonClient({url,key,fetchImpl=globalThis.fetch,timeoutMs=30000,maxBytes=2*1024*1024}){
  const base=endpoint(url);if(typeof key!=='string'||!key.trim())throw Error('MISSING_SERVICE_KEY');
  return async(path,{method='GET',body,requestId}={})=>{
    try{
      const response=await fetchImpl(base+path,{method,redirect:'error',headers:{'x-api-key':key,...(body?{'content-type':'application/json'}:{}),...(requestId?{'idempotency-key':requestId}:{})},
        body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok||response.redirected)throw Error('HTTP_ERROR');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw Error('RESPONSE_LIMIT');}chunks.push(Buffer.from(value));}}
      finally{reader.releaseLock();}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch{throw Error('SERVICE_UNAVAILABLE');} // Ни текст ответа, ни URL, ни ключ не попадают в исключение.
  };
}
function createCrm(options){
  const call=createJsonClient(options),scope=item=>`?companyCode=${encodeURIComponent(item.companyCode)}`;
  return {
    requests:()=>call('/internal/reel-materials/requests'),queue:()=>call('/internal/reel-materials/queue'),
    reply:(item,body)=>call(`/internal/reel-materials/requests/${item.id}/reply${scope(item)}`,{method:'POST',body}),
    task:body=>call('/tasks'+scope(body),{method:'POST',body:{title:body.title,description:body.description,companyCode:body.companyCode,
      assigneeRole:'synapse',assigneeName:'Claude',status:'inbox',source:'manual',sourceRef:body.sourceRef,sourceAuthor:'Сторож монтажа',createdBy:'Сторож монтажа'}})
  };
}
function createRuntime(options){
  const status=createJsonClient({...options,timeoutMs:5000,maxBytes:128*1024}),reply=createJsonClient({...options,timeoutMs:60000,maxBytes:128*1024});
  return {name:options.name,model:options.model||null,price:options.price||null,status:()=>status('/status'),reply:body=>reply('/reply',{method:'POST',body})};
}
function createExecutor(options){const call=createJsonClient(options);return (item,{idempotencyKey})=>call('',{method:'POST',requestId:idempotencyKey,body:{idempotencyKey,item}});}
module.exports={endpoint,createJsonClient,createCrm,createRuntime,createExecutor};
