import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompanyView, buildAdPatch, buildProfile, createCompanyController, escapeHtml,
  metricDisplay, statusLabel, validateBindings } from './ui-state.mjs';
import { createSyntheticAdapter, demoCompanies, makeSyntheticViews } from './synthetic-adapter.mjs';
import { createServiceAdapter, normalizeServiceView } from './service-adapter.mjs';
import { mountYandexPanel } from './yandex-panel.mjs';

const time = Date.parse('2026-10-28T12:00:00Z');
const fixtures = () => makeSyntheticViews(time);
const rawView = (companyId = 'demo-north') => ({
  companyId, profile:{companyId,label:'Учебная компания',siteHosts:['example.test'],methodologyVersion:'v1',businessFacts:[]},
  connection:null,bindings:{campaignIds:['900'],counterIds:['800'],version:1},capabilities:{connection:'unverified'},
  policy:{mode:'observe',currency:'RUB',maxBudgetMinor:'100000',period:{from:'2026-10-01',to:'2026-10-31'}},
  objects:{campaigns:[{Id:'900',Status:'DRAFT',Name:'Черновик'}],ads:[{Id:'1925418653941270479',CampaignId:'900',Status:'DRAFT',ResponsiveAd:{Titles:['Первый','Второй'],Texts:['Один','Два']}}]},proposals:[],jobs:[],
});

test('чужая компания и вложенные чужие объекты не проходят границу отображения', () => {
  const views = fixtures();
  assert.throws(() => assertCompanyView(views['demo-south'],'demo-north'), /компанию/);
  const mixed = views['demo-north']; mixed.ads.push(views['demo-south'].ads[0]);
  assert.throws(() => assertCompanyView(mixed,'demo-north'), /другой компании/);
});

test('привязки ограничены объектами компании, исходное соединение сохраняется', () => {
  const view = fixtures()['demo-north']; view.bindings.connectionId='conn-own';
  assert.throws(() => validateBindings(view,{campaignIds:['demo-campaign-s'],counterIds:[]}), /вне доступного/);
  const binding = validateBindings(view,{campaignIds:['demo-campaign-n','demo-campaign-n'],counterIds:['demo-counter-0']});
  assert.equal(binding.connectionId,'conn-own'); assert.deepEqual(binding.campaignIds,['demo-campaign-n']);
  assert.deepEqual(view.bindings.counterIds,[]);
});

test('профиль новой компании пуст, бизнес-факты требуют источник и дату', () => {
  const view = fixtures()['demo-south'];
  assert.equal(view.policy.totalBudgetMinor,undefined); assert.deepEqual(view.profile.businessFacts,{});
  assert.throws(() => buildProfile(view.profile,{region:'Север'}), /источник и дату/);
  const profile=buildProfile(view.profile,{region:'Север',source:'Бриф владельца',checkedAt:'2026-10-28'});
  assert.equal(profile.companyId,'demo-south'); assert.equal(profile.businessFacts.region,'Север');
  assert.equal(profile.budgetMinor,undefined);
});

test('CPL и CAC не показываются без своей доказанной связи с рекламой и оплаты', () => {
  const view=fixtures()['demo-north'];
  assert.match(metricDisplay(view,'cpl').value,/375/);
  assert.equal(metricDisplay(view,'cac').value,'Недостаточно данных');
  assert.equal(metricDisplay(view,'paidClients').value,'Недостаточно данных');
  view.environment='unconnected';
  assert.equal(metricDisplay(view,'spend').value,'Нет данных');
  view.overview.metrics.spend={value:1000};
  assert.equal(metricDisplay(view,'spend').value,'Нет данных');
});

test('неизвестный статус не превращается в успешный', () => {
  assert.equal(statusLabel('future-success-ish'),'Состояние не подтверждено');
  assert.equal(statusLabel('unknown'),'Результат неизвестен');
});

test('все варианты комбинаторного объявления сохраняются в предложении', () => {
  assert.deepEqual(buildAdPatch({Titles:'Заголовок 1\nЗаголовок 2',Texts:'Текст 1\nТекст 2'}),{Titles:['Заголовок 1','Заголовок 2'],Texts:['Текст 1','Текст 2']});
  assert.throws(() => buildAdPatch({Titles:'a',Texts:'1\n2\n3\n4'}), /от 1 до 3/);
  assert.throws(() => buildAdPatch({Titles:'Один',Texts:'Текст'},fixtures()['demo-north'].ads[0]), /сохранив их количество/);
});

