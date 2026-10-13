'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSocialMaxStats}=require('./social-max-stats');
const NOW=Date.parse('2026-10-13T12:00:00Z'),DAY='2026-10-12',CHAT='-72000000000000001',AT=Date.parse('2026-10-12T10:00:00Z');
function fixture(t,{knownPosts=()=>[],pages,channel,options={}}={}){
 const state={revision:1,fingerprint:'max:1:'+CHAT,ready:true};const calls=[];
 const envelope=(company,data)=>({companyCode:company,chatId:CHAT,accessRevision:state.revision,observedAt:new Date(NOW).toISOString(),data});
 const access={ready:()=>({ok:state.ready,chatId:CHAT,accountRef:CHAT,accessRevision:state.revision}),bindingFingerprint:()=>state.fingerprint,
  readChannel:async(company,opt)=>channel?channel({company,opt,envelope,state}):envelope(company,{chat_id:CHAT,type:'channel',status:'active',participants_count:42}),
  readMessages:async(company,q,opt)=>{calls.push(q);return pages?pages({company,q,opt,envelope,state,calls}):envelope(company,{messages:[]})}};
 const stats=createSocialMaxStats({access,knownPosts,now:()=>NOW,...options});t.after(()=>stats.stop());
 return {stats,state,calls,envelope,run:(input={})=>stats.collectDate({companyCode:'max-a',date:DAY,timezone:'UTC',...input})};
}
const message=(mid='mid.native_1',ts=AT,views=10,chat=CHAT)=>({recipient:{chat_id:chat,chat_type:'channel'},timestamp:ts,body:{mid,text:'PRIVATE-TEXT',attachments:['PRIVATE-MEDIA']},sender:{user_id:111,name:'PRIVATE-NAME'},stat:views===null?null:{views}});

