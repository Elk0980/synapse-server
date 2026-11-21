'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{once}=require('node:events');
const {spawn}=require('node:child_process'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createCrm,createJsonClient,createExecutor}=require('./transport'),{createStore}=require('./store'),{createWatcher}=require('./watcher');
test('настоящий CRM: служебные очереди, ответ в карточке, задача Claude с постоянным sourceRef, изоляция',{timeout:30000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'montage-watcher-')),key=randomBytes(24).toString('hex'),probe=http.createServer();
  probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,[path.join(__dirname,'../crm/server.js')],{env:{PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH||'',PORT:String(port),DATABASE_PATH:path.join(dir,'crm.sqlite'),API_KEY:key},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let ready=false,stderr='';child.stdout.on('data',d=>{if(d.toString().includes('слушает'))ready=true;});child.stderr.on('data',d=>stderr+=d);
  const state=new DatabaseSync(path.join(dir,'state.sqlite'));t.after(async()=>{
    state.close();if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});
  });
  for(let i=0;i<200&&!ready;i++){if(child.exitCode!==null)throw Error('CRM не запущен: '+stderr);await new Promise(r=>setTimeout(r,25));}
  assert.ok(ready);
  const url=`http://127.0.0.1:${port}`,owner=Buffer.from(JSON.stringify({v:1,userId:7,userName:'SAMPLE редактор',role:'owner',permissions:[],companyCodes:[]})).toString('base64url');
  async function api(method,route,body,identity=owner){const r=await fetch(url+route,{method,headers:{'x-api-key':key,...(identity?{'x-synapse-crm-identity':identity}:{}),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}
  for(const code of ['alpha','beta'])assert.equal((await api('POST','/companies',{code,name:'SAMPLE '+code})).status,201);
  const made=await api('POST','/autoposting/reels?companyCode=alpha',{title:'SAMPLE',durationMs:10000,mediaUrl:'https://synapse.synapsebusiness.ru/content/publishing-assets/alpha/'+'a'.repeat(32)+'.mp4'});
  assert.equal(made.status,201);const reelId=made.body.id,base=`/autoposting/reels/${reelId}`;
  const rq=await api('POST',base+'/requests?companyCode=alpha',{clientRequestId:'watcher-message',kind:'message',text:'SAMPLE вопрос'});assert.equal(rq.status,201);
  const ed=await api('POST',base+'/edits?companyCode=alpha',{clientRequestId:'watcher-edl',baseVersion:1,kind:'edl',edl:{v:1,video:[{inMs:0,outMs:5000}],audio:[],captions:[],speed:1,coverMs:null}});assert.equal(ed.status,201);
  const crm=createCrm({url,key}),store=createStore(state);let models=0;
  const watcher=createWatcher({store,crm,executor:null,classify:async()=>{models++;return {action:'reply',status:'ready',reply:'SAMPLE пояснение статуса'};}});
  await watcher.tick();await watcher.tick();await watcher.stop();assert.equal(models,1);
  const card=(await api('GET',base+'?companyCode=alpha')).body;assert.equal(card.requests[0].reply,'SAMPLE пояснение статуса');assert.equal(card.requests[0].status,'ready');
  const taskList=(await api('GET','/tasks?companyCode=alpha',undefined,null)).body.tasks.filter(r=>r.sourceRef.startsWith('montage-watcher:'));
  assert.equal(taskList.length,1);assert.equal(taskList[0].assigneeName,'Claude');assert.ok(taskList[0].description.includes('reel/'+reelId));
  const repeat=await crm.task({companyCode:'alpha',sourceRef:taskList[0].sourceRef,title:'SAMPLE повтор',description:'SAMPLE'});assert.equal(repeat.id,taskList[0].id);
  assert.equal((await api('POST',`/internal/reel-materials/requests/${rq.body.request.id}/reply?companyCode=beta`,{status:'ready',reply:'Чужое'},null)).status,404);
  assert.equal((await api('GET','/internal/reel-materials/requests')).status,403,'браузерная личность не является служебным клиентом');
  assert.equal((await crm.queue()).edits[0].status,'pending','нет исполнителя — не изображаем фактический claim');
});

test('transport: ключ в заголовке, redirect/слишком большой ответ/сырая ошибка закрыты',async()=>{
  let options;
  const call=createJsonClient({url:'https://service.test',key:'CANARY_KEY',maxBytes:4,fetchImpl:async(url,o)=>{options=o;return new Response('12345');}});
  await assert.rejects(call('/status'),/^Error: SERVICE_UNAVAILABLE$/);assert.equal(options.headers['x-api-key'],'CANARY_KEY');assert.equal(options.redirect,'error');
  const fail=createJsonClient({url:'https://service.test',key:'CANARY_KEY',fetchImpl:()=>{throw Error('CANARY_KEY PRIVATE_TEXT');}});
  await assert.rejects(fail('/status'),e=>e.message==='SERVICE_UNAVAILABLE'&&!e.stack.includes('PRIVATE_TEXT'));
  const dispatch=createExecutor({url:'https://service.test/jobs',key:'k',fetchImpl:async(url,o)=>{
    assert.equal(o.headers['idempotency-key'],'stable');assert.equal(JSON.parse(o.body).item.companyCode,'alpha');return Response.json({accepted:true});
  }});await dispatch({companyCode:'alpha'},{idempotencyKey:'stable'});
});
