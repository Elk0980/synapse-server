'use strict';
// №166: карточка рилса и итоги публикации в общем чате компании — настоящая схема и выдача team-chat.js.
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createTeamChat}=require('./team-chat');
const {createReelChatApprovalSync,itemLine}=require('./reel-chat-approval');

const media='https://synapse.synapsebusiness.ru/content/publishing-assets/avokado/'+'a'.repeat(32)+'.mp4';
const approval=over=>({id:3,companyCode:'avokado',reelId:8,version:2,postId:40,title:'Рилс №1',caption:'Подпись',mediaUrl:media,durationMs:12000,
  platforms:[{id:'instagram',label:'Instagram'},{id:'vk',label:'ВКонтакте'}],requestedBy:{id:5,name:'СММ'},requestedAt:'2026-11-05T10:00:00.000Z',
  status:'pending',statusLabel:'Ждёт согласования',open:true,scheduledAt:null,approvedBy:null,approvedAt:null,returned:null,edit:null,
  publication:{items:[{platformId:'instagram',label:'Instagram',state:'none'},{platformId:'vk',label:'ВКонтакте',state:'none'}],done:false},...over});
function fixture(t,{rooms=true}={}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  // Участники: СММ(5) и Лена(9) в avokado, Петя(4) в alvi.
  const people={5:{name:'СММ',codes:['avokado']},9:{name:'Лена',codes:['avokado']},4:{name:'Петя',codes:['alvi']}};
  const tasks={access(id,code){const p=people[id];if(!p||!p.codes.includes(code))throw Object.assign(Error('denied'),{status:403});return {id,displayName:p.name,role:'editor'};}};
  if(rooms)createTeamChat({db,tasks,call:async()=>({})});
  else db.exec(`CREATE TABLE team_chat_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,company_code TEXT NOT NULL,user_id INTEGER NOT NULL,author_name TEXT NOT NULL,
    text TEXT NOT NULL,client_id TEXT NOT NULL,created_at TEXT NOT NULL,task_id INTEGER,command_state TEXT NOT NULL DEFAULT 'none',UNIQUE(company_code,user_id,client_id))`);
  const chat=rooms?createTeamChat({db,tasks,call:async()=>({})}):null;
  let body={approvals:[approval()]},clock=100000,status=200;const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});return {ok:status===200,status,json:async()=>body};};
  const sync=createReelChatApprovalSync({db,crmUrl:'http://crm',crmKey:'k',fetchImpl,now:()=>clock,warn:()=>{}});
  return {db,chat,sync,calls,set:value=>{body=value;},fail:code=>{status=code;},tick:ms=>{clock+=ms;}};
}

test('Карточка появляется в общем чате один раз, видна участникам компании, статус обновляется в том же сообщении',async t=>{
  const f=fixture(t);
  assert.deepEqual(await f.sync.sync('avokado'),{written:1});
  assert.equal(f.calls[0].url,'http://crm/internal/reel-materials/chat-approvals?companyCode=avokado');
  assert.deepEqual(f.calls[0].options.headers,{'x-api-key':'k'},'только ключ сервиса, без личности браузера');
  const seen=f.chat.list(9,'avokado').messages;
  assert.equal(seen.length,1);assert.equal(seen[0].kind,'reel-approval');assert.equal(seen[0].user_id,5);assert.equal(seen[0].author_name,'СММ');
  const card=JSON.parse(seen[0].payload);
  assert.deepEqual([card.approvalId,card.reelId,card.version,card.mediaUrl,card.status,card.open],[3,8,2,media,'pending',true]);
  assert.match(seen[0].text,/На согласование: рилс «Рилс №1» v2 — Instagram, ВКонтакте/);
  assert.throws(()=>f.chat.list(4,'avokado'),{status:403},'другая компания не читает карточку');
  assert.equal((await f.sync.sync('avokado')).skipped,'RECENT','повтор не чаще интервала');
  f.set({approvals:[approval({status:'approved',statusLabel:'Согласовано — ждёт публикации',open:false,approvedBy:'Лена',approvedAt:'2026-11-05T10:05:00.000Z'})]});
  assert.deepEqual(await f.sync.sync('avokado',{force:true}),{written:1});
  const after=f.chat.list(5,'avokado').messages;
  assert.equal(after.length,1,'статус меняется в той же карточке');
  assert.equal(JSON.parse(after[0].payload).approvedBy,'Лена');assert.match(after[0].text,/Согласовал\(а\): Лена/);
  assert.deepEqual(await f.sync.sync('avokado',{force:true}),{written:0},'без изменений ничего не пишется');
});

