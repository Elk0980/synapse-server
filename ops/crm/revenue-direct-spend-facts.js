'use strict';
const crypto=require('node:crypto');
const {directConfiguration,directReportName,assertDisjointDirectBindings,ENDPOINT,REPORT_TYPE}=require('./revenue-direct-adapter');
// Внутренний readonly reader расхода Яндекс Директа для cohortFacts (FR004/FR006/FR008/FR010, T017).
// Источник — только сохранённые снимки revenue_direct текущей ревизии своей компании внутри уже открытой
// транзакции вызывающего: только SELECT, без сети, записей, миграций, секретов и доказательств из HTTP.
// Диапазон одного провайдера не является реестром всех расходов, первым касанием или НДС выручки: complete:false.
const TIMEZONES=['Asia/Irkutsk','Asia/Bangkok','Europe/Moscow','UTC'];
const NATIVE_TZ='Europe/Moscow',MAX_DAYS=7300,MAX_REPORT_DAYS=1096;
const sorted=list=>[...list].sort().join();
const INPUT_KEYS=sorted(['companyCode','period','observationTo','timezone']);
const DIRECT_COLUMNS=sorted(['company','from_day','to_day','revision','payload','collected_at']);
const ACCESS_COLUMNS=['company','provider','config','revision','enabled'];
const PAYLOAD_KEYS=sorted(['companyCode','provider','externalLogin','campaignIds','period','periodClosed','currency','includeVAT','includeDiscount',
  'includeSubscriptionDiscount','timezone','moneyUnit','rows','rowCount','totalCostMicros','totalClicks','totalImpressions','provenance']);
const PROVENANCE_KEYS=sorted(['checkedAt','endpoint','method','reportType','reportName','requestId','processingMode','polls']);
const ROW_KEYS=sorted(['date','campaignId','impressions','clicks','costMicros']);
const fail=(code='VALIDATION_ERROR',status=400)=>{throw Object.assign(new Error(code),{code,status});};
// Сомнительный сохранённый снимок означает «расход неизвестен» (null): не ноль и не поиск другого, «удобного» отчёта.
const UNKNOWN=Symbol('direct-spend-unknown');
const unknown=()=>{throw UNKNOWN;};
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,expected)=>isObject(v)&&sorted(Object.keys(v))===expected;
const validDay=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const span=(from,to)=>(Date.parse(to)-Date.parse(from))/86400000;
const shiftDay=(d,n)=>new Date(Date.parse(d)+n*86400000).toISOString().slice(0,10);
const moscow=new Intl.DateTimeFormat('en-CA',{timeZone:NATIVE_TZ,year:'numeric',month:'2-digit',day:'2-digit'});
const instant=v=>{
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))unknown();
  const n=Date.parse(v);if(!Number.isFinite(n)||new Date(n).toISOString()!==v)unknown();return n;
};
const count=v=>{if(!Number.isSafeInteger(v)||v<0)unknown();return v;};
// Непрозрачные ссылки: без логина, имени отчёта, requestId, секретов и тела ответа.
const digest=parts=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,40);

