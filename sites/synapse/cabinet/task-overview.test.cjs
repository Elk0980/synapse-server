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
test('module prefixes identify structure independently of goal presence and hide the storage prefix',()=>{
  const model=api.build([task(1000,{title:'Цель · Удалённая цель',status:'cancelled'}),task(1100,{title:'Модуль · Отдельный блок',parent_task_id:1000,status:'in_progress'}),task(1200,{title:'Модуль · Без цели',parent_task_id:9999,status:'in_progress'}),task(1300,{title:'Модуль · Снятый',status:'cancelled'}),task(1400,{parent_task_id:1100,status:'in_progress'})]);
  assert.equal(model.goals.length,0);assert.equal(model.modules.length,2);assert.deepEqual(Array.from(model.modules,item=>item.title),['Отдельный блок','Без цели']);assert.deepEqual(Array.from(model.now,item=>item.task.id),[1400]);assert.equal(model.structuralIds.includes(1100),true);assert.equal(model.structuralIds.includes(1200),true);assert.equal(api.title(task(1,{title:'Модуль · Название'})),'Название');
});
test('module contains all visible tasks once and traverses cancelled intermediate parents',()=>{
  const model=api.build([task(1000,{title:'Цель · Проверка'}),task(1100,{title:'Модуль · Полный состав',parent_task_id:1000,description:'Состав: №1400, №1400, №1500, №1900'}),task(1400,{parent_task_id:1100,status:'planned',coordination:stages(1)}),task(1450,{parent_task_id:1400,status:'done',coordination:stages(4)}),task(1500,{status:'cancelled',coordination:stages(4)}),task(1600,{parent_task_id:1500,status:'in_progress',coordination:stages(2)}),task(1900,{company_code:'foreign',coordination:stages(4)})]);
  assert.deepEqual(Array.from(model.modules[0].members,item=>item.id),[1400]);assert.equal(model.modules[0].progress,25);assert.deepEqual(Array.from(model.modules[0].allMembers,item=>item.id),[1400,1450,1600]);assert.equal(model.modules[0].current[0].id,1600);assert.equal(model.now[0].modules[0].task.id,1100);assert.equal(model.goals[0].progress,25);
});
test('explicit owner questions on goals and modules stay visible while cancelled questions do not',()=>{
  const goal=task(1000,{title:'Цель · Решение',assignee_name:'Влад'}),module=task(1100,{title:'Модуль · Вопрос',parent_task_id:1000,coordination:{blocker:'Ждёт Влада: принять модуль'}}),cancelled=task(1200,{title:'Модуль · Не показывать',status:'cancelled',assignee_name:'Влад'});
  const model=api.build([goal,module,cancelled]);assert.deepEqual(Array.from(model.waiting,item=>item.id),[1000,1100]);assert.equal(api.waitingNeed(goal),'Решение');assert.equal(api.waitingNeed(task(1,{title:'Модуль · Заголовок',assignee_name:'Влад'})),'Заголовок');
});
test('empty description fields never consume the next line or turn purpose text into composition',()=>{
  const emptyWhy=task(11,{title:'Модуль · Пустой результат',parent_task_id:10,description:'ЦКП:\nСостав: №20'}),emptyComposition=task(12,{title:'Модуль · Пустой состав',parent_task_id:10,description:'Состав:  \r\n\tЦКП:\tРезультат №20'});
  assert.equal(api.descriptionField(emptyWhy,'ЦКП'),'');assert.equal(api.descriptionField(emptyWhy,'Состав'),'№20');assert.equal(api.descriptionField(emptyComposition,'Состав'),'');assert.equal(api.descriptionField(emptyComposition,'ЦКП'),'Результат №20');
  const model=api.build([task(10,{title:'Цель · Поля'}),emptyWhy,emptyComposition,task(20,{coordination:stages(2)})]);assert.equal(model.modules[0].why,'');assert.equal(model.modules[0].members.length,1);assert.equal(model.modules[1].members.length,0);
});