test('Итоги публикации: одно сообщение на новые итоги, ссылки только https из CRM, Onlypult — ID без ссылки, без повторов',async t=>{
  const f=fixture(t);await f.sync.sync('avokado');
  const items=[{platformId:'instagram',label:'Instagram',state:'published',url:null,source:'onlypult',providerPostId:'op123'},
    {platformId:'vk',label:'ВКонтакте',state:'pending',source:'direct'}];
  f.set({approvals:[approval({status:'publishing',publication:{items,done:false}})]});
  await f.sync.sync('avokado',{force:true});
  let messages=f.chat.list(9,'avokado').messages.filter(m=>m.kind==='reel-published');
  assert.equal(messages.length,1);
  assert.equal(messages[0].text,'Рилс «Рилс №1» опубликован:\nInstagram: опубликовано, ссылка недоступна (ID задания Onlypult op123)');
  await f.sync.sync('avokado',{force:true});
  assert.equal(f.chat.list(9,'avokado').messages.filter(m=>m.kind==='reel-published').length,1,'повтор синхронизации не дублирует');
  items[1]={platformId:'vk',label:'ВКонтакте',state:'published',url:'https://vk.com/wall-1_2',source:'direct',externalId:'-1_2'};
  items.push({platformId:'telegram',label:'Telegram',state:'failed',error:'площадка не подтвердила публикацию'},
    {platformId:'max',label:'MAX',state:'published',url:'javascript:alert(1)',source:'direct',externalId:'77'});
  f.set({approvals:[approval({status:'partial',publication:{items,done:true}})]});
  await f.sync.sync('avokado',{force:true});
  messages=f.chat.list(5,'avokado').messages.filter(m=>m.kind==='reel-published');
  assert.equal(messages.length,2);
  assert.equal(messages[1].text,['Рилс «Рилс №1» — итоги публикации:','ВКонтакте: https://vk.com/wall-1_2',
    'Telegram: ошибка публикации — площадка не подтвердила публикацию','MAX: опубликовано, ссылка недоступна (ID 77)'].join('\n'),'небезопасная ссылка не показывается');
  assert.deepEqual(JSON.parse(messages[1].payload).items.map(i=>i.url),['https://vk.com/wall-1_2',null,null]);
  assert.equal(itemLine({label:'Instagram',state:'published',url:'https://www.instagram.com/reel/AbCdE12345/',source:'receipt'}),'Instagram: https://www.instagram.com/reel/AbCdE12345/ (ссылка подтверждена вручную)');
  assert.equal(itemLine({label:'YouTube Shorts',state:'uncertain',error:'проверьте вручную'}),'YouTube Shorts: результат не подтверждён — проверьте вручную');
});

test('Изоляция и отказоустойчивость: ответ другой компании не пишется, ошибка CRM не роняет чат, без комнат — пропуск',async t=>{
  const f=fixture(t);
  f.set({approvals:[approval({companyCode:'alvi'}),approval({id:4,companyCode:'Avokado'}),approval({id:5,requestedBy:{id:0}})]});
  assert.deepEqual(await f.sync.sync('avokado'),{written:0});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM team_chat_messages').get().n,0);
  f.fail(503);
  const request={method:'GET',headers:{}},url=new URL('https://x/content/people/team-chat?companyCode=avokado');
  f.tick(20000);
  assert.deepEqual(await f.sync.beforePeople(request,url,()=>({user:{companyCodes:['avokado']}})),{written:0,skipped:'ERROR'});
  assert.equal(await f.sync.beforePeople(request,new URL('https://x/content/people/team-chat?companyCode=alvi'),()=>({user:{companyCodes:['avokado']}})),null,'чужая компания — CRM не вызывается');
  assert.equal(await f.sync.beforePeople(request,url,()=>{throw Object.assign(Error('no'),{status:401});}),null);
  assert.equal(await f.sync.afterProxy('/autoposting/reels/8/chat-approvals','GET',200,'avokado'),null);
  assert.equal(await f.sync.afterProxy('/leads/1','POST',200,'avokado'),null);
  const calls=f.calls.length;f.fail(200);
  await f.sync.afterProxy('/autoposting/reels/8/chat-approvals/3/approve','POST',200,'avokado');
  assert.equal(f.calls.length,calls+1,'решение кнопки синхронизируется сразу');
  const bare=fixture(t,{rooms:false});
  assert.deepEqual(await bare.sync.sync('avokado'),{written:0,skipped:'NO_ROOMS'});assert.equal(bare.calls.length,0);
  const noKey=createReelChatApprovalSync({db:f.db,crmUrl:'',crmKey:''});
  assert.equal((await noKey.sync('avokado')).skipped,'NO_CRM');noKey.start();noKey.stop();
});
