'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {createPeopleCrmClient}=require('../content/people-crm-client');

test('рабочий чат → реальная CRM: person, повторы, история и изоляция',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-people-scoped-')),key=crypto.randomBytes(24).toString('hex');let child;
  t.after(async()=>{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const database=path.join(dir,'crm.sqlite');let output='';
  child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{SystemRoot:process.env.SystemRoot||'',PATH:process.env.PATH||'',PORT:String(port),DATABASE_PATH:database,API_KEY:key},stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  for(let i=0;i<200&&!output.includes('слушает');i++)await new Promise(r=>setTimeout(r,25));assert.match(output,/слушает/);
  const base=`http://127.0.0.1:${port}`,owner={v:1,userId:1,userName:'Владелец',role:'owner',companyCodes:['alpha'],permissions:['crm.view','crm.edit']};
  const editor={v:1,userId:2,userName:'Человек',role:'editor',companyCodes:['alpha'],permissions:['tasks.self.view','tasks.self.edit','content-plan.approve']};
  const user={id:2,displayName:'Человек',role:'editor',companyCodes:['alpha'],permissions:editor.permissions};
  async function request(route,method='GET',body,actor=owner,auth=true) {
    const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...(auth?{'x-api-key':key}:{}),...(actor?{'x-synapse-crm-identity':Buffer.from(JSON.stringify(actor)).toString('base64url')}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,body:await r.json()};
  }
  for(const code of ['alpha','beta'])assert.equal((await request('/companies','POST',{code,name:code})).status,201);

  const call=createPeopleCrmClient({crmUrl:base,apiKey:key});
  const input={messageId:123,title:'Подготовить материал'};
  const result=await call('teamChatTask',input,user,'alpha');
  assert.equal(result.created,true);assert.equal(result.task.assignee_name,'person:2');
  const repeated=await call('teamChatTask',input,user,'alpha');assert.equal(repeated.task.id,result.task.id);assert.equal(repeated.created,false);
  const duplicate=await call('teamChatTask',{...input,messageId:124,title:'  подготовить   МАТЕРИАЛ '},user,'alpha');assert.equal(duplicate.task.id,result.task.id);
  const own=await call('task_get',{task_id:result.task.id},user,'alpha');assert.match(own.description,/team-chat.html.*message-123/);
  await call('task_update',{task_id:own.id,status:'done',revision:own.coordination.revision},user,'alpha');
  assert.equal((await call('teamChatTask',{...input,messageId:124,title:'  подготовить   МАТЕРИАЛ '},user,'alpha')).task.id,own.id);
  await assert.rejects(call('teamChatTask',{...input,executor:'person:3'},user,'alpha'),{status:400});
  await assert.rejects(call('teamChatTask',input,{...user,permissions:['tasks.self.view']},'alpha'),{status:403});
  await assert.rejects(call('teamChatTask',input,user,'beta'),{status:403});
  const outsider={...user,id:3};
  const hidden=await call('tasks_list',{project:'alpha',limit:100,offset:0},outsider,'alpha');assert.equal(hidden.tasks.length,0);
  const listed=await call('tasks_list',{project:'alpha',limit:100,offset:0},user,'alpha');assert.equal(listed.tasks.length,1);
});
