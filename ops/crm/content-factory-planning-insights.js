'use strict';

// Права и early replay проверяет вызывающий сервер. Здесь только сохранённая сводка.
const {buildInsights,INSIGHTS_PLATFORMS,INSIGHTS_METRIC_LABELS}=require('./social-insights');
const MAX_BYTES=8192,FRESH_MS=7*86400000;
const UNAVAILABLE_LIMITATION='Сохранённая статистика недоступна для этого запуска. План можно подготовить без статистических выводов.';
const OPEN_PERIOD_LIMITATION='Выбранный период ещё не закрыт в системе суток компании; его нельзя считать полным месяцем.';
const LIMITATIONS=Object.freeze([
  'Использованы только сохранённые профильные измерения текущих аккаунтов; архив публикаций здесь не оценивается.',
  'Missing означает недостаток пригодных данных, а не нулевой результат. Состояние на дату не является итогом месяца.',
  'Свежесть — давность сохранённого сбора: recent не старше7дней, stale старше7дней; это не доказательство полноты месяца.',
  'Confidence описывает качество данных, а не статистическую уверенность. Разные аккаунты, источники и системы суток не объединяются.',
  'Охват, проценты и средние длительности не объединяются в общий показатель периода или нескольких площадок.',
  'Причины результата, рейтинг роликов, успешные темы и влияние на продажи из этой проекции не выводятся.',
]);
const RECOMMENDATIONS=Object.freeze({
  CHECK_COVERAGE:'Проверьте пропуски и полноту сохранённых измерений перед использованием их в следующем плане.',
  CHECK_COMPARABILITY:'Проверьте сопоставимость измерений; разные аккаунты, источники и системы суток рассматривайте отдельно.',
  CHECK_PERIOD_DATA:'Состояние на дату не показывает результат месяца; перед сравнением проверьте наличие измерений периода.',
  CHECK_EDITORIAL_HYPOTHESES:'Измерения не доказывают причины результата. Проверяйте редакционные гипотезы отдельно, до изменения плана.',
  CHECK_FRESHNESS:'Проверьте свежесть сохранённых измерений перед выводами для нового плана.',
});
const fail=()=>{throw Object.assign(Error('Выберите компанию и месяц плана'),{status:400,code:'VALIDATION_ERROR'});};
const record=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const known=value=>typeof value==='number'&&Number.isFinite(value);
function safeTimezone(value){
  if(typeof value!=='string'||value.length>80)return null;
  try{return new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone;}catch{return null;}
}
function savedTime(value,at){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))return null;
  const time=Date.parse(value);if(!Number.isFinite(time)||time>at)return null;
  const iso=new Date(time).toISOString();
  return iso.replace('.000Z','Z')===value.replace('.000Z','Z')?iso:null;
}
function previousMonth(month){
  if(typeof month!=='string'||!/^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/.test(month))fail();
  const year=Number(month.slice(0,4)),index=Number(month.slice(5))-1;
  return {from:new Date(Date.UTC(year,index-1,1)).toISOString().slice(0,10),to:new Date(Date.UTC(year,index,0)).toISOString().slice(0,10)};
}
function localDay(at,timezone){
  if(!timezone)return null;
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
  const part=kind=>parts.find(item=>item.type===kind).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function incompatible(item,from,to){
  if(!item.accountRef||!item.provider||!safeTimezone(item.timezone)||item.activeInterval&&safeTimezone(item.activeInterval)!==safeTimezone(item.timezone))return true;
  if(item.history?.length||item.otherIntervals?.length)return true;
  const providers=new Set(),kinds=new Map();
  for(const [date,day]of Object.entries(item.days||{})){
    if(date<from||date>to||!record(day))continue;
    for(const [metric,cell]of Object.entries(day)){
      if(!Object.hasOwn(INSIGHTS_METRIC_LABELS,metric)||!known(cell?.value))continue;
      if(typeof cell.provider!=='string'||!cell.provider||!['organic','paid'].includes(cell.kind))return true;
      providers.add(cell.provider);if(!kinds.has(metric))kinds.set(metric,new Set());kinds.get(metric).add(cell.kind);
    }
  }
  return providers.size>1||[...providers].some(provider=>provider!==item.provider)||[...kinds.values()].some(values=>values.size>1);
}
function createPlanningInsights({stats,now=Date.now}){
  if(!stats||typeof stats.overview!=='function'||typeof now!=='function')throw Error('Нужна сохранённая сводка статистики');
  function capture(code,month){
    if(typeof code!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code))fail();
    code=code.toLowerCase();const period=previousMonth(month),at=now();
    if(!Number.isSafeInteger(at)||!Number.isFinite(new Date(at).getTime()))throw Error('Некорректное время снимка');
    const source={kind:'saved_social_stats',status:'available',period:{...period,timezone:null},capturedAt:new Date(at).toISOString()};
    const unavailable=()=>({schemaVersion:1,companyCode:code,planMonth:month,source:{...source,status:'unavailable'},platforms:[],
      limitations:[UNAVAILABLE_LIMITATION]});
    try{
      const current=stats.overview(code,period.from,period.to);
      if(!record(current)||typeof current.companyCode!=='string'||current.companyCode.toLowerCase()!==code||
        current.from!==period.from||current.to!==period.to||!record(current.platforms))return unavailable();
      source.period.timezone=safeTimezone(current.timezone);
      const today=localDay(at,source.period.timezone),open=today!==null&&period.to>=today;
      const insights=buildInsights({companyCode:code,period:source.period,current,today});
      const platforms=INSIGHTS_PLATFORMS.map(({key})=>{
        const item=record(current.platforms[key])?current.platforms[key]:{};
        const observations=insights.social.filter(value=>value.platform===key&&(!value.metric||Object.hasOwn(INSIGHTS_METRIC_LABELS,value.metric)));
        const daily=observations.filter(value=>value.kind==='coverage'&&known(value.values?.knownDays)&&value.values.knownDays>0);
        const state=observations.some(value=>value.kind==='state'&&known(value.values?.value));
        let coverage=observations.some(value=>value.kind==='absent')?'missing':daily.length?(daily.every(value=>value.ruleId==='coverage.full')?'complete':'partial'):state?'state_only':'missing';
        if(coverage!=='missing'&&(!source.period.timezone||incompatible(item,period.from,period.to)))coverage='incompatible';
        if(coverage==='complete'&&open)coverage='partial';
        const lastCollectedAt=savedTime(item.lastCollectedAt,at);
        const freshness={status:lastCollectedAt?(at-Date.parse(lastCollectedAt)<=FRESH_MS?'recent':'stale'):'unknown',lastCollectedAt,basis:'saved_collection_time'};
        const confidence=coverage==='missing'||coverage==='incompatible'?'insufficient':coverage==='complete'&&freshness.status==='recent'?'descriptive':'limited';
        const editorialRecommendations=[];
        const add=id=>editorialRecommendations.push({code:id,text:RECOMMENDATIONS[id]});
        if(coverage!=='missing'){
          add(coverage==='incompatible'?'CHECK_COMPARABILITY':coverage==='state_only'?'CHECK_PERIOD_DATA':coverage==='partial'?'CHECK_COVERAGE':'CHECK_EDITORIAL_HYPOTHESES');
          if(freshness.status!=='recent')add('CHECK_FRESHNESS');
        }
        return {platform:key,timezone:safeTimezone(item.timezone),coverage,confidence,freshness,editorialRecommendations};
      });
      const result={schemaVersion:1,companyCode:code,planMonth:month,source,platforms,limitations:[...LIMITATIONS,
        ...(open?[OPEN_PERIOD_LIMITATION]:[])]};
      return Buffer.byteLength(JSON.stringify(result))<=MAX_BYTES?result:unavailable();
    }catch{return unavailable();} // Исходные ошибки/частные данные никогда не попадают в проекцию.
  }
  return {capture};
}
module.exports={createPlanningInsights,RECOMMENDATIONS,LIMITATIONS,UNAVAILABLE_LIMITATION,OPEN_PERIOD_LIMITATION};
