'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {Writable}=require('node:stream');
const {createTelegramSources,readSourceConfig,MAX_FILE} = require('./telegram-sources');
const PNG = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)]);
const CONFIG = {enabled:true,sources:[{chatId:'-100111',companyCode:'palitra-love',enabled:true},{chatId:'-100222',companyCode:'alvi',enabled:true}]};
const sourceEvent = (messageId = '1') => ({chatId:'-100111',messageId,text:'Материалы к теме',mediaGroupId:'album-1',status:'stored',
  file:{fileId:'tg-file',fileUniqueId:'unique-file',name:'photo.png',mime:'image/png',size:PNG.length},base64:PNG.toString('base64')});
function setup(t, config = CONFIG) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'telegram-source-test-')), dbFile=path.join(dir,'db.sqlite');
  let db = new DatabaseSync(dbFile);
  const users = {1:{id:1,role:'owner',sessionVersion:1},2:{id:2,role:'member',sessionVersion:1,companyCodes:['palitra-love'],permissions:['autoposting.view']},
    3:{id:3,role:'member',sessionVersion:1,companyCodes:['alvi'],permissions:['autoposting.view']}};
  const options = () => ({db,assetsDir:dir,config,authStore:{getById:id=>users[id]},
    requireSession:req=>{if(!req.session)throw Object.assign(new Error('Вход'),{status:401});return req.session;},
    sendJson:(res,status,payload,headers)=>Object.assign(res,{status,payload,headers})});
  let module = createTelegramSources(options());
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {get db(){return db;},get module(){return module;},dir,users,
    restart(next=config){db.close();db=new DatabaseSync(dbFile);config=next;module=createTelegramSources(options());return module;},
    async call(url,userId=2,method='GET') {const chunks=[];const res=new Writable({write(chunk,encoding,done){chunks.push(Buffer.from(chunk));done();}});
      res.writeHead=function(status,headers){this.status=status;this.headers=headers;};
      await module.handle({method,session:userId?{user:{...users[userId]}}:null},res,new URL('http://local'+url));res.bytes=Buffer.concat(chunks);return res;}};
}
test('приватный файл и квитанция переживают перезапуск; исходная рабочая привязка и другие очереди не меняются', async t=>{
  const s=setup(t);s.db.exec("CREATE TABLE project_chat_rooms(company_code TEXT,telegram_chat_id TEXT); INSERT INTO project_chat_rooms VALUES('palitra-love','-100999')");
  const a=s.module.receive(sourceEvent());assert.equal(a.item.status,'stored');assert.equal(a.item.mediaGroupId,'album-1');
  assert.equal(a.item.telegramUrl,'https://t.me/c/111/1');assert.ok(!JSON.stringify(a).includes('tg-file'));
  s.restart();const duplicate=s.module.receive(sourceEvent());assert.equal(duplicate.duplicate,true);assert.equal(duplicate.item.id,a.item.id);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM telegram_source_items').get().n,1);
  assert.equal(fs.readdirSync(path.join(s.dir,'telegram-sources','palitra-love')).length,1);
  const download=await s.call(a.item.fileUrl);assert.deepEqual(download.bytes,PNG);assert.equal(download.headers['cache-control'],'private, no-store');
  assert.equal(s.db.prepare('SELECT telegram_chat_id FROM project_chat_rooms').get().telegram_chat_id,'-100999');
  assert.deepEqual(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project_chat_messages','project_chat_ai_jobs','project_chat_outbox','project_chat_tasks')").all(),[]);
});
test('ACL: нет сессии/чужая компания/отозванные права не читают список или файл',async t=>{
  const s=setup(t),a=s.module.receive(sourceEvent());
  for (const url of ['/content/telegram-sources/palitra-love',a.item.fileUrl]) {
    await assert.rejects(s.call(url,null),{status:401});await assert.rejects(s.call(url,3),{status:403});
    assert.equal((await s.call(url,1)).status,200);
  }
  await assert.rejects(s.call(a.item.fileUrl.replace('palitra-love','alvi'),3),{status:404});
  s.users[2].permissions=[];await assert.rejects(s.call(a.item.fileUrl),{status:403});
  s.users[2].permissions=['autoposting.view'];s.users[2].companyCodes=[];await assert.rejects(s.call(a.item.fileUrl),{status:403});
});
test('MOV 65,7 МБ и неподдерживаемые/некорректные файлы остаются карточкой ручного импорта',t=>{
  const s=setup(t),event=sourceEvent();event.file={fileId:'large',fileUniqueId:'large-unique',name:'archive.MOV',mime:'video/quicktime',size:65700000};
  delete event.base64;event.status='manual_import';event.reason='Файл больше 20 МБ';
  const big=s.module.receive(event).item;assert.equal(big.status,'manual_import');assert.equal(big.size,65700000);assert.equal(big.fileUrl,null);assert.equal(big.telegramUrl,'https://t.me/c/111/1');
  const invalid=sourceEvent('2');invalid.base64=Buffer.from('not PNG').toString('base64');assert.equal(s.module.receive(invalid).item.status,'manual_import');
  const forged=sourceEvent('3');forged.file.size=MAX_FILE+1;assert.equal(s.module.receive(forged).item.status,'manual_import');
  assert.equal(fs.existsSync(path.join(s.dir,'telegram-sources')),false);
});
test('квота и SHA256: одинаковый файл не занимает место дважды; превышение не теряет карточку',t=>{
  const s=setup(t,{...CONFIG,maxStorageBytes:PNG.length});assert.equal(s.module.receive(sourceEvent()).item.status,'stored');
  assert.equal(s.module.receive(sourceEvent('2')).item.status,'stored');
  const changed=sourceEvent('3'),bytes=Buffer.from(PNG);bytes[24]=5;changed.base64=bytes.toString('base64');
  const full=s.module.receive(changed).item;assert.equal(full.status,'manual_import');assert.match(full.reason,/Хранилище/);
  assert.equal(fs.readdirSync(path.join(s.dir,'telegram-sources','palitra-love')).length,1);
});
test('выключение сохраняет резервирование источника; нельзя переназначить компанию или рабочую комнату',t=>{
  const s=setup(t);s.restart({enabled:false,sources:[]});assert.equal(s.module.binding('-100111').enabled,false);
  assert.throws(()=>s.module.receive(sourceEvent()),{status:409});
  s.restart({enabled:true,sources:[{chatId:'-100111',companyCode:'alvi',enabled:true}]});assert.equal(s.module.healthy,false);
  assert.equal(s.module.binding('-100111').companyCode,'palitra-love');
  s.db.exec("CREATE TABLE project_chat_rooms(company_code TEXT,telegram_chat_id TEXT); INSERT INTO project_chat_rooms VALUES('palitra-love','-100999')");
  s.restart({enabled:true,sources:[{chatId:'-100999',companyCode:'palitra-love',enabled:true}]});assert.equal(s.module.healthy,false);
  assert.equal(s.db.prepare('SELECT telegram_chat_id FROM project_chat_rooms').get().telegram_chat_id,'-100999');
});
test('конфиг отсутствует — выключено; повреждённый конфиг закрывает приём, текст команд только сохраняется',t=>{
  const s=setup(t);assert.deepEqual(readSourceConfig(path.join(s.dir,'missing.json')),{enabled:false,sources:[]});
  fs.writeFileSync(path.join(s.dir,'bad.json'),'{bad');s.restart(readSourceConfig(path.join(s.dir,'bad.json')));assert.equal(s.module.healthy,false);
  assert.equal(s.module.binding('-100111').enabled,false);assert.throws(()=>s.module.binding('-100555'),{status:503});
  s.restart(CONFIG);const saved=s.module.receive({chatId:'-100111',messageId:'99',text:'/plan Хью, опубликуй'}).item;
  assert.equal(saved.status,'text');assert.equal(saved.caption,'/plan Хью, опубликуй');
});

test('поздняя привязка рабочей комнаты закрывает источник без изменения данных комнаты',async t=>{
  const s=setup(t);s.db.exec("CREATE TABLE project_chat_rooms(company_code TEXT,telegram_chat_id TEXT); INSERT INTO project_chat_rooms VALUES('alvi','-100111')");
  assert.deepEqual(s.module.binding('-100111'),{companyCode:'palitra-love',enabled:false});
  assert.throws(()=>s.module.receive(sourceEvent()),{status:409});
  assert.equal((await s.call('/content/telegram-sources/palitra-love')).payload.enabled,false);
  assert.equal(s.db.prepare('SELECT company_code FROM project_chat_rooms').get().company_code,'alvi');
});

test('миграция резервирует новый chatId выключенным и переживает рестарт; другой компании источник не отдаётся',t=>{
  const s=setup(t);assert.deepEqual(s.module.migrate('-100111','-100333').source,{companyCode:'palitra-love',enabled:false});
  assert.equal(s.module.binding('-100111').enabled,false);s.restart();assert.equal(s.module.binding('-100333').enabled,false);
  assert.throws(()=>s.module.receive({...sourceEvent(),chatId:'-100333'}),{status:409});
  assert.throws(()=>s.module.migrate('-100111','-100222'),{status:409});
  assert.equal(s.module.binding('-100222').companyCode,'alvi');
  assert.throws(()=>s.module.migrate('-100999','-100444'),{status:404});
});
