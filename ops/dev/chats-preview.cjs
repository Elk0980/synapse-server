'use strict';
// Локальный предпросмотр модулей «Чаты», «Задачи», «Хью» (№98 · Д) на синтетических данных (QA).
// Настоящие team-chat.js и people-board.js на sqlite в памяти; реестр модулей — упрощённая заглушка контракта А.
// Запуск: node ops/dev/chats-preview.cjs [порт] → http://127.0.0.1:<порт>/?m=chats|tasks|hugh-chat
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const {createTeamChat}=require('../content/team-chat'),{unsafe,createTeamChatAnswers}=require('../content/team-chat-answers'),{createPeopleBoard}=require('../crm/people-board');
const db=new DatabaseSync(':memory:'),VIEWER=2,CODE='avokado';
db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT,updated_at TEXT,is_deleted INTEGER DEFAULT 0,title TEXT,description TEXT DEFAULT '',
  company_code TEXT,assignee_name TEXT DEFAULT '',status TEXT DEFAULT 'inbox',priority TEXT DEFAULT 'normal',due_date TEXT DEFAULT '',source TEXT DEFAULT 'manual',
  created_by TEXT DEFAULT '',parent_task_id INTEGER,client_ref TEXT);
  CREATE TABLE task_comments(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER,author TEXT,text TEXT,created_at TEXT);`);
const people={1:{name:'Влад',role:'owner'},2:{name:'Лена (QA)'},3:{name:'Таня (QA)'},4:{name:'СММ (QA)'}};
const tasks={access(id){const p=people[id];if(!p)throw Object.assign(Error('denied'),{status:403});return {id,displayName:p.name,role:p.role||'editor'};}};
const add=(title,assignee,extra={})=>db.prepare(`INSERT INTO tasks(created_at,updated_at,title,company_code,assignee_name,status,priority,due_date,source,created_by,client_ref)
  VALUES(datetime('now'),datetime('now'),?,?,?,?,?,?,?,?,?)`).run(title,CODE,assignee,extra.status||'inbox',extra.priority||'normal',extra.due||'',extra.source||'manual',extra.by||'1',extra.ref||null);
add('Снять рилс №1 «Уход за кожей зимой»','person:2',{status:'in_progress',priority:'high',due:'2026-11-06',source:'claude'});
add('Согласовать контент-план на неделю','person:2',{due:'2026-11-07'});
add('Загрузить исходники съёмки 04.11','person:2',{status:'planned',source:'claude'});
add('Подготовить подписи к трём рилсам','Хью',{by:'2',ref:`hugh:${CODE}:2:seed`});
add('Чужая задача — не видна Лене','person:3');
const board=createPeopleBoard({db,view:row=>({id:row.id,title:row.title,company_code:row.company_code,status:row.status,priority:row.priority,due_date:row.due_date,subtask_count:0,subtask_done:0})});
const actor=user=>({userId:user.id,userName:user.displayName});
let next=100;
const call=async(action,args,user)=>{
  if(action==='hughTask'){const id=Number(add(args.title,'Хью',{by:String(user.id),ref:`hugh:${CODE}:${user.id}:${args.messageId}`}).lastInsertRowid);return {task:{id,company_code:CODE,assignee_name:'Хью'}};}
  if(action==='teamChatTask')return {task:{id:++next,company_code:CODE,assignee_name:`person:${user.id}`}};
  if(action==='taskChatComment')return board.comment(CODE,actor(user),args);
  throw Error('unexpected '+action);
};
const answers={async answer(row){db.prepare(`INSERT INTO team_chat_messages(company_code,user_id,author_name,text,client_id,created_at,room,audience_id)
  VALUES(?,0,'Хью · ИИ',?,?,?,?,?)`).run(row.company_code,'QA: синтетический ответ Хью для предпросмотра.',`hugh-answer:${row.id}`,new Date().toISOString(),row.room,row.user_id);}};
createTeamChatAnswers({db,tasks,call,env:{}});// схема журнала ответов
const chat=createTeamChat({db,tasks,call,answers,unsafe});
db.exec("CREATE TABLE auth_users(id INTEGER PRIMARY KEY,display_name TEXT,role TEXT);CREATE TABLE company_team_members(user_id INTEGER,company_code TEXT,staff_role TEXT)");
for(const [id,p] of Object.entries(people)){db.prepare('INSERT INTO auth_users VALUES(?,?,?)').run(Number(id),p.name,p.role||'editor');if(!p.role)db.prepare("INSERT INTO company_team_members VALUES(?,?,'human_executor')").run(Number(id),CODE);}
const seed=async()=>{let n=0;const s=(id,text,room='common')=>chat.send(id,CODE,{text,clientMessageId:`seed-${++n}-xxxx`,room});
  await s(3,'Коллеги, съёмка в четверг переносится на 15:00');await s(2,'Ок, беру реквизит');await s(2,'Хью, что у меня сегодня в работе?');
  await s(3,'Хью, поменяй контент-план: рилс про уход перенеси на пятницу',`hugh:3`);await s(2,'Поменяй контент-план: в четверг вместо сторис рилс',`hugh:2`);
  await s(2,'Лен, пришли, пожалуйста, ссылку на исходники','dm:2-3');};
const html=module=>`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA · ${module}</title><link rel="stylesheet" href="/chats.css"><style>:root{--bg:#0b0908;--surface:#12100f;--surface-soft:#181513;--text:#f4f0eb;--muted:#b9afa7;--accent:#9fd4ff;--blue:#2e6bd6;--line:rgba(244,240,235,.12)}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif}main{padding:16px}.plain-button{min-height:40px;padding:8px 12px;border-radius:10px;border:1px solid var(--line);background:#1f1b18;color:inherit;font:inherit;cursor:pointer}
.qa{font-size:12px;color:#f2c14e;margin:0 0 8px}.sb-chat-panel{position:fixed;right:16px;bottom:16px;width:min(420px,calc(100vw - 32px));height:min(640px,calc(100dvh - 32px));display:flex;flex-direction:column;background:#12100f;border:1px solid var(--line);border-radius:16px}.sb-chat-panel__body{flex:1;min-height:0;display:flex}[hidden]{display:none!important}</style></head>
<body><main><p class="qa">QA-предпросмотр: синтетические данные, внешних вызовов нет.</p><div id="host"></div></main><aside class="sb-chat-panel" id="panel" hidden><div class="sb-chat-panel__body" id="dock"></div></aside>
<script>const defs=new Map(),q=window.SynapseModulesQueue||[];let csrf='';const api={async get(p,params={}){const u=new URLSearchParams({companyCode:'${CODE}',...Object.fromEntries(Object.entries(params).filter(([,v])=>v!=null))});const r=await fetch('/content/'+p+'?'+u);const b=await r.json();if(!r.ok)throw Object.assign(Error(b.error),{status:r.status});return b;},
async post(p,body){const r=await fetch('/content/'+p+'?companyCode=${CODE}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const b=await r.json();if(!r.ok)throw Object.assign(Error(b.error),{status:r.status});return b;}};
const ctx=id=>({moduleId:id,companyCode:'${CODE}',companyName:'Авокадо (QA)',user:{id:${VIEWER},name:'Лена (QA)',role:'editor'},permissions:['tasks.self.view','tasks.self.edit'],can:()=>true,signal:new AbortController().signal,route:{path:'',params:new URLSearchParams(location.search)},api,navigate(){},openHughChat:()=>dock.open(),escapeHTML:s=>s});
const mount=(host,id)=>{const el=document.createElement('div');el.className='sb-module-root';host.replaceChildren(el);defs.get(id).mount(el,ctx(id));};
const dock={open(){panel.hidden=false;mount(document.getElementById('dock'),'hugh-chat');},isOpen:()=>!panel.hidden,companyChanged(){mount(document.getElementById('dock'),'hugh-chat');}};
window.SynapseModules={register:(id,d)=>defs.set(id,d),chat:dock};</script>
<script src="/chats.js"></script><script src="/my-tasks.js"></script><script>for(const [id,d] of q)defs.set(id,d);const m=new URLSearchParams(location.search).get('m')||'chats';
if(m==='hugh-chat')dock.open();else mount(document.getElementById('host'),m);</script></body></html>`;
const root=path.join(__dirname,'../../sites/synapse/cabinet');
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://local'),send=(status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  try {
    if(url.pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');return res.end(html(url.searchParams.get('m')||'chats'));}
    if(['/chats.js','/chats.css','/my-tasks.js'].includes(url.pathname)){res.setHeader('content-type',url.pathname.endsWith('.css')?'text/css':'text/javascript');return res.end(fs.readFileSync(path.join(root,url.pathname.slice(1))));}
    const body=req.method==='POST'?JSON.parse(await new Promise(r=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>r(raw));})):null;
    if(url.pathname==='/content/people/team-chat')return send(200,body?await chat.send(VIEWER,CODE,body):chat.list(VIEWER,CODE,url.searchParams.get('before'),url.searchParams.get('room')||'common'));
    if(url.pathname==='/content/people/team-chat/rooms')return send(200,chat.members(VIEWER,CODE));
    if(url.pathname==='/content/people/my-board')return send(200,board.board(CODE,{userId:VIEWER}));
    if(url.pathname==='/content/people/my-board/action')return send(200,board.action(CODE,{userId:VIEWER},body));
    send(404,{error:'Нет адреса'});
  }catch(error){send(error.status||500,{error:error.message});}
});
seed().then(()=>server.listen(Number(process.argv[2])||4173,'127.0.0.1',()=>console.log(`QA-предпросмотр: http://127.0.0.1:${server.address().port}/?m=chats`)));
module.exports={server};
