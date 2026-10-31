'use strict';
const { createPalitraPush } = require('./palitra-push.cjs');
const { createPalitraPushHttp } = require('./palitra-push-http.cjs');
const { createSafeSender } = require('./palitra-push-transport.cjs');
const { readVapid } = require('./palitra-push-keys.cjs');
const refuse = () => { throw Object.assign(new Error('PUSH_FORBIDDEN'), {status:403,code:'PUSH_FORBIDDEN'}); };

function createPalitraPushHost({db,transaction,getCore,getUser,getCustomerContext,requireSession,requireCsrf,canReadPalitra,
 enabled=false,contactFollowupEnabled=()=>false,keyPath='/run/secrets/palitra-push/vapid.json',loadVapid=readVapid,webpush=null}={}) {
 if ([transaction,getCore,getUser,getCustomerContext,requireSession,requireCsrf,canReadPalitra].some(fn=>typeof fn!=='function')) throw new TypeError('Existing host dependencies required');
 let vapid=null,sender=null;
 if(enabled===true){
  try{
   vapid=loadVapid(keyPath);
   const library=webpush||require('./palitra-push-deps/node_modules/web-push');
   sender=createSafeSender({webpush:library,vapid});
  }catch{vapid=null;sender=null;console.warn('content: PALITRA_PUSH_SETUP_UNAVAILABLE');}
 }
 const staffStillValid=(actor)=>{
  const user=getUser(Number(actor.id));
  return Boolean(user&&String(user.sessionVersion)===actor.sessionVersion&&canReadPalitra(user)===true);
 };
 const push=createPalitraPush({db,transaction,staffStillValid,vapid,sender,enabled,followupEnabled:contactFollowupEnabled});
 const resolveStaff=(request,{mutating})=>{
  const session=requireSession(request);if(!session?.user||!canReadPalitra(session.user))refuse();
  if(mutating)requireCsrf(request,session);
  return {kind:'staff',id:String(session.user.id),company:'palitra-love',origin:'https://synapse.synapsebusiness.ru',sessionVersion:String(session.user.sessionVersion)};
 };
 const resolveCustomer=(request,{origin})=>{
  const core=getCore();if(!core||typeof core.pushActor!=='function')throw Object.assign(new Error('PUSH_NOT_READY'),{status:503,code:'PUSH_NOT_READY'});
  const context=getCustomerContext(request,origin);
  if(!context||context.site!=='palitra'||context.origin!==origin)refuse();
  return core.pushActor(context);
 };
 const http=createPalitraPushHttp({push,resolveStaff,resolveCustomer});
 const onMessageStored=(event)=>{const result=push.onMessageStored(event);push.requestDrain();return result;};
 return Object.freeze({http,onMessageStored,onOrderFollowup:push.onOrderFollowup,requestDrain:push.requestDrain});
}
module.exports={createPalitraPushHost};
