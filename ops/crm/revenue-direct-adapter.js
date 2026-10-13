'use strict';
const crypto=require('node:crypto');
// Только официальный метод чтения отчётов Яндекс Директа (документация сверена 13.10.2026):
// https://yandex.com/dev/direct/doc/en/reports, /headers, /mode, /report-format; https://yandex.ru/dev/direct/doc/ru/example
// Адаптер не создаёт, не меняет и не останавливает кампании: других методов API здесь нет.
const ENDPOINT='https://api.direct.yandex.com/json/v501/reports';
const REPORT_TYPE='CAMPAIGN_PERFORMANCE_REPORT';
const FIELDS=Object.freeze(['Date','CampaignId','Impressions','Clicks','Cost']);
// Статистика Директа всегда по Москве, независимо от географии и расписания показов:
// https://yandex.ru/support/direct/ru/efficiency/timetargeting
const TIMEZONES=['Europe/Moscow'];
const CURRENCIES=['RUB','BYN','KZT','UZS','TRY','USD','EUR','CHF'];
const MAX_BYTES=8*1024*1024,ERROR_BYTES=64*1024,MAX_CAMPAIGNS=100,MAX_DAYS=1096,FALLBACK_RETRY_SECONDS=10;
const UPSTREAM_STATUSES=[400,401,403,429,500,502,503,504];
const OWN=Symbol('revenue-direct-error');
const fail=(code='VALIDATION_ERROR',status=400,extra={})=>{throw Object.assign(new Error(code),{code,status,[OWN]:true},extra);};
const validDay=v=>typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v;
const company=v=>{if(typeof v!=='string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v))fail();return v;};
const id=v=>{if((typeof v!=='string' && typeof v!=='number') || !/^[1-9]\d{0,14}$/.test(String(v)) || !Number.isSafeInteger(Number(v)))fail();return String(v);};
const range=(from,to)=>{if(!validDay(from) || !validDay(to) || from>to || (Date.parse(to)-Date.parse(from))/86400000>=MAX_DAYS)fail('BAD_PERIOD');return {from,to};};
const localDay=(at,timezone)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
const sleep=(ms,signal)=>new Promise(resolve=>{
  if(signal?.aborted)return resolve();
  const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
  const timer=setTimeout(done,ms);signal?.addEventListener('abort',done,{once:true});
});

function directConfiguration(input) {
  if(!input || Array.isArray(input) || typeof input!=='object')fail();
  const keys=['externalLogin','campaignIds','currency','timezone','includeVAT','includeDiscount'];
  if(Object.keys(input).sort().join()!==[...keys].sort().join())fail();
  // Логин клиента, валюта, часовой пояс и режим НДС только из явной привязки: не угадываются по названию компании.
  if(typeof input.externalLogin!=='string' || !/^[a-z0-9](?:[a-z0-9.-]{0,48}[a-z0-9])?$/.test(input.externalLogin))fail();
  if(!Array.isArray(input.campaignIds) || !input.campaignIds.length || input.campaignIds.length>MAX_CAMPAIGNS)fail();
  const campaignIds=input.campaignIds.map(id).sort((a,b)=>Number(a)-Number(b));
  if(new Set(campaignIds).size!==campaignIds.length)fail();
  if(!CURRENCIES.includes(input.currency))fail('BAD_CURRENCY');
  if(!TIMEZONES.includes(input.timezone))fail('BAD_TIMEZONE');
  if(typeof input.includeVAT!=='boolean')fail();
  // Поддерживается один режим: расход с учётом скидки (IncludeDiscount=YES).
  if(input.includeDiscount!==true)fail();
  return {externalLogin:input.externalLogin,campaignIds,currency:input.currency,timezone:input.timezone,includeVAT:input.includeVAT,includeDiscount:true};
}
function directCredential(value) {
  if(!value || typeof value!=='object' || Object.keys(value).join()!=='token')fail();
  // Только печатные ASCII без пробелов: перевод строки не может добавить заголовок запроса.
  if(typeof value.token!=='string' || !value.token.length || value.token.length>4096 || !/^[\x21-\x7e]+$/.test(value.token))fail();
  return value;
}
// Кампании Директа уникальны глобально. Одна кампания у двух компаний означает двойной учёт расхода общего аккаунта.
function assertDisjointDirectBindings(bindings) {
  if(!Array.isArray(bindings))fail();
  const companies=new Set(),owners=new Map();
  for(const b of bindings) {
    const c=company(b?.companyCode),config=directConfiguration(b?.config);
    if(companies.has(c))fail('BINDING_OVERLAP',409);companies.add(c);
    for(const campaign of config.campaignIds){if(owners.has(campaign))fail('BINDING_OVERLAP',409);owners.set(campaign,c);}
  }
  return true;
}
// Одинаковое имя для одинаковых параметров: повтор опроса 201/202 отправляет точно тот же запрос.
// Каждый новый час сбора получает новое имя, в том числе для закрытых периодов:
// расход может корректироваться задним числом. Внутри опроса имя не меняется.
function directReportName(companyCode,config,period,window='closed') {
  company(companyCode);const c=directConfiguration(config);range(period?.from,period?.to);
  if(typeof window!=='string' || !/^(?:closed|open-\d{1,12}|refresh-\d{1,12})$/.test(window))fail();
  const digest=crypto.createHash('sha256').update(JSON.stringify(['synapse/direct-report/v1',companyCode,c.externalLogin,c.campaignIds,period.from,period.to,c.currency,c.timezone,c.includeVAT,c.includeDiscount,window])).digest('hex');
  return 'synapse-direct-'+digest.slice(0,32);
}
function directReportRequest(config,period,reportName) {
  const c=directConfiguration(config);range(period?.from,period?.to);
  if(typeof reportName!=='string' || !/^synapse-direct-[0-9a-f]{32}$/.test(reportName))fail();
  return {params:{SelectionCriteria:{DateFrom:period.from,DateTo:period.to,Filter:[{Field:'CampaignId',Operator:'IN',Values:[...c.campaignIds]}]},
    FieldNames:[...FIELDS],ReportName:reportName,ReportType:REPORT_TYPE,DateRangeType:'CUSTOM_DATE',Format:'TSV',
    IncludeVAT:c.includeVAT?'YES':'NO',IncludeDiscount:'YES',IncludeSubscriptionDiscount:'YES'}};
}
// Чистый разбор TSV без сети. Заголовок отчёта, строка столбцов и итог «Total rows» доказывают период и полноту.
function parseDirectReport(text,{reportName,from,to,campaignIds}={}) {
  if(typeof text!=='string' || typeof reportName!=='string' || !reportName)fail('RESPONSE_UNCERTAIN',502);
  range(from,to);
  if(!Array.isArray(campaignIds) || !campaignIds.length)fail();
  const allowed=new Set(campaignIds.map(id));
  const lines=text.replace(/^﻿/,'').split('\n').map(l=>l.endsWith('\r')?l.slice(0,-1):l);
  if(lines.at(-1)==='')lines.pop();
  if(!lines.length)fail('INCOMPLETE',502);
  let title=lines[0];if(title.length>1 && title.startsWith('"') && title.endsWith('"'))title=title.slice(1,-1);
  const header=/^(.{1,255}) \((\d{4}-\d{2}-\d{2}) - (\d{4}-\d{2}-\d{2})\)$/.exec(title);
  // HTML-страница, JSON ошибки или чужой отчёт не являются пустым отчётом.
  if(!header || header[1]!==reportName)fail('RESPONSE_UNCERTAIN',502);
  if(header[2]!==from || header[3]!==to)fail('INCOMPLETE',502);
  if(lines.length<3)fail('INCOMPLETE',502);
  const columns=lines[1].split('\t');
  if(columns.length!==FIELDS.length || new Set(columns).size!==columns.length || !FIELDS.every(f=>columns.includes(f)))fail('RESPONSE_UNCERTAIN',502);
  const summary=/^Total rows: (0|[1-9]\d{0,8})$/.exec(lines.at(-1));
  const data=lines.slice(2,-1);
  if(!summary || Number(summary[1])!==data.length)fail('INCOMPLETE',502);
  const index=Object.fromEntries(columns.map((c,i)=>[c,i]));
  const count=v=>{if(!/^(?:0|[1-9]\d{0,15})$/.test(v) || !Number.isSafeInteger(Number(v)))fail('RESPONSE_UNCERTAIN',502);return Number(v);};
  const seen=new Set(),rows=[];let totalCostMicros=0,totalClicks=0,totalImpressions=0;
  for(const line of data) {
    const cells=line.split('\t');if(cells.length!==columns.length)fail('RESPONSE_UNCERTAIN',502);
    const date=cells[index.Date],campaignId=cells[index.CampaignId];
    if(!validDay(date) || date<from || date>to || !/^[1-9]\d{0,14}$/.test(campaignId))fail('RESPONSE_UNCERTAIN',502);
    // Чужая кампания общего аккаунта не может попасть в расходы компании.
    if(!allowed.has(campaignId))fail('PROFILE_CHANGED',502);
    const key=date+'/'+campaignId;if(seen.has(key))fail('RESPONSE_UNCERTAIN',502);seen.add(key);
    // Деньги только целыми микроединицами валюты аккаунта; дробь означает другой режим ответа.
    const row={date,campaignId,impressions:count(cells[index.Impressions]),clicks:count(cells[index.Clicks]),costMicros:count(cells[index.Cost])};
    totalCostMicros+=row.costMicros;totalClicks+=row.clicks;totalImpressions+=row.impressions;
    if(![totalCostMicros,totalClicks,totalImpressions].every(Number.isSafeInteger))fail('RESPONSE_UNCERTAIN',502);
    rows.push(row);
  }
  rows.sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:Number(a.campaignId)-Number(b.campaignId));
  return {period:{from,to},rows,rowCount:rows.length,totalCostMicros,totalClicks,totalImpressions};
}
function createDirectAdapter({fetchImpl=globalThis.fetch,now=Date.now,wait=sleep,signal,deadlineMs=15*60000,requestTimeoutMs=120000,maxPolls=60,maxBytes=MAX_BYTES,maxRetryInSeconds=300}={}) {
  const bounded=(v,min,max)=>{if(!Number.isSafeInteger(v) || v<min || v>max)fail('BAD_ADAPTER_OPTIONS',500);};
  bounded(deadlineMs,1000,3600000);bounded(requestTimeoutMs,1000,600000);bounded(maxPolls,1,200);bounded(maxBytes,1024,MAX_BYTES);bounded(maxRetryInSeconds,1,3600);
  if(![fetchImpl,now,wait].every(f=>typeof f==='function') || (signal!==undefined && !(signal instanceof AbortSignal)))fail('BAD_ADAPTER_OPTIONS',500);
  const internal=new AbortController();
  const cancel=signal?AbortSignal.any([internal.signal,signal]):internal.signal;
  const discard=async response=>{try{await response.body?.cancel();}catch{}};
  const requestIdOf=response=>{const v=response.headers.get('requestid');return v && /^[A-Za-z0-9_-]{1,64}$/.test(v)?v:null;};
  async function send(headers,body,stop,timeoutMs) {
    let response;
    try{response=await fetchImpl(ENDPOINT,{method:'POST',headers:{...headers},body,redirect:'error',signal:AbortSignal.any([stop,AbortSignal.timeout(timeoutMs)])});}
    // Объект исключения fetch не передаётся дальше: в нём может оказаться заголовок с токеном.
    catch{if(stop.aborted)fail('CANCELLED',503);fail('CONNECTION_UNCERTAIN',504);}
    if(!response || typeof response.status!=='number' || !response.headers)fail('RESPONSE_UNCERTAIN',502);
    // Перенаправление могло увести запрос с токеном на другой адрес: ответ не принимается.
    if(response.redirected || (response.url && response.url!==ENDPOINT)){await discard(response);fail('RESPONSE_UNCERTAIN',502);}
    return response;
  }
  async function readBody(response,limit,overflow,stop) {
    const declared=response.headers.get('content-length');
    if(declared && /^\d+$/.test(declared) && Number(declared)>limit){await discard(response);fail(overflow,502);}
    const reader=response.body?.getReader();if(!reader)fail('RESPONSE_UNCERTAIN',502);
    const chunks=[];let size=0;
    try {
      for(;;) {
        const {value,done}=await reader.read();if(done)break;
        if(!(value instanceof Uint8Array))fail('RESPONSE_UNCERTAIN',502);
        size+=value.byteLength;if(size>limit){try{await reader.cancel();}catch{}fail(overflow,502);}
        chunks.push(value);
      }
    }catch(e){if(e?.[OWN])throw e;if(stop.aborted)fail('CANCELLED',503);fail('CONNECTION_UNCERTAIN',504);}
    return Buffer.concat(chunks);
  }
  async function upstreamCode(response,stop) {
    try {
      const b=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBody(response,ERROR_BYTES,'RESPONSE_UNCERTAIN',stop)));
      const v=b?.error?.error_code;return (typeof v==='number' || (typeof v==='string' && /^\d{1,6}$/.test(v)))?Number(v):null;
    }catch{if(stop.aborted)fail('CANCELLED',503);return null;}
  }
  async function reject(response,requestId,stop) {
    const s=response.status;
    if(!UPSTREAM_STATUSES.includes(s)){await discard(response);fail('RESPONSE_UNCERTAIN',502,{requestId});}
    const code=await upstreamCode(response,stop);
    if(s===401 || s===403)fail('ACCESS_DENIED',502,{requestId});
    if(s===429)fail('RATE_LIMITED',502,{requestId});
    fail('UPSTREAM_ERROR',502,{requestId});
  }
  async function collect(binding,requested,{signal:callSignal}={}) {
    if(callSignal!==undefined && !(callSignal instanceof AbortSignal))fail();
    const stop=callSignal?AbortSignal.any([cancel,callSignal]):cancel;
    const halt=()=>{if(stop.aborted)fail('CANCELLED',503);};
    halt();
    if(!binding || typeof binding!=='object')fail();
    const companyCode=company(binding.companyCode),config=directConfiguration(binding.config),credential=directCredential(binding.credential);
    const period=range(requested?.from,requested?.to);
    const started=now(),today=localDay(started,config.timezone);
    // Будущие даты не являются расходом. Сегодняшний день допускается, но помечается незакрытым.
    if(period.to>today)fail('BAD_PERIOD');
    const periodClosed=period.to<today;
    const reportName=directReportName(companyCode,config,period,'refresh-'+Math.floor(started/3600000));
    const body=JSON.stringify(directReportRequest(config,period,reportName));
    // Без skipReportHeader/skipColumnHeader/skipReportSummary: они нужны для проверки периода и числа строк.
    const headers=Object.freeze({Authorization:'Bearer '+credential.token,'Client-Login':config.externalLogin,'Accept-Language':'en',
      processingMode:'auto','Content-Type':'application/json; charset=utf-8'});
    for(let poll=1;;poll++) {
      halt();
      const remaining=deadlineMs-(now()-started);if(remaining<=0)fail('DELAYED',504);
      const response=await send(headers,body,stop,Math.max(1000,Math.min(requestTimeoutMs,remaining)));
      const requestId=requestIdOf(response);
      if(response.status===200) {
        if(/json|html|xml/i.test(response.headers.get('content-type')||'')){await discard(response);fail('RESPONSE_UNCERTAIN',502,{requestId});}
        const bytes=await readBody(response,maxBytes,'RESPONSE_TOO_LARGE',stop);
        let text,parsed;
        try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('RESPONSE_UNCERTAIN',502,{requestId});}
        try{parsed=parseDirectReport(text,{reportName,...period,campaignIds:config.campaignIds});}
        catch(e){if(e?.[OWN])e.requestId=requestId;throw e;}
        return {companyCode,provider:'direct',externalLogin:config.externalLogin,campaignIds:[...config.campaignIds],period,periodClosed,
          currency:config.currency,includeVAT:config.includeVAT,includeDiscount:config.includeDiscount,includeSubscriptionDiscount:true,timezone:config.timezone,moneyUnit:'micros',
          rows:parsed.rows,rowCount:parsed.rowCount,totalCostMicros:parsed.totalCostMicros,totalClicks:parsed.totalClicks,totalImpressions:parsed.totalImpressions,
          provenance:{checkedAt:new Date(now()).toISOString(),endpoint:ENDPOINT,method:'POST',reportType:REPORT_TYPE,reportName,requestId,processingMode:'auto',polls:poll}};
      }
      if(response.status===201 || response.status===202) {
        // Отчёт в очереди или формируется: это не снимок. Повтор того же запроса после retryIn в пределах бюджета.
        await discard(response);
        const header=response.headers.get('retryin');
        const seconds=header && /^\d{1,5}$/.test(header)?Math.max(1,Number(header)):FALLBACK_RETRY_SECONDS;
        if(poll>=maxPolls || seconds>maxRetryInSeconds || now()-started+seconds*1000>deadlineMs)fail('DELAYED',504,{requestId});
        try{await wait(seconds*1000,stop);}catch{halt();fail('DELAYED',504,{requestId});}
        continue;
      }
      await reject(response,requestId,stop);
    }
  }
  return {collect,stop:()=>internal.abort()};
}
module.exports={createDirectAdapter,parseDirectReport,directConfiguration,directCredential,directReportName,directReportRequest,assertDisjointDirectBindings,ENDPOINT,REPORT_TYPE,FIELDS};
