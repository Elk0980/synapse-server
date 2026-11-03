'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startFixture } = require('./test-fixture');

test('MCP → настоящий кабинет/CSRF → MCP: одна запись, общий статус, изоляция', async t => {
  const f = await startFixture();
  t.after(f.stop);
  const initialized = await f.rpc('initialize', { protocolVersion: '2025-11-25',
    capabilities: {}, clientInfo: { name: 'SAMPLE acceptance', version: '1' } });
  assert.equal(initialized.status, 200);
  assert.ok(initialized.result.serverInfo);
  const tools = await f.rpc('tools/list');
  assert.deepEqual(tools.result.tools.map(tool => tool.name).sort(), [
    'tasks_list', 'task_get', 'task_create', 'task_update', 'task_comment',
    'agents_list', 'agent_report', 'session_start', 'doc_read', 'session_end',
    'archive_list', 'archive_read', 'archive_write',
    'agent_launch', 'agent_status', 'agent_message', 'agent_stop', 'agent_worker_claim', 'agent_worker_update'
  ].sort());
  assert.equal((await fetch(f.mcpUrl + '/mcp')).status, 401);
  const input = { title: 'SAMPLE сквозная задача', project: 'palitra-love', client_ref: 'acceptance-1',
    source: 'gpt', executor: 'Codex fixture', reviewer: 'Owner fixture', due_date: '2026-11-03' };
  const created = await f.call('task_create', input);
  assert.equal(created.isError, false, JSON.stringify(created));
  const id = created.data.task.id;
  const repeat = await f.call('task_create', input);
  assert.equal(repeat.data.created, false);
  assert.equal(repeat.data.task.id, id);
  const board = await f.cabinet('/coordination/tasks?companyCode=palitra-love');
  assert.equal(board.status, 200);
  assert.equal(board.body.tasks.find(task => task.taskId === id).title, input.title);
  assert.equal(board.headers.get('cache-control'), 'private, no-store');
  const updated = await f.cabinet('/coordination/mcp/task_update', 'POST', { task_id: id, status: 'in_progress' });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal((await f.call('task_get', { task_id: id })).data.status, 'in_progress');
  const legacy = await f.cabinet(`/tasks/${id}?companyCode=palitra-love`, 'PATCH', { status: 'done' });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal((await f.call('task_get', { task_id: id })).data.status, 'done');
  const sameReviewer = await f.cabinet(`/tasks/${id}?companyCode=palitra-love`, 'PATCH', { assigneeName: input.reviewer });
  assert.equal(sameReviewer.status, 400);
  const assigned = await f.cabinet(`/tasks/${id}?companyCode=palitra-love`, 'PATCH', { assigneeName: 'Claude fixture' });
  assert.equal(assigned.status, 200);
  assert.equal((await f.call('task_get', { task_id: id })).data.coordination.executorName, 'Claude fixture');
  const comment = await f.call('task_comment', { task_id: id, author: 'Codex fixture', text: 'SAMPLE проверено' });
  assert.equal(comment.isError, false);
  assert.equal((await f.call('task_get', { task_id: id })).data.comments.length, 1);
  assert.equal((await f.call('task_create', { ...input, client_ref: 'bad-reviewer', reviewer: input.executor })).isError, true);
  const foreign = await f.crm('/coordination/mcp/task_get', 'POST', { task_id: id },
    Buffer.from(JSON.stringify({ v: 1, userId: 1, role: 'owner', permissions: [], companyCodes: ['foreign'] })).toString('base64url'));
  assert.equal(foreign.status, 404);
  assert.equal((await f.cabinet('/coordination/mcp/tasks_list', 'POST', {}, f.editor)).status, 403);
  const list = await f.call('tasks_list', { project: 'palitra-love', search: 'SAMPLE сквозная' });
  assert.equal(list.data.tasks.length, 1);
  const session = await f.call('session_start', { agent: 'Codex fixture', kind: 'codex', request: 'правка сайта Палитры' });
  assert.equal(session.isError, false, JSON.stringify(session));
  const sessionText = JSON.stringify(session.data);
  assert.match(sessionText, /SITE\.md/);
  assert.doesNotMatch(sessionText, /VIDEO\.md/);
  assert.equal((await f.call('session_end', { session_id: session.data.session_id, summary: 'SAMPLE завершено', statuses: [] })).isError, false);
});

test('отсутствующая папка канона не мешает MCP/CRM; тестовая карта подключается без перезапуска', async t => {
  const f = await startFixture({installDocuments: false});
  t.after(f.stop);
  await assert.rejects(fs.stat(f.docs), error => error.code === 'ENOENT');
  assert.equal((await fetch(f.mcpUrl + '/health')).status, 200);
  assert.equal((await f.rpc('tools/list')).result.tools.length, 19);
  assert.equal((await f.call('tasks_list', {})).isError, false);
  const created = await f.call('task_create', {client_ref:'absent-map-1', title:'SAMPLE без карты',
    project:'palitra-love', executor:'SAMPLE Codex', reviewer:'SAMPLE Owner', source:'manual'});
  assert.equal(created.isError, false, JSON.stringify(created));
  const id = created.data.task.id;
  assert.equal((await f.call('task_get', {task_id:id})).data.id, id);
  assert.equal((await f.call('task_update', {task_id:id, status:'in_progress'})).isError, false);
  assert.equal((await f.call('task_comment', {task_id:id, author:'SAMPLE Codex', text:'SAMPLE без карты'})).isError, false);
  const rejected = await f.call('session_start', {agent:'SAMPLE Codex', kind:'codex', request:'правка сайта'});
  assert.equal(rejected.isError, true);
  assert.equal(rejected.data.error.status, 503);
  assert.equal(rejected.data.error.message, 'Карта не установлена');
  assert.deepEqual((await f.call('agents_list', {})).data.agents, []);
  await assert.rejects(fs.stat(f.docs), error => error.code === 'ENOENT');
  await f.installSampleDocuments();
  const session = await f.call('session_start', {agent:'SAMPLE Codex', kind:'codex', request:'правка сайта'});
  assert.equal(session.isError, false, JSON.stringify(session));
  assert.equal((await f.call('doc_read', {path:'SITE.md'})).data.text, 'SAMPLE fixture SITE.md');
  const retained = f.docs + '-retained';
  assert.equal(path.dirname(path.resolve(f.docs)), path.resolve(f.dir));
  assert.equal(path.dirname(path.resolve(retained)), path.resolve(f.dir));
  await fs.rename(f.docs, retained);
  assert.equal((await f.call('session_end', {session_id:session.data.session_id, summary:'SAMPLE готово'})).isError, false);
  assert.equal((await f.call('agent_report', {agent:'SAMPLE Codex', state:'idle', last_event:'SAMPLE завершено'})).isError, false);
  assert.equal((await f.call('task_update', {task_id:id, status:'done'})).isError, false);
  assert.equal((await f.cabinet('/coordination/mcp/task_get', 'POST', {task_id:id})).body.status, 'done');
});
