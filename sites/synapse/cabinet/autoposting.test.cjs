const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const scripts=['company-information.js','autoposting.js'].map(file=>fs.readFileSync(require.resolve('./'+file),'utf8'));
const clone=value=>JSON.parse(JSON.stringify(value)),tick=()=>new Promise(resolve=>setImmediate(resolve));
const channels=()=>[{id:'telegram',platform:'telegram',provider:'direct',name:'Telegram',target:'@fixture',revision:1,enabled:true,connected:true,tokenConfigured:true,caps:{maxText:4096,maxMedia:10}},{id:'vk',platform:'vk',provider:'direct',name:'ВКонтакте',target:'club1',revision:1,enabled:true,connected:true,tokenConfigured:true,caps:{maxText:15000,maxMedia:1,mediaMode:'link'}}];
test('VK setup separates company reference from verified access and performs no writes',async()=>{
 const f=await fixture({override:call=>{
  if(call.path.endsWith('/company-information'))return {companyCode:call.code,revision:2,profile:{socials:[{type:'vk',url:'https://vk.ru/'+call.code}]}};
  if(call.path.endsWith('/autoposting/settings'))return {channels:[{id:'vk',platform:'vk',connected:false,enabled:false,tokenConfigured:false,revision:0}]};
 }});try{
  const guide=f.node('vk-connection-guide');assert.match(guide.textContent,/ВКонтакте · АЛВИ/);assert.match(guide.textContent,/Авторизация через кнопку ВК в Synapse пока не настроена/);
  assert.equal(guide.querySelector('a').href,'https://vk.ru/alvi');assert.ok(f.calls.every(c=>c.method==='GET'));
  f.set('autoposting-company','avokado','change');assert.ok(!guide.textContent.includes('https://vk.ru/alvi'));await f.settle();
  assert.match(guide.textContent,/ВКонтакте · Авокадо/);assert.equal(guide.querySelector('a').href,'https://vk.ru/avokado');
  assert.ok(!guide.querySelector('input[type=password]'));assert.ok(f.calls.every(c=>c.method==='GET'));
 }finally{f.close();}
});
test('VK setup does not turn a lookalike host into the community link',async()=>{
 const f=await fixture({override:call=>call.path.endsWith('/company-information')?{companyCode:call.code,revision:2,profile:{socials:[{type:'vk',url:'https://vk.ru.attacker.example/group'}]}}:undefined});
 try{assert.equal(f.node('vk-connection-guide').querySelector('a[target=_blank]'),null);assert.match(f.node('vk-connection-guide').textContent,/Доступ проверен/);}finally{f.close();}
});
test('company selector delegates to cabinet workspace switch when available',async()=>{
 const f=await fixture();try{let chosen;f.ctx.chooseProject=code=>{chosen=code;};f.set('autoposting-company','avokado','change');assert.equal(chosen,'avokado');
  await f.views.autoposting.onProjectChange({...f.ctx,selectedProjectId:'avokado'});assert.match(f.node('vk-connection-guide').textContent,/ВКонтакте · Авокадо/);
 }finally{f.close();}
});
test('VK access failure explains missing permission without exposing provider text',async()=>{
 const f=await fixture({override:call=>call.path.endsWith('/check')?{ok:false,code:'WALL_PERMISSION_REQUIRED',error:'RAW_SECRET'}:undefined});
 try{f.node('autoposting-channels').querySelector('[data-check-channel=vk]').click();await f.settle();assert.match(f.node('autoposting-status').textContent,/разрешение wall/);assert.ok(!f.d.body.textContent.includes('RAW_SECRET'));}finally{f.close();}
});
async function fixture({role='owner',permissions=[],override,entries=[],starter=false}={}){
  const dom=new JSDOM('<section id="view"></section>',{url:'https://cabinet.test/',runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[],posts=clone(entries),configs={alvi:{channels:channels(),timezone:'Asia/Irkutsk'},avokado:{channels:channels(),timezone:'Asia/Irkutsk'}};
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};scripts.forEach(source=>w.eval(source));
  const plans=Object.fromEntries(['alvi','avokado'].map(code=>[code,{companyCode:code,available:starter,timezone:'Asia/Irkutsk',reviewNote:'Проверьте сведения и материалы',imports:{vk:null,telegram:null},
    topics:Array.from({length:7},(_,i)=>({id:code+'-'+i,title:code+' · Тема '+(i+1),goal:'Помочь выбрать услугу',dayOffset:i,localTime:'10:00',mediaBrief:'Фото этой компании'}))}]));
  const ctx={identity:{role,permissions,companies:[{id:'alvi',name:'АЛВИ'},{id:'avokado',name:'Авокадо'}]},selectedProjectId:'alvi',
    csrfOptions:(method,body)=>({method,headers:{'X-CSRF-Token':'test-csrf'},...(body===undefined?{}:{body:JSON.stringify(body)})}),
    apiJson:async(url,options={})=>{const parsed=new URL(url,'https://cabinet.test'),code=parsed.searchParams.get('companyCode'),call={url,path:parsed.pathname,code,method:options.method||'GET',options};calls.push(call);
      if(override){const result=await override(call);if(result!==undefined)return clone(result);}
      if(call.path==='/content/publishing-assets')return {url:'https://assets.example.test/photo.png'};
      if(call.path==='/content/crm/company-information')return {companyCode:code,revision:2,profile:{name:code,timezone:'Asia/Irkutsk',socials:[{type:'two_gis',url:'https://2gis.ru/fixture'}]}};
      if(call.path==='/content/crm/autoposting/settings'){if(call.method==='PUT'){const body=JSON.parse(options.body);for(const row of body.channels){const existing=configs[code].channels.find(item=>item.id===row.id);assert.equal(row.revision,existing.revision);const {token,...publicRow}=row;Object.assign(existing,publicRow,{revision:existing.revision+1,connected:false,tokenConfigured:!!token||existing.tokenConfigured});}}return clone(configs[code]);}
      if(call.path.endsWith('/profiles')){const id=call.path.split('/').at(-2);return {companyCode:code,channelId:id,revision:configs[code].channels.find(c=>c.id===id).revision,profiles:[{id:code+'-'+id,name:code+' '+id,platform:id,status:'active'}]};}
      if(call.path==='/content/crm/autoposting/starter-plan'){
        if(call.method==='POST'){const body=JSON.parse(options.body);assert.equal(body.profileRevision,2);assert.ok(['vk','telegram'].includes(body.platform));
          if(!plans[code].imports[body.platform]){const ids=[];for(let i=0;i<7;i++){const id=posts.reduce((max,p)=>Math.max(max,p.id),0)+1;ids.push(id);posts.push({id,companyCode:code,title:code+' '+body.platform+' '+(i+1),text:'Текст для '+code,revision:1,status:'draft',mediaUrls:[],platformIds:[],scheduledAt:null,timezone:'Asia/Irkutsk',profileRevision:2,deliveries:[]});}plans[code].imports[body.platform]={postIds:ids};}
        }return clone(plans[code]);
      }
      if(call.path.endsWith('/check'))return {ok:true};
      if(call.path==='/content/crm/autoposting/posts'){if(call.method==='POST'){const item={id:posts.length+1,companyCode:code,revision:1,status:'draft',deliveries:[],...JSON.parse(options.body)};posts.push(item);return clone(item);}return {companyCode:code,posts:clone(posts.filter(item=>item.companyCode===code))};}
      const match=call.path.match(/\/posts\/(\d+)(?:\/(schedule|cancel|reconcile))?$/);assert.ok(match,call.path);const item=posts.find(item=>item.id===Number(match[1])&&item.companyCode===code),body=JSON.parse(options.body);assert.ok(item);assert.equal(body.revision,item.revision);
      if(match[2]==='reconcile'){item.lastErrorCode='PROVIDER_LINK_UNAVAILABLE';for(const delivery of item.deliveries)if(delivery.providerPostId){delivery.providerStatus='published';delivery.errorCode='PROVIDER_LINK_UNAVAILABLE';}}
      else if(match[2])item.status=match[2]==='schedule'?'scheduled':'cancelled';else Object.assign(item,body);item.revision++;return clone(item);
    }};
  await views.autoposting.render(d.getElementById('view'),ctx);
  const f={w,d,ctx,views,calls,posts,configs,plans,node:id=>d.getElementById(id),settle:async()=>{for(let i=0;i<8;i++)await tick();},set(id,value,type='input'){const node=f.node(id);node.value=value;node.dispatchEvent(new w.Event(type,{bubbles:true}));},async click(id){f.node(id).click();await f.settle();},close:()=>w.close()};return f;
}
function fill(f,{text='Текст публикации',media=''}={}){
  f.set('autoposting-title','Тестовый материал');f.set('autoposting-text',text);f.set('autoposting-media',media);f.set('autoposting-date','2099-01-01T10:00');
  const checkbox=f.node('autoposting-platforms').querySelector('[value=telegram]');checkbox.click();
}
test('autoposting is permission scoped and read-only viewers cannot mutate or configure',async()=>{
  for(const permissions of [[],['autoposting.view']]){const f=await fixture({role:'marketer',permissions});try{assert.equal(!!f.node('autoposting-form'),!!permissions.length);if(permissions.length){assert.equal(f.node('autoposting-title').disabled,true);assert.equal(f.node('autoposting-channels').querySelector('input').disabled,true);}assert.ok(f.calls.every(call=>call.method==='GET'));}finally{f.close();}}
});
test('explicit save converts company local time to UTC; preview and separate schedule are required',async()=>{
  const f=await fixture();try{fill(f);assert.ok(f.calls.every(call=>call.method==='GET'));await f.click('autoposting-save');const create=f.calls.find(call=>call.method==='POST');
    assert.equal(JSON.parse(create.options.body).scheduledAt,'2099-01-01T02:00:00.000Z');assert.equal(JSON.parse(create.options.body).profileRevision,2);assert.equal(create.options.headers['X-CSRF-Token'],'test-csrf');
    assert.match(f.node('autoposting-form-status').textContent,/Черновик сохранён/);
    let scrolled;f.node('autoposting-preview-title').scrollIntoView=options=>{scrolled=options;};
    assert.equal(f.node('autoposting-schedule').disabled,true);await f.click('autoposting-preview');assert.equal(f.node('autoposting-schedule').disabled,false);
    assert.equal(f.d.activeElement,f.node('autoposting-preview-title'));assert.equal(scrolled.block,'start');
    f.set('autoposting-text','Изменение');assert.equal(f.node('autoposting-schedule').disabled,true);await f.click('autoposting-save');await f.click('autoposting-preview');await f.click('autoposting-schedule');
    assert.equal(f.posts[0].status,'scheduled');assert.equal(f.calls.filter(call=>call.path.endsWith('/schedule')).length,1);
    f.set('autoposting-month','2099-01','change');assert.ok(f.node('autoposting-calendar').querySelector('[data-calendar-date="2099-01-01"] span'));
  }finally{f.close();}
});
test('Telegram media caption and VK link caps block scheduling; preview escapes text and rejects unsafe material URLs',async()=>{
  const f=await fixture();try{fill(f,{text:'x'.repeat(1025),media:'https://assets.example.test/a.png'});await f.click('autoposting-save');await f.click('autoposting-preview');assert.match(f.node('autoposting-preview-content').textContent,/1024/);assert.equal(f.node('autoposting-schedule').disabled,true);
    f.set('autoposting-text','<script>bad()</script>');f.set('autoposting-media','javascript:alert(1)');await f.click('autoposting-save');assert.equal(f.calls.filter(call=>call.method==='PATCH').length,0);
    f.set('autoposting-media','https://assets.example.test/a.png\nhttps://assets.example.test/b.png');f.node('autoposting-platforms').querySelector('[value=vk]').click();await f.click('autoposting-save');await f.click('autoposting-preview');
    assert.equal(f.node('autoposting-preview-content').querySelector('script'),null);assert.match(f.node('autoposting-preview-content').textContent,/не больше 1/);
  }finally{f.close();}
});
test('settings saves only the edited card, omits blank token, retains a failed key for retry, and check never publishes',async()=>{
  let fail=false;const f=await fixture({override:call=>{if(fail&&call.method==='PUT')throw Error('RAW_SECRET');}});try{
    let form=f.node('autoposting-channels').querySelector('[data-channel=telegram]');form.querySelector('button[type=submit]').click();await f.settle();const first=f.calls.find(call=>call.method==='PUT'),body=JSON.parse(first.options.body);
    assert.equal(body.channels.length,1);assert.equal(body.channels[0].id,'telegram');assert.equal(body.channels[0].revision,1);assert.equal('token' in body.channels[0],false);
    form=f.node('autoposting-channels').querySelector('[data-channel=telegram]');form.querySelector('[data-check-channel]').click();await f.settle();assert.ok(f.calls.some(call=>call.path.endsWith('/check')));assert.equal(f.calls.some(call=>call.path.endsWith('/schedule')),false);
    fail=true;form=f.node('autoposting-channels').querySelector('[data-channel=telegram]');const token=form.querySelector('[type=password]');token.value='NEW_TEST_SECRET';form.querySelector('button[type=submit]').click();await f.settle();assert.equal(token.value,'NEW_TEST_SECRET');assert.doesNotMatch(f.d.body.textContent,/RAW_SECRET|NEW_TEST_SECRET/);
    fail=false;form.querySelector('button[type=submit]').click();await f.settle();assert.equal(JSON.parse(f.calls.filter(call=>call.method==='PUT').at(-1).options.body).channels[0].token,'NEW_TEST_SECRET');
    assert.equal(token.value,'');assert.equal(f.node('autoposting-channels').querySelector('[data-channel=telegram] [type=password]').value,'');
  }finally{f.close();}
});
test('company switch preserves unfinished draft fields but clears credentials and ignores stale responses',async()=>{
  let resolveOld;const f=await fixture({override:call=>call.code==='avokado'&&call.path.endsWith('/posts')&&!resolveOld?new Promise(resolve=>{resolveOld=resolve;}):undefined});try{
    f.set('autoposting-title','Черновик АЛВИ');f.set('autoposting-timezone','unfinished/zone');f.node('autoposting-channels').querySelector('[type=password]').value='TEMP_SECRET';
    const old=f.views.autoposting.onProjectChange({...f.ctx,selectedProjectId:'avokado'});await f.settle();await f.views.autoposting.onProjectChange(f.ctx);resolveOld({companyCode:'avokado',posts:[]});await old;
    assert.equal(f.node('autoposting-company').value,'alvi');assert.equal(f.node('autoposting-title').value,'Черновик АЛВИ');assert.equal(f.node('autoposting-timezone').value,'unfinished/zone');assert.equal(f.node('autoposting-channels').querySelector('[type=password]').value,'');
  }finally{f.close();}
});
test('photo selection alone does not upload, explicit upload adds HTTPS photo to draft without publication',async()=>{
  const f=await fixture();try{const photo=new f.w.File(['fixture-image'],'photo.webp',{type:'image/webp'});Object.defineProperty(f.node('autoposting-photo'),'files',{value:[photo]});assert.equal(f.calls.some(call=>call.path.includes('publishing-assets')),false);
    await f.click('autoposting-upload');const call=f.calls.find(call=>call.path.includes('publishing-assets'));assert.equal(call.code,'alvi');assert.equal(call.options.body,photo);assert.equal(f.node('autoposting-media').value,'https://assets.example.test/photo.png');assert.equal(f.calls.some(call=>call.path.endsWith('/posts')&&call.method==='POST'),false);
  }finally{f.close();}
});
test('uncertain or partially published materials expose safe platform result links and block accidental duplicate planning',async()=>{
  const f=await fixture({entries:[{id:4,companyCode:'alvi',revision:3,status:'needs_review',title:'Часть опубликована',text:'Текст',mediaUrls:[],platformIds:['telegram'],scheduledAt:'2099-01-01T02:00:00Z',timezone:'Asia/Irkutsk',profileRevision:2,lastErrorCode:'PUBLICATION_UNCERTAIN',deliveries:[{channelId:'telegram',status:'published',url:'https://t.me/fixture/123'},{channelId:'vk',status:'needs_review',url:'javascript:alert(1)'}]}]});
  try{f.set('autoposting-select','4','change');assert.equal(f.node('autoposting-save').disabled,true);await f.click('autoposting-preview');assert.equal(f.node('autoposting-schedule').disabled,true);
    assert.match(f.node('autoposting-post-error').textContent,/провер/iu);assert.equal(f.node('autoposting-deliveries').querySelectorAll('a').length,1);
    assert.equal(f.node('autoposting-deliveries').querySelector('a').href,'https://t.me/fixture/123');assert.equal(f.calls.some(call=>call.method!=='GET'),false);
  }finally{f.close();}
});

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
const receiptPost=(code='alvi')=>({id:55,companyCode:code,revision:3,status:'needs_review',title:'Задание принято Onlypult',text:'Подтверждённый текст',mediaUrls:[],platformIds:['vk'],scheduledAt:'2099-01-01T02:00:00Z',timezone:'Asia/Irkutsk',profileRevision:2,lastErrorCode:'PROVIDER_PENDING',deliveries:[{channelId:'vk',status:'needs_review',providerPostId:'job-55',providerStatus:'scheduled',externalId:null,url:null}]});

test('switching a provider clears the target, permission and unsaved key without changing saved settings',async()=>{
 const f=await fixture();try{
  const token=channelInput(f,'token','UNSAVED_TOKEN',{event:'input'});assert.equal(token.value,'UNSAVED_TOKEN');
  const before=f.calls.length;channelInput(f,'provider','onlypult');
  assert.equal(card(f).querySelector('[data-channel-field=target]').value,'');
  assert.equal(card(f).querySelector('[data-channel-field=enabled]').checked,false);
  assert.equal(card(f).querySelector('[type=password]').value,'');assert.equal(token.isConnected,false);
  assert.equal(f.configs.alvi.channels.find(c=>c.id==='vk').provider,'direct');assert.equal(f.calls.length,before);
  card(f).querySelector('[data-load-profiles]').click();await f.settle();assert.equal(f.calls.length,before);
  assert.match(f.node('autoposting-status').textContent,/Сначала сохраните/);
  channelInput(f,'provider','direct');assert.equal(card(f).querySelector('[data-channel-field=target]').value,'');
  assert.equal(card(f).querySelector('[data-channel-field=enabled]').checked,false);assert.equal(f.calls.length,before);
 }finally{f.close();}
});

test('Onlypult setup saves a disabled empty target, lists profiles read-only, then saves the exact company profile',async()=>{
 const f=await fixture();try{
  await connectOnlypultKey(f);const first=f.calls.find(c=>c.method==='PUT'),body=JSON.parse(first.options.body).channels[0];
  assert.equal(first.code,'alvi');assert.equal(body.provider,'onlypult');assert.equal(body.target,'');assert.equal(body.enabled,false);
  assert.equal(body.revision,1);assert.equal(body.token,'op_'+'a'.repeat(64));assert.equal(card(f).querySelector('[type=password]').value,'');
  assert.match(f.node('autoposting-status').textContent,/Ключ сохранён.*Загрузите профили/);
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
  assert.equal(f.calls.some(c=>c.path.includes('/posts')&&c.method!=='GET'),false);
 }finally{f.close();}
});

test('Onlypult first save ignores a checked send flag without a profile and a rejected key remains available for retry',async()=>{
 let reject=true;const f=await fixture({override:call=>{if(reject&&call.method==='PUT')throw Error('RAW_PROVIDER_REJECTION');}});
 try{
  channelInput(f,'provider','onlypult');const enabled=card(f).querySelector('[data-channel-field=enabled]');
  assert.equal(enabled.disabled,true);enabled.click();assert.equal(enabled.checked,false);
  const token=channelInput(f,'token','op_'+'b'.repeat(64),{event:'input'});
  // A stale or restored checkbox must not prevent saving the key before profile selection.
  enabled.checked=true;card(f).querySelector('button[type=submit]').click();await f.settle();
  const rejected=JSON.parse(f.calls.find(c=>c.method==='PUT').options.body).channels[0];
  assert.equal(rejected.target,'');assert.equal(rejected.enabled,false);assert.equal(enabled.checked,false);
  assert.equal(token.value,'op_'+'b'.repeat(64));assert.equal(token.type,'password');assert.equal(token.disabled,false);
  assert.equal(f.configs.alvi.channels.find(c=>c.id==='vk').provider,'direct');
  assert.match(f.node('autoposting-status').textContent,/ключ остаётся в поле/);
  assert.doesNotMatch(f.d.body.textContent,/RAW_PROVIDER_REJECTION|op_b{64}/);assert.equal(f.w.localStorage.length,0);assert.equal(f.w.sessionStorage.length,0);
  card(f).querySelector('[data-load-profiles]').click();await f.settle();assert.equal(f.calls.some(c=>c.path.endsWith('/profiles')),false);
  reject=false;card(f).querySelector('button[type=submit]').click();await f.settle();
  assert.equal(token.value,'');assert.equal(card(f).querySelector('[type=password]').value,'');
  assert.equal(f.configs.alvi.channels.find(c=>c.id==='vk').provider,'onlypult');assert.equal(f.configs.alvi.channels.find(c=>c.id==='vk').enabled,false);
  assert.match(f.node('autoposting-status').textContent,/Ключ сохранён/);
  card(f).querySelector('[data-load-profiles]').click();await f.settle();
  channelInput(f,'target','alvi-vk');assert.equal(card(f).querySelector('[data-channel-field=enabled]').disabled,false);
  channelInput(f,'enabled',true);channelInput(f,'target','');
  assert.equal(card(f).querySelector('[data-channel-field=enabled]').disabled,true);assert.equal(card(f).querySelector('[data-channel-field=enabled]').checked,false);
  assert.equal(f.calls.some(c=>c.path.includes('/posts')&&c.method!=='GET'),false);
 }finally{f.close();}
});

test('Onlypult setup does not claim a saved key unless the settings response confirms it',async()=>{
 const f=await fixture({override:call=>call.method==='PUT'?{companyCode:call.code,channels:[{...channels()[1],provider:'onlypult',target:'',enabled:false,tokenConfigured:false,connected:false,revision:2}]}:undefined});
 try{
  await connectOnlypultKey(f);assert.doesNotMatch(f.node('autoposting-status').textContent,/Ключ сохранён/);
  assert.match(f.node('autoposting-status').textContent,/Вставьте ключ Onlypult/);
  card(f).querySelector('[data-load-profiles]').click();await f.settle();assert.equal(f.calls.some(c=>c.path.endsWith('/profiles')),false);
 }finally{f.close();}
});

test('Onlypult profile labels are escaped and a response for another company cannot populate the selector',async()=>{
 let wrong=true;const f=await fixture({override:call=>call.path.endsWith('/profiles')?{companyCode:wrong?'avokado':call.code,profiles:[{id:'exact-vk-id',name:'<img src=x onerror=alert(1)>',platform:'vk',status:'active'}]}:undefined});
 try{await connectOnlypultKey(f);card(f).querySelector('[data-load-profiles]').click();await f.settle();
  assert.equal(card(f).querySelector('[data-channel-field=target]').options.length,1);assert.match(f.node('autoposting-status').textContent,/Не удалось загрузить/);
  wrong=false;card(f).querySelector('[data-load-profiles]').click();await f.settle();
  assert.equal(card(f).querySelector('img'),null);assert.match(card(f).querySelector('[data-channel-field=target]').textContent,/<img/);
  assert.equal(card(f).querySelector('[data-channel-field=target]').options[1].value,'exact-vk-id');
 }finally{f.close();}
});

test('Onlypult delayed profile response cannot overwrite another company or expose its profile names',async()=>{
 let release;const f=await fixture({override:call=>call.path.endsWith('/profiles')&&call.code==='alvi'?new Promise(resolve=>{release=resolve;}):undefined});
 try{await connectOnlypultKey(f);card(f).querySelector('[data-load-profiles]').click();await f.settle();assert.equal(typeof release,'function');
  await f.views.autoposting.onProjectChange({...f.ctx,selectedProjectId:'avokado'});
  release({companyCode:'alvi',profiles:[{id:'alvi-private-profile',name:'ALVI PROFILE FROM PREVIOUS COMPANY',platform:'vk',status:'active'}]});await f.settle();
  assert.equal(f.node('autoposting-company').value,'avokado');assert.equal(card(f).querySelector('[data-channel-field=provider]').value,'direct');
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

test('company editors can edit materials but cannot configure owner-managed Onlypult or enumerate its profiles',async()=>{
 const f=await fixture({role:'editor',permissions:['autoposting.view','autoposting.edit'],override:call=>call.path.endsWith('/settings')&&call.method==='GET'?{channels:[channels()[0],{...channels()[1],provider:'onlypult',target:'alvi-vk'}],timezone:'Asia/Irkutsk'}:undefined});
 try{
  const onlypult=card(f),direct=card(f,'telegram');
  for(const field of onlypult.querySelectorAll('input,select,button'))assert.equal(field.disabled,!field.matches('[data-check-channel]'),field.outerHTML);
  assert.equal(direct.querySelector('[data-channel-field=provider]').disabled,false);
  assert.equal(direct.querySelector('[data-channel-field=provider] option[value=onlypult]').disabled,true);
  assert.equal(f.node('autoposting-title').disabled,false);assert.equal(f.node('autoposting-text').disabled,false);
  onlypult.querySelector('[data-load-profiles]').dispatchEvent(new f.w.MouseEvent('click',{bubbles:true}));
  onlypult.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await f.settle();
  assert.equal(f.calls.some(c=>c.path.endsWith('/profiles')||c.method==='PUT'),false);
  onlypult.querySelector('[data-check-channel]').click();await f.settle();
  assert.ok(f.calls.some(c=>c.path.endsWith('/settings/vk/check')&&c.method==='POST'));
  fill(f);await f.click('autoposting-save');assert.equal(f.posts.length,1);assert.equal(f.posts[0].companyCode,'alvi');assert.equal(f.posts[0].status,'draft');
 }finally{f.close();}
});

test('weekly plan appears for the selected company, imports exactly seven unscheduled drafts once, and never sends them',async()=>{
 const f=await fixture({starter:true});try{
  assert.equal(f.node('autoposting-starter-plan').hidden,false);assert.equal(f.node('autoposting-starter-plan').querySelectorAll('li').length,7);
  assert.match(f.node('autoposting-starter-plan').textContent,/АЛВИ/);assert.ok(f.calls.every(c=>c.method==='GET'));
  await f.click('autoposting-import-plan');const imports=f.calls.filter(c=>c.path.endsWith('/starter-plan')&&c.method==='POST');
  assert.equal(imports.length,1);assert.equal(imports[0].code,'alvi');assert.deepEqual(JSON.parse(imports[0].options.body),{platform:'vk',profileRevision:2});
  assert.equal(imports[0].options.headers['X-CSRF-Token'],'test-csrf');assert.equal(f.posts.length,7);
  assert.ok(f.posts.every(p=>p.companyCode==='alvi'&&p.status==='draft'&&p.scheduledAt===null&&p.platformIds.length===0&&p.mediaUrls.length===0));
  assert.equal(f.node('autoposting-import-plan').disabled,true);await f.click('autoposting-import-plan');assert.equal(f.posts.length,7);
  assert.equal(f.calls.some(c=>c.path.endsWith('/schedule')||c.path.endsWith('/check')||(c.path.endsWith('/posts')&&c.method==='POST')),false);
  f.set('autoposting-plan-platform','telegram','change');assert.equal(f.node('autoposting-import-plan').disabled,false);await f.click('autoposting-import-plan');assert.equal(f.posts.length,14);
  await f.views.autoposting.onProjectChange({...f.ctx,selectedProjectId:'avokado'});assert.match(f.node('autoposting-starter-plan').textContent,/Авокадо/);assert.equal(f.node('autoposting-import-plan').disabled,false);assert.equal(f.node('autoposting-select').options.length,1);
 }finally{f.close();}
});

test('weekly plan import is disabled for read-only users and unsupported companies keep regular editing available',async()=>{
 const f=await fixture({starter:true,role:'editor',permissions:['autoposting.view']});try{
  assert.equal(f.node('autoposting-import-plan').disabled,true);await f.click('autoposting-import-plan');assert.equal(f.posts.length,0);assert.ok(f.calls.every(c=>c.method==='GET'));
 }finally{f.close();}
 const unavailable=await fixture();try{assert.equal(unavailable.node('autoposting-starter-plan').hidden,true);assert.equal(unavailable.node('autoposting-title').disabled,false);assert.ok(unavailable.node('autoposting-calendar').querySelector('button'));}finally{unavailable.close();}
});

test('delayed weekly import does not replace the destination company list or start a second request for that company',async()=>{
 let release;const f=await fixture({starter:true,override:call=>call.path.endsWith('/starter-plan')&&call.method==='POST'?new Promise(resolve=>{release=resolve;}):undefined});
 try{f.node('autoposting-import-plan').click();await f.settle();await f.views.autoposting.onProjectChange({...f.ctx,selectedProjectId:'avokado'});const count=f.calls.length;
  release({companyCode:'alvi',available:true,imports:{vk:{postIds:[1,2,3,4,5,6,7]}}});await f.settle();
  assert.equal(f.calls.length,count);assert.equal(f.node('autoposting-company').value,'avokado');assert.match(f.node('autoposting-starter-plan').textContent,/Авокадо/);
  assert.equal(f.node('autoposting-select').options.length,1);assert.equal(f.node('autoposting-import-plan').disabled,false);
 }finally{f.close();}
});

test('provider reconciliation checks an existing receipt without resending or presenting its job ID as a published social link',async()=>{
 const f=await fixture({entries:[receiptPost()]});try{f.set('autoposting-select','55','change');assert.equal(f.node('autoposting-reconcile').hidden,false);
  assert.equal(f.node('autoposting-save').disabled,true);assert.equal(f.node('autoposting-schedule').disabled,true);
  await f.click('autoposting-reconcile');const calls=f.calls.filter(c=>c.method!=='GET');assert.equal(calls.length,1);
  assert.equal(calls[0].path,'/content/crm/autoposting/posts/55/reconcile');assert.equal(calls[0].method,'POST');assert.equal(calls[0].code,'alvi');assert.deepEqual(JSON.parse(calls[0].options.body),{revision:3});
  assert.equal(f.posts[0].status,'needs_review');assert.equal(f.posts[0].deliveries[0].providerStatus,'published');assert.equal(f.node('autoposting-deliveries').querySelectorAll('a').length,0);
  assert.match(f.node('autoposting-post-error').textContent,/Сервис сообщил о публикации/);assert.match(f.node('autoposting-status').textContent,/Повторная отправка не выполнялась/);
  assert.equal(f.node('autoposting-save').disabled,true);await f.click('autoposting-preview');assert.equal(f.node('autoposting-schedule').disabled,true);
 }finally{f.close();}
});

test('reconciliation failure is safe and a read-only viewer cannot request it',async()=>{
 const f=await fixture({entries:[receiptPost()],override:call=>{if(call.path.endsWith('/reconcile'))throw Error('RAW_PROVIDER_KEY op_private');}});
 try{f.set('autoposting-select','55','change');await f.click('autoposting-reconcile');assert.doesNotMatch(f.d.body.textContent,/RAW_PROVIDER_KEY|op_private/);assert.equal(f.posts[0].revision,3);assert.match(f.node('autoposting-status').textContent,/Повторная отправка не выполнялась/);
 }finally{f.close();}
 const viewer=await fixture({role:'editor',permissions:['autoposting.view'],entries:[receiptPost()]});try{viewer.set('autoposting-select','55','change');assert.equal(viewer.node('autoposting-reconcile').disabled,true);await viewer.click('autoposting-reconcile');assert.ok(viewer.calls.every(c=>c.method==='GET'));}finally{viewer.close();}
});

test('a successful HTTP response with a failed provider status check does not claim that the status was verified',async()=>{
 const entry=receiptPost();const f=await fixture({entries:[entry],override:call=>{
  if(call.path.endsWith('/reconcile'))return {...entry,deliveries:entry.deliveries.map(d=>({...d,errorCode:'PROVIDER_CHECK_FAILED',providerCheckedAt:'2026-09-17T09:00:00.000Z'}))};
 }});
 try{f.set('autoposting-select','55','change');await f.click('autoposting-reconcile');
  assert.doesNotMatch(f.node('autoposting-status').textContent,/Статус проверен/);
  assert.match(f.node('autoposting-status').textContent,/не удалось|не подтверд/iu);
  assert.match(f.node('autoposting-deliveries').textContent,/не удалось|не подтверд/iu);
  assert.equal(f.node('autoposting-save').disabled,true);assert.equal(f.node('autoposting-schedule').disabled,true);
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,1);assert.equal(f.node('autoposting-deliveries').querySelectorAll('a').length,0);
 }finally{f.close();}
});
