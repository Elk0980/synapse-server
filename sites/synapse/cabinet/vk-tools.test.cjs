'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const source = fs.readFileSync(__dirname + '/vk-tools.js','utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const readState = async f => { f.node('state').click(); await tick(); };
const setting = (companyCode,purpose,extra={}) => ({companyCode,purpose,groupId:companyCode==='palitra-love'?'241948768':'123',tokenType:purpose==='analytics'?'user':'group',revision:2,configured:true,enabled:true,connected:true,...extra});
function fixture(override,role='owner') {
  const dom = new JSDOM('<main></main>',{url:'https://example.test',runScripts:'outside-only'}),w=dom.window,container=w.document.querySelector('main'),calls=[];
  w.eval(source);
  let ctx={selectedProjectId:'palitra-love',identity:{role},csrfOptions:(method,body)=>({method,body:JSON.stringify(body),headers:{'X-CSRF-Token':'test'}}),async apiJson(url,options={}) {
    const u=new URL(url,'https://example.test'),parts=u.pathname.split('/'),call={path:u.pathname,purpose:parts[4],companyCode:u.searchParams.get('companyCode'),method:options.method||'GET',body:options.body?JSON.parse(options.body):null,headers:options.headers};calls.push(call);
    assert.ok(['palitra-love','alvi'].includes(call.companyCode));if(call.method!=='GET')assert.equal(call.headers['X-CSRF-Token'],'test');
    if(override){const value=await override(call);if(value!==undefined)return value;}
    if(call.path.endsWith('/settings'))return setting(call.companyCode,call.purpose,call.method==='PUT'?{revision:3,connected:false}:{});
    if(call.path.endsWith('/check'))return setting(call.companyCode,call.purpose);
    const base={companyCode:call.companyCode,revision:2,groupId:call.companyCode==='palitra-love'?'241948768':'123'};
    if(call.path.endsWith('/state'))return {...base,description:'Старое описание',cover:{enabled:false,images:[]}};
    if(call.path.endsWith('/history'))return {companyCode:call.companyCode,items:[]};
    if(call.path.endsWith('/preview')||call.path.endsWith('/rollback-preview'))return {...base,previewId:'preview-fixture',operation:'description',before:'Старое описание',after:call.body.description||'Возврат',warnings:[]};
    if(call.path.endsWith('/apply'))return {...base,requestId:call.body.requestId,previewId:call.body.previewId,status:'verified'};
    assert.fail('Unexpected '+call.path);
  }};
  const ui=w.SbCabinet.mountVkTools(container,ctx),node=id=>container.querySelector('#vkt-'+id);
  return {dom,w,calls,container,node,ui,mount:()=>ui.update(ctx,'palitra-love'),change(code,newRole='owner'){ctx={...ctx,identity:{role:newRole},selectedProjectId:code};return ui.update(ctx,code);},input(id,value){node(id).value=value;node(id).dispatchEvent(new w.Event('input',{bubbles:true}));},submit(id){node(id).dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));},close(){ui.destroy();w.close();}};
}
test('mount only reads scoped independent connections and exposes no token value',async()=>{const f=fixture();try{await f.mount();assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.method==='GET'&&!c.path.includes('autoposting')));assert.equal(f.node('analytics-token').type,'password');assert.equal(f.node('analytics-type').value,'user');assert.equal(f.node('analytics-type').disabled,true);assert.equal(f.node('apply').disabled,true);}finally{f.close();}});
test('save clears secret and needs check, preserving publishing and adding CSRF/revision',async()=>{const f=fixture();try{await f.mount();f.input('analytics-token','FIXTURE_SECRET');f.submit('analytics-form');await tick();const c=f.calls.at(-1);assert.equal(c.method,'PUT');assert.equal(c.body.accessToken,'FIXTURE_SECRET');assert.equal(c.body.revision,2);assert.equal(c.body.tokenType,'user');assert.equal(f.node('analytics-token').value,'');assert.doesNotMatch(f.container.innerHTML,/FIXTURE_SECRET/);assert.match(f.node('analytics-connection').textContent,/требуется проверка/);assert.equal(f.node('design-check').disabled,false,'independent design connection stays available');assert.ok(f.calls.every(c=>!c.path.includes('autoposting')));}finally{f.close();}});
test('description requires explicit preview then separate apply; edited text invalidates preview',async()=>{const f=fixture();try{await f.mount();await readState(f);f.input('description','Новое <script>');f.node('description-preview').click();await tick();assert.equal(f.calls.at(-1).path,'/content/crm/vk-tools/design/preview');assert.equal(f.node('apply').disabled,false);assert.equal(f.container.querySelector('script'),null);assert.match(f.node('preview').textContent,/Новое <script>/);assert.ok(!f.calls.some(c=>c.path.endsWith('/apply')));f.input('description','Ещё новое');assert.equal(f.node('apply').disabled,true);f.node('apply').click();await tick();assert.ok(!f.calls.some(c=>c.path.endsWith('/apply')));}finally{f.close();}});
test('uncertain apply never retries and retains request identity for explicit status recovery',async()=>{let original;const f=fixture(c=>{if(c.path.endsWith('/apply')){original=c.body;throw Error('FIXTURE_PRIVATE_ERROR');}});try{await f.mount();await readState(f);f.input('description','Новое');f.node('description-preview').click();await tick();f.node('apply').click();await tick();assert.match(original.requestId,/^[a-f0-9-]{36}$/);assert.equal(f.node('apply').disabled,true);assert.match(f.node('status').textContent,/не подтверждён/);assert.doesNotMatch(f.container.textContent,/FIXTURE_PRIVATE_ERROR/);f.node('apply').click();assert.equal(f.calls.filter(c=>c.path.endsWith('/apply')).length,1);f.node('history-refresh').click();await tick();assert.equal(f.calls.at(-1).method,'GET');}finally{f.close();}});
test('company switch clears secrets/drafts and ignores late settings from old company',async()=>{let release;const f=fixture(c=>c.companyCode==='palitra-love'&&c.purpose==='analytics'?new Promise(r=>{release=r;}):undefined);try{const pending=f.mount();f.input('design-token','OLD_SECRET');f.input('description','OLD_PRIVATE_DRAFT');await f.change('alvi');assert.equal(f.node('design-token').value,'');assert.equal(f.node('description').value,'');release(setting('palitra-love','analytics',{group:{name:'OLD_PRIVATE_NAME'}}));await pending;assert.equal(f.node('analytics-group').value,'123');assert.doesNotMatch(f.container.textContent,/OLD_PRIVATE/);}finally{f.close();}});
test('role loss clears UI and suppresses late previews',async()=>{let release;const f=fixture(c=>c.path.endsWith('/preview')?new Promise(r=>{release=()=>r({companyCode:c.companyCode,revision:2,groupId:'241948768',previewId:'p',operation:'description',before:{},after:{description:'PRIVATE_LATE'}});}):undefined);try{await f.mount();await readState(f);f.input('description','Text');f.node('description-preview').click();await tick();await f.change('palitra-love','editor');assert.equal(f.container.children.length,0);release();await tick();assert.equal(f.container.children.length,0);}finally{f.close();}});
test('wrong company or revision preview cannot enable apply',async()=>{for(const extra of [{companyCode:'alvi'},{revision:999}]){const f=fixture(c=>c.path.endsWith('/preview')?{companyCode:c.companyCode,groupId:'241948768',revision:2,previewId:'p',operation:'description',before:{},after:{description:'WRONG_PRIVATE'},...extra}:undefined);try{await f.mount();await readState(f);f.input('description','Text');f.node('description-preview').click();await tick();assert.equal(f.node('apply').disabled,true);assert.doesNotMatch(f.container.textContent,/WRONG_PRIVATE/);}finally{f.close();}}});

