'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const settle = async () => {
  for (let count = 0; count < 12; count++) await new Promise(resolve => setImmediate(resolve));
};
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
}[char]));

function fixture(t, {route = 'tasks', role = 'owner'} = {}) {
  const dom = new JSDOM(`<div id="tasks-content"></div><span id="tasks-badge"></span>
    <dialog id="task-create-dialog"><button data-task-create-close>Закрыть</button>
    <form id="task-create-form"><input name="title"><textarea name="description"></textarea>
    <select name="companyCode" data-task-company></select><select name="assigneeRole" data-task-role></select>
    <input name="assigneeName"><select name="priority" data-task-priority></select><input name="dueDate" type="date">
    <select name="status" data-task-status></select><button type="submit">Создать</button><p role="alert" hidden></p></form></dialog>`, {
    url:`https://example.test/#${route}`, runScripts:'outside-only'
  });
  const w = dom.window, d = w.document, calls = [], navigations = [], projectChanges = [];
  t.after(() => w.close());
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const RealDate = w.Date;
  w.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-02T18:00:00Z'])); }
    static now() { return RealDate.parse('2026-11-02T18:00:00Z'); }
  };
  const task = {
    id:7, title:'Общая задача', description:'Описание', company_code:'synapse', status:'in_progress',
    assignee_name:'Codex', reviewer_name:'Claude', parent_task_id:null, source:'gpt', due_date:'2026-11-03',
    subtask_count:2, subtask_done:1, no_report:true,
    coordination:{revision:3,executorName:'Codex',blocker:'',nextAction:'Проверить',links:[
      {url:'https://example.test/photo.png',label:'Фото <проверка>',kind:'image'},
      {url:'https://example.test/movie.mp4',label:'Видео',kind:'video'},
      {url:'javascript:alert(1)',label:'Опасная ссылка',kind:'image'}
    ],milestones:Object.fromEntries(['code','connected','verified','accepted'].map(key => [key,{state:'pending',evidence:'',checkedAt:''}]))},
    subtasks:[{id:8,title:'Подзадача',status:'done'}],
    comments:[{id:1,author:'Claude',text:'Комментарий <img src=x onerror=alert(1)>',created_at:'2026-11-02T15:00:00Z'}]
  };
  const records = [
    {...task,taskId:7,companyCode:'synapse',taskStatus:task.status,assigneeName:'Codex',...task.coordination,updatedAt:'2026-11-02T15:00:00Z'},
    {...task,taskId:9,title:'Завтра',due_date:'2026-11-04',companyCode:'synapse',taskStatus:'planned',...task.coordination}
  ];
  let failUpdate = false, failComment = false, failCreate = false;
  const ctx = {
    identity:{role,userId:1,userName:'Влад',companies:[{id:'synapse',name:'Synapse'},{id:'alpha',name:'Альфа'}]},
    currentView:'tasks',selectedProjectId:'synapse',byId:id => d.getElementById(id),escapeHTML,
    scopeParams:() => ({companyCode:ctx.selectedProjectId}),hasPermission:() => true,
    csrfOptions:(method,body) => ({method,body}),chooseProject:value => {
      projectChanges.push(value);
      ctx.selectedProjectId = value;
      w.localStorage.setItem('selected-project', value);
    },navigate:value => navigations.push(value),
    crmQuery:async (url, params, options) => {
      calls.push({url,params,options:options ? structuredClone(options) : undefined});
      if (url === '/tasks/summary') return {inbox:1};
      if (url === '/tasks') return {tasks:[],pagination:{total:0}};
      if (url === '/coordination/tasks') return {tasks:records,pagination:{total:records.length}};
      if (url === '/coordination/tasks/7') return {reviewer_name:task.reviewer_name,...task.coordination};
      if (url === '/tasks/7') return {id:7,title:task.title,companyCode:'synapse',assigneeName:task.assignee_name,
        assigneeRole:'synapse',source:task.source,status:task.status,priority:'normal',dueDate:task.due_date};
      if (url === '/coordination/dispatch/7') return {state:'manual',history:[]};
      if (url === '/coordination/mcp/task_get') {
        const args = options.body;
        const comments = [...task.comments].sort((a,b) => b.id-a.id);
        const subtasks = [...task.subtasks].sort((a,b) => a.id-b.id);
        const commentsOffset = args.comments_offset || 0, commentsLimit = args.comments_limit || 20;
        const subtasksOffset = args.subtasks_offset || 0, subtasksLimit = args.subtasks_limit || 20;
        return structuredClone({...task,
          comments:comments.slice(commentsOffset,commentsOffset+commentsLimit),
          subtasks:subtasks.slice(subtasksOffset,subtasksOffset+subtasksLimit),
          comments_pagination:{total:comments.length,offset:commentsOffset,limit:commentsLimit},
          subtasks_pagination:{total:subtasks.length,offset:subtasksOffset,limit:subtasksLimit}});
      }
      if (url === '/coordination/mcp/agents_list') return {agents:[{id:1,name:'Синапс <img>',kind:'claude',mode:'event',
        state:'work',function:'Проверка',chat:'Синапс Рабочая',last_event:'подключился',last_event_at:'2026-11-02T14:00:00Z',
        tracking:'manual',no_report:true,active_tasks:[task]}]};
      if (url === '/coordination/mcp/task_update') {
        if (failUpdate) throw new Error('Карточка изменена другим исполнителем');
        const args = options.body;
        task.status = args.status;
        task.assignee_name = args.executor;
        task.reviewer_name = args.reviewer;
        task.due_date = args.due_date;
        task.coordination.revision++;
        task.coordination.links = args.links;
        if (args.stage) task.coordination.milestones[args.stage] = {state:'confirmed',evidence:args.evidence,checkedAt:args.checked_at};
        return {task:structuredClone(task)};
      }
      if (url === '/coordination/mcp/task_comment') {
        if (failComment) throw new Error('Связь прервалась. Результат неизвестен');
        task.comments.push({...options.body,id:Math.max(0,...task.comments.map(comment => comment.id || 0))+1,created_at:'2026-11-02T18:00:00Z'});
        return {comment:task.comments.at(-1)};
      }
      if (url === '/coordination/mcp/task_create') {
        if (failCreate) throw new Error('Результат отправки неизвестен');
        return {task:{id:10},created:true};
      }
      throw new Error('Unexpected route ' + url);
    }
  };
  w.SbCabinet = {registerView:(_,view) => { w.taskView = view; }};
  w.eval(fs.readFileSync(path.resolve(__dirname, '../../sites/synapse/cabinet/tasks.js'), 'utf8'));
  w.taskView.render(d.getElementById('tasks-content'), ctx);
  return {w,d,ctx,calls,task,records,navigations,projectChanges,failUpdate:value => {failUpdate=value;},
    failComment:value => {failComment=value;},failCreate:value => {failCreate=value;}};
}

