'use strict';
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})};
function createMiniappSelection({authority,context,core,legacy,services,db,transact,getBotIdentity}){
 return function select(token,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!=='orderId'||!Number.isSafeInteger(input.orderId)||input.orderId<1)fail(400,'MINIAPP_ORDER','Некорректный заказ');
  if(authority.bootstrap(token).role==='staff'){services.readOrder(token,input.orderId);return {ok:true,orderId:input.orderId,orderRef:`native-order:${input.orderId}`};}
  return transact(()=>{
   const ref=authority.order(token,input.orderId),actor=authority.actor(token),bot=getBotIdentity();
   if(!bot)fail(503,'MINIAPP_BOT','Связь с ботом временно недоступна');
   if(ref.threadId){
    const current=db.prepare("SELECT thread_id FROM chat_thread_channels WHERE bot_key=? AND telegram_user_id=? AND status='active'").get(bot.key,actor.principal.subject);
    if(current?.thread_id!==ref.threadId){
     // Signed Mini App identity + a previously verified OWN order grant. This is an explicit
     // order-selection action, never a fabricated Telegram update or a claim for another user.
     const link=core.issueTelegramLink(context.request(token,input.orderId),{threadId:ref.threadId});
     const selected=core.claimTelegramLink({botKey:bot.key,startPayload:link.startPayload,telegramUserId:actor.principal.subject,chatId:actor.principal.subject});
     if(!selected.claimed||selected.threadId!==ref.threadId)fail(409,'MINIAPP_SELECTION','Не удалось выбрать заказ');
    }
   }else legacy.select({token,orderId:input.orderId,dialogId:ref.dialogId});
   authority.order(token,input.orderId);
   return {ok:true,orderId:input.orderId,orderRef:ref.orderRef,threadRef:ref.threadRef,dialogRef:ref.dialogRef??null};
  });
 };
}
module.exports={createMiniappSelection};
