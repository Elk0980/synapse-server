'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');
const {createAutopostingTransport}=require('./autoposting-transport');

const FOUR=['telegram','vk','youtube_shorts','instagram'],FIVE=[...FOUR,'tiktok'];
const PLATFORM={telegram:'telegram',vk:'vk',youtube_shorts:'youtube',instagram:'instagram_business_login',tiktok:'tiktok'};
async function fixture(t,{uncertain=null}={}){
  t.mock.method(globalThis,'fetch',async()=>assert.fail('Настоящая сеть запрещена'));
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,
      timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'palitra-love','Вымышленная проверка','Europe/Moscow','[]'),
      (2,'fixture-other','Другая вымышленная компания','UTC','[]');`);
  let clock=Date.parse('2026-11-01T00:00:00Z');const now=()=>clock,calls=[];
  const byProfile=new Map(FIVE.map(id=>['fixture-'+id,id]));
  const fetchImpl=async(address,options)=>{
    const url=new URL(address);assert.equal(url.origin,'https://api.onlypult.com');
    const call={method:options.method,path:url.pathname,body:options.body?JSON.parse(options.body):null};calls.push(call);
    let data;
    if(call.method==='GET'&&call.path==='/v1/profiles')data=FIVE.map(id=>({id:'fixture-'+id,name:'Вымышленный '+id,platform:PLATFORM[id],status:'active'}));
    else if(call.method==='GET'&&call.path==='/v1/account')data={plan_active:true};
    else if(call.method==='GET'&&call.path==='/v1/posts/limits'){
      const id=byProfile.get(url.searchParams.get('profile_id'));assert.ok(id);
      // Значения профилей наблюдались 01.11; идентификаторы, ключи и материалы здесь вымышленные.
      data={platform:{limits:{text:{charLimit:{telegram:4000,vk:16350,youtube_shorts:2000,instagram:2195,tiktok:2200}[id]},media:{minCount:1,maxCount:10}}}};
    }else if(call.method==='POST'&&call.path==='/v1/posts'){
      const id=byProfile.get(call.body.profile_ids?.[0]);assert.ok(id);
      if(id===uncertain)throw Error('Вымышленная потеря ответа после отправки');
      data={id:'fixture-job-'+id,profile_ids:['fixture-'+id],platform:PLATFORM[id],status:'draft'};
    }else if(call.method==='GET'&&call.path.startsWith('/v1/posts/fixture-job-')){
      const id=call.path.slice('/v1/posts/fixture-job-'.length);assert.ok(FOUR.includes(id));
      data={id:'fixture-job-'+id,profile_ids:['fixture-'+id],platform:PLATFORM[id],status:'published'};
    }else assert.fail('Непредусмотренный запрос '+call.method+' '+call.path);
    return new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}});
  };
  const information=createCompanyInformation(db,{now});
  const transport=createAutopostingTransport(db,{apiKey:'FIXTURE_ONLY_ENCRYPTION_KEY',now,fetchImpl});
  for(const id of FIVE){
    transport.saveSettings('palitra-love',{channels:[{id,revision:0,enabled:true,provider:'onlypult',target:'fixture-'+id,token:'op_'+'b'.repeat(64)}]});
    assert.equal((await transport.checkChannel('palitra-love',id)).ok,true);
  }
  calls.length=0;
  const api=createAutoposting(db,{information,transport,now,logger:{warn(){}}});
  const create=(ids=FIVE)=>api.create('palitra-love',{title:'Вымышленный тестовый ролик',text:'Вымышленный общий текст',
    mediaUrls:['https://cdn.example.test/fixture.mp4'],platformIds:ids,
    captions:Object.fromEntries(ids.map(id=>[id,'Вымышленная подпись '+id])),
    platformOptions:{instagram:{is_reels:true},...(ids.includes('tiktok')?{tiktok:{privacy:'SELF_ONLY'}}:{})},
    scheduledAt:new Date(clock+60000).toISOString(),timezone:'Europe/Moscow',profileRevision:information.get('palitra-love').revision},7);
  const approve=p=>api.approve(p.id,'palitra-love',{revision:p.revision,approved:true},{userId:7,userName:'Вымышленный согласующий'});
  const schedule=p=>api.schedule(p.id,'palitra-love',{revision:p.revision});
  return {api,transport,calls,create,approve,schedule,advance:()=>clock+=60000};
}

test('известный блокер TikTok останавливает всю выбранную очередь до записи доставок',async t=>{
  const f=await fixture(t);let card=f.create();
  await assert.rejects(f.schedule(card),e=>e.details?.code==='APPROVAL_REQUIRED');
  card=f.approve(card);
  const calendar=await f.api.calendar('palitra-love',{from:'2026-11-01',to:'2026-11-07'});
  const listed=[...calendar.posts,...calendar.undated].find(p=>p.id===card.id);
  const tiktok=listed.calendarReadiness.platforms.find(p=>p.platform==='tiktok');
  assert.equal(tiktok.ready,false);assert.match(tiktok.issues.join(' '),/аудиторию профиля/);
  await assert.rejects(f.schedule(card),e=>e.details?.code==='TIKTOK_PRIVACY_UNCONFIRMED');
  const saved=f.api.get(card.id,'palitra-love');assert.equal(saved.status,'draft');
  assert.equal(saved.approval.approved,true,'одобрение содержимого сохраняется, отправка не начинается');
  assert.deepEqual(saved.deliveries,[]);assert.equal(f.calls.filter(x=>x.method==='POST').length,0);
  assert.equal(f.transport.getSettings('palitra-love').channels.find(x=>x.id==='tiktok').connected,true,'доступ и возможность отправки различаются');
});

test('четыре транспорта: одобрение и время обязательны, подписи и профили не смешиваются',async t=>{
  const f=await fixture(t);let card=f.create(FOUR);
  await assert.rejects(f.schedule(card),e=>e.details?.code==='APPROVAL_REQUIRED');
  card=await f.schedule(f.approve(card));await f.api.drain();
  assert.equal(f.calls.filter(x=>x.method==='POST').length,0,'до срока отправки нет');
  f.advance();await f.api.drain();
  const writes=f.calls.filter(x=>x.method==='POST');assert.equal(writes.length,4);
  for(const call of writes){
    const id=call.body.profile_ids[0].slice('fixture-'.length);assert.ok(FOUR.includes(id));
    assert.equal(call.body.content,'Вымышленная подпись '+id);
    assert.deepEqual(call.body.media_urls,['https://cdn.example.test/fixture.mp4']);
    if(id==='instagram')assert.deepEqual(call.body.platform_options,{instagram:{is_reels:true}});
    if(id==='youtube_shorts')assert.deepEqual(call.body.platform_options,{youtube:{is_shorts:true,privacy:'public'}});
    if(['telegram','vk'].includes(id))assert.equal(call.body.platform_options,undefined);
  }
  f.advance();await f.api.drain();
  assert.equal(f.calls.filter(x=>x.method==='POST').length,4,'статус провайдера сверяется только чтением');
  card=f.api.get(card.id,'palitra-love');assert.equal(card.status,'needs_review');
  assert.ok(card.deliveries.every(d=>d.url===null&&d.status==='needs_review'),'published провайдера не превращается в выдуманную ссылку');
  assert.equal(f.api.list('fixture-other').posts.length,0);
});

test('согласовать и запланировать: известный блокер откатывает решение целиком',async t=>{
  const f=await fixture(t),card=f.create();
  await assert.rejects(f.api.approveAndSchedule(card.id,'palitra-love',{
    revision:card.revision,approved:true,schedule:true,
  },{userId:7,userName:'Вымышленный согласующий'}),e=>e.details?.code==='TIKTOK_PRIVACY_UNCONFIRMED');
  const saved=f.api.get(card.id,'palitra-love');
  assert.equal(saved.revision,card.revision);assert.equal(saved.approval.approved,false);
  assert.deepEqual(saved.platformApprovals,card.platformApprovals);assert.deepEqual(saved.deliveries,[]);
  assert.equal(f.calls.filter(x=>x.method==='POST').length,0);
});

test('неизвестный ответ одного канала не приводит к повторному POST',async t=>{
  const f=await fixture(t,{uncertain:'vk'});let card=f.create(FOUR);card=await f.schedule(f.approve(card));
  f.advance();await f.api.drain();f.advance();await f.api.drain();
  assert.equal(f.calls.filter(x=>x.method==='POST'&&x.body.profile_ids[0]==='fixture-vk').length,1);
  assert.equal(f.api.get(card.id,'palitra-love').deliveries.find(x=>x.channelId==='vk').status,'needs_review');
});

test('старая очередь с пятью каналами останавливается до первой внешней отправки',async t=>{
  const f=await fixture(t),getSettings=f.transport.getSettings;
  // Состояние старой версии только в memory fixture: доступ был проверен, раннего барьера ещё не было.
  f.transport.getSettings=code=>{
    const settings=getSettings(code);
    for(const channel of settings.channels)delete channel.caps.deliveryBlocker;
    return settings;
  };
  const card=await f.schedule(f.approve(f.create()));f.transport.getSettings=getSettings;
  f.advance();await f.api.drain();
  const saved=f.api.get(card.id,'palitra-love');
  assert.equal(f.calls.filter(x=>x.method==='POST').length,0);
  assert.equal(saved.status,'needs_review');assert.equal(saved.lastErrorCode,'TIKTOK_PRIVACY_UNCONFIRMED');
  assert.equal(saved.contentRevision,card.contentRevision);assert.deepEqual(saved.captions,card.captions);
  assert.ok(saved.deliveries.every(d=>d.status==='pending'),'сохранённые доставки не удаляются и не помечаются опубликованными');
});
