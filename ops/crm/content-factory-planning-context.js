'use strict';
// Only the server may supply this projection. Fixed texts prevent collector errors or labels entering a prompt.
const {RECOMMENDATIONS,LIMITATIONS,UNAVAILABLE_LIMITATION,OPEN_PERIOD_LIMITATION}=require('./content-factory-planning-insights');
const PLATFORMS=['instagram','tiktok','youtube','vk','telegram','max'];
const fail=()=>{throw Object.assign(Error('Некорректный сохранённый контекст статистики'),{status:400,code:'VALIDATION_ERROR'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const timezone=value=>{if(value===null)return true;if(typeof value!=='string'||value.length>80||!value)return false;try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}};
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function validatePlanningContext(value,code,month){
 if(!exact(value,['schemaVersion','companyCode','planMonth','source','platforms','limitations'])||value.schemaVersion!==1||value.companyCode!==code.toLowerCase()||value.planMonth!==month||
   !/^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/.test(month)||Buffer.byteLength(JSON.stringify(value))>8192)fail();
 const {source}=value;
 if(!exact(source,['kind','status','period','capturedAt'])||source.kind!=='saved_social_stats'||!['available','unavailable'].includes(source.status)||!iso(source.capturedAt)||
   !exact(source.period,['from','to','timezone'])||!timezone(source.period.timezone))fail();
 const year=Number(month.slice(0,4)),index=Number(month.slice(5))-1;
 if(source.period.from!==new Date(Date.UTC(year,index-1,1)).toISOString().slice(0,10)||source.period.to!==new Date(Date.UTC(year,index,0)).toISOString().slice(0,10))fail();
 const texts=new Set([...LIMITATIONS,UNAVAILABLE_LIMITATION,OPEN_PERIOD_LIMITATION]);
 if(!Array.isArray(value.limitations)||value.limitations.length>8||new Set(value.limitations).size!==value.limitations.length||value.limitations.some(text=>!texts.has(text)))fail();
 if(!Array.isArray(value.platforms)||value.platforms.length>PLATFORMS.length||new Set(value.platforms.map(p=>p?.platform)).size!==value.platforms.length)fail();
 if(source.status==='unavailable'&&(value.platforms.length||value.limitations.length!==1||value.limitations[0]!==UNAVAILABLE_LIMITATION))fail();
 for(const item of value.platforms){
   if(!exact(item,['platform','timezone','coverage','confidence','freshness','editorialRecommendations'])||!PLATFORMS.includes(item.platform)||!timezone(item.timezone)||
     !['missing','partial','complete','state_only','incompatible'].includes(item.coverage)||!['insufficient','limited','descriptive'].includes(item.confidence))fail();
   const fresh=item.freshness;
   if(!exact(fresh,['status','lastCollectedAt','basis'])||!['unknown','recent','stale'].includes(fresh.status)||fresh.basis!=='saved_collection_time'||
     (fresh.lastCollectedAt!==null&&!iso(fresh.lastCollectedAt))||(fresh.status==='unknown')!==(fresh.lastCollectedAt===null))fail();
   if(!Array.isArray(item.editorialRecommendations)||item.editorialRecommendations.length>2||new Set(item.editorialRecommendations.map(r=>r?.code)).size!==item.editorialRecommendations.length)fail();
   for(const recommendation of item.editorialRecommendations)if(!exact(recommendation,['code','text'])||!Object.hasOwn(RECOMMENDATIONS,recommendation.code)||recommendation.text!==RECOMMENDATIONS[recommendation.code])fail();
   if(item.coverage==='missing'&&(item.confidence!=='insufficient'||item.editorialRecommendations.length))fail();
 }
 return JSON.parse(JSON.stringify(value));
}
function planningPromptContext(value,code,month){
 const context=validatePlanningContext(value,code,month);
 return {source:'saved_social_stats',period:{from:context.source.period.from,to:context.source.period.to},status:context.source.status,
   platforms:context.platforms.map(item=>({platform:item.platform,coverage:item.coverage,confidence:item.confidence,freshness:item.freshness.status,
     editorialRecommendations:item.editorialRecommendations.map(r=>({code:r.code,text:r.text}))})),limitations:context.limitations};
}
module.exports={validatePlanningContext,planningPromptContext};
