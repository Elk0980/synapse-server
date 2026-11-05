'use strict';
// №166 на настоящем CRM server.js: отправка рилса в чат → существующее согласование / requestEdit → итоги по площадкам.
// Итоги доставок записываются в базу напрямую: живая отправка на площадки в тестах не выполняется.
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');

async function startCrm(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reel-chat-approval-'));
  const key=randomBytes(24).toString('hex'),probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const databasePath=path.join(directory,'crm.sqlite');let output='';
  const child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{PATH:process.env.PATH||'',PORT:String(port),DATABASE_PATH:databasePath,API_KEY:key},stdio:['ignore','pipe','ignore']});
  t.after(async()=>{if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}await fs.rm(directory,{recursive:true,force:true});});
  child.stdout.on('data',chunk=>{output+=chunk;});
  for(let i=0;i<200&&!output.includes('слушает');i++){if(child.exitCode!==null)throw Error('CRM не запустился');await new Promise(r=>setTimeout(r,25));}
  async function request(method,url,{body,identity}={}){
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{'x-api-key':key,...(identity?{'x-synapse-crm-identity':identity}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  }
  return {request,databasePath};
}
const encode=identity=>Buffer.from(JSON.stringify({v:1,role:'editor',permissions:[],companyCodes:[],...identity})).toString('base64url');
const owner=encode({userId:1,role:'owner',userName:'Влад'});
const smm=encode({userId:5,permissions:['autoposting.view','autoposting.edit'],companyCodes:['avokado'],userName:'СММ'});
const lena=encode({userId:9,permissions:['autoposting.view','autoposting.edit','autoposting.approve'],companyCodes:['avokado'],userName:'Лена'});
const alien=encode({userId:11,permissions:['autoposting.view','autoposting.edit','autoposting.approve'],companyCodes:['alvi'],userName:'Чужой'});
const asset=(code,n,ext='mp4')=>`https://synapse.synapsebusiness.ru/content/publishing-assets/${code}/${n.repeat(32)}.${ext}`;

test('Чат-согласование: отправка, права, «Согласовано» существующим approve, повтор без дублей, устаревание',async t=>{
  const {request}=await startCrm(t);
  for(const code of ['avokado','alvi'])assert.equal((await request('POST','/companies',{identity:owner,body:{code,name:code,timezone:'Asia/Irkutsk'}})).status,201);
  const reel=(await request('POST','/autoposting/reels?companyCode=avokado',{identity:smm,body:{title:'Рилс №1',platforms:['instagram','vk'],mediaUrl:asset('avokado','a'),durationMs:12000}})).body;
  const base=`/autoposting/reels/${reel.id}/chat-approvals?companyCode=avokado`;
  const noCaption=await request('POST',base,{identity:smm,body:{clientRequestId:'c-1',version:1,platformIds:['instagram','vk']}});
  assert.equal(noCaption.status,400);assert.equal(noCaption.body.details?.code||noCaption.body.code,'CAPTION_REQUIRED');
  assert.equal((await request('GET','/autoposting/posts?companyCode=avokado',{identity:owner})).body.posts.length,0,'без подписи черновик не создаётся');
  assert.equal((await request('POST',base,{identity:encode({userId:6,permissions:['autoposting.view'],companyCodes:['avokado']}),body:{clientRequestId:'c-x',version:1,platformIds:['vk'],text:'x'}})).status,403,'без autoposting.edit отправить нельзя');
  const sent=await request('POST',base,{identity:smm,body:{clientRequestId:'c-2',version:1,platformIds:['instagram','vk'],text:'Подпись к рилсу #авокадо'}});
  assert.equal(sent.status,201,JSON.stringify(sent.body));
  const a=sent.body.approval;
  assert.equal(a.status,'pending');assert.equal(a.caption,'Подпись к рилсу #авокадо');assert.deepEqual(a.platforms.map(p=>p.id),['instagram','vk']);
  assert.equal(a.requestedBy.name,'СММ');assert.equal(a.mediaUrl,asset('avokado','a'));assert.equal(a.version,1);
  const post=(await request('GET',`/autoposting/posts/${a.postId}?companyCode=avokado`,{identity:owner})).body;
  assert.equal(post.status,'draft');assert.equal(post.review.state,'pending','карточка ушла на согласование существующим submitReview');
  assert.deepEqual(post.mediaUrls,[asset('avokado','a')]);assert.equal(post.scheduledAt,null);
  const again=await request('POST',base,{identity:smm,body:{clientRequestId:'c-2',version:1,platformIds:['instagram','vk'],text:'Подпись к рилсу #авокадо'}});
  assert.equal(again.status,200);assert.equal(again.body.approval.id,a.id,'повтор с тем же ключом — тот же запрос');
  // Чужая компания и чужие права.
  assert.equal((await request('GET',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}?companyCode=alvi`,{identity:alien})).status,404);
  assert.equal((await request('POST',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}/approve?companyCode=avokado`,{identity:alien,body:{}})).status,403);
  assert.equal((await request('POST',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}/approve?companyCode=avokado`,{identity:smm,body:{}})).status,403,'«Согласовано» — только владелец или autoposting.approve');
  const approved=await request('POST',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}/approve?companyCode=avokado`,{identity:lena,body:{}});
  assert.equal(approved.status,200,JSON.stringify(approved.body));
  assert.equal(approved.body.approval.status,'approved');assert.equal(approved.body.approval.approvedBy,'Лена');assert.ok(approved.body.approval.approvedAt);
  assert.equal(approved.body.approval.statusLabel,'Согласовано — ждёт публикации');
  const after=(await request('GET',`/autoposting/posts/${a.postId}?companyCode=avokado`,{identity:owner})).body;
  assert.equal(after.approval.approved,true);assert.equal(after.status,'draft','публикация не запускается из чата');
  assert.deepEqual(after.platformApprovals.map(p=>[p.platformId,p.approved,p.byName]),[['instagram',true,'Лена'],['vk',true,'Лена']]);
  assert.ok(after.history.some(h=>h.action==='approved'&&h.actorName==='Лена'),'история согласования — существующая');
  const twice=await request('POST',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}/approve?companyCode=avokado`,{identity:lena,body:{}});
  assert.equal(twice.status,200);assert.equal(twice.body.approval.status,'approved');
  assert.equal((await request('POST',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}/changes?companyCode=avokado`,{identity:lena,body:{comment:'поздно'}})).status,409,'после согласования правки — через «Постинг»');
  // Новая отправка той же версии переиспользует черновик; изменение подписи после отправки делает прежнюю карточку устаревшей.
  const second=(await request('POST',base,{identity:smm,body:{clientRequestId:'c-3',version:1,platformIds:['vk'],text:'Новая подпись'}})).body.approval;
  assert.equal(second.postId,a.postId,'тот же черновик ролика');assert.equal(second.status,'pending');
  const old=(await request('GET',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}?companyCode=avokado`,{identity:lena})).body.approval;
  assert.equal(old.status,'stale');assert.equal(old.open,false);
  const current=(await request('GET',`/autoposting/posts/${a.postId}?companyCode=avokado`,{identity:owner})).body;
  assert.equal((await request('PATCH',`/autoposting/posts/${a.postId}?companyCode=avokado`,{identity:owner,body:{revision:current.revision,text:'Исправили в «Постинге»'}})).status,200);
  const stale=await request('POST',`/autoposting/reels/${reel.id}/chat-approvals/${second.id}/approve?companyCode=avokado`,{identity:lena,body:{}});
  assert.equal(stale.status,409);assert.match(stale.body.error,/изменилась/);
  // Служебная выдача — только ключ сервиса.
  assert.equal((await request('GET','/internal/reel-materials/chat-approvals?companyCode=avokado',{identity:lena})).status,403);
  const internal=await request('GET','/internal/reel-materials/chat-approvals?companyCode=avokado');
  assert.equal(internal.status,200);assert.deepEqual(internal.body.approvals.map(x=>[x.id,x.status]),[[a.id,'stale'],[second.id,'stale']]);
  assert.equal((await request('GET','/internal/reel-materials/chat-approvals?companyCode=alvi')).body.approvals.length,0);
});

test('Чат-согласование: «Нужны правки» → существующий requestEdit и задача доски; скриншот своей компании',async t=>{
  const {request}=await startCrm(t);
  for(const code of ['avokado','alvi'])await request('POST','/companies',{identity:owner,body:{code,name:code,timezone:'UTC'}});
  const reel=(await request('POST','/autoposting/reels?companyCode=avokado',{identity:smm,body:{title:'Рилс №2',platforms:['telegram'],mediaUrl:asset('avokado','b')}})).body;
  const a=(await request('POST',`/autoposting/reels/${reel.id}/chat-approvals?companyCode=avokado`,{identity:smm,body:{clientRequestId:'k1',version:1,platformIds:['telegram'],text:'Текст'}})).body.approval;
  const url=`/autoposting/reels/${reel.id}/chat-approvals/${a.id}/changes?companyCode=avokado`;
  assert.equal((await request('POST',url,{identity:lena,body:{comment:'Обрежь начало'}})).status,400,'длительность неизвестна и момент не отмечен');
  assert.equal((await request('POST',url,{identity:lena,body:{comment:'x',durationMs:9000,screenshotUrl:asset('alvi','c','jpg')}})).status,403,'скриншот другой компании');
  assert.equal((await request('POST',url,{identity:lena,body:{comment:'x',durationMs:9000,screenshotUrl:'https://evil.example/content/publishing-assets/avokado/'+'c'.repeat(32)+'.jpg'}})).status,400);
  assert.equal((await request('POST',url,{identity:lena,body:{comment:''}})).status,400);
  const done=await request('POST',url,{identity:lena,body:{comment:'Обрежь первые 2 секунды',startMs:0,endMs:2500,durationMs:9000,screenshotUrl:asset('avokado','d','jpg')}});
  assert.equal(done.status,200,JSON.stringify(done.body));
  const ap=done.body.approval;assert.equal(ap.status,'changes_requested');assert.ok(ap.edit.taskId);assert.equal(ap.edit.byName,'Лена');
  assert.equal(ap.edit.screenshotUrl,asset('avokado','d','jpg'));
  const full=(await request('GET',`/autoposting/reels/${reel.id}?companyCode=avokado`,{identity:smm})).body;
  assert.equal(full.edits.length,1);assert.equal(full.edits[0].kind,'request');assert.equal(full.edits[0].endMs,2500);
  assert.match(full.edits[0].comment,/Обрежь первые 2 секунды\nСкрин: https:\/\/synapse/);
  const repeat=await request('POST',url,{identity:lena,body:{comment:'ещё раз',durationMs:9000}});
  assert.equal(repeat.status,200);assert.equal(repeat.body.approval.edit.id,ap.edit.id,'повтор не создаёт вторую правку');
  const tasks=await request('GET','/tasks?companyCode=avokado',{identity:owner});
  assert.equal(JSON.stringify(tasks.body).split('Монтаж: «Рилс №2» v1').length-1,1,'ровно одна задача монтажа');
  assert.equal((await request('POST',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}/approve?companyCode=avokado`,{identity:lena,body:{}})).status,409);
});

