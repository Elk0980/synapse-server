'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createReviews}=require('./reviews');
function fixture(t) {
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,name TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES('alvi','ALVI','[]',0),('avokado','Авокадо','[]',0),('deleted','Deleted','[]',1);`);
  let now=Date.parse('2026-09-17T12:00:00Z');const options={now:()=>now},api=createReviews(db,options);
  t.after(()=>db.close());
  const body={platform:'two_gis',author:'Анна',rating:5,text:'Приятная студия',publishedAt:'2026-09-16',sourceUrl:'https://2gis.ru/irkutsk/firm/123/tab/reviews'};
  return {db,api,body,options,advance(){now+=60000;},create:(changes={},code='avokado')=>api.create(code,{...body,...changes})};
}
const errorCode=(code,status=400)=>error=>{assert.equal(error.code,code);assert.equal(error.status,status);return true;};

test('empty company state is honest; platform links follow company socials without credentials or cross-company inheritance',t=>{
  const f=fixture(t);
  f.db.prepare('UPDATE companies SET socials=? WHERE code=?').run(JSON.stringify([
    {type:'two_gis',url:'https://2gis.ru/irkutsk/firm/123'},
    {type:'yandex_maps',url:'https://yandex.ru/maps/org/123/'},
    {type:'vk',url:'https://vk.com/club12?access_token=PRIVATE'},
    {type:'flamp',url:'https://irkutsk.flamp.ru/firm/123'},
  ]),'avokado');
  const state=f.api.list('AVOKADO');assert.deepEqual(state.company,{code:'avokado',name:'Авокадо'});
  assert.deepEqual(state.items,[]);assert.deepEqual(state.counts,{total:0,new:0,in_progress:0,answered:0});
  assert.deepEqual(state.platforms.map(p=>p.key),['two_gis','yandex_maps','vk','flamp','other']);
  for(const p of state.platforms){assert.equal(p.canSync,false);assert.equal(p.canReply,false);assert.equal(p.syncMode,'manual');assert.equal(p.rules,'');assert.equal(p.revision,0);}
  assert.equal(state.platforms[0].publicUrl,'https://2gis.ru/irkutsk/firm/123');
  assert.equal(state.platforms[2].publicUrl,'');assert.equal(state.platforms[3].publicUrl,'https://irkutsk.flamp.ru/firm/123');
  assert.ok(f.api.list('alvi').platforms.every(p=>p.publicUrl===''));
  assert.doesNotMatch(JSON.stringify(state),/PRIVATE|access_token/);
  for(const code of ['deleted','missing'])assert.throws(()=>f.api.list(code),errorCode('NOT_FOUND',404));
  for(const code of ['','../avokado'])assert.throws(()=>f.api.list(code),errorCode('VALIDATION_ERROR'));
});

test('manual ingestion is durable and idempotent by external ID or exact normalized content within company and platform',t=>{
  const f=fixture(t),first=f.create();assert.equal(first.duplicate,false);assert.equal(first.item.status,'new');
  assert.equal(first.item.publishedAt,'2026-09-16T00:00:00.000Z');assert.equal(first.item.confirmationMode,null);
  const again=f.create({text:'  Приятная студия  '});assert.equal(again.duplicate,true);assert.equal(again.item.id,first.item.id);
  const imported=f.create({externalId:'review-12'});const changed=f.create({externalId:'review-12',text:'Не перезаписывать по повтору',rating:1});
  assert.equal(changed.duplicate,true);assert.equal(changed.item.text,imported.item.text);assert.equal(changed.item.rating,5);
  assert.equal(f.create({externalId:'review-12'},'alvi').duplicate,false);
  assert.equal(f.create({externalId:'review-12',platform:'vk',sourceUrl:'https://vk.com/wall-12_1'}).duplicate,false);
  const reopened=createReviews(f.db,f.options);assert.equal(reopened.list('avokado').items.length,3);
  assert.equal(reopened.list('alvi').items.length,1);
});

test('review updates are scoped and optimistic; only actual manual evidence can label an answer published',t=>{
  const f=fixture(t),created=f.create().item;
  assert.throws(()=>f.api.update('alvi',created.id,{revision:1,note:'foreign'}),errorCode('NOT_FOUND',404));
  assert.throws(()=>f.api.update('avokado',created.id,{revision:0,note:'stale'}),errorCode('REVISION_CONFLICT',409));
  let row=f.api.update('avokado',created.id,{revision:1,draftReply:'Спасибо!',status:'in_progress',note:'Уточнить у мастера'}).item;
  assert.equal(row.revision,2);assert.equal(row.publishedReply,'');assert.equal(row.confirmationMode,null);
  for(const body of [{status:'answered'},{status:'answered',publishedReply:'Спасибо!'},
    {status:'answered',replyUrl:'https://2gis.ru/irkutsk/firm/123/tab/reviews'}]) {
    assert.throws(()=>f.api.update('avokado',row.id,{revision:2,...body}),errorCode('CONFIRMATION_REQUIRED'));
  }
  row=f.api.update('avokado',row.id,{revision:2,status:'answered',publishedReply:'Спасибо!',replyUrl:'https://2gis.ru/irkutsk/firm/123/tab/reviews?review_id=review-12'}).item;
  assert.equal(row.confirmationMode,'manual');assert.equal(row.confirmedAt,'2026-09-17T12:00:00.000Z');
  assert.deepEqual(f.api.list('avokado').counts,{total:1,new:0,in_progress:0,answered:1});
  f.advance();row=f.api.update('avokado',row.id,{revision:3,draftReply:'Новый черновик'}).item;
  assert.equal(row.publishedReply,'Спасибо!');assert.equal(row.confirmedAt,'2026-09-17T12:00:00.000Z');
  assert.throws(()=>f.api.update('avokado',row.id,{revision:4,replyUrl:''}),errorCode('CONFIRMATION_REQUIRED'));
  row=f.api.update('avokado',row.id,{revision:4,status:'in_progress'}).item;assert.equal(row.confirmedAt,null);assert.equal(row.confirmationMode,null);
  assert.throws(()=>f.api.update('avokado',row.id,{revision:5,companyCode:'alvi'}),errorCode('VALIDATION_ERROR'));
});

test('atomic revision CAS prevents overwriting a concurrent edit even after loading the previous row',t=>{
  const f=fixture(t),row=f.create().item;let inject=true;
  const wrapped={exec(sql){if(inject&&sql==='BEGIN IMMEDIATE'){inject=false;f.db.prepare('UPDATE company_reviews SET revision=revision+1,note=? WHERE id=?').run('Concurrent',row.id);}return f.db.exec(sql);},prepare:sql=>f.db.prepare(sql)};
  const api=createReviews(wrapped,f.options);
  assert.throws(()=>api.update('avokado',row.id,{revision:1,note:'Lost update'}),errorCode('REVISION_CONFLICT',409));
  assert.equal(f.api.list('avokado').items[0].note,'Concurrent');
});

test('platform rules and official cabinet links persist independently; stale edits and secret-bearing redirects fail',t=>{
  const f=fixture(t),body={revision:0,cabinetUrl:'https://account.2gis.com/',rules:'Приветствие; факты; приглашение связаться с администратором.'};
  const saved=f.api.savePlatform('avokado','two_gis',body).platform;assert.equal(saved.revision,1);assert.equal(saved.rules,body.rules);
  assert.equal(f.api.list('alvi').platforms[0].rules,'');
  assert.throws(()=>f.api.savePlatform('avokado','two_gis',body),errorCode('REVISION_CONFLICT',409));
  assert.equal(createReviews(f.db,f.options).list('avokado').platforms[0].rules,body.rules);
  for(const cabinetUrl of ['https://account.2gis.com.evil.org/','https://evil.org/','http://account.2gis.com/',
    'https://user:pass@account.2gis.com/','https://account.2gis.com/?token=PRIVATE','https://account.2gis.com/#access_token=PRIVATE'])
    assert.throws(()=>f.api.savePlatform('avokado','two_gis',{...body,revision:1,cabinetUrl}),errorCode('CABINET_LINK_INVALID'));
  const flamp=f.api.savePlatform('avokado','flamp',{...body,cabinetUrl:'https://flamp.ru/',rules:''}).platform;
  assert.equal(flamp.cabinetUrl,'https://flamp.ru/');assert.equal(flamp.cabinetLabel,'Открыть Flamp');
  assert.equal(f.api.savePlatform('avokado','other',{...body,cabinetUrl:'',rules:''}).platform.cabinetUrl,'');
});

test('official cabinet deep links permit ordinary navigation but reject authentication query and fragment values',t=>{
  const f=fixture(t);let revision=0;
  for(const cabinetUrl of ['https://account.2gis.com/?id=123','https://account.2gis.com/#/firm/123/reviews',
    'https://account.2gis.com/?sectionId=reviews&subsectionId=all&act=list',
    'https://account.2gis.com/#/firm/123?sectionId=reviews']) {
    const row=f.api.savePlatform('avokado','two_gis',{revision,cabinetUrl,rules:''}).platform;
    revision=row.revision;assert.equal(row.cabinetUrl,cabinetUrl);
  }
  for(const cabinetUrl of ['https://account.2gis.com/?token=PRIVATE','https://account.2gis.com/#/firm/123?access_token=PRIVATE',
    'https://account.2gis.com/#access%5Ftoken=PRIVATE','https://account.2gis.com/?session=PRIVATE',
    'https://account.2gis.com/?redirect=https://evil.org/','https://account.2gis.com/#code=PRIVATE']) {
    assert.throws(()=>f.api.savePlatform('avokado','two_gis',{revision,cabinetUrl,rules:''}),error=>{
      assert.equal(error.code,'CABINET_LINK_INVALID');assert.match(error.message,/без пароля/);assert.doesNotMatch(error.message,/PRIVATE/);return true;
    });
  }
});

test('untrusted links, malformed values and unsupported status fields are rejected without exposing raw input',t=>{
  const f=fixture(t);
  for(const sourceUrl of ['javascript:alert(1)','http://2gis.ru/a','https://2gis.ru:444/a','https://2gis.ru.evil.org/a',
    'https://2gis.ru/a?api_key=PRIVATE','https://2gis.ru/a?code=PRIVATE','https://u:PRIVATE@2gis.ru/a',
    'https://2gis.ru/a#access_token=PRIVATE','https://127.0.0.1/a','https://[::1]/a','https://localhost/a',
    'https://evil.internal/a','https://evil.test/a']) {
    assert.throws(()=>f.create({sourceUrl}),error=>{assert.equal(error.status,400);assert.doesNotMatch(error.message,/PRIVATE/);return true;});
  }
  for(const sourceUrl of ['https://127.0.0.1/a','https://localhost/a','https://evil.internal/a'])assert.throws(()=>f.create({platform:'other',sourceUrl}),errorCode('VALIDATION_ERROR'));
  for(const changes of [{platform:'unknown'},{author:''},{text:''},{text:'x'.repeat(12001)},{rating:0},{rating:5.1},{rating:'5'},
    {publishedAt:'2026-02-30'},{publishedAt:'not a date'},{externalId:{}},{companyCode:'alvi'}])assert.throws(()=>f.create(changes),errorCode('VALIDATION_ERROR'));
  const row=f.create().item;
  for(const body of [null,[],{revision:'1'},{revision:1,status:'published'},{revision:1,status:null},{revision:1,replyUrl:'https://vk.com/wall1_1'},
    {revision:1,note:3},{revision:1,text:'Cannot silently replace source review'}])assert.throws(()=>f.api.update('avokado',row.id,body),errorCode('VALIDATION_ERROR'));
  assert.equal(f.api.list('avokado').items.length,1);
});

test('manual confirmation records actor and immutable evidence transactionally; draft edits retain the original confirmer',t=>{
  const f=fixture(t),owner={userId:9,userName:'Владелец'},editor={userId:10,userName:'Администратор'};
  let row=f.api.create('avokado',f.body,editor).item;
  row=f.api.update('avokado',row.id,{revision:1,status:'answered',publishedReply:'Спасибо за отзыв',replyUrl:row.sourceUrl},owner).item;
  assert.deepEqual(row.confirmationBy,{userId:9,name:'Владелец'});
  row=f.api.update('avokado',row.id,{revision:2,draftReply:'Позже исправить ответ'},editor).item;
  assert.deepEqual(row.confirmationBy,{userId:9,name:'Владелец'});
  row=f.api.update('avokado',row.id,{revision:3,status:'in_progress'},editor).item;
  assert.equal(row.confirmationBy,null);
  const history=f.db.prepare('SELECT * FROM company_review_events ORDER BY id').all();assert.equal(history.length,4);
  assert.equal(history[1].action,'manual_confirmation');assert.equal(history[1].actor_id,9);
  assert.deepEqual(JSON.parse(history[1].payload).publishedReply,'Спасибо за отзыв');
  assert.equal(history[1].company_code,'avokado');assert.equal(history[3].actor_id,10);
  assert.throws(()=>f.api.update('avokado',row.id,{revision:1,note:'stale'},owner),errorCode('REVISION_CONFLICT',409));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM company_review_events').get().n,4);
});

test('pagination is explicit and stable while counts include the entire selected company',t=>{
  const f=fixture(t);for(let n=1;n<=5;n++)f.create({externalId:'page-'+n});f.create({},'alvi');
  const first=f.api.list('avokado',{limit:2,offset:0}),next=f.api.list('avokado',{limit:2,offset:2}),last=f.api.list('avokado',{limit:2,offset:4});
  assert.deepEqual(first.pagination,{total:5,limit:2,offset:0,hasMore:true});assert.equal(first.counts.new,5);
  assert.deepEqual(first.items.map(i=>i.externalId),['page-5','page-4']);assert.deepEqual(next.items.map(i=>i.externalId),['page-3','page-2']);
  assert.equal(last.items.length,1);assert.equal(last.pagination.hasMore,false);
  for(const options of [{limit:0},{limit:201},{limit:NaN},{offset:-1},{offset:1.2}])assert.throws(()=>f.api.list('avokado',options),errorCode('VALIDATION_ERROR'));
});

test('server filters cover the whole company before pagination with Cyrillic case-insensitive literal search',t=>{
  const f=fixture(t);
  f.create({externalId:'a',author:'МАРИЯ',text:'Отличный массаж'});
  const changed=f.create({externalId:'b',author:'Ольга',text:'Помогите выбрать'}).item;
  f.api.update('avokado',changed.id,{revision:1,status:'in_progress',draftReply:'Приглашаем на Консультацию'});
  f.create({externalId:'c',platform:'vk',sourceUrl:'https://vk.com/wall-1_3',author:'Мария',text:'Отличный уход'});
  f.create({externalId:'other-company',author:'Мария'},'alvi');
  const matched=f.api.list('avokado',{q:'мария',limit:1,offset:1});
  assert.equal(matched.pagination.total,2);assert.equal(matched.items[0].externalId,'a');assert.equal(matched.counts.total,3);
  assert.equal(f.api.list('avokado',{q:'КОНСУЛЬТАЦИЮ',status:'in_progress',platform:'two_gis'}).items[0].externalId,'b');
  assert.equal(f.api.list('avokado',{q:'%',platform:'two_gis'}).pagination.total,0);
  assert.equal(f.api.list('avokado',{q:'мария',platform:'vk',status:'new'}).pagination.total,1);
  assert.equal(f.api.list('alvi',{q:'Консультацию'}).pagination.total,0);
  for(const filter of [{status:'published'},{platform:'evil'},{q:null},{q:'x'.repeat(301)}])assert.throws(()=>f.api.list('avokado',filter),errorCode('VALIDATION_ERROR'));
});
