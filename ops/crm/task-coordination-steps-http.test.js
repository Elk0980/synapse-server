'use strict';
// specs/101: старый CRUD задач не обходит шаги приёмки. Данные — SAMPLE.
const test=require('node:test'),assert=require('node:assert/strict');
const {startFixture}=require('../tasks-mcp/test-fixture');

test('legacy CRUD: POST done and PATCH description [x] + done with open steps -> 409',async t=>{
  const fixture=await startFixture();t.after(fixture.stop);
  const steps='Точка А: SAMPLE\nШаги приёмки:\n- [ ] проверить';
  const created=await fixture.cabinet('/tasks?companyCode=palitra-love','POST',{title:'SAMPLE crud done',status:'done',description:steps,companyCode:'palitra-love'});
  assert.equal(created.status,409,JSON.stringify(created.body));
  const ticked=await fixture.cabinet('/tasks?companyCode=palitra-love','POST',{title:'SAMPLE crud ticked',status:'done',description:steps.replace('[ ]','[x]'),companyCode:'palitra-love'});
  assert.equal(ticked.status,409,'«[x]» в описании не закрывает шаг');
  const open=await fixture.cabinet('/tasks?companyCode=palitra-love','POST',{title:'SAMPLE crud open',description:steps,companyCode:'palitra-love'});
  assert.equal(open.status,201,JSON.stringify(open.body));
  const patched=await fixture.cabinet(`/tasks/${open.body.id}?companyCode=palitra-love`,'PATCH',{description:steps.replace('[ ]','[x]'),status:'done'});
  assert.equal(patched.status,409,JSON.stringify(patched.body));
  const cleared=await fixture.cabinet(`/tasks/${open.body.id}?companyCode=palitra-love`,'PATCH',{description:'Без шагов',status:'done'});
  assert.equal(cleared.status,409,'стирание шагов из описания в том же запросе не закрывает задачу');
  const plain=await fixture.cabinet('/tasks?companyCode=palitra-love','POST',{title:'SAMPLE crud plain',status:'done',companyCode:'palitra-love'});
  assert.equal(plain.status,201);
});
