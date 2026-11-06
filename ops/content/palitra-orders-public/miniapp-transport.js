(function(root,build){'use strict';const api=build();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'PalitraMiniappTransport',{value:api,writable:false,configurable:false});})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const ROUTES=new Set(['orders','order','conversation','message','stage','upload-prepare','upload-status','read','unread','select','sources','funnel']);
 const WRITES=new Set(['message','stage','upload-prepare','read','select']);
 const error=(message,code,status=0,extra={})=>Object.assign(new Error(message),{code,status,...extra});
 function create({fetch:fetcher,origin='https://palitra-love.ru',telegram=null,journal=null,crypto:cryptoApi=globalThis.crypto}={}){
  if(typeof fetcher!=='function'||origin!=='https://palitra-love.ru'||globalThis.location&&globalThis.location.origin!==origin)throw new TypeError('Нужен текущий адрес приложения Палитры');
  let bearer='',csrf='',boot=null,connecting=null,exchangeAttempted=false,epoch=0,verifiedRaw='';
  const rawIdentity=()=>typeof telegram?.initData==='string'?telegram.initData:'';
  try{if(!journal)journal=globalThis.sessionStorage||null}catch{journal=null}
  const snapshot=()=>boot?JSON.parse(JSON.stringify(boot)):null;
  function accept(value,raw){
   if(rawIdentity()!==raw){reset();throw error('Аккаунт Telegram изменился. Откройте приложение заново.','MINIAPP_CONTEXT',403);}
   if(!value||value.schema!=='palitra-miniapp/v1'||value.companyCode!=='palitra-love'||!['staff','customer'].includes(value.role)||typeof value.csrfToken!=='string'||!value.csrfToken||value.token!==undefined&&!/^pcrm\.[A-Za-z0-9_-]{43}$/.test(value.token))throw error('Сервер не подтвердил вход','MINIAPP_RESPONSE');
   bearer=value.token||'';csrf=value.csrfToken;verifiedRaw=raw;const {token,csrfToken,...safe}=value;boot=safe;return snapshot();
  }
  async function exchangeKey(initData){
   if(!cryptoApi?.subtle)throw error('Обновите Telegram и откройте приложение заново','MINIAPP_CRYPTO');
   const digest=await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(initData));
   return 'palitra-miniapp-exchange-v1:'+Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
  }
  async function perform(route,body,{signal,raw=false,headers={},binary=false,writing=false,session=false}={}){
   if(!session&&boot&&rawIdentity()!==verifiedRaw){reset();throw error('Аккаунт Telegram изменился. Откройте приложение заново.','MINIAPP_CONTEXT',403);}
   if(!session&&!boot)throw error('Откройте приложение через Telegram','MINIAPP_SESSION',401);
   const current=epoch,auth=bearer?{Authorization:'Bearer '+bearer}:csrf?{'X-Palitra-Miniapp-CSRF':csrf}:{};
   let response;
   try{response=await fetcher('/api/telegram-miniapp/'+route,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal,
    headers:{Accept:binary?'application/octet-stream':'application/json',...(!raw?{'Content-Type':'application/json'}:{'Content-Type':'application/octet-stream'}),...auth,...headers},body:raw?body:JSON.stringify(body)})}
   catch(cause){if(signal?.aborted)throw error('Запрос отменён','ABORTED',0,{unknown:writing,cause});throw error(writing?'Результат отправки пока неизвестен. Проверьте переписку.':'Не удалось связаться с сервером','NETWORK_UNKNOWN',0,{unknown:writing,cause})}
   if(current!==epoch)throw error('Вход изменился. Откройте переписку заново','MINIAPP_CONTEXT',403);
   if(binary&&response.ok){const blob=await response.blob();if(current!==epoch)throw error('Вход изменился. Откройте переписку заново','MINIAPP_CONTEXT',403);return blob;}
   let value;try{value=await response.json()}catch{throw error('Сервер не подтвердил результат','MINIAPP_RESPONSE',response.status,{unknown:writing})}
   if(current!==epoch)throw error('Вход изменился. Откройте переписку заново','MINIAPP_CONTEXT',403);
   if(!response.ok||value?.ok===false){if(response.status===401)reset();throw error(typeof value?.error==='string'?value.error:'Не удалось выполнить запрос',typeof value?.code==='string'?value.code:'MINIAPP_ERROR',response.status,{unknown:writing&&(response.status>=500||response.status===408)});}
   return value;
  }
  async function initialize(){
   const initData=rawIdentity();
   // Official SDK: only raw initData is sent to the server; initDataUnsafe/user/role are never used.
   // https://core.telegram.org/bots/webapps#initializing-mini-apps
   if(!initData)throw error('Откройте приложение кнопкой в Telegram','MINIAPP_OPEN_TELEGRAM',401);
   try{return accept(await perform('session',{resumeInitData:initData}, {session:true}),initData)}
   catch(e){if(e.status!==401||!['MINIAPP_SESSION','MINIAPP_IDENTITY_CHANGED'].includes(e.code))throw e;}
   const key=await exchangeKey(initData);let saved=null;try{saved=journal?.getItem(key)}catch{}
   if(exchangeAttempted||saved)throw error('Предыдущий вход уже отправлен. Закройте приложение и откройте его заново в Telegram.','MINIAPP_EXCHANGE_SENT',409);
   exchangeAttempted=true;try{journal?.setItem(key,'attempted')}catch{}
   return accept(await perform('session',{initData},{session:true,writing:true}),initData);
  }
  function connect(){if(boot){if(rawIdentity()===verifiedRaw)return Promise.resolve(snapshot());reset();}if(!connecting)connecting=initialize().finally(()=>{connecting=null});return connecting;}
  function request(route,body={},options={}){if(!ROUTES.has(route))throw new TypeError('Неизвестная операция');return perform(route,body,{signal:options.signal,writing:WRITES.has(route)});}
  function upload({orderId=null,conversationRef,uuid},bytes,{signal}={}){
   const headers={'X-Palitra-Upload':uuid};if(orderId!==null)headers['X-Palitra-Order']=String(orderId);if(conversationRef!==undefined)headers['X-Palitra-Conversation']=conversationRef;
   return perform('upload',bytes,{raw:true,headers,signal,writing:true});
  }
  const file=(input,{signal}={})=>perform('file',input,{binary:true,signal});
  function reset(){epoch++;bearer='';csrf='';boot=null;verifiedRaw='';}
  return Object.freeze({connect,request,upload,file,snapshot,reset});
 }
 return Object.freeze({create});
});
