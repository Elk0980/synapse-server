'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{createCompanyTeam}=require('./company-team'),{hashPassword}=require('./passwords');
const {createPeopleTasks}=require('./people-tasks');
function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const hash=hashPassword('synthetic-test-password-35');
  const auth=createAuthStore(db,`root:owner:${hash}`),team=createCompanyTeam(auth);
  const lena=team.create(1,{companyCode:'synapse-business',displayName:'Одинаковое имя',login:'lena',password:'synthetic-test-password-35',staffRole:'human_executor'});
  const other=team.create(1,{companyCode:'synapse-business',displayName:'Одинаковое имя',login:'other',password:'synthetic-test-password-35',staffRole:'human_executor'});
  const task=(id,extra={})=>({id,title:`Запись ${id}`,description:'ЦКП: Подготовленный результат',company_code:'synapse-business',assignee_name:`person:${lena.id}`,status:'in_progress',parent_task_id:null,subtask_count:0,subtask_done:0,coordination:{revision:1,milestones:{code:{state:'confirmed'}}},...extra});
  let all=[task(1),task(2,{assignee_name:`person:${other.id}`}),task(3,{assignee_name:'',parent_task_id:1}),task(4,{company_code:'alvi',parent_task_id:1}),task(5,{assignee_name:'Одинаковое имя'})];
  let hook=()=>{};const calls=[];
  const call=async(name,args)=>{
    calls.push({name,args});await hook(name,args);
    if(name==='taskRecords')return {tasks:all.map(t=>({id:t.id,companyCode:t.company_code,description:t.description})),pagination:{total:all.length}};
    if(name==='tasks_list')return {tasks:structuredClone(all.slice(args.offset,args.offset+args.limit)).map(({description,...summary})=>summary),total:all.length};
    const row=all.find(t=>t.id===args.task_id);
    if(name==='task_get')return {...structuredClone(row),comments:[{id:1,text:'Исторический комментарий'}],subtasks:structuredClone(all.filter(t=>t.parent_task_id===row.id))};
    assert.equal(args.revision,row.coordination.revision);row.status=args.status;row.coordination.revision++;return {task:structuredClone(row)};
  };
  return {db,auth,team,lena,other,tasks:createPeopleTasks({db,authStore:auth,call}),calls,setHook(fn){hook=fn;},setRows(rows){all=rows;},task};
}
test('старые/новые задачи: одинаковое имя не открывает чужую ветку; неназначенный потомок доступен только своей ветке',async t=>{
  const f=fixture(t),result=await f.tasks.list(f.lena.id,'synapse-business');
  assert.deepEqual(result.tasks.map(t=>t.id),[1,3]);assert.equal(result.total,2);
  assert.equal(result.tasks[0].purpose,'Подготовленный результат');
  await assert.rejects(f.tasks.get(f.lena.id,'synapse-business',2),{status:404});
  await assert.rejects(f.tasks.get(f.lena.id,'alvi',4),{status:403});
});
test('подзадачи другой компании и чужого исполнителя не выходят через detail',async t=>{
  const f=fixture(t);const {task}=await f.tasks.get(f.lena.id,'synapse-business',1);
  assert.deepEqual(task.subtasks.map(t=>t.id),[3]);assert.equal(task.comments[0].text,'Исторический комментарий');assert.equal(task.purpose,'Подготовленный результат');
});
test('человек меняет только напрямую назначенный статус с CAS; ни этапы, ни назначение не принимаются',async t=>{
  const f=fixture(t);assert.equal((await f.tasks.update(f.lena.id,'synapse-business',1,{status:'done',revision:1})).task.status,'done');
  await assert.rejects(f.tasks.update(f.lena.id,'synapse-business',1,{status:'planned',revision:1}),{status:409});
  await assert.rejects(f.tasks.update(f.lena.id,'synapse-business',3,{status:'done',revision:1}),{status:403});
  await assert.rejects(f.tasks.update(f.lena.id,'synapse-business',1,{status:'done',revision:2,executor:'person:1'}),{status:400});
});
test('отзыв прав в уже открытой сессии и во время async чтения закрывает ответ',async t=>{
  const f=fixture(t);f.setHook(name=>{if(name==='tasks_list')f.auth.updateAccess(1,f.lena.id,['synapse-business'],[]);});
  await assert.rejects(f.tasks.list(f.lena.id,'synapse-business'),{status:403});
});

test('выдача временного пароля во время чтения закрывает ответ и запись статуса',async t=>{
  for(const action of ['list','update']) {
    const f=fixture(t);let issued=false;
    f.setHook(name=>{if(!issued&&['taskRecords','task_get'].includes(name)){issued=true;f.auth.issueTemporary(1,f.lena.id);}});
    await assert.rejects(action==='list'?f.tasks.list(f.lena.id,'synapse-business'):f.tasks.update(f.lena.id,'synapse-business',1,{status:'done',revision:1}),{status:403});
    assert.equal(f.calls.some(c=>c.name==='task_update'),false);
  }
});

test('сброс и установка личного пароля не возобновляют старую мутацию',async t=>{
  const f=fixture(t);let changed=false;
  f.setHook(name=>{if(!changed&&name==='tasks_list'){changed=true;f.auth.issueTemporary(1,f.lena.id);
    f.auth.setOwnPassword(f.lena.id,f.auth.getById(f.lena.id).sessionVersion,'new-own-password');}});
  await assert.rejects(f.tasks.update(f.lena.id,'synapse-business',1,{status:'done',revision:1}),{status:401});
  assert.equal(f.calls.some(c=>c.name==='task_update'),false);
});
test('переназначение во время чтения не отдаёт прежнему исполнителю detail',async t=>{
  const f=fixture(t);f.setHook(name=>{if(name==='task_get')f.setRows([f.task(1,{assignee_name:`person:${f.other.id}`})]);});
  await assert.rejects(f.tasks.get(f.lena.id,'synapse-business',1),{status:404});
});
test('повреждённый цикл родителей не даёт доступ; прогресс совпадает с данными и стадиями',async t=>{
  const f=fixture(t);f.setRows([f.task(1,{subtask_count:8,subtask_done:3}),f.task(2),f.task(3,{assignee_name:'',parent_task_id:4}),f.task(4,{assignee_name:'',parent_task_id:3})]);
  const r=await f.tasks.list(f.lena.id,'synapse-business');assert.deepEqual(r.tasks.map(t=>[t.id,t.percent]),[[1,38],[2,25]]);
});
test('переназначение родительской ветки во время detail закрывает наследованный доступ',async t=>{
  const f=fixture(t);f.setHook(name=>{if(name==='task_get')f.setRows([f.task(1,{assignee_name:`person:${f.other.id}`}),f.task(3,{assignee_name:'',parent_task_id:1})]);});
  await assert.rejects(f.tasks.get(f.lena.id,'synapse-business',3),{status:404});
});
test('владелец явно переводит существующего редактора: данные/пароль не меняются, широкие права заменяются',t=>{
  const f=fixture(t),before=f.auth.getById(f.other.id);
  f.auth.updateAccess(1,f.other.id,['synapse-business','alvi','avokado'],['crm.edit','account.view']);
  f.team.assignHuman(1,f.other.id,'synapse-business');const after=f.auth.getById(f.other.id);
  assert.equal(after.passwordHash,before.passwordHash);assert.equal(after.login,before.login);
  assert.deepEqual(after.permissions,['tasks.self.edit','tasks.self.view']);assert.deepEqual(after.companyCodes,['synapse-business']);
  assert.throws(()=>f.team.assignHuman(f.lena.id,f.other.id,'synapse-business'),{status:403});
});
