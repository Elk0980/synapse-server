'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createClientIntakeProxy}=require('./client-intake-proxy');
const source={companyCode:'alvi',body:{botKey:'alvi',dialogId:7,telegramUserId:'123',name:'Тест'}};
test('proxy uses trusted identity and exact source, no public lead route or redirects',async()=>{
  let sent;const proxy=createClientIntakeProxy({crmUrl:'http://crm.test',apiKey:'test-only',identityHeader:x=>'trusted:'+x.id,fetchImpl:async(url,options)=>{sent={url,options};return {ok:true,json:async()=>({companyCode:'alvi',leadId:1,created:true})};}});
  assert.equal((await proxy(source,{id:9})).leadId,1);assert.match(sent.url,/\/client-dialog-intakes\?companyCode=alvi$/);
  assert.equal(sent.options.headers['x-synapse-crm-identity'],'trusted:9');assert.equal(sent.options.redirect,'error');assert.deepEqual(JSON.parse(sent.options.body),source.body);
});
test('timeouts are explicit, foreign receipts fail closed, and upstream errors do not leak data',async()=>{
  for(const response of [{ok:true,json:async()=>({companyCode:'palitra-love',leadId:1})},{ok:false,status:500,json:async()=>({error:'private detail'})}]){
    const proxy=createClientIntakeProxy({crmUrl:'http://crm.test',apiKey:'test',identityHeader:()=>'',fetchImpl:async()=>response});
    await assert.rejects(proxy(source,{}),e=>e.status===502&&!e.message.includes('private detail'));
  }
  const proxy=createClientIntakeProxy({crmUrl:'http://crm.test',apiKey:'test',identityHeader:()=>'',fetchImpl:async()=>{throw Error('secret');}});
  await assert.rejects(proxy(source,{}),e=>e.status===503&&/ту же карточку/.test(e.message)&&!e.message.includes('secret'));
});
