'use strict';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const key=id=>`person:${id}`;
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
function createPeopleTasks({authStore,db,call}) {
  function access(userId,companyCode,write=false) {
    const user=authStore.getById(userId);
    if(!user)fail(401,'Требуется вход в кабинет');
    if(!user.companyCodes.includes(companyCode))fail(403,'Компания недоступна');
    if(user.role!=='owner') {
      const member=db.prepare("SELECT 1 FROM company_team_members WHERE user_id=? AND company_code=? AND staff_role='human_executor'").get(userId,companyCode);
      if(!member||!user.permissions.includes(write?'tasks.self.edit':'tasks.self.view'))fail(403,'Нет доступа к своим задачам');
    }
    return user;
  }
  async function rows(userId,code) {
    const list=[];let offset=0;
    for(let page=0;page<100;page++) {
      const actor=access(userId,code),result=await call('tasks_list',{project:code,limit:100,offset},actor,code);
      access(userId,code);
      if(!Array.isArray(result.tasks))fail(502,'Некорректный список задач');
      list.push(...result.tasks.filter(task=>same(task.company_code,code)));
      if(result.tasks.length<100||offset+result.tasks.length>=result.total)return list;
      offset+=result.tasks.length;
    }
    fail(503,'Слишком большой проект: требуется уточнение списка задач');
  }
  function visible(task,map,user,code) {
    if(!task||!same(task.company_code,code))return false;
    if(user.role==='owner')return true;
    let row=task;const visited=new Set();
    while(row&&!visited.has(row.id)&&same(row.company_code,code)) {
      visited.add(row.id);
      // Явное назначение другому исполнителю закрывает наследование ветки.
      if(row.assignee_name)return row.assignee_name===key(user.id);
      row=map.get(row.parent_task_id);
    }
    return false;
  }
  function dto(task,user,children) {
    const direct=task.assignee_name===key(user.id),coord=task.coordination||{},milestones=coord.milestones||{};
    const total=task.subtask_count||0,done=task.subtask_done||0;
    const percent=total?Math.round(done/total*100):Object.values(milestones).filter(stage=>stage.state==='confirmed').length*25;
    return {id:task.id,title:task.title,description:task.description||'',status:task.status,
      company_code:task.company_code,assignee_name:task.assignee_name||'',
      assigneeName:direct?user.displayName:task.assignee_name||'',parent_task_id:task.parent_task_id,
      subtask_count:total,subtask_done:done,percent:Math.min(100,percent),
      purpose:(task.description||'').split(/\r?\n/).find(line=>/^\s*ЦКП\s*:/i.test(line))?.replace(/^\s*ЦКП\s*:\s*/i,'')||'',
      coordination:{revision:coord.revision,milestones},canEdit:user.role==='owner'||direct&&user.permissions.includes('tasks.self.edit'),
      ...(children?{subtasks:children,comments:task.comments||[],comments_pagination:task.comments_pagination}:{} )};
  }
  async function list(userId,code) {
    // MCP summary не содержит description. Получаем описания пакетно через прежний
    // GET /tasks, без N запросов detail и без изменения контракта доски №26.
    const descriptions=new Map();let offset=0;
    for(let page=0;page<50;page++) {
      const actor=access(userId,code),result=await call('taskRecords',{offset},actor,code);
      access(userId,code);
      if(!Array.isArray(result.tasks))fail(502,'Некорректный список описаний задач');
      for(const row of result.tasks)if(same(row.companyCode,code))descriptions.set(row.id,row.description||'');
      offset+=result.tasks.length;
      if(result.tasks.length<200||offset>=result.pagination?.total)break;
      if(page===49)fail(503,'Слишком большой проект');
    }
    const all=await rows(userId,code),user=access(userId,code),map=new Map(all.map(t=>[t.id,t]));
    const tasks=all.filter(t=>visible(t,map,user,code)).map(t=>dto({...t,description:descriptions.get(t.id)||''},user));
    return {tasks,total:tasks.length};
  }
  async function get(userId,code,id) {
    if(!Number.isSafeInteger(id)||id<1)fail(404,'Задача не найдена');
    const all=await rows(userId,code),map=new Map(all.map(t=>[t.id,t]));let user=access(userId,code);
    if(!visible(map.get(id),map,user,code))fail(404,'Задача не найдена');
    const result=await call('task_get',{task_id:id,subtasks_limit:100,comments_limit:20},user,code);
    // За время чтения могла быть переназначена сама ветка. Перепроверяем цепочку
    // по новой выборке, а не по map, который разрешил исходный запрос.
    const latest=await rows(userId,code),currentMap=new Map(latest.map(t=>[t.id,t]));
    user=access(userId,code);
    if(!visible(currentMap.get(id),currentMap,user,code)||!visible(result,currentMap,user,code))fail(404,'Задача не найдена');
    const children=(result.subtasks||[]).filter(t=>visible(currentMap.get(t.id),currentMap,user,code)&&visible(t,currentMap,user,code)).map(t=>dto(t,user));
    return {task:dto(result,user,children)};
  }
  async function update(userId,code,id,body) {
    if(!body||Object.keys(body).sort().join(',')!=='revision,status'||!Number.isSafeInteger(body.revision)||
      !['inbox','planned','in_progress','done','cancelled'].includes(body.status))fail(400,'Передайте только статус и ревизию задачи');
    const {task}=await get(userId,code,id);let user=access(userId,code,true);
    if(user.role!=='owner'&&task.assignee_name!==key(user.id))fail(403,'Статус меняет назначенный исполнитель');
    if(task.coordination.revision!==body.revision)fail(409,'Задача изменилась. Обновите карточку');
    const result=await call('task_update',{task_id:id,status:body.status,revision:body.revision},user,code);
    user=access(userId,code,true);
    if(!result.task||!same(result.task.company_code,code)||user.role!=='owner'&&result.task.assignee_name!==key(user.id))fail(409,'Доступ к задаче изменился. Обновите список');
    return {task:dto(result.task,user)};
  }
  return {access,list,get,update};
}
module.exports={createPeopleTasks,executorKey:key};
