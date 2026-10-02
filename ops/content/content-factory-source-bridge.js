'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const TYPES={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4','video/webm':'.webm'};
const matches=(type,head)=>type==='image/jpeg'?head.length>=4&&head[0]===255&&head[1]===216&&head[2]===255:
 type==='image/png'?head.length>=24&&head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
 type==='image/webp'?head.length>=16&&head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP':
 type==='video/mp4'?head.length>=12&&head.toString('ascii',4,8)==='ftyp':head.length>=4&&head.subarray(0,4).equals(Buffer.from([26,69,223,163]));
function createContentFactorySourceBridge({db,authStore,assetsDir,requireSession,requireCsrf,readJson,sendJson,crmCall,
 ready=()=>true,publishingOrigin,maxImageBytes=10*1024*1024,maxVideoBytes=60*1024*1024}){
 const origin=new URL(publishingOrigin);
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/')throw Error('Invalid publishing origin');
 function access(request,code,edit=false,initial=null){
  const session=requireSession(request),user=authStore.getById(session.user.id);
  if(!user||user.sessionVersion!==session.user.sessionVersion)fail(401,'Требуется вход в кабинет');
  if(user.role!=='owner'&&(!user.companyCodes.includes(code)||!user.permissions.includes('autoposting.view')||edit&&!user.permissions.includes('autoposting.edit')))fail(403,'Нет доступа к исходникам компании');
  if(initial&&user.id!==initial.user.id)fail(403,'Доступ изменился во время операции');
  if(edit)requireCsrf(request,session);
  return {session,user};
 }
 function source(code,id,revision=null){
  const row=db.prepare('SELECT * FROM telegram_source_items WHERE company_code=? AND id=?').get(code,id);
  if(!row)fail(404,'Исходник не найден');
  if(revision!==null&&(!Number.isSafeInteger(revision)||revision<1||revision!==row.revision))fail(409,'Исходник уже изменён. Обновите библиотеку.');
  return row;
 }
 function exportReady(code,row){
  let metadata;try{metadata=JSON.parse(row.metadata||'{}');}catch{fail(409,'Метаданные исходника требуют проверки');}
  if(row.status!=='stored'||metadata.materialState!=='ready')fail(409,'Отметьте файл как готовый материал перед прикреплением.');
  if(!Object.hasOwn(TYPES,row.mime))fail(415,'Для публикации доступны JPEG, PNG, WebP, MP4 и WebM. Остальные файлы остаются исходниками.');
  if(!/^[a-f0-9]{64}$/.test(row.sha256||'')||row.disk_name!==row.sha256)fail(409,'Файл требует проверки');
  const filename=path.join(assetsDir,'telegram-sources',code,row.disk_name);
  if(!fs.existsSync(filename))fail(404,'Файл исходника недоступен');
  const size=fs.statSync(filename).size,limit=row.mime.startsWith('video/')?maxVideoBytes:maxImageBytes;
  if(size<1||size>limit)fail(413,'Готовый материал превышает допустимый размер');
  const bytes=fs.readFileSync(filename);
  if(!matches(row.mime,bytes.subarray(0,32)))fail(415,'Содержимое файла не соответствует его формату');
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==row.sha256)fail(409,'Файл исходника изменился. Загрузите проверенную версию.');
  const name=row.sha256.slice(0,32)+TYPES[row.mime],directory=path.join(assetsDir,'publishing',code),destination=path.join(directory,name);
  fs.mkdirSync(directory,{recursive:true});
  try{fs.writeFileSync(destination,bytes,{flag:'wx'});}catch(error){
   if(error.code!=='EEXIST')throw error;
   if(crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')!==row.sha256)fail(409,'Готовый файл требует проверки');
  }
  return {id:row.id,revision:row.revision,sha256:row.sha256,url:origin.origin+'/content/publishing-assets/'+code+'/'+name};
 }
 async function handle(request,response,url){
  const match=/^\/content\/telegram-sources\/([a-z0-9_-]{1,64})\/([1-9]\d*)\/(attach|usage)$/.exec(url.pathname);
  if(!match)return false;
  const [,code,rawId,action]=match,id=Number(rawId),edit=action==='attach';
  if(!Number.isSafeInteger(id))fail(404,'Исходник не найден');
  if(request.method!==(edit?'POST':'GET'))fail(405,'Метод не поддерживается');
  const initial=access(request,code,edit);source(code,id);
  if(!ready())fail(503,'Связь с CRM пока не настроена');
  let result;
  if(edit){
   const body=await readJson(request);
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['clientRequestId','sourceRevision','postId','revision','newPost'].includes(key)))fail(400,'Некорректные параметры прикрепления');
   if(typeof body.clientRequestId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(body.clientRequestId)||
      !Number.isSafeInteger(body.sourceRevision)||body.sourceRevision<1)fail(400,'Нужны ключ запроса и версия исходника');
   const existing=Object.hasOwn(body,'postId'),creating=Object.hasOwn(body,'newPost');
   if(existing===creating)fail(400,'Выберите карточку или создайте новый черновик');
   if(existing&&(!Number.isSafeInteger(body.postId)||body.postId<1||!Number.isSafeInteger(body.revision)||body.revision<1))fail(400,'Нужны номер карточки и её версия');
   if(creating){
    const fields=body.newPost;
    if(Object.hasOwn(body,'revision')||!fields||typeof fields!=='object'||Array.isArray(fields)||
       Object.keys(fields).some(key=>!['title','text','format','ovpRole'].includes(key))||
       fields.title!==undefined&&(typeof fields.title!=='string'||fields.title.length>200)||
       fields.text!==undefined&&(typeof fields.text!=='string'||fields.text.length>20000)||
       fields.format!==undefined&& !['','post','story','reel','carousel'].includes(fields.format)||
       fields.ovpRole!==undefined&& !['','reach','affection','sale'].includes(fields.ovpRole))fail(400,'Некорректные параметры черновика');
   }
   const {sourceRevision,...target}=body;
   const fresh=access(request,code,true,initial),row=source(code,id);
   if(row.revision!==sourceRevision){
    // Metadata may change after CRM committed a request whose response was lost. This path only reads its receipt.
    if(!/^[a-f0-9]{64}$/.test(row.sha256||'')||row.disk_name!==row.sha256||!Object.hasOwn(TYPES,row.mime))fail(409,'Исходник уже изменён. Обновите библиотеку.');
    const pointer={id:row.id,revision:sourceRevision,sha256:row.sha256,url:origin.origin+'/content/publishing-assets/'+code+'/'+row.sha256.slice(0,32)+TYPES[row.mime]};
    const lookup=await crmCall('source-attach-lookup',code,{...target,source:pointer},fresh.user);
    access(request,code,true,initial);
    if(lookup?.companyCode!==code||!lookup.receipt)fail(409,'Исходник уже изменён. Обновите библиотеку.');
    if(lookup.receipt.companyCode!==code||lookup.receipt.duplicate!==true||lookup.receipt.link?.sourceId!==id||
       lookup.receipt.link?.sourceRevision!==sourceRevision||lookup.receipt.link?.sha256!==pointer.sha256||
       lookup.receipt.link?.url!==pointer.url||lookup.receipt.post?.id!==lookup.receipt.link?.postId)fail(502,'CRM вернула неполный ответ. Повторите тот же запрос.');
    sendJson(response,200,lookup.receipt,{'cache-control':'no-store'});return true;
   }
   const exported=exportReady(code,source(code,id,sourceRevision));
   // CRM фиксирует ссылку и новую версию карточки одной транзакцией; библиотека хранит исходник отдельно.
   result=await crmCall('source-attach',code,{...target,source:exported},fresh.user);
  }else result=await crmCall('source-usage',code,{sourceId:id},initial.user);
  access(request,code,edit,initial);
  sendJson(response,200,result,{'cache-control':'no-store'});return true;
 }
 return {handle};
}
module.exports={createContentFactorySourceBridge};
