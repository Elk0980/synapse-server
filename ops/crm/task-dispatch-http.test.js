'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {once}=require('node:events'),{spawn}=require('node:child_process'),{randomBytes}=require('node:crypto');
test('real CRM routes isolate service leases, owner actions, projects and stale revisions',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dispatch-http-')),key=randomBytes(20).toString('hex');let child;
 t.after(async()=>{if(child&&child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));await fs.rm(dir,{recursive:true,force:true});});
 const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 let output='';child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{SystemRoot:process.env.SystemRoot||'',PATH:process.env.PATH||'',PORT:String(port),DATABASE_PATH:path.join(dir,'crm.sqlite'),API_KEY:key},stdio:['ignore','pipe','pipe'],windowsHide:true});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 for(let i=0;i<200&&!output.includes('слушает');i++)await new Promise(r=>setTimeout(r,25));assert.match(output,/слушает/);
 const identity=role=>Buffer.from(JSON.stringify({v:1,userId:1,role,permissions:['crm.edit'],companyCodes:['alpha']})).toString('base64url');
 async function req(url,method='GET',body,role='owner',auth=true){const r=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{...(auth?{'x-api-key':key}:{}),...(role?{'x-synapse-crm-identity':identity(role)}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
 for(const code of ['alpha','beta'])assert.equal((await req('/companies','POST',{code,name:code})).status,201);
 const created=await req('/tasks?companyCode=alpha','POST',{title:'Проверочный черновик',description:'Текст',companyCode:'alpha'});assert.equal(created.status,201);const id=created.body.id;
 assert.equal((await req(`/coordination/dispatch/${id}/enqueue`,'POST',{revision:0},'editor')).status,403);
 assert.equal((await req(`/coordination/dispatch/${id}/enqueue?companyCode=beta`,'POST',{revision:0})).status,404);
 assert.equal((await req(`/coordination/dispatch/${id}/enqueue`,'POST',{revision:0})).status,200);
 assert.equal((await req('/internal/task-dispatch/claim','POST',{},'owner')).status,403);
 assert.equal((await req('/internal/task-dispatch/claim','POST',{},null,false)).status,401);
 const job=(await req('/internal/task-dispatch/claim','POST',{},null)).body.job;assert.equal(job.taskId,id);
 assert.equal((await req('/internal/task-dispatch/complete','POST',{job,result:{state:'needs_input',department:'support',question:'Какой срок?',provider:'fixture',model:'fixture-1'}},null)).status,200);
 const saved=(await req(`/coordination/dispatch/${id}`)).body;assert.equal(saved.state,'needs_input');
 assert.equal((await req(`/coordination/dispatch/${id}/action`,'POST',{revision:0,action:'answer',text:'Завтра'})).status,409);
 assert.equal((await req(`/coordination/dispatch/${id}/action`,'POST',{revision:saved.revision,action:'answer',text:'Завтра'})).status,200);
 const board=(await req('/coordination/tasks?companyCode=alpha')).body;assert.equal(board.tasks[0].dispatch.state,'queued');
});
