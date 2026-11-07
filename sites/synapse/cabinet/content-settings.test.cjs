const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
test('№181: поле таблицы есть в прежних настройках, сохраняется существующим API и закрыто для читателя',async()=>{
 for(const canEdit of [true,false]){
  const dom=new JSDOM('<main id="root"></main>',{runScripts:'outside-only',url:'https://sample.test'}),w=dom.window;let def,saved;
  const data={settings:{approverUserIds:[],shootingWeekdays:[],deadlineDays:2,platforms:[],caption:{font:'Inter',size:'m',color:'#ffffff',uppercase:false}},canEdit,candidates:[],options:{fonts:['Inter'],sizes:['m'],platforms:['vk']},version:1};
  w.SynapseModules={register:(name,d)=>{def=d}};w.eval(fs.readFileSync(path.join(__dirname,'content-settings.js'),'utf8'));
  const root=w.document.querySelector('#root');await def.mount(root,{signal:new w.AbortController().signal,settings:{content:{get:async()=>data,save:async(settings,version)=>{saved={settings,version};return {...data,settings,version:2}}}}});
  const field=root.querySelector('[name="contentPlanSheetUrl"]');assert.equal(field.disabled,!canEdit);
  if(canEdit){field.value='https://docs.google.com/spreadsheets/d/sample/edit';root.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(setImmediate);assert.equal(saved.settings.contentPlanSheetUrl,field.value);assert.equal(saved.version,1);}
  w.close();
 }
});

/* №208: Настройки → Контент-план → «Уведомления» — матрица «этап × роль», сохраняется сразу; со старым сервером не ломается. */
const ROLES=['owner','approver','content','shooting','editor'];
const MATRIX={script_review:['owner','approver'],script_rework:['content'],planned:['content','shooting'],shot:['content','editor'],
  edit_review:['approver','content'],edit_rework:['editor'],ready:['content'],published:ROLES,publish_error:['owner','content']};
const base=()=>({approverUserIds:[],shootingWeekdays:[2],deadlineDays:2,platforms:['vk'],caption:{font:'Inter',size:'m',color:'#ffffff',uppercase:false}});
async function open({oldServer=false,canEdit=true,path:routePath='notifications',save}={}){
  const dom=new JSDOM('<main id="root"></main>',{runScripts:'outside-only',url:'https://sample.test'}),w=dom.window;let def;const puts=[];
  let data={settings:{...base(),...(oldServer?{}:{notificationMatrix:JSON.parse(JSON.stringify(MATRIX))})},canEdit,candidates:[],options:{fonts:['Inter'],sizes:['m'],platforms:['vk']},version:4};
  w.SynapseModules={register:(name,d)=>{def=d}};w.eval(fs.readFileSync(path.join(__dirname,'content-settings.js'),'utf8'));
  const api={get:async()=>data,save:async(settings,version)=>{puts.push({settings:JSON.parse(JSON.stringify(settings)),version});
    if(save)return save(settings,version,data);
    if(oldServer&&'notificationMatrix' in settings)throw Object.assign(new Error('Ожидались поля approverUserIds, shootingWeekdays, deadlineDays, platforms, caption'),{status:400});
    data={...data,settings:{...settings,...(oldServer?{}:{notificationMatrix:settings.notificationMatrix||data.settings.notificationMatrix})},version:version+1};return data;}};
  const root=w.document.querySelector('#root');
  await def.mount(root,{signal:new w.AbortController().signal,companyName:'Пример',route:{path:routePath,params:new w.URLSearchParams()},settings:{content:api}});
  const box=(stage,role)=>root.querySelector(`[data-csn-matrix] input[data-stage="${stage}"][data-role="${role}"]`);
  const toggle=async(stage,role)=>{const b=box(stage,role);b.checked=!b.checked;b.dispatchEvent(new w.Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,5));};
  return {w,root,box,toggle,puts,status:()=>root.querySelector('[data-csn-status]').textContent};
}

test('№208: вкладка «Уведомления» — 9 этапов × 5 ролей, отметки по умолчанию с сервера',async()=>{
  const {root,box}=await open();
  assert.equal(root.querySelector('[data-csn-notify]').hidden,false,'адрес settings/content/notifications открывает вкладку');
  assert.equal(root.querySelector('form.cs-form').hidden,true);
  assert.equal(root.querySelectorAll('[data-csn-matrix] tbody tr').length,9);
  assert.equal(root.querySelectorAll('[data-csn-matrix] input[type="checkbox"]').length,45);
  assert.deepEqual([...root.querySelectorAll('[data-csn-matrix] thead .csn-long')].map(n=>n.textContent),['Владелец','Согласующий','Контент (СММ)','Съёмка','Монтажёр']);
  assert.equal(box('script_review','approver').checked,true);assert.equal(box('edit_review','approver').checked,true);
  assert.equal(box('shot','editor').checked,true);assert.equal(box('edit_rework','editor').checked,true);
  assert.equal(box('planned','shooting').checked,true);assert.equal(box('publish_error','owner').checked,true);
  for(const role of ROLES)assert.equal(box('published',role).checked,true,'всем — опубликовано');
  assert.equal(box('ready','approver').checked,false);
  assert.equal(root.querySelector('[data-csn-matrix] tbody tr:nth-child(3) th').textContent,'Сценарий согласован → Запланировано');
});

