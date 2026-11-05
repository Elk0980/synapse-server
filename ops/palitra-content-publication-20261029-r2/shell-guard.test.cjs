'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'payload/sites/synapse/cabinet/palitra-orders/shell.js'),'utf8');
const allowed=source.slice(source.indexOf('  function contentCreateAllowed()'),source.indexOf('  function disposeContentTasks()'));
const screen=source.slice(source.indexOf('  function contentTasksScreen()'),source.indexOf('  function responseReportAllowed()'));
function fixture({owner=false,edit=true,host={}}={}) {
  let options;const api={read:async()=>({}),readContext:async()=>({timezone:'Europe/Moscow'}),uploadAsset:async()=>({url:'asset'}),saveDraft:async()=>({id:1}),...host};
  const context={document:{},window:{PalitraContentTasksUI:{create:o=>{options=o;return{element:'screen'};}}},HOST:{contentTasks:api},
    auth:{cabinet:{role:owner?'owner':'editor',permissions:edit?['autoposting.view','autoposting.edit']:['autoposting.view']}},
    allowed:true,binding:'actor1',contentTasksKey:'',contentTasksView:null,
    contentTasksAllowed:()=>context.allowed,managerBinding:()=>context.binding,disposeContentTasks:()=>{context.contentTasksView=null;},h:()=>null,endSession:()=>{}};
  vm.runInNewContext(allowed+'\n'+screen+'\ncontentTasksScreen();',context);
  return{context,options:()=>options};
}
test('форма доступна редактору с edit и owner; просмотр не выдаёт create',()=>{
  assert.equal(fixture().options().canCreate,true);
  assert.equal(fixture({owner:true,edit:false}).options().canCreate,true);
  assert.equal(fixture({edit:false}).options().canCreate,false);
});
test('смена binding блокирует callbacks до запроса',async()=>{
  let calls=0;const f=fixture({host:{saveDraft:async()=>{calls++;return{id:1};}}});f.context.binding='actor2';
  await assert.rejects(f.options().saveDraft({}),error=>error.contextChanged&&error.definitive);
  assert.equal(calls,0);
});
test('отзыв права после await не позволяет показать успешное сохранение и не разрешает повтор',async()=>{
  let release;const wait=new Promise(resolve=>release=resolve);
  const f=fixture({host:{saveDraft:async()=>{await wait;return{id:1};}}});
  const pending=f.options().saveDraft({});f.context.auth.cabinet.permissions=['autoposting.view'];release();
  await assert.rejects(pending,error=>error.contextChanged&&error.unknown===true&&error.definitive===false);
});
test('ошибка до upload или readContext не вызывает transport при отзыве доступа',async()=>{
  let calls=0;const f=fixture({host:{uploadAsset:async()=>{calls++;},readContext:async()=>{calls++;}}});f.context.allowed=false;
  await assert.rejects(f.options().uploadAsset({}),error=>error.definitive===true);
  await assert.rejects(f.options().readContext({}),error=>error.definitive===true);
  assert.equal(calls,0);
});
