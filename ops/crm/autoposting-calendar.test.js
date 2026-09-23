'use strict';
/* Календарь автопостинга: чтение месяца по реальным данным компании, плана и карточек.
   Проверяется именно то, что обещает ответ: даты в часовом поясе компании, честная готовность
   по площадкам, покрытие текущего контент-плана и полное отсутствие записи в базу. */
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting,CALENDAR_UNDATED_LIMIT}=require('./autoposting');
const {createMediaMentor}=require('./media-mentor');
const {createMediaMentorTransfer}=require('./media-mentor-transfer');

const OWNER={userId:7,userName:'Владелец'};
const MEDIA='https://cdn.example.com/photo.jpg';
const MONTH={from:'2026-10-01',to:'2026-10-31'};
const day=(date,platform,topic)=>({date,platform,format:'post',role:'reach',topic});

function fixture(t,{mentorTables=true}={}) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,
    timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'alvi','ALVI','Asia/Irkutsk','[]'),(2,'avokado','Авокадо','UTC','[]');`);
  // 2026-09-30 20:00 UTC — это уже 1 октября в Иркутске: календарь обязан показывать день компании.
  let time=Date.parse('2026-09-30T20:00:00Z');
  const channels=[{id:'telegram',platform:'telegram',name:'Telegram',enabled:true,connected:true,revision:1,
    caps:{maxText:4096,maxMedia:10,mediaMode:'photos',maxCaption:1024}},
    {id:'vk',platform:'vk',name:'ВКонтакте',enabled:true,connected:true,revision:1,caps:{maxText:15000,maxMedia:1,mediaMode:'link'}}];
  const settingsCalls=[],sideEffects=[];
  const information=createCompanyInformation(db,{now:()=>time});
  const transport={getSettings:async code=>{settingsCalls.push(code);return {channels:structuredClone(channels)};},
    publish:async input=>{sideEffects.push(['publish',input]);return {externalId:'never'};},
    reconcile:async input=>{sideEffects.push(['reconcile',input]);return null;}};
  const api=createAutoposting(db,{information,transport,now:()=>time,logger:{warn(){}}});
  const mentor=mentorTables?createMediaMentor(db,{now:()=>time}):null;
  const transfer=mentor?createMediaMentorTransfer(db,{mentor,autoposting:api,information,now:()=>time}):null;

  function savePlan(code,days,platforms=['telegram','vk']) {
    const before=mentor.get(code);
    mentor.saveBrief(code,{revision:before.brief.revision,brief:{goal:'Рост записи',platforms,assets:[]}},OWNER);
    const snapshot=mentor.get(code);
    mentor.savePlan(code,{planRevision:snapshot.plan?snapshot.plan.revision:0,briefRevision:snapshot.brief.revision,days},OWNER);
    return mentor.get(code);
  }
  function approvePlan(code,decision='approved') {
    const snapshot=mentor.get(code);
    mentor.decide(code,{planRevision:snapshot.plan.revision,briefRevision:snapshot.brief.revision,decision,comment:'Решение владельца'},OWNER);
  }
  function runTransfer(code) {
    const snapshot=mentor.get(code);
    return transfer.transfer(code,{planRevision:snapshot.plan.revision,briefRevision:snapshot.brief.revision},OWNER);
  }
  function fill(id,code='alvi',patch={}) {
    const card=api.get(id,code);
    return api.update(id,code,{revision:card.revision,text:'Подтверждённый текст записи',mediaUrls:[MEDIA],platformIds:['telegram'],...patch});
  }
  function makeReady(id,code='alvi',patch={}) {
    const card=fill(id,code,patch);
    return api.approve(id,code,{revision:card.revision,approved:true,comment:''},OWNER);
  }
  const insert=db.prepare(`INSERT INTO autoposting_posts(company_id,status,title,text,media_urls,platform_ids,scheduled_at,timezone,
    profile_revision,created_at,updated_at,content_revision,approved_revision,sort_order)
    VALUES(?,'draft',?,'Готовый текст',?,'["telegram"]',?,'Asia/Irkutsk',?,?,?,1,1,?)`);
  function seed(count,scheduledAt,start=0) {
    const profileRevision=information.get('alvi').revision,stamp=new Date(time).toISOString();
    for(let index=0;index<count;index++)insert.run(1,`Карточка ${start+index}`,JSON.stringify([MEDIA]),scheduledAt,profileRevision,stamp,stamp,start+index+1);
  }
  const changes=()=>db.prepare('SELECT total_changes() n').get().n;
  return {db,api,information,mentor,transfer,channels,settingsCalls,sideEffects,savePlan,approvePlan,runTransfer,
    fill,makeReady,seed,changes,advance:ms=>{time+=ms;},now:()=>time};
}
const dayOf=(result,date)=>result.coverage.days.find(item=>item.date===date);
const groupOf=(result,date,platform)=>dayOf(result,date).platforms.find(item=>item.platform===platform);
const postOf=(result,id)=>result.posts.find(item=>item.id===id);

test('календарь отдаёт согласованный контракт, полную карточку и только выбранную компанию',async t=>{
  const f=fixture(t);
  f.savePlan('alvi',[day('2026-10-01','telegram','Запуск'),day('2026-10-05','telegram','Отзыв'),day('2026-10-10','telegram','Итог')]);
  f.approvePlan('alvi');
  const moved=f.runTransfer('alvi');
  f.makeReady(moved.posts[0].id);
  const result=await f.api.calendar('alvi',MONTH);
  assert.deepEqual(Object.keys(result).sort(),['companyCode','coverage','from','posts','summary','timezone','to','today',
    'truncated','undated','undatedTotal','undatedTruncated'].sort());
  assert.equal(result.companyCode,'alvi');assert.equal(result.from,'2026-10-01');assert.equal(result.to,'2026-10-31');
  assert.equal(result.timezone,'Asia/Irkutsk');assert.equal(result.today,'2026-10-01');
  assert.equal(result.truncated,false);assert.equal(result.undatedTruncated,false);assert.equal(result.undatedTotal,0);
  assert.equal(result.coverage.days.length,31);
  assert.deepEqual(result.coverage.days.map(item=>item.date)[0],'2026-10-01');
  assert.deepEqual(Object.keys(result.coverage).sort(),['basis','days','guaranteedDays','planApproval','planRevision','uncoveredDates','unknownDates'].sort());
  assert.deepEqual(result.summary,{targetDays:14,minimumDays:7,criticalBelowDays:3,readyPosts:1,pendingPosts:0,missingPosts:2,
    knownPlanDays:3,coveredPlanDays:1,stockDays:null});
  const card=postOf(result,moved.posts[0].id);
  // Существующий DTO остаётся целиком: календарь только добавляет поля.
  for(const key of ['id','companyCode','revision','contentRevision','status','title','text','mediaUrls','platformIds','scheduledAt',
    'timezone','dayKey','captions','origin','readiness','approval','meta','review','history','labels','captionLimits',
    'externalReceipts','deliveries','profileRevision','createdAt','updatedAt'])assert.ok(Object.hasOwn(card,key),`нет поля ${key}`);
  assert.equal(card.text,'Подтверждённый текст записи');assert.deepEqual(card.mediaUrls,[MEDIA]);
  assert.equal(card.plannedDate,'2026-10-01');assert.equal(card.planPlatform,'telegram');
  assert.equal(card.publishDate,null);assert.equal(card.effectiveDate,'2026-10-01');assert.equal(card.dateKind,'plan');
  assert.deepEqual(Object.keys(card.calendarReadiness).sort(),['issues','platforms','ready','state'].sort());
  assert.equal(card.calendarReadiness.state,'ready');assert.equal(card.calendarReadiness.ready,true);
  assert.deepEqual(card.calendarReadiness.issues,[]);
  assert.deepEqual(card.calendarReadiness.platforms,[{platform:'telegram',state:'ready',ready:true,issues:[]}]);
  const other=await f.api.calendar('avokado',MONTH);
  assert.deepEqual(other.posts,[]);assert.deepEqual(other.undated,[]);assert.equal(other.coverage.basis,'none');
  await assert.rejects(f.api.calendar('unknown-company',MONTH),error=>error.status===404);
});

test('период проверяется строго: несуществующие, перевёрнутые и слишком длинные даты отклоняются',async t=>{
  const f=fixture(t);
  const bad=value=>assert.rejects(f.api.calendar('alvi',value),error=>error.status===400);
  await bad(undefined);await bad({});await bad({from:'2026-10-01'});await bad({to:'2026-10-05'});
  await bad({from:'2026-10-01',to:'2026-10-05',extra:1});
  await bad({from:'01.10.2026',to:'2026-10-05'});await bad({from:'2026-10-1',to:'2026-10-05'});
  await bad({from:'2026-13-01',to:'2026-13-05'});await bad({from:'2026-02-30',to:'2026-03-01'});
  await bad({from:'2025-02-29',to:'2025-03-01'});await bad({from:2026,to:'2026-10-05'});
  await bad({from:'2026-10-05',to:'2026-10-01'});
  await bad({from:'2026-10-01',to:'2026-11-01'});
  const leap=await f.api.calendar('alvi',{from:'2024-02-01',to:'2024-02-29'});
  assert.equal(leap.coverage.days.length,29);assert.equal(leap.coverage.days.at(-1).date,'2024-02-29');
  const month=await f.api.calendar('alvi',MONTH);assert.equal(month.coverage.days.length,31);
  const single=await f.api.calendar('alvi',{from:'2026-10-07',to:'2026-10-07'});
  assert.deepEqual(single.coverage.days.map(item=>item.date),['2026-10-07']);
});

test('дата берётся из часового пояса компании сейчас, а не из UTC и не из пояса старой карточки',async t=>{
  const f=fixture(t);
  f.seed(1,'2026-10-05T18:00:00Z');
  const id=f.db.prepare('SELECT id FROM autoposting_posts').get().id;
  // Пояс на самой карточке устарел: календарь обязан считать день по текущей компании.
  f.db.prepare("UPDATE autoposting_posts SET timezone='America/New_York' WHERE id=?").run(id);
  const irkutsk=await f.api.calendar('alvi',MONTH);
  assert.equal(irkutsk.timezone,'Asia/Irkutsk');assert.equal(irkutsk.today,'2026-10-01');
  assert.equal(postOf(irkutsk,id).publishDate,'2026-10-06');
  assert.equal(postOf(irkutsk,id).effectiveDate,'2026-10-06');
  assert.equal(postOf(irkutsk,id).dateKind,'schedule');
  assert.deepEqual(groupOf(irkutsk,'2026-10-06','telegram').postIds,[id]);
  assert.equal(dayOf(irkutsk,'2026-10-05').platforms.length,0);
  const current=f.information.get('alvi');
  f.information.save('alvi',{revision:current.revision,profile:{timezone:'UTC'}},OWNER.userId);
  const utc=await f.api.calendar('alvi',MONTH);
  assert.equal(utc.timezone,'UTC');assert.equal(utc.today,'2026-09-30');
  assert.equal(postOf(utc,id).publishDate,'2026-10-05');
  assert.deepEqual(groupOf(utc,'2026-10-05','telegram').postIds,[id]);
  assert.equal(dayOf(utc,'2026-10-06').platforms.length,0);
  // Смена данных компании — это новая версия профиля: прежний текст больше не подтверждён.
  assert.equal(postOf(utc,id).calendarReadiness.state,'missing');
  assert.ok(postOf(utc,id).calendarReadiness.issues.some(issue=>/прежней версии данных компании/.test(issue)));
});

test('карточки с датой отдаются полностью, а запас без даты ограничен и честно помечен',async t=>{
  const f=fixture(t);
  f.seed(205,'2026-10-05T03:00:00Z');
  f.seed(5,'2026-10-20T03:00:00Z',205);
  f.seed(260,null,210);
  const result=await f.api.calendar('alvi',MONTH);
  assert.equal(result.posts.length,210);assert.equal(result.truncated,false);
  assert.equal(result.undated.length,CALENDAR_UNDATED_LIMIT);
  assert.equal(result.undatedTotal,260);assert.equal(result.undatedTruncated,true);
  assert.equal(groupOf(result,'2026-10-05','telegram').postIds.length,205);
  assert.equal(groupOf(result,'2026-10-20','telegram').postIds.length,5);
  assert.equal(groupOf(result,'2026-10-05','telegram').planned,0);
  assert.ok(result.undated.every(card=>card.effectiveDate===null&&card.plannedDate===null&&card.publishDate===null&&card.dateKind===null));
  // Запас без даты не превращается в дни плана и не объявляется покрытием.
  assert.equal(result.summary.stockDays,null);assert.equal(result.summary.knownPlanDays,0);
  assert.deepEqual(result.coverage.uncoveredDates,[]);
  assert.equal(result.coverage.unknownDates.length,31);
});

test('время отправки важнее плановой даты, а расписка прошлой версии плана даты не даёт',async t=>{
  const f=fixture(t);
  f.savePlan('alvi',[day('2026-10-02','telegram','Разбор'),day('2026-10-08','telegram','Ответы')]);
  f.approvePlan('alvi');
  const moved=f.runTransfer('alvi');
  const [first,second]=moved.posts.map(card=>card.id);
  let planned=await f.api.calendar('alvi',MONTH);
  assert.equal(postOf(planned,first).effectiveDate,'2026-10-02');
  assert.equal(postOf(planned,first).dateKind,'plan');
  const ready=f.makeReady(first);
  await f.api.schedule(first,'alvi',{revision:ready.revision,scheduledAt:'2026-10-06T03:00:00Z'});
  planned=await f.api.calendar('alvi',MONTH);
  const shifted=postOf(planned,first);
  assert.equal(shifted.plannedDate,'2026-10-02');assert.equal(shifted.publishDate,'2026-10-06');
  assert.equal(shifted.effectiveDate,'2026-10-06');assert.equal(shifted.dateKind,'schedule');
  // Слот 2 октября остался без материала, хотя карточка того же плана уехала на 6-е.
  assert.equal(groupOf(planned,'2026-10-02','telegram').missing,1);
  assert.equal(groupOf(planned,'2026-10-02','telegram').planned,1);
  assert.deepEqual(groupOf(planned,'2026-10-02','telegram').postIds,[]);
  assert.equal(groupOf(planned,'2026-10-06','telegram').planned,0);
  assert.ok(planned.coverage.uncoveredDates.includes('2026-10-02'));
  assert.ok(planned.coverage.unknownDates.includes('2026-10-06'));
  // Новая версия плана: прежний перенос больше не текущий, его карточки остаются без плановой даты.
  f.savePlan('alvi',[day('2026-10-12','telegram','Новый разбор'),day('2026-10-19','telegram','Новые ответы')]);
  f.approvePlan('alvi');
  const next=await f.api.calendar('alvi',MONTH);
  assert.equal(next.coverage.planRevision,2);
  assert.equal(postOf(next,first).plannedDate,null);assert.equal(postOf(next,first).planPlatform,null);
  assert.equal(postOf(next,first).effectiveDate,'2026-10-06');
  const orphan=next.undated.find(card=>card.id===second);
  assert.ok(orphan);assert.equal(orphan.plannedDate,null);assert.equal(orphan.dateKind,null);
  assert.deepEqual(next.coverage.uncoveredDates,['2026-10-12','2026-10-19']);
});

test('готовность консервативна: материал, текст, канал, одобрение, версия компании и согласование плана',async t=>{
  const f=fixture(t);
  f.savePlan('alvi',[day('2026-10-01','telegram','Один'),day('2026-10-03','telegram','Два'),day('2026-10-05','telegram','Три'),
    day('2026-10-07','telegram','Четыре'),day('2026-10-09','telegram','Пять')]);
  f.approvePlan('alvi');
  const moved=f.runTransfer('alvi');
  const ids=moved.posts.map(card=>card.id);
  const state=async id=>postOf(await f.api.calendar('alvi',MONTH),id).calendarReadiness;
  // Перенос оставляет карточку пустой: ни материала, ни текста, ни каналов.
  const empty=await state(ids[0]);
  assert.equal(empty.state,'missing');assert.deepEqual(empty.platforms.map(item=>item.platform),['telegram']);
  assert.ok(empty.issues.some(issue=>/Нет материала/.test(issue)));
  assert.ok(empty.issues.some(issue=>/не выбрана в карточке/.test(issue)));
  // Есть текст и канал, но нет материала.
  f.fill(ids[1],'alvi',{mediaUrls:[]});
  const noMedia=await state(ids[1]);
  assert.equal(noMedia.state,'missing');assert.ok(noMedia.issues.some(issue=>/Нет материала/.test(issue)));
  // Материал и канал есть, текста и подписи нет.
  f.fill(ids[2],'alvi',{text:''});
  const noText=await state(ids[2]);
  assert.equal(noText.state,'missing');assert.ok(noText.issues.some(issue=>/Нет текста и подписей/.test(issue)));
  // Подпись есть только для ВКонтакте, а выбран Telegram: общего текста нет.
  f.fill(ids[3],'alvi',{text:'',captions:{vk:'Подпись ВКонтакте'}});
  const wrongCaption=await state(ids[3]);
  assert.equal(wrongCaption.state,'missing');
  assert.ok(wrongCaption.issues.some(issue=>/ни подписи, ни общего текста/.test(issue)));
  // Всё заполнено, но владелец эту версию не одобрял.
  f.fill(ids[4]);
  const unapproved=await state(ids[4]);
  assert.equal(unapproved.state,'pending');assert.equal(unapproved.ready,false);
  assert.ok(unapproved.issues.some(issue=>/не одобрена владельцем/.test(issue)));
  const approved=f.makeReady(ids[4]);
  assert.equal((await state(ids[4])).state,'ready');
  // Отключённый и неизвестный канал готовыми не бывают.
  f.channels[0].connected=false;
  const disconnected=await state(ids[4]);
  assert.equal(disconnected.state,'missing');assert.ok(disconnected.issues.some(issue=>/не подключён/.test(issue)));
  f.channels[0].connected=true;f.channels[0].enabled=false;
  assert.ok((await state(ids[4])).issues.some(issue=>/выключен/.test(issue)));
  f.channels[0].enabled=true;
  f.api.update(ids[4],'alvi',{revision:f.api.get(ids[4],'alvi').revision,platformIds:['unknown-channel']});
  const unknown=await state(ids[4]);
  assert.equal(unknown.state,'missing');
  assert.ok(unknown.issues.some(issue=>/не настроен в подключениях/.test(issue)));
  f.makeReady(ids[4]);
  assert.equal((await state(ids[4])).state,'ready');
  // Известное ограничение площадки: материал есть, а подпись длиннее лимита Telegram.
  const long=f.api.update(ids[4],'alvi',{revision:f.api.get(ids[4],'alvi').revision,text:'т'.repeat(1100)});
  f.api.approve(ids[4],'alvi',{revision:long.revision,approved:true,comment:''},OWNER);
  const overCaption=await state(ids[4]);
  assert.equal(overCaption.state,'missing');
  assert.ok(overCaption.issues.some(issue=>/лимита площадки \(1024\)/.test(issue)));
  const back=f.api.update(ids[4],'alvi',{revision:f.api.get(ids[4],'alvi').revision,text:'Подтверждённый текст записи'});
  f.api.approve(ids[4],'alvi',{revision:back.revision,approved:true,comment:''},OWNER);
  assert.equal((await state(ids[4])).state,'ready');
  // Правка карточки компании мимо архива версий: профиль устарел, готовность снимается.
  f.db.prepare("UPDATE companies SET phone='+7 900 000-00-00' WHERE id=1").run();
  const stale=await state(ids[4]);
  assert.equal(stale.state,'missing');
  assert.ok(stale.issues.some(issue=>/ещё не зафиксирована новой версией/.test(issue)));
  f.db.prepare('UPDATE companies SET phone=NULL WHERE id=1').run();
  assert.equal((await state(ids[4])).state,'ready');
});

test('перенос несогласованного и пересогласуемого плана готовым не считается',async t=>{
  const f=fixture(t);
  f.savePlan('alvi',[day('2026-10-01','telegram','Один'),day('2026-10-08','telegram','Два')]);
  f.approvePlan('alvi');
  const moved=f.runTransfer('alvi');
  const id=moved.posts[0].id;
  f.makeReady(id);
  assert.equal(postOf(await f.api.calendar('alvi',MONTH),id).calendarReadiness.state,'ready');
  // Бриф ушёл вперёд: план требует пересогласования, значит перенесённая карточка не готова.
  const snapshot=f.mentor.get('alvi');
  f.mentor.saveBrief('alvi',{revision:snapshot.brief.revision,brief:{goal:'Другая цель'}},OWNER);
  const result=await f.api.calendar('alvi',MONTH);
  assert.equal(result.coverage.planApproval,'needs_reapproval');
  assert.equal(postOf(result,id).calendarReadiness.state,'missing');
  assert.ok(postOf(result,id).calendarReadiness.issues.some(issue=>/требует повторного согласования/.test(issue)));
  assert.deepEqual(result.coverage.uncoveredDates,['2026-10-01','2026-10-08']);
});

test('редкий план: непереносённые слоты, дубли и сдвиг площадки считаются как нехватка',async t=>{
  const f=fixture(t);
  f.savePlan('alvi',[day('2026-10-01','telegram','Утро'),day('2026-10-01','telegram','Вечер'),
    day('2026-10-03','vk','Разбор'),day('2026-10-10','telegram','Итог')]);
  f.approvePlan('alvi');
  // План согласован, но ещё не перенесён: слоты честно показываются как нехватка.
  const before=await f.api.calendar('alvi',MONTH);
  assert.equal(before.coverage.basis,'current_plan');assert.equal(before.coverage.planApproval,'approved');
  assert.equal(before.coverage.guaranteedDays,null);
  assert.deepEqual(groupOf(before,'2026-10-01','telegram'),{platform:'telegram',planned:2,ready:0,missing:2,pending:0,published:0,postIds:[]});
  assert.deepEqual(before.coverage.uncoveredDates,['2026-10-01','2026-10-03','2026-10-10']);
  assert.ok(before.coverage.unknownDates.includes('2026-10-02'));
  assert.ok(!before.coverage.unknownDates.includes('2026-10-03'));
  assert.equal(before.summary.knownPlanDays,3);assert.equal(before.summary.coveredPlanDays,0);
  const moved=f.runTransfer('alvi');
  const ids=moved.posts.map(card=>card.id);
  // Один из двух слотов 1 октября готов: второй остаётся нехваткой.
  f.makeReady(ids[0]);
  let result=await f.api.calendar('alvi',MONTH);
  // Второй слот занят пустой карточкой того же переноса: это одна нехватка, а не две.
  assert.deepEqual(groupOf(result,'2026-10-01','telegram'),
    {platform:'telegram',planned:2,ready:1,missing:1,pending:0,published:0,postIds:[ids[0],ids[1]]});
  assert.ok(result.coverage.uncoveredDates.includes('2026-10-01'));
  f.makeReady(ids[1]);
  result=await f.api.calendar('alvi',MONTH);
  assert.deepEqual(groupOf(result,'2026-10-01','telegram'),
    {platform:'telegram',planned:2,ready:2,missing:0,pending:0,published:0,postIds:[ids[0],ids[1]]});
  assert.ok(!result.coverage.uncoveredDates.includes('2026-10-01'));
  assert.equal(result.summary.coveredPlanDays,1);
  // Слот 3 октября запланирован во ВКонтакте, а в карточке выбран Telegram: слот не закрыт.
  f.makeReady(ids[2],'alvi',{platformIds:['telegram']});
  result=await f.api.calendar('alvi',MONTH);
  const vk=groupOf(result,'2026-10-03','vk');
  assert.equal(vk.planned,1);assert.equal(vk.ready,0);assert.equal(vk.missing,1);
  assert.deepEqual(vk.postIds,[ids[2]]);
  assert.equal(groupOf(result,'2026-10-03','telegram').planned,0);
  assert.ok(result.coverage.uncoveredDates.includes('2026-10-03'));
  assert.equal(postOf(result,ids[2]).calendarReadiness.state,'missing');
  // Отменённая карточка слот не закрывает и в запас не идёт.
  const last=f.makeReady(ids[3]);
  f.api.cancel(ids[3],'alvi',{revision:last.revision});
  result=await f.api.calendar('alvi',MONTH);
  assert.equal(postOf(result,ids[3]).calendarReadiness.state,'inactive');
  assert.deepEqual(groupOf(result,'2026-10-10','telegram'),
    {platform:'telegram',planned:1,ready:0,missing:1,pending:0,published:0,postIds:[ids[3]]});
  assert.ok(result.coverage.uncoveredDates.includes('2026-10-10'));
});

test('опубликованное и отмеченное вне ЛК закрывает прошлый слот, но запасом не становится',async t=>{
  const f=fixture(t);
  f.savePlan('alvi',[day('2026-10-01','telegram','Один'),day('2026-10-08','telegram','Два')]);
  f.approvePlan('alvi');
  const moved=f.runTransfer('alvi');
  const [first,second]=moved.posts.map(card=>card.id);
  const ready=f.makeReady(first);
  f.api.recordReceipt(first,'alvi',{platform:'telegram',url:'https://t.me/alvi_channel/12',
    publishedAt:'2026-09-29T09:00:00Z',contentRevision:ready.contentRevision,note:''},OWNER);
  f.makeReady(second);
  const result=await f.api.calendar('alvi',MONTH);
  const card=postOf(result,first);
  assert.equal(card.calendarReadiness.state,'published');
  assert.deepEqual(card.calendarReadiness.platforms.map(item=>item.state),['published']);
  assert.ok(card.calendarReadiness.issues.some(issue=>/создаст дубликат/.test(issue)));
  // Слот считается закрытым публикацией, но карточка не числится готовым запасом.
  assert.deepEqual(groupOf(result,'2026-10-01','telegram'),
    {platform:'telegram',planned:1,ready:0,missing:0,pending:0,published:1,postIds:[first]});
  assert.ok(!result.coverage.uncoveredDates.includes('2026-10-01'));
  assert.equal(result.summary.readyPosts,1);assert.equal(result.summary.coveredPlanDays,2);
  assert.equal(result.summary.stockDays,null);
});

test('без карточек и без плана календарь ничего не выдумывает',async t=>{
  const f=fixture(t);
  const empty=await f.api.calendar('alvi',MONTH);
  assert.deepEqual(empty.posts,[]);assert.deepEqual(empty.undated,[]);
  assert.equal(empty.undatedTotal,0);assert.equal(empty.undatedTruncated,false);
  assert.deepEqual(empty.coverage,{basis:'none',planRevision:null,planApproval:null,guaranteedDays:null,
    days:empty.coverage.days,uncoveredDates:[],unknownDates:empty.coverage.days.map(item=>item.date)});
  assert.ok(empty.coverage.days.every(item=>item.platforms.length===0));
  assert.deepEqual(empty.summary,{targetDays:14,minimumDays:7,criticalBelowDays:3,readyPosts:0,pendingPosts:0,missingPosts:0,
    knownPlanDays:0,coveredPlanDays:0,stockDays:null});
  f.savePlan('alvi',[day('2026-10-01','telegram','Один'),day('2026-10-08','telegram','Два')]);
  const pending=await f.api.calendar('alvi',MONTH);
  assert.equal(pending.coverage.basis,'current_plan');assert.equal(pending.coverage.planApproval,'pending');
  assert.equal(pending.summary.knownPlanDays,2);assert.equal(pending.summary.coveredPlanDays,0);
  assert.equal(pending.summary.readyPosts,0);assert.equal(pending.summary.stockDays,null);
  assert.deepEqual(pending.coverage.uncoveredDates,['2026-10-01','2026-10-08']);
});

test('календарь работает без таблиц Медиа-наставника',async t=>{
  const f=fixture(t,{mentorTables:false});
  f.seed(2,'2026-10-04T03:00:00Z');
  const result=await f.api.calendar('alvi',MONTH);
  assert.equal(result.posts.length,2);
  assert.equal(result.coverage.basis,'none');assert.equal(result.coverage.planRevision,null);
  assert.equal(result.coverage.planApproval,null);
  assert.ok(result.posts.every(card=>card.plannedDate===null&&card.planPlatform===null));
  assert.equal(groupOf(result,'2026-10-04','telegram').planned,0);
});

test('календарь ничего не меняет в базе и не обращается к площадкам',async t=>{
  const f=fixture(t);
  f.savePlan('alvi',[day('2026-10-01','telegram','Один'),day('2026-10-08','telegram','Два')]);
  f.approvePlan('alvi');
  const moved=f.runTransfer('alvi');
  f.makeReady(moved.posts[0].id);
  f.seed(3,'2026-10-04T03:00:00Z');
  const before=f.changes(),profile=f.information.get('alvi').revision,after=f.changes();
  assert.ok(after>=before);
  const baseline=f.changes();
  const result=await f.api.calendar('alvi',MONTH);
  assert.equal(f.changes(),baseline,'календарь не должен писать в базу');
  assert.equal(f.information.get('alvi').revision,profile);
  assert.equal(result.posts.length,5);
  // Компания без заполненной карточки данных: просмотр не создаёт первую версию профиля.
  const fresh=f.changes();
  const other=await f.api.calendar('avokado',MONTH);
  assert.equal(f.changes(),fresh);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM company_information WHERE company_id=2').get().n,0);
  assert.deepEqual(other.posts,[]);
  // Изменённые поля компании не архивируются просмотром — они остаются расхождением.
  f.db.prepare("UPDATE companies SET city='Иркутск' WHERE id=1").run();
  const changed=f.changes();
  const stale=await f.api.calendar('alvi',MONTH);
  assert.equal(f.changes(),changed);
  assert.equal(f.db.prepare('SELECT revision FROM company_information WHERE company_id=1').get().revision,profile);
  assert.ok(stale.posts.every(card=>card.calendarReadiness.state!=='ready'));
  // Ни одной публикации, ни одной сверки с провайдером — только чтение настроек каналов.
  assert.deepEqual(f.sideEffects,[]);
  assert.ok(f.settingsCalls.length>=3);
  assert.deepEqual(new Set(f.settingsCalls),new Set(['alvi','avokado']));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM autoposting_posts WHERE status='needs_review'").get().n,0);
});
