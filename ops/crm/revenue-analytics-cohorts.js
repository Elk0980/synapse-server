'use strict';
// Когорты привлечения одной компании поверх уже нормализованных строк revenue_records/revenue_cash.
// Клиент входит в когорту по местной дате самого раннего подтверждённого сервером касания (связь заявка→запись),
// а не по дате первой оплаты. Чистое вычисление: без сети, БД, контактов и побочных эффектов.
const {company,id,day,range,shiftDay,fail,configuration}=require('./revenue-analytics-access');

const CONTRACT='revenue-cohorts/v2';
const TIMEZONES=['Asia/Irkutsk','Asia/Bangkok','Europe/Moscow','UTC'];
// Выручка YCLIENTS нормализуется в рублях (см. report() в revenue-analytics.js).
const CURRENCIES=['RUB'];
const VAT_MODES=['no_vat','vat_included','vat_excluded'];
const UTM_KEYS=['source','medium','campaign','content','term'];
// Допустимые виды подтверждений. Автоматические совпадения (хэш телефона, имени, времени) не принимаются.
const EVIDENCE={
  history:['owner_confirmed_opening_date','accounting_ledger_review'],
  binding:['server_lead_record_link','server_record_origin'],
  spendCoverage:['ad_cabinet_export','accounting_ledger','owner_confirmed'],
  spend:['ad_cabinet_export','invoice','closing_act','accounting_ledger'],
  campaign:['ad_cabinet_export','owner_confirmed'],
  cost:['accounting_ledger','owner_confirmed']
};
const REASONS={
  YCLIENTS_SNAPSHOT_MISSING:'Нет успешной выгрузки YCLIENTS. Показатели неизвестны, это не ноль.',
  YCLIENTS_SNAPSHOT_STALE:'Подключение или правила изменились после выгрузки. Прежние строки не считаются проверенными деньгами.',
  HISTORY_AFTER_PERIOD_START:'Загруженная история YCLIENTS начинается позже начала периода.',
  PAYMENT_HISTORY_UNPROVEN:'Не подтверждено отсутствие оплат до начала загруженной истории. Новизна клиентов неизвестна.',
  CASH_RULES_MISSING:'Правила статей YCLIENTS не заданы. Деньги не классифицированы.',
  UNKNOWN_CASH_ARTICLE:'Операции с неизвестной статьёй исключены; среди них могут быть оплаты или возвраты.',
  CLIENT_IDENTITY_MISSING:'Оплата без идентификатора клиента: её нельзя отнести к новому или прежнему клиенту.',
  CLIENT_IDENTITY_CONFLICT:'Клиент операции и клиент записи не совпадают: клиент и источник неизвестны.',
  PAYMENT_UNMATCHED:'Оплата без однозначной связи с записью: метка записи и себестоимость неизвестны.',
  ACQUISITION_RECORD_AMBIGUOUS:'В день первой оплаты клиента оплачены записи с разными метками.',
  REFUND_UNASSIGNED:'Возврат без идентификатора клиента нельзя отнести к когорте.',
  PERIOD_NOT_CLOSED:'Период включает день последней выгрузки или более поздние даты; итог ещё неполный.',
  ATTRIBUTION_UNBOUND:'Нет подтверждённой сервером связи заявки с записью клиента: дата привлечения и источник неизвестны. Метка записи не является первым касанием.',
  BINDING_CONFLICT:'Для одной записи переданы разные связи (заявка, время или источник); ни одна не принята.',
  BINDING_LEAD_CONFLICT:'Одна заявка передана с разным временем или источником; её связи не приняты.',
  BINDING_LEAD_MULTIPLE_CLIENTS:'Одна заявка связана с записями разных клиентов; её связи не приняты.',
  BINDING_TIME_INCONSISTENT:'Первое касание позже создания записи; связь не принята.',
  BINDING_RECORD_MISSING:'Связь указывает на запись, которой нет в выгрузке.',
  BINDING_CLIENT_MISSING:'Запись связи не содержит идентификатора клиента; привлечение нельзя отнести к клиенту.',
  ACQUISITION_TOUCH_AMBIGUOUS:'У клиента несколько разных подтверждённых касаний в одно и то же время; первое касание не определено.',
  ACQUISITION_EARLIER_CONTACT:'У клиента есть запись или операция раньше подтверждённого первого касания; дата привлечения неизвестна.',
  LEAD_JOURNAL_NOT_INTEGRATED:'Серверный журнал заявок без записи ещё не подключён; заявки, не дошедшие до записи, не учитываются.',
  SPEND_COVERAGE_MISSING:'Полнота рекламных расходов за период когорты не подтверждена.',
  SPEND_COVERAGE_CONTRADICTION:'Расход относится к каналу вне подтверждённого перечня каналов.',
  EXPENSE_PERIOD_UNALLOCATED:'Период услуги расхода пересекает границу когорты без подтверждённого распределения.',
  SHARED_ACCOUNT_UNALLOCATED:'Кампания общего кабинета не подтверждена для этой компании; расход не распределяется.',
  CAMPAIGN_UNMAPPED:'Кампания не связана подтверждённым словарём с меткой источника.',
  CAMPAIGN_DICTIONARY_CONFLICT:'Словарь кампаний содержит противоречащие метки для одной кампании.',
  CURRENCY_MISMATCH:'Валюта не совпадает с валютой отчёта; суммы несопоставимы.',
  VAT_MODE_MISMATCH:'Режим НДС не совпадает с отчётом; суммы несопоставимы.',
  VAT_MODE_UNCONFIRMED:'Режим НДС этой когорты не подтверждён; стоимость клиента и окупаемость неизвестны.',
  TIMEZONE_MISMATCH:'Часовой пояс расхода не совпадает с отчётом; границы дней несопоставимы, суммы не пересчитываются.',
  COSTS_MISSING:'Себестоимость записей не передана.',
  COST_RECORD_MISSING:'Для части оплаченных записей когорты нет подтверждённой себестоимости.',
  NO_NEW_CLIENTS:'Новых платящих клиентов нет; CAC не определён.',
  ZERO_SPEND:'Подтверждённый расход равен нулю; ROMI не определён.'
};
const DEFINITIONS={
  cohort:'Клиент входит в когорту по местной дате (часовой пояс отчёта) самого раннего подтверждённого сервером касания: связь заявка→запись или серверное происхождение записи. Дата первой оплаты, from_url, дата создания записи, хэш и телефон датой привлечения не являются.',
  newPayingClients:'Привлечённые в окне когорты клиенты без оплат раньше первого касания по подтверждённой полной истории и с первой положительной оплатой до observationTo включительно, в том числе после окна когорты. Знаменатель CAC.',
  knownValue:'Подтверждённая часть показателя при неполных данных. Это не итог и не нижняя граница; status показывает, что значение не проверено.',
  funnel:'Стадии клиентов, привлечённых в окне: с записью, с посещением, платящие и ещё не оплатившие к observationTo. Заявки без записи требуют серверного журнала заявок; он ещё не подключён.',
  reactivatedPriorPayers:'Клиенты с подтверждённым касанием в окне, но с оплатой раньше этого касания. Не новые; в CAC и ROMI когорты не входят.',
  firstObservedPayers:'Календарный факт: клиенты, чья первая оплата в загруженной истории пришлась на окно from..to. Не когорта привлечения и не знаменатель CAC; оплаты без клиента не учтены.',
  cohortActivity:'Все записи, уникальные посещения, оплаты и возвраты клиентов когорты до observationTo включительно, в том числе после окна когорты. Это не кассовый итог календарного периода.',
  calendar:'Календарные факты окна from..to: записи по дате создания, посещения по дате визита, деньги по дате операции.',
  visits:'Посещение — attendance=1 без удаления; один visitId считается один раз. Отмены и неявки не посещения.',
  firstTouch:'Самое раннее подтверждённое сервером касание клиента; при нескольких касаниях выбор по времени, а не по порядку ввода. Разные касания в одно время — неоднозначность. Посетитель Метрики без связи не является клиентом.',
  recordLabel:'UTM из from_url записей первой оплаты нового платящего клиента. Доказывает метку записи, а не первое касание.',
  cac:'Полный сопоставимый рекламный расход окна привлечения / новые платящие клиенты этого окна. Только при подтверждённых клиентах, расходах и привязке.',
  romi:'(Чистая выручка когорты до observationTo − себестоимость − расход окна привлечения) / расход × 100, в базисных пунктах (10000 = 100%).',
  spendTimezone:'Директ отдаёт московские сутки. При другом поясе отчёта суммы не пересчитываются искусственно, экономика недоступна.',
  money:'Целые копейки. Неизвестно не равно нулю.'
};

