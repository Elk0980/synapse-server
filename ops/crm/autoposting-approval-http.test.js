'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');

test('Palitra approve+schedule HTTP: existing edit/approve permissions, company scope and atomic failure',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'palitra-approval-api-'));
  const key=randomBytes(24).toString('hex'),probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));let child,inspectDb;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
    if(inspectDb)inspectDb.close();
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});
  });
  let output='';child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{SystemRoot:process.env.SystemRoot||'',PATH:process.env.PATH||'',PORT:String(port),DATABASE_PATH:path.join(directory,'crm.sqlite'),API_KEY:key},stdio:['ignore','pipe','ignore'],windowsHide:true});
  child.stdout.on('data',chunk=>{output+=chunk;});
  for(let attempt=0;attempt<200&&!output.includes('слушает');attempt++){if(child.exitCode!==null)throw Error('Fixture CRM failed to start');await new Promise(resolve=>setTimeout(resolve,25));}
  assert.match(output,/слушает/);
  const encode=identity=>Buffer.from(JSON.stringify({v:1,userId:1,role:'editor',permissions:[],companyCodes:[],...identity})).toString('base64url');
  const owner=encode({role:'owner'});
  async function request(method,url,{body,identity=owner,authenticated=true}={}){
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{...(authenticated?{'x-api-key':key}:{}),...(identity?{'x-synapse-crm-identity':identity}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  }
  for(const code of ['palitra-love','other'])assert.equal((await request('POST','/companies',{body:{code,name:code,timezone:'UTC'}})).status,201);
  const created=await request('POST','/autoposting/posts?companyCode=palitra-love',{body:{title:'Материал',text:'Текст',mediaUrls:['https://example.test/photo.webp'],platformIds:['telegram'],scheduledAt:new Date(Date.now()+3600000).toISOString(),timezone:'UTC',profileRevision:1}});
  assert.equal(created.status,201);assert.equal(created.body.approvalRequired,true);
  const id=created.body.id,route=`/autoposting/posts/${id}/approve?companyCode=palitra-love`,body={revision:created.body.revision,approved:true,schedule:true};
  const localParts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(created.body.scheduledAt));
  const localDate=['year','month','day'].map(part=>localParts.find(value=>value.type===part).value).join('-');
  const reminderRoute=`/autoposting/review-reminders?companyCode=palitra-love&date=${localDate}`;
  const reminder=await request('GET',reminderRoute,{identity:null});assert.equal(reminder.status,200);assert.equal(reminder.body.items[0].id,id);
  assert.equal(reminder.body.items[0].text,undefined);assert.equal(reminder.body.timezone,'Europe/Moscow');
  assert.equal((await request('GET',reminderRoute,{identity:null,authenticated:false})).status,401);
  assert.equal((await request('GET',reminderRoute)).status,403,'сессионный proxy не получает служебный маршрут');
  assert.equal((await request('GET',reminderRoute.replace('palitra-love','other'),{identity:null})).status,404);
  assert.equal((await request('GET',reminderRoute+'&date='+localDate,{identity:null})).status,400);
  for(const permissions of [['autoposting.view'],['autoposting.edit'],['autoposting.approve']]){
    const result=await request('POST',route,{body,identity:encode({permissions,companyCodes:['palitra-love']})});assert.equal(result.status,403);
  }
  assert.equal((await request('POST',route,{body,identity:encode({permissions:['autoposting.edit','autoposting.approve'],companyCodes:['other']})})).status,403);
  assert.equal((await request('POST',route,{body,authenticated:false})).status,401);
  assert.equal((await request('POST',`/autoposting/posts/${id}/approve?companyCode=other`,{body})).status,404);
  // Согласующий имеет права, но Telegram не подключён. Маршрут должен дойти до общей проверки
  // и откатить согласование, а не принять schedule:true как обычную галочку.
  const reviewer=encode({permissions:['autoposting.view','autoposting.edit','autoposting.approve'],companyCodes:['palitra-love']});
  const result=await request('POST',route,{body,identity:reviewer});assert.equal(result.status,409);assert.match(JSON.stringify(result.body),/CHANNEL_NOT_CONNECTED|канал не подключён/);
  const unchanged=await request('GET',`/autoposting/posts/${id}?companyCode=palitra-love`);
  assert.equal(unchanged.body.revision,created.body.revision);assert.equal(unchanged.body.approval.approved,false);assert.equal(unchanged.body.status,'draft');assert.deepEqual(unchanged.body.deliveries,[]);
  const approved=await request('POST',route,{body:{revision:body.revision,approved:true},identity:reviewer});assert.equal(approved.status,200);assert.equal(approved.body.approval.approved,true);assert.equal(approved.body.status,'draft');
  const rejectRoute=`/autoposting/posts/${id}/reject?companyCode=palitra-love`;
  const annotation={category:'text',comment:'Исправить титр',timingKind:'material',mediaIndex:0,startMs:12000,endMs:14000};
  const rejection={revision:approved.body.revision,comment:'Нужна правка текста',annotations:[annotation,{category:'music',comment:'Плавное начало',timingKind:'editing_wish',startMs:5000}]};
  for(const identity of [encode({permissions:['autoposting.view','autoposting.edit'],companyCodes:['palitra-love']}),encode({permissions:['autoposting.view','autoposting.edit','autoposting.approve'],companyCodes:['other']})]){
    assert.equal((await request('POST',rejectRoute,{body:rejection,identity})).status,403);
  }
  assert.equal((await request('POST',rejectRoute,{body:rejection,authenticated:false})).status,401);
  assert.equal((await request('POST',rejectRoute.replace('palitra-love','other'),{body:rejection})).status,404);
  assert.equal((await request('POST',rejectRoute,{body:{...rejection,annotations:[{...annotation,endMs:11000}]},identity:reviewer})).status,400);
  const stillApproved=await request('GET',`/autoposting/posts/${id}?companyCode=palitra-love`);
  assert.equal(stillApproved.body.revision,approved.body.revision);assert.equal(stillApproved.body.approval.approved,true);assert.deepEqual(stillApproved.body.reviewNotes,[]);
  inspectDb=new DatabaseSync(path.join(directory,'crm.sqlite'));
  inspectDb.exec("CREATE TRIGGER test_task_failure BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'fixture task failure'); END;");
  assert.equal((await request('POST',rejectRoute,{body:rejection,identity:reviewer})).status,500);
  const rolledBack=await request('GET',`/autoposting/posts/${id}?companyCode=palitra-love`);
  assert.equal(rolledBack.body.revision,approved.body.revision);assert.equal(rolledBack.body.approval.approved,true);
  assert.deepEqual(rolledBack.body.reviewNotes,[]);assert.deepEqual(rolledBack.body.reviewTasks,[]);
  inspectDb.exec('DROP TRIGGER test_task_failure');
  const rejected=await request('POST',rejectRoute,{body:rejection,identity:reviewer});
  assert.equal(rejected.status,200);assert.equal(rejected.body.approval.approved,false);assert.equal(rejected.body.review.state,'rejected');
  assert.equal(rejected.body.reviewNotes.length,1);assert.equal(rejected.body.reviewNotes[0].annotations[0].startMs,12000);
  assert.equal(rejected.body.reviewTasks.length,1);const task=rejected.body.reviewTasks[0];
  assert.equal(task.status,'inbox');assert.equal(task.assigneeName,null);assert.equal(task.dueDate,null);
  assert.match(inspectDb.prepare('SELECT description FROM tasks WHERE id=?').get(task.taskId).description,/Текст — файл №1, 0:12–0:14: Исправить титр/);
  assert.match(inspectDb.prepare('SELECT description FROM tasks WHERE id=?').get(task.taskId).description,/Музыка — пожелание к монтажу, 0:05: Плавное начало/);
  assert.equal(inspectDb.prepare('SELECT count(*) n FROM task_dispatch WHERE task_id=?').get(task.taskId).n,0);
  assert.equal((await request('POST',rejectRoute,{body:rejection,identity:reviewer})).status,409);
  const edited=await request('PATCH',`/autoposting/posts/${id}?companyCode=palitra-love`,{body:{revision:rejected.body.revision,text:'Исправленный текст',mediaUrls:['https://example.test/new.webp']},identity:reviewer});
  assert.equal(edited.status,200);assert.deepEqual(edited.body.reviewNotes,rejected.body.reviewNotes);
  const readBack=await request('GET',`/autoposting/posts/${id}?companyCode=palitra-love`);
  assert.deepEqual(readBack.body.reviewNotes,rejected.body.reviewNotes);
  assert.equal(readBack.body.reviewTasks.length,1);
  const listBack=(await request('GET','/autoposting/posts?companyCode=palitra-love')).body.posts.find(p=>p.id===id);
  assert.deepEqual(listBack.reviewTasks,readBack.body.reviewTasks);assert.deepEqual(listBack.reviewNotes,readBack.body.reviewNotes);
  inspectDb.prepare("UPDATE tasks SET company_code='other',assignee_name='Не показывать' WHERE id=?").run(task.taskId);
  assert.deepEqual((await request('GET',`/autoposting/posts/${id}?companyCode=palitra-love`)).body.reviewTasks,[]);
  assert.equal((await request('POST',`/autoposting/posts/${id}/approve?companyCode=other`,{body,identity:encode({permissions:['autoposting.view','autoposting.approve'],companyCodes:['other']})})).status,403);
  // CF5: прежние edit/view/company границы; восстановление без согласования и отправки.
  const archiveRoute=`/autoposting/posts/${id}/archive?companyCode=palitra-love`;
  const restoreRoute=archiveRoute.replace('/archive?','/restore?');
  const archiveBody={revision:edited.body.revision};
  assert.equal((await request('POST',archiveRoute,{body:archiveBody,identity:encode({permissions:['autoposting.view'],companyCodes:['palitra-love']})})).status,403);
  assert.equal((await request('POST',archiveRoute.replace('palitra-love','other'),{body:archiveBody})).status,404);
  const archived=await request('POST',archiveRoute,{body:archiveBody,identity:reviewer});
  assert.equal(archived.status,200);assert.ok(archived.body.archive.archivedAt);
  assert.equal((await request('GET','/autoposting/posts?companyCode=palitra-love')).body.posts.some(p=>p.id===id),false);
  assert.equal((await request('GET','/autoposting/archived?companyCode=palitra-love')).body.posts.some(p=>p.id===id),true);
  assert.equal((await request('GET','/autoposting/archived?companyCode=other')).body.posts.length,0);
  assert.equal((await request('POST',restoreRoute,{body:archiveBody})).status,409);
  const restored=await request('POST',restoreRoute,{body:{revision:archived.body.revision},identity:reviewer});
  assert.equal(restored.status,200);assert.equal(restored.body.archive.archivedAt,null);
  assert.equal(restored.body.approval.approved,false);assert.equal(restored.body.scheduledAt,null);
  assert.deepEqual(restored.body.reviewNotes,rejected.body.reviewNotes);

});
