/* Palitra Love Заказы — хост рабочего подключения к существующему Synapse.

   Открывается только на разрешённых адресах: кабинет https://synapse.synapsebusiness.ru (whoami cookie + CSRF)
   и магазин https://palitra-love.ru (сессия аккаунта /api/draft-account/session, portal через штатный crm-session.js,
   чат сайта /api/customer-chat/*). Новой авторизации нет: только существующие относительные маршруты моста.

   Сеть, CRM и чат включены после проверки Root. Изменение флагов требует отдельного проверенного выпуска
   (свободное окно общего сервера, origin/CSP, PALITRA_APP_ORIGIN). Адрес, роль, localStorage и данные макета флаги
   не меняют. Проверки разрешённого адреса, сессии и CSRF выполняются перед каждым запросом.
   CSRF/токены живут только в замыкании этого файла и в штатном crm-session.js; в state оболочки, URL и манифест не идут. */
'use strict';
(() => {
  const B = window.SynapseBridge;
  const FLAGS = Object.freeze({ network: true, crm: true, e1Native: true });
  const CABINET = B.ORIGINS.synapse, SHOP = B.ORIGINS.shop;
  const origin = window.location.origin;
  /* Точка входа задаётся страницей: shop.html (data-entry="shop", data-auth="site", штатный crm-session.js до этого файла)
     или cabinet.html (data-entry="cabinet", без инициализации магазина). Страница работает только на «своём» адресе. */
  const root = document.documentElement;
  const entry = root.dataset.entry === 'shop' || root.dataset.entry === 'cabinet' ? root.dataset.entry : '';
  const allowed = (entry === 'cabinet' && origin === CABINET) || (entry === 'shop' && origin === SHOP && root.dataset.auth === 'site');
  let cabinetCsrf = '', accountCsrf = '', chatCsrf = '';
  function orderReadAccess() {
    if(activeCompany!=='palitra-love' || entry!=='cabinet' || origin!==CABINET || FLAGS.network!==true || !cabinetCsrf)throw Object.assign(new Error('Нет доступа к сообщениям.'),{status:403});
    const company=activeCompany,csrf=cabinetCsrf;
    return ()=>{if(activeCompany!==company || cabinetCsrf!==csrf)throw Object.assign(new Error('Вход изменился. Откройте заказы заново.'),{status:403});};
  }
  const listeners = [];
  let activeCompany = 'palitra-love';
  let contentDayEpoch = 0;

  // Optional recorded attribution enriches labels only; it grants no capability or identity.
  function validateManagerSource(source) {
    const plain=v=>v && typeof v==='object' && !Array.isArray(v),platform=v=>v===null || ['vk','telegram','instagram','youtube','tiktok','other'].includes(v);
    const utm=v=>plain(v) && Object.entries(v).every(([k,x])=>['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].includes(k) && typeof x==='string' && x.length<=200 && !/[\x00-\x1f\x7f<>]/.test(x));
    const touch=v=>v===null || plain(v) && platform(v.trafficSource) && utm(v.utm);
    if(!plain(source) || !['site_order','site_chat','telegram','unknown'].includes(source.entryKind) || !platform(source.trafficSource) || !utm(source.utm) || !touch(source.firstTouch) || !touch(source.lastTouch) || !['recorded','legacy_order','channel_only','unknown'].includes(source.basis))throw new Error('Не удалось проверить источник. Обновите заказы.');
    return source;
  }
  function createContentDayTransport() {
    const positive=n=>Number.isSafeInteger(n)&&n>0;
    const day=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\d$/.test(s)&&Number.isFinite(Date.parse(s+'T12:00:00Z'))&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s;
    const bad=()=>{throw Error('CONTENT_DAY_RESPONSE');};
    function validSource(b){const current=b.copySource==='current-material';return (b.copySource===undefined||['published-snapshot','current-material'].includes(b.copySource))&&(current?positive(b.currentContentRevision)&&b.confirmCurrentSource===true&&b.publishedContentRevision===undefined:b.currentContentRevision===undefined&&b.confirmCurrentSource===undefined&&(b.publishedContentRevision===undefined||positive(b.publishedContentRevision)));}function copy(v){if(v?.schema!=='palitra-content-copy/v1'||v.companyCode!=='palitra-love'||!/^[-a-zA-Z0-9_]{8,100}$/.test(v.requestId||'')||typeof v.found!=='boolean')bad();if(!v.found)return {schema:v.schema,companyCode:v.companyCode,requestId:v.requestId,found:false};if(!positive(v.sourceId)||!positive(v.sourceRevision)||!/^[-a-z0-9_]{1,64}$/.test(v.platformId||'')||!positive(v.post?.id)||!positive(v.post.revision)||!['draft','scheduled','publishing','published','failed','needs_review','cancelled'].includes(v.post.status))bad();return {schema:v.schema,companyCode:v.companyCode,requestId:v.requestId,found:true,sourceId:v.sourceId,sourceRevision:v.sourceRevision,platformId:v.platformId,copySource:v.copySource||'published-snapshot',sourceContentRevision:v.sourceContentRevision??null,post:{id:v.post.id,revision:v.post.revision,status:v.post.status,scheduledAt:v.post.scheduledAt},...(v.planCopy&&typeof v.planCopy.versionId==='string'&&v.planCopy.status==='pending'?{planCopy:{versionId:v.planCopy.versionId,status:'pending'}}:{})};}
    function project(v,expected){if(v?.schema!=='palitra-content-day/v1'||v.companyCode!=='palitra-love'||!day(v.date)||expected&&v.date!==expected||!day(v.today)||typeof v.timezone!=='string'||!Array.isArray(v.channels)||!v.coverage||typeof v.coverage.complete!=='boolean'||!Number.isSafeInteger(v.coverage.unknownDateCount)||typeof v.capabilities?.duplicateDraft!=='boolean')bad();new Intl.DateTimeFormat('ru-RU',{timeZone:v.timezone});return {schema:v.schema,companyCode:v.companyCode,actorScope:v.actorScope,date:v.date,today:v.today,timezone:v.timezone,asOf:v.asOf,coverage:{basis:v.coverage.basis,complete:v.coverage.complete,unknownDateCount:v.coverage.unknownDateCount},capabilities:{duplicateDraft:v.capabilities.duplicateDraft},channels:v.channels.map(c=>({id:c.id,platform:c.platform,name:c.name,connected:c.connected,enabled:c.enabled,published:c.published.map(p=>({postId:p.postId,revision:p.revision,contentRevision:p.contentRevision,title:p.title,excerpt:p.excerpt,format:p.format,key:p.key,basis:p.basis,at:p.at,url:p.url,publishedContentRevision:p.publishedContentRevision,copyable:p.copyable,copyUnavailableReason:p.copyUnavailableReason,...(p.currentMaterial?{currentMaterial:{revision:p.currentMaterial.revision,contentRevision:p.currentMaterial.contentRevision,title:p.currentMaterial.title,text:p.currentMaterial.text,format:p.currentMaterial.format}}:{})})),planned:c.planned.map(p=>({postId:p.postId,revision:p.revision,contentRevision:p.contentRevision,title:p.title,format:p.format,state:p.state,scheduledAt:p.scheduledAt}))}))};}
    async function request(path,{method='GET',body,signal,validate=v=>v}={}){const write=method!=='GET';let dispatched=false;const captured={company:activeCompany,csrf:cabinetCsrf,epoch:contentDayEpoch};const check=()=>{if(!allowed||entry!=='cabinet'||origin!==CABINET||FLAGS.network!==true||activeCompany!=='palitra-love'||!cabinetCsrf||signal?.aborted||captured.company!==activeCompany||captured.csrf!==cabinetCsrf||captured.epoch!==contentDayEpoch)throw Object.assign(Error('CONTENT_CONTEXT_CHANGED'),{status:403,contextChanged:true});};try{check();dispatched=true;const response=await window.fetch(path+(path.includes('?')?'&':'?')+'companyCode=palitra-love',{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal,headers:{Accept:'application/json',...(write?{'Content-Type':'application/json','X-CSRF-Token':captured.csrf}:{})},...(write?{body:JSON.stringify(body)}:{})});check();if(!response.ok){let detail;try{detail=await response.json();}catch{}check();throw Object.assign(Error('CONTENT_HTTP'),{status:response.status,code:detail?.details?.code==='PLAN_LINKED_POST'?'PLAN_LINKED_POST':null,definitive:[400,401,403,404,409,413,415,422].includes(response.status)});}const value=await response.json();check();return validate(value);}catch(e){if(write){e.unknown=dispatched&&e.definitive!==true;if(!dispatched)e.definitive=true;}throw e;}}
    return Object.freeze({readDay:({date,signal}={})=>{if(date!==undefined&&!day(date))throw TypeError('CONTENT_DATE');return request('/content/crm/autoposting/day'+(date?'?date='+date:''),{signal,validate:v=>project(v,date)});},duplicate:(id,body,{signal}={})=>{if(!positive(id)||!body||!validSource(body)||Object.keys(body).some(k=>!['revision','platformId','clientRequestId','publishedContentRevision','copySource','currentContentRevision','confirmCurrentSource'].includes(k))||!positive(body.revision)||!/^[-a-z0-9_]{1,64}$/.test(body.platformId||'')||!/^[-a-zA-Z0-9_]{8,100}$/.test(body.clientRequestId||''))throw Object.assign(TypeError('CONTENT_COPY'),{definitive:true});return request('/content/crm/autoposting/posts/'+id+'/day-copy',{method:'POST',body,signal,validate:v=>{const result=copy(v);if(result.copySource!==(body.copySource||'published-snapshot')||(body.copySource==='current-material'&&result.sourceContentRevision!==body.currentContentRevision))bad();return result;}});},lookup:(id,{signal,copySource='published-snapshot'}={})=>{if(!/^[-a-zA-Z0-9_]{8,100}$/.test(id))throw TypeError('CONTENT_COPY_ID');if(!['published-snapshot','current-material'].includes(copySource))throw TypeError('CONTENT_COPY_SOURCE');return request('/content/crm/autoposting/day-copies/'+id+(copySource==='current-material'?'?copySource=current-material':''),{signal,validate:v=>{const result=copy(v);if(result.requestId!==id||(result.found&&result.copySource!==copySource))bad();return result;}});}});
  }

  // PALITRA_ATTENTION_DISPLAY_V2_VALIDATOR_BEGIN
  function validateManagerAttentionDisplay(data,query){
    const bad=()=>{throw new Error('Сервер не подтвердил группировку заявок. Обновите список.');};
    const plain=v=>v&&typeof v==='object'&&!Array.isArray(v),count=v=>Number.isSafeInteger(v)&&v>=0;
    const date=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
    const keys=['total','attention','unanswered','firstContact','inWork','refused','completed'];
    const counts=(v,canonical=false)=>plain(v)&&keys.every(k=>count(v[k]))&&v.total===v.inWork+v.refused+v.completed&&v.attention<=v.total&&v.unanswered<=v.attention&&v.firstContact<=v.attention&&
      (canonical?v.unanswered+v.firstContact===v.attention:v.unanswered+v.firstContact>=v.attention);
    const stable=v=>Array.isArray(v)?v.map(stable):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
    if(query.view!=='display-v2'||!plain(data)||data.schema!=='palitra-manager-attention/display-v2'||data.companyCode!=='palitra-love'||data.scopeKey!=='palitra'||data.filter!==query.filter||data.partial!==false||!date(data.asOf)||
      !(/^[a-f0-9]{64}$/).test(data.sourceRevision||'')||!counts(data.counts)||!counts(data.canonicalCounts,true)||keys.some(k=>data.counts[k]>data.canonicalCounts[k])||!Array.isArray(data.items)||data.items.length>query.limit||
      !(data.nextCursor===null||typeof data.nextCursor==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(data.nextCursor)))bad();
    const canonicalPage=Object.fromEntries(keys.map(k=>[k,0]));
    const cardKeys=new Set(),memberKeys=new Set(),memberRefs=new Set(),page={total:0,attention:0,unanswered:0,firstContact:0,inWork:0,refused:0,completed:0};
    for(const item of data.items){const display=item?.display;
      if(!plain(display)||Object.keys(display).sort().join(',')!=='basis,groupKey,members,representativeKey,schema,sort'||display.schema!=='palitra-attention-display/v2'||display.representativeKey!==item.key||
        !Array.isArray(display.members)||display.members.length<1||display.members.length>100||!plain(display.sort)||Object.keys(display.sort).sort().join(',')!=='basisAt,priority'||cardKeys.has(item.key))bad();
      cardKeys.add(item.key);
      for(const member of display.members){
        if(!plain(member)||member.display!==undefined||memberKeys.has(member.key))bad();memberKeys.add(member.key);
        const one={total:1,attention:member.reason?1:0,unanswered:member.reason==='unanswered'?1:0,firstContact:member.reason==='first-contact'?1:0,inWork:member.group==='in_work'?1:0,refused:member.group==='refused'?1:0,completed:member.group==='completed'?1:0};
        for(const key of keys)canonicalPage[key]+=one[key];
        for(const ref of [...member.threadRefs,...member.dialogRefs]){if(memberRefs.has(ref))bad();memberRefs.add(ref);}
        validateManagerAttention({schema:'palitra-manager-attention/v1',companyCode:data.companyCode,scopeKey:data.scopeKey,filter:'all',asOf:data.asOf,partial:false,counts:one,items:[member],nextCursor:null},{filter:'all',limit:1});
      }
      const canonical={...item};delete canonical.display;
      if(JSON.stringify(stable(canonical))!==JSON.stringify(stable(display.members[0])))bad();
      if(display.members.length===1){if(display.basis!=='canonical'||display.groupKey!==item.key)bad();}
      else{
        if(display.basis!=='direct-grant-set'||!/^conversation-display:[a-f0-9]{64}$/.test(display.groupKey)||item.kind!=='order'||item.group!=='in_work'||item.completionPending||item.threadRefs.length!==1||
          display.members.slice(1).some(m=>m.kind!=='web-thread'||m.orderRef!==null||m.group!=='in_work'||m.completionPending||m.threadRefs.length!==1))bad();
      }
      const sorted=[...display.members].sort((a,b)=>(a.reason?0:1)-(b.reason?0:1)||a.basisAt.localeCompare(b.basisAt)||a.key.localeCompare(b.key));
      if(display.sort.priority!==(sorted[0].reason?0:1)||display.sort.basisAt!==sorted[0].basisAt)bad();
      const unanswered=display.members.some(m=>m.reason==='unanswered'),firstContact=display.members.some(m=>m.reason==='first-contact');
      if(query.filter==='attention'&&!unanswered&&!firstContact||['in_work','refused','completed'].includes(query.filter)&&item.group!==query.filter)bad();
      page.total++;if(unanswered||firstContact)page.attention++;if(unanswered)page.unanswered++;if(firstContact)page.firstContact++;page[{in_work:'inWork',refused:'refused',completed:'completed'}[item.group]]++;
    }
    const countKey={all:'total',attention:'attention',in_work:'inWork',refused:'refused',completed:'completed'}[query.filter];
    if(!countKey||data.items.length>data.counts[countKey]||keys.some(k=>page[k]>data.counts[k]||canonicalPage[k]>data.canonicalCounts[k])||data.nextCursor!==null&&!data.items.length)bad();
    return data;
  }
  // PALITRA_ATTENTION_DISPLAY_V2_VALIDATOR_END

  // PALITRA_MANAGER_ATTENTION_VALIDATOR: read-only data, never grants or action capabilities.
  function validateManagerAttention(data, query) {
    const bad = () => { throw new Error('Сервер не подтвердил список клиентов. Обновите список.'); };
    if(data?.schema==='palitra-manager-attention/display-v2')return validateManagerAttentionDisplay(data,query);
    if(query.view==='display-v2')bad();
    const plain = v => v && typeof v === 'object' && !Array.isArray(v);
    const date = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
    const count = v => Number.isSafeInteger(v) && v >= 0;
    if (!plain(data) || data.schema !== 'palitra-manager-attention/v1' || data.companyCode !== 'palitra-love' ||
        data.scopeKey !== 'palitra' || data.filter !== query.filter || !date(data.asOf) || data.partial !== false ||
        !plain(data.counts) || !['total','attention','unanswered','firstContact','inWork','refused','completed'].every(k => count(data.counts[k])) ||
        data.counts.total !== data.counts.inWork + data.counts.refused + data.counts.completed ||
        data.counts.attention > data.counts.total || data.counts.unanswered + data.counts.firstContact !== data.counts.attention ||
        !Array.isArray(data.items) || data.items.length > query.limit ||
        !(data.nextCursor === null || typeof data.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(data.nextCursor))) bad();
    const keys = new Set(), ref = (v,p) => v === null || typeof v === 'string' && new RegExp('^'+p+':[1-9]\\d*$').test(v) && Number.isSafeInteger(Number(v.split(':')[1]));
    const refs = (v,p) => Array.isArray(v) && v.every((r,i) => r !== null && ref(r,p) && (i === 0 || Number(v[i-1].split(':')[1]) < Number(r.split(':')[1])));
    for (const item of data.items) {
      const stage = item && (item.stage || item.nativeStage);
      if(item?.source !== undefined) validateManagerSource(item.source);
      if (!plain(item) || typeof item.key !== 'string' || !/^(order|thread|legacy):[1-9]\d*$/.test(item.key) || keys.has(item.key) ||
          !['order','web-thread','legacy-dialog'].includes(item.kind) || !ref(item.orderRef,'native-order') || !ref(item.threadRef,'thread') || !ref(item.dialogRef,'legacy') ||
          !refs(item.threadRefs,'thread') || !refs(item.dialogRefs,'legacy') || item.threadRef !== (item.threadRefs[0] || null) || item.dialogRef !== (item.dialogRefs[0] || null) ||
          (item.reason === 'unanswered' ? ![...item.threadRefs,...item.dialogRefs].includes(item.attentionRef) : item.attentionRef !== null) ||
          item.orderRef === null && item.threadRef === null && item.dialogRef === null ||
          typeof item.customerLabel !== 'string' || item.customerLabel.length > 100 ||
          ![null,'unanswered','first-contact'].includes(item.reason) || item.reason === 'first-contact' && item.orderRef === null || query.filter === 'attention' && item.reason === null ||
          !date(item.basisAt) || Date.parse(item.basisAt) > Date.parse(data.asOf) || !count(item.ageSeconds) ||
          item.ageSeconds !== Math.floor((Date.parse(data.asOf)-Date.parse(item.basisAt))/1000) ||
          ![null,'customer-first-reply'].includes(item.deadlineKind) ||
          !(item.dueAt === null && item.deadlineKind === null || date(item.dueAt) && item.deadlineKind === 'customer-first-reply' && item.reason === 'first-contact') ||
          !['in_work','refused','completed'].includes(item.group) ||
          !(item.completionPending === undefined || typeof item.completionPending === 'boolean') ||
          item.completionPending === true && (item.group !== 'in_work' || stage?.id !== 'issued') ||
          item.group === 'refused' && stage?.id !== 'cancelled' || item.group === 'completed' && stage?.id !== 'issued' ||
          stage?.id === 'cancelled' && item.group !== 'refused' || stage?.id === 'issued' && item.group === 'in_work' && item.completionPending !== true ||
          ['in_work','refused','completed'].includes(query.filter) && item.group !== query.filter ||
          !['stored','uninitialized'].includes(item.workflowState) || (item.workflowState === 'uninitialized' ? item.stage !== null : item.stage === null) ||
          !(item.nativeStage === undefined || item.nativeStage === null || item.workflowState === 'uninitialized' && item.stage === null && plain(item.nativeStage)
            && ['issued','cancelled'].includes(item.nativeStage.id) && typeof item.nativeStage.label === 'string' && item.nativeStage.label.length <= 100 && item.nativeStage.since === null) ||
          !(item.stage === null || plain(item.stage) && typeof item.stage.id === 'string' && item.stage.id.length <= 100 && typeof item.stage.label === 'string' && item.stage.label.length <= 100 && (item.stage.since === null || date(item.stage.since) && Date.parse(item.stage.since)<=Date.parse(data.asOf)))) bad();
      if (item.kind === 'order' && item.key !== item.orderRef?.replace('native-order:','order:') ||
          item.kind === 'web-thread' && (item.key !== item.threadRef || item.orderRef !== null) ||
          item.kind === 'legacy-dialog' && (item.key !== item.dialogRef || item.orderRef !== null)) bad();
      keys.add(item.key);
    }
    const countKey = { all:'total', attention:'attention', in_work:'inWork', refused:'refused', completed:'completed' }[query.filter];
    if (!countKey || data.nextCursor !== null && data.items.length === 0 || data.items.length > data.counts[countKey]) bad();
    for (const [group,key] of [['in_work','inWork'],['refused','refused'],['completed','completed']]) if (data.items.filter(item => item.group === group).length > data.counts[key]) bad();
    return data;
  }
  // PALITRA_MANAGER_ATTENTION_VALIDATOR_END

  // PALITRA_RESPONSE_REPORT_VALIDATOR: observation facts only, no capabilities.
  function validateResponseReport(data) {
    const bad = () => { throw new Error('Сервер не подтвердил статистику ответов. Обновите отчёт.'); };
    const plain = v => v && typeof v === 'object' && !Array.isArray(v);
    const date = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
    const count = v => Number.isSafeInteger(v) && v >= 0;
    const seconds = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    const stat = v => plain(v) && count(v.sampleCount) && (v.sampleCount === 0 ? v.medianSeconds === null && v.meanSeconds === null : seconds(v.medianSeconds) && seconds(v.meanSeconds));
    if (!plain(data) || data.schema !== 'palitra-response-report/v1' || data.companyCode !== 'palitra-love' || !date(data.asOf) ||
        !(data.observationStartedAt === null || date(data.observationStartedAt) && Date.parse(data.observationStartedAt) <= Date.parse(data.asOf)) ||
        !plain(data.range) || !date(data.range.until) || Date.parse(data.range.until) > Date.parse(data.asOf) || typeof data.range.truncatedAtStart !== 'boolean' ||
        !(data.range.from === null && (data.observationStartedAt === null || data.coverage?.period === 'before_observation') || date(data.range.from) && data.observationStartedAt !== null && Date.parse(data.range.from) >= Date.parse(data.observationStartedAt) && Date.parse(data.range.from) < Date.parse(data.range.until)) ||
        !plain(data.coverage) || data.coverage.status !== (data.observationStartedAt === null ? 'not_started' : 'observing') || data.coverage.beforeObservation !== 'excluded' || data.coverage.period !== (data.observationStartedAt === null ? 'not_started' : data.range.from === null ? 'before_observation' : 'observed') ||
        data.coverage.canonicalTelegramSentAt !== 'latest-confirmed-delivery-update' || data.coverage.legacyTelegramSentAt !== 'outbox-finished-at' ||
        !Array.isArray(data.channels) || data.channels.length !== 6) bad();
    const ids = ['site','telegram','vk','instagram','youtube','tiktok'];
    for (let i=0;i<ids.length;i++) {
      const row=data.channels[i];
      if (!plain(row) || row.id !== ids[i] || !['connected','not_connected','unobserved'].includes(row.status) || !stat(row.first) || !stat(row.subsequent) ||
          !plain(row.waiting) || !count(row.waiting.count) ||
          !(row.waiting.count === 0 ? row.waiting.oldestSince === null && row.waiting.oldestSeconds === null : data.observationStartedAt !== null && date(row.waiting.oldestSince) && Date.parse(row.waiting.oldestSince) >= Date.parse(data.observationStartedAt) && Date.parse(row.waiting.oldestSince)<=Date.parse(data.asOf) && row.waiting.oldestSeconds === Math.floor((Date.parse(data.asOf)-Date.parse(row.waiting.oldestSince))/1000)) ||
          !plain(row.beforeObservationWaiting) || !count(row.beforeObservationWaiting.count) ||
          !(row.beforeObservationWaiting.count === 0 ? row.beforeObservationWaiting.oldestSince === null : data.observationStartedAt !== null && date(row.beforeObservationWaiting.oldestSince) && Date.parse(row.beforeObservationWaiting.oldestSince)<Date.parse(data.observationStartedAt))) bad();
      if (data.observationStartedAt === null && (row.first.sampleCount || row.subsequent.sampleCount || row.waiting.count || row.beforeObservationWaiting.count)) bad();
    }
    return data;
  }
  // PALITRA_RESPONSE_REPORT_VALIDATOR_END

  // PALITRA_CONTENT_TASKS_VALIDATOR: existing calendar, never a second task store.
  function validateContentTasks(data,from,to) {
    const bad = () => { throw new Error('Сервер не подтвердил контент-план Палитры. Обновите список.'); };
    const plain = v => v && typeof v === 'object' && !Array.isArray(v);
    const day = v => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v+'T00:00:00Z')) && new Date(v+'T00:00:00Z').toISOString().slice(0,10) === v;
    const count = v => Number.isSafeInteger(v) && v >= 0;
    const states=['missing','pending','ready','published','inactive'];
    const issues=v=>Array.isArray(v)&&v.every(x=>typeof x==='string'&&x.length<=2000);
    const ready = v => plain(v) && states.includes(v.state) && v.ready === (v.state==='ready') && issues(v.issues);
    if (!plain(data) || data.companyCode !== 'palitra-love' || data.from !== from || data.to !== to || !day(data.today) ||
        typeof data.timezone !== 'string' || !data.timezone || data.truncated !== false || typeof data.undatedTruncated !== 'boolean' ||
        !Array.isArray(data.posts) || !Array.isArray(data.undated) || !count(data.undatedTotal) || data.undatedTotal<data.undated.length ||
        !plain(data.coverage) || !['none','current_plan'].includes(data.coverage.basis) || !plain(data.summary)) bad();
    try {new Intl.DateTimeFormat('ru-RU',{timeZone:data.timezone});} catch(_){bad();}
    const ids=new Set();
    for (const [rows,dated] of [[data.posts,true],[data.undated,false]]) for (const row of rows) {
      if (!plain(row) || !Number.isSafeInteger(row.id) || row.id<1 || ids.has(row.id) || row.companyCode!=='palitra-love' ||
          !Number.isSafeInteger(row.revision) || row.revision<1 || typeof row.title!=='string' || row.title.length>200 ||
          !(dated ? day(row.effectiveDate)&&row.effectiveDate>=from&&row.effectiveDate<=to : row.effectiveDate===null) ||
          !ready(row.calendarReadiness) || !Array.isArray(row.calendarReadiness.platforms)) bad();
      const platforms=new Set();
      for (const item of row.calendarReadiness.platforms) {
        // A published receipt is truthful even though ready:false (not future stock).
        if (!plain(item) || typeof item.platform!=='string' || !/^[a-z0-9_-]{1,64}$/.test(item.platform) || platforms.has(item.platform) ||
            !states.includes(item.state) || typeof item.ready!=='boolean' || item.ready && item.state!=='ready' || !issues(item.issues)) bad();
        platforms.add(item.platform);
      }
      ids.add(row.id);
    }
    return data;
  }
  // PALITRA_CONTENT_TASKS_VALIDATOR_END

  // Push HTTP возвращает {ok:false,code}; не переносим произвольный ответ/секреты в интерфейс.
  const PUSH_ERRORS = Object.freeze({
    PUSH_ORIGIN: 'Сервер не подтвердил адрес приложения. Подписка не подтверждена.',
    PUSH_JSON_REQUIRED: 'Сервер не принял формат запроса подписки.',
    PUSH_BODY_LIMIT: 'Сервер не принял размер запроса подписки.',
    PUSH_JSON: 'Сервер не смог прочитать данные подписки.',
    PUSH_FIELDS: 'Сервер не принял поля подписки этого браузера.',
    PUSH_SUBSCRIPTION: 'Сервер не принял данные подписки этого браузера.',
    PUSH_ENDPOINT: 'Сервер не принял адрес службы уведомлений этого браузера.',
    PUSH_PROVIDER: 'Служба уведомлений этого браузера пока не поддерживается.',
    PUSH_KEY: 'Сервер не принял ключи подписки этого браузера.',
    PUSH_EXPIRATION: 'Срок подписки истёк или не распознан сервером.',
    PUSH_ACTOR: 'Сервер не подтвердил текущую учётную запись.',
    PUSH_ACTOR_CHANGED: 'Учётная запись изменилась. Откройте приложение заново.',
    PUSH_ACTOR_REVOKED: 'Доступ учётной записи изменился. Войдите в приложение заново.',
    PUSH_FORBIDDEN: 'Для этой учётной записи нет доступа к уведомлениям.',
    PUSH_ENDPOINT_OTHER_ACTOR: 'Эта подписка связана с другой учётной записью.',
    PUSH_DEVICE_LIMIT: 'Достигнут лимит подключённых устройств для этой учётной записи.',
    PUSH_SUBSCRIPTION_NOT_FOUND: 'Подписка этой учётной записи не найдена на сервере.',
    PUSH_NOT_READY: 'Служба уведомлений ещё не готова. Попробуйте позже.',
    PUSH_NOT_CONFIGURED: 'Уведомления пока не настроены на сервере.',
    PUSH_KEYS_UNAVAILABLE: 'Служба уведомлений временно недоступна на сервере.',
    PUSH_STORE: 'Сервер не смог прочитать сохранённую подписку.',
    PUSH_STORE_LIMIT: 'Сервер не смог обработать список подписок.',
    PUSH_UNAVAILABLE: 'Служба уведомлений временно недоступна.',
    PUSH_BAD_RESPONSE: 'Сервер вернул нераспознанный ответ. Подключение не подтверждено.',
    METHOD: 'Сервер не поддерживает это действие с подпиской.',
    NOT_FOUND: 'Сервис подписки не найден на сервере.',
  });
  function pushHttpError(operation, method, status, data) {
    const safeOperation = ['capability', 'subscription', 'subscription/status'].includes(operation) ? operation : 'unknown';
    const code = data && typeof data.code === 'string' && Object.prototype.hasOwnProperty.call(PUSH_ERRORS, data.code) ? data.code : 'PUSH_REQUEST_FAILED';
    const safeStatus = Number.isInteger(status) && status >= 100 && status < 600 ? status : 0;
    const action = safeOperation === 'capability' ? 'Проверка готовности уведомлений' : safeOperation === 'subscription/status' || method === 'GET' ? 'Проверка подписки' : method === 'DELETE' ? 'Отключение уведомлений' : 'Сохранение подписки';
    const fallback = safeStatus === 401 ? 'Сессия завершилась. Войдите в приложение заново.'
      : safeStatus === 403 ? 'Сервер не подтвердил доступ к уведомлениям для текущего входа.'
        : safeStatus === 409 ? 'Состояние подписки изменилось. Подключение не подтверждено.' : 'Не удалось подтвердить подписку на сервере. Можно продолжить без уведомлений.';
    const message = safeStatus === 401 ? fallback : code === 'PUSH_UNAVAILABLE' && safeStatus === 403 ? fallback : PUSH_ERRORS[code] || fallback;
    return Object.assign(new Error(`${action}: ${message}`), { name: 'PalitraPushError', code, status: safeStatus, operation: safeOperation });
  }
  let host;
  if (!allowed) {
    // Чужой адрес (в том числе localhost/127.0.0.1) или страница другого входа: транспорта нет — «Подключение не настроено».
    host = { mode: 'blocked', reason: entry ? 'origin' : 'entry' };
  } else {
    // Штатный crm-session.js — только на входе магазина и только в режиме сайта (cookie аккаунта + CSRF, не Telegram).
    const session = entry === 'shop' && window.PalitraSession && window.PalitraSession.auth === 'site' && typeof window.PalitraSession.request === 'function' ? window.PalitraSession : null;
    const transport = B.createNativeTransport({
      // fetch внедряется только здесь, на разрешённом адресе; мост сам глобальный fetch не трогает.
      fetch: (url, init) => window.fetch(url, init),
      host: {
        origin, portalOrigin: SHOP, allowNetwork: FLAGS.network, e1Native: FLAGS.e1Native,
        cabinet: { get csrfToken() { return cabinetCsrf; } },
        account: { get csrf() { return accountCsrf; } },
        chat: { get csrf() { return chatCsrf; } },
        portal: FLAGS.crm && session ? { request: (path, options) => session.request(path, options) } : null,
      },
    });
    host = {
      mode: 'native', verified: true, origin, transport, e1Native: FLAGS.e1Native,
      selectCompany: (code) => {
        if (entry !== 'cabinet' || !window.SynapseCompanies?.profile(code)) throw new Error('Компания недоступна для этого входа');
        contentDayEpoch++; activeCompany = code;
        return B.forCompany(code).createNativeTransport({ fetch: (url, init) => window.fetch(url, init),
          host: { origin, portalOrigin: SHOP, allowNetwork: FLAGS.network, e1Native: code === 'palitra-love' && FLAGS.e1Native,
            cabinet: { get csrfToken() { return cabinetCsrf; } } } });
      },
      // Автоперечитывание открытого чата (5 с) — только при включённых сети и чате сайта E/R1.
      chatAutoRefresh: FLAGS.network === true && FLAGS.e1Native === true,
      // Файлы используют только разрешённую entry/origin и актуальный CSRF замыкания; server uploads.enabled проверяется UI и backend.
      attachments: B.createAttachmentTransport({ fetch: (url, init) => window.fetch(url, init),
        host: { origin, entry, allowNetwork: FLAGS.network, e1Native: FLAGS.e1Native,
          getCsrf: () => entry === 'cabinet' ? cabinetCsrf : chatCsrf } }),
      // Только наличие сессий своего адреса; роли и identity оболочка берёт из ответов whoami/bootstrap.
      getAuthContext: () => (entry === 'cabinet' ? { cabinetSession: true } : { shopSession: true, guest: true, portalAvailable: FLAGS.crm && Boolean(session) }),
      acceptCabinetCsrf: (value) => { contentDayEpoch++; cabinetCsrf = typeof value === 'string' ? value : ''; window.dispatchEvent(new Event('palitra:push-auth-ready')); },
      acceptAccountCsrf: (value) => { accountCsrf = typeof value === 'string' ? value : ''; },
      acceptChatSession: (value) => { chatCsrf = typeof value === 'string' ? value : ''; window.dispatchEvent(new Event('palitra:push-auth-ready')); },
      // Только кабинет, разрешённый origin, network flag и CSRF текущего whoami. Роли проверяет backend.
      managerAttention: Object.freeze({ read: async (options = {}) => {
        if (!options || typeof options !== 'object' || Object.keys(options).some(k => !['filter','limit','cursor','search','view','signal'].includes(k))) throw new TypeError('Некорректный запрос списка клиентов');
        const query = { filter: options.filter === undefined ? 'all' : options.filter, limit: options.limit === undefined ? 30 : options.limit };
        if (!['all','attention','in_work','refused','completed'].includes(query.filter) || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100 ||
            options.cursor !== undefined && (typeof options.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(options.cursor))) throw new TypeError('Некорректный запрос списка клиентов');
        if(options.view!==undefined&&options.view!=='display-v2'||options.search!==undefined&&(typeof options.search!=='string'||options.search.length>120||/[\x00-\x1f\x7f]/.test(options.search)))throw new TypeError('Некорректное представление списка');
        if(options.view!==undefined)query.view=options.view;
        if (activeCompany !== 'palitra-love' || entry !== 'cabinet' || origin !== CABINET || FLAGS.network !== true || !cabinetCsrf) throw Object.assign(new Error('Список клиентов недоступен для этого входа.'), {status:403});
        const sentCompany = activeCompany, sentCsrf = cabinetCsrf;
        const params = new URLSearchParams({filter:query.filter,limit:String(query.limit)});
        if (options.cursor !== undefined) params.set('cursor',options.cursor);
        if(options.view!==undefined)params.set('view',options.view);
        if(options.search!==undefined)params.set('search',options.search);
        const response = await window.fetch('/content/palitra/manager-attention?'+params, {method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:options.signal,headers:{Accept:'application/json'}});
        if (activeCompany !== sentCompany || cabinetCsrf !== sentCsrf) throw Object.assign(new Error('Вход изменился. Откройте список заново.'), {status:403});
        if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'Войдите в приложение заново.' : response.status === 403 ? 'Нет доступа к клиентам Палитры.' : 'Не удалось получить список клиентов. Обновите список.'), {status:response.status});
        const data = await response.json();
        if (activeCompany !== sentCompany || cabinetCsrf !== sentCsrf) throw Object.assign(new Error('Вход изменился. Откройте список заново.'), {status:403});
        return validateManagerAttention(data,query);
      } }),
      attributionReport: Object.freeze({read:async (options={})=>{
        const {from,until,signal}=options;
        if(!options||typeof options!=='object'||Object.keys(options).some(k=>!['from','until','signal'].includes(k))||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(from)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until)||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(until))||new Date(from).toISOString()!==from||new Date(until).toISOString()!==until||from>until||Date.parse(until)>Date.now()||Date.parse(until)-Date.parse(from)>366*86400000)throw new TypeError('Некорректный период источников');
        const check=orderReadAccess(),response=await window.fetch('/content/palitra/attribution/summary?'+new URLSearchParams({from,until}),{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal,headers:{Accept:'application/json'}});
        check();if(!response.ok){let failure;try{failure=await response.json();}catch{}check();throw Object.assign(new Error('Не удалось получить источники.'),{status:response.status,code:['ATTRIBUTION_NOT_READY','ATTRIBUTION_SCHEMA'].includes(failure?.code)?failure.code:null});}const data=await response.json();check();return data;
      }}),
      orderRead: Object.freeze({
        read: async (options={}) => {
          if(!options || typeof options!=='object' || Object.keys(options).some(k=>k!=='signal'))throw new TypeError('Некорректный запрос сообщений');
          const check=orderReadAccess(), response=await window.fetch('/content/palitra/order-read/summary',{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:options.signal,headers:{Accept:'application/json'}});
          check(); if(!response.ok)throw Object.assign(new Error('Счётчик сообщений пока недоступен.'),{status:response.status});
          const data=await response.json();check();return data;
        },
        ack: async body => {
          if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).sort().join(',')!=='id,kind,throughMessageId' || !['thread','legacy'].includes(body.kind) || !Number.isSafeInteger(body.id) || body.id<=0 || !Number.isSafeInteger(body.throughMessageId) || body.throughMessageId<=0)throw new TypeError('Некорректное прочтение сообщения');
          const check=orderReadAccess(),sentCsrf=cabinetCsrf,response=await window.fetch('/content/palitra/order-read/ack',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json','Content-Type':'application/json','X-CSRF-Token':sentCsrf},body:JSON.stringify({kind:body.kind,id:body.id,throughMessageId:body.throughMessageId})});
          check();if(!response.ok)throw Object.assign(new Error('Не удалось подтвердить прочтение.'),{status:response.status});
          const data=await response.json();check();return data;
        }
      }),
      contentTasks: Object.freeze({ ...createContentDayTransport(), read: async (options = {}) => {
        if (!options || typeof options !== 'object' || Object.keys(options).some(k=>!['signal'].includes(k))) throw new TypeError('Некорректный запрос контент-плана');
        if (activeCompany!=='palitra-love' || entry!=='cabinet' || origin!==CABINET || FLAGS.network!==true || !cabinetCsrf) throw Object.assign(new Error('Контент-план недоступен для этого входа.'),{status:403});
        const sentCompany=activeCompany,sentCsrf=cabinetCsrf;
        const check=()=>{if(activeCompany!==sentCompany || cabinetCsrf!==sentCsrf)throw Object.assign(new Error('Вход изменился. Откройте контент-план заново.'),{status:403});};
        const from=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
        const end=new Date(from+'T12:00:00Z');end.setUTCDate(end.getUTCDate()+6);const to=end.toISOString().slice(0,10);
        const params=new URLSearchParams({companyCode:'palitra-love',from,to});
        const response=await window.fetch('/content/crm/autoposting/calendar?'+params,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:options.signal,headers:{Accept:'application/json'}});
        check();
        if(!response.ok)throw Object.assign(new Error(response.status===401?'Войдите в приложение заново.':response.status===403?'Нет доступа к контент-плану Палитры.':'Не удалось загрузить контент-план. Попробуйте ещё раз.'),{status:response.status});
        const data=await response.json();check();return validateContentTasks(data,from,to);
      } }),
      responseReport: Object.freeze({ read: async (options = {}) => {
        if (!options || typeof options !== 'object' || Object.keys(options).some(k => !['signal'].includes(k))) throw new TypeError('Некорректный запрос отчёта');
        if (activeCompany !== 'palitra-love' || entry !== 'cabinet' || origin !== CABINET || FLAGS.network !== true || !cabinetCsrf) throw Object.assign(new Error('Отчёт недоступен для этого входа.'), {status:403});
        const sentCompany = activeCompany, sentCsrf = cabinetCsrf;
        const check = () => { if (activeCompany !== sentCompany || cabinetCsrf !== sentCsrf) throw Object.assign(new Error('Вход изменился. Откройте отчёт заново.'), {status:403}); };
        const response = await window.fetch('/content/palitra/response-report', {method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:options.signal,headers:{Accept:'application/json'}});
        check();
        if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'Войдите в приложение заново.' : response.status === 403 ? 'Нет доступа к отчёту Палитры.' : 'Не удалось получить отчёт. Попробуйте ещё раз.'), {status:response.status});
        const data = await response.json(); check();
        return validateResponseReport(data);
      } }),
      customerReports: Object.freeze({ request: async (query = {}, options = {}) => {
        if (entry !== 'cabinet' || origin !== CABINET || FLAGS.network !== true || !['alvi', 'avokado'].includes(activeCompany)) throw Object.assign(new Error('Отчёты этой компании ещё не подключены.'), { status: 403 });
        for (const key of Object.keys(query)) if (!['mode', 'month', 'day', 'basis'].includes(key) || typeof query[key] !== 'string') throw new TypeError('Неизвестный фильтр отчёта');
        const path = `/content/${window.SynapseCompanies.profile(activeCompany).site}/customer-reports?${new URLSearchParams(query)}`;
        const response = await window.fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: options.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw Object.assign(new Error(response.status === 403 ? 'Нет доступа к отчётам этой компании.' : response.status === 401 ? 'Войдите в приложение заново.' : 'Не удалось получить отчёт.'), { status: response.status });
        return response.json();
      } }),
      workflow: Object.freeze({ request: async (path, options = {}) => {
        const method = options.method || 'GET';
        const base = path === '/content/palitra/workflow' || path === '/content/palitra/workflow/widget-settings' || path === '/content/palitra/workflow/completion-settings';
        const readOnly = path === '/content/palitra/workflow/funnel-report' || path === '/content/palitra/workflow/memo-assets';
        const order = /^\/content\/palitra\/workflow\/(?:orders|threads)\/[1-9]\d*(?:\/(confirm|advance|stage))?$/.exec(path);
        const allowedMethod = base ? ['GET', 'PUT'].includes(method) : readOnly ? method === 'GET' : order ? (order[1] ? method === 'POST' : method === 'GET') : false;
        if (activeCompany !== 'palitra-love' || entry !== 'cabinet' || origin !== CABINET || FLAGS.network !== true || !cabinetCsrf || !allowedMethod) throw Object.assign(new Error('Этапы заказа не подключены для этого входа.'), { status: 403 });
        const sentCompany = activeCompany, sentCsrf = cabinetCsrf;
        const response = await window.fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: options.signal,
          headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': cabinetCsrf } : {}) },
          ...(method !== 'GET' ? { body: JSON.stringify(options.body) } : {}) });
        if (activeCompany !== sentCompany || cabinetCsrf !== sentCsrf) throw Object.assign(new Error('Вход изменился. Откройте заказ заново.'), {status:403});
        const data = await response.json();
        if (activeCompany !== sentCompany || cabinetCsrf !== sentCsrf) throw Object.assign(new Error('Вход изменился. Откройте заказ заново.'), {status:403});
        if (!response.ok) throw Object.assign(new Error(data && data.error && typeof data.error === 'string' ? data.error : 'Не удалось выполнить действие с заказом.'), { status: response.status });
        return data;
      }, memoUpload: async ({ file, requestId } = {}) => {
        if (activeCompany !== 'palitra-love' || entry !== 'cabinet' || origin !== CABINET || FLAGS.network !== true || !cabinetCsrf) throw Object.assign(new Error('Загрузка памятки недоступна для этого входа.'), {status:403});
        if (!(file instanceof window.File) || file.size < 1 || file.size > 2 * 1024 * 1024 || !['application/pdf','image/jpeg','image/png','image/webp'].includes(file.type)
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId || '')
          || !file.name || file.name.length > 180 || /[\x00-\x1f\x7f\\/]/.test(file.name)) throw new TypeError('Выберите памятку PDF, JPG, PNG или WebP размером до 2 МБ.');
        const sentCompany = activeCompany, sentCsrf = cabinetCsrf;
        const check = () => { if (activeCompany !== sentCompany || cabinetCsrf !== sentCsrf) throw Object.assign(new Error('Вход изменился. Откройте настройки заново.'), {status:403}); };
        const response = await window.fetch('/content/palitra/workflow/memo-assets', {method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
          headers:{Accept:'application/json','Content-Type':file.type,'X-CSRF-Token':sentCsrf,'X-Palitra-Memo-Request-Id':requestId,'X-Palitra-Memo-Name':encodeURIComponent(file.name)},body:file});
        check(); const data = await response.json(); check();
        if (!response.ok) throw Object.assign(new Error(typeof data?.error === 'string' ? data.error : 'Не удалось загрузить памятку.'), {status:response.status});
        const a = data?.asset;
        if (data?.ok !== true || typeof data.duplicate !== 'boolean' || !a || a.reference !== 'memo:' + requestId || a.name !== file.name.trim() || a.size !== file.size || a.contentType !== file.type
          || !['photo','document'].includes(a.kind) || !/^[0-9a-f]{64}$/.test(a.sha256 || '') || !Number.isFinite(Date.parse(a.createdAt))) throw new Error('Сервер не подтвердил именно этот файл памятки. Повторите ту же загрузку.');
        return data;
      } }),
      push: Object.freeze({ request: async (operation, options = {}) => {
        const method = options.method || 'GET';
        const permitted = operation === 'capability' ? method === 'GET' : operation === 'subscription' ? ['GET', 'POST', 'DELETE'].includes(method) : operation === 'subscription/status' && method === 'POST';
        const csrf = entry === 'cabinet' ? cabinetCsrf : chatCsrf;
        if ((entry === 'cabinet' && activeCompany !== 'palitra-love') || !permitted || !FLAGS.network || !csrf || (entry === 'shop' && !FLAGS.e1Native)) throw Object.assign(new Error('Уведомления пока не подключены для этого входа.'), { status: 403 });
        const path = (entry === 'cabinet' ? '/content/palitra/push/' : '/api/customer-chat/push/') + operation;
        const response = await window.fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { Accept: 'application/json', [entry === 'cabinet' ? 'X-CSRF-Token' : 'X-Palitra-Chat-CSRF']: csrf, ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) },
          ...(method !== 'GET' ? { body: JSON.stringify(options.body) } : {}) });
        let data;
        try { data = await response.json(); }
        catch (_) { throw pushHttpError(operation, method, response.status, { code: 'PUSH_BAD_RESPONSE' }); }
        if (!response.ok) throw pushHttpError(operation, method, response.status, data);
        return data;
      } }),
      onAuthChange: (fn) => { if (typeof fn === 'function') listeners.push(fn); },
    };
    // Штатное событие завершения portal-сессии (crm-session.js) — смена identity: прежние данные и CSRF очищаются.
    window.addEventListener('palitra:session-ended', () => { contentDayEpoch++; cabinetCsrf = ''; accountCsrf = ''; chatCsrf = ''; for (const fn of listeners) fn(); });
  }
  Object.defineProperty(window, 'PalitraShellHost', { value: Object.freeze(host), writable: false, configurable: false });
})();
