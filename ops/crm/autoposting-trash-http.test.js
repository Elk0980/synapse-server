'use strict';
// HTTP-маршруты корзины: права правки/просмотра своей компании, чужая компания, метод и полный цикл.
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto');

test('корзина через HTTP: только право правки этой компании удаляет и восстанавливает, чужая компания получает 403/404',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'autoposting-trash-api-'));
  const key=randomBytes(24).toString('hex'),probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));let child;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});
  });
  let output='';child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{SystemRoot:process.env.SystemRoot||'',PATH:process.env.PATH||'',PORT:String(port),DATABASE_PATH:path.join(directory,'crm.sqlite'),API_KEY:key},stdio:['ignore','pipe','ignore'],windowsHide:true});
  child.stdout.on('data',chunk=>{output+=chunk;});
  for(let attempt=0;attempt<200&&!output.includes('слушает');attempt++){if(child.exitCode!==null)throw Error('Fixture CRM failed to start');await new Promise(resolve=>setTimeout(resolve,25));}
  assert.match(output,/слушает/);
  const encode=identity=>Buffer.from(JSON.stringify({v:1,userId:1,role:'editor',permissions:[],companyCodes:[],...identity})).toString('base64url');
  const owner=encode({role:'owner',userName:'Влад'});
  async function request(method,url,{body,identity=owner,authenticated=true}={}){
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{...(authenticated?{'x-api-key':key}:{}),...(identity?{'x-synapse-crm-identity':identity}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  }
  for(const code of ['palitra-love','other'])assert.equal((await request('POST','/companies',{body:{code,name:code,timezone:'UTC'}})).status,201);
  const created=await request('POST','/autoposting/posts?companyCode=palitra-love',{body:{title:'Пробный · День1',text:'Букеты',mediaUrls:['https://example.test/clip.mp4'],platformIds:['telegram'],scheduledAt:null,timezone:'UTC',profileRevision:1}});
  assert.equal(created.status,201);
  const id=created.body.id,del=`/autoposting/posts/${id}/delete?companyCode=palitra-love`,body={revision:created.body.revision,comment:'Цветы'};
  const viewer=encode({permissions:['autoposting.view'],companyCodes:['palitra-love']});
  const foreignEditor=encode({permissions:['autoposting.view','autoposting.edit'],companyCodes:['other']});
  const editor=encode({permissions:['autoposting.view','autoposting.edit'],companyCodes:['palitra-love'],userName:'Редактор'});
  assert.equal((await request('POST',del,{body,identity:viewer})).status,403,'просмотр не даёт удаления');
  assert.equal((await request('POST',del,{body,identity:foreignEditor})).status,403,'право чужой компании не действует');
  assert.equal((await request('POST',del,{body,authenticated:false})).status,401);
  assert.equal((await request('POST',`/autoposting/posts/${id}/delete?companyCode=other`,{body})).status,404,'карточка другой компании не находится');
  assert.equal((await request('GET',del)).status,405);
  assert.equal((await request('GET',`/autoposting/posts/${id}?companyCode=palitra-love`)).status,200,'неудачные попытки ничего не удалили');
  const removed=await request('POST',del,{body,identity:editor});
  assert.equal(removed.status,200);assert.equal(removed.body.deleted.byName,'Редактор');assert.equal(removed.body.deleted.comment,'Цветы');
  assert.equal((await request('POST',del,{body,identity:editor})).status,404,'повтор той же версии');
  assert.equal((await request('GET',`/autoposting/posts/${id}?companyCode=palitra-love`)).status,404);
  assert.deepEqual((await request('GET','/autoposting/posts?companyCode=palitra-love')).body.posts,[]);
  const trash=await request('GET','/autoposting/trash?companyCode=palitra-love',{identity:viewer});
  assert.equal(trash.status,200);assert.deepEqual(trash.body.posts.map(p=>p.id),[id]);
  assert.equal((await request('GET','/autoposting/trash?companyCode=palitra-love',{identity:foreignEditor})).status,403);
  assert.deepEqual((await request('GET','/autoposting/trash?companyCode=other')).body.posts,[]);
  assert.equal((await request('POST','/autoposting/trash?companyCode=palitra-love',{body:{}})).status,405);
  const restoreRoute=`/autoposting/posts/${id}/restore?companyCode=palitra-love`;
  assert.equal((await request('POST',restoreRoute,{body:{revision:removed.body.revision},identity:viewer})).status,403);
  assert.equal((await request('POST',`/autoposting/posts/${id}/restore?companyCode=other`,{body:{revision:removed.body.revision}})).status,404);
  assert.equal((await request('POST',restoreRoute,{body:{revision:created.body.revision},identity:editor})).status,409,'устаревшая версия');
  const restored=await request('POST',restoreRoute,{body:{revision:removed.body.revision},identity:editor});
  assert.equal(restored.status,200);assert.equal(restored.body.deleted,null);assert.equal(restored.body.title,'Пробный · День1');
  assert.deepEqual((await request('GET','/autoposting/posts?companyCode=palitra-love')).body.posts.map(p=>p.id),[id]);
});