test('existing owner board adds review, progress and safe media; day plan uses Bangkok and survives refresh', async t => {
  const f = fixture(t);
  await settle();
  assert.match(f.d.body.textContent, /Проверяющий: Claude/);
  assert.match(f.d.body.textContent, /Подзадачи: 1\/2/);
  assert.match(f.d.body.textContent, /Нет отчёта больше 60 минут/);
  assert.match(f.d.body.textContent, /GPT/);
  assert.equal(f.d.querySelectorAll('video[preload=none]').length, 2);
  assert.equal(f.d.querySelector('[src^="javascript:"]'), null);
  assert.equal(f.d.querySelector('проверка'), null);
  f.d.querySelector('[data-owner-task-tab=today]').click();
  await settle();
  assert.match(f.d.body.textContent, /2026-11-03 включительно · Asia\/Bangkok/);
  assert.match(f.d.body.textContent, /Общая задача/);
  assert.doesNotMatch(f.d.body.textContent, /Завтра/);
  assert.equal(f.w.location.hash, '#tasks/today');
  f.w.taskView.render(f.d.getElementById('tasks-content'), f.ctx);
  await settle();
  assert.equal(f.d.querySelector('[data-owner-task-tab=today]').getAttribute('aria-pressed'), 'true');
});

test('agents tab displays self-reported state and active tasks without execution requests', async t => {
  const f = fixture(t, {route:'tasks/agents'});
  await settle();
  assert.match(f.d.body.textContent, /Синапс <img>/);
  assert.match(f.d.body.textContent, /Состояние сообщают сами агенты/);
  assert.match(f.d.body.textContent, /Общая задача/);
  assert.match(f.d.body.textContent, /Нет отчёта больше 60 минут/);
  assert.equal(f.d.querySelector('img'), null);
  assert.ok(!f.calls.some(call => /enqueue|agent_report/.test(call.url)));
});

