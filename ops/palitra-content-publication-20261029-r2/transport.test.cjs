'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'payload/sites/synapse/cabinet/palitra-orders/native-host.js'),'utf8');
const start = source.indexOf('  function createContentDayTransport() {');
const end = source.indexOf('\n  // PALITRA_MANAGER_ATTENTION_VALIDATOR:', start);
assert.ok(start > 0 && end > start);
const unit = source.slice(start,end);
function response(value,status=200) { return {ok:status>=200&&status<300,status,json:async()=>value}; }
function fixture(fetch) {
  const calls=[];
  const context={URL,Intl,Map,Set,JSON,Date,Number,Object,Error,TypeError,encodeURIComponent,
    allowed:true,entry:'cabinet',origin:'https://synapse.synapsebusiness.ru',CABINET:'https://synapse.synapsebusiness.ru',
    FLAGS:{network:true},activeCompany:'palitra-love',cabinetCsrf:'synthetic-csrf',contentDayEpoch:1,
    window:{fetch:async(path,options)=>{calls.push({path,options});return fetch(path,options);}}};
  const api=vm.runInNewContext(unit+'\ncreateContentDayTransport();',context);
  return {api,context,calls};
}
const body=()=>({title:'Праздник',text:'Три шара',mediaUrls:[],platformIds:['telegram'],scheduledAt:'2026-11-05T09:00:00.000Z',timezone:'Europe/Moscow',profileRevision:7,dayKey:'2026-11-05',origin:'palitra-app:aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',format:'post',mediaSha256:''});
function material(input=body(),extra={}) {return {...input,companyCode:'palitra-love',id:21,revision:1,status:'draft',meta:{format:input.format},...extra};}
function json(value) {return JSON.parse(JSON.stringify(value));}

