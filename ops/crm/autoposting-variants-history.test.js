'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');
function fixture(t,{workflow}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
 INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'qa','QA','Asia/Irkutsk','[]'),(2,'other','Other','UTC','[]'),(3,'palitra-love','Palitra','Europe/Moscow','[]');`);
 let time=Date.parse('2026-10-01T00:00:00Z');const calls=[],channels=['telegram','vk','instagram'].map(id=>({id,platform:id,enabled:true,connected:true,revision:1}));
 const information=createCompanyInformation(db,{now:()=>time}),transport={approvalDestination:(_code,id)=>{const channel=channels.find(item=>item.id===id);return {destinationRevision:channel?.revision||0,channelRevision:channel?.revision||0};},getSettings:()=>({channels}),publish:async input=>{calls.push(input);return {externalId:'synthetic-1',url:'https://example.test/post'};}};
 const options={information,transport,workflow,now:()=>time,logger:{warn(){}}},api=createAutoposting(db,options),actor={userId:7,userName:'Редактор'};
 const draft=(body={},code='qa')=>api.create(code,{title:'Исходная идея',text:'Исходный текст',mediaUrls:['https://example.test/photo.png'],platformIds:['telegram'],scheduledAt:new Date(time+60000).toISOString(),...body},7);
 const body=(p,key='variant-request-1',platformId='vk')=>({revision:p.revision,clientRequestId:key,platformId});
 return {db,api,options,information,transport,calls,actor,draft,body,advance:ms=>time+=ms};
}
const rows=(db,table)=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshots=db=>Object.fromEntries(['autoposting_posts','autoposting_reviews','autoposting_platform_reviews','autoposting_deliveries','autoposting_variant_links','autoposting_variant_requests'].map(table=>[table,rows(db,table)]));
const errorCode=code=>e=>e.status===409&&e.details.code===code;

test('CF20: полная история страницами — чистый SELECT, стабильный курсор, компания и архив',t=>{
 const f=fixture(t),p=f.draft(),other=f.draft({},'other'),empty=f.draft();
 const insert=f.db.prepare('INSERT INTO autoposting_reviews(post_id,company_id,action,content_revision,comment,actor_name,created_at) VALUES(?,?,?,?,?,?,?)');
 const actions=['submitted','approved','rejected','revoked','edited','reordered','rescheduled'];
 for(let i=0;i<145;i++){
  insert.run(p.id,1,actions[i%actions.length],1+Math.floor(i/20),`Комментарий ${i}\nВторая строка`,i%2?'Редактор':null,'2026-10-01T00:00:00.000Z');
  insert.run(other.id,2,'approved',1,'Другой проект','Другой автор','2026-10-01T00:00:00.000Z');
 }
 // Даже ошибочная чужая строка с тем же post_id не раскрывается новым API.
 insert.run(p.id,2,'approved',1,'Чужая компания','Чужой автор','2026-10-01T00:00:00.000Z');
 f.db.prepare("UPDATE autoposting_posts SET archived_at='2026-10-01T00:00:00.000Z',status='scheduled',profile_revision=-1,content_revision=9 WHERE id=?").run(p.id);
 const expected=f.db.prepare('SELECT id,action,content_revision contentRevision,comment,actor_name actorName,created_at createdAt FROM autoposting_reviews WHERE post_id=? AND company_id=1 ORDER BY id DESC').all(p.id);
 const before=snapshots(f.db),changes=f.db.prepare('SELECT total_changes() n').get().n;
 f.db.exec('PRAGMA query_only=ON');f.information.get=()=>{throw Error('Нельзя get/invalidate');};f.db.exec=()=>{throw Error('Нельзя BEGIN/write');};
 const first=f.api.history(p.id,'QA');assert.equal(first.items.length,30);assert.equal(first.hasMore,true);assert.equal(first.nextBefore,first.items.at(-1).id);
 assert.equal(first.companyCode,'qa');assert.equal(first.postId,p.id);assert.equal(first.contentRevision,9);
 const all=[];let cursor;do{const page=f.api.history(p.id,'qa',{limit:100,...(cursor===undefined?{}:{before:cursor})});all.push(...page.items);cursor=page.nextBefore;}while(cursor!==null);
 assert.deepEqual(all,expected);assert.equal(new Set(all.map(item=>item.id)).size,145);
 assert.deepEqual(f.api.history(empty.id,'qa'),{companyCode:'qa',postId:empty.id,contentRevision:1,items:[],hasMore:false,nextBefore:null});
 assert.throws(()=>f.api.history(p.id,'other'),e=>e.status===404);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);assert.deepEqual(snapshots(f.db),before);assert.equal(f.db.isTransaction,false);
});

test('CF20: история строго проверяет limit/before/body и не выдумывает записи',t=>{
 const f=fixture(t),p=f.draft();
 for(const options of [null,[],{limit:0},{limit:101},{limit:'30'},{limit:1.5},{limit:null},{before:0},{before:'1'},{before:null},{before:Number.MAX_SAFE_INTEGER+1},{companyCode:'other'}])
  assert.throws(()=>f.api.history(p.id,'qa',options),e=>e.status===400);
 assert.throws(()=>f.api.history(999,'qa'),e=>e.status===404);
 assert.deepEqual(f.api.history(p.id,'qa',{before:1,limit:1}).items,[]);
});

test('CF20: новый draft копирует разрешённое содержимое/SHA guards, исходник и другие карточки неизменны',t=>{
 const f=fixture(t);let p=f.draft({dayKey:'D1',captions:{telegram:'Подпись Telegram',vk:'Подпись ВК'},platformIds:['telegram','vk'],format:'reel',role:'reach',hook:'Старый hook',methodSource:'Частный метод',mediaSha256:'a'.repeat(64),platformOptions:{instagram:{is_reels:true},max:{pin_message:true}}});
 p=f.api.approve(p.id,'qa',{revision:p.revision,approved:true},f.actor);f.draft({title:'Не менять'});
 f.db.prepare('UPDATE autoposting_posts SET expected_media_sha256=?,expected_media_file=? WHERE id=?').run('a'.repeat(64),'clip.mp4',p.id);
 const profile=f.information.save('qa',{revision:f.information.get('qa').revision,profile:{name:'Новые данные компании'}},7);assert.ok(profile.revision>p.profileRevision);
 const before=snapshots(f.db),source=before.autoposting_posts.find(row=>row.id===p.id);
 f.information.get=()=>{throw Error('createVariant не должен актуализировать другие карточки');};
 const result=f.api.createVariant(p.id,'QA',f.body(p),f.actor),child=result.post;
 assert.equal(result.companyCode,'qa');assert.equal(result.created,true);assert.equal(child.status,'draft');assert.equal(child.scheduledAt,null);assert.equal(child.dayKey,'');
 assert.equal(child.text,p.text);assert.equal(child.title,p.title);assert.deepEqual(child.mediaUrls,p.mediaUrls);assert.deepEqual(child.platformIds,['vk']);assert.deepEqual(child.captions,{vk:'Подпись ВК'});assert.deepEqual(child.platformOptions,{});
 assert.equal(child.profileRevision,p.profileRevision);assert.notEqual(child.profileRevision,profile.revision);assert.equal(child.timezone,p.timezone);assert.equal(child.mediaSha256,p.mediaSha256);assert.equal(child.expectedMediaSha256,'a'.repeat(64));assert.equal(child.expectedMediaFile,'clip.mp4');
 assert.equal(child.meta.format,'reel');assert.equal(child.meta.role,'reach');assert.equal(child.meta.hook,'');assert.equal(child.meta.methodSource,'');
 assert.equal(child.approvalRequired,true);assert.equal(child.approval.approved,false);assert.equal(child.approval.approvedRevision,null);assert.equal(child.platformApprovals[0].state,'pending');
 assert.deepEqual(child.deliveries,[]);assert.deepEqual(child.externalReceipts,[]);assert.deepEqual(child.history,[]);
 assert.deepEqual(child.variantOf,{postId:p.id,revision:p.revision,contentRevision:p.contentRevision});assert.deepEqual(child.rootIdea,{postId:p.id,contentRevision:p.contentRevision});
 assert.deepEqual(rows(f.db,'autoposting_posts').filter(row=>row.id!==child.id),before.autoposting_posts);assert.deepEqual(rows(f.db,'autoposting_reviews'),before.autoposting_reviews);
 assert.deepEqual(rows(f.db,'autoposting_deliveries'),before.autoposting_deliveries);assert.equal(rows(f.db,'autoposting_variant_links').length,1);assert.equal(rows(f.db,'autoposting_variant_requests').length,1);
 assert.deepEqual(f.db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(p.id),source);assert.equal(f.calls.length,0);
});

test('CF20: из опубликованной карточки создаётся новая версия без изменения истории доставки',t=>{
 const f=fixture(t),p=f.draft();f.db.prepare("UPDATE autoposting_posts SET status='published' WHERE id=?").run(p.id);
 f.db.prepare("INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision,status,external_id) VALUES(?,'telegram',1,'published','old-publication')").run(p.id);
 const before=snapshots(f.db),result=f.api.createVariant(p.id,'qa',f.body(p),f.actor);
 assert.equal(result.post.status,'draft');assert.deepEqual(result.post.deliveries,[]);assert.deepEqual(rows(f.db,'autoposting_deliveries'),before.autoposting_deliveries);
 assert.deepEqual(rows(f.db,'autoposting_posts').filter(row=>row.id!==result.post.id),before.autoposting_posts);
});

test('CF20: медиа-only Story сохраняет только свои публичные options и требует нового решения',t=>{
 const f=fixture(t),p=f.draft({text:'',platformIds:['instagram'],format:'story',role:'affection',platformOptions:{instagram:{is_story:true,disable_comment:false},max:{pin_message:true}}});
 const child=f.api.createVariant(p.id,'qa',f.body(p,'story-variant-1','instagram'),f.actor).post;
 assert.equal(child.text,'');assert.equal(child.readiness.mediaOnlyStory,true);assert.equal(child.approvalRequired,true);assert.equal(child.approval.approved,false);
 assert.deepEqual(child.platformOptions,{instagram:{disable_comment:false,is_story:true}});assert.equal(child.meta.format,'story');assert.equal(child.meta.role,'affection');
});

test('CF20: durable replay возвращает первоначальный DTO после правки/архива источника и ребёнка, без get',t=>{
 const f=fixture(t),p=f.draft(),body=f.body(p),first=f.api.createVariant(p.id,'qa',body,f.actor);
 let child=f.api.update(first.post.id,'qa',{revision:first.post.revision,title:'Ручная версия',text:'Другой текст'},f.actor);
 f.api.archive(child.id,'qa',{revision:child.revision},f.actor);f.api.archive(p.id,'qa',{revision:p.revision},f.actor);
 const api=createAutoposting(f.db,f.options),before=snapshots(f.db),changes=f.db.prepare('SELECT total_changes() n').get().n;
 f.information.get=()=>{throw Error('Replay не должен вызывать get');};
 const replay=api.createVariant(p.id,'QA',{platformId:' vk ',clientRequestId:body.clientRequestId,revision:body.revision},{userId:8,userName:'Другой редактор'});
 assert.deepEqual(replay,{...first,created:false});assert.equal(replay.post.archive.archivedAt,null);assert.equal(replay.post.title,'Исходная идея');
 assert.deepEqual(snapshots(f.db),before);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);assert.equal(f.db.isTransaction,false);
});

test('CF20: request payload конфликтует при замене источника/revision/площадки, компания изолирует ключ',t=>{
 const f=fixture(t),p=f.draft(),p2=f.draft(),foreign=f.draft({},'other'),body=f.body(p),first=f.api.createVariant(p.id,'qa',body,f.actor);
 for(const patch of [{revision:p.revision+1},{platformId:'instagram'}])assert.throws(()=>f.api.createVariant(p.id,'qa',{...body,...patch},f.actor),errorCode('REQUEST_CONFLICT'));
 assert.throws(()=>f.api.createVariant(p2.id,'qa',body,f.actor),errorCode('REQUEST_CONFLICT'));
 assert.throws(()=>f.api.createVariant(p.id,'other',body,f.actor),e=>e.status===404);
 const other=f.api.createVariant(foreign.id,'other',f.body(foreign),f.actor);assert.notEqual(first.post.id,other.post.id);assert.equal(other.companyCode,'other');
 assert.deepEqual(f.api.createVariant(p.id,'qa',body,f.actor),{...first,created:false});assert.equal(rows(f.db,'autoposting_variant_requests').length,2);
});

test('CF20: строгие fields/revision/company/archive/legacy-plan guards не создают ребёнка',t=>{
 const f=fixture(t),p=f.draft(),body=f.body(p);
 for(const invalid of [null,[],{}, {...body,revision:0},{...body,revision:'1'},{...body,clientRequestId:'short'}, {...body,platformId:'custom-channel'}, {...body,scheduledAt:'2026-10-02T00:00:00Z'}, {...body,variantOf:{postId:1}},{...body,approved:true}])
  assert.throws(()=>f.api.createVariant(p.id,'qa',invalid,f.actor),e=>e.status===400);
 assert.throws(()=>f.api.createVariant(p.id,'qa',{...body,revision:99},f.actor),errorCode('REVISION_CONFLICT'));
 assert.throws(()=>f.api.createVariant(p.id,'other',body,f.actor),e=>e.status===404);
 f.db.exec(`CREATE TABLE media_mentor_variant_transfers(post_id INTEGER,company_id INTEGER,idea_id TEXT,platform TEXT,content_revision INTEGER,plan_revision INTEGER,brief_revision INTEGER);
 CREATE TABLE media_mentor_plans(dummy INTEGER);CREATE TABLE media_mentor_briefs(dummy INTEGER);CREATE TABLE media_mentor_variant_approvals(dummy INTEGER);`);
 f.db.prepare('INSERT INTO media_mentor_variant_transfers VALUES(?,1,\'idea-1\',\'telegram\',1,1,1)').run(p.id);
 assert.throws(()=>f.api.createVariant(p.id,'qa',body,f.actor),errorCode('PLAN_LINKED_POST'));
 f.api.archive(p.id,'qa',{revision:p.revision},f.actor);assert.throws(()=>f.api.createVariant(p.id,'qa',body,f.actor),errorCode('POST_ARCHIVED'));
 assert.equal(rows(f.db,'autoposting_posts').length,1);assert.deepEqual(rows(f.db,'autoposting_variant_links'),[]);assert.deepEqual(rows(f.db,'autoposting_variant_requests'),[]);
});

for(const table of ['autoposting_variant_links','autoposting_variant_requests'])test(`CF20: отказ INSERT ${table} откатывает child/link/platform approval/receipt вместе`,t=>{
 const f=fixture(t),p=f.draft(),before=snapshots(f.db);
 f.db.exec(`CREATE TRIGGER refuse_variant BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'variant write refused'); END;`);
 assert.throws(()=>f.api.createVariant(p.id,'qa',f.body(p),f.actor),/variant write refused/);assert.deepEqual(snapshots(f.db),before);assert.equal(f.db.isTransaction,false);
});

test('CF20: связь требует собственного решения даже после очистки captions/dayKey',async t=>{
 const f=fixture(t);let p=f.draft({dayKey:'D1',captions:{telegram:'Прежняя подпись'}});p=f.api.approve(p.id,'qa',{revision:p.revision,approved:true},f.actor);
 const first=f.api.createVariant(p.id,'qa',f.body(p,'approval-variant-1','telegram'),f.actor);
 let child=f.api.update(first.post.id,'qa',{revision:first.post.revision,captions:{},dayKey:''},f.actor);assert.equal(child.approvalRequired,true);assert.equal(child.approval.approved,false);
 await assert.rejects(f.api.schedule(child.id,'qa',{revision:child.revision,scheduledAt:'2026-10-01T00:01:00Z'}),errorCode('APPROVAL_REQUIRED'));
 child=f.api.approve(child.id,'qa',{revision:child.revision,approved:true},f.actor);child=await f.api.schedule(child.id,'qa',{revision:child.revision,scheduledAt:'2026-10-01T00:01:00Z'});
 assert.equal(child.status,'scheduled');assert.equal(child.approval.approved,true);assert.equal(f.api.get(p.id,'qa').approval.approved,true);assert.equal(f.calls.length,0);
});

test('CF20: потомок сохраняет rootIdea, а immediate source фиксирует новую версию содержимого',t=>{
 const f=fixture(t),p=f.draft(),first=f.api.createVariant(p.id,'qa',f.body(p),f.actor);
 const changed=f.api.update(first.post.id,'qa',{revision:first.post.revision,text:'Адаптация для другой площадки'},f.actor);
 const next=f.api.createVariant(changed.id,'qa',f.body(changed,'variant-descendant-1','instagram'),f.actor).post;
 assert.deepEqual(next.variantOf,{postId:changed.id,revision:changed.revision,contentRevision:changed.contentRevision});assert.deepEqual(next.rootIdea,first.post.rootIdea);assert.equal(next.text,changed.text);
 assert.equal(f.api.get(p.id,'qa').variantOf,null);assert.equal(f.api.get(p.id,'qa').rootIdea,null);
});

test('CF20: manual workflow запрещает только новую очередь до settings; approve/variant разрешены',async t=>{
 let settingsCalls=0;const workflow={get:()=>({configured:true,fields:{releaseMode:'manual'}})},f=fixture(t,{workflow});
 const p=f.draft(),palitra=f.draft({},'palitra-love'),before=snapshots(f.db);
 f.transport.getSettings=()=>{settingsCalls++;throw Error('Manual не должен читать transport settings');};
 await assert.rejects(f.api.schedule(p.id,'qa',{revision:p.revision}),errorCode('WORKFLOW_MANUAL_MODE'));
 await assert.rejects(f.api.approveAndSchedule(palitra.id,'palitra-love',{revision:palitra.revision,approved:true,schedule:true},f.actor),errorCode('WORKFLOW_MANUAL_MODE'));
 assert.equal(settingsCalls,0);assert.deepEqual(snapshots(f.db),before);
 assert.equal(f.api.approve(p.id,'qa',{revision:p.revision,approved:true},f.actor).approval.approved,true);
 assert.equal(f.api.createVariant(palitra.id,'palitra-love',f.body(palitra),f.actor).post.status,'draft');
});

test('CF20: смена workflow во время await settings запрещает schedule без доставки',async t=>{
 let manual=false;const workflow={get:()=>({configured:true,fields:{releaseMode:manual?'manual':'automatic'}})},f=fixture(t,{workflow}),p=f.draft(),before=snapshots(f.db);
 const settings=f.transport.getSettings();f.transport.getSettings=async()=>{manual=true;return settings;};
 await assert.rejects(f.api.schedule(p.id,'qa',{revision:p.revision}),errorCode('WORKFLOW_MANUAL_MODE'));assert.deepEqual(snapshots(f.db),before);assert.equal(f.calls.length,0);
});

test('CF20: manual после await откатывает approveAndSchedule вместе с новым решением/историей',async t=>{
 let manual=false;const workflow={get:()=>({configured:true,fields:{releaseMode:manual?'manual':'automatic'}})},f=fixture(t,{workflow}),p=f.draft({},'palitra-love'),before=snapshots(f.db);
 const settings=f.transport.getSettings();f.transport.getSettings=async()=>{manual=true;return settings;};
 await assert.rejects(f.api.approveAndSchedule(p.id,'palitra-love',{revision:p.revision,approved:true,schedule:true},f.actor),errorCode('WORKFLOW_MANUAL_MODE'));
 assert.deepEqual(snapshots(f.db),before);assert.equal(f.db.isTransaction,false);assert.equal(f.calls.length,0);
});

test('CF20: unconfigured manual сохраняет прежнюю постановку; ранее назначенная очередь при manual не меняется',async t=>{
 let configured=false;const workflow={get:()=>({configured,fields:{releaseMode:'manual'}})},f=fixture(t,{workflow}),p=f.draft();
 const scheduled=await f.api.schedule(p.id,'qa',{revision:p.revision});assert.equal(scheduled.status,'scheduled');configured=true;
 f.advance(60000);await f.api.drain();assert.equal(f.calls.length,1);assert.equal(f.api.get(p.id,'qa').status,'published');
});