function request(input) {
  if(!keys(input,INPUT_KEYS)||!keys(input.period,'from,to'))fail();
  const {companyCode:c,period:{from,to},observationTo,timezone}=input;
  if(typeof c!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(c))fail();
  if(![from,to,observationTo].every(validDay)||from>to||observationTo<to||span(from,observationTo)>MAX_DAYS)fail('BAD_PERIOD');
  // Анализный календарь только проверяется: московские сутки Директа не переносятся в другой пояс.
  if(!TIMEZONES.includes(timezone))fail('BAD_TIMEZONE');
  return {c,from,to};
}
function connection(state,c,nowMs) {
  if(!isObject(state)||typeof state.then==='function')fail('DIRECT_STATE_INVALID',500);
  if(state.companyCode!==c||state.provider!=='direct')fail('FOREIGN_COMPANY',409);
  // Только текущий успешный снимок включённого подключения. Устаревший, ошибочный или выключенный источник неизвестен.
  if(state.configured!==true||state.enabled!==true||state.current!==true||state.stale!==false||(state.errorCode!=null&&state.errorCode!==''))unknown();
  if(!Number.isSafeInteger(state.revision)||state.revision<1||!isObject(state.config))unknown();
  const lastSuccess=instant(state.lastSuccess);if(lastSuccess>nowMs)unknown();
  const {historyFrom,...direct}=state.config;let config;
  try{config=directConfiguration(direct);}catch{unknown();}
  if(!validDay(historyFrom)||JSON.stringify(direct.campaignIds)!==JSON.stringify(config.campaignIds))unknown();
  return {config,lastSuccess};
}
function nativeReport(row,c,config,lastSuccess) {
  if(row.company!==c||!validDay(row.from_day)||!validDay(row.to_day)||row.from_day>row.to_day||span(row.from_day,row.to_day)>=MAX_REPORT_DAYS)unknown();
  const collected=instant(row.collected_at);if(collected>lastSuccess)unknown();
  let p;try{p=JSON.parse(row.payload);}catch{unknown();}
  if(!keys(p,PAYLOAD_KEYS)||!keys(p.period,'from,to')||!keys(p.provenance,PROVENANCE_KEYS)||!Array.isArray(p.rows))unknown();
  const period={from:row.from_day,to:row.to_day},v=p.provenance;
  // Исходные компания, логин, кампании, период, валюта, НДС, скидки, пояс и единицы точно совпадают с текущей привязкой.
  if(p.companyCode!==c||p.provider!=='direct'||p.externalLogin!==config.externalLogin||JSON.stringify(p.campaignIds)!==JSON.stringify(config.campaignIds)||
    p.period.from!==period.from||p.period.to!==period.to||typeof p.periodClosed!=='boolean'||p.currency!==config.currency||p.includeVAT!==config.includeVAT||
    p.includeDiscount!==true||p.includeSubscriptionDiscount!==true||p.timezone!==NATIVE_TZ||p.moneyUnit!=='micros')unknown();
  const checked=instant(v.checkedAt),hour=Math.floor(checked/3600000);
  // Имя отчёта адаптера — хеш компании, привязки, периода и часа сбора; заголовок TSV был проверен именно по нему.
  if(checked>collected||v.endpoint!==ENDPOINT||v.method!=='POST'||v.reportType!==REPORT_TYPE||v.processingMode!=='auto'||
    !(v.requestId===null||(typeof v.requestId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v.requestId)))||!Number.isSafeInteger(v.polls)||v.polls<1||v.polls>200||
    ![0,1,2].some(k=>v.reportName===directReportName(c,config,period,'refresh-'+(hour-k))))unknown();
  // Незакрытый день сбора (текущие московские сутки) не покрыт: его расход ещё меняется.
  const checkedDay=moscow.format(checked);
  if(period.to>checkedDay||(p.periodClosed?period.to>=checkedDay:period.to<shiftDay(checkedDay,-1)))unknown();
  const allowed=new Set(config.campaignIds),cells=new Map();let cost=0,clicks=0,impressions=0;
  for(const r of p.rows) {
    if(!keys(r,ROW_KEYS)||!validDay(r.date)||r.date<period.from||r.date>period.to||!allowed.has(r.campaignId))unknown();
    const key=r.date+'/'+r.campaignId;if(cells.has(key))unknown();
    const cell={impressions:count(r.impressions),clicks:count(r.clicks),costMicros:count(r.costMicros)};
    cost+=cell.costMicros;clicks+=cell.clicks;impressions+=cell.impressions;
    if(![cost,clicks,impressions].every(Number.isSafeInteger))unknown();
    cells.set(key,cell);
  }
  if(p.rowCount!==p.rows.length||p.totalCostMicros!==cost||p.totalClicks!==clicks||p.totalImpressions!==impressions)unknown();
  return {from:period.from,to:period.to,closedTo:p.periodClosed?period.to:shiftDay(period.to,-1),checked,collectedAt:row.collected_at,cells,
    key:digest(['synapse/direct-report/v1',c,row.revision,period.from,period.to,row.collected_at,v.checkedAt])};
}

