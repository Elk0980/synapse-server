'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const source = fs.readFileSync(__dirname + '/vk-tools.js','utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const readState = async f => { f.node('state').click(); await tick(); };
const setting = (companyCode,purpose,extra={}) => ({companyCode,purpose,groupId:companyCode==='palitra-love'?'12345':'123',tokenType:purpose==='analytics'?'user':'group',revision:2,configured:true,enabled:true,connected:true,...extra});
function fixture(override,role='owner') {
  const dom = new JSDOM('<main></main>',{url:'https://example.test',runScripts:'outside-only'}),w=dom.window,container=w.document.querySelector('main'),calls=[];
  w.eval(source);
  let ctx={selectedProjectId:'palitra-love',identity:{role},csrfOptions:(method,body)=>({method,body:JSON.stringify(body),headers:{'X-CSRF-Token':'test'}}),async apiJson(url,options={}) {
    const u=new URL(url,'https://example.test'),parts=u.pathname.split('/'),call={path:u.pathname,purpose:parts[4],companyCode:u.searchParams.get('companyCode'),query:Object.fromEntries(u.searchParams),method:options.method||'GET',body:options.body?JSON.parse(options.body):null,headers:options.headers};calls.push(call);
    assert.ok(['palitra-love','alvi'].includes(call.companyCode));if(call.method!=='GET')assert.equal(call.headers['X-CSRF-Token'],'test');
    if(override){const value=await override(call);if(value!==undefined)return value;}
    if(call.path.endsWith('/settings'))return setting(call.companyCode,call.purpose,call.method==='PUT'?{revision:3,connected:false}:{});
    if(call.path.endsWith('/check'))return setting(call.companyCode,call.purpose);
    const base={companyCode:call.companyCode,revision:2,groupId:call.companyCode==='palitra-love'?'12345':'123'};
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
test('role loss clears UI and suppresses late previews',async()=>{let release;const f=fixture(c=>c.path.endsWith('/preview')?new Promise(r=>{release=()=>r({companyCode:c.companyCode,revision:2,groupId:'12345',previewId:'p',operation:'description',before:{},after:{description:'PRIVATE_LATE'}});}):undefined);try{await f.mount();await readState(f);f.input('description','Text');f.node('description-preview').click();await tick();await f.change('palitra-love','editor');assert.equal(f.container.children.length,0);release();await tick();assert.equal(f.container.children.length,0);}finally{f.close();}});
test('wrong company or revision preview cannot enable apply',async()=>{for(const extra of [{companyCode:'alvi'},{revision:999}]){const f=fixture(c=>c.path.endsWith('/preview')?{companyCode:c.companyCode,groupId:'12345',revision:2,previewId:'p',operation:'description',before:{},after:{description:'WRONG_PRIVATE'},...extra}:undefined);try{await f.mount();await readState(f);f.input('description','Text');f.node('description-preview').click();await tick();assert.equal(f.node('apply').disabled,true);assert.doesNotMatch(f.container.textContent,/WRONG_PRIVATE/);}finally{f.close();}}});

test('non-owner never reads private connections or retains controls',async()=>{
  const f=fixture(undefined,'editor');try{await f.mount();assert.equal(f.calls.length,0);assert.equal(f.container.children.length,0);}finally{f.close();}
});
test('unknown state is not treated as empty description and cannot be overwritten',async()=>{
  const f=fixture(c=>c.path.endsWith('/state')?{companyCode:c.companyCode,groupId:'12345',revision:2,description:null,cover:null}:undefined);
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
  const f=fixture(c=>c.path.endsWith('/preview')&&c.body.operation==='cover'?{companyCode:c.companyCode,groupId:'12345',revision:2,previewId:'cover-preview',operation:'cover',before:{enabled:false,images:[]},after:{mime:'image/png',width:1590,height:400,crop:{x:0,y:0,x2:1590,y2:400}},warnings:['COVER_RESTORE_REQUIRES_ORIGINAL']}:undefined);
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
  const f=fixture(c=>c.path.endsWith('/apply')?{companyCode:c.companyCode,groupId:'12345',revision:2,requestId:c.body.requestId,status:'applied_unverified'}:undefined);
  try{
    await f.mount();await readState(f);f.input('description','Новое описание');f.node('description-preview').click();await tick();f.node('apply').click();await tick();
    const apply=f.calls.at(-1);assert.equal(f.node('state').disabled,false);assert.equal(f.node('description-preview').disabled,true);
    await readState(f);assert.equal(f.calls.at(-1).method,'GET');assert.equal(f.node('description').value,'Новое описание');assert.match(f.node('current-state').textContent,/Старое описание/);
    assert.equal(f.node('apply').disabled,true);assert.equal(f.node('description-preview').disabled,true);assert.equal(f.calls.filter(c=>c.path.endsWith('/apply')).length,1);assert.equal(apply.body.requestId,f.calls.find(c=>c.path.endsWith('/apply')).body.requestId);
  }finally{f.close();}
});

const materialDto=c=>({companyCode:c.companyCode,groupId:c.companyCode==='palitra-love'?'12345':'123',revision:2,previewId:'album-preview',operation:'album_photo',album:{id:7,title:'Фото <img src=x>'},caption:c.body?.caption||'',image:{mime:'image/png',width:1,height:1,size:7,sourceHash:'fixture-hash'},expiresAt:'2099-01-01T00:00:00Z'});
function materialFixture(override){return fixture(async c=>{
  if(override){const result=await override(c);if(result!==undefined)return result;}
  if(c.path.endsWith('/settings')&&c.purpose==='design')return setting(c.companyCode,c.purpose,{tokenType:'user'});
  if(c.path.endsWith('/albums')){assert.equal(c.query.revision,'2');return {...materialDto(c),total:2,offset:Number(c.query.offset),nextOffset:null,albums:[{id:7,title:'Фото <img src=x>',size:0},{id:8,title:'Другой альбом',size:1}]};}
  if(c.path.endsWith('/material-preview'))return materialDto(c);
  if(c.path.endsWith('/material-apply'))return {...materialDto(c),requestId:c.body.requestId,status:'verified'};
  if(c.path.endsWith('/material-history')){assert.equal(c.query.revision,'2');return {...materialDto(c),items:[]};}
});}
async function materialFile(f,name='fixture.png',type='image/png'){
  const file=new f.w.File(['fixture'],name,{type});Object.defineProperty(f.node('material-file'),'files',{configurable:true,value:[file]});f.node('material-file').dispatchEvent(new f.w.Event('change'));
  for(let i=0;i<30&&!f.node('material-file-info').textContent;i++)await new Promise(resolve=>setTimeout(resolve,5));
}
async function materialDraft(f){await f.mount();f.node('albums-refresh').click();await tick();f.node('album').value='7';f.node('album').dispatchEvent(new f.w.Event('change'));await materialFile(f);f.input('material-caption','Подпись <script>');}

test('albums require checked user design binding and never load automatically',async()=>{
  const f=fixture();try{await f.mount();assert.equal(f.node('albums-refresh').disabled,true);f.node('albums-refresh').click();assert.equal(f.calls.length,2);assert.match(f.node('materials-connection').textContent,/Пользователь/);}finally{f.close();}
});
test('album upload previews exact destination and local photo before one explicit confirmed apply',async()=>{
  let release;const f=materialFixture(c=>c.path.endsWith('/material-apply')?new Promise(resolve=>{release=()=>resolve({...materialDto(c),requestId:c.body.requestId,status:'verified'});}):undefined);
  try{
    await materialDraft(f);assert.equal(f.calls.length,3,'selection and caption do not upload');assert.equal(f.container.querySelector('script'),null);assert.equal(f.node('material-caption').maxLength,2000);
    f.node('material-preview-button').click();await tick();const call=f.calls.at(-1);assert.equal(call.method,'POST');assert.equal(call.body.albumId,7);assert.equal(call.body.image.mime,'image/png');assert.equal(call.body.caption,'Подпись <script>');assert.equal(f.node('material-apply').disabled,false);
    assert.match(f.node('material-preview').textContent,/12345/);assert.match(f.node('material-preview').textContent,/Фото <img src=x> · ID 7/);assert.equal(f.node('material-preview').querySelectorAll('img').length,1);assert.ok(!f.calls.some(c=>c.path.endsWith('/material-apply')));
    f.node('material-apply').click();f.node('material-apply').click();await tick();assert.equal(f.calls.filter(c=>c.path.endsWith('/material-apply')).length,1);assert.deepEqual(Object.keys(f.calls.at(-1).body).sort(),['previewId','requestId','revision']);release();await tick();assert.equal(f.node('material-apply').disabled,true);assert.match(f.node('status').textContent,/Проверено/);
  }finally{f.close();}
});
test('album preview is invalidated by caption, destination, file and binding changes',async()=>{
  const f=materialFixture();try{
    await materialDraft(f);
    for(const edit of [()=>f.input('material-caption','Изменено'),()=>{f.node('album').value='8';f.node('album').dispatchEvent(new f.w.Event('change'));},()=>materialFile(f,'second.png'),()=>f.input('design-token','FIXTURE_ONLY')]){
      f.node('album').value='7';f.node('material-preview-button').click();await tick();assert.equal(f.node('material-apply').disabled,false);await edit();assert.equal(f.node('material-apply').disabled,true);assert.equal(f.node('material-preview').children.length,0);
    }
    assert.equal(f.calls.filter(c=>c.path.endsWith('/material-apply')).length,0);
  }finally{f.close();}
});
test('late album preview after content edit or company switch cannot restore confirmation',async()=>{
  for(const edit of ['caption','company']){let release;const f=materialFixture(c=>c.path.endsWith('/material-preview')?new Promise(resolve=>{release=()=>resolve({...materialDto(c),album:{id:7,title:'PRIVATE_LATE_ALBUM'}});}):undefined);
    try{await materialDraft(f);f.node('material-preview-button').click();await tick();if(edit==='caption')f.input('material-caption','Changed');else await f.change('alvi');release();await tick();assert.equal(f.node('material-apply').disabled,true);assert.doesNotMatch(f.container.textContent,/PRIVATE_LATE_ALBUM/);}finally{f.close();}
  }
});
test('unknown album apply stays blocked across edits and company navigation until matching journal confirms outcome',async()=>{
  let original,verified=false;const f=materialFixture(c=>{
    if(c.path.endsWith('/material-apply')){original=c.body;throw Error('PRIVATE_PROVIDER_ERROR');}
    if(c.path.endsWith('/material-history'))return {...materialDto(c),items:verified?[{...materialDto(c),requestId:original.requestId,status:'verified'}]:[{...materialDto(c),revision:1,groupId:'999',requestId:original?.requestId,status:'verified'}]};
  });try{
    await materialDraft(f);f.node('material-preview-button').click();await tick();f.node('material-apply').click();await tick();assert.match(f.node('status').textContent,/не подтверждён/);f.input('material-caption','Changed');assert.equal(f.node('material-preview-button').disabled,true);
    f.node('material-history-refresh').click();await tick();assert.equal(f.calls.at(-1).query.revision,'2');assert.equal(f.node('material-preview-button').disabled,true,'old binding journal cannot clear current outcome lock');
    await f.change('alvi');await f.change('palitra-love');assert.match(f.node('materials-connection').textContent,/заблокирована/);assert.equal(f.node('material-apply').disabled,true);assert.equal(f.calls.filter(c=>c.path.endsWith('/material-apply')).length,1);
    verified=true;f.node('material-history-refresh').click();await tick();assert.match(f.node('status').textContent,/Проверено/);assert.equal(f.node('material-apply').disabled,true,'resolved outcome still requires a new preview');assert.doesNotMatch(f.container.textContent,/PRIVATE_PROVIDER_ERROR/);
  }finally{f.close();}
});
test('mixed-company material journal rejects the entire batch before rendering private titles',async()=>{
  const f=materialFixture(c=>c.path.endsWith('/material-history')?{...materialDto(c),items:[{...materialDto(c),album:{title:'SHOULD_NOT_RENDER'}},{...materialDto(c),companyCode:'alvi',album:{title:'OTHER_COMPANY_PRIVATE'}}]}:undefined);
  try{await f.mount();f.node('material-history-refresh').click();await tick();assert.doesNotMatch(f.container.textContent,/SHOULD_NOT_RENDER|OTHER_COMPANY_PRIVATE/);}finally{f.close();}
});
test('expired album previews never dispatch locally and explicit server expiry permits a new preview',async()=>{
  for(const local of [true,false]){const f=materialFixture(c=>{
    if(local&&c.path.endsWith('/material-preview'))return {...materialDto(c),expiresAt:'2000-01-01T00:00:00Z'};
    if(!local&&c.path.endsWith('/material-apply')){const error=Error('PRIVATE');error.code='PREVIEW_EXPIRED';throw error;}
  });try{await materialDraft(f);f.node('material-preview-button').click();await tick();f.node('material-apply').click();await tick();assert.equal(f.node('material-apply').disabled,true);assert.equal(f.node('material-preview-button').disabled,false);assert.match(f.node('status').textContent,/устарел/);assert.equal(f.calls.filter(c=>c.path.endsWith('/material-apply')).length,local?0:1);}finally{f.close();}}
});
test('known late album outcome clears only its company binding lock while unknown remains blocked',async()=>{
  for(const status of ['verified','uncertain']){let release;const f=materialFixture(c=>c.path.endsWith('/material-apply')?new Promise(resolve=>{release=()=>resolve({...materialDto(c),requestId:c.body.requestId,status});}):undefined);
    try{await materialDraft(f);f.node('material-preview-button').click();await tick();f.node('material-apply').click();await tick();await f.change('alvi');release();await tick();assert.doesNotMatch(f.node('status').textContent,/Проверено/);await f.change('palitra-love');assert.equal(f.node('materials-connection').textContent.includes('заблокирована'),status==='uncertain');}finally{f.close();}
  }
});

const avatarDto=c=>({companyCode:c.companyCode,groupId:c.companyCode==='palitra-love'?'12345':'123',revision:2,previewId:'avatar-preview',operation:'avatar',before:{hasPhoto:true,photo200:'https://sun9.userapi.com/old.jpg',photoMax:null,photoMaxOrig:null},after:{mime:c.body.image.mime,width:640,height:640,sourceHash:'a'.repeat(64)},sourceHash:'a'.repeat(64),warnings:['AVATAR_MAY_CREATE_PUBLIC_POST','AVATAR_APPLY_DISABLED','AVATAR_CROP_UNVERIFIED'],capabilities:{applyEnabled:false,cropSupported:false}});
function avatarFixture(override,{width=640,height=640,deferDecode=false}={}){
  const f=materialFixture(async c=>{if(override){const result=await override(c);if(result!==undefined)return result;}if(c.path.endsWith('/avatar-preview'))return avatarDto(c);});
  f.decoders=[];
  f.w.Image=class {
    constructor(){this.naturalWidth=width;this.naturalHeight=height;f.decoders.push(this);}
    set src(value){this.url=value;if(!deferDecode)setImmediate(()=>this.onload?.());}
  };
  return f;
}
async function avatarFile(f,{name='avatar.png',type='image/png',size,wait=true,file}={}){
  file ||= new f.w.File(['synthetic-image-fixture'],name,{type});if(size!==undefined)Object.defineProperty(file,'size',{value:size});
  let files=[file];const input=f.node('avatar-file');Object.defineProperty(input,'files',{configurable:true,get:()=>files});Object.defineProperty(input,'value',{configurable:true,get:()=>files.length?'C:\\fakepath\\'+files[0].name:'',set:value=>{if(value==='')files=[];}});
  input.dispatchEvent(new f.w.Event('input'));input.dispatchEvent(new f.w.Event('change'));
  if(wait)for(let i=0;i<30&&files.length&&!f.node('avatar-file-info').textContent;i++)await new Promise(resolve=>setTimeout(resolve,5));
  return file;
}
test('avatar preparation keeps selection local, shows square/circle and submits only frozen image to scoped preview',async()=>{
  const f=avatarFixture();try{
    await f.mount();const before=f.calls.length;assert.equal(f.node('avatar-preview-button').disabled,true);await avatarFile(f,{name:'avatar <img src=x>.png'});assert.equal(f.calls.length,before);
    const samples=[...f.node('avatar-local-preview').querySelectorAll('img')];assert.equal(samples.length,2);assert.ok(samples.every(img=>img.src.startsWith('data:image/png;base64,')));assert.equal(samples[1].style.borderRadius,'50%');assert.match(f.node('avatar-file-info').textContent,/640 × 640/);assert.equal(f.node('avatar-preview-button').disabled,false);
    f.node('avatar-preview-button').click();await tick();const call=f.calls.at(-1);assert.equal(call.path,'/content/crm/vk-tools/design/avatar-preview');assert.equal(call.companyCode,'palitra-love');assert.equal(call.method,'POST');assert.deepEqual(Object.keys(call.body).sort(),['image','revision']);assert.deepEqual(Object.keys(call.body.image).sort(),['base64','mime']);assert.equal(call.body.revision,2);
    assert.match(f.node('avatar-preview').textContent,/12345/);assert.match(f.node('avatar-preview').textContent,/Файл проверен сервером/);assert.match(f.node('avatar-preview').textContent,/не подтверждает права/);assert.equal(f.node('avatar-apply').disabled,true);assert.equal(f.node('avatar-effect').disabled,true);assert.equal(f.node('avatar-effect').checked,false);assert.equal(f.node('avatar-card').querySelector('script,iframe,input[type="range"]'),null);assert.ok(f.calls.every(c=>!c.path.endsWith('/avatar-apply')));
    assert.match(f.node('avatar-warning').textContent,/публичную запись на стене/);assert.match(f.node('avatar-warning').textContent,/отдельное разрешение владельца/);assert.match(f.node('avatar-warning').textContent,/подтверждённый доступ к API/);assert.match(f.node('avatar-card').textContent,/кадрирование ВК не подтверждено/);
    f.node('avatar-clear').click();assert.equal(f.node('avatar-local-preview').children.length,0);assert.equal(f.node('avatar-preview').children.length,0);assert.equal(f.node('avatar-file').value,'');assert.equal(f.node('avatar-preview-button').disabled,true);
  }finally{f.close();}
});
test('avatar rejects non-square, unsupported, empty and oversized local files without any API call',async()=>{
  for(const scenario of [{width:640,height:480},{type:'image/svg+xml'},{size:0},{size:8*1024*1024+1}]){
    const f=avatarFixture(undefined,scenario);try{await f.mount();const before=f.calls.length;await avatarFile(f,scenario);assert.equal(f.calls.length,before);assert.equal(f.node('avatar-preview-button').disabled,true);assert.equal(f.node('avatar-local-preview').children.length,0);assert.match(f.node('status').textContent,/квадратный|квадратное/);}finally{f.close();}
  }
});
test('avatar is gated on owner and checked user binding, independently from other design operations',async()=>{
  for(const extra of [{tokenType:'group'},{tokenType:'user',connected:false},{tokenType:'user',enabled:false}]){
    const f=fixture(c=>c.purpose==='design'&&c.path.endsWith('/settings')?setting(c.companyCode,'design',extra):undefined);
    try{await f.mount();assert.equal(f.node('avatar-file').disabled,true);assert.equal(f.node('avatar-preview-button').disabled,true);f.node('avatar-preview-button').dispatchEvent(new f.w.MouseEvent('click'));assert.equal(f.calls.length,2);assert.equal(f.node('avatar-apply').disabled,true);}finally{f.close();}
  }
  const f=fixture(undefined,'editor');try{await f.mount();assert.equal(f.calls.length,0);assert.equal(f.container.children.length,0);}finally{f.close();}
});
test('avatar application cannot be enabled by forged capabilities, checkbox changes or programmatic clicks',async()=>{
  const f=avatarFixture(c=>c.path.endsWith('/avatar-preview')?{...avatarDto(c),capabilities:{applyEnabled:true,cropSupported:true},warnings:[],before:{photoMaxOrig:'javascript:alert(1)'}}:undefined);
  try{await f.mount();await avatarFile(f);f.node('avatar-preview-button').click();await tick();assert.equal(f.node('avatar-preview').children.length,0);assert.equal(f.node('avatar-apply').disabled,true);assert.equal(f.node('avatar-effect').disabled,true);
    const before=f.calls.length;f.node('avatar-effect').disabled=false;f.node('avatar-effect').checked=true;f.node('avatar-effect').dispatchEvent(new f.w.Event('change'));assert.equal(f.node('avatar-effect').checked,false);assert.equal(f.node('avatar-effect').disabled,true);
    f.node('avatar-apply').disabled=false;f.node('avatar-apply').dispatchEvent(new f.w.MouseEvent('click'));f.node('avatar-apply').click();await tick();assert.equal(f.calls.length,before);await f.change('palitra-love');assert.equal(f.node('avatar-apply').disabled,true);assert.match(f.node('avatar-warning').textContent,/публичную запись/);assert.equal(f.node('avatar-card').querySelector('[href]'),null);
  }finally{f.close();}
});
test('reselecting the same avatar file or editing the binding invalidates prepared and in-flight previews',async()=>{
  for(const action of ['same-file','input','binding']){let release;const f=avatarFixture(c=>c.path.endsWith('/avatar-preview')?new Promise(resolve=>{release=()=>resolve(avatarDto(c));}):undefined);
    try{await f.mount();const file=await avatarFile(f);f.node('avatar-preview-button').click();await tick();if(action==='same-file')await avatarFile(f,{file});else if(action==='input')f.node('avatar-file').dispatchEvent(new f.w.Event('input'));else f.input('design-token','FIXTURE_ONLY');release();await tick();assert.equal(f.node('avatar-preview').children.length,0);assert.equal(f.node('avatar-apply').disabled,true);if(action!=='same-file')assert.equal(f.node('avatar-local-preview').children.length,0);}finally{f.close();}
  }
});
test('company/role changes discard late avatar preview and local decoder callbacks',async()=>{
  for(const phase of ['preview','decode'])for(const change of ['company','role']){let release;const f=avatarFixture(c=>phase==='preview'&&c.path.endsWith('/avatar-preview')?new Promise(resolve=>{release=()=>resolve(avatarDto(c));}):undefined,{deferDecode:phase==='decode'});
    try{
      await f.mount();await avatarFile(f,{wait:phase!=='decode'});
      if(phase==='decode'){for(let i=0;i<30&&!f.decoders.length;i++)await new Promise(resolve=>setTimeout(resolve,5));release=()=>f.decoders[0].onload();}else{f.node('avatar-preview-button').click();await tick();}
      await f.change(change==='company'?'alvi':'palitra-love',change==='role'?'editor':'owner');release();await tick();
      if(change==='role')assert.equal(f.container.children.length,0);else{assert.equal(f.node('avatar-preview').children.length,0);assert.equal(f.node('avatar-local-preview').children.length,0);assert.equal(f.node('avatar-file-info').textContent,'');assert.equal(f.node('avatar-preview-button').disabled,true);}
    }finally{f.close();}
  }
});
test('avatar server preview rejects foreign scopes and missing or inconsistent source hashes',async()=>{
  for(const wrong of [{companyCode:'alvi'},{groupId:'999'},{revision:999},{sourceHash:undefined},{sourceHash:'b'.repeat(64)}]){const f=avatarFixture(c=>c.path.endsWith('/avatar-preview')?{...avatarDto(c),...wrong}:undefined);
    try{await f.mount();await avatarFile(f);f.node('avatar-preview-button').click();await tick();assert.equal(f.node('avatar-preview').children.length,0);assert.equal(f.node('avatar-apply').disabled,true);assert.ok(f.calls.every(c=>!c.path.endsWith('/avatar-apply')));}finally{f.close();}
  }
});
