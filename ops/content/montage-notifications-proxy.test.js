'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),{once}=require('node:events');
const {DatabaseSync}=require('node:sqlite'),{createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
test('живой proxy: OFF/ON, свой автор из сессии, view-only read+CSRF, запрет чужой компании и внутреннего feed',{timeout:60000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'montage-notices-proxy-')),database=path.join(dir,'content.sqlite'),children=[],calls=[];
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});});
 const authDb=new DatabaseSync(database),auth=createAuthStore(authDb,'owner:owner:'+hashPassword('SAMPLE-password-12345')),owner=auth.getByLogin('owner');
 const viewer=auth.create(owner.id,{login:'viewer',displayName:'SAMPLE',password:'SAMPLE-password-12345',companies:['avokado'],permissions:['autoposting.view']},hashPassword('SAMPLE-password-12345'));
 auth.create(owner.id,{login:'denied',displayName:'SAMPLE denied',password:'SAMPLE-password-12345',companies:['avokado'],permissions:['crm.view']},hashPassword('SAMPLE-password-12345'));authDb.close();
 const crm=http.createServer((req,res)=>{
  let body='';req.on('data',c=>body+=c);req.on('end',()=>{
   calls.push({path:req.url,method:req.method,identity:req.headers['x-synapse-crm-identity'],body});res.setHeader('content-type','application/json');
   if(req.url.startsWith('/internal/reel-materials/notifications'))return res.end(JSON.stringify({enabled:true,events:[],nextAfter:0}));
   if(req.url.includes('/notifications'))return res.end(JSON.stringify({enabled:true,companyCode:'avokado',count:0,reels:[]}));
   if(req.url.startsWith('/internal/reel-materials/hugh-log'))return res.end(JSON.stringify({authorId:viewer.id,companyCode:'avokado',entries:[]}));
   res.writeHead(403);res.end('{}');
  });
 });
 await new Promise(r=>crm.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>crm.close(r)));
 const origin=`http://127.0.0.1:${crm.address().port}`,preload=path.join(dir,'network.cjs');
 await fs.writeFile(preload,`const net=require('node:net');const original=net.Socket.prototype.connect;const allowed=new URL(${JSON.stringify(origin)});
 net.Socket.prototype.connect=function(...args){const a=Array.isArray(args[0])?args[0]:args;const o=typeof a[0]==='object'?a[0]:{port:a[0],host:a[1]};if(o.host!==allowed.hostname||String(o.port)!==allowed.port)throw Error('NETWORK_BLOCKED');return original.apply(this,args);};require('node:tls').connect=()=>{throw Error('NETWORK_BLOCKED');};`);
 async function start(enabled){
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['--require',preload,path.join(__dirname,'server.js')],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{PATH:process.env.PATH||'',NODE_PATH:process.env.NODE_PATH||'',PORT:String(port),DATABASE_PATH:database,
   SEED_DIR:dir,ASSETS_DIR:path.join(dir,'assets'),AUTH_USERS:'',SESSION_SECRET:'SAMPLE-session-secret-montage-298',CRM_URL:origin,CRM_API_KEY:'SAMPLE',MONTAGE_WATCHER_ENABLED:'0',MONTAGE_NOTIFICATIONS_ENABLED:enabled?'1':'0'}});
  children.push(child);let errors='';child.stderr.on('data',c=>errors+=c);const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(errors);try{await fetch(base+'/health');return {base,child};}catch{await new Promise(r=>setTimeout(r,25));}}throw Error('START_TIMEOUT');
 }
 async function call(base,route,options={}){const response=await fetch(base+route,options);return {status:response.status,headers:response.headers,body:await response.json()};}
 async function login(base,name){const result=await call(base,'/content/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:name,password:'SAMPLE-password-12345'})});assert.equal(result.status,200);
  const cookie=result.headers.get('set-cookie').split(';')[0],profile=await call(base,'/content/whoami',{headers:{cookie}});return {cookie,'x-csrf-token':profile.body.csrfToken};}
 const route='/content/crm/autoposting/reels/notifications?companyCode=avokado';
 const disabled=await start(false),first=await login(disabled.base,'viewer');assert.equal((await call(disabled.base,route,{headers:first})).body.enabled,false);
 const ended=once(disabled.child,'exit');disabled.child.kill();await ended;
 const {base}=await start(true),headers=await login(base,'viewer');
 assert.equal((await call(base,route,{headers:{...headers,'x-synapse-crm-identity':'SAMPLE FORGED'}})).status,200);
 const forwarded=calls.find(c=>c.path.startsWith('/autoposting/reels/notifications'));assert.equal(JSON.parse(Buffer.from(forwarded.identity,'base64url')).userId,viewer.id);
 const read='/content/crm/autoposting/reels/21/notifications/read?companyCode=avokado',body=JSON.stringify({throughId:1});
 assert.equal((await call(base,read,{method:'POST',headers:{...headers,'content-type':'application/json','x-csrf-token':''},body})).status,403);
 assert.equal((await call(base,read,{method:'POST',headers:{...headers,'content-type':'application/json'},body})).status,200);
 assert.equal((await call(base,route.replace('avokado','alvi'),{headers})).status,403);
 assert.equal((await call(base,'/content/crm/internal/reel-materials/notifications',{headers})).status,403);
 assert.equal((await call(base,route,{headers:await login(base,'denied')})).status,403);
});
