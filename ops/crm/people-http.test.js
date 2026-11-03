'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {createPeopleCrmClient}=require('../content/people-crm-client');

test('реальные content→CRM запросы editor: узкие задачи, CAS/история и согласование без owner/crm.edit',async t=>{
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
  let sequence=0;
  async function create(title,executor,parent_id=null,code='alpha') {
    const response=await request('/coordination/mcp/task_create','POST',{project:code,title,description:'ЦКП: Сохранённый результат',executor,reviewer:'Проверяющий',client_ref:`people-test:${++sequence}`,...(parent_id?{parent_id}:{})},{...owner,companyCodes:[code]});
    assert.ok([200,201].includes(response.status));return response.body.task;
  }
  const branch=await create('Своя ветка','person:2'),own=await create('Прямая задача','person:2',branch.id),inherited=await create('Неназначенная задача','',branch.id),foreign=await create('Чужая ветка','person:3'),foreignChild=await create('Закрытая подветка','person:3',branch.id),wrongProject=await create('Другой проект','person:2',null,'beta');
  const call=createPeopleCrmClient({crmUrl:base,apiKey:key});
  await t.test('identity, API key, компания и capability проверяются CRM до чтения',async()=>{
    const route='/internal/people/tasks_list?companyCode=alpha',body={project:'alpha',limit:100,offset:0};
    assert.equal((await request(route,'POST',body,editor,false)).status,401);
    assert.equal((await request(route,'POST',body,null)).status,403);
    assert.equal((await request(route,'POST',body,{...editor,permissions:[]})).status,403);
    assert.equal((await request(route,'POST',body,{...editor,companyCodes:['alpha','beta']})).status,403);
    assert.equal((await request(route.replace('alpha','beta'),'POST',{...body,project:'beta'},editor)).status,403);
    assert.equal((await request('/coordination/mcp/tasks_list','POST',{project:'alpha'},editor)).status,403);
  });
  await t.test('список/описания/detail содержат только свою ветку; явное чужое назначение закрывает потомка',async()=>{
    const list=await call('tasks_list',{project:'alpha',limit:100,offset:0},user,'alpha');
    assert.deepEqual(list.tasks.map(t=>t.id),[branch.id,own.id,inherited.id]);assert.equal(list.total,3);
    const records=await call('taskRecords',{offset:0},user,'alpha');assert.deepEqual(records.tasks.map(t=>t.id),[branch.id,own.id,inherited.id]);assert.match(records.tasks[0].description,/ЦКП/);
    const detail=await call('task_get',{task_id:branch.id,subtasks_limit:100,comments_limit:20},user,'alpha');assert.deepEqual(detail.subtasks.map(t=>t.id),[own.id,inherited.id]);
    for(const id of [foreign.id,foreignChild.id,wrongProject.id])await assert.rejects(call('task_get',{task_id:id},user,'alpha'),{status:404});
  });
  await t.test('прямой status/CAS сохраняет историю настоящего человека и не открывает owner поля',async()=>{
    // Добавочная колонка моделирует совместимость следующей схемы: status-write
    // не пересобирает строку и не теряет поля продукта или прежние метаданные.
    const compatibility=new DatabaseSync(database);
    try {
      compatibility.exec('ALTER TABLE tasks ADD COLUMN product_id INTEGER');
      compatibility.prepare('UPDATE tasks SET product_id=? WHERE id=?').run(345,own.id);
      const row=compatibility.prepare('SELECT data FROM task_coordination WHERE task_id=?').get(own.id);
      compatibility.prepare('UPDATE task_coordination SET data=? WHERE task_id=?').run(JSON.stringify({...JSON.parse(row.data),futureMetadata:{retained:true}}),own.id);
    }finally{compatibility.close();}
    const before=await call('task_get',{task_id:own.id},user,'alpha');
    const updated=await call('task_update',{task_id:own.id,status:'done',revision:before.coordination.revision},user,'alpha');assert.equal(updated.task.status,'done');assert.equal(updated.task.coordination.revision,before.coordination.revision+1);
    const db=new DatabaseSync(database,{readOnly:true});try{assert.equal(db.prepare('SELECT updated_by FROM task_coordination WHERE task_id=?').get(own.id).updated_by,2);assert.equal(db.prepare('SELECT updated_by FROM task_coordination_history WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(own.id).updated_by,2);assert.equal(db.prepare('SELECT product_id FROM tasks WHERE id=?').get(own.id).product_id,345);assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM task_coordination WHERE task_id=?').get(own.id).data).futureMetadata,{retained:true});}finally{db.close();}
    await assert.rejects(call('task_update',{task_id:own.id,status:'planned',revision:before.coordination.revision},user,'alpha'),{status:409});
    await assert.rejects(call('task_update',{task_id:inherited.id,status:'done',revision:inherited.coordination.revision},user,'alpha'),{status:404});
    const response=await request('/internal/people/task_update?companyCode=alpha','POST',{task_id:own.id,status:'done',revision:updated.task.coordination.revision,executor:'person:2'},editor);assert.equal(response.status,400);
    assert.equal((await request('/coordination/mcp/task_update','POST',{task_id:own.id,status:'done'},editor)).status,403);
  });
  await t.test('согласование editor работает на реальном media_mentor только своей компании и без публикации',async()=>{
    assert.equal((await request('/media-mentor/brief?companyCode=alpha','PUT',{revision:0,brief:{goal:'Семь материалов',platforms:['vk']}})).status,200);
    const days=Array.from({length:7},(_,i)=>({date:`2026-11-${String(9+i).padStart(2,'0')}`,platform:'vk',format:'post',role:'reach',topic:`Тема ${i+1}`,variants:{vk:{text:`Полный текст ${i+1}`}}}));
    assert.equal((await request('/media-mentor/plan?companyCode=alpha','PUT',{planRevision:0,briefRevision:1,days})).status,200);
    const snapshot=await call('mediaMentor',{},user,'alpha');assert.equal(snapshot.plan.days.length,7);
    const body={planRevision:1,briefRevision:1,scope:'plan',decision:'approved',comment:''};
    const approved=await call('planVariantsDecision',body,user,'alpha');assert.equal(approved.variants.filter(v=>v.status==='approved').length,7);assert.equal(approved.variants[0].actorId,2);
    const missing={...user,permissions:['tasks.self.view']};await assert.rejects(call('planVariantsDecision',body,missing,'alpha'),{status:403});
    assert.equal((await request('/internal/people/planVariantsDecision?companyCode=beta','POST',body,editor)).status,403);
    assert.equal((await request('/internal/people/planVariantsDecision?companyCode=alpha','POST',{...body,publish:true},editor)).status,400);
    assert.equal((await request('/media-mentor/plan/variants/decision?companyCode=alpha','POST',body,editor)).status,403);
    const posts=await request('/autoposting/posts?companyCode=alpha');assert.equal(posts.status,200);assert.equal(posts.body.posts.length,0);
    await assert.rejects(call('planVariantsDecision',{...body,briefRevision:99},user,'alpha'),{status:409});
  });
});
