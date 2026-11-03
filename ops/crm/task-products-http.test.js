'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {startFixture}=require('../tasks-mcp/test-fixture');

test('board products and plan use existing cabinet session/CSRF and one CRM registry',async t=>{
  const fixture=await startFixture();t.after(fixture.stop);
  const call=(tool,args={},session)=>fixture.cabinet(`/coordination/mcp/${tool}`,'POST',args,session);
  const created=await call('task_create',{project:'palitra-love',title:'SAMPLE доска продукт',new_product:'SAMPLE приложение',
    chat_url:'https://example.test/chat',executor:'Sample Codex',reviewer:'Sample Claude',client_ref:'board-http-one'});
  assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(created.body.created,true);
  const task=created.body.task;assert.ok(task.product_id);assert.equal(task.product_name,'SAMPLE приложение');
  const products=await call('products_list',{project:'palitra-love'});assert.equal(products.status,200);assert.equal(products.body.products.length,1);
  const editor=await call('products_list',{},fixture.editor);assert.equal(editor.status,403);
  const duplicate=await call('task_create',{project:'palitra-love',title:'SAMPLE доска продукт',new_product:'SAMPLE другое',client_ref:'board-http-two'});
  assert.equal(duplicate.body.created,false);assert.equal(duplicate.body.possible_duplicates[0].id,task.id);
  assert.equal((await call('products_list',{project:'palitra-love'})).body.products.length,1);
  const saved=await call('task_update',{task_id:task.id,revision:task.coordination.revision,status:'in_progress',priority:'high',next_step:'SAMPLE проверка'});
  assert.equal(saved.status,200);assert.equal(saved.body.task.priority,'high');
  const legacy=await fixture.cabinet(`/tasks/${task.id}?companyCode=palitra-love`,'PATCH',{status:'planned'});assert.equal(legacy.status,200);
  const stale=await call('task_update',{task_id:task.id,revision:saved.body.task.coordination.revision,status:'done'});assert.equal(stale.status,409);
  const list=await call('tasks_list',{project:'palitra-love',product:task.product_id});assert.deepEqual(list.body.tasks.map(row=>row.id),[task.id]);
  const identity=Buffer.from(JSON.stringify({v:1,userId:1,role:'owner',permissions:[],companyCodes:['foreign']})).toString('base64url');
  const denied=await fixture.crm('/coordination/mcp/tasks_list','POST',{product:task.product_id},identity);assert.equal(denied.status,404);
});
