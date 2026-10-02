'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Readable,Writable}=require('node:stream'),{DatabaseSync}=require('node:sqlite');
const {createTelegramSources}=require('./telegram-sources');
const {CAPTION_PLATFORMS,FORMATS}=require('../crm/autoposting');
const BOUNDARY='ordinary-source-test',HEAD=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypqt  '),Buffer.alloc(20)]);
const EMPTY={platforms:[],formats:[],occasion:'',eventDate:'',usageRestrictions:'',materialState:'source'};
function multipart({fields={},size=128,marker=0,mime='video/quicktime',name='clip.MOV',head=HEAD,incomplete=false,onEnd,second=false}={}){
  return Readable.from((async function*(){
    for(const [key,value]of Object.entries(fields))yield Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
    yield Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`);
    yield head.subarray(0,Math.min(size,head.length));if(size>head.length)yield Buffer.alloc(size-head.length,marker);
    if(onEnd)await onEnd();if(incomplete)return;
    if(second)yield Buffer.from(`\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="second.MOV"\r\n\r\nsecond`);
    yield Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  })());
}
function setup(t,{config={enabled:false,sources:[]},legacy=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-upload-')),dbFile=path.join(dir,'db.sqlite');let db=new DatabaseSync(dbFile);
  if(legacy)db.exec(`CREATE TABLE telegram_source_items(id INTEGER PRIMARY KEY AUTOINCREMENT,company_code TEXT NOT NULL,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,
    media_group_id TEXT NOT NULL DEFAULT '',caption TEXT NOT NULL DEFAULT '',file_id TEXT NOT NULL DEFAULT '',file_unique_id TEXT NOT NULL DEFAULT '',name TEXT NOT NULL DEFAULT '',mime TEXT NOT NULL DEFAULT '',
    declared_size INTEGER,size INTEGER,sha256 TEXT,disk_name TEXT,status TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,UNIQUE(chat_id,message_id));
    INSERT INTO telegram_source_items(company_code,chat_id,message_id,caption,status,created_at)VALUES('palitra-love','-100111','1','Старое описание','text','2026-09-01T00:00:00Z');`);
  const users={1:{id:1,role:'owner',sessionVersion:1},2:{id:2,role:'member',sessionVersion:1,companyCodes:['palitra-love'],permissions:['autoposting.view','autoposting.edit']},
    3:{id:3,role:'member',sessionVersion:1,companyCodes:['palitra-love'],permissions:['autoposting.view']},4:{id:4,role:'member',sessionVersion:1,companyCodes:['alvi'],permissions:['autoposting.view','autoposting.edit']},
    5:{id:5,role:'member',sessionVersion:1,companyCodes:['palitra-love'],permissions:['autoposting.edit']}};
  const options=()=>({db,assetsDir:path.join(dir,'assets'),config,authStore:{getById:id=>users[id]},requireSession:req=>{
    if(!req.actor)throw Object.assign(Error('Вход'),{status:401});return {user:{id:req.actor,sessionVersion:1},csrfToken:'csrf'};
  },requireCsrf:req=>{if(req.headers?.['x-csrf-token']!=='csrf')throw Object.assign(Error('CSRF'),{status:403});},sendJson:(res,status,payload)=>Object.assign(res,{status,payload})});
  let service=createTelegramSources(options());t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  async function call(req,{code='palitra-love',actor=2,csrf='csrf',method='POST',suffix='upload'}={}){
    req.method=method;req.actor=actor;req.headers={'content-type':`multipart/form-data; boundary=${BOUNDARY}`,'x-csrf-token':csrf,...req.headers};
    const res={};assert.equal(await service.handle(req,res,new URL(`http://local/content/telegram-sources/${code}${suffix?'/'+suffix:''}`)),true);return res;
  }
  const patch=(id,body,options={},onEnd)=>{const req=Readable.from((async function*(){yield Buffer.from(JSON.stringify(body));if(onEnd)await onEnd();})());req.headers={'content-type':'application/json'};return call(req,{...options,method:'PATCH',suffix:id+'/metadata'});};
  return {dir,users,call,patch,get db(){return db;},get service(){return service;},restart(){db.close();db=new DatabaseSync(dbFile);service=createTelegramSources(options());},
    async list(options={}){return(await call({},{...options,method:'GET',suffix:''})).payload;},
    leftovers(){const storage=path.join(dir,'assets','telegram-sources');return fs.existsSync(storage)?fs.readdirSync(storage).filter(name=>name.startsWith('.upload-')):[];},
    async download(item,actor=3){let bytes=0;const hash=crypto.createHash('sha256'),res=new Writable({write(chunk,enc,done){bytes+=chunk.length;hash.update(chunk);done();}});res.writeHead=(status,headers)=>Object.assign(res,{status,headers});
      await service.handle({method:'GET',actor},res,new URL('http://local'+item.fileUrl));return {bytes,sha256:hash.digest('hex'),headers:res.headers};}};
}
test('обычная загрузка без Telegram доступна редактору: приватный файл, DTO и восстановление после рестарта',async t=>{
  const s=setup(t),metadata={platforms:['telegram','instagram'],formats:['reel','post'],occasion:'  Открытие  ',eventDate:'2026-10-01',usageRestrictions:'  Без лиц посетителей  ',materialState:'ready'};
  const result=await s.call(multipart({fields:{caption:'Подпись',metadata:JSON.stringify(metadata)},mime:'application/octet-stream'}));assert.equal(result.status,201);assert.equal(result.payload.duplicate,false);
  const item=result.payload.item;assert.equal(item.revision,1);assert.equal(item.importMethod,'upload');assert.equal(item.telegramUrl,null);assert.equal(item.provenance,'');assert.equal(item.caption,'Подпись');
  assert.deepEqual(item.metadata,{...metadata,platforms:['instagram','telegram'],formats:['post','reel'],occasion:'Открытие',usageRestrictions:'Без лиц посетителей'});
  const row=s.db.prepare('SELECT * FROM telegram_source_items').get();assert.equal(row.chat_id,'upload:palitra-love');assert.equal(row.message_id,item.sha256);assert.equal(row.imported_by,2);
  const download=await s.download(item);assert.equal(download.bytes,128);assert.equal(download.sha256,item.sha256);assert.equal(download.headers['cache-control'],'private, no-store');
  const editor=await s.list(),viewer=await s.list({actor:3});assert.equal(editor.uploadAllowed,true);assert.equal(viewer.uploadAllowed,false);assert.equal(editor.manualUploadAllowed,false);assert.equal(editor.enabled,false);
  assert.equal(editor.limits.maxFiles,1);assert.equal(editor.limits.maxFileBytes,256*1024*1024);assert.ok(editor.limits.mimeTypes.includes('video/quicktime'));assert.ok(editor.limits.extensions.includes('.mov'));
  assert.deepEqual(editor.metadataVocabulary.platforms,Object.entries(CAPTION_PLATFORMS).map(([id,value])=>({id,label:value.label})));
  assert.deepEqual(editor.metadataVocabulary.formats,Object.entries(FORMATS).map(([id,label])=>({id,label})));
  s.restart();assert.deepEqual((await s.list()).items[0],item);assert.deepEqual(s.leftovers(),[]);
});
test('повтор SHA возвращает прежние сведения и Telegram происхождение; компании изолированы',async t=>{
  const config={enabled:true,sources:[{chatId:'-100111',companyCode:'palitra-love',enabled:true}]},s=setup(t,{config});
  const bytes=Buffer.concat([HEAD,Buffer.alloc(128-HEAD.length)]);
  const telegram=s.service.receive({chatId:'-100111',messageId:'7',status:'stored',text:'Из Telegram',file:{name:'tg.MOV',mime:'video/quicktime',size:128},base64:bytes.toString('base64')}).item;
  const repeat=await s.call(multipart({fields:{caption:'Не перезаписывать',metadata:JSON.stringify({materialState:'ready'})}}));
  assert.equal(repeat.status,200);assert.equal(repeat.payload.duplicate,true);assert.deepEqual(repeat.payload.item,telegram);
  const other=await s.call(multipart(),{code:'alvi',actor:4});assert.equal(other.status,201);assert.equal(other.payload.item.companyCode,'alvi');assert.notEqual(other.payload.item.id,telegram.id);
  const ordinary=await s.call(multipart({marker:5,fields:{metadata:JSON.stringify({occasion:'Первое'})}}));
  const again=await s.call(multipart({marker:5,fields:{caption:'Второе',metadata:JSON.stringify({occasion:'Второе'})}}));assert.deepEqual(again.payload.item,ordinary.payload.item);
  assert.equal(s.db.prepare('SELECT count(*) n FROM telegram_source_items').get().n,3);assert.deepEqual(s.leftovers(),[]);
});
test('metadata PATCH: нормализация, сброс, сохранение полей, optimistic revision и company scope',async t=>{
  const s=setup(t),item=(await s.call(multipart({fields:{caption:'Исходная',metadata:JSON.stringify({formats:['reel'],occasion:'Праздник'})}}))).payload.item;
  const changed=(await s.patch(item.id,{revision:1,metadata:{formats:[],platforms:['vk','instagram'],eventDate:'2028-02-29'},caption:'Новая'})).payload.item;
  assert.equal(changed.revision,2);assert.deepEqual(changed.metadata.formats,[]);assert.deepEqual(changed.metadata.platforms,['instagram','vk']);assert.equal(changed.metadata.occasion,'Праздник');assert.equal(changed.caption,'Новая');
  assert.equal((await s.patch(item.id,{revision:2,metadata:{}})).payload.item.revision,2);
  await assert.rejects(s.patch(item.id,{revision:1,metadata:{occasion:'Потерянное'}}),{status:409});
  await assert.rejects(s.patch(item.id,{revision:2,metadata:{}},{code:'alvi',actor:4}),{status:404});
  assert.deepEqual((await s.list()).items[0],changed);
});
test('неизвестные значения, повторы, типы и невозможные даты metadata дают 400 без изменения item',async t=>{
  const s=setup(t),item=(await s.call(multipart())).payload.item;
  for(const metadata of [{platforms:['unknown']},{formats:['video']},{platforms:['vk','vk']},{formats:'reel'},{platforms:[1]},
    {eventDate:'2026-02-29'},{eventDate:'2026-13-01'},{eventDate:'01.10.2026'},{materialState:'published'},{occasion:12},{usageRestrictions:'x'.repeat(2001)},{origin:'fake'},null,[]]){
    await assert.rejects(s.patch(item.id,{revision:1,metadata}),{status:400});
    await assert.rejects(s.call(multipart({fields:{metadata:JSON.stringify(metadata)}})),{status:400});
  }
  await assert.rejects(s.call(multipart({fields:{metadata:'not-json'}})),{status:400});
  for(const body of [{revision:0,metadata:{}},{revision:'1',metadata:{}},{revision:1},{revision:1,metadata:{},author:99},{revision:1,metadata:{},caption:1}])await assert.rejects(s.patch(item.id,body),{status:400});
  assert.deepEqual((await s.list()).items[0],item);assert.deepEqual(item.metadata,EMPTY);assert.deepEqual(s.leftovers(),[]);
});
test('реальные размер, MIME, сигнатура, квота и parser cleanup; клиент не задаёт происхождение',async t=>{
  const s=setup(t,{config:{enabled:false,sources:[],maxStorageBytes:256,maxManualFileBytes:200}});
  for(const [input,status]of [[{size:201},413],[{incomplete:true},400],[{second:true},400],[{mime:'application/zip',name:'x.zip'},415],[{mime:'image/png'},415],[{head:Buffer.alloc(32)},415],
    [{fields:{chatId:'-100111'}},400],[{fields:{telegramUrl:'https://t.me/c/111/1'}},400],[{fields:{author:'1'}},400],[{fields:{origin:'fake'}},400]]){
    await assert.rejects(s.call(multipart(input)),{status});assert.deepEqual(s.leftovers(),[]);
  }
  assert.equal(s.db.prepare('SELECT count(*) n FROM telegram_source_items').get().n,0);
  const first=await s.call(multipart());assert.equal(first.status,201);assert.equal((await s.call(multipart())).status,200);
  await assert.rejects(s.call(multipart({size:180,marker:9})),{status:413});
  assert.equal(s.db.prepare('SELECT count(*) n FROM telegram_source_items').get().n,1);assert.equal(fs.readdirSync(path.join(s.dir,'assets','telegram-sources','palitra-love')).length,1);assert.deepEqual(s.leftovers(),[]);
});
test('session/company/view/edit/CSRF и потеря авторизации после async защищают upload и PATCH',async t=>{
  const s=setup(t);
  for(const [options,status]of [[{actor:null},401],[{actor:3},403],[{actor:4},403],[{actor:5},403],[{csrf:''},403],[{code:'unknown'},400]])await assert.rejects(s.call(multipart(),options),{status});
  await assert.rejects(s.call(multipart({onEnd:()=>{s.users[2].sessionVersion=2;}})),{status:401});s.users[2].sessionVersion=1;
  await assert.rejects(s.call(multipart({onEnd:()=>{s.users[2].permissions=['autoposting.view'];}})),{status:403});s.users[2].permissions.push('autoposting.edit');
  assert.equal(s.db.prepare('SELECT count(*) n FROM telegram_source_items').get().n,0);assert.deepEqual(s.leftovers(),[]);
  const item=(await s.call(multipart())).payload.item;
  for(const [options,status]of [[{actor:null},401],[{actor:3},403],[{actor:4},403],[{actor:5},403],[{csrf:''},403]])await assert.rejects(s.patch(item.id,{revision:1,metadata:{}},options),{status});
  await assert.rejects(s.patch(item.id,{revision:1,metadata:{occasion:'Не сохранено'}},{},()=>{s.users[2].companyCodes=[];}),{status:403});s.users[2].companyCodes=['palitra-love'];
  await assert.rejects(s.patch(item.id,{revision:1,metadata:{occasion:'Не сохранено'}},{},()=>{s.users[2].sessionVersion=2;}),{status:401});s.users[2].sessionVersion=1;
  assert.deepEqual((await s.list()).items[0],item);
  assert.equal((await s.call(multipart({marker:8}),{actor:1})).status,201,'владелец сохраняет существующее исключение');
});
test('миграция старой библиотеки добавляет defaults без изменения происхождения и повторяется безопасно',async t=>{
  const s=setup(t,{legacy:true});const item=(await s.list()).items[0];assert.equal(item.revision,1);assert.deepEqual(item.metadata,EMPTY);assert.equal(item.caption,'Старое описание');assert.equal(item.importMethod,'telegram');
  assert.equal(item.telegramUrl,'https://t.me/c/111/1');s.restart();assert.deepEqual((await s.list()).items[0],item);
  const patch=(await s.patch(item.id,{revision:1,metadata:{materialState:'ready'}})).payload.item;assert.equal(patch.revision,2);assert.equal(patch.importMethod,'telegram');assert.equal(patch.telegramUrl,item.telegramUrl);
});
