'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {validateSeed, importSeed} = require('./seed');

const seed = () => ({agents:[{agent:'Codex',kind:'codex',state:'unknown',last_event:'SAMPLE импорт'}],tasks:[
  {client_ref:'child',title:'Подзадача',project:'synapse-business',parent_ref:'parent'},
  {client_ref:'parent',title:'Основная задача',project:'synapse-business',executor:'Codex',reviewer:'Owner',status:'planned'},
  {client_ref:'idea',title:'Идея',project:'synapse-business',idea:true,status:'done'}
]});

test('seed полностью проверяется до записи, родитель перед ребёнком, идеи inbox', async () => {
  const checked = validateSeed(seed());
  assert.equal(checked.tasks[0].client_ref,'parent');
  assert.equal(checked.tasks.find(task => task.client_ref === 'idea').status,'inbox');
  for (const mutate of [
    input => { input.tasks[0].parent_ref = 'missing'; },
    input => { input.tasks[0].project = 'foreign'; },
    input => { input.tasks[1].reviewer = ' codex '; },
    input => { input.tasks[0].client_ref = 'parent'; },
    input => { input.tasks[0].links = [{url:'javascript:alert(1)',label:'x',kind:'link'}]; },
    input => { input.tasks[0].source = 'foreign'; }
  ]) {
    const bad = seed(); mutate(bad);
    let calls = 0;
    await assert.rejects(importSeed(bad,async () => { calls++; }));
    assert.equal(calls,0);
  }
});

test('повтор импорта сохраняет одну запись по client_ref и последующие правки статусов', async () => {
  const tasks = new Map(), agents = new Map();
  const call = async (name,args) => {
    if (name === 'task_create') {
      const existing = tasks.get(args.client_ref);
      if (existing) return {task:existing,created:false};
      const task = {status:'inbox',...args,id:tasks.size+1}; tasks.set(args.client_ref,task);
      return {task,created:true};
    }
    if (name === 'task_update') {
      const task = [...tasks.values()].find(task => task.id === args.task_id);
      Object.assign(task,args); return {task};
    }
    if (name === 'agents_list') return {agents:[...agents.values()]};
    if (name === 'agent_report') { agents.set(args.agent,{name:args.agent,...args}); return {agent:agents.get(args.agent)}; }
    throw new Error('unexpected');
  };
  assert.deepEqual(await importSeed(seed(),call),{created:3,existing:0,agents:1});
  const parent = tasks.get('parent');
  assert.equal(tasks.get('child').parent_id,parent.id);
  parent.status = 'done'; agents.get('Codex').state = 'work';
  assert.deepEqual(await importSeed(seed(),call),{created:0,existing:3,agents:0});
  assert.equal(parent.status,'done');
  assert.equal(agents.get('Codex').state,'work');
  assert.equal(tasks.get('idea').status,'inbox');
});

test('потерянный ответ атомарного создания не теряет начальный статус и ссылки при повторе', async () => {
  const input = {agents:[], tasks:[{client_ref:'partial',title:'Полная запись',project:'synapse-business',status:'planned',
    links:[{url:'https://example.test/evidence',label:'Основание',kind:'link'}]}]};
  let record, loseReply = true, writes = 0;
  const call = async (name,args) => {
    if (name === 'agents_list') return {agents:[]};
    assert.equal(name,'task_create'); // Отдельной записи task_update в импорте нет.
    if (record) return {task:record,created:false};
    record = {...args,id:1}; writes++;
    if (loseReply) { loseReply = false; throw new Error('SAMPLE: ответ потерян после COMMIT'); }
    return {task:record,created:true};
  };
  await assert.rejects(importSeed(input,call));
  assert.equal(record.status,'planned');
  assert.deepEqual(record.links,input.tasks[0].links);
  assert.deepEqual(await importSeed(input,call),{created:0,existing:1,agents:0});
  assert.equal(writes,1);
  assert.equal(record.status,'planned');
  assert.deepEqual(record.links,input.tasks[0].links);
});
