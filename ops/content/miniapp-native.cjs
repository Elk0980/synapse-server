'use strict';
const crypto=require('node:crypto');
const COMPANY='palitra-love',SITE='palitra';
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})};
const positive=n=>Number.isSafeInteger(n)&&n>0;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
// Runtime adapters only. No new bot/worker, users, permissions, site sessions or business records.
function createMiniappNative({db,authStore,canAccess,bots,clientDialogs,siteOrders,workflow,botId}) {
 if(!db||typeof authStore?.getById!=='function'||typeof canAccess!=='function'||!bots||
    typeof clientDialogs?.status!=='function'||typeof siteOrders?.checklistOrder!=='function'||
    typeof workflow?.customerOrder!=='function'||typeof botId!=='string'||!/^[1-9]\d{0,19}$/.test(botId))
   throw new TypeError('Нужны действующие сервисы и подтверждённый ID бота Palitra');
 function getBotIdentity(){
   const found=Object.entries(bots).filter(([,b])=>b&&b.site===SITE);
   if(found.length!==1)return null;
   const [key,config]=found[0];
   if(!/^[a-zA-Z0-9_]{5,32}$/.test(String(config.username||'')))return null;
   const bridge=db.prepare('SELECT ok,username,telegram_bot_id FROM client_bot_bridge_state WHERE bot_key=?').get(key);
   if(!bridge||bridge.ok!==1||String(bridge.telegram_bot_id)!==botId||
      String(bridge.username).toLowerCase()!==config.username.toLowerCase()||clientDialogs.status(SITE)?.bridge?.ready!==true)return null;
   return {key,botId,enabled:true};
 }
 function linkedStaff(subject,permission='crm.view'){
   if(typeof subject!=='string'||!/^[1-9]\d{0,15}$/.test(subject)||!['crm.view','crm.edit'].includes(permission))return null;
   const link=db.prepare('SELECT user_id FROM project_chat_telegram_links WHERE telegram_user_id=?').get(subject);
   if(!link)return null;
   const user=authStore.getById(link.user_id);
   if(!user||user.id!==link.user_id||!positive(user.id)||!Number.isSafeInteger(user.sessionVersion)||!canAccess(user,permission))return null;
   // Same existing link-version convention as the native CRM host; never creates a link/version.
   const version=db.prepare('SELECT version FROM project_chat_telegram_link_versions WHERE user_id=?').get(user.id)?.version??1;
   if(!positive(version))return null;
   return {user,version};
 }
 function telegramBind({subject}){
   const state=linkedStaff(subject);
   return state?hash(`palitra-miniapp-staff-v1:${subject}:${state.user.id}:${state.user.sessionVersion}:${state.version}`):null;
 }
 function telegramRole({subject,ref}){
   const current=telegramBind({subject});
   // 'admin' here is the existing CRM session classification, never a membership/grant.
   // Every read/write is additionally checked against current native crm.view/crm.edit.
   return current&&typeof ref==='string'&&current.length===ref.length&&crypto.timingSafeEqual(Buffer.from(current),Buffer.from(ref))?'admin':null;
 }
 function resolveStaff(subject,permission){
   const found=linkedStaff(subject,permission);
   return found?{id:found.user.id,sessionVersion:found.user.sessionVersion,companyCode:COMPANY}:null;
 }
 function staffUser(actor){
   const user=authStore.getById(actor?.id);
   return user&&user.sessionVersion===actor.sessionVersion&&canAccess(user,'crm.view')?user:null;
 }
 function canonical(orderId){
   if(!positive(orderId))fail(404,'MINIAPP_ORDER','Заказ не найден');
   const row=db.prepare('SELECT id,created_at,name FROM site_orders WHERE id=? AND site=? AND company_code=?').get(orderId,SITE,COMPANY);
   if(!row)fail(404,'MINIAPP_ORDER','Заказ не найден');return row;
 }
 function conversation(site,orderId){
   if(site!==SITE)fail(404,'MINIAPP_ORDER','Заказ не найден');canonical(orderId);
   const threads=db.prepare('SELECT id FROM chat_threads WHERE site=? AND company_code=? AND order_id=? LIMIT 2').all(SITE,COMPANY,orderId);
   if(threads.length>1)fail(409,'MINIAPP_CHAT_AMBIGUOUS','Нужно проверить связь переписки с заказом');
   if(threads.length===1)return {threadId:threads[0].id,dialogId:null};
   const bot=getBotIdentity();if(!bot)fail(503,'MINIAPP_BOT','Связь с ботом временно недоступна');
   const dialogs=db.prepare(`SELECT DISTINCT d.id FROM client_dialogs d WHERE d.bot_key=? AND d.company_code=?
     AND (d.order_id=? OR EXISTS(SELECT 1 FROM client_order_links l WHERE l.dialog_id=d.id AND l.bot_key=d.bot_key
       AND l.site=? AND l.order_id=? AND l.used_at IS NOT NULL)) LIMIT 2`).all(bot.key,COMPANY,orderId,SITE,orderId);
   if(dialogs.length>1)fail(409,'MINIAPP_CHAT_AMBIGUOUS','Нужно проверить связь переписки с заказом');
   return {threadId:null,dialogId:dialogs[0]?.id??null};
 }
 function resolveConversation({orderId,conversationRef}){
   if(conversationRef===undefined){
     canonical(orderId);const ref=conversation(SITE,orderId);
     if(!ref.threadId&&!ref.dialogId)fail(404,'MINIAPP_CHAT','Переписка не найдена');
     return {...ref,orderId,conversationRef:ref.threadId?`thread:${ref.threadId}`:`legacy:${ref.dialogId}`};
   }
   const match=/^(thread|legacy):([1-9]\d{0,14})$/.exec(conversationRef||'');
   if(!match||!Number.isSafeInteger(Number(match[2])))fail(404,'MINIAPP_CHAT','Переписка не найдена');
   const id=Number(match[2]),thread=match[1]==='thread',bot=getBotIdentity();
   const row=thread?db.prepare('SELECT order_id FROM chat_threads WHERE id=? AND site=? AND company_code=?').get(id,SITE,COMPANY):
     bot?db.prepare('SELECT order_id FROM client_dialogs WHERE id=? AND bot_key=? AND company_code=?').get(id,bot.key,COMPANY):null;
   if(!row)fail(404,'MINIAPP_CHAT','Переписка не найдена');
   let actualOrder=positive(row.order_id)&&db.prepare('SELECT 1 FROM site_orders WHERE id=? AND site=? AND company_code=?').get(row.order_id,SITE,COMPANY)?row.order_id:null;
   if(orderId!==undefined&&orderId!==null){
     canonical(orderId);
     const oldClaim=!thread&&db.prepare('SELECT 1 FROM client_order_links WHERE dialog_id=? AND bot_key=? AND site=? AND order_id=? AND used_at IS NOT NULL').get(id,bot.key,SITE,orderId);
     if(actualOrder!==orderId&&!oldClaim)fail(404,'MINIAPP_CHAT','Переписка не относится к этому заказу');actualOrder=orderId;
   }
   return {orderId:actualOrder,threadId:thread?id:null,dialogId:thread?null:id,conversationRef};
 }
 const orders={
   read:(site,id)=>{if(site!==SITE)fail(404,'MINIAPP_ORDER','Заказ не найден');canonical(id);return siteOrders.checklistOrder(SITE,id).order},
   conversation,resolveConversation,
   customerSummary:id=>{const row=canonical(id);return {orderId:id,orderRef:`native-order:${id}`,name:row.name,createdAt:row.created_at,workflow:workflow.customerOrder(id)}},
   customer:id=>{const row=canonical(id),snapshot=siteOrders.chatOrderSnapshot(SITE,id);if(!snapshot||snapshot.id!==id)fail(404,'MINIAPP_ORDER','Заказ не найден');
     return {orderId:id,orderRef:`native-order:${id}`,name:row.name,createdAt:row.created_at,composition:{text:snapshot.text},workflow:workflow.customerOrder(id)}}
 };
 const stages={get:(actor,id)=>workflow.getOrder(actor,id),report:actor=>workflow.getFunnelReport(actor),action:(actor,id,action)=>{
   if(!action||typeof action!=='object'||Array.isArray(action)||Object.keys(action).sort().join(',')!=='body,type'||
      !['confirm','advance','set-stage'].includes(action.type))fail(400,'MINIAPP_STAGE','Некорректное действие с этапом');
   if(typeof id==='string' && /^thread:[1-9]\d{0,14}$/.test(id)){const ref=resolveConversation({conversationRef:id});if(ref.orderId!==null)fail(409,'MINIAPP_CHAT','Обновите связанную заявку');}else canonical(id);
   return action.type==='set-stage'?workflow.setStage(actor,id,action.body):workflow[action.type](actor,id,action.body);
 }};
 return Object.freeze({getBotIdentity,telegramBind,telegramRole,resolveStaff,staffUser,orders:Object.freeze(orders),workflow:Object.freeze(stages)});
}
module.exports={createMiniappNative};