const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function shape(v,required,optional=[]) {
  if(!isObject(v)||required.some(k=>!(k in v))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))fail();
  return v;
}
const list=v=>{if(!Array.isArray(v)||v.length>500000)fail();return v;};
const oneOf=(v,values,code='VALIDATION_ERROR')=>{if(!values.includes(v))fail(code);return v;};
const flag=v=>{if(typeof v!=='boolean')fail();return v;};
const currencyCode=v=>{if(typeof v!=='string'||!/^[A-Z]{3}$/.test(v))fail();return v;};
// Тот же фильтр, что у attribution(): метка не должна нести контакт или адрес страницы.
const label=v=>{if(typeof v!=='string'||!v.length||v.length>200||/[@:\/?\x00-\x1f]|\d{7,}/.test(v))fail();return v;};
const reference=v=>{if(typeof v!=='string'||!/^[A-Za-z0-9._\/-]{1,128}$/.test(v))fail();return v;};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Идентификатор заявки выдаёт сервер (UUID или префиксный код). Телефон и почта не проходят.
const leadId=v=>{if(typeof v!=='string'||!(UUID.test(v)||(/^[A-Za-z][A-Za-z0-9_-]{5,63}$/.test(v)&&!/\d{7,}/.test(v))))fail();return v;};
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const instant=v=>{if(typeof v!=='string'||!ISO.test(v))fail();day(v.slice(0,10));const n=Date.parse(v);if(!Number.isFinite(n))fail();return n;};
const kopecks=(v,min=-Infinity)=>{if(!Number.isSafeInteger(v)||v<min)fail('BAD_MONEY');return v;};
const plus=(a,b)=>{const r=a+b;if(!Number.isSafeInteger(r))fail('MONEY_OVERFLOW',422);return r;};
const clientKey=v=>{if(v===null)return null;if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail();return v;};
const optionalId=v=>v===null?null:id(v);
const scoped=(v,c)=>{if(v.companyCode!==c)fail('FOREIGN_COMPANY',409);return v;};
const visitKey=r=>r.visitId?'visit:'+r.visitId:'record:'+r.id;
function evidence(v,kinds) {
  shape(v,['kind','reference','confirmedAt']);
  if(!kinds.includes(v.kind))fail('EVIDENCE_REJECTED');
  reference(v.reference);instant(v.confirmedAt);
  return v.kind;
}
function unique(rows) {
  const seen=new Set();for(const r of rows){if(seen.has(r.id))fail('DUPLICATE_ROW');seen.add(r.id);}
  return rows;
}
// Отношение целых с округлением половины от нуля; деньги не проходят через дробные числа.
function ratio(numerator,denominator) {
  let n=BigInt(numerator),d=BigInt(denominator);const negative=(n<0n)!==(d<0n);
  if(n<0n)n=-n;if(d<0n)d=-d;let q=n/d;if((n%d)*2n>=d)q++;
  const value=Number(negative?-q:q);if(!Number.isSafeInteger(value))fail('MONEY_OVERFLOW',422);return value;
}
function reasons() {
  const map=new Map();
  const self={
    add(code,n=1){if(!REASONS[code])throw new Error('Unknown reason '+code);if(n>0)map.set(code,(map.get(code)||0)+n);return self;},
    // Объединение причин разных показателей: одна и та же причина не удваивается.
    merge(...others){for(const o of others)for(const [code,n] of o.entries())map.set(code,Math.max(map.get(code)||0,n));return self;},
    entries:()=>[...map],
    get size(){return map.size;},
    list:()=>[...map].sort((a,b)=>a[0]<b[0]?-1:1).map(([code,count])=>({code,label:REASONS[code],count}))
  };
  return self;
}
const state=r=>r.size?'partial':'verified';
const unavailableValue=(r,extra={})=>({status:'unavailable',...extra,reasons:r.list()});
const notApplicable=(code,extra={})=>({status:'not_applicable',...extra,reasons:reasons().add(code).list()});

