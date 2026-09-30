'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createHughOwnerAlerts}=require('./hugh-owner-alerts');
test('уведомления живут в БД, разделены по компаниям и не повторяют uncertain',()=>{
  const db=new DatabaseSync(':memory:'); let at=Date.now();
  let a=createHughOwnerAlerts({db,now:()=>at});
  a.add('one','task:1','Нужен ответ');a.add('one','task:1','Дубль');a.add('two','task:2','Другое');
  assert.equal(a.list('one').length,1);
  const job=a.pending().jobs[0]; assert.equal(job.audience,'owner');assert.equal(job.chatId,null);
  a.acknowledge(job.id,{ok:false,uncertain:true});
  a=createHughOwnerAlerts({db,now:()=>at});
  assert.equal(a.pending().jobs[0].companyCode,'two');
  at+=360000;
  assert.deepEqual(a.pending().jobs,[]);
  assert.equal(a.list('one')[0].status,'uncertain');
  assert.equal(a.list('two')[0].status,'uncertain');
});
test('известный отказ допускает не больше трёх попыток',()=>{
  const db=new DatabaseSync(':memory:');let at=Date.now();const a=createHughOwnerAlerts({db,now:()=>at});
  a.add('one','delay:1','Задержка');
  for(let i=0;i<3;i++){const job=a.pending().jobs[0];a.acknowledge(job.id,{ok:false,retryable:true});at+=31000;}
  assert.deepEqual(a.pending().jobs,[]);assert.equal(a.list('one')[0].status,'error');
});
