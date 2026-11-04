'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createPeopleCrmClient}=require('./people-crm-client');
test('каждая операция передаёт реальную editor роль, одну компанию и одно фактическое право',async()=>{
  const seen=[],user={id:2,displayName:'Исполнитель',role:'editor',companyCodes:['alvi','avokado'],permissions:['tasks.self.view','tasks.self.edit','content-plan.approve','crm.edit']};
  const call=createPeopleCrmClient({crmUrl:'http://127.0.0.1',apiKey:'synthetic-test',fetchImpl:async(url,options)=>{seen.push({url,options});return new Response('{}');}});
  for(const action of ['tasks_list','task_get','taskRecords','task_update','mediaMentor','planVariantsDecision']) {
    await call(action,{offset:0},user,'alvi');const {url,options}=seen.at(-1),identity=JSON.parse(Buffer.from(options.headers['x-synapse-crm-identity'],'base64url'));
    assert.equal(identity.role,'editor');assert.equal(identity.userId,2);assert.deepEqual(identity.companyCodes,['alvi']);
    assert.deepEqual(identity.permissions,[['mediaMentor','planVariantsDecision'].includes(action)?'content-plan.approve':action==='task_update'?'tasks.self.edit':'tasks.self.view']);
    assert.ok(!identity.permissions.includes('crm.edit'));assert.match(new URL(url).pathname,/^\/internal\/people\//);assert.equal(new URL(url).searchParams.get('companyCode'),'alvi');
  }
});
test('контекст плана сохраняет фактическое право согласования, не выдаёт его исполнителю',async()=>{
  const seen=[],call=createPeopleCrmClient({crmUrl:'http://127.0.0.1',apiKey:'synthetic',fetchImpl:async(u,o)=>{seen.push(JSON.parse(Buffer.from(o.headers['x-synapse-crm-identity'],'base64url')));return new Response('{}');}});
  const user={id:2,role:'editor',displayName:'Тест',companyCodes:['alvi'],permissions:['tasks.self.view']};
  await call('teamChatContext',{},user,'alvi');assert.deepEqual(seen.at(-1).permissions,['tasks.self.view']);
  await call('teamChatContext',{}, {...user,permissions:[...user.permissions,'content-plan.approve']},'alvi');assert.deepEqual(seen.at(-1).permissions,['tasks.self.view','content-plan.approve']);
});
test('отсутствующее право и чужая компания не заменяются owner; запрос не выходит',async()=>{
  let calls=0;const call=createPeopleCrmClient({crmUrl:'http://127.0.0.1',apiKey:'synthetic-test',fetchImpl:async()=>{calls++;return new Response('{}');}});
  const user={id:2,role:'editor',displayName:'Тест',companyCodes:['alvi'],permissions:['tasks.self.view']};
  for(const action of ['task_update','mediaMentor','planVariantsDecision'])await assert.rejects(call(action,{},user,'alvi'),{status:403});
  await assert.rejects(call('tasks_list',{},user,'avokado'),{status:403});assert.equal(calls,0);
  await call('mediaMentor',{}, {...user,id:1,role:'owner'},'alvi');assert.equal(calls,1);
});
