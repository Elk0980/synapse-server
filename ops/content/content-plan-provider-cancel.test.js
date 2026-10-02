'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createHughFallback}=require('./hugh-fallback');
function fixture(t,fetchImpl){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const env={HUGH_FALLBACK_PROVIDERS:'first,second',HUGH_FALLBACK_BUDGET_MAX_REQUESTS:'10'};
 for(const name of ['FIRST','SECOND'])Object.assign(env,{[`HUGH_FALLBACK_${name}_URL`]:'https://example.invalid/v1',
  [`HUGH_FALLBACK_${name}_KEY`]:'synthetic-key',[`HUGH_FALLBACK_${name}_MODEL`]:'synthetic-model'});
 return {db,api:createHughFallback({db,env,fetchImpl})};
}
test('отмена до вызова не резервирует деньги и не вызывает API',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++}),controller=new AbortController();controller.abort();
 await assert.rejects(f.api.reply('{}',{signal:controller.signal}),{name:'AbortError'});
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM hugh_fallback_reservations').get().n,0);
});
test('отмена запроса передаётся fetch; неопределённый расход сохранён, второй провайдер не вызывается',async t=>{
 let calls=0,started;const ready=new Promise(r=>started=r),controller=new AbortController();
 const f=fixture(t,async(_,options)=>{calls++;started();return new Promise((_,reject)=>{
  options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
 })});
 const running=f.api.reply('{}',{signal:controller.signal});await ready;controller.abort();
 await assert.rejects(running,{name:'AbortError'});assert.equal(calls,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM hugh_fallback_reservations WHERE state='kept'").get().n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM project_chat_provider_state WHERE failures>0").get().n,0);
});
test('отмена во время чтения ответа не принимает поздний результат и не запускает резерв',async t=>{
 let calls=0,release,started;const ready=new Promise(r=>started=r),controller=new AbortController();
 const f=fixture(t,async()=>{calls++;return {ok:true,status:200,json:()=>{started();return new Promise(r=>release=r)}}});
 const running=f.api.reply('{}',{signal:controller.signal});await ready;controller.abort();
 release({choices:[{message:{content:'Поздний ответ'}}]});
 await assert.rejects(running,{name:'AbortError'});assert.equal(calls,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM hugh_fallback_reservations WHERE state='kept'").get().n,1);
});
