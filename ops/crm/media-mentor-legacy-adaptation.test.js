'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation,company}=require('./company-information');
const {createAutoposting}=require('./autoposting');
const {createMediaMentor}=require('./media-mentor');
const {createMediaMentorTransfer}=require('./media-mentor-transfer');
const {createMediaMentorHandler}=require('./media-mentor-http');
const OWNER={userId:1,userName:'Владелец'},EDITOR={userId:7,userName:'Редактор'};
const OWNER_IDENTITY={...OWNER,role:'owner'},EDITOR_IDENTITY={...EDITOR,role:'editor',companies:['qa'],permissions:['autoposting.view','autoposting.edit']};
const brief={goal:'Цель',product:'Продукт',audience:'Аудитория',platforms:['telegram','vk'],assets:[{id:'a1',title:'Съёмка',kind:'photo',note:'Описание'}],shootingComfort:{level:'hands_only',notes:''}};
const days=()=>Array.from({length:7},(_,i)=>({ideaId:`legacy-idea-${i+1}`,date:`2026-10-${String(i+1).padStart(2,'0')}`,platform:'telegram',format:'post',role:'reach',topic:`Идея ${i+1}`,assetId:'a1',
 variants:i?{telegram:{text:''}}:{telegram:{text:'Текст Telegram'},vk:{text:'Текст ВКонтакте'}}}));
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
 INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'qa','QA','Asia/Irkutsk','[]'),(2,'other','Other','UTC','[]');`);
 let time=Date.parse('2026-10-01T00:00:00Z');const calls=[],channels=['telegram','vk'].map(id=>({id,platform:id,enabled:true,connected:true,revision:1}));
 const information=createCompanyInformation(db,{now:()=>time}),transport={approvalDestination:(_code,id)=>{const channel=channels.find(item=>item.id===id);return {destinationRevision:channel?.revision||0,channelRevision:channel?.revision||0};},getSettings:async()=>({channels}),publish:async input=>{input.beforePublish?.();calls.push(input);return {externalId:'synthetic',url:'https://example.test/post'};}};
 const autoposting=createAutoposting(db,{information,transport,now:()=>time,logger:{warn(){}}}),mentor=createMediaMentor(db,{now:()=>time}),transfer=createMediaMentorTransfer(db,{mentor,autoposting,information,now:()=>time});
 const ready=({code='qa',planDays=days(),approved=true}={})=>{information.get(code);const b=mentor.saveBrief(code,{revision:0,brief},EDITOR),p=mentor.savePlan(code,{planRevision:0,briefRevision:b.brief.revision,days:planDays},EDITOR);
  if(approved)mentor.decideVariants(code,{planRevision:p.plan.revision,briefRevision:b.brief.revision,scope:'plan',decision:'approved',comment:''},OWNER);return mentor.get(code);};
 const body=(platform='telegram',code='qa')=>{const current=mentor.get(code),idea=current.plan.days[0];return {planRevision:current.plan.revision,briefRevision:current.brief.revision,selection:{ideaId:idea.ideaId,platform,contentRevision:idea.variants[platform].contentRevision}};};
 const queue=async(postId,code='qa')=>{let p=autoposting.get(postId,code);p=autoposting.update(postId,code,{revision:p.revision,platformIds:['telegram'],mediaUrls:['https://example.test/photo.png'],profileRevision:information.get(code).revision},EDITOR);
  p=autoposting.approve(postId,code,{revision:p.revision,approved:true},OWNER);return autoposting.schedule(postId,code,{revision:p.revision,scheduledAt:new Date(time+60000).toISOString()});};
 return {db,information,autoposting,mentor,transfer,transport,calls,ready,body,queue,advance:ms=>time+=ms};
}
const tableRows=(db,table)=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot=db=>Object.fromEntries(['autoposting_posts','media_mentor_variant_transfers','autoposting_deliveries','autoposting_reviews','autoposting_platform_reviews'].map(table=>[table,tableRows(db,table)]));
const codeError=(code,status=409)=>e=>e.status===status&&e.details?.code===code;

test('CF24: из двух согласованных соседей selection создаёт ровно одну карточку и truthful scoped planLink',t=>{
 const f=fixture(t),state=f.ready(),body=f.body(),beforePlan=tableRows(f.db,'media_mentor_plans'),beforeApprovals=tableRows(f.db,'media_mentor_variant_approvals');
 const neighbor=f.transfer.transferVariants('qa',f.body('vk'),EDITOR),neighborBefore=f.db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(neighbor.posts[0].id);
 const result=f.transfer.transferVariants('QA',body,EDITOR),post=result.posts[0];
 assert.equal(result.createdCount,1);assert.equal(result.alreadyTransferred,0);assert.equal(post.text,'Текст Telegram');assert.equal(post.status,'draft');assert.equal(post.scheduledAt,null);assert.deepEqual(post.mediaUrls,[]);assert.deepEqual(post.platformIds,[]);assert.deepEqual(post.deliveries,[]);assert.equal(post.approval.approved,false);
 assert.deepEqual({...post.planLink},{ideaId:body.selection.ideaId,platform:'telegram',contentRevision:body.selection.contentRevision,planRevision:state.plan.revision,briefRevision:state.brief.revision});
 assert.deepEqual(f.db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(neighbor.posts[0].id),neighborBefore);assert.deepEqual(tableRows(f.db,'media_mentor_plans'),beforePlan);assert.deepEqual(tableRows(f.db,'media_mentor_variant_approvals'),beforeApprovals);assert.equal(f.calls.length,0);
 assert.throws(()=>f.autoposting.createVariant(post.id,'qa',{revision:post.revision,clientRequestId:'legacy-clone-1',platformId:'vk'},EDITOR),codeError('PLAN_LINKED_POST'));
});

test('CF24: planLink берётся из связи, а не origin/meta; company scope сохраняется',t=>{
 const f=fixture(t);f.ready();f.ready({code:'other'});const a=f.transfer.transferVariants('qa',f.body(),EDITOR).posts[0],b=f.transfer.transferVariants('other',f.body('vk','other'),EDITOR).posts[0];
 assert.equal(a.planLink.platform,'telegram');assert.equal(b.planLink.platform,'vk');assert.throws(()=>f.autoposting.get(a.id,'other'),e=>e.status===404);
 const fake=f.autoposting.create('qa',{title:'Обычная',text:'Текст',origin:'media-mentor-plan',methodSource:'идея legacy-idea-1 · площадка telegram · версия 1'});
 assert.equal(fake.planLink,null);assert.throws(()=>f.autoposting.update(fake.id,'qa',{revision:fake.revision,planLink:a.planLink}),e=>e.status===400);
 const list=f.autoposting.list('qa').posts;assert.ok(list.every(p=>p.id!==b.id));assert.deepEqual({...list.find(p=>p.id===a.id).planLink},{...a.planLink});
});

test('CF24: selected receipt после ручной правки/архива не пишет и не восстанавливает карточку',t=>{
 const f=fixture(t);f.ready();const body=f.body(),first=f.transfer.transferVariants('qa',body,EDITOR);let p=first.posts[0];
 p=f.autoposting.update(p.id,'qa',{revision:p.revision,title:'Ручной заголовок',text:'Ручной текст'},EDITOR);const edited=f.db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(p.id);
 let replay=f.transfer.transferVariants('qa',body,EDITOR);assert.equal(replay.createdCount,0);assert.equal(replay.skipped[0].postId,p.id);assert.equal(replay.skipped[0].cardStatus,'draft');assert.equal(replay.skipped[0].archivedAt,null);assert.deepEqual(f.db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(p.id),edited);
 const archived=f.autoposting.archive(p.id,'qa',{revision:p.revision},EDITOR),before=snapshot(f.db);
 f.autoposting.get=()=>{throw Error('Selected replay не должен вызывать get существующего post');};
 f.db.exec("CREATE TRIGGER no_post_rewrite BEFORE UPDATE ON autoposting_posts BEGIN SELECT RAISE(ABORT,'post must stay unchanged'); END;");
 replay=f.transfer.transferVariants('qa',body,EDITOR);assert.equal(replay.createdCount,0);assert.equal(replay.alreadyTransferred,1);assert.deepEqual(replay.posts,[]);
 assert.deepEqual(replay.skipped,[{...body.selection,postId:p.id,cardStatus:'draft',archivedAt:archived.archive.archivedAt}]);assert.deepEqual(snapshot(f.db),before);
});

test('CF24: invalid/missing selection fields400, unknown idea404, stale content409 без создания',t=>{
 const f=fixture(t);f.ready();const body=f.body(),before=snapshot(f.db);
 for(const selection of [null,undefined,[],{}, {ideaId:body.selection.ideaId,platform:'telegram'}, {...body.selection,contentRevision:0},{...body.selection,contentRevision:'1'},{...body.selection,contentRevision:1.5},{...body.selection,contentRevision:Number.MAX_SAFE_INTEGER+1},{...body.selection,ideaId:''},{...body.selection,platform:''},{...body.selection,platform:'constructor'},{...body.selection,actor:{role:'owner'}}])
  assert.throws(()=>f.transfer.transferVariants('qa',{...body,selection},EDITOR),e=>e.status===400);
 assert.throws(()=>f.transfer.transferVariants('qa',{...body,selection:{...body.selection,ideaId:'missing-idea'}},EDITOR),codeError('IDEA_NOT_FOUND',404));
 assert.throws(()=>f.transfer.transferVariants('qa',{...body,selection:{...body.selection,contentRevision:2}},EDITOR),codeError('STALE_VARIANT'));
 assert.throws(()=>f.transfer.transferVariants('qa',{...body,actor:OWNER},EDITOR),e=>e.status===400);assert.deepEqual(snapshot(f.db),before);
});

for(const condition of ['empty','excluded','unapproved'])test(`CF24: selected ${condition} даёт409 вместо тихого пропуска`,t=>{
 const f=fixture(t),plan=days();if(condition==='empty')plan[0].variants.telegram.text='';if(condition==='excluded')plan[0].variants.telegram.excluded=true;
 f.ready({planDays:plan,approved:condition!=='unapproved'});const body=f.body(),before=snapshot(f.db);
 assert.throws(()=>f.transfer.transferVariants('qa',body,EDITOR),codeError(condition==='unapproved'?'VARIANT_NOT_APPROVED':'VARIANT_NOT_APPROVABLE'));assert.deepEqual(snapshot(f.db),before);
});

test('CF24: непереносимая соседняя тема не блокирует selection, прежний batch validation сохранён',t=>{
 const f=fixture(t),plan=days();plan[1].topic='X'.repeat(201);f.ready({planDays:plan});const body=f.body(),result=f.transfer.transferVariants('qa',body,EDITOR);
 assert.equal(result.createdCount,1);assert.equal(result.created[0].ideaId,body.selection.ideaId);
 assert.throws(()=>f.transfer.transferVariants('qa',{planRevision:body.planRevision,briefRevision:body.briefRevision},EDITOR),e=>e.status===400);
 assert.equal(tableRows(f.db,'autoposting_posts').length,1);
});

test('CF24: безselection batch по-прежнему переносит соседей, прежний skipped DTO не расширен',t=>{
 const f=fixture(t);f.ready();const selected=f.body(),first=f.transfer.transferVariants('qa',selected,EDITOR),body={planRevision:selected.planRevision,briefRevision:selected.briefRevision};
 const batch=f.transfer.transferVariants('qa',body,EDITOR);assert.equal(batch.createdCount,1);assert.equal(batch.posts[0].text,'Текст ВКонтакте');assert.deepEqual(batch.skipped,[{...selected.selection,postId:first.posts[0].id}]);
 const again=f.transfer.transferVariants('qa',body,EDITOR);assert.equal(again.createdCount,0);assert.equal(again.alreadyTransferred,2);assert.equal(tableRows(f.db,'autoposting_posts').length,2);
});

for(const kind of ['plan','brief','profile','approval'])test(`CF24: ${kind} race после snapshot повторно проверяется до записи`,t=>{
 const f=fixture(t);f.ready();const body=f.body(),get=f.information.get.bind(f.information);let once=true;
 f.information.get=code=>{const result=get(code);if(once){once=false;
  if(kind==='plan'){const current=f.mentor.get(code),edited=current.plan.days.map((day,i)=>i?day:{...day,variants:{...day.variants,telegram:{...day.variants.telegram,text:'Новая версия'}}});f.mentor.savePlan(code,{planRevision:current.plan.revision,briefRevision:current.brief.revision,days:edited},EDITOR);}
  if(kind==='brief'){const current=f.mentor.get(code);f.mentor.saveBrief(code,{revision:current.brief.revision,brief:{goal:'Новая цель'}},EDITOR);}
  if(kind==='profile')f.information.save(code,{revision:result.revision,profile:{name:'Новое название'}},7);
  if(kind==='approval')f.mentor.decideVariants(code,{planRevision:body.planRevision,briefRevision:body.briefRevision,scope:'variants',ideaId:body.selection.ideaId,platforms:['telegram'],decision:'withdrawn',comment:''},OWNER);
 }return result;};
 const expected={plan:'STALE_PLAN',brief:'BRIEF_CHANGED',profile:'PROFILE_CHANGED',approval:'VARIANT_NOT_APPROVED'};
 assert.throws(()=>f.transfer.transferVariants('qa',body,EDITOR),codeError(expected[kind]));assert.equal(tableRows(f.db,'autoposting_posts').length,0);assert.equal(tableRows(f.db,'media_mentor_variant_transfers').length,0);assert.equal(f.db.isTransaction,false);
});

test('CF24: ошибка INSERT immutable receipt откатывает новый draft вместе со связью',t=>{
 const f=fixture(t);f.ready();f.transfer.transferVariants('qa',f.body('vk'),EDITOR);const before=snapshot(f.db);f.db.exec("CREATE TRIGGER refuse_link BEFORE INSERT ON media_mentor_variant_transfers BEGIN SELECT RAISE(ABORT,'selected link refused'); END;");
 assert.throws(()=>f.transfer.transferVariants('qa',f.body(),EDITOR),/selected link refused/);assert.deepEqual(snapshot(f.db),before);assert.equal(f.db.isTransaction,false);
});

for(const change of ['edit','withdrawn'])test(`CF24: ${change} версии сохраняет schedule/drain plan-link guard`,async t=>{
 const f=fixture(t);f.ready();const body=f.body(),post=f.transfer.transferVariants('qa',body,EDITOR).posts[0];await f.queue(post.id);
 if(change==='edit'){const current=f.mentor.get('qa'),edited=current.plan.days.map((day,i)=>i?day:{...day,variants:{...day.variants,telegram:{...day.variants.telegram,text:'Изменённый плановый текст'}}});f.mentor.savePlan('qa',{planRevision:current.plan.revision,briefRevision:current.brief.revision,days:edited},EDITOR);}
 else f.mentor.decideVariants('qa',{planRevision:body.planRevision,briefRevision:body.briefRevision,scope:'variants',ideaId:body.selection.ideaId,platforms:['telegram'],decision:'withdrawn',comment:''},OWNER);
 f.advance(60000);await f.autoposting.drain();const current=f.autoposting.get(post.id,'qa');assert.equal(f.calls.length,0);assert.equal(current.status,'needs_review');assert.equal(current.lastErrorCode,'PLAN_APPROVAL_REVOKED');
 await assert.rejects(f.autoposting.schedule(post.id,'qa',{revision:current.revision,scheduledAt:'2026-10-01T01:00:00Z'}),codeError('PLAN_APPROVAL_REVOKED'));
});

function httpFixture(t){
 const f=fixture(t);f.ready({approved:false});let reads=0;const guards=[];
 const handler=createMediaMentorHandler({mentor:f.mentor,transfer:f.transfer,companyModuleContext(request,code,permission){
  guards.push({code,permission});const identity=request.identity,deny=()=>{throw Object.assign(Error('Synthetic trusted guard denied'),{status:403});};
  if(!identity||identity.role!=='owner'&&!identity.permissions?.includes(permission))deny();
  if(identity.role!=='owner'&&!identity.companies?.includes(String(code).toLowerCase()))deny();
  if(request.method!=='GET'&&!request.csrf)deny();return {identity,company:company(f.db,code)};
 },readJson:async request=>{reads++;await new Promise(resolve=>setImmediate(resolve));request.afterRead?.(request);return request.body;},send:(response,status,result,headers)=>{response.sent={status,result,headers};}});
 const call=async(path,identity,body,{afterRead,code='qa',csrf=true,method='POST'}={})=>{const request={method,identity,body,afterRead,csrf},response={};await handler(request,response,new URL(`http://crm.local${path}?companyCode=${code}`),{});return response.sent;};
 const decision=()=>{const body=f.body();return {planRevision:body.planRevision,briefRevision:body.briefRevision,scope:'variants',ideaId:body.selection.ideaId,platforms:['telegram'],decision:'approved',comment:''};};
 return {...f,call,decision,guards,reads:()=>reads};
}
const decisionPath='/media-mentor/plan/variants/decision',transferPath='/media-mentor/plan/variants/transfer';
for(const path of [decisionPath,transferPath])test(`CF24 HTTP ${path}: async revoke/identity/company/CSRF loss запрещают запись`,async t=>{
 const mutations=[request=>{request.identity=null;},request=>{request.identity={...request.identity,role:'editor',permissions:[],companies:['qa']};},request=>{request.identity={...request.identity,userId:99};},request=>{request.identity.userId=99;},request=>{request.identity={...request.identity,role:'editor',permissions:['autoposting.edit'],companies:['other']};},request=>{request.csrf=false;}];
 for(const afterRead of mutations){const f=httpFixture(t),identity={...OWNER_IDENTITY},body=path===decisionPath?f.decision():f.body(),before=snapshot(f.db),approvals=tableRows(f.db,'media_mentor_variant_approvals');
  await assert.rejects(f.call(path,identity,body,{afterRead}),e=>e.status===403);assert.equal(f.reads(),1);assert.deepEqual(snapshot(f.db),before);assert.deepEqual(tableRows(f.db,'media_mentor_variant_approvals'),approvals);
 }
});

