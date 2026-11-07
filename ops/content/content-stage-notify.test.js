'use strict';
// specs/214-notification-delivery: рассылка по матрице «этап × роль» — выключатель, первый снимок, дедуп, получатели, изоляция.
// Никаких реальных отправок: push подменён записью в массив, CRM — функцией с заданными этапами.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store');
const {hashPassword}=require('./passwords');
const {createContentSettings}=require('./content-settings');
const {createPeopleNotifications}=require('./people-notifications');
const {createContentStageNotify}=require('./content-stage-notify');
const hash=hashPassword('Example-Only-Password-42');
const pushKeys={auth:Buffer.alloc(16,1).toString('base64url'),p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,2)]).toString('base64url')};

function setup(t,{peopleEnabled=false}={}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const auth=createAuthStore(db,`root:owner:${hash}`),owner=auth.getByLogin('root');
  const mk=(login,companies,permissions)=>auth.create(owner.id,{login,displayName:login,password:'x',companies,permissions},hash);
  const lena=mk('lena',['avokado'],['content-plan.approve','tasks.self.view']);  // согласующий
  const smm=mk('smm',['avokado'],['autoposting.edit','tasks.self.view']);         // контент
  const oper=mk('oper',['avokado'],['tasks.self.view']);                          // съёмка
  const cut=mk('cut',['avokado'],['tasks.self.view']);                            // монтажёр
  const tuner=mk('tuner',['avokado'],['settings.edit']);
  const alien=mk('alien',['alvi'],['content-plan.approve','tasks.self.view']);
  db.exec('CREATE TABLE IF NOT EXISTS company_team_members(user_id INTEGER PRIMARY KEY, company_code TEXT, staff_role TEXT, created_by INTEGER)');
  for(const u of [lena,smm,oper,cut])db.prepare("INSERT INTO company_team_members VALUES(?,?,'human_executor',?)").run(u.id,'avokado',owner.id);
  db.prepare("INSERT INTO company_team_members VALUES(?,?,'human_executor',?)").run(alien.id,'alvi',owner.id);
  const settings=createContentSettings({db,authStore:auth,requireSession:()=>{},requireCsrf:()=>{},readJson:async()=>({}),sendJson:()=>{}});
  const sent=[];
  // canReceive — как в people-service: владелец или исполнитель компании.
  const canReceive=(id,code)=>{const u=auth.getById(id);if(!u||!u.companyCodes.includes(code))return false;
    return u.role==='owner'||Boolean(db.prepare("SELECT 1 FROM company_team_members WHERE user_id=? AND company_code=? AND staff_role='human_executor'").get(id,code));};
  let notify;
  const notifications=createPeopleNotifications({db,authStore:auth,enabled:peopleEnabled,canReceive,
    sendPush:async item=>{sent.push(item);return {ok:true};},validateEvent:async e=>notify.validateEvent(e)});
  const stages={avokado:[],alvi:[]},calls=[];
  const call=async(action,args,actor,code)=>{calls.push({action,args,actor:actor.login,code});assert.equal(action,'contentStages');
    return {companyCode:code,shooting:Boolean(args.shootingFacts),ideas:stages[code].map((i,n)=>({number:n+1,topic:`Тема ${i[0]}`,date:'2026-11-10',ideaId:i[0],stage:i[1]}))};};
  const facts=code=>Buffer.from(JSON.stringify({v:1,companyCode:code,reels:{}})).toString('base64url');
  notify=createContentStageNotify({db,authStore:auth,settings,call,notifications,shootingFacts:facts,peopleDeliveryEnabled:peopleEnabled,cabinetUrl:'https://cabinet.test/cabinet.html'});
  const base={approverUserIds:[],shootingWeekdays:[],deadlineDays:2,platforms:[],caption:{font:'Inter',size:'m',color:'#ffffff',uppercase:false}};
  const configure=(code,over={},by=owner.id)=>{const v=settings.read(by,code).version;return settings.save(by,code,{version:v,settings:{...base,...over}});};
  const log=code=>db.prepare('SELECT * FROM content_stage_notify_log WHERE company_code=? ORDER BY id').all(code);
  const outbox=()=>db.prepare('SELECT * FROM people_notification_outbox ORDER BY id').all();
  return {db,auth,owner,lena,smm,oper,cut,tuner,alien,settings,notifications,notify,stages,calls,sent,configure,log,outbox};
}
const people=f=>({rolePeople:{content:[f.smm.id],shooting:[f.oper.id],editor:[f.cut.id]},approverUserIds:[f.lena.id]});

