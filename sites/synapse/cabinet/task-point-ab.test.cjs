'use strict';
// specs/101-task-point-a-b: блок «Было | Будет», шаги приёмки и «N из M шагов». Данные — SAMPLE.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const board = fs.readFileSync(__dirname + '/task-board.js','utf8');
const overview = fs.readFileSync(__dirname + '/task-overview.js','utf8');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const plain = value => JSON.parse(JSON.stringify(value));
const milestones = n => Object.fromEntries(['code','connected','verified','accepted'].map((key,i) => [key,{state:i < n ? 'confirmed' : 'pending'}]));

function fixture(taskPatch = {}) {
  const dom = new JSDOM('<main id="board"></main>',{url:'https://example.test/cabinet.html#tasks',runScripts:'outside-only'});
  const w = dom.window, d = w.document, calls = [];
  const task = {id:5,title:'SAMPLE <b>задача</b>',description:'',company_code:'synapse-business',assignee_name:'Claude',reviewer_name:'Влад',
    status:'in_progress',coordination:{revision:4,milestones:milestones(2)},acceptance_steps:{total:2,closed:1},progress:50,
    point_ab:{source:'card',pointA:'Было <img src=x onerror=alert(1)>',pointB:'Будет',example:'SAMPLE пример',
      pointAImage:'https://example.test/a.png',pointBImage:'javascript:alert(1)',
      steps:[{id:'s1',text:'<script>bad()</script> шаг',state:'closed',evidence:'https://example.test/proof',evidenceKind:'link',closedBy:'Codex',closedAt:'2026-11-04T00:00:00Z'},
        {id:'s2',text:'второй шаг',state:'open',evidence:''}]},comments:[],subtasks:[],...taskPatch};
  const module = {id:4,title:'Модуль · SAMPLE',description:'Состав: №5',company_code:'synapse-business',status:'in_progress',coordination:{revision:1,milestones:{}}};
  const ctx = {identity:{role:'owner',userId:1,companies:[{id:'synapse-business',name:'Synapse'}]},csrfOptions:(method,body) => ({method,body}),
    crmQuery:async (path,query,options) => {
      const name = path.split('/').at(-1), args = options?.body || {}; calls.push({name,args});
      if (name === 'tasks_list') return {tasks:[{...task,point_ab:undefined},module],pagination:{total:2}};
      if (name === 'products_list') return {products:[],pagination:{total:0}};
      if (name === 'agents_list') return {agents:[]};
      if (name === 'task_get') return structuredClone(args.task_id === 4 ? module : task);
      if (['task_step_close','task_step_reopen','task_point_ab','task_update'].includes(name)) return {task};
      throw Error('Unexpected ' + name);
    }};
  w.eval(overview); w.eval(board);
  const controller = w.SbTaskBoard.mount(d.getElementById('board'),ctx,{view:'projects'});
  return {w,d,calls,controller,close:() => { controller?.destroy(); w.close(); }};
}

test('overview helper: progress formula with steps and module «N из M шагов»', () => {
  const dom = new JSDOM('',{runScripts:'outside-only'}); dom.window.eval(overview);
  const api = dom.window.SbTaskOverview;
  assert.equal(api.progress({status:'planned',coordination:{milestones:milestones(2)}}), 50);
  assert.equal(api.progress({status:'planned',coordination:{milestones:milestones(2)},acceptance_steps:{total:4,closed:1}}), 38);
  assert.equal(api.progress({status:'done',acceptance_steps:{total:4,closed:0}}), 100);
  assert.equal(api.stepsText({acceptance_steps:{total:3,closed:2}}), '2 из 3 шагов');
  assert.equal(api.stepsText({}), '');
  dom.window.close();
});

