const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const scripts=['company-information.js','autoposting.js'].map(file=>fs.readFileSync(require.resolve('./'+file),'utf8'));
const clone=value=>JSON.parse(JSON.stringify(value)),tick=()=>new Promise(resolve=>setImmediate(resolve));
const channels=()=>[{id:'telegram',platform:'telegram',name:'Telegram',target:'@fixture',revision:1,enabled:true,connected:true,caps:{maxText:4096,maxMedia:10}},{id:'vk',platform:'vk',name:'ВКонтакте',target:'club1',revision:1,enabled:true,connected:true,caps:{maxText:15000,maxMedia:1,mediaMode:'link'}}];
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
async function fixture({role='owner',permissions=[],override,entries=[]}={}){
  const dom=new JSDOM('<section id="view"></section>',{url:'https://cabinet.test/',runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[],posts=clone(entries),configs={alvi:{channels:channels(),timezone:'Asia/Irkutsk'},avokado:{channels:channels(),timezone:'Asia/Irkutsk'}};
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};scripts.forEach(source=>w.eval(source));
  const ctx={identity:{role,permissions,companies:[{id:'alvi',name:'АЛВИ'},{id:'avokado',name:'Авокадо'}]},selectedProjectId:'alvi',
    csrfOptions:(method,body)=>({method,headers:{'X-CSRF-Token':'test-csrf'},...(body===undefined?{}:{body:JSON.stringify(body)})}),
    apiJson:async(url,options={})=>{const parsed=new URL(url,'https://cabinet.test'),code=parsed.searchParams.get('companyCode'),call={url,path:parsed.pathname,code,method:options.method||'GET',options};calls.push(call);
      if(override){const result=await override(call);if(result!==undefined)return clone(result);}
      if(call.path==='/content/publishing-assets')return {url:'https://assets.example.test/photo.png'};
      if(call.path==='/content/crm/company-information')return {companyCode:code,revision:2,profile:{name:code,timezone:'Asia/Irkutsk',socials:[{type:'two_gis',url:'https://2gis.ru/fixture'}]}};
      if(call.path==='/content/crm/autoposting/settings'){if(call.method==='PUT'){const body=JSON.parse(options.body);for(const row of body.channels){assert.equal(row.revision,1);const {token,...publicRow}=row;Object.assign(configs[code].channels.find(item=>item.id===row.id),publicRow,{revision:2,connected:false});}}return clone(configs[code]);}
      if(call.path.endsWith('/check'))return {ok:true};
      if(call.path==='/content/crm/autoposting/posts'){if(call.method==='POST'){const item={id:posts.length+1,companyCode:code,revision:1,status:'draft',deliveries:[],...JSON.parse(options.body)};posts.push(item);return clone(item);}return {companyCode:code,posts:clone(posts.filter(item=>item.companyCode===code))};}
      const match=call.path.match(/\/posts\/(\d+)(?:\/(schedule|cancel))?$/);assert.ok(match,call.path);const item=posts.find(item=>item.id===Number(match[1])&&item.companyCode===code),body=JSON.parse(options.body);assert.ok(item);assert.equal(body.revision,item.revision);
      if(match[2])item.status=match[2]==='schedule'?'scheduled':'cancelled';else Object.assign(item,body);item.revision++;return clone(item);
    }};
  await views.autoposting.render(d.getElementById('view'),ctx);
  const f={w,d,ctx,views,calls,posts,configs,node:id=>d.getElementById(id),settle:async()=>{for(let i=0;i<8;i++)await tick();},set(id,value,type='input'){const node=f.node(id);node.value=value;node.dispatchEvent(new w.Event(type,{bubbles:true}));},async click(id){f.node(id).click();await f.settle();},close:()=>w.close()};return f;
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
test('settings saves only the edited card, omits blank token, clears new token even on failure, and check never publishes',async()=>{
  let fail=false;const f=await fixture({override:call=>{if(fail&&call.method==='PUT')throw Error('RAW_SECRET');}});try{
    let form=f.node('autoposting-channels').querySelector('[data-channel=telegram]');form.querySelector('button[type=submit]').click();await f.settle();const first=f.calls.find(call=>call.method==='PUT'),body=JSON.parse(first.options.body);
    assert.equal(body.channels.length,1);assert.equal(body.channels[0].id,'telegram');assert.equal(body.channels[0].revision,1);assert.equal('token' in body.channels[0],false);
    form=f.node('autoposting-channels').querySelector('[data-channel=telegram]');form.querySelector('[data-check-channel]').click();await f.settle();assert.ok(f.calls.some(call=>call.path.endsWith('/check')));assert.equal(f.calls.some(call=>call.path.endsWith('/schedule')),false);
    fail=true;form=f.node('autoposting-channels').querySelector('[data-channel=telegram]');const token=form.querySelector('[type=password]');token.value='NEW_TEST_SECRET';form.querySelector('button[type=submit]').click();await f.settle();assert.equal(token.value,'');assert.doesNotMatch(f.d.body.textContent,/RAW_SECRET|NEW_TEST_SECRET/);
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
