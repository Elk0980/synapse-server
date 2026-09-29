'use strict';

const {createHash}=require('node:crypto');
const {profileFacts}=require('./company-facts');
const ROOT_FIELDS=['name','city','timezone','phone','email','websiteUrl','address','hours','description'];
const populated=value=>value!==undefined&&value!==null&&value!=='';

// Проекция только текущих значений. Старые цены и текст неподтверждённых фактов
// не передаются потребителю даже вместе с предупреждением.
function companyKnowledge(snapshot) {
  const current=profileFacts(snapshot.profile);
  const facts=new Map(snapshot.facts.map(fact=>[fact.key,fact]));
  const valid=key=>{
    const fact=facts.get(key),entry=current.get(key);
    return !!(fact&&entry&&!fact.removed&&fact.status==='confirmed'&&fact.source&&fact.sourceRef&&fact.checkedAt
      &&JSON.stringify(fact.value)===JSON.stringify(entry.value));
  };
  const evidence=key=>{
    const fact=facts.get(key);
    return {factId:fact.id,key,source:fact.source,sourceRef:fact.sourceRef,checkedAt:fact.checkedAt,supersedesId:fact.supersedesId};
  };
  const profile={},sources={},missingFields=[];
  for(const key of ROOT_FIELDS) {
    if(!populated(snapshot.profile[key]))continue;
    if(valid(key)){profile[key]=snapshot.profile[key];sources[key]=evidence(key);}
    else missingFields.push(key);
  }
  const services=[],unavailableServices=[];
  for(const service of snapshot.profile.services||[]) {
    const prefix=`services/${encodeURIComponent(service.id)}/`;
    // Нельзя выдавать голую цену без названия, валюты или без подтверждения
    // сохранённых условий/длительности. Ноль — допустимая цена, отсутствие — нет.
    const required=new Set(['title','price','currency',...(service.priceUnit==='program'?['priceUnit','guestCount','visitDurationMinutes']:service.priceUnit==='minutes'?['priceUnit','minuteCount']:['procedureCount']),...Object.keys(service).filter(key=>key!=='id'&&populated(service[key]))]);
    const missing=[...required].filter(key=>!populated(service[key])||!valid(prefix+key));
    if(missing.length){unavailableServices.push({id:service.id,missingFields:missing});continue;}
    const fields=Object.keys(service).filter(key=>key!=='id'&&populated(service[key]));
    services.push({id:service.id,...Object.fromEntries(fields.map(key=>[key,service[key]])),
      sources:Object.fromEntries(fields.map(key=>[key,evidence(prefix+key)]))});
  }
  const data={schemaVersion:1,companyCode:snapshot.companyCode,profileRevision:snapshot.revision,
    profile,sources,services,readiness:{catalog:services.length
      ?(unavailableServices.length?'partial':'verified'):'unavailable',
      missingFields,unavailableServices,
      // Скидки и материалы требуют отдельной проверки срока и применимости.
      promotions:'unavailable',materials:'unavailable'}};
  return {...data,knowledgeRevision:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
}
// Потребитель передаёт только выбранный ID и версию просмотренного каталога.
// Цену, количество и условия заново берём из текущих доказанных сведений.
function serviceQuote(knowledge,serviceId,expectedRevision) {
  const fail=(status,message,code)=>{throw Object.assign(Error(message),{status,details:{code}});};
  if(typeof serviceId!=='string'||!serviceId||serviceId.length>100||
    typeof expectedRevision!=='string'||!/^[a-f0-9]{64}$/.test(expectedRevision))
    fail(400,'Укажите услугу и версию проверенного каталога','VALIDATION_ERROR');
  if(expectedRevision!==knowledge.knowledgeRevision)
    fail(409,'Каталог изменился. Обновите предложение перед ответом.','KNOWLEDGE_CHANGED');
  const found=knowledge.services.find(row=>row.id===serviceId);
  if(!found)fail(409,'Услуга отсутствует в проверенном каталоге. Передайте вопрос администратору.','SERVICE_UNAVAILABLE');
  const fields=['id','title','price','currency','priceUnit','minuteCount','guestCount','visitDurationMinutes','procedureCount','durationMinutes','bookingIntervalMinutes','description'];
  const service=Object.fromEntries(fields.filter(key=>populated(found[key])).map(key=>[key,found[key]]));
  const minutes=service.priceUnit==='minutes',count=minutes?service.minuteCount:service.procedureCount;
  const words=minutes?['минуту','минуты','минут']:['процедуру','процедуры','процедур'];
  const word=count%10===1&&count%100!==11?words[0]:count%10>=2&&count%10<=4&&!(count%100>=12&&count%100<=14)?words[1]:words[2];
  const unit=(service.priceUnit==='program'?'программу целиком':`${count} ${word}`)+(service.guestCount?` (гостей: ${service.guestCount})`:'');
  const lines=[service.title,`${String(service.price).replace('.',',')} ${service.currency==='RUB'?'₽':service.currency} за ${unit}.`];
  if(service.priceUnit==='program')lines.push(`Общая длительность визита: ${service.visitDurationMinutes} мин.`);
  else if(minutes)lines.push('Указано суммарное оплаченное время. Длительность отдельного сеанса уточнит администратор.');
  else if(service.durationMinutes)lines.push(`Продолжительность одной процедуры: ${service.durationMinutes} мин.`);
  if(service.description)lines.push(service.description);
  return {companyCode:knowledge.companyCode,knowledgeRevision:knowledge.knowledgeRevision,service,
    text:lines.join('\n'),availability:'not_checked'};
}
module.exports={companyKnowledge,serviceQuote};
