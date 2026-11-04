'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createTeamChat}=require('./team-chat');
const {createReelHughLog}=require('./reel-materials-chat');

const lena={id:7,displayName:'Лена',companyCodes:['avokado']};
const entries=[{key:'reel-edit:3:request',at:'2026-11-05T01:00:00.000Z',from:'user',text:'«Рилс» — Хью, измени (v1, 5.0–7.5 с): ярче'},
  {key:'reel-edit:3:done',at:'2026-11-05T01:30:00.000Z',from:'hugh',text:'Исправлено: «Рилс» — готова v2'},
  {key:'evil:1',from:'hugh',text:'не из «Материалов»'}];
function fixture({rooms=true,body}={}){
  const db=new DatabaseSync(':memory:');
  createTeamChat({db,tasks:{},call:async()=>({})}); // схема рабочего чата как на main (PR 480)
  if(rooms)for(const sql of ["room TEXT NOT NULL DEFAULT 'common'","kind TEXT NOT NULL DEFAULT 'message'",'ref_task_id INTEGER','audience_id INTEGER'])
    db.exec('ALTER TABLE team_chat_messages ADD COLUMN '+sql); // миграция комнат PR 504
  const calls=[];let clock=1000;
  const fetchImpl=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>body??{companyCode:'avokado',authorId:7,entries}};};
  const log=createReelHughLog({db,crmUrl:'http://crm',crmKey:'k',fetchImpl,now:()=>clock,warn:()=>{}});
  return {db,log,calls,tick:ms=>{clock+=ms;}};
}
const rows=db=>db.prepare('SELECT user_id,author_name,text,client_id,room,kind,audience_id FROM team_chat_messages ORDER BY id').all().map(r=>({...r}));

test('Лог правок попадает в личную комнату hugh:<id>: запрос от пользователя, «Исправлено» от Хью; повтор без дублей',async()=>{
  const f=fixture();
  assert.deepEqual(await f.log.sync('avokado',lena,{force:true}),{written:2});
  assert.match(f.calls[0].url,/\/internal\/reel-materials\/hugh-log\?companyCode=avokado&authorId=7$/);assert.equal(f.calls[0].options.headers['x-api-key'],'k');
  assert.deepEqual(rows(f.db),[
    {user_id:7,author_name:'Лена',text:entries[0].text,client_id:'reel-edit:3:request',room:'hugh:7',kind:'reel-edit',audience_id:7},
    {user_id:0,author_name:'Хью · ИИ',text:entries[1].text,client_id:'reel-edit:3:done',room:'hugh:7',kind:'reel-edit-result',audience_id:7}]);
  assert.deepEqual(await f.log.sync('avokado',lena,{force:true}),{written:0});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM team_chat_messages WHERE room='common'").get().n,0,'в общий чат лог не попадает');
});

test('Без комнат чата (PR 504 не выпущен) запись пропускается и не падает; CRM не вызывается',async()=>{
  const f=fixture({rooms:false});
  assert.deepEqual(await f.log.sync('avokado',lena,{force:true}),{written:0,skipped:'NO_ROOMS'});
  assert.equal(f.calls.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM team_chat_messages').get().n,0);
  assert.equal(await f.log.afterProxy('/autoposting/reels/1/edits','POST',201,'avokado',lena).then(r=>r.skipped),'NO_ROOMS');
});

test('Хуки: только «Материалы» с 2xx, чтения не чаще 15 с, чужой ответ CRM и чужая комната отклоняются',async()=>{
  const f=fixture();
  assert.equal(await f.log.afterProxy('/autoposting/posts','GET',200,'avokado',lena),null);
  assert.equal(await f.log.afterProxy('/autoposting/reels/1/edits','POST',400,'avokado',lena),null);
  assert.deepEqual(await f.log.afterProxy('/autoposting/reels/1','GET',200,'avokado',lena),{written:2});
  assert.equal((await f.log.afterProxy('/autoposting/reels/1','GET',200,'avokado',lena)).skipped,'RECENT');
  assert.equal((await f.log.afterProxy('/autoposting/reels/1/edits','POST',201,'avokado',lena)).written,0,'запись правки синхронизируется сразу');
  assert.equal(f.calls.length,2);
  const session=user=>()=>({user});
  const url=room=>new URL(`http://c/content/people/team-chat?companyCode=avokado&room=${room}`);
  assert.equal(await f.log.beforePeople({method:'GET'},url('hugh:8'),session(lena)),null,'чужая комната');
  assert.equal(await f.log.beforePeople({method:'GET'},url('common'),session(lena)),null);
  assert.equal(await f.log.beforePeople({method:'GET'},url('hugh:7'),session({...lena,companyCodes:['alvi']})),null,'чужая компания');
  assert.equal(await f.log.beforePeople({method:'GET'},url('hugh:7'),()=>{throw Object.assign(Error('401'),{status:401});}),null);
  f.tick(16000);assert.equal((await f.log.beforePeople({method:'GET'},url('hugh:7'),session(lena))).written,0);assert.equal(f.calls.length,3);
  const wrong=fixture({body:{companyCode:'alvi',authorId:7,entries}});
  assert.equal((await wrong.log.afterProxy('/autoposting/reels','GET',200,'avokado',lena)).skipped,'ERROR');assert.equal(rows(wrong.db).length,0);
});