test('поздний ответ прежней компании не отображается после переключения', async () => {
  let resolveNorth;
  const adapter={getCompanyView:(companyId) => companyId==='demo-north' ? new Promise((resolve) => { resolveNorth=resolve; }) : Promise.resolve(fixtures()['demo-south'])};
  const history=[];
  const controller=createCompanyController({adapter,companies:demoCompanies,onChange:(state) => history.push(state)});
  const first=controller.load('demo-north'); await controller.load('demo-south');
  resolveNorth(fixtures()['demo-north']); await first;
  assert.equal(controller.getState().companyId,'demo-south');
  assert.equal(controller.getState().view.companyId,'demo-south');
  const switchIndex=history.findIndex((state) => state.companyId==='demo-south');
  assert.ok(history.slice(switchIndex).every((state) => !state.view || state.view.companyId==='demo-south'));
});

test('поздний отказ записи A после переключения B сохраняет unknown A и не показывает его в B',async()=>{
  let rejectWrite;
  const views=fixtures();
  const adapter={getCompanyView:async(companyId)=>structuredClone(views[companyId]),saveProfile:()=>new Promise((_resolve,reject)=>{rejectWrite=reject;})};
  const controller=createCompanyController({adapter,companies:demoCompanies});
  await controller.load('demo-north');const pending=controller.act('saveProfile',{});
  await controller.load('demo-south');rejectWrite(new Error('timeout'));
  await pending;
  assert.equal(controller.getState().companyId,'demo-south');assert.equal(controller.getState().error,'');assert.equal(controller.getState().uncertain,false);
  await controller.load('demo-north');assert.equal(controller.getState().uncertain,true);
  await assert.rejects(controller.act('saveProfile',{}),/текущее состояние/);
});

test('возвращение A до окончания записи не разрешает параллельный повтор',async()=>{
  let rejectWrite;let calls=0;
  const views=fixtures();
  const adapter={getCompanyView:async(companyId)=>structuredClone(views[companyId]),saveProfile:()=>{calls++;return new Promise((_resolve,reject)=>{rejectWrite=reject;});}};
  const controller=createCompanyController({adapter,companies:demoCompanies});
  await controller.load('demo-north');const pending=controller.act('saveProfile',{});
  await controller.load('demo-south');await controller.load('demo-north');
  assert.equal(controller.getState().busy,true);
  await assert.rejects(controller.act('saveProfile',{}),/текущее состояние/);
  rejectWrite(new Error('timeout'));await pending;assert.equal(controller.getState().uncertain,true);assert.equal(calls,1);
});

test('неизвестный результат блокирует слепую повторную запись и скрывает внешнюю ошибку', async () => {
  let calls=0;
  const adapter={getCompanyView:async () => fixtures()['demo-north'],saveProfile:async () => {calls++;throw new Error('Authorization: Bearer SECRET_OTHER_COMPANY');}};
  const controller=createCompanyController({adapter,companies:demoCompanies});
  await controller.load('demo-north'); await controller.act('saveProfile',{});
  assert.equal(controller.getState().uncertain,true);
  assert.ok(!controller.getState().error.includes('SECRET'));
  await assert.rejects(controller.act('saveProfile',{}),/текущее состояние/);
  await controller.load('demo-north');
  assert.equal(controller.getState().uncertain,true,'Обычное чтение без сверки операции не снимает неопределённость');
  assert.equal(calls,1);
});

test('ответ неизвестной формы не выдаётся за сохранение', async () => {
  const adapter={getCompanyView:async () => fixtures()['demo-north'],saveProfile:async () => ({companyId:'demo-north',ok:true})};
  const controller=createCompanyController({adapter,companies:demoCompanies});
  await controller.load('demo-north'); await controller.act('saveProfile',{});
  assert.equal(controller.getState().message,''); assert.equal(controller.getState().uncertain,true);
});

