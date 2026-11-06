'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const source = fs.readFileSync(__dirname + '/task-board.js','utf8');
const settle = async () => { for (let i=0;i<12;i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(role='owner', initial={view:'board'},setup) {
  const dom = new JSDOM('<main id="board"></main>',{url:'https://example.test/cabinet.html#tasks',runScripts:'outside-only'});
  const w=dom.window,d=w.document,calls=[],interceptors={};
  const milestones = {code:{state:'confirmed',evidence:'https://example.test/review',checkedAt:'2026-01-01T00:00:00Z'},connected:{state:'pending'},verified:{state:'pending'},accepted:{state:'pending'}};
  const task={id:1,title:'Собрать <макет>',description:'Описание <script>bad()</script>',company_code:'synapse-business',assignee_name:'Codex',reviewer_name:'Claude',status:'in_progress',due_date:'2026-12-01',priority:'high',product_id:3,product_name:'Кабинет',no_report:true,subtask_count:1,subtask_done:0,chat_url:'https://example.test/chat',parent_task_id:null,coordination:{revision:4,milestones,nextAction:'Проверить макет',blocker:'',links:[{kind:'link',label:'Чат старый',url:'javascript:alert(1)'}]},subtasks:[{id:2,title:'Подзадача',status:'planned'}],subtasks_pagination:{total:1},comments:[{id:5,author:'Claude',text:'Ссылка https://example.test/report',created_at:'2026-01-01T00:00:00Z'}],comments_pagination:{total:1}};
  let failUpdate=false,duplicates=false,replay=false,refreshCount=0;
  const ctx={identity:{role,userId:1,companies:[{id:'synapse-business',name:'Synapse'},{id:'alvi',name:'ALVI'}]},csrfOptions:(method,body)=>({method,body}),crmQuery:async(path,query,options)=>{
    const name=path.split('/').at(-1),args=options?.body || {};calls.push({name,args});
    if (interceptors[name]) return interceptors[name](args);
    if(name==='tasks_list'){refreshCount++;return {tasks:[task,{...task,id:9,title:'Продукт · Кабинет',product_placeholder:true}],pagination:{total:2}};}
    if(name==='products_list')return {products:[{id:3,company_code:'synapse-business',name:'Кабинет',slug:'kabinet'}],pagination:{total:1}};
    if(name==='agents_list')return {agents:[{name:'Codex',state:'work',chat:'https://example.test/agent',last_event:'Пишет интерфейс'}]};
    if(name==='task_get')return structuredClone(task);
    if(name==='task_update'){if(failUpdate)throw Error('Карточка изменена другим исполнителем');return {task};}
    if(name==='task_comment')return {comment:{id:6,author:args.author,text:args.text,created_at:'2026-01-01T01:00:00Z'}};
    if(name==='task_duplicates')return {possible_duplicates:duplicates?[task]:[],possible_product_duplicates:[]};
    if(name==='task_create')return replay?{created:false,task}:duplicates&&!args.force?{created:false,possible_duplicates:[task],possible_product_duplicates:[]}:{created:true,task};
    throw Error('Unexpected '+name);
  }};
  setup?.(w);w.eval(fs.readFileSync(__dirname+'/task-text.js','utf8'));
  w.eval(fs.readFileSync(__dirname+'/task-overview.js','utf8'));
  w.eval(source);
  const controller=w.SbTaskBoard.mount(d.getElementById('board'),ctx,initial);
  const input=(field,value)=>{field.value=value;field.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const submit=form=>form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  return {w,d,ctx,controller,calls,task,input,submit,intercept:(name,fn)=>{interceptors[name]=fn;},fail:()=>failUpdate=true,duplicate:()=>duplicates=true,replay:()=>replay=true,refreshCount:()=>refreshCount,close:()=>{controller?.destroy();w.close();}};
}
test('compact owner board contains every status, stage evidence markers and accessible legacy products',async()=>{
  const f=fixture();try{await settle();assert.equal(f.d.querySelectorAll('.tb-column').length,4);assert.equal(f.d.querySelectorAll('.tb-column [data-task-open]').length,1);assert.match(f.d.querySelector('.tb-task').textContent,/Собрать <макет>/);assert.equal(f.d.querySelector('макет'),null);assert.match(f.d.body.textContent,/Прежние продукты/);assert.equal(f.d.querySelectorAll('[data-task-open="9"]').length,1);assert.match(f.d.querySelector('.tb-task').textContent,/Нет отчёта/);assert.equal(f.d.querySelectorAll('.tb-task [data-state=confirmed]').length,2);assert.equal(f.calls.find(call=>call.name==='tasks_list').args.project,undefined);}finally{f.close();}
});
test('non-owner does not mount or request internal data',async()=>{
  const f=fixture('editor');try{await settle();assert.equal(f.controller,null);assert.equal(f.calls.length,0);assert.equal(f.d.querySelector('.tb-board'),null);}finally{f.close();}
});
test('project overview opens project plan and compact product filter',async()=>{
  const f=fixture('owner',{view:'projects'});try{await settle();assert.match(f.d.querySelector('.tb-project-card').textContent,/Сейчас: Собрать <макет>/);f.d.querySelector('.tb-project-card[data-project="synapse-business"]').click();assert.ok(f.d.querySelector('.tb-plan'));assert.equal(f.d.querySelector('[data-project="synapse-business"]').getAttribute('aria-pressed'),'true');f.d.querySelector('[data-product="3"]').click();assert.equal(f.d.querySelectorAll('.tb-plan-row').length,1);}finally{f.close();}
});
test('task sheet shows chat and safe clickable evidence, save conflicts retain plan and comment drafts',async()=>{
  const f=fixture();try{await settle();await f.controller.openTask(1);assert.equal(f.d.querySelector('.tb-chat-link').href,'https://example.test/chat');assert.equal(f.d.querySelector('script'),null);assert.equal(f.d.querySelector('a[href^="javascript:"]'),null);assert.ok(f.d.querySelector('a[href="https://example.test/review"]'));const form=f.d.querySelector('[data-plan-form]');f.input(form.elements.next_step,'Новый шаг');f.fail();f.submit(form);await settle();assert.match(form.querySelector('[data-plan-result]').textContent,/изменена/);assert.equal(form.elements.next_step.value,'Новый шаг');assert.equal(f.calls.find(call=>call.name==='task_update').args.revision,4);const comment=f.d.querySelector('[data-comment-form]');f.input(comment.elements.text,'Черновик');f.d.querySelector('[data-sheet-close]').click();await f.controller.openTask(1);assert.equal(f.d.querySelector('[data-plan-form]').elements.next_step.value,'Новый шаг');assert.equal(f.d.querySelector('[data-comment-form]').elements.text.value,'Черновик');}finally{f.close();}
});
test('comment is sent as Влад without changing plan or discarding draft before success',async()=>{
  const f=fixture();try{await settle();await f.controller.openTask(1);const form=f.d.querySelector('[data-comment-form]');f.input(form.elements.text,'Проверено');f.submit(form);await settle();const request=f.calls.find(call=>call.name==='task_comment');assert.equal(request.args.author,'Влад');assert.equal(form.elements.text.value,'');assert.match(f.d.querySelector('[data-comments]').textContent,/Проверено/);}finally{f.close();}
});
test('duplicate response requires explicit force and creates with the same idempotency reference',async()=>{
  const f=fixture();try{await settle();f.duplicate();f.d.querySelector('[data-create-task]').click();const form=f.d.querySelector('[data-create-form]');f.input(form.elements.title,'Собрать макет');form.elements.project.value='synapse-business';form.elements.project.dispatchEvent(new f.w.Event('change'));f.submit(form);await settle();assert.match(form.querySelector('[data-create-duplicates]').textContent,/Похожие задачи/);assert.equal(form.querySelector('[data-force-label]').hidden,false);const first=f.calls.find(call=>call.name==='task_create');assert.equal(first.args.force,undefined);form.elements.force.checked=true;form.elements.force.dispatchEvent(new f.w.Event('input',{bubbles:true}));f.submit(form);await settle();const requests=f.calls.filter(call=>call.name==='task_create');assert.equal(requests.length,2);assert.equal(requests[1].args.force,true);assert.equal(requests[0].args.client_ref,requests[1].args.client_ref);assert.equal(f.d.querySelector('[data-create-form]'),null);}finally{f.close();}
});
test('existing client_ref replay opens the actual task instead of blocking as duplicate',async()=>{
  const f=fixture();try{await settle();f.replay();f.d.querySelector('[data-create-task]').click();const form=f.d.querySelector('[data-create-form]');f.input(form.elements.title,'Создать');form.elements.project.value='synapse-business';f.submit(form);await settle();assert.equal(f.d.querySelector('[data-create-form]'),null);assert.match(f.d.querySelector('.tb-task-title').textContent,/Собрать/);}finally{f.close();}
});
test('refresh after page restoration preserves an open form and destroy remount restores its draft',async()=>{
  const f=fixture();try{await settle();await f.controller.openTask(1);const form=f.d.querySelector('[data-plan-form]');f.input(form.elements.next_step,'Сохранить при восстановлении');const before=f.refreshCount();f.w.dispatchEvent(new f.w.PageTransitionEvent('pageshow',{persisted:true}));await settle();assert.ok(f.refreshCount()>before);assert.equal(f.d.querySelector('[data-plan-form]'),form);assert.equal(form.elements.next_step.value,'Сохранить при восстановлении');f.controller.destroy();f.controller=f.w.SbTaskBoard.mount(f.d.getElementById('board'),f.ctx,{taskId:1});await settle();assert.equal(f.d.querySelector('[data-plan-form]').elements.next_step.value,'Сохранить при восстановлении');}finally{f.close();}
});
test('dragging a card updates existing task with its revision; status remains accessible by button',async()=>{
  const f=fixture();try{await settle();const card=f.d.querySelector('.tb-column [data-task-open]');card.dispatchEvent(new f.w.Event('dragstart',{bubbles:true}));f.d.querySelector('[data-drop-status=done]').dispatchEvent(new f.w.Event('drop',{bubbles:true,cancelable:true}));await settle();assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(call=>call.name==='task_update').args)),{task_id:1,status:'done',revision:4});await f.controller.openTask(1);f.d.querySelector('[data-detail-status=planned]').click();await settle();assert.equal(f.calls.filter(call=>call.name==='task_update').at(-1).args.status,'planned');}finally{f.close();}
});
test('lost creation response keeps draft and retries with the same client_ref to recover existing task',async()=>{
  const f=fixture();try{await settle();let first=true;f.intercept('task_create',async()=>{if(first){first=false;throw Error('Связь прервана');}return {created:false,task:f.task};});f.d.querySelector('[data-create-task]').click();const form=f.d.querySelector('[data-create-form]');f.input(form.elements.title,'Проверка восстановления');form.elements.project.value='synapse-business';f.submit(form);await settle();assert.equal(f.d.querySelector('[data-create-form]'),form);assert.equal(form.elements.title.value,'Проверка восстановления');f.submit(form);await settle();const requests=f.calls.filter(call=>call.name==='task_create');assert.equal(requests.length,2);assert.equal(requests[0].args.client_ref,requests[1].args.client_ref);assert.equal(f.d.querySelector('[data-create-form]'),null);assert.ok(f.d.querySelector('.tb-task-title'));}finally{f.close();}
});
test('late comment success cannot erase a newer draft after reopening the task',async()=>{
  const f=fixture();try{await settle();let finish;f.intercept('task_comment',()=>new Promise(resolve=>{finish=resolve;}));await f.controller.openTask(1);let form=f.d.querySelector('[data-comment-form]');f.input(form.elements.text,'Отправленное');f.submit(form);await settle();await f.controller.openTask(1);form=f.d.querySelector('[data-comment-form]');f.input(form.elements.text,'Новый черновик');finish({comment:{id:10,author:'Влад',text:'Отправленное',created_at:'2026-01-01T00:00:00Z'}});await settle();assert.equal(form.elements.text.value,'Новый черновик');assert.equal(JSON.parse(f.w.sessionStorage.getItem('sb-task-board:1:comment:1')).text,'Новый черновик');}finally{f.close();}
});
test('late plan and stage success preserve newer unsent versions',async()=>{
  const f=fixture();try{await settle();let finish;f.intercept('task_update',()=>new Promise(resolve=>{finish=resolve;}));await f.controller.openTask(1);let plan=f.d.querySelector('[data-plan-form]');f.input(plan.elements.next_step,'Отправленный шаг');f.submit(plan);await settle();await f.controller.openTask(1);plan=f.d.querySelector('[data-plan-form]');f.input(plan.elements.next_step,'Новый шаг');finish({task:f.task});await settle();assert.equal(JSON.parse(f.w.sessionStorage.getItem('sb-task-board:1:plan:1')).next_step,'Новый шаг');let stage=f.d.querySelector('[data-stage-form=verified]');f.input(stage.elements.evidence,'Отправленное основание');f.input(stage.elements.checked_at,'2026-01-01T00:00');f.submit(stage);await settle();await f.controller.openTask(1);stage=f.d.querySelector('[data-stage-form=verified]');f.input(stage.elements.evidence,'Новое основание');finish({task:f.task});await settle();assert.equal(JSON.parse(f.w.sessionStorage.getItem('sb-task-board:1:stage:1:verified')).evidence,'Новое основание');}finally{f.close();}
});
test('late successful creation preserves a newer creation draft with a fresh client_ref',async()=>{
  const f=fixture();try{await settle();let finish;f.intercept('task_create',()=>new Promise(resolve=>{finish=resolve;}));f.d.querySelector('[data-create-task]').click();let form=f.d.querySelector('[data-create-form]');f.input(form.elements.title,'Первая задача');form.elements.project.value='synapse-business';f.submit(form);await settle();const first=f.calls.find(call=>call.name==='task_create').args.client_ref;f.d.querySelector('[data-sheet-close]').click();f.d.querySelector('[data-create-task]').click();form=f.d.querySelector('[data-create-form]');f.input(form.elements.title,'Следующая задача');finish({created:true,task:f.task});await settle();assert.equal(form.elements.title.value,'Следующая задача');const saved=JSON.parse(f.w.sessionStorage.getItem('sb-task-board:1:create'));assert.equal(saved.title,'Следующая задача');assert.notEqual(saved.client_ref,first);f.submit(form);await settle();assert.equal(f.calls.filter(call=>call.name==='task_create').at(-1).args.client_ref,saved.client_ref);}finally{f.close();}
});
test('unassigned legacy tasks remain available in overview and separate project filter',async()=>{
  const f=fixture('owner',{view:'projects'});try{f.task.company_code='';await f.controller.render();const project=f.d.querySelector('.tb-project-card[data-project="__unassigned__"]');assert.ok(project);assert.match(project.textContent,/Без проекта/);project.click();assert.equal(f.d.querySelectorAll('.tb-plan-row').length,1);assert.equal(f.d.querySelector('[data-quick-task]'),null);f.d.querySelector('[data-create-task]').click();assert.equal(f.d.querySelector('option[value="__unassigned__"]'),null);}finally{f.close();}
});
test('board theme cycles independently of cabinet palette, persists and cleans up on leave',async()=>{
  const f=fixture();try{await settle();assert.equal(f.d.getElementById('board').dataset.tbTheme,'light');const click=()=>f.d.querySelector('[data-board-theme]').click();click();assert.equal(f.w.localStorage.getItem('sb-task-board:1:theme'),'light');click();assert.equal(f.d.getElementById('board').dataset.tbTheme,'dark');await f.controller.openTask(1);assert.equal(f.d.querySelector('.tb-sheet').dataset.tbTheme,'dark');f.controller.destroy();assert.equal(f.d.body.classList.contains('tb-owner-theme-dark'),false);f.controller=f.w.SbTaskBoard.mount(f.d.getElementById('board'),f.ctx);await settle();assert.equal(f.d.getElementById('board').dataset.tbTheme,'dark');}finally{f.close();}
});
test('edited draft after unknown creation outcome survives idempotent replay of the earlier task',async()=>{
  const f=fixture();try{
    await settle();let first=true;
    f.intercept('task_create',async()=>{if(first){first=false;throw Error('Ответ потерян после записи');}return {created:false,task:{...f.task,title:'Первая задача'}};});
    f.d.querySelector('[data-create-task]').click();let form=f.d.querySelector('[data-create-form]');
    f.input(form.elements.title,'Первая задача');form.elements.project.value='synapse-business';f.submit(form);await settle();
    const originalRef=f.calls.find(call=>call.name==='task_create').args.client_ref;
    // Закрытие и повторное открытие имитируют восстановление сохранённой формы.
    f.d.querySelector('[data-sheet-close]').click();f.d.querySelector('[data-create-task]').click();form=f.d.querySelector('[data-create-form]');
    f.input(form.elements.title,'Следующая задача');f.input(form.elements.description,'Новые подробности');f.submit(form);await settle();
    const calls=f.calls.filter(call=>call.name==='task_create');assert.equal(calls.length,2);assert.equal(calls[1].args.client_ref,originalRef);
    const draft=JSON.parse(f.w.sessionStorage.getItem('sb-task-board:1:create'));assert.equal(draft.title,'Следующая задача');assert.equal(draft.description,'Новые подробности');assert.notEqual(draft.client_ref,originalRef);
    assert.match(f.d.querySelector('[data-detail-result]').textContent,/ранее созданная задача/);assert.match(f.d.querySelector('[data-detail-result]').textContent,/сохранён в черновике/);
    f.d.querySelector('[data-sheet-close]').click();f.d.querySelector('[data-create-task]').click();form=f.d.querySelector('[data-create-form]');assert.equal(form.elements.title.value,'Следующая задача');assert.equal(f.calls.filter(call=>call.name==='task_create').length,2);
  }finally{f.close();}
});
test('comment pagination advances after local prepend and ignores overlap from concurrent comments',async()=>{
  const f=fixture();try{
    await settle();const item=id=>({id,author:'Влад',text:`Комментарий ${id}`,created_at:'2026-01-01T00:00:00Z'});
    f.intercept('task_get',async args=>({...f.task,comments:args.comments_offset?[item(4),item(3)]:[item(6),item(5),item(4)],comments_pagination:{total:6}}));
    f.intercept('task_comment',async()=>({comment:item(7)}));
    await f.controller.openTask(1);const form=f.d.querySelector('[data-comment-form]');f.input(form.elements.text,'Новый');f.submit(form);await settle();
    f.d.querySelector('[data-comments-more]').click();await settle();
    assert.equal(f.calls.filter(call=>call.name==='task_get').at(-1).args.comments_offset,4);
    assert.equal(f.d.querySelectorAll('[data-comment-id="4"]').length,1);assert.ok(f.d.querySelector('[data-comment-id="3"]'));
  }finally{f.close();}
});
test('upgrade imports a legacy comment only for the same user and task, then removes its exact old version after success',async()=>{
  const f=fixture();try{
    await settle();const own='sb-task:1:comment:synapse-business:1',otherProject='sb-task:1:comment:alvi:1',otherUser='sb-task:2:comment:synapse-business:1';
    f.w.sessionStorage.setItem(own,JSON.stringify({text:'Старый комментарий'}));f.w.sessionStorage.setItem(otherProject,JSON.stringify({text:'Другой проект'}));f.w.sessionStorage.setItem(otherUser,JSON.stringify({text:'Другой пользователь'}));
    await f.controller.openTask(1);const form=f.d.querySelector('[data-comment-form]');assert.equal(form.elements.text.value,'Старый комментарий');f.submit(form);await settle();
    assert.equal(f.calls.find(call=>call.name==='task_comment').args.text,'Старый комментарий');assert.equal(f.w.sessionStorage.getItem(own),null);assert.ok(f.w.sessionStorage.getItem(otherProject));assert.ok(f.w.sessionStorage.getItem(otherUser));
    await f.controller.openTask(1);assert.equal(f.d.querySelector('[data-comment-form]').elements.text.value,'');
  }finally{f.close();}
});
test('a newer board comment takes precedence and late legacy edits are never deleted',async()=>{
  const f=fixture();try{
    await settle();const old='sb-task:1:comment:synapse-business:1';f.w.sessionStorage.setItem(old,JSON.stringify({text:'Прежний'}));f.w.sessionStorage.setItem('sb-task-board:1:comment:1',JSON.stringify({text:'Новый'}));
    await f.controller.openTask(1);assert.equal(f.d.querySelector('[data-comment-form]').elements.text.value,'Новый');assert.equal(JSON.parse(f.w.sessionStorage.getItem(old)).text,'Прежний');
    f.w.sessionStorage.removeItem('sb-task-board:1:comment:1');await f.controller.openTask(1);let finish;f.intercept('task_comment',()=>new Promise(resolve=>{finish=resolve;}));const form=f.d.querySelector('[data-comment-form]');f.submit(form);await settle();
    const changed=JSON.stringify({text:'Изменено старым открытым сеансом'});f.w.sessionStorage.setItem(old,changed);finish({comment:{id:8,author:'Влад',text:'Прежний',created_at:'2026-01-01T00:00:00Z'}});await settle();assert.equal(f.w.sessionStorage.getItem(old),changed);
  }finally{f.close();}
});
test('upgrade restores scoped child creation fields, links and client_ref without touching other legacy drafts',async()=>{
  const f=fixture();try{
    await settle();f.ctx.selectedProjectId='synapse-business';
    const old='sb-task:1:create:synapse-business:1',other='sb-task:1:create:alvi:',root='sb-task:1:create:synapse-business:';
    const links=[{kind:'image',label:'Фото',url:'https://example.test/photo.jpg'},{kind:'video',label:'Видео',url:'https://example.test/video.mp4'}];
    f.w.sessionStorage.setItem(old,JSON.stringify({title:'Старая подзадача',description:'Подробности',companyCode:'synapse-business',assigneeName:'Исполнитель',reviewer:'Приёмщик',dueDate:'2026-12-02',priority:'high',status:'planned',client_ref:'legacy:child:1',links}));
    f.w.sessionStorage.setItem(other,JSON.stringify({title:'Чужой проект',companyCode:'alvi'}));f.w.sessionStorage.setItem(root,JSON.stringify({title:'Отдельный корневой черновик',companyCode:'synapse-business'}));
    await f.controller.openTask(1);f.d.querySelector('[data-add-subtask]').click();const form=f.d.querySelector('[data-create-form]');assert.equal(form.elements.title.value,'Старая подзадача');assert.equal(form.elements.executor.value,'Исполнитель');assert.equal(form.elements.reviewer.value,'Приёмщик');assert.equal(form.elements.due_date.value,'2026-12-02');assert.match(form.textContent,/Ссылки из черновика/);f.submit(form);await settle();
    const request=f.calls.find(call=>call.name==='task_create').args;assert.equal(request.client_ref,'legacy:child:1');assert.equal(request.parent_id,1);assert.equal(request.status,'planned');assert.deepEqual(JSON.parse(JSON.stringify(request.links)),links);assert.equal(f.w.sessionStorage.getItem(old),null);assert.ok(f.w.sessionStorage.getItem(other));assert.ok(f.w.sessionStorage.getItem(root));
    f.d.querySelector('[data-add-subtask]').click();assert.equal(f.d.querySelector('[data-create-form]').elements.title.value,'');
  }finally{f.close();}
});
test('new creation draft wins over legacy; inaccessible legacy project stays untouched',async()=>{
  const f=fixture();try{
    await settle();f.ctx.selectedProjectId='synapse-business';const old='sb-task:1:create:synapse-business:';f.w.sessionStorage.setItem(old,JSON.stringify({title:'Прежний',companyCode:'synapse-business',client_ref:'old:ref'}));f.w.sessionStorage.setItem('sb-task-board:1:create',JSON.stringify({title:'Новый',project:'alvi',client_ref:'new:ref'}));
    f.d.querySelector('[data-create-task]').click();let form=f.d.querySelector('[data-create-form]');assert.equal(form.elements.title.value,'Новый');assert.equal(form.elements.project.value,'alvi');assert.equal(JSON.parse(f.w.sessionStorage.getItem(old)).title,'Прежний');
    f.d.querySelector('[data-sheet-close]').click();f.w.sessionStorage.removeItem('sb-task-board:1:create');const hidden=JSON.stringify({title:'Недоступный',companyCode:'foreign-project',client_ref:'foreign:ref'});f.w.sessionStorage.setItem(old,hidden);f.d.querySelector('[data-create-task]').click();form=f.d.querySelector('[data-create-form]');assert.equal(form.elements.title.value,'');assert.equal(f.w.sessionStorage.getItem(old),hidden);
  }finally{f.close();}
});
test('legacy creation CAS preserves edits from an older open session while request is pending',async()=>{
  const f=fixture();try{
    await settle();f.ctx.selectedProjectId='synapse-business';const old='sb-task:1:create:synapse-business:';f.w.sessionStorage.setItem(old,JSON.stringify({title:'Отправляемая',companyCode:'synapse-business',client_ref:'legacy:pending'}));let finish;f.intercept('task_create',()=>new Promise(resolve=>{finish=resolve;}));f.d.querySelector('[data-create-task]').click();f.submit(f.d.querySelector('[data-create-form]'));await settle();const edited=JSON.stringify({title:'Новый ввод в старом сеансе',companyCode:'synapse-business',client_ref:'legacy:new'});f.w.sessionStorage.setItem(old,edited);finish({created:true,task:f.task});await settle();assert.equal(f.w.sessionStorage.getItem(old),edited);
  }finally{f.close();}
});
test('upgrade preserves edited legacy description when its client_ref already belongs to an earlier committed task',async()=>{
  const f=fixture();try{
    await settle();f.ctx.selectedProjectId='synapse-business';
    const key='sb-task:1:create:synapse-business:',old={title:'Одна задача',description:'Новое описание из старой формы',companyCode:'synapse-business',assigneeName:'Исполнитель',reviewer:'Приёмщик',dueDate:'2026-12-03',priority:'normal',status:'planned',client_ref:'legacy:already-committed'};
    const raw=JSON.stringify(old);f.w.sessionStorage.setItem(key,raw);
    f.intercept('task_create',async()=>({created:false,task:{...f.task,title:'Одна задача',description:'Описание ранее созданной задачи',company_code:'synapse-business',assignee_name:'Исполнитель',reviewer_name:'Приёмщик',due_date:'2026-12-03',priority:'normal',chat_url:'',status:'done'}}));
    f.d.querySelector('[data-create-task]').click();f.submit(f.d.querySelector('[data-create-form]'));await settle();
    const saved=JSON.parse(f.w.sessionStorage.getItem('sb-task-board:1:create'));assert.equal(saved.description,old.description);assert.notEqual(saved.client_ref,old.client_ref);assert.equal(f.w.sessionStorage.getItem(key),raw);assert.equal(f.calls.filter(call=>call.name==='task_create').length,1);assert.match(f.d.querySelector('[data-detail-result]').textContent,/сохранён в черновике/);
  }finally{f.close();}
});


