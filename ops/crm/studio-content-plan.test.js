'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');
const {createStudioContentPlan}=require('./studio-content-plan');
const data=require('./studio-content-plan-data.json');

function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES
      (1,'alvi','ALVI','Asia/Irkutsk','[]'),(2,'avokado','Авокадо','Asia/Irkutsk','[]'),(3,'other','Другая компания','UTC','[]');`);
  const calls=[],now=()=>Date.parse('2026-09-17T05:00:00Z');
  const information=createCompanyInformation(db,{now});
  const autoposting=createAutoposting(db,{information,now,transport:{
    getSettings:()=>{throw Error('Import must not access publication settings');},
    publish:async input=>{calls.push(input);throw Error('Import must not publish');}
  }});
  const options={information,autoposting,now},api=createStudioContentPlan(db,options);
  const payload=(code='alvi',platform='vk')=>({platform,profileRevision:information.get(code).revision});
  return {db,information,autoposting,options,api,payload,calls};
}

test('preview contains seven company-specific themes, review notice and metadata without creating posts',t=>{
  const f=fixture(t),alvi=f.api.get('ALVI'),avokado=f.api.get('avokado');
  assert.equal(alvi.available,true);assert.equal(alvi.companyCode,'alvi');assert.equal(alvi.topics.length,7);
  assert.equal(avokado.topics.length,7);assert.equal(alvi.requiresLiveCompanyReview,true);
  assert.match(alvi.reviewNote,/не означает/);assert.equal(alvi.timezone,'Asia/Irkutsk');
  assert.deepEqual(alvi.platforms,['vk','telegram']);assert.deepEqual(alvi.imports,{vk:null,telegram:null});
  assert.ok(alvi.topics.every(p=>p.id.startsWith('alvi-')&&p.mediaBrief&&p.goal&&p.localTime));
  assert.ok(avokado.topics.every(p=>p.id.startsWith('avokado-')));
  assert.deepEqual(alvi.topics.map(p=>p.dayOffset),[0,1,2,3,4,5,6]);
  assert.deepEqual(f.api.get('other'),{available:false,companyCode:'other'});assert.deepEqual(f.api.get('missing'),{available:false,companyCode:'missing'});
  assert.deepEqual(f.api.get(null),{available:false,companyCode:null});
  assert.equal(f.db.prepare('SELECT count(*) count FROM autoposting_posts').get().count,0);
  assert.equal(f.db.prepare('SELECT count(*) count FROM studio_content_plan_imports').get().count,0);
  alvi.topics[0].title='Changed response';assert.notEqual(f.api.get('alvi').topics[0].title,'Changed response');
});

test('import creates exactly seven local drafts, no dates, channels, attachments, jobs or publication calls',async t=>{
  const f=fixture(t),result=f.api.import('ALVI',f.payload(),41);
  assert.equal(result.created,true);assert.equal(result.alreadyImported,false);assert.equal(result.companyCode,'alvi');
  assert.equal(result.postIds.length,7);assert.equal(result.posts.length,7);assert.equal(result.requiresLiveCompanyReview,true);
  const template=data.companies.find(c=>c.key==='alvi');
  for(const [index,post]of result.posts.entries()){
    assert.equal(post.status,'draft');assert.equal(post.scheduledAt,null);assert.deepEqual(post.platformIds,[]);assert.deepEqual(post.mediaUrls,[]);
    assert.deepEqual(post.deliveries,[]);assert.equal(post.timezone,'Asia/Irkutsk');assert.equal(post.profileRevision,result.profileRevision);
    assert.equal(post.text,template.posts[index].channelVariants.vk.body);assert.doesNotMatch(post.text,/Файл-кандидат|проверить выбранные фотографии|mediaBrief/);
    assert.match(post.text,/utm_source=vk/);assert.doesNotMatch(post.text,/avokado38\.ru/);
  }
  const rows=f.db.prepare('SELECT company_id,created_by FROM autoposting_posts').all();assert.ok(rows.every(r=>r.company_id===1&&r.created_by===41));
  assert.equal(f.db.prepare('SELECT count(*) count FROM autoposting_deliveries').get().count,0);
  await f.autoposting.drain();assert.equal(f.calls.length,0);
  assert.deepEqual(f.api.get('alvi').imports.vk.postIds,result.postIds);assert.equal(f.api.get('alvi').imports.telegram,null);
});

test('repeat import and service restart reuse the same drafts without overwriting edits or unrelated materials',t=>{
  const f=fixture(t),first=f.api.import('alvi',f.payload());
  const edited=f.autoposting.update(first.posts[0].id,'alvi',{revision:first.posts[0].revision,text:'Сохранённая правка владельца'});
  const unrelated=f.autoposting.create('alvi',{title:'Другой материал',text:'Сохранить',profileRevision:first.profileRevision});
  const api=createStudioContentPlan(f.db,f.options),again=api.import('ALVI',f.payload(),99);
  assert.equal(again.created,false);assert.equal(again.alreadyImported,true);assert.deepEqual(again.postIds,first.postIds);
  assert.equal(again.posts[0].text,edited.text);assert.equal(again.posts[0].revision,edited.revision);
  assert.equal(f.autoposting.get(unrelated.id,'alvi').text,'Сохранить');
  assert.equal(f.db.prepare('SELECT count(*) count FROM autoposting_posts').get().count,8);
  assert.equal(f.db.prepare('SELECT count(*) count FROM studio_content_plan_imports').get().count,1);
  assert.equal(f.db.prepare('SELECT count(*) count FROM studio_content_plan_items').get().count,7);
});

test('company and platform receipts are isolated, platform controls UTM only',t=>{
  const f=fixture(t),alviVk=f.api.import('alvi',f.payload()),alviTg=f.api.import('alvi',f.payload('alvi','telegram'));
  const avocado=f.api.import('avokado',f.payload('avokado','vk'));
  assert.equal(new Set([...alviVk.postIds,...alviTg.postIds,...avocado.postIds]).size,21);
  assert.ok(alviTg.posts.every(p=>p.text.includes('utm_source=telegram')&&!p.text.includes('utm_source=vk')));
  assert.ok(avocado.posts.every(p=>p.companyCode==='avokado'&&p.text.includes('https://avokado38.ru/')&&!p.text.includes('spaalvi-38.ru')));
  assert.deepEqual(f.api.get('alvi').imports.vk.postIds,alviVk.postIds);assert.deepEqual(f.api.get('avokado').imports.vk.postIds,avocado.postIds);
  assert.equal(f.api.get('avokado').imports.telegram,null);assert.equal(f.autoposting.list('other').posts.length,0);
  assert.throws(()=>f.autoposting.get(alviVk.postIds[0],'avokado'),e=>e.status===404);
});

test('insertion failure rolls back the whole batch and its receipt; retry still creates seven posts',t=>{
  const f=fixture(t),body=f.payload();
  f.db.exec(`CREATE TRIGGER fail_fourth_starter BEFORE INSERT ON autoposting_posts
    WHEN (SELECT count(*) FROM autoposting_posts WHERE company_id=NEW.company_id)>=3
    BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;`);
  assert.throws(()=>f.api.import('alvi',body),/simulated disk failure/);
  for(const table of ['autoposting_posts','autoposting_deliveries','studio_content_plan_imports','studio_content_plan_items']){
    assert.equal(f.db.prepare(`SELECT count(*) count FROM ${table}`).get().count,0,table);
  }
  f.db.exec('DROP TRIGGER fail_fourth_starter');assert.equal(f.api.import('alvi',body).postIds.length,7);
});

test('stale company version is rejected and importing at a new revision does not rewrite an earlier batch',t=>{
  const f=fixture(t),body=f.payload(),first=f.api.import('alvi',body);
  const current=f.information.get('alvi');f.information.save('alvi',{revision:current.revision,profile:{description:'Новые сведения владельца'}});
  assert.throws(()=>f.api.import('alvi',body),e=>e.status===409&&e.details.code==='PROFILE_CHANGED');
  const newBody=f.payload(),again=f.api.import('alvi',newBody);
  assert.equal(again.created,false);assert.deepEqual(again.postIds,first.postIds);
  assert.ok(again.posts.every(p=>p.profileRevision===body.profileRevision));
  assert.ok(newBody.profileRevision>body.profileRevision);assert.equal(f.db.prepare('SELECT count(*) count FROM autoposting_posts').get().count,7);
});

test('company version is checked again under the write lock before any insertion',t=>{
  const f=fixture(t),body=f.payload();
  const information={get(code){const snapshot=f.information.get(code);f.db.prepare('UPDATE company_information SET revision=revision+1 WHERE company_id=1').run();return snapshot;}};
  const api=createStudioContentPlan(f.db,{...f.options,information});
  assert.throws(()=>api.import('alvi',body),e=>e.status===409&&e.details.code==='PROFILE_CHANGED');
  assert.equal(f.db.prepare('SELECT count(*) count FROM autoposting_posts').get().count,0);
  assert.equal(f.db.prepare('SELECT count(*) count FROM studio_content_plan_imports').get().count,0);
});

test('unknown companies, deleted companies and invalid inputs cannot import anything',t=>{
  const f=fixture(t),body=f.payload();
  for(const code of ['other','missing','alvi/avokado',null])assert.throws(()=>f.api.import(code,body),e=>e.status===400&&e.details.code==='STARTER_PLAN_UNAVAILABLE');
  for(const payload of [{platform:'email',profileRevision:body.profileRevision},{platform:'vk'},{platform:'vk',profileRevision:'1'},
    {...body,companyCode:'avokado'},{...body,scheduledAt:'2026-09-18T00:00:00Z'},{...body,text:'injected'},null]){
    assert.throws(()=>f.api.import('alvi',payload),e=>e.status===400);
  }
  f.db.exec('UPDATE companies SET is_deleted=1 WHERE id=1');assert.throws(()=>f.api.import('alvi',body),e=>e.status===404);
  assert.equal(f.db.prepare('SELECT count(*) count FROM autoposting_posts').get().count,0);
});

test('failure while reading the committed response does not duplicate a successful import on retry',t=>{
  const f=fixture(t),body=f.payload();
  const failingApi=createStudioContentPlan(f.db,{...f.options,autoposting:{get(){throw Error('response interrupted');}}});
  assert.throws(()=>failingApi.import('alvi',body),/response interrupted/);
  const retry=f.api.import('alvi',body);assert.equal(retry.created,false);assert.equal(retry.posts.length,7);
  assert.equal(f.db.prepare('SELECT count(*) count FROM autoposting_posts').get().count,7);
});

test('bundled data contains no local paths or private conversation and keeps UTM before page fragments',()=>{
  const serialized=JSON.stringify(data);assert.doesNotMatch(serialized,/C:\\|C:\/|AppData|repositoryPath|sourceRefs|Татьяна|\.codex/);
  assert.equal(data.companies.length,2);
  for(const c of data.companies)for(const post of c.posts)for(const platform of ['vk','telegram']){
    const lines=post.channelVariants[platform].body.split('\n'),link=new URL(lines.at(-1));
    assert.equal(link.protocol,'https:');assert.equal(link.hostname,c.key==='alvi'?'spaalvi-38.ru':'avokado38.ru');
    assert.equal(link.searchParams.get('utm_source'),platform);assert.equal(link.searchParams.get('utm_content'),post.id);
    assert.doesNotMatch(link.hash,/utm_/);
  }
});
