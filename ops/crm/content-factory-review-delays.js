'use strict';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
function validDay(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(value+'T00:00:00.000Z');return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value;
}
// Чистое чтение: не вызывает autoposting.get/list/invalidate и не создаёт CRM events.
function createContentFactoryReviewDelays({db,now=()=>Date.now()}){
  function pending({companyCode,limit=100,afterTaskId=0}={}){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail(400,'Лимит сводки от 1 до 100');
    if(!Number.isSafeInteger(afterTaskId)||afterTaskId<0)fail(400,'Некорректный курсор задач');
    if(companyCode!==undefined&&(typeof companyCode!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(companyCode)))fail(400,'Выберите компанию');
    const at=now();if(!Number.isFinite(at))fail(503,'Время проверки недоступно');const detectedAt=new Date(at).toISOString(),items=[],days=new Map();
    const rows=db.prepare(`SELECT c.code companyCode,c.timezone,l.post_id postId,l.content_revision contentRevision,
      t.id taskId,t.status taskStatus,t.assignee_role assigneeRole,t.assignee_name assigneeName,t.due_date dueDate
      FROM autoposting_review_tasks l JOIN autoposting_posts p ON p.id=l.post_id AND p.company_id=l.company_id
      JOIN companies c ON c.id=l.company_id JOIN tasks t ON t.id=l.task_id AND t.company_code=c.code COLLATE NOCASE
      WHERE t.id>? AND c.is_deleted=0 AND t.is_deleted=0 AND t.status IN ('inbox','planned','in_progress')
      AND p.archived_at IS NULL AND p.status NOT IN ('published','publishing','cancelled') AND l.content_revision=p.content_revision
      AND p.review_state<>'approved' AND (p.approved_revision IS NULL OR p.approved_revision<>p.content_revision OR EXISTS(
        SELECT 1 FROM json_each(p.platform_ids) selected JOIN autoposting_platform_reviews r ON r.post_id=p.id AND r.platform_id=selected.value
        WHERE r.state<>'approved' OR r.content_revision<>p.content_revision))
      AND t.due_date<>'' AND t.assignee_role IN ('owner','admin','marketer','synapse')
      AND NOT EXISTS(SELECT 1 FROM autoposting_review_tasks newer WHERE newer.post_id=l.post_id AND newer.post_revision>l.post_revision)
      ${companyCode!==undefined?'AND c.code=? COLLATE NOCASE':''} ORDER BY t.id`);
    for(const row of rows.iterate(afterTaskId,...(companyCode!==undefined?[companyCode]:[]))){
      if(!validDay(row.dueDate)||row.assigneeName.trim().length>2000||/[\x00-\x1f\x7f]/.test(row.assigneeName))continue;const timezone=row.timezone||'UTC';
      if(!days.has(timezone)){
        let today=null;try{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at);
          const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));today=`${values.year}-${values.month}-${values.day}`;}catch{}
        days.set(timezone,today);
      }
      const asOfDate=days.get(timezone);if(!asOfDate||row.dueDate>=asOfDate)continue;
      const code=row.companyCode.toLowerCase(),assigneeName=row.assigneeName.trim();
      items.push({...row,companyCode:code,timezone,timezoneSource:row.timezone?'company':'utc_fallback',assigneeName,asOfDate,detectedAt,
        eventKey:`content-review-delay:${code}:${row.postId}:${row.taskId}:${row.dueDate}:${row.contentRevision}`});
      if(items.length>limit)break;
    }
    const hasMore=items.length>limit;return {detectedAt,items:items.slice(0,limit),hasMore,nextAfterTaskId:hasMore?items[limit-1].taskId:0};
  }
  return {pending};
}
module.exports={createContentFactoryReviewDelays};