test('успешная квитанция без совпавшего повторного чтения не становится успехом',async()=>{
  const adapter={getCompanyView:async()=>fixtures()['demo-north'],saveProfile:async()=>({companyId:'demo-north',outcome:'saved'})};
  const controller=createCompanyController({adapter,companies:demoCompanies});await controller.load('demo-north');
  const profile=buildProfile(controller.getState().view.profile,{services:'Новое',source:'Бриф',checkedAt:'2026-10-28'});
  await controller.act('saveProfile',profile);
  assert.equal(controller.getState().uncertain,true);assert.equal(controller.getState().message,'');
  assert.match(controller.getState().error,/не подтвердило ожидаемое/);
});

test('старое предложение с тем же patch не подтверждает создание нового ID и digest',async()=>{
  const view=fixtures()['demo-north'];const old=view.proposals[0];
  const adapter={getCompanyView:async()=>structuredClone(view),createProposal:async()=>({companyId:view.companyId,outcome:'saved',proposalId:'new-proposal',digest:'new-digest'})};
  const controller=createCompanyController({adapter,companies:demoCompanies});await controller.load(view.companyId);
  await controller.act('createProposal',{adId:old.adId,patch:old.patch,expiresAt:new Date(time+172800000).toISOString()});
  assert.equal(controller.getState().uncertain,true);assert.equal(controller.getState().message,'');
});

test('сохранённая серверная блокировка после сверки не выдается за снятое ограничение',async()=>{
  const view=fixtures()['demo-north'];view.jobs[0].status='reconciled_locked';
  const controller=createCompanyController({adapter:{getCompanyView:async()=>view},companies:demoCompanies});
  await controller.load('demo-north');assert.equal(controller.getState().uncertain,true);
  assert.match(statusLabel(view.jobs[0].status),/блокировка сохранена/);
});

test('проверенная сервером сверка конкретной операции снимает блокировку', async () => {
  let reconciled=false;
  const adapter={getCompanyView:async () => ({...fixtures()['demo-north'],...(reconciled ? {reconciliation:{status:'verified',operationId:'op-1'}}:{})}),saveProfile:async () => ({companyId:'demo-north',outcome:'unknown'})};
  const controller=createCompanyController({adapter,companies:demoCompanies});
  await controller.load('demo-north');await controller.act('saveProfile',{});reconciled=true;await controller.load('demo-north');
  assert.equal(controller.getState().uncertain,false);
});

test('нормализация не передаёт секреты, не теряет 64-битный ID и не выдумывает статистику', () => {
  const raw=rawView();raw.secretRef='private/vault/ref';raw.connection={secretRef:'secret',accessToken:'PRIVATE'};
  const view=normalizeServiceView(raw,'demo-north');
  assert.equal(view.ads[0].id,'1925418653941270479');
  assert.ok(!JSON.stringify(view).includes('PRIVATE'));assert.ok(!JSON.stringify(view).includes('secretRef'));
  assert.equal(metricDisplay(view,'spend').value,'Нет данных');
  raw.objects.ads[0].Id=1925418653941270479;
  assert.throws(() => normalizeServiceView(raw,'demo-north'),/потерянной точностью/);
});

test('shim не присваивает компанию посторонней кампании из смешанного ответа',()=>{
  const raw=rawView();raw.objects.campaigns.push({Id:'foreign',Name:'Чужая компания'});
  assert.throws(()=>normalizeServiceView(raw,'demo-north'),/не входит в привязки/);
});

test('сервисный adapter не позволяет прислать actor или переназначить компанию', async () => {
  const calls=[];
  const adapter=createServiceAdapter({invoke:async (method,args) => {calls.push({method,args});return {companyId:args.companyId,id:'record',digest:'version'};}});
  await assert.rejects(adapter.saveProfile('demo-north',{companyId:'demo-south'}),/другой компании/);
  assert.equal(calls.length,0);
  await adapter.saveBindings('demo-north',{campaignIds:['900'],counterIds:[]});
  assert.equal(calls[0].args.companyId,'demo-north');assert.equal(calls[0].args.actor,undefined);
});

