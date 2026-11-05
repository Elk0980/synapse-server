'use strict';
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})};
function createMiniappLegacy({authority,native,clientDialogs}){
 const core=clientDialogs.miniapp;if(!core)throw new TypeError('Нужен серверный Mini App адаптер прежних диалогов');
 function customer(input){
   const verify=()=>{
     const actor=authority.actor(input.token),ref=authority.order(input.token,input.orderId),bot=native.getBotIdentity();
     if(!bot||ref.threadId||ref.dialogId!==input.dialogId)fail(404,'MINIAPP_CHAT','Переписка не найдена');
     return {subject:actor.principal.subject,botKey:bot.key,companyCode:'palitra-love',orderId:input.orderId,dialogId:ref.dialogId};
   };verify();return {...input,verify};
 }
 function staff(input,write=false){
   const owner=authority.staff(input.token,write?'crm.edit':'crm.view'),ref=native.orders.resolveConversation({orderId:input.orderId,conversationRef:input.conversationRef});
   if(ref.threadId||ref.dialogId!==input.dialogId)fail(404,'MINIAPP_CHAT','Переписка не найдена');return owner;
 }
 const isStaff=input=>authority.bootstrap(input.token).role==='staff';
 const ownerRead=input=>{staff(input);return clientDialogs.dialogView('palitra',input.dialogId)};
 const staffWrite=(input,action)=>core.staffWrite({...input,verifyOwner:()=>staff(input,true)},action);
 const ownerReply=input=>staffWrite(input,()=>clientDialogs.sendOwnerReply('palitra',input.dialogId,{requestId:input.requestId,text:input.text},staff(input,true)));
 function prepareUpload(input){return isStaff(input)?clientDialogs.prepareOwnerUpload('palitra',input.dialogId,input.body,staff(input,true)):core.prepareUpload(customer(input));}
 function uploadStatus(input){return isStaff(input)?clientDialogs.ownerUploadStatus('palitra',input.dialogId,input.uuid,staff(input)):core.uploadStatus(customer(input));}
 function uploadBytes(input){
   if(!isStaff(input))return core.uploadBytes(customer(input));
   const owner=staff(input,true),begun=clientDialogs.beginOwnerUpload('palitra',input.dialogId,input.uuid,owner);
   try{return staffWrite(input,()=>clientDialogs.finishOwnerUpload('palitra',input.dialogId,input.uuid,begun.claim,input.bytes,staff(input,true)))}
   catch(e){if(begun.claim)clientDialogs.releaseOwnerUpload(input.uuid,begun.claim,'Загрузка не завершена');throw e}
 }
 function attachment(input){
   if(!isStaff(input))return core.attachment(customer(input));
   staff(input);return core.staffAttachment({...input,verifyOwner:()=>{staff(input);return true}});
 }
 return Object.freeze({select:input=>core.customerSelect(customer(input)),ownerRead,ownerReply,customerRead:input=>core.customerRead(customer(input)),customerSend:input=>core.customerSend(customer(input)),prepareUpload,uploadStatus,uploadBytes,attachment});
}
module.exports={createMiniappLegacy};
