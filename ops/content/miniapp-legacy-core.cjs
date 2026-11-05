'use strict';
const crypto=require('node:crypto');
const {createMiniappNotifications,STAFF_CONTEXT_PREFIX}=require('./miniapp-notifications.cjs');
const mediaKit=require('./customer-chat-media.cjs'),uploadKit=require('./customer-chat-upload.cjs');
const SITE='palitra',COMPANY='palitra-love',PREFIX=COMPANY+'/miniapp-legacy-requests/v1/';
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
// Receives capabilities from the one existing client-dialogs factory, never from HTTP.
function createMiniappLegacyCore(c,{miniappUrl}){
 const notifications=createMiniappNotifications(c,{miniappUrl});
 const {db,tx,now}=c,storage=mediaKit.createMediaStorage({root:c.storageRoot});
 const endpoint=new URL(miniappUrl);if(endpoint.origin!=='https://palitra-love.ru'||endpoint.pathname!=='/love-app/telegram.html'||endpoint.search||endpoint.hash)throw new TypeError('Нужен текущий разрешённый вход Mini App');
 const stamp=()=>new Date(now()).toISOString();
 function scope(input){
   if(typeof input?.verify!=='function')fail(403,'MINIAPP_LEGACY','Нет доступа');
   const proof=input.verify(),found=c.botForSite(SITE);
   if(!proof||proof.companyCode!==COMPANY||proof.orderId!==input.orderId||proof.dialogId!==input.dialogId||
      typeof proof.subject!=='string'||!/^[1-9]\d{0,15}$/.test(proof.subject)||!found?.enabled||proof.botKey!==found.key)fail(404,'MINIAPP_LEGACY','Переписка не найдена');
   const dialog=db.prepare(`SELECT d.* FROM client_dialogs d WHERE d.id=? AND d.bot_key=? AND d.company_code=? AND d.telegram_user_id=?
     AND EXISTS(SELECT 1 FROM client_order_links l JOIN site_orders o ON o.id=l.order_id AND o.site=l.site AND o.company_code=d.company_code
       WHERE l.dialog_id=d.id AND l.bot_key=d.bot_key AND l.site=? AND l.order_id=? AND l.used_at IS NOT NULL)
     AND NOT EXISTS(SELECT 1 FROM chat_threads t JOIN chat_thread_channels ch ON ch.thread_id=t.id
       WHERE t.site=? AND t.company_code=d.company_code AND t.order_id=?)`).get(input.dialogId,found.key,COMPANY,proof.subject,SITE,input.orderId,SITE,input.orderId);
   if(!dialog)fail(404,'MINIAPP_LEGACY','Переписка не найдена');
   return {found,dialog,proof,uploadScope:{site:SITE,companyCode:COMPANY,botKey:found.key,actorKind:'web',actorRef:`miniapp:${found.key}:${proof.subject}`,targetKind:'legacy',targetId:dialog.id}};
 }
 function store(write=false){const s=c.getUploads();if(!s)fail(503,'MINIAPP_UPLOADS','Файлы временно недоступны');if(write&&!c.uploadsEnabled())fail(409,'UPLOADS_DISABLED','Отправка файлов пока недоступна');return s;}
 const key=(s,id)=>PREFIX+hash(JSON.stringify([s.found.key,s.proof.subject,id]));
 function receipt(k){const row=db.prepare('SELECT body FROM documents WHERE key=? ORDER BY version DESC LIMIT 1').get(k);if(!row)return null;try{const value=JSON.parse(row.body);if(value.schema!==1)throw 0;return value}catch{fail(503,'MINIAPP_JOURNAL','Не удалось прочитать квитанцию сообщения')}}
 function previous(s,requestId,fingerprint){const k=key(s,requestId),r=receipt(k);if(r&&r.fingerprint!==fingerprint)fail(409,'REQUEST_MISMATCH','Этот requestId уже использован для другой отправки');return {k,r};}
 function save(k,value){db.prepare('INSERT INTO documents(key,version,created_at,author,body) VALUES(?,1,?,?,?)').run(k,stamp(),'palitra-miniapp-legacy',JSON.stringify({schema:1,...value}));}
 function deliverable(s){const operator=c.activeOperator(s.found.key);if(!operator||!c.bridgeState(s.found.key).ready)fail(503,'MINIAPP_BRIDGE','Связь с менеджером временно недоступна');return operator;}
 function notify(s,messageId,text,upload=null){
   const operator=deliverable(s),url=new URL(endpoint.href);url.searchParams.set('order',String(s.proof.orderId));url.searchParams.set('chat',`legacy:${s.dialog.id}`);
   const name=db.prepare("SELECT name FROM site_orders WHERE id=? AND site='palitra' AND company_code='palitra-love'").get(s.proof.orderId)?.name||'Клиент';
   const short=value=>Array.from(String(value).replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim()).slice(0,500).join('');
   const header=`Сообщение · №${s.proof.orderId} · ${short(name).slice(0,100)} · ${short(text)||'Вложение'}`;
   const parts=c.textParts(operator.telegram_user_id,header,{map:'message'});
   if(parts[0])parts[0].params.reply_markup={inline_keyboard:[[{text:'Открыть заказ',web_app:{url:url.href}}]]};
   if(upload)parts.push(store().filePart(upload,{chatId:String(operator.telegram_user_id),caption:''}));
   return c.enqueue(s.found.key,s.found.bot,'forward',{parts,dialogId:s.dialog.id,messageId,operatorId:operator.telegram_user_id});
 }
 function customerRead(input){
   const s=scope(input),limit=input.limit??50,before=input.before??null;
   if(!Number.isSafeInteger(limit)||limit<1||limit>100||before!==null&&(!Number.isSafeInteger(before)||before<1))fail(400,'MINIAPP_PAGE','Некорректная страница');
   const rows=db.prepare("SELECT * FROM client_dialog_messages WHERE dialog_id=? AND direction IN ('in','out') AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?").all(s.dialog.id,before,before,limit+1);
   const more=rows.length>limit,page=rows.slice(0,limit).reverse();
   const messages=page.map(m=>({id:m.id,direction:m.direction,authorKind:m.author_type==='client'?'customer':m.author_type==='operator'?'manager':'system',text:m.text,createdAt:m.created_at,
     attachments:[...db.prepare("SELECT id,kind,mime,name,size,status FROM client_dialog_attachments WHERE message_id=? AND superseded_at IS NULL ORDER BY id").all(m.id).map(a=>({...a,ref:`legacy:${a.id}`})),
       ...(c.getUploads()?.forLegacyMessage(m.id)?[c.getUploads().attachmentView(c.getUploads().forLegacyMessage(m.id))]:[])]}));
   scope(input);return {orderId:input.orderId,dialogRef:`legacy:${s.dialog.id}`,messages,nextBefore:more?page[0].id:null,...(c.uploadsEnabled()?{uploads:{enabled:true,maxBytes:store().maxFile}}:{})};
 }
 function customerSend(input){
   const {requestId,text}=input;if(!uuid(requestId)||typeof text!=='string'||!text.trim()||text.length>8000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))fail(400,'MINIAPP_TEXT','Напишите корректный текст сообщения');
   return tx(()=>{
     const s=scope(input),fingerprint=hash(JSON.stringify({kind:'text',orderId:input.orderId,dialogId:s.dialog.id,text})),{k,r}=previous(s,requestId,fingerprint);
     if(r)return {ok:true,duplicate:true,orderId:input.orderId,messageId:r.messageId,requestId};
     if(c.getUploads()?.requestUsed('web',s.uploadScope.actorRef,requestId))fail(409,'REQUEST_MISMATCH','Этот requestId уже использован для файла');
     deliverable(s);
     const messageId=c.insertMessage({dialog:s.dialog,direction:'in',authorType:'client',text,chatId:null,messageId:null});
     if(typeof c.onAcceptedCustomerMessage==='function')c.onAcceptedCustomerMessage({dialogId:s.dialog.id,messageId});
     db.prepare('UPDATE client_dialogs SET unread=unread+1 WHERE id=?').run(s.dialog.id);
     scope(input);const jobId=notify(s,messageId,text);
     save(k,{kind:'text',fingerprint,messageId,jobId,orderId:input.orderId,dialogId:s.dialog.id,subject:s.proof.subject});
     return {ok:true,duplicate:false,orderId:input.orderId,messageId,requestId};
   });
 }
 function staffWrite(input,action){
   if(typeof input?.verifyOwner!=='function'||typeof action!=='function')fail(403,'MINIAPP_STAFF','Нет доступа сотрудника');
   return tx(()=>{
    input.verifyOwner();const found=c.botForSite(SITE),orderId=input.orderId??null;
    const dialog=found&&db.prepare('SELECT * FROM client_dialogs WHERE id=? AND bot_key=? AND company_code=?').get(input.dialogId,found.key,COMPANY);
    if(!dialog||!found.enabled)fail(404,'MINIAPP_CHAT','Переписка не найдена');
    if(orderId!==null&&(!Number.isSafeInteger(orderId)||!db.prepare(`SELECT 1 FROM site_orders o WHERE o.id=? AND o.site=? AND o.company_code=? AND
      (o.id=? OR EXISTS(SELECT 1 FROM client_order_links l WHERE l.order_id=o.id AND l.dialog_id=? AND l.bot_key=? AND l.site=o.site AND l.used_at IS NOT NULL))`).get(orderId,SITE,COMPANY,dialog.order_id,input.dialogId,found.key)))fail(404,'MINIAPP_ORDER','Заказ не найден');
    const result=action();input.verifyOwner();const messageId=result?.messageId;
    const message=Number.isSafeInteger(messageId)&&db.prepare("SELECT id FROM client_dialog_messages WHERE id=? AND dialog_id=? AND bot_key=? AND company_code=? AND direction='out' AND author_type='operator'").get(messageId,dialog.id,found.key,COMPANY);
    if(!message)fail(409,'MINIAPP_RECEIPT','Ответ не подтверждён');
    const k=STAFF_CONTEXT_PREFIX+found.key+'/'+messageId,old=receipt(k);
    if(old&&(old.orderId!==orderId||old.dialogId!==dialog.id||old.messageId!==messageId))fail(409,'REQUEST_MISMATCH','Этот запрос уже относится к другому заказу');
    if(!old)save(k,{kind:'staff-context',orderId,dialogId:dialog.id,messageId});return result;
   });
 }
 function customerSelect(input){
   return tx(()=>{
     const s=scope(input);
     db.prepare(`UPDATE chat_thread_channels SET status='inactive',deactivated_at=?,deactivated_reason='switched'
       WHERE bot_key=? AND telegram_user_id=? AND status='active' AND thread_id IN
       (SELECT id FROM chat_threads WHERE site=? AND company_code=?)`).run(stamp(),s.found.key,s.proof.subject,SITE,COMPANY);
     db.prepare('UPDATE client_dialogs SET order_id=? WHERE id=? AND bot_key=? AND telegram_user_id=?').run(input.orderId,s.dialog.id,s.found.key,s.proof.subject);
     scope(input);return {ok:true,orderId:input.orderId,dialogRef:`legacy:${s.dialog.id}`};
   });
 }
 function prepareUpload(input){
   const u=uploadKit.prepareInput(input.body,{maxFile:store(true).maxFile});
   return tx(()=>{const s=scope(input),fingerprint=hash(JSON.stringify({kind:'file',orderId:input.orderId,dialogId:s.dialog.id,input:u})),{k,r}=previous(s,u.requestId,fingerprint);
     if(!r)deliverable(s);
     const result=store(true).prepare({scope:s.uploadScope,input:u,crossUsed:()=>Boolean(r&&r.kind!=='file')});
     if(!r)save(k,{kind:'file',fingerprint,uuid:result.row.upload_uuid,orderId:input.orderId,dialogId:s.dialog.id,subject:s.proof.subject});
     scope(input);return {ok:true,duplicate:result.duplicate,orderId:input.orderId,upload:store().view(result.row)};
   });
 }
 function uploadScope(input){
   const s=scope(input),row=store().row(input.uuid),r=row?receipt(key(s,row.request_id)):null;
   if(!r||r.kind!=='file'||r.uuid!==input.uuid||r.orderId!==input.orderId||r.dialogId!==input.dialogId)fail(404,'MINIAPP_FILE','Загрузка не найдена');
   return s;
 }
 function uploadStatus(input){const s=uploadScope(input);return store().status(input.uuid,s.uploadScope,row=>({orderId:input.orderId,messageId:row.legacy_message_id,requestId:row.request_id}));}
 function uploadBytes(input){
   const s=uploadScope(input),st=store(true),begun=st.begin(input.uuid,s.uploadScope);
   try{
     const result=st.finish({uuid:input.uuid,scope:s.uploadScope,claim:begun.claim,bytes:input.bytes,authorize:()=>scope(input),
       receipt:row=>({orderId:input.orderId,messageId:row.legacy_message_id,requestId:row.request_id}),commit:row=>{
         const fresh=scope(input);deliverable(fresh);
         const messageId=c.insertMessage({dialog:fresh.dialog,direction:'in',authorType:'client',text:row.caption,chatId:null,messageId:null});
         db.prepare('UPDATE client_dialogs SET unread=unread+1 WHERE id=?').run(fresh.dialog.id);
         const linked=st.link(row.upload_uuid,{legacyMessageId:messageId});if(typeof c.onAcceptedCustomerMessage==='function')c.onAcceptedCustomerMessage({dialogId:fresh.dialog.id,messageId});scope(input);notify(fresh,messageId,row.caption,linked);
         return {orderId:input.orderId,messageId,requestId:row.request_id};
       }});
     return {ok:true,...result,upload:st.view(st.row(input.uuid))};
   }catch(e){if(begun.claim)st.release(input.uuid,begun.claim,'Загрузка не завершена');throw e;}
 }
 function attachmentFor(s,input){
   const u=uploadKit.parseUploadRef(input.ref);
   if(u){const st=store(),meta=st.fileMeta(u,{targetKind:'legacy',targetId:s.dialog.id,site:SITE,companyCode:COMPANY});return {meta,open:()=>st.open(meta)};}
   const match=/^legacy:([1-9]\d*)$/.exec(input.ref||'');if(!match)fail(404,'MINIAPP_FILE','Файл не найден');
   const row=db.prepare("SELECT id,disk_name,size,mime,name,kind FROM client_dialog_attachments WHERE id=? AND dialog_id=? AND bot_key=? AND company_code=? AND status='stored' AND superseded_at IS NULL").get(Number(match[1]),s.dialog.id,s.found.key,COMPANY);
   if(!row||!uuid(row.disk_name))fail(404,'MINIAPP_FILE','Файл не найден');
   const actual=storage.inspect(row.disk_name);if(!actual||actual.size!==row.size)fail(404,'MINIAPP_FILE','Файл не найден');
   const meta={id:row.id,diskName:row.disk_name,size:row.size,sha256:actual.sha256,contentType:row.mime,name:row.name,kind:row.kind,presentation:mediaKit.presentationOf(row.kind,row.mime)};
   return {meta,open:()=>storage.open(meta.diskName,meta.size,meta.sha256)};
 }
 function attachment(input){return attachmentFor(scope(input),input);}
 function staffAttachment(input){
   if(typeof input?.verifyOwner!=='function'||input.verifyOwner()!==true)fail(403,'MINIAPP_STAFF','Нет доступа');
   const found=c.botForSite(SITE),dialog=found?db.prepare('SELECT * FROM client_dialogs WHERE id=? AND bot_key=? AND company_code=?').get(input.dialogId,found.key,COMPANY):null;
   if(!dialog)fail(404,'MINIAPP_FILE','Файл не найден');
   return attachmentFor({found,dialog},input);
 }
 function uploadOf(job){
   if(!job||job.kind!=='forward'||!Number.isSafeInteger(job.message_id))return null;
   const st=c.getUploads(),row=st?.forLegacyMessage(job.message_id);if(!row||row.actor_kind!=='web'||!row.actor_ref.startsWith('miniapp:')||row.bot_key!==job.bot_key||row.dialog_id!==job.dialog_id)return null;
   const subject=row.actor_ref.slice(('miniapp:'+row.bot_key+':').length),r=receipt(PREFIX+hash(JSON.stringify([row.bot_key,subject,row.request_id])));
   const dialog=db.prepare('SELECT telegram_user_id FROM client_dialogs WHERE id=? AND bot_key=?').get(job.dialog_id,job.bot_key);
   return r?.kind==='file'&&r.uuid===row.upload_uuid&&r.dialogId===row.dialog_id&&dialog?.telegram_user_id===subject?row:null;
 }
 function uploadJobAllowed(job){
   const row=uploadOf(job),operator=c.activeOperator(job?.bot_key);if(!row||!operator||job.operator_id!==operator.telegram_user_id)return false;
   let parts;try{parts=JSON.parse(job.parts)}catch{return false}
   const files=parts.filter(p=>Object.hasOwn(uploadKit.FILE_METHODS,p?.method));
   return files.length===1&&store().partMatches(files[0],row)&&parts.every(p=>(p.method==='sendMessage'||Object.hasOwn(uploadKit.FILE_METHODS,p.method))&&String(p.params?.chat_id)===String(operator.telegram_user_id));
 }
 function isMessageJob(job){
   if(uploadOf(job))return true;
   if(!job||job.kind!=='forward'||!Number.isSafeInteger(job.message_id))return false;
   const m=db.prepare("SELECT m.*,d.telegram_user_id FROM client_dialog_messages m JOIN client_dialogs d ON d.id=m.dialog_id WHERE m.id=? AND m.dialog_id=? AND m.bot_key=? AND m.company_code=? AND m.direction='in' AND m.author_type='client' AND m.chat_id IS NULL AND m.message_id IS NULL").get(job.message_id,job.dialog_id,job.bot_key,COMPANY);
   if(!m)return false;
   const r=db.prepare("SELECT body FROM documents WHERE key LIKE ? AND json_extract(body,'$.kind')='text' AND json_extract(body,'$.messageId')=? AND json_extract(body,'$.jobId')=?").get(PREFIX+'%',m.id,job.id);
   if(!r)return false;const body=JSON.parse(r.body);return body.subject===m.telegram_user_id&&body.dialogId===m.dialog_id;
 }
 return Object.freeze({customerRead,customerSend,customerSelect,prepareUpload,uploadStatus,uploadBytes,attachment,staffAttachment,staffWrite,uploadOf,uploadJobAllowed,isMessageJob,
   startMarkup:notifications.startMarkup,orderParts:notifications.orderParts,notificationParts:(job,parts)=>isMessageJob(job)?parts:notifications.notificationParts(job,parts)});
}
module.exports={createMiniappLegacyCore};