test('Итоги публикации: прямые ссылки, Onlypult без ссылки, ошибки, расписка владельца — только из записей автопостинга',async t=>{
  const {request,databasePath}=await startCrm(t);
  await request('POST','/companies',{identity:owner,body:{code:'avokado',name:'Авокадо',timezone:'UTC'}});
  const reel=(await request('POST','/autoposting/reels?companyCode=avokado',{identity:smm,body:{title:'Рилс №3',platforms:['instagram','vk','telegram','youtube_shorts'],mediaUrl:asset('avokado','e'),durationMs:15000}})).body;
  const a=(await request('POST',`/autoposting/reels/${reel.id}/chat-approvals?companyCode=avokado`,{identity:smm,body:{clientRequestId:'p1',version:1,platformIds:['instagram','vk','telegram','youtube_shorts'],text:'Подпись'}})).body.approval;
  await request('POST',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}/approve?companyCode=avokado`,{identity:lena,body:{}});
  const db=new DatabaseSync(databasePath);t.after(()=>db.close());db.exec('PRAGMA busy_timeout=5000');
  const insert=db.prepare(`INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision,status,external_id,url,error_code,finished_at,provider_post_id,provider_status)
    VALUES(?,?,1,?,?,?,?,?,?,?)`);
  insert.run(a.postId,'vk','published','-1_2','https://vk.com/wall-1_2',null,'2026-11-05T10:00:00Z',null,null);
  insert.run(a.postId,'instagram','needs_review',null,null,'PROVIDER_PENDING',null,'op123','scheduled');
  db.prepare("UPDATE autoposting_posts SET status='needs_review' WHERE id=?").run(a.postId);
  let view=(await request('GET','/internal/reel-materials/chat-approvals?companyCode=avokado')).body.approvals[0];
  assert.equal(view.status,'publishing');
  assert.deepEqual(view.publication.items.map(i=>[i.platformId,i.state,i.url]),[['instagram','pending',null],['youtube_shorts','none',null],['vk','published','https://vk.com/wall-1_2'],['telegram','none',null]]);
  db.prepare("UPDATE autoposting_deliveries SET provider_status='published',error_code='PROVIDER_LINK_UNAVAILABLE' WHERE post_id=? AND channel_id='instagram'").run(a.postId);
  insert.run(a.postId,'telegram','failed',null,null,'PUBLISH_FAILED','2026-11-05T10:01:00Z',null,null);
  insert.run(a.postId,'youtube_shorts','needs_review',null,null,'PUBLICATION_UNCERTAIN','2026-11-05T10:02:00Z',null,null);
  view=(await request('GET','/internal/reel-materials/chat-approvals?companyCode=avokado')).body.approvals[0];
  assert.equal(view.status,'partial');assert.equal(view.publication.done,true);
  const byId=Object.fromEntries(view.publication.items.map(i=>[i.platformId,i]));
  assert.deepEqual([byId.instagram.state,byId.instagram.url,byId.instagram.providerPostId,byId.instagram.source],['published',null,'op123','onlypult'],'Onlypult: ссылки нет, ID задания');
  assert.equal(byId.telegram.state,'failed');assert.match(byId.telegram.error,/не подтвердила/);
  assert.equal(byId.youtube_shorts.state,'uncertain');
  // Расписка владельца с проверенной ссылкой — реальная ссылка с пометкой источника.
  const post=(await request('GET',`/autoposting/posts/${a.postId}?companyCode=avokado`,{identity:owner})).body;
  const receipt=await request('POST',`/autoposting/posts/${a.postId}/receipts?companyCode=avokado`,{identity:owner,body:{platform:'instagram',url:'https://www.instagram.com/reel/AbCdE12345/',publishedAt:'2026-11-05T09:00:00Z',contentRevision:post.contentRevision}});
  assert.equal(receipt.status,201,JSON.stringify(receipt.body));
  view=(await request('GET','/internal/reel-materials/chat-approvals?companyCode=avokado')).body.approvals[0];
  const ig=view.publication.items.find(i=>i.platformId==='instagram');
  assert.deepEqual([ig.state,ig.url,ig.source],['published','https://www.instagram.com/reel/AbCdE12345/','receipt']);
});

test('Устаревание: площадку запроса убрали из публикации в «Постинге» → карточка закрыта, решение 409 (площадки не входят в версию содержимого)',async t=>{
  const {request}=await startCrm(t);
  await request('POST','/companies',{identity:owner,body:{code:'avokado',name:'Авокадо',timezone:'UTC'}});
  const reel=(await request('POST','/autoposting/reels?companyCode=avokado',{identity:smm,body:{title:'Рилс №4',platforms:['instagram','vk'],mediaUrl:asset('avokado','f'),durationMs:9000}})).body;
  const a=(await request('POST',`/autoposting/reels/${reel.id}/chat-approvals?companyCode=avokado`,{identity:smm,body:{clientRequestId:'s1',version:1,platformIds:['instagram','vk'],text:'Подпись'}})).body.approval;
  const post=(await request('GET',`/autoposting/posts/${a.postId}?companyCode=avokado`,{identity:owner})).body;
  const patched=await request('PATCH',`/autoposting/posts/${a.postId}?companyCode=avokado`,{identity:owner,body:{revision:post.revision,platformIds:['vk']}});
  assert.equal(patched.status,200,JSON.stringify(patched.body));assert.equal(patched.body.contentRevision,post.contentRevision,'версия содержимого не изменилась');
  const view=(await request('GET',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}?companyCode=avokado`,{identity:lena})).body.approval;
  assert.equal(view.status,'stale');assert.equal(view.open,false);
  assert.equal((await request('POST',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}/approve?companyCode=avokado`,{identity:lena,body:{}})).status,409);
  assert.equal((await request('POST',`/autoposting/reels/${reel.id}/chat-approvals/${a.id}/changes?companyCode=avokado`,{identity:lena,body:{comment:'x'}})).status,409);
});
