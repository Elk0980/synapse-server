(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SynapseCustomerReports=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const zone='Asia/Irkutsk',names={alvi:'Алви',avokado:'Авокадо'};
 const date=at=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
 const money=value=>{if(value===null||value===undefined)return 'Нет данных';const n=BigInt(value),abs=n<0n?-n:n;return `${n<0n?'−':''}${(abs/100n).toLocaleString('ru-RU')},${String(abs%100n).padStart(2,'0')} ₽`;};
 function normalize(input={},now=new Date().toISOString()){
  const today=date(now),mode=input.mode==='day'?'day':'month',month=/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month||'')?input.month:today.slice(0,7);
  const day=/^\d{4}-\d\d-\d\d$/.test(input.day||'')&&Number.isFinite(Date.parse(input.day+'T00:00:00Z'))&&new Date(input.day+'T00:00:00Z').toISOString().slice(0,10)===input.day?input.day:today;
  return{mode,month:mode==='day'?day.slice(0,7):month,...(mode==='day'?{day}:{}),basis:'lastVisit'};
 }
 function entry(hash){
  if(!hash.startsWith('#reports?'))return null;
  const p=new URLSearchParams(hash.slice(9));
  for(const key of p.keys())if(!['company','mode','month','day'].includes(key)||p.getAll(key).length!==1)throw new Error('Некорректная ссылка отчёта');
  const company=p.get('company');if(!names[company])throw new Error('Компания в ссылке не поддерживается');
  if(p.has('mode')&&!['month','day'].includes(p.get('mode'))||p.has('month')&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.get('month')))throw new Error('Некорректный период отчёта');
  if(p.has('day')){const value=p.get('day');if(!/^\d{4}-\d\d-\d\d$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value||p.has('month')&&value.slice(0,7)!==p.get('month'))throw new Error('Некорректная дата отчёта');}
  return{company,query:normalize(Object.fromEntries(p))};
 }
 const reasons={SOURCE_UNAVAILABLE:'Данные YCLIENTS ещё не получены.',HISTORY_INCOMPLETE:'Для расчёта нужна полная история клиентов и посещений.',CASH_HISTORY_INCOMPLETE:'История оплат и возвратов пока неполная.',CASH_CLIENT_UNMATCHED:'Не все оплаты удалось связать с клиентами.',PERIOD_NOT_OBSERVED:'За этот период ещё нет наблюдений.',NO_PAYING_CLIENTS:'В подтверждённой истории ещё нет оплаченных посещений.',HISTORICAL_LAST_VISIT_UNAVAILABLE:'Для этого периода нужна история посещений, а не только дата последнего визита сегодня.'};
 Object.assign(reasons,{PERIOD_AGGREGATE_UNAVAILABLE:'За выбранный период данные ещё не получены.',DAILY_SERIES_UNAVAILABLE:'График по дням пока не получен.',HOURLY_SERIES_UNAVAILABLE:'Разбивка по часам пока не получена.'});
 function validate(data,company,q){
  const p=data&&data.period;
  if(!data||data.contract!=='salon-customer-report/v1'||data.companyCode!==company||!p||p.mode!==q.mode||p.month!==q.month||p.basis!=='lastVisit'||p.timezone!==zone||(q.mode==='day'&&p.day!==q.day)||!data.source||data.source.kind!=='yclients'||!['unavailable','partial','complete'].includes(data.source.status))throw new Error('Ответ не соответствует компании или периоду');
  for(const m of [data.newClients,data.clients])if(!m||m.value!==null&&(!Number.isSafeInteger(m.value)||m.value<0))throw new Error('Некорректные показатели отчёта');
  if(!data.ltv||data.ltv.value!==null&&!/^-?\d{1,32}$/.test(data.ltv.value)||!Array.isArray(data.groups)||data.groups.length!==6||!Array.isArray(data.newSeries)||data.newSeries.length>31||!Array.isArray(data.ltvSeries)||data.ltvSeries.length>12)throw new Error('Некорректные графики отчёта');
  for(const g of data.groups)if(typeof g.label!=='string'||g.count!==null&&(!Number.isSafeInteger(g.count)||g.count<0)||g.percent!==null&&(!Number.isFinite(g.percent)||g.percent<0||g.percent>100))throw new Error('Некорректные группы клиентов');
  for(const s of data.newSeries)if(typeof s.key!=='string'||s.value!==null&&(!Number.isSafeInteger(s.value)||s.value<0))throw new Error('Некорректный график новых клиентов');
  for(const s of data.ltvSeries)if(typeof s.key!=='string'||s.value!==null&&!/^-?\d{1,32}$/.test(s.value))throw new Error('Некорректный график LTV');
  const groupKeys=['under3','3to6','6to12','1to2','over2','noVisit'];
  if(data.groups.some((g,i)=>g.key!==groupKeys[i]||g.label.length>150))throw new Error('Некорректные группы клиентов');
  if(data.groups.some(g=>g.count!==null)&&data.groups.some(g=>g.count===null))throw new Error('Группы клиентов получены не полностью');
  if(data.groups.every(g=>g.count!==null)){
   if(data.clients.value===null||data.groups.reduce((n,g)=>n+g.count,0)!==data.clients.value||data.groups.some(g=>g.percent===null||Math.abs(g.percent-(data.clients.value?g.count/data.clients.value*100:0))>.11))throw new Error('Группы не соответствуют клиентской базе');
  }
  const seriesKeys=new Set();for(const s of data.newSeries){if(seriesKeys.has(s.key)||(q.mode==='day'?!/^(?:[01]\d|2[0-3])$/.test(s.key):!/^\d{4}-\d\d-\d\d$/.test(s.key)||s.key<p.from||s.key>p.to))throw new Error('График не относится к выбранному периоду');seriesKeys.add(s.key);}
  if(data.traffic){
   const t=data.traffic,allowed=['2gis','telegram','vk','instagram','youtube','tiktok','max','yandex_maps','yandex','google','whatsapp','other','unknown'];
   if(t.contract!=='app-entry-statistics/v1'||t.companyCode!==company||t.period?.fromAt!==p.fromAt||t.period?.untilAt!==p.untilAt||t.metric!=='entrances'||!['complete','partial','unobserved'].includes(t.status)||t.total!==null&&(!Number.isSafeInteger(t.total)||t.total<0)||!Array.isArray(t.sources)||t.sources.length!==allowed.length)throw new Error('Некорректная статистика входов');
   const seen=new Set();for(const s of t.sources){if(!allowed.includes(s.key)||seen.has(s.key)||typeof s.label!=='string'||s.label.length>100||s.count!==null&&(!Number.isSafeInteger(s.count)||s.count<0)||s.percent!==null&&(!Number.isFinite(s.percent)||s.percent<0||s.percent>100))throw new Error('Некорректный источник входа');seen.add(s.key);}
   if(t.total!==null&&(t.sources.some(s=>s.count===null)||t.sources.reduce((n,s)=>n+s.count,0)!==t.total))throw new Error('Сумма источников не совпадает с числом входов');
   if(!Number.isFinite(Date.parse(t.enabledAt))||!Number.isFinite(Date.parse(t.updatedAt))||t.status!=='unobserved'&&t.total===null||t.status==='unobserved'&&(t.total!==null||t.sources.some(s=>s.count!==null))||t.total!==null&&t.sources.some(s=>s.percent===null||Math.abs(s.percent-(t.total?s.count/t.total*100:0))>.11))throw new Error('Покрытие статистики входов не подтверждено');
  }
  return data;
 }
 function create({document:d,window:w,companyCode,request,query={},now=()=>new Date().toISOString(),onQuery=()=>{},onUnauthorized=()=>{}}){
  if(!names[companyCode]||typeof request!=='function')throw new TypeError('Нужно подключение отчётов выбранной компании');
  const el=(tag,attrs={},...children)=>{const n=d.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='text')n.textContent=v;else if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else n.setAttribute(k,String(v));}for(const c of children.flat())if(c)n.append(c);return n;};
  const root=el('section',{class:'salon-reports','aria-label':`Отчёты · ${names[companyCode]}`}),content=el('div',{class:'salon-reports__cards'});
  let q=normalize(query,now()),data=null,error='',loading=false,disposed=false,seq=0,abort=null;
  const time=at=>{try{return new Intl.DateTimeFormat('ru-RU',{timeZone:zone,year:'numeric',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}).format(new Date(at));}catch(_){return 'дата не подтверждена';}};
  const fit=()=>{if(root.parentElement)root.style.setProperty('--report-block-height',`${Math.max(350,Math.ceil(root.parentElement.clientHeight/1.5))}px`);};
  const observer=w.ResizeObserver?new w.ResizeObserver(fit):null;
  let parent=null;
  function controls(title){
   const label=el('label',{class:'salon-period'}),mode=el('select',{'aria-label':`Период: ${title}`,onchange:e=>change({...q,mode:e.target.value,day:q.day||date(now())})},el('option',{value:'month',text:'Месяц'}),el('option',{value:'day',text:'День'}));mode.value=q.mode;
   const picker=el('input',{type:q.mode==='day'?'date':'month','aria-label':`Выбрать ${q.mode==='day'?'день':'месяц'}: ${title}`,value:q.mode==='day'?q.day:q.month,onchange:e=>{if(e.target.value&&e.target.validity.valid)change({...q,[q.mode==='day'?'day':'month']:e.target.value});}});
   label.append(mode,picker);return label;
  }
  function change(next){q=normalize(next,now());onQuery({...q});void refresh();}
  function note(reason){return el('p',{class:'salon-report__empty',text:loading?'Загружаем данные…':error||reasons[reason]||'Нет подтверждённых данных.'});}
  function chart(series,kind,title){
   const figure=el('figure',{class:'salon-chart','aria-label':title});
   const known=series.filter(p=>p.value!==null);if(!known.length)return note(kind==='money'?data?.ltv.reason:data?.newClients.seriesReason||data?.newClients.reason);
   const svg=d.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 600 190');svg.setAttribute('role','img');svg.setAttribute('aria-label',title);
   const node=(tag,a,text)=>{const n=d.createElementNS(svg.namespaceURI,tag);Object.entries(a).forEach(([k,v])=>n.setAttribute(k,String(v)));if(text)n.textContent=text;svg.append(n);return n;};
   let max=known.reduce((m,p)=>{const n=BigInt(p.value);return(n<0n?-n:n)>m?(n<0n?-n:n):m;},1n);
   const negative=known.some(p=>BigInt(p.value)<0n),baseline=negative?93:158,scale=negative?65:130;
   node('line',{x1:14,x2:586,y1:baseline,y2:baseline,class:'salon-chart__axis'});
   let previous=null;
   series.forEach((p,i)=>{const x=24+(series.length===1?0:i*552/(series.length-1));if(p.value===null){previous=null;return;}
    const n=BigInt(p.value),ratio=Number(n*10000n/max)/10000,y=baseline-ratio*scale;
    if(kind==='money'){
     if(previous)node('line',{x1:previous.x,y1:previous.y,x2:x,y2:y,class:'salon-chart__line'});
     const circle=node('circle',{cx:x,cy:y,r:4,class:'salon-chart__point'}),t=d.createElementNS(svg.namespaceURI,'title');t.textContent=`${p.key}: ${money(p.value)}`;circle.append(t);previous={x,y};
    }else{const bar=node('rect',{x:x-5,y:Math.min(y,baseline),width:10,height:Math.max(1,Math.abs(baseline-y)),rx:3,class:'salon-chart__bar'}),t=d.createElementNS(svg.namespaceURI,'title');t.textContent=`${p.key}: ${p.value}`;bar.append(t);}
    if(i===0||i===series.length-1||series.length>10&&i===Math.floor(series.length/2))node('text',{x,y:183,'text-anchor':i===0?'start':i===series.length-1?'end':'middle',class:'salon-chart__label'},p.key);
   });
   node('text',{x:14,y:15,class:'salon-chart__label'},kind==='money'?money(max.toString()):String(max));
   figure.append(svg);
   const details=el('details',{class:'salon-chart__data'},el('summary',{text:'Данные графика'})),table=el('table',{},el('caption',{text:title})),tbody=el('tbody');
   for(const p of series)tbody.append(el('tr',{},el('th',{scope:'row',text:p.key}),el('td',{text:p.value===null?'Нет данных':kind==='money'?money(p.value):String(p.value)})));
   table.append(tbody);details.append(table);figure.append(details);return figure;
  }
  function paint(){
   if(disposed)return;
   const refreshButton=el('button',{class:'salon-reports__refresh',type:'button',text:loading?'Обновляем…':'Обновить',onclick:()=>void refresh()});refreshButton.disabled=loading;
   const meta=el('div',{class:'salon-reports__meta'},el('h2',{text:`Отчёты · ${names[companyCode]}`}),refreshButton,el('p',{class:'salon-reports__source',role:'status',text:loading?'Получаем отчёт…':error?'Отчёт не загружен':data?.source.updatedAt?`YCLIENTS · обновлено ${time(data.source.updatedAt)} · Иркутск`:'YCLIENTS · обновление не подтверждено'}));
   content.replaceChildren();
   const card=(title,subtitle,metric,help)=>{
    const header=el('div',{class:'salon-report__head'},el('h3',{text:title}),help||null),n=el('article',{class:'salon-report'},header,controls(title),el('p',{class:'salon-report__value',text:loading?'…':metric===null?'Нет данных':metric}),el('p',{class:'salon-report__subtitle',text:subtitle}));content.append(n);return n;
   };
   const first=card('Новые клиенты',data?.newClients.definition||'Первый оплаченный состоявшийся визит за выбранный период',data?.newClients.value??null);first.append(data&&!loading&&!error?chart(data.newSeries,'count','Новые клиенты по дням или часам'):note());
   const clients=card('Клиенты','Всего в базе на выбранную дату · группы от последнего посещения',data?.clients.value??null);
   if(data&&!loading&&!error&&data.groups.every(g=>g.count!==null)){
    const groups=el('div',{class:'salon-groups','aria-label':'Давность последнего посещения'});
    data.groups.forEach((g,i)=>{const row=el('div',{class:`salon-group salon-group--${i}`},el('span',{text:g.label}),el('strong',{text:`${g.count} · ${String(g.percent).replace('.',',')}%`})),track=el('div',{class:'salon-group__track','aria-hidden':'true'}),fill=el('div',{class:'salon-group__fill'});fill.style.width=`${g.percent}%`;track.append(fill);row.append(track);groups.append(row);});clients.append(groups);
   }else clients.append(note(data?.groupsReason||data?.clients.reason));
   const traffic=data?.traffic;
   const sourceCard=card('Откуда заходят','Входы в приложение · по источникам перехода',traffic?.total==null?null:`${traffic.total}${traffic.status==='partial'?' за время сбора':''}`);
   if(traffic&&traffic.total!==null&&!loading&&!error){
    sourceCard.append(el('p',{class:'salon-report__subtitle',text:`Статистика с ${time(traffic.enabledAt)} · Иркутск`}));
    const rows=el('div',{class:'salon-groups','aria-label':'Источники входа в приложение'});
    const active=traffic.sources.filter(s=>s.count>0).sort((a,b)=>b.count-a.count);
    for(const s of active){const row=el('div',{class:'salon-group'},el('span',{text:s.label}),el('strong',{text:`${s.count} · ${String(s.percent).replace('.',',')}%`})),track=el('div',{class:'salon-group__track','aria-hidden':'true'}),fill=el('div',{class:'salon-group__fill'});fill.style.width=`${s.percent}%`;track.append(fill);row.append(track);rows.append(row);}
    if(!active.length)rows.append(el('p',{class:'salon-report__subtitle',text:'За время сбора входов пока нет.'}));
    sourceCard.append(rows,el('p',{class:'salon-report__subtitle',text:'Считаем входы, а не уникальных людей. Если метки и источник перехода отсутствуют, вход относится к неизвестному источнику.'}));
   }else sourceCard.append(el('p',{class:'salon-report__empty',text:loading?'Загружаем данные…':error||'Статистика появится после подключения отслеживания входов.'}));
   const help=el('button',{class:'salon-report__help',type:'button','aria-label':'Как считается LTV','aria-expanded':'false'},el('span',{'aria-hidden':'true',text:'?'})),hint=el('div',{class:'salon-report__hint',hidden:'',role:'note'});
   help.addEventListener('click',()=>{const expanded=help.getAttribute('aria-expanded')!=='true';help.setAttribute('aria-expanded',String(expanded));hint.hidden=!expanded;});
   hint.append(el('p',{text:'LTV = все фактические оплаты минус возвраты, делённые на число клиентов с оплаченным состоявшимся визитом. Учитывается вся подтверждённая история до выбранной даты. Это выручка на клиента, не прибыль и не прогноз.'}),el('p',{text:data?.source.asOf?`Данные по ${time(data.source.asOf)} (Иркутск).`:'Полнота истории пока не подтверждена.'}));
   const ltv=card('LTV','Средняя выручка на платившего клиента за всю историю',data?.ltv.value==null?null:money(data.ltv.value),help);ltv.append(hint,data&&!loading&&!error&&data.ltv.value!==null?chart(data.ltvSeries,'money','LTV на конец месяца'):note(data?.ltv.reason));
   root.replaceChildren(meta,content);root.setAttribute('aria-busy',String(loading));
   w.requestAnimationFrame(()=>{if(disposed)return;if(root.parentElement&&parent!==root.parentElement){observer?.disconnect();parent=root.parentElement;observer?.observe(parent);}fit();});
  }
  async function refresh(){
   if(disposed)return;const ticket=++seq;abort?.abort();abort=new w.AbortController();data=null;error='';loading=true;paint();
   try{const result=await request({...q},{signal:abort.signal});if(disposed||ticket!==seq)return;data=validate(result,companyCode,q);}
   catch(e){if(disposed||ticket!==seq)return;if([401,403].includes(e.status)){onUnauthorized(e);if(disposed)return;}error=e.status===404?'Отчёты ещё не подключены в приложении.':e.message||'Не удалось получить отчёт.';}
   if(disposed||ticket!==seq)return;loading=false;paint();
  }
  w.addEventListener('resize',fit);void refresh();
  return{element:root,refresh,query:()=>({...q}),dispose:()=>{disposed=true;seq++;abort?.abort();observer?.disconnect();w.removeEventListener('resize',fit);root.replaceChildren();}};
 }
 return Object.freeze({create,normalize,entry,validate,money});
});
