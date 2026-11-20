'use strict';
// specs/231-lena-materials-requests на настоящем CRM (server.js): права, границы компаний, просьбы, служебный API агента, «живой монтаж».
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto');

test('Материалы 231 через настоящий CRM: подпись и отметка, просьбы со статусами, отрезки и живой монтаж',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reel-requests-api-'));
  const key=randomBytes(24).toString('hex'),probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));let child;
  t.after(async()=>{if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}await fs.rm(directory,{recursive:true,force:true});});
  let output='';child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{PATH:process.env.PATH||'',PORT:String(port),DATABASE_PATH:path.join(directory,'crm.sqlite'),API_KEY:key},stdio:['ignore','pipe','ignore']});
  child.stdout.on('data',chunk=>{output+=chunk;});
  for(let i=0;i<200&&!output.includes('слушает');i++){if(child.exitCode!==null)throw Error('CRM не запустился');await new Promise(r=>setTimeout(r,25));}
  const encode=identity=>Buffer.from(JSON.stringify({v:1,userId:5,role:'editor',permissions:[],companyCodes:[],...identity})).toString('base64url');
  const owner=encode({role:'owner',userName:'Владелец'});
  const editor=encode({permissions:['autoposting.view','autoposting.edit'],companyCodes:['alpha'],userName:'Редактор'});
  const viewer=encode({userId:6,permissions:['autoposting.view'],companyCodes:['alpha'],userName:'Зритель'});
  async function request(method,url,{body,identity=editor}={}){
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{'x-api-key':key,...(identity?{'x-synapse-crm-identity':identity}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  }
  for(const code of ['alpha','beta'])assert.equal((await request('POST','/companies',{identity:owner,body:{code,name:code,timezone:'UTC'}})).status,201);
  const asset=(code,n)=>`https://synapse.synapsebusiness.ru/content/publishing-assets/${code}/${n.repeat(32)}.mp4`;
  const reel=await request('POST','/autoposting/reels?companyCode=alpha',{body:{title:'Ролик 1',releaseDate:'2026-11-20',platforms:['vk'],mediaUrl:asset('alpha','a'),durationMs:9000}});
  assert.equal(reel.status,201,JSON.stringify(reel.body));
  const base=`/autoposting/reels/${reel.body.id}`;

  /* Подпись, отметка, история; права и чужая компания. */
  const patched=await request('PATCH',`${base}?companyCode=alpha`,{body:{caption:'Подпись к ролику',decision:'take',decisionComment:'Хороший дубль'}});
  assert.equal(patched.status,200,JSON.stringify(patched.body));
  assert.equal(patched.body.caption,'Подпись к ролику');assert.equal(patched.body.decision,'take');
  assert.deepEqual(patched.body.history.map(e=>[e.field,e.authorName]).sort(),[['caption','Редактор'],['decision','Редактор']]);
  assert.equal((await request('PATCH',`${base}?companyCode=alpha`,{identity:viewer,body:{caption:'нельзя'}})).status,403,'только просмотр не правит');
  assert.equal((await request('PATCH',`${base}?companyCode=beta`,{body:{caption:'чужая'}})).status,403,'нет доступа к чужой компании');
  assert.equal((await request('PATCH',`${base}?companyCode=beta`,{identity:owner,body:{caption:'чужая'}})).status,404,'ролик другой компании не находится');
  assert.equal((await request('POST',`${base}/requests?companyCode=alpha`,{identity:viewer,body:{clientRequestId:'v1',kind:'message',text:'x'}})).status,403);
  assert.equal((await request('POST',`${base}/requests?companyCode=beta`,{identity:owner,body:{clientRequestId:'b1',kind:'message',text:'x'}})).status,404);

  /* «Переделать» → правка монтажа → новая версия → «готово, посмотрите». */
  const redo=await request('POST',`${base}/requests?companyCode=alpha`,{body:{clientRequestId:'q1',kind:'redo',text:'Короче начало',startMs:0,endMs:2000}});
  assert.equal(redo.status,201,JSON.stringify(redo.body));assert.equal(redo.body.request.status,'accepted');
  assert.equal((await request('POST',`${base}/requests?companyCode=alpha`,{body:{clientRequestId:'q1',kind:'redo',text:'Короче начало',startMs:0,endMs:2000}})).status,200,'повтор без дубля');
  assert.equal((await request('GET','/internal/reel-materials/requests?companyCode=alpha')).status,403,'браузерная личность не попадает в служебный API');
  const queue=await request('GET','/internal/reel-materials/requests?companyCode=alpha',{identity:null});
  assert.deepEqual(queue.body.requests.map(r=>[r.kind,r.title,r.companyCode]),[['redo','Ролик 1','alpha']]);
  assert.deepEqual((await request('GET','/internal/reel-materials/requests?companyCode=beta',{identity:null})).body.requests,[]);
  assert.equal((await request('POST',`/internal/reel-materials/edits/${redo.body.request.editId}/claim?companyCode=alpha`,{identity:null})).body.status,'in_progress');
  const v2=await request('POST',`/internal/reel-materials/reels/${reel.body.id}/versions?companyCode=alpha`,{identity:null,
    body:{mediaUrl:asset('alpha','b'),durationMs:8000,editId:redo.body.request.editId,segments:[{startMs:0,endMs:3000,label:'Начало'},{startMs:3000,endMs:8000}]}});
  assert.equal(v2.status,200,JSON.stringify(v2.body));assert.equal(v2.body.version.segments.length,2);
  let card=await request('GET',`${base}?companyCode=alpha`,{identity:viewer});
  assert.equal(card.body.requests[0].status,'ready');assert.match(card.body.requests[0].reply,/v2/);

  /* Сообщение → задача на общей доске → ответ агента виден на ролике. */
  const note=await request('POST',`${base}/requests?companyCode=alpha`,{body:{clientRequestId:'q2',kind:'reschedule',date:'2026-11-27',text:'Перенесите на пятницу'}});
  assert.equal(note.status,201,JSON.stringify(note.body));
  assert.ok(JSON.stringify((await request('GET','/tasks?companyCode=alpha',{identity:owner})).body).includes('перенести дату (просьба №'+note.body.request.id),'задача просьбы на общей доске');
  assert.equal((await request('POST',`/internal/reel-materials/requests/${note.body.request.id}/reply?companyCode=alpha`,{body:{status:'ready',reply:'x'}})).status,403);
  assert.equal((await request('POST',`/internal/reel-materials/requests/${note.body.request.id}/reply?companyCode=beta`,{identity:null,body:{status:'ready',reply:'x'}})).status,404);
  assert.equal((await request('POST',`/internal/reel-materials/requests/${note.body.request.id}/reply?companyCode=alpha`,{identity:null,body:{status:'published',reply:'x'}})).status,400);
  const answer=await request('POST',`/internal/reel-materials/requests/${note.body.request.id}/reply?companyCode=alpha`,{identity:null,body:{status:'ready',reply:'Перенёс на 27 ноября. Посмотрите.'}});
  assert.equal(answer.status,200,JSON.stringify(answer.body));assert.equal(answer.body.statusLabel,'готово, посмотрите');
  card=await request('GET',`${base}?companyCode=alpha`,{identity:viewer});
  assert.equal(card.body.requests[1].reply,'Перенёс на 27 ноября. Посмотрите.');

  /* «Опубликовать» → только черновик существующего автопостинга с подписью ролика; ничего не отправлено. */
  const publish=await request('POST',`${base}/requests?companyCode=alpha`,{body:{clientRequestId:'q3',kind:'publish',platformIds:['vk']}});
  assert.equal(publish.status,201,JSON.stringify(publish.body));
  const post=await request('GET',`/autoposting/posts/${publish.body.request.postId}?companyCode=alpha`,{identity:owner});
  assert.equal(post.body.status,'draft');assert.equal(post.body.scheduledAt,null);assert.equal(post.body.text,'Подпись к ролику');assert.deepEqual(post.body.mediaUrls,[asset('alpha','b')]);
  assert.equal(publish.body.request.status,post.body.approvalRequired&&!post.body.approval.approved?'waiting_owner':'ready');
  assert.equal((await request('POST',`${base}/requests?companyCode=alpha`,{body:{clientRequestId:'q4',kind:'publish'}})).status,409,'второй черновик той же версии не создаётся');

  /* Отрезки версии и «живой монтаж». */
  assert.equal((await request('POST',`/internal/reel-materials/reels/${reel.body.id}/versions/1/segments?companyCode=alpha`,{body:{segments:[{startMs:0,endMs:9000}]}})).status,403);
  assert.equal((await request('POST',`/internal/reel-materials/reels/${reel.body.id}/versions/1/segments?companyCode=alpha`,{identity:null,body:{segments:[{startMs:0,endMs:4000},{startMs:4000,endMs:9000}]}})).status,200);
  const toggles=[{startMs:0,endMs:3000,enabled:false,sound:true},{startMs:3000,endMs:8000,enabled:true,sound:false}];
  assert.equal((await request('POST',`${base}/live-edit?companyCode=alpha`,{identity:viewer,body:{clientRequestId:'l1',baseVersion:2,segments:toggles}})).status,403);
  assert.equal((await request('POST',`${base}/live-edit?companyCode=alpha`,{body:{clientRequestId:'l0',baseVersion:2,segments:[toggles[1],toggles[0]]}})).status,400,'перестановка отрезков отклоняется');
  const live=await request('POST',`${base}/live-edit?companyCode=alpha`,{body:{clientRequestId:'l1',baseVersion:2,segments:toggles}});
  assert.equal(live.status,201,JSON.stringify(live.body));
  assert.deepEqual(live.body.edit.edl.video,[{inMs:3000,outMs:8000}]);assert.equal(live.body.edit.edl.audio[0].muted,true);
  const edits=await request('GET','/internal/reel-materials/queue?companyCode=alpha',{identity:null});
  assert.ok(edits.body.edits.some(e=>e.id===live.body.edit.id&&e.edl.live.segments.length===2),'правку живого монтажа забирает агент монтажа');
  assert.equal((await request('GET',`${base}/requests?companyCode=alpha`)).status,405);
});
