'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createMetrika} = require('./metrika');
const env = {METRIKA_COUNTER_ALVI:'101', METRIKA_TOKEN_ALVI:'secret-a',
  METRIKA_COUNTER_AVOKADO:'202', METRIKA_TOKEN_AVOKADO:'secret-b'};
test('счётчик и секрет изолированы по компаниям; кеш не удваивает запросы и значения', async () => {
  const calls=[];
  const report=createMetrika({env,fetchImpl:async(url,options)=>{
    calls.push({url,options}); return {ok:true,json:async()=>({totals:[12,8,22],sampled:false})};
  }});
  const args=['alvi','2026-09-01','2026-09-24'];
  const [a,b]=await Promise.all([report(...args),report(...args)]);
  assert.deepEqual(a.metrics,{visits:12,users:8,pageViews:22});assert.deepEqual(a,b);
  await report(...args);assert.equal(calls.length,1);
  await report('avokado',args[1],args[2]);assert.equal(calls.length,2);
  assert.equal(calls[0].url.searchParams.get('ids'),'101');
  assert.equal(calls[1].options.headers.Authorization,'OAuth secret-b');
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(JSON.stringify(a).includes('secret'),false);
});
test('без подключения нет выдуманных нулей и внешних запросов',async()=>{
  const report=createMetrika({env:{},fetchImpl:()=>{throw Error('must not call');}});
  const r=await report('alvi','2026-09-01','2026-09-24');
  assert.equal(r.status,'not_configured');assert.equal(r.metrics,null);
});
test('ошибки доступа и некорректный ответ скрывают цифры и тела ошибок',async()=>{
  for(const [response,status] of [[{ok:false,status:403},'access_denied'],[{ok:false,status:429},'rate_limited'],
    [{ok:true,json:async()=>({totals:[1,null,2]})},'invalid_response']]){
    const report=createMetrika({env,fetchImpl:async()=>response});
    const r=await report('alvi','2026-09-01','2026-09-24');assert.equal(r.status,status);assert.equal(r.metrics,null);
  }
});
test('недопустимые даты отклоняются до отправки запроса',async()=>{
  const report=createMetrika({env,fetchImpl:()=>{throw Error('must not call');}});
  for(const [from,to] of [['2026-02-30','2026-03-01'],['2026-09-25','2026-09-01'],['2024-01-01','2026-09-01']]){
    await assert.rejects(report('alvi',from,to),{status:400});
  }
});
