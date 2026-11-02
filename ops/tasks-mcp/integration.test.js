'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
    'agents_list', 'agent_report', 'session_start', 'doc_read', 'session_end'
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
