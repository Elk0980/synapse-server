'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(role='owner') {
  const dom=new JSDOM('<div id="tasks-content"></div><span id="tasks-badge"></span><dialog id="task-create-dialog"><button data-task-create-close></button><form id="task-create-form"></form></dialog>',{url:'https://example.test/#tasks',runScripts:'outside-only'});
  const w=dom.window,d=w.document,calls=[];
  w.SbCabinet={registerView:(_,view)=>w.taskView=view};
  w.eval(fs.readFileSync(__dirname+'/tasks.js','utf8'));
  const item={taskId:1,title:'Прайсы <проверка>',companyCode:'alvi',module:'prices',revision:3,executorName:'Codex',
    result:'Файл доставлен',blocker:'Ответ клиента',milestones:Object.fromEntries(['code','connected','verified','accepted'].map(key=>[key,{state:'pending',evidence:'',checkedAt:''}]))};
  let failSave=false;
  const ctx={identity:{role,companies:[{id:'alvi',name:'Алви'}]},currentView:'tasks',selectedProjectId:'alvi',
    byId:id=>d.getElementById(id),escapeHTML:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    scopeParams:()=>({companyCode:'alvi'}),hasPermission:()=>true,csrfOptions:(method,body)=>({method,body}),chooseProject:()=>{},navigate:()=>{},
    crmQuery:async(path,params,options)=>{calls.push({path,params,options});
      if(path==='/tasks/summary')return {};
      if(path==='/tasks')return {tasks:[],pagination:{total:0}};
      if(options?.method==='PUT'){if(failSave)throw Error('Карточка изменена другим исполнителем');return item;}
      if(path==='/coordination/tasks')return {tasks:[item],pagination:{total:1}};
      throw Error('Unexpected route '+path);
    }};
  w.taskView.render(d.getElementById('tasks-content'),ctx);
  return {w,d,calls,ctx,close:()=>w.close(),conflict:()=>failSave=true};
}
test('owner board uses existing tasks, independent milestones and explicit all-company scope',async()=>{
  const f=fixture();try{
    await settle();f.d.querySelector('[data-task-coordination]').click();await settle();
    assert.match(f.d.body.textContent,/Код готов/);assert.match(f.d.body.textContent,/Принято: Не подтверждено/);
    assert.equal(f.d.querySelector('проверка'),null);
    assert.equal(f.calls.find(c=>c.path==='/coordination/tasks').params.companyCode,'alvi');
    f.d.querySelector('[data-coord-all]').click();await settle();
    assert.equal(f.calls.filter(c=>c.path==='/coordination/tasks').at(-1).params.companyCode,undefined);
    f.d.querySelector('[data-coord-edit]').click();await settle();
    const form=f.d.querySelector('[data-coord-form]');
    form.elements.namedItem('result').value='Проверенный результат';
    f.conflict();form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await settle();
    const sent=f.calls.find(c=>c.options?.method==='PUT');assert.equal(sent.options.body.revision,3);
    assert.equal(sent.options.body.data.result,'Проверенный результат');
    assert.match(form.textContent,/изменена другим исполнителем/);
    assert.equal(form.elements.namedItem('result').value,'Проверенный результат');
    assert.equal(form.querySelector('[type=submit]').disabled,false);
  }finally{f.close();}
});
test('client task list does not expose internal coordination or fetch it',async()=>{
  const f=fixture('editor');try{await settle();assert.equal(f.d.querySelector('[data-task-coordination]'),null);
    assert.ok(!f.calls.some(c=>c.path.startsWith('/coordination')));
  }finally{f.close();}
});
