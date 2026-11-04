'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {hashPassword}=require('./passwords');
test('view-as HTTP: owner, employee, forgery, binding, readonly, live permissions, audit',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'synapse-people-35-')),password=crypto.randomBytes(24).toString('hex');
  const task=(id,assignee)=>({id,title:`Старая задача ${id}`,description:'ЦКП: Проверяемый результат',company_code:'synapse-business',assignee_name:assignee,status:'planned',parent_task_id:null,subtask_count:0,subtask_done:0,coordination:{revision:1,milestones:{}}});
  let all=[],calls=0;
  const crm=http.createServer(async(req,res)=>{
    calls++;let body='';for await(const chunk of req)body+=chunk;const args=body?JSON.parse(body):{};
    const actor=JSON.parse(Buffer.from(req.headers['x-synapse-crm-identity'],'base64url'));
    assert.deepEqual(actor.companyCodes,['synapse-business']);assert.equal(req.headers['x-api-key'],'synthetic-crm-key');
    let result;
    const action=new URL(req.url,'http://localhost').pathname.split('/').at(-1);
    assert.equal(actor.role,actor.userId===1?'owner':'editor');
    assert.deepEqual(actor.permissions,[['mediaMentor','planVariantsDecision'].includes(action)?'content-plan.approve':action==='task_update'?'tasks.self.edit':'tasks.self.view']);
    if(action==='mediaMentor')result={companyCode:'synapse-business',brief:{revision:0},plan:null,variants:[]};
    else if(action==='taskRecords')result={tasks:all.map(t=>({id:t.id,companyCode:t.company_code,description:t.description})),pagination:{total:all.length}};
    else if(action==='tasks_list')result={tasks:all,total:all.length};
    else if(action==='task_get')result={...all.find(x=>x.id===args.task_id),comments:[],subtasks:[]};
    else if(action==='task_update'){const row=all.find(x=>x.id===args.task_id);assert.equal(args.revision,row.coordination.revision);row.status=args.status;row.coordination.revision++;result={task:row};}
    else throw Error('Неожиданный upstream request');
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  });
  crm.listen(0,'127.0.0.1');await once(crm,'listening');
  const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:os.tmpdir(),TMP:os.tmpdir(),PORT:String(port),DATABASE_PATH:path.join(dir,'db.sqlite'),ASSETS_DIR:path.join(dir,'assets'),AUTH_USERS:`root:owner:${hashPassword(password)}`,SESSION_SECRET:crypto.randomBytes(32).toString('hex'),API_KEY:'',CRM_API_KEY:'synthetic-crm-key',CRM_URL:`http://127.0.0.1:${crm.address().port}`,PEOPLE_NOTIFICATIONS_ENABLED:'0',PEOPLE_NOTIFICATIONS_TEXT_APPROVED:'0'};
  const child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env,stdio:'ignore'});
  t.after(async()=>{
    if(child.exitCode===null){const closed=once(child,'exit');child.kill();await closed;}
    crm.closeAllConnections();await new Promise(r=>crm.close(r));
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});
  });
  const request=(route,session,method='GET',body,csrf=true)=>fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{'content-type':'application/json',...(session?{cookie:session.cookie,...(csrf?{'x-csrf-token':session.csrf}: {})}: {})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  let ready=false;for(let i=0;i<150;i++){try{if((await request('/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,20));}assert.ok(ready,'server startup');
  const login=async name=>{const r=await request('/content/login',null,'POST',{login:name,password});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0],data=await(await request('/content/whoami',{cookie})).json();return {cookie,csrf:data.csrfToken};};
  const owner=await login('root');

  assert.equal((await request('/content/admin/team',owner,'POST',{login:'lena',displayName:'Лена',password,companyCode:'synapse-business',staffRole:'administrator'})).status,201);
  const human=await login('lena');
  const users=await (await request('/content/view-as',owner)).json();
  const id=users.users.find(u=>u.login==='lena').id;
  assert.equal((await request('/content/view-as',human)).status,403);
  assert.equal((await request('/content/view-as',human,'POST',{userId:1})).status,403);
  assert.equal((await request('/content/view-as',owner,'POST',{userId:id},false)).status,403);
  const {token}=await (await request('/content/view-as',owner,'POST',{userId:id})).json();
  const viewed=(session=owner,value=token,method='GET',route='/content/whoami')=>fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{cookie:session.cookie,'X-View-As':value,'X-CSRF-Token':session.csrf}});
  const effective=await(await viewed()).json();
  assert.equal(effective.userId,id);assert.equal(effective.role,'editor');assert.equal(effective.viewAs.readOnly,true);
  const actual=await(await request('/content/whoami',human)).json();
  assert.deepEqual(effective.permissions,actual.permissions);assert.deepEqual(effective.companies,actual.companies);
  assert.equal((await viewed(human)).status,403);
  assert.equal((await viewed(owner,token+'x')).status,403);
  assert.equal((await viewed(owner,'2')).status,403);
  assert.equal((await viewed(owner,token.split('.')[0]+'.'+ 'é'.repeat(43))).status,403);
  assert.equal((await viewed()).headers.get('cache-control'),'private, no-store');
  const otherOwner=await login('root');assert.equal((await viewed(otherOwner)).status,403);
  for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS']) {
    const r=await viewed(owner,token,method,'/content/logout');assert.equal(r.status,403);
    if(method!=='HEAD')assert.equal((await r.json()).code,'VIEW_AS_READONLY');
  }
  const {DatabaseSync}=require('node:sqlite'),auditDb=new DatabaseSync(env.DATABASE_PATH);
  assert.equal(auditDb.prepare("SELECT count(*) n FROM auth_audit WHERE action='VIEW_AS_STARTED'").get().n,1);auditDb.close();
  assert.equal((await fetch(`http://127.0.0.1:${port}/content/whoami`,{headers:{'X-View-As':token}})).status,403);
  assert.equal((await request(`/content/admin/accounts/${id}/access`,owner,'PUT',{companies:['synapse-business'],permissions:[]})).status,200);
  assert.deepEqual((await(await viewed()).json()).permissions,[]);
  assert.equal((await request('/content/whoami',owner)).status,200);
});

test('revoked target is rejected when an issued token is resolved',()=>{
 const {createViewAs}=require('./view-as');let target={id:2,displayName:'Лена'};
 const api=createViewAs({secret:'synthetic-test',authStore:{getById:()=>target},db:{prepare:()=>({run(){}})}});
 const session={user:{id:1,role:'owner'},csrf:'synthetic-binding'},token=api.issue(session,2).token;
 target=null;assert.throws(()=>api.resolve({method:'GET',headers:{'x-view-as':token}},session),e=>e.status===403&&e.code==='VIEW_AS_INVALID');
});
