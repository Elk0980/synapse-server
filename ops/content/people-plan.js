'use strict';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
function createPeoplePlan({db,authStore,tasks,call}) {
  function access(id,code) {
    const user=tasks.access(id,code);
    if(user.role!=='owner'&&!user.permissions.includes('content-plan.approve'))fail(403,'Нет права согласовывать план проекта');
    return user;
  }
  function grant(actorId,userId,code,enabled) {
    const actor=authStore.getById(actorId);
    if(!actor||actor.role!=='owner'||!actor.companyCodes.includes(code))fail(403,'Право назначает владелец');
    if(typeof enabled!=='boolean')fail(400,'Укажите состояние права согласования');
    const target=tasks.access(userId,code);
    if(target.role==='owner')fail(400,'Владелец уже имеет право согласования');
    db.exec('BEGIN IMMEDIATE');
    try {
      if(enabled)db.prepare('INSERT OR IGNORE INTO auth_user_permissions VALUES(?,?)').run(userId,'content-plan.approve');
      else db.prepare('DELETE FROM auth_user_permissions WHERE user_id=? AND permission=?').run(userId,'content-plan.approve');
      authStore.audit(actorId,userId,'PEOPLE_PLAN_APPROVAL_ACCESS',{companyCode:code,enabled});
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return {userId,companyCode:code,canApprovePlan:enabled};
  }
  const safe=(snapshot,code)=>{
    if(snapshot?.companyCode!==code||!snapshot.brief||!Array.isArray(snapshot.variants))fail(502,'Некорректный план проекта');
    return {companyCode:code,brief:{revision:snapshot.brief.revision},
      plan:snapshot.plan?{revision:snapshot.plan.revision,briefRevision:snapshot.plan.briefRevision,days:snapshot.plan.days}:null,
      variants:snapshot.variants,approval:snapshot.approval};
  };
  async function get(id,code) {const user=access(id,code),result=await call('mediaMentor',{},user,code);access(id,code);return {snapshot:safe(result,code)};}
  async function decide(id,code,body) {
    const allowed=['planRevision','briefRevision','scope','ideaId','decision','comment'];
    if(!body||Object.keys(body).some(k=>!allowed.includes(k))||!['plan','idea'].includes(body.scope)||
      !Number.isSafeInteger(body.planRevision)||body.planRevision<1||!Number.isSafeInteger(body.briefRevision)||body.briefRevision<1||
      !['approved','rejected','withdrawn'].includes(body.decision)||typeof body.comment!=='string'||body.comment.length>2000||
      body.scope==='idea'&&(typeof body.ideaId!=='string'||!body.ideaId.trim())||body.scope==='plan'&&body.ideaId!==undefined||
      body.decision==='rejected'&&!body.comment.trim())fail(400,'Проверьте версию, область и комментарий решения');
    const user=access(id,code),result=await call('planVariantsDecision',body,user,code);access(id,code);
    return {snapshot:safe(result,code)};
  }
  return {access,get,decide,grant};
}
module.exports={createPeoplePlan};
