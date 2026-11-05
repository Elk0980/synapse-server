
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {startFixture} = require('./test-fixture');

test('обновление приватного канона возобновляет реальную CRM-сессию и сохраняет старые задачи', async t => {
  const f = await startFixture();
  t.after(f.stop);
  const agent = {agent:'SAMPLE прежний агент',kind:'codex',request:'сайт'};
  const first = await f.call('session_start',agent);
  assert.equal(first.isError,false);
  const created = await f.call('task_create',{client_ref:'SAMPLE-map-retained',title:'SAMPLE прежняя задача',
    project:'palitra-love',executor:agent.agent,reviewer:'SAMPLE проверяющий',source:'manual'});
  assert.equal(created.isError,false);
  const id = created.data.task.id;
  await f.call('task_comment',{task_id:id,author:agent.agent,text:'SAMPLE сохранённый комментарий'});
  const before = (await f.call('task_get',{task_id:id})).data;
  await fs.writeFile(path.join(f.docs,'RULES.md'),'SAMPLE новый приватный канон');
  await fs.writeFile(path.join(f.docs,'MAP.json'),JSON.stringify({version:'SAMPLE-map-2',rules_version:'SAMPLE-2',
    always:[{doc:'RULES.md',why:'SAMPLE обязательный'}],rules:[],
    fallback:{read:['SITE.md'],why:'SAMPLE справочник'}}));
  const resumed = await f.call('session_start',agent);
  assert.equal(resumed.isError,false);
  assert.equal(resumed.data.session_id,first.data.session_id);
  assert.equal(resumed.data.resumed,true);
  assert.equal(resumed.data.rules_changed,true);
  assert.deepEqual(resumed.data.rules,['SAMPLE новый приватный канон']);
  assert.equal(resumed.data.rules_version,'SAMPLE-2');
  const fresh = await f.call('session_start',{...agent,agent:'SAMPLE новый агент'});
  assert.equal(fresh.isError,false);
  assert.equal(fresh.data.rules_changed,null);
  assert.deepEqual(fresh.data.rules,resumed.data.rules);
  // №142: задача не меняется; меняется только текущий код правил в метке якоря.
  const after=(await f.call('task_get',{task_id:id})).data;
  assert.equal(after.rules_anchor.current,resumed.data.rules_revision.slice(0,8));
  assert.notEqual(after.rules_anchor.current,before.rules_anchor.current);
  const strip=task=>({...task,rules_anchor:null,coordination:{...task.coordination,rules_anchor:null}});
  assert.deepEqual(strip(after),strip(before));
  assert.equal((await f.call('doc_read',{path:'SITE.md'})).isError,false);
  assert.equal((await f.call('doc_read',{path:'CONSTITUTION.md'})).isError,true);
});
