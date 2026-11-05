'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {rollingWeekStart,createPeopleTelegramResolver}=require('./people-runtime');
const {DatabaseSync}=require('node:sqlite');
test('еженедельный интервал переносится на семь дней, timezone учитывает местный понедельник',()=>{
  const rule={timezone:'Asia/Irkutsk',weekStart:'2026-11-09'};
  assert.equal(rollingWeekStart(rule,'2026-11-03T10:00:00Z',Date.parse('2026-11-06T10:00:00Z')),'2026-11-09');
  assert.equal(rollingWeekStart(rule,'2026-11-03T10:00:00Z',Date.parse('2026-11-13T10:00:00Z')),'2026-11-16');
  assert.equal(rollingWeekStart(rule,'2026-11-03T10:00:00Z',Date.parse('2026-11-08T18:00:00Z')),'2026-11-16');
});
test('Telegram только existing member/link/exact Mini App bot ID и явная компания, без owner fallback',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE project_chat_members(user_id,company_code); CREATE TABLE project_chat_telegram_links(user_id,telegram_user_id);');
  const authStore={getById:()=>({companyCodes:['alvi']})};
  const env={PEOPLE_TELEGRAM_COMPANIES:'alvi',TELEGRAM_BOT_ID:'123',TELEGRAM_BOT_TOKEN:'123:synthetic-private-token'};
  const resolve=createPeopleTelegramResolver({db,authStore,env});
  assert.equal(resolve({userId:2,companyCode:'alvi'}),null);
  db.prepare('INSERT INTO project_chat_members VALUES(?,?)').run(2,'alvi');db.prepare('INSERT INTO project_chat_telegram_links VALUES(?,?)').run(2,'12345');
  assert.equal(resolve({userId:2,companyCode:'alvi'}).chatId,'12345');
  assert.equal(resolve({userId:2,companyCode:'avokado'}),null);
  env.TELEGRAM_BOT_ID='456';assert.equal(resolve({userId:2,companyCode:'alvi'}),null);
});

test('owner decision scheduler uses existing consent and push queue without Telegram or duplicate ticks',async t=>{
 const {createPeopleRuntime}=require('./people-runtime'),{createPeopleNotifications}=require('./people-notifications');
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE auth_users(id INTEGER PRIMARY KEY);INSERT INTO auth_users VALUES(1);CREATE TABLE company_team_members(user_id,company_code,staff_role)");
 const user={id:1,role:'owner',companyCodes:['alvi']},authStore={getById:()=>user};let eventKey='owner-decision:106:created',sent=[];
 const notifications=createPeopleNotifications({db,authStore,enabled:true,sendPush:async item=>{sent.push(item);return {ok:true};}});
 notifications.setPreferences(1,'alvi',{enabled:true,push:true,telegram:true});notifications.subscribe(1,'alvi',{endpoint:'https://web.push.apple.com/test',keys:{auth:Buffer.alloc(16,1).toString('base64url'),p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,2)]).toString('base64url')}});
 const runtime=createPeopleRuntime({db,authStore,tasks:{},notifications,enabled:true,call:async(action,args,actor,code)=>{
   assert.equal(action,'ownerDecisionEvents');assert.equal(actor.role,'owner');assert.equal(code,'alvi');return {events:[{taskId:Number(eventKey.split(':')[1]),eventKey,title:'Решение'}],nextOffset:null};
 }});t.after(()=>runtime.stop());
 await runtime.runOnce();assert.equal(sent.length,0,'first run is a baseline: an already open task is not pushed');
 eventKey='owner-decision:107:created';
 await Promise.all([runtime.runOnce(),runtime.runOnce()]);await runtime.runOnce();assert.equal(sent.length,1);assert.match(sent[0].payload.title,/Нужно ваше решение: №107 Решение/);assert.match(sent[0].payload.url,/company=alvi&task=107/);
 eventKey='owner-decision:106:blocker:2';await runtime.runOnce();assert.equal(sent.length,2);
 notifications.setPreferences(1,'alvi',{enabled:false,push:false,telegram:false});eventKey='owner-decision:106:blocker:3';await runtime.runOnce();assert.equal(sent.length,2);
});

test('owner decision baseline: existing open tasks are silent, only new events and changed blockers push',async t=>{
 const {createPeopleRuntime}=require('./people-runtime'),{createPeopleNotifications}=require('./people-notifications');
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE auth_users(id INTEGER PRIMARY KEY);INSERT INTO auth_users VALUES(1);CREATE TABLE company_team_members(user_id,company_code,staff_role)");
 const user={id:1,role:'owner',companyCodes:['alvi']},authStore={getById:()=>user},sent=[];
 const notifications=createPeopleNotifications({db,authStore,enabled:true,sendPush:async item=>{sent.push(item);return {ok:true};}});
 notifications.setPreferences(1,'alvi',{enabled:true,push:true,telegram:false});notifications.subscribe(1,'alvi',{endpoint:'https://web.push.apple.com/test',keys:{auth:Buffer.alloc(16,1).toString('base64url'),p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,2)]).toString('base64url')}});
 // Two pages of already open tasks for Vlad at the moment of the first start.
 let pages=[[{taskId:10,eventKey:'owner-decision:10:created',title:'Старая А'}],[{taskId:11,eventKey:'owner-decision:11:blocker:3',title:'Старая Б'}]],failPage=-1;
 const runtime=createPeopleRuntime({db,authStore,tasks:{},notifications,enabled:true,call:async(action,{offset})=>{
   const index=offset/100;if(index===failPage)throw new Error('CRM недоступна');
   return {events:pages[index],nextOffset:index+1<pages.length?offset+100:null};
 }});t.after(()=>runtime.stop());
 failPage=1;await runtime.runOnce();
 assert.equal(db.prepare('SELECT COUNT(*) n FROM people_owner_decision_baseline').get().n,0,'partial read does not create a baseline');
 assert.equal(sent.length,0,'partial first read sends nothing');
 failPage=-1;await runtime.runOnce();await runtime.runOnce();
 assert.equal(sent.length,0,'existing open tasks are treated as already sent');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM people_owner_decision_seen').get().n,2);
 pages[1]=[...pages[1],{taskId:12,eventKey:'owner-decision:12:created',title:'Новая'}];
 await runtime.runOnce();assert.equal(sent.length,1);assert.match(sent[0].payload.title,/№12 Новая/);
 pages[0]=[{taskId:10,eventKey:'owner-decision:10:blocker:5',title:'Старая А'}];
 await runtime.runOnce();assert.equal(sent.length,2);assert.match(sent[1].payload.title,/№10 Старая А/);
 await runtime.runOnce();assert.equal(sent.length,2,'no repeats');
 // A second device subscribed later does not receive the backlog again.
 notifications.subscribe(1,'alvi',{endpoint:'https://web.push.apple.com/second',keys:{auth:Buffer.alloc(16,3).toString('base64url'),p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,4)]).toString('base64url')}});
 await runtime.runOnce();assert.equal(sent.length,2);
});