test('compact task retains result and opens previous controls in the task project',async()=>{
  const f=fixture();try{await settle();f.task.coordination.result='Подтверждённый результат';let project,route;f.ctx.chooseProject=value=>{project=value;};f.ctx.navigate=value=>{route=value;};await f.controller.openTask(1);assert.match(f.d.querySelector('.tb-facts').textContent,/Подтверждённый результат/);f.d.querySelector('[data-task-record]').click();assert.equal(project,'synapse-business');assert.equal(route,'tasks/record/1');}finally{f.close();}
});

const questionFields={owner_question:'Разрешить следующий шаг?',if_yes:'Работа продолжится.',if_no:'Работу отложим.',owner_minutes:2};
const overviewTask=(id,extra={})=>({id,title:`Работа ${id}`,company_code:'synapse-business',description:'',status:'planned',assignee_name:'Codex',reviewer_name:'Claude',waiting_since:null,coordination:{revision:1,blocker:'',nextAction:'',milestones:{}},comments:[{id:3,author:'Claude',text:'Начало',created_at:'2026-01-01T00:00:00Z'}],comments_pagination:{total:1},subtasks:[],subtasks_pagination:{total:0},...extra,coordination:{revision:1,blocker:'',nextAction:'',milestones:{},...questionFields,...extra.coordination}});
async function overviewFixture(records,initial={view:'projects'}) {
  const f=fixture('owner',initial);await settle();const map=new Map(records.map(task=>[task.id,task]));
  f.intercept('tasks_list',async()=>({tasks:[...map.values()],pagination:{total:map.size}}));
  f.intercept('task_get',async args=>{const task=map.get(args.task_id);if(!task)throw Error('Не найдена');return structuredClone(task);});
  f.intercept('task_update',async args=>{const task=map.get(args.task_id);if('blocker'in args)task.coordination.blocker=args.blocker;if('next_step'in args)task.coordination.nextAction=args.next_step;return {task};});
  f.w.eval(fs.readFileSync(__dirname+'/task-overview.js','utf8'));await f.controller.render(initial);return {...f,map};
}
test('owner overview orders waiting, guide, goal, active directions, future and current work',async()=>{
  const stages={code:{state:'confirmed'},connected:{state:'confirmed'},verified:{state:'pending'},accepted:{state:'pending'}};
  const records=[overviewTask(100,{title:'Цель · Понятная система'}),overviewTask(110,{title:'Направление · Видеть работу',parent_task_id:100,description:'ЦКП: Вся работа прозрачна\nСостав: №201, №202'}),overviewTask(120,{title:'Направление · Следующий шаг',parent_task_id:100,description:'ЦКП: Следующий результат\nСостав: №202'}),overviewTask(201,{title:'Проверить панель',status:'in_progress',waiting_since:'2026-01-02T03:00:00Z',coordination:{revision:2,blocker:'ЖДЁТ ВЛАДА: выбрать макет',nextAction:'',milestones:stages}}),overviewTask(202,{status:'planned'})];
  const f=await overviewFixture(records);try{
    const nodes=[...f.d.querySelector('.tb-overview').children];assert.equal(nodes[0].dataset.waiting,'');assert.equal(nodes[1].dataset.boardGuide,'');assert.equal(nodes[1].open,false);assert.equal(nodes[2].dataset.goal,'100');assert.ok(nodes[3].hasAttribute('data-active-directions'));assert.equal(nodes[4].className,'tb-upcoming');assert.ok(nodes[5].hasAttribute('data-now-tasks'));
    assert.match(f.d.querySelector('[data-goal]').textContent,/13%/);assert.match(f.d.querySelector('[data-goal]').textContent,/Сейчас строим: Видеть работу → потом: Следующий шаг/);assert.match(f.d.querySelector('.tb-direction').textContent,/Зачем: Вся работа прозрачна/);assert.match(f.d.querySelector('.tb-direction').textContent,/Ведёт Codex · Принимает Claude/);assert.match(f.d.querySelector('[data-now-tasks]').textContent,/Видеть работу/);assert.match(f.d.querySelector('[data-now-tasks]').textContent,/проверка/);assert.equal(f.d.querySelector('[data-waiting] time').dateTime,'2026-01-02T03:00:00Z');
    f.d.querySelector('[data-waiting] button').click();await settle();assert.ok(f.d.querySelector('[data-wait-reply]'));assert.equal(f.calls.filter(call=>call.name==='tasks_list').at(-1).args.overview,true);
  }finally{f.close();}
});
test('waiting block hides when empty and never substitutes last update for an unknown start date',async()=>{
  const task=overviewTask(201,{coordination:{revision:1,blocker:'Пока без вопроса',nextAction:'',updatedAt:'2026-01-01T00:00:00Z',milestones:{}}});
  const f=await overviewFixture([task]);try{assert.equal(f.d.querySelector('[data-waiting]'),null);task.assignee_name='Влад';await f.controller.render();assert.ok(f.d.querySelector('[data-waiting]'));assert.equal(f.d.querySelector('[data-waiting] time'),null);assert.match(f.d.querySelector('[data-waiting]').textContent,/Ждёт решения · начало не зафиксировано/);}finally{f.close();}
});
test('waiting Yes and No add only explicit comments; unrelated blocker and next step are preserved',async()=>{
  const task=overviewTask(201,{assignee_name:'Влад',coordination:{revision:2,blocker:'Нужны данные клиента',nextAction:'ВОПРОС → Влад: выбрать вариант',milestones:{}}});
  const f=await overviewFixture([task]);try{
    await f.controller.openTask(201);assert.equal(f.d.querySelector('[data-wait-clear]').hidden,false);f.d.querySelector('[data-wait-choice="Да"]').click();await settle();assert.equal(f.calls.filter(call=>call.name==='task_comment').at(-1).args.text,'ОТВЕТ: Да');assert.equal(f.calls.filter(call=>call.name==='task_comment').at(-1).args.author,'Влад');assert.equal(f.calls.filter(call=>call.name==='task_update').length,0);
    f.d.querySelector('[data-wait-choice="Нет"]').click();await settle();assert.equal(f.calls.filter(call=>call.name==='task_comment').at(-1).args.text,'ОТВЕТ: Нет');assert.equal(task.coordination.blocker,'Нужны данные клиента');assert.equal(task.coordination.nextAction,'ВОПРОС → Влад: выбрать вариант');
  }finally{f.close();}
});
test('clear waiting changes only a marked blocker and reports a remaining assignment marker',async()=>{
  const task=overviewTask(201,{assignee_name:'Влад',coordination:{revision:7,blocker:'Ждёт Влада: принять',nextAction:'Продолжить после решения',milestones:{}}});
  const f=await overviewFixture([task]);try{await f.controller.openTask(201);f.d.querySelector('[data-wait-clear]').click();await settle();const request=f.calls.find(call=>call.name==='task_update').args;assert.deepEqual(JSON.parse(JSON.stringify(request)),{task_id:201,revision:7,blocker:''});assert.equal(task.assignee_name,'Влад');assert.equal(task.coordination.nextAction,'Продолжить после решения');assert.match(f.d.querySelector('[data-wait-result]').textContent,/Ожидание остаётся/);}finally{f.close();}
});
test('waiting reply unknown outcome survives reopening, checks history and does not resend automatically',async()=>{
  const task=overviewTask(201,{coordination:{revision:1,blocker:'Ждёт Влада: ответ',nextAction:'',milestones:{}}});
  const f=await overviewFixture([task]);try{
    f.intercept('task_comment',async args=>{task.comments.unshift({id:7,author:'Влад',text:args.text,created_at:'2026-01-01T01:00:00Z'});throw Error('Ответ сервера потерян');});
    await f.controller.openTask(201);let form=f.d.querySelector('[data-wait-reply]');f.input(form.elements.text,'Мой ответ');f.submit(form);await settle();assert.equal(form.querySelector('[type=submit]').disabled,true);assert.match(form.querySelector('[data-wait-result]').textContent,/не повторяется автоматически/);await f.controller.openTask(201);form=f.d.querySelector('[data-wait-reply]');assert.equal(form.elements.text.value,'Мой ответ');assert.equal(form.querySelector('[type=submit]').disabled,true);
    f.input(form.elements.text,'Следующий черновик');form.querySelector('[data-wait-check]').click();await settle();assert.equal(f.calls.filter(call=>call.name==='task_comment').length,1);form=f.d.querySelector('[data-wait-reply]');assert.equal(form.elements.text.value,'Следующий черновик');assert.equal(form.querySelector('[type=submit]').disabled,false);assert.match(form.querySelector('[data-wait-result]').textContent,/ответ найден/);
  }finally{f.close();}
});
test('late waiting reply success preserves a new draft typed in another open sheet',async()=>{
  const task=overviewTask(201,{coordination:{revision:1,blocker:'Ждёт Влада: ответ',nextAction:'',milestones:{}}}),f=await overviewFixture([task]);
  try{let finish;f.intercept('task_comment',()=>new Promise(resolve=>{finish=resolve;}));await f.controller.openTask(201);let form=f.d.querySelector('[data-wait-reply]');f.input(form.elements.text,'Отправленный');f.submit(form);await settle();await f.controller.openTask(201);form=f.d.querySelector('[data-wait-reply]');f.input(form.elements.text,'Новый черновик');finish({comment:{id:7}});await settle();assert.equal(form.elements.text.value,'Новый черновик');const saved=JSON.parse(f.w.sessionStorage.getItem('sb-task-board:1:waitreply:201'));assert.equal(saved.text,'Новый черновик');assert.equal(saved.pending,undefined);assert.equal(f.calls.filter(call=>call.name==='task_comment').length,1);}finally{f.close();}
});
test('older summaries and truncated direction descriptions hydrate in at most three parallel requests',async()=>{
  const records=[overviewTask(100,{title:'Цель · Совместимость'}),overviewTask(110,{parent_task_id:100,title:'Направление · Длинное описание',description:`${'x'.repeat(1100)}\nЦКП: Работает со старыми данными\nСостав: №201`}),overviewTask(201,{status:'in_progress'}),overviewTask(202),overviewTask(203)];
  const f=fixture('owner',{view:'projects'});try{
    await settle();let inflight=0,max=0;const byId=new Map(records.map(task=>[task.id,task]));f.intercept('tasks_list',async()=>({tasks:records.map(task=>({id:task.id,title:task.title,company_code:task.company_code,parent_task_id:task.parent_task_id,status:task.status,description:task.description.slice(0,1000),description_truncated:task.description.length>1000,coordination:{revision:1,milestones:{}}})),pagination:{total:records.length}}));
    f.intercept('task_get',async args=>{inflight++;max=Math.max(max,inflight);await new Promise(resolve=>setTimeout(resolve,3));inflight--;return structuredClone(byId.get(args.task_id));});f.w.eval(fs.readFileSync(__dirname+'/task-overview.js','utf8'));await f.controller.render();assert.ok(max>1&&max<=3);assert.match(f.d.querySelector('.tb-direction').textContent,/Работает со старыми данными/);assert.match(f.d.querySelector('.tb-direction-current').textContent,/№201/);assert.equal(f.d.querySelector('[data-waiting] time'),null);
  }finally{f.close();}
});
test('checking history while the original reply POST is in flight cannot unlock a second submission',async()=>{
  const task=overviewTask(201,{coordination:{revision:1,blocker:'Ждёт Влада: ответ',nextAction:'',milestones:{}}}),f=await overviewFixture([task]);
  try{let finish;f.intercept('task_comment',()=>new Promise(resolve=>{finish=resolve;}));await f.controller.openTask(201);let form=f.d.querySelector('[data-wait-reply]');f.input(form.elements.text,'Первый');f.submit(form);await settle();const before=f.calls.filter(call=>call.name==='task_get').length;assert.equal(form.querySelector('[data-wait-check]').disabled,true);form.querySelector('[data-wait-check]').dispatchEvent(new f.w.Event('click',{bubbles:true}));await settle();assert.equal(f.calls.filter(call=>call.name==='task_get').length,before);await f.controller.openTask(201);form=f.d.querySelector('[data-wait-reply]');form.querySelector('[data-wait-check]').dispatchEvent(new f.w.Event('click',{bubbles:true}));f.input(form.elements.text,'Второй');f.submit(form);await settle();assert.equal(f.calls.filter(call=>call.name==='task_comment').length,1);assert.equal(form.querySelector('[type=submit]').disabled,true);finish({comment:{id:7}});await settle();}finally{f.close();}
});
test('late reply success unlocks the current reopened form while retaining its new text',async()=>{
  const task=overviewTask(201,{coordination:{revision:1,blocker:'Ждёт Влада: ответ',nextAction:'',milestones:{}}}),f=await overviewFixture([task]);
  try{let finish;f.intercept('task_comment',()=>new Promise(resolve=>{finish=resolve;}));await f.controller.openTask(201);let form=f.d.querySelector('[data-wait-reply]');f.input(form.elements.text,'Первый');f.submit(form);await settle();await f.controller.openTask(201);form=f.d.querySelector('[data-wait-reply]');f.input(form.elements.text,'Новый');finish({comment:{id:7}});await settle();assert.equal(form.elements.text.value,'Новый');assert.equal(form.querySelector('[type=submit]').disabled,false);assert.equal(form.querySelector('[data-wait-check]').hidden,true);assert.equal(JSON.parse(f.w.sessionStorage.getItem('sb-task-board:1:waitreply:201')).text,'Новый');}finally{f.close();}
});
test('reply lock survives controller remount and settled response synchronizes the new controller',async()=>{
  const task=overviewTask(201,{coordination:{revision:1,blocker:'Ждёт Влада: ответ',nextAction:'',milestones:{}}}),f=await overviewFixture([task]);
  try{let finish;f.intercept('task_comment',()=>new Promise(resolve=>{finish=resolve;}));await f.controller.openTask(201);let form=f.d.querySelector('[data-wait-reply]');f.input(form.elements.text,'Первый');f.submit(form);await settle();f.controller.destroy();f.controller=f.w.SbTaskBoard.mount(f.d.getElementById('board'),f.ctx,{view:'projects'});await settle();await f.controller.openTask(201);form=f.d.querySelector('[data-wait-reply]');assert.equal(form.querySelector('[data-wait-check]').disabled,true);f.input(form.elements.text,'Сохранённый новый');f.submit(form);assert.equal(f.calls.filter(call=>call.name==='task_comment').length,1);finish({comment:{id:7}});await settle();assert.equal(form.elements.text.value,'Сохранённый новый');assert.equal(form.querySelector('[type=submit]').disabled,false);assert.equal(form.querySelector('[data-wait-check]').hidden,true);}finally{f.controller.destroy();f.close();}
});
test('every module shows all visible nested work with task progress while structure and cancelled tasks stay out of execution counts',async()=>{
  const confirmed=n=>({revision:1,blocker:'',nextAction:'',milestones:Object.fromEntries(['code','connected','verified','accepted'].map((key,index)=>[key,{state:index<n?'confirmed':'pending'}]))});
  const parent=overviewTask(201,{title:'Подготовить основу',parent_task_id:1100,coordination:confirmed(1)}),done=overviewTask(202,{title:'Готовая часть',parent_task_id:1100,status:'done',coordination:confirmed(4)}),cancelled=overviewTask(203,{title:'Снятая часть',parent_task_id:1100,status:'cancelled',coordination:confirmed(4)});
  const records=[overviewTask(1000,{title:'Цель · Полезная система',status:'in_progress',no_report:true}),overviewTask(1100,{title:'Модуль · Первый блок',parent_task_id:1000,status:'in_progress',no_report:true,description:'Состав: №201, №201, №202, №205',coordination:confirmed(4),subtasks:[parent,done,cancelled],subtasks_pagination:{total:3}}),overviewTask(1200,{title:'Модуль · Будущий блок',parent_task_id:1000}),overviewTask(1300,{title:'Прежняя структура',parent_task_id:1000,status:'in_progress',description:'ЦКП: Сохранить прежний путь\nСостав: №207'}),parent,done,cancelled,overviewTask(204,{title:'Вложенная работа',parent_task_id:201,status:'in_progress',coordination:confirmed(2)}),overviewTask(205,{title:'Скрытый промежуточный',parent_task_id:1100,status:'cancelled'}),overviewTask(206,{title:'Работа за скрытым родителем',parent_task_id:205,status:'in_progress',coordination:confirmed(4)}),overviewTask(207,{title:'Прежняя рабочая задача',status:'in_progress',no_report:true,coordination:confirmed(2)}),overviewTask(208,{title:'Входящая работа',status:'inbox'}),overviewTask(209,{title:'Запланированная работа',parent_task_id:1200})];
  const before=JSON.stringify(records),f=await overviewFixture(records);try{
    const first=f.d.querySelector('[data-module-id="1100"]');assert.equal(first.querySelectorAll('[data-module-task]').length,4);assert.equal(first.querySelectorAll('[data-module-task="201"]').length,1);assert.match(first.querySelector('[data-module-task="201"]').textContent,/25%/);assert.match(first.querySelector('[data-module-task="201"]').textContent,/подключение/);assert.match(first.querySelector('[data-module-task="202"]').textContent,/100%/);assert.ok(first.querySelector('[data-module-task="206"]'));assert.equal(first.querySelector('[data-module-task="203"]'),null);assert.equal(f.d.querySelector('[data-module-id="1200"]'),null);assert.ok(f.d.querySelector('.tb-upcoming [data-task-open="1200"]'));assert.equal(f.d.querySelectorAll('.tb-upcoming [data-task-open="1200"]').length,1);
    const summary=f.d.querySelector('.tb-project-card[data-project="synapse-business"]');assert.match(summary.textContent,/В работе 3 · План 2 · Входящие 1/);assert.match(summary.textContent,/Нет отчёта 1/);assert.equal(f.d.querySelectorAll('.tb-now-row').length,3);assert.doesNotMatch([...f.d.querySelectorAll('.tb-now-row>strong')].map(node=>node.textContent).join(' '),/Полезная система|Первый блок|Прежняя структура/);assert.doesNotMatch(f.d.querySelector('.tb-overview').textContent,/Модуль ·|Цель ·|Снятая часть|Скрытый промежуточный/);
    await f.controller.render({view:'board'});assert.equal(f.d.querySelectorAll('.tb-column [data-task-open]').length,7);assert.equal(f.d.querySelector('[data-drop-status="in_progress"] h3>span:last-child').textContent,'3');assert.doesNotMatch(f.d.querySelector('.tb-board').textContent,/Отменено|Снятая часть|Скрытый промежуточный/);
    await f.controller.render({view:'plan'});assert.doesNotMatch(f.d.querySelector('.tb-plan').textContent,/Отменено|Снятая часть/);await f.controller.openTask(1100);assert.equal(f.d.querySelector('.tb-task-title').textContent,'Первый блок');assert.equal(f.d.querySelectorAll('[data-subtasks] [data-child-open]').length,2);assert.doesNotMatch(f.d.querySelector('[data-subtasks]').textContent,/Снятая часть/);await f.controller.openTask(203);assert.equal(f.d.querySelector('.tb-task-title'),null);assert.match(f.d.querySelector('[data-sheet-body]').textContent,/снята с доски/);assert.equal(JSON.stringify(records),before);
  }finally{f.close();}
});
test('explicit questions on goals and orphan modules remain in waiting without inflating work counters',async()=>{
  const records=[overviewTask(1000,{title:'Цель · Решение по системе',assignee_name:'Влад',status:'in_progress'}),overviewTask(1100,{title:'Модуль · Самостоятельный блок',parent_task_id:9999,status:'in_progress',coordination:{revision:1,blocker:'Ждёт Влада',nextAction:'',milestones:{}}}),overviewTask(1200,{title:'Модуль · Снятый вопрос',status:'cancelled',assignee_name:'Влад'}),overviewTask(201,{title:'Единственная работа',parent_task_id:1100,status:'in_progress'})];
  const f=await overviewFixture(records);try{assert.equal(f.d.querySelectorAll('.tb-waiting-row').length,2);assert.match(f.d.querySelector('[data-waiting]').textContent,/Разрешить следующий шаг/);assert.doesNotMatch(f.d.querySelector('[data-waiting]').textContent,/Модуль ·|Цель ·|Снятый вопрос/);assert.ok(f.d.querySelector('[data-module-id="1100"]'));assert.match(f.d.querySelector('.tb-project-card[data-project="synapse-business"]').textContent,/В работе 1/);assert.equal(f.d.querySelectorAll('.tb-now-row').length,1);assert.equal(f.d.querySelector('.tb-now-row').dataset.taskOpen,'201');}finally{f.close();}
});
test('a cancelled duplicate stays hidden but permits explicit separate creation with the same client_ref',async()=>{
  const f=fixture();try{
    await settle();const hidden={...f.task,id:500,status:'cancelled',title:'Скрытое прежнее имя'};
    f.intercept('task_duplicates',async()=>({possible_duplicates:[hidden],possible_product_duplicates:[]}));
    f.intercept('task_create',async args=>args.force?{created:true,task:{...f.task,title:args.title}}:{created:false,possible_duplicates:[hidden],possible_product_duplicates:[]});
    f.d.querySelector('[data-create-task]').click();const form=f.d.querySelector('[data-create-form]');f.input(form.elements.title,'Новая отдельная задача');form.elements.project.value='synapse-business';f.submit(form);await settle();
    assert.equal(form.querySelector('[data-force-label]').hidden,false);assert.equal(form.querySelector('[data-existing-task="500"]'),null);assert.doesNotMatch(form.textContent,/Скрытое прежнее имя/);assert.match(form.querySelector('[data-create-duplicates]').textContent,/прежнее совпадение/);
    const first=f.calls.find(call=>call.name==='task_create').args;assert.equal(first.force,undefined);form.elements.force.checked=true;form.elements.force.dispatchEvent(new f.w.Event('input',{bubbles:true}));f.submit(form);await settle();
    const requests=f.calls.filter(call=>call.name==='task_create');assert.equal(requests.length,2);assert.equal(requests[1].args.force,true);assert.equal(requests[1].args.client_ref,first.client_ref);assert.equal(f.d.querySelector('[data-create-form]'),null);assert.equal(f.d.querySelector('.tb-task-title').textContent,f.task.title);
  }finally{f.close();}
});
test('next-step waiting can be cleared without deleting its meaningful body or unrelated blocker',async()=>{
  const task=overviewTask(201,{coordination:{revision:9,blocker:'Получить данные клиента',nextAction:'ВОПРОС → Влад: выбрать вариант\nДалее проверить результат',milestones:{}}}),f=await overviewFixture([task]);
  try{await f.controller.openTask(201);assert.equal(f.d.querySelector('[data-wait-clear]').hidden,false);const comment=f.d.querySelector('[data-comment-form]');f.input(comment.elements.text,'Сохранённый комментарий');f.d.querySelector('[data-wait-clear]').click();await settle();const sent=f.calls.find(call=>call.name==='task_update').args;assert.deepEqual(JSON.parse(JSON.stringify(sent)),{task_id:201,revision:9,next_step:'выбрать вариант\nДалее проверить результат'});assert.equal(task.coordination.blocker,'Получить данные клиента');assert.equal(task.coordination.nextAction,'выбрать вариант\nДалее проверить результат');assert.equal(task.assignee_name,'Codex');assert.equal(f.d.querySelector('[data-waiting-actions]'),null);assert.equal(f.d.querySelector('[data-comment-form]').elements.text.value,'Сохранённый комментарий');}finally{f.close();}
});
test('clearing both marked waiting fields uses one revision-checked patch and preserves assignment waiting',async()=>{
  const task=overviewTask(201,{assignee_name:'Влад',coordination:{revision:11,blocker:'Ждёт Влада: согласовать',nextAction:'  ЖДЁТ ВЛАДА — принять план\nЗатем продолжить',milestones:{}}}),f=await overviewFixture([task]);
  try{await f.controller.openTask(201);f.d.querySelector('[data-wait-clear]').click();await settle();const sent=f.calls.filter(call=>call.name==='task_update');assert.equal(sent.length,1);assert.deepEqual(JSON.parse(JSON.stringify(sent[0].args)),{task_id:201,revision:11,blocker:'',next_step:'принять план\nЗатем продолжить'});assert.equal(task.assignee_name,'Влад');assert.equal(task.coordination.nextAction,'принять план\nЗатем продолжить');assert.equal(f.d.querySelector('[data-wait-clear]').hidden,true);assert.match(f.d.querySelector('[data-wait-result]').textContent,/Ожидание остаётся/);f.d.querySelector('[data-wait-edit-plan]').click();assert.equal(f.d.querySelector('[data-plan-form]').closest('details').open,true);}finally{f.close();}
});
test('waiting clear conflict retains every field and draft while sending the observed revision',async()=>{
  const task=overviewTask(201,{coordination:{revision:12,blocker:'Проверить данные',nextAction:'Ждёт Влада: подтвердить план',milestones:{}}}),f=await overviewFixture([task]);
  try{const before=JSON.stringify(task);f.intercept('task_update',async()=>{throw Object.assign(Error('Карточка изменена другим исполнителем'),{status:409});});await f.controller.openTask(201);const reply=f.d.querySelector('[data-wait-reply]');f.input(reply.elements.text,'Неотправленный ответ');f.d.querySelector('[data-wait-clear]').click();await settle();assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(call=>call.name==='task_update').args)),{task_id:201,revision:12,next_step:'подтвердить план'});assert.equal(JSON.stringify(task),before);assert.equal(reply.elements.text.value,'Неотправленный ответ');assert.equal(f.d.querySelector('[data-wait-clear]').disabled,false);assert.match(f.d.querySelector('[data-wait-result]').textContent,/изменена другим исполнителем/);}finally{f.close();}
});
test('goal shows equal module weights, completed work gives 100%, and future module work opens from a single compact row',async()=>{
  const done=overviewTask(201,{title:'Завершённая работа',parent_task_id:1100,status:'done',coordination:{revision:1,blocker:'',nextAction:'',milestones:{}}});
  const records=[overviewTask(1000,{title:'Цель · Равные модули'}),overviewTask(1100,{title:'Модуль · Завершённый блок',parent_task_id:1000}),overviewTask(1200,{title:'Модуль · Будущий блок',parent_task_id:1000}),done,overviewTask(202,{parent_task_id:1200}),overviewTask(203,{parent_task_id:1200}),overviewTask(204,{description:'Модуль №1200'})],before=JSON.stringify(records),f=await overviewFixture(records);
  try{assert.match(f.d.querySelector('[data-goal]').textContent,/50%/);assert.match(f.d.querySelector('[data-board-guide]').textContent,/среднее процентов её модулей с равным весом/);assert.match(f.d.querySelector('[data-board-guide]').textContent,/Завершённая задача даёт 100%/);assert.match(f.d.querySelector('[data-module-id="1100"] [data-module-task="201"]').textContent,/100%/);assert.match(f.d.querySelector('[data-module-id="1100"] [data-module-task="201"]').textContent,/готово/);assert.equal(f.d.querySelector('[data-module-id="1200"]'),null);const row=f.d.querySelector('.tb-upcoming [data-task-open="1200"]');assert.ok(row);assert.equal(f.d.querySelectorAll('.tb-upcoming [data-task-open="1200"]').length,1);row.click();await settle();assert.equal(f.d.querySelectorAll('[data-module-composition] [data-module-task]').length,3);assert.ok(f.d.querySelector('[data-module-composition] [data-module-task="204"]'));assert.match(f.d.querySelector('[data-module-composition]').textContent,/0%/);assert.equal(JSON.stringify(records),before);}finally{f.close();}
});

