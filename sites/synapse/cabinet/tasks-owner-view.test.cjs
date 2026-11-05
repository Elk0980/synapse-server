'use strict';
/* №148: «Задачи» для владельца — свои задачи и «Ждут вашего решения» первым экраном,
   тема кабинета без своей палитры, заголовок в «Мои задачи» открывает карточку. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

const question = {owner_question:'Разрешить следующий шаг?', if_yes:'Работа продолжится.', if_no:'Работу отложим.', owner_minutes:2};
const record = (id, extra = {}) => ({id, title:`Работа ${id}`, company_code:'synapse-business', description:'', status:'planned', assignee_name:'Codex', reviewer_name:'Claude', waiting_since:null,
  comments:[], comments_pagination:{total:0}, subtasks:[], subtasks_pagination:{total:0}, ...extra,
  coordination:{revision:1, blocker:'', nextAction:'', owner_question:'', if_yes:'', if_no:'', owner_minutes:null, links:[], milestones:{}, ...extra.coordination}});

function board(records) {
  const dom = new JSDOM('<main id="board"></main>', {url:'https://example.test/cabinet.html#tasks', runScripts:'outside-only'});
  const w = dom.window, d = w.document, map = new Map(records.map(task => [task.id, task]));
  const ctx = {identity:{role:'owner', userId:1, companies:[{id:'synapse-business', name:'Synapse'}]}, csrfOptions:(method, body) => ({method, body}), crmQuery:async (route, _query, options) => {
    const name = route.split('/').at(-1), args = options?.body || {};
    if (name === 'tasks_list') return {tasks:[...map.values()], pagination:{total:map.size}};
    if (name === 'products_list') return {products:[], pagination:{total:0}};
    if (name === 'agents_list') return {agents:[]};
    if (name === 'task_get') { const task = map.get(args.task_id); if (!task) throw Error('Не найдена'); return structuredClone(task); }
    throw Error('Unexpected ' + name);
  }};
  for (const file of ['task-text.js', 'task-overview.js', 'task-board.js']) w.eval(read(file));
  const controller = w.SbTaskBoard.mount(d.getElementById('board'), ctx, {view:'projects'});
  return {w, d, ctx, controller, close:() => { controller?.destroy(); w.close(); }};
}

test('№148·1: у владельца «Ждут вашего решения» и «Мои задачи» стоят первыми, с инструкцией и ссылками; цель и модули ниже', async () => {
  const records = [
    record(100, {title:'Цель · Понятная система'}),
    record(110, {title:'Модуль · Доска', parent_task_id:100, description:'ЦКП: видно всё\nСостав: №201, №202'}),
    record(201, {title:'Решить про макет', status:'in_progress', coordination:{blocker:'ждёт Влада: выбрать макет', ...question}}),
    record(202, {title:'Вход для Гули', status:'in_progress', assignee_name:'Влад', coordination:{blocker:'Открыть ЛК → Люди → Добавить. Займёт 2 минуты.', nextAction:'Сообщить Гуле логин', links:[{kind:'link', label:'Открыть ЛК', url:'https://example.test/people'}, {kind:'link', label:'Опасная', url:'javascript:alert(1)'}]}}),
    record(203, {title:'Закрытая', status:'done', assignee_name:'Влад'}),
    record(204, {title:'Чужая', status:'in_progress'})
  ];
  const f = board(records);
  try {
    await settle();
    const first = f.d.querySelector('.tb-board').firstElementChild;
    assert.ok(first.matches('.tb-overview'), 'обзор стоит до панели инструментов');
    const blocks = [...first.children];
    assert.equal(blocks[0].dataset.waiting, '', 'сначала «Ждут вашего решения»');
    assert.match(blocks[0].querySelector('h2').textContent, /Ждут вашего решения/);
    const mine = blocks[1];
    assert.equal(mine.dataset.myTasks, '', 'затем блок «Мои задачи»');
    assert.deepEqual([...mine.querySelectorAll('[data-my-task]')].map(row => row.dataset.myTask), ['202'], 'только открытые задачи Влада без оформленного вопроса');
    const row = mine.querySelector('[data-my-task="202"]');
    assert.equal(row.querySelector('[data-task-open]').dataset.taskOpen, '202', 'заголовок открывает карточку');
    assert.match(row.textContent, /Вход для Гули/);
    assert.equal(row.querySelector('[data-my-instructions]').open, true, 'инструкция видна сразу');
    assert.match(row.querySelector('[data-my-instructions]').textContent, /Открыть ЛК → Люди → Добавить. Займёт 2 минуты\./);
    assert.match(row.querySelector('[data-my-instructions]').textContent, /Следующий шаг[\s\S]*Сообщить Гуле логин/);
    assert.equal(row.querySelector('a[href="https://example.test/people"]').textContent.trim(), 'Открыть ЛК ↗');
    assert.equal(row.querySelector('a[href^="javascript:"]'), null, 'небезопасные ссылки не попадают на экран');
    assert.equal(mine.querySelector('a[href="#tasks/mine"]').hidden, false, 'ссылка на полный список своих задач');
    const order = [...f.d.querySelector('.tb-board').querySelectorAll('[data-waiting],[data-my-tasks],[data-goal],[data-modules]')].map(node => node.dataset.waiting !== undefined ? 'waiting' : node.dataset.myTasks !== undefined ? 'mine' : node.dataset.goal ? 'goal' : 'modules');
    assert.deepEqual(order, ['waiting', 'mine', 'goal', 'modules'], 'цель и модули ниже задач владельца');
    // На других видах доски («Доска», «План») задачи владельца тоже стоят первыми.
    await f.controller.render({view:'board'});
    assert.equal(f.d.querySelector('.tb-board').firstElementChild.dataset.waiting, '');
    assert.equal(f.d.querySelector('.tb-board').children[1].dataset.myTasks, '');
    // Кнопка заголовка открывает ту же карточку, что и общая доска.
    row.querySelector('[data-task-open]').click(); await settle();
    assert.match(f.d.querySelector('.tb-sheet .tb-task-title').textContent, /Вход для Гули/);
    assert.match(f.d.querySelector('.tb-sheet').textContent, /Открыть ЛК → Люди → Добавить/);
  } finally { f.close(); }
});

test('№148·2: доска без своей темы — нет переключателя и светлой палитры, только переменные кабинета', async () => {
  const f = board([record(1)]);
  try {
    await settle();
    assert.equal(f.d.querySelector('[data-board-theme]'), null, 'переключателя темы нет');
    assert.equal(f.d.getElementById('board').dataset.tbTheme, undefined, 'доска не помечает свою тему');
    assert.equal([...f.d.body.classList].filter(name => name.startsWith('tb-owner-theme')).length, 0, 'body без классов темы доски');
    f.w.localStorage.setItem('sb-task-board:1:theme', 'light');
    f.controller.destroy(); f.controller = f.w.SbTaskBoard.mount(f.d.getElementById('board'), f.ctx, {view:'board'}); await settle();
    assert.equal(f.w.localStorage.getItem('sb-task-board:1:theme'), null, 'прежняя настройка светлой темы не оживает');
    await f.controller.openTask(1);
    assert.equal(f.d.querySelector('.tb-sheet').dataset.tbTheme, undefined, 'карточка тоже без своей темы');
  } finally { f.close(); }
  const css = read('task-board.css') + read('task-board-shell.css');
  assert.doesNotMatch(css, /data-tb-theme|tb-owner-theme|prefers-color-scheme/, 'в CSS нет своей палитры доски');
  for (const variable of ['--bg', '--surface', '--surface-soft', '--text', '--muted', '--line', '--accent']) assert.match(css, new RegExp(`var\\(${variable}[,)]`), `${variable} берётся из кабинета`);
  const tokens = css.match(/\.tb-board,\.tb-sheet\{[^}]*\}/)[0];
  assert.doesNotMatch(tokens, /#fff\b|#f3f5f8|#dce1e8|#172033/, 'резервные цвета не светлые');
  const cabinet = read('workspace.css');
  for (const variable of ['--surface', '--text', '--line', '--accent']) assert.match(cabinet, new RegExp(`:root \\{[^}]*${variable}:`), `${variable} объявлена в теме кабинета`);
});

test('№148·3: в «Мои задачи» заголовок — кнопка: владельцу открывает карточку общей доски, сотруднику — #tasks/<id>', async () => {
  const dom = new JSDOM('<!doctype html><section id="tasks-view"><div class="content-header"><h1>Задачи</h1></div><div class="card"><div id="tasks-content"></div></div></section>', {runScripts:'outside-only', url:'https://cabinet.test/#tasks/mine'});
  const w = dom.window, d = w.document, opened = [], mounts = [], navigated = [];
  try {
    const board = {companyCode:'synapse-business', assigned:[{id:131, title:'Вход Гули', status:'in_progress', priority:'urgent', from:'system'}], hugh:[], deleted:[]};
    let role = 'owner';
    w.SbCabinet = {views:{tasks:{title:'Задачи', render() {}, onLeave() {}, updateSummary() {}}}};
    w.SynapseModules = {register(id, definition) { w.defs = {...(w.defs || {}), [id]:definition}; },
      mount(host, id, options) {
        const el = d.createElement('div'); host.replaceChildren(el);
        w.defs[id].mount(el, {user:{role}, route:{path:options.route.path, params:new w.URLSearchParams(options.route.query || '')}, api:{async get() { return board; }, async post() { return board; }}, navigate:target => navigated.push(target), openHughChat() {}});
        return {unmount() { el.remove(); }};
      }};
    w.SbTaskBoard = {mount(container, ctx, initial) { mounts.push({container, ctx, initial}); return {openTask:async id => { opened.push(id); }, destroy() { mounts.pop(); }}; }};
    w.eval(read('my-tasks.js'));
    const context = {identity:{role:'owner'}};
    w.SbCabinet.views.tasks.render(null, context); await settle();
    const title = d.querySelector('.sbt-item .sbt-item__title');
    assert.equal(title.tagName, 'BUTTON', 'заголовок — кнопка');
    assert.equal(title.dataset.taskOpen, '131');
    assert.match(title.getAttribute('aria-label'), /№131/);
    title.click(); await settle();
    assert.deepEqual(opened, [131], 'владельцу открывается карточка общей доски');
    assert.equal(mounts.length, 1, 'доска для карточки поднята один раз');
    assert.equal(mounts[0].ctx, context, 'карточка работает с контекстом кабинета');
    assert.equal(mounts[0].container.hidden, true, 'скрытый контейнер доски не виден в списке');
    assert.ok(d.getElementById('tasks-view').contains(mounts[0].container));
    title.click(); await settle();
    assert.deepEqual(opened, [131, 131]); assert.equal(mounts.length, 1, 'повторное нажатие не поднимает вторую доску');
    w.SbCabinet.views.tasks.onLeave();
    assert.equal(mounts.length, 0, 'уход с экрана убирает скрытую доску');
    assert.equal(d.querySelector('.sbt-card-host'), null);
    // Сотрудник: та же кнопка ведёт на прежнюю карточку #tasks/<id>.
    role = 'editor';
    w.SbCabinet.views.tasks.render(null, {identity:{role:'editor'}}); await settle();
    d.querySelector('.sbt-item .sbt-item__title').click();
    assert.deepEqual(navigated, ['tasks/131']);
    assert.equal(mounts.length, 0, 'сотруднику доска владельца не поднимается');
  } finally { w.close(); }
});