test('module card shows «N из M шагов»; task card renders «Было | Будет» with escaped text and https-only images', async () => {
  const f = fixture();
  try {
    await settle();
    assert.equal(f.d.querySelector('[data-module-steps]')?.textContent, '1 из 2 шагов');
    assert.match(f.d.querySelector('.tb-module-task-steps').textContent, /1 из 2 шагов/);
    assert.match(f.d.querySelector('.tb-module-task-progress').textContent, /50%/);
    await f.controller.openTask(5);
    const section = f.d.querySelector('[data-point-ab]');
    assert.ok(section);
    assert.equal(section.querySelector('h3').textContent, 'Точка А → Точка Б');
    assert.equal(section.querySelectorAll('.tb-ab-col').length, 2);
    assert.equal(f.d.querySelector('script'), null);
    assert.equal(section.querySelector('img[onerror]'), null);
    assert.match(section.querySelector('[data-ab-side=a] p').textContent, /<img src=x/);
    assert.deepEqual([...section.querySelectorAll('img')].map(img => img.getAttribute('src')), ['https://example.test/a.png']);
    assert.equal(section.querySelector('a[href^="javascript:"]'), null);
    assert.equal(section.querySelector('[data-steps-count]').textContent, '1 из 2');
    assert.equal(section.querySelector('[data-step=s1]').dataset.state, 'closed');
    assert.match(section.querySelector('[data-step=s1]').textContent, /<script>bad\(\)<\/script> шаг/);
    assert.ok(section.querySelector('[data-step=s1] a[href="https://example.test/proof"]'));
  } finally { f.close(); }
});

test('closing a step requires https evidence and sends revision; reopen and edit keep step ids', async () => {
  const f = fixture();
  try {
    await settle(); await f.controller.openTask(5);
    const form = f.d.querySelector('[data-step-close=s2]');
    form.elements.evidence.value = 'http://example.test/plain';
    form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true})); await settle();
    assert.equal(f.calls.some(call => call.name === 'task_step_close'), false);
    assert.match(f.d.querySelector('[data-step-result]').textContent, /https/);
    form.elements.evidence.value = 'https://example.test/ok';
    form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true})); await settle();
    assert.deepEqual(plain(f.calls.find(call => call.name === 'task_step_close').args),
      {task_id:5,revision:4,step_id:'s2',evidence:'https://example.test/ok',kind:'link'});
    await f.controller.openTask(5);
    f.d.querySelector('[data-step-reopen=s1]').click(); await settle();
    assert.deepEqual(plain(f.calls.find(call => call.name === 'task_step_reopen').args), {task_id:5,revision:4,step_id:'s1'});
    await f.controller.openTask(5);
    const edit = f.d.querySelector('[data-ab-form]');
    edit.elements.steps.value = '<script>bad()</script> шаг\nновый шаг';
    edit.elements.pointBImage.value = 'http://example.test/b.png';
    edit.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true})); await settle();
    assert.equal(f.calls.some(call => call.name === 'task_point_ab'), false, 'не-https картинка не отправляется');
    edit.elements.pointBImage.value = 'https://example.test/b.png';
    edit.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true})); await settle();
    const saved = f.calls.find(call => call.name === 'task_point_ab').args;
    assert.deepEqual(plain(saved.point_ab.steps), [{id:'s1',text:'<script>bad()</script> шаг'},{text:'новый шаг'}]);
    assert.equal(saved.point_ab.pointBImage, 'https://example.test/b.png');
  } finally { f.close(); }
});

test('done task shows «Было → Стало»; description-parsed block asks to save before closing', async () => {
  const done = fixture({status:'done',acceptance_steps:{total:2,closed:2}});
  try {
    await settle(); await done.controller.openTask(5);
    assert.equal(done.d.querySelector('[data-point-ab] h3').textContent, 'Было → Стало');
    assert.match(done.d.querySelector('[data-ab-side=b] figcaption').textContent, /Стало/);
  } finally { done.close(); }
  const legacy = fixture({point_ab:{source:'description',pointA:'А',pointB:'Б',example:'',pointAImage:'',pointBImage:'',steps:[{id:'d1',text:'шаг',state:'open'}]}});
  try {
    await settle(); await legacy.controller.openTask(5);
    assert.match(legacy.d.querySelector('[data-point-ab]').textContent, /Разобрано из описания/);
    const form = legacy.d.querySelector('[data-step-close=d1]');
    form.elements.evidence.value = 'https://example.test/ok';
    form.dispatchEvent(new legacy.w.Event('submit',{bubbles:true,cancelable:true})); await settle();
    assert.equal(legacy.calls.some(call => call.name === 'task_step_close'), false);
  } finally { legacy.close(); }
});
