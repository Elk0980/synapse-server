'use strict';
// Быстрые периоды сквозной аналитики: точное число включительных дат, «За год», ручные даты
// и активная кнопка. Данные синтетические, без рабочих компаний.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const SOURCE=fs.readFileSync(require.resolve('./analytics.js'),'utf8');
const SHELL=fs.readFileSync(require.resolve('../cabinet.html'),'utf8');
const section=SHELL.slice(SHELL.indexOf('<section class="view-panel" id="analytics-through-view"'),SHELL.indexOf('<section class="view-panel" id="ad-platforms-view"'));
const ENDPOINTS=['/dashboard','/summary','/expenses','/platform-demand/potential','/platform-demand/company-metrics','/revenue-analytics'];
const TODAY='2026-10-12';
const tick=async(n=4)=>{for(let i=0;i<n;i++)await new Promise(resolve=>setImmediate(resolve));};
const dayCount=({from,to})=>(Date.parse(to)-Date.parse(from))/86400000+1;
// Повторяет periodDates оболочки: «сегодня минус 7/30 дней», т. е. 8/31 дата. analytics.js обязан это исправить.
const shellPeriodDates=(period)=>{
  const to=new Date(TODAY+'T09:00:00Z'),from=new Date(to);
  if(period==='7d')from.setUTCDate(from.getUTCDate()-7);
  if(period==='30d')from.setUTCDate(from.getUTCDate()-30);
  return {from:from.toISOString().slice(0,10),to:TODAY};
};

function fixture(){
  const dom=new JSDOM(`<div>${section}</div>`,{url:'https://cabinet.test/cabinet.html#analytics-through',runScripts:'outside-only'});
  const w=dom.window,d=w.document,views={},calls=[];
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};w.eval(SOURCE);
  const ctx={currentView:'analytics-through',identity:{role:'marketer',permissions:['analytics.view']},byId:id=>d.getElementById(id),
    escapeHTML:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    csrfOptions:(method,body)=>({method,body:JSON.stringify(body)}),scopeParams:()=>({companyCode:'demo'}),
    formatMoney:v=>String(v)+' ₽',formatROMI:v=>v===null?'—':String(v)+'%',dateValue:()=>TODAY,periodDates:shellPeriodDates,
    crmQuery:async(path,params)=>{calls.push({path,params:{...params}});
      if(path==='/dashboard')return {sourceStats:[],summary:{total:null,booked:null,visited:null,sales:null},expenses:null};
      if(path==='/summary')return {sources:[]};
      if(path==='/expenses')return {expenses:[]};
      return {error:true};}};
  const form=d.getElementById('analytics-dates');
  const pressed=()=>[...d.querySelectorAll('[data-analytics-period]')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.analyticsPeriod);
  const lastBatch=()=>ENDPOINTS.map(path=>calls.filter(call=>call.path===path).at(-1));
  return {w,d,form,calls,pressed,lastBatch,close:()=>w.close(),
    async render(){views['analytics-through'].render(d.getElementById('analytics-through-view'),ctx);await tick();},
    async click(period){d.querySelector(`[data-analytics-period="${period}"]`).click();await tick();},
    async submit(from,to){form.elements.from.value=from;form.elements.to.value=to;form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();}};
}
const assertBatch=(f,range,message)=>{
  for(const call of f.lastBatch()){
    assert.ok(call,message+': каждый источник запрошен');
    assert.equal(call.params.from,range.from,`${message}: from для ${call.path}`);
    assert.equal(call.params.to,range.to,`${message}: to для ${call.path}`);
    assert.equal(call.params.companyCode,'demo');
  }
};

test('по умолчанию — 30 дат включая сегодня, активна кнопка «30 дней», все запросы получают точные даты',async()=>{
  const f=fixture();try{
    assert.deepEqual(f.pressed(),['30d'],'разметка открывается с активной кнопкой 30 дней');
    await f.render();
    const range={from:'2026-09-13',to:TODAY};assert.equal(dayCount(range),30);
    assertBatch(f,range,'старт');
    assert.equal(f.calls.length,ENDPOINTS.length,'одна загрузка на открытие');
    assert.deepEqual(f.pressed(),['30d']);
    assert.equal(f.form.elements.from.value,range.from);assert.equal(f.form.elements.to.value,range.to);
    assert.equal(f.lastBatch()[0].params.period,'30d','серверный period сохранён для известного пресета');
  }finally{f.close();}
});

test('«За год», 7 и 30 дней — точное число включительных дат; кнопка отражает диапазон',async()=>{
  const f=fixture();try{
    await f.render();
    for(const [period,from,days] of [['365d','2025-10-13',365],['7d','2026-10-06',7],['30d','2026-09-13',30],['today',TODAY,1]]){
      await f.click(period);
      const range={from,to:TODAY};assert.equal(dayCount(range),days,period);
      assertBatch(f,range,period);
      assert.deepEqual(f.pressed(),[period]);
      assert.equal(f.form.elements.from.value,from);
    }
    await f.click('365d');
    assert.equal('period' in f.lastBatch()[0].params,false,'«365d» не отправляется в серверную проверку period; действуют from/to');
  }finally{f.close();}
});

test('ручные даты уходят как введены и не подменяются пресетом; совпадение с пресетом подсвечивает кнопку',async()=>{
  const f=fixture();try{
    await f.render();
    await f.submit('2026-01-15','2026-03-20');
    assertBatch(f,{from:'2026-01-15',to:'2026-03-20'},'ручной диапазон');
    assert.deepEqual(f.pressed(),[],'ни одна быстрая кнопка не активна');
    assert.equal('period' in f.lastBatch()[0].params,false,'ручной диапазон не сопровождается выдуманным period');
    assert.equal(f.form.elements.from.value,'2026-01-15');
    await f.submit('2025-10-13',TODAY);
    assertBatch(f,{from:'2025-10-13',to:TODAY},'ручной год');
    assert.deepEqual(f.pressed(),['365d']);
    await f.submit('2026-10-05',TODAY);
    assert.deepEqual(f.pressed(),[],'8 дат — не «7 дней»');
    assertBatch(f,{from:'2026-10-05',to:TODAY},'8 дат');
  }finally{f.close();}
});

test('пустые или перевёрнутые ручные даты не запускают запросы и не меняют выбранный период',async()=>{
  const f=fixture();try{
    await f.render();const before=f.calls.length;
    await f.submit('','2026-10-01');
    assert.match(f.d.getElementById('analytics-content').textContent,/Укажите обе даты/);
    await f.submit('2026-10-10','2026-10-01');
    assert.match(f.d.getElementById('analytics-content').textContent,/не может быть позже/);
    assert.equal(f.calls.length,before);assert.deepEqual(f.pressed(),['30d']);
  }finally{f.close();}
});