test('текущий состав и lifetime просмотры датируются наблюдением, не целевыми прошлыми сутками; PII отсутствует',async t=>{
 const f=fixture(t,{pages:({company,envelope})=>envelope(company,{messages:[message()]})});const r=await f.run();
 assert.equal(r.status,'partial');assert.equal(r.snapshots[0].date,'2026-10-13');assert.equal(r.snapshots[0].period,'lifetime');assert.equal(r.snapshots[0].value,42);
 assert.equal(r.posts[0].platformPostId,'mid.native_1');assert.equal(r.posts[0].publishedAt,new Date(AT).toISOString());assert.equal(r.posts[0].metrics[0].date,'2026-10-13');assert.equal(r.posts[0].metrics[0].period,'lifetime');assert.equal(r.posts[0].metrics[0].value,10);
 for(const secret of ['PRIVATE-TEXT','PRIVATE-MEDIA','PRIVATE-NAME','sender','user_id'])assert.equal(JSON.stringify(r).includes(secret),false);
 assert.equal(r.coverage.historyDaily,'unavailable');assert.equal(r.retryable,false);
});
test('нет stat или неподдерживаемые поля не дают выдуманные просмотры/reposts и истинный ноль истории',async t=>{
 const m=message();m.stat={reposts:99};const f=fixture(t,{pages:({company,envelope})=>envelope(company,{messages:[m]})});const r=await f.run();
 assert.equal(r.posts[0].metrics[0].value,null);assert.equal(r.posts[0].metrics[0].completeness,'partial');assert.equal(r.posts[0].metrics.length,1);assert.equal(r.status,'partial');
});
test('истинный native ноль участников сохраняется, отсутствующий счётчик остаётся без значения',async t=>{
 const f=fixture(t,{channel:({company,envelope})=>envelope(company,{chat_id:CHAT,type:'channel',status:'active',participants_count:0})});assert.equal((await f.run()).snapshots[0].value,0);
 const absent=fixture(t,{channel:({company,envelope})=>envelope(company,{chat_id:CHAT,type:'channel',status:'active'})});const r=await absent.run();assert.equal(r.snapshots.length,0);assert.equal(r.status,'partial');
});
test('чужая компания/native receiver отвергает результат целиком, без публикационных строк',async t=>{
 const wrong=fixture(t,{pages:({envelope})=>envelope('max-b',{messages:[message()]})});const r=await wrong.run();assert.equal(r.posts.length,0);assert.equal(r.snapshots.length,0);assert.equal(r.status,'missing_access');
 const wrongChat=fixture(t,{pages:({company,envelope})=>envelope(company,{messages:[message('native',AT,10,'-2')]})});const c=await wrongChat.run();assert.equal(c.posts.length,0);assert.equal(c.snapshots.length,0);assert.equal(c.status,'missing_access');
});
test('изменение сохранённой привязки после сети не выдаёт прежние значения',async t=>{
 const f=fixture(t,{pages:({company,envelope,state})=>{state.fingerprint='new-native-binding';return envelope(company,{messages:[message()]})}});const r=await f.run();assert.equal(r.status,'missing_access');assert.equal(r.snapshots.length,0);assert.equal(r.posts.length,0);
});
test('known native IDs обновляются отдельно, latest observation не складывает просмотры',async t=>{
 const earlier=AT-86400000;const knownPosts=()=>[{platformPostId:'mid.older',publishedAt:new Date(earlier).toISOString()}];
 const f=fixture(t,{knownPosts,pages:({company,q,envelope})=>envelope(company,{messages:q.messageIds?[message('mid.older',earlier,25)]:[message()]})});const r=await f.run();
 assert.ok(f.calls.some(q=>q.messageIds?.[0]==='mid.older'));assert.equal(r.posts.length,2);assert.equal(r.posts.find(p=>p.platformPostId==='mid.older').metrics[0].value,25);assert.equal(r.coverage.knownPostRefresh,'complete');
});
test('известный ID с другим временем публикации не повышает охват',async t=>{
 const knownPosts=()=>[{platformPostId:'mid.native_1',publishedAt:new Date(AT-1).toISOString()}];const f=fixture(t,{knownPosts,pages:({company,envelope})=>envelope(company,{messages:[message()]})});const r=await f.run();assert.equal(r.posts.length,0);assert.equal(r.coverage.knownPostRefresh,'partial');
});
test('полная граница100 постов с одинаковым timestamp остаётся неполной и ограничивает запросы',async t=>{
 const list=Array.from({length:100},(_,i)=>message('mid.post_'+i));const f=fixture(t,{pages:({company,envelope})=>envelope(company,{messages:list})});const r=await f.run();
 assert.equal(r.coverage.postIndex,'partial');assert.equal(r.status,'partial');assert.ok(f.calls.length<=2);assert.ok(r.missing.some(s=>s.includes('границ')));
});
test('DST календарные UTC-границы сохраняют реальные23 часа, не сутки в86400000мс',async t=>{
 const f=fixture(t);const r=await f.run({date:'2026-03-08',timezone:'America/Los_Angeles'});
 assert.equal(Date.parse(r.coverage.dayEndUtc)-Date.parse(r.coverage.dayStartUtc),23*3600000);
});
test('невалидная дата/future/zone отклоняются до запросов',async t=>{
 const f=fixture(t);await assert.rejects(f.run({date:'2026-02-30'}));await assert.rejects(f.run({date:'2027-01-01'}));await assert.rejects(f.run({timezone:'invalid/Zone'}));assert.equal(f.calls.length,0);
});

test('forwarded пост без native MID оставляет индекс partial, сохраняя другие доступные посты',async t=>{
 const forward=message();forward.body=null;
 const f=fixture(t,{pages:({company,envelope})=>envelope(company,{messages:[message(),forward]})});const r=await f.run();
 assert.equal(r.posts.length,1);assert.equal(r.coverage.postIndex,'partial');assert.equal(r.snapshots[0].value,42);
});

test('UTC ms не угадываются как секунды: epoch timestamp хранится как1970 дата без ложной полной истории',async t=>{
 const f=fixture(t,{pages:({company,envelope})=>envelope(company,{messages:[message('mid.epoch',0,1)]})});const r=await f.run({date:'1970-01-01'});
 assert.equal(r.posts[0].publishedAt,'1970-01-01T00:00:00.000Z');assert.equal(r.status,'partial');assert.ok(f.calls.every(q=>q.after===undefined||q.after>=0));
});
test('stop завершает зависший whole collect, late ответ не принимается',async t=>{
 let release;const f=fixture(t,{channel:()=>new Promise(resolve=>{release=resolve})});const run=f.run();const rejection=assert.rejects(run,{code:'STOPPED'});await new Promise(resolve=>setImmediate(resolve));await f.stats.stop();await rejection;
 release(f.envelope('max-a',{chat_id:CHAT,type:'channel',status:'active',participants_count:99}));await assert.rejects(f.run(),{code:'STOPPED'});
});
