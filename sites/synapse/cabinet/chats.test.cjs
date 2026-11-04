'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const flush=async()=>{for(let n=0;n<10;n++)await new Promise(setImmediate);};
function load() {
  const dom=new JSDOM('<!doctype html><div id="host"></div><div id="dock"></div>',{runScripts:'outside-only',url:'https://cabinet.test/'});
  const w=dom.window,defs=new Map(),calls=[];let open=false;
  w.SynapseModules={register:(id,d)=>defs.set(id,d),chat:{open(){open=true;mount(w.document.getElementById('dock'),'hugh-chat');},isOpen:()=>open,companyChanged(){mount(w.document.getElementById('dock'),'hugh-chat');}}};
  const state={messages:[{id:1,user_id:3,author_name:'Таня',text:'<img src=x onerror=alert(1)>',created_at:'2026-11-05T00:00:00Z'}],
    board:{companyCode:'alvi',assigned:[{id:11,title:'Первая',status:'inbox',priority:'high',from:'system'},{id:12,title:'Вторая',status:'in_progress',priority:'normal',from:'manager'}],hugh:[{id:13,title:'Поменяй план',status:'inbox',from:'me'}],deleted:[]}};
  const api={async get(p,params={}){calls.push(['GET',p,params]);
      if(p==='people/team-chat/rooms')return {viewerId:2,common:'common',hugh:'hugh:2',people:[{id:3,name:'Таня',room:'dm:2-3'}]};
      if(p==='people/team-chat')return {messages:params.room==='common'?state.messages:[],hasMore:false,viewerId:2};
      if(p==='people/my-board')return state.board;throw Object.assign(Error('404'),{status:404});},
    async post(p,body){calls.push(['POST',p,body]);
      if(p==='people/team-chat')return {message:{id:50+calls.length,user_id:2,author_name:'Лена',text:body.text,room:body.room,created_at:'2026-11-05T00:01:00Z',ref_task_id:body.taskId}};
      if(p==='people/my-board/action'){const b=structuredClone(state.board);if(body.op==='delete'){b.deleted=b.hugh;b.hugh=[];}if(body.op==='order')b.assigned=body.order.map(id=>b.assigned.find(t=>t.id===id));return b;}}};
  const ctx=id=>({moduleId:id,companyCode:'alvi',companyName:'ALVI',user:{id:2,role:'editor'},signal:new w.AbortController().signal,route:{path:'',params:new w.URLSearchParams()},api,openHughChat(){}});
  function mount(host,id){const el=w.document.createElement('div');host.replaceChildren(el);defs.get(id).mount(el,ctx(id));return el;}
  for(const file of ['chats.js','my-tasks.js'])w.eval(fs.readFileSync(path.join(__dirname,file),'utf8'));
  return {w,defs,calls,mount,host:w.document.getElementById('host'),dock:w.document.getElementById('dock')};
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