test('по умолчанию выключено: CRM не опрашивается, журнал и очередь пусты',async t=>{
  const f=setup(t,{peopleEnabled:true});
  f.configure('avokado',people(f));
  assert.equal(f.settings.read(f.owner.id,'avokado').settings.notificationDelivery,'off');
  f.stages.avokado=[['a','script_review']];await f.notify.runOnce();
  f.stages.avokado=[['a','planned']];await f.notify.runOnce();
  assert.equal(f.calls.length,0);assert.equal(f.log('avokado').length,0);assert.equal(f.outbox().length,0);
  await f.notifications.runOnce();assert.equal(f.sent.length,0);
});

test('пробный режим: первый проход только запоминает; переход — журнал по матрице, ни одной постановки в очередь',async t=>{
  const f=setup(t,{peopleEnabled:true});
  f.configure('avokado',{...people(f),notificationDelivery:'trial'});
  f.stages.avokado=[['a','script_review'],['b','planned']];
  await f.notify.runOnce();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].actor,'root','источник читается от владельца');
  assert.equal(f.log('avokado').length,0,'старые этапы при первом запуске не рассылаются');
  f.stages.avokado=[['a','planned'],['b','planned']];
  await f.notify.runOnce();
  const rows=f.log('avokado');
  // planned по умолчанию: контент + съёмка.
  assert.deepEqual(rows.map(r=>[r.user_id,r.roles,r.status,r.from_stage,r.to_stage]),[[f.smm.id,'content','trial','script_review','planned'],[f.oper.id,'shooting','trial','script_review','planned']]);
  assert.equal(rows[0].title,'№1 Тема a');
  assert.match(rows[0].body,/^Новый этап: Запланировано \(было: Сценарий на согласовании\)\. Открыть в кабинете: https:\/\/cabinet\.test\/cabinet\.html#content\/plan$/);
  assert.equal(f.outbox().length,0);await f.notifications.runOnce();assert.equal(f.sent.length,0);
  // Журнал отдаётся владельцу и настройщику; людям без settings.edit — нет.
  const view=f.notify.log(f.tuner.id,'avokado');assert.equal(view.items.length,2);assert.equal(view.items[0].person,'oper');assert.equal(view.mode,'trial');
  assert.throws(()=>f.notify.log(f.smm.id,'avokado'),{status:403});
});

test('матрица → получатели: роли берутся из настроек, общий человек получает одно сообщение с двумя ролями',async t=>{
  const f=setup(t);
  const matrix=Object.fromEntries(['script_review','script_rework','planned','shot','edit_review','edit_rework','ready','published','publish_error'].map(s=>[s,[]]));
  matrix.edit_review=['owner','approver','editor'];matrix.published=['owner','approver','content','shooting','editor'];
  f.configure('avokado',{rolePeople:{content:[f.smm.id],shooting:[f.smm.id],editor:[f.cut.id]},approverUserIds:[f.lena.id],notificationMatrix:matrix,notificationDelivery:'trial'});
  f.stages.avokado=[['a','shot']];await f.notify.runOnce();
  f.stages.avokado=[['a','edit_review']];await f.notify.runOnce();
  assert.deepEqual(f.log('avokado').map(r=>[r.user_id,r.roles]).sort((a,b)=>a[0]-b[0]),[[f.owner.id,'owner'],[f.lena.id,'approver'],[f.cut.id,'editor']].sort((a,b)=>a[0]-b[0]));
  f.stages.avokado=[['a','published']];await f.notify.runOnce();
  const pub=f.log('avokado').filter(r=>r.to_stage==='published');
  assert.equal(pub.find(r=>r.user_id===f.smm.id).roles,'content,shooting');
  assert.equal(pub.length,4);
  // Этап без людей в матрице — одна строка «нет получателей»; этап вне матрицы (В монтаже) — только запоминается.
  f.stages.avokado=[['a','editing']];await f.notify.runOnce();
  f.stages.avokado=[['a','ready']];await f.notify.runOnce();
  const ready=f.log('avokado').filter(r=>r.to_stage==='ready');
  assert.deepEqual(ready.map(r=>[r.user_id,r.status,r.from_stage]),[[0,'no_recipients','editing']]);
  assert.equal(f.log('avokado').filter(r=>r.to_stage==='editing').length,0);
});

