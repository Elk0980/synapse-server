'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const source = fs.readFileSync(__dirname + '/task-board.js','utf8');
const settle = async () => { for (let i=0;i<12;i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(role='owner', initial={view:'board'}) {
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
