'use strict';
const fail=()=>{throw Object.assign(Error('Некорректная служебная сводка просроченной доработки'),{status:502});};
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===allowed.length&&Object.keys(value).every(key=>allowed.includes(key));
const day=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const at=new Date(value+'T00:00:00.000Z');return Number.isFinite(at.valueOf())&&at.toISOString().slice(0,10)===value;};
const stamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function validate(summary,afterTaskId){
  if(!keys(summary,['detectedAt','items','hasMore','nextAfterTaskId'])||!stamp(summary.detectedAt)||!Array.isArray(summary.items)||summary.items.length>100||typeof summary.hasMore!=='boolean'||
    !Number.isSafeInteger(summary.nextAfterTaskId)||summary.nextAfterTaskId<0)fail();
  const seen=new Set();let previous=afterTaskId;
  for(const item of summary.items){
    if(!keys(item,['companyCode','timezone','timezoneSource','postId','contentRevision','taskId','taskStatus','assigneeRole','assigneeName','dueDate','asOfDate','detectedAt','eventKey'])||
      typeof item.companyCode!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.companyCode)||
      ['postId','taskId','contentRevision'].some(key=>!Number.isSafeInteger(item[key])||item[key]<1)||
      !['inbox','planned','in_progress'].includes(item.taskStatus)||!['owner','admin','marketer','synapse'].includes(item.assigneeRole)||
      typeof item.assigneeName!=='string'||item.assigneeName.length>2000||item.assigneeName!==item.assigneeName.trim()||/[\x00-\x1f\x7f]/.test(item.assigneeName)||
      !day(item.dueDate)||!day(item.asOfDate)||item.dueDate>=item.asOfDate||item.detectedAt!==summary.detectedAt||typeof item.timezone!=='string'||item.timezone.length>100||
      !['company','utc_fallback'].includes(item.timezoneSource)||item.timezoneSource==='utc_fallback'&&item.timezone!=='UTC')fail();
    let actualDay;try{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:item.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(Date.parse(item.detectedAt));
      const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));actualDay=`${values.year}-${values.month}-${values.day}`;}catch{fail();}
    if(actualDay!==item.asOfDate||item.eventKey!==`content-review-delay:${item.companyCode}:${item.postId}:${item.taskId}:${item.dueDate}:${item.contentRevision}`||seen.has(item.eventKey))fail();
    if(item.taskId<=previous)fail();previous=item.taskId;seen.add(item.eventKey);
  }
  if(summary.hasMore?(summary.items.length!==100||summary.nextAfterTaskId!==previous):summary.nextAfterTaskId!==0)fail();
  return summary.items;
}
function createContentFactoryReviewDelayNotifications({request,alerts}){
  let afterTaskId=0;
  async function sync({signal}={}){
    let queued=0,summary;
    for(let page=0;page<10;page++){
      signal?.throwIfAborted();summary=await request('review-delays',{afterTaskId,limit:100},signal);const items=validate(summary,afterTaskId);signal?.throwIfAborted();
      for(const item of items){
        signal?.throwIfAborted();const assignee=item.assigneeName?`ответственный ${item.assigneeName} (${item.assigneeRole})`:'ответственный не назначен';
        const zone=item.timezoneSource==='utc_fallback'?'UTC — часовой пояс компании не задан':item.timezone;
        const text=`Доработка публикации №${item.postId} была просрочена по состоянию на ${item.detectedAt} (дата ${item.asOfDate}, ${zone}); срок ${item.dueDate}, ${assignee}. Откройте задачу №${item.taskId}. Это факт на время проверки; текущее состояние уточните в задаче.`;
        await alerts.add(item.companyCode,item.eventKey,text);
      }
      // Ошибка/abort не продвигает страницу; durable INSERT OR IGNORE делает её повтор безопасным.
      signal?.throwIfAborted();afterTaskId=summary.nextAfterTaskId;queued+=items.length;if(!summary.hasMore)break;
    }
    return {queued,hasMore:summary.hasMore,detectedAt:summary.detectedAt};
  }
  return {sync};
}
module.exports={createContentFactoryReviewDelayNotifications};