test('дедуп: один раз на переход; повторный реальный переход туда же — новое событие; новая идея не рассылается',async t=>{
  const f=setup(t);
  f.configure('avokado',{...people(f),notificationDelivery:'trial'});
  f.stages.avokado=[['a','edit_review']];await f.notify.runOnce();
  f.stages.avokado=[['a','edit_rework']];await f.notify.runOnce();await f.notify.runOnce();await Promise.all([f.notify.runOnce(),f.notify.runOnce()]);
  assert.equal(f.log('avokado').length,1,'edit_rework → монтажёру, один раз');
  f.stages.avokado=[['a','edit_review']];await f.notify.runOnce();
  f.stages.avokado=[['a','edit_rework']];await f.notify.runOnce();
  const rework=f.log('avokado').filter(r=>r.to_stage==='edit_rework');
  assert.equal(rework.length,2);assert.notEqual(rework[0].event_key,rework[1].event_key);
  const before=f.log('avokado').length;
  f.stages.avokado=[['a','edit_rework'],['n','script_review']];await f.notify.runOnce();
  assert.equal(f.log('avokado').length,before,'появление идеи в плане — не переход');
  f.stages.avokado=[['a','edit_rework'],['n','script_rework']];await f.notify.runOnce();
  assert.equal(f.log('avokado').at(-1).to_stage,'script_rework');
});

test('включено: очередь people с согласием человека, отправка один раз, устаревшее событие не уходит',async t=>{
  const f=setup(t,{peopleEnabled:true});
  f.configure('avokado',{...people(f),notificationDelivery:'on'});
  f.notifications.setPreferences(f.cut.id,'avokado',{enabled:true,push:true,telegram:false});
  f.notifications.subscribe(f.cut.id,'avokado',{endpoint:'https://web.push.apple.com/cut',keys:pushKeys});
  f.stages.avokado=[['a','shot'],['b','shot']];await f.notify.runOnce();
  f.stages.avokado=[['a','edit_rework'],['b','edit_rework']];await f.notify.runOnce();
  const rows=f.log('avokado');
  assert.deepEqual(rows.map(r=>r.status),['queued','queued']);
  assert.equal(f.outbox().length,2);
  // b ушла дальше до доставки — её устаревшее «на доработке» отменяется проверкой источника.
  f.stages.avokado=[['a','edit_rework'],['b','edit_review']];await f.notify.runOnce();
  await f.notifications.runOnce();await f.notifications.runOnce();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].payload.title,'№1 Тема a');assert.equal(f.sent[0].payload.url,'/cabinet.html#content/plan');
  assert.equal(f.outbox().find(r=>r.event_key.includes(':b:1:')).error_code,'SOURCE_CHANGED');
  // Человек без согласия: журнал честно говорит «нет канала», в очередь ничего.
  const smm=f.log('avokado').filter(r=>r.user_id===f.smm.id);
  assert.ok(smm.length&&smm.every(r=>r.status==='no_channel'));
});

test('включено на компании, но доставка people на сервере выключена — в очередь не ставится',async t=>{
  const f=setup(t,{peopleEnabled:false});
  f.configure('avokado',{...people(f),notificationDelivery:'on'});
  f.notifications.setPreferences(f.cut.id,'avokado',{enabled:true,push:true,telegram:false});
  f.stages.avokado=[['a','shot']];await f.notify.runOnce();
  f.stages.avokado=[['a','edit_rework']];await f.notify.runOnce();
  assert.deepEqual(f.log('avokado').map(r=>r.status),['server_off']);assert.equal(f.outbox().length,0);
});

