'use strict';
/* Расходы и ROMI по выбранной компании в сквозной аналитике (spec 111).
   Компании, суммы и даты синтетические. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const RANGE={from:'2026-11-01',to:'2026-11-04'};
const SKELETON=`<div id="analytics-periods"></div>
  <form id="analytics-dates"><input name="from"><input name="to"></form>
  <div id="platform-filter"><button id="platform-trigger" type="button"></button><div id="platform-panel"></div></div>
  <div id="analytics-content"></div><div id="analytics-legacy"></div>
  <section id="expenses-section"><h2>Расходы</h2><div id="expenses-content"></div>
  <form id="expense-form" hidden><input name="date"><input name="source"><input name="amount"><input name="comment">
  <button type="submit">Добавить</button></form><p id="expense-result"></p></section>`;
const row=(source,over={})=>({source,leads:0,booked:0,visited:0,sales:0,revenue:0,expenses:null,romi:null,
  visits:0,clicks:0,clicksByTarget:{},external:null,externalCapturedAt:null,...over});

function fixture({dashboard,summary={sources:[]},expenses=[],permissions=['analytics.view','crm.edit']}) {
  const dom=new JSDOM(`<main>${SKELETON}</main>`,{url:'https://cabinet.example.test/',runScripts:'outside-only'});
  const w=dom.window,d=w.document,views={},queries=[];
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};
  w.eval(fs.readFileSync(__dirname+'/analytics.js','utf8'));
  const ctx={currentView:'analytics-through',selectedProjectId:'avokado',
    identity:{role:'owner',permissions,companies:[{id:'avokado',name:'Авокадо'}]},
    byId:id=>d.getElementById(id),
    escapeHTML:value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
    csrfOptions:(method,body)=>({method,body}),
    scopeParams:()=>({companyCode:'avokado'}),
    formatMoney:value=>`${value} ₽`,formatROMI:value=>value===null?'—':`${value}%`,
    periodDates:()=>({...RANGE}),dateValue:()=>'2026-11-04',
    crmQuery:async(path,params,options)=>{queries.push({path,params,options});
      if(path==='/dashboard')return dashboard;
      if(path==='/summary')return summary;
      if(path==='/expenses')return options?.method==='POST'?{id:1}:{expenses,expensesScope:'company'};
      if(path.startsWith('/platform-demand/'))return {error:true};
      throw Error('unexpected '+path);}};
  return {d,ctx,queries,
    async render(){views['analytics-through'].render(d.querySelector('main'),ctx);for(let i=0;i<8;i++)await tick();},
    finance:()=>[...d.querySelectorAll('.analytics-finance .crm-stat > *')].map(el=>el.textContent.trim()).join(' '),
    platformRow:label=>[...d.querySelectorAll('.analytics-source-table tbody tr')]
      .find(tr=>tr.cells[0].textContent.trim()===label),
    close:()=>w.close()};
}

test('внесённый расход компании даёт ROMI с меткой ручного ввода и по площадке',async()=>{
  const f=fixture({dashboard:{expensesScope:'company',summary:{expenses:1000,revenue:3000,romi:200},
    sourceStats:[row('yandex-direct',{leads:1,sales:1,revenue:3000,expenses:1000,romi:200})]},
    expenses:[{spentAt:'2026-11-03T00:00:00.000Z',source:'yandex-direct',amount:1000,comment:'',companyCode:'avokado'}]});
  try{
    await f.render();
    const finance=f.finance();
    assert.match(finance,/Расходы 1000 ₽ РУЧНОЙ ВВОД/);
    assert.match(finance,/ROMI 200% РУЧНОЙ ВВОД/);
    assert.doesNotMatch(finance,/не ведутся/);
    const direct=f.platformRow('Поисковая реклама');
    assert.equal(direct.cells[7].textContent.trim(),'1000 ₽');
    assert.equal(direct.cells[8].textContent.trim(),'200%');
    assert.match(f.d.getElementById('expenses-content').textContent,/yandex-direct/);
    assert.equal(f.d.getElementById('expense-form').hidden,false);
  }finally{f.close();}
});

test('у компании без расходов показано «не внесены», а не ноль и не «не ведутся»',async()=>{
  const f=fixture({dashboard:{expensesScope:'company',summary:{expenses:null,revenue:3000,romi:null},
    sourceStats:[row('yandex-direct',{sales:1,revenue:3000})]}});
  try{
    await f.render();
    const finance=f.finance();
    assert.match(finance,/Расходы не внесены НЕТ ДАННЫХ/);
    assert.match(finance,/ROMI нет расходов для расчёта/);
    assert.doesNotMatch(finance,/Расходы 0 ₽|не ведутся/);
    assert.equal(f.platformRow('Поисковая реклама').cells[8].textContent.trim(),'—');
    assert.match(f.d.getElementById('expenses-content').textContent,/не внесены/);
    const form=f.d.getElementById('expense-form');
    assert.equal(form.hidden,false,'владелец может внести первый расход');
    const codes=[...f.d.querySelectorAll('#expense-source-codes option')].map(option=>option.value);
    assert.ok(codes.includes('yandex-direct'),'подсказка кодов площадок');
    assert.equal(form.elements.source.getAttribute('list'),'expense-source-codes');
  }finally{f.close();}
});

test('ROMI площадки из нескольких кодов считается из сумм, а не складывает проценты',async()=>{
  const f=fixture({dashboard:{expensesScope:'company',summary:{expenses:300,revenue:600,romi:100},
    sourceStats:[row('vk',{revenue:400,expenses:100,romi:300}),row('vk-ads',{revenue:200,expenses:200,romi:0})]}});
  try{
    await f.render();
    const vk=f.platformRow('ВКонтакте');
    assert.equal(vk.cells[7].textContent.trim(),'300 ₽');
    assert.equal(vk.cells[8].textContent.trim(),'100%','(600−300)/300, а не 300%+0%');
  }finally{f.close();}
});

test('старый сервер без расходов по компании честно показывает «не ведутся» и прячет форму',async()=>{
  const f=fixture({dashboard:{expensesScope:'global_unavailable',summary:{expenses:null,revenue:0,romi:null},sourceStats:[]}});
  try{
    await f.render();
    assert.match(f.finance(),/Расходы по компании не ведутся/);
    assert.equal(f.d.getElementById('expense-form').hidden,true);
  }finally{f.close();}
});

test('расход из формы уходит в выбранную компанию',async()=>{
  const f=fixture({dashboard:{expensesScope:'company',summary:{expenses:null,revenue:0,romi:null},sourceStats:[]}});
  try{
    await f.render();
    const form=f.d.getElementById('expense-form');
    form.elements.source.value='yandex-direct';form.elements.amount.value='450';
    form.dispatchEvent(new f.d.defaultView.Event('submit',{cancelable:true}));
    for(let i=0;i<8;i++)await tick();
    const post=f.queries.find(item=>item.path==='/expenses'&&item.options?.method==='POST');
    assert.ok(post);
    assert.equal(post.params.companyCode,'avokado');
    assert.equal(post.options.body.source,'yandex-direct');
    assert.equal(post.options.body.amount,450);
  }finally{f.close();}
});

test('строка только с ручным расходом помечена «РУЧНОЙ ВВОД», а не LIVE',async()=>{
  const f=fixture({dashboard:{expensesScope:'company',summary:{expenses:1500,revenue:3000,romi:100},
    sourceStats:[row('yandex-direct',{expenses:1000,romi:-100}),
      row('vk',{leads:1,sales:1,revenue:3000,expenses:500,romi:500}),row('2gis',{leads:2})]}});
  try{
    await f.render();
    const mark=label=>f.platformRow(label).cells[9].textContent.trim();
    assert.equal(mark('Поисковая реклама'),'РУЧНОЙ ВВОД','только расход — не LIVE');
    assert.equal(mark('ВКонтакте'),'LIVE + РУЧНОЙ ВВОД');
    assert.equal(mark('2ГИС'),'LIVE');
    assert.equal(mark('TikTok'),'НЕТ ДАННЫХ');
  }finally{f.close();}
});
