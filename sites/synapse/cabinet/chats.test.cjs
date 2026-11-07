'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const flush=async()=>{for(let n=0;n<10;n++)await new Promise(setImmediate);};
function load(options={}) {
  const dom=new JSDOM('<!doctype html><div id="host"></div><div id="dock"></div>',{runScripts:'outside-only',pretendToBeVisual:true,url:'https://cabinet.test/'});
  assert.equal(dom.window.document.hidden,false);
  const w=dom.window,defs=new Map(),calls=[],intervals=new Map(),mounted=new Map(),storageAccess=[];let open=false,timerId=0;
  w.setInterval=fn=>{const id=++timerId;intervals.set(id,fn);return id;};w.clearInterval=id=>intervals.delete(id);
  const storage=w.sessionStorage,proto=Object.getPrototypeOf(storage),raw={};
  for(const method of ['getItem','setItem','removeItem']){raw[method]=proto[method];proto[method]=function(...args){storageAccess.push([method,...args]);return raw[method].apply(this,args);};}
  w.SynapseModules={register:(id,d)=>defs.set(id,d),chat:{open(){open=true;mount(w.document.getElementById('dock'),'hugh-chat');},isOpen:()=>open,companyChanged(){mount(w.document.getElementById('dock'),'hugh-chat');}}};
  const state={viewerId:2,companyCode:'alvi',failSend:0,...options,messages:[{id:1,user_id:3,author_name:'Таня',text:'<img src=x onerror=alert(1)>',created_at:'2026-11-05T00:00:00Z'}],
    board:{companyCode:'alvi',assigned:[{id:11,title:'Первая',status:'inbox',priority:'high',from:'system'},{id:12,title:'Вторая',status:'in_progress',priority:'normal',from:'manager'}],hugh:[{id:13,title:'Поменяй план',status:'inbox',from:'me'}],deleted:[]}};
  const api={async get(p,params={}){calls.push(['GET',p,params]);
      if(p==='whoami')return state.contextGet?state.contextGet():{userId:state.contextViewerId??state.viewerId,csrfToken:`csrf-${state.contextViewerId??state.viewerId}`};
      if(p==='people/team-chat/rooms')return {viewerId:state.viewerId,common:'common',hugh:`hugh:${state.viewerId}`,people:[{id:3,name:'Таня',room:`dm:${[state.viewerId,3].sort((a,b)=>a-b).join('-')}`} ]};
      if(p==='people/team-chat')return state.chatGet?state.chatGet(params):{messages:params.room==='common'?(state.messagesByViewer?.[state.viewerId]??state.messages):[],hasMore:false,viewerId:state.viewerId,room:params.room};
      if(p==='people/my-board')return state.board;throw Object.assign(Error('404'),{status:404});},
    async post(p,body,params,options){calls.push(options===undefined?['POST',p,body]:['POST',p,body,options]);
      if(state.beforePost)await state.beforePost(p,body,options);
      return post(p,body);},url:p=>new w.URL(`/content/${p}`,w.location.href).href};
  function post(p,body){
    if(p==='people/team-chat'){if(state.failSend-->0)throw Object.assign(Error('unknown result'),{status:503});return {message:{id:50+calls.length,user_id:state.viewerId,author_name:'Лена',text:body.text,room:body.room,created_at:'2026-11-05T00:01:00Z',ref_task_id:body.taskId}};}
    if(p==='people/my-board/action'){const b=structuredClone(state.board);if(body.op==='delete'){b.deleted=b.hugh;b.hugh=[];}if(body.op==='order')b.assigned=body.order.map(id=>b.assigned.find(t=>t.id===id));return b;}
    throw Error(`Unexpected POST ${p}`);
  }
  w.fetch=async()=>{throw Error('Чат должен использовать ctx.api, прямой fetch запрещён');};
  const ctx=(id,opts)=>({moduleId:id,companyCode:opts.companyCode??state.companyCode,companyName:'ALVI',user:{id:state.viewerId,role:'editor'},signal:opts.controller.signal,route:{path:'',params:new w.URLSearchParams(opts.room?{room:opts.room}:{})},api,openHughChat(){}});
  function unmount(host){const prior=mounted.get(host);if(prior){defs.get(prior.id).unmount?.(prior.el);prior.controller.abort();mounted.delete(host);}}
  function mount(host,id,opts={}){unmount(host);const el=w.document.createElement('div'),controller=new w.AbortController(),context=ctx(id,{...opts,controller});host.replaceChildren(el);mounted.set(host,{el,id,controller,context});defs.get(id).mount(el,context);return el;}
  for(const file of ['chats.js','my-tasks.js'])w.eval(fs.readFileSync(path.join(__dirname,file),'utf8'));
  return {w,defs,calls,state,mount,unmount,storageAccess,context:host=>mounted.get(host)?.context,host:w.document.getElementById('host'),dock:w.document.getElementById('dock'),
    reload(){for(const host of [...mounted.keys()])unmount(host);w.eval(fs.readFileSync(path.join(__dirname,'chats.js'),'utf8'));},
    async poll(){for(const fn of [...intervals.values()])fn();await flush();},
    seed(key,value){raw.setItem.call(storage,key,typeof value==='string'?value:JSON.stringify(value));},
    saved(key){return JSON.parse(raw.getItem.call(storage,key)||'null');}};
}
test('модули регистрируются по контракту А; «Чаты»: комнаты, текст без HTML, отправка в выбранную комнату',async t=>{
  const f=load();t.after(()=>f.w.close());assert.deepEqual([...f.defs.keys()].sort(),['chats','hugh-chat','tasks']);
  f.mount(f.host,'chats');await flush();
  const rooms=[...f.host.querySelectorAll('.sbc-room')].map(b=>b.dataset.room);assert.deepEqual(rooms,['common','dm:2-3','hugh:2']);
  assert.equal(f.host.querySelector('img'),null);assert.match(f.host.querySelector('.sbc-msg__text').textContent,/<img/);
  f.host.querySelectorAll('.sbc-room')[1].click();await flush();
  f.host.querySelector('textarea').value='Лично';f.host.querySelector('form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();
  const sent=f.calls.find(c=>c[0]==='POST');assert.equal(sent[2].room,'dm:2-3');assert.equal(sent[2].text,'Лично');assert.ok(!('taskId' in sent[2]));
});
test('«Задачи»: разделы, перестановка, удаление в «Удалённые», чат по задаче уходит в лог с taskId',async t=>{
  const f=load();t.after(()=>f.w.close());f.mount(f.host,'tasks');await flush();
  const tabs=[...f.host.querySelectorAll('.sbt-tab')].map(t=>t.textContent);assert.deepEqual(tabs,['Мне поставили · 2','Я поставил Хью · 1','Удалённые · 0']);
  f.host.querySelector('[aria-label="Ниже: Первая"]').click();await flush();
  assert.equal(JSON.stringify(f.calls.at(-1)),JSON.stringify(['POST','people/my-board/action',{op:'order',section:'assigned',order:[12,11]}]));
  assert.deepEqual([...f.host.querySelectorAll('.sbt-item__title')].map(n=>n.textContent),['Вторая','Первая']);
  f.host.querySelectorAll('.sbt-tab')[1].click();
  [...f.host.querySelectorAll('.sbt-item button')].find(b=>b.textContent==='Удалить').click();await flush();
  assert.equal(JSON.stringify(f.calls.at(-1)[2]),JSON.stringify({op:'delete',taskId:13}));assert.match(f.host.querySelector('.sbt-tabs').textContent,/Удалённые · 1/);
  f.host.querySelectorAll('.sbt-tab')[0].click();
  [...f.host.querySelectorAll('.sbt-item button')].find(b=>b.textContent==='Чат с Хью').click();await flush();
  assert.match(f.dock.querySelector('.sbc-taskbar').textContent,/№11: Первая/);
  f.dock.querySelector('textarea').value='Уточнение';f.dock.querySelector('form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();
  const sent=f.calls.filter(c=>c[0]==='POST'&&c[1]==='people/team-chat').at(-1)[2];assert.equal(sent.room,'hugh:2');assert.equal(sent.taskId,11);
});
test('«Задачи»: перетаскивание меняет порядок тем же действием order',async t=>{
  const f=load();t.after(()=>f.w.close());f.mount(f.host,'tasks');await flush();
  const fire=(el,type)=>{const e=new f.w.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'dataTransfer',{value:{setData(){},effectAllowed:''}});el.dispatchEvent(e);};
  const [first,second]=f.host.querySelectorAll('.sbt-item');assert.equal(first.draggable,true);
  fire(second,'dragstart');fire(first,'dragover');fire(first,'drop');await flush();
  assert.equal(JSON.stringify(f.calls.at(-1)),JSON.stringify(['POST','people/my-board/action',{op:'order',section:'assigned',order:[12,11]}]));
});
test('экран #tasks: сотрудник видит свою доску, владелец — общую и ссылку «Мои задачи», карточка №id — прежний экран',async t=>{
  const dom=new JSDOM('<!doctype html><section id="tasks-view"><div class="content-header"><h1>Задачи</h1></div><div class="card"><div id="tasks-content"></div></div></section>',{runScripts:'outside-only',url:'https://cabinet.test/#tasks'});
  const w=dom.window;t.after(()=>w.close());const seen=[];
  w.SbCabinet={views:{tasks:{title:'Задачи',render(){seen.push('legacy');},onLeave(){seen.push('leave');},updateSummary(){}}}};
  w.SynapseModules={register(){},mount(host,id,o){seen.push(`${id}:${o.route.path}`);host.textContent='личная доска';return {unmount(){seen.push('unmount');}};}};
  w.eval(fs.readFileSync(path.join(__dirname,'my-tasks.js'),'utf8'));
  const view=w.SbCabinet.views.tasks,editor={identity:{role:'editor'}},owner={identity:{role:'owner'}};
  assert.equal(typeof view.updateSummary,'function');
  view.render(null,editor);assert.deepEqual(seen,['leave','tasks:mine']);assert.equal(w.document.querySelector('.content-header').hidden,true);
  w.location.hash='#tasks/42';view.render(null,editor);assert.deepEqual(seen.slice(2),['unmount','legacy']);assert.equal(w.document.querySelector('.content-header').hidden,false);
  w.location.hash='#tasks';seen.length=0;view.render(null,owner);assert.deepEqual(seen,['legacy']);
  const link=w.document.querySelector('.sbt-mine-link');assert.equal(link.getAttribute('href'),'#tasks/mine');assert.equal(link.hidden,false);
  w.location.hash='#tasks/mine';view.render(null,owner);assert.deepEqual(seen.slice(1),['leave','tasks:mine']);assert.equal(link.hidden,true);
  view.onLeave();assert.deepEqual(seen.slice(3),['unmount','leave']);
});

const draftKey=(viewer,company='alvi',room='common',task='')=>`sbc:v2:${viewer}:${company}:${room}:${task}`;
function writeDraft(f,host,value){const text=host.querySelector('textarea');assert.ok(text);text.value=value;text.dispatchEvent(new f.w.Event('input',{bubbles:true}));}
async function submit(f,host){host.querySelector('form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();}
const sends=f=>f.calls.filter(c=>c[0]==='POST'&&c[1]==='people/team-chat');

test('черновики Alice→Bob→Alice переживают полную перезагрузку модуля в одном sessionStorage',async t=>{
  const f=load({viewerId:7});t.after(()=>f.w.close());
  f.mount(f.host,'chats');await flush();writeDraft(f,f.host,'Черновик Alice');
  f.reload();f.state.viewerId=8;f.mount(f.host,'chats');await flush();
  assert.equal(f.host.querySelector('textarea').value,'');writeDraft(f,f.host,'Черновик Bob');
  f.reload();f.state.viewerId=7;f.mount(f.host,'chats');await flush();
  assert.equal(f.host.querySelector('textarea').value,'Черновик Alice');
  assert.equal(f.saved(draftKey(7)).text,'Черновик Alice');assert.equal(f.saved(draftKey(8)).text,'Черновик Bob');
  assert.equal(sends(f).length,0);
});

test('старый viewerless sbc ключ не читается, не перезаписывается и не удаляется',async t=>{
  const f=load({viewerId:7});t.after(()=>f.w.close());const legacy='sbc:alvi:common:';
  const value={text:'Чужой исторический черновик',pending:{text:'Не отправлять',clientMessageId:'legacy-id',room:'common'}};
  f.seed(legacy,value);f.mount(f.host,'chats');await flush();assert.equal(f.host.querySelector('textarea').value,'');
  writeDraft(f,f.host,'Новый личный');f.unmount(f.host);
  assert.deepEqual(f.saved(legacy),value);assert.equal(f.storageAccess.some(c=>c[1]===legacy),false);assert.equal(sends(f).length,0);
});

test('до разрешения viewerId чат не трогает storage и блокирует отправку',async t=>{
  const f=load({viewerId:7});t.after(()=>f.w.close());let resolve;
  f.state.chatGet=()=>new Promise(done=>{resolve=done;});f.mount(f.host,'chats');await flush();
  assert.equal(f.storageAccess.length,0);assert.equal(f.host.querySelector('button[type=submit]').disabled,true);
  f.host.querySelector('textarea').value='Не отправлять до идентификации';await submit(f,f.host);
  assert.equal(sends(f).length,0);assert.equal(f.storageAccess.length,0);
  resolve({viewerId:7,room:'common',messages:[],hasMore:false});await flush();
  assert.equal(f.host.querySelector('button[type=submit]').disabled,false);
});

test('некорректный viewerId не открывает composer и не создаёт анонимный storage',async t=>{
  for(const viewerId of [undefined,null,0,-1,1.5,'7']){
    const f=load({viewerId});try{
      f.mount(f.host,'chats');await flush();const button=f.host.querySelector('button[type=submit]');assert.ok(button);
      assert.equal(button.disabled,true,`viewerId=${String(viewerId)}`);f.host.querySelector('textarea').value='Не отправлять';await submit(f,f.host);
      assert.equal(sends(f).length,0);assert.equal(f.storageAccess.length,0);
    }finally{f.w.close();}
  }
});

test('смена viewer при poll убирает старую переписку, сохраняет Alice и восстанавливает Bob без POST',async t=>{
  const msg=(id,text)=>({id,user_id:id,author_name:'Автор',text,created_at:'2026-11-05T00:00:00Z'});
  const f=load({viewerId:7});t.after(()=>f.w.close());f.state.messagesByViewer={7:[msg(71,'Секрет Alice')],8:[msg(81,'Сообщение Bob')]};
  f.seed(draftKey(8),{text:'Черновик Bob',pending:null});f.mount(f.host,'chats');await flush();writeDraft(f,f.host,'Черновик Alice');
  f.state.viewerId=8;await f.poll();assert.doesNotMatch(f.host.querySelector('.sbc-messages').textContent,/Секрет Alice/);
  assert.match(f.host.querySelector('.sbc-messages').textContent,/Сообщение Bob/);assert.equal(f.host.querySelector('textarea').value,'Черновик Bob');
  assert.equal(f.saved(draftKey(7)).text,'Черновик Alice');assert.equal(sends(f).length,0);
  f.state.viewerId=7;await f.poll();assert.equal(f.host.querySelector('textarea').value,'Черновик Alice');assert.doesNotMatch(f.host.querySelector('.sbc-messages').textContent,/Сообщение Bob/);
});

test('черновики разделены по компании, комнате и задаче; старый mount сохраняет захваченную компанию',async t=>{
  const f=load({viewerId:7});t.after(()=>f.w.close());f.mount(f.host,'chats');await flush();writeDraft(f,f.host,'Общий ALVI');
  f.host.querySelector('[data-room="dm:3-7"]').click();await flush();assert.equal(f.host.querySelector('textarea').value,'');writeDraft(f,f.host,'Личный ALVI');
  f.state.companyCode='other';f.context(f.host).companyCode='other';writeDraft(f,f.host,'Личный ALVI');f.mount(f.host,'chats');await flush();assert.equal(f.host.querySelector('textarea').value,'');writeDraft(f,f.host,'Общий OTHER');
  assert.equal(f.saved(draftKey(7,'alvi','common')).text,'Общий ALVI');assert.equal(f.saved(draftKey(7,'alvi','dm:3-7')).text,'Личный ALVI');
  f.state.companyCode='alvi';f.w.SynapseHughChat.open({task:{id:11,title:'Первая'}});await flush();writeDraft(f,f.dock,'Задача 11');
  f.w.SynapseHughChat.open({task:{id:12,title:'Вторая'}});await flush();assert.equal(f.dock.querySelector('textarea').value,'');writeDraft(f,f.dock,'Задача 12');
  f.w.SynapseHughChat.open({task:{id:11,title:'Первая'}});await flush();assert.equal(f.dock.querySelector('textarea').value,'Задача 11');
  assert.equal(f.saved(draftKey(7,'alvi','hugh:7',12)).text,'Задача 12');assert.equal(f.saved(draftKey(7,'other')).text,'Общий OTHER');assert.equal(sends(f).length,0);
});

test('неизвестная отправка принадлежит Alice; смена аккаунта не отправляет её за Bob, повтор сохраняет clientMessageId',async t=>{
  const f=load({viewerId:7});t.after(()=>f.w.close());f.mount(f.host,'chats');await flush();writeDraft(f,f.host,'От Alice');f.state.failSend=1;
  await submit(f,f.host);assert.equal(sends(f).length,1);const first=sends(f)[0];assert.ok(first[2].clientMessageId);assert.equal(first[3]?.csrfToken,'csrf-7');
  assert.equal(f.saved(draftKey(7)).pending.clientMessageId,first[2].clientMessageId);
  f.state.viewerId=8;await submit(f,f.host);assert.equal(sends(f).length,1);await f.poll();assert.equal(f.host.querySelector('textarea').value,'');
  assert.equal(f.saved(draftKey(7)).pending.clientMessageId,first[2].clientMessageId);
  f.state.viewerId=7;await f.poll();assert.equal(f.host.querySelector('textarea').value,'От Alice');await submit(f,f.host);
  assert.equal(sends(f).length,2);assert.equal(sends(f)[1][2].clientMessageId,first[2].clientMessageId);assert.equal(sends(f)[1][3]?.csrfToken,'csrf-7');assert.equal(f.saved(draftKey(7)).pending,null);
});

test('смена cookie после whoami: frozen CSRF даёт отказ, pending остаётся Alice и не переходит Bob',async t=>{
  const f=load({viewerId:7});t.after(()=>f.w.close());f.mount(f.host,'chats');await flush();writeDraft(f,f.host,'Alice: неизвестный результат');
  f.state.beforePost=async(p,body,options)=>{
    if(p!=='people/team-chat')return;
    assert.equal(options?.csrfToken,'csrf-7');f.state.viewerId=8;throw Object.assign(Error('CSRF expired'),{status:403});
  };
  await submit(f,f.host);assert.equal(sends(f).length,1);const pending=f.saved(draftKey(7)).pending;assert.ok(pending.clientMessageId);
  await f.poll();assert.equal(f.host.querySelector('textarea').value,'');assert.equal(f.saved(draftKey(8))?.pending??null,null);assert.equal(sends(f).length,1);
  f.state.beforePost=null;f.state.viewerId=7;await f.poll();assert.equal(f.host.querySelector('textarea').value,'Alice: неизвестный результат');assert.equal(f.host.querySelector('textarea').readOnly,true);
  await submit(f,f.host);assert.equal(sends(f).length,2);assert.equal(sends(f)[1][2].clientMessageId,pending.clientMessageId);assert.equal(sends(f)[1][3].csrfToken,'csrf-7');
});

test('поздний GET Alice после нового GET Bob не возвращает чужую переписку и черновик',async t=>{
  const f=load({viewerId:7});t.after(()=>f.w.close());f.mount(f.host,'chats');await flush();writeDraft(f,f.host,'Alice draft');
  let resolveAlice;f.state.chatGet=()=>new Promise(resolve=>{resolveAlice=resolve;});await f.poll();
  f.state.viewerId=8;f.seed(draftKey(8),{text:'Bob draft',pending:null});
  f.state.chatGet=async()=>({viewerId:8,room:'common',messages:[{id:80,user_id:8,author_name:'Bob',text:'Bob message'}],hasMore:false});await f.poll();
  resolveAlice({viewerId:7,room:'common',messages:[{id:70,user_id:7,author_name:'Alice',text:'Alice late secret'}],hasMore:false});await flush();
  assert.equal(f.host.querySelector('textarea').value,'Bob draft');assert.match(f.host.querySelector('.sbc-messages').textContent,/Bob message/);
  assert.doesNotMatch(f.host.querySelector('.sbc-messages').textContent,/Alice late secret/);assert.equal(f.saved(draftKey(7)).text,'Alice draft');assert.equal(sends(f).length,0);
});

test('whoami без действительного CSRF запрещает POST и сохраняет личный черновик',async t=>{
  for(const csrfToken of [undefined,'','   ']){
    const f=load({viewerId:7});try{
      f.mount(f.host,'chats');await flush();writeDraft(f,f.host,'Alice safe draft');f.state.contextGet=async()=>({userId:7,csrfToken});
      await submit(f,f.host);assert.equal(sends(f).length,0);assert.equal(f.host.querySelector('button[type=submit]').disabled,true);assert.equal(f.saved(draftKey(7)).text,'Alice safe draft');
    }finally{f.w.close();}
  }
});

test('pending чужой комнаты или задачи под личным ключом сохраняется, но не отправляется',async t=>{
  for(const scope of [{room:'dm:3-7'},{room:'common',taskId:11}]){
    const f=load({viewerId:7});try{
      const pending={text:'Сохранить для выяснения',clientMessageId:'existing-id',...scope};f.seed(draftKey(7),{text:pending.text,pending});
      f.mount(f.host,'chats');await flush();await submit(f,f.host);assert.equal(sends(f).length,0);assert.deepEqual(f.saved(draftKey(7)).pending,pending);
    }finally{f.w.close();}
  }
});

test('контекст задачи Alice отсутствует до подтверждения viewer и удаляется из DOM при отказе новой сессии',async t=>{
  for(const status of [401,403]){
    const f=load({viewerId:7});try{
      let resolve;f.state.chatGet=()=>new Promise(done=>{resolve=done;});
      f.w.SynapseHughChat.open({task:{id:11,title:'Личная задача Alice'}});await flush();
      const bar=f.dock.querySelector('.sbc-taskbar');assert.ok(bar);
      assert.doesNotMatch(f.dock.textContent,/Личная задача Alice|№11/);assert.equal(bar.hidden,true);assert.equal(bar.style.display,'none');
      resolve({viewerId:7,room:'hugh:7',messages:[],hasMore:false});await flush();
      assert.match(bar.textContent,/№11: Личная задача Alice/);assert.equal(bar.hidden,false);assert.notEqual(bar.style.display,'none');
      writeDraft(f,f.dock,'Уточнение Alice');f.state.viewerId=8;
      f.state.chatGet=async()=>{throw Object.assign(Error('Session changed'),{status});};await f.poll();
      assert.doesNotMatch(f.dock.textContent,/Личная задача Alice|№11/);assert.equal(bar.querySelector('span').textContent,'');
      assert.equal(bar.hidden,true);assert.equal(bar.style.display,'none');assert.equal(f.dock.querySelector('button[type=submit]').disabled,true);
      assert.equal(f.dock.querySelector('textarea').value,'');assert.equal(f.saved(draftKey(7,'alvi','hugh:7',11)).text,'Уточнение Alice');
      f.state.viewerId=7;f.state.chatGet=async params=>({viewerId:7,room:params.room,messages:[],hasMore:false});await f.poll();
      assert.match(bar.textContent,/№11: Личная задача Alice/);assert.equal(bar.hidden,false);assert.notEqual(bar.style.display,'none');
      assert.equal(f.dock.querySelector('textarea').value,'Уточнение Alice');assert.equal(sends(f).length,0);
    }finally{f.w.close();}
  }
});

test('подтверждённый другой viewer не получает название прежней задачи',async t=>{
  const f=load({viewerId:7});t.after(()=>f.w.close());
  f.w.SynapseHughChat.open({task:{id:11,title:'Скрыть от Bob'}});await flush();assert.match(f.dock.textContent,/Скрыть от Bob/);
  f.state.viewerId=8;await f.poll();const bar=f.dock.querySelector('.sbc-taskbar');
  assert.doesNotMatch(f.dock.textContent,/Скрыть от Bob|№11/);assert.equal(bar.querySelector('span').textContent,'');
  assert.equal(bar.hidden,true);assert.equal(bar.style.display,'none');assert.equal(sends(f).length,0);
});
test('specs/227: «Лео · Claude» — ответ ассистента с именем «Лео», запасной ответ Лео с понятным статусом',async t=>{
  const msgs=[{id:1,user_id:2,author_name:'Лена',text:'Лео, смонтируй рилс',created_at:'2026-11-07T11:00:00Z'},
    {id:2,user_id:0,author_name:'Лео',text:'Лео получил запрос и ответит здесь.',created_at:'2026-11-07T11:00:01Z',answerAudit:{status:'agent_answered',model:'',review_model:'',checked_at:''}},
    {id:3,user_id:0,author_name:'Лео · Claude',text:'Смонтировал черновик.',kind:'agent-reply',agentReply:{persona:'leo',replyTo:1},created_at:'2026-11-07T11:05:00Z'},
    {id:4,user_id:0,author_name:'Хью · Claude',text:'Сайт обновлён.',kind:'agent-reply',agentReply:{persona:'hugh',replyTo:null},created_at:'2026-11-07T11:06:00Z'},
    {id:5,user_id:0,author_name:'Хью · ИИ',text:'Ответ пока недоступен. Вопрос сохранён для проверки.',created_at:'2026-11-07T11:07:00Z',answerAudit:{status:'review_required'}}];
  const f=load({chatGet:params=>({messages:params.room==='common'?msgs:[],hasMore:false,viewerId:2,room:params.room})});t.after(()=>f.w.close());
  f.mount(f.host,'chats');await flush();
  const items=[...f.host.querySelectorAll('.sbc-msg')];
  assert.deepEqual(items.map(li=>li.querySelector('strong').textContent),['Лена','Лео','Лео','Хью','Хью · ИИ']);
  assert.ok(items[2].classList.contains('sbc-msg--hugh')&&items[2].classList.contains('sbc-msg--leo'),'стиль ответа ассистента');
  assert.equal(items[2].dataset.persona,'leo');assert.ok(!items[3].classList.contains('sbc-msg--leo'));
  assert.equal(items[1].querySelector('small').textContent,'Ответ ниже');assert.equal(items[4].querySelector('small').textContent,'Передано на проверку');
  assert.match(f.host.querySelector('textarea').placeholder,/Лео, …/);
});
