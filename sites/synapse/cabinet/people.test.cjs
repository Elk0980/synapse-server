'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync(path.join(__dirname,'people.html'),'utf8');
const script=fs.readFileSync(path.join(__dirname,'people.js'),'utf8');
const sw=fs.readFileSync(path.join(__dirname,'people-sw.js'),'utf8');
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const task=(extra={})=>({id:35,title:'Контент проекта',description:'ЦКП: 7 публикаций\nОписание',company_code:'alvi',status:'in_progress',subtask_count:4,subtask_done:2,canEdit:true,coordination:{revision:3,milestones:{}},...extra});
function fixture(t,{owner=false,permissions=[],handler,setup,tasks=[task()],contextStatus=200}={}) {
  const dom=new JSDOM(html,{url:'https://synapse.synapsebusiness.ru/cabinet/people.html',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,calls=[];
  t.after(()=>w.close());
  w.fetch=async(route,options={})=>{
    calls.push({route,options});const parsed=new URL(route,w.location.href);
    const special=await handler?.(route,options,calls);if(special!==undefined)return special;
    if(parsed.pathname==='/content/people/context')return response({user:{id:7,displayName:'Исполнитель',role:owner?'owner':'editor',permissions},isOwner:owner,csrfToken:'csrf-test',companies:[{id:'alvi',name:'ALVI'},{id:'avokado',name:'Авокадо'}]},contextStatus);
    if(parsed.pathname==='/content/people/tasks')return response({tasks,total:tasks.length});
    if(/^\/content\/people\/tasks\/\d+$/.test(parsed.pathname))return response({task:tasks[0]});
    if(parsed.pathname==='/content/people/preferences')return response({preferences:{enabled:false,push:false,telegram:false},pushPublicKey:'BEsamplekey'});
    if(parsed.pathname==='/content/people/preview')return response({items:[]});
    if(parsed.pathname==='/content/people/members')return response({members:[{id:7,displayName:'Исполнитель',login:'worker',staffRole:'human_executor',executorKey:'person:7'}]});
    if(parsed.pathname==='/content/people/friday-rule')return response({rule:{enabled:false,userId:7,timezone:'Asia/Irkutsk',metric:'pendingIdeas',weekStart:'2026-11-09',morningHour:9,eveningHour:18}});
    return response({});
  };
  setup?.(w);w.eval(script);return {w,dom,calls,byId:id=>w.document.getElementById(id)};
}
test('обычный вход показывает назначенные задачи и не запускает подписки или отправки',async t=>{
  const f=fixture(t);await flush();
  assert.equal(f.byId('workspace').hidden,false);assert.equal(f.byId('tab-owner').hidden,true);
  assert.equal(f.byId('task-list').querySelectorAll('button').length,1);assert.match(f.byId('task-list').textContent,/50%/);
  assert.equal(f.calls.every(call=>(call.options.method || 'GET')==='GET'),true);
  assert.equal(f.byId('enable-push').disabled,true);assert.match(f.byId('push-status').textContent,/iPhone/);
  assert.equal(f.w.SynapsePeople.progress(task({subtask_count:0,coordination:{milestones:{code:{state:'confirmed'},verified:{state:'confirmed'}}}})),50);
});
test('название задачи и имя участника выводятся текстом, без внедрения HTML',async t=>{
  const f=fixture(t,{owner:true,tasks:[task({title:'<img src=x onerror=alert(1)>'})],handler:async route=>route.startsWith('/content/people/members')?response({members:[{id:7,login:'worker',displayName:'<svg onload=alert(1)>',executorKey:'person:7'}]}):undefined});
  await flush();assert.equal(f.byId('task-list').querySelector('img'),null);assert.match(f.byId('task-list').textContent,/<img/);
  assert.equal(f.byId('member-list').querySelector('svg'),null);assert.match(f.byId('member-list').textContent,/person:7/);
});
test('карточка показывает серверные ЦКП, ответственного и прогресс без ключа назначения',async t=>{
  const f=fixture(t,{tasks:[task({description:undefined,purpose:'7 согласованных публикаций',assigneeName:'Исполнитель проекта',percent:75})]});await flush();
  assert.match(f.byId('task-list').textContent,/7 согласованных публикаций/);assert.match(f.byId('task-list').textContent,/Ответственный: Исполнитель проекта/);assert.match(f.byId('task-list').textContent,/75%/);
  const keyFixture=fixture(t,{tasks:[task({assigneeName:'person:7'})]});await flush();
  assert.equal(keyFixture.byId('task-list').textContent.includes('person:7'),false);assert.match(keyFixture.byId('task-list').textContent,/Ответственный: Исполнитель/);
});
test('safe preview показывает канал, состояние и дату без eventKey и сырых ошибок',async t=>{
  const f=fixture(t,{handler:async route=>route.startsWith('/content/people/preview')?response({items:[
    {id:1,eventKey:'private-internal-key',channel:'push',status:'uncertain',errorCode:'SEND_OUTCOME_UNKNOWN',attempts:1,createdAt:'2026-11-03T05:00:00Z'},
    {id:2,eventKey:'other-key',channel:'telegram',status:'error',errorCode:'TELEGRAM_NOT_LINKED',createdAt:'2026-11-03T05:10:00Z'},
    {id:3,eventKey:'secret-key',channel:'push',status:'error',errorCode:'UNKNOWN_SECRET_VALUE',createdAt:'bad-date'}
  ]}):undefined});await flush();const text=f.byId('notification-list').textContent;
  assert.match(text,/Push/);assert.match(text,/Telegram/);assert.match(text,/Результат отправки не подтверждён/);assert.match(text,/не привязан/);assert.match(text,/2026/);
  assert.equal(text.includes('private-internal-key'),false);assert.equal(text.includes('UNKNOWN_SECRET_VALUE'),false);assert.equal(text.includes('Invalid Date'),false);
});
test('перевод existing account предупреждает о замене прав и компаний до кнопки',async t=>{
  const f=fixture(t,{owner:true});await flush();const form=f.byId('member-adopt-form'),warning=f.byId('member-adopt-warning'),button=form.querySelector('button');
  assert.match(warning.textContent,/Прежние права и компании будут заменены/);assert.match(warning.textContent,/данные и пароль сохранятся/);
  assert.equal(button.getAttribute('aria-describedby'),warning.id);assert.ok(warning.compareDocumentPosition(button)&f.w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(f.calls.some(call=>call.options.method==='PUT'),false);
});
test('новое правило по умолчанию считает согласованное на следующую неделю, якорь необязателен',async t=>{
  const f=fixture(t,{owner:true,handler:async route=>route.startsWith('/content/people/friday-rule')?response({rule:{}}):undefined});await flush();const form=f.byId('friday-form');
  assert.equal(form.elements.metric.value,'approvedIdeas');assert.equal(form.elements.weekMode.value,'nextWeek');assert.equal(form.elements.minimum.value,'7');assert.equal(form.elements.weekday.value,'5');assert.equal(form.elements.weekStart.required,false);
  form.elements.userId.value='7';form.elements.timezone.value='Asia/Irkutsk';form.elements.weekStart.value='2026-11-02';form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();
  const call=f.calls.find(call=>call.options.method==='PUT'&&call.route.startsWith('/content/people/friday-rule')),body=JSON.parse(call.options.body);
  assert.equal(body.weekStart,'');assert.equal(body.weekMode,'nextWeek');assert.equal(body.minimum,7);assert.equal(body.weekday,5);
  form.elements.weekMode.value='anchored';form.elements.weekMode.dispatchEvent(new f.w.Event('change'));assert.equal(form.elements.weekStart.required,true);assert.equal(f.byId('week-anchor-label').hidden,false);
});
test('owner выдаёт право согласования только явным сохранением',async t=>{
  const f=fixture(t,{owner:true});await flush();const member=f.byId('member-list'),checkbox=member.querySelector('[type="checkbox"]'),form=member.querySelector('form');
  assert.equal(checkbox.checked,false);assert.equal(f.calls.some(call=>call.route.endsWith('/approval')),false);checkbox.checked=true;
  form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();const call=f.calls.find(call=>call.route.endsWith('/approval'));
  assert.equal(call.route,'/content/people/members/7/approval');assert.equal(call.options.headers['x-csrf-token'],'csrf-test');assert.deepEqual(JSON.parse(call.options.body),{companyCode:'alvi',enabled:true});
});
const planSnapshot={companyCode:'alvi',brief:{revision:4},plan:{revision:8,briefRevision:4,days:[{ideaId:'idea-1',date:'2026-11-09',topic:'Тема публикации',variants:{vk:{text:'Полный текст <img src=x>\nВторая строка',contentRevision:3}}}]},variants:[{ideaId:'idea-1',platform:'vk',status:'pending'}]};
test('без права согласования страница не получает тексты плана',async t=>{
  const f=fixture(t);await flush();assert.equal(f.byId('tab-plan').hidden,true);assert.equal(f.calls.some(call=>call.route.startsWith('/content/people/plan')),false);
});
test('согласующий видит полные тексты и возвращает идею с комментарием, CSRF и версиями',async t=>{
  const f=fixture(t,{permissions:['content-plan.approve'],handler:async(route,options)=>route.startsWith('/content/people/plan')?response({snapshot:planSnapshot}):undefined});await flush();
  assert.equal(f.byId('tab-plan').hidden,false);assert.match(f.byId('plan-list').textContent,/Полный текст <img src=x>/);assert.equal(f.byId('plan-list').querySelector('img'),null);
  const form=f.byId('plan-list').querySelector('form'),reject=form.querySelector('button[value="rejected"]');form.dispatchEvent(new f.w.SubmitEvent('submit',{cancelable:true,submitter:reject}));await flush();
  assert.match(f.byId('plan-message').textContent,/Напишите причину/);assert.equal(f.calls.some(call=>call.options.method==='POST'),false);
  form.elements.comment.value='Уточнить предложение';form.dispatchEvent(new f.w.SubmitEvent('submit',{cancelable:true,submitter:reject}));await flush();
  const call=f.calls.find(call=>call.options.method==='POST');assert.equal(call.route,'/content/people/plan/decision?companyCode=alvi');assert.equal(call.options.headers['x-csrf-token'],'csrf-test');
  assert.deepEqual(JSON.parse(call.options.body),{planRevision:8,briefRevision:4,scope:'idea',decision:'rejected',comment:'Уточнить предложение',ideaId:'idea-1'});
  assert.equal(f.calls.some(call=>/autoposting|publish/.test(call.route)),false);
});
test('при неизвестном результате согласования нет повтора и комментарий остаётся',async t=>{
  const f=fixture(t,{permissions:['content-plan.approve'],handler:async(route,options)=>{if(route.startsWith('/content/people/plan')){if(options.method==='POST')throw Error('network');return response({snapshot:planSnapshot});}}});await flush();
  const form=f.byId('plan-list').querySelector('form'),reject=form.querySelector('button[value="rejected"]');form.elements.comment.value='Сохранённый комментарий';form.dispatchEvent(new f.w.SubmitEvent('submit',{cancelable:true,submitter:reject}));await flush();
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);assert.equal(form.elements.comment.value,'Сохранённый комментарий');assert.match(f.byId('plan-message').textContent,/не подтверждён/);
});
test('поздний ответ прежней компании не заменяет новый проект',async t=>{
  let release;const delayed=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,{handler:async route=>{
    if(route==='/content/people/tasks?companyCode=alvi')return delayed;
    if(route==='/content/people/tasks?companyCode=avokado')return response({tasks:[task({id:44,title:'Только Авокадо',company_code:'avokado'})]});
  }});
  await flush();f.byId('company').value='avokado';f.byId('company').dispatchEvent(new f.w.Event('change'));await flush();
  assert.match(f.byId('task-list').textContent,/Только Авокадо/);
  release(response({tasks:[task({title:'Старый ответ ALVI'})]}));await flush();
  assert.equal(f.byId('task-list').textContent.includes('Старый ответ'),false);
});
test('изменение статуса использует revision и CSRF без расширения полей',async t=>{
  const f=fixture(t);await flush();f.byId('task-list').querySelector('button').click();await flush();
  assert.match(f.byId('task-purpose').textContent,/7 публикаций/);
  const form=f.byId('task-status-form');form.elements.status.value='done';form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();
  const call=f.calls.find(call=>call.options.method==='PATCH');assert.ok(call);assert.equal(call.options.headers['x-csrf-token'],'csrf-test');
  assert.deepEqual(JSON.parse(call.options.body),{status:'done',revision:3});
});
test('унаследованная видимость ветки не даёт редактировать её статус',async t=>{
  const f=fixture(t,{tasks:[task({canEdit:false})]});await flush();f.byId('task-list').querySelector('button').click();await flush();
  assert.equal(f.byId('task-status-form').hidden,true);assert.match(f.byId('task-message').textContent,/назначенному исполнителю/);
  f.byId('task-status-form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();assert.equal(f.calls.some(call=>call.options.method==='PATCH'),false);
});
test('неизвестный результат не повторяет запись и сохраняет выбранный статус',async t=>{
  const f=fixture(t,{handler:async(route,options)=>{if(options.method==='PATCH')throw Error('network');}});await flush();f.byId('task-list').querySelector('button').click();await flush();
  const form=f.byId('task-status-form');form.elements.status.value='done';form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();
  assert.equal(f.calls.filter(call=>call.options.method==='PATCH').length,1);assert.equal(form.elements.status.value,'done');assert.match(f.byId('task-message').textContent,/не подтверждён/);
});
test('401 открывает вход, пароль при ошибке сохраняется и не уходит в storage',async t=>{
  const f=fixture(t,{contextStatus:401,handler:async(route,options)=>route==='/content/login'?response({},401):undefined});await flush();assert.equal(f.byId('login-panel').hidden,false);
  const form=f.byId('login-form');form.elements.login.value='worker';form.elements.password.value='private-input';form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();
  assert.equal(form.elements.password.value,'private-input');assert.equal(f.w.localStorage.length,0);assert.equal(f.w.sessionStorage.length,0);
});
test('owner создаёт human_executor только по явной форме, без отправки приглашения',async t=>{
  const f=fixture(t,{owner:true,handler:async(route,options)=>route==='/content/people/members'&&options.method==='POST'?response({member:{id:8},temporaryPassword:'one-time-secret',expiresAt:'2026-11-07T12:00:00Z'}):undefined});await flush();assert.equal(f.byId('tab-owner').hidden,false);
  const form=f.byId('member-create-form');form.elements.displayName.value='Новый исполнитель';form.elements.login.value='worker_new';assert.equal(form.elements.password,undefined);
  form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();const call=f.calls.find(call=>call.options.method==='POST');
  assert.equal(call.route,'/content/people/members');assert.deepEqual(JSON.parse(call.options.body),{companyCode:'alvi',displayName:'Новый исполнитель',login:'worker_new',staffRole:'human_executor'});
  assert.equal(f.byId('temporary-password').querySelectorAll('output').length,1);assert.match(f.byId('temporary-password').textContent,/one-time-secret/);assert.match(f.byId('temporary-password').textContent,/Действует до/);
  f.byId('temporary-password').querySelector('button').click();assert.equal(f.byId('temporary-password').textContent,'');
  assert.equal(f.w.localStorage.length,0);assert.equal(f.w.sessionStorage.length,0);assert.equal(f.calls.some(call=>/invite|send/.test(call.route)),false);
});
test('новый временный пароль очищается при смене проекта, выходе и уходе со страницы',async t=>{
  const f=fixture(t,{owner:true,handler:async route=>route.endsWith('/temp-password')?response({temporaryPassword:'reset-secret',expiresAt:'2026-11-07T12:00:00Z'}):undefined});await flush();
  const reset=()=>[...f.byId('member-list').querySelectorAll('button')].find(button=>button.textContent==='Новый временный пароль').click();
  reset();await flush();const call=f.calls.find(call=>call.route.endsWith('/temp-password'));
  assert.deepEqual(JSON.parse(call.options.body),{companyCode:'alvi'});assert.equal(call.options.headers['x-csrf-token'],'csrf-test');assert.match(f.byId('temporary-password').textContent,/reset-secret/);
  f.byId('company').value='avokado';f.byId('company').dispatchEvent(new f.w.Event('change'));assert.equal(f.byId('temporary-password').textContent,'');await flush();
  reset();await flush();f.w.dispatchEvent(new f.w.PageTransitionEvent('pagehide'));assert.equal(f.byId('temporary-password').textContent,'');
  reset();await flush();f.byId('logout').click();await flush();assert.equal(f.byId('temporary-password').textContent,'');assert.equal(f.byId('workspace').hidden,true);
});
test('поздний сброс пароля не заменяет результат последней операции',async t=>{
  let release;const delayed=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,{owner:true,handler:async(route,options)=>{
    if(route==='/content/people/members?companyCode=alvi')return response({members:[{id:7,displayName:'Первый',login:'one'},{id:8,displayName:'Второй',login:'two'}]});
    if(route.endsWith('/7/temp-password'))return delayed;
    if(route.endsWith('/8/temp-password'))return response({temporaryPassword:'current-secret'});
  }});await flush();const buttons=[...f.byId('member-list').querySelectorAll('button')].filter(button=>button.textContent==='Новый временный пароль');
  buttons[0].click();buttons[1].click();await flush();release(response({temporaryPassword:'outdated-secret'}));await flush();
  assert.equal(f.byId('temporary-password').querySelector('output').textContent,'current-secret');assert.equal(f.byId('temporary-password').textContent.includes('outdated-secret'),false);
});
const restricted=()=>response({error:'Нужно сменить пароль',details:{mustChangePassword:true,csrfToken:'restricted-csrf'}},403);
test('первый вход и повторное открытие требуют личный пароль; проверка и смена используют CSRF',async t=>{
  let changed=false,rejectPassword=false;const f=fixture(t,{handler:async(route,options)=>{
    if(route==='/content/people/context'&&!changed)return restricted();
    if(route==='/content/password'){if(rejectPassword)return response({error:'Новый пароль должен отличаться от временного.'},400);changed=true;return response({ok:true});}
  }});await flush();assert.equal(f.byId('password-panel').hidden,false);assert.equal(f.byId('workspace').hidden,true);assert.equal(f.byId('logout').hidden,false);
  await f.w.SynapsePeople.initialize();assert.equal(f.byId('password-panel').hidden,false);assert.equal(f.calls.some(call=>call.route.startsWith('/content/people/tasks')),false);
  const form=f.byId('password-form'),submit=async()=>{form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();};
  form.elements.password.value='short';form.elements.confirmation.value='short';await submit();assert.match(f.byId('password-error').textContent,/10 символов/);
  form.elements.password.value='personal-password';form.elements.confirmation.value='different-password';await submit();assert.match(f.byId('password-error').textContent,/не совпадают/);assert.equal(f.calls.some(call=>call.route==='/content/password'),false);
  form.elements.confirmation.value='personal-password';rejectPassword=true;await submit();assert.match(f.byId('password-error').textContent,/отличаться/);assert.equal(form.elements.password.value,'personal-password');
  rejectPassword=false;await submit();const call=f.calls.find(call=>call.route==='/content/password');assert.equal(call.options.headers['x-csrf-token'],'restricted-csrf');assert.deepEqual(JSON.parse(call.options.body),{password:'personal-password'});
  assert.equal(f.byId('password-panel').hidden,true);assert.equal(f.byId('workspace').hidden,false);assert.equal(form.elements.password.value,'');assert.equal(form.elements.confirmation.value,'');assert.equal(f.w.localStorage.length,0);assert.equal(f.w.sessionStorage.length,0);
});
test('любой restricted 403 скрывает открытый кабинет, выход обходит операции push и очищает поля',async t=>{
  let restrictedNow=false,pushLookups=0;const f=fixture(t,{setup:w=>Object.defineProperty(w.navigator,'serviceWorker',{value:{getRegistration:async()=>{pushLookups++;}}}),handler:async route=>restrictedNow&&route.startsWith('/content/people/tasks/')?restricted():undefined});await flush();
  restrictedNow=true;f.byId('task-list').querySelector('button').click();await flush();assert.equal(f.byId('workspace').hidden,true);assert.equal(f.byId('password-panel').hidden,false);assert.equal(f.byId('task-list').textContent,'');
  f.byId('password-form').elements.password.value='private-draft';f.byId('password-form').elements.confirmation.value='private-draft';f.byId('logout').click();await flush();
  assert.equal(pushLookups,0);const call=f.calls.find(call=>call.route==='/content/logout');assert.equal(call.options.headers['x-csrf-token'],'restricted-csrf');assert.equal(f.byId('password-panel').hidden,true);assert.equal(f.byId('login-panel').hidden,false);assert.equal(f.byId('password-form').elements.password.value,'');assert.equal(f.byId('password-form').elements.confirmation.value,'');
});
test('push подключается только явной кнопкой, отказ разрешения не создаёт подписку',async t=>{
  let permissions=0,registrations=0;
  const f=fixture(t,{setup:w=>{w.PushManager=function(){};w.Notification={requestPermission:async()=>{permissions++;return 'denied';}};
    Object.defineProperty(w.navigator,'serviceWorker',{value:{register:async()=>{registrations++;}}});}});
  await flush();assert.equal(permissions,0);assert.equal(registrations,0);f.byId('enable-push').click();await flush();
  assert.equal(permissions,1);assert.equal(registrations,0);assert.equal(f.calls.some(call=>call.route.startsWith('/content/people/subscriptions')),false);
  assert.match(f.byId('push-status').textContent,/не разрешены/);
});
test('logout не отписывает чужой endpoint после отказа сервера',async t=>{
  let unsubscribed=0;
  const f=fixture(t,{setup:w=>{Object.defineProperty(w.navigator,'serviceWorker',{value:{getRegistration:async()=>({pushManager:{getSubscription:async()=>({endpoint:'https://push.example.invalid/current',unsubscribe:async()=>{unsubscribed++;}})}})}});},
    handler:async(route,options)=>route.startsWith('/content/people/subscriptions')&&options.method==='DELETE'?response({},403):undefined});
  await flush();f.byId('logout').click();await flush();
  assert.equal(unsubscribed,0);assert.equal(f.calls.some(call=>call.route==='/content/logout'),false);
  assert.equal(f.byId('workspace').hidden,false);assert.match(f.byId('global-message').textContent,/Нет доступа/);
});
function serviceWorker({context,contextStatus=200,data}={}) {
  const handlers={},shown=[],opened=[],calls=[];
  const self={location:{origin:'https://synapse.synapsebusiness.ru'},registration:{showNotification:async(title,options)=>shown.push({title,options})},clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)},addEventListener:(type,handler)=>{handlers[type]=handler;}};
  vm.runInNewContext(sw,{self,URL,fetch:async(route,options)=>{calls.push({route,options});return response(context,contextStatus);}});
  return {shown,opened,calls,async push(){let pending;handlers.push({data:{json:()=>data},waitUntil:p=>{pending=p;}});await pending;},async click(){let pending;handlers.notificationclick({notification:{close(){},data:{url:'https://attacker.invalid'}},waitUntil:p=>{pending=p;}});await pending;}};
}
test('SW не показывает личный текст другому пользователю или после выхода',async()=>{
  const data={audienceUserId:7,companyCode:'alvi',title:'Личная задача',body:'Закрытые сведения'};
  for(const context of [{user:{id:8},companies:[{id:'alvi'}]},{user:{id:7},companies:[{id:'avokado'}]},null]){
    const f=serviceWorker({context,contextStatus:context?200:401,data});await f.push();assert.equal(f.shown[0].title,'Synapse Business');assert.equal(f.shown[0].options.body.includes('Закрытые'),false);assert.equal(f.calls[0].options.cache,'no-store');
  }
});
test('SW для текущего адресата показывает текст, а клик игнорирует внешний URL',async()=>{
  const f=serviceWorker({context:{user:{id:7},companies:[{id:'alvi'}]},data:{audienceUserId:7,companyCode:'alvi',title:'Пятница',body:'На согласовании 6',url:'https://attacker.invalid'}});
  await f.push();assert.equal(f.shown[0].title,'Пятница');await f.click();assert.deepEqual(f.opened,['https://synapse.synapsebusiness.ru/cabinet/people.html']);
});
test('manifest устанавливает точку входа людей, worker не перехватывает страницы',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'people.webmanifest'),'utf8'));
  assert.equal(manifest.start_url,'/cabinet/people.html');assert.equal(manifest.scope,'/cabinet/');assert.equal(sw.includes("addEventListener('fetch'"),false);
});
