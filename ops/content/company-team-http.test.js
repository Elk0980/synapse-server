'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {hashPassword}=require('./passwords');
test('HTTP: команда ограничена компанией, CSRF и отдельным правом',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'synapse-team-'));
  const password=crypto.randomBytes(24).toString('hex');
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{...process.env,PORT:String(port),DATABASE_PATH:path.join(dir,'db.sqlite'),ASSETS_DIR:path.join(dir,'assets'),API_KEY:'',AUTH_USERS:`root:owner:${hashPassword(password)}`,SESSION_SECRET:crypto.randomBytes(32).toString('hex')},stdio:'ignore'});
  t.after(async()=>{const exited=once(child,'exit');child.kill();await exited;fs.rmSync(dir,{recursive:true,force:true});});
  const request=(route,session,method='GET',body,csrf=true)=>fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{...(session?{cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrf}: {})}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  let ready=false;for(let i=0;i<150;i++){try{if((await request('/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,20));}assert.ok(ready);
  async function login(name){const response=await request('/content/login',null,'POST',{login:name,password});assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];const profile=await (await request('/content/whoami',{cookie})).json();return {cookie,csrf:profile.csrfToken};}
  const root=await login('root');
  assert.equal((await request('/content/admin/accounts',root,'POST',{login:'manager',displayName:'Руководитель',password,companies:['alvi'],permissions:['team.manage']})).status,201);
  const manager=await login('manager'),body={companyCode:'alvi',staffRole:'master',login:'worker',displayName:'Мастер',password};
  assert.equal((await request('/content/admin/team?companyCode=alvi')).status,401);
  assert.equal((await request('/content/admin/team',manager,'POST',body,false)).status,403);
  assert.equal((await request('/content/admin/team',manager,'POST',{...body,companyCode:'avokado'})).status,403);
  assert.equal((await request('/content/admin/team',manager,'POST',{...body,permissions:['account.view']})).status,400);
  assert.equal((await request('/content/admin/team',manager,'POST',body)).status,201);
  const list=await (await request('/content/admin/team?companyCode=alvi',manager)).json();assert.equal(list.members.length,1);assert.equal(list.members[0].passwordHash,undefined);
  assert.equal((await request('/content/admin/team?companyCode=avokado',manager)).status,403);
  assert.equal((await request('/content/admin/accounts',manager)).status,403);
  assert.equal((await request('/content/admin/accounts',manager,'POST',{login:'evil',displayName:'X',password})).status,403);
  const worker=await login('worker');assert.equal((await request('/content/admin/team?companyCode=alvi',worker)).status,403);
});
