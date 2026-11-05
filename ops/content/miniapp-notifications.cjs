'use strict';
const positive=n=>Number.isSafeInteger(n)&&n>0;
const STAFF_CONTEXT_PREFIX='palitra-love/miniapp-staff-message/v1/';
const clean=(value,max)=>{const a=Array.from(String(value||'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim());return a.length>max?a.slice(0,max-1).join('')+'…':a.join('')};
function createMiniappNotifications(c,{miniappUrl}){
 const {db}=c,entry=new URL(miniappUrl);if(entry.href!=='https://palitra-love.ru/love-app/telegram.html')throw new TypeError('Нужен действующий вход Палитры');
 function order(id){return positive(id)?db.prepare("SELECT id,name FROM site_orders WHERE id=? AND site='palitra' AND company_code='palitra-love'").get(id):null}
 function link(orderId,conversationRef,staff){const url=new URL(entry);if(positive(orderId))url.searchParams.set('order',String(orderId));if(staff&&conversationRef)url.searchParams.set('chat',conversationRef);return url.href}
 function button(orderId,conversationRef,staff,label='Открыть заказ'){return {text:label,web_app:{url:link(orderId,conversationRef,staff)}}}
 function startMarkup({key,chatId,threadId,dialogId}){
  const found=c.botForSite('palitra');if(!found?.enabled||found.key!==key||typeof chatId!=='string'||!/^[1-9]\d{0,15}$/.test(chatId))return null;
  let row;
  if(positive(threadId))row=db.prepare(`SELECT t.order_id FROM chat_threads t JOIN chat_thread_channels ch ON ch.thread_id=t.id
   WHERE t.id=? AND t.site='palitra' AND t.company_code='palitra-love' AND ch.bot_key=? AND ch.telegram_user_id=? AND ch.chat_id=? AND ch.status='active'
   AND ch.id=(SELECT max(last.id) FROM chat_thread_channels last WHERE last.thread_id=t.id AND last.bot_key=ch.bot_key)`).get(threadId,key,chatId,chatId);
  else if(positive(dialogId))row=db.prepare(`SELECT d.order_id FROM client_dialogs d WHERE d.id=? AND d.bot_key=? AND d.company_code='palitra-love' AND d.telegram_user_id=? AND d.chat_id=?
   AND EXISTS(SELECT 1 FROM client_order_links l WHERE l.dialog_id=d.id AND l.bot_key=d.bot_key AND l.site='palitra' AND l.order_id=d.order_id AND l.used_at IS NOT NULL)`).get(dialogId,key,chatId,chatId);
  if(!row||!order(row.order_id))return null;return {inline_keyboard:[[button(row.order_id,null,false,'Мой заказ')]]};
 }
 function projected(parts,context,known=[]){
  if(!context||!Array.isArray(parts)||!parts.length||!Array.isArray(known)||known.length)return parts;
  if(parts.some(p=>String(p?.params?.chat_id)!==context.chatId))return parts;
  const result=parts.map(p=>({...p,params:{...p.params}})),indices=result.map((p,i)=>p.method==='sendMessage'&&typeof p.params.text==='string'?i:-1).filter(i=>i>=0);
  if(context.staff&&indices.length){
   const row=order(context.orderId),label=row?`№${row.id}`:'Без заказа',name=clean(row?.name||context.name,100)||'Клиент';
   const carriesText=result.some(p=>p.method==='copyMessage'||p.method!=='sendMessage'&&p.params.caption);
   const content=`${context.event||'Сообщение'} · ${label} · ${name}${carriesText?'':' · '+clean(context.body,500)}`;
   const points=Array.from(content);if(points.length>=indices.length){let offset=0;indices.forEach((i,n)=>{const size=Math.ceil((points.length-offset)/(indices.length-n));result[i].params.text=points.slice(offset,offset+size).join('');offset+=size})}
  }
  const index=indices[0]??0,previous=result[index].params.reply_markup;
  // Preserve unrelated existing callbacks; replace only our exact WebApp pointer, never destinations/media/receipt slots.
  const rows=Array.isArray(previous?.inline_keyboard)?previous.inline_keyboard.map(r=>r.filter(b=>!b.web_app||!String(b.web_app.url).startsWith(entry.href))).filter(r=>r.length):[];
  result[index].params.reply_markup={inline_keyboard:[...rows,[button(context.orderId,context.conversationRef,context.staff,context.orderId?'Открыть заказ':'Открыть переписку')]]};
  return result;
 }
 function notificationParts(job,parts){
  if(!job||job.company_code!=='palitra-love'||!['forward','reply'].includes(job.kind))return parts;
  const found=c.botForSite('palitra');if(!found?.enabled||found.key!==job.bot_key)return parts;let known;try{known=JSON.parse(job.external_ids||'[]')}catch{return parts}
  const native=db.prepare("SELECT thread_id,message_id,target FROM chat_native_jobs WHERE job_id=? AND bot_key=? AND company_code='palitra-love'").get(job.id,job.bot_key);
  let context;
  if(native){const row=db.prepare(`SELECT m.text,m.direction,m.author_kind,t.order_id FROM chat_thread_messages m JOIN chat_threads t ON t.id=m.thread_id
    WHERE m.id=? AND t.id=? AND t.site='palitra' AND t.company_code='palitra-love'`).get(native.message_id,native.thread_id);
   if(!row)return parts;
   if(native.target==='manager'){const operator=c.activeOperator(found.key);if(!operator||job.operator_id!==operator.telegram_user_id||row.direction!=='in'||row.author_kind!=='customer')return parts;
    context={staff:true,chatId:String(operator.telegram_user_id),orderId:order(row.order_id)?.id||null,conversationRef:`thread:${native.thread_id}`,name:'Клиент',
     body:c.notificationText.message(native.message_id,native.thread_id)?.body||row.text||'Вложение'};
   }else if(native.target==='customer'){const channel=db.prepare("SELECT chat_id FROM chat_thread_channels WHERE thread_id=? AND bot_key=? AND status='active' ORDER BY id DESC LIMIT 1").get(native.thread_id,found.key);if(!channel||!['out','in'].includes(row.direction))return parts;
    if(!order(row.order_id))return parts;context={staff:false,chatId:String(channel.chat_id),orderId:row.order_id};
   }
  }else if(positive(job.dialog_id)&&positive(job.message_id)){
   const row=db.prepare(`SELECT m.text,m.direction,m.author_type,d.order_id,d.chat_id,d.display_name FROM client_dialog_messages m JOIN client_dialogs d ON d.id=m.dialog_id
    WHERE m.id=? AND d.id=? AND m.bot_key=? AND d.bot_key=m.bot_key AND m.company_code='palitra-love' AND d.company_code='palitra-love'`).get(job.message_id,job.dialog_id,found.key);if(!row)return parts;
   if(job.kind==='forward'&&row.direction==='in'&&row.author_type==='client'){const operator=c.activeOperator(found.key);if(!operator||job.operator_id!==operator.telegram_user_id)return parts;
    context={staff:true,chatId:String(operator.telegram_user_id),orderId:order(row.order_id)?.id||null,conversationRef:`legacy:${job.dialog_id}`,name:row.display_name,body:row.text||'Вложение'};
   }else if(job.kind==='reply'&&row.direction==='out'){
    let orderId=row.order_id;const record=db.prepare('SELECT body FROM documents WHERE key=? ORDER BY version DESC LIMIT 1').get(STAFF_CONTEXT_PREFIX+found.key+'/'+job.message_id);
    if(record){let value;try{value=JSON.parse(record.body)}catch{return parts}if(value.schema!==1||value.messageId!==job.message_id||value.dialogId!==job.dialog_id)return parts;orderId=value.orderId;}
    if(!order(orderId))return parts;context={staff:false,chatId:String(row.chat_id),orderId};
   }
  }
  return projected(parts,context,known);
 }
 function orderParts(job,parts){const found=c.botForSite('palitra'),row=order(job.orderId),operator=found&&c.activeOperator(found.key);
  if(!found?.enabled||!row||job.site!=='palitra'||job.companyCode!=='palitra-love'||job.orderKind!=='order'||job.compactNotification!==true||!operator||String(job.chatId)!==operator.telegram_user_id)return parts;
  const threads=db.prepare("SELECT id FROM chat_threads WHERE order_id=? AND site='palitra' AND company_code='palitra-love' ORDER BY id").all(row.id);
  return projected(parts,{staff:true,chatId:String(job.chatId),orderId:row.id,conversationRef:threads.length===1?`thread:${threads[0].id}`:null,event:'Новая заявка',body:c.notificationText.order(row.id)?.body||'Клиент оформил заявку.'});
 }
 return Object.freeze({notificationParts,orderParts,startMarkup});
}
module.exports={createMiniappNotifications,STAFF_CONTEXT_PREFIX};
