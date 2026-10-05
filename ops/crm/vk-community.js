'use strict';

const crypto = require('node:crypto');
const {validateImage,validateUploadUrl}=require('./vk-design');
const REPLY_PREVIEW_TTL=30*60*1000,MAX_FILE_BYTES=8*1024*1024;
const VK_ERRORS = Object.freeze({
  CONNECTION_MISSING:'Сначала сохраните и проверьте подключение ВКонтакте',
  TOKEN_UNREADABLE:'Не удалось прочитать сохранённый ключ. Сохраните ключ заново',
  SETTINGS_CHANGED:'Подключение изменилось. Обновите страницу',
  ACCESS_DENIED:'ВКонтакте не предоставил доступ. Проверьте ключ сообщества и его права',
  PLATFORM_REJECTED:'ВКонтакте отклонил запрос',
  RESPONSE_INVALID:'ВКонтакте вернул неожиданный ответ. Действие не подтверждено',
  CONNECTION_UNCERTAIN:'Не удалось подтвердить результат запроса ВКонтакте',
  GROUP_MISMATCH:'Ответ ВКонтакте не соответствует выбранному сообществу',
  DIALOG_REQUIRED:'Сначала загрузите существующий диалог этой компании',
  REPLY_DENIED:'В этом диалоге ВКонтакте не разрешает ответ',
  REQUEST_CONFLICT:'Этот идентификатор отправки уже использован для другого сообщения',
  INVALID_INPUT:'Проверьте параметры сообщения',
  INVALID_FILE:'Выберите корректный JPEG, PNG или PDF до 8 МиБ',
  PREVIEW_NOT_FOUND:'Предпросмотр сообщения этой компании не найден',
  PREVIEW_EXPIRED:'Предпросмотр сообщения устарел. Подготовьте его заново',
  PREVIEW_LIMIT:'Достигнут лимит предпросмотров сообщений. Дождитесь истечения старых',
  UNSAFE_UPLOAD_URL:'Сервер загрузки ВКонтакте не входит в разрешённый список',
  UPLOAD_FAILED:'Не удалось подтвердить загрузку вложения ВКонтакте',
});
const fail = (message, status=400, code) => {throw Object.assign(new Error(message), {status,...(code?{code}:{})});};
const failure = (code, ambiguous=false) => Object.assign(new Error(VK_ERRORS[code] || VK_ERRORS.PLATFORM_REJECTED), {code,status:code==='SETTINGS_CHANGED'?409:502,ambiguous});
const object = value => value && typeof value==='object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value>=0;
const positive = value => integer(value) && value>0;
const plain = (value,max=300) => typeof value==='string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max) : '';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const requestId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{16,100}$/.test(value);
const strictKeys=(value,keys)=>{if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))fail(VK_ERRORS.INVALID_INPUT,400,'INVALID_INPUT');};

