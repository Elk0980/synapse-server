const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const {normalizeProfile}=require('../../../ops/crm/company-information');
const script=fs.readFileSync(require.resolve('./company-information.js'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const record=code=>({companyCode:code,revision:1,profile:{name:code,city:'Иркутск',timezone:'Asia/Irkutsk',phone:'+70000000000',socials:[{type:'custom',url:'https://example.test/',label:'Сохранённая',extra:'keep'}],services:[{id:'s1',title:'Услуга',price:500,currency:'RUB',durationMinutes:45,bookingIntervalMinutes:60}],promotions:[],materials:[]},fieldStates:{phone:{state:'confirmed'},email:{state:'unknown'}},history:[],checks:[]});
async function fixture({role='owner',permissions=[],override}={}){
  const dom=new JSDOM('<section id="view"></section>',{url:'https://cabinet.test/',runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[];
  const data={alvi:record('alvi'),avokado:record('avokado')};
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};w.eval(script);
  const ctx={identity:{role,permissions,companies:[{id:'alvi',name:'АЛВИ'},{id:'avokado',name:'Авокадо'}]},selectedProjectId:'alvi',
    csrfOptions:(method,body)=>({method,headers:{'X-CSRF-Token':'test-csrf'},...(body===undefined?{}:{body:JSON.stringify(body)})}),
    apiJson:async(url,options={})=>{const parsed=new URL(url,'https://cabinet.test'),code=parsed.searchParams.get('companyCode'),call={url,path:parsed.pathname,code,method:options.method||'GET',options};calls.push(call);
      if(override){const result=await override(call);if(result!==undefined)return clone(result);}
      if(call.path==='/content/publishing-assets')return {url:'https://assets.example.test/photo.png'};
      if(call.method==='PUT'){const body=JSON.parse(options.body);assert.equal(body.revision,data[code].revision);const normalized=normalizeProfile(body.profile);data[code]={...data[code],revision:data[code].revision+1,profile:{...data[code].profile,...normalized}};}
      return clone(data[code]);}};
  await views['company-information'].render(d.getElementById('view'),ctx);
  const f={w,d,views,calls,data,ctx,node:id=>d.getElementById(id),settle:async()=>{for(let i=0;i<8;i++)await tick();},set(id,value,type='input'){const node=f.node(id);node.value=value;node.dispatchEvent(new w.Event(type,{bubbles:true}));},async click(id){f.node(id).click();await f.settle();},close:()=>w.close()};return f;
}
test('information obeys explicit view/edit permission and never writes on opening',async()=>{
  for(const permissions of [[],['company-information.view']]){const f=await fixture({role:'marketer',permissions});try{
    assert.equal(!!f.node('information-form'),!!permissions.length);assert.ok(f.calls.every(call=>call.method==='GET'));
    if(permissions.length){assert.equal(f.node('information-name').disabled,true);f.node('information-form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await f.settle();assert.equal(f.calls.length,1);}
  }finally{f.close();}}
});
test('owner save preserves row IDs/unknown properties and intentional deletion, without converting untouched unknown blanks into removal',async()=>{
  const f=await fixture();try{f.set('information-phone','');f.set('information-name','Новое название');await f.click('information-save');
    const write=f.calls.find(call=>call.method==='PUT'),body=JSON.parse(write.options.body);
    assert.equal(write.options.headers['X-CSRF-Token'],'test-csrf');assert.equal(body.profile.phone,'');assert.equal('email' in body.profile,false);
    assert.equal(body.profile.socials[0].extra,'keep');assert.equal(body.profile.services[0].id,'s1');assert.equal(body.profile.services[0].bookingIntervalMinutes,60);
  }finally{f.close();}
});
test('invalid unfinished input survives a project switch and stale company responses are discarded',async()=>{
  let resolveOld;const f=await fixture({override:call=>call.code==='avokado'&&!resolveOld?new Promise(resolve=>{resolveOld=resolve;}):undefined});
  try{f.set('information-timezone','unfinished/zone');f.set('information-name','Черновик АЛВИ');
    const old=f.views['company-information'].onProjectChange({...f.ctx,selectedProjectId:'avokado'});await f.settle();
    await f.views['company-information'].onProjectChange(f.ctx);resolveOld(record('avokado'));await old;
    assert.equal(f.node('information-company').value,'alvi');assert.equal(f.node('information-name').value,'Черновик АЛВИ');assert.equal(f.node('information-timezone').value,'unfinished/zone');
  }finally{f.close();}
});
test('company timezone converts wall time to UTC without depending on computer timezone and rejects DST gaps/ambiguity',async()=>{
  const f=await fixture();try{const time=f.w.SbCabinet.companyTime;
    assert.equal(time.toUTC('2099-01-01T10:00','Asia/Irkutsk'),'2099-01-01T02:00:00.000Z');
    assert.equal(time.toLocal('2099-01-01T02:00:00.000Z','Asia/Irkutsk'),'2099-01-01T10:00');
    assert.throws(()=>time.toUTC('2026-03-29T02:30','Europe/Berlin'));assert.throws(()=>time.toUTC('2026-10-25T02:30','Europe/Berlin'));
  }finally{f.close();}
});
test('photo upload is explicit, scoped, binary, and never saves or publishes the profile automatically',async()=>{
  const f=await fixture();try{const file=new f.w.File(['fake-photo'],'фото.png',{type:'image/png'});Object.defineProperty(f.node('information-photo'),'files',{value:[file]});
    assert.equal(f.calls.length,1);await f.click('information-upload');const upload=f.calls.find(call=>call.path==='/content/publishing-assets');
    assert.equal(upload.code,'alvi');assert.equal(upload.options.body,file);assert.equal(upload.options.headers['Content-Type'],'image/png');assert.equal(upload.options.headers['X-CSRF-Token'],'test-csrf');
    assert.equal(f.node('information-materials').querySelector('img').src,'https://assets.example.test/photo.png');assert.equal(f.calls.some(call=>call.method==='PUT'),false);
  }finally{f.close();}
});
test('external check facts and malicious profile strings render as text, with actual partial/differences semantics',async()=>{
  const bad=record('alvi');bad.profile.name='<img src=x onerror=alert(1)>';bad.checks=[{platformId:'two_gis',status:'differences',fields:[{field:'name',expected:'<script>bad()</script>',observed:'Другое имя',status:'differs'}]}];
  const f=await fixture({override:()=>bad});try{assert.equal(f.node('information-name').value,bad.profile.name);assert.equal(f.d.querySelector('script,img'),null);assert.match(f.node('information-checks').textContent,/Есть расхождения/);assert.match(f.node('information-checks').textContent,/<script>bad\(\)<\/script>/);}finally{f.close();}
});
