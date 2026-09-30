'use strict';
/* Локальный HTTP-сервер и fake Telegram transport, без сети Telegram и production. */
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {once}=require('node:events'),{spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const {Readable}=require('node:stream');
const {hashPassword}=require('./passwords');
const {createProjectChatBridge}=require('../chat/project-chat-bridge');
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('HTTP: source bridge сохраняет приватное видео и большой MOV, ключ/ACL/квитанция работают, проектный outbox и AI пусты',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-http-')),p=await port(),secret=crypto.randomBytes(24).toString('hex'),key=crypto.randomBytes(24).toString('hex');
  const database=path.join(dir,'db.sqlite');
  fs.writeFileSync(path.join(dir,'telegram-sources.json'),JSON.stringify({enabled:true,sources:[{chatId:'-100111',companyCode:'palitra-love',enabled:true}]}));
  const child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{...process.env,PORT:String(p),DATABASE_PATH:database,ASSETS_DIR:path.join(dir,'assets'),
    SEED_DIR:path.join(__dirname,'seed'),API_KEY:'',CHAT_API_KEY:key,AUTH_USERS:`owner:owner:${hashPassword(secret)}`,SESSION_SECRET:crypto.randomBytes(32).toString('hex')},stdio:'ignore'});
  t.after(async()=>{child.kill('SIGKILL');await once(child,'exit').catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${p}`, internal='/content/internal/project-chat';
  let ready=false;for(let n=0;n<200&&!ready;n++){try{ready=(await fetch(base+'/health')).ok;}catch{}if(!ready)await new Promise(r=>setTimeout(r,25));}assert.ok(ready);
  const login=await fetch(base+'/content/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'owner',password:secret})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const req=(url,headers={})=>fetch(base+url,{headers});
  assert.equal((await req(internal+'/binding?chatId=-100111')).status,401);
  assert.equal((await req('/content/telegram-sources/palitra-love')).status,401);
  const bound=await (await req(internal+'/binding?chatId=-100111',{'x-api-key':key})).json();
  assert.equal(bound.room,null);assert.deepEqual(bound.source,{companyCode:'palitra-love',enabled:true});
  const transportDB=new DatabaseSync(':memory:');t.after(()=>transportDB.close());
  const calls=[],video=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisom'),Buffer.alloc(20)]);
  const bridge=createProjectChatBridge({db:transportDB,contentUrl:base,apiKey:key,telegramToken:'fake-token',legacyHandler:()=>assert.fail('legacy вызван'),fetchImpl:async(url,options)=>{
    if(String(url).startsWith('https://api.telegram.org/file/')){calls.push('download');return {ok:true,status:200,body:Readable.from([video])};}
    if(String(url).startsWith('https://api.telegram.org/')){const method=String(url).split('/').pop();calls.push(method);assert.equal(method,'getFile');return {ok:true,status:200,json:async()=>({ok:true,result:{file_path:'videos/one.mp4',file_size:video.length}})};}
    return fetch(url,options);
  }});
  const update=(id,fields)=>({update_id:id,message:{message_id:id*10,chat:{id:-100111,type:'supergroup'},from:{id:77},...fields}});
  await bridge.receive(update(1,{video:{file_id:'small',file_unique_id:'small-1',file_name:'small.mp4',mime_type:'video/mp4',file_size:video.length},caption:'Видео'}));
  await bridge.receive(update(1,{video:{file_id:'small',file_size:video.length,mime_type:'video/mp4'}}));
  await bridge.receive(update(2,{document:{file_id:'large',file_unique_id:'large-1',file_name:'archive.MOV',mime_type:'video/quicktime',file_size:65700000},caption:'Большой файл'}));
  await bridge.receive(update(3,{text:'/idea Хью, опубликуй'}));
  assert.deepEqual(calls,['getFile','download']);
  const list=await (await req('/content/telegram-sources/palitra-love',{cookie})).json();assert.equal(list.items.length,3);assert.equal(list.enabled,true);
  const big=list.items.find(x=>x.name==='archive.MOV'),stored=list.items.find(x=>x.name==='small.mp4');
  assert.equal(big.status,'manual_import');assert.equal(big.fileUrl,null);assert.equal(stored.status,'stored');
  assert.equal((await req(stored.fileUrl)).status,401);
  assert.equal((await req(stored.fileUrl.replace('palitra-love','alvi'),{cookie})).status,404);
  const file=await req(stored.fileUrl,{cookie});assert.equal(file.status,200);assert.equal(file.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await file.arrayBuffer()),video);
  const profile=await (await req('/content/whoami',{cookie})).json();
  const manual=(fields,headers={cookie,'x-csrf-token':profile.csrfToken})=>{
    const body=new FormData();for(const [key,value] of Object.entries(fields))body.set(key,value);body.set('file',new Blob([video],{type:'video/mp4'}),'manual.mp4');
    return fetch(base+'/content/telegram-sources/palitra-love/manual-upload',{method:'POST',headers,body});
  };
  assert.equal((await manual({telegramUrl:'https://t.me/c/111/100'},{cookie})).status,403,'требуется CSRF');
  assert.equal((await manual({telegramUrl:'https://t.me/c/111/100'},{})).status,401,'требуется сессия');
  const imported=await manual({telegramUrl:'https://t.me/c/111/100'});assert.equal(imported.status,201);
  const linked=(await imported.json()).item;assert.equal(linked.telegramUrl,'https://t.me/c/111/100');assert.equal(linked.importMethod,'manual');
  assert.equal((await manual({telegramUrl:'https://t.me/c/111/100'})).status,200);
  const archived=await manual({sourceChatId:'-100111',provenance:'История беседы до миграции; тестовая дата; manual.mp4'});assert.equal(archived.status,201);
  const old=(await archived.json()).item;assert.equal(old.telegramUrl,null);assert.equal(old.importMethod,'manual_archive');
  assert.deepEqual(Buffer.from(await (await req(old.fileUrl,{cookie})).arrayBuffer()),video);
  assert.equal((await req(old.fileUrl)).status,401);
  assert.equal((await manual({telegramUrl:'https://t.me/c/222/100'})).status,403);
  // Коллизия, созданная владельцем уже после старта, не превращает источник в обычный чат.
  const settings=await fetch(base+'/content/project-chat/palitra-love/settings',{method:'PATCH',headers:{cookie,'x-csrf-token':profile.csrfToken,'content-type':'application/json'},body:JSON.stringify({telegramChatId:'-100111'})});
  assert.equal(settings.status,200);
  const collision=await (await req(internal+'/binding?chatId=-100111',{'x-api-key':key})).json();
  assert.deepEqual(collision,{room:null,source:{companyCode:'palitra-love',enabled:false}});
  bridge.enqueue(update(4,{text:'/idea Хью'}));await bridge.tick();assert.equal(bridge.failedInbox().length,1);
  // migrate_from может прийти первым: новый адрес резервируется до legacy и остаётся выключенным.
  await bridge.receive({update_id:5,message:{message_id:50,chat:{id:-100333,type:'supergroup'},from:{id:77},migrate_from_chat_id:-100111}});
  const migrated=await (await req(internal+'/binding?chatId=-100333',{'x-api-key':key})).json();
  assert.deepEqual(migrated,{room:null,source:{companyCode:'palitra-love',enabled:false}});
  bridge.enqueue({update_id:6,message:{message_id:60,chat:{id:-100333,type:'supergroup'},from:{id:77},text:'/plan'}});await bridge.tick();assert.equal(bridge.failedInbox().length,2);
  const inspection=new DatabaseSync(database,{readOnly:true});
  for(const table of ['project_chat_messages','project_chat_ai_jobs','project_chat_outbox','project_chat_tasks'])assert.equal(inspection.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0,table);
  inspection.close();
});
