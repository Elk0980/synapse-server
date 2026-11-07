'use strict';
/* specs/217: метка рилса в подписи при отправке, связь заявки с публикацией и отчёт до выручки/ROMI. Данные синтетические. */
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');
const {createReelAttribution,trackedUrl,postIdOfTag}=require('./reel-attribution');
const {createReelAttributionHandler}=require('./reel-attribution-http');

function fixture(t,{site='https://demo-a.example.test/?ref=bio&utm_source=old#zapis'}={}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'demo-a','Демо А','Asia/Irkutsk','[]'),(2,'demo-b','Демо Б','UTC','[]');
    CREATE TABLE leads(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'новая',sale_amount REAL,company_code TEXT,
      utm_source TEXT,utm_medium TEXT,utm_campaign TEXT,utm_content TEXT);
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,type TEXT NOT NULL,company_code TEXT,client_id TEXT,
      utm_source TEXT,utm_medium TEXT,utm_campaign TEXT,utm_content TEXT);
    CREATE TABLE expenses(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT,spent_at TEXT,source TEXT NOT NULL,amount REAL NOT NULL,comment TEXT,company_code TEXT);`);
  let time=Date.parse('2026-11-01T00:00:00Z');
  const calls=[],channels=[{id:'telegram',enabled:true,connected:true,revision:1},{id:'vk',enabled:true,connected:true,revision:1}];
  const information=createCompanyInformation(db,{now:()=>time});
  if(site)for(const code of ['demo-a','demo-b'])information.save(code,{revision:information.get(code).revision,profile:{websiteUrl:site}});
  const transport={approvalDestination:(_c,id)=>{const ch=channels.find(x=>x.id===id);return {destinationRevision:ch?.revision||0,channelRevision:ch?.revision||0};},
    getSettings:()=>({channels:structuredClone(channels)}),publish:async input=>{calls.push(input);return {externalId:`qa-${calls.length}`,url:'https://example.test/post'};}};
  const attribution=createReelAttribution(db,{information,now:()=>time,logger:{warn(){}}});
  const api=createAutoposting(db,{information,transport,captionLink:attribution,now:()=>time,logger:{warn(){}}});
  const draft=(text='Подтверждённый текст',code='demo-a',platformIds=['telegram','vk'])=>api.create(code,{title:'Рилс про запись',text,mediaUrls:[],platformIds,
    scheduledAt:new Date(time+60000).toISOString(),timezone:'Asia/Irkutsk',profileRevision:information.get(code).revision},7);
  const publish=async post=>{await api.schedule(post.id,post.companyCode,{revision:post.revision});time+=60000;await api.drain();await api.drain();};
  const enable=(code='demo-a',enabled=true,label)=>{const s=attribution.getSettings(code);return attribution.saveSettings(code,{revision:s.revision,enabled,...(label===undefined?{}:{label})},{userId:1});};
  return {db,information,attribution,api,calls,draft,publish,enable,advance:ms=>time+=ms};
}

test('метка: utm_source=площадка, medium=social, campaign=cf, content=post-<N>; чужие utm_* заменяются; только http(s)',()=>{
  const link=new URL(trackedUrl('https://site.example.test/?ref=bio&utm_source=old&UTM_TERM=x#zapis','youtube_shorts',42));
  assert.equal(link.searchParams.get('utm_source'),'youtube');assert.equal(link.searchParams.get('utm_medium'),'social');
  assert.equal(link.searchParams.get('utm_campaign'),'cf');assert.equal(link.searchParams.get('utm_content'),'post-42');
  assert.equal(link.searchParams.get('ref'),'bio');assert.equal(link.searchParams.has('UTM_TERM'),false);assert.equal(link.hash,'#zapis');
  assert.equal(trackedUrl('javascript:alert(1)','vk',1),null);assert.equal(trackedUrl('https://u:p@site.test/','vk',1),null);
  assert.equal(trackedUrl('https://site.test/','two_gis',1),null);assert.equal(trackedUrl('https://site.test/','vk',0),null);
  assert.equal(postIdOfTag('POST-17'),17);assert.equal(postIdOfTag('post-0'),null);assert.equal(postIdOfTag('idea-17'),null);
});

test('по умолчанию выключено: подпись уходит как была, меток не записано',async t=>{
  const f=fixture(t),post=f.draft();
  assert.equal(f.attribution.getSettings('demo-a').enabled,false);
  await f.publish(post);
  assert.equal(f.calls.length,2);for(const call of f.calls)assert.equal(call.post.text,'Подтверждённый текст');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM reel_attribution_links').get().n,0);
});

test('включено и есть сайт: ссылка с меткой площадки дописана при отправке, карточка не переписана',async t=>{
  const f=fixture(t);f.enable();f.advance(1000);
  const post=f.draft();await f.publish(post);
  const byChannel=Object.fromEntries(f.calls.map(c=>[c.channelId,c.post.text]));
  for(const [channel,source] of [['telegram','telegram'],['vk','vk']]){
    const [head,tail]=byChannel[channel].split('\n\n');
    assert.equal(head,'Подтверждённый текст');assert.match(tail,/^Подробнее: https:\/\/demo-a\.example\.test\//);
    const url=new URL(tail.slice('Подробнее: '.length));
    assert.equal(url.searchParams.get('utm_source'),source);assert.equal(url.searchParams.get('utm_content'),`post-${post.id}`);
  }
  const saved=f.api.get(post.id,'demo-a');assert.equal(saved.text,'Подтверждённый текст');assert.equal(saved.status,'published');
  const links=f.db.prepare('SELECT channel_id,status FROM reel_attribution_links ORDER BY channel_id').all().map(r=>({...r}));
  assert.deepEqual(links,[{channel_id:'telegram',status:'added'},{channel_id:'vk',status:'added'}]);
});

test('задним числом не меняется: карточка, созданная до включения, уходит без ссылки',async t=>{
  const f=fixture(t),post=f.draft();f.advance(1000);f.enable();
  await f.publish(post);
  for(const call of f.calls)assert.equal(call.post.text,'Подтверждённый текст');
});

test('нет сайта в данных компании: ссылка не ставится, настройка честно говорит почему',async t=>{
  const f=fixture(t,{site:''});const s=f.enable();
  assert.equal(s.enabled,true);assert.equal(s.active,false);assert.match(s.reason,/нет сайта/);
  f.advance(1000);await f.publish(f.draft());
  for(const call of f.calls)assert.equal(call.post.text,'Подтверждённый текст');
});

test('ссылка не влезает в лимит подписи площадки: подпись не обрезается, метка отмечена skipped_limit',async t=>{
  const f=fixture(t);f.enable();f.advance(1000);
  const long='а'.repeat(1000);await f.publish(f.draft(long,'demo-a',['telegram']));
  assert.equal(f.calls[0].post.text,long);
  assert.equal(f.db.prepare('SELECT status FROM reel_attribution_links').get().status,'skipped_limit');
});

test('настройки: ревизия защищает от одновременной правки, подпись к ссылке настраивается, выключение возвращает прежнее',async t=>{
  const f=fixture(t);const on=f.enable('demo-a',true,'Запись:');
  assert.throws(()=>f.attribution.saveSettings('demo-a',{revision:0,enabled:false},{}),e=>e.status===409);
  assert.throws(()=>f.attribution.saveSettings('demo-a',{revision:on.revision,enabled:'yes'},{}),e=>e.status===400);
  assert.throws(()=>f.attribution.saveSettings('demo-a',{revision:on.revision,enabled:true,extra:1},{}),e=>e.status===400);
  f.advance(1000);await f.publish(f.draft());assert.match(f.calls[0].post.text,/\n\nЗапись: https:/);
  f.enable('demo-a',false);f.advance(1000);const before=f.calls.length;await f.publish(f.draft());
  assert.equal(f.calls[before].post.text,'Подтверждённый текст');
  assert.equal(f.attribution.getSettings('demo-b').enabled,false,'другая компания не затронута');
});

test('отчёт: рилс → переходы → заявки → продажи → выручка; чужая компания и чужие метки не засчитываются',async t=>{
  const f=fixture(t);f.enable();f.advance(1000);
  const reel=f.draft();await f.publish(reel);
  const foreign=f.draft('Текст Б','demo-b',['telegram']);
  const tag=`post-${reel.id}`,ins=f.db.prepare('INSERT INTO leads(created_at,stage,sale_amount,company_code,utm_source,utm_medium,utm_campaign,utm_content) VALUES(?,?,?,?,?,?,?,?)');
  const visit=f.db.prepare("INSERT INTO events(created_at,type,company_code,client_id,utm_source,utm_campaign,utm_content) VALUES(?,?,?,?,?,?,?)");
  visit.run('2026-11-02T10:00:00Z','visit','demo-a','c1','vk','cf',tag);
  visit.run('2026-11-02T10:05:00Z','visit','demo-a','c1','vk','cf',tag);// тот же посетитель — один переход
  visit.run('2026-11-02T11:00:00Z','visit','demo-a','c2','telegram','cf',tag);
  visit.run('2026-11-02T11:00:00Z','click','demo-a','c3','telegram','cf',tag);// клик — не переход
  visit.run('2026-11-02T12:00:00Z','visit','demo-a','c4','vk','cf',`post-${foreign.id}`);// карточка другой компании
  ins.run('2026-11-02T10:10:00Z','продажа',15000,'demo-a','vk','social','cf',tag);
  ins.run('2026-11-02T11:10:00Z','новая',null,'demo-a','telegram','social','cf',tag);
  ins.run('2026-11-03T09:00:00Z','продажа',null,'demo-a','vk','social','cf',tag);// продажа без суммы
  ins.run('2026-11-03T09:00:00Z','продажа',9000,'demo-a','vk','social','other',tag);// другая кампания
  ins.run('2026-11-03T09:00:00Z','продажа',9000,'demo-b','vk','social','cf',tag);// другая компания
  ins.run('2026-11-03T09:00:00Z','новая',null,'demo-a','vk','social','cf',`post-${foreign.id}`);
  const r=f.attribution.report('demo-a','2026-11-01','2026-11-30');
  assert.equal(r.mode,'LIVE');assert.equal(r.reels.length,1);
  const row=r.reels[0];
  assert.equal(row.postId,reel.id);assert.equal(row.visits,2);assert.equal(row.leads,3);assert.equal(row.sales,2);assert.equal(row.revenue,15000);assert.equal(row.salesWithoutAmount,1);
  const vk=row.platforms.find(p=>p.platform==='vk');
  assert.equal(vk.visits,1);assert.equal(vk.leads,2);assert.equal(vk.linkStatus,'added');assert.equal(vk.deliveryStatus,'published');assert.match(vk.link,/utm_content=post-/);
  assert.deepEqual(r.unmatched,{visits:1,leads:1});
  assert.equal(row.lifetime.romi,null);assert.match(row.lifetime.romiReason,/не внесён/);
  f.db.prepare("INSERT INTO expenses(spent_at,source,amount,company_code) VALUES('2026-10-30',?,5000,'demo-a')").run(`cf-post-${reel.id}`);
  f.db.prepare("INSERT INTO expenses(spent_at,source,amount,company_code) VALUES('2026-10-30',?,99999,'demo-b')").run(`cf-post-${reel.id}`);
  const withCost=f.attribution.report('demo-a','2026-11-01','2026-11-30').reels[0].lifetime;
  assert.equal(withCost.cost,5000);assert.equal(withCost.romi,200);assert.match(withCost.romiReason,/без суммы/);
  const outside=f.attribution.report('demo-a','2026-12-01','2026-12-31');
  assert.equal(outside.reels[0].leads,0,'метка есть, заявок за период нет — честный ноль');
});

test('отчёт по теме: адаптации одной идеи складываются; пусто — NO_DATA',async t=>{
  const f=fixture(t);
  assert.equal(f.attribution.report('demo-a','2026-11-01','2026-11-30').mode,'NO_DATA');
  const root=f.draft('Идея'),child=f.draft('Адаптация');
  f.db.prepare(`INSERT INTO autoposting_variant_links(post_id,company_id,source_post_id,source_revision,source_content_revision,root_post_id,root_content_revision,platform_id,created_at)
    VALUES(?,1,?,1,1,?,1,'vk','2026-11-01T00:00:00Z')`).run(child.id,root.id,root.id);
  const ins=f.db.prepare("INSERT INTO leads(created_at,stage,sale_amount,company_code,utm_source,utm_campaign,utm_content) VALUES('2026-11-05T00:00:00Z',?,?,'demo-a','vk','cf',?)");
  ins.run('продажа',1000,`post-${root.id}`);ins.run('продажа',2000,`post-${child.id}`);
  const r=f.attribution.report('demo-a','2026-11-01','2026-11-30');
  assert.equal(r.themes.length,1);assert.equal(r.themes[0].themeId,root.id);assert.deepEqual(r.themes[0].postIds.sort(),[root.id,child.id].sort());
  assert.equal(r.themes[0].revenue,3000);assert.equal(r.themes[0].lifetime.romi,null);
  assert.throws(()=>f.attribution.report('demo-a','2026-11-30','2026-11-01'),e=>e.status===400);
});

test('HTTP: чтение — analytics.view своей компании, включение — только владелец',async t=>{
  const f=fixture(t),sent=[];
  const context=(identity)=>(request,code,permission)=>{if(identity.role!=='owner'&&!identity.permissions.includes(permission))throw Object.assign(Error('Недостаточно прав'),{status:403});
    return {identity,company:{code}};};
  const make=identity=>createReelAttributionHandler({attribution:f.attribution,companyModuleContext:context(identity),readJson:async()=>({revision:0,enabled:true}),send:(res,status,body)=>sent.push({status,body})});
  const viewer=make({userId:5,role:'manager',permissions:['analytics.view','crm.edit']});
  const url=path=>new URL(`http://crm.test${path}`);
  assert.equal(await viewer({method:'GET'},{},url('/social-stats/other?companyCode=demo-a')),false);
  await viewer({method:'GET'},{},url('/social-stats/reel-attribution?companyCode=demo-a&from=2026-11-01&to=2026-11-30'));
  assert.equal(sent.at(-1).status,200);assert.equal(sent.at(-1).body.mode,'NO_DATA');
  await assert.rejects(viewer({method:'PUT'},{},url('/social-stats/reel-attribution/settings?companyCode=demo-a')),e=>e.status===403);
  await assert.rejects(viewer({method:'POST'},{},url('/social-stats/reel-attribution?companyCode=demo-a')),e=>e.status===405);
  const owner=make({userId:1,role:'owner',permissions:[]});
  await owner({method:'PUT'},{},url('/social-stats/reel-attribution/settings?companyCode=demo-a'));
  assert.equal(sent.at(-1).body.enabled,true);assert.equal(f.attribution.getSettings('demo-a').enabled,true);
});