// --- Проверка входа. Лишние поля (имя, телефон, комментарий) отклоняются, а не игнорируются. ---
function recordRow(r) {
  shape(r,['id','visitId','client','createdAt','visitAt','changedAt','attendance','deleted','utm','online']);
  if(![-1,0,1,2].includes(r.attendance))fail();flag(r.deleted);flag(r.online);instant(r.changedAt);
  if(!isObject(r.utm)||Object.keys(r.utm).some(k=>!UTM_KEYS.includes(k)))fail();
  const utm={};for(const k of UTM_KEYS)if(r.utm[k]!==undefined)utm[k]=label(r.utm[k]);
  return {id:id(r.id),visitId:optionalId(r.visitId),client:clientKey(r.client),createdAt:instant(r.createdAt),visitAt:instant(r.visitAt),
    attendance:r.attendance,deleted:r.deleted,utm};
}
function cashRow(t) {
  shape(t,['id','recordId','visitId','client','at','amount','expenseId','deleted']);flag(t.deleted);
  return {id:id(t.id),recordId:optionalId(t.recordId),visitId:optionalId(t.visitId),client:clientKey(t.client),at:instant(t.at),
    amount:kopecks(t.amount),expenseId:optionalId(t.expenseId),deleted:t.deleted};
}
function snapshotInput(y,c,tz) {
  const r=reasons();
  if(y===null)return {data:null,reasons:r.add('YCLIENTS_SNAPSHOT_MISSING'),source:null};
  shape(y,['companyCode','current','collectedAt','historyFrom','config','records','cash']);scoped(y,c);flag(y.current);
  const config=configuration('yclients',y.config);
  // Другой календарь даёт другие границы дней: такой вызов — ошибка интеграции, а не частичный отчёт.
  if(config.timezone!==tz)fail('TIMEZONE_MISMATCH',409);
  const data={config,historyFrom:day(y.historyFrom),collectedAt:instant(y.collectedAt),
    records:unique(list(y.records).map(recordRow)),cash:unique(list(y.cash).map(cashRow))};
  const source={collectedAt:new Date(data.collectedAt).toISOString(),historyFrom:data.historyFrom,current:y.current};
  if(!y.current)return {data:null,reasons:r.add('YCLIENTS_SNAPSHOT_STALE'),source};
  return {data,reasons:r,source};
}
function historyFact(v,c) {
  if(v==null)return null;
  shape(v,['companyCode','noPaymentsBefore','evidence']);scoped(v,c);evidence(v.evidence,EVIDENCE.history);
  return {noPaymentsBefore:day(v.noPaymentsBefore)};
}
function bindingFact(b,c) {
  shape(b,['companyCode','recordId','leadId','firstTouch','evidence']);scoped(b,c);
  const kind=evidence(b.evidence,EVIDENCE.binding);
  // Связь заявки обязана нести серверный leadId; происхождение записи без заявки — нет.
  if(kind==='server_lead_record_link'?b.leadId===null:b.leadId!==null)fail();
  shape(b.firstTouch,['source','campaign','at']);
  return {recordId:id(b.recordId),leadId:b.leadId===null?null:leadId(b.leadId),kind,
    touch:{source:label(b.firstTouch.source),campaign:b.firstTouch.campaign===null?null:label(b.firstTouch.campaign)},touchAt:instant(b.firstTouch.at)};
}
function allocationList(f,v) {
  if(v===null)return null;
  const rows=list(v).map(a=>{shape(a,['from','to','amountKopecks']);range(a.from,a.to);return {from:a.from,to:a.to,amountKopecks:kopecks(a.amountKopecks,0)};})
    .sort((a,b)=>a.from<b.from?-1:a.from>b.from?1:0);
  // Подтверждённое распределение покрывает период услуги без пропусков и наложений и сходится до копейки.
  if(!rows.length||rows[0].from!==f.serviceFrom||rows.at(-1).to!==f.serviceTo)fail('ALLOCATION_MISMATCH');
  let sum=0;rows.forEach((a,i)=>{if(i&&a.from!==shiftDay(rows[i-1].to,1))fail('ALLOCATION_MISMATCH');sum=plus(sum,a.amountKopecks);});
  if(sum!==f.amountKopecks)fail('ALLOCATION_MISMATCH');
  return rows;
}
function spendInput(v,c) {
  if(v==null)return null;
  shape(v,['companyCode','from','to','providers','evidence','facts','campaigns']);scoped(v,c);range(v.from,v.to);
  evidence(v.evidence,EVIDENCE.spendCoverage);
  const providers=list(v.providers).map(label);
  const facts=unique(list(v.facts).map(f=>{
    shape(f,['companyCode','id','provider','campaignId','accountScope','kind','serviceFrom','serviceTo','amountKopecks','currency','vatMode','timezone','allocations','evidence']);
    scoped(f,c);evidence(f.evidence,EVIDENCE.spend);range(f.serviceFrom,f.serviceTo);
    const fact={id:reference(f.id),provider:label(f.provider),campaignId:reference(f.campaignId),accountScope:oneOf(f.accountScope,['company','shared']),
      kind:oneOf(f.kind,['spend','package']),serviceFrom:f.serviceFrom,serviceTo:f.serviceTo,amountKopecks:kopecks(f.amountKopecks,0),
      currency:currencyCode(f.currency),vatMode:oneOf(f.vatMode,VAT_MODES),timezone:oneOf(f.timezone,TIMEZONES,'BAD_TIMEZONE')};
    fact.allocations=allocationList(fact,f.allocations);return fact;
  }));
  const campaigns=list(v.campaigns).map(m=>{
    shape(m,['companyCode','provider','campaignId','utm','evidence']);scoped(m,c);evidence(m.evidence,EVIDENCE.campaign);shape(m.utm,['source','campaign']);
    return {provider:label(m.provider),campaignId:reference(m.campaignId),utm:{source:label(m.utm.source),campaign:label(m.utm.campaign)}};
  });
  return {from:v.from,to:v.to,providers,facts,campaigns};
}
function costFacts(v,c) {
  if(v==null)return null;
  const map=new Map();
  for(const f of list(v)) {
    shape(f,['companyCode','recordId','costKopecks','currency','vatMode','evidence']);scoped(f,c);evidence(f.evidence,EVIDENCE.cost);
    const recordId=id(f.recordId);if(map.has(recordId))fail('DUPLICATE_ROW');
    map.set(recordId,{costKopecks:kopecks(f.costKopecks,0),currency:currencyCode(f.currency),vatMode:oneOf(f.vatMode,VAT_MODES)});
  }
  return map;
}

