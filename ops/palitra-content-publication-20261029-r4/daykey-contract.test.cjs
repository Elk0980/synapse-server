'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const serverPath=path.join(__dirname,'../crm/autoposting.js');
const serverSource=fs.readFileSync(serverPath,'utf8');
const definition=serverSource.match(/^const dayKey=value=>\{.*\};\r?$/m)?.[0];
assert.ok(definition,'Из реального модуля сервера должна быть получена текущая функция dayKey');
const serverDayKey=vm.runInNewContext(definition+'\ndayKey;',{fail:(status,message)=>{throw Object.assign(Error(message),{status});}});
const native=fs.readFileSync(path.join(__dirname,'payload/sites/synapse/cabinet/palitra-orders/native-host.js'),'utf8');
const unit=native.slice(native.indexOf('  function createContentDayTransport() {'),native.indexOf('\n  // PALITRA_MANAGER_ATTENTION_VALIDATOR:'));
function response(value,status=200){return{ok:status>=200&&status<300,status,json:async()=>value};}
function fixture(){
  const calls=[];let saved;
  const context={URL,Intl,Map,Set,JSON,Date,Number,Object,Error,TypeError,encodeURIComponent,allowed:true,entry:'cabinet',origin:'https://synapse.synapsebusiness.ru',CABINET:'https://synapse.synapsebusiness.ru',FLAGS:{network:true},activeCompany:'palitra-love',cabinetCsrf:'synthetic-csrf',contentDayEpoch:1,window:{fetch:async(url,options)=>{
    calls.push({url,options});
    if(options.method==='POST'){
      const body=JSON.parse(options.body);
      // Реальный серверный validator, а не повтор клиентского предположения.
      try{const normalized=serverDayKey(body.dayKey);saved={...body,dayKey:normalized,companyCode:'palitra-love',id:22,revision:1,profileRevision:10,status:'draft',meta:{format:body.format}};return response(saved,201);}
      catch(error){return response({details:{code:'VALIDATION_ERROR'},message:error.message},error.status);}
    }
    return response(saved);
  }}};
  return{api:vm.runInNewContext(unit+'\ncreateContentDayTransport();',context),calls};
}
const input=()=>({title:'Техническая проверка',text:'',mediaUrls:[],platformIds:['telegram'],scheduledAt:'2026-11-05T09:00:00.000Z',timezone:'Europe/Moscow',origin:'palitra-app:bbbbbbbb-cccc-4ddd-eeee-ffffffffffff',format:'post'});
test('реальный серверный dayKey — недельный слот, календарная дата отвергается',()=>{
  assert.equal(serverDayKey(undefined),'');assert.equal(serverDayKey(''),'');
  for(let n=1;n<=7;n++)assert.equal(serverDayKey('D'+n),'D'+n);
  for(const value of ['2026-11-05','D0','D8',7])assert.throws(()=>serverDayKey(value),error=>error.status===400);
});
test('сохранение без dayKey проходит реальный validator и подтверждается independent GET',async()=>{
  const f=fixture();const body=input();const result=await f.api.saveDraft(body);
  assert.equal(result.status,'draft');assert.equal(result.id,22);
  assert.deepEqual(f.calls.map(call=>call.options.method),['POST','GET']);
  const sent=JSON.parse(f.calls[0].options.body);
  assert.equal(Object.hasOwn(sent,'dayKey'),false);
  assert.equal(sent.scheduledAt,body.scheduledAt);
  await f.api.saveDraft(body);assert.equal(f.calls.length,2,'повтор не отправляет POST');
});
test('явные недельные слоты и пустое значение совместимы с реальным validator',async()=>{
  for(const dayKey of ['','D1','D7']){
    const f=fixture();assert.equal((await f.api.saveDraft({...input(),dayKey})).status,'draft');
    assert.equal(JSON.parse(f.calls[0].options.body).dayKey,dayKey);
  }
});
test('календарный dayKey и null отклоняются до сети',async()=>{
  const f=fixture();for(const dayKey of ['2026-11-05',null,'D8'])await assert.rejects(f.api.saveDraft({...input(),dayKey}),error=>error.definitive===true);
  assert.equal(f.calls.length,0);
});
