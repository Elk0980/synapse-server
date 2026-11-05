/* Generated from frozen Root shell; no edits to its report logic. */
(function(root,build){'use strict';const api=build();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'PalitraMiniappSourceReport',{value:api,writable:false});})(typeof globalThis!=='undefined'?globalThis:this,function(){'use strict';

  const SOURCE_REPORT_LABELS=Object.freeze({vk:'ВКонтакте',telegram:'Telegram',instagram:'Instagram',youtube:'YouTube',tiktok:'TikTok',other:'Другая ссылка',unknown:'Без метки'});
  function sourceReportRange(now=Date.now()) { return {from:new Date(now-30*86400000).toISOString(),until:new Date(now).toISOString()}; }
  function checkedSourceReport(data,query) {
    const object=v=>v && typeof v==='object' && !Array.isArray(v),stamp=v=>typeof v==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString()===v;
    const count=n=>Number.isSafeInteger(n)&&n>=0,fail=()=>{throw new Error('Не удалось проверить статистику источников. Обновите отчёт.');};
    if(!object(data)||data.schema!=='palitra-attribution/v1'||data.companyCode!=='palitra-love'||!['ready','empty','not_observed'].includes(data.status)||!stamp(data.startedAt)||!stamp(data.asOf)||!stamp(data.from)||!stamp(data.until)||data.from!==query.from||data.until!==query.until||data.from>data.until||data.until>data.asOf||Date.parse(data.until)-Date.parse(data.from)>366*86400000||!object(data.coverage)||data.coverage.visits!=='consented_only'||data.coverage.leads!=='new_accepted_only'||data.coverage.historicalVisits!=='not_backfilled'||!Array.isArray(data.sources)||data.sources.length!==7)fail();
    const known=data.status!=='not_observed',seen=new Set(),totals={visits:0,leads:0,linkedLeads:0};
    if(data.startedAt>data.asOf || known!==(data.until>data.startedAt))fail();
    for(const row of data.sources) {
      if(!object(row)||!Object.prototype.hasOwnProperty.call(SOURCE_REPORT_LABELS,row.source)||seen.has(row.source))fail();seen.add(row.source);
      for(const key of Object.keys(totals)){if(known?!count(row[key]):row[key]!==null)fail();if(known){totals[key]+=row[key];if(!count(totals[key]))fail();}}
      if(known&&row.linkedLeads>row.leads)fail();
    }
    if(known){if(!object(data.totals)||Object.keys(totals).some(k=>data.totals[k]!==totals[k]))fail();if(data.status==='empty'&&Object.values(totals).some(n=>n!==0)||data.status==='ready'&&!totals.visits&&!totals.leads)fail();}
    else if(data.totals!==null)fail();
    return data;
  }
  function createSourceReport({h,win,read,help,isCurrent}) {
    const element=h('section',{class:'card source-report','aria-label':'Источники клиентов'});
    let request=null,serial=0,disposed=false;
    function paint({mode,data,query}={}) {
      const refresh=h('button',{type:'button',class:'app-btn app-btn--ghost',disabled:mode==='loading',onclick:()=>{void load();},text:'Обновить'});
      const rows=[h('div',{class:'source-report__header'},h('h2',{class:'text__title',text:'Источники клиентов'}),help?.('Переходы учитываются только после согласия на аналитику, обращения — с момента запуска учёта. «Связано с переходом» — обращения с подтверждённым переходом. Метка ссылки не доказывает рекламный источник. Процент конверсии здесь не рассчитывается.','О статистике источников'),refresh)];
      if(query)rows.push(h('p',{class:'source-report__period',text:'За 30 дней · '+new Date(query.from).toLocaleDateString('ru-RU')+' — '+new Date(query.until).toLocaleDateString('ru-RU')}));
      if(mode==='loading')rows.push(h('p',{class:'app-empty',role:'status',text:'Загружаем источники…'}));
      else if(mode!=='ready')rows.push(h('p',{class:mode==='error'?'app-error':'app-empty',role:mode==='error'?'alert':'status',text:mode==='not-started'?'Учёт источников ещё не запущен':mode==='missing'?'Статистика источников сейчас недоступна. Обновите интерфейс.':'Не удалось загрузить источники. Попробуйте обновить отчёт.'}));
      else {
        if(data.status==='not_observed')rows.push(h('p',{class:'app-empty',text:'Нет данных за этот период.'}));
        const bySource=new Map(data.sources.map(row=>[row.source,row]));
        rows.push(h('ul',{class:'source-report__rows'},Object.entries(SOURCE_REPORT_LABELS).map(([key,label])=>{
          const row=bySource.get(key),metric=(name,value)=>h('div',{},h('dt',{text:name}),h('dd',{text:value===null?'Нет данных':String(value)}));
          return h('li',{},h('h3',{text:label}),h('dl',{},metric('Переходы',row.visits),metric('Обращения',row.leads),metric('Связано с переходом',row.linkedLeads)));
        })));
      }
      element.replaceChildren(...rows);
    }
    async function load() {
      const id=++serial;request?.abort();request=new win.AbortController();const signal=request.signal,query=sourceReportRange();
      if(typeof read!=='function'){paint({mode:'missing',query});return;}
      paint({mode:'loading',query});
      try { const data=checkedSourceReport(await read({...query,signal}),query);if(!disposed&&!signal.aborted&&id===serial&&isCurrent())paint({mode:'ready',data,query}); }
      catch(error){if(!disposed&&!signal.aborted&&id===serial&&isCurrent())paint({mode:error.status===503&&['ATTRIBUTION_NOT_READY','ATTRIBUTION_SCHEMA'].includes(error.code)?'not-started':'error',query});}
    }
    void load();
    return {element,refresh:load,dispose(){disposed=true;serial++;request?.abort();}};
  }
  
function managerEntrySource(item) {
    // These are record/channel kinds, never inferred advertising attribution.
    const source=item?.source,entryLabels={site_order:'Заявка',site_chat:'Чат сайта',telegram:'Telegram',unknown:'Источник не указан'};
    const entry = source && entryLabels[source.entryKind] || (item?.kind === 'order' ? 'Заявка' : item?.kind === 'web-thread' ? 'Чат сайта' : item?.kind === 'legacy-dialog' ? 'Telegram' : 'Источник не указан');
    const labels={vk:'ВКонтакте',telegram:'Telegram',instagram:'Instagram',youtube:'YouTube',tiktok:'TikTok',other:'другая ссылка'};
    // The recorded URL label is a fact about the link, not proof of the external referrer.
    return source && ['recorded','legacy_order'].includes(source.basis) && labels[source.trafficSource] ? entry+' · метка '+labels[source.trafficSource] : entry;
  }

return Object.freeze({createSourceReport,managerEntrySource});
});
