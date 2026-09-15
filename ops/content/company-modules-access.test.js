'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto');
const {mkdtemp,rm,writeFile,readdir}=require('node:fs/promises'),{existsSync}=require('node:fs');
const {tmpdir}=require('node:os'),path=require('node:path'),net=require('node:net');
const {DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'company-modules-access-')),children=[];
  t.after(async()=>{
    for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));await rm(directory,{recursive:true,force:true});
  });
  const password='Fixture account password',database=path.join(directory,'content.sqlite');
  const authDb=new DatabaseSync(database);
  try{
    const auth=createAuthStore(authDb,`owner:owner:${hashPassword(password)}`),owner=auth.getByLogin('owner');
    for(const [login,permissions]of [
      ['editor',['company-information.view','company-information.edit','autoposting.view','autoposting.edit']],
      ['viewer',['company-information.view','autoposting.view']],['none',['analytics.view']],
      ['information_editor',['company-information.view','company-information.edit']],
      ['posting_editor',['autoposting.view','autoposting.edit']],
    ]){const user=auth.create(owner.id,{login,displayName:login,password},hashPassword(password));auth.updateAccess(owner.id,user.id,['alvi'],permissions);}
  }finally{authDb.close();}
  const apiKey=randomBytes(24).toString('hex'),marker=path.join(directory,'unexpected-network.txt'),preload=path.join(directory,'deny-outbound.cjs');
  await writeFile(preload,`'use strict';
    function blocked(){require('node:fs').appendFileSync(${JSON.stringify(marker)},'outbound attempted\\n');throw Error('Fixture outbound disabled');}
    require('node:net').Socket.prototype.connect=blocked;require('node:tls').connect=blocked;
    const dns=require('node:dns');for(const method of ['lookup','resolve','resolve4','resolve6','resolveMx']){dns[method]=blocked;if(dns.promises[method])dns.promises[method]=blocked;}
  `);
  async function start(file,env,guard){
    const port=await freePort(),child=spawn(process.execPath,[...(guard?['--require',guard]:[]),file],{env:{...process.env,...env,PORT:String(port)},stdio:['ignore','ignore','pipe'],windowsHide:true});children.push(child);
    let errors='';child.stderr.on('data',chunk=>errors+=chunk);const base=`http://127.0.0.1:${port}`;
    for(let attempt=0;attempt<100;attempt++){
      if(child.exitCode!==null)throw Error('Fixture service failed: '+errors);
      try{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});await response.text();return base;}catch{await new Promise(resolve=>setTimeout(resolve,25));}
    }throw Error('Fixture service did not start');
  }
  const crmBase=await start(path.join(__dirname,'../crm/server.js'),{DATABASE_PATH:path.join(directory,'crm.sqlite'),API_KEY:apiKey,
    LEADS_SMTP_HOST:'',LEADS_SMTP_USER:'',LEADS_SMTP_PASSWORD:'',LEADS_NOTIFY_EMAIL:'',LEADS_NOTIFY_EMAIL_ALVI:'',LEADS_NOTIFY_EMAIL_AVOKADO:''},preload);
  for(const code of ['alvi','avokado']){
    const response=await fetch(crmBase+'/companies',{method:'POST',headers:{'x-api-key':apiKey,'content-type':'application/json'},body:JSON.stringify({code,name:code,timezone:'UTC'})});
    assert.equal(response.status,201);await response.text();
  }
  const base=await start(path.join(__dirname,'server.js'),{DATABASE_PATH:database,API_KEY:'',AUTH_USERS:'',SEED_DIR:directory,
    ASSETS_DIR:path.join(directory,'assets'),SESSION_SECRET:randomBytes(32).toString('hex'),CRM_URL:crmBase,CRM_API_KEY:apiKey});
  async function request(method,pathname,body,session,headers={}){
    const response=await fetch(base+pathname,{method,headers:{...headers,...(session?{cookie:session.cookie,...(session.csrf!==undefined?{'x-csrf-token':session.csrf}:{})}:{}),
      ...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(6000)});
    const text=await response.text();return {status:response.status,text,body:text&&response.headers.get('content-type')?.includes('json')?JSON.parse(text):null,headers:response.headers};
  }
  async function login(login){const signed=await request('POST','/content/login',{login,password});assert.equal(signed.status,200);const session={cookie:signed.headers.get('set-cookie').split(';')[0]};session.csrf=(await request('GET','/content/whoami',undefined,session)).body.csrfToken;return session;}
  const sessions={};for(const name of ['owner','editor','viewer','none','information_editor','posting_editor'])sessions[name]=await login(name);
  return {base,request,sessions,marker,assetsDir:path.join(directory,'assets'),crm:(method,url,body,session,headers)=>request(method,'/content/crm'+url,body,session,headers)};
}

