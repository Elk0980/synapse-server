'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createTeamChat}=require('./team-chat');
const {createMontageNotifications}=require('./montage-notifications');
const {createReelHughLog}=require('./reel-materials-chat');
const event=(id,extra={})=>({id,eventKey:`reel-edit:9:${id===1?'in_progress':'done'}`,companyCode:'avokado',authorId:'7',
  reelId:21,title:'SAMPLE ролик',kind:id===1?'in_progress':'done',text:id===1?'Правку взяли в работу.':'Версия v2 готова, посмотрите.',createdAt:'2026-11-21T10:00:00Z',...extra});
function fixture(t,enabled=true){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());createTeamChat({db,tasks:{},call:async()=>({})});
  const users=new Map([[7,{id:7,role:'editor',companyCodes:['avokado'],permissions:['autoposting.view']}]]);
  let events=[event(1),event(2)],bad=false,calls=0;
  const options={db,enabled,authStore:{getById:id=>users.get(id)},crmUrl:'http://crm',crmKey:'SAMPLE',fetchImpl:async(url,o)=>{
    calls++;assert.equal(o.redirect,'error');assert.equal(o.headers['x-api-key'],'SAMPLE');
    const after=Number(new URL(url).searchParams.get('after')),rows=events.filter(e=>e.id>after);
    return new Response(JSON.stringify(bad?{events:rows,nextAfter:99}:{enabled:true,events:rows,nextAfter:rows.at(-1)?.id||after}));
  }};
  return {db,users,options,worker:createMontageNotifications(options),calls:()=>calls,events:value=>events=value,bad:value=>bad=value};
}
test('кабинет без Telegram: оба перехода доходят только в личный Hugh автора; повтор, restart и прежний pull не дублируют',async t=>{
  const f=fixture(t);assert.equal((await f.worker.tick()).written,2);assert.equal((await f.worker.tick()).written,0);
  assert.equal((await createMontageNotifications(f.options).tick()).written,0);
  const rows=f.db.prepare('SELECT * FROM team_chat_messages').all();assert.equal(rows.length,2);
  assert.ok(rows.every(r=>r.room==='hugh:7'&&r.audience_id===7&&r.company_code==='avokado'&&r.user_id===0));
  assert.match(rows[0].text,/взяли в работу/);assert.match(rows[1].text,/v2 готова/);assert.match(rows[0].text,/materials\/reel\/21\?company=avokado/);
  const log=createReelHughLog({...f.options,notificationsEnabled:true,fetchImpl:async()=>({ok:true,json:async()=>({companyCode:'avokado',authorId:7,
    entries:[{key:'reel-edit:9:done',text:'SAMPLE прежний pull',from:'hugh'}]})})});
  await log.sync('avokado',{id:7});assert.equal(f.db.prepare('SELECT COUNT(*) n FROM team_chat_messages').get().n,2);
});
test('по умолчанию OFF: нет fetch, событий или фонового таймера; прежний pull не переносит новый in_progress',async t=>{
  const f=fixture(t,false);f.worker.start();await f.worker.tick();await f.worker.stop();assert.equal(f.calls(),0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='montage_notification_cursor'").get().n,0);
  const log=createReelHughLog({...f.options,notificationsEnabled:false,fetchImpl:async()=>({ok:true,json:async()=>({companyCode:'avokado',authorId:7,
    entries:[{key:'reel-edit:9:in_progress',from:'hugh',text:'SAMPLE'}]})})});
  assert.equal((await log.sync('avokado',{id:7})).written,0);
});
test('отозванный доступ, удалённый автор и другая компания не получают чужие события',async t=>{
  const f=fixture(t);f.events([event(1,{companyCode:'alvi'}),event(2,{authorId:'8'}),event(3,{authorId:'legacy-service'})]);await f.worker.tick();
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM team_chat_messages').get().n,0);
  f.users.get(7).permissions=[];f.events([event(4)]);await f.worker.tick();
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM team_chat_messages').get().n,0);
});
test('повреждённый feed и ошибка записи не продвигают курсор; повтор атомарно восстанавливает результат без дублей',async t=>{
  const f=fixture(t);f.bad(true);assert.equal((await f.worker.tick()).error,true);
  assert.equal(f.db.prepare('SELECT * FROM montage_notification_cursor').all().length,0);f.bad(false);
  f.db.exec("CREATE TRIGGER sample_abort BEFORE INSERT ON team_chat_messages WHEN NEW.client_id='reel-edit:9:done' BEGIN SELECT RAISE(ABORT,'SAMPLE');END");
  assert.equal((await f.worker.tick()).error,true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM team_chat_messages').get().n,0);
  f.db.exec('DROP TRIGGER sample_abort');assert.equal((await f.worker.tick()).written,2);
});
test('прежний pull успел получить done: поздний worker не добавляет устаревшее «взяли» после «готово»',async t=>{
 const f=fixture(t);
 const log=createReelHughLog({...f.options,notificationsEnabled:true,fetchImpl:async()=>({ok:true,json:async()=>({companyCode:'avokado',authorId:7,
  entries:[{key:'reel-edit:9:done',text:'SAMPLE готово',from:'hugh'}]})})});
 await log.sync('avokado',{id:7});await f.worker.tick();
 assert.deepEqual(f.db.prepare('SELECT client_id FROM team_chat_messages ORDER BY id').all().map(r=>r.client_id),['reel-edit:9:done']);
});
