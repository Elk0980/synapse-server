'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {startFixture} = require('./test-fixture');

test('архив MCP → CRM: сессия, автор, повтор, аудит, исправление и кабинетный API', async t => {
  const f = await startFixture({installArchive:true});
  t.after(f.stop);
  const task = await f.call('task_create', {client_ref:'archive-task-sample', title:'SAMPLE отчёт сайта',
    project:'palitra-love', executor:'SAMPLE архив', reviewer:'SAMPLE проверяющий'});
  assert.equal(task.isError, false, JSON.stringify(task));
  const started = await f.call('session_start', {agent:'SAMPLE архив', kind:'codex', request:'отчёт модуля сайты Палитра'});
  assert.equal(started.isError, false, JSON.stringify(started));
  assert.ok(started.data.archives.some(item => item.module === 'sites' || item.code === 'sites'));
  const input = {session_id:started.data.session_id, client_ref:'archive-sample-1', module:'sites',
    project:'palitra-love', type:'report', text:'SAMPLE результат проверки', task_id:task.data.task.id,
    links:[{kind:'file', label:'SAMPLE существующее вложение', url:'https://files.example.test/report.pdf'}]};
  const noSession = {...input}; delete noSession.session_id;
  assert.equal((await f.call('archive_write', noSession)).isError, true);
  assert.equal((await f.call('archive_write', {...input, author:'Другой автор'})).isError, true);
  const written = await f.call('archive_write', input);
  assert.equal(written.isError, false, JSON.stringify(written));
  assert.equal(written.data.created, true);
  assert.equal(written.data.entry.agent.name, 'SAMPLE архив');
  const id = written.data.entry.id;
  const repeat = await f.call('archive_write', input);
  assert.equal(repeat.isError, false);
  assert.equal(repeat.data.created, false);
  assert.equal(repeat.data.entry.id, id);
  const changedRepeat = await f.call('archive_write', {...input, text:'SAMPLE иной текст'});
  assert.equal(changedRepeat.data.error.status, 409);
  const read = await f.call('archive_read', {id, session_id:started.data.session_id});
  assert.equal(read.isError, false, JSON.stringify(read));
  assert.equal(read.data.entry.text, input.text);
  const listed = await f.call('archive_list', {module:'sites', project:'palitra-love', session_id:started.data.session_id});
  assert.equal(listed.isError, false, JSON.stringify(listed));
  assert.equal(listed.data.entries.length, 1);
  assert.ok(listed.data.usage.some(item => item.agent?.name === 'SAMPLE архив' && item.writes >= 2));
  const cabinet = await f.cabinet('/coordination/mcp/archive_read', 'POST', {id});
  assert.equal(cabinet.status, 200, JSON.stringify(cabinet.body));
  assert.equal(cabinet.body.entry.id, id);
  assert.equal(cabinet.headers.get('cache-control'), 'private, no-store');
  assert.equal((await f.cabinet('/coordination/mcp/archive_read', 'POST', {id}, f.editor)).status, 403);
  const foreignActor = Buffer.from(JSON.stringify({v:1,userId:1,role:'owner',permissions:[],companyCodes:['foreign']})).toString('base64url');
  assert.equal((await f.crm('/coordination/mcp/archive_read', 'POST', {id}, foreignActor)).status, 404);
  const correction = await f.call('archive_write', {...input, client_ref:'archive-sample-2', type:'decision',
    text:'SAMPLE уточнение', supersedes_id:id});
  assert.equal(correction.isError, false, JSON.stringify(correction));
  assert.equal(correction.data.entry.supersedes_id, id);
  assert.equal((await f.call('archive_read', {id})).data.entry.text, input.text);
  assert.equal((await f.call('session_end', {session_id:started.data.session_id, summary:'SAMPLE архив проверен'})).isError, false);
  const closed = await f.call('archive_write', {...input, client_ref:'archive-closed'});
  assert.equal(closed.isError, true);
  assert.equal((await f.call('archive_read', {id})).isError, false);
  assert.equal((await f.call('task_get', {task_id:task.data.task.id})).data.title, 'SAMPLE отчёт сайта');
});

test('архив не обходит отсутствующие миграцию и MAP, не создаёт сессии от чтения', async t => {
  const f = await startFixture({installDocuments:false});
  t.after(f.stop);
  const list = await f.call('archive_list', {});
  assert.equal(list.isError, true);
  assert.equal(list.data.error.status, 503);
  const started = await f.call('session_start', {agent:'SAMPLE архив без карты', kind:'codex', request:'сайты'});
  assert.equal(started.isError, true);
  assert.equal(started.data.error.status, 503);
  assert.equal(started.data.error.message, 'Карта не установлена');
  assert.deepEqual((await f.call('agents_list', {})).data.agents, []);
});