test('real content-to-CRM modules enforce assigned company permissions, trusted role and CSRF',async t=>{
  const f=await fixture(t),{owner,editor,viewer,none}=f.sessions;
  for(const route of ['/company-information','/autoposting/settings','/autoposting/posts']){
    assert.equal((await f.crm('GET',route+'?companyCode=alvi')).status,401);
    for(const session of [owner,editor,viewer])assert.equal((await f.crm('GET',route+'?companyCode=alvi',undefined,session)).status,200);
    assert.equal((await f.crm('GET',route+'?companyCode=alvi',undefined,none)).status,403);
    assert.equal((await f.crm('GET',route+'?companyCode=avokado',undefined,editor)).status,403);
    assert.equal((await f.crm('GET',route+'?companyCode=avokado',undefined,owner)).status,200);
    assert.equal((await f.crm('GET',route,undefined,owner)).status,400);
    assert.equal((await f.crm('GET',route+'?companyCode=bad%2Fcode',undefined,owner)).status,400);
  }
  const initial=(await f.crm('GET','/company-information?companyCode=alvi',undefined,editor)).body;
  const profileBody={revision:initial.revision,profile:{description:'Fixture confirmed facts'}};
  const forged=Buffer.from(JSON.stringify({v:1,userId:1,role:'owner',permissions:['company-information.edit','autoposting.edit'],companyCodes:['alvi','avokado']})).toString('base64url');
  for(const session of [none,viewer])assert.equal((await f.crm('PUT','/company-information?companyCode=alvi',profileBody,session,{'x-synapse-crm-identity':forged,'x-api-key':'browser-spoof'})).status,403);
  assert.equal((await f.crm('GET','/company-information?companyCode=avokado',undefined,editor,{'x-synapse-crm-identity':forged})).status,403);
  for(const csrf of [undefined,'wrong'])assert.equal((await f.crm('PUT','/company-information?companyCode=alvi',profileBody,{...editor,csrf})).status,403);
  assert.equal((await f.crm('GET','/company-information?companyCode=alvi',undefined,editor)).body.revision,initial.revision);
  const saved=await f.crm('PUT','/company-information?companyCode=alvi',profileBody,editor);assert.equal(saved.status,200);
  assert.equal(saved.body.profile.description,'Fixture confirmed facts');assert.equal(saved.body.history[0].actorId,saved.body.fieldStates.description.actorId);
  assert.equal((await f.crm('PUT','/company-information?companyCode=alvi',profileBody,editor)).status,409);
  const draftBody={title:'QA draft',text:'Never send from this test',mediaUrls:[],platformIds:[],timezone:'UTC',profileRevision:saved.body.revision};
  for(const session of [none,viewer])assert.equal((await f.crm('POST','/autoposting/posts?companyCode=alvi',draftBody,session)).status,403);
  for(const csrf of [undefined,'wrong'])assert.equal((await f.crm('POST','/autoposting/posts?companyCode=alvi',draftBody,{...editor,csrf})).status,403);
  const created=await f.crm('POST','/autoposting/posts?companyCode=alvi',draftBody,editor);assert.equal(created.status,201);
  const post=created.body;
  assert.equal((await f.crm('GET',`/autoposting/posts/${post.id}?companyCode=avokado`,undefined,owner)).status,404);
  for(const action of ['schedule','cancel']){
    assert.equal((await f.crm('POST',`/autoposting/posts/${post.id}/${action}?companyCode=alvi`,{revision:post.revision},viewer)).status,403);
    assert.equal((await f.crm('POST',`/autoposting/posts/${post.id}/${action}?companyCode=alvi`,{revision:post.revision},{...editor,csrf:undefined})).status,403);
  }
  assert.equal((await f.crm('POST',`/autoposting/posts/${post.id}/cancel?companyCode=alvi`,{revision:post.revision},editor)).body.status,'cancelled');
  for(const pathname of ['/company-information/check','/autoposting/settings/telegram/check']){
    assert.equal((await f.crm('POST',pathname+'?companyCode=alvi',{},viewer)).status,403);
    assert.equal((await f.crm('POST',pathname+'?companyCode=alvi',{},{...editor,csrf:'bad'})).status,403);
  }
  assert.equal((await f.crm('POST','/company-information/check?companyCode=alvi',{},editor)).status,200);
  for(const [method,pathname,expected]of [['DELETE','/company-information',405],['PUT','/autoposting/posts',405],['POST','/autoposting/settings',404],['DELETE',`/autoposting/posts/${post.id}`,405]]){
    assert.equal((await f.crm(method,pathname+'?companyCode=alvi',{},owner)).status,expected,`${method} ${pathname}`);
  }
  assert.equal(existsSync(f.marker),false,'all test data and services stay local, without publication or external fetch');
});

