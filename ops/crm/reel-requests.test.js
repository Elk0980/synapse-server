'use strict';
// specs/231-lena-materials-requests: подпись, отметка, история; просьбы агенту со статусами; «живой монтаж». Данные синтетические.
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createReelMaterials,validateEdl}=require('./reel-materials');
const asset=(code,n='a')=>`https://synapse.synapsebusiness.ru/content/publishing-assets/${code}/${n.repeat(32)}.mp4`;

function fixture({approvalRequired=false}={}){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code) VALUES(1,'alpha'),(2,'beta');
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT,updated_at TEXT,is_deleted INTEGER DEFAULT 0,title TEXT,description TEXT,company_code TEXT,
      assignee_role TEXT,assignee_name TEXT,status TEXT,priority TEXT DEFAULT 'normal',due_date TEXT DEFAULT '',source TEXT,source_ref TEXT,source_author TEXT,created_by TEXT);`);
  const posts=new Map(),created=[];
  const autoposting={list:()=>({posts:[]}),
    get:(id,code)=>{const post=posts.get(id);if(!post||post.code!==code)throw Object.assign(Error('nf'),{status:404});return post;},
    create:(code,body,actorId)=>{created.push({code,body,actorId});
      const post={id:500+created.length,code,title:body.title,status:'draft',platformIds:body.platformIds,mediaUrls:body.mediaUrls,approvalRequired,
        approval:{approved:false},platformApprovals:approvalRequired?body.platformIds.map(platformId=>({platformId,approved:false})):[]};
      posts.set(post.id,post);return post;}};
  const materials=createReelMaterials(db,{autoposting,information:{get:()=>({revision:3})}});
  const reel=materials.create('alpha',{title:'Ролик А',releaseDate:'2026-11-20',platforms:['instagram','vk'],mediaUrl:asset('alpha'),durationMs:10000},editor);
  return {db,materials,created,posts,reel};
}
const editor={userId:7,userName:'Редактор',role:'editor'};
const other={userId:8,userName:'Другой',role:'editor'};
const tasks=f=>f.db.prepare('SELECT * FROM tasks ORDER BY id').all();

test('Подпись и отметка: сохраняются, история хранит кто, когда и что; чужая компания не видит ролик',()=>{
  const f=fixture();
  assert.equal(f.reel.caption,'');assert.equal(f.reel.decision,'');assert.deepEqual(f.reel.history,[]);assert.deepEqual(f.reel.requests,[]);
  const first=f.materials.update('alpha',f.reel.id,{caption:'  Новая подпись  ',decision:'redo',decisionComment:'Затянуто начало'},editor);
  assert.equal(first.caption,'Новая подпись');assert.equal(first.decision,'redo');assert.equal(first.decisionLabel,'переделать');assert.equal(first.decisionComment,'Затянуто начало');
  assert.deepEqual(first.history.map(e=>[e.field,e.before,e.after,e.authorName]).sort(),[['caption','','Новая подпись','Редактор'],['decision','','redo','Редактор']]);
  assert.equal(first.history.find(e=>e.field==='decision').comment,'Затянуто начало');
  assert.ok(first.history.every(e=>!Number.isNaN(Date.parse(e.at))));
  const second=f.materials.update('alpha',f.reel.id,{title:'Ролик Б',decision:'take',decisionComment:''},other);
  assert.equal(second.title,'Ролик Б');assert.equal(second.caption,'Новая подпись','подпись не тронута частичной правкой');
  assert.deepEqual(second.history.slice(0,2).map(e=>[e.field,e.before,e.after,e.authorName]).sort(),[['decision','redo','take','Другой'],['title','Ролик А','Ролик Б','Другой']]);
  assert.equal(f.materials.update('alpha',f.reel.id,{title:'Ролик Б'},editor).history.length,4,'без изменений история не растёт');
  assert.equal(f.materials.list('alpha').reels[0].decision,'take');assert.equal(f.materials.list('alpha').reels[0].caption,'Новая подпись');
  for(const bad of [{decision:'maybe'},{decision:'',decisionComment:'без решения'},{caption:'я'.repeat(4001)},{decision:1},{extra:1}])
    assert.throws(()=>f.materials.update('alpha',f.reel.id,bad,editor),{status:400},JSON.stringify(bad));
  assert.throws(()=>f.materials.update('beta',f.reel.id,{caption:'чужое'},editor),{status:404});
  assert.throws(()=>f.materials.get('beta',f.reel.id),{status:404});
});

test('Своя подпись уходит в черновик публикации; длинная подпись не подставляется в площадку с меньшим лимитом',()=>{
  const f=fixture();
  f.materials.createPublication('alpha',f.reel.id,{version:1,platformIds:['vk']},editor);
  assert.equal(f.created[0].body.text,undefined,'без подписи текст не подставляется — прежнее поведение');
  f.materials.update('alpha',f.reel.id,{caption:'Подпись ролика'},editor);
  const made=f.materials.createPublication('alpha',f.reel.id,{version:1,platformIds:['instagram','vk']},editor);
  assert.equal(f.created[1].body.text,'Подпись ролика');assert.equal(made.planText.source,'material');assert.match(f.created[1].body.origin,/текст из подписи ролика/);
  const long='д'.repeat(3000);f.materials.update('alpha',f.reel.id,{caption:long},editor);
  const limited=f.materials.createPublication('alpha',f.reel.id,{version:1,platformIds:['instagram','vk']},editor);
  assert.equal(f.created[2].body.text,undefined);assert.deepEqual(f.created[2].body.captions,{vk:long});
  assert.deepEqual(limited.planText.warnings.map(w=>[w.platform,w.code]),[['instagram','CAPTION_TOO_LONG']]);
});

test('«Переделать»: одна правка монтажа и одна задача доски; статус идёт за правкой до «готово, посмотрите»',()=>{
  const f=fixture();
  assert.throws(()=>f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'r0',kind:'redo'},editor),{status:400},'текст обязателен');
  const body={clientRequestId:'r1',kind:'redo',text:'Убрать паузу в начале',startMs:1000,endMs:2500};
  const made=f.materials.createRequest('alpha',f.reel.id,body,editor),again=f.materials.createRequest('alpha',f.reel.id,body,editor);
  assert.equal(made.duplicate,false);assert.equal(again.duplicate,true);assert.equal(again.request.id,made.request.id);
  assert.equal(made.request.status,'accepted');assert.equal(made.request.statusLabel,'принято');assert.equal(made.request.kindLabel,'Переделать');
  assert.equal(tasks(f).length,1);assert.equal(tasks(f)[0].company_code,'alpha');assert.equal(tasks(f)[0].assignee_name,'Claude · монтаж');
  assert.equal(made.reel.edits.length,1);assert.equal(made.reel.edits[0].id,made.request.editId);assert.equal(made.reel.edits[0].startMs,1000);
  assert.equal(made.reel.openRequests,1);assert.equal(f.materials.list('alpha').reels[0].openRequests,1);
  assert.equal(f.materials.requestQueue('alpha').requests.length,1);assert.deepEqual(f.materials.requestQueue('beta').requests,[]);
  f.materials.claim('alpha',made.request.editId);
  assert.equal(f.materials.get('alpha',f.reel.id).requests[0].status,'in_progress');
  f.materials.addVersion('alpha',f.reel.id,{mediaUrl:asset('alpha','b'),durationMs:9000,editId:made.request.editId});
  const done=f.materials.get('alpha',f.reel.id).requests[0];
  assert.equal(done.status,'ready');assert.equal(done.statusLabel,'готово, посмотрите');assert.match(done.reply,/версия v2/);
  assert.deepEqual(done.events.map(e=>e.status),['accepted','in_progress','ready']);
  assert.equal(f.materials.get('alpha',f.reel.id).requests[0].events.length,3,'повторное чтение не плодит события');
  assert.deepEqual(f.materials.requestQueue('alpha').requests,[],'готовая просьба уходит из очереди агента');
  const whole=f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'r2',kind:'redo',text:'Слишком длинно'},editor);
  assert.equal(whole.request.version,2);assert.equal(whole.request.startMs,null);
  assert.match(whole.reel.edits.at(-1).comment,/^Весь ролик\. Слишком длинно$/);assert.equal(whole.reel.edits.at(-1).endMs,9000);
  assert.throws(()=>f.materials.cancelRequest('alpha',f.reel.id,whole.request.id,other),{status:403},'чужую просьбу не отменить');
  const cancelled=f.materials.cancelRequest('alpha',f.reel.id,whole.request.id,editor);
  assert.equal(cancelled.requests[1].status,'rejected');assert.equal(cancelled.edits.at(-1).status,'cancelled');
  assert.throws(()=>f.materials.cancelRequest('alpha',f.reel.id,whole.request.id,editor),{status:409});
  assert.throws(()=>f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'r3',kind:'redo',text:'x',date:'2026-11-21'},editor),{status:400},'дата не относится к «Переделать»');
});

test('«Опубликовать»: только черновик автопостинга; без согласования — «ждёт владельца»; «опубликовано» только по факту',()=>{
  const f=fixture({approvalRequired:true});
  const made=f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'p1',kind:'publish',platformIds:['instagram']},editor);
  assert.equal(f.created.length,1);assert.deepEqual(f.created[0].body.platformIds,['instagram']);
  assert.equal(made.request.status,'waiting_owner');assert.equal(made.request.statusLabel,'ждёт владельца');
  assert.match(made.request.reply,/должен согласовать владелец/);assert.match(made.request.reply,/ничего не отправлено/);assert.equal(made.request.postId,501);
  assert.equal(tasks(f).length,0,'публикация идёт своим согласованием, отдельной задачи нет');
  assert.throws(()=>f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'p2',kind:'publish'},editor),error=>error.status===409&&error.details.code==='REQUEST_EXISTS');
  assert.equal(f.created.length,1,'второго черновика нет');
  assert.throws(()=>f.materials.replyRequest('alpha',made.request.id,{status:'published',reply:'Опубликовал'},'агент'),{status:400},'агент не объявляет «опубликовано»');
  f.posts.get(501).approval.approved=true;
  assert.equal(f.materials.get('alpha',f.reel.id).requests[0].status,'ready');
  f.posts.get(501).status='scheduled';
  assert.equal(f.materials.get('alpha',f.reel.id).requests[0].status,'in_progress');
  f.posts.get(501).status='published';
  const published=f.materials.get('alpha',f.reel.id);
  assert.equal(published.requests[0].status,'published');assert.equal(published.openRequests,0);
  assert.throws(()=>f.materials.replyRequest('alpha',made.request.id,{status:'ready',reply:'ещё раз'},'агент'),{status:409});
  const free=fixture(),direct=free.materials.createRequest('alpha',free.reel.id,{clientRequestId:'p1',kind:'publish'},editor);
  assert.equal(direct.request.status,'ready');assert.match(direct.request.reply,/Черновик публикации №501 создан/);
  free.posts.get(501).status='cancelled';
  assert.equal(free.materials.get('alpha',free.reel.id).requests[0].status,'rejected');
});

test('Перенос даты, замена текста, убрать из плана, сообщение: задача доски и ответ агента простым языком',()=>{
  const f=fixture();
  assert.throws(()=>f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'d0',kind:'reschedule'},editor),{status:400},'нужна дата');
  assert.throws(()=>f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'d0',kind:'reschedule',date:'завтра'},editor),{status:400});
  assert.throws(()=>f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'d0',kind:'replace_text'},editor),{status:400});
  assert.throws(()=>f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'d0',kind:'delete_everything',text:'x'},editor),{status:400});
  const move=f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'d1',kind:'reschedule',date:'2026-11-25',text:'После праздника'},editor);
  const swap=f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'d2',kind:'replace_text',text:'Сделать короче'},editor);
  const drop=f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'d3',kind:'remove_from_plan'},editor);
  const note=f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'d4',kind:'message',text:'Когда будет готово?'},editor);
  assert.equal(move.request.date,'2026-11-25');assert.equal(tasks(f).length,4);
  assert.ok(tasks(f).every(task=>task.company_code==='alpha'&&task.status==='inbox'&&/^reel-request:\d+$/.test(task.source_ref)));
  assert.match(tasks(f)[0].description,/новая дата: 2026-11-25/);
  assert.equal(f.materials.requestQueue().requests.length,4);
  assert.throws(()=>f.materials.replyRequest('beta',move.request.id,{status:'ready',reply:'Перенёс'},'агент'),{status:404},'чужая компания не отвечает на просьбу');
  assert.throws(()=>f.materials.replyRequest('alpha',move.request.id,{status:'ready',reply:''},'агент'),{status:400},'ответ обязателен');
  assert.throws(()=>f.materials.replyRequest('alpha',move.request.id,{status:'done',reply:'x'},'агент'),{status:400});
  assert.equal(f.materials.replyRequest('alpha',move.request.id,{status:'in_progress',reply:'Смотрю план на эту неделю.'},'Агент А').status,'in_progress');
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(move.request.taskId).status,'in_progress');
  const ready=f.materials.replyRequest('alpha',move.request.id,{status:'ready',reply:'Перенёс на 25 ноября. Посмотрите.'},'Агент А');
  assert.equal(ready.status,'ready');assert.equal(ready.reply,'Перенёс на 25 ноября. Посмотрите.');assert.equal(ready.repliedBy,'Агент А');
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(move.request.taskId).status,'done');
  f.materials.replyRequest('alpha',swap.request.id,{status:'waiting_owner',reply:'Новый текст меняет цену — нужно решение владельца.'},'Агент А');
  f.materials.replyRequest('alpha',drop.request.id,{status:'rejected',reply:'Ролик уже опубликован, из плана его не убрать.'},'Агент А');
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(drop.request.taskId).status,'cancelled');
  assert.throws(()=>f.materials.replyRequest('alpha',drop.request.id,{status:'ready',reply:'x'},'агент'),{status:409});
  const card=f.materials.get('alpha',f.reel.id);
  assert.deepEqual(card.requests.map(r=>r.status),['ready','waiting_owner','rejected','accepted']);assert.equal(card.openRequests,3);
  assert.deepEqual(f.materials.requestQueue('alpha').requests.map(r=>r.id),[swap.request.id,note.request.id]);
  const log=f.materials.hughLog('alpha',7).entries;
  assert.ok(log.some(e=>e.key===`reel-request:${move.request.id}:request`&&e.from==='user'));
  assert.ok(log.some(e=>e.from==='hugh'&&/Перенёс на 25 ноября/.test(e.text)));
  assert.deepEqual(f.materials.hughLog('alpha',8).entries,[],'чужой автор не видит просьбы');
  assert.deepEqual(f.materials.hughLog('beta',7).entries,[]);
  f.materials.archive('alpha',f.reel.id,{},editor);
  assert.deepEqual(f.materials.requestQueue('alpha').requests,[],'просьбы убранного ролика агенту не выдаются');
  assert.throws(()=>f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'d9',kind:'message',text:'x'},editor),{status:409});
});

test('EDL: поле live необязательно, прежний EDL не меняется; дорожки обязаны соответствовать переключателям',()=>{
  const plain={v:1,video:[{inMs:0,outMs:4000}],audio:[],captions:[],coverMs:null,speed:1};
  assert.equal(Object.hasOwn(validateEdl(plain,10000),'live'),false);
  const live={v:1,video:[{inMs:0,outMs:3000},{inMs:6000,outMs:10000}],audio:[{inMs:0,outMs:3000,gain:1,muted:false},{inMs:6000,outMs:10000,gain:1,muted:true}],captions:[],coverMs:null,speed:1,
    live:{segments:[{inMs:0,outMs:3000,enabled:true,sound:true},{inMs:3000,outMs:6000,enabled:false,sound:true},{inMs:6000,outMs:10000,enabled:true,sound:false,label:'Финал'}]}};
  assert.equal(validateEdl(live,10000).live.segments[2].label,'Финал');
  const swapped={...live,video:[live.video[1],live.video[0]]};
  const sound={...live,audio:[live.audio[0],{...live.audio[1],muted:false}]};
  const gap={...live,live:{segments:[live.live.segments[0],live.live.segments[2]]}};
  const junk={...live,live:{segments:live.live.segments,src:'x'}};
  for(const bad of [swapped,sound,gap,junk,{...live,live:{segments:[]}}])assert.throws(()=>validateEdl(bad,10000),{status:400});
});

test('«Живой монтаж»: отрезок выключается, звук убирается, порядок не меняется; правка уходит агенту как обычный EDL',()=>{
  const f=fixture();
  const segments=[{startMs:0,endMs:3000,label:'Вход'},{startMs:3000,endMs:6000},{startMs:6000,endMs:10000,label:'Финал'}];
  for(const bad of [[],[{startMs:500,endMs:3000}],[{startMs:0,endMs:3000},{startMs:4000,endMs:6000}],[{startMs:0,endMs:50}],[{startMs:0,endMs:20000}],[{startMs:0,endMs:3000,src:'x'}]])
    assert.throws(()=>f.materials.setSegments('alpha',f.reel.id,1,{segments:bad}),{status:400},JSON.stringify(bad));
  assert.throws(()=>f.materials.setSegments('beta',f.reel.id,1,{segments}),{status:404});
  assert.throws(()=>f.materials.setSegments('alpha',f.reel.id,9,{segments}),{status:404});
  assert.deepEqual(f.materials.setSegments('alpha',f.reel.id,1,{segments}).versions[0].segments,segments);
  const toggles=[{startMs:0,endMs:3000,enabled:true,sound:true},{startMs:3000,endMs:6000,enabled:false,sound:true},{startMs:6000,endMs:10000,enabled:true,sound:false}];
  const made=f.materials.liveEdit('alpha',f.reel.id,{clientRequestId:'l1',baseVersion:1,segments:toggles,comment:'Финал без голоса'},editor);
  assert.equal(made.edit.kind,'edl');
  assert.deepEqual(made.edit.edl.video,[{inMs:0,outMs:3000},{inMs:6000,outMs:10000}]);
  assert.deepEqual(made.edit.edl.audio,[{inMs:0,outMs:3000,gain:1,muted:false},{inMs:6000,outMs:10000,gain:1,muted:true}]);
  assert.equal(made.edit.edl.outputMs,7000);assert.equal(made.edit.edl.live.segments[1].enabled,false);assert.equal(made.edit.edl.live.segments[2].label,'Финал');
  assert.equal(made.edit.comment,'Живой монтаж; выключены отрезки: 2; без звука: 3. Финал без голоса');
  assert.equal(f.materials.liveEdit('alpha',f.reel.id,{clientRequestId:'l1',baseVersion:1,segments:toggles},editor).duplicate,true);
  assert.equal(f.materials.queue('alpha').edits[0].edl.live.segments.length,3);assert.equal(tasks(f).length,1);
  const shifted=toggles.map((item,index)=>index===1?{...item,endMs:5000}:item);
  const reordered=[toggles[2],toggles[1],toggles[0]];
  for(const [bad,why] of [[shifted,'чужие границы'],[reordered,'перестановка'],[toggles.slice(0,2),'не все отрезки'],
    [toggles.map(item=>({...item,enabled:false})),'всё выключено'],[toggles.map(item=>({...item,enabled:true,sound:true})),'ничего не изменено'],[toggles.map(item=>({...item,sound:'да'})),'не булево']])
    assert.throws(()=>f.materials.liveEdit('alpha',f.reel.id,{clientRequestId:'l-'+why,baseVersion:1,segments:bad},editor),{status:400},why);
  assert.throws(()=>f.materials.liveEdit('beta',f.reel.id,{clientRequestId:'l2',baseVersion:1,segments:toggles},editor),{status:404});
  /* Версия без отрезков от агента: границы задаёт человек, но только подряд и на весь ролик. */
  const v2=f.materials.addVersion('alpha',f.reel.id,{mediaUrl:asset('alpha','b'),durationMs:8000});
  assert.equal(Object.hasOwn(v2.version,'segments'),false);
  const own=[{startMs:0,endMs:5000,enabled:true,sound:false},{startMs:5000,endMs:8000,enabled:true,sound:true}];
  assert.deepEqual(f.materials.liveEdit('alpha',f.reel.id,{clientRequestId:'l3',baseVersion:2,segments:own},editor).edit.edl.audio.map(a=>a.muted),[true,false]);
  assert.throws(()=>f.materials.liveEdit('alpha',f.reel.id,{clientRequestId:'l4',baseVersion:2,segments:[{startMs:0,endMs:5000,enabled:true,sound:false}]},editor),{status:400},'не до конца ролика');
  const v3=f.materials.addVersion('alpha',f.reel.id,{mediaUrl:asset('alpha','c'),durationMs:6000,segments:[{startMs:0,endMs:2000},{startMs:2000,endMs:6000}]});
  assert.equal(v3.version.segments.length,2,'агент монтажа передаёт отрезки вместе с версией');
});

test('Ревью PR 634: удалённая публикация закрывает просьбу, отмена «Переделать» — одна запись, неверный тип версии — 400',()=>{
  const f=fixture();
  const made=f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'x1',kind:'publish'},editor);
  assert.throws(()=>f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'x2',kind:'publish'},editor),{status:409});
  f.posts.delete(made.request.postId);
  const gone=f.materials.get('alpha',f.reel.id);
  assert.equal(gone.requests[0].status,'rejected');assert.equal(gone.requests[0].reply,'Публикация удалена в «Постинге». Если нужно — попросите опубликовать ещё раз.');
  assert.equal(gone.openRequests,0);assert.equal(f.materials.list('alpha').reels[0].openRequests,0,'счётчик в ленте не висит');
  const again=f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'x3',kind:'publish'},editor);
  assert.equal(again.request.status,'ready','повторная просьба проходит');assert.equal(f.created.length,2);
  /* Другая ошибка чтения публикации просьбу не закрывает; карточка при этом открывается с прежним статусом. */
  const broken=f.posts.get(again.request.postId);f.posts.delete(again.request.postId);
  const boom=Object.assign(Error('сбой чтения'),{status:500});
  const failing=fixture(),first=failing.materials.createRequest('alpha',failing.reel.id,{clientRequestId:'y1',kind:'publish'},editor);
  failing.posts.set(first.request.postId,new Proxy({},{get(){throw boom;}}));
  assert.equal(failing.materials.get('alpha',failing.reel.id).requests.find(r=>r.id===first.request.id).status,'ready','карточка открывается при сбое');
  failing.posts.set(first.request.postId,broken);
  assert.equal(failing.db.prepare('SELECT status FROM reel_requests WHERE id=?').get(first.request.id).status,'ready','сбой не превратился в отклонение');
  /* Отмена «Переделать»: в истории просьбы одно отклонение — «Отменено автором.» */
  const redo=f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'x4',kind:'redo',text:'Короче'},editor);
  const cancelled=f.materials.cancelRequest('alpha',f.reel.id,redo.request.id,editor).requests.find(r=>r.id===redo.request.id);
  assert.deepEqual(cancelled.events.map(e=>[e.status,e.text]),[['accepted',''],['rejected','Отменено автором.']]);
  assert.equal(cancelled.reply,'Отменено автором.');
  assert.equal(f.db.prepare('SELECT status FROM reel_edits WHERE id=?').get(redo.request.editId).status,'cancelled');
  /* Версия не целым числом — 400, а не внутренняя ошибка. */
  for(const version of ['2',1.5,{},[],null,true,0])
    assert.throws(()=>f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'v-'+JSON.stringify(version),kind:'redo',text:'x',version},editor),{status:400},JSON.stringify(version));
  const toggles=[{startMs:0,endMs:10000,enabled:true,sound:false}];
  for(const baseVersion of ['1',1.5,{},[],null,undefined,0])
    assert.throws(()=>f.materials.liveEdit('alpha',f.reel.id,{clientRequestId:'lv',baseVersion,segments:toggles},editor),{status:400},JSON.stringify(baseVersion));
  assert.equal(f.materials.liveEdit('alpha',f.reel.id,{clientRequestId:'lv',baseVersion:1,segments:toggles},editor).edit.edl.audio[0].muted,true);
});