test('waiting instructions expose full blocker, next step and link buttons directly; text URLs are safe in all fields',async()=>{
 const blocker='ждёт Влада: Первая строка\nВторая строка: github.com/Elk0980/synapse-server/pull/523\nТретья строка — '+ 'Длинный текст '.repeat(60);
 const next='Открыть synapse.synapsebusiness.ru/cabinet/people.html\nЗатем принять решение';
 const task=overviewTask(201,{description:'Описание https://example.test/description <img src=x onerror=alert(1)>',coordination:{revision:2,blocker,nextAction:next,milestones:{},links:[{url:'https://example.test/button',label:'Открыть инструкцию'},{url:'javascript:alert(1)',label:'Запрещено'}]}});
 task.comments=[{id:1,author:'Claude',text:'Комментарий github.com/Elk0980/synapse-server',created_at:'2026-01-01'}];
 const f=await overviewFixture([task]);try{
 const row=f.d.querySelector('.tb-waiting-row');assert.equal(row.querySelector('[data-waiting-instructions]').open,true,'вариант C (№108): виден сразу в строке');assert.equal(row.querySelector('.tb-waiting-text').textContent,blocker);assert.match(row.textContent,/Следующий шаг/);assert.ok(row.querySelector('a[href="https://example.test/button"]'));assert.equal(row.querySelector('button a'),null);
 assert.ok(row.querySelector('a[href="https://github.com/Elk0980/synapse-server/pull/523"]'));
 await f.controller.openTask(201);await settle();const panel=f.d.querySelector('[data-waiting-actions]');
 const full=panel.nextElementSibling;assert.ok(full.matches('[data-waiting-instructions]'),'full text sits right after the simple decision panel');assert.equal(full.open,true,'вариант C (№108): виден сразу в карточке');
 assert.equal(full.querySelector('.tb-waiting-text').textContent,blocker);assert.match(full.textContent,/Затем принять решение/);assert.equal(panel.querySelector('.tb-waiting-text'),null,'decision panel stays simple (№88)');assert.ok(panel.querySelector('a[href="https://example.test/button"]'));
 assert.ok(f.d.querySelector('.tb-description a[href="https://example.test/description"]'));assert.ok(f.d.querySelector('[data-comments] a[href="https://github.com/Elk0980/synapse-server"]'));
 assert.equal(f.d.querySelector('img'),null);assert.equal(f.d.querySelector('a[href^="javascript:"]'),null);
 assert.equal(f.d.querySelector('[data-plan-form]').elements.blocker.value,blocker);
 for(const a of panel.querySelectorAll('a')){assert.equal(a.target,'_blank');assert.equal(a.rel,'noopener noreferrer');}
 }finally{f.close();}
});