function createRevenueDirectSpendFacts(db,options={}) {
  if(!isObject(options)||Object.keys(options).some(k=>!['providerState','now'].includes(k)))fail('DIRECT_READER_INVALID',500);
  const {providerState,now=Date.now}=options;
  if(!db||typeof db.prepare!=='function'||typeof providerState!=='function'||typeof now!=='function')fail('DIRECT_READER_INVALID',500);
  const columns=table=>db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(r=>r.name);
  // Счёт компании подтверждается текущими непересекающимися привязками всех компаний; столбец секрета не читается.
  function binding(c,state,config) {
    const present=columns('revenue_access');if(ACCESS_COLUMNS.some(k=>!present.includes(k)))unknown();
    const rows=db.prepare("SELECT company,config,revision,enabled FROM revenue_access WHERE provider='direct'").all();
    const own=rows.filter(r=>r.company===c);
    if(own.length!==1||own[0].revision!==state.revision||own[0].enabled!==1)unknown();
    try {
      const bindings=rows.map(r=>{const {historyFrom,...direct}=JSON.parse(r.config);return {companyCode:r.company,config:direct,historyFrom};});
      assertDisjointDirectBindings(bindings.map(b=>({companyCode:b.companyCode,config:b.config})));
      const mine=bindings.find(b=>b.companyCode===c);
      if(JSON.stringify(directConfiguration(mine.config))!==JSON.stringify(config)||mine.historyFrom!==state.config.historyFrom)unknown();
    }catch{unknown();}
  }
  function resolve(c,from,to,state,nowMs) {
    const {config,lastSuccess}=connection(state,c,nowMs);
    if(sorted(columns('revenue_direct'))!==DIRECT_COLUMNS)unknown();
    binding(c,state,config);
    const reports=[];
    for(const row of db.prepare('SELECT company,from_day,to_day,revision,payload,collected_at FROM revenue_direct WHERE company=? AND from_day<=? AND to_day>=?').all(c,to,from)) {
      if(!Number.isSafeInteger(row.revision)||row.revision>state.revision)unknown();
      // Прежняя ревизия относится к прежней настройке: не принимается и не дополняет текущую.
      if(row.revision<state.revision)continue;
      reports.push(nativeReport(row,c,config,lastSuccess));
    }
    if(!reports.length)unknown();
    // Для каждого дня — самый поздний отчёт, охватывающий его. Его отсутствующая строка — проверенный ноль кампании,
    // прежняя сумма не остаётся. Незакрытый в нём день не покрыт, более старый отчёт не подбирается.
    // Ничья с разными значениями — противоречие: ни выбор, ни сумма, весь расход неизвестен.
    const days=[];
    for(let d=from;d<=to;d=shiftDay(d,1)) {
      const candidates=reports.filter(r=>r.from<=d&&d<=r.to);
      if(!candidates.length){days.push(null);continue;}
      const latest=Math.max(...candidates.map(r=>r.checked)),ties=candidates.filter(r=>r.checked===latest),chosen=ties[0];
      const cell=(r,id)=>JSON.stringify(r.cells.get(d+'/'+id)??null);
      for(const r of ties.slice(1))
        if((r.closedTo>=d)!==(chosen.closedTo>=d)||config.campaignIds.some(id=>cell(r,id)!==cell(chosen,id)))unknown();
      days.push(chosen.closedTo>=d?{day:d,report:chosen}:null);
    }
    // Все покрытые части периода сохраняются. Пробел не разрешает отбросить
    // второй валидный отрезок ради удобного непрерывного диапазона.
    const used=days.filter(Boolean);if(!used.length)unknown();
    const coveredRanges=[];
    for(const x of used){const last=coveredRanges.at(-1);
      if(last&&shiftDay(last.to,1)===x.day)last.to=x.day;else coveredRanges.push({from:x.day,to:x.day});}
    const vatMode=config.includeVAT?'vat_included':'vat_excluded',facts=[];
    for(const {day,report} of used)for(const campaignId of config.campaignIds) {
      const cell=report.cells.get(day+'/'+campaignId);if(!cell)continue;
      facts.push({companyCode:c,id:'direct-spend/'+digest(['synapse/direct-spend/v1',c,state.revision,report.key,day,campaignId]),provider:'yandex_direct',
        campaignId,accountScope:'company',kind:'spend',serviceFrom:day,serviceTo:day,amountMicros:cell.costMicros,currency:config.currency,vatMode,
        timezone:NATIVE_TZ,allocations:null,evidence:{kind:'direct_reports_api',reference:'direct-report/'+report.key,confirmedAt:report.collectedAt}});
    }
    const contributing=[...new Set(used.map(x=>x.report))];
    return {companyCode:c,vatMode:'unknown',paymentHistory:null,leadBindings:null,recordCosts:null,
      spend:{companyCode:c,from,to,coveredRanges,providers:['yandex_direct'],complete:false,
        evidence:{kind:'native_report_range',reference:'direct-range/'+digest(['synapse/direct-range/v1',c,state.revision,from,to,coveredRanges,contributing.map(r=>r.key).sort()]),
          confirmedAt:contributing.map(r=>r.collectedAt).sort().at(-1)},
        facts,campaigns:[]}};
  }
  function read(input) {
    const {c,from,to}=request(input);
    // Настройки, состояние и строки — одна транзакция вызывающего (report()); здесь только SELECT.
    if(db.isTransaction!==true)fail('SNAPSHOT_REQUIRED',500);
    const nowMs=now();if(!Number.isSafeInteger(nowMs))fail('DIRECT_READER_INVALID',500);
    const state=providerState(c,'direct');
    try{return resolve(c,from,to,state,nowMs);}catch(e){if(e===UNKNOWN)return null;throw e;}
  }
  return {read};
}
module.exports={createRevenueDirectSpendFacts};
