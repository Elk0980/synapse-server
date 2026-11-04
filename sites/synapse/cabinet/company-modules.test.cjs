const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const script=fs.readFileSync(require.resolve('./company-modules.js'),'utf8');
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const data=(over={})=>({companyCode:'alvi',companyName:'ALVI <b>',history:[],modules:[
  {key:'analytics',name:'Сквозная аналитика',status:'available',billing:'monthly',enabled:false,params:{},version:0,purchased:true,purchasedIn:[{dealId:7,title:'Сделка <i>'}],paramsSchema:[]},
  {key:'crm',name:'CRM-система',status:'development',billing:'monthly',enabled:false,params:{},version:0,purchased:false,purchasedIn:[],
    paramsSchema:[{name:'leadEmailRecipients',type:'emailList',label:'Получатели',hint:'До 5 адресов'}]}],...over});
const setup=()=>{const dom=new JSDOM('<div id="t"></div>',{runScripts:'outside-only'});const w=dom.window;w.eval(script);return {w,ui:w.SbCabinet.companyModulesUI,target:w.document.getElementById('t')};};
const tick=()=>new Promise(setImmediate);

test('экран модулей: экранирование, отметка «приобретён», включение с CSRF и компанией карточки',async()=>{
  const {w,ui,target}=setup();const calls=[];
  const crmQuery=async(path,query,options)=>{calls.push({path,query,options});
    if(options?.method==='PUT'){const d=data();d.modules[0].enabled=true;d.modules[0].version=1;d.history=[{id:1,moduleKey:'analytics',at:'2026-11-04T00:00:00Z',actor:'Влад',before:null,after:{enabled:true,params:{}}}];return d;}
    return data();};
  const csrfOptions=(method,body)=>({method,headers:{'X-CSRF-Token':'tok'},body:JSON.stringify(body)});
  try{
    await ui.render(target,{company:{id:3,code:'alvi'},crmQuery,csrfOptions,escapeHTML:esc,identity:{role:'owner'}});
    assert.equal(target.querySelector('b'),null,'название компании экранировано');
    assert.equal(target.querySelector('i'),null,'название сделки экранировано');
    assert.equal(calls[0].path,'/company-modules');assert.equal(JSON.stringify(calls[0].query),'{"companyCode":"alvi"}');assert.equal(calls[0].options,undefined);
    const card=target.querySelector('[data-module=analytics]');
    assert.match(card.textContent,/Приобретён в сделке/);
    assert.equal(card.querySelector('a').getAttribute('href'),'#deals/7');
    const button=card.querySelector('[data-module-toggle]');assert.match(button.textContent,/Включить — приобретён/);
    button.click();await tick();
    const put=calls.find(c=>c.options?.method==='PUT');
    assert.equal(put.path,'/company-modules/analytics');assert.equal(JSON.stringify(put.query),'{"companyCode":"alvi"}');
    assert.equal(put.options.headers['X-CSRF-Token'],'tok');assert.deepEqual(JSON.parse(put.options.body),{enabled:true,version:0});
    assert.match(target.querySelector('[data-module=analytics]').textContent,/Включён/);
    assert.match(target.querySelector('.company-modules-history').textContent,/Влад/);
  }finally{w.close();}
});

test('параметр: «как прежде» отправляет null, введённые адреса — строкой; ошибка видна в карточке',async()=>{
  const {w,ui,target}=setup();const bodies=[];
  const crmQuery=async(path,query,options)=>{if(options?.method==='PUT'){bodies.push(JSON.parse(options.body));if(bodies.length===2)throw new Error('Некорректный адрес');}return data();};
  try{
    await ui.render(target,{company:{code:'alvi'},crmQuery,csrfOptions:(method,body)=>({method,headers:{},body:JSON.stringify(body)}),escapeHTML:esc,identity:{role:'owner'}});
    target.querySelector('[data-module=crm] [data-module-save]').click();await tick();
    assert.deepEqual(bodies[0],{enabled:false,version:0,params:{leadEmailRecipients:null}});
    const card=target.querySelector('[data-module=crm]');
    const box=card.querySelector('[data-param-inherit]');box.checked=false;box.dispatchEvent(new w.Event('change'));
    card.querySelector('[data-param]').value=' a@example.test ';card.querySelector('[data-module-save]').click();await tick();
    assert.deepEqual(bodies[1].params,{leadEmailRecipients:'a@example.test'});
    assert.equal(card.querySelector('[role=alert]').hidden,false);assert.match(card.textContent,/Некорректный адрес/);
  }finally{w.close();}
});

test('не владелец не получает экран; ответ прежней карточки отбрасывается',async()=>{
  const {w,ui,target}=setup();
  try{
    let called=false;
    await ui.render(target,{company:{code:'alvi'},crmQuery:async()=>{called=true;return data();},escapeHTML:esc,identity:{role:'editor'}});
    assert.equal(called,false);assert.equal(target.querySelector('[data-module]'),null);
    let release;const slow=new Promise(r=>release=r);
    const first=ui.render(target,{company:{code:'alvi'},crmQuery:()=>slow,escapeHTML:esc,identity:{role:'owner'}});
    ui.reset();target.innerHTML='<p>другая карточка</p>';release(data());await first;
    assert.equal(target.textContent,'другая карточка');
  }finally{w.close();}
});
