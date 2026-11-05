'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const context = {window:{}};vm.runInNewContext(fs.readFileSync(__dirname+'/task-overview.js','utf8'),context);
const api=context.window.SbTaskOverview;
const questionFields={owner_question:'Разрешить следующий шаг?',if_yes:'Работа продолжится.',if_no:'Работу отложим.',owner_minutes:2};
const task=(id,extra={})=>({id,title:`Задача ${id}`,company_code:'sample',status:'planned',coordination:{milestones:{}},...extra,coordination:{milestones:{},...questionFields,...extra.coordination}});
const stages=n=>({milestones:Object.fromEntries(['code','connected','verified','accepted'].map((key,index)=>[key,{state:index<n?'confirmed':'pending'}]))});
test('waiting uses prefixes rather than a mention and does not infer a date',()=>{
  for(const value of ['ждёт Влада: решение','  ЖДЕТ ВЛАДА — решение','ВОПРОС → Влад: да или нет']) assert.equal(api.isWaiting(task(1,{coordination:{blocker:value}})),true);
  assert.equal(api.isWaiting(task(1,{coordination:{nextAction:'ВОПРОС → Влад: ответ'}})),true);
  assert.equal(api.isWaiting(task(1,{assignee_name:'Влад'})),true);assert.equal(api.isWaiting(task(1,{assignee_name:'  вЛаД  '})),true);
  assert.equal(api.isWaiting(task(1,{assignee_name:'Владимир',coordination:{blocker:'Клиент ждёт Влада'}})),false);
  assert.equal(api.waitingNeed(task(1,{coordination:{blocker:'ждёт Влада: принять макет'}})),'принять макет');
  assert.equal(api.build([task(1,{assignee_name:'Влад'})]).waiting[0].waiting_since,undefined);
});
test('done is complete while other tasks derive progress only from confirmed milestones',()=>{
  assert.equal(api.progress(task(1,{status:'done'})),100);assert.equal(api.progress(task(1,{coordination:stages(2)})),50);
  assert.equal(api.progress(task(1,{coordination:{milestones:{code:{state:'not_required'},accepted:{state:'confirmed'}}}})),25);
  assert.equal(api.stageText(task(1,{coordination:stages(1)})),'подключение');
});
test('goal directions combine same-project children and references once, without reparenting',()=>{
  const input=[task(100,{title:'Цель · Сделать полезное'}),task(110,{parent_task_id:100,title:'Направление · Первый путь',description:'ЦКП: Рабочий результат\nСостав: №120, №120, №130, №999, №140'}),task(115,{parent_task_id:100,title:'Обычная прежняя задача'}),task(120,{parent_task_id:110,status:'in_progress',coordination:stages(2)}),task(130,{coordination:stages(1)}),task(140,{company_code:'foreign',coordination:stages(4)})];
  const before=JSON.stringify(input),model=api.build(input);assert.equal(model.directions.length,1);assert.equal(model.directions[0].why,'Рабочий результат');assert.deepEqual(Array.from(model.directions[0].members,item=>item.id),[120,130]);assert.equal(model.directions[0].progress,38);assert.equal(model.goals[0].progress,38);assert.equal(JSON.stringify(input),before);assert.equal(model.now[0].directions[0].title,'Первый путь');
});
test('shared references contribute once per module and cycles remain finite',()=>{
  const model=api.build([task(10,{title:'Цель · Общая'}),task(11,{parent_task_id:10,description:'ЦКП: A\nСостав: №20, №30, №10'}),task(12,{parent_task_id:10,description:'Состав: №20'}),task(20,{coordination:stages(4)}),task(30,{parent_task_id:31}),task(31,{parent_task_id:30})]);
  assert.equal(model.goals[0].members.length,2);assert.equal(model.goals[0].progress,75);assert.equal(model.directions[0].members.length,2);assert.equal(model.directions[0].allMembers.length,3);
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

test('goal weights modules equally despite unequal task counts and includes empty modules at zero',()=>{
  const input=[task(1000,{title:'Цель · Результат'}),task(1100,{title:'Модуль · Первый',parent_task_id:1000}),task(1200,{title:'Модуль · Второй',parent_task_id:1000}),task(2000,{parent_task_id:1100,status:'done'}),task(2100,{parent_task_id:1200}),task(2200,{parent_task_id:1200}),task(2300,{parent_task_id:1200})];
  const model=api.build(input);assert.deepEqual(Array.from(model.modules,item=>item.progress),[100,0]);assert.equal(model.goals[0].progress,50);
  const empty=task(1300,{title:'Модуль · Пустой',parent_task_id:1000});assert.equal(api.build([...input,empty]).goals[0].progress,33);
  assert.equal(api.build([...input,{...empty,status:'cancelled'}]).goals[0].progress,50);assert.equal(api.build([input[0]]).goals[0].progress,0);
});

test('legacy done progress does not alter stage evidence or claim owner acceptance',()=>{
  const item=task(2000,{status:'done',coordination:{milestones:{code:{state:'confirmed',evidence:'проверка',checkedAt:'2026-01-01T00:00:00Z'},connected:{state:'not_required'},verified:{state:'pending'},accepted:{state:'pending'}}}});
  const before=JSON.stringify(item);assert.equal(api.progress(item),100);assert.equal(api.stageText(item),'готово');assert.equal(JSON.stringify(item),before);assert.equal(item.coordination.milestones.accepted.state,'pending');
});

test('standalone module lines add same-project membership without duplicates or reparenting',()=>{
  const input=[task(1000,{title:'Цель · Связи'}),task(1100,{title:'Модуль · Первый',parent_task_id:1000,description:'Состав: №2000'}),task(1200,{title:'Модуль · Второй',parent_task_id:1000}),task(1300,{title:'Модуль · Снятый',status:'cancelled'}),task(2000,{parent_task_id:1100,description:'Модуль №1100\nМодуль №1100\nМодуль №1200',status:'in_progress',coordination:stages(2)}),task(2100,{description:'Пояснение\r\n\tмодуль № 1100\t\r\nДальше',status:'done'}),task(2200,{description:'Модуль №1100',company_code:'foreign'}),task(2300,{description:'Упомянуть Модуль №1100'}),task(2400,{description:'Модуль №9999'}),task(2500,{description:'Модуль №1300',status:'in_progress'}),task(2600,{description:'Модуль №1100',status:'cancelled'}),task(2700,{parent_task_id:2600,status:'in_progress'})];
  const before=JSON.stringify(input),model=api.build(input);assert.deepEqual(Array.from(model.modules[0].members,item=>item.id),[2000,2100]);assert.deepEqual(Array.from(model.modules[0].allMembers,item=>item.id),[2000,2100,2700]);assert.deepEqual(Array.from(model.modules[1].members,item=>item.id),[2000]);assert.equal(model.modules[0].progress,75);assert.equal(model.goals[0].progress,63);assert.equal(model.now.find(item=>item.task.id===2000).modules.length,2);assert.equal(model.now.find(item=>item.task.id===2700).modules[0].task.id,1100);assert.equal(model.now.find(item=>item.task.id===2500).modules.length,0);assert.equal(JSON.stringify(input),before);
});

test('waiting prefix removal preserves the next action body and ignores ordinary mentions',()=>{
  for(const value of ['Ждёт Влада: Принять вариант','  ВОПРОС → Влад — Принять вариант','ЖДЕТ ВЛАДА Принять вариант']) assert.equal(api.stripWaitingPrefix(value),'Принять вариант');
  assert.equal(api.stripWaitingPrefix('ВОПРОС → Влад: Первая строка\n  Вторая строка  '),'Первая строка\n  Вторая строка  ');assert.equal(api.stripWaitingPrefix('Ждёт Влада'),'');
  for(const value of ['ВОПРОС → Владимир: другое','Действие ждёт Влада','  Обычный шаг  ']) assert.equal(api.stripWaitingPrefix(value),value);
  assert.equal(api.hasWaitingNextStep(task(1,{coordination:{nextAction:'ВОПРОС → Влад: действие'}})),true);assert.equal(api.hasWaitingNextStep(task(1,{coordination:{nextAction:'Обычный шаг'}})),false);
});

test('waiting today excludes completed, cancelled, future and next-step-only tasks in Bangkok',()=>{
 const now=Date.parse('2026-11-05T00:00:00Z');
 const base=task(1,{assignee_name:'Влад',due_date:'2026-11-05'});assert.equal(api.actionableWaiting(base,now),true);
 for(const status of ['done','cancelled'])assert.equal(api.actionableWaiting({...base,status},now),false);
 assert.equal(api.actionableWaiting({...base,due_date:'2026-11-06'},now),false);assert.equal(api.actionableWaiting({...base,due_date:''},now),true);
 assert.equal(api.actionableWaiting(task(2,{coordination:{nextAction:'ждёт Влада: потом'}}),now),false);
 assert.equal(api.actionableWaiting(task(2,{coordination:{blocker:'ждёт Влада: сейчас'}}),now),true);
});
test('owner decision needs four plain fields and accepts product names without exposing technical details',()=>{
  const ready=task(900,{assignee_name:'Влад'});assert.equal(api.build([ready]).waiting.length,1);
  for(const key of ['owner_question','if_yes','if_no','owner_minutes']) {const old=task(900,{assignee_name:'Влад',coordination:{[key]:key==='owner_minutes'?null:''}}),model=api.build([old]);assert.equal(model.waiting.length,0);assert.equal(model.unprepared.length,1);}
  for(const value of ['Согласовать 3517116?','🙂','12345','αβγ','Начать αβγ','Résumé prêt','PR 123','CI пройден','head abcdef1234567890','Путь /opt/private','Первая строка\nВторая']) assert.equal(api.decision(task(900,{coordination:{if_yes:value}})),null);
  const product=task(900,{coordination:{owner_question:'Продолжить работу в Synapse?'}});assert.equal(api.decision(product),null);assert.equal(api.decision(product,['Synapse']).question,'Продолжить работу в Synapse?');
  assert.equal(api.decision(task(900,{coordination:{owner_question:'Выбрать вариант 123?'}})).question,'Выбрать вариант 123?');assert.equal(api.decision(task(900,{coordination:{owner_minutes:0}})).minutes,0);assert.equal(api.decision(task(900,{coordination:{owner_minutes:'2'}})),null);assert.equal(api.decision(task(900,{coordination:{owner_question:'я'.repeat(121)}})),null);
});
