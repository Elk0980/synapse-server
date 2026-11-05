'use strict';
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const id=x=>Number.isSafeInteger(x)&&x>0;
const exactly=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>keys.includes(k));
function createMiniappServices({authority,context,core,legacy,orders,workflow,queue,staffUser,readState=null,attribution=null}) {
  if (!authority||!context||!core||!legacy||!orders||!workflow||!queue||typeof staffUser!=='function') throw new TypeError('Нужны существующие сервисы Palitra');
  const staff=(token,write=false)=>{
    const actor=authority.staff(token,write?'crm.edit':'crm.view'),user=staffUser(actor);
    if (!user || user.id!==actor.id || user.sessionVersion!==actor.sessionVersion) fail(403,'MINIAPP_STAFF','Доступ сотрудника изменился');
    return {actor,user};
  };
  const owned=(token,orderId)=>{if(!id(orderId))fail(404,'MINIAPP_ORDER','Заказ не найден');return authority.order(token,orderId)};
  const staffOrder=(token,orderId,write=false)=>{
    if(!id(orderId))fail(404,'MINIAPP_ORDER','Заказ не найден');
    const who=staff(token,write),row=orders.read('palitra',orderId);
    if(!row||row.id!==orderId)fail(404,'MINIAPP_ORDER','Заказ не найден');
    return {...who,row};
  };
  const customerRequest=(token,orderId)=>context.request(token,orderId);
  function target(token,input,write=false){
    if(authority.bootstrap(token).role==='staff'){
      const who=staff(token,write);
      const ref=typeof orders.resolveConversation==='function'?orders.resolveConversation({orderId:input.orderId,conversationRef:input.conversationRef}):
        {...orders.conversation('palitra',staffOrder(token,input.orderId,write).row.id),orderId:input.orderId};
      if(!ref.threadId&&!ref.dialogId)fail(404,'MINIAPP_CHAT','Переписка не найдена');
      return {...ref,staff:true,owner:who.actor,conversationRef:ref.conversationRef||(ref.threadId?`thread:${ref.threadId}`:`legacy:${ref.dialogId}`)};
    }
    if(input.conversationRef!==undefined)fail(400,'MINIAPP_CHAT','Клиент открывает свой заказ');
    return {...owned(token,input.orderId),staff:false};
  }
  function readOrder(token,orderId) {
    if(authority.bootstrap(token).role==='staff') {
      const {actor,row}=staffOrder(token,orderId);
      return {orderId,orderRef:`native-order:${orderId}`,order:row,composition:orders.customer(orderId).composition,workflow:workflow.get(actor,orderId)};
    }
    owned(token,orderId);
    // Host's existing customer projection excludes internal notes and refusal reason.
    return orders.customer(orderId);
  }
  function readConversation(token,input) {
    if(!exactly(input,['orderId','conversationRef','before','limit']))fail(400,'MINIAPP_INPUT','Некорректный запрос');
    const ref=target(token,input),orderId=ref.orderId;
    if(ref.staff) {
      if(ref.threadId)return core.ownerReadThread({site:'palitra',owner:ref.owner,threadId:ref.threadId,before:input.before,limit:input.limit});
      return legacy.ownerRead({token,orderId,conversationRef:ref.conversationRef,site:'palitra',owner:ref.owner,dialogId:ref.dialogId,before:input.before,limit:input.limit});
    }
    if(ref.threadId)return core.listWebMessages(customerRequest(token,orderId),{threadId:ref.threadId,before:input.before,limit:input.limit});
    return legacy.customerRead({token,subject:authority.actor(token).principal.subject,orderId,dialogId:ref.dialogId,before:input.before,limit:input.limit});
  }
  function send(token,input) {
    if(!exactly(input,['orderId','conversationRef','requestId','text']))fail(400,'MINIAPP_INPUT','Некорректное сообщение');
    // Keep the original UUID and exact body across unknown outcomes. No automatic resubmit here.
    const {requestId,text}=input,ref=target(token,input,true),orderId=ref.orderId;
    if(ref.staff) {
      if(ref.threadId)return core.ownerReply({site:'palitra',owner:ref.owner,body:{threadId:ref.threadId,requestId,text}});
      return legacy.ownerReply({token,orderId,conversationRef:ref.conversationRef,site:'palitra',owner:ref.owner,dialogId:ref.dialogId,requestId,text});
    }
    if(ref.threadId)return core.postWebMessage(customerRequest(token,orderId),{threadId:ref.threadId,requestId,text});
    return legacy.customerSend({token,subject:authority.actor(token).principal.subject,orderId,dialogId:ref.dialogId,requestId,text});
  }
  function list(token,input={}) {
    if(!exactly(input,['filter','search','cursor','limit']))fail(400,'MINIAPP_INPUT','Некорректный список');
    if(authority.bootstrap(token).role==='staff') {const who=staff(token),page=queue.read(who.user,input),decorated=readState?readState.decorate(who.actor,page):page;
      if(!attribution)return decorated;attribution.authorize(who.actor);
      const items=decorated.items.map(item=>{const ref=/^(order|thread|legacy):([1-9]\d*)$/.exec(item.key||'');return {...item,source:attribution.projectSource(ref?{kind:ref[1],id:Number(ref[2])}:{})}});
      staff(token);return {...decorated,items};}
    if(Object.keys(input).some(k=>k!=='limit'))fail(400,'MINIAPP_INPUT','Некорректный список заказов');
    return {orders:authority.conversations(token).map(ref=>({...ref,...orders.customerSummary(ref.orderId)}))};
  }
  function stage(token,input) {
    if(input?.conversationRef!==undefined){
      if(!exactly(input,['conversationRef','action']))fail(400,'MINIAPP_INPUT','Некорректный этап');
      const ref=target(token,input,Boolean(input.action));
      if(!ref.threadId || ref.orderId!==null)fail(409,'MINIAPP_CHAT','Откройте актуальную карточку переписки');
      const actor=staff(token,Boolean(input.action)).actor,resource=`thread:${ref.threadId}`;
      const result=input.action ? workflow.action(actor,resource,input.action) : workflow.get(actor,resource);
      staff(token,Boolean(input.action));return result;
    }
    if(!exactly(input,['orderId','action'])||!id(input.orderId))fail(400,'MINIAPP_INPUT','Некорректный этап');
    const {actor}=staffOrder(token,input.orderId,true);
    return workflow.action(actor,input.orderId,input.action);
  }
  const uploadScope=(token,input,write)=>target(token,input,write);
  function prepareUpload(token,input) {
    if(!exactly(input,['orderId','conversationRef','body']))fail(400,'MINIAPP_INPUT','Некорректный файл');
    const ref=uploadScope(token,input,true);
    if(!ref.threadId)return legacy.prepareUpload({token,conversationRef:ref.conversationRef,subject:authority.actor(token).principal.subject,owner:ref.owner,orderId:ref.orderId,dialogId:ref.dialogId,body:input.body});
    return ref.staff ? core.ownerPrepareUpload({site:'palitra',owner:ref.owner,threadId:ref.threadId,body:input.body})
      :core.prepareWebUpload(customerRequest(token,input.orderId),{threadId:ref.threadId,body:input.body});
  }
  function uploadStatus(token,input) {
    if(!exactly(input,['orderId','conversationRef','uuid']))fail(400,'MINIAPP_INPUT','Некорректный файл');
    const ref=uploadScope(token,input,false);
    if(!ref.threadId)return legacy.uploadStatus({token,...ref,subject:authority.actor(token).principal.subject,uuid:input.uuid});
    return ref.staff ? core.ownerUploadStatus({site:'palitra',owner:ref.owner,threadId:ref.threadId,uuid:input.uuid})
      :core.webUploadStatus(customerRequest(token,input.orderId),{threadId:ref.threadId,uuid:input.uuid});
  }
  function uploadBytes(token,input,bytes) {
    if(!exactly(input,['orderId','conversationRef','uuid'])||!Buffer.isBuffer(bytes))fail(400,'MINIAPP_INPUT','Некорректный файл');
    const ref=uploadScope(token,input,true);
    if(!ref.threadId)return legacy.uploadBytes({token,...ref,subject:authority.actor(token).principal.subject,uuid:input.uuid,bytes});
    const request=ref.staff?null:customerRequest(token,input.orderId);
    const begun=ref.staff?core.ownerBeginUpload({site:'palitra',owner:ref.owner,threadId:ref.threadId,uuid:input.uuid})
      :core.beginWebUpload(request,{threadId:ref.threadId,uuid:input.uuid});
    // The claim is server-generated and never accepted from HTTP input.
    return ref.staff?core.ownerFinishUpload({site:'palitra',owner:ref.owner,threadId:ref.threadId,uuid:input.uuid,claim:begun.claim,bytes})
      :core.finishWebUpload(request,{threadId:ref.threadId,uuid:input.uuid,claim:begun.claim,bytes});
  }
  function attachment(token,input) {
    if(!exactly(input,['orderId','conversationRef','ref'])||typeof input.ref!=='string')fail(400,'MINIAPP_INPUT','Некорректное вложение');
    const ref=uploadScope(token,input,false),options={site:'palitra',owner:ref.owner,threadId:ref.threadId};
    if(!ref.threadId)return legacy.attachment({token,...ref,subject:authority.actor(token).principal.subject,ref:input.ref});
    const old=/^thread:([1-9]\d*)$/.exec(input.ref),upload=/^upload:([0-9a-f-]{36})$/i.exec(input.ref);
    const request=ref.staff?null:customerRequest(token,input.orderId);
    if(old) {
      const attachmentId=Number(old[1]);
      const meta=ref.staff?core.ownerAttachment({...options,attachmentId}):core.webAttachment(request,{threadId:ref.threadId,attachmentId});
      return {meta,open:()=>core.openAttachment(meta)};
    }
    if(upload) {
      const uuid=upload[1];
      const meta=ref.staff?core.ownerUploadFile({...options,uuid}):core.webUploadFile(request,{threadId:ref.threadId,uuid});
      return {meta,open:()=>core.openUpload(meta)};
    }
    fail(404,'MINIAPP_FILE','Файл не найден');
  }
  function markRead(token,input){
    if(!exactly(input,['orderId','conversationRef','throughMessageId']))fail(400,'MINIAPP_INPUT','Некорректная отметка прочтения');
    const ref=target(token,input);
    if(!ref.staff)fail(403,'MINIAPP_STAFF','Нет доступа сотрудника');
    if(!readState)fail(503,'MINIAPP_READ','Отметка прочтения временно недоступна');
    return readState.acknowledge(ref.owner,{kind:ref.threadId?'thread':'legacy',id:ref.threadId||ref.dialogId,throughMessageId:input.throughMessageId});
  }
  function unread(token,input){
    if(!exactly(input,[])||!readState)fail(503,'UNREAD_NOT_READY','Счётчик сообщений пока недоступен');
    return readState.summary(staff(token).actor);
  }
  function bootstrap(token){
    const boot={...authority.bootstrap(token),draftScope:context.draftScope(token)};if(boot.role!=='staff')return boot;
    const who=staff(token),user=who.user;
    return {...boot,identity:{userId:String(user.id),role:user.role==='owner'?'owner':'editor',
      displayName:String(user.displayName||user.login||'Сотрудник Палитры'),login:String(user.login||''),
      companies:user.role==='owner'?['palitra-love']:[...(user.companyCodes||[])],permissions:[...(user.permissions||[])]}};
  }
  function sources(token,input){if(!exactly(input,['from','until']))fail(400,'MINIAPP_INPUT','Некорректный период');const who=staff(token);
    if(!attribution)fail(503,'ATTRIBUTION_NOT_READY','Учёт источников ещё не запущен');const result=attribution.summary(who.actor,input);staff(token);return result;}
  function funnel(token,input){if(!exactly(input,[]))fail(400,'MINIAPP_INPUT','Некорректный отчёт');const who=staff(token),result=workflow.report(who.actor);staff(token);return result;}
  return Object.freeze({readOrder,readConversation,send,list,stage,prepareUpload,uploadStatus,uploadBytes,attachment,markRead,unread,bootstrap,sources,funnel});
}
module.exports={createMiniappServices};