test('45s refresh, focus and pull update waiting while preserving open drafts; destroy clears timer',async()=>{
 let tick,cleared=false;const f=fixture('owner',{view:'board'},w=>{
 Object.defineProperty(w.document,'visibilityState',{configurable:true,value:'visible'});
 w.setInterval=(callback,ms)=>{assert.equal(ms,45000);tick=callback;return 123;};w.clearInterval=id=>{if(id===123)cleared=true;};
 });try{await settle();const before=f.refreshCount();tick();await settle();assert.equal(f.refreshCount(),before+1);
 await f.controller.openTask(1);const draft=f.d.querySelector('[data-comment-form] textarea');f.input(draft,'Не потерять');tick();await settle();assert.equal(draft.value,'Не потерять');assert.ok(draft.isConnected);
 f.d.querySelector('[data-sheet-close]').click();const count=f.refreshCount();f.w.dispatchEvent(new f.w.Event('focus'));await settle();assert.equal(f.refreshCount(),count+1);
 const container=f.d.querySelector('#board'),event=(type,touches)=>{const e=new f.w.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:touches});container.dispatchEvent(e);};
 const pulls=f.refreshCount();event('touchstart',[{clientX:20,clientY:10}]);event('touchmove',[{clientX:20,clientY:100}]);event('touchend',[]);await settle();assert.equal(f.refreshCount(),pulls+1);
 f.controller.destroy();assert.equal(cleared,true);
 }finally{f.close();}
});
test('auto refresh does not redraw while search or quick task has focus; applies after blur; pull still forces',async()=>{
 let tick;const f=fixture('owner',{view:'board',project:'synapse-business'},w=>{
 Object.defineProperty(w.document,'visibilityState',{configurable:true,value:'visible'});
 w.setInterval=(callback,ms)=>{tick=callback;return 123;};w.clearInterval=()=>{};
 });try{await settle();const wait=()=>new Promise(r=>setTimeout(r,5));
 for(const selector of ['[data-board-search]','[data-quick-task] input']){
  const field=f.d.querySelector(selector);field.focus();field.value='набираю';assert.equal(f.d.activeElement,field);
  const before=f.refreshCount();tick();f.w.dispatchEvent(new f.w.Event('focus'));await settle();
  assert.equal(f.refreshCount(),before,'no reload while typing in '+selector);assert.ok(field.isConnected);assert.equal(f.d.activeElement,field);assert.equal(field.value,'набираю');
  field.blur();await wait();await settle();assert.equal(f.refreshCount(),before+1,'postponed refresh applied after blur');assert.equal(field.isConnected,false);
 }
 // Load already in flight when the person starts typing: data is kept, DOM is not replaced.
 let release;f.intercept('tasks_list',()=>new Promise(resolve=>{release=()=>resolve({tasks:[f.task],pagination:{total:1}});}));
 tick();await settle();const search=f.d.querySelector('[data-board-search]');search.focus();release();await settle();
 assert.ok(search.isConnected);assert.equal(f.d.activeElement,search);
 f.intercept('tasks_list',undefined);
 // Explicit pull-to-refresh is not postponed.
 const container=f.d.querySelector('#board'),event=(type,touches)=>{const e=new f.w.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:touches});container.querySelector('.tb-columns').dispatchEvent(e);};
 const pulls=f.refreshCount();event('touchstart',[{clientX:20,clientY:10}]);event('touchmove',[{clientX:20,clientY:100}]);event('touchend',[]);await settle();assert.equal(f.refreshCount(),pulls+1);
 }finally{f.close();}
});
test('only complete plain questions reach the owner; legacy requests stay in the orchestrator queue',async()=>{
  const task=overviewTask(900,{title:'PR 123 head abcdef1234567890 /opt/private',description:'CI log',status:'in_progress',due_date:'2026-01-01',assignee_name:'Влад',coordination:{owner_question:''}}),f=await overviewFixture([task]);
  try{assert.equal(f.d.querySelector('[data-waiting]'),null);for(const view of ['board','plan','today','projects']){await f.controller.render({view});assert.match(f.d.body.textContent,/PR 123 head abcdef1234567890 \/opt\/private/);}await f.controller.render({view:'agents'});assert.match(f.d.querySelector('[data-question-queue]').textContent,/Вопрос не оформлен/);await f.controller.openTask(900);assert.equal(f.d.querySelector('[data-waiting-actions]'),null);assert.match(f.d.querySelector('[data-task-simple]').textContent,/Вопрос пока не оформлен/);assert.equal(f.d.querySelector('[data-task-technical]').open,false);assert.match(f.d.querySelector('[data-task-technical]').textContent,/abcdef1234567890/);}finally{f.close();}
});
test('decision main is simple and hides technical context; own response remains explicit',async()=>{
  const task=overviewTask(901,{title:'PR 123 abcdef1234567890',description:'/opt/private head CI',assignee_name:'Влад',coordination:{nextAction:'Проверить CI /opt/private'}}),f=await overviewFixture([task]);
  try{await f.controller.openTask(901);const panel=f.d.querySelector('[data-owner-decision]');assert.match(panel.textContent,/Да → Работа продолжится/);assert.match(panel.textContent,/Нет → Работу отложим/);assert.match(panel.textContent,/Ваше время: 2 мин/);assert.doesNotMatch(panel.textContent,/[a-z]/i);assert.equal(f.d.querySelector('.tb-simple-next'),null);assert.equal(f.d.querySelector('[data-task-technical]').open,false);assert.match(f.d.querySelector('[data-task-technical]').textContent,/abcdef1234567890/);assert.equal(f.d.querySelector('[data-wait-custom]').hidden,true);panel.querySelector('[data-wait-own]').click();const form=panel.querySelector('form');assert.equal(f.d.querySelector('[data-wait-custom]').hidden,false);f.input(form.elements.text,'Предлагаю обсудить завтра');f.submit(form);await settle();assert.equal(f.calls.filter(call=>call.name==='task_comment').at(-1).args.text,'ОТВЕТ: Предлагаю обсудить завтра');assert.equal(f.calls.filter(call=>call.name==='task_update').length,0);}finally{f.close();}
});
test('a plain next action stays in one compact line and structured question updates leave the queue',async()=>{
  const task=overviewTask(902,{assignee_name:'Влад',coordination:{owner_question:'',nextAction:'Выбрать дату начала'}}),f=await overviewFixture([task]);
  try{await f.controller.openTask(902);assert.match(f.d.querySelector('.tb-simple-next').textContent,/Выбрать дату начала/);Object.assign(task.coordination,questionFields);await f.controller.render({view:'agents'});assert.equal(f.d.querySelector('[data-question-queue]'),null);assert.equal(f.d.querySelectorAll('.tb-waiting-row').length,1);}finally{f.close();}
});

