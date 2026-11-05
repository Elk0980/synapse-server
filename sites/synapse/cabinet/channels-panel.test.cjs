'use strict';
/* №149: «Подключение площадок» — один компонент cabinet.channelsPanel (autoposting.js), смонтированный на экране
   «Подключения» (content-connections.js). Тесты перенесены из autoposting.test.cjs / autoposting-daily.test.cjs /
   platform-links.test.cjs: та же логика ключей, профилей Onlypult, проверки доступа и прав. Сервер синтетический. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const scripts=['platform-links.js','company-information.js','autoposting.js','content-connections.js'].map(file=>fs.readFileSync(require.resolve('./'+file),'utf8'));
const clone=value=>JSON.parse(JSON.stringify(value)),tick=()=>new Promise(resolve=>setImmediate(resolve));
const channels=()=>[{id:'telegram',platform:'telegram',provider:'direct',name:'Telegram',target:'@fixture',revision:1,enabled:true,connected:true,tokenConfigured:true,caps:{maxText:4096,maxMedia:10}},{id:'vk',platform:'vk',provider:'direct',name:'ВКонтакте',target:'club1',revision:1,enabled:true,connected:true,tokenConfigured:true,caps:{maxText:15000,maxMedia:1,mediaMode:'link'}}];
const NAMES={alvi:'АЛВИ',avokado:'Авокадо'};
const connections=code=>({companyCode:code,days:14,checkedAt:'2026-11-05T05:00:00Z',platforms:[
  {id:'vk',label:'ВКонтакте',status:'yellow',statusText:'Частично',dataMode:'none',facts:[],next:'Ключ сообщества'},
  {id:'telegram_channel',label:'Telegram-канал',status:'red',statusText:'Не подключено',dataMode:'none',facts:[],next:'Токен бота'},
  {id:'youtube',label:'YouTube',status:'red',statusText:'Не подключено',dataMode:'none',facts:[],next:'Ключ Onlypult'},
  {id:'two_gis',label:'2ГИС',status:'red',statusText:'Не подключено',dataMode:'none',facts:[],next:''},
  {id:'metrika',label:'Яндекс Метрика',status:'red',statusText:'Не подключено',dataMode:'none',facts:[],next:'Доступ к API'}]});

async function fixture({role='owner',permissions=[],override,company='alvi'}={}){
  const dom=new JSDOM('<section id="view"></section>',{url:'https://cabinet.test/cabinet.html#content/connections',runScripts:'outside-only'}),w=dom.window,d=w.document,modules={},calls=[];
  const configs={alvi:{channels:channels(),timezone:'Asia/Irkutsk'},avokado:{channels:channels(),timezone:'Asia/Irkutsk'}};
  w.SbCabinet={registerView(){}};w.SynapseModules={register:(id,def)=>{modules[id]=def;}};scripts.forEach(source=>w.eval(source));
  const apiJson=async(path,code,method,body)=>{
    const call={url:`/content/${path}?companyCode=${code}`,path:'/content/'+path,code,method,options:body===undefined?{}:{body:JSON.stringify(body)}};calls.push(call);
    if(override){const result=await override(call);if(result!==undefined)return clone(result);}
    if(call.path==='/content/crm/company-information')return {companyCode:code,revision:2,profile:{name:code,timezone:'Asia/Irkutsk',socials:[{type:'two_gis',url:'https://2gis.ru/fixture'},{type:'vk',url:'https://vk.com/'+code}]}};
    if(call.path==='/content/crm/autoposting/settings'){if(method==='PUT'){for(const row of body.channels){const existing=configs[code].channels.find(item=>item.id===row.id);assert.equal(row.revision,existing.revision);const {token,...publicRow}=row;Object.assign(existing,publicRow,{revision:existing.revision+1,connected:false,tokenConfigured:!!token||existing.tokenConfigured});}}return clone(configs[code]);}
    if(call.path.endsWith('/profiles')){const id=call.path.split('/').at(-2);return {companyCode:code,channelId:id,revision:configs[code].channels.find(c=>c.id===id).revision,profiles:[{id:code+'-'+id,name:code+' '+id,platform:id,status:'active'}]};}
    if(call.path.endsWith('/check'))return {ok:true};
    throw Error('Unexpected '+call.path);
  };
  const f={w,d,calls,configs,modules,company:'',ctx:null,abort:null,
    node:id=>d.getElementById(id),status:()=>d.getElementById('autoposting-channels-status').textContent,
    settle:async()=>{for(let i=0;i<8;i++)await tick();},close:()=>w.close(),
    async mount({code=f.company||company,role:nextRole=role,permissions:nextPermissions=permissions}={}){
      f.abort?.abort();const abort=new w.AbortController();f.abort=abort;f.company=code;
      const can=p=>nextRole==='owner'||nextPermissions.includes(p);
      f.ctx={companyCode:code,companyName:NAMES[code]||code,user:{role:nextRole},permissions:nextPermissions,can,signal:abort.signal,
        crm:async(path,params)=>{calls.push({path,code:params.companyCode,method:'GET'});return connections(params.companyCode);},
        api:{get:path=>apiJson(path,code,'GET'),put:(path,body)=>apiJson(path,code,'PUT',body),post:(path,body)=>apiJson(path,code,'POST',body)}};
      const el=d.getElementById('view');const done=modules['content-connections'].mount(el,f.ctx);await f.settle();return done;
    },
    switchCompany:code=>f.mount({code}),
  };
  await f.mount({code:company});
  return f;
}
const card=(f,id='vk')=>f.node('autoposting-channels').querySelector(`[data-channel="${id}"]`);
function channelInput(f,field,value,{id='vk',event='change'}={}){
  const node=card(f,id).querySelector(`[data-channel-field="${field}"]`);
  if(node.type==='checkbox')node.checked=Boolean(value);else node.value=value;
  node.dispatchEvent(new f.w.Event(event,{bubbles:true}));return node;
}
async function connectOnlypultKey(f){
  channelInput(f,'provider','onlypult');
  channelInput(f,'token','op_'+'a'.repeat(64),{event:'input'});
  card(f).querySelector('button[type=submit]').click();await f.settle();
}

test('№149: блок виден сразу на «Подключениях» без свёрток, тем же компонентом; кнопка карточки ведёт к форме площадки',async()=>{
  const f=await fixture();try{
    const section=f.d.querySelector('[data-cc-channels]');assert.ok(section,'секция «Подключение площадок» есть');
    assert.equal(section.closest('details'),null,'не внутри свёртки');
    assert.ok(card(f,'telegram').querySelector('[data-channel-field=token]'),'токен Telegram');
    assert.ok(card(f,'vk').querySelector('[data-channel-field=token]'),'ключ ВК');
    assert.ok(card(f,'vk').querySelector('button[type=submit]'));assert.ok(card(f,'vk').querySelector('[data-check-channel]'));
    assert.equal(f.d.querySelector('.autoposting-connections'),null,'прежней свёртки «Постинга» нет');
    assert.match(f.node('vk-connection-guide').textContent,/ВКонтакте · АЛВИ/);
    const scrolled=[];f.w.HTMLElement.prototype.scrollIntoView=function(){scrolled.push(this);};
    const button=f.d.querySelector('[data-cc-platform="telegram_channel"] button[data-cc-setup]');
    assert.equal(button.textContent,'Подключить');assert.equal(button.dataset.ccChannel,'telegram');
    button.click();assert.equal(scrolled.at(-1)?.dataset.channel,'telegram');assert.equal(f.d.activeElement?.dataset.channelField,'target');
    const vkButton=f.d.querySelector('[data-cc-platform="vk"] button[data-cc-setup]');assert.equal(vkButton.textContent,'Настроить');
    assert.equal(f.d.querySelector('[data-cc-platform="two_gis"] a[data-cc-setup]').getAttribute('href'),'#platform-demand');
    assert.equal(f.d.querySelector('[data-cc-platform="metrika"] [data-cc-setup]'),null,'для Метрики поля ввода в ЛК нет — кнопки нет');
    assert.match(f.d.querySelector('[data-cc-platform="youtube"] .cc-next').textContent,/Что нужно: Ключ Onlypult/);
    assert.ok(f.calls.every(c=>c.method==='GET'));
  }finally{f.close();}
});

test('№149: только право аналитики — блока подключения и кнопок постинга нет; без прав — сообщение',async()=>{
  const f=await fixture({role:'marketer',permissions:['analytics.view']});try{
    assert.equal(f.d.querySelector('[data-cc-channels]'),null);assert.equal(f.d.querySelector('[data-cc-platform="vk"] [data-cc-setup]'),null);
    assert.ok(f.d.querySelector('[data-cc-platform="two_gis"] [data-cc-setup]'));
    assert.equal(f.calls.some(c=>c.path.includes('autoposting')),false,'настройки постинга не запрашиваются');
  }finally{f.close();}
  const none=await fixture({role:'marketer',permissions:[]});try{assert.match(none.d.body.textContent,/по праву/);assert.equal(none.calls.length,0);}finally{none.close();}
});

test('VK setup separates company reference from verified access and performs no writes',async()=>{
 const f=await fixture({override:call=>{
  if(call.path.endsWith('/company-information'))return {companyCode:call.code,revision:2,profile:{socials:[{type:'vk',url:'https://vk.ru/'+call.code}]}};
  if(call.path.endsWith('/autoposting/settings'))return {channels:[{id:'vk',platform:'vk',connected:false,enabled:false,tokenConfigured:false,revision:0}]};
 }});try{
  let guide=f.node('vk-connection-guide');assert.match(guide.textContent,/ВКонтакте · АЛВИ/);assert.match(guide.textContent,/Авторизация через кнопку ВК в Synapse пока не настроена/);
  assert.equal(guide.querySelector('a').href,'https://vk.ru/alvi');assert.ok(f.calls.every(c=>c.method==='GET'));
  await f.switchCompany('avokado');guide=f.node('vk-connection-guide');assert.ok(!guide.textContent.includes('https://vk.ru/alvi'));
  assert.match(guide.textContent,/ВКонтакте · Авокадо/);assert.equal(guide.querySelector('a').href,'https://vk.ru/avokado');
  assert.ok(!guide.querySelector('input[type=password]'));assert.ok(f.calls.every(c=>c.method==='GET'));
 }finally{f.close();}
});
test('VK setup does not turn a lookalike host into the community link',async()=>{
 const f=await fixture({override:call=>call.path.endsWith('/company-information')?{companyCode:call.code,revision:2,profile:{socials:[{type:'vk',url:'https://vk.ru.attacker.example/group'}]}}:undefined});
 try{assert.equal(f.node('vk-connection-guide').querySelector('a[target=_blank]'),null);assert.match(f.node('vk-connection-guide').textContent,/Доступ проверен/);}finally{f.close();}
});
test('VK access failure explains missing permission without exposing provider text',async()=>{
 const f=await fixture({override:call=>call.path.endsWith('/check')?{ok:false,code:'WALL_PERMISSION_REQUIRED',error:'RAW_SECRET'}:undefined});
 try{f.node('autoposting-channels').querySelector('[data-check-channel=vk]').click();await f.settle();assert.match(f.status(),/разрешение wall/);assert.ok(!f.d.body.textContent.includes('RAW_SECRET'));}finally{f.close();}
});
test('channel setup explains its own media rules and TikTok blocker without claiming every channel publishes public Shorts',async()=>{
 const ids=['youtube_shorts','instagram','tiktok','max'];
 const f=await fixture({override:call=>call.path.endsWith('/autoposting/settings')?{
  timezone:'Asia/Irkutsk',channels:ids.map(id=>({id,platform:id,provider:'onlypult',name:id,revision:1,enabled:false,connected:false,tokenConfigured:false}))
 }:undefined});
 try{
  const help=id=>f.node('autoposting-channels').querySelector(`[data-channel="${id}"] [data-channel-publishing-help]`).textContent;
  assert.match(help('youtube_shorts'),/один видеофайл.*Shorts в публичном доступе/);
  for(const id of ['instagram','tiktok','max'])assert.doesNotMatch(help(id),/Shorts|публичном доступе/);
  assert.match(help('instagram'),/истории и Reels/);assert.match(help('instagram'),/Reel — ровно одно видео/);
  assert.match(help('tiktok'),/Отправка пока заблокирована/);assert.match(help('tiktok'),/режимы видимости не подтверждены/);
  assert.match(help('max'),/Вложения необязательны/);
  assert.ok(f.calls.every(call=>call.method==='GET'));
 }finally{f.close();}
});
test('карточка подключения YouTube Shorts: только Onlypult, по умолчанию выключено, есть загрузка профилей, проверка и сохранение',async()=>{
  const list=[{id:'telegram',platform:'telegram',name:'Telegram',enabled:false,connected:true,revision:1,provider:'direct'},
    {id:'youtube_shorts',platform:'youtube_shorts',name:'YouTube Shorts',enabled:false,connected:false,revision:0,provider:'onlypult',target:'',caps:{maxText:5000,maxMedia:1,mediaMode:'video'}}];
  const f=await fixture({override:call=>call.path.endsWith('/settings')?{timezone:'Asia/Irkutsk',channels:list}:undefined});try{
    const node=card(f,'youtube_shorts');assert.ok(node,'карточка канала есть');
    assert.deepEqual([...node.querySelectorAll('[data-channel-field="provider"] option')].map(o=>o.value),['onlypult'],'прямого подключения в выборе нет');
    assert.equal(node.querySelector('[data-channel-field="enabled"]').checked,false,'по умолчанию отправка выключена');
    assert.ok(node.querySelector('[data-channel-field="name"]'));assert.ok(node.querySelector('[data-channel-field="target"]'));
    assert.ok(node.querySelector('[data-load-profiles="youtube_shorts"]'));assert.ok(node.querySelector('[data-check-channel="youtube_shorts"]'));assert.ok(node.querySelector('button[type="submit"]'));
    assert.match(node.textContent,/только через Onlypult/);assert.match(node.textContent,/заголовок|заголовка/i);
    assert.match(node.querySelector('h3').textContent,/YouTube Shorts/);assert.match(card(f,'telegram').querySelector('h3').textContent,/Telegram/);
    assert.ok(f.calls.every(call=>call.method==='GET'),'осмотр карточки ничего не сохраняет');
  }finally{f.close();}
});
test('read-only viewers see the forms disabled and cannot configure',async()=>{
  const f=await fixture({role:'marketer',permissions:['autoposting.view']});try{
    assert.equal(f.node('autoposting-channels').querySelector('input').disabled,true);assert.match(f.status(),/только для просмотра/);
    card(f,'telegram').querySelector('button[type=submit]').click();await f.settle();assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}
});
test('settings saves only the edited card, omits blank token, retains a failed key for retry, and check never publishes',async()=>{
  let fail=false;const f=await fixture({override:call=>{if(fail&&call.method==='PUT')throw Error('RAW_SECRET');}});try{
    let form=card(f,'telegram');form.querySelector('button[type=submit]').click();await f.settle();const first=f.calls.find(call=>call.method==='PUT'),body=JSON.parse(first.options.body);
    assert.equal(body.channels.length,1);assert.equal(body.channels[0].id,'telegram');assert.equal(body.channels[0].revision,1);assert.equal('token' in body.channels[0],false);
    assert.equal(f.w.SbCabinet.channelsRevision,1,'«Постинг» узнаёт об изменении по счётчику');
    form=card(f,'telegram');form.querySelector('[data-check-channel]').click();await f.settle();assert.ok(f.calls.some(call=>call.path.endsWith('/check')));assert.equal(f.calls.some(call=>call.path.endsWith('/schedule')),false);
    fail=true;form=card(f,'telegram');const token=form.querySelector('[type=password]');token.value='NEW_TEST_SECRET';form.querySelector('button[type=submit]').click();await f.settle();assert.equal(token.value,'NEW_TEST_SECRET');assert.doesNotMatch(f.d.body.textContent,/RAW_SECRET|NEW_TEST_SECRET/);
    fail=false;form.querySelector('button[type=submit]').click();await f.settle();assert.equal(JSON.parse(f.calls.filter(call=>call.method==='PUT').at(-1).options.body).channels[0].token,'NEW_TEST_SECRET');
    assert.equal(token.value,'');assert.equal(card(f,'telegram').querySelector('[type=password]').value,'');
  }finally{f.close();}
});
test('company switch clears credentials and ignores stale responses of the previous company',async()=>{
  let resolveOld;const f=await fixture({override:call=>call.code==='avokado'&&call.path.endsWith('/company-information')&&!resolveOld?new Promise(resolve=>{resolveOld=resolve;}):undefined});try{
    card(f,'vk').querySelector('[type=password]').value='TEMP_SECRET';
    const pending=f.switchCompany('avokado');await f.settle();assert.equal(f.d.querySelector('[type=password]')?.value||'','');
    const back=f.switchCompany('alvi');resolveOld({companyCode:'avokado',revision:2,profile:{name:'avokado',socials:[{type:'vk',url:'https://vk.com/avokado-late'}]}});await pending;await back;
    assert.equal(f.company,'alvi');assert.match(f.node('vk-connection-guide').textContent,/ВКонтакте · АЛВИ/);assert.ok(!f.d.body.textContent.includes('avokado-late'));
    assert.equal(card(f,'vk').querySelector('[type=password]').value,'');
  }finally{f.close();}
});
test('switching a provider clears the target, permission and unsaved key without changing saved settings',async()=>{
 const f=await fixture();try{
  const token=channelInput(f,'token','UNSAVED_TOKEN',{event:'input'});assert.equal(token.value,'UNSAVED_TOKEN');
  const before=f.calls.length;channelInput(f,'provider','onlypult');
  assert.equal(card(f).querySelector('[data-channel-field=target]').value,'');
  assert.equal(card(f).querySelector('[data-channel-field=enabled]').checked,false);
  assert.equal(card(f).querySelector('[type=password]').value,'');assert.equal(token.isConnected,false);
  assert.equal(f.configs.alvi.channels.find(c=>c.id==='vk').provider,'direct');assert.equal(f.calls.length,before);
  channelInput(f,'provider','direct');assert.equal(card(f).querySelector('[data-channel-field=target]').value,'');
  assert.equal(card(f).querySelector('[data-channel-field=enabled]').checked,false);assert.equal(f.calls.length,before);
 }finally{f.close();}
});
test('№149 (Влад 13:24): вставил ключ Onlypult и нажал «Загрузить профили» — ключ сохраняется сам, профили грузятся, ответ в карточке под кнопкой',async()=>{
 let reject=false;const f=await fixture({override:call=>{if(reject&&call.method==='PUT')throw Error('RAW_REJECTION');}});try{
  const cardStatus=()=>card(f).querySelector('[data-channel-status]').textContent;
  channelInput(f,'provider','onlypult');
  // Без ключа и без сохранённого — подсказка прямо в карточке, запросов нет.
  const before=f.calls.length;
  const unsavedDraft=f.calls.length;card(f).querySelector('[data-load-profiles]').click();await f.settle();
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,1,'черновик способа подключения сохраняется');assert.ok(f.calls.length>unsavedDraft);
  // Ключ вставлен, нажата только «Загрузить профили».
  const profileCalls=()=>f.calls.filter(c=>c.path.endsWith('/profiles')).length,seen=profileCalls();
  reject=true;let token=channelInput(f,'token','op_'+'e'.repeat(64),{event:'input'});card(f).querySelector('[data-load-profiles]').click();await f.settle();
  assert.match(cardStatus(),/Не удалось сохранить ключ/,'ошибка видна в карточке');assert.equal(token.value,'op_'+'e'.repeat(64),'ключ остаётся в поле');
  assert.doesNotMatch(f.d.body.textContent,/RAW_REJECTION|op_e{64}/);assert.equal(profileCalls(),seen,'после неудачного сохранения профили не запрашиваются');
  reject=false;card(f).querySelector('[data-load-profiles]').click();await f.settle();
  const put=f.calls.filter(c=>c.method==='PUT').at(-1),body=JSON.parse(put.options.body).channels[0];
  assert.equal(body.token,'op_'+'e'.repeat(64));assert.equal(body.provider,'onlypult');assert.equal(body.target,'');
  const listing=f.calls.at(-1);assert.equal(listing.path,'/content/crm/autoposting/settings/vk/profiles');assert.ok(f.calls.indexOf(put)<f.calls.indexOf(listing),'сначала сохранение, затем профили');
  assert.equal(card(f).querySelector('[type=password]').value,'');
  const select=card(f).querySelector('[data-channel-field=target]');assert.ok([...select.options].some(o=>o.value==='alvi-vk'),'список профилей заполнен');
  assert.equal(cardStatus(),'Выберите профиль этой компании, сохраните и проверьте доступ.');
  assert.equal(f.status(),cardStatus(),'то же сообщение и в общей строке блока');
  assert.ok(card(f).querySelector('.autoposting-actions + [data-channel-status]'),'сообщение стоит сразу под кнопками');
  assert.ok(before<f.calls.length);
 }finally{f.close();}
});
test('Onlypult setup saves a disabled empty target, lists profiles read-only, then saves the exact company profile',async()=>{
 const f=await fixture();try{
  await connectOnlypultKey(f);const first=f.calls.find(c=>c.method==='PUT'),body=JSON.parse(first.options.body).channels[0];
  assert.equal(first.code,'alvi');assert.equal(body.provider,'onlypult');assert.equal(body.target,'');assert.equal(body.enabled,false);
  assert.equal(body.revision,1);assert.equal(body.token,'op_'+'a'.repeat(64));assert.equal(card(f).querySelector('[type=password]').value,'');
  assert.match(f.status(),/Ключ сохранён.*Загрузите профили/);
  assert.equal(card(f).querySelector('[data-channel-field=enabled]').disabled,true);
  const before=f.calls.length;card(f).querySelector('[data-load-profiles]').click();await f.settle();
  assert.equal(f.calls.length,before+1);const listing=f.calls.at(-1);assert.equal(listing.path,'/content/crm/autoposting/settings/vk/profiles');assert.equal(listing.method,'GET');assert.equal(listing.code,'alvi');assert.equal(listing.options.body,undefined);
  const select=card(f).querySelector('[data-channel-field=target]');assert.equal(select.tagName,'SELECT');assert.ok([...select.options].some(o=>o.value==='alvi-vk'));
  assert.equal(card(f).querySelector('[data-channel-field=enabled]').disabled,true);
  channelInput(f,'target','alvi-vk');assert.equal(card(f).querySelector('[data-channel-field=enabled]').disabled,false);channelInput(f,'enabled',true);
  const checkCount=f.calls.length;card(f).querySelector('[data-check-channel]').click();await f.settle();assert.equal(f.calls.length,checkCount);
  card(f).querySelector('button[type=submit]').click();await f.settle();const second=f.calls.filter(c=>c.method==='PUT').at(-1),saved=JSON.parse(second.options.body).channels[0];
  assert.equal(saved.target,'alvi-vk');assert.equal(saved.enabled,true);assert.equal(saved.revision,2);assert.equal('token' in saved,false);
  assert.equal(f.configs.avokado.channels.find(c=>c.id==='vk').provider,'direct');
  card(f).querySelector('[data-check-channel]').click();await f.settle();
  assert.ok(f.calls.some(c=>c.path==='/content/crm/autoposting/settings/vk/check'&&c.method==='POST'&&c.code==='alvi'));
  assert.equal(f.calls.some(c=>c.path.includes('/posts')),false);
 }finally{f.close();}
});
test('Onlypult first save ignores a checked send flag without a profile and a rejected key remains available for retry',async()=>{
 let reject=true;const f=await fixture({override:call=>{if(reject&&call.method==='PUT')throw Error('RAW_PROVIDER_REJECTION');}});
 try{
  channelInput(f,'provider','onlypult');const enabled=card(f).querySelector('[data-channel-field=enabled]');
  assert.equal(enabled.disabled,true);enabled.click();assert.equal(enabled.checked,false);
  const token=channelInput(f,'token','op_'+'b'.repeat(64),{event:'input'});
  enabled.checked=true;card(f).querySelector('button[type=submit]').click();await f.settle();
  const rejected=JSON.parse(f.calls.find(c=>c.method==='PUT').options.body).channels[0];
  assert.equal(rejected.target,'');assert.equal(rejected.enabled,false);assert.equal(enabled.checked,false);
  assert.equal(token.value,'op_'+'b'.repeat(64));assert.equal(token.type,'password');assert.equal(token.disabled,false);
  assert.equal(f.configs.alvi.channels.find(c=>c.id==='vk').provider,'direct');
  assert.match(f.status(),/ключ остаётся в поле/);
  assert.doesNotMatch(f.d.body.textContent,/RAW_PROVIDER_REJECTION|op_b{64}/);assert.equal(f.w.localStorage.length,0);assert.equal(f.w.sessionStorage.length,0);
  card(f).querySelector('[data-load-profiles]').click();await f.settle();assert.equal(f.calls.some(c=>c.path.endsWith('/profiles')),false);
  reject=false;card(f).querySelector('button[type=submit]').click();await f.settle();
  assert.equal(token.value,'');assert.equal(card(f).querySelector('[type=password]').value,'');
  assert.equal(f.configs.alvi.channels.find(c=>c.id==='vk').provider,'onlypult');assert.equal(f.configs.alvi.channels.find(c=>c.id==='vk').enabled,false);
  assert.match(f.status(),/Ключ сохранён/);
  card(f).querySelector('[data-load-profiles]').click();await f.settle();
  channelInput(f,'target','alvi-vk');assert.equal(card(f).querySelector('[data-channel-field=enabled]').disabled,false);
  channelInput(f,'enabled',true);channelInput(f,'target','');
  assert.equal(card(f).querySelector('[data-channel-field=enabled]').disabled,true);assert.equal(card(f).querySelector('[data-channel-field=enabled]').checked,false);
 }finally{f.close();}
});
test('Onlypult setup does not claim a saved key unless the settings response confirms it',async()=>{
 const f=await fixture({override:call=>call.method==='PUT'?{companyCode:call.code,channels:[{...channels()[1],provider:'onlypult',target:'',enabled:false,tokenConfigured:false,connected:false,revision:2}]}:undefined});
 try{
  await connectOnlypultKey(f);assert.doesNotMatch(f.status(),/Ключ сохранён/);
  assert.match(f.status(),/Вставьте ключ Onlypult/);
  card(f).querySelector('[data-load-profiles]').click();await f.settle();assert.equal(f.calls.some(c=>c.path.endsWith('/profiles')),false);
 }finally{f.close();}
});
test('Onlypult empty profile diagnostics distinguish no profiles from unmatched platforms and use Russian count forms',async()=>{
 for(const [total,expected] of [[0,'не вернул профилей для этого ключа'],[1,'вернул 1 профиль,'],[2,'вернул 2 профиля,'],[5,'вернул 5 профилей,'],[11,'вернул 11 профилей,'],[21,'вернул 21 профиль,']]){
  const f=await fixture({override:call=>call.path.endsWith('/profiles')?{companyCode:call.code,profiles:[],diagnostics:{totalProfiles:total,platformCounts:total?[{platform:'vk_variant',count:total}]:[]}}:undefined});
  try{await connectOnlypultKey(f);card(f).querySelector('[data-load-profiles]').click();await f.settle();
   const status=f.status();assert.ok(status.includes(expected),status);
   if(total){assert.match(status,/для ВКонтакте подходящих профилей не найдено/);assert.ok(status.includes('Обозначения площадок: vk_variant — '+total));assert.doesNotMatch(status,/не вернул профилей для этого ключа/);}
   else assert.doesNotMatch(status,/Обозначения площадок/);
   assert.equal(card(f).querySelector('[data-channel-field=target]').options.length,1);assert.equal(card(f).querySelector('[data-channel-field=enabled]').disabled,true);
   assert.equal(f.calls.filter(call=>call.path.endsWith('/profiles')).length,1);
  }finally{f.close();}
 }
});
test('Onlypult empty Telegram results show the returned platform counts for the requested channel',async()=>{
 const f=await fixture({override:call=>call.path.endsWith('/profiles')?{companyCode:call.code,profiles:[],diagnostics:{totalProfiles:3,platformCounts:[{platform:'vk',count:2},{platform:'unknown',count:1}]}}:undefined});
 try{channelInput(f,'provider','onlypult',{id:'telegram'});channelInput(f,'token','op_'+'c'.repeat(64),{id:'telegram',event:'input'});card(f,'telegram').querySelector('button[type=submit]').click();await f.settle();
  card(f,'telegram').querySelector('[data-load-profiles]').click();await f.settle();
  assert.match(f.status(),/вернул 3 профиля, но для Telegram подходящих профилей не найдено/);
  assert.match(f.status(),/vk — 2, unknown — 1/);
  assert.equal(f.calls.at(-1).path,'/content/crm/autoposting/settings/telegram/profiles');
 }finally{f.close();}
});
test('Onlypult missing or invalid diagnostics keep an empty response message neutral',async()=>{
 for(const diagnostics of [undefined,{totalProfiles:'0'},{totalProfiles:-1},{totalProfiles:1001}]){
  const f=await fixture({override:call=>call.path.endsWith('/profiles')?{companyCode:call.code,profiles:[],diagnostics}:undefined});
  try{await connectOnlypultKey(f);card(f).querySelector('[data-load-profiles]').click();await f.settle();
   assert.match(f.status(),/В ответе Onlypult нет подходящих профилей/);
   assert.doesNotMatch(f.status(),/не вернул профилей для этого ключа|вернул 0|В Onlypult нет/);
   assert.equal(card(f).querySelector('[data-profile-diagnostics]').hidden,true);
  }finally{f.close();}
 }
});
test('Onlypult technical diagnostics show only safe shape types and field names and clear on company switch',async()=>{
 const diagnostics={totalProfiles:2,platformCounts:[{platform:'vk',count:2}],profileShapes:[{idType:'number',nameType:'string',statusType:'number',platformType:'undefined',count:1,fieldNames:['id','name','status','network_type']}],otherShapesCount:1};
 let release;const f=await fixture({override:call=>call.path.endsWith('/profiles')?{companyCode:call.code,profiles:[],diagnostics}:call.code==='avokado'&&call.path.endsWith('/company-information')?new Promise(resolve=>{release=resolve;}):undefined});
 try{await connectOnlypultKey(f);card(f).querySelector('[data-load-profiles]').click();await f.settle();
  const details=card(f).querySelector('[data-profile-diagnostics]');assert.equal(details.hidden,false);assert.equal(details.open,false);
  assert.match(details.textContent,/Технические сведения профилей/);assert.match(details.textContent,/id: number; name: string; status: number; platform: undefined/);
  assert.match(details.textContent,/Поля: id, name, status, network_type/);assert.match(details.textContent,/Профили с другой структурой: 1/);
  assert.equal(details.querySelectorAll('input,button').length,0);
  const switching=f.switchCompany('avokado');await f.settle();
  assert.equal(f.d.body.textContent.includes('network_type'),false);assert.equal(f.d.querySelector('[data-profile-diagnostics]'),null);
  release({companyCode:'avokado',revision:2,profile:{socials:[]}});await switching;
  assert.equal(f.d.body.textContent.includes('network_type'),false);assert.equal(f.company,'avokado');assert.match(f.node('vk-connection-guide').textContent,/ВКонтакте · Авокадо/);
 }finally{f.close();}
});
test('Onlypult malicious diagnostics never render markup or raw profile values',async()=>{
 const diagnostics={totalProfiles:1,platformCounts:[{platform:'<img src=x onerror=alert(1)>',count:1},{platform:'vk',count:'<script>attack</script>'}],profileShapes:[
  {idType:'number',nameType:'string',statusType:'null',platformType:'undefined',count:1,fieldNames:['network_type','<img src=x>','op_'+'d'.repeat(64)],id:'RAW_PRIVATE_ID',name:'RAW_PRIVATE_NAME',status:'RAW_PRIVATE_STATUS'},
  {idType:'<script>attack</script>',nameType:'string',statusType:'number',platformType:'string',count:1}
 ],raw:'RAW_SECRET',otherShapesCount:'<script>attack</script>'};
 const f=await fixture({override:call=>call.path.endsWith('/profiles')?{companyCode:call.code,profiles:[],diagnostics}:undefined});
 try{await connectOnlypultKey(f);card(f).querySelector('[data-load-profiles]').click();await f.settle();
  assert.match(f.status(),/unknown — 1/);assert.equal(card(f).querySelectorAll('img,script').length,0);
  const details=card(f).querySelector('[data-profile-diagnostics]');assert.equal(details.hidden,false);assert.match(details.textContent,/Поля: network_type/);
  assert.doesNotMatch(f.d.body.textContent,/RAW_PRIVATE|RAW_SECRET|<img|<script>|onerror|op_d{64}/);assert.equal(details.querySelectorAll('p').length,1);
  assert.equal(f.w.localStorage.length,0);assert.equal(f.w.sessionStorage.length,0);
  await f.mount({role:'editor',permissions:['autoposting.view','autoposting.edit']});
  assert.equal(card(f).querySelector('[data-profile-diagnostics]'),null);
 }finally{f.close();}
});
test('Onlypult nonempty profiles keep the selection flow without showing diagnostics',async()=>{
 const f=await fixture({override:call=>call.path.endsWith('/profiles')?{companyCode:call.code,profiles:[{id:'alvi-vk',name:'Profile',platform:'vk',status:'active'}],diagnostics:{totalProfiles:1,platformCounts:[{platform:'vk',count:1}],profileShapes:[{idType:'string',nameType:'string',statusType:'string',platformType:'string',count:1}]}}:undefined});
 try{await connectOnlypultKey(f);card(f).querySelector('[data-load-profiles]').click();await f.settle();
  assert.equal(f.status(),'Выберите профиль этой компании, сохраните и проверьте доступ.');assert.equal(card(f).querySelector('[data-profile-diagnostics]').hidden,true);
  channelInput(f,'target','alvi-vk');assert.equal(card(f).querySelector('[data-channel-field=enabled]').disabled,false);
 }finally{f.close();}
});
test('Onlypult profile labels are escaped and a response for another company cannot populate the selector',async()=>{
 let wrong=true;const f=await fixture({override:call=>call.path.endsWith('/profiles')?{companyCode:wrong?'avokado':call.code,profiles:[{id:'exact-vk-id',name:'<img src=x onerror=alert(1)>',platform:'vk',status:'active'}]}:undefined});
 try{await connectOnlypultKey(f);card(f).querySelector('[data-load-profiles]').click();await f.settle();
  assert.equal(card(f).querySelector('[data-channel-field=target]').options.length,1);assert.match(f.status(),/Не удалось загрузить/);
  wrong=false;card(f).querySelector('[data-load-profiles]').click();await f.settle();
  assert.equal(card(f).querySelector('img'),null);assert.match(card(f).querySelector('[data-channel-field=target]').textContent,/<img/);
  assert.equal(card(f).querySelector('[data-channel-field=target]').options[1].value,'exact-vk-id');
 }finally{f.close();}
});
test('Onlypult delayed profile response cannot overwrite another company or expose its profile names',async()=>{
 let release;const f=await fixture({override:call=>call.path.endsWith('/profiles')&&call.code==='alvi'?new Promise(resolve=>{release=resolve;}):undefined});
 try{await connectOnlypultKey(f);card(f).querySelector('[data-load-profiles]').click();await f.settle();assert.equal(typeof release,'function');
  await f.switchCompany('avokado');
  release({companyCode:'alvi',profiles:[{id:'alvi-private-profile',name:'ALVI PROFILE FROM PREVIOUS COMPANY',platform:'vk',status:'active'}]});await f.settle();
  assert.equal(f.company,'avokado');assert.equal(card(f).querySelector('[data-channel-field=provider]').value,'direct');
  assert.ok(!f.d.body.textContent.includes('ALVI PROFILE FROM PREVIOUS COMPANY'));
  assert.equal(f.calls.filter(c=>c.path.endsWith('/profiles')).length,1);
 }finally{f.close();}
});
test('Onlypult profile cache is removed on provider change and disabled viewers cannot load or configure it',async()=>{
 const f=await fixture();try{await connectOnlypultKey(f);card(f).querySelector('[data-load-profiles]').click();await f.settle();assert.equal(card(f).querySelector('[data-channel-field=target]').options.length,2);
  channelInput(f,'provider','direct');channelInput(f,'provider','onlypult');assert.equal(card(f).querySelector('[data-channel-field=target]').options.length,1);
 }finally{f.close();}
 const viewer=await fixture({role:'editor',permissions:['autoposting.view'],override:call=>call.path.endsWith('/settings')?{channels:[{...channels()[1],provider:'onlypult',target:'alvi-vk'}]}:undefined});
 try{assert.equal(card(viewer).querySelector('[data-channel-field=provider]').disabled,true);assert.equal(card(viewer).querySelector('[data-load-profiles]').disabled,true);
  card(viewer).querySelector('[data-load-profiles]').click();await viewer.settle();assert.equal(viewer.calls.some(c=>c.path.endsWith('/profiles')),false);
 }finally{viewer.close();}
});
test('company editors cannot configure owner-managed Onlypult or enumerate its profiles',async()=>{
 const f=await fixture({role:'editor',permissions:['autoposting.view','autoposting.edit'],override:call=>call.path.endsWith('/settings')&&call.method==='GET'?{channels:[channels()[0],{...channels()[1],provider:'onlypult',target:'alvi-vk'}],timezone:'Asia/Irkutsk'}:undefined});
 try{
  const onlypult=card(f),direct=card(f,'telegram');
  for(const field of onlypult.querySelectorAll('input,select,button'))assert.equal(field.disabled,!field.matches('[data-check-channel]'),field.outerHTML);
  assert.equal(direct.querySelector('[data-channel-field=provider]').disabled,false);
  assert.equal(direct.querySelector('[data-channel-field=provider] option[value=onlypult]').disabled,true);
  onlypult.querySelector('[data-load-profiles]').dispatchEvent(new f.w.MouseEvent('click',{bubbles:true}));
  onlypult.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await f.settle();
  assert.equal(f.calls.some(c=>c.path.endsWith('/profiles')||c.method==='PUT'),false);
  onlypult.querySelector('[data-check-channel]').click();await f.settle();
  assert.ok(f.calls.some(c=>c.path.endsWith('/settings/vk/check')&&c.method==='POST'));
 }finally{f.close();}
});
test('company pages, provider cabinet and planning links; switching clears old external links',async()=>{
 let release;
 const f=await fixture({override:call=>call.code==='avokado'&&call.path.endsWith('/company-information')?new Promise(resolve=>{release=resolve;}):
   call.path.endsWith('/autoposting/settings')?{companyCode:call.code,channels:[{id:'vk',platform:'vk',provider:'onlypult',name:'VK',target:'provider-profile',connected:true,enabled:false,revision:1}]}:undefined});
 try{
  assert.ok(f.d.querySelector('[data-channel-links] a[href="https://vk.com/alvi"]'));assert.ok(f.d.querySelector('[data-channel="vk"] a[href="https://app.ru.onlypult.com/"]'));
  assert.ok(f.d.querySelector('#autoposting-planning a[href="https://account.2gis.com/"]'));
  const next=f.switchCompany('avokado');await f.settle();
  assert.equal(f.d.querySelector('[data-channel-links] a'),null);assert.equal(f.d.getElementById('autoposting-planning').children.length,0);
  release({companyCode:'avokado',revision:2,profile:{name:'avokado',socials:[{type:'vk',url:'https://vk.com/avokado'}]}});await next;
  assert.ok(f.d.querySelector('[data-channel-links] a[href="https://vk.com/avokado"]'));assert.ok(f.calls.every(c=>c.method==='GET'));
 }finally{f.close();}
});
test('№149 (Влад 13:30): профили подписаны площадкой; выбранные в других проектах — отдельной группой, выбрать нельзя',async()=>{
 const f=await fixture({company:'avokado',override:call=>call.path.endsWith('/profiles')?{companyCode:call.code,profiles:[
   {id:'900001',name:'Алви',platform:'youtube_shorts',status:'active',takenBy:[{companyCode:'alvi',companyName:'АЛВИ'}]},
   {id:'900002',name:'Палитра-SAMPLE',platform:'youtube_shorts',status:'active',takenBy:[{companyCode:'palitra',companyName:'Палитра'}]},
   {id:'900003',name:'Авокадо',platform:'youtube_shorts',status:'active'},
   {id:'<img src=x>',name:'<script>x</script>',platform:'youtube_shorts',status:'inactive',takenBy:[{companyCode:'x',companyName:'<b>X</b>'}]}]}:
   call.path.endsWith('/autoposting/settings')&&call.method==='GET'?{channels:[{id:'youtube_shorts',platform:'youtube_shorts',provider:'onlypult',name:'YouTube Shorts',target:'',revision:1,enabled:false,connected:false,tokenConfigured:true}]}:undefined});
 try{
  card(f,'youtube_shorts').querySelector('[data-load-profiles]').click();await f.settle();
  const select=card(f,'youtube_shorts').querySelector('[data-channel-field=target]');
  const own=[...select.querySelectorAll(':scope > option')].filter(o=>o.value);
  assert.deepEqual(own.map(o=>o.textContent),['Авокадо · YouTube · 900003'],'в основном списке — только профиль без чужого проекта, с площадкой');
  const group=select.querySelector('optgroup');assert.equal(group.label,'Уже выбраны в других проектах');
  const foreign=[...group.querySelectorAll('option')];
  assert.match(foreign[0].textContent,/^Алви · YouTube · 900001 · проект АЛВИ$/);assert.match(foreign[1].textContent,/Палитра-SAMPLE · YouTube · 900002 · проект Палитра/);
  assert.ok(foreign.every(o=>o.disabled),'чужой профиль выбрать нельзя');
  assert.equal(select.querySelectorAll('img,script,b').length,0);assert.match(foreign[2].textContent,/<script>x<\/script> · YouTube · <img src=x> · требует подключения · проект <b>X<\/b>/);
  select.value='900003';select.dispatchEvent(new f.w.Event('change',{bubbles:true}));card(f,'youtube_shorts').querySelector('button[type=submit]').click();await f.settle();
  const saved=JSON.parse(f.calls.filter(c=>c.method==='PUT').at(-1).options.body).channels[0];assert.equal(saved.target,'900003');
 }finally{f.close();}
});