test('agent and parent links switch company before opening and retain its scope after refresh', async t => {
  const f = fixture(t, {route:'tasks/agents'});
  f.task.company_code = 'alpha';
  await settle();
  const activeLink = f.d.querySelector('[data-owner-task-open="7"]');
  assert.equal(activeLink.dataset.taskProject, 'alpha');
  activeLink.click();
  assert.deepEqual(f.projectChanges, ['alpha']);
  assert.equal(f.navigations.at(-1), 'tasks/7');
  assert.equal(f.w.localStorage.getItem('selected-project'), 'alpha');
  f.w.location.hash = '#tasks/7';
  f.ctx.selectedProjectId = f.w.localStorage.getItem('selected-project');
  f.w.taskView.render(f.d.getElementById('tasks-content'), f.ctx);
  await settle();
  assert.equal(f.calls.find(call => call.url === '/tasks/7').params.companyCode, 'alpha');
  f.records[0].parent_task_id = 7;
  f.records[0].companyCode = 'alpha';
  f.ctx.selectedProjectId = 'synapse';
  f.w.location.hash = '#tasks/board';
  f.w.taskView.render(f.d.getElementById('tasks-content'), f.ctx);
  await settle();
  f.d.querySelector('[data-owner-task-open="7"]').click();
  assert.equal(f.projectChanges.at(-1), 'alpha');
  assert.equal(f.navigations.at(-1), 'tasks/7');
});

test('owner updates shared status and evidence with revision, preserves links and drafts on conflicts', async t => {
  const f = fixture(t, {route:'tasks/7'});
  await settle();
  assert.equal(f.d.querySelector('img[src="x"]'), null);
  const form = f.d.querySelector('[data-owner-task-update]');
  form.elements.status.value = 'done';
  form.elements.stage.value = 'verified';
  form.elements.evidence.value = 'Проверено по сценарию';
  form.elements.checked_at.value = '2026-11-03T00:30:00.000';
  // Удаляем запрещённую ссылку, которая пришла от старой версии данных.
  form.querySelector('[data-task-link-url][value^="javascript:"]').closest('fieldset').querySelector('[data-task-link-remove]').click();
  f.failUpdate(true);
  form.dispatchEvent(new f.w.Event('submit', {cancelable:true}));
  await settle();
  assert.match(form.textContent, /изменена другим исполнителем/);
  assert.equal(form.elements.evidence.value, 'Проверено по сценарию');
  assert.equal(form.elements.status.value, 'done');
  f.failUpdate(false);
  form.dispatchEvent(new f.w.Event('submit', {cancelable:true}));
  await settle();
  const sent = f.calls.filter(call => call.url.endsWith('/task_update')).at(-1).options.body;
  assert.equal(sent.revision, 3);
  assert.equal(sent.task_id, 7);
  assert.equal(sent.status, 'done');
  assert.equal(sent.stage, 'verified');
  assert.equal(sent.evidence, 'Проверено по сценарию');
  assert.equal(sent.links.length, 2);
  assert.equal(f.task.status, 'done');
  assert.equal(f.d.querySelector('[data-task-form]').elements.status.value, 'done');
  assert.match(f.d.querySelector('[data-owner-task-detail]').textContent, /Проверено: Подтверждено/);
});

test('comment draft survives unknown send and refresh, then clears only after success', async t => {
  const f = fixture(t, {route:'tasks/7'});
  await settle();
  let form = f.d.querySelector('[data-task-comment-form]');
  form.elements.text.value = 'Результат проверки';
  form.elements.text.dispatchEvent(new f.w.Event('input'));
  f.failComment(true);
  form.dispatchEvent(new f.w.Event('submit', {cancelable:true}));
  await settle();
  assert.equal(form.elements.text.value, 'Результат проверки');
  assert.equal(f.calls.filter(call => call.url.endsWith('/task_comment')).length, 1);
  f.w.taskView.render(f.d.getElementById('tasks-content'), f.ctx);
  await settle();
  form = f.d.querySelector('[data-task-comment-form]');
  assert.equal(form.elements.text.value, 'Результат проверки');
  f.failComment(false);
  form.dispatchEvent(new f.w.Event('submit', {cancelable:true}));
  await settle();
  assert.equal(f.d.querySelector('[data-task-comment-form]').elements.text.value, '');
  assert.match(f.d.querySelector('.tasks-mcp-comments').textContent, /Результат проверки/);
});

