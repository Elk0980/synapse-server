'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
const {createAutopostingTransport}=require('../crm/autoposting-transport');
async function freePort(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;}
test('real proxy enforces owner/company/CSRF and journals one explicit design mutation without touching Onlypult',{timeout:40000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vk-tools-test-')),children=[];let stored;
 const crmDb=path.join(dir,'crm.sqlite'),contentDb=path.join(dir,'content.sqlite'),marker=path.join(dir,'methods.jsonl');
 const key=randomBytes(32).toString('hex'),password='Synthetic-fixture-password',token='FIXTURE_DIRECT_VK_TOKEN';
 t.after(async()=>{for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
   if(stored)stored.close();
   assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});});
 const adb=new DatabaseSync(contentDb),auth=createAuthStore(adb,`owner:owner:${hashPassword(password)}`),owner=auth.getByLogin('owner');
 auth.create(owner.id,{login:'editor',displayName:'Fixture editor',password,companies:['avokado'],permissions:['crm.view','crm.edit','analytics.view','autoposting.view','autoposting.edit']},hashPassword(password));adb.close();
 const preload=path.join(dir,'provider.cjs');
 await fs.writeFile(preload,`'use strict';
 const fs=require('node:fs');function blocked(){throw Error('External network disabled');}
 require('node:net').Socket.prototype.connect=blocked;require('node:tls').connect=blocked;
 let description='Original fixture description';
 globalThis.fetch=async(url,options)=>{
   if(url==='https://pu.vk.com/material-upload'){
     if(options.redirect!=='error'||!options.body.get('photo'))blocked();
     fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({method:'fixture.upload',group:'12345'})+'\\n');
     return new Response(JSON.stringify({server:1,photos_list:'FIXTURE_PHOTOS',hash:'FIXTURE_HASH'}));
   }
   if(typeof url!=='string'||!url.startsWith('https://api.vk.com/method/'))blocked();
   const method=url.split('/').pop(),p=Object.fromEntries(new URLSearchParams(options.body));
   fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({method,group:p.group_id||null})+'\\n');
   let response;
   if(method==='account.getProfileInfo')response={id:123,first_name:'Fixture',last_name:'User'};
   else if(method==='groups.getTokenPermissions')response={mask:4096,permissions:[{name:'manage',setting:1}]};
   else if(method==='groups.getById')response={groups:[{id:Number(p.group_id),name:'Fixture group',description,members_count:25,cover:{enabled:0,images:[]},has_photo:1,photo_200:'https://sun.userapi.com/avatar.jpg'}]};
   else if(method==='stats.get')response=[{period_from:1,period_to:2,visitors:{views:7},reach:{reach:5},activity:{likes:2,comments:1,copies:0,subscribed:1,unsubscribed:0}}];
   else if(method==='photos.getAlbums')response={count:1,items:[{id:55,owner_id:-12345,title:'Fixture album',size:0}]};
   else if(method==='photos.getUploadServer')response={upload_url:'https://pu.vk.com/material-upload',album_id:55};
   else if(method==='photos.save'||method==='photos.getById')response=[{id:99,owner_id:-12345,album_id:55,text:'Fixture album photo'}];
   else if(method==='groups.edit'){description=p.description;response=1;}else blocked();
   return new Response(JSON.stringify({response}));
 };`);
 const crmBase=`http://127.0.0.1:${await freePort()}`,contentBase=`http://127.0.0.1:${await freePort()}`;
 async function start(file,env,base,pre){let stderr='';const child=spawn(process.execPath,[...(pre?['--require',pre]:[]),file],{env:{...process.env,...env},stdio:['ignore','ignore','pipe'],windowsHide:true});children.push(child);child.stderr.on('data',chunk=>stderr+=chunk);
   for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error('Service failed '+stderr);try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(300)});await r.text();return;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}throw Error('Service not ready '+stderr);}
 await start(path.join(__dirname,'../crm/server.js'),{PORT:new URL(crmBase).port,DATABASE_PATH:crmDb,API_KEY:key,RATE_LIMIT_MAX:'10000',STRICT_ORIGIN:'',LEADS_SMTP_HOST:'',LEADS_SMTP_PORT:'465',LEADS_SMTP_USER:'',LEADS_SMTP_PASSWORD:'',LEADS_MAIL_FROM:'',LEADS_NOTIFY_EMAIL:'',LEADS_NOTIFY_EMAIL_ALVI:'',LEADS_NOTIFY_EMAIL_AVOKADO:''},crmBase,preload);
 await start(path.join(__dirname,'server.js'),{PORT:new URL(contentBase).port,DATABASE_PATH:contentDb,AUTH_USERS:'',API_KEY:'',CRM_URL:crmBase,CRM_API_KEY:key,SEED_DIR:dir,ASSETS_DIR:path.join(dir,'assets'),SESSION_SECRET:randomBytes(32).toString('hex')},contentBase);
 const identity=Buffer.from(JSON.stringify({v:1,userId:1,role:'owner',permissions:[],companyCodes:['avokado','alvi']})).toString('base64url');
 async function request(base,route,{method='GET',body,headers={}}={}){const r=await fetch(base+route,{method,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const raw=await r.text();return{status:r.status,body:raw?JSON.parse(raw):null,headers:r.headers};}
 for(const code of ['avokado','alvi']){const r=await request(crmBase,'/companies',{method:'POST',body:{code,name:'Fixture '+code},headers:{'x-api-key':key,'x-synapse-crm-identity':identity}});assert.equal(r.status,201);}
 const sessions={};for(const login of ['owner','editor']){const r=await request(contentBase,'/content/login',{method:'POST',body:{login,password}});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];const who=await request(contentBase,'/content/whoami',{headers:{cookie}});sessions[login]={cookie,'x-csrf-token':who.body.csrfToken};}
 const through=(who,route,options={})=>request(contentBase,'/content/crm'+route,{...options,headers:{...sessions[who],...options.headers}});
 const route=p=>'/vk-tools/'+p+'?companyCode=avokado';
 const getCalls=async()=>{try{return(await fs.readFile(marker,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return[];throw e;}};
 stored=new DatabaseSync(crmDb);
 createAutopostingTransport(stored,{apiKey:key}).saveSettings('avokado',{channels:[{id:'vk',provider:'onlypult',name:'Fixture VK',target:'fixture_vk_profile',enabled:true,revision:0,token:'op_'+'f'.repeat(64)}]});
 stored.prepare("UPDATE autoposting_channels SET checked_revision=revision,status='connected' WHERE company_code='avokado' AND id='vk'").run();
 const publishingBefore=stored.prepare('SELECT * FROM autoposting_channels').all();
 for(const p of ['analytics/settings','design/settings','design/state','design/history','design/albums','design/material-history','design/avatar-history'])assert.equal((await through('editor',route(p))).status,403);
 for(const p of ['design/material-preview','design/material-apply','design/avatar-preview','design/avatar-apply'])assert.equal((await through('editor',route(p),{method:'POST',body:{}})).status,403);
 assert.equal((await through('owner','/vk-tools/design/settings')).status,400);
 assert.equal((await through('owner',route('design/settings'),{method:'PUT',body:{},headers:{'x-csrf-token':''}})).status,403);
 assert.equal((await getCalls()).length,0);
 for(const purpose of ['analytics','design']){
   const body={revision:0,groupId:'12345',tokenType:purpose==='analytics'?'user':'group',accessToken:token,enabled:true};
   const saved=await through('owner',route(purpose+'/settings'),{method:'PUT',body});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.connected,false);assert.equal(saved.body.revision,1);assert.ok(!JSON.stringify(saved.body).includes(token));
   const checked=await through('owner',route(purpose+'/check'),{method:'POST',body:{revision:1}});assert.equal(checked.status,200,JSON.stringify(checked.body));assert.equal(checked.body.connected,true);
 }
 const account=await through('owner','/social-stats/accounts?companyCode=avokado',{method:'PUT',body:{accounts:[{platform:'vk',accountRef:'club12345',provider:'onlypult',enabled:true,kind:'organic',timezone:'Etc/UTC',revision:0}]}});
 assert.equal(account.status,200,JSON.stringify(account.body));
 const collected=await through('owner','/social-stats/collect?companyCode=avokado',{method:'POST',body:{platform:'vk',date:new Date(Date.now()-86400000).toISOString().slice(0,10)}});
 assert.equal(collected.status,200,JSON.stringify(collected.body));
 const snapshots=stored.prepare("SELECT metric,value,provider FROM social_snapshots WHERE company_code='avokado' AND platform='vk'").all();
 assert.equal(snapshots.find(row=>row.metric==='views')?.value,7);assert.equal(snapshots.find(row=>row.metric==='followers')?.value,25);
 assert.ok(snapshots.every(row=>row.provider==='direct'));
 assert.equal(stored.prepare("SELECT provider FROM social_accounts WHERE company_code='avokado' AND platform='vk'").get().provider,'onlypult');
 assert.equal(stored.prepare("SELECT provider FROM social_collect_runs WHERE company_code='avokado' AND platform='vk' ORDER BY id DESC LIMIT 1").get().provider,'direct');
 assert.equal(stored.prepare("SELECT COUNT(*) AS n FROM social_snapshots WHERE company_code='alvi'").get().n,0);
 const preview=await through('owner',route('design/preview'),{method:'POST',body:{revision:1,operation:'description',description:'Approved fixture description'}});assert.equal(preview.status,200,JSON.stringify(preview.body));
 const action={revision:1,previewId:preview.body.previewId,requestId:'fixture_design_request_0001'};
 const denied=await through('owner',route('design/apply'),{method:'POST',body:action,headers:{'x-csrf-token':''}});assert.equal(denied.status,403);
 const crossed=await through('owner','/vk-tools/design/apply?companyCode=alvi',{method:'POST',body:action});assert.ok(crossed.status>=400);
 assert.equal((await getCalls()).filter(c=>c.method==='groups.edit').length,0);
 const applied=await through('owner',route('design/apply'),{method:'POST',body:action});assert.equal(applied.status,200,JSON.stringify(applied.body));assert.equal(applied.body.status,'verified');
 const duplicate=await through('owner',route('design/apply'),{method:'POST',body:action});assert.deepEqual(duplicate.body,applied.body);
 assert.equal((await getCalls()).filter(c=>c.method==='groups.edit').length,1);
 const history=await through('owner',route('design/history'));assert.equal(history.status,200);assert.equal(history.body.items.length,1);assert.ok(!JSON.stringify(history.body).includes(token));
 // Album writes require a deliberately checked user binding; community cover access is insufficient.
 const unsupported=await through('owner',route('design/albums')+'&revision=1');assert.ok(unsupported.status>=400);
 const userBinding=await through('owner',route('design/settings'),{method:'PUT',body:{revision:1,groupId:'12345',tokenType:'user',accessToken:token,enabled:true}});assert.equal(userBinding.status,200);
 assert.equal((await through('owner',route('design/check'),{method:'POST',body:{revision:2}})).body.connected,true);
 const albums=await through('owner',route('design/albums')+'&revision=2');assert.equal(albums.status,200,JSON.stringify(albums.body));assert.equal(albums.body.albums[0].id,55);
 const albumPreview=await through('owner',route('design/material-preview'),{method:'POST',body:{revision:2,albumId:55,caption:'Fixture album photo',image:{mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII='}}});
 assert.equal(albumPreview.status,200,JSON.stringify(albumPreview.body));assert.equal((await getCalls()).filter(c=>c.method==='fixture.upload').length,0);
 const albumAction={revision:2,previewId:albumPreview.body.previewId,requestId:'fixture_material_request_0001'};
 assert.equal((await through('owner',route('design/material-apply'),{method:'POST',body:albumAction,headers:{'x-csrf-token':''}})).status,403);
 assert.ok((await through('owner','/vk-tools/design/material-apply?companyCode=alvi',{method:'POST',body:albumAction})).status>=400);
 assert.equal((await getCalls()).filter(c=>c.method==='fixture.upload').length,0);
 const uploaded=await through('owner',route('design/material-apply'),{method:'POST',body:albumAction});assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));assert.equal(uploaded.body.status,'verified',JSON.stringify(uploaded.body));
 assert.deepEqual((await through('owner',route('design/material-apply'),{method:'POST',body:albumAction})).body,uploaded.body);
 assert.equal((await getCalls()).filter(c=>c.method==='fixture.upload').length,1);assert.equal((await getCalls()).filter(c=>c.method==='photos.save').length,1);
 const materialHistory=await through('owner',route('design/material-history')+'&revision=2');assert.equal(materialHistory.body.items.length,1);assert.doesNotMatch(JSON.stringify(materialHistory.body),/FIXTURE_HASH|FIXTURE_PHOTOS|FIXTURE_DIRECT_VK_TOKEN/);
 // Avatar preparation reads only; even a manually crafted explicit confirmation
 // cannot upload/save or enable the possible public wall-post side effect.
 const avatarBody={revision:2,image:{mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII='}};
 const beforeAvatar=(await getCalls()).length;
 assert.equal((await through('owner',route('design/avatar-preview'),{method:'POST',body:avatarBody,headers:{'x-csrf-token':''}})).status,403);
 const avatarPreview=await through('owner',route('design/avatar-preview'),{method:'POST',body:avatarBody});assert.equal(avatarPreview.status,200,JSON.stringify(avatarPreview.body));
 assert.deepEqual((await getCalls()).slice(beforeAvatar).map(c=>c.method),['groups.getById']);
 assert.deepEqual(avatarPreview.body.capabilities,{applyEnabled:false,cropSupported:false});
 assert.equal(avatarPreview.body.before.photo200,'https://sun.userapi.com/avatar.jpg');
 const avatarAction={revision:2,previewId:avatarPreview.body.previewId,requestId:'fixture_avatar_request_0001',confirmPublicPost:true};
 assert.equal((await through('owner',route('design/avatar-apply'),{method:'POST',body:avatarAction,headers:{'x-csrf-token':''}})).status,403);
 assert.ok((await through('owner','/vk-tools/design/avatar-apply?companyCode=alvi',{method:'POST',body:avatarAction})).status>=400);
 const beforeBlocked=(await getCalls()).length;
 const blocked=await through('owner',route('design/avatar-apply'),{method:'POST',body:avatarAction});assert.equal(blocked.status,200,JSON.stringify(blocked.body));assert.equal(blocked.body.status,'blocked');assert.equal(blocked.body.code,'AVATAR_APPLY_DISABLED');
 assert.deepEqual((await through('owner',route('design/avatar-apply'),{method:'POST',body:avatarAction})).body,blocked.body);
 assert.equal((await through('owner',route('design/avatar-apply'),{method:'POST',body:{...avatarAction,applyEnabled:true}})).status,400);
 const avatarHistory=await through('owner',route('design/avatar-history')+'&revision=2');assert.equal(avatarHistory.status,200);assert.equal(avatarHistory.body.items.length,1);
 assert.equal((await getCalls()).length,beforeBlocked);assert.doesNotMatch(JSON.stringify(avatarHistory.body),/FIXTURE_DIRECT_VK_TOKEN|base64|image_bytes/);
 assert.deepEqual(stored.prepare('SELECT * FROM autoposting_channels').all(),publishingBefore);
 assert.equal((await getCalls()).some(c=>['messages.send','wall.post','photos.getOwnerPhotoUploadServer','photos.saveOwnerPhoto'].includes(c.method)),false);
});
