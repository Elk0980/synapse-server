'use strict';

const crypto=require('node:crypto');
const MAX_IMAGE_BYTES=8*1024*1024,MAX_RESPONSE_BYTES=2*1024*1024;
const VK_DESIGN_ERRORS=Object.freeze({
 INVALID_INPUT:'Проверьте параметры оформления',INVALID_IMAGE:'Нужен корректный JPEG или PNG до 8 МиБ с допустимыми размерами',
 CONNECTION_MISSING:'Сначала сохраните и проверьте подключение оформления ВКонтакте',SETTINGS_CHANGED:'Подключение изменилось. Создайте новый предпросмотр',
 GROUP_MISMATCH:'Ответ ВКонтакте не соответствует выбранному сообществу',RESPONSE_INVALID:'ВКонтакте вернул неожиданный ответ',
 PREVIEW_NOT_FOUND:'Предпросмотр этой компании не найден',PREVIEW_EXPIRED:'Предпросмотр устарел. Создайте новый',
 PREVIEW_LIMIT:'Достигнут лимит активных предпросмотров. Дождитесь истечения старых или примените нужный',
 STATE_CHANGED:'Оформление сообщества изменилось. Создайте новый предпросмотр',REQUEST_CONFLICT:'Идентификатор запроса уже использован для другого изменения',
 OPERATION_BUSY:'Предыдущее изменение ещё обрабатывается. Проверьте журнал',ACCESS_DENIED:'ВКонтакте не предоставил нужные права',
 PLATFORM_REJECTED:'ВКонтакте отклонил изменение',CONNECTION_UNCERTAIN:'Результат изменения неизвестен. Автоматического повтора не будет',
 UNSAFE_UPLOAD_URL:'Сервер загрузки ВКонтакте не входит в разрешённый список',UPLOAD_FAILED:'Не удалось подготовить обложку на сервере ВКонтакте',
 READBACK_MISMATCH:'ВКонтакте принял изменение, но опубликованный результат ещё не подтверждён',
 ROLLBACK_UNAVAILABLE:'Для этого изменения автоматическое восстановление недоступно',
});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,status=400)=>{throw Object.assign(new Error(VK_DESIGN_ERRORS[code]||VK_DESIGN_ERRORS.RESPONSE_INVALID),{code,status});};
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const stateHash=value=>digest(JSON.stringify(value));
const knownCode=error=>Object.hasOwn(VK_DESIGN_ERRORS,error?.code)?error.code:'CONNECTION_UNCERTAIN';
const strictKeys=(value,allowed)=>{if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('INVALID_INPUT');};
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{16,100}$/.test(value);
function validateUploadUrl(value) {
 let url;try{url=new URL(value);}catch{fail('UNSAFE_UPLOAD_URL');}
 const host=url.hostname.toLowerCase();
 if(typeof value!=='string'||value.length>8192||url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||
  !['vk.com','vk.ru','userapi.com'].some(domain=>host===domain||host.endsWith('.'+domain)))fail('UNSAFE_UPLOAD_URL');
 return url.href;
}
function validateImage(image) {
 if(!object(image)||Object.keys(image).some(key=>!['mime','base64'].includes(key))||!['image/png','image/jpeg'].includes(image.mime)||
  typeof image.base64!=='string'||!image.base64.length||image.base64.length%4!==0||image.base64.length>4*Math.ceil(MAX_IMAGE_BYTES/3)||/[^A-Za-z0-9+/=]/.test(image.base64))fail('INVALID_IMAGE');
 // Canonical roundtrip below rejects misplaced/excess padding without a repeated-group regex over multi-megabyte input.
 const bytes=Buffer.from(image.base64,'base64');if(bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==image.base64)fail('INVALID_IMAGE');
 let width=0,height=0;
 if(image.mime==='image/png') {
  if(bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('INVALID_IMAGE');
  let offset=8,header=false,data=false,end=false;
  while(offset+12<=bytes.length){
   const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);
   if(length>MAX_IMAGE_BYTES||offset+12+length>bytes.length)fail('INVALID_IMAGE');
   if(!header){if(type!=='IHDR'||length!==13)fail('INVALID_IMAGE');width=bytes.readUInt32BE(offset+8);height=bytes.readUInt32BE(offset+12);header=true;}
   else if(type==='IHDR')fail('INVALID_IMAGE');
   if(type==='IDAT')data=true;
   offset+=length+12;
   if(type==='IEND'){if(length!==0||offset!==bytes.length)fail('INVALID_IMAGE');end=true;break;}
  }
  if(!header||!data||!end)fail('INVALID_IMAGE');
 } else {
  if(bytes.length<12||bytes[0]!==0xff||bytes[1]!==0xd8||bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)fail('INVALID_IMAGE');
  let offset=2,scan=false;
  while(offset+4<=bytes.length){
   if(bytes[offset++]!==0xff)fail('INVALID_IMAGE');while(bytes[offset]===0xff)offset++;
   const marker=bytes[offset++];if(marker===0xda){if(offset+2>bytes.length||bytes.readUInt16BE(offset)<6||offset+bytes.readUInt16BE(offset)>=bytes.length-2)fail('INVALID_IMAGE');scan=true;break;}if(marker===0xd9)break;
   if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
   if(offset+2>bytes.length)fail('INVALID_IMAGE');const length=bytes.readUInt16BE(offset);
   if(length<2||offset+length>bytes.length)fail('INVALID_IMAGE');
   if([0xc0,0xc1,0xc2].includes(marker)){if(length<8)fail('INVALID_IMAGE');height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);}
   offset+=length;
  }
  if(!scan)fail('INVALID_IMAGE');
 }
 if(!width||!height||width>16384||height>16384||width*height>40000000)fail('INVALID_IMAGE');
 return {bytes,mime:image.mime,width,height,sourceHash:digest(bytes)};
}
function images(value) {
 if(!Array.isArray(value)||value.length>30)fail('RESPONSE_INVALID',502);
 return value.map(item=>{
  if(!object(item)||!Number.isSafeInteger(item.width)||item.width<1||!Number.isSafeInteger(item.height)||item.height<1||typeof item.url!=='string'||item.url.length>4096)fail('RESPONSE_INVALID',502);
  let url;try{url=validateUploadUrl(item.url);}catch{fail('RESPONSE_INVALID',502);}
  return {url,width:item.width,height:item.height};
 }).sort((a,b)=>a.width-b.width||a.height-b.height||a.url.localeCompare(b.url));
}
function createVkDesign(db,{direct,fetchImpl=fetch,now=Date.now,timeoutMs=15000}={}) {
 if(!direct?.getSettings||!direct?.request)throw new Error('VK direct connector is required');
 db.exec(`CREATE TABLE IF NOT EXISTS vk_design_previews (
  company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code),preview_id TEXT NOT NULL,
  group_id TEXT NOT NULL,revision INTEGER NOT NULL,operation TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,
  before_hash TEXT NOT NULL,source_hash TEXT NOT NULL,image_bytes BLOB,warnings_json TEXT NOT NULL,created_at TEXT NOT NULL,
  PRIMARY KEY(company_code,preview_id));
 CREATE TABLE IF NOT EXISTS vk_design_actions (
  company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code),request_id TEXT NOT NULL,preview_id TEXT NOT NULL,
  group_id TEXT NOT NULL,revision INTEGER NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL,error_code TEXT,
  created_at TEXT NOT NULL,completed_at TEXT,PRIMARY KEY(company_code,request_id),UNIQUE(company_code,preview_id),
  FOREIGN KEY(company_code,preview_id) REFERENCES vk_design_previews(company_code,preview_id));`);
 const stamp=()=>new Date(now()).toISOString();
 function company(code) {
  if(typeof code!=='string'||! /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code))fail('INVALID_INPUT');
  const found=db.prepare('SELECT code FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
  if(!found)fail('INVALID_INPUT',404);return found.code.toLowerCase();
 }
 function connection(code,revision) {
  const companyCode=company(code),row=direct.getSettings(companyCode,'design');
  if(row.companyCode!==companyCode||typeof row.groupId!=='string'||! /^[1-9]\d{0,14}$/.test(row.groupId))fail('CONNECTION_MISSING',409);
  if(revision!==undefined&&revision!==row.revision)fail('SETTINGS_CHANGED',409);
  if(!row.connected)fail('CONNECTION_MISSING',409);return row;
 }
 function guard(row){const current=connection(row.companyCode,row.revision);if(current.groupId!==row.groupId)fail('SETTINGS_CHANGED',409);}
 async function request(row,method,params){guard(row);return direct.request(row.companyCode,'design',row.revision,method,params);}
 async function readState(row) {
  const result=await request(row,'groups.getById',{fields:'description,cover'});guard(row);
  if(!object(result)||!Array.isArray(result.groups)||result.groups.length!==1||String(result.groups[0]?.id)!==row.groupId)fail('GROUP_MISMATCH',502);
  const group=result.groups[0];
  // Missing fields are unknown, not an empty description or a disabled cover.
  if(group.description!==undefined&&(typeof group.description!=='string'||group.description.length>10000))fail('RESPONSE_INVALID',502);
  if(group.cover!==undefined&&(!object(group.cover)||![0,1].includes(group.cover.enabled)))fail('RESPONSE_INVALID',502);
  const cover=group.cover===undefined?null:{enabled:group.cover.enabled===1,images:images(group.cover.images||[])};
  return {companyCode:row.companyCode,groupId:row.groupId,revision:row.revision,description:group.description??null,cover};
 }
 async function getState(code,options={}){strictKeys(options,['revision']);return readState(connection(code,options.revision));}
 const previewFor=(code,previewId)=>db.prepare('SELECT * FROM vk_design_previews WHERE company_code=? AND preview_id=?').get(code,previewId);
 const actionFor=(code,requestId)=>db.prepare('SELECT * FROM vk_design_actions WHERE company_code=? AND request_id=?').get(code,requestId);
 const previewDto=row=>({companyCode:row.company_code,groupId:row.group_id,revision:row.revision,previewId:row.preview_id,operation:row.operation,
  before:JSON.parse(row.before_json),after:JSON.parse(row.after_json),sourceHash:row.source_hash,warnings:JSON.parse(row.warnings_json),createdAt:row.created_at});
 const actionDto=row=>({...previewDto(previewFor(row.company_code,row.preview_id)),requestId:row.request_id,status:row.status,code:row.error_code||null,
  createdAt:row.created_at,completedAt:row.completed_at||null});
 function savePreview(row,operation,before,after,sourceHash,imageBytes,warnings) {
  guard(row);const previewId=crypto.randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try{
   guard(row);
   // Only unused expired previews are disposable. Referenced metadata/audit is retained.
   db.prepare(`DELETE FROM vk_design_previews WHERE company_code=? AND created_at<? AND NOT EXISTS
    (SELECT 1 FROM vk_design_actions a WHERE a.company_code=vk_design_previews.company_code AND a.preview_id=vk_design_previews.preview_id)`)
    .run(row.companyCode,new Date(now()-30*60*1000).toISOString());
   const usage=db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(image_bytes)),0) AS bytes FROM vk_design_previews p WHERE company_code=? AND NOT EXISTS
    (SELECT 1 FROM vk_design_actions a WHERE a.company_code=p.company_code AND a.preview_id=p.preview_id)`).get(row.companyCode);
   if(usage.count>=20||usage.bytes+(imageBytes?.length||0)>128*1024*1024)fail('PREVIEW_LIMIT',409);
   db.prepare(`INSERT INTO vk_design_previews(company_code,preview_id,group_id,revision,operation,before_json,after_json,before_hash,source_hash,image_bytes,warnings_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.companyCode,previewId,row.groupId,row.revision,operation,JSON.stringify(before),JSON.stringify(after),stateHash(before),sourceHash,imageBytes||null,JSON.stringify(warnings),stamp());
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return previewDto(previewFor(row.companyCode,previewId));
 }
 async function preview(code,body) {
  strictKeys(body,['revision','operation','description','image','crop']);const row=connection(code,body.revision);
  if(body.revision!==row.revision||!['description','cover'].includes(body.operation))fail('INVALID_INPUT');
  let after,sourceHash,imageBytes,warnings=[];
  if(body.operation==='description'){
   if(typeof body.description!=='string'||body.description.length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.description)||body.image!==undefined||body.crop!==undefined)fail('INVALID_INPUT');
   after=body.description;sourceHash=digest(after);
  }else{
   if(body.description!==undefined)fail('INVALID_INPUT');const image=validateImage(body.image);
   const crop=body.crop===undefined?{x:0,y:0,x2:image.width,y2:image.height}:body.crop;strictKeys(crop,['x','y','x2','y2']);
   if(!Object.values(crop).every(Number.isSafeInteger)||Object.keys(crop).length!==4||crop.x<0||crop.y<0||crop.x2<=crop.x||crop.y2<=crop.y||crop.x2>image.width||crop.y2>image.height)fail('INVALID_INPUT');
   after={mime:image.mime,width:image.width,height:image.height,sourceHash:image.sourceHash,crop};sourceHash=image.sourceHash;imageBytes=image.bytes;warnings=['COVER_RESTORE_REQUIRES_ORIGINAL'];
  }
  const current=await readState(row);if(current[body.operation]===null)fail('RESPONSE_INVALID',502);
  return savePreview(row,body.operation,current[body.operation],after,sourceHash,imageBytes,warnings);
 }
 async function readUploadResponse(response,signal) {
  if(!response.ok||response.redirected)fail('UPLOAD_FAILED',502);const reader=response.body?.getReader();if(!reader)fail('UPLOAD_FAILED',502);
  let size=0;const chunks=[];let abort;
  const aborted=new Promise((_,reject)=>{abort=()=>reject(new Error('Upload timeout'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
  try{
   while(true){const {done,value}=await Promise.race([reader.read(),aborted]);if(done)break;size+=value.byteLength;if(size>MAX_RESPONSE_BYTES)fail('UPLOAD_FAILED',502);chunks.push(value);}
   return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
  }finally{signal.removeEventListener('abort',abort);reader.cancel().catch(()=>{});}
 }
 async function upload(row,p) {
  const after=JSON.parse(p.after_json),crop=after.crop;
  const destination=await request(row,'photos.getOwnerCoverPhotoUploadServer',{crop_x:crop.x,crop_y:crop.y,crop_x2:crop.x2,crop_y2:crop.y2,is_video_cover:0});guard(row);
  const url=validateUploadUrl(destination?.upload_url),bytes=Buffer.from(p.image_bytes||[]);
  if(digest(bytes)!==p.source_hash)fail('INVALID_IMAGE');
  const body=new FormData();body.append('photo',new Blob([bytes],{type:after.mime}),after.mime==='image/png'?'cover.png':'cover.jpg');
  const controller=new AbortController(),signal=controller.signal;let result,timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Upload timeout'));},timeoutMs);});
  try{result=await Promise.race([(async()=>readUploadResponse(await fetchImpl(url,{method:'POST',body,redirect:'error',signal}),signal))(),timeout]);}catch{fail('UPLOAD_FAILED',502);}finally{clearTimeout(timer);}
  if(!object(result)||Object.hasOwn(result,'error'))fail('UPLOAD_FAILED',502);
  if(Object.hasOwn(result,'response'))result=result.response;
  if(!object(result)||Object.hasOwn(result,'error')||typeof result.hash!=='string'||!result.hash||result.hash.length>4096||typeof result.photo!=='string'||!result.photo||result.photo.length>1024*1024)fail('UPLOAD_FAILED',502);
  guard(row);return {hash:result.hash,photo:result.photo,is_video_cover:0};
 }
 async function apply(code,body) {
  strictKeys(body,['revision','previewId','requestId']);if(!id(body.previewId)||!id(body.requestId))fail('INVALID_INPUT');
  const row=connection(code,body.revision);if(body.revision!==row.revision)fail('SETTINGS_CHANGED',409);
  const p=previewFor(row.companyCode,body.previewId);if(!p)fail('PREVIEW_NOT_FOUND',404);
  if(p.revision!==row.revision||p.group_id!==row.groupId)fail('SETTINGS_CHANGED',409);
  function previous(){
   const same=actionFor(row.companyCode,body.requestId);
   if(same&&same.preview_id!==p.preview_id)fail('REQUEST_CONFLICT',409);
   return same||db.prepare('SELECT * FROM vk_design_actions WHERE company_code=? AND preview_id=?').get(row.companyCode,p.preview_id);
  }
  const existing=previous();if(existing)return actionDto(existing);
  if(now()-Date.parse(p.created_at)>30*60*1000)fail('PREVIEW_EXPIRED',409);
  // The durable claim precedes every await and every external write. A crash leaves a non-retryable applying record.
  db.exec('BEGIN IMMEDIATE');
  try{
   guard(row);const same=previous();if(same){db.exec('COMMIT');return actionDto(same);}
   if(db.prepare("SELECT 1 FROM vk_design_actions WHERE group_id=? AND status='applying'").get(row.groupId))fail('OPERATION_BUSY',409);
   db.prepare(`INSERT INTO vk_design_actions(company_code,request_id,preview_id,group_id,revision,operation,status,created_at)
    VALUES(?,?,?,?,?,?,'applying',?)`).run(row.companyCode,body.requestId,p.preview_id,row.groupId,row.revision,p.operation,stamp());db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  let status='failed',errorCode=null,mutationStarted=false,accepted=false;
  try{
   const current=await readState(row);if(stateHash(current[p.operation])!==p.before_hash)fail('STATE_CHANGED',409);
   let expectedImages;
   if(p.operation==='description'){
    guard(row);mutationStarted=true;
    const response=await request(row,'groups.edit',{description:JSON.parse(p.after_json)});
    if(response!==1)fail('RESPONSE_INVALID',502);accepted=true;
   }else{
    const uploadParams=await upload(row,p);
    // Upload may take time; do not overwrite another manager's intervening change.
    const beforeSave=await readState(row);if(stateHash(beforeSave.cover)!==p.before_hash)fail('STATE_CHANGED',409);
    guard(row);mutationStarted=true;
    const response=await request(row,'photos.saveOwnerCoverPhoto',uploadParams);
    if(!object(response)||!Array.isArray(response.images)||!response.images.length)fail('RESPONSE_INVALID',502);
    expectedImages=images(response.images);accepted=true;
   }
   status='applied_unverified';const observed=await readState(row);
   const matches=p.operation==='description'?observed.description===JSON.parse(p.after_json):observed.cover?.enabled&&expectedImages.some(saved=>observed.cover.images.some(image=>image.url===saved.url));
   if(matches)status='verified';else errorCode='READBACK_MISMATCH';
  }catch(error){
   errorCode=knownCode(error);
   const definite=['ACCESS_DENIED','PLATFORM_REJECTED','SETTINGS_CHANGED','CONNECTION_MISSING'].includes(errorCode)&&error?.ambiguous!==true&&error?.uncertain!==true;
   status=accepted?'applied_unverified':mutationStarted&&!definite?'uncertain':'failed';
  }
  db.prepare('UPDATE vk_design_actions SET status=?,error_code=?,completed_at=? WHERE company_code=? AND request_id=?').run(status,errorCode,stamp(),row.companyCode,body.requestId);
  // Dispatch is terminal for this preview; retain hash/metadata but not redundant private source bytes.
  db.prepare('UPDATE vk_design_previews SET image_bytes=NULL WHERE company_code=? AND preview_id=?').run(row.companyCode,p.preview_id);
  return actionDto(actionFor(row.companyCode,body.requestId));
 }
 function history(code){const companyCode=company(code);return {companyCode,items:db.prepare('SELECT * FROM vk_design_actions WHERE company_code=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(companyCode).map(actionDto)};}
 async function rollbackPreview(code,body){
  strictKeys(body,['revision','requestId']);if(!id(body.requestId))fail('INVALID_INPUT');const row=connection(code,body.revision);if(body.revision!==row.revision)fail('SETTINGS_CHANGED',409);
  const action=actionFor(row.companyCode,body.requestId);
  if(!action||action.operation!=='description'||!['verified','applied_unverified'].includes(action.status)||action.group_id!==row.groupId)fail('ROLLBACK_UNAVAILABLE',409);
  const p=previewFor(row.companyCode,action.preview_id),current=await readState(row);
  if(current.description!==JSON.parse(p.after_json))fail('STATE_CHANGED',409);
  const before=JSON.parse(p.before_json);return savePreview(row,'description',current.description,before,digest(before),null,[]);
 }
 return {getState,preview,apply,history,rollbackPreview};
}

module.exports={createVkDesign,VK_DESIGN_ERRORS,validateImage,validateUploadUrl};
