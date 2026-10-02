'use strict';

/* Тихий приём новых исходников. Нет зависимости от чата, outbox, задач или моделей.
   Конфигурация локальная, по умолчанию выключена. Снятая привязка остаётся зарезервированной,
   чтобы исходный чат после перезапуска не попадал в legacy-обработчик команд. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {readSourceMultipart}=require('./telegram-sources-multipart');
const { COMPANIES } = require('./auth-store');
const MAX_FILE = 20 * 1024 * 1024;
const MAX_MANUAL_FILE = 256 * 1024 * 1024;
const DEFAULT_STORAGE = 512 * 1024 * 1024;
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'application/pdf']);
const EXTENSIONS=Object.freeze({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.pdf':'application/pdf'});
// Content-контейнер не содержит CRM. Соответствие действительным словарям CRM проверяет upload.test.
const SOURCE_PLATFORMS=Object.freeze({instagram:'Instagram / Reels',tiktok:'TikTok',youtube_shorts:'YouTube Shorts',vk:'ВКонтакте',telegram:'Telegram',max:'MAX',two_gis:'2ГИС'});
const SOURCE_FORMATS=Object.freeze({post:'Пост',story:'Сторис',reel:'Reels / Shorts / клип',carousel:'Карусель'});
const EMPTY_METADATA=Object.freeze({platforms:[],formats:[],occasion:'',eventDate:'',usageRestrictions:'',materialState:'source'});
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const text = (value, max = 200) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max);
const chatId = value => { const id = String(value ?? ''); if (!/^-\d{1,20}$/.test(id)) fail(400, 'Некорректный источник'); return id; };
const messageId = value => { const id = String(value ?? ''); if (!/^[1-9]\d{0,19}$/.test(id)) fail(400, 'Некорректный номер сообщения'); return id; };
const company = value => { if (!Object.hasOwn(COMPANIES, value)) fail(400, 'Неизвестная компания'); return value; };
const telegramUrl = (chat, message) => /^-100\d+$/.test(chat) && /^[1-9]\d*$/.test(message) ? `https://t.me/c/${chat.slice(4)}/${message}` : null;
function normalizeMetadata(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(EMPTY_METADATA,key)))fail(400,'Некорректные сведения об исходнике');
  const out={};
  for(const [key,item]of Object.entries(value)){
    if(key==='platforms'||key==='formats'){
      const dictionary=key==='platforms'?SOURCE_PLATFORMS:SOURCE_FORMATS;
      if(!Array.isArray(item)||item.some(id=>typeof id!=='string'||!Object.hasOwn(dictionary,id))||new Set(item).size!==item.length)fail(400,'Выберите уникальные площадки и форматы из списка');
      out[key]=Object.keys(dictionary).filter(id=>item.includes(id));
    }else{
      if(typeof item!=='string'||item.length>(key==='usageRestrictions'?2000:key==='occasion'?500:key==='eventDate'?10:20))fail(400,'Некорректное текстовое поле исходника');
      const cleaned=item.trim();
      if(key==='materialState'&&!['source','ready'].includes(cleaned))fail(400,'Состояние материала: source или ready');
      if(key==='eventDate'&&cleaned){
        const time=Date.parse(cleaned+'T00:00:00Z');
        if(!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)||!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==cleaned)fail(400,'Укажите существующую дату события ГГГГ-ММ-ДД');
      }
      out[key]=text(cleaned,key==='usageRestrictions'?2000:500);
    }
  }return out;
}

function readSourceConfig(file) {
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config || !Array.isArray(config.sources)) throw new Error('sources');
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return {enabled: false, sources: []};
    // Не раскрываем путь/содержимое конфигурации в ошибках.
    return {enabled: false, sources: [], invalid: true};
  }
}
function validBytes(mime, bytes) {
  if (mime === 'image/jpeg') return bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'video/mp4' || mime === 'video/quicktime') return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  if (mime === 'application/pdf') return bytes.toString('ascii', 0, 5) === '%PDF-';
  return false;
}

function createTelegramSources({db, assetsDir, config = {enabled: false, sources: []}, authStore, requireSession, requireCsrf, sendJson}) {
  const storage = path.resolve(assetsDir, 'telegram-sources');
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_source_chats (
    chat_id TEXT PRIMARY KEY, company_code TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS telegram_source_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL, media_group_id TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '',
      file_id TEXT NOT NULL DEFAULT '', file_unique_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL DEFAULT '', declared_size INTEGER, size INTEGER, sha256 TEXT, disk_name TEXT,
      status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      UNIQUE(chat_id,message_id));
    CREATE INDEX IF NOT EXISTS telegram_source_items_company ON telegram_source_items(company_code,id);`);
  const columns = db.prepare('PRAGMA table_info(telegram_source_items)').all().map(row=>row.name);
  for (const [name,type] of [['import_method',"TEXT NOT NULL DEFAULT 'telegram'"],['imported_by','INTEGER'],['imported_at','TEXT'],['origin_note',"TEXT NOT NULL DEFAULT ''"],['revision','INTEGER NOT NULL DEFAULT 1'],['metadata',`TEXT NOT NULL DEFAULT '${JSON.stringify(EMPTY_METADATA)}'`]]) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE telegram_source_items ADD COLUMN ${name} ${type}`);
  }
  let manualBusy = false;
  let healthy = !config.invalid;
  const maxStorage = Number.isSafeInteger(config.maxStorageBytes) && config.maxStorageBytes >= 0 ? Math.min(config.maxStorageBytes, 4 * 1024 ** 3) : DEFAULT_STORAGE;
  const limits=code=>{
    const override=config.companyLimits?.[code]||{};
    const storage=Number.isSafeInteger(override.maxStorageBytes)&&override.maxStorageBytes>=0?Math.min(override.maxStorageBytes,4*1024**3):maxStorage;
    const manual=override.maxManualFileBytes??config.maxManualFileBytes;
    return {storage,manual:Math.min(storage,Number.isSafeInteger(manual)&&manual>0?manual:MAX_MANUAL_FILE)};
  };
  try {
    if (!Array.isArray(config.sources) || config.sources.length > 32) throw new Error('sources');
    const configured = config.sources.map(source => ({chat: chatId(source.chatId), code: company(source.companyCode), enabled: config.enabled === true && source.enabled === true}));
    if (new Set(configured.map(row => row.chat)).size !== configured.length) throw new Error('duplicates');
    for (const source of configured) {
      const old = db.prepare('SELECT company_code FROM telegram_source_chats WHERE chat_id=?').get(source.chat);
      if (old && old.company_code !== source.code) throw new Error('reassignment');
      const rooms = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_chat_rooms'").get();
      if (rooms && db.prepare('SELECT 1 FROM project_chat_rooms WHERE telegram_chat_id=?').get(source.chat)) throw new Error('room collision');
    }
    db.exec('BEGIN IMMEDIATE');
    db.exec('UPDATE telegram_source_chats SET enabled=0');
    for (const source of configured) db.prepare(`INSERT INTO telegram_source_chats(chat_id,company_code,enabled) VALUES(?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET enabled=excluded.enabled`).run(source.chat, source.code, source.enabled ? 1 : 0);
    db.exec('COMMIT');
  } catch { if (db.isTransaction) db.exec('ROLLBACK'); healthy = false; db.exec('UPDATE telegram_source_chats SET enabled=0'); }
  function binding(value) {
    const row = db.prepare('SELECT * FROM telegram_source_chats WHERE chat_id=?').get(String(value));
    const rooms = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_chat_rooms'").get();
    const room = rooms && db.prepare('SELECT 1 FROM project_chat_rooms WHERE telegram_chat_id=?').get(String(value));
    if (!healthy && !row && !room) fail(503, 'Настройки источников требуют проверки');
    // Настройки рабочей комнаты могли поменять уже после старта: источник остаётся тихим.
    return row ? {companyCode: row.company_code, enabled: healthy && row.enabled === 1 && !room} : null;
  }
  function migrate(oldValue, newValue) {
    const oldChat = chatId(oldValue), newChat = chatId(newValue);
    if (oldChat === newChat) fail(400, 'Источник не изменился');
    const source = db.prepare('SELECT * FROM telegram_source_chats WHERE chat_id=?').get(oldChat);
    if (!source) fail(404, 'Источник не настроен');
    const existing = db.prepare('SELECT * FROM telegram_source_chats WHERE chat_id=?').get(newChat);
    if (existing && existing.company_code !== source.company_code) fail(409, 'Источник уже закреплён за другой компанией');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Перенос в супергруппу резервирует новый id, но не включает его без проверки конфигурации.
      db.prepare('INSERT OR IGNORE INTO telegram_source_chats(chat_id,company_code,enabled) VALUES(?,?,0)').run(newChat,source.company_code);
      db.prepare('UPDATE telegram_source_chats SET enabled=0 WHERE chat_id=?').run(oldChat);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    return {source:binding(newChat)};
  }
  const json = row => row && ({id: row.id, companyCode: row.company_code, name: row.name, mime: row.mime,
    caption: row.caption, mediaGroupId: row.media_group_id, size: row.size ?? row.declared_size,
    status: row.status, reason: row.reason, createdAt: row.created_at, importMethod:row.import_method, importedAt:row.imported_at,
    sha256:row.sha256, provenance:row.origin_note,revision:row.revision,metadata:JSON.parse(row.metadata),
    telegramUrl: telegramUrl(row.chat_id, row.message_id),
    fileUrl: row.status === 'stored' ? `/content/telegram-sources/${row.company_code}/${row.id}/file` : null});
  function receipt(chat, message) {
    return json(db.prepare('SELECT * FROM telegram_source_items WHERE chat_id=? AND message_id=?').get(chatId(chat), messageId(message)));
  }
  function receive(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail(400, 'Некорректный исходник');
    const chat = chatId(event.chatId), message = messageId(event.messageId), source = binding(chat);
    if (!source) fail(404, 'Источник не настроен');
    if (!source.enabled) fail(409, 'Приём источника выключен');
    const old = receipt(chat, message); if (old) return {item: old, duplicate: true};
    const file = event.file || null, caption = text(event.text, 12000), mediaGroup = text(event.mediaGroupId, 64);
    if (!file && !caption.trim()) fail(400, 'Пустой исходник');
    const name = text(file?.name || '', 180).replace(/[\\/\r\n]/g, '_');
    const mime = text(file?.mime || '', 80).toLowerCase();
    const declaredSize = Number.isSafeInteger(file?.size) && file.size >= 0 ? file.size : null;
    let status = file ? 'manual_import' : 'text', reason = file ? text(event.reason || 'Нужен ручной импорт', 300) : '', bytes = null, sha = null, disk = null;
    if (file && event.status === 'stored') {
      if (typeof event.base64 !== 'string' || event.base64.length > Math.ceil(MAX_FILE / 3) * 4) fail(413, 'Файл больше 20 МБ');
      bytes = Buffer.from(event.base64, 'base64');
      if (!bytes.length || bytes.length > MAX_FILE || declaredSize > MAX_FILE) { reason = 'Файл больше лимита облачного Telegram; нужен ручной импорт'; bytes = null; }
      else if (!MIME.has(mime) || !validBytes(mime, bytes)) { reason = 'Формат файла не распознан; нужен ручной импорт'; bytes = null; }
      else {
        sha = crypto.createHash('sha256').update(bytes).digest('hex'); disk = sha;
        const used = db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM (SELECT disk_name,MAX(size) AS size FROM telegram_source_items WHERE company_code=? AND disk_name IS NOT NULL GROUP BY disk_name)').get(source.companyCode).n;
        const exists = db.prepare('SELECT 1 FROM telegram_source_items WHERE company_code=? AND disk_name=?').get(source.companyCode, disk);
        if (!exists && used + bytes.length > limits(source.companyCode).storage) { reason = 'Хранилище заполнено; нужен ручной импорт'; bytes = null; sha = null; disk = null; }
        else { status = 'stored'; reason = ''; }
      }
    }
    let createdFile = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (bytes) {
        const dir = path.join(storage, source.companyCode); fs.mkdirSync(dir, {recursive: true, mode: 0o700});
        const destination = path.join(dir, disk);
        if (!fs.existsSync(destination)) { fs.writeFileSync(destination, bytes, {flag: 'wx', mode: 0o600}); createdFile = destination; }
      }
      const result = db.prepare(`INSERT INTO telegram_source_items
        (company_code,chat_id,message_id,media_group_id,caption,file_id,file_unique_id,name,mime,declared_size,size,sha256,disk_name,status,reason,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(source.companyCode,chat,message,mediaGroup,caption,text(file?.fileId,250),text(file?.fileUniqueId,250),name,mime,
          declaredSize,bytes?.length ?? null,sha,disk,status,reason,new Date().toISOString());
      db.exec('COMMIT');
      return {item: json(db.prepare('SELECT * FROM telegram_source_items WHERE id=?').get(result.lastInsertRowid)), duplicate: false};
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); if (createdFile) fs.rmSync(createdFile, {force: true}); throw error; }
  }
  function access(request, code) {
    company(code);
    const session = requireSession(request), user = authStore.getById(session.user.id);
    if (!user || user.sessionVersion !== session.user.sessionVersion) fail(401, 'Требуется вход в кабинет');
    if (user.role !== 'owner' && (!user.companyCodes.includes(code) || !user.permissions.includes('autoposting.view'))) fail(403, 'Нет доступа к исходникам компании');
    return {session,user};
  }
  const canUpload=user=>user.role==='owner'||user.permissions?.includes('autoposting.edit');
  function writeAccess(request,code){const current=access(request,code);if(!canUpload(current.user))fail(403,'Нет права изменения исходников');requireCsrf(request,current.session);return current;}
  function manualSourceChat(code, chat) {
    if (!healthy) fail(503, 'Настройки источников требуют проверки');
    const source=binding(chatId(chat));
    if (!source || source.companyCode!==code) fail(403,'Сообщение не из источника выбранной компании');
    const rooms=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_chat_rooms'").get();
    if (rooms && db.prepare('SELECT 1 FROM project_chat_rooms WHERE telegram_chat_id=?').get(chat)) fail(409,'Источник совпадает с рабочей комнатой; проверьте настройки');
    return chat;
  }
  function manualOrigin(code, fields, sha) {
    const origin=fields.telegramUrl;
    if (!origin) {
      if (!fields.sourceChatId || !fields.provenance?.trim() || fields.provenance.length>1000) fail(400,'Укажите источник и происхождение старого файла');
      return {chat:manualSourceChat(code,fields.sourceChatId),message:'archive:'+sha,method:'manual_archive',provenance:text(fields.provenance,1000)};
    }
    if (fields.sourceChatId || fields.provenance || origin.length>200) fail(400,'Выберите один способ указать происхождение');
    let url; try {url=new URL(origin);} catch {fail(400,'Укажите ссылку на исходное сообщение Telegram');}
    const match=/^\/c\/([1-9]\d{0,16})\/([1-9]\d{0,19})$/.exec(url.pathname);
    if (url.protocol!=='https:' || url.hostname!=='t.me' || url.port || url.username || url.password || url.hash || (url.search && url.search!=='?single') || !match) fail(400,'Нужна ссылка вида https://t.me/c/…/…');
    return {chat:manualSourceChat(code,'-100'+match[1]),message:match[2],method:'manual',provenance:''};
  }
  function saveManual(code, fields, file, name, mime, authorId) {
    const sha=file.sha256,{chat,message,method,provenance}=manualOrigin(code,fields,sha),caption=text(fields.caption,12000);
    let createdFile=null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const old=db.prepare('SELECT * FROM telegram_source_items WHERE chat_id=? AND message_id=?').get(chat,message);
      if (old?.status==='stored') {
        if (old.sha256!==sha) fail(409,'Для этого сообщения уже сохранён другой файл');
        db.exec('COMMIT'); return {item:json(old),duplicate:true};
      }
      if (old?.declared_size > 0 && old.declared_size!==file.size) fail(409,'Размер файла отличается от исходного сообщения Telegram');
      const used=db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM (SELECT disk_name,MAX(size) AS size FROM telegram_source_items WHERE company_code=? AND disk_name IS NOT NULL GROUP BY disk_name)').get(code).n;
      const exists=db.prepare('SELECT 1 FROM telegram_source_items WHERE company_code=? AND disk_name=?').get(code,sha);
      if (!exists && used+file.size>limits(code).storage) fail(413,'Хранилище компании заполнено; файл не сохранён');
      const dir=path.join(storage,code), destination=path.join(dir,sha);
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      if (!fs.existsSync(destination)) {fs.renameSync(file.path,destination);createdFile=destination;}
      const now=new Date().toISOString();let id=old?.id;
      if (old) db.prepare(`UPDATE telegram_source_items SET name=?,mime=?,caption=?,size=?,sha256=?,disk_name=?,status='stored',reason='',import_method=?,imported_by=?,imported_at=?,origin_note=?,revision=revision+1 WHERE id=?`)
        .run(old.name||name,mime,old.caption||caption,file.size,sha,sha,method,authorId,now,provenance,id);
      else id=db.prepare(`INSERT INTO telegram_source_items(company_code,chat_id,message_id,caption,name,mime,declared_size,size,sha256,disk_name,status,created_at,import_method,imported_by,imported_at,origin_note)
        VALUES(?,?,?,?,?,?,?,?,?,?,'stored',?,?,?,?,?)`).run(code,chat,message,caption,name,mime,file.size,file.size,sha,sha,now,method,authorId,now,provenance).lastInsertRowid;
      db.exec('COMMIT');return {item:json(db.prepare('SELECT * FROM telegram_source_items WHERE id=?').get(id)),duplicate:false};
    } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');if(createdFile)fs.rmSync(createdFile,{force:true});throw error;}
  }
  async function manualUpload(request,response,code,initial) {
    if (initial.user.role!=='owner') fail(403,'Ручной импорт доступен владельцу');
    requireCsrf(request,initial.session);
    if (manualBusy) fail(429,'Другая загрузка ещё выполняется. Повторите позже');
    manualBusy=true;let parsed;
    try {
      parsed=await readSourceMultipart(request,{storage,maxFile:limits(code).manual});
      const {file,fields}=parsed;
      if ((fields.caption||'').length>12000) fail(400,'Подпись слишком длинная');
      const name=text(file.name,180).replace(/[\\/\r\n]/g,'_').toWellFormed();
      if (!name.trim()) fail(400,'У файла нет имени');
      const mime=(!file.mime || file.mime==='application/octet-stream') ? EXTENSIONS[path.extname(name).toLowerCase()] : file.mime.toLowerCase();
      if (!MIME.has(mime) || !validBytes(mime,file.head)) fail(415,'Формат или содержимое файла не поддерживается');
      // Чтение большого multipart асинхронно: повторяем актуальную авторизацию прямо перед записью.
      const fresh=access(request,code);requireCsrf(request,fresh.session);
      if (fresh.user.role!=='owner' || fresh.user.id!==initial.user.id) fail(403,'Доступ изменился во время загрузки');
      const result=saveManual(code,fields,file,name,mime,fresh.user.id);
      sendJson(response,result.duplicate?200:201,result,{'cache-control':'no-store'});return true;
    } finally {try{await parsed?.cleanup();}finally{manualBusy=false;}}
  }
  function saveUpload(code,fields,file,name,mime,metadata,authorId){
    let createdFile=null;db.exec('BEGIN IMMEDIATE');
    try{
      const old=db.prepare("SELECT * FROM telegram_source_items WHERE company_code=? AND sha256=? AND status='stored' ORDER BY id LIMIT 1").get(code,file.sha256);
      if(old){db.exec('COMMIT');return {item:json(old),duplicate:true};}
      const used=db.prepare('SELECT COALESCE(SUM(size),0) n FROM (SELECT disk_name,MAX(size) size FROM telegram_source_items WHERE company_code=? AND disk_name IS NOT NULL GROUP BY disk_name)').get(code).n;
      const exists=db.prepare('SELECT 1 FROM telegram_source_items WHERE company_code=? AND disk_name=?').get(code,file.sha256);
      if(!exists&&used+file.size>limits(code).storage)fail(413,'Хранилище компании заполнено; файл не сохранён');
      const dir=path.join(storage,code),destination=path.join(dir,file.sha256);fs.mkdirSync(dir,{recursive:true,mode:0o700});
      if(!fs.existsSync(destination)){fs.renameSync(file.path,destination);createdFile=destination;}
      const now=new Date().toISOString();
      const id=db.prepare(`INSERT INTO telegram_source_items(company_code,chat_id,message_id,caption,name,mime,declared_size,size,sha256,disk_name,status,created_at,import_method,imported_by,imported_at,metadata)
        VALUES(?,?,?,?,?,?,?,?,?,?,'stored',?,'upload',?,?,?)`).run(code,'upload:'+code,file.sha256,text(fields.caption,12000),name,mime,file.size,file.size,file.sha256,file.sha256,now,authorId,now,JSON.stringify(metadata)).lastInsertRowid;
      db.exec('COMMIT');return {item:json(db.prepare('SELECT * FROM telegram_source_items WHERE id=?').get(id)),duplicate:false};
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');if(createdFile)fs.rmSync(createdFile,{force:true});throw error;}
  }
  async function upload(request,response,code){
    const initial=writeAccess(request,code);if(manualBusy)fail(429,'Другая загрузка ещё выполняется. Повторите позже');
    manualBusy=true;let parsed;
    try{
      parsed=await readSourceMultipart(request,{storage,maxFile:limits(code).manual,upload:true});
      const {file,fields}=parsed;
      if((fields.caption||'').length>12000)fail(400,'Подпись слишком длинная');
      let input={};if(fields.metadata!==undefined){try{input=JSON.parse(fields.metadata);}catch{fail(400,'Сведения об исходнике должны быть JSON');}}
      const metadata={...EMPTY_METADATA,...normalizeMetadata(input)};
      const name=text(file.name,180).replace(/[\\/\r\n]/g,'_').toWellFormed();if(!name.trim())fail(400,'У файла нет имени');
      const mime=(!file.mime||file.mime==='application/octet-stream')?EXTENSIONS[path.extname(name).toLowerCase()]:file.mime.toLowerCase();
      if(!MIME.has(mime)||!validBytes(mime,file.head))fail(415,'Формат или содержимое файла не поддерживается');
      const fresh=writeAccess(request,code);if(fresh.user.id!==initial.user.id)fail(403,'Доступ изменился во время загрузки');
      const result=saveUpload(code,fields,file,name,mime,metadata,fresh.user.id);
      sendJson(response,result.duplicate?200:201,result,{'cache-control':'no-store'});return true;
    }finally{try{await parsed?.cleanup();}finally{manualBusy=false;}}
  }
  async function patchMetadata(request,response,code,id){
    const initial=writeAccess(request,code);
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type']||''))fail(415,'Ожидался JSON');
    const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>32768)fail(413,'Сведения об исходнике слишком длинные');chunks.push(Buffer.from(chunk));}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'Ожидался JSON');}
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['revision','metadata','caption'].includes(key))||!Number.isSafeInteger(body.revision)||body.revision<1)fail(400,'Нужна версия исходника и сведения для изменения');
    const patch=normalizeMetadata(body.metadata);
    if(body.caption!==undefined&&(typeof body.caption!=='string'||body.caption.length>12000))fail(400,'Некорректная подпись');
    const fresh=writeAccess(request,code);if(fresh.user.id!==initial.user.id)fail(403,'Доступ изменился во время сохранения');
    db.exec('BEGIN IMMEDIATE');
    try{
      const row=db.prepare('SELECT * FROM telegram_source_items WHERE id=? AND company_code=?').get(id,code);if(!row)fail(404,'Исходник не найден');
      if(row.revision!==body.revision)fail(409,'Исходник уже изменён. Обновите страницу');
      const metadata={...JSON.parse(row.metadata),...patch},caption=body.caption===undefined?row.caption:text(body.caption,12000);
      if(JSON.stringify(metadata)!==row.metadata||caption!==row.caption)db.prepare('UPDATE telegram_source_items SET metadata=?,caption=?,revision=revision+1 WHERE id=? AND company_code=?').run(JSON.stringify(metadata),caption,id,code);
      const item=json(db.prepare('SELECT * FROM telegram_source_items WHERE id=? AND company_code=?').get(id,code));
      db.exec('COMMIT');sendJson(response,200,{item},{'cache-control':'no-store'});return true;
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/content/telegram-sources/')) return false;
    const ordinary=/^\/content\/telegram-sources\/([a-z0-9_-]+)\/upload$/.exec(url.pathname);
    if(ordinary){if(request.method!=='POST')fail(405,'Метод не поддерживается');return upload(request,response,ordinary[1]);}
    const metadata=/^\/content\/telegram-sources\/([a-z0-9_-]+)\/(\d+)\/metadata$/.exec(url.pathname);
    if(metadata){if(request.method!=='PATCH')fail(405,'Метод не поддерживается');return patchMetadata(request,response,metadata[1],Number(metadata[2]));}
    const manual=/^\/content\/telegram-sources\/([a-z0-9_-]+)\/manual-upload$/.exec(url.pathname);
    if(manual) {
      if(request.method!=='POST')fail(405,'Метод не поддерживается');
      return manualUpload(request,response,manual[1],access(request,manual[1]));
    }
    if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'Метод не поддерживается');
    const match = /^\/content\/telegram-sources\/([a-z0-9_-]+)(?:\/(\d+)\/file)?$/.exec(url.pathname);
    if (!match) fail(404, 'Исходник не найден');
    const code = match[1], current=access(request, code);
    if (!match[2]) {
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      const rows = db.prepare('SELECT * FROM telegram_source_items WHERE company_code=? AND id<? ORDER BY id DESC LIMIT 51').all(code,before);
      sendJson(response, 200, {items: rows.slice(0,50).map(json), nextBefore: rows.length > 50 ? rows[49].id : null,
        uploadAllowed:canUpload(current.user),limits:{maxFileBytes:limits(code).manual,storageLimitBytes:limits(code).storage,mimeTypes:[...MIME],extensions:Object.keys(EXTENSIONS),maxFiles:1},
        metadataVocabulary:{platforms:Object.entries(SOURCE_PLATFORMS).map(([id,label])=>({id,label})),formats:Object.entries(SOURCE_FORMATS).map(([id,label])=>({id,label}))},
        manualUploadAllowed:healthy && current.user.role==='owner' && Boolean(db.prepare('SELECT 1 FROM telegram_source_chats WHERE company_code=?').get(code)),
        ...(current.user.role==='owner'?{manualMaxBytes:limits(code).manual,storageLimitBytes:limits(code).storage,sources:db.prepare('SELECT chat_id FROM telegram_source_chats WHERE company_code=? ORDER BY chat_id').all(code).map(row=>({chatId:row.chat_id}))}:{}),
        enabled: healthy && db.prepare('SELECT chat_id FROM telegram_source_chats WHERE company_code=? AND enabled=1').all(code).some(row=>binding(row.chat_id).enabled)}, {'cache-control':'no-store'});
      return true;
    }
    const row = db.prepare('SELECT * FROM telegram_source_items WHERE id=? AND company_code=?').get(Number(match[2]),code);
    if (!row || row.status !== 'stored' || !/^[a-f0-9]{64}$/.test(row.disk_name)) fail(404, 'Файл не сохранён');
    const file = path.join(storage,code,row.disk_name);
    if (!fs.existsSync(file)) fail(404, 'Файл недоступен');
    response.writeHead(200, {'content-type':row.mime,'content-length':row.size,'cache-control':'private, no-store',
      'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",
      'content-disposition':`attachment; filename="source-${row.id}"; filename*=UTF-8''${encodeURIComponent(row.name || `source-${row.id}`)}`});
    if(request.method==='HEAD')response.end();
    else {try{await pipeline(fs.createReadStream(file),response);}catch{response.destroy();}}
    return true;
  }
  return {binding,receipt,receive,migrate,handle,healthy};
}
module.exports = {createTelegramSources,readSourceConfig,MAX_FILE,MAX_MANUAL_FILE,DEFAULT_STORAGE};