test('decision failures keep raw diagnostics in extended details and never resend an unknown reply',async()=>{
  const task=overviewTask(903,{assignee_name:'Влад'}),f=await overviewFixture([task]);
  try{f.intercept('task_comment',async()=>{throw Error('POST /coordination/mcp PR #500 CI abcdef1234567890');});await f.controller.openTask(903);f.d.querySelector('[data-wait-choice="Да"]').click();await settle();assert.doesNotMatch(f.d.querySelector('[data-owner-decision]').textContent,/POST|PR|CI|abcdef/);f.intercept('task_get',async()=>{throw Error('GET /coordination/mcp PR #500 CI abcdef1234567890');});f.d.querySelector('[data-wait-check]').click();await settle();assert.doesNotMatch(f.d.querySelector('[data-owner-decision]').textContent,/GET|PR|CI|abcdef/);assert.match(f.d.querySelector('[data-task-technical]').textContent,/GET.*abcdef/);assert.equal(f.d.querySelector('[data-task-technical]').open,false);assert.equal(f.calls.filter(call=>call.name==='task_comment').length,1);await f.controller.openTask(903);const body=f.d.querySelector('[data-sheet-body]').cloneNode(true);body.querySelector('[data-task-technical]').remove();assert.doesNotMatch(body.textContent,/GET|PR|CI|abcdef/);assert.match(f.d.querySelector('[data-task-technical]').textContent,/GET.*abcdef/);}finally{f.close();}
});

