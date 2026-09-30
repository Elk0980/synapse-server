'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store');
const {createProjectChat}=require('./project-chat');
const {configFromEnv,validatedConfig,slotsAt}=require('./content-review-reminders');
const COMPANY='palitra-love',ENABLED={enabled:true,evening:'18:00',morning:'09:00'};
const HASH=`scrypt$16384$8$1$${Buffer.alloc(16,7).toString('base64url')}$${Buffer.alloc(32,9).toString('base64url')}`;
const item=(id=1,extra={})=>({id,revision:2,contentRevision:1,title:'Материал '+id,effectiveDate:'2026-10-01',dateKind:'schedule',scheduledAt:'2026-10-01T12:00:00Z',status:'draft',approved:false,...extra});
const summary=(items,date='2026-10-01')=>({companyCode:COMPANY,timezone:'Europe/Moscow',date,items});
function fixture(t,{config=ENABLED,items=[item()],fetchOverride,instant='2026-09-30T15:00:00Z'}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'content-review-reminders-'));let db,chat;
  const clock={now:Date.parse(instant)},calls=[];let current=items;
  const open=()=>{
    db=new DatabaseSync(path.join(dir,'fixture.sqlite'));db.exec('PRAGMA foreign_keys=ON;');
    const authStore=createAuthStore(db,`fixture:owner:${HASH}`);
    chat=createProjectChat({db,authStore,assetsDir:dir,requireSession:()=>{throw Error('No session should be needed');},requireCsrf(){throw Error('No write request');},sendJson(){},readBody(){},
      now:()=>clock.now,crmUrl:'http://fixture-crm',crmApiKey:'fixture-service-key',cabinetUrl:'https://fixture.test',reviewReminders:config,
      fetchImpl:async(url,options)=>{
        calls.push({url,options});assert.equal(options.method,undefined);assert.equal(options.headers['x-api-key'],'fixture-service-key');
        assert.equal(new URL(url).pathname,'/autoposting/review-reminders');assert.equal(new URL(url).searchParams.get('companyCode'),COMPANY);
        if(fetchOverride){const response=await fetchOverride({db,chat,clock,url,calls});if(response!==undefined)return response;}
        return {ok:true,json:async()=>summary(current,new URL(url).searchParams.get('date'))};
      }});
    for(const [code,group] of [[COMPANY,'-1001111111111'],['alvi','-1002222222222']])db.prepare(`INSERT OR IGNORE INTO project_chat_rooms
      (company_code,title,telegram_chat_id,created_at,updated_at) VALUES(?,?,?,'2026-09-30','2026-09-30')`).run(code,code,group);
  };
  open();t.after(()=>{chat.stopWorker();db.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  return {get db(){return db;},get chat(){return chat;},clock,calls,setItems:items=>{current=items;},run:()=>chat.contentReviewReminders.process(),
    advance:ms=>{clock.now+=ms;},at:value=>{clock.now=Date.parse(value);},restart(){chat.stopWorker();db.close();open();},
    messages:()=>db.prepare('SELECT * FROM project_chat_messages ORDER BY id').all(),
    runs:()=>db.prepare('SELECT * FROM content_review_reminder_runs').all(),
    count:table=>db.prepare(`SELECT count(*) n FROM ${table}`).get().n};
}

test('явное включение и время обязательны; московские сутки учитывают границы месяца/года',()=>{
  assert.equal(validatedConfig(configFromEnv({})).enabled,false);
  assert.equal(validatedConfig(configFromEnv({PALITRA_REVIEW_REMINDERS_ENABLED:'1'})).enabled,false);
  for(const config of [{enabled:true},{enabled:true,evening:'25:00'},{enabled:true,evening:'23:30'},{enabled:true,evening:'18:00',morning:'17:30'}])assert.equal(validatedConfig(config).enabled,false);
  const config=validatedConfig(ENABLED);
  assert.deepEqual(slotsAt(Date.parse('2026-09-30T14:59:59Z'),config),[]);
  assert.deepEqual(slotsAt(Date.parse('2026-09-30T15:00:00Z'),config),[{phase:'evening',date:'2026-09-30',targetDate:'2026-10-01'}]);
  assert.deepEqual(slotsAt(Date.parse('2026-12-31T15:30:00Z'),config),[{phase:'evening',date:'2026-12-31',targetDate:'2027-01-01'}]);
  assert.deepEqual(slotsAt(Date.parse('2026-10-01T06:00:00Z'),config),[{phase:'morning',date:'2026-10-01',targetDate:'2026-10-01'}]);
  assert.deepEqual(slotsAt(Date.parse('2026-09-30T16:00:00Z'),config),[]);
});
test('по умолчанию и без группы нет ни запроса CRM, ни сообщений',async t=>{
  const off=fixture(t,{config:{}});assert.equal((await off.run()).status,'disabled');assert.equal(off.calls.length,0);assert.equal(off.messages().length,0);
  const noRoom=fixture(t);noRoom.db.prepare('UPDATE project_chat_rooms SET telegram_chat_id=NULL WHERE company_code=?').run(COMPANY);
  assert.equal((await noRoom.run()).status,'no_group');assert.equal(noRoom.calls.length,0);assert.equal(noRoom.runs().length,0);
});
test('вечером одна сводка версий, действующая группа, Хью и существующий outbox без AI',async t=>{
  const f=fixture(t,{items:[item(),item(2,{dateKind:'plan',scheduledAt:null,title:'<Сценарий>\nбез времени'})]});await f.run();
  const [message]=f.messages();assert.equal(f.messages().length,1);assert.equal(message.company_code,COMPANY);assert.equal(message.author_type,'assistant');assert.equal(message.author_name,'Хью');
  assert.match(message.text,/01\.10\.2026/);assert.match(message.text,/№1 · версия 1/);assert.match(message.text,/Дата плана; время публикации ещё не задано/);
  assert.match(message.text,/https:\/\/fixture\.test\/cabinet\.html#autoposting\?company=palitra-love&post=1&revision=1/);
  assert.match(message.text,/не является согласованием/);
  const out=f.db.prepare('SELECT * FROM project_chat_outbox').get();assert.equal(out.chat_id,'-1001111111111');assert.equal(out.status,'pending');
  assert.equal(f.count('content_review_reminder_items'),2);assert.equal(f.count('project_chat_ai_jobs'),0);assert.equal(f.runs()[0].status,'queued');
  f.advance(60000);await f.run();assert.equal(f.calls.length,1);assert.equal(f.messages().length,1);
});
test('утро уведомляет только новые версии/материалы; неопределённая доставка и рестарт не порождают дубль',async t=>{
  const f=fixture(t);await f.run();const out=f.db.prepare('SELECT id FROM project_chat_outbox').get();
  f.chat.acknowledgeTelegram(out.id,{uncertain:true});f.restart();f.advance(60000);await f.run();assert.equal(f.messages().length,1);
  f.setItems([item(),item(2)]);f.at('2026-10-01T06:00:00Z');await f.run();assert.equal(f.messages().length,2);
  assert.doesNotMatch(f.messages()[1].text,/№1 ·/);assert.match(f.messages()[1].text,/№2 ·/);
  assert.equal(f.db.prepare('SELECT status FROM project_chat_outbox WHERE id=?').get(out.id).status,'uncertain');
  const changed=fixture(t);await changed.run();changed.setItems([item(1,{revision:3,contentRevision:2})]);changed.at('2026-10-01T06:00:00Z');await changed.run();
  assert.equal(changed.messages().length,2);assert.match(changed.messages()[1].text,/версия 2/);
});
test('свежий ответ исключает согласованные/отменённые/опубликованные и прошедшее время',async t=>{
  const f=fixture(t,{instant:'2026-10-01T06:00:00Z',items:[item(1,{approved:true}),item(2,{status:'cancelled'}),item(3,{status:'published'}),item(4,{status:'publishing'}),item(5,{scheduledAt:'2026-10-01T05:59:00Z'})]});
  await f.run();assert.equal(f.messages().length,0);assert.equal(f.runs()[0].status,'empty');assert.equal(f.count('content_review_reminder_items'),0);
});
test('смена группы во время запроса блокирует окно, не переносит уведомление другой аудитории',async t=>{
  const f=fixture(t,{fetchOverride:({db})=>{db.prepare("UPDATE project_chat_rooms SET telegram_chat_id='-1003333333333' WHERE company_code=?").run(COMPANY);}});
  await f.run();assert.equal(f.messages().length,0);assert.equal(f.runs()[0].status,'blocked');assert.equal(f.runs()[0].last_error,'GROUP_CHANGED');
  f.restart();f.advance(60000);await f.run();assert.equal(f.calls.length,1);assert.equal(f.messages().length,0);
});
test('CRM недоступна/чужая сводка: никаких ложных отметок успеха, повтор только в окне',async t=>{
  const f=fixture(t,{fetchOverride:({calls})=>calls.length===1?{ok:true,json:async()=>({...summary([item()]),companyCode:'alvi'})}:undefined});
  assert.equal((await f.run()).status,'unavailable');assert.equal(f.messages().length,0);assert.equal(f.runs()[0].status,'pending');
  f.advance(60000);await f.run();assert.equal(f.messages().length,1);assert.equal(f.calls.length,2);
  const late=fixture(t,{fetchOverride:({clock})=>{clock.now=Date.parse('2026-09-30T16:00:00Z');}});await late.run();assert.equal(late.messages().length,0);
});
test('атомарность: сбой записи журнала откатывает сообщение/outbox, затем один безопасный повтор',async t=>{
  const f=fixture(t);f.db.exec("CREATE TRIGGER fail_reminder BEFORE INSERT ON content_review_reminder_items BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  await assert.rejects(f.run(),/fixture failure/);assert.equal(f.messages().length,0);assert.equal(f.count('project_chat_outbox'),0);assert.equal(f.runs()[0].status,'pending');
  f.db.exec('DROP TRIGGER fail_reminder');f.advance(60000);await f.run();assert.equal(f.messages().length,1);assert.equal(f.count('content_review_reminder_items'),1);
});
test('большая сводка делится на ограниченные сообщения; все версии учтены один раз',async t=>{
  const f=fixture(t,{items:Array.from({length:75},(_,index)=>item(index+1,{title:'Название '.repeat(25)}))});await f.run();
  assert.ok(f.messages().length>1);assert.ok(f.messages().every(message=>message.text.length<=10000));assert.equal(f.count('content_review_reminder_items'),75);
  assert.equal(f.count('project_chat_ai_jobs'),0);
});
test('остановка worker во время чтения CRM не допускает позднюю отправку',async t=>{
  const f=fixture(t,{fetchOverride:({chat})=>{chat.stopWorker();}});
  assert.equal((await f.run()).status,'stopped');assert.equal(f.messages().length,0);assert.equal(f.count('content_review_reminder_items'),0);
  assert.equal(f.runs()[0].status,'pending');
});
