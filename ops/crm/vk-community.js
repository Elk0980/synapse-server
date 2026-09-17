'use strict';

const crypto = require('node:crypto');
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
});
const fail = (message, status=400, code) => {throw Object.assign(new Error(message), {status,...(code?{code}:{})});};
const failure = (code, ambiguous=false) => Object.assign(new Error(VK_ERRORS[code] || VK_ERRORS.PLATFORM_REJECTED), {code,status:code==='SETTINGS_CHANGED'?409:502,ambiguous});
const object = value => value && typeof value==='object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value>=0;
const positive = value => integer(value) && value>0;
const plain = (value,max=300) => typeof value==='string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max) : '';

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
    if (object(data?.error) && Number.isInteger(data.error.error_code)) {
      throw failure([5,7,15,27,28,200,203,901,902].includes(data.error.error_code)?'ACCESS_DENIED':'PLATFORM_REJECTED');
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
    return {id:value.id,peerId,fromId:value.from_id,text:value.text,date:value.date,out:value.out===1};
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
  return {getSettings,saveSettings,checkConnection,syncConversations,syncHistory,reply};
}

module.exports={createVkCommunity,VK_ERRORS};
