'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createReelPreviewWorker}=require('./reel-preview-worker'),{createReelPreviews}=require('./reel-previews');
const item=(cursor)=>({cursor,companyCode:'alpha',fileName:cursor.toString(16).padStart(32,'0')+'.mp4'});
const response=items=>({ok:true,json:async()=>({items})});
const settle=()=>new Promise(r=>setImmediate(r));
test('пустое хранилище не опрашивает CRM; первый сохранённый файл включает фоновое чтение',async()=>{
 let present=false,reads=0;const worker=createReelPreviewWorker({crmUrl:'http://crm.test',apiKey:'SAMPLE',hasSources:()=>present,
  previews:{inspect:()=>assert.fail()},fetchImpl:async()=>{reads++;return response([]);}});
 await worker.tick();assert.equal(reads,0);present=true;await worker.tick();assert.equal(reads,1);worker.close();
});
test('сохранённые версии до первого просмотра: 10 файлов/очередь8, повтор после busy, восстановление после рестарта',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'preview-feed-')),sourceDir=path.join(root,'publishing','alpha');fs.mkdirSync(sourceDir,{recursive:true});
 for(let i=1;i<=10;i++)fs.writeFileSync(path.join(sourceDir,item(i).fileName),'SAMPLE original '+i);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let pending=[],converted=0,reads=0,viewRequests=0;
 const convert=async(source,target)=>new Promise(resolve=>{converted++;pending.push(()=>{fs.copyFileSync(source,target);resolve();});});
 const previews=createReelPreviews({assetsDir:root,convert});t.after(()=>previews.close());
 const fetchImpl=async(url,options)=>{reads++;assert.equal(options.headers['x-api-key'],'SAMPLE');assert.equal(options.redirect,'error');
  const after=Number(new URL(url).searchParams.get('after'));return response(Array.from({length:10},(_,i)=>item(i+1)).filter(x=>x.cursor>after));};
 const worker=createReelPreviewWorker({crmUrl:'http://crm.test',apiKey:'SAMPLE',previews,fetchImpl});t.after(()=>worker.close());
 await worker.tick();assert.equal(converted,1);assert.equal(previews.inspect('alpha',item(10).fileName,{start:false}).state,'busy');
 pending.shift()();await settle();await worker.tick();assert.equal(previews.inspect('alpha',item(10).fileName,{start:false}).state,'queued','полная очередь не потеряла десятую версию');
 while(pending.length){pending.shift()();await settle();}assert.equal(converted,10);assert.equal(viewRequests,0);
 worker.close();await previews.close();
 const restarted=createReelPreviews({assetsDir:root,convert:async()=>{throw Error('CACHE MUST SURVIVE');}});t.after(()=>restarted.close());
 const next=createReelPreviewWorker({crmUrl:'http://crm.test',apiKey:'SAMPLE',previews:restarted,fetchImpl});t.after(()=>next.close());
 await next.tick();assert.equal(converted,10);assert.ok(reads>=3);
 for(let i=1;i<=10;i++)assert.equal(fs.readFileSync(path.join(sourceDir,item(i).fileName),'utf8'),'SAMPLE original '+i);
});
test('версия появилась после пустой очереди; сбой CRM/некорректный пакет не теряет её и не допускает URL/чужую компанию',async()=>{
 const calls=[],responses=[response([]),{ok:false},response([item(1),{...item(2),fileName:'http://private.test/a.mp4'}]),response([item(1),{...item(2),companyCode:'other'}, {...item(3),fileName:null}])];
 const worker=createReelPreviewWorker({crmUrl:'http://crm.test',apiKey:'SAMPLE',allowedCompany:c=>c==='alpha',previews:{inspect:(...args)=>{calls.push(args);return {state:'ready'};}},fetchImpl:async()=>responses.shift()});
 await worker.tick();await worker.tick();await worker.tick();assert.equal(calls.length,0);
 await worker.tick();assert.deepEqual(calls,[['alpha',item(1).fileName]]);worker.close();
});
test('остановка отменяет чтение, два одновременных прохода не запускаются',async()=>{
 let reads=0,aborted=false;
 const worker=createReelPreviewWorker({crmUrl:'http://crm.test',apiKey:'SAMPLE',previews:{inspect:()=>assert.fail()},fetchImpl:async(url,{signal})=>{
  reads++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('ABORT'));}));
 }});
 const running=worker.tick();await worker.tick();assert.equal(reads,1);worker.close();await running;assert.equal(aborted,true);await worker.tick();assert.equal(reads,1);
});
