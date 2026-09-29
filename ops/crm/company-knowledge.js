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
    const required=new Set(['title','price','currency','procedureCount',...Object.keys(service).filter(key=>key!=='id'&&populated(service[key]))]);
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
module.exports={companyKnowledge};