test('comment and subtask pages append history without resetting edits; new comments and late-page links work', async t => {
  const f = fixture(t, {route:'tasks/7'});
  f.ctx.selectedProjectId = 'alpha';
  f.task.company_code = 'alpha';
  f.task.comments = Array.from({length:21}, (_,index) => ({
    id:index+1,author:'Claude',text:`Комментарий ${index+1}`,created_at:'2026-11-02T15:00:00Z'
  }));
  f.task.subtasks = Array.from({length:21}, (_,index) => ({
    id:index+10,title:`Дочерняя ${index+1}`,company_code:'alpha',status:'planned'
  }));
  await settle();
  const updateForm = f.d.querySelector('[data-owner-task-update]');
  const commentForm = f.d.querySelector('[data-task-comment-form]');
  updateForm.elements.executor.value = 'Черновик исполнителя';
  commentForm.elements.text.value = 'Новый комментарий';
  commentForm.elements.text.dispatchEvent(new f.w.Event('input'));
  assert.equal(f.d.querySelectorAll('[data-task-comment-id]').length, 20);
  assert.equal(f.d.querySelector('[data-task-comment-id="21"]')?.textContent.includes('Комментарий 21'), true);
  assert.equal(f.d.querySelector('[data-task-comment-id="1"]'), null);
  f.d.querySelector('[data-task-comments-more]').click();
  f.d.querySelector('[data-task-subtasks-more]').click();
  await settle();
  assert.equal(f.d.querySelectorAll('[data-task-comment-id]').length, 21);
  assert.ok(f.d.querySelector('[data-task-comment-id="1"]'));
  assert.equal(f.d.querySelectorAll('[data-task-subtask-id]').length, 21);
  assert.equal(updateForm.elements.executor.value, 'Черновик исполнителя');
  assert.equal(commentForm.elements.text.value, 'Новый комментарий');
  assert.equal(f.d.querySelector('[data-task-comments-more]').hidden, true);
  assert.equal(f.d.querySelector('[data-task-subtasks-more]').hidden, true);
  commentForm.dispatchEvent(new f.w.Event('submit', {cancelable:true}));
  await settle();
  assert.match(f.d.querySelector('[data-task-comments-list]').firstElementChild.textContent, /Новый комментарий/);
  assert.equal(f.d.querySelectorAll('[data-task-comment-id]').length, 22);
  assert.equal(updateForm.elements.executor.value, 'Черновик исполнителя');
  assert.equal(commentForm.elements.text.value, '');
  f.ctx.selectedProjectId = 'synapse';
  f.d.querySelector('[data-task-subtask-id="30"] a').click();
  assert.equal(f.projectChanges.at(-1), 'alpha');
  assert.equal(f.navigations.at(-1), 'tasks/30');
});

test('a freshly posted comment stays visible while older unloaded history remains reachable', async t => {
  const f = fixture(t, {route:'tasks/7'});
  f.task.comments = Array.from({length:21}, (_,index) => ({
    id:index+1,author:'Claude',text:`История ${index+1}`,created_at:'2026-11-02T15:00:00Z'
  }));
  await settle();
  const form = f.d.querySelector('[data-task-comment-form]');
  form.elements.text.value = 'Свежий результат';
  form.dispatchEvent(new f.w.Event('submit', {cancelable:true}));
  await settle();
  assert.match(f.d.querySelector('[data-task-comments-list]').firstElementChild.textContent, /Свежий результат/);
  assert.equal(f.d.querySelector('[data-task-comment-id="1"]'), null);
  f.d.querySelector('[data-task-comments-more]').click();
  await settle();
  assert.equal(f.d.querySelectorAll('[data-task-comment-id]').length, 22);
  assert.ok(f.d.querySelector('[data-task-comment-id="1"]'));
  assert.equal(new Set([...f.d.querySelectorAll('[data-task-comment-id]')].map(item => item.dataset.taskCommentId)).size, 22);
  assert.match(f.d.querySelector('[data-task-comments-list]').firstElementChild.textContent, /Свежий результат/);
});

test('owner create reuses client_ref after unknown result and supports a same-company subtask', async t => {
  const f = fixture(t, {route:'tasks/7'});
  await settle();
  f.d.querySelector('[data-task-add-child]').click();
  await settle();
  const form = f.d.getElementById('task-create-form');
  form.elements.title.value = 'Новая подзадача';
  form.elements.assigneeName.value = 'Codex';
  form.elements.reviewer.value = 'Claude';
  form.elements.title.dispatchEvent(new f.w.Event('input', {bubbles:true}));
  assert.equal(form.elements.companyCode.disabled, true);
  f.failCreate(true);
  form.dispatchEvent(new f.w.Event('submit', {cancelable:true}));
  await settle();
  f.d.querySelector('[data-task-create-close]').click();
  f.d.querySelector('[data-task-add-child]').click();
  await settle();
  assert.equal(form.elements.title.value, 'Новая подзадача');
  f.failCreate(false);
  form.dispatchEvent(new f.w.Event('submit', {cancelable:true}));
  await settle();
  const calls = f.calls.filter(call => call.url.endsWith('/task_create'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body.client_ref, calls[1].options.body.client_ref);
  assert.equal(calls[1].options.body.parent_id, 7);
  assert.equal(calls[1].options.body.project, 'synapse');
  assert.equal(calls[1].options.body.reviewer, 'Claude');
  assert.ok(!f.calls.some(call => call.url.endsWith('/enqueue')));
});

test('editor never loads owner agents or task coordination', async t => {
  const f = fixture(t, {role:'editor'});
  await settle();
  assert.equal(f.d.querySelector('[data-owner-task-tab]'), null);
  assert.ok(!f.calls.some(call => call.url.startsWith('/coordination')));
});
