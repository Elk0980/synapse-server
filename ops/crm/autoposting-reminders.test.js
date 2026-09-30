'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');
const {createMediaMentor}=require('./media-mentor');
const {createMediaMentorTransfer}=require('./media-mentor-transfer');
const CODE='palitra-love',OWNER={userId:7,userName:'Согласующий'};
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,
    timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'palitra-love','Fixture','UTC','[]'),(2,'other','Other','UTC','[]');`);
  const now=()=>Date.parse('2026-09-30T15:00:00Z'),information=createCompanyInformation(db,{now}),effects=[];
  const transport={getSettings(){effects.push('settings');throw Error('No transport read');},publish(){effects.push('publish');throw Error('No publish');}};
  const api=createAutoposting(db,{information,transport,now,logger:{warn(){}}}),mentor=createMediaMentor(db,{now});
  const transfer=createMediaMentorTransfer(db,{mentor,autoposting:api,information,now});
  const create=(extra={},code=CODE)=>api.create(code,{title:'Название',text:'Текст',mediaUrls:[],platformIds:['telegram'],scheduledAt:'2026-09-30T22:00:00Z',timezone:'Europe/Moscow',profileRevision:information.get(code).revision,...extra},7);
  return {db,api,mentor,transfer,effects,create,changes:()=>db.prepare('SELECT total_changes() n').get().n};
}
test('служебная сводка включает обычную Palitra-карточку по московской дате, не раскрывает тексты и ничего не пишет',t=>{
  const f=fixture(t),card=f.create();f.create({},'other');const before=f.changes(),result=f.api.reviewReminderSummary(CODE,'2026-10-01');
  assert.equal(f.changes(),before);assert.deepEqual(f.effects,[]);assert.equal(result.timezone,'Europe/Moscow');assert.equal(result.items.length,1);
  assert.deepEqual(result.items[0],{id:card.id,revision:card.revision,contentRevision:card.contentRevision,title:card.title,effectiveDate:'2026-10-01',dateKind:'schedule',scheduledAt:card.scheduledAt,status:'draft',approved:false});
  assert.deepEqual(f.api.reviewReminderSummary(CODE,'2026-09-30').items,[]);
  assert.throws(()=>f.api.reviewReminderSummary('other','2026-10-01'),e=>e.status===404);
  assert.throws(()=>f.api.reviewReminderSummary(CODE,'2026-02-30'),e=>e.status===400);
});
test('согласование всех каналов, отмена/отправка и новая версия проверяются по текущим данным',t=>{
  const f=fixture(t);let card=f.create({platformIds:['telegram','vk']});
  card=f.api.approve(card.id,CODE,{revision:card.revision,approved:true,platformIds:['telegram']},OWNER);
  assert.equal(f.api.reviewReminderSummary(CODE,'2026-10-01').items.length,1);
  card=f.api.approve(card.id,CODE,{revision:card.revision,approved:true,platformIds:['vk']},OWNER);
  assert.equal(f.api.reviewReminderSummary(CODE,'2026-10-01').items.length,0);
  card=f.api.update(card.id,CODE,{revision:card.revision,text:'Новая версия'});
  assert.equal(f.api.reviewReminderSummary(CODE,'2026-10-01').items[0].contentRevision,card.contentRevision);
  for(const status of ['cancelled','published','publishing']){
    f.db.prepare('UPDATE autoposting_posts SET status=? WHERE id=?').run(status,card.id);
    assert.equal(f.api.reviewReminderSummary(CODE,'2026-10-01').items.length,0,status);
  }
});
test('настоящая дата переноса плана используется без выдумывания даты по D1; назначенное время приоритетно',t=>{
  const f=fixture(t);f.create({dayKey:'D1',scheduledAt:null});
  const initial=f.mentor.get(CODE);f.mentor.saveBrief(CODE,{revision:initial.brief.revision,brief:{goal:'Запросы',platforms:['telegram'],assets:[]}},OWNER);
  const brief=f.mentor.get(CODE);f.mentor.savePlan(CODE,{planRevision:0,briefRevision:brief.brief.revision,
    days:Array.from({length:7},(_,index)=>({date:`2026-10-0${index+1}`,platform:'telegram',format:'post',role:'reach',topic:'Фактический день '+index}))},OWNER);
  const plan=f.mentor.get(CODE);f.mentor.decide(CODE,{planRevision:plan.plan.revision,briefRevision:plan.brief.revision,decision:'approved',comment:'Тестовое согласование плана'},OWNER);
  const moved=f.transfer.transfer(CODE,{planRevision:plan.plan.revision,briefRevision:plan.brief.revision},OWNER);
  const before=f.changes(),items=f.api.reviewReminderSummary(CODE,'2026-10-01').items;assert.equal(f.changes(),before);
  assert.equal(items.length,1);assert.equal(items[0].id,moved.posts[0].id);assert.equal(items[0].dateKind,'plan');
  const card=f.api.get(items[0].id,CODE);f.api.update(card.id,CODE,{revision:card.revision,scheduledAt:'2026-10-02T10:00:00Z'});
  assert.equal(f.api.reviewReminderSummary(CODE,'2026-10-01').items.length,0);
  assert.equal(f.api.reviewReminderSummary(CODE,'2026-10-02').items[0].dateKind,'schedule');
});
