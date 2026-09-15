const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const read = name => fs.readFileSync(require.resolve('./' + name), 'utf8');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function setupClient(query = async () => ({id: 42})) {
  const dom = new JSDOM('<div id="crm-contacts-content"></div>', {url:'https://example.test/cabinet.html#crm-contacts', runScripts:'outside-only'});
  const w = dom.window, calls = [], views = {};
  w.SbCabinet = {registerView: (name, descriptor) => views[name] = descriptor, pipelineStages:{stages:[],load:async()=>{}}};
  w.eval(read('clients.js').replace('Object.assign(api, { renderCrmEntityRoute,',
    'window.testClient = {renderEntityForm, saveEntityForm, companySummaryMarkup, renderRelationForm}; Object.assign(api, { renderCrmEntityRoute,')
    .replace('const renderEntityCard = async (view, id) => {',
      'const renderEntityCard = async () => { document.getElementById("crm-contacts-content").innerHTML = "<p data-card-status></p>"; }; const unusedCard = async (view, id) => {'));
  views.clients.render(null, {identity:{role:'owner'}, selectedProjectId:'alvi', escapeHTML:escape, navigate() {},
    hasPermission:()=>true, scopeParams:()=>({companyCode:'alvi'}), byId:id=>w.document.getElementById(id),
    csrfOptions:(method, body)=>({method, body:JSON.stringify(body)}),
    crmQuery:async (path, scope, options)=>{calls.push({path,scope,options});return query(path,scope,options);}});
  return {dom,w,calls,api:w.testClient};
}

test('new client form submits entered details to the current company and opens the saved record', async () => {
  const {dom,w,calls,api} = setupClient();
  await api.renderEntityForm('crm-contacts', null);
  const form = w.document.querySelector('form');
  form.elements.name.value = 'Анна'; form.elements.phone.value = '+79990000000'; form.elements.notes.value = 'Перезвонить вечером';
  await api.saveEntityForm({preventDefault(){},currentTarget:form}, 'crm-contacts', null);
  assert.equal(calls.length,1); assert.equal(calls[0].path,'/contacts');
  assert.equal(calls[0].scope.companyCode,'alvi'); assert.equal(calls[0].options.method,'POST');
  assert.equal(JSON.parse(calls[0].options.body).notes,'Перезвонить вечером');
  assert.equal(w.location.hash,'#crm-contacts/42'); dom.window.close();
});

test('editing a client PATCHes only changed details and preserves other contact channels', async () => {
  const {dom,w,calls,api} = setupClient();
  const record = {id:42,name:'Анна',phone:'+79990000000',messengers:[{type:'telegram',handle:'@anna'}],links:[]};
  await api.renderEntityForm('crm-contacts', record);
  const form = w.document.querySelector('form'); form.elements.phone.value = '+79990000001';
  await api.saveEntityForm({preventDefault(){},currentTarget:form}, 'crm-contacts', record);
  assert.equal(calls[0].path,'/contacts/42'); assert.equal(calls[0].options.method,'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body),{phone:'+79990000001'});
  assert.equal(w.document.querySelector('[data-card-status]').textContent,'Сохранено'); dom.window.close();
});

test('failed saves retain the form, display an error and allow retry; concurrent submits do not duplicate clients', async () => {
  let fail;
  const {dom,w,calls,api} = setupClient(()=>new Promise((_,reject)=>{fail=reject;}));
  await api.renderEntityForm('crm-contacts', null);
  const form = w.document.querySelector('form'); form.elements.name.value='Анна';
  const event = {preventDefault(){}, currentTarget:form};
  const first = api.saveEntityForm(event,'crm-contacts',null);
  await api.saveEntityForm(event,'crm-contacts',null); assert.equal(calls.length,1);
  fail(new Error('Нет соединения')); await first;
  assert.equal(form.elements.name.value,'Анна'); assert.equal(form.querySelector('[type=submit]').disabled,false);
  assert.equal(form.querySelector('[role=alert]').textContent,'Нет соединения'); dom.window.close();
});

test('company overview stays bounded with thousands of clients and links to the complete filtered list', () => {
  const {dom,w,api} = setupClient();
  const html=api.companySummaryMarkup({company:{id:7},contacts:Array.from({length:3103},(_,i)=>({id:i+1,name:'Клиент '+i}))});
  const d=new JSDOM(html).window.document;
  assert.equal(d.querySelector('.client-summary-section').querySelectorAll('li').length,5);
  assert.ok(d.querySelector('a[href="#crm-contacts?companyId=7"]'));
  assert.match(d.querySelector('h3').textContent,/3103/); dom.window.close();
});

test('every working cabinet view has four setup steps, without invented connection statuses', () => {
  const dom = new JSDOM('<section><header class="content-header"></header></section>', {runScripts:'outside-only'});
  dom.window.eval(read('module-guide.js'));
  const sb=dom.window.SbCabinet, container=dom.window.document.querySelector('section');
  const shell=fs.readFileSync(require.resolve('../cabinet.html'),'utf8');
  const views=[...shell.matchAll(/data-view="([a-z-]+)"/g)].map(m=>m[1]).filter(v=>v!=='access-denied');
  for(const view of views){
    assert.ok(sb.moduleGuides[view],view);
    sb.renderModuleGuide(container,view,{escapeHTML:escape,canView:()=>true,hasPermission:()=>true});
    assert.equal(container.querySelectorAll('.module-guide').length,1);
    assert.equal(container.querySelectorAll('li').length,4);
    assert.doesNotMatch(container.textContent,/Подключено|Готово/);
  }
  sb.renderModuleGuide(container,'crm-contacts',{escapeHTML:escape,canView:()=>true,hasPermission:()=>false});
  assert.equal(container.querySelector('a'),null,'view-only role does not see a create shortcut');
  dom.window.close();
});

test('new person and company are submitted together in one POST', async()=>{
  const {dom,w,calls,api}=setupClient(); await api.renderEntityForm('crm-contacts',null);
  const form=w.document.querySelector('form');form.elements.name.value='Анна';
  form.elements.companyMode.value='new';form.elements.companyMode.dispatchEvent(new w.Event('change'));
  form.elements.newCompanyName.value='Компания Анны';form.elements.newCompanyCity.value='Иркутск';form.elements.companyRole.value='Собственник';
  await api.saveEntityForm({preventDefault(){},currentTarget:form},'crm-contacts',null);
  assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0].options.body).companyLink,{newCompany:{name:'Компания Анны',city:'Иркутск'},role:'Собственник'});
  dom.window.close();
});

