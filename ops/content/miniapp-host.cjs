'use strict';
const {createCrmAccess}=require('./palitra-crm/app/lib/crm-access.js');
const {createMiniappNative}=require('./miniapp-native.cjs');
const {createMiniappAuthority}=require('./miniapp-authority.cjs');
const {createMiniappChatContext}=require('./miniapp-chat-context.cjs');
const {createMiniappLegacy}=require('./miniapp-legacy.cjs');
const {createMiniappServices}=require('./miniapp-services.cjs');
const {createMiniappSelection}=require('./miniapp-selection.cjs');
const {createMiniappHttp,PREFIX}=require('./miniapp-http.cjs');
const mediaKit=require('./customer-chat-media.cjs');
const {createMiniappReadAdapter}=require('./miniapp-read-adapter.cjs');
const {createMiniappStatic}=require('./miniapp-static.cjs');
const {assertMiniappSchema}=require('./miniapp-schema.cjs');
// Server host only: all dependencies are the existing application's live services.
// This factory never registers a Telegram update handler, changes recipients or starts a worker.
function createMiniappHost({enabled=false,db,transaction,authStore,canAccess,bots,clientDialogs,getCore,siteOrders,workflow,queue,orderRead=null,attribution=null,refKey,publicDir=null,origin='https://palitra-love.ru',now=Date.now}){
 if(origin!=='https://palitra-love.ru')throw new TypeError('Mini App должен работать на текущем адресе Palitra');
 let http=null;const staticHost=enabled===true&&publicDir?createMiniappStatic({publicDir,origin}):null;
 function initialize(){
  if(http)return http;
  assertMiniappSchema(db);
  const found=Object.entries(bots).filter(([,b])=>b?.site==='palitra');
  if(found.length!==1)throw Object.assign(new Error('Связь с ботом временно недоступна'),{status:503});
  const [key,config]=found[0],bridge=db.prepare('SELECT ok,username,telegram_bot_id FROM client_bot_bridge_state WHERE bot_key=?').get(key);
  const botId=String(bridge?.telegram_bot_id||'');
  if(bridge?.ok!==1||String(bridge.username).toLowerCase()!==String(config.username).toLowerCase()||!/^[1-9]\d{0,19}$/.test(botId)||clientDialogs.status('palitra')?.bridge?.ready!==true)
    throw Object.assign(new Error('Связь с ботом временно недоступна'),{status:503});
  const native=createMiniappNative({db,authStore,canAccess,bots,clientDialogs,siteOrders,workflow,botId});
  // Existing CRM performs production Telegram Ed25519 verification; no caller key/identity/role is accepted.
  const access=createCrmAccess({db,botId,now,telegramBind:native.telegramBind,telegramRole:native.telegramRole});
  const authority=createMiniappAuthority({db,access,transact:transaction,botId,getBotIdentity:native.getBotIdentity,resolveStaff:native.resolveStaff,now});
  const context=createMiniappChatContext({db,transact:transaction,authority,origin,refKey,now}),core=getCore();
  const legacy=createMiniappLegacy({authority,native,clientDialogs});
  const sharedRead=createMiniappReadAdapter({db,state:orderRead});
  const services=createMiniappServices({authority,context,core,legacy,orders:native.orders,workflow:native.workflow,queue,staffUser:native.staffUser,readState:sharedRead,attribution});
  const select=createMiniappSelection({authority,context,core,legacy,services,db,transact:transaction,getBotIdentity:native.getBotIdentity});
  http=createMiniappHttp({authority,services,select,origin,sendFile:mediaKit.sendFile,now});return http;
 }
 async function handle(request,response){
  if(staticHost?.serve(request,response))return true;
  if(enabled!==true||!new URL(request.url,origin).pathname.startsWith(PREFIX))return false;
  if(request.headers.origin!==origin||request.headers.host!==new URL(origin).host||new URL(request.url,origin).origin!==origin){
   response.writeHead(403,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   response.end(JSON.stringify({ok:false,code:'MINIAPP_ORIGIN',error:'Запрос с другого адреса запрещён'}));return true;
  }
  try{return await initialize().handle(request,response)}
  catch(error){
   if(response.headersSent){response.destroy();return true;}
   response.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   response.end(JSON.stringify({ok:false,code:'MINIAPP_UNAVAILABLE',error:'Приложение Telegram временно недоступно. Можно продолжить на сайте.'}));return true;
  }
 }
 return Object.freeze({handle});
}
module.exports={createMiniappHost};