test('неизменённые факты сохраняют разные источники и точные исходные даты',async()=>{
  const raw=rawView();raw.profile.businessFacts=[
    {kind:'services',value:'S',source:'source-A',verifiedAt:'2026-01-01T08:15:30.000Z'},
    {kind:'resultsSource',value:'P',source:'source-B',verifiedAt:'2026-10-01T14:45:00.000Z'},
  ];
  let sent;
  const adapter=createServiceAdapter({invoke:async(method,args)=>{sent=args.profile;return {companyId:args.companyId};}});
  const profile=normalizeServiceView(raw,raw.companyId).profile;
  assert.equal(profile.businessFacts.source,'','Разные источники не подменяются одним последним');
  const formProfile=buildProfile(profile,{...profile.businessFacts});
  await adapter.saveProfile(raw.companyId,formProfile);
  assert.deepEqual(sent.businessFacts,raw.profile.businessFacts);
});

test('новый provenance присваивается только отредактированному факту',async()=>{
  const raw=rawView();raw.profile.businessFacts=[
    {kind:'services',value:'S',source:'source-A',verifiedAt:'2026-01-01T08:15:30.000Z'},
    {kind:'resultsSource',value:'P',source:'source-B',verifiedAt:'2026-10-01T14:45:00.000Z'},
  ];
  let sent;
  const adapter=createServiceAdapter({invoke:async(_method,args)=>{sent=args.profile;return {companyId:args.companyId};}});
  const profile=normalizeServiceView(raw,raw.companyId).profile;
  const changed=buildProfile(profile,{...profile.businessFacts,services:'S2',source:'source-C',checkedAt:'2026-10-28'});
  await adapter.saveProfile(raw.companyId,changed);
  assert.deepEqual(sent.businessFacts.find((fact)=>fact.kind==='resultsSource'),raw.profile.businessFacts[1]);
  assert.deepEqual(sent.businessFacts.find((fact)=>fact.kind==='services'),{kind:'services',value:'S2',source:'source-C',verifiedAt:'2026-10-28T00:00:00.000Z'});
});

test('demo возвращает ID и версию именно созданного предложения',async()=>{
  const adapter=createSyntheticAdapter({now:()=>time});const view=await adapter.getCompanyView('demo-north');
  const payload={adId:view.ads[0].id,patch:{Titles:['Первый','Второй'],Texts:['Текст 1','Текст 2']},expiresAt:new Date(time+86400000).toISOString()};
  const controller=createCompanyController({adapter,companies:demoCompanies});await controller.load('demo-north');
  await controller.act('createProposal',payload);
  assert.equal(controller.getState().uncertain,false,controller.getState().error);
  assert.equal(controller.getState().view.proposals.length,2);
});

test('демонстрационный adapter изолирует две компании и не имеет внешнего исполнения', async () => {
  const adapter=createSyntheticAdapter({now:()=>time});
  assert.equal(adapter.beginConnection,undefined);assert.equal(adapter.enqueueProposal,undefined);
  const north=await adapter.getCompanyView('demo-north');
  await adapter.saveProfile('demo-north',buildProfile(north.profile,{services:'Учебная услуга',source:'Учебный бриф',checkedAt:'2026-10-28'}));
  assert.deepEqual((await adapter.getCompanyView('demo-south')).profile.businessFacts,{});
  assert.deepEqual((await createSyntheticAdapter({now:()=>time}).getCompanyView('demo-north')).profile.businessFacts,{});
  await assert.rejects(adapter.getCompanyView('arbitrary-company'),/не разрешена/);
});

test('DOM-представление экранирует серверный текст, варианты и атрибуты', async () => {
  const view=fixtures()['demo-north'];
  const payload='<img src=x onerror="alert(1)"><script>bad()</script>';
  view.profile.siteHosts=[payload];view.ads[0].responsiveAd.Titles=[payload];view.proposals[0].patch.Titles=[payload];
  const root={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;},replaceChildren(){}};
  const panel=mountYandexPanel(root,{adapter:{getCompanyView:async () => view},companies:demoCompanies,now:()=>time});
  await panel.ready;
  assert.ok(!root.innerHTML.includes('<img src=x'));assert.ok(!root.innerHTML.includes('<script>bad'));
  assert.ok(root.innerHTML.includes(escapeHtml(payload)));
  assert.ok(root.innerHTML.includes('Демонстрация'));assert.ok(root.innerHTML.includes('Яндекс не подключён'));
  assert.ok(root.innerHTML.includes('Состояние каждой')===false);
  panel.destroy();
});
