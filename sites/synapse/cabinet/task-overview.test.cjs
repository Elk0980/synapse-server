'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const context = {window:{}};vm.runInNewContext(fs.readFileSync(__dirname+'/task-overview.js','utf8'),context);
const api=context.window.SbTaskOverview;
const task=(id,extra={})=>({id,title:`Задача ${id}`,company_code:'sample',status:'planned',coordination:{milestones:{}},...extra});
const stages=n=>({milestones:Object.fromEntries(['code','connected','verified','accepted'].map((key,index)=>[key,{state:index<n?'confirmed':'pending'}]))});
test('waiting uses prefixes rather than a mention and does not infer a date',()=>{
  for(const value of ['ждёт Влада: решение','  ЖДЕТ ВЛАДА — решение','ВОПРОС → Влад: да или нет']) assert.equal(api.isWaiting(task(1,{coordination:{blocker:value}})),true);
  assert.equal(api.isWaiting(task(1,{coordination:{nextAction:'ВОПРОС → Влад: ответ'}})),true);
  assert.equal(api.isWaiting(task(1,{assignee_name:'Влад'})),true);assert.equal(api.isWaiting(task(1,{assignee_name:'  вЛаД  '})),true);
  assert.equal(api.isWaiting(task(1,{assignee_name:'Владимир',coordination:{blocker:'Клиент ждёт Влада'}})),false);
  assert.equal(api.waitingNeed(task(1,{coordination:{blocker:'ждёт Влада: принять макет'}})),'принять макет');
  assert.equal(api.build([task(1,{assignee_name:'Влад'})]).waiting[0].waiting_since,undefined);
});
test('progress comes only from confirmed milestones, including unknown and done tasks',()=>{
  assert.equal(api.progress(task(1,{status:'done'})),0);assert.equal(api.progress(task(1,{coordination:stages(2)})),50);
  assert.equal(api.progress(task(1,{coordination:{milestones:{code:{state:'not_required'},accepted:{state:'confirmed'}}}})),25);
  assert.equal(api.stageText(task(1,{coordination:stages(1)})),'подключение');
});
test('goal directions combine same-project children and references once, without reparenting',()=>{
  const input=[task(100,{title:'Цель · Сделать полезное'}),task(110,{parent_task_id:100,title:'Направление · Первый путь',description:'ЦКП: Рабочий результат\nСостав: №120, №120, №130, №999, №140'}),task(115,{parent_task_id:100,title:'Обычная прежняя задача'}),task(120,{parent_task_id:110,status:'in_progress',coordination:stages(2)}),task(130,{coordination:stages(1)}),task(140,{company_code:'foreign',coordination:stages(4)})];
  const before=JSON.stringify(input),model=api.build(input);assert.equal(model.directions.length,1);assert.equal(model.directions[0].why,'Рабочий результат');assert.deepEqual(Array.from(model.directions[0].members,item=>item.id),[120,130]);assert.equal(model.directions[0].progress,38);assert.equal(model.goals[0].progress,38);assert.equal(JSON.stringify(input),before);assert.equal(model.now[0].directions[0].title,'Первый путь');
});
test('shared references contribute once to goal average and cycles remain finite',()=>{
  const model=api.build([task(10,{title:'Цель · Общая'}),task(11,{parent_task_id:10,description:'ЦКП: A\nСостав: №20, №30, №10'}),task(12,{parent_task_id:10,description:'Состав: №20'}),task(20,{coordination:stages(4)}),task(30,{parent_task_id:31}),task(31,{parent_task_id:30})]);
  assert.equal(model.goals[0].members.length,2);assert.equal(model.goals[0].progress,50);assert.equal(model.directions[0].members.length,2);assert.equal(model.directions[0].allMembers.length,3);
});
test('explicit parent composition keeps its own progress and direction membership with nested children',()=>{
  const model=api.build([task(10,{title:'Цель · Вложенность'}),task(11,{parent_task_id:10,description:'ЦКП: Результат'}),task(20,{parent_task_id:11,status:'in_progress',coordination:stages(1)}),task(21,{parent_task_id:20,status:'planned',coordination:stages(4)})]);
  assert.equal(model.directions[0].progress,25);assert.equal(model.goals[0].progress,25);assert.equal(model.directions[0].members.length,1);assert.equal(model.directions[0].members[0].id,20);assert.equal(model.directions[0].started,true);assert.equal(model.now[0].directions.length,1);assert.equal(model.directions[0].current[0].id,20);
});
test('nested active descendants inherit membership without being added to the explicit progress denominator',()=>{
  const model=api.build([task(10,{title:'Цель · Потомки'}),task(11,{parent_task_id:10,description:'Состав: №20'}),task(20,{coordination:stages(2)}),task(21,{parent_task_id:20,status:'in_progress',coordination:stages(4)})]);
  assert.equal(model.directions[0].progress,50);assert.equal(model.goals[0].progress,50);assert.equal(model.directions[0].current[0].id,21);assert.equal(model.now[0].directions[0].task.id,11);
});
