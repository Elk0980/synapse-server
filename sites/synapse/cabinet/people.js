'use strict';
(() => {
  const statusLabels = {inbox:'Входящие',planned:'Запланировано',in_progress:'В работе',done:'Готово',cancelled:'Отменено'};
  const $ = id => document.getElementById(id);
  const state = {context:null,company:'',epoch:0,identityEpoch:0,taskEpoch:0,activeTask:null,preferences:null,pushPublicKey:'',tab:'tasks',snapshot:null};
  const message = (id,text,error=false) => {const node=$(id);node.textContent=text || '';node.hidden=!text;node.classList.toggle('error',error);};
  const node = (tag,text,className) => {const element=document.createElement(tag);if(text!==undefined)element.textContent=String(text);if(className)element.className=className;return element;};
  const scoped = (path,company=state.company) => `${path}?companyCode=${encodeURIComponent(company)}`;
  const active = (epoch,company) => epoch===state.epoch && company===state.company && Boolean(state.context);
  const canApprove = () => state.context?.isOwner || state.context?.user?.permissions?.includes('content-plan.approve');
  const mutable = method => !['GET','HEAD'].includes(method);
  function failure(status,write=false) {
    if(status===401)return 'Войдите в кабинет ещё раз. Ваши данные в форме сохранены.';
    if(status===403)return 'Нет доступа к этому действию. Обновите кабинет или обратитесь к владельцу.';
    if(status===404)return 'Запись недоступна в этом проекте. Обновите список.';
    if(status===409)return 'Данные изменились. Обновите кабинет перед следующим сохранением.';
    if(status===400 || status===422)return 'Проверьте заполненные поля и выбранный проект.';
    return write?'Результат сохранения не подтверждён. Обновите кабинет и проверьте запись перед повтором.':'Не удалось загрузить данные. Попробуйте обновить кабинет.';
  }
  async function api(path,{method='GET',body}={}) {
    const controller = new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try {
      const response = await fetch(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
        headers:{accept:'application/json',...(body!==undefined?{'content-type':'application/json'}:{}),
          ...(mutable(method)&&state.context?.csrfToken?{'x-csrf-token':state.context.csrfToken}:{})},
        ...(body!==undefined?{body:JSON.stringify(body)}:{})});
      if(!response.ok)throw Object.assign(Error(failure(response.status,mutable(method))),{status:response.status,userVisible:true});
      return response.status===204?{}:await response.json();
    } catch(error) {
      if(Number.isInteger(error.status))throw error;
      throw Object.assign(Error(failure(0,mutable(method))),{userVisible:true});
    } finally {clearTimeout(timer);}
  }
  async function busy(form,work,messageId='global-message') {
    const epoch=state.epoch,company=state.company;
    const buttons=[...form.querySelectorAll('[type="submit"]')],disabled=buttons.map(button=>button.disabled);
    if(form.dataset.busy==='true')return;
    form.dataset.busy='true';for(const button of buttons)button.disabled=true;
    try {await work();}catch(error){if(messageId==='login-error'||active(epoch,company))message(messageId,error.message,true);}
    finally {delete form.dataset.busy;buttons.forEach((button,index)=>{button.disabled=disabled[index];});}
  }
  function progress(task) {
    if(typeof task.percent==='number'&&Number.isFinite(task.percent))return Math.min(100,Math.max(0,Math.round(task.percent)));
    const total=Math.max(0,Number(task.subtask_count)||0),done=Math.max(0,Number(task.subtask_done)||0);
    const milestones=task.coordination?.milestones || {};
    const confirmed=['code','connected','verified','accepted'].filter(key=>milestones[key]?.state==='confirmed').length;
    return total?Math.min(100,Math.round(done/total*100)):confirmed*25;
  }
  function progressElement(task) {
    const wrapper=node('div'),bar=node('div',undefined,'progress'),fill=node('span');
    fill.style.width=`${progress(task)}%`;bar.append(fill);
    wrapper.append(bar,node('span',task.subtask_count?`${task.subtask_done || 0} из ${task.subtask_count} · ${progress(task)}%`:`${progress(task)}% по подтверждённым этапам`,'muted'));
    return wrapper;
  }
  function renderTasks(tasks) {
    $('task-list').replaceChildren();$('task-count').textContent=String(tasks.length);
    if(!tasks.length){$('task-list').append(node('p','В этом проекте вам пока ничего не назначено.','muted'));return;}
    for(const task of tasks) {
      const button=node('button',undefined,'task-card');button.type='button';button.dataset.taskId=String(task.id);
      button.append(node('strong',task.title || `Задача №${task.id}`));
      if(task.purpose)button.append(node('p',task.purpose,'muted task-card-purpose'));
      const meta=node('span',undefined,'task-meta');meta.append(node('span',statusLabels[task.status] || task.status,'pill'),node('span',`№${task.id}`));
      const assignment=String(task.assigneeName || task.assignee_name || '');
      const personKey=/^person:(\d+)$/.exec(assignment);
      const responsible=personKey?(Number(personKey[1])===state.context?.user?.id?state.context.user.displayName:'Назначенный исполнитель'):assignment;
      if(responsible)meta.append(node('span',`Ответственный: ${responsible}`));
      button.append(meta,progressElement(task));
      button.addEventListener('click',()=>{void openTask(task.id,button);});$('task-list').append(button);
    }
  }
  function renderPreferences(data) {
    state.preferences=data.preferences || {enabled:false,push:false,telegram:false};state.pushPublicKey=data.pushPublicKey || '';
    for(const field of ['enabled','push','telegram'])$('preferences-form').elements[field].checked=state.preferences[field]===true;
    $('enable-push').disabled=!pushAvailable();$('disable-push').disabled=!('serviceWorker' in navigator);
    if(!pushAvailable())message('push-status','Push недоступен в этом браузере. На iPhone откройте установленное приложение с экрана «Домой».');
    else message('push-status','');
  }
  function renderNotifications(data) {
    const list=$('notification-list');list.replaceChildren();
    const items=data.items || [];
    if(!items.length){list.textContent='Пока нет уведомлений.';return;}
    const channels={push:'Push',telegram:'Telegram'};
    const statuses={pending:'Ожидает отправки',sending:'Отправляется',sent:'Передано службе уведомлений',uncertain:'Результат отправки не подтверждён',error:'Не отправлено',cancelled:'Отправка отменена'};
    const errors={SEND_OUTCOME_UNKNOWN:'Перед повтором нужно проверить результат отправки.',PUSH_NOT_CONFIGURED:'Push ещё не настроен владельцем.',TELEGRAM_NOT_CONFIGURED:'Telegram ещё не настроен владельцем.',
      TELEGRAM_NOT_LINKED:'Аккаунт Telegram ещё не привязан к этому проекту.',ACCESS_OR_CONSENT_REVOKED:'Доступ или согласие на уведомления отозваны.',UNSUBSCRIBED:'Подписка на устройстве отключена.',
      SUBSCRIPTION_EXPIRED:'Подписка на устройстве истекла. Подключите push заново.',PROVIDER_REJECTED:'Служба уведомлений отклонила отправку.',INVALID_SUBSCRIPTION:'Подписка устройства недействительна. Подключите push заново.'};
    for(const item of items){
      const row=node('div',undefined,'notification-row');row.append(node('strong',channels[item.channel] || 'Уведомление'),node('p',statuses[item.status] || 'Состояние пока недоступно.'));
      const at=new Date(item.createdAt || item.updatedAt || '');
      if(Number.isFinite(at.valueOf()))row.append(node('span',new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short'}).format(at),'muted'));
      if(item.errorCode)row.append(node('p',errors[item.errorCode] || 'Не удалось обработать уведомление. Обратитесь к владельцу.','muted'));
      list.append(row);
    }
  }
  function renderMembers(data) {
    const list=$('member-list'),select=$('friday-form').elements.userId,previous=select.value;list.replaceChildren();select.replaceChildren(node('option','Выберите человека'));
    select.options[0].value='';
    const members=data.members || [];
    if(!members.length)list.append(node('p','В этом проекте пока нет подключённых людей.','muted'));
    for(const member of members){
      const row=node('div',undefined,'member-row');row.append(node('strong',member.displayName),node('span',`${member.login} · №${member.id}`,'muted'));
      if(member.executorKey)row.append(node('span',`Для назначения задач: ${member.executorKey}`,'muted'));list.append(row);
      if(state.context?.isOwner){
        const form=node('form'),label=node('label',undefined,'check'),checkbox=node('input'),save=node('button','Сохранить право');
        checkbox.type='checkbox';checkbox.checked=member.canApprovePlan===true;checkbox.setAttribute('aria-label',`Согласование плана: ${member.displayName}`);
        label.append(checkbox,document.createTextNode('Согласование контент-плана'));save.type='submit';form.append(label,save);row.append(form);
        form.addEventListener('submit',event=>{event.preventDefault();const company=state.company,epoch=state.epoch;void busy(form,async()=>{
          await api(`/content/people/members/${member.id}/approval`,{method:'PUT',body:{companyCode:company,enabled:checkbox.checked}});
          if(active(epoch,company))message('global-message','Право согласования сохранено. Другие действия с публикациями не разрешены.');
        });});
      }
      const option=node('option',member.displayName);option.value=String(member.id);select.append(option);
    }
    select.value=previous;
  }
  function renderRule(data) {
    const rule=data.rule || {},form=$('friday-form');form.elements.enabled.checked=rule.enabled===true;
    const defaults={metric:'approvedIdeas',minimum:7,weekday:5,weekMode:'nextWeek',weekStart:'',morningHour:9,eveningHour:18};
    for(const field of ['userId','timezone','metric','weekStart','morningHour','eveningHour','minimum','weekday','weekMode']){
      const value=rule[field] ?? defaults[field];if(value!==undefined)form.elements[field].value=String(value);
    }
    syncWeekMode();
  }
  function syncWeekMode(){const anchored=$('friday-form').elements.weekMode.value==='anchored';$('week-anchor-label').hidden=!anchored;$('friday-form').elements.weekStart.required=anchored;}
  function renderPlan(data) {
    const snapshot=data.snapshot || data,statePlan=snapshot.plan;state.snapshot=snapshot;const list=$('plan-list');list.replaceChildren();message('plan-message','');
    if(!statePlan?.days?.length){list.append(node('p','План ещё не составлен.','muted'));return;}
    const fresh=statePlan.briefRevision===snapshot.brief?.revision;
    if(!fresh)message('plan-message','Бриф изменился. Сначала обновите план; прежнюю версию согласовать нельзя.',true);
    const decisions={approved:'Согласовано',pending:'На согласовании',rejected:'Возвращено',needs_reapproval:'Нужно пересогласовать',excluded:'Исключено'};
    const decisionForm=(scope,ideaId)=>{
      const form=node('form'),label=node('label','Комментарий'),comment=node('textarea'),actions=node('div',undefined,'decision-actions');
      comment.name='comment';comment.rows=2;comment.maxLength=2000;label.append(comment);form.append(label);
      for(const [value,title] of [['approved',scope==='plan'?'Согласовать весь план':'Согласовать'],['rejected','Вернуть']]){
        const button=node('button',title,value==='approved'?'primary':'');button.type='submit';button.value=value;button.disabled=!fresh;actions.append(button);
      }
      form.append(actions);form.addEventListener('submit',event=>{event.preventDefault();const decision=event.submitter?.value || 'approved';
        if(!fresh)return;if(decision==='rejected'&&!comment.value.trim()){message('plan-message','Напишите причину возврата. Текст комментария сохранится при ошибке.',true);comment.focus();return;}
        const company=state.company,epoch=state.epoch;void busy(form,async()=>{
          const body={planRevision:statePlan.revision,briefRevision:snapshot.brief.revision,scope,decision,comment:comment.value.trim(),...(scope==='idea'?{ideaId}:{})};
          const result=await api(scoped('/content/people/plan/decision',company),{method:'POST',body});
          if(!active(epoch,company))return;
          const next=result.snapshot?result:await api(scoped('/content/people/plan',company));
          if(active(epoch,company)){renderPlan(next);message('plan-message',decision==='approved'?'Согласование сохранено.':'План возвращён с комментарием.');}
        },'plan-message');
      });return form;
    };
    const activeIdeas=[];
    for(const idea of statePlan.days){
      const article=node('article',undefined,'card plan-idea');article.append(node('p',idea.date || '','eyebrow'),node('h3',idea.topic || idea.title || 'Публикация'));
      let included=false;
      for(const [platform,variant] of Object.entries(idea.variants || {})){
        const version=node('section',undefined,'plan-variant'),status=snapshot.variants?.find(item=>item.ideaId===idea.ideaId&&item.platform===platform);
        version.append(node('h4',platform));if(variant.excluded)version.append(node('p','Исключено из плана.','muted'));
        else if(variant.text?.trim())included=true;
        if(status?.status)version.append(node('p',decisions[status.status] || 'Нужно проверить согласование','muted'));
        if(variant.hook || idea.hook)version.append(node('p',variant.hook || idea.hook,'plan-text'));
        version.append(node('p',variant.text || 'Текст ещё не заполнен.','plan-text'));article.append(version);
      }
      if(included){activeIdeas.push(idea.ideaId);article.append(decisionForm('idea',idea.ideaId));}
      list.append(article);
    }
    if(activeIdeas.length){const card=node('div',undefined,'card');card.append(node('h3','Решение по всему плану'),decisionForm('plan'));list.append(card);}
  }
  async function loadCompany() {
    const company=state.company,epoch=++state.epoch;
    closeTask();state.preferences=null;state.pushPublicKey='';state.snapshot=null;$('task-list').replaceChildren();$('task-count').textContent='';$('plan-list').replaceChildren();message('plan-message','');
    $('member-list').replaceChildren();$('notification-list').replaceChildren();$('preferences-form').reset();$('friday-form').reset();
    $('member-create-form').reset();$('member-adopt-form').reset();message('friday-result','');message('push-status','');
    syncWeekMode();
    if(!company){message('global-message','Владелец ещё не назначил вам проект.');return;}
    message('global-message','Загружаем проект…');
    const calls=[['tasks',()=>api(scoped('/content/people/tasks',company))],['preferences',()=>api(scoped('/content/people/preferences',company))],['notifications',()=>api(scoped('/content/people/preview',company))]];
    if(state.context.isOwner)calls.push(['members',()=>api(scoped('/content/people/members',company))],['rule',()=>api(scoped('/content/people/friday-rule',company))]);
    if(canApprove())calls.push(['plan',()=>api(scoped('/content/people/plan',company))]);
    const results=await Promise.allSettled(calls.map(async([name,work])=>({name,data:await work()})));
    if(!active(epoch,company))return;
    const errors=[];
    // Список команды нужен до выбранного в правиле получателя.
    const successful=results.filter(result=>result.status==='fulfilled').map(result=>result.value);
    for(const name of ['tasks','preferences','notifications','members','rule','plan']){
      const result=successful.find(item=>item.name===name);if(!result)continue;
      if(name==='tasks')renderTasks(result.data.tasks || []);
      else if(name==='preferences')renderPreferences(result.data);
      else if(name==='notifications')renderNotifications(result.data);
      else if(name==='members')renderMembers(result.data);
      else if(name==='rule')renderRule(result.data);
      else if(name==='plan')renderPlan(result.data);
    }
    for(const result of results)if(result.status==='rejected')errors.push(result.reason.message);
    message('global-message',errors.length?[...new Set(errors)].join(' '):'',Boolean(errors.length));
  }
  function setTab(tab) {
    if(tab==='owner' && !state.context?.isOwner)return;
    if(tab==='plan' && !canApprove())return;
    state.tab=tab;
    for(const name of ['tasks','plan','settings','owner']){$(`${name}-panel`).hidden=name!==tab;$(`tab-${name}`).setAttribute('aria-pressed',String(name===tab));}
  }
  let returnFocus=null;
  function closeTask() {state.taskEpoch++;state.activeTask=null;$('task-overlay').hidden=true;document.body.classList.remove('sheet-open');returnFocus?.focus();returnFocus=null;}
  async function openTask(id,button) {
    const company=state.company,epoch=state.epoch,taskEpoch=++state.taskEpoch;
    try {
      const result=await api(scoped(`/content/people/tasks/${id}`,company));
      if(!active(epoch,company)||taskEpoch!==state.taskEpoch)return;
      const task=result.task;state.activeTask=task;returnFocus=button;
      $('task-title').textContent=task.title || `Задача №${task.id}`;$('task-description').textContent=task.description || '';
      const purpose=task.purpose || String(task.description || '').match(/^\s*ЦКП:\s*(.+)$/mi)?.[1] || '';$('task-purpose').textContent=purpose;$('task-purpose').hidden=!purpose;
      $('task-progress').replaceChildren(progressElement(task));$('task-status-form').elements.status.value=task.status;
      $('task-status-form').hidden=task.canEdit===false;
      $('task-children').replaceChildren();
      for(const child of task.subtasks || [])$('task-children').append(node('div',`${statusLabels[child.status] || child.status} · ${child.title}`,'child-row'));
      if(!task.subtasks?.length)$('task-children').append(node('p','Подзадач пока нет.','muted'));
      message('task-message',task.canEdit===false?'Изменение статуса доступно назначенному исполнителю.':'');$('task-overlay').hidden=false;document.body.classList.add('sheet-open');$('task-overlay').querySelector('.task-sheet').focus();
    }catch(error){if(active(epoch,company))message('global-message',error.message,true);}
  }
  function showLogin() {
    state.epoch++;state.identityEpoch++;state.taskEpoch++;state.context=null;state.company='';state.activeTask=null;state.preferences=null;state.pushPublicKey='';
    $('workspace').hidden=true;$('login-panel').hidden=false;$('logout').hidden=true;closeTask();message('global-message','');
    state.snapshot=null;$('plan-list').replaceChildren();$('task-list').replaceChildren();$('member-list').replaceChildren();$('notification-list').replaceChildren();$('member-create-form').reset();$('member-adopt-form').reset();$('friday-form').reset();$('preferences-form').reset();
  }
  async function initialize() {
    const identityEpoch=++state.identityEpoch;
    try {
      const context=await api('/content/people/context');
      if(identityEpoch!==state.identityEpoch)return;
      const previousCompany=state.company;
      state.context=context;$('login-panel').hidden=true;$('workspace').hidden=false;$('logout').hidden=false;
      $('person-name').textContent=context.user.displayName || context.user.login || '';
      $('tab-owner').hidden=!context.isOwner;$('tab-plan').hidden=!canApprove();$('company').replaceChildren();
      for(const company of context.companies || []){const option=node('option',company.name || company.id);option.value=company.id;$('company').append(option);}
      if([...$('company').options].some(option=>option.value===previousCompany))$('company').value=previousCompany;
      state.company=$('company').value;setTab('tasks');await loadCompany();
    }catch(error){if(identityEpoch!==state.identityEpoch)return;if(error.status===401)showLogin();else message('global-message',error.message,true);}
  }
  function pushAvailable(){return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;}
  function applicationKey(value) {
    const normalized=value.replace(/-/g,'+').replace(/_/g,'/'),padded=normalized+'='.repeat((4-normalized.length%4)%4),raw=atob(padded);
    return Uint8Array.from(raw,char=>char.charCodeAt(0));
  }
  async function enablePush() {
    if(!pushAvailable()){message('push-status','Push недоступен. На iPhone сначала установите приложение на экран «Домой».');return;}
    if(!state.pushPublicKey){message('push-status','Подключение push ещё не настроено владельцем.',true);return;}
    const company=state.company,epoch=state.epoch;let created=null;
    $('enable-push').disabled=true;
    try {
      // Разрешение запрашивается только этой кнопкой, пока сохранён жест пользователя.
      const permission=await Notification.requestPermission();
      if(!active(epoch,company))return;
      if(permission!=='granted'){message('push-status','Уведомления не разрешены. Изменить решение можно в настройках браузера.');return;}
      const registration=await navigator.serviceWorker.register('/cabinet/people-sw.js?v=20261103-people-1',{scope:'/cabinet/',updateViaCache:'none'});
      if(!registration.active){
        let timer;
        try{await Promise.race([navigator.serviceWorker.ready,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('WORKER_NOT_READY')),15000);})]);}
        finally{clearTimeout(timer);}
      }
      if(!active(epoch,company))return;
      let subscription=await registration.pushManager.getSubscription();
      if(!subscription){subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:applicationKey(state.pushPublicKey)});created=subscription;}
      if(!active(epoch,company)){if(created)await created.unsubscribe();return;}
      await api(scoped('/content/people/subscriptions',company),{method:'POST',body:subscription.toJSON()});
      if(active(epoch,company))message('push-status','Это устройство подключено. Получение уведомлений включается в настройках проекта выше.');
    }catch(error){if(active(epoch,company))message('push-status',error.userVisible?error.message:'Подключение устройства не подтверждено. Проверьте разрешение уведомлений и обновите кабинет.',true);}
    finally{if(active(epoch,company))$('enable-push').disabled=false;}
  }
  async function disablePush({silent=false}={}) {
    if(!('serviceWorker' in navigator))return;
    const company=state.company,epoch=state.epoch;
    const registration=await navigator.serviceWorker.getRegistration('/cabinet/');
    const subscription=await registration?.pushManager.getSubscription();
    if(!subscription){if(!silent)message('push-status','На этом устройстве нет подписки push.');return;}
    if(!active(epoch,company))return;
    await api(scoped('/content/people/subscriptions',company),{method:'DELETE',body:{endpoint:subscription.endpoint}});
    if(!active(epoch,company))return;
    await subscription.unsubscribe();
    if(!silent)message('push-status','Push на этом устройстве отключён. Настройки Telegram сохранены.');
  }
  $('login-form').addEventListener('submit',event=>{event.preventDefault();void busy(event.currentTarget,async()=>{
    const form=$('login-form');await api('/content/login',{method:'POST',body:{login:form.elements.login.value.trim(),password:form.elements.password.value}});
    form.elements.password.value='';message('login-error','');await initialize();
  },'login-error');});
  $('logout').addEventListener('click',()=>{void busy($('login-form'),async()=>{
    // Отписываем только endpoint текущего пользователя после подтверждения сервера.
    await disablePush({silent:true});await api('/content/logout',{method:'POST'});showLogin();
  });});
  $('company').addEventListener('change',()=>{state.company=$('company').value;void loadCompany();});
  $('refresh').addEventListener('click',()=>{void initialize();});
  for(const tab of ['tasks','plan','settings','owner'])$(`tab-${tab}`).addEventListener('click',()=>setTab(tab));
  $('preferences-form').addEventListener('submit',event=>{event.preventDefault();const company=state.company,epoch=state.epoch;void busy(event.currentTarget,async()=>{
    const form=$('preferences-form'),preferences=Object.fromEntries(['enabled','push','telegram'].map(key=>[key,form.elements[key].checked]));
    const result=await api(scoped('/content/people/preferences',company),{method:'PUT',body:preferences});
    if(active(epoch,company)){renderPreferences({...result,pushPublicKey:state.pushPublicKey});message('global-message','Настройки уведомлений сохранены.');}
  });});
  $('enable-push').addEventListener('click',()=>{void enablePush();});
  $('disable-push').addEventListener('click',async()=>{$('disable-push').disabled=true;try{await disablePush();}catch(error){message('push-status',error.message,true);}finally{$('disable-push').disabled=false;}});
  $('task-status-form').addEventListener('submit',event=>{event.preventDefault();const company=state.company,epoch=state.epoch,task=state.activeTask;if(!task || task.canEdit===false)return;void busy(event.currentTarget,async()=>{
    const result=await api(scoped(`/content/people/tasks/${task.id}`,company),{method:'PATCH',body:{status:$('task-status-form').elements.status.value,revision:task.coordination?.revision}});
    if(!active(epoch,company)||state.activeTask?.id!==task.id)return;
    state.activeTask=result.task || task;message('task-message','Статус сохранён.');
    const list=await api(scoped('/content/people/tasks',company));if(active(epoch,company))renderTasks(list.tasks || []);
  },'task-message');});
  $('close-task').addEventListener('click',closeTask);
  document.addEventListener('keydown',event=>{
    if($('task-overlay').hidden)return;
    if(event.key==='Escape')closeTask();
    if(event.key==='Tab'){
      const elements=[...$('task-overlay').querySelectorAll('button:not(:disabled),select,input,[tabindex="0"]')],first=elements[0],last=elements.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
  $('member-create-form').addEventListener('submit',event=>{event.preventDefault();const company=state.company,epoch=state.epoch;void busy(event.currentTarget,async()=>{
    const form=$('member-create-form');await api('/content/people/members',{method:'POST',body:{companyCode:company,displayName:form.elements.displayName.value.trim(),login:form.elements.login.value.trim(),password:form.elements.password.value,staffRole:'human_executor'}});
    if(!active(epoch,company))return;form.reset();const members=await api(scoped('/content/people/members',company));if(active(epoch,company)){renderMembers(members);message('global-message','Доступ создан. Приглашение не отправлялось.');}
  });});
  $('member-adopt-form').addEventListener('submit',event=>{event.preventDefault();const company=state.company,epoch=state.epoch;void busy(event.currentTarget,async()=>{
    const form=$('member-adopt-form'),id=Number(form.elements.userId.value);if(!Number.isSafeInteger(id)||id<1)throw Error('Укажите номер учётной записи.');
    await api(`/content/people/members/${id}`,{method:'PUT',body:{companyCode:company,staffRole:'human_executor'}});
    if(!active(epoch,company))return;form.reset();const members=await api(scoped('/content/people/members',company));if(active(epoch,company)){renderMembers(members);message('global-message','Учётная запись подключена к проекту.');}
  });});
  $('friday-form').addEventListener('submit',event=>{event.preventDefault();const company=state.company,epoch=state.epoch;void busy(event.currentTarget,async()=>{
    const form=$('friday-form'),rule={enabled:form.elements.enabled.checked,userId:Number(form.elements.userId.value),timezone:form.elements.timezone.value.trim(),metric:form.elements.metric.value,weekMode:form.elements.weekMode.value,weekStart:form.elements.weekMode.value==='anchored'?form.elements.weekStart.value:'',minimum:Number(form.elements.minimum.value),weekday:Number(form.elements.weekday.value),morningHour:Number(form.elements.morningHour.value),eveningHour:Number(form.elements.eveningHour.value)};
    const result=await api(scoped('/content/people/friday-rule',company),{method:'PUT',body:rule});
    if(active(epoch,company)){renderRule(result);message('global-message','Пятничное правило сохранено.');}
  });});
  $('friday-form').elements.weekMode.addEventListener('change',syncWeekMode);
  $('friday-preview').addEventListener('click',async()=>{
    const company=state.company,epoch=state.epoch;$('friday-preview').disabled=true;
    try{const result=await api(scoped('/content/people/friday-preview',company),{method:'POST'});if(!active(epoch,company))return;
      const summary=result.summary || {};
      message('friday-result',result.event?`${result.event.title}\n${result.event.body}`:summary.available===false?(summary.reason || 'Счётчик недоступен.'):`Количество: ${summary.count ?? 0}. Сейчас уведомление по правилу не требуется.`);
    }catch(error){if(active(epoch,company))message('friday-result',error.message,true);}finally{if(active(epoch,company))$('friday-preview').disabled=false;}
  });
  // Малый публичный интерфейс для проверки без браузерной автоматизации.
  window.SynapsePeople=Object.freeze({progress,initialize,pushAvailable});
  void initialize();
})();
