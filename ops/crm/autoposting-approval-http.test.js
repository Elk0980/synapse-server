'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto');

test('Palitra approve+schedule HTTP: existing edit/approve permissions, company scope and atomic failure',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'palitra-approval-api-'));
  const key=randomBytes(24).toString('hex'),probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));let child;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
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
  const rejected=await request('POST',`/autoposting/posts/${id}/reject?companyCode=palitra-love`,{body:{revision:approved.body.revision,comment:'Нужна правка текста'},identity:reviewer});
  assert.equal(rejected.status,200);assert.equal(rejected.body.approval.approved,false);assert.equal(rejected.body.review.state,'rejected');
  assert.equal((await request('POST',`/autoposting/posts/${id}/approve?companyCode=other`,{body,identity:encode({permissions:['autoposting.view','autoposting.approve'],companyCodes:['other']})})).status,403);
});