test('контекст возвращает только поля формы и сохраняет границы компании',async()=>{
  const f=fixture(async path=>{assert.match(path,/\/autoposting\/settings\?/);return response(
    {companyCode:'palitra-love',timezone:'Europe/Moscow',channels:[{id:'telegram',name:'Telegram',enabled:false,connected:false,target:'private-target',tokenConfigured:true}]});});
  assert.deepEqual(json(await f.api.readContext()),{channels:[{id:'telegram',name:'Telegram',connected:false,enabled:false}],timezone:'Europe/Moscow',profileRevision:null,publisherLabel:'Палитра'});
  assert.equal(f.calls.length,1);
  assert.equal(f.calls.some(call=>call.path.includes('company-information')),false);
  assert.ok(f.calls.every(call=>call.path.endsWith('?companyCode=palitra-love')&&call.options.credentials==='same-origin'&&call.options.redirect==='error'));
  assert.ok(f.calls.every(call=>!Object.hasOwn(call.options.headers,'X-CSRF-Token')));
});
test('ответы прежней компании или прежнего CSRF отклоняются после await',async()=>{
  let release;const waiting=new Promise(resolve=>release=resolve);
  const f=fixture(async()=>{await waiting;return response({companyCode:'palitra-love',revision:7,profile:{timezone:'Europe/Moscow'},channels:[]});});
  const pending=f.api.readContext();f.context.activeCompany='alvi';f.context.contentDayEpoch++;release();
  await assert.rejects(pending,error=>error.contextChanged===true&&error.status===403);
  assert.equal(f.calls.length,1);
});
test('отмена до отправки не создаёт сетевого запроса',async()=>{
  const f=fixture(()=>{throw Error('unexpected fetch');});
  await assert.rejects(f.api.saveDraft(body(),{signal:{aborted:true}}),error=>error.contextChanged===true);
  await assert.rejects(f.api.readContext({signal:{aborted:true}}),error=>error.contextChanged===true);
  assert.equal(f.calls.length,0);
});
test('файл передаётся бинарно с CSRF, типом и кодированным именем',async()=>{
  const file={type:'image/png',size:123,name:'Три шара.png'};
  const asset={url:'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/'+'a'.repeat(32)+'.png',type:'image/png',size:123,sha256:'b'.repeat(64)};
  const f=fixture(async()=>response(asset,201));
  assert.deepEqual(json(await f.api.uploadAsset(file)),asset);
  assert.equal(f.calls[0].options.body,file);
  assert.equal(f.calls[0].options.headers['Content-Type'],'image/png');
  assert.equal(f.calls[0].options.headers['X-CSRF-Token'],'synthetic-csrf');
  assert.equal(f.calls[0].options.headers['X-Filename'],encodeURIComponent(file.name));
});
test('ошибочный тип и размер не отправляются; чужой URL загрузки не принимается',async()=>{
  const f=fixture(async()=>response({url:'https://example.test/file.png',type:'image/png',size:12,sha256:'b'.repeat(64)}));
  for(const file of [{type:'text/html',size:12,name:'bad.html'},{type:'video/mp4',size:61*1024*1024,name:'large.mp4'}])
    await assert.rejects(f.api.uploadAsset(file),error=>error.definitive===true);
  assert.equal(f.calls.length,0);
  await assert.rejects(f.api.uploadAsset({type:'image/png',size:12,name:'ok.png'}),error=>error.unknown===true);
  assert.equal(f.calls.length,1);
});
test('сохранение: один POST, независимый GET карточки, повтор возвращает подтверждённый результат',async()=>{
  const f=fixture(async(path,options)=>response(material()));
  const expected={companyCode:'palitra-love',id:21,revision:1,status:'draft',title:'Праздник',scheduledAt:body().scheduledAt,origin:body().origin};
  assert.deepEqual(json(await f.api.saveDraft(body())),expected);
  assert.deepEqual(json(await f.api.saveDraft(body())),expected);
  assert.deepEqual(f.calls.map(call=>call.options.method),['POST','GET']);
  assert.match(f.calls[1].path,/\/posts\/21\?/);
  assert.deepEqual(JSON.parse(f.calls[0].options.body),body());
  assert.equal(f.calls[0].options.headers['X-CSRF-Token'],'synthetic-csrf');
});
test('двойное нажатие не порождает второй POST',async()=>{
  let release;const waiting=new Promise(resolve=>release=resolve);
  const f=fixture(async(path,options)=>{if(options.method==='POST')await waiting;return response(material());});
  const a=f.api.saveDraft(body()),b=f.api.saveDraft(body());release();
  assert.equal((await a).id,21);assert.equal((await b).id,21);
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
});
test('readback учитывает штатную нормализацию пробелов сервером',async()=>{
  const f=fixture(async()=>response(material()));
  assert.equal((await f.api.saveDraft({...body(),title:'  Праздник  ',text:'  Три шара\n'})).id,21);
  assert.equal(JSON.parse(f.calls[0].options.body).text,'Три шара');
});
test('новый draft без profileRevision использует штатную текущую версию сервера',async()=>{
  const input=body();delete input.profileRevision;
  const f=fixture(async()=>response(material(input,{profileRevision:12})));
  assert.equal((await f.api.saveDraft(input)).id,21);
  assert.equal(Object.hasOwn(JSON.parse(f.calls[0].options.body),'profileRevision'),false);
  assert.equal(f.calls.length,2);
});
test('null profileRevision не подменяет отсутствие поля',async()=>{
  const f=fixture(()=>{throw Error('unexpected fetch');});
  await assert.rejects(f.api.saveDraft({...body(),profileRevision:null}),error=>error.definitive===true);
  assert.equal(f.calls.length,0);
});
test('потерянный ответ POST сверяется по origin: без второго POST',async()=>{
  const f=fixture(async(path,options)=>{if(options.method==='POST')throw Error('network');return response({companyCode:'palitra-love',posts:[material()]});});
  assert.equal((await f.api.saveDraft(body())).id,21);
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
  assert.match(f.calls[1].path,/\/posts\?companyCode=/);
});
test('неизвестный результат остаётся заблокированным при повторе и изменении формы',async()=>{
  const f=fixture(async(path,options)=>{if(options.method==='POST')throw Error('network');return response({companyCode:'palitra-love',posts:[]});});
  for(const input of [body(),body(),{...body(),title:'Изменённое'}])
    await assert.rejects(f.api.saveDraft(input),error=>error.code==='SAVE_OUTCOME_UNKNOWN'&&error.unknown===true);
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
});
test('похожий материал или несовпавшая запись не подтверждает неизвестное сохранение',async()=>{
  const f=fixture(async(path,options)=>{if(options.method==='POST')throw Error('network');return response({companyCode:'palitra-love',posts:[material(body(),{text:'Другой текст'})]});});
  await assert.rejects(f.api.saveDraft(body()),error=>error.code==='SAVE_OUTCOME_UNKNOWN');
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
});
test('409 PROFILE_CHANGED остаётся определённой ошибкой без GET поиска',async()=>{
  const f=fixture(async()=>response({details:{code:'PROFILE_CHANGED'}},409));
  await assert.rejects(f.api.saveDraft(body()),error=>error.status===409&&error.code==='PROFILE_CHANGED'&&error.definitive===true&&error.unknown===false);
  assert.equal(f.calls.length,1);
});
test('смена компании после отправки не запускает lookup в новой компании',async()=>{
  const f=fixture(async()=>{f.context.activeCompany='avokado';f.context.contentDayEpoch++;return response(material());});
  await assert.rejects(f.api.saveDraft(body()),error=>error.code==='SAVE_OUTCOME_UNKNOWN'&&error.contextChanged===true);
  assert.equal(f.calls.length,1);
});
test('отсутствие независимого подтверждения блокирует повтор даже после успешного POST',async()=>{
  const f=fixture(async(path,options)=>{if(options.method==='POST')return response(material());throw Error('read unavailable');});
  await assert.rejects(f.api.saveDraft(body()),error=>error.code==='SAVE_OUTCOME_UNKNOWN');
  await assert.rejects(f.api.saveDraft(body()),error=>error.code==='SAVE_OUTCOME_UNKNOWN');
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
});
test('чужие данные и действия за пределами draft отклоняются до POST',async()=>{
  const f=fixture(()=>{throw Error('unexpected fetch');});
  for(const input of [{...body(),companyCode:'alvi'},{...body(),approve:true},{...body(),origin:'other-app:123'},{...body(),format:'video'},
    {...body(),mediaUrls:['https://example.test/video.mp4']},{...body(),platformIds:['unknown']},{...body(),timezone:'Invalid/zone'}])
    await assert.rejects(f.api.saveDraft(input),error=>error.definitive===true);
  assert.equal(f.calls.length,0);
});
