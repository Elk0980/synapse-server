'use strict';

const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const stages=['code','connected','verified','accepted'];
function createPeopleHandler({db,taskCoordination,mentor,identity,readJson,send}) {
  function access(request,code,permission) {
    const actor=identity(request);
    if(!actor||!['owner','editor'].includes(actor.role)||!Number.isSafeInteger(actor.userId)||actor.userId<1||
      typeof code!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)||
      !(actor.companyCodes instanceof Set)||actor.companyCodes.size!==1||!actor.companyCodes.has(code)||
      actor.role!=='owner'&&(!(actor.permissions instanceof Set)||!actor.permissions.has(permission)))fail(403,'Нет доступа к действию в этом проекте');
    return actor;
  }
  const projectRows=code=>db.prepare('SELECT * FROM tasks WHERE company_code=? COLLATE NOCASE AND is_deleted=0 ORDER BY id').all(code);
  function visible(row,map,actor,code) {
    if(!row||String(row.company_code).toLowerCase()!==code)return false;
    if(actor.role==='owner')return true;
    const seen=new Set();
    while(row&&!seen.has(row.id)&&String(row.company_code).toLowerCase()===code) {
      seen.add(row.id);
      if(row.assignee_name)return row.assignee_name===`person:${actor.userId}`;
      row=map.get(row.parent_task_id);
    }
    return false;
  }
  function view(row) {
    const fields=['id','title','description','company_code','assignee_name','status','parent_task_id','priority','due_date'];
    const stored=db.prepare('SELECT revision,data FROM task_coordination WHERE task_id=?').get(row.id),data=stored?JSON.parse(stored.data):{};
    const children=db.prepare("SELECT count(*) total,coalesce(sum(status='done'),0) done FROM tasks WHERE parent_task_id=? AND company_code=? COLLATE NOCASE AND is_deleted=0").get(row.id,row.company_code);
    return {...Object.fromEntries(fields.map(key=>[key,row[key]])),subtask_count:children.total,subtask_done:children.done,
      coordination:{revision:stored?.revision||0,milestones:Object.fromEntries(stages.map(key=>[key,data.milestones?.[key]||{state:'pending'}]))}};
  }
  const board=require('./people-board').createPeopleBoard({db,view});
  const integer=(value,fallback,max)=>{const n=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(n)||n<0||n>max)fail(400,'Некорректная страница');return n;};
  return async function handle(request,response,url,cors={}) {
    if(!url.pathname.startsWith('/internal/people/'))return false;
    const values=url.searchParams.getAll('companyCode'),code=values[0];
    if(values.length!==1||[...url.searchParams.keys()].some(key=>!['companyCode','offset',...(url.pathname.endsWith('/ownerDecisionEvents')?['taskId']:[])].includes(key)))fail(400,'Укажите один проект');
    const action=url.pathname.slice('/internal/people/'.length),method=request.method;
    const plan=action==='mediaMentor'||action==='planVariantsDecision';
    const write=['task_update','teamChatTask','hughTask','myBoardAction','taskChatComment'].includes(action);
    const actor=access(request,code,plan?'content-plan.approve':write?'tasks.self.edit':'tasks.self.view');
    let result;
    if(action==='teamChatContext'&&method==='GET') {
      const all=projectRows(code),map=new Map(all.map(row=>[row.id,row]));
      const snapshot=actor.role==='owner'||actor.permissions.has('content-plan.approve')?mentor.get(code):null;
      if(snapshot&&snapshot.companyCode!==code)fail(502,'Источник другого проекта');
      result={companyCode:code,tasks:all.filter(row=>visible(row,map,actor,code)).map(row=>({id:row.id,title:row.title,status:row.status,due_date:row.due_date})),
        plan:(snapshot?.plan?.days||[]).map(day=>({date:day.date,topic:day.topic,scripts:Object.values(day.variants||{}).map(v=>v.text||'')}))};
    } else if(action==='ownerDecisionEvents'&&method==='GET') {
      if(actor.role!=='owner')fail(403,'Только владелец');
      result=require('./owner-decision-events').listOwnerDecisionEvents(db,code,{offset:integer(url.searchParams.get('offset')??undefined,0,1e9),taskId:url.searchParams.has('taskId')?integer(url.searchParams.get('taskId'),0,1e9):undefined});
    } else if(action==='teamChatTask'&&method==='POST') {
      const body=await readJson(request),fresh=access(request,code,'tasks.self.edit');
      if(fresh.userId!==actor.userId)fail(403,'Доступ изменился');
      result=require('./team-chat-task').createTeamChatTask(db,code,fresh,body);
    } else if(['hughTask','myBoardAction','taskChatComment'].includes(action)&&method==='POST') {
      const body=await readJson(request),fresh=access(request,code,'tasks.self.edit');
      if(fresh.userId!==actor.userId)fail(403,'Доступ изменился');
      result=action==='hughTask'?require('./team-chat-task').createTeamChatTask(db,code,fresh,body,'hugh'):
        action==='myBoardAction'?board.action(code,fresh,body):board.comment(code,fresh,body);
    } else if(action==='myBoard'&&method==='GET')result=board.board(code,actor);
    else if(action==='mediaMentor'&&method==='GET')result=mentor.get(code);
    else if(action==='planVariantsDecision'&&method==='POST') {
      const body=await readJson(request),fresh=access(request,code,'content-plan.approve');
      if(fresh.userId!==actor.userId)fail(403,'Доступ изменился');
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['planRevision','briefRevision','scope','ideaId','decision','comment'].includes(k))||
        !['plan','idea'].includes(body.scope))fail(400,'Некорректная область согласования');
      result=mentor.decideVariants(code,body,{userId:fresh.userId,userName:fresh.userName});
    } else if(['tasks_list','task_get','task_update'].includes(action)&&method==='POST'||action==='taskRecords'&&method==='GET') {
      const body=method==='POST'?await readJson(request):{};
      const fresh=access(request,code,write?'tasks.self.edit':'tasks.self.view');
      if(fresh.userId!==actor.userId)fail(403,'Доступ изменился');
      const allowed=action==='tasks_list'?['project','limit','offset']:action==='task_get'?['task_id','subtasks_limit','subtasks_offset','comments_limit','comments_offset']:action==='task_update'?['task_id','status','revision']:[];
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))fail(400,'Переданы лишние параметры');
      if(action==='tasks_list'&&body.project!==code)fail(403,'Проект недоступен');
      const all=projectRows(code),map=new Map(all.map(row=>[row.id,row])),own=all.filter(row=>visible(row,map,fresh,code));
      if(action==='task_update') {
        taskCoordination.selfStatus(body.task_id,{status:body.status,revision:body.revision},fresh,code);
        result={task:view(db.prepare('SELECT * FROM tasks WHERE id=?').get(body.task_id))};
      }else if(action==='task_get') {
        if(!Number.isSafeInteger(body.task_id)||!visible(map.get(body.task_id),map,fresh,code))fail(404,'Задача не найдена');
        const row=map.get(body.task_id),subLimit=integer(body.subtasks_limit,20,100),subOffset=integer(body.subtasks_offset,0,1e9),commentLimit=integer(body.comments_limit,20,20),commentOffset=integer(body.comments_offset,0,1e9);
        if(!subLimit||!commentLimit)fail(400,'Лимит должен быть положительным');
        const children=own.filter(child=>child.parent_task_id===row.id);
        result={...view(row),subtasks:children.slice(subOffset,subOffset+subLimit).map(view),subtasks_pagination:{total:children.length,limit:subLimit,offset:subOffset},
          comments:db.prepare('SELECT id,task_id,author,text,created_at FROM task_comments WHERE task_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(row.id,commentLimit,commentOffset),
          comments_pagination:{total:db.prepare('SELECT count(*) n FROM task_comments WHERE task_id=?').get(row.id).n,limit:commentLimit,offset:commentOffset}};
      }else {
        const limit=action==='taskRecords'?200:integer(body.limit,100,100),offset=integer(action==='taskRecords'?url.searchParams.get('offset')??undefined:body.offset,0,1e9);
        if(!limit)fail(400,'Лимит должен быть положительным');
        const page=own.slice(offset,offset+limit);
        result={tasks:action==='taskRecords'?page.map(row=>({id:row.id,companyCode:row.company_code,description:row.description||''})):page.map(view),
          total:own.length,limit,offset,pagination:{total:own.length,limit,offset}};
      }
    }else fail(405,'Метод или адрес не поддерживается');
    send(response,200,result,{...cors,'cache-control':'private, no-store'});return true;
  };
}
module.exports={createPeopleHandler};
