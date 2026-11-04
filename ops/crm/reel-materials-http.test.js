'use strict';
// Настоящий CRM: маршрут подключён к server.js, публикация создаётся существующим автопостингом, служебный API — по ключу без личности.
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto');

test('Материалы через настоящий CRM: ролик → правка → v2 → черновик публикации в автопостинге',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reel-materials-api-'));
  const key=randomBytes(24).toString('hex'),probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));let child;
  t.after(async()=>{if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}await fs.rm(directory,{recursive:true,force:true});});
  let output='';child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{PATH:process.env.PATH||'',PORT:String(port),DATABASE_PATH:path.join(directory,'crm.sqlite'),API_KEY:key},stdio:['ignore','pipe','ignore']});
  child.stdout.on('data',chunk=>{output+=chunk;});
  for(let i=0;i<200&&!output.includes('слушает');i++){if(child.exitCode!==null)throw Error('CRM не запустился');await new Promise(r=>setTimeout(r,25));}
  const encode=identity=>Buffer.from(JSON.stringify({v:1,userId:5,role:'editor',permissions:[],companyCodes:[],...identity})).toString('base64url');
  const owner=encode({role:'owner',userName:'Влад'}),smm=encode({permissions:['autoposting.view','autoposting.edit'],companyCodes:['avokado'],userName:'СММ'});
  async function request(method,url,{body,identity=owner}={}){
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{'x-api-key':key,...(identity?{'x-synapse-crm-identity':identity}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  }
  for(const code of ['avokado','alvi'])assert.equal((await request('POST','/companies',{body:{code,name:code,timezone:'UTC'}})).status,201);
  const asset=(code,n)=>`https://synapse.example/content/publishing-assets/${code}/${n.repeat(32)}.mp4`;
  const reel=await request('POST','/autoposting/reels?companyCode=avokado',{identity:smm,body:{title:'Рилс №1',releaseDate:'2026-11-07',platforms:['instagram','tiktok'],mediaUrl:asset('avokado','a'),durationMs:12000}});
  assert.equal(reel.status,201,JSON.stringify(reel.body));
  assert.equal((await request('GET','/autoposting/reels?companyCode=alvi',{identity:smm})).status,403);
  assert.equal((await request('GET',`/autoposting/reels/${reel.body.id}?companyCode=alvi`)).status,404);
  const edit=await request('POST',`/autoposting/reels/${reel.body.id}/edits?companyCode=avokado`,{identity:smm,body:{clientRequestId:'k1',baseVersion:1,kind:'edl',
    edl:{v:1,video:[{inMs:3000,outMs:9000},{inMs:0,outMs:2000}],audio:[{inMs:0,outMs:8000,gain:1.2,muted:false}],captions:[],coverMs:500,speed:1}}});
  assert.equal(edit.status,201,JSON.stringify(edit.body));
  assert.equal((await request('GET','/internal/reel-materials/queue',{identity:smm})).status,403,'браузерная личность не попадает в служебный API');
  const queue=await request('GET','/internal/reel-materials/queue?companyCode=avokado',{identity:null});
  assert.equal(queue.body.edits[0].edl.outputMs,8000);
  assert.equal((await request('POST',`/internal/reel-materials/edits/${edit.body.edit.id}/claim?companyCode=avokado`,{identity:null})).body.status,'in_progress');
  const v2=await request('POST',`/internal/reel-materials/reels/${reel.body.id}/versions?companyCode=avokado`,{identity:null,body:{mediaUrl:asset('avokado','b'),durationMs:8000,editId:edit.body.edit.id}});
  assert.equal(v2.body.version.version,2);
  const tasks=await request('GET','/tasks?companyCode=avokado');
  assert.ok(JSON.stringify(tasks.body).includes('Монтаж: «Рилс №1» v1'),'задача монтажа на общей доске');
  const pub=await request('POST',`/autoposting/reels/${reel.body.id}/publication?companyCode=avokado`,{identity:smm,body:{version:2,platformIds:['instagram']}});
  assert.equal(pub.status,201,JSON.stringify(pub.body));
  const post=await request('GET',`/autoposting/posts/${pub.body.post.id}?companyCode=avokado`);
  assert.deepEqual(post.body.mediaUrls,[asset('avokado','b')]);assert.equal(post.body.status,'draft');assert.equal(post.body.scheduledAt,null);
  const list=await request('GET','/autoposting/reels?companyCode=avokado&platform=instagram',{identity:smm});
  assert.deepEqual(list.body.reels.map(r=>[r.title,r.currentVersion.version,r.postId]),[['Рилс №1',2,pub.body.post.id]]);
});