test('CF24 HTTP: решение требует fresh owner; перед JSON editor отклоняется, downgrade owner после JSON тоже',async t=>{
 const f=httpFixture(t);await assert.rejects(f.call(decisionPath,{...EDITOR_IDENTITY},f.decision()),e=>e.status===403);assert.equal(f.reads(),0);
 await assert.rejects(f.call(decisionPath,{...OWNER_IDENTITY},f.decision(),{afterRead:request=>{request.identity={...EDITOR_IDENTITY,userId:1};}}),e=>e.status===403);
 assert.equal(tableRows(f.db,'media_mentor_variant_approvals').length,0);
});

test('CF24 HTTP: свежий trusted actor, selected transfer201/replay200, no-store и company/edit guards',async t=>{
 const f=httpFixture(t),decided=await f.call(decisionPath,{...OWNER_IDENTITY},f.decision(),{afterRead:request=>{request.identity={...OWNER_IDENTITY,userName:'Свежий владелец'};}});
 assert.equal(decided.status,201);assert.equal(tableRows(f.db,'media_mentor_variant_approvals')[0].actor_name,'Свежий владелец');assert.equal(decided.headers['cache-control'],'no-store');
 const body=f.body(),created=await f.call(transferPath,{...EDITOR_IDENTITY},body,{afterRead:request=>{request.identity={...EDITOR_IDENTITY,userName:'Свежий редактор'};}});
 assert.equal(created.status,201);assert.equal(created.result.createdCount,1);assert.equal(tableRows(f.db,'media_mentor_variant_transfers')[0].actor_name,'Свежий редактор');assert.equal(created.headers['cache-control'],'no-store');
 const repeated=await f.call(transferPath,{...EDITOR_IDENTITY},body);assert.equal(repeated.status,200);assert.equal(repeated.result.createdCount,0);assert.equal(repeated.result.skipped[0].postId,created.result.posts[0].id);
 assert.deepEqual(f.guards.slice(-2),[{code:'qa',permission:'autoposting.edit'},{code:'qa',permission:'autoposting.edit'}]);
 await assert.rejects(f.call(transferPath,{...EDITOR_IDENTITY,permissions:['autoposting.view']},body),e=>e.status===403);
 await assert.rejects(f.call(transferPath,{...EDITOR_IDENTITY},body,{code:'other'}),e=>e.status===403);
 await assert.rejects(f.call(transferPath,{...EDITOR_IDENTITY},{...body,actor:OWNER_IDENTITY}),e=>e.status===400);
 assert.equal(tableRows(f.db,'autoposting_posts').length,1);assert.equal(f.calls.length,0);
});
