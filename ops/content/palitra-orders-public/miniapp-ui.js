(function(root,build){'use strict';const api=build();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'PalitraMiniappUI',{value:api,writable:false});})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const GROUPS=[['all','Все заявки'],['in_work','В работе'],['refused','Отказы'],['completed','Завершённые']];
 const ref=value=>{const m=/^(native-order|thread|legacy):([1-9]\d*)$/.exec(value||'');return m?{kind:m[1],id:Number(m[2])}:null};
 function create({document:doc,window:win,api,telegram=null,workflowFactory=null,draftStoreFactory=null,sourceReportFactory=null,sourceLabel=null}){
  const h=(tag,props={},...children)=>{const el=doc.createElement(tag);for(const [k,v]of Object.entries(props)){if(v===undefined||v===null)continue;if(k==='class')el.className=v;else if(k==='text')el.textContent=v;else if(k==='dataset')Object.assign(el.dataset,v);else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);else if(['value','disabled','hidden','type','placeholder'].includes(k))el[k]=v;else el.setAttribute(k,String(v));}for(const x of children.flat())if(x!==undefined&&x!==null)el.append(typeof x==='string'?doc.createTextNode(x):x);return el};
  const root=doc.getElementById('miniapp'),drafts=new Map(),urls=new Set(),panelObservers=new Set();
  let boot=null,store=null,view='orders',filter='in_work',search='',target=null,epoch=0,queueSerial=0,helpTimer=0,helpPop=null,poll=null,chatNodes=null,busy=false,workflow=null,disposed=false,queueItems=[],nextCursor=null,renderedMessages=[],olderCursor=null,olderBusy=false,uploads={enabled:false},sourceReport=null,unreadCount=null,unreadBusy=false;
  const staff=()=>boot?.role==='staff',key=t=>staff()&&t.conversationRef?t.conversationRef:`native-order:${t.orderId}`;
  const canWrite=()=>!staff()||boot.identity?.role==='owner'||boot.identity?.permissions?.includes('crm.edit');
  const canReply=()=>canWrite()&&(!staff()||Boolean(target?.conversationRef));
  function unreadBadge(){return h('span',{class:'tg-unread',dataset:{unreadCounter:''},text:unreadCount===null?'—':String(unreadCount),'aria-label':unreadCount===null?'Счётчик сообщений недоступен':`Непрочитанных сообщений: ${unreadCount}`})}
  function paintUnread(value){unreadCount=Number.isSafeInteger(value)&&value>=0?value:null;for(const n of root.querySelectorAll('[data-unread-counter]')){n.textContent=unreadCount===null?'—':String(unreadCount);n.setAttribute('aria-label',unreadCount===null?'Счётчик сообщений недоступен':`Непрочитанных сообщений: ${unreadCount}`)}}
  async function refreshUnread(){if(!staff()||unreadBusy||disposed)return;unreadBusy=true;const current=epoch;try{const result=await api.request('unread',{});if(current!==epoch)return;paintUnread(result.unreadMessages);
   const counts=new Map(result.items.map(item=>[item.ref,item.unreadMessages]));for(const card of root.querySelectorAll('[data-read-ref]')){const badge=card.querySelector('[data-card-unread]'),value=counts.get(card.dataset.readRef)||0;if(badge){badge.hidden=value===0;badge.textContent=String(value);badge.setAttribute('aria-label',`Непрочитанных сообщений: ${value}`)}}
  }catch{if(current===epoch)paintUnread(null)}finally{unreadBusy=false}}
  const draft=()=>{const k=key(target);if(!drafts.has(k))drafts.set(k,{text:'',file:null,pending:null});return drafts.get(k)};
  const persist=(d,k)=>store?store.save(k,d):Promise.resolve();
  function saveDraft(){if(!target)return;const d=draft(),current=epoch;void persist(d,key(target)).catch(e=>{if(current===epoch)showError(e)})}
  async function restoreDraft(next){const k=key(next);if(drafts.has(k)||!store)return;const data=await store.load(k);if(!data)return;
   if(data.pending&&(data.pending.kind==='text'&&(data.pending.body?.orderId!==next.orderId||data.pending.body?.conversationRef!==next.conversationRef)||!['file','text'].includes(data.pending.kind)))throw new Error('Черновик относится к другой переписке. Отправка остановлена.');
   drafts.set(k,{text:typeof data.text==='string'?data.text:'',pending:data.pending||null,file:data.file?new win.File([data.file.blob],data.file.name,{type:data.file.type,lastModified:data.file.lastModified}):null});
  }
  function closeHelp(){if(helpPop){helpPop.remove();helpPop=null;}win.clearTimeout(helpTimer)}
  function help(text,label='Пояснение'){
   const button=h('button',{type:'button',class:'tg-help','aria-label':label,'aria-expanded':'false',text:'?'});
   button.addEventListener('click',()=>{closeHelp();button.setAttribute('aria-expanded','true');const box=h('aside',{class:'tg-help-pop',role:'region','aria-label':label},h('p',{text}),h('button',{type:'button','aria-label':'Закрыть пояснение',text:'×',onclick:()=>{closeHelp();button.setAttribute('aria-expanded','false')}}));doc.body.append(box);helpPop=box;const r=button.getBoundingClientRect();box.style.left=Math.max(8,Math.min(r.left,win.innerWidth-328))+'px';box.style.top=Math.min(r.bottom+8,Math.max(8,win.innerHeight-box.offsetHeight-80))+'px';helpTimer=win.setTimeout(()=>{closeHelp();button.setAttribute('aria-expanded','false')},6000)});return button;
  }
  const button=(text,click,cls='app-btn app-btn--ghost')=>h('button',{type:'button',class:cls,text,onclick:click});
  function errorBox(text){return h('p',{class:'app-error tg-error',role:'alert',text})}
  function roundSharedRefresh(panel){const paint=()=>{for(const b of panel.querySelectorAll('button'))if(/^Обновить(?:\s|$)/.test(b.textContent.trim())){const label=b.textContent.trim();b.setAttribute('aria-label',label);b.setAttribute('title',label);b.classList.add('tg-refresh');b.textContent='🔄'}};paint();if(typeof win.MutationObserver==='function'){const observer=new win.MutationObserver(paint);observer.observe(panel,{childList:true,subtree:true});panelObservers.add(observer)}}
  function title(text,back=false){const refresh=button('🔄',()=>view==='chat'?refreshChat():view==='reports'?refreshReports():loadOrders(false),'tg-refresh');refresh.setAttribute('aria-label','Обновить');refresh.setAttribute('title','Обновить');return h('header',{class:'tg-head'},back?button('‹',orders,'tg-back'):button('☰',menu,'tg-back'),h('strong',{text}),refresh)}
  function showError(e){if(disposed)return;if(chatNodes)chatNodes.status.replaceChildren(errorBox(e.message||'Не удалось выполнить запрос'));else root.append(errorBox(e.message||'Не удалось выполнить запрос'))}
  function cleanupView(){closeHelp();for(const observer of panelObservers)observer.disconnect();panelObservers.clear();sourceReport?.dispose();sourceReport=null;for(const dialog of doc.querySelectorAll('[data-miniapp-file-dialog]'))dialog.remove();for(const url of urls)win.URL.revokeObjectURL(url);urls.clear();chatNodes=null;renderedMessages=[];olderCursor=null;olderBusy=false;uploads={enabled:false};epoch++;}
  function orders(){cleanupView();view='orders';target=null;telegram?.BackButton?.hide?.();const head=title(staff()?'Заказы':'Мои заказы');if(staff())head.querySelector('strong').append(' ',unreadBadge());root.replaceChildren(head);const panel=h('section',{class:'tg-orders tg-orders--queue'});root.append(panel);
   if(staff()){
    panel.append(h('div',{class:'tg-groups',role:'group','aria-label':'Разделы заявок'},GROUPS.map(([id,label])=>button(label,()=>{filter=id;orders()},'tg-tab'+(id===filter?' is-current':'')))));
    const input=h('input',{type:'search',value:search,placeholder:'Клиент или номер заказа','aria-label':'Поиск по клиенту и номеру заказа'});
    panel.append(h('form',{class:'tg-search',onsubmit:e=>{e.preventDefault();search=input.value;loadOrders(false)}},input,h('button',{type:'submit',class:'app-btn',text:'Найти'})));
   }
   panel.append(h('div',{id:'tg-list',class:'tg-list','aria-live':'polite'}));void loadOrders(false);
  }
  async function loadOrders(append){
   if(view!=='orders'||disposed)return;const serial=++queueSerial,savedEpoch=epoch,list=doc.getElementById('tg-list');if(!list)return;
   const status=h('p',{class:'muted',role:'status',text:'Загружаем…'});if(!append)list.replaceChildren(status);else list.append(status);
   try{
    const result=await api.request('orders',staff()?{filter,limit:30,...(search?{search}:{}),...(append&&nextCursor?{cursor:nextCursor}:{})}:{});
    if(serial!==queueSerial||epoch!==savedEpoch||view!=='orders')return;
    const items=staff()?result.items:result.orders;if(!Array.isArray(items))throw new Error('Сервер не подтвердил список заказов');
    queueItems=append?[...queueItems,...items]:items;nextCursor=staff()?result.nextCursor:null;if(staff())paintUnread(result.unreadStatus==='ready'?result.unreadMessages:null);list.replaceChildren();
    if(!queueItems.length)list.append(h('p',{class:'app-empty',text:staff()?'Заявок в этом разделе пока нет.':'Подтверждённые заказы пока не найдены. Откройте ссылку «Продолжить в Telegram» в чате вашего заказа на сайте.'}));
    for(const item of queueItems){
     const order=staff()?ref(item.orderRef):{id:item.orderId},conversation=staff()?(item.lastMessage?.conversationRef||item.threadRef||item.dialogRef):undefined;
     const orderId=order?.id??null,label=orderId?`Заказ №${orderId}`:'Обращение без заказа';
     const stage=item.workflow?.label||item.stage?.label||item.nativeStage?.label||(!staff()?'':item.workflowState==='uninitialized'?'Новый заказ':'Этап не задан');
     const unread=staff()?item.unreadMessages:null,source=staff()&&sourceLabel?sourceLabel(item):item.sourceLabel||item.attribution?.label||null;
     const card=button('',()=>openChat(staff()?{orderId,conversationRef:conversation}:{orderId}),'tg-order-card');
     if(staff()&&typeof item.key==='string')card.dataset.readRef=item.key;
     card.append(h('span',{class:'tg-order-card__line'},h('strong',{text:item.customerLabel||item.name||'Palitra Love'}),source?h('small',{class:'tg-source',text:source}):null),
      h('span',{class:'tg-order-card__line'},h('span',{text:label}),staff()?h('span',{class:'tg-unread',dataset:{cardUnread:''},hidden:!(typeof unread==='number'&&unread>0),'aria-label':`Непрочитанных сообщений: ${unread??'недоступно'}`,text:String(unread??'—')}):null));
     if(stage)card.append(h('small',{class:'tg-stage',text:stage}));
     const previewText=typeof item.lastMessage?.text==='string'?item.lastMessage.text:'';
     if(previewText.trim())card.append(h('p',{class:'tg-snippet',text:previewText}));
     if(staff()&&!conversation&&!orderId)card.disabled=true;list.append(card);
    }
    if(staff()&&result.unreadStatus==='unavailable')list.append(h('p',{class:'muted',text:'Счётчик сообщений пока недоступен.'}));
    if(nextCursor)list.append(button('Показать ещё',()=>loadOrders(true)));
   }catch(e){if(serial===queueSerial&&epoch===savedEpoch){paintUnread(null);list.replaceChildren(errorBox(e.message),button('Повторить загрузку',()=>loadOrders(append)))}}
  }
  function menu(){const old=view;cleanupView();const panel=h('section',{class:'tg-menu'},h('h1',{text:'Меню'}));const prefix=boot.identity?.role==='owner'?'A':'S',base='https://synapse.synapsebusiness.ru/cabinet/palitra-orders/cabinet.html';
   const orderButton=button(staff()?'Заказы':'Мои заказы',orders);if(staff())orderButton.append(' ',unreadBadge());panel.append(orderButton);
   const site=h('details',{class:'settings-tree__section'},h('summary',{text:'Сайт'}),h('a',{class:'app-btn app-btn--ghost',href:'https://palitra-love.ru/',target:'_blank',rel:'noopener noreferrer',text:'Открыть сайт ↗'}));panel.append(site);
   if(staff()){
    const link=(label,hash)=>h('a',{class:'app-btn app-btn--ghost',href:base+'#'+hash,target:'_blank',rel:'noopener noreferrer',text:label+' ↗'});
    site.append(link('Редактор фотографий на сайте',prefix+'06'),link('Редактор прайса на сайте',prefix+'07'));
    panel.append(link('Прайс',prefix+'07'),button('Отчёты',reports));if(boot.identity?.role==='owner'||boot.identity?.permissions?.includes('autoposting.view'))panel.append(link('Контент',prefix+'_CONTENT_TASKS'));panel.append(link('Рабочий чат',prefix+'_TEAM_CHAT'));
    const settings=h('details',{class:'settings-tree__section'},h('summary',{text:'Настройки'}),help('Дополнительные разделы открываются в рабочем приложении. При необходимости войдите в свой рабочий аккаунт.','О разделах рабочего приложения'));
    if(boot.identity?.role==='owner')settings.append(link('Чат на сайте','A_SITE_CHAT_SETTINGS'));
    if(boot.identity?.role==='owner')settings.append(link('Заказы: автоответ, этапы и памятка','A10'));settings.append(link('Установка и уведомления',prefix+'_APP_SETTINGS'));panel.append(settings);
   }
   view='menu';root.replaceChildren(title('Палитра',true),panel);telegram?.BackButton?.show?.();
  }
  function reports(){if(!staff())return;cleanupView();view='reports';telegram?.BackButton?.show?.();const current=epoch,panel=h('section',{class:'tg-orders'});root.replaceChildren(title('Отчёты',true),panel);
   if(!sourceReportFactory){panel.append(errorBox('Обновите приложение: отчёт источников ещё не загружен.'));return;}
   sourceReport=sourceReportFactory({h:(tag,props,...children)=>h(tag,tag==='button'&&props?.text==='Обновить'?{...props,text:'🔄',class:'tg-refresh','aria-label':'Обновить'}:props,...children),win,read:({signal,...range})=>api.request('sources',range,{signal}),help,isCurrent:()=>!disposed&&view==='reports'&&epoch===current});panel.append(sourceReport.element);
   if(workflow){const funnel=workflow.funnelReportPanel();if(funnel){panel.append(funnel);roundSharedRefresh(funnel);funnel.querySelector('button')?.click();}}
  }
  function refreshReports(){sourceReport?.refresh();root.querySelector('[data-funnel-report] button')?.click();}
  async function openChat(next){
   cleanupView();view='chat';target=Object.freeze({...next});const current=epoch;root.replaceChildren(title(next.orderId?`Заказ №${next.orderId}`:'Обращение',true),h('p',{class:'app-empty',role:'status',text:'Открываем переписку…'}));
   try{
    await restoreDraft(next);if(current!==epoch||view!=='chat')return;
    if(!staff())await api.request('select',{orderId:next.orderId});
    const noChat=staff()&&!next.conversationRef;
    const [history,order]=await Promise.all([noChat?Promise.resolve({messages:[],uploads:{enabled:false}}):api.request('conversation',next),next.orderId?api.request('order',{orderId:next.orderId}):Promise.resolve(null)]);
    if(current!==epoch||view!=='chat')return;
    const frame=h('section',{class:'tg-chat'}),top=h('div',{class:'tg-chat-top'}),messages=h('div',{class:'tg-messages',role:'log','aria-label':'Переписка','aria-live':'polite'}),status=h('div',{class:'tg-status'});
    if(order){const composition=h('pre',{class:'tg-composition',text:order.composition?.text||''});
     if(staff()&&workflow&&order.orderId){const panel=workflow.orderPanel(order.orderId,{compact:true,detailsContent:()=>composition.cloneNode(true)});if(panel){top.append(panel);roundSharedRefresh(panel)}}
     else top.append(h('span',{class:'tg-stage',text:order.workflow?.label||'Новый заказ'}),h('details',{},h('summary',{text:'Мой заказ'}),composition));
    }else if(staff()&&workflow&&/^thread:[1-9]\d*$/.test(next.conversationRef||'')){const panel=workflow.orderPanel(next.conversationRef,{compact:true});if(panel){top.append(panel);roundSharedRefresh(panel)}}else top.append(h('span',{class:'tg-stage',text:'Обращение без заказа'}));
    const d=draft(),input=h('textarea',{rows:'1',class:'chat__input',placeholder:'Написать сообщение','aria-label':'Написать сообщение',value:d.text});
    const file=h('input',{type:'file',hidden:true,'aria-label':'Выбрать вложение'}),chosen=h('div',{class:'tg-file'});
    const paper=button('📎',()=>file.click(),'tg-paper');paper.setAttribute('aria-label','Прикрепить файл');
    const send=h('button',{type:'submit',class:'tg-send',text:'Отправить'}),form=h('form',{class:'tg-compose',onsubmit:e=>{e.preventDefault();void submit(false)}},file,paper,input,send);
    frame.append(top,messages,status,chosen,form);root.replaceChildren(title(next.orderId?`Заказ №${next.orderId}`:'Обращение',true),frame);
    chatNodes={frame,top,messages,status,chosen,input,send,paper,file};
    input.addEventListener('input',()=>{if(busy||d.pending||!canWrite())return;d.text=input.value;saveDraft();syncClosing()});file.addEventListener('change',()=>{if(busy||d.pending||!canWrite()||!uploads.enabled)return;if(file.files?.[0])d.file=file.files[0];saveDraft();renderDraft();syncClosing()});
    if(!canWrite())status.append(h('p',{class:'muted',text:'Доступ только для просмотра.'}));
    if(noChat)status.append(h('p',{class:'muted',text:'У этого заказа пока нет переписки. Контакты и состав — в подробностях выше.'}));
    messages.addEventListener('scroll',markVisible,{passive:true});renderHistory(history);renderDraft();telegram?.BackButton?.show?.();syncClosing();
   }catch(e){if(current===epoch)root.replaceChildren(title(next.orderId?`Заказ №${next.orderId}`:'Обращение',true),errorBox(e.message),button('Повторить открытие',()=>openChat(next)))}
  }
  function renderDraft(){if(!chatNodes)return;const d=draft();chatNodes.input.value=d.text;chatNodes.input.readOnly=busy||Boolean(d.pending)||!canReply();chatNodes.chosen.replaceChildren();
   if(d.file)chatNodes.chosen.append(h('span',{text:d.file.name}),button('Убрать',()=>{if(!busy&&!d.pending){d.file=null;saveDraft();renderDraft();syncClosing()}}));
   chatNodes.send.disabled=busy||!canReply();chatNodes.paper.disabled=busy||Boolean(d.pending)||!canReply()||uploads.enabled!==true;chatNodes.file.disabled=chatNodes.paper.disabled;
   chatNodes.status.querySelector('[data-pending-controls]')?.remove();if(d.pending&&!busy)chatNodes.status.append(h('div',{dataset:{pendingControls:''}},button('Проверить переписку',()=>refreshChat()),...(canWrite()?[button('Повторить тот же запрос',()=>submit(true))]:[])));
  }
  function renderHistory(history,older=false){if(!chatNodes)return;const list=chatNodes.messages,oldTop=list.scrollTop,oldHeight=list.scrollHeight,initial=list.childElementCount===0,nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<60;
   const rows=Array.isArray(history.messages)?history.messages:[],merged=new Map(renderedMessages.map(m=>[m.id,m]));for(const m of rows)merged.set(m.id,m);renderedMessages=[...merged.values()].sort((a,b)=>a.id-b.id);
   if(initial||older)olderCursor=history.nextBefore??null;if(!older)uploads=history.uploads||{enabled:false};list.replaceChildren();
   if(olderCursor)list.append(button(olderBusy?'Загружаем…':'Ранние сообщения',loadEarlier,'app-btn app-btn--ghost tg-earlier'));
   for(const m of renderedMessages){const author=m.author||m.authorType||m.authorKind,customer=['customer','client'].includes(author),mine=staff()?!customer:customer;
    const row=h('article',{class:'chat__msg '+(mine?'is-mine':'is-theirs'),dataset:{messageId:String(m.id),incoming:String(m.direction==='in'&&customer)}},h('small',{class:'chat__meta',text:customer?'Клиент':author==='system'?'Palitra Love':'Менеджер'}),h('p',{class:'chat__text',text:m.displayText||m.text||''}));
    for(const a of m.attachments||[]){const fileRef=a.ref||(typeof a.id==='string'?a.id:(target.conversationRef?.startsWith('legacy:')||history.dialogRef?'legacy:':'thread:')+a.id);row.append(button(a.name||'Открыть вложение',()=>openFile(fileRef,a.name)));}
    if(m.createdAt&&Number.isFinite(Date.parse(m.createdAt)))row.append(h('time',{dateTime:m.createdAt,text:new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'}).format(new Date(m.createdAt))}));list.append(row);
   }
   if(older)list.scrollTop=oldTop+list.scrollHeight-oldHeight;else if(nearBottom||initial)list.scrollTop=list.scrollHeight;else list.scrollTop=oldTop;
   win.requestAnimationFrame(()=>win.requestAnimationFrame(markVisible));
  }
  async function loadEarlier(){if(!chatNodes||!olderCursor||olderBusy)return;olderBusy=true;const current=epoch,saved=target,before=olderCursor;try{const history=await api.request('conversation',{...saved,before});if(current===epoch){olderBusy=false;renderHistory(history,true)}}catch(e){if(current===epoch){showError(e);renderDraft()}}finally{if(current===epoch)olderBusy=false}}
  async function refreshChat(){if(view!=='chat'||!target||!chatNodes||busy||staff()&&!target.conversationRef)return;const current=epoch,saved=target;try{const history=await api.request('conversation',saved);if(current===epoch){renderHistory(history);renderDraft()}}catch(e){if(current===epoch){showError(e);renderDraft()}}}
  let readBusy=false;const readThrough=new Map();
  async function markVisible(){
   if(!staff()||!chatNodes||doc.hidden||telegram?.isActive===false||view!=='chat'||readBusy)return;const list=chatNodes.messages,r=list.getBoundingClientRect(),bottom=Math.min(r.bottom,win.visualViewport?.height||win.innerHeight);
   const ids=[...list.querySelectorAll('[data-incoming="true"]')].filter(node=>{const b=node.getBoundingClientRect();return b.bottom>r.top&&b.bottom<=bottom&&b.top<bottom}).map(n=>Number(n.dataset.messageId));
   const through=Math.max(0,...ids),k=key(target);if(!through||(readThrough.get(k)||0)>=through)return;readBusy=true;
   try{await api.request('read',{...target,throughMessageId:through});readThrough.set(k,through)}catch{}finally{readBusy=false}
  }
  async function submit(retry){
   if(!chatNodes||busy||!target||!canReply())return;const d=draft(),saved=target,current=epoch;if(d.pending&&!retry)return;
   if(!d.pending&&!d.text.trim()&&!d.file)return;
   const selectedFile=d.file,text=d.text;
   if(selectedFile&&(!uploads.enabled||selectedFile.size>Math.min(20*1024*1024,uploads.maxBytes||20*1024*1024))){showError(new Error('Вложение недоступно или файл превышает допустимый размер.'));return;}
   busy=true;chatNodes.status.replaceChildren(h('p',{role:'status',text:'Отправляем…'}));renderDraft();
   try{
    if(!d.pending){
     if(selectedFile){const data=await selectedFile.arrayBuffer(),sha=await win.crypto.subtle.digest('SHA-256',data);
      d.pending={kind:'file',body:{requestId:win.crypto.randomUUID(),name:selectedFile.name,size:selectedFile.size,sha256:[...new Uint8Array(sha)].map(x=>x.toString(16).padStart(2,'0')).join(''),caption:text}};
     }else d.pending={kind:'text',body:{...saved,requestId:win.crypto.randomUUID(),text}};
    }
    await persist(d,key(saved));
    if(d.pending.kind==='text')await api.request('message',d.pending.body);
    else{const prepared=await api.request('upload-prepare',{...saved,body:d.pending.body}),id=prepared.upload.ref.slice(7);const state=await api.request('upload-status',{...saved,uuid:id});
     if(state.upload.state!=='committed')await api.upload({...saved,uuid:id},d.file);
    }
    d.text='';d.file=null;d.pending=null;await persist(d,key(saved));if(current===epoch&&chatNodes){chatNodes.status.replaceChildren();chatNodes.file.value='';renderDraft();}
   }catch(e){if(!e.unknown&&e.status>=400&&e.status<500){d.pending=null;void persist(d,key(saved)).catch(()=>{})}if(current===epoch){chatNodes?.status.replaceChildren(errorBox(e.message));renderDraft();}}
   finally{busy=false;if(chatNodes){renderDraft();syncClosing();if(current===epoch)await refreshChat();}}
  }
  async function openFile(fileRef,name){const saved=target,current=epoch;try{const blob=await api.file({...saved,ref:fileRef});if(current!==epoch)return;const url=win.URL.createObjectURL(blob);urls.add(url);const box=h('dialog',{class:'tg-file-dialog',dataset:{miniappFileDialog:''}}),close=()=>{box.close();box.remove();win.URL.revokeObjectURL(url);urls.delete(url)};
    box.append(button('Закрыть',close));if(blob.type.startsWith('image/'))box.append(h('img',{src:url,alt:name||'Вложение'}));else if(blob.type.startsWith('video/'))box.append(h('video',{src:url,controls:true}));else if(blob.type.startsWith('audio/'))box.append(h('audio',{src:url,controls:true}));
    box.append(h('a',{href:url,download:name||'Вложение',class:'app-btn',text:'Скачать файл'}));box.addEventListener('cancel',e=>{e.preventDefault();close()});doc.body.append(box);box.showModal();
   }catch(e){if(current===epoch)showError(e)}}
  function syncClosing(){const dirty=[...drafts.values()].some(d=>d.text||d.file||d.pending);if(dirty)telegram?.enableClosingConfirmation?.();else telegram?.disableClosingConfirmation?.();}
  function viewport(){const visible=win.visualViewport?.height||win.innerHeight,stable=Number(telegram?.viewportStableHeight)||visible;doc.documentElement.style.setProperty('--tg-app-height',Math.min(visible,stable)+'px')}
  async function start(){root.replaceChildren(h('p',{class:'app-empty',role:'status',text:'Открываем Палитру…'}));
   try{const nextBoot=await api.connect();if(disposed)return;if(boot&&boot.draftScope!==nextBoot.draftScope){cleanupView();drafts.clear();await store?.close();store=null;}boot=nextBoot;if(draftStoreFactory&&!store)store=draftStoreFactory({indexedDB:win.indexedDB,scope:boot.draftScope});
    if(staff()&&workflowFactory){workflow=workflowFactory({document:doc,window:win,request:async(path,options={})=>{if(path==='/content/palitra/workflow/funnel-report')return api.request('funnel',{});const t=/^\/content\/palitra\/workflow\/threads\/([1-9]\d*)(?:\/(confirm|advance|stage))?$/.exec(path);if(t)return api.request('stage',{conversationRef:`thread:${t[1]}`,...(t[2]?{action:{type:t[2]==='stage'?'set-stage':t[2],body:options.body}}:{})});const m=/^\/content\/palitra\/workflow\/orders\/([1-9]\d*)(?:\/(confirm|advance|stage))?$/.exec(path);if(!m)throw new Error('Настройки открываются в рабочем приложении');const orderId=Number(m[1]);return m[2]?api.request('stage',{orderId,action:{type:m[2]==='stage'?'set-stage':m[2],body:options.body}}):(await api.request('order',{orderId})).workflow;},onChanged:()=>{if(target)void openChat(target)},onUnauthorized:showError});
     workflow.setIdentity({key:'telegram-staff:'+boot.identity.userId,role:boot.identity.role,member:boot.identity.companies.includes('palitra-love'),permissions:boot.identity.permissions});}
    telegram?.ready?.();telegram?.expand?.();telegram?.BackButton?.onClick?.(orders);win.addEventListener('resize',viewport);win.visualViewport?.addEventListener('resize',viewport);viewport();
    const params=new URL(win.location.href).searchParams,selected=Number(params.get('order'));
    if(Number.isSafeInteger(selected)&&selected>0){
     if(!staff())await openChat({orderId:selected});
     else{const pointer=params.get('chat'),list=pointer?null:await api.request('orders',{filter:'all',search:'№ '+selected,limit:100}),item=list?.items.find(x=>x.orderRef===`native-order:${selected}`),conversationRef=pointer||item?.lastMessage?.conversationRef||item?.threadRef||item?.dialogRef;
      if(conversationRef&&(!ref(conversationRef)||ref(conversationRef).kind==='native-order'))throw new Error('Переписка не найдена');await openChat({orderId:selected,...(conversationRef?{conversationRef}:{})});}
    }else if(staff()&&ref(params.get('chat'))&&ref(params.get('chat')).kind!=='native-order')await openChat({orderId:null,conversationRef:params.get('chat')});
    else orders();
    poll=win.setInterval(()=>{if(doc.hidden||telegram?.isActive===false)return;if(view==='chat')void refreshChat();else if(staff()&&['orders','menu'].includes(view))void refreshUnread()},5000);
   }catch(e){root.replaceChildren(errorBox(e.message),button('Проверить вход',()=>start()))}}
  function dispose(){disposed=true;win.clearInterval(poll);cleanupView();win.removeEventListener('resize',viewport);win.visualViewport?.removeEventListener('resize',viewport);telegram?.BackButton?.offClick?.(orders);void store?.close().catch(()=>{});}
  return Object.freeze({start,dispose});
 }
 return Object.freeze({create});
});