test('№208: галочка сохраняется сразу без кнопки, вместе с прежними настройками и текущей версией',async()=>{
  const {toggle,puts,status,root}=await open();
  assert.equal(root.querySelector('[data-csn-notify] button[type="submit"]'),null,'кнопки «Сохранить» у матрицы нет');
  await toggle('ready','approver');
  assert.equal(puts.length,1);assert.equal(puts[0].version,4);
  assert.deepEqual(puts[0].settings.notificationMatrix.ready,['approver','content'],'роли в каноническом порядке');
  assert.deepEqual(puts[0].settings.platforms,['vk'],'остальные настройки уходят без изменений');
  assert.match(status(),/Сохранено · версия 5/);
  await toggle('published','owner');
  assert.equal(puts[1].version,5,'следующее сохранение — с новой версией');
  assert.deepEqual(puts[1].settings.notificationMatrix.published,['approver','content','shooting','editor']);
});

test('№208: старый сервер отклоняет ключ — понятное сообщение, повторных запросов нет, основная форма сохраняет без матрицы',async()=>{
  const {toggle,puts,status,root,box,w}=await open({oldServer:true});
  assert.equal(box('script_review','approver').checked,true,'без матрицы на сервере — значения по умолчанию');
  await toggle('ready','owner');
  assert.equal(puts.length,1);assert.match(status(),/Сохранение заработает после обновления сервера/);
  await toggle('ready','editor');
  assert.equal(puts.length,1,'после отказа старого сервера запросы не повторяются');
  root.querySelector('[data-csn-tab="platforms"]').click();
  assert.equal(root.querySelector('form.cs-form').hidden,false);
  root.querySelector('form.cs-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,5));
  assert.equal(puts.length,2);assert.equal('notificationMatrix' in puts[1].settings,false,'основная форма не шлёт новый ключ старому серверу');
  assert.match(root.querySelector('.cs-actions .cs-status').textContent,/Сохранено · версия 5/);
});

test('№208: только просмотр — галочки выключены; конфликт версий — показываются актуальные отметки',async()=>{
  const ro=await open({canEdit:false});
  assert.ok([...ro.root.querySelectorAll('[data-csn-matrix] input')].every(n=>n.disabled));
  const conflict=await open({save:()=>{throw Object.assign(new Error('Настройки уже изменил другой пользователь'),{status:409});}});
  await conflict.toggle('ready','owner');await new Promise(r=>setTimeout(r,5));
  assert.equal(conflict.box('ready','owner').checked,false,'после конфликта — значения сервера');
  assert.match(conflict.status(),/изменил другой пользователь/);
  const main=await open({path:''});
  assert.equal(main.root.querySelector('form.cs-form').hidden,false,'без адреса вкладки открывается основная форма');
});

/* Макет 07.11: вкладки «Площадки · Участники · Уведомления»; одна форма и одно сохранение на «Площадки» и «Участники». */
test('макет 07.11: три вкладки по порядку, разделы на своих местах, сохранение прежнее',async()=>{
  const {root,w,puts}=await open({path:''});
  assert.deepEqual([...root.querySelectorAll('[data-csn-tab]')].map(n=>n.textContent),['Площадки','Участники','Уведомления']);
  const pane=id=>root.querySelector(`[data-cs-pane="${id}"]`);
  assert.equal(pane('platforms').hidden,false);assert.equal(pane('people').hidden,true);
  for(const name of ['platform','weekday','deadlineDays','contentPlanSheetUrl','font','size','color','uppercase'])assert.ok(pane('platforms').querySelector(`[name="${name}"]`),name+' — во вкладке «Площадки»');
  assert.ok(pane('people').querySelector('[data-cs-approvers]'),'кто согласует — во вкладке «Участники»');
  root.querySelector('[data-csn-tab="people"]').click();
  assert.equal(pane('people').hidden,false);assert.equal(pane('platforms').hidden,true);
  assert.equal(root.querySelector('form.cs-form').hidden,false);assert.ok(root.querySelector('.cs-actions .cs-save'),'кнопка «Сохранить» видна и в «Участниках»');
  root.querySelector('form.cs-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,5));
  assert.equal(puts.length,1);
  assert.deepEqual(Object.keys(puts[0].settings).sort(),['approverUserIds','caption','contentPlanSheetUrl','deadlineDays','platforms','shootingWeekdays']);
  root.querySelector('[data-csn-tab="notifications"]').click();
  assert.equal(root.querySelector('form.cs-form').hidden,true);assert.equal(root.querySelector('[data-csn-notify]').hidden,false);
  root.querySelector('[data-csn-goto="people"]').click();
  assert.equal(pane('people').hidden,false,'ссылка «Участники» из уведомлений открывает вкладку');
  const people=await open({path:'people'});
  assert.equal(people.root.querySelector('[data-cs-pane="people"]').hidden,false,'адрес settings/content/people');
});
