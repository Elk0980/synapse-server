'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('./company-app-http.cjs');
function setup({code='alvi',role='editor',permissions=['crm.view','crm.edit'],companyCodes=['alvi','avokado'],method='GET',path='/orders',body={},origin='https://synapse.synapsebusiness.ru',afterRead}={}){
 const log=[],user={id:2,sessionVersion:7,role,companyCodes,permissions,displayName:'Сотрудник'};let session={user};
 const args={request:{method,headers:{origin}},url:new URL(`https://synapse.synapsebusiness.ru/content/${code}${path}`),origin:'https://synapse.synapsebusiness.ru',
  requireSession:()=>session,requireCsrf:()=>log.push(['csrf']),readJson:async()=>{if(afterRead)session={user:afterRead(user)};return body;},reply:(...x)=>log.push(['reply',...x]),
  orders:{listOrders:(...x)=>{log.push(['list',...x]);return{orders:[{id:18,site:x[0]}]};},checklistOrder:(...x)=>{log.push(['checklist',...x]);return{order:{id:18}};},setWorkStatus:(...x)=>{log.push(['write',...x]);return{ok:true};},setChecklist:(...x)=>{log.push(['write',...x]);return{ok:true};}},
  dialogs:{orderDialog:(...x)=>{log.push(['dialog',...x]);return{dialogId:4};},listDialogs:(...x)=>({dialogs:[{id:18,site:x[0]}]}),dialogView:(...x)=>({id:18,site:x[0]}),status:site=>({site})}};
 return {args,log,user};
}
test('same native order id is resolved under exact studio and current permissions',async()=>{
 for(const code of ['alvi','avokado']){const s=setup({code});assert.equal(await H.handle(s.args),true);assert.deepEqual(s.log[0].slice(0,2),['list',code]);assert.equal(s.log.at(-1)[2].orders[0].site,code);}
});
test('direct foreign company access, missing read permission, unknown role and owner without membership are denied before data access',async()=>{
 for(const options of [{companyCodes:['avokado']},{permissions:[]},{role:'customer'},{role:'owner',companyCodes:[]}]){const s=setup(options);await assert.rejects(H.handle(s.args),{status:403});assert.deepEqual(s.log,[]);}
});
test('old Palitra route and unrelated modules remain owned by existing handlers',async()=>{
 for(const options of [{code:'palitra'},{path:'/customer-threads'},{path:'/workflow'},{path:'/order-recipient'},{path:'/client-dialogs/18/reply'}]){const s=setup(options);assert.equal(await H.handle(s.args),false);assert.equal(s.log.length,0);}
});
test('work mutation carries exact company and authenticated actor, with CSRF before/after body',async()=>{
 const s=setup({method:'PUT',path:'/orders/18/work',body:{status:'done',expected:'in_work'}});assert.equal(await H.handle(s.args),true);assert.equal(s.log.filter(x=>x[0]==='csrf').length,2);const write=s.log.find(x=>x[0]==='write');assert.equal(write[1],'alvi');assert.equal(write[2],'18');assert.equal(write[3],'done');assert.equal(write[4],'manager: Сотрудник');assert.deepEqual(write[5],{expected:'in_work'});
});
test('write access or identity revoked while body is read makes no mutation',async()=>{
 for(const change of [u=>({...u,id:3}),u=>({...u,sessionVersion:8}),u=>({...u,companyCodes:['avokado']}),u=>({...u,permissions:['crm.view']})]){
  const s=setup({method:'PUT',path:'/orders/18/work',body:{status:'done'},afterRead:change});await assert.rejects(H.handle(s.args),{status:403});assert.equal(s.log.some(x=>x[0]==='write'),false);
 }
});
test('foreign Origin, missing edit permission and injected fields cannot change orders',async()=>{
 for(const options of [{origin:'https://other.example'},{permissions:['crm.view']},{body:{status:'done',companyCode:'avokado'}},{body:[]}]){
  const s=setup({method:'PUT',path:'/orders/18/work',body:{status:'done'},...options});await assert.rejects(H.handle(s.args),e=>[400,403].includes(e.status));assert.equal(s.log.some(x=>x[0]==='write'),false);
 }
});
test('old order relation is looked up in same site only; no synthetic webchat relation',async()=>{
 const s=setup({path:'/orders/18/dialog'});assert.equal(await H.handle(s.args),true);assert.equal(s.log.find(x=>x[0]==='checklist')[1],'alvi');assert.deepEqual(s.log.find(x=>x[0]==='dialog').slice(1),['alvi','18']);assert.equal(s.log.at(-1)[2].dialogRef,'legacy:4');assert.equal(s.log.at(-1)[2].threadRef,null);
});
test('duplicate cursors and arbitrary query parameters are rejected; no operator or transport mutations are exposed',async()=>{
 for(const path of ['/orders?limit=1&limit=2','/orders?companyCode=avokado','/orders/18/dialog?before=1']){const s=setup({path});await assert.rejects(H.handle(s.args),{status:400});assert.deepEqual(s.log,[]);}
 const s=setup({method:'POST',path:'/client-bot'});await assert.rejects(H.handle(s.args),{status:405});assert.deepEqual(s.log,[]);
});