// INBOX_SCOPE: manual attachments never accept a caller-supplied VK reference or remote URL.
function validateReplyFile(file) {
  strictKeys(file,['base64','mime','name']);
  if(typeof file.name!=='string'||!file.name.trim()||file.name.length>180||/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(file.name))fail(VK_ERRORS.INVALID_FILE,400,'INVALID_FILE');
  let result;
  try {
    if(['image/jpeg','image/png'].includes(file.mime))result=validateImage({mime:file.mime,base64:file.base64});
    else {
      if(file.mime!=='application/pdf'||typeof file.base64!=='string'||!file.base64.length||file.base64.length%4!==0||file.base64.length>4*Math.ceil(MAX_FILE_BYTES/3)||/[^A-Za-z0-9+/=]/.test(file.base64))throw Error();
      const bytes=Buffer.from(file.base64,'base64');
      if(bytes.length>MAX_FILE_BYTES||bytes.toString('base64')!==file.base64||!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.subarray(0,10).toString('latin1'))||!/(?:\r|\n)%%EOF[\r\n\t ]*$/.test(bytes.subarray(-1024).toString('latin1')))throw Error();
      result={bytes,mime:file.mime,sourceHash:digest(bytes)};
    }
  } catch {fail(VK_ERRORS.INVALID_FILE,400,'INVALID_FILE');}
  // Normalize the upload extension so a double-extension executable name is never sent to VK.
  const extension=file.mime==='image/png'?'png':file.mime==='image/jpeg'?'jpg':'pdf';
  const name=(plain(file.name.trim(),160).replace(/\.[^.]*$/,'').replace(/[<>:"|?*]/g,'_')||'Вложение')+'.'+extension;
  return {...result,name,size:result.bytes.length};
}
function incomingUrl(value) {
  try {
    const url=new URL(validateUploadUrl(value));
    if([...url.searchParams.keys()].some(key=>/^(access_key|access_token|token|authorization)$/i.test(key)))return null;
    return url.href;
  } catch {return null;}
}
function incomingAttachments(value) {
  if(!Array.isArray(value))return [{type:'unavailable',name:'Вложение недоступно'}];
  return value.slice(0,100).map(item=>{
    if(item?.type==='photo'&&object(item.photo)&&Array.isArray(item.photo.sizes)) {
      const sizes=item.photo.sizes.slice(0,30).filter(size=>object(size)&&positive(size.width)&&positive(size.height)&&size.width<=16384&&size.height<=16384)
        .map(size=>({url:incomingUrl(size.url),width:size.width,height:size.height})).filter(size=>size.url).sort((a,b)=>b.width*b.height-a.width*a.height);
      if(sizes[0])return {type:'photo',name:'Фото',...sizes[0]};
    }
    if(item?.type==='doc'&&object(item.doc)) {
      const doc=item.doc,url=incomingUrl(doc.url),name=plain(doc.title,180)||'Документ';
      // PDF is the supported document format; other types keep a visible placeholder.
      if(url&&typeof doc.ext==='string'&&doc.ext.toLowerCase()==='pdf'&&integer(doc.size))return {type:'doc',name,url,size:doc.size,mime:'application/pdf'};
    }
    return {type:'unavailable',name:'Вложение недоступно'};
  });
}

function createVkCommunity(db,{apiKey,fetchImpl=fetch,now=Date.now,timeoutMs=15000}={}) {
  if (!apiKey) throw new Error('Ключ хранения настроек отсутствует');
  db.exec(`CREATE TABLE IF NOT EXISTS vk_community_connections (
    company_code TEXT PRIMARY KEY COLLATE NOCASE REFERENCES companies(code), group_id TEXT NOT NULL,
    encrypted_token TEXT NOT NULL, revision INTEGER NOT NULL, checked_revision INTEGER,
    status TEXT NOT NULL, checked_at TEXT, error_code TEXT, group_name TEXT, screen_name TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vk_community_dialogs (
    company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code), group_id TEXT NOT NULL,
    revision INTEGER NOT NULL, peer_id INTEGER NOT NULL, synced_at TEXT NOT NULL,
    PRIMARY KEY(company_code,peer_id)
  );
  CREATE TABLE IF NOT EXISTS vk_community_replies (
    company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code), request_id TEXT NOT NULL,
    revision INTEGER NOT NULL, group_id TEXT NOT NULL, peer_id INTEGER NOT NULL, text_hash TEXT NOT NULL,
    random_id INTEGER NOT NULL, status TEXT NOT NULL, message_id INTEGER, error_code TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY(company_code,request_id), UNIQUE(group_id,random_id)
  );
  CREATE TABLE IF NOT EXISTS vk_community_reply_previews (
    company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code),preview_id TEXT NOT NULL,
    group_id TEXT NOT NULL,revision INTEGER NOT NULL,peer_id INTEGER NOT NULL,text TEXT,file_json TEXT,file_bytes BLOB,
    content_hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(company_code,preview_id)
  );
  CREATE TABLE IF NOT EXISTS vk_community_reply_actions (
    company_code TEXT NOT NULL COLLATE NOCASE,preview_id TEXT NOT NULL,request_id TEXT NOT NULL,
    PRIMARY KEY(company_code,preview_id),UNIQUE(company_code,request_id),
    FOREIGN KEY(company_code,preview_id) REFERENCES vk_community_reply_previews(company_code,preview_id),
    FOREIGN KEY(company_code,request_id) REFERENCES vk_community_replies(company_code,request_id)
  )`);
  const stamp=()=>new Date(now()).toISOString();
  function company(code) {
    if (typeof code!=='string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail('Выберите компанию');
    const current=db.prepare('SELECT code FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if (!current) fail('Компания не найдена',404);
    return current.code;
  }
  const rowFor=code=>db.prepare('SELECT * FROM vk_community_connections WHERE company_code=?').get(code);
  function crypt(code,groupId,value,decrypt=false) {
    const aad=Buffer.from(`synapse/vk-community/v1/${code.toLowerCase()}/${groupId}`);
    const envelope=decrypt?JSON.parse(value):{v:1,salt:crypto.randomBytes(16).toString('base64'),iv:crypto.randomBytes(12).toString('base64')};
    if (envelope.v!==1) throw new Error('Invalid credential envelope');
    const key=Buffer.from(crypto.hkdfSync('sha256',Buffer.from(apiKey),Buffer.from(envelope.salt,'base64'),aad,32));
    try {
      const cipher=decrypt?crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64')):crypto.createCipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
      cipher.setAAD(aad);
      if (decrypt) {
        cipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
        return Buffer.concat([cipher.update(Buffer.from(envelope.data,'base64')),cipher.final()]).toString('utf8');
      }
      envelope.data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]).toString('base64');
      envelope.tag=cipher.getAuthTag().toString('base64');
      return JSON.stringify(envelope);
    } finally {key.fill(0);}
  }
  function tokenFor(row) {
    if (!row?.encrypted_token) throw failure('CONNECTION_MISSING');
    try {return crypt(row.company_code,row.group_id,row.encrypted_token,true);} catch {throw failure('TOKEN_UNREADABLE');}
  }
  function getSettings(code) {
    const companyCode=company(code),row=rowFor(companyCode);
    let tokenConfigured=false;
    if (row) try {tokenConfigured=Boolean(tokenFor(row));} catch {}
    const connected=Boolean(tokenConfigured && row.status==='connected' && row.checked_revision===row.revision);
    return {companyCode,groupId:row?.group_id || '',revision:row?.revision || 0,
      configured:Boolean(row),tokenConfigured,connected,status:row?.status || 'not_configured',
      checkedAt:row?.checked_at || null,errorCode:row?.error_code || null,
      group:row?.group_name?{id:row.group_id,name:row.group_name,screenName:row.screen_name || ''}:null,
      capabilities:{messages:connected,communityInfo:connected,statistics:false,ads:false,design:false}};
  }
  function saveSettings(code,body) {
    const companyCode=company(code);
    if (!object(body) || typeof body.groupId!=='string' || !/^[1-9]\d{0,14}$/.test(body.groupId) || !Number.isSafeInteger(Number(body.groupId))) fail('Укажите числовой ID сообщества ВКонтакте');
    if (body.communityToken!==undefined && (typeof body.communityToken!=='string' || body.communityToken.length>2048 || /[\s\u0000-\u001f\u007f]/.test(body.communityToken))) fail('Проверьте ключ доступа сообщества');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous=rowFor(companyCode);
      if (body.revision!==(previous?.revision || 0)) throw failure('SETTINGS_CHANGED');
      const token=body.communityToken || (previous?.group_id===body.groupId?tokenFor(previous):'');
      if (!token) fail('Введите ключ доступа этого сообщества');
      db.prepare(`INSERT INTO vk_community_connections(company_code,group_id,encrypted_token,revision,status,updated_at)
        VALUES(?,?,?,1,'needs_check',?) ON CONFLICT(company_code) DO UPDATE SET group_id=excluded.group_id,
        encrypted_token=excluded.encrypted_token,revision=vk_community_connections.revision+1,checked_revision=NULL,
        status='needs_check',checked_at=NULL,error_code=NULL,group_name=NULL,screen_name=NULL,updated_at=excluded.updated_at`)
        .run(companyCode,body.groupId,crypt(companyCode,body.groupId,token),stamp());
      db.prepare('DELETE FROM vk_community_dialogs WHERE company_code=?').run(companyCode);
      db.prepare('UPDATE vk_community_reply_previews SET file_bytes=NULL,text=NULL WHERE company_code=?').run(companyCode);
      db.exec('COMMIT');
    } catch (error) {db.exec('ROLLBACK');throw error;}
    return getSettings(companyCode);
  }
  function guard(row,requireConnected=false) {
    company(row.company_code);
    const latest=rowFor(row.company_code);
    if (!latest || latest.revision!==row.revision || latest.group_id!==row.group_id) throw failure('SETTINGS_CHANGED');
    if (requireConnected && (latest.status!=='connected' || latest.checked_revision!==latest.revision)) throw failure('CONNECTION_MISSING');
  }
  function connection(code,revision) {
    const row=rowFor(company(code));
    if (!row) throw failure('CONNECTION_MISSING');
    if (revision!==undefined && revision!==row.revision) throw failure('SETTINGS_CHANGED');
    guard(row,true);return row;
  }
  async function readResponse(response,signal) {
    const reader=response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const chunks=[];let size=0,abort;
    const aborted=new Promise((resolve,reject)=>{abort=()=>reject(new Error('Timeout'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
    try {
      while (true) {
        const {done,value}=await Promise.race([reader.read(),aborted]);
        if (done) break;
        size+=value.byteLength;if(size>2*1024*1024)throw new Error('Response too large');chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
    } finally {signal.removeEventListener('abort',abort);reader.cancel().catch(()=>{});}
  }
  async function call(row,method,params={},sending=false) {
    guard(row);
    const token=tokenFor(row),signal=AbortSignal.timeout(timeoutMs);
    let response,data;
    try {
      response=await fetchImpl(`https://api.vk.com/method/${method}`,{method:'POST',redirect:'error',signal,
        headers:{'content-type':'application/x-www-form-urlencoded',Authorization:`Bearer ${token}`},
        body:new URLSearchParams({...params,v:'5.199'}).toString()});
      data=await readResponse(response,signal);
    } catch {throw failure('CONNECTION_UNCERTAIN',sending);}
    // A gateway/server failure can hide an accepted write even when its body looks like a VK error.
    if (response.status>=500 || response.redirected) throw failure('CONNECTION_UNCERTAIN',sending);
    if (Object.hasOwn(data || {},'error')) {
      const providerCode=object(data.error)?data.error.error_code:null;
      // Internal/unknown/malformed VK errors do not prove a dispatched write was rejected.
      if(!Number.isSafeInteger(providerCode))throw failure('CONNECTION_UNCERTAIN',sending);
      if([5,7,15,27,28,200,203,901,902].includes(providerCode))throw failure('ACCESS_DENIED');
      if([6,100].includes(providerCode))throw failure('PLATFORM_REJECTED');
      throw failure('CONNECTION_UNCERTAIN',sending);
    }
    if (!response.ok) throw failure('CONNECTION_UNCERTAIN',sending);
    if (!object(data) || !Object.hasOwn(data,'response')) throw failure('RESPONSE_INVALID',sending);
    // Mutating calls record the outcome before checking revision; reads never expose stale data.
    if (!sending) guard(row);
    return data.response;
  }
  function page(value,max) {
    const offset=value.offset===undefined?0:value.offset,count=value.count===undefined?max:value.count;
    if (!integer(offset) || offset>100000 || !positive(count) || count>max) fail('Проверьте размер страницы');
    return {offset,count};
  }
  function collection(value,max) {
    if (!object(value) || !integer(value.count) || !Array.isArray(value.items) || value.items.length>max) throw failure('RESPONSE_INVALID');
    return value;
  }
  function message(value,peerId) {
    if (!object(value) || !integer(value.id) || value.peer_id!==peerId || !Number.isSafeInteger(value.from_id) || !integer(value.date) ||
        typeof value.text!=='string' || value.text.length>100000 || ![0,1].includes(value.out)) throw failure('RESPONSE_INVALID');
    return {id:value.id,peerId,fromId:value.from_id,text:value.text,date:value.date,out:value.out===1,
      ...(value.attachments===undefined?{}:{attachments:incomingAttachments(value.attachments)})};
  }
  async function checkConnection(code) {
    const companyCode=company(code),row=rowFor(companyCode);
    if (!row) throw failure('CONNECTION_MISSING');
    let group=null,errorCode=null;
    try {
      const permissions=await call(row,'groups.getTokenPermissions');
      if (!object(permissions) || !integer(permissions.mask) || !Array.isArray(permissions.permissions) || permissions.permissions.length>100 ||
          permissions.permissions.some(item=>!object(item) || typeof item.name!=='string' || !integer(item.setting))) throw failure('RESPONSE_INVALID');
      const result=await call(row,'groups.getById',{group_id:row.group_id});
      if (!object(result) || !Array.isArray(result.groups) || result.groups.length!==1 || String(result.groups[0]?.id)!==row.group_id) throw failure('GROUP_MISMATCH');
      const found=result.groups[0];
      if (!positive(found.id) || typeof found.name!=='string' || !found.name.trim()) throw failure('RESPONSE_INVALID');
      group={name:plain(found.name),screenName:/^[a-zA-Z0-9_.]{1,100}$/.test(found.screen_name || '')?found.screen_name:''};
      // getById is public metadata, NOT a token ownership test. Verify scoped messaging access separately.
      collection(await call(row,'messages.getConversations',{group_id:row.group_id,count:1,offset:0,filter:'all'}),1);
      guard(row);
    } catch (error) {errorCode=Object.hasOwn(VK_ERRORS,error.code)?error.code:'RESPONSE_INVALID';}
    const changed=db.prepare(`UPDATE vk_community_connections SET status=?,checked_revision=?,checked_at=?,error_code=?,group_name=?,screen_name=?
      WHERE company_code=? AND revision=?`).run(errorCode?'error':'connected',errorCode?null:row.revision,stamp(),errorCode,
        errorCode?null:group.name,errorCode?null:group.screenName,companyCode,row.revision).changes;
    return {...getSettings(companyCode),ok:Boolean(changed&&!errorCode),code:changed?errorCode:'SETTINGS_CHANGED'};
  }
  async function syncConversations(code,options={}) {
    const row=connection(code,options.revision),{offset,count}=page(options,100);
    const result=collection(await call(row,'messages.getConversations',{group_id:row.group_id,offset,count,filter:'all',extended:1}),count);
    const profiles=new Map((Array.isArray(result.profiles)?result.profiles:[]).filter(item=>positive(item?.id)).map(item=>[item.id,plain([plain(item.first_name,100),plain(item.last_name,100)].filter(Boolean).join(' '),200)]));
    const items=[];
    for (const item of result.items) {
      const conversation=item?.conversation,peer=conversation?.peer;
      // Pilot supports existing one-to-one customer conversations, not group chats or broadcasts.
      if (!object(peer) || !Number.isSafeInteger(peer.id) || typeof peer.type!=='string') throw failure('RESPONSE_INVALID');
      if (peer.type!=='user' || !positive(peer.id)) continue;
      const lastMessage=item.last_message?message(item.last_message,peer.id):null;
      items.push({peerId:peer.id,title:profiles.get(peer.id) || `Пользователь ${peer.id}`,
        unreadCount:integer(conversation.unread_count)?conversation.unread_count:0,canReply:conversation.can_write?.allowed===true,lastMessage});
    }
    guard(row,true);
    const save=db.prepare(`INSERT INTO vk_community_dialogs(company_code,group_id,revision,peer_id,synced_at) VALUES(?,?,?,?,?)
      ON CONFLICT(company_code,peer_id) DO UPDATE SET group_id=excluded.group_id,revision=excluded.revision,synced_at=excluded.synced_at`);
    for (const item of items) save.run(row.company_code,row.group_id,row.revision,item.peerId,stamp());
    return {companyCode:row.company_code,revision:row.revision,count:result.count,offset,items};
  }
  function knownDialog(row,peerId) {
    if (!positive(peerId)) fail('Выберите диалог');
    const dialog=db.prepare('SELECT 1 FROM vk_community_dialogs WHERE company_code=? AND group_id=? AND revision=? AND peer_id=?').get(row.company_code,row.group_id,row.revision,peerId);
    if (!dialog) throw failure('DIALOG_REQUIRED');
  }
  async function syncHistory(code,options={}) {
    const row=connection(code,options.revision);knownDialog(row,options.peerId);
    const {offset,count}=page(options,100);
    const result=collection(await call(row,'messages.getHistory',{group_id:row.group_id,peer_id:options.peerId,offset,count,rev:0}),count);
    const items=result.items.map(item=>message(item,options.peerId));guard(row,true);
    return {companyCode:row.company_code,revision:row.revision,peerId:options.peerId,count:result.count,offset,items};
  }
  const replyFor=(code,id)=>db.prepare('SELECT * FROM vk_community_replies WHERE company_code=? AND request_id=?').get(code,id);
  const replyDto=row=>({companyCode:row.company_code,revision:row.revision,peerId:row.peer_id,requestId:row.request_id,status:row.status,messageId:row.message_id || null,code:row.error_code || null});
  async function reply(code,body) {
    if (!object(body) || typeof body.text!=='string' || !body.text.trim() || body.text.length>9000 || typeof body.requestId!=='string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId)) fail('Введите сообщение и идентификатор отправки');
    const row=connection(code,body.revision);
    if (body.revision!==row.revision) throw failure('SETTINGS_CHANGED');
    knownDialog(row,body.peerId);
    const textHash=crypto.createHash('sha256').update(body.text).digest('hex');
    function previousResult() {
      const previous=replyFor(row.company_code,body.requestId);
      if (!previous) return null;
      if (previous.group_id!==row.group_id || previous.peer_id!==body.peerId || previous.text_hash!==textHash || previous.revision!==row.revision) throw failure('REQUEST_CONFLICT');
      return replyDto(previous);
    }
    const previous=previousResult();if(previous)return previous;
    const result=collection(await call(row,'messages.getConversationsById',{group_id:row.group_id,peer_ids:body.peerId}),1);
    const peer=result.items[0];
    if (result.items.length!==1 || peer?.peer?.id!==body.peerId || peer.peer.type!=='user') throw failure('DIALOG_REQUIRED');
    if (peer.can_write?.allowed!==true) throw failure('REPLY_DENIED');
    guard(row,true);
    // Serialize logical sends before the first external mutation. Even crash/timeout records must never auto-resend.
    let randomId;
    db.exec('BEGIN IMMEDIATE');
    try {
      guard(row,true);
      const existing=previousResult();
      if (existing) {db.exec('COMMIT');return existing;}
      do {randomId=crypto.randomInt(1,2147483647);} while(db.prepare('SELECT 1 FROM vk_community_replies WHERE group_id=? AND random_id=?').get(row.group_id,randomId));
      db.prepare(`INSERT INTO vk_community_replies(company_code,request_id,revision,group_id,peer_id,text_hash,random_id,status,created_at)
        VALUES(?,?,?,?,?,?,?,'sending',?)`).run(row.company_code,body.requestId,row.revision,row.group_id,body.peerId,textHash,randomId,stamp());
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    let messageId=null,errorCode=null,status='sent';
    try {
      guard(row,true);
      const sent=await call(row,'messages.send',{group_id:row.group_id,peer_id:body.peerId,message:body.text,random_id:randomId},true);
      if (!positive(sent)) throw failure('RESPONSE_INVALID',true);
      messageId=sent;
    } catch(error) {errorCode=Object.hasOwn(VK_ERRORS,error.code)?error.code:'CONNECTION_UNCERTAIN';status=error.ambiguous?'uncertain':'failed';}
    db.prepare('UPDATE vk_community_replies SET status=?,message_id=?,error_code=? WHERE company_code=? AND request_id=?').run(status,messageId,errorCode,row.company_code,body.requestId);
    guard(row,true);
    return replyDto(replyFor(row.company_code,body.requestId));
  }
  // INBOX_SCOPE: preview is local, then a durable claim authorizes exactly one explicit dispatch chain.
  const previewFor=(code,id)=>db.prepare('SELECT * FROM vk_community_reply_previews WHERE company_code=? AND preview_id=?').get(code,id);
  const replyActionFor=(code,id)=>db.prepare(`SELECT r.*,a.preview_id FROM vk_community_reply_actions a JOIN vk_community_replies r
    ON r.company_code=a.company_code AND r.request_id=a.request_id WHERE a.company_code=? AND a.preview_id=?`).get(code,id);
  const replyActionDto=row=>({...replyDto(row),groupId:row.group_id,previewId:row.preview_id});
  function purgeExpiredPreviews() {
    db.prepare('UPDATE vk_community_reply_previews SET file_bytes=NULL,text=NULL WHERE created_at<=? AND (file_bytes IS NOT NULL OR text IS NOT NULL)')
      .run(new Date(now()-REPLY_PREVIEW_TTL).toISOString());
  }
  function previewReply(code,body) {
    strictKeys(body,['revision','peerId','text','file']);
    const row=connection(code,body.revision);
    if(body.revision!==row.revision)throw failure('SETTINGS_CHANGED');
    knownDialog(row,body.peerId);
    const text=body.text===undefined?'':body.text;
    if(typeof text!=='string'||text.length>9000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)||(!text.trim()&&body.file===undefined))fail(VK_ERRORS.INVALID_INPUT,400,'INVALID_INPUT');
    const file=body.file===undefined?null:validateReplyFile(body.file);
    const meta=file?{name:file.name,mime:file.mime,size:file.size,sourceHash:file.sourceHash,...(file.width?{width:file.width,height:file.height}:{})}:null;
    const previewId=crypto.randomUUID(),createdAt=stamp(),expiresAt=new Date(now()+REPLY_PREVIEW_TTL).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      guard(row,true);purgeExpiredPreviews();
      const usage=db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(file_bytes)),0) AS bytes FROM vk_community_reply_previews p
        WHERE company_code=? AND created_at>? AND text IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM vk_community_reply_actions a WHERE a.company_code=p.company_code AND a.preview_id=p.preview_id)`)
        .get(row.company_code,new Date(now()-REPLY_PREVIEW_TTL).toISOString());
      if(usage.count>=20||usage.bytes+(file?.size||0)>128*1024*1024)fail(VK_ERRORS.PREVIEW_LIMIT,409,'PREVIEW_LIMIT');
      const contentHash=digest(JSON.stringify({peerId:body.peerId,text,file:meta}));
      db.prepare(`INSERT INTO vk_community_reply_previews(company_code,preview_id,group_id,revision,peer_id,text,file_json,file_bytes,content_hash,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(row.company_code,previewId,row.group_id,row.revision,body.peerId,text,meta?JSON.stringify(meta):null,file?.bytes||null,contentHash,createdAt);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;} finally {file?.bytes.fill(0);}
    return {companyCode:row.company_code,groupId:row.group_id,revision:row.revision,peerId:body.peerId,previewId,text,file:meta,createdAt,expiresAt};
  }
  async function writableDialog(row,peerId) {
    knownDialog(row,peerId);
    const result=collection(await call(row,'messages.getConversationsById',{group_id:row.group_id,peer_ids:peerId}),1),peer=result.items[0];
    if(result.items.length!==1||peer?.peer?.id!==peerId||peer.peer.type!=='user')throw failure('DIALOG_REQUIRED');
    if(peer.can_write?.allowed!==true)throw failure('REPLY_DENIED');
    guard(row,true);
  }
  async function uploadReplyFile(row,p) {
    const file=JSON.parse(p.file_json),isPhoto=file.mime!=='application/pdf';
    const destination=await call(row,isPhoto?'photos.getMessagesUploadServer':'docs.getMessagesUploadServer',
      {peer_id:p.peer_id,...(isPhoto?{}:{type:'doc'})});
    guard(row,true);
    let url;try {url=validateUploadUrl(destination?.upload_url);} catch {throw failure('UNSAFE_UPLOAD_URL');}
    const bytes=Buffer.from(p.file_bytes||[]);
    if(!bytes.length||digest(bytes)!==file.sourceHash){bytes.fill(0);throw failure('INVALID_FILE');}
    const body=new FormData();body.append(isPhoto?'photo':'file',new Blob([bytes],{type:file.mime}),file.name);bytes.fill(0);
    const controller=new AbortController(),signal=controller.signal;let upload,timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure('UPLOAD_FAILED',true));},timeoutMs);});
    try {
      guard(row,true);
      upload=await Promise.race([(async()=>{
        const response=await fetchImpl(url,{method:'POST',body,redirect:'error',signal});
        if(!response.ok||response.redirected)throw failure('UPLOAD_FAILED',true);
        return readResponse(response,signal);
      })(),timeout]);
    } catch {throw failure('UPLOAD_FAILED',true);} finally {clearTimeout(timer);}
    if(!object(upload)||Object.hasOwn(upload,'error'))throw failure('UPLOAD_FAILED',true);
    guard(row,true);
    let saved;
    if(isPhoto) {
      if(!integer(upload.server)||typeof upload.photo!=='string'||!upload.photo||upload.photo.length>1024*1024||
        typeof upload.hash!=='string'||!upload.hash||upload.hash.length>4096)throw failure('RESPONSE_INVALID',true);
      const photos=await call(row,'photos.saveMessagesPhoto',{server:upload.server,photo:upload.photo,hash:upload.hash},true);
      if(!Array.isArray(photos)||photos.length!==1)throw failure('RESPONSE_INVALID',true);
      saved=photos[0];
    } else {
      if(typeof upload.file!=='string'||!upload.file||upload.file.length>8192)throw failure('RESPONSE_INVALID',true);
      const result=await call(row,'docs.save',{file:upload.file,title:file.name},true);
      if(!object(result)||result.type!=='doc')throw failure('RESPONSE_INVALID',true);
      saved=result.doc;
    }
    if(!object(saved)||!Number.isSafeInteger(saved.owner_id)||saved.owner_id===0||!positive(saved.id)||
      (saved.access_key!==undefined&&(typeof saved.access_key!=='string'||! /^[a-zA-Z0-9_-]{1,512}$/.test(saved.access_key))))throw failure('RESPONSE_INVALID',true);
    guard(row,true);
    // IDs are trusted only from this binding's save response (owner_id is not assumed to be a group).
    // VK access keys are used only inside this one dispatch; they never enter DTOs or audit records.
    return `${isPhoto?'photo':'doc'}${saved.owner_id}_${saved.id}${saved.access_key?'_'+saved.access_key:''}`;
  }
  async function confirmReply(code,body) {
    strictKeys(body,['revision','previewId','requestId']);
    if(!requestId(body.previewId)||!requestId(body.requestId))fail(VK_ERRORS.INVALID_INPUT,400,'INVALID_INPUT');
    const row=connection(code,body.revision);
    if(body.revision!==row.revision)throw failure('SETTINGS_CHANGED');
    purgeExpiredPreviews();
    const p=previewFor(row.company_code,body.previewId);
    if(!p)fail(VK_ERRORS.PREVIEW_NOT_FOUND,404,'PREVIEW_NOT_FOUND');
    if(p.group_id!==row.group_id||p.revision!==row.revision)throw failure('SETTINGS_CHANGED');
    knownDialog(row,p.peer_id);
    function previous() {
      const existing=replyFor(row.company_code,body.requestId);
      const action=replyActionFor(row.company_code,p.preview_id);
      if(existing&&(!action||action.request_id!==existing.request_id))throw failure('REQUEST_CONFLICT');
      return action;
    }
    const before=previous();if(before)return replyActionDto(before);
    if(now()-Date.parse(p.created_at)>=REPLY_PREVIEW_TTL||p.text===null)fail(VK_ERRORS.PREVIEW_EXPIRED,409,'PREVIEW_EXPIRED');
    let randomId;
    db.exec('BEGIN IMMEDIATE');
    try {
      guard(row,true);const existing=previous();if(existing){db.exec('COMMIT');return replyActionDto(existing);}
      do {randomId=crypto.randomInt(1,2147483647);} while(db.prepare('SELECT 1 FROM vk_community_replies WHERE group_id=? AND random_id=?').get(row.group_id,randomId));
      db.prepare(`INSERT INTO vk_community_replies(company_code,request_id,revision,group_id,peer_id,text_hash,random_id,status,created_at)
        VALUES(?,?,?,?,?,?,?,'sending',?)`).run(row.company_code,body.requestId,row.revision,row.group_id,p.peer_id,p.content_hash,randomId,stamp());
      db.prepare('INSERT INTO vk_community_reply_actions(company_code,preview_id,request_id) VALUES(?,?,?)').run(row.company_code,p.preview_id,body.requestId);
      // Purge source bytes at the durable claim, so a process crash cannot leave a retriable file or retained source.
      db.prepare('UPDATE vk_community_reply_previews SET file_bytes=NULL,text=NULL WHERE company_code=? AND preview_id=?').run(row.company_code,p.preview_id);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');if(p.file_bytes)p.file_bytes.fill(0);throw error;}
    let messageId=null,errorCode=null,status='sent';
    try {
      await writableDialog(row,p.peer_id);
      const attachment=p.file_json?await uploadReplyFile(row,p):null;
      if(attachment)await writableDialog(row,p.peer_id);
      guard(row,true);
      const sent=await call(row,'messages.send',{group_id:row.group_id,peer_id:p.peer_id,message:p.text,random_id:randomId,...(attachment?{attachment}:{})},true);
      if(!positive(sent))throw failure('RESPONSE_INVALID',true);messageId=sent;
    } catch(error) {errorCode=Object.hasOwn(VK_ERRORS,error.code)?error.code:'CONNECTION_UNCERTAIN';status=error.ambiguous?'uncertain':'failed';}
    finally {if(p.file_bytes)p.file_bytes.fill(0);p.text=null;}
    db.prepare('UPDATE vk_community_replies SET status=?,message_id=?,error_code=? WHERE company_code=? AND request_id=?')
      .run(status,messageId,errorCode,row.company_code,body.requestId);
    guard(row,true);return replyActionDto(replyActionFor(row.company_code,p.preview_id));
  }
  purgeExpiredPreviews();
  return {getSettings,saveSettings,checkConnection,syncConversations,syncHistory,reply,previewReply,confirmReply};
}

module.exports={createVkCommunity,VK_ERRORS};
