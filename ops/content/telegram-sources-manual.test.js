'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Readable,Writable}=require('node:stream'),{DatabaseSync}=require('node:sqlite');
const {createTelegramSources}=require('./telegram-sources');
const BOUNDARY='source-test-boundary', HEAD=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypqt  '),Buffer.alloc(20)]);
const CONFIG={enabled:true,sources:[{chatId:'-100111',companyCode:'palitra-love',enabled:true},{chatId:'-100222',companyCode:'alvi',enabled:true}]};
function multipart({fields={telegramUrl:'https://t.me/c/111/1'},size=128,marker=0,mime='video/quicktime',name='old.MOV',incomplete=false,onEnd,extra=''}={}){
  return Readable.from((async function*(){
    for(const [key,value] of Object.entries(fields))yield Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
    yield Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`);
    yield HEAD.subarray(0,Math.min(size,HEAD.length));let left=size-HEAD.length;const chunk=Buffer.alloc(65536,marker);
    while(left>0){const n=Math.min(left,chunk.length);yield chunk.subarray(0,n);left-=n;}
    if(onEnd)await onEnd();if(incomplete)return;
    yield Buffer.from(`\r\n--${BOUNDARY}--\r\n${extra}`);
  })());
}
function setup(t,config=CONFIG){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-manual-')),dbFile=path.join(dir,'db.sqlite');let db=new DatabaseSync(dbFile);
  const users={1:{id:1,role:'owner',sessionVersion:1},2:{id:2,role:'member',sessionVersion:1,companyCodes:['palitra-love'],permissions:['autoposting.view']}};
  const options=()=>({db,assetsDir:path.join(dir,'assets'),config,authStore:{getById:id=>users[id]},
    requireSession:req=>{if(!req.actor)throw Object.assign(Error('Вход'),{status:401});return {user:{id:req.actor,sessionVersion:1},csrfToken:'csrf'};},
    requireCsrf:req=>{if(req.headers['x-csrf-token']!=='csrf')throw Object.assign(Error('CSRF'),{status:403});},
    sendJson:(res,status,payload)=>Object.assign(res,{status,payload})});
  let module=createTelegramSources(options());t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const call=async(req,code='palitra-love',actor=1,csrf='csrf')=>{req.method='POST';req.actor=actor;req.headers={'content-type':`multipart/form-data; boundary=${BOUNDARY}`,'x-csrf-token':csrf,...req.headers};
    const res={};await module.handle(req,res,new URL(`http://local/content/telegram-sources/${code}/manual-upload`));return res;};
  return {get db(){return db;},get module(){return module;},dir,users,call,
    restart(){db.close();db=new DatabaseSync(dbFile);module=createTelegramSources(options());},
    async list(code='palitra-love'){const res={};await module.handle({method:'GET',actor:1},res,new URL(`http://local/content/telegram-sources/${code}`));return res.payload;},
    async download(url){let size=0;const hash=crypto.createHash('sha256'),res=new Writable({write(chunk,enc,done){size+=chunk.length;hash.update(chunk);done();}});res.writeHead=(status,headers)=>Object.assign(res,{status,headers});
      await module.handle({method:'GET',actor:1},res,new URL('http://local'+url));return {size,sha:hash.digest('hex'),headers:res.headers};}};
}
test('потоковый ручной импорт 68 935 123 байта повышает карточку, сохраняет origin и не повторяется после рестарта',async t=>{
  const s=setup(t),size=68935123;
  const original=s.module.receive({chatId:'-100111',messageId:'1',status:'manual_import',file:{name:'old.MOV',mime:'video/quicktime',size},text:'Прежняя подпись'}).item;
  const result=await s.call(multipart({size}));assert.equal(result.status,201);assert.equal(result.payload.item.id,original.id);
  const item=result.payload.item;assert.equal(item.importMethod,'manual');assert.equal(item.telegramUrl,'https://t.me/c/111/1');assert.equal(item.caption,'Прежняя подпись');assert.equal(item.size,size);
  const actual=await s.download(item.fileUrl);assert.equal(actual.size,size);assert.equal(actual.sha,item.sha256);assert.equal(actual.headers['cache-control'],'private, no-store');
  s.restart();const again=await s.call(multipart({size}));assert.equal(again.status,200);assert.equal(again.payload.duplicate,true);assert.equal(again.payload.item.id,item.id);
  await assert.rejects(s.call(multipart({size,marker:1})),{status:409});
  assert.equal(s.db.prepare('SELECT count(*) n FROM telegram_source_items').get().n,1);
  assert.deepEqual(fs.readdirSync(path.join(s.dir,'assets','telegram-sources')),['palitra-love']);
});
test('архив без ссылки: 170 МБ помещаются, честное происхождение, отдельная дедупликация company/source/SHA',async t=>{
  const s=setup(t),fields={sourceChatId:'-100111',provenance:'История беседы до миграции; 21 сентября; old.MOV'};
  const first=await s.call(multipart({fields,size:170000000}));const item=first.payload.item;
  assert.equal(item.size,170000000);assert.equal(item.importMethod,'manual_archive');assert.equal(item.telegramUrl,null);assert.equal(item.provenance,fields.provenance);
  const record=s.db.prepare('SELECT * FROM telegram_source_items').get();assert.match(record.message_id,/^archive:[a-f0-9]{64}$/);assert.equal(record.imported_by,1);assert.ok(record.imported_at);
  s.restart();const repeat=await s.call(multipart({fields,size:170000000}));assert.equal(repeat.payload.item.id,item.id);assert.equal(repeat.payload.duplicate,true);
  assert.equal(s.module.receipt('-100111','1'),undefined);
  const other=await s.call(multipart({fields:{...fields,sourceChatId:'-100222'},size:128}),'alvi');assert.equal(other.status,201);assert.equal(other.payload.item.companyCode,'alvi');
  assert.deepEqual(s.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('project_chat_ai_jobs','project_chat_outbox','project_chat_tasks')").all(),[]);
});
test('ручная загрузка защищена owner/CSRF/актуальной сессией и источником выбранной компании',async t=>{
  const s=setup(t);
  await assert.rejects(s.call(multipart(),undefined,null),{status:401});await assert.rejects(s.call(multipart(),undefined,2),{status:403});
  await assert.rejects(s.call(multipart(),undefined,1,''),{status:403});
  for(const fields of [{telegramUrl:'https://t.me/c/222/1'},{sourceChatId:'-100222',provenance:'старое'},{sourceChatId:'-100999',provenance:'старое'}])await assert.rejects(s.call(multipart({fields})),{status:403});
  for(const url of ['https://example.org/c/111/1','https://evil@t.me/c/111/1','javascript:alert(1)','https://t.me/c/111/1#fake','https://t.me/c/111/1?x=1'])await assert.rejects(s.call(multipart({fields:{telegramUrl:url}})),{status:400});
  await assert.rejects(s.call(multipart({onEnd:()=>{s.users[1].sessionVersion=2;}})),{status:401});s.users[1].sessionVersion=1;
  await assert.rejects(s.call(multipart({onEnd:()=>{s.users[1].role='member';s.users[1].companyCodes=['palitra-love'];s.users[1].permissions=['autoposting.view'];}})),{status:403});
  assert.equal(s.db.prepare('SELECT count(*) n FROM telegram_source_items').get().n,0);
  assert.deepEqual(fs.readdirSync(path.join(s.dir,'assets','telegram-sources')),[]);
});
test('multipart, лимит, обрыв, сигнатура и исчерпанная квота не оставляют файл или ложную квитанцию',async t=>{
  const s=setup(t,{...CONFIG,maxStorageBytes:256,maxManualFileBytes:200});
  await assert.rejects(s.call(multipart({size:201})),{status:413});await assert.rejects(s.call(multipart({incomplete:true})),{status:400});
  await assert.rejects(s.call(multipart({extra:'trailing'})),{status:400});await assert.rejects(s.call(multipart({mime:'image/png'})),{status:415});
  await assert.rejects(s.call(multipart({fields:{telegramUrl:'https://t.me/c/111/1',sourceChatId:'-100111'}})),{status:400});
  await assert.rejects(s.call(multipart({fields:{sourceChatId:'-100111'}})),{status:400});
  const a=await s.call(multipart());assert.equal(a.status,201);
  const b=await s.call(multipart({fields:{telegramUrl:'https://t.me/c/111/2'}}));assert.equal(b.status,201,'один SHA не тратит квоту дважды');
  await assert.rejects(s.call(multipart({fields:{telegramUrl:'https://t.me/c/111/3'},size:180,marker:3})),{status:413});
  assert.equal(fs.readdirSync(path.join(s.dir,'assets','telegram-sources','palitra-love')).length,1);
  assert.equal(s.db.prepare('SELECT count(*) n FROM telegram_source_items').get().n,2);
});
test('индивидуальная квота Palitra не повышает лимит другой компании',async t=>{
  const s=setup(t,{...CONFIG,maxStorageBytes:100,companyLimits:{'palitra-love':{maxStorageBytes:4294967296}}});
  assert.equal((await s.list()).storageLimitBytes,4294967296);assert.equal((await s.list('alvi')).storageLimitBytes,100);
  assert.equal((await s.list()).manualMaxBytes,256*1024*1024);
  assert.equal((await s.call(multipart())).status,201);
  await assert.rejects(s.call(multipart({fields:{telegramUrl:'https://t.me/c/222/1'}}),'alvi'),{status:413});
});