test('другая компания не получает: свои этапы, свои люди, свой выключатель',async t=>{
  const f=setup(t);
  f.configure('avokado',{...people(f),notificationDelivery:'trial'});
  f.configure('alvi',{approverUserIds:[f.alien.id]});  // alvi выключена
  f.stages.avokado=[['a','script_rework']];f.stages.alvi=[['a','script_rework']];
  await f.notify.runOnce();
  f.stages.avokado=[['a','script_review']];f.stages.alvi=[['a','script_review']];
  await f.notify.runOnce();
  assert.ok(f.calls.every(c=>c.code==='avokado'),'выключенная компания не опрашивается');
  assert.equal(f.log('alvi').length,0);
  const ids=f.log('avokado').map(r=>r.user_id);
  assert.ok(!ids.includes(f.alien.id));assert.deepEqual(ids.sort((a,b)=>a-b),[f.owner.id,f.lena.id].sort((a,b)=>a-b));
  // Человек другой компании не может быть назначен в роль.
  assert.throws(()=>f.configure('avokado',{rolePeople:{content:[f.alien.id],shooting:[],editor:[]}}),{status:400});
  // Событие с ключом одной компании не проходит проверку для другой.
  const key=f.log('avokado')[0].event_key;
  assert.equal(f.notify.validateEvent({userId:f.owner.id,companyCode:'alvi',eventKey:key}),false);
});

test('выключение сбрасывает снимок: повторное включение снова начинается без рассылки старых этапов',async t=>{
  const f=setup(t);
  f.configure('avokado',{...people(f),notificationDelivery:'trial'});
  f.stages.avokado=[['a','script_review']];await f.notify.runOnce();
  f.configure('avokado',{notificationDelivery:'off'});await f.notify.runOnce();
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM content_stage_snapshot').get().n,0);
  f.stages.avokado=[['a','planned']];
  f.configure('avokado',{notificationDelivery:'trial'});
  await f.notify.runOnce();assert.equal(f.log('avokado').length,0,'переход за время выключения не рассылается');
  // Быстрое «выкл → вкл» между проходами тоже даёт новый первый снимок (новая отметка включения).
  f.configure('avokado',{notificationDelivery:'off'});f.configure('avokado',{notificationDelivery:'trial'});
  f.stages.avokado=[['a','shot']];await f.notify.runOnce();
  assert.equal(f.log('avokado').length,0);
});

test('режим меняет только владелец; настройщик сохраняет прочее с прежним режимом',async t=>{
  const f=setup(t);
  assert.throws(()=>f.configure('avokado',{notificationDelivery:'on'},f.tuner.id),{status:403});
  f.configure('avokado',{notificationDelivery:'trial'});
  const saved=f.configure('avokado',{notificationDelivery:'trial',deadlineDays:5},f.tuner.id);
  assert.equal(saved.settings.notificationDelivery,'trial');assert.equal(saved.canDeliver,false);
  assert.equal(f.configure('avokado',{deadlineDays:6},f.tuner.id).settings.notificationDelivery,'trial','без ключа — прежний режим');
  assert.throws(()=>f.configure('avokado',{notificationDelivery:'loud'}),{status:400});
  assert.equal(f.settings.read(f.owner.id,'avokado').canDeliver,true);
});

test('обрезанные факты съёмки — проход пропускается, ложного отката этапа нет',async t=>{
  const f=setup(t);
  f.configure('avokado',{...people(f),notificationDelivery:'trial'});
  f.stages.avokado=[['a','shot']];await f.notify.runOnce();
  const notify=createContentStageNotify({db:f.db,authStore:f.auth,settings:f.settings,call:async()=>assert.fail('CRM не читается'),
    shootingFacts:()=>Buffer.from(JSON.stringify({v:1,companyCode:'avokado',truncated:true})).toString('base64url')});
  await notify.runOnce();
  assert.equal(f.db.prepare("SELECT stage FROM content_stage_snapshot WHERE idea_id='a'").get().stage,'shot');
});