// --- Расходы окна когорты: только подтверждённые факты; период услуги, а не дата оплаты пакета. ---
function allocated(f,cohort) {
  if(!f.allocations)return null;
  let sum=0;
  for(const a of f.allocations) {
    if(a.from>=cohort.from&&a.to<=cohort.to)sum=plus(sum,a.amountKopecks);
    else if(a.to>=cohort.from&&a.from<=cohort.to)return null;
  }
  return sum;
}
function computeSpend(s,{cohort,currency,vatMode,tz}) {
  const r=reasons(),channel=reasons(),byKey=new Map();
  if(!s)return {reasons:r.add('SPEND_COVERAGE_MISSING'),channelReasons:channel,byKey,total:null,provided:false};
  if(s.from>cohort.from||s.to<cohort.to)r.add('SPEND_COVERAGE_MISSING');
  const dictionary=new Map(),conflicts=new Set();
  for(const m of s.campaigns) {
    const k=m.provider+'\n'+m.campaignId,key=JSON.stringify([m.utm.source,m.utm.campaign]);
    if(!dictionary.has(k))dictionary.set(k,{key,utm:m.utm});else if(dictionary.get(k).key!==key)conflicts.add(k);
  }
  let total=0;
  for(const f of s.facts) {
    let amount;
    if(f.serviceFrom>=cohort.from&&f.serviceTo<=cohort.to)amount=f.amountKopecks;
    else if(f.serviceTo<cohort.from||f.serviceFrom>cohort.to)continue;
    else amount=allocated(f,cohort);
    if(!s.providers.includes(f.provider))r.add('SPEND_COVERAGE_CONTRADICTION');
    if(f.currency!==currency)r.add('CURRENCY_MISMATCH');
    if(f.vatMode!==vatMode)r.add('VAT_MODE_MISMATCH');
    // Московские сутки Директа не сдвигаются в пояс отчёта: сумма остаётся как есть, экономика недоступна.
    if(f.timezone!==tz)r.add('TIMEZONE_MISMATCH');
    if(amount===null){r.add('EXPENSE_PERIOD_UNALLOCATED');continue;}
    const k=f.provider+'\n'+f.campaignId,mapped=conflicts.has(k)?null:dictionary.get(k)||null;
    if(conflicts.has(k))channel.add('CAMPAIGN_DICTIONARY_CONFLICT');else if(!mapped)channel.add('CAMPAIGN_UNMAPPED');
    // Общий кабинет: без подтверждения кампании этой компанией сумма не делится между компаниями.
    if(f.accountScope==='shared'&&!mapped){r.add('SHARED_ACCOUNT_UNALLOCATED');continue;}
    total=plus(total,amount);
    if(mapped){const prev=byKey.get(mapped.key);byKey.set(mapped.key,{utm:mapped.utm,amount:plus(prev?.amount||0,amount)});}
  }
  return {reasons:r,channelReasons:channel,byKey,total,provided:true};
}
function spendOutput(spend) {
  return {status:!spend.provided?'unavailable':state(spend.reasons),knownKopecks:spend.total,reasons:spend.reasons.list(),
    channelStatus:!spend.provided?'unavailable':state(reasons().merge(spend.reasons,spend.channelReasons)),channelReasons:spend.channelReasons.list(),
    channels:[...spend.byKey].sort((a,b)=>a[0]<b[0]?-1:1).map(([,v])=>({utm:{...v.utm},spendKopecks:v.amount}))};
}