test('ordinary titles keep Latin, paths, long text and numbers in every task view and compact header',async()=>{
  const titles=['Проверить CRM /cabinet',('Подробное название '+ 'работы '.repeat(25)).trim(),'3517116'];
  const rows=titles.map((title,index)=>overviewTask(9100+index,{title,status:'in_progress',due_date:'2026-01-01',parent_task_id:1100}));
  const f=await overviewFixture([overviewTask(1000,{title:'Цель · Результат'}),overviewTask(1100,{title:'Модуль · Названия',parent_task_id:1000,status:'in_progress'}),...rows]);
  try{for(const row of rows){assert.equal(f.d.querySelector(`[data-module-task="${row.id}"] strong`).textContent,`№${row.id} ${row.title}`);assert.equal(f.d.querySelector(`[data-now-tasks] [data-task-open="${row.id}"] strong`).textContent,`№${row.id} ${row.title}`);}
    for(const view of ['board','plan','today','projects']){await f.controller.render({view});for(const row of rows)assert.ok(f.d.body.textContent.includes(row.title));assert.doesNotMatch(f.d.body.textContent,/№(910[0-2]) Задача №\1/);}
    for(const row of rows){await f.controller.openTask(row.id);assert.equal(f.d.querySelector('[data-task-simple] h3').textContent,row.title);}
  }finally{f.close();}
});
