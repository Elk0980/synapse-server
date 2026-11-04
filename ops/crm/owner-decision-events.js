 'use strict';
const waiting=value=>/^ждет\s+влада(?=$|[^а-яa-z0-9_])/iu.test(String(value||'').trim().toLowerCase().replace(/ё/g,'е'));
function ownerDecisionEvent(db,row) {
  if (!row || row.is_deleted || ['done','cancelled'].includes(row.status)) return null;
  const history=db.prepare('SELECT revision,data FROM task_coordination_history WHERE task_id=? ORDER BY revision DESC').all(row.id);
  const current=db.prepare('SELECT data FROM task_coordination WHERE task_id=?').get(row.id);
  const blocker=current?JSON.parse(current.data).blocker||'':'';
  if(waiting(blocker)) {
    // Walk the continuous identical-blocker chain: unrelated edits cannot create another event.
    let revision=0;
    for(const item of history) {
      if((JSON.parse(item.data).blocker||'')!==blocker)break;
      revision=item.revision;
    }
    return {taskId:row.id,eventKey:`owner-decision:${row.id}:blocker:${revision}`,title:row.title};
  }
  const first=history.at(-1);
  if(String(row.assignee_name||'').trim().toLowerCase()==='влад' && (!first ||
      first.revision===1 && String(JSON.parse(first.data).executorName||'').trim().toLowerCase()==='влад'))
    return {taskId:row.id,eventKey:`owner-decision:${row.id}:created`,title:row.title};
  return null;
}
function listOwnerDecisionEvents(db,code,{offset=0,taskId}={}) {
  const rows=taskId?db.prepare('SELECT * FROM tasks WHERE id=? AND company_code=? COLLATE NOCASE AND is_deleted=0').all(taskId,code):
    db.prepare('SELECT * FROM tasks WHERE company_code=? COLLATE NOCASE AND is_deleted=0 ORDER BY id LIMIT 100 OFFSET ?').all(code,offset);
  return {events:rows.map(row=>ownerDecisionEvent(db,row)).filter(Boolean),nextOffset:!taskId&&rows.length===100?offset+100:null};
}
module.exports={waiting,ownerDecisionEvent,listOwnerDecisionEvents};