test('non-owner never reads private connections or retains controls',async()=>{
  const f=fixture(undefined,'editor');try{await f.mount();assert.equal(f.calls.length,0);assert.equal(f.container.children.length,0);}finally{f.close();}
});
test('unknown state is not treated as empty description and cannot be overwritten',async()=>{
  const f=fixture(c=>c.path.endsWith('/state')?{companyCode:c.companyCode,groupId:'241948768',revision:2,description:null,cover:null}:undefined);
  try{await f.mount();f.input('description','UNSAVED');await readState(f);assert.equal(f.node('description').value,'UNSAVED');assert.equal(f.node('description-preview').disabled,true);assert.equal(f.node('cover-preview').disabled,true);assert.match(f.node('status').textContent,/неизвестного поля/);assert.ok(!f.calls.some(c=>c.path.endsWith('/preview')));}finally{f.close();}
});
test('binding or token type changes need a new credential, without posting or checking automatically',async()=>{
  const f=fixture();try{await f.mount();f.input('design-group','777');f.submit('design-form');await tick();assert.equal(f.calls.length,2);assert.match(f.node('status').textContent,/нужен его ключ/);assert.equal(f.node('design-check').disabled,true);}finally{f.close();}
});
test('provider token-type errors show fixed wording and clear failed-save secret',async()=>{
  const f=fixture(c=>{if(c.method==='PUT'){const error=Error('SECRET_FROM_PROVIDER');error.code='TOKEN_TYPE_MISMATCH';throw error;}});
  try{await f.mount();f.input('design-token','PRIVATE_SECRET');f.submit('design-form');await tick();assert.equal(f.node('design-token').value,'');assert.match(f.node('status').textContent,/Тип ключа не подходит/);assert.doesNotMatch(f.container.textContent,/SECRET_FROM_PROVIDER|PRIVATE_SECRET/);assert.equal(f.calls.filter(c=>c.method!=='GET').length,1);}finally{f.close();}
});
test('cover input is bounded, private, previewed before explicit apply and never uploaded on selection',async()=>{
  const f=fixture(c=>c.path.endsWith('/preview')&&c.body.operation==='cover'?{companyCode:c.companyCode,groupId:'241948768',revision:2,previewId:'cover-preview',operation:'cover',before:{enabled:false,images:[]},after:{mime:'image/png',width:1590,height:400,crop:{x:0,y:0,x2:1590,y2:400}},warnings:['COVER_RESTORE_REQUIRES_ORIGINAL']}:undefined);
  try{
    await f.mount();await readState(f);
    const select=file=>{Object.defineProperty(f.node('cover'),'files',{configurable:true,value:[file]});f.node('cover').dispatchEvent(new f.w.Event('change'));};
    select(new f.w.File(['x'],'unsafe.svg',{type:'image/svg+xml'}));assert.match(f.node('status').textContent,/JPEG или PNG/);assert.equal(f.node('cover-preview').disabled,true);
    const before=f.calls.length;select(new f.w.File(['fixture-image'],'cover.png',{type:'image/png'}));
    for(let i=0;i<20&&f.node('cover-preview').disabled;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(f.node('cover-preview').disabled,false);assert.equal(f.calls.length,before);
    f.node('cover-preview').click();await tick();assert.equal(f.calls.at(-1).body.image.mime,'image/png');assert.match(f.calls.at(-1).body.image.base64,/^[a-zA-Z0-9+/]+=*$/);
    assert.match(f.node('preview').textContent,/исходный файл/);assert.equal(f.node('apply').disabled,false);assert.equal(f.calls.some(c=>c.path.endsWith('/apply')),false);
    f.node('apply').click();await tick();assert.equal(f.calls.at(-1).body.previewId,'cover-preview');assert.match(f.node('status').textContent,/Проверено/);assert.equal(f.node('apply').disabled,true);
  }finally{f.close();}
});
test('history rollback only creates a new preview and requires its own explicit apply',async()=>{
  const f=fixture(c=>c.path.endsWith('/history')?{companyCode:c.companyCode,items:[{companyCode:c.companyCode,operation:'description',requestId:'old-request',status:'verified'}]}:undefined);
  try{await f.mount();f.node('history-refresh').click();await tick();f.container.querySelector('[data-rollback]').click();await tick();assert.equal(f.calls.at(-1).path,'/content/crm/vk-tools/design/rollback-preview');assert.deepEqual(f.calls.at(-1).body,{revision:2,requestId:'old-request'});assert.equal(f.node('apply').disabled,false);assert.equal(f.calls.some(c=>c.path.endsWith('/apply')),false);}finally{f.close();}
});
test('read-only state remains available after an unverified apply without clearing its request or unlocking mutation',async()=>{
  const f=fixture(c=>c.path.endsWith('/apply')?{companyCode:c.companyCode,groupId:'241948768',revision:2,requestId:c.body.requestId,status:'applied_unverified'}:undefined);
  try{
    await f.mount();await readState(f);f.input('description','Новое описание');f.node('description-preview').click();await tick();f.node('apply').click();await tick();
    const apply=f.calls.at(-1);assert.equal(f.node('state').disabled,false);assert.equal(f.node('description-preview').disabled,true);
    await readState(f);assert.equal(f.calls.at(-1).method,'GET');assert.equal(f.node('description').value,'Новое описание');assert.match(f.node('current-state').textContent,/Старое описание/);
    assert.equal(f.node('apply').disabled,true);assert.equal(f.node('description-preview').disabled,true);assert.equal(f.calls.filter(c=>c.path.endsWith('/apply')).length,1);assert.equal(apply.body.requestId,f.calls.find(c=>c.path.endsWith('/apply')).body.requestId);
  }finally{f.close();}
});
