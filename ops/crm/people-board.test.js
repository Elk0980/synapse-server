'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {createPeopleCrmClient}=require('../content/people-crm-client');

test('«Задачи» сотрудника на реальной CRM: разделы, порядок, пауза, мягкое удаление, комментарий, изоляция',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-people-board-')),key=crypto.randomBytes(24).toString('hex');let child;
  t.after(async()=>{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}fs.rmSync(dir,{recursive:true,force:true});});
  const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const database=path.join(dir,'crm.sqlite');let output='';
  child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{PATH:process.env.PATH||'',PORT:String(port),DATABASE_PATH:database,API_KEY:key},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  for(let i=0;i<200&&!output.includes('слушает');i++)await new Promise(r=>setTimeout(r,25));assert.match(output,/слушает/);
  const base=`http://127.0.0.1:${port}`,owner={v:1,userId:1,userName:'Владелец',role:'owner',companyCodes:['alpha'],permissions:['crm.view','crm.edit']};
  const request=async(route,method,body,actor=owner)=>{const r=await fetch(base+route,{method,headers:{'content-type':'application/json','x-api-key':key,'x-synapse-crm-identity':Buffer.from(JSON.stringify(actor)).toString('base64url')},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  for(const code of ['alpha','beta'])assert.equal((await request('/companies','POST',{code,name:code})).status,201);
  let n=0;const create=async(title,executor,code='alpha',source)=>{const r=await request('/coordination/mcp/task_create','POST',{project:code,title,executor,client_ref:`board-test:${++n}`,...(source?{source}:{})},{...owner,companyCodes:[code]});assert.ok([200,201].includes(r.status),JSON.stringify(r.body));return r.body.task;};
  const fromSystem=await create('Снять рилс №1','person:2','alpha','claude'),fromManager=await create('Проверить прайс','person:2'),peer=await create('Чужая задача','person:3'),beta=await create('Задача другой компании','person:2','beta');
  const call=createPeopleCrmClient({crmUrl:base,apiKey:key});
  const user=(id,code='alpha',permissions=['tasks.self.view','tasks.self.edit'])=>({id,displayName:`Человек ${id}`,role:'editor',companyCodes:[code],permissions});
  const lena=user(2),peerUser=user(3);

  const asked=await call('hughTask',{messageId:41,title:'Поменять контент-план на неделю'},lena,'alpha');
  assert.equal(asked.task.assignee_name,'Хью');assert.equal(asked.task.company_code,'alpha');
  assert.equal((await call('hughTask',{messageId:41,title:'Поменять контент-план на неделю'},lena,'alpha')).task.id,asked.task.id,'повтор не дублирует');
  let board=await call('myBoard',{},lena,'alpha');
  assert.deepEqual(board.assigned.map(t=>t.id).sort(),[fromSystem.id,fromManager.id].sort());
  assert.deepEqual(board.hugh.map(t=>t.id),[asked.task.id]);
  assert.equal(board.assigned.find(t=>t.id===fromSystem.id).from,'system');assert.equal(board.assigned.find(t=>t.id===fromManager.id).from,'manager');
  assert.ok(!JSON.stringify(board).includes('Чужая задача')&&!JSON.stringify(board).includes('другой компании'));
  assert.equal((await call('myBoard',{},peerUser,'alpha')).hugh.length,0,'задачи Хью видит только автор');

  board=await call('myBoardAction',{op:'order',section:'assigned',order:[fromManager.id,fromSystem.id]},lena,'alpha');
  assert.deepEqual(board.assigned.map(t=>t.id),[fromManager.id,fromSystem.id]);
  await assert.rejects(call('myBoardAction',{op:'order',section:'assigned',order:[peer.id]},lena,'alpha'),{status:404});
  await assert.rejects(call('myBoardAction',{op:'order',section:'hugh',order:[fromSystem.id]},lena,'alpha'),{status:404});
  board=await call('myBoardAction',{op:'pause',taskId:fromSystem.id},lena,'alpha');assert.equal(board.assigned.find(t=>t.id===fromSystem.id).paused,true);
  board=await call('myBoardAction',{op:'pause',taskId:fromSystem.id},lena,'alpha');
  board=await call('myBoardAction',{op:'delete',taskId:asked.task.id},lena,'alpha');
  assert.equal(board.hugh.length,0);assert.deepEqual(board.deleted.map(t=>t.id),[asked.task.id]);
  await assert.rejects(call('myBoardAction',{op:'pause',taskId:asked.task.id},lena,'alpha'),{status:409});
  await assert.rejects(call('myBoardAction',{op:'delete',taskId:peer.id},lena,'alpha'),{status:404});
  await assert.rejects(call('myBoardAction',{op:'delete',taskId:beta.id},lena,'alpha'),{status:404});
  await assert.rejects(call('myBoard',{},lena,'beta'),{status:403});
  await assert.rejects(call('myBoardAction',{op:'pause',taskId:fromSystem.id},user(2,'alpha',['tasks.self.view']),'alpha'),{status:403});

  const comment=await call('taskChatComment',{taskId:fromManager.id,messageId:77,text:'Прайс от 1 ноября'},lena,'alpha');
  assert.match(comment.comment.text,/Уточнение из чата с Хью: Прайс от 1 ноября/);assert.equal(comment.comment.author,'person:2');
  assert.equal((await call('taskChatComment',{taskId:fromManager.id,messageId:77,text:'Прайс от 1 ноября'},lena,'alpha')).comment.id,comment.comment.id);
  await assert.rejects(call('taskChatComment',{taskId:peer.id,messageId:78,text:'x'},lena,'alpha'),{status:404});
  board=await call('myBoardAction',{op:'restore',taskId:asked.task.id},lena,'alpha');assert.deepEqual(board.hugh.map(t=>t.id),[asked.task.id]);

  const db=new DatabaseSync(database,{readOnly:true});
  try {
    assert.equal(db.prepare('SELECT is_deleted FROM tasks WHERE id=?').get(asked.task.id).is_deleted,0,'данные задачи остаются на доске');
    const notes=db.prepare("SELECT text FROM task_comments WHERE author='person:2' ORDER BY id").all().map(r=>r.text);
    assert.equal(notes.filter(t=>/паузу/.test(t)).length,1,'повторная пауза не дублирует запись');
    assert.ok(notes.some(t=>/«Удалённые»/.test(t))&&notes.some(t=>/Вернул/.test(t)));
  }finally{db.close();}
});