test('repeated company linking opens only one form, including while its options are loading',async()=>{
  let resolveQuery;
  const {dom,w,api,calls}=setupClient(()=>new Promise(resolve=>{resolveQuery=resolve;}));
  w.document.querySelector('#crm-contacts-content').innerHTML='<p data-card-status></p><div data-relations></div>';
  const relation={path:'companies',key:'companies',view:'crm-companies',flag:'isResponsible',flagLabel:'Ответственный'};
  const first=api.renderRelationForm('crm-contacts',{id:42},relation);
  await api.renderRelationForm('crm-contacts',{id:42},relation);assert.equal(calls.length,1);
  resolveQuery({companies:[{id:7,name:'Компания'}]});await first;
  const next=api.renderRelationForm('crm-contacts',{id:42},relation);
  resolveQuery({companies:[{id:7,name:'Компания'}]});await next;
  assert.equal(w.document.querySelectorAll('[data-relation-form]').length,1);dom.window.close();
});

test('existing company choice loads scoped options, blocks unfinished search and saves the selected ID',async()=>{
  const {dom,w,calls,api}=setupClient(async path=>path==='/companies'?{companies:[{id:7,name:'Компания',city:'Иркутск'}]}:{id:42});
  await api.renderEntityForm('crm-contacts',null);const form=w.document.querySelector('form');form.elements.name.value='Анна';
  form.elements.companyMode.value='existing';form.elements.companyMode.dispatchEvent(new w.Event('change'));
  await new Promise(resolve=>w.setTimeout(resolve,0));
  assert.equal(calls[0].scope.companyCode,'alvi');
  await api.saveEntityForm({preventDefault(){},currentTarget:form},'crm-contacts',null);
  assert.equal(calls.length,1);assert.match(form.querySelector('[role=alert]').textContent,/Выберите компанию/);
  form.elements.companyChoice.value='7';
  await api.saveEntityForm({preventDefault(){},currentTarget:form},'crm-contacts',null);
  assert.deepEqual(JSON.parse(calls[1].options.body).companyLink,{companyId:7,role:'Сотрудник'});dom.window.close();
});

test('a delayed previous client response cannot replace a newly opened create form', async () => {
  const dom=new JSDOM('<div id="crm-contacts-content"></div>',{url:'https://example.test/#crm-contacts',runScripts:'outside-only'});
  const w=dom.window, views={}; let finish;
  w.SbCabinet={registerView:(name,view)=>views[name]=view};
  w.eval(read('clients.js').replace('Object.assign(api, { renderCrmEntityRoute,',
    'window.testRace={renderEntityCard,renderEntityForm}; Object.assign(api, { renderCrmEntityRoute,'));
  views.clients.render(null,{identity:{role:'owner'},hasPermission:()=>true,navigate(){},escapeHTML:escape,
    byId:id=>w.document.getElementById(id),scopeParams:()=>({companyCode:'alvi'}),
    crmQuery:()=>new Promise(resolve=>{finish=resolve;})});
  const oldCard=w.testRace.renderEntityCard('crm-contacts',42);
  await w.testRace.renderEntityForm('crm-contacts',null);
  w.document.querySelector('input[name=name]').value='Не терять введённое имя';
  finish({id:42,name:'Предыдущий клиент'}); await oldCard;
  assert.equal(w.document.querySelector('h2').textContent,'Новый клиент');
  assert.equal(w.document.querySelector('input[name=name]').value,'Не терять введённое имя');
  dom.window.close();
});
