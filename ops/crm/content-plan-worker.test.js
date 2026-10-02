'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createContentPlanJobs}=require('./content-plan-jobs');
const {createContentPlanWorker,validateProposals,slotsFor,promptFor}=require('./content-plan-worker');
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES(1,'alpha',0)");
 const jobs=createContentPlanJobs(db);
 const monthInputs={platforms:['telegram'],perDay:{telegram:1},excludedDays:Array.from({length:30},(_,i)=>`2026-10-${String(i+2).padStart(2,'0')}`)};
 const snapshot={timezone:'Asia/Irkutsk',brief:{product:'Шары',assets:[]},profile:{},monthInputs,requested:1,inputs:{briefRevision:1,profileRevision:2,monthRevision:3}};
 const job=jobs.enqueue('alpha',{clientRequestId:'worker_req1',month:'2026-10',snapshot});
 return {db,jobs,job,snapshot};
}
const proposal=()=>({date:'2026-10-01',platform:'telegram',format:'post',role:'reach',topic:'Как подготовить праздник',text:'Составьте список пожеланий',hook:'С чего начать?',assetId:''});
const provider=generate=>({identity:{kind:'test',model:'synthetic-only'},generate});
function libraryFor(t,code='alpha'){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE telegram_source_items(id INTEGER PRIMARY KEY,company_code TEXT,revision INTEGER,sha256 TEXT,name TEXT,mime TEXT,size INTEGER,declared_size INTEGER,status TEXT,caption TEXT,metadata TEXT);
 INSERT INTO telegram_source_items VALUES(7,'${code}',1,NULL,'','',NULL,NULL,'text','Подпись исходника','{}')`);
 return require('../content/content-factory-source-context').createSourceContext({db}).capture(code);
}
test('source:<id> входит в prompt и допустимые ссылки своей библиотеки без прикрепления',async t=>{
 const f=fixture(t),old=f.jobs.claim();f.jobs.reject(old.id,old.token);
 const manifest=libraryFor(t),snapshot={...f.snapshot,sourceLibrary:manifest};
 const created=f.jobs.enqueue('alpha',{clientRequestId:'worker_source_01',month:'2026-10',snapshot});
 let calls=0;
 await createContentPlanWorker({jobs:f.jobs,authorize:async()=>true,provider:provider(async input=>{
   calls++;assert.deepEqual(JSON.parse(input.messages[1].content).sourceLibrary,manifest);
   return {proposals:[{...proposal(),assetId:'source:7'}]};
 })}).runOne();
 const result=f.jobs.get('alpha',created.id).job;assert.equal(calls,1);assert.equal(result.status,'succeeded');assert.equal(result.proposals[0].assetId,'source:7');
 assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='autoposting_posts'").get().n,0);
});
test('неизвестные/чужие source IDs и коллизия legacy namespace отклоняются; старый snapshot совместим',t=>{
 const f=fixture(t),job={id:'source_job',companyCode:'alpha',month:'2026-10',snapshot:{...f.snapshot,brief:{assets:[{id:'brief_7'},{id:'source:999'}]},sourceLibrary:libraryFor(t)}};
 assert.equal(validateProposals({proposals:[{...proposal(),assetId:'brief_7'}]},job)[0].assetId,'brief_7');
 for(const assetId of ['source:999','source:8','source:07','7'])assert.throws(()=>validateProposals({proposals:[{...proposal(),assetId}]},job),e=>e.code==='INVALID_RESULT');
 const foreign={...job,snapshot:{...job.snapshot,sourceLibrary:libraryFor(t,'beta')}};
 assert.throws(()=>validateProposals({proposals:[{...proposal(),assetId:'source:7'}]},foreign),e=>e.code==='INVALID_RESULT');
 assert.throws(()=>promptFor(foreign),e=>e.code==='INVALID_RESULT');
 const legacy={...job,snapshot:{...f.snapshot,brief:{assets:[{id:'source:999'}]}}};
 assert.equal(validateProposals({proposals:[{...proposal(),assetId:'source:999'}]},legacy)[0].assetId,'source:999');
 assert.equal('sourceLibrary' in JSON.parse(promptFor(legacy)[1].content),false);
});
test('ссылка на сырой или неподходящий исходник не объявляет материал готовым, prompt не заявляет просмотра файлов',t=>{
 const f=fixture(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE telegram_source_items(id INTEGER PRIMARY KEY,company_code TEXT,revision INTEGER,sha256 TEXT,name TEXT,mime TEXT,size INTEGER,declared_size INTEGER,status TEXT,caption TEXT,metadata TEXT)");
 const insert=db.prepare('INSERT INTO telegram_source_items VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 insert.run(7,'alpha',1,null,'','',null,null,'text','Идея','{}');
 insert.run(8,'alpha',1,'a'.repeat(64),'photo.jpg','image/jpeg',100,100,'stored','Фото','{"materialState":"ready"}');
 insert.run(9,'alpha',1,'b'.repeat(64),'brief.pdf','application/pdf',100,100,'stored','Документ','{"materialState":"ready"}');
 const sourceLibrary=require('../content/content-factory-source-context').createSourceContext({db}).capture('alpha');
 const job={id:'raw-source',companyCode:'alpha',month:'2026-10',snapshot:{...f.snapshot,sourceLibrary}};
 for(const assetId of ['source:7','source:9'])assert.ok(validateProposals({proposals:[{...proposal(),assetId}]},job)[0].warnings.some(w=>w.code==='SOURCE_PREPARATION_REQUIRED'));
 assert.equal(validateProposals({proposals:[{...proposal(),assetId:'source:8'}]},job)[0].warnings.some(w=>w.code==='SOURCE_PREPARATION_REQUIRED'),false);
 assert.match(promptFor(job)[0].content,/содержимое фото, видео и аудио тебе не передано/);
 assert.match(promptFor(job)[0].content,/Не утверждай, что просмотрел/);
});
test('генерация частями после сбоя не вызывает модель для уже сохранённой части',async t=>{
 const f=fixture(t),old=f.jobs.claim();f.jobs.reject(old.id,old.token);
 const snapshot={...f.snapshot,monthInputs:{...f.snapshot.monthInputs,perDay:{telegram:2}},requested:2};
 const job=f.jobs.enqueue('alpha',{clientRequestId:'chunked_job',month:'2026-10',snapshot});
 let calls=[];
 const model=provider(async input=>{
  calls.push(input.partIndex);
  if(calls.length===2)throw Object.assign(Error('Synthetic outage'),{code:'PROVIDER_UNAVAILABLE'});
  const context=JSON.parse(input.messages[1].content);
  assert.equal(context.slots.length,1);
  if(input.partIndex===1)assert.equal(context.previousTopics[0].topic,'Идея 0');
  return {proposals:[{...proposal(),topic:'Идея '+input.partIndex}]};
 });
 await createContentPlanWorker({jobs:f.jobs,provider:model,authorize:async()=>true,chunkSize:1}).runOne();
 assert.equal(f.jobs.get('alpha',job.id).job.status,'queued');
 assert.equal(f.db.prepare('SELECT count(*) n FROM content_plan_parts').get().n,1);
 f.db.prepare('UPDATE content_plan_jobs SET available_at=0 WHERE id=?').run(job.id);
 await createContentPlanWorker({jobs:f.jobs,provider:model,authorize:async()=>true,chunkSize:1}).runOne();
 const result=f.jobs.get('alpha',job.id).job;
 assert.equal(result.status,'succeeded');assert.deepEqual(calls,[0,1,1]);
 assert.equal(new Set(result.proposals.map(p=>p.ideaId)).size,2);
});
test('adapter использует переданный бюджетируемый runtime и сохраняет его model, а не выдуманную модель',async t=>{
 const f=fixture(t);let request,options;
 const adapter=require('./content-plan-provider').createContentPlanProvider({reply:async(payload,opts)=>{
  request=JSON.parse(payload);options=opts;return {text:JSON.stringify({proposals:[proposal()]}),model:'synthetic-api-reported'};
 }});
 await createContentPlanWorker({jobs:f.jobs,provider:adapter,authorize:async()=>true,chunkSize:1}).runOne();
 assert.equal(request.companyCode,'alpha');assert.equal(request.maxOutputTokens,1200);assert.equal(options.maxAttempts,2);
 assert.equal(f.jobs.get('alpha',f.job.id).job.executor.model,'synthetic-api-reported');
});
test('остановка прерывает ожидание модели; поздний ответ не завершает задачу и новые тики запрещены',async t=>{
 const f=fixture(t);let release,signal;
 const worker=createContentPlanWorker({jobs:f.jobs,authorize:async()=>true,provider:provider(arg=>{
  signal=arg.signal;return new Promise(resolve=>release=resolve);
 })});
 const running=worker.runOne();await new Promise(r=>setImmediate(r));await worker.stop();await running;
 assert.equal(signal.aborted,true);assert.equal(f.jobs.get('alpha',f.job.id).job.status,'queued');
 release({proposals:[proposal()]});await new Promise(r=>setImmediate(r));
 assert.equal(f.jobs.get('alpha',f.job.id).job.coverage.proposed,0);assert.equal(await worker.runOne(),false);
});
test('полный месяц по семи площадкам сохраняет более 300 КБ проверенных предложений',async t=>{
 const f=fixture(t),previous=f.jobs.claim();f.jobs.reject(previous.id,previous.token);
 const platforms=Object.keys(require('./autoposting').CAPTION_PLATFORMS);
 const monthInputs={platforms,perDay:Object.fromEntries(platforms.map(p=>[p,3])),excludedDays:[]};
 const snapshot={...f.snapshot,monthInputs,requested:platforms.length*31*3};
 const next=f.jobs.enqueue('alpha',{clientRequestId:'large_month',month:'2026-10',snapshot});
 const proposals=slotsFor('2026-10',monthInputs).map((slot,i)=>({...proposal(),...slot,
  topic:'Идея '+i,format:slot.platform==='youtube_shorts'?'reel':'post',text:'',mentorNote:'Подготовьте материал. '.repeat(70)}));
 assert.ok(Buffer.byteLength(JSON.stringify(proposals))>300000);
 await createContentPlanWorker({jobs:f.jobs,authorize:async()=>true,provider:provider(async()=>({proposals}))}).runOne();
 const result=f.jobs.get('alpha',next.id).job;
 assert.equal(result.status,'succeeded');assert.equal(result.proposals.length,snapshot.requested);
});
test('полный цикл: фиксированный контекст, результат только предложения, явная QA-модель',async t=>{
 const f=fixture(t);let received;
 const worker=createContentPlanWorker({jobs:f.jobs,authorize:async()=>true,provider:provider(async input=>{received=input;return {proposals:[proposal()]}})});
 assert.equal(await worker.runOne(),true);const job=f.jobs.get('alpha',f.job.id).job;
 assert.equal(job.status,'succeeded');assert.equal(job.executor.kind,'test');assert.equal(job.coverage.proposed,1);
 assert.deepEqual(job.inputs,{briefRevision:1,monthRevision:3,profileRevision:2});assert.ok(job.startedAt);assert.ok(job.finishedAt);
 assert.equal(job.proposals[0].warnings[0].code,'REVIEW_REQUIRED');assert.match(received.messages[1].content,/Asia\/Irkutsk/);
 assert.equal(await worker.runOne(),false);
});
test('неподключённый исполнитель и отказ бюджета не вызывают модель',async t=>{
 for(const noProvider of [true,false]){
  const f=fixture(t);let calls=0;
  await createContentPlanWorker({jobs:f.jobs,provider:noProvider?null:provider(async()=>{calls++}),authorize:async()=>false}).runOne();
  assert.equal(calls,0);assert.equal(f.jobs.get('alpha',f.job.id).job.errorCode,noProvider?'PROVIDER_NOT_CONFIGURED':'BUDGET_EXCEEDED');
 }
});
test('неправильный объём, даты, площадки, формат, чужой исходник и дубли отклоняются',t=>{
 const f=fixture(t),job={id:f.job.id,month:'2026-10',snapshot:f.snapshot};
 for(const bad of [{proposals:[]},{proposals:[{...proposal(),date:'2026-10-02'}]},
  {proposals:[{...proposal(),platform:'vk'}]},{proposals:[{...proposal(),format:'madeup'}]},
  {proposals:[{...proposal(),assetId:'other-company'}]}, {proposals:[{...proposal(),text:'x'.repeat(1025)}]}])
  assert.throws(()=>validateProposals(bad,job),e=>e.code==='INVALID_RESULT');
 job.snapshot.monthInputs.perDay.telegram=2;
 assert.throws(()=>validateProposals({proposals:[proposal(),proposal()]},job),e=>e.code==='INVALID_RESULT');
 assert.equal(slotsFor(job.month,job.snapshot.monthInputs).length,2);
});
test('таймаут освобождает worker, задача остаётся в очереди для ограниченного повтора',async t=>{
 const f=fixture(t);let signal;
 await createContentPlanWorker({jobs:f.jobs,authorize:async()=>true,timeoutMs:10,provider:provider(async arg=>{signal=arg.signal;return new Promise(()=>{})})}).runOne();
 const result=f.jobs.get('alpha',f.job.id).job;assert.equal(result.status,'queued');assert.equal(result.errorCode,'PROVIDER_UNAVAILABLE');assert.equal(signal.aborted,true);
});
test('параллельные тики одного worker не делают второй вызов; невалидный JSON не становится успехом',async t=>{
 const f=fixture(t);let release,calls=0;
 const worker=createContentPlanWorker({jobs:f.jobs,authorize:async()=>true,provider:provider(()=>{calls++;return new Promise(resolve=>release=resolve)})});
 const first=worker.runOne();await new Promise(r=>setImmediate(r));assert.equal(await worker.runOne(),false);
 release('not json');await first;assert.equal(calls,1);assert.equal(f.jobs.get('alpha',f.job.id).job.errorCode,'INVALID_RESULT');
});

test('результат обязан соблюдать выбранные форматы и цели ОВП, независимо по каждому набору',t=>{
 const f=fixture(t),job={id:f.job.id,month:'2026-10',snapshot:{...f.snapshot,
  monthInputs:{...f.snapshot.monthInputs,formats:['carousel','post'],roles:['sale']}}};
 assert.equal(validateProposals({proposals:[{...proposal(),role:'sale'}]},job)[0].role,'sale');
 assert.equal(validateProposals({proposals:[{...proposal(),format:'carousel',role:'sale'}]},job)[0].format,'carousel');
 for(const row of [{...proposal(),role:'sale',format:'reel'},{...proposal(),role:'reach'}])
  assert.throws(()=>validateProposals({proposals:[row]},job),e=>e.code==='INVALID_RESULT');
 job.snapshot.monthInputs.formats=[];
 assert.equal(validateProposals({proposals:[{...proposal(),format:'reel',role:'sale'}]},job)[0].format,'reel');
 assert.throws(()=>validateProposals({proposals:[proposal()]},job),e=>e.code==='INVALID_RESULT','сброс форматов не сбрасывает ОВП');
 job.snapshot.monthInputs.formats=['post'];job.snapshot.monthInputs.roles=[];
 assert.equal(validateProposals({proposals:[{...proposal(),role:'affection'}]},job)[0].role,'affection');
 assert.throws(()=>validateProposals({proposals:[{...proposal(),format:'story'}]},job),e=>e.code==='INVALID_RESULT','сброс ОВП не сбрасывает форматы');
});

test('старые снимки и пустые списки допускают прежние форматы/ОВП, но сохраняют правило Shorts',t=>{
 const f=fixture(t),job={id:f.job.id,month:'2026-10',snapshot:f.snapshot};
 for(const choices of [{},{formats:[],roles:[]}]){
  job.snapshot.monthInputs={...f.snapshot.monthInputs,...choices};
  for(const [format,role]of [['post','reach'],['story','affection'],['reel','sale'],['carousel','reach']])
   assert.equal(validateProposals({proposals:[{...proposal(),format,role}]},job)[0].format,format);
  const shortJob={...job,snapshot:{...job.snapshot,monthInputs:{...job.snapshot.monthInputs,platforms:['youtube_shorts'],perDay:{youtube_shorts:1}}}};
  assert.throws(()=>validateProposals({proposals:[{...proposal(),platform:'youtube_shorts',format:'post'}]},shortJob),e=>e.code==='INVALID_RESULT');
  assert.equal(validateProposals({proposals:[{...proposal(),platform:'youtube_shorts',format:'reel'}]},shortJob)[0].format,'reel');
 }
});

test('prompt передаёт ограничения снимка и явно требует их соблюдать без процентов ОВП',t=>{
 const f=fixture(t),job={id:f.job.id,month:'2026-10',snapshot:{...f.snapshot,
  monthInputs:{...f.snapshot.monthInputs,formats:['post'],roles:['affection']}}};
 const before=JSON.stringify(job.snapshot),messages=promptFor(job),context=JSON.parse(messages[1].content);
 assert.deepEqual(context.monthInputs.formats,['post']);assert.deepEqual(context.monthInputs.roles,['affection']);
 assert.match(messages[0].content,/используй только выбранные форматы или цели ОВП/);
 assert.match(messages[0].content,/Пустой список или отсутствующее поле/);assert.match(messages[0].content,/обязательных процентов ОВП нет/);
 assert.equal(JSON.stringify(job.snapshot),before);
});

test('worker отклоняет ответ вне выбранного набора, не сохраняя предложение как успех',async t=>{
 const f=fixture(t),old=f.jobs.claim();f.jobs.reject(old.id,old.token);
 const snapshot={...f.snapshot,monthInputs:{...f.snapshot.monthInputs,formats:['story'],roles:['sale']}};
 const next=f.jobs.enqueue('alpha',{clientRequestId:'disallowed_choices_01',month:'2026-10',snapshot});
 let calls=0;
 const worker=createContentPlanWorker({jobs:f.jobs,provider:provider(async input=>{
  calls++;assert.deepEqual(JSON.parse(input.messages[1].content).monthInputs.formats,['story']);return {proposals:[proposal()]};
 }),authorize:async()=>true});
 await worker.runOne();await worker.stop();
 const result=f.jobs.get('alpha',next.id).job;
 assert.equal(calls,1);assert.equal(result.status,'failed');assert.equal(result.errorCode,'INVALID_RESULT');
 assert.equal(result.coverage.proposed,0);
});

const operationalWorkflow=()=>({companyCode:'alpha',revision:1,configured:true,fields:{releaseMode:'scheduled',hours:['09:00','18:30'],preparationDays:3,reviewDays:2}});
test('workflow manual/scheduled/unset передаются как пожелания без назначения времени и исполнителя',async t=>{
 for(const mode of ['manual','scheduled','unset']){
  const f=fixture(t),old=f.jobs.claim();f.jobs.reject(old.id,old.token);
  const workflow=operationalWorkflow();
  if(mode==='unset'){workflow.revision=0;workflow.configured=false;workflow.fields={releaseMode:'manual',hours:[],preparationDays:0,reviewDays:0};}
  else workflow.fields.releaseMode=mode;
  const snapshot={...f.snapshot,inputs:{...f.snapshot.inputs,workflowRevision:workflow.revision},workflow};
  const next=f.jobs.enqueue('alpha',{clientRequestId:'workflow_mode_'+mode,month:'2026-10',snapshot});
  const worker=createContentPlanWorker({jobs:f.jobs,authorize:async()=>true,provider:provider(async input=>{
   assert.deepEqual(JSON.parse(input.messages[1].content).workflow,workflow);
   assert.doesNotMatch(JSON.stringify(input.messages),/publisherName|actorName|assigneeName/);
   assert.match(input.messages[0].content,/не являются назначенным расписанием/);
   assert.match(input.messages[0].content,/configured=false/);
   return {proposals:[proposal()]};
  })});
  await worker.runOne();await worker.stop();
  const result=f.jobs.get('alpha',next.id).job;assert.equal(result.status,'succeeded');
  assert.equal(Object.hasOwn(result.proposals[0],'scheduledAt'),false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='autoposting_posts'").get().n,0);
 }
});
test('некорректный queue workflow отклоняется до бюджета/API: scope, лишние поля, типы, revision reference',async t=>{
 const mutations=[
  snapshot=>{snapshot.workflow.companyCode='beta';},snapshot=>{snapshot.workflow.actorName='PRIVATE';},
  snapshot=>{snapshot.workflow.fields.publisherName='PRIVATE';},snapshot=>{snapshot.workflow.fields.extra=true;},
  snapshot=>{snapshot.workflow.fields.releaseMode='automatic';},snapshot=>{snapshot.workflow.fields.hours=['9:00'];},
  snapshot=>{snapshot.workflow.fields.hours=['09:00','09:00'];},snapshot=>{snapshot.workflow.fields.preparationDays='3';},
  snapshot=>{snapshot.workflow.fields.reviewDays=31;},snapshot=>{snapshot.workflow.revision='1';},
  snapshot=>{snapshot.workflow.configured='true';},snapshot=>{snapshot.workflow.configured=false;},
  snapshot=>{delete snapshot.workflow.fields.hours;},snapshot=>{snapshot.inputs.workflowRevision=2;},
  snapshot=>{delete snapshot.inputs.workflowRevision;},snapshot=>{snapshot.workflow=null;},
 ];
 for(const [index,mutate]of mutations.entries()){
  const f=fixture(t),old=f.jobs.claim();f.jobs.reject(old.id,old.token);
  const snapshot={...f.snapshot,inputs:{...f.snapshot.inputs,workflowRevision:1},workflow:operationalWorkflow()};mutate(snapshot);
  const next=f.jobs.enqueue('alpha',{clientRequestId:'workflow_invalid_'+index,month:'2026-10',snapshot});
  assert.throws(()=>promptFor({id:next.id,companyCode:'alpha',month:'2026-10',snapshot}),e=>e.code==='INVALID_RESULT');
  let auth=0,calls=0;
  const worker=createContentPlanWorker({jobs:f.jobs,authorize:async()=>{auth++;return true;},provider:provider(async()=>{calls++;return {proposals:[proposal()]};})});
  await worker.runOne();await worker.stop();
  assert.equal(auth,0);assert.equal(calls,0);assert.equal(f.jobs.get('alpha',next.id).job.errorCode,'INVALID_RESULT');
 }
});
test('старый job без workflow по-прежнему генерируется без выдуманных настроек',async t=>{
 const f=fixture(t);let calls=0;
 const worker=createContentPlanWorker({jobs:f.jobs,authorize:async()=>true,provider:provider(async input=>{
  calls++;assert.equal(Object.hasOwn(JSON.parse(input.messages[1].content),'workflow'),false);return {proposals:[proposal()]};
 })});
 await worker.runOne();await worker.stop();
 assert.equal(calls,1);assert.equal(f.jobs.get('alpha',f.job.id).job.status,'succeeded');
});