test('publishing photo uploads require an assigned editor and CSRF; opaque public images are bounded and non-executable',async t=>{
  const f=await fixture(t),{owner,editor,viewer,none,information_editor,posting_editor}=f.sessions;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ksAAAAASUVORK5CYII=','base64');
  async function raw(method,pathname,bytes,session,type='image/png',headers={}){
    const response=await fetch(f.base+pathname,{method,headers:{...headers,...(session?{cookie:session.cookie,...(session.csrf!==undefined?{'x-csrf-token':session.csrf}:{})}:{}),...(bytes?{'content-type':type}:{})},body:bytes,signal:AbortSignal.timeout(6000)});
    const data=Buffer.from(await response.arrayBuffer());return {status:response.status,headers:response.headers,data,body:response.headers.get('content-type')?.includes('json')?JSON.parse(data.toString()):null};
  }
  const upload='/content/publishing-assets?companyCode=alvi';
  assert.equal((await raw('POST',upload,png)).status,401);
  for(const session of [viewer,none])assert.equal((await raw('POST',upload,png,session)).status,403);
  assert.equal((await raw('POST','/content/publishing-assets?companyCode=avokado',png,editor)).status,403);
  for(const csrf of [undefined,'wrong'])assert.equal((await raw('POST',upload,png,{...editor,csrf})).status,403);
  assert.equal((await raw('POST','/content/publishing-assets',png,owner)).status,400);
  assert.equal((await raw('POST','/content/publishing-assets?companyCode=unknown',png,owner)).status,400);
  assert.equal((await raw('GET','/content/publishing-assets')).status,405);
  assert.equal((await raw('GET','/content/publishing-assets/')).status,404);
  assert.equal((await raw('GET','/content/publishing-assets/alvi/')).status,404);
  assert.equal(existsSync(path.join(f.assetsDir,'publishing')),false,'denied uploads create no publication files');
  for(const [bytes,type]of [[png,'image/jpeg'],[png.subarray(0,8),'image/png'],[Buffer.from('<svg onload="alert(1)"/>'),'image/svg+xml'],[Buffer.from('<script>alert(1)</script>'),'image/png']]){
    assert.equal((await raw('POST',upload,bytes,editor,type)).status,415);
  }
  const oversized=Buffer.alloc(10*1024*1024+1);png.copy(oversized);
  assert.equal((await raw('POST',upload,oversized,editor)).status,413);
  assert.equal(existsSync(path.join(f.assetsDir,'publishing')),false,'invalid/oversized uploads leave no files');
  const successful=[];
  for(const session of [owner,information_editor,posting_editor]){
    const result=await raw('POST',upload,png,session);assert.equal(result.status,201);
    assert.equal(result.body.size,png.length);assert.equal(result.body.type,'image/png');
    const url=new URL(result.body.url);assert.equal(url.origin,'https://synapse.synapsebusiness.ru');assert.match(url.pathname,/^\/content\/publishing-assets\/alvi\/[a-f0-9]{32}\.png$/);
    successful.push(url.pathname);
    const publicImage=await raw('GET',url.pathname);assert.equal(publicImage.status,200);assert.deepEqual(publicImage.data,png);
    assert.equal(publicImage.headers.get('content-type'),'image/png');assert.equal(publicImage.headers.get('x-content-type-options'),'nosniff');
    assert.match(publicImage.headers.get('content-security-policy'),/default-src 'none'; sandbox/);
    assert.match(publicImage.headers.get('cache-control'),/immutable/);assert.match(publicImage.headers.get('content-disposition'),/^inline; filename="[a-f0-9]{32}\.png"$/);
    const head=await raw('HEAD',url.pathname);assert.equal(head.status,200);assert.equal(head.data.length,0);assert.equal(Number(head.headers.get('content-length')),png.length);
    assert.equal((await raw('GET',url.pathname.replace('/alvi/','/avokado/'))).status,404);
    assert.equal((await raw('DELETE',url.pathname,undefined,owner)).status,405);
  }
  assert.equal(new Set(successful).size,successful.length,'filenames are opaque and newly allocated');
  const files=await readdir(path.join(f.assetsDir,'publishing/alvi'));assert.equal(files.length,3);
  for(const suffix of ['../auth.sqlite','%2e%2e%2fcontent.sqlite','a'.repeat(32)+'.html','a'.repeat(32)+'.png'])assert.equal((await raw('GET','/content/publishing-assets/alvi/'+suffix)).status,404);
  assert.equal(existsSync(f.marker),false);
});