function buildRevenueCohorts(input) {
  shape(input,['companyCode','cohort','observationTo','timezone','currency','vatMode','yclients'],['paymentHistory','leadBindings','spend','recordCosts']);
  const c=company(input.companyCode);
  shape(input.cohort,['from','to']);const cohort=range(input.cohort.from,input.cohort.to);
  const observationTo=day(input.observationTo);if(observationTo<cohort.to)fail('BAD_PERIOD');range(cohort.from,observationTo);
  const tz=oneOf(input.timezone,TIMEZONES,'BAD_TIMEZONE'),currency=oneOf(input.currency,CURRENCIES),vatMode=oneOf(input.vatMode,[...VAT_MODES,'unknown']);
  const taxR=reasons();if(vatMode==='unknown')taxR.add('VAT_MODE_UNCONFIRMED');
  // Все факты проверяются до расчёта: строка чужой компании отклоняет весь вызов.
  const history=historyFact(input.paymentHistory,c);
  const bindings=input.leadBindings==null?[]:list(input.leadBindings).map(b=>bindingFact(b,c));
  const spend=computeSpend(spendInput(input.spend,c),{cohort,currency,vatMode,tz});
  const costs=costFacts(input.recordCosts,c);
  const snapshot=snapshotInput(input.yclients,c,tz);
  // Заявки без записи появятся только с серверным журналом заявок; до этого стадия неизвестна, а не ноль.
  const leadsWithoutBooking=unavailableValue(reasons().add('LEAD_JOURNAL_NOT_INTEGRATED'),{value:null});
  const result={contract:CONTRACT,companyCode:c,scope:{companyCode:c,timezone:tz,currency,vatMode,unit:'kopecks'},
    cohort:{from:cohort.from,to:cohort.to,observationTo,basis:'server_bound_first_touch_local_day'},
    source:{yclients:snapshot.source,metrika:'not_linked_without_lead_binding',leadJournal:'not_integrated'},spend:spendOutput(spend),definitions:DEFINITIONS};
  if(!snapshot.data) {
    const r=snapshot.reasons,blocked=reasons().merge(r,spend.reasons,taxR);
    return {...result,
      calendar:unavailableValue(r,{createdBookings:null,cancelledBookings:null,noShows:null,attendedUniqueVisits:null,paymentKopecks:null,refundKopecks:null,netCashKopecks:null,firstObservedPayers:null}),
      cohortTotals:{newPayingClients:unavailableValue(r,{value:null,knownValue:null}),
        funnel:unavailableValue(r,{acquiredClients:null,bookedClients:null,attendedClients:null,payingClients:null,notYetPayingClients:null,
          reactivatedPriorPayers:null,unknownAcquisitionClients:null,leadsWithoutBooking}),
        activity:unavailableValue(r,{createdBookings:null,cancelledBookings:null,noShows:null,attendedUniqueVisits:null,paymentKopecks:null,refundKopecks:null,netKopecks:null}),
        margin:unavailableValue(r,{valueKopecks:null,costKopecks:null})},
      attribution:{firstTouch:unavailableValue(r,{boundClients:null,multiTouchClients:null,unknownClients:null}),recordLabel:unavailableValue(r),bindingReasons:[]},
      rows:[],economics:{cac:unavailableValue(blocked,{valueKopecks:null,exact:null}),romi:unavailableValue(blocked,{basisPoints:null,exact:null})},
      coverage:{status:'unavailable',reasons:blocked.list()}};
  }
  const {config,records,cash,historyFrom}=snapshot.data;
  // Тот же формат, что localDay() из revenue-analytics-access, но один форматтер на вызов.
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
  const dayOf=ms=>formatter.format(ms),inCohort=d=>d>=cohort.from&&d<=cohort.to;
  const collectedDay=dayOf(snapshot.data.collectedAt);
  const rules=new Map(config.cashRules.map(r=>[r.expenseId,r.kind]));
  const byId=new Map(records.map(r=>[r.id,r])),byVisit=new Map(),byClient=new Map();
  const push=(map,key,v)=>{const a=map.get(key);if(a)a.push(v);else map.set(key,[v]);};
  for(const r of records){if(r.visitId)push(byVisit,r.visitId,r);if(r.client)push(byClient,r.client,r);}
  // Связь как в report(): recordId или единственная запись visitId; противоречие клиента/визита — без записи.
  function link(t) {
    let record=null,conflict=false;
    if(t.recordId)record=byId.get(t.recordId)||null;
    else if(t.visitId&&byVisit.get(t.visitId)?.length===1)record=byVisit.get(t.visitId)[0];
    if(record&&t.visitId&&record.visitId&&t.visitId!==record.visitId)record=null;
    if(record&&t.client&&record.client&&t.client!==record.client){record=null;conflict=true;}
    return {record,clientConflict:conflict,client:conflict?null:t.client||record?.client||null};
  }
  const entries=[],unknownOps=[];
  for(const t of [...cash].sort((a,b)=>a.at-b.at||Number(a.id)-Number(b.id))) {
    if(t.deleted)continue;const d=dayOf(t.at);if(d>observationTo)continue;
    const kind=rules.get(t.expenseId);if(!kind){unknownOps.push({at:t.at,day:d,...link(t)});continue;}if(kind==='exclude')continue;
    const amount=kind==='payment'?Math.abs(t.amount):kind==='refund'?-Math.abs(t.amount):t.amount;
    if(amount)entries.push({id:t.id,at:t.at,day:d,amount,...link(t)});
  }

  // Календарные факты окна: отдельно от когорты привлечения.
  const calendarR=reasons();
  if(historyFrom>cohort.from)calendarR.add('HISTORY_AFTER_PERIOD_START');
  if(cohort.to>=collectedDay)calendarR.add('PERIOD_NOT_CLOSED');
  if(!rules.size)calendarR.add('CASH_RULES_MISSING');
  calendarR.add('UNKNOWN_CASH_ARTICLE',unknownOps.filter(u=>inCohort(u.day)).length);
  const calendar={createdBookings:0,cancelledBookings:0,noShows:0,attendedUniqueVisits:0,paymentKopecks:0,refundKopecks:0,netCashKopecks:0,firstObservedPayers:0};
  const calendarVisits=new Set();
  for(const r of records) {
    if(inCohort(dayOf(r.createdAt))){calendar.createdBookings++;if(r.deleted)calendar.cancelledBookings++;}
    if(!r.deleted&&inCohort(dayOf(r.visitAt))){if(r.attendance===-1)calendar.noShows++;if(r.attendance===1)calendarVisits.add(visitKey(r));}
  }
  calendar.attendedUniqueVisits=calendarVisits.size;
  for(const e of entries)if(inCohort(e.day)){if(e.amount>0)calendar.paymentKopecks=plus(calendar.paymentKopecks,e.amount);else calendar.refundKopecks=plus(calendar.refundKopecks,-e.amount);}
  calendar.netCashKopecks=plus(calendar.paymentKopecks,-calendar.refundKopecks);
  // Первая оплата в загруженной истории по календарю. Это не число новых клиентов когорты привлечения.
  const firstPaid=new Map();
  for(const e of entries)if(e.amount>0&&e.client&&!firstPaid.has(e.client))firstPaid.set(e.client,e.day);
  calendar.firstObservedPayers=[...firstPaid.values()].filter(inCohort).length;

  // Подтверждённые связи заявка→запись. Совпадения по контактам здесь не существуют.
  // Любое расхождение одной записи или одной заявки отклоняет все её связи: первый ввод не выбирается.
  const bindingR=reasons(),badClient=new Map(),byRecord=new Map(),byLead=new Map(),touchesOf=new Map(),orphans=[],valid=[];
  const taint=(client,code)=>{const s=badClient.get(client);if(s)s.add(code);else badClient.set(client,new Set([code]));};
  for(const b of bindings) {
    const r=byId.get(b.recordId);
    if(!r||!r.client){const code=r?'BINDING_CLIENT_MISSING':'BINDING_RECORD_MISSING';bindingR.add(code);orphans.push({code,touchAt:b.touchAt});continue;}
    push(byRecord,b.recordId,{...b,client:r.client,sig:JSON.stringify([b.leadId,b.kind,b.touchAt,b.touch.source,b.touch.campaign])});
  }
  for(const [rid,rows] of byRecord) {
    const r=byId.get(rid);
    if(new Set(rows.map(b=>b.sig)).size>1){bindingR.add('BINDING_CONFLICT');taint(r.client,'BINDING_CONFLICT');continue;}
    if(rows[0].touchAt>r.createdAt){bindingR.add('BINDING_TIME_INCONSISTENT');taint(r.client,'BINDING_TIME_INCONSISTENT');continue;}
    valid.push(rows[0]);if(rows[0].leadId)push(byLead,rows[0].leadId,rows[0]);
  }
  const rejectedLeads=new Set();
  for(const [lead,rows] of byLead) {
    // Одна заявка может вести к нескольким записям одного клиента, но только с одинаковым касанием.
    const code=new Set(rows.map(b=>b.sig)).size>1?'BINDING_LEAD_CONFLICT':new Set(rows.map(b=>b.client)).size>1?'BINDING_LEAD_MULTIPLE_CLIENTS':null;
    if(code){bindingR.add(code);rejectedLeads.add(lead);for(const b of rows)taint(b.client,code);}
  }
  for(const b of valid)if(!b.leadId||!rejectedLeads.has(b.leadId))push(touchesOf,b.client,b);

  // Самый ранний факт существования клиента: запись или денежная операция любой статьи.
  const earliest=new Map(),entriesOf=new Map();
  const seen=(client,at)=>{if(client&&!(earliest.get(client)<=at))earliest.set(client,at);};
  for(const r of records)seen(r.client,r.createdAt);
  for(const e of [...entries,...unknownOps])seen(e.client,e.at);
  for(const e of entries)if(e.client)push(entriesOf,e.client,e);
  const paying=client=>(entriesOf.get(client)||[]).some(e=>e.amount>0);

  // Классификация клиента. Привлечение не может быть позже его первой записи или операции,
  // поэтому клиент с фактом раньше окна точно не входит в когорту даже без связи.
  const cls=new Map();
  for(const [client,firstAt] of [...earliest].sort((a,b)=>a[0]<b[0]?-1:1)) {
    const firstDay=dayOf(firstAt),unresolved=code=>cls.set(client,{kind:firstDay<cohort.from?'before':'unknown',code});
    const bad=badClient.get(client);
    if(bad){unresolved([...bad].sort()[0]);continue;}
    const touches=[...(touchesOf.get(client)||[])].sort((a,b)=>a.touchAt-b.touchAt||(a.sig<b.sig?-1:a.sig>b.sig?1:0));
    if(!touches.length){unresolved('ATTRIBUTION_UNBOUND');continue;}
    const touch=touches[0];
    if(new Set(touches.filter(t=>t.touchAt===touch.touchAt).map(t=>t.sig)).size>1){unresolved('ACQUISITION_TOUCH_AMBIGUOUS');continue;}
    const acqDay=dayOf(touch.touchAt);
    if((entriesOf.get(client)||[]).some(e=>e.amount>0&&e.at<touch.touchAt)){cls.set(client,{kind:'prior',acqDay});continue;}
    if(firstAt<touch.touchAt){unresolved('ACQUISITION_EARLIER_CONTACT');continue;}
    cls.set(client,{kind:inCohort(acqDay)?'member':'outside',touch,acqDay,touches:new Set(touches.map(t=>t.sig)).size});
  }

  // Причины неизвестности: привлечение (воронка) и новизна платящих (знаменатель CAC).
  const acqR=reasons(),freshR=reasons();
  if(historyFrom>cohort.from){acqR.add('HISTORY_AFTER_PERIOD_START');freshR.add('HISTORY_AFTER_PERIOD_START');}
  if(cohort.to>=collectedDay)acqR.add('PERIOD_NOT_CLOSED');
  // Связь без клиента с касанием не позже окна могла бы добавить члена или сдвинуть чьё-то первое касание раньше.
  for(const o of orphans)if(dayOf(o.touchAt)<=cohort.to){acqR.add(o.code);freshR.add(o.code);}
  let unknownClients=0,reactivated=0;
  for(const [client,k] of cls) {
    if(k.kind==='prior'&&inCohort(k.acqDay))reactivated++;
    if(k.kind!=='unknown')continue;
    unknownClients++;acqR.add(k.code);
    // Неизвестный клиент без оплаты к observationTo не может быть новым платящим: CAC он не блокирует.
    if(paying(client))freshR.add(k.code);
  }
  if(!history||historyFrom>history.noPaymentsBefore)freshR.add('PAYMENT_HISTORY_UNPROVEN');
  if(observationTo>=collectedDay)freshR.add('PERIOD_NOT_CLOSED');
  if(!rules.size)freshR.add('CASH_RULES_MISSING');
  for(const e of entries)if(e.amount>0&&!e.client)freshR.add(e.clientConflict?'CLIENT_IDENTITY_CONFLICT':'CLIENT_IDENTITY_MISSING');
  const memberUnknown=reasons();
  for(const u of unknownOps) {
    if(!u.client){freshR.add('UNKNOWN_CASH_ARTICLE');continue;}
    if(cls.get(u.client).kind!=='member')continue;
    // Неизвестная операция члена когорты искажает его деньги; число платящих — только если он ещё не платил.
    memberUnknown.add('UNKNOWN_CASH_ARTICLE');if(!paying(u.client))freshR.add('UNKNOWN_CASH_ARTICLE');
  }
  const revenueR=reasons().merge(freshR,memberUnknown);
  for(const e of entries)if(e.amount<0&&!e.client&&e.day>=cohort.from)revenueR.add('REFUND_UNASSIGNED');

  const members=[...cls].filter(([,k])=>k.kind==='member').map(([client])=>client);
  const labelR=reasons(),marginR=reasons().merge(taxR),groups=new Map(),paidRecords=new Set(),totalVisits=new Set();
  const activity={createdBookings:0,cancelledBookings:0,noShows:0,attendedUniqueVisits:0,paymentKopecks:0,refundKopecks:0,netKopecks:0};
  const funnel={acquiredClients:members.length,bookedClients:0,attendedClients:0,payingClients:0,notYetPayingClients:0};
  function group(basis,key,attribution) {
    const k=basis+'|'+key;
    if(!groups.has(k))groups.set(k,{basis,key,attribution,acquired:0,clients:0,createdBookings:0,cancelledBookings:0,noShows:0,
      paymentKopecks:0,refundKopecks:0,visits:new Set(),records:new Set()});
    return groups.get(k);
  }
  let multiTouch=0;
  for(const client of members) {
    const k=cls.get(client),mine=entriesOf.get(client)||[],paid=mine.filter(e=>e.amount>0);
    if(k.touches>1)multiTouch++;
    const targets=[group('first_touch',JSON.stringify([k.touch.touch.source,k.touch.touch.campaign]),{...k.touch.touch})];
    if(paid.length) {
      funnel.payingClients++;
      const firstDay=paid[0].day,acquired=paid.filter(e=>e.day===firstDay);
      let labelKey='unknown',utm=null;
      if(acquired.some(e=>!e.record))labelR.add('PAYMENT_UNMATCHED');
      else {
        const recs=[...new Map(acquired.map(e=>[e.record.id,e.record])).values()];
        const labels=new Set(recs.map(r=>r.utm.source?JSON.stringify(UTM_KEYS.map(k=>r.utm[k]||'')):'unknown'));
        if(labels.size===1){labelKey=[...labels][0];utm=labelKey==='unknown'?null:{...recs[0].utm};}else labelR.add('ACQUISITION_RECORD_AMBIGUOUS');
      }
      targets.push(group('record_label',labelKey,utm));
    } else funnel.notYetPayingClients++;
    for(const g of targets){g.acquired++;if(paid.length)g.clients++;}
    for(const e of mine) {
      const field=e.amount>0?'paymentKopecks':'refundKopecks',value=Math.abs(e.amount);
      activity[field]=plus(activity[field],value);for(const g of targets)g[field]=plus(g[field],value);
      if(e.record){paidRecords.add(e.record.id);for(const g of targets)g.records.add(e.record.id);}else marginR.add('PAYMENT_UNMATCHED');
    }
    let booked=false,attended=false;
    for(const r of byClient.get(client)||[]) {
      if(dayOf(r.createdAt)<=observationTo){booked=true;activity.createdBookings++;if(r.deleted)activity.cancelledBookings++;
        for(const g of targets){g.createdBookings++;if(r.deleted)g.cancelledBookings++;}}
      if(!r.deleted&&dayOf(r.visitAt)<=observationTo) {
        if(r.attendance===-1){activity.noShows++;for(const g of targets)g.noShows++;}
        if(r.attendance===1){attended=true;totalVisits.add(visitKey(r));for(const g of targets)g.visits.add(visitKey(r));}
      }
    }
    if(booked)funnel.bookedClients++;if(attended)funnel.attendedClients++;
  }
  activity.attendedUniqueVisits=totalVisits.size;activity.netKopecks=plus(activity.paymentKopecks,-activity.refundKopecks);

  // Себестоимость: каждая оплаченная запись когорты должна иметь подтверждённый факт.
  if(costs===null)marginR.add('COSTS_MISSING');
  else for(const rid of paidRecords) {
    const f=costs.get(rid);if(!f){marginR.add('COST_RECORD_MISSING');continue;}
    if(f.currency!==currency)marginR.add('CURRENCY_MISMATCH');if(f.vatMode!==vatMode)marginR.add('VAT_MODE_MISMATCH');
  }
  const costOf=ids=>{let s=0;for(const rid of ids)s=plus(s,costs.get(rid).costKopecks);return s;};
  const marginKnown=!marginR.size&&!revenueR.size;
  const costTotal=marginKnown?costOf(paidRecords):null,margin=marginKnown?plus(activity.netKopecks,-costTotal):null;

  // Знаменатель CAC — только новые платящие окна привлечения; расход — того же окна привлечения.
  const romiValue=(netMargin,spendKopecks)=>({status:'verified',basisPoints:ratio(BigInt(plus(netMargin,-spendKopecks))*10000n,spendKopecks),
    exact:{netMarginKopecks:netMargin,spendKopecks},reasons:[]});
  const n=funnel.payingClients,cacR=reasons().merge(freshR,spend.reasons,taxR),romiR=reasons().merge(cacR,revenueR,marginR);
  const cac=cacR.size?unavailableValue(cacR,{valueKopecks:null,exact:null}):
    !n?notApplicable('NO_NEW_CLIENTS',{valueKopecks:null,exact:{spendKopecks:spend.total,clients:0}}):
    {status:'verified',valueKopecks:ratio(spend.total,n),exact:{spendKopecks:spend.total,clients:n},reasons:[]};
  const romi=romiR.size?unavailableValue(romiR,{basisPoints:null,exact:null}):
    !spend.total?notApplicable('ZERO_SPEND',{basisPoints:null,exact:{netMarginKopecks:margin,spendKopecks:0}}):romiValue(margin,spend.total);

  // Каналы: расход привязан словарём кампаний к первому касанию; метки записей расход не получают.
  for(const [key,v] of spend.byKey)if(!groups.has('first_touch|'+key))group('first_touch',key,{...v.utm});
  const channelR=reasons().merge(cacR,spend.channelReasons),channelRomiR=reasons().merge(channelR,revenueR,marginR);
  const rows=[...groups.values()].sort((a,b)=>a.basis<b.basis?-1:a.basis>b.basis?1:a.key<b.key?-1:a.key>b.key?1:0).map(g=>{
    const row={basis:g.basis,attribution:g.attribution,acquiredClients:g.acquired,clients:g.clients,createdBookings:g.createdBookings,cancelledBookings:g.cancelledBookings,
      noShows:g.noShows,attendedUniqueVisits:g.visits.size,paymentKopecks:g.paymentKopecks,refundKopecks:g.refundKopecks,
      netKopecks:plus(g.paymentKopecks,-g.refundKopecks),spendKopecks:null,cac:null,romi:null};
    if(g.basis!=='first_touch')return row;
    if(channelR.size){row.cac=unavailableValue(channelR,{valueKopecks:null});row.romi=unavailableValue(channelRomiR,{basisPoints:null});return row;}
    const s=spend.byKey.get(g.key)?.amount||0;row.spendKopecks=s;
    row.cac=g.clients?{status:'verified',valueKopecks:ratio(s,g.clients),reasons:[]}:notApplicable('NO_NEW_CLIENTS',{valueKopecks:null});
    row.romi=channelRomiR.size?unavailableValue(channelRomiR,{basisPoints:null}):!s?notApplicable('ZERO_SPEND',{basisPoints:null}):
      romiValue(plus(row.netKopecks,-costOf(g.records)),s);
    return row;
  });

  const funnelR=reasons().merge(acqR,freshR);
  const coverage=reasons().merge(calendarR,acqR,freshR,revenueR,labelR,bindingR,spend.reasons,spend.channelReasons,marginR).add('LEAD_JOURNAL_NOT_INTEGRATED');
  return {...result,
    calendar:{status:state(calendarR),...calendar,reasons:calendarR.list()},
    cohortTotals:{
      newPayingClients:freshR.size?unavailableValue(freshR,{value:null,knownValue:n}):{status:'verified',value:n,knownValue:n,reasons:[]},
      funnel:{status:state(funnelR),...funnel,reactivatedPriorPayers:reactivated,unknownAcquisitionClients:unknownClients,leadsWithoutBooking,reasons:funnelR.list()},
      activity:{status:state(revenueR),...activity,reasons:revenueR.list()},
      margin:marginKnown?{status:'verified',valueKopecks:margin,costKopecks:costTotal,reasons:[]}:unavailableValue(reasons().merge(revenueR,marginR),{valueKopecks:null,costKopecks:null})
    },
    attribution:{firstTouch:{status:state(acqR),boundClients:members.length,multiTouchClients:multiTouch,unknownClients,reasons:acqR.list()},
      recordLabel:{status:state(labelR),reasons:labelR.list()},bindingReasons:bindingR.list()},
    rows,economics:{cac,romi},coverage:{status:coverage.size?'partial':'complete',reasons:coverage.list()}};
}

module.exports={buildRevenueCohorts,REASONS,EVIDENCE,CONTRACT};
