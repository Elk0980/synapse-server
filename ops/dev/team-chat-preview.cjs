'use strict';
// Synthetic loopback preview: no credentials, production requests or notifications.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../sites/synapse/cabinet');
const {DatabaseSync}=require('node:sqlite'),{createTeamChat}=require('../content/team-chat'),{createTeamChatAnswers}=require('../content/team-chat-answers');
const db=new DatabaseSync(':memory:'),tasks={access:id=>({id,displayName:'Тестовый человек'})};
const call=async()=>({companyCode:'alpha',tasks:[{id:7,title:'Подготовить ролик',status:'in_progress',due_date:''}],plan:[{topic:'Уход за волосами',scripts:['Покажите этапы ухода.']}]});
const answers=createTeamChatAnswers({db,tasks,call,env:{CHAT_API_KEY:'synthetic'},fetchImpl:async(url,options)=>{
  const p=JSON.parse(options.body),question=p.messages[1].content;
  const answer=question.includes('темы')?'Сегодня тема: уход за волосами.':question.includes('снять')?'Покажите этапы ухода.':'В работе: подготовить ролик.';
  return new Response(JSON.stringify({model:'gpt-5.5',text:p.jobId.startsWith('team-review:')?'{"approved":true}':JSON.stringify({answer})}));
}});
const chat=createTeamChat({db,tasks,call,answers});
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  res.setHeader('cache-control','no-store');
  if(url.pathname==='/') {res.setHeader('content-type','text/html; charset=utf-8');return res.end('<style>body{margin:0;background:#080f18;color:white;font-family:system-ui}iframe{height:760px;border:1px solid #557}section{display:flex;gap:16px}</style><h1>Синтетическая проверка · ПК 900 px и телефон 390 px</h1><section><iframe width="900" src="/team-chat.html?companyCode=alpha"></iframe><iframe width="390" src="/team-chat.html?companyCode=alpha"></iframe></section>');}
  if(url.pathname.startsWith('/content/people/')) {
    res.setHeader('content-type','application/json');
    if(url.pathname.endsWith('/context'))return res.end(JSON.stringify({user:{id:2},csrfToken:'synthetic',companies:[{id:'alpha',name:'Тестовый проект'}]}));
    if(req.method==='POST'){let raw='';for await(const b of req)raw+=b;return res.end(JSON.stringify(await chat.send(2,'alpha',JSON.parse(raw))));}
    return res.end(JSON.stringify(chat.list(2,'alpha')));
  }
  const name=url.pathname.slice(1);if(!['team-chat.html','team-chat.js','team-chat.css'].includes(name)){res.writeHead(404);return res.end();}
  res.setHeader('content-type',name.endsWith('.css')?'text/css':name.endsWith('.js')?'application/javascript':'text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,name)));
}).listen(38736,'127.0.0.1',()=>console.log('Synthetic preview http://127.0.0.1:38736'));
