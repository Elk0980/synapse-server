'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));};
test('owner answers from card using revision and project; no unsafe markup or silent acceptance',async()=>{
 const dom=new JSDOM('<div id="tasks-content"></div><span id="tasks-badge"></span><dialog id="task-create-dialog"><button data-task-create-close></button><form id="task-create-form"></form></dialog>',{url:'https://example.test/#tasks/7',runScripts:'outside-only'});
 const w=dom.window,d=w.document,calls=[];try{w.SbCabinet={registerView:(_,v)=>w.view=v};w.eval(fs.readFileSync(__dirname+'/tasks.js','utf8'));
 const task={id:7,title:'Задача',companyCode:'alpha',source:'manual',status:'inbox'};
 let state={taskId:7,state:'needs_input',revision:3,question:'Кому <img src=x onerror=alert(1)>?',attempts:1,history:[]};
 const ctx={identity:{role:'owner',companies:[{id:'alpha',name:'Альфа'}]},currentView:'tasks',selectedProjectId:'alpha',byId:id=>d.getElementById(id),escapeHTML:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),scopeParams:()=>({companyCode:'alpha'}),hasPermission:()=>true,csrfOptions:(method,body)=>({method,body}),chooseProject:()=>{},navigate:()=>{},crmQuery:async(path,params,options)=>{calls.push({path,params,options});if(path==='/tasks/7')return task;if(path==='/coordination/dispatch/7')return state;if(path.endsWith('/action')){state={...state,state:'queued',revision:4};return state;}throw Error(path);}};
 w.view.render(d.getElementById('tasks-content'),ctx);await settle();assert.equal(d.querySelector('img'),null);assert.match(d.body.textContent,/Нужен ваш ответ/);assert.equal(d.querySelector('[data-dispatch-action=accept]'),null);
 d.querySelector('[data-dispatch-answer]').value='Новые клиенты';d.querySelector('[data-dispatch-action=answer]').click();await settle();
 const sent=calls.find(c=>c.options);assert.equal(sent.params.companyCode,'alpha');assert.equal(sent.options.body.revision,3);assert.equal(sent.options.body.text,'Новые клиенты');assert.equal(sent.options.body.action,'answer');assert.match(d.body.textContent,/В очереди/);
 }finally{w.close();}
});
test('review and historical verdicts stay visible and escaped; only owner can accept',async()=>{
 const dom=new JSDOM('<div id="tasks-content"></div><span id="tasks-badge"></span><dialog id="task-create-dialog"><button data-task-create-close></button><form id="task-create-form"></form></dialog>',{url:'https://example.test/#tasks/7',runScripts:'outside-only'});
 const w=dom.window,d=w.document;try{
  w.SbCabinet={registerView:(_,v)=>w.view=v};w.eval(fs.readFileSync(__dirname+'/tasks.js','utf8'));
  const task={id:7,title:'Задача',companyCode:'alpha',source:'manual',status:'inbox'};
  let state={taskId:7,state:'review',revision:3,result:'Черновик',model:'author',review:{verdict:'changes',provider:'reviewer',model:'second',note:'Уточнить <img src=x onerror=alert(1)>'},history:[{note:'Предыдущая проверка',review:{verdict:'unavailable',note:'Проверка недоступна'},createdAt:'2026-09-30T00:00:00Z'}]};
  const ctx={identity:{role:'owner'},currentView:'tasks',selectedProjectId:'alpha',byId:id=>d.getElementById(id),escapeHTML:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),scopeParams:()=>({companyCode:'alpha'}),hasPermission:()=>true,crmQuery:async path=>path==='/tasks/7'?task:state};
  w.view.render(d.getElementById('tasks-content'),ctx);await settle();
  assert.match(d.body.textContent,/Вторая проверка: есть замечания/);assert.match(d.body.textContent,/reviewer \/ second/);
  assert.match(d.body.textContent,/Вторая проверка: не выполнена/);assert.equal(d.querySelector('img'),null);
  assert.ok(d.querySelector('[data-dispatch-action=accept]'));assert.match(d.body.textContent,/Результат принимает владелец/);
  assert.equal(state.state,'review');
 }finally{w.close();}
});
