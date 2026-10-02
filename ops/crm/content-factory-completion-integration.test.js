'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto');
test('actual CRM HTTP: настройки, независимая версия/replay и полная cursor история',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cf-completion-')),key=randomBytes(24).toString('hex');
 const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 let child; t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const closed=once(child,'exit');child.kill();await closed;}assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));await fs.rm(dir,{recursive:true,force:true});});
 let output='';child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{SystemRoot:process.env.SystemRoot||'',PATH:process.env.PATH||'',PORT:String(port),DATABASE_PATH:path.join(dir,'crm.sqlite'),API_KEY:key},stdio:['ignore','pipe','pipe'],windowsHide:true});
 child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
 for(let i=0;i<200&&!output.includes('слушает');i++){if(child.exitCode!==null)throw Error('Fixture CRM failed: '+output);await new Promise(r=>setTimeout(r,25));}assert.match(output,/слушает/);
 const identity=(role='owner',permissions=[],companyCodes=[])=>Buffer.from(JSON.stringify({v:1,userId:1,userName:'QA Owner',role,permissions,companyCodes})).toString('base64url');
 async function req(method,url,body,who=identity(),auth=true){const res=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{...(auth?{'x-api-key':key}:{}),'x-synapse-crm-identity':who,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});return {status:res.status,body:await res.json(),cache:res.headers.get('cache-control')};}
 for(const code of ['qa','other'])assert.equal((await req('POST','/companies',{code,name:code,timezone:'UTC'})).status,201);
 const scope='?companyCode=qa',wf='/media-mentor/workflow'+scope;
 let response=await req('GET',wf);assert.equal(response.status,200);assert.equal(response.body.configured,false);assert.equal(response.body.revision,0);assert.equal(response.cache,'no-store');
 response=await req('PUT',wf,{revision:0,fields:{releaseMode:'manual',hours:['10:00'],preparationDays:2,reviewDays:1,publisherName:'QA Publisher'}});assert.equal(response.status,200);assert.equal(response.body.configured,true);assert.equal(response.body.revision,1);
 assert.equal((await req('PUT',wf,{revision:0,fields:{releaseMode:'manual'}})).status,409);
 const base=await req('POST','/autoposting/posts'+scope,{title:'Исходная идея',text:'Текст',platformIds:['instagram'],mediaUrls:[],format:'reel',role:'reach',timezone:'UTC',profileRevision:1});assert.equal(base.status,201);let original=base.body;
 const rootUrl=`/autoposting/posts/${original.id}`;
 response=await req('POST',rootUrl+'/schedule'+scope,{revision:original.revision,profileRevision:original.profileRevision,scheduledAt:'2099-01-01T10:00:00Z'});assert.equal(response.status,409);assert.match(JSON.stringify(response.body),/WORKFLOW_MANUAL_MODE/);
 const body={revision:original.revision,clientRequestId:'variant-one',platformId:'telegram'},url=rootUrl+'/variants'+scope;
 const made=await req('POST',url,body);assert.equal(made.status,201);assert.equal(made.body.created,true);const variant=made.body.post;
 assert.notEqual(variant.id,original.id);assert.deepEqual(variant.platformIds,['telegram']);assert.equal(variant.status,'draft');assert.equal(variant.scheduledAt,null);assert.equal(variant.approvalRequired,true);assert.equal(variant.variantOf.postId,original.id);assert.equal(variant.rootIdea.postId,original.id);
 const edited=await req('PATCH',`/autoposting/posts/${variant.id}`+scope,{revision:variant.revision,title:'Ручная правка',captions:{},dayKey:''});assert.equal(edited.status,200);assert.equal(edited.body.approvalRequired,true);
 const replay=await req('POST',url,body);assert.equal(replay.status,200);assert.equal(replay.body.created,false);assert.equal(replay.body.post.id,variant.id);assert.equal(replay.body.post.title,variant.title,'receipt сохраняет исходный DTO, не затирает ручной материал');
 assert.equal((await req('GET',`/autoposting/posts/${variant.id}`+scope)).body.title,'Ручная правка');
 assert.equal((await req('POST',url,{...body,platformId:'vk'})).status,409);
 const viewer=identity('editor',['autoposting.view'],['qa']);assert.equal((await req('POST',url,body,viewer)).status,403);
 assert.equal((await req('POST',url,body,identity(),false)).status,401);assert.equal((await req('POST',rootUrl+'/variants?companyCode=other',body)).status,404);
 for(let i=0;i<35;i++){const changed=await req('PATCH',rootUrl+scope,{revision:original.revision,title:`Версия ${i}`});assert.equal(changed.status,200);original=changed.body;}
 const first=await req('GET',rootUrl+'/history'+scope+'&limit=10',null,viewer);assert.equal(first.status,200);assert.equal(first.cache,'no-store');assert.equal(first.body.items.length,10);assert.equal(first.body.hasMore,true);
 const second=await req('GET',rootUrl+'/history'+scope+`&limit=100&before=${first.body.nextBefore}`,null,viewer);assert.equal(second.status,200);assert.equal(second.body.hasMore,false);
 const ids=[...first.body.items,...second.body.items].map(i=>i.id);assert.equal(new Set(ids).size,ids.length);assert.ok(ids.length>30);assert.equal(second.body.nextBefore,null);
 assert.equal((await req('GET',rootUrl+'/history?companyCode=other',null,identity())).status,404);assert.equal((await req('POST',rootUrl+'/history'+scope,{})).status,405);
});
