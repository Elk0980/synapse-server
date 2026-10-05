'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(__dirname + '/vk-community.js', 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const SECRET = 'FIXTURE_PRIVATE_VK_TOKEN';
function shellResponseError() {
  const shell = fs.readFileSync(__dirname + '/../cabinet.html', 'utf8');
  const match = shell.match(/const responseError = \(response, body\) => \{[\s\S]*?\n  \};(?=\s*const apiJson)/);
  assert.ok(match, 'test must execute the actual shell responseError implementation');
  return vm.runInNewContext(match[0] + '\nresponseError;');
}
const settings = (companyCode = 'avokado', extra = {}) => ({ companyCode, groupId: companyCode === 'avokado' ? '12345' : '67890', revision: 1,
  configured: true, tokenConfigured: true, connected: true, status: 'connected', checkedAt: '2026-09-17T12:00:00Z', errorCode: null,
  group: { id: '12345', name: companyCode === 'avokado' ? 'Авокадо ВК' : 'АЛВИ ВК', screenName: 'fixture' }, ...extra });
const dialog = (peerId = 101, extra = {}) => ({ peerId, title: 'Клиент <img src=x>', unreadCount: 1, canReply: true,
  lastMessage: { id: 10, peerId, fromId: peerId, text: 'Текст <script>test</script>', date: 1789640000, out: false }, ...extra });
function fixture({ role = 'owner', override, directTools = false } = {}) {
  const errors = [], calls = [], views = {}, vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<main id="view"></main>', { url: 'https://cabinet.example.test/cabinet.html#vk-community', runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window, d = w.document, container = d.getElementById('view');
  w.SbCabinet = { registerView(name, view) { views[name] = view; } };
  if (directTools) w.eval(fs.readFileSync(__dirname + '/vk-tools.js', 'utf8'));
  w.eval(source);
  let ctx = { selectedProjectId: 'avokado', identity: { role, companies: [{ id: 'avokado', name: 'Авокадо' }, { id: 'alvi', name: 'АЛВИ' }] },
    csrfOptions: (method, body) => ({ method, body: JSON.stringify(body), headers: { 'X-CSRF-Token': 'fixture-csrf' } }),
    async apiJson(url, options = {}) {
      const parsed = new URL(url, 'https://cabinet.example.test');
      const call = { path: parsed.pathname, companyCode: parsed.searchParams.get('companyCode'), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers };
      calls.push(call);
      assert.ok(call.companyCode === 'avokado' || call.companyCode === 'alvi', 'every call must be scoped');
      if (call.method !== 'GET') assert.equal(call.headers['X-CSRF-Token'], 'fixture-csrf');
      if (override) { const value = await override(call); if (value !== undefined) return value; }
      const base = { companyCode: call.companyCode, revision: 1 };
      if (call.path.includes('/vk-tools/')) return { ...base, purpose: call.path.split('/')[4], groupId: '12345', tokenType: call.path.includes('/analytics/') ? 'user' : 'group', configured: true, enabled: true, connected: true };
      if (call.path.endsWith('/autoposting/settings')) return { channels: [] };
      if (call.path.endsWith('/settings')) return settings(call.companyCode, call.method === 'PUT' ? { revision: 2, connected: false, status: 'needs_check' } : {});
      if (call.path.endsWith('/check')) return { ...settings(call.companyCode), ok: true };
      if (call.path.endsWith('/conversations')) return { ...base, count: 1, offset: call.body.offset, rawPageSize: 1, items: [dialog()] };
      if (call.path.endsWith('/history')) return { ...base, peerId: call.body.peerId, count: 1, offset: 0, items: [dialog(call.body.peerId).lastMessage] };
      if (call.path.endsWith('/reply')) return { ...base, peerId: call.body.peerId, requestId: call.body.requestId, status: 'sent', messageId: 99, code: null };
      assert.fail('Unexpected mock route: ' + call.path);
    }
  };
  const node = id => container.querySelector('#vk-' + id);
  return { dom, w, d, errors, calls, container, node,
    mount() { return views['vk-community'].render(container, ctx); },
    change(companyCode, role = ctx.identity.role, render = false) {
      ctx = { ...ctx, selectedProjectId: companyCode, identity: { ...ctx.identity, role } };
      return render ? views['vk-community'].render(container, ctx) : views['vk-community'].onProjectChange(ctx);
    },
    input(id, value) { node(id).value = value; node(id).dispatchEvent(new w.Event('input', { bubbles: true })); },
    submit(id) { node(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); },
    async inbox() { node('sync').click(); await tick(); container.querySelector('[data-peer]').click(); await tick(); },
    close() { assert.deepEqual(errors, []); w.close(); }
  };
}

test('non-owner sees no connection controls and makes no API calls', async () => {
  const f = fixture({ role: 'editor' }); try {
    await f.mount(); assert.equal(f.calls.length, 0); assert.equal(f.container.children.length, 0);
    await f.change('alvi'); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('direct tools mount alongside inbox with independent controls and clear together on project change', async () => {
  const f = fixture({ directTools: true });
  try {
    await f.mount();
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls.every(call => call.method === 'GET'));
    const directNode = id => f.container.querySelector('#vkt-' + id);
    assert.equal(directNode('analytics-type').disabled, true, 'inbox controls cannot enable a forbidden analytics token type');
    assert.equal(directNode('apply').disabled, true, 'inbox load cannot enable unpreviewed apply');
    directNode('design-token').value = 'PRIVATE_DIRECT_KEY';
    directNode('description').value = 'PRIVATE_DIRECT_DRAFT';
    await f.change('alvi');
    assert.equal(directNode('design-token').value, '');
    assert.equal(directNode('description').value, '');
    assert.equal(f.node('token').value, '');
    await f.change('alvi', 'editor', true);
    assert.equal(f.container.children.length, 0);
  } finally { f.close(); }
});

test('initial owner rendering only reads selected-company settings and never checks, syncs or sends automatically', async () => {
  const f = fixture(); try {
    await f.mount(); assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.method === 'GET' && call.companyCode === 'avokado'));
    assert.deepEqual(f.calls.map(call => call.path), ['/content/crm/vk-community/settings', '/content/crm/autoposting/settings']);
    assert.equal(f.node('token').type, 'password'); assert.equal(f.node('token').value, '');
    assert.equal(f.node('reply-panel').hidden, true);
    assert.ok(f.container.querySelector('a[href="#ad-platforms"]')); assert.match(f.container.textContent, /Ручные снимки/);
  } finally { f.close(); }
});

test('save sends only an explicit secret input with CSRF and clears it afterwards without automatic verification', async () => {
  const f = fixture(); try {
    await f.mount(); f.input('token', SECRET); assert.equal(f.node('check').disabled, true); f.submit('settings-form'); await tick();
    const saved = f.calls.at(-1); assert.equal(saved.method, 'PUT');
    assert.deepEqual(saved.body, { revision: 1, groupId: '12345', communityToken: SECRET });
    assert.equal(f.node('token').value, ''); assert.doesNotMatch(f.container.innerHTML + f.container.textContent, new RegExp(SECRET));
    assert.equal(f.node('sync').disabled, true); assert.equal(f.calls.length, 3); assert.match(f.node('status').textContent, /Теперь проверьте доступ/);
    f.submit('settings-form'); await tick(); assert.equal(Object.hasOwn(f.calls.at(-1).body, 'communityToken'), false);
  } finally { f.close(); }
});

test('actual shell HTTP 409 keeps SETTINGS_CHANGED for the UI and retains the unsaved secret in its input', async () => {
  const responseError = shellResponseError();
  const f = fixture({ override: async call => {
    if (call.method !== 'PUT' || !call.path.endsWith('/settings')) return;
    const response = new Response(JSON.stringify({ error: 'Подключение изменилось. Обновите страницу', code: 'SETTINGS_CHANGED' }), {
      status: 409, headers: { 'content-type': 'application/json' }
    });
    throw responseError(response, await response.json());
  } });
  try {
    await f.mount(); f.input('token', SECRET); f.submit('settings-form'); await tick();
    assert.match(f.node('status').textContent, /Подключение изменилось\. Обновите раздел/);
    assert.equal(f.node('token').value, SECRET, 'failed save must preserve the value for the owner');
    assert.equal(f.node('token').type, 'password'); assert.equal(f.node('save').disabled, false);
    assert.equal(f.node('check').disabled, true); assert.equal(f.node('sync').disabled, true);
    assert.doesNotMatch(f.container.textContent + f.container.innerHTML, new RegExp(SECRET));
    assert.equal(f.calls.length, 3, 'failed save must not check, sync or retry by itself');
  } finally { f.close(); }
});

test('actual shell keeps 403 wording generic and ignores invalid error codes', () => {
  const responseError = shellResponseError();
  const forbidden = responseError(new Response('', { status: 403 }), { error: SECRET, code: 'FORBIDDEN' });
  assert.equal(forbidden.message, 'Недостаточно прав'); assert.equal(forbidden.code, 'FORBIDDEN');
  for (const invalid of [null, 5, '', 'settings_changed', 'SETTINGS_CHANGED<script>', 'A'.repeat(65)]) {
    const error = responseError(new Response('', { status: 409 }), { error: 'Ошибка запроса', code: invalid });
    assert.equal(Object.hasOwn(error, 'code'), false);
  }
});

test('manual check, sync and history are separate explicit actions; remote text renders as text and read never sends', async () => {
  const f = fixture(); try {
    await f.mount(); f.node('check').click(); await tick();
    assert.equal(f.calls.at(-1).path, '/content/crm/vk-community/check'); assert.equal(f.calls.at(-1).method, 'POST');
    await f.inbox();
    assert.deepEqual(f.calls.slice(3).map(call => call.path), ['/content/crm/vk-community/conversations', '/content/crm/vk-community/history']);
    assert.equal(f.calls.at(-1).body.peerId, 101); assert.equal(f.node('reply-panel').hidden, false);
    assert.equal(f.container.querySelector('img,script'), null); assert.match(f.node('messages').textContent, /<script>test<\/script>/);
    assert.equal(f.calls.some(call => call.path.endsWith('/reply')), false);
  } finally { f.close(); }
});

test('typing a reply sends nothing; explicit submit is scoped and the confirmed response is shown once', async () => {
  const f = fixture(); try {
    await f.mount(); await f.inbox(); const before = f.calls.length;
    f.input('reply', 'Ответ <img src=x>'); await tick(); assert.equal(f.calls.length, before);
    f.submit('reply-panel'); await tick(); const call = f.calls.at(-1);
    assert.equal(call.path, '/content/crm/vk-community/reply'); assert.equal(call.companyCode, 'avokado');
    assert.equal(call.body.revision, 1); assert.equal(call.body.peerId, 101); assert.equal(call.body.text, 'Ответ <img src=x>');
    assert.match(call.body.requestId, /^[a-zA-Z0-9_-]{16,100}$/);
    assert.equal(f.node('reply').value, ''); assert.equal(f.node('send').disabled, true);
    assert.match(f.node('status').textContent, /ВК подтвердил отправку/); assert.equal(f.node('messages').querySelector('img'), null);
    assert.equal(f.node('messages').querySelectorAll('.vk-message-out').length, 1);
  } finally { f.close(); }
});

test('denied conversations do not offer a reply and cannot be sent through form submission', async () => {
  const f = fixture({ override: call => call.path.endsWith('/conversations') ? { companyCode: call.companyCode, revision: 1, offset: 0, count: 1, rawPageSize: 1, items: [dialog(101, { canReply: false })] } : undefined });
  try {
    await f.mount(); await f.inbox(); assert.equal(f.node('reply-panel').hidden, true); f.input('reply', 'Test'); f.submit('reply-panel'); await tick();
    assert.equal(f.calls.some(call => call.path.endsWith('/reply')), false);
  } finally { f.close(); }
});

test('uncertain, sending and lost-response results block resubmission even after editing the text', async () => {
  for (const status of ['uncertain', 'sending', 'lost']) {
    const f = fixture({ override: call => {
      if (!call.path.endsWith('/reply')) return;
      if (status === 'lost') throw new Error(SECRET);
      return { companyCode: call.companyCode, revision: 1, peerId: call.body.peerId, requestId: call.body.requestId, status, messageId: null, code: null };
    } });
    try {
      await f.mount(); await f.inbox(); f.input('reply', 'Test reply'); f.submit('reply-panel'); await tick();
      assert.equal(f.node('reply').value, 'Test reply'); assert.equal(f.node('send').disabled, true, status);
      assert.doesNotMatch(f.node('status').textContent, new RegExp(SECRET));
      f.input('reply', 'Edited while unconfirmed'); f.submit('reply-panel'); await tick();
      assert.equal(f.calls.filter(call => call.path.endsWith('/reply')).length, 1, status);
      assert.equal(f.node('messages').querySelectorAll('.vk-message-out').length, 0);
    } finally { f.close(); }
  }
});

test('late settings from a previously selected company do not reveal its group or start further reads', async () => {
  let resolveOld;
  const f = fixture({ override: call => call.companyCode === 'avokado' && call.path.endsWith('/vk-community/settings') ? new Promise(resolve => { resolveOld = resolve; }) : undefined });
  try {
    const pending = f.mount(); await f.change('alvi');
    resolveOld(settings('avokado', { group: { name: 'PRIVATE OLD GROUP' } })); await pending;
    assert.equal(f.node('group').value, '67890'); assert.doesNotMatch(f.container.textContent, /PRIVATE OLD GROUP/);
    assert.equal(f.calls.filter(call => call.companyCode === 'avokado').length, 1);
  } finally { f.close(); }
});

test('company switch clears an entered secret, draft and conversations immediately', async () => {
  const f = fixture();
  try {
    await f.mount(); await f.inbox(); f.input('reply', 'OLD PRIVATE DRAFT'); f.input('token', SECRET);
    assert.equal(f.node('token').value, SECRET); assert.equal(f.node('reply').value, 'OLD PRIVATE DRAFT');
    const changed = f.change('alvi');
    assert.equal(f.node('token').value, ''); assert.equal(f.node('reply').value, ''); assert.equal(f.node('messages').children.length, 0);
    assert.equal(f.container.querySelector('[data-peer]'), null);
    await changed;
    assert.doesNotMatch(f.container.textContent, /OLD PRIVATE DRAFT/); assert.equal(f.node('group').value, '67890');
    assert.ok(f.calls.filter(call => call.companyCode === 'alvi').every(call => call.method === 'GET'));
  } finally { f.close(); }
});

test('late conversation history is discarded after changing company', async () => {
  let release;
  const f = fixture({ override: call => call.path.endsWith('/history') ? new Promise(resolve => { release = resolve; }) : undefined });
  try {
    await f.mount(); f.node('sync').click(); await tick(); f.container.querySelector('[data-peer]').click(); await tick();
    await f.change('alvi');
    release({ companyCode: 'avokado', revision: 1, peerId: 101, count: 1, items: [{ ...dialog().lastMessage, text: 'LATE PRIVATE HISTORY' }] }); await tick();
    assert.doesNotMatch(f.container.textContent, /LATE PRIVATE HISTORY/); assert.equal(f.node('group').value, '67890');
  } finally { f.close(); }
});

test('late send success from the old company cannot populate the new company conversation', async () => {
  let release;
  const f = fixture({ override: call => call.path.endsWith('/reply') ? new Promise(resolve => { release = () => resolve({ companyCode: call.companyCode, revision: 1, peerId: call.body.peerId, requestId: call.body.requestId, status: 'sent', messageId: 99 }); }) : undefined });
  try {
    await f.mount(); await f.inbox(); f.input('reply', 'OLD SENT TEXT'); f.submit('reply-panel'); await tick(); await f.change('alvi');
    release(); await tick(); assert.doesNotMatch(f.container.textContent, /OLD SENT TEXT|ВК подтвердил отправку/);
    assert.equal(f.node('messages').children.length, 0); assert.equal(f.node('reply-panel').hidden, true);
  } finally { f.close(); }
});

test('losing owner role during a request removes private UI and does not revive it after the response', async () => {
  let release;
  const f = fixture({ override: call => call.path.endsWith('/history') ? new Promise(resolve => { release = resolve; }) : undefined });
  try {
    await f.mount(); f.node('sync').click(); await tick(); f.container.querySelector('[data-peer]').click(); await tick();
    await f.change('avokado', 'editor', true); assert.equal(f.container.children.length, 0);
    release({ companyCode: 'avokado', revision: 1, peerId: 101, items: [{ ...dialog().lastMessage, text: 'PRIVATE AFTER ROLE LOST' }] }); await tick();
    assert.equal(f.container.children.length, 0); assert.equal(f.calls.filter(call => call.path.endsWith('/reply')).length, 0);
  } finally { f.close(); }
});

test('pagination advances by the raw 30-item page even when filtering leaves no personal dialogs', async () => {
  const f = fixture({ override: call => call.path.endsWith('/conversations') ? {
    companyCode: call.companyCode, revision: 1, offset: call.body.offset, count: 61, items: []
  } : undefined });
  try {
    await f.mount(); f.node('sync').click(); await tick();
    assert.equal(f.node('next').disabled, false); assert.equal(f.node('previous').disabled, true);
    assert.match(f.node('page-label').textContent, /Страница 1 из 3/);
    f.node('next').click(); await tick();
    assert.equal(f.calls.at(-1).body.offset, 30); assert.equal(f.node('next').disabled, false);
    assert.match(f.node('page-label').textContent, /Страница 2 из 3/);
    f.node('next').click(); await tick();
    assert.equal(f.calls.at(-1).body.offset, 60); assert.equal(f.node('next').disabled, true);
    assert.equal(f.node('previous').disabled, false); assert.match(f.node('page-label').textContent, /Страница 3 из 3/);
  } finally { f.close(); }
});

test('losing owner through render invalidates a pending reply without showing its later success or sending again', async () => {
  let release;
  const f = fixture({ override: call => call.path.endsWith('/reply') ? new Promise(resolve => {
    release = () => resolve({ companyCode: call.companyCode, revision: 1, peerId: call.body.peerId, requestId: call.body.requestId, status: 'sent', messageId: 99 });
  }) : undefined });
  try {
    await f.mount(); await f.inbox(); f.input('reply', 'PRIVATE PENDING SEND'); f.submit('reply-panel'); await tick();
    await f.change('avokado', 'editor', true); assert.equal(f.container.children.length, 0);
    release(); await tick(); assert.equal(f.container.children.length, 0);
    assert.equal(f.calls.filter(call => call.path.endsWith('/reply')).length, 1);
    await f.change('alvi', 'owner', true); assert.equal(f.node('group').value, '67890');
    assert.doesNotMatch(f.container.textContent, /PRIVATE PENDING SEND|ВК подтвердил отправку/);
    assert.equal(f.node('reply').value, ''); assert.equal(f.node('messages').children.length, 0);
  } finally { f.close(); }
});

const attachmentPreview=call=>({companyCode:call.companyCode,groupId:call.companyCode==='avokado'?'12345':'67890',revision:1,peerId:call.body.peerId,previewId:'attachment-preview',text:call.body.text,file:{name:call.body.file.name,mime:call.body.file.mime,size:7,sourceHash:'fixture-hash'},expiresAt:'2099-01-01T00:00:00Z'});
function attachmentFixture(override){return fixture({override:async call=>{
  if(override){const result=await override(call);if(result!==undefined)return result;}
  if(call.path.endsWith('/reply-preview'))return attachmentPreview(call);
  if(call.path.endsWith('/reply-confirm'))return {companyCode:call.companyCode,groupId:call.companyCode==='avokado'?'12345':'67890',revision:1,peerId:101,previewId:call.body.previewId,requestId:call.body.requestId,status:'sent',messageId:100};
}});}
async function attachmentFile(f,{name='fixture.pdf',type='application/pdf',bytes='fixture'}={}){
  let files=[new f.w.File([bytes],name,{type})];const input=f.node('reply-file');
  Object.defineProperty(input,'files',{configurable:true,get:()=>files});
  Object.defineProperty(input,'value',{configurable:true,get:()=>files.length?'C:\\fakepath\\'+files[0].name:'',set:value=>{if(value==='')files=[];}});
  input.dispatchEvent(new f.w.Event('change'));
  for(let i=0;i<30&&files.length&&!f.node('reply-file-info').textContent;i++)await new Promise(resolve=>setTimeout(resolve,5));
}
async function attachmentDraft(f){await f.mount();await f.inbox();await attachmentFile(f);}

test('incoming photo/PDF attachments render safe links and hostile/unsupported attachments stay unavailable',async()=>{
  const f=fixture({override:call=>call.path.endsWith('/history')?{companyCode:call.companyCode,revision:1,peerId:101,items:[{...dialog().lastMessage,attachments:[
    {type:'photo',url:'https://sun9.userapi.com/photo.jpg',name:'<img src=x>',width:100,height:80},
    {type:'doc',url:'https://vk.com/doc1_2',name:'<script>.pdf',mime:'application/pdf'},
    {type:'photo',url:'javascript:alert(1)',name:'BAD'},
    {type:'photo',url:'https://userapi.com.attacker.test/a',name:'BAD'},
    {type:'doc',url:'https://vk.com/doc1_3',name:'program.exe',mime:'application/octet-stream'},
    {type:'unavailable',name:'Unsupported'}
  ]}]}:undefined});
  try{await f.mount();await f.inbox();const links=[...f.node('messages').querySelectorAll('a')];assert.equal(links.length,2);assert.ok(links.every(link=>link.rel==='noopener noreferrer'&&link.referrerPolicy==='no-referrer'));assert.equal(f.node('messages').querySelector('img,script'),null);assert.match(f.node('messages').textContent,/<img src=x>/);assert.equal((f.node('messages').textContent.match(/Вложение недоступно/g)||[]).length,4);assert.equal(f.calls.some(c=>c.path.includes('/reply')),false);}finally{f.close();}
});
test('file-only reply stays local through selection and requires preview then one frozen explicit confirmation',async()=>{
  let release;const f=attachmentFixture(call=>call.path.endsWith('/reply-confirm')?new Promise(resolve=>{release=()=>resolve({companyCode:call.companyCode,groupId:'12345',revision:1,peerId:101,previewId:call.body.previewId,requestId:call.body.requestId,status:'sent'});}):undefined);
  try{
    await attachmentDraft(f);const before=f.calls.length;assert.equal(f.node('reply').value,'');f.submit('reply-panel');await tick();assert.equal(f.calls.length,before,'form submit with file cannot use text-only send');
    f.node('reply-preview-button').click();await tick();assert.equal(f.calls.at(-1).path,'/content/crm/vk-community/reply-preview');assert.equal(f.calls.at(-1).body.text,'');assert.equal(f.calls.at(-1).body.file.mime,'application/pdf');assert.equal(f.calls.some(c=>c.path.endsWith('/reply-confirm')),false);
    assert.match(f.node('reply-preview').textContent,/12345/);assert.match(f.node('reply-preview').textContent,/ID 101/);assert.match(f.node('reply-preview').textContent,/fixture.pdf/);assert.equal(f.node('reply-preview').querySelector('iframe,embed,object'),null);
    f.node('reply-confirm').click();f.node('reply-confirm').click();await tick();assert.equal(f.calls.filter(c=>c.path.endsWith('/reply-confirm')).length,1);assert.deepEqual(Object.keys(f.calls.at(-1).body).sort(),['previewId','requestId','revision']);release();await tick();assert.match(f.node('status').textContent,/подтвердил отправку ответа с вложением/);assert.equal(f.node('reply-file-info').textContent,'');assert.equal(f.node('reply-confirm').disabled,true);assert.equal(f.node('messages').querySelectorAll('.vk-message-out').length,1);
  }finally{f.close();}
});
test('attachment confirmation is invalidated by text, file and binding edits without sending',async()=>{
  const f=attachmentFixture();try{
    await attachmentDraft(f);
    for(const edit of [()=>f.input('reply','Новый текст'),()=>attachmentFile(f,{name:'second.png',type:'image/png'}),()=>f.input('token',SECRET)]){
      f.node('reply-preview-button').click();await tick();assert.equal(f.node('reply-confirm').disabled,false);await edit();assert.equal(f.node('reply-confirm').disabled,true);assert.equal(f.node('reply-preview').children.length,0);
    }
    assert.equal(f.calls.some(c=>c.path.endsWith('/reply-confirm')||c.path.endsWith('/reply')),false);
  }finally{f.close();}
});
test('late attachment preview cannot revive confirmation after text edit, company change or role loss',async()=>{
  for(const action of ['text','company','role']){let release;const f=attachmentFixture(call=>call.path.endsWith('/reply-preview')?new Promise(resolve=>{release=()=>resolve({...attachmentPreview(call),file:{...attachmentPreview(call).file,name:'PRIVATE_LATE_FILE'}});}):undefined);
    try{await attachmentDraft(f);f.node('reply-preview-button').click();await tick();if(action==='text')f.input('reply','Changed');else await f.change(action==='company'?'alvi':'avokado',action==='role'?'editor':'owner',true);release();await tick();assert.doesNotMatch(f.container.textContent,/PRIVATE_LATE_FILE/);if(action!=='role')assert.equal(f.node('reply-confirm').disabled,true);else assert.equal(f.container.children.length,0);}finally{f.close();}
  }
});
test('unknown attachment send remains blocked after file removal, dialog refresh and company roundtrip',async()=>{
  const f=attachmentFixture(call=>{if(call.path.endsWith('/reply-confirm'))throw Error('PRIVATE_NETWORK_FAILURE');});
  try{
    await attachmentDraft(f);f.node('reply-preview-button').click();await tick();f.node('reply-confirm').click();await tick();assert.match(f.node('status').textContent,/не подтверждён/);f.node('reply-file-clear').click();f.input('reply','Edited text');f.submit('reply-panel');assert.equal(f.node('send').disabled,true);
    await f.inbox();f.input('reply','Another text');assert.equal(f.node('send').disabled,true);await f.change('alvi');await f.change('avokado');await f.inbox();f.input('reply','Another text');assert.equal(f.node('send').disabled,true);assert.equal(f.calls.filter(c=>c.path.endsWith('/reply-confirm')).length,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/reply')).length,0);assert.doesNotMatch(f.container.textContent,/PRIVATE_NETWORK_FAILURE/);
  }finally{f.close();}
});
test('wrong-scope attachment preview never displays content or enables confirm',async()=>{
  for(const wrong of [{companyCode:'alvi'},{revision:8},{peerId:999},{groupId:'999'}]){const f=attachmentFixture(call=>call.path.endsWith('/reply-preview')?{...attachmentPreview(call),...wrong,file:{...attachmentPreview(call).file,name:'WRONG_PRIVATE_FILE'}}:undefined);
    try{await attachmentDraft(f);f.node('reply-preview-button').click();await tick();assert.equal(f.node('reply-confirm').disabled,true);assert.doesNotMatch(f.container.textContent,/WRONG_PRIVATE_FILE/);}finally{f.close();}
  }
});
test('known late text/attachment send outcome clears only its original lock without rendering in another company',async()=>{
  for(const attachment of [false,true])for(const status of ['sent','uncertain']){let release;const f=attachmentFixture(call=>call.path.endsWith(attachment?'/reply-confirm':'/reply')?new Promise(resolve=>{release=()=>resolve({companyCode:call.companyCode,groupId:'12345',revision:1,peerId:101,previewId:call.body.previewId,requestId:call.body.requestId,status});}):undefined);
    try{
      await f.mount();await f.inbox();f.input('reply','PRIVATE_OLD_REPLY');if(attachment){await attachmentFile(f);f.node('reply-preview-button').click();await tick();f.node('reply-confirm').click();}else f.submit('reply-panel');await tick();await f.change('alvi');release();await tick();assert.doesNotMatch(f.container.textContent,/PRIVATE_OLD_REPLY|подтвердил отправку/);
      await f.change('avokado');await f.inbox();f.input('reply','Fresh reply');assert.equal(f.node('send').disabled,status==='uncertain');
    }finally{f.close();}
  }
});
test('explicit pre-dispatch attachment expiry allows a new preview; unknown transport error never does',async()=>{
  for(const errorCode of ['PREVIEW_EXPIRED',null]){const f=attachmentFixture(call=>{if(call.path.endsWith('/reply-confirm')){const error=Error('PRIVATE');if(errorCode)error.code=errorCode;throw error;}});
    try{await attachmentDraft(f);f.node('reply-preview-button').click();await tick();f.node('reply-confirm').click();await tick();assert.equal(f.node('reply-confirm').disabled,true);assert.equal(f.node('reply-preview-button').disabled,errorCode===null);assert.doesNotMatch(f.container.textContent,/PRIVATE/);}finally{f.close();}
  }
});
test('returning to the original dialog before a late confirmed send refreshes controls without reviving old text',async()=>{
  let release;const f=attachmentFixture(call=>call.path.endsWith('/reply-confirm')?new Promise(resolve=>{release=()=>resolve({companyCode:call.companyCode,groupId:'12345',revision:1,peerId:101,previewId:call.body.previewId,requestId:call.body.requestId,status:'sent'});}):undefined);
  try{await attachmentDraft(f);f.input('reply','PRIVATE_PENDING_TEXT');f.node('reply-preview-button').click();await tick();f.node('reply-confirm').click();await tick();await f.change('alvi');await f.change('avokado');await f.inbox();f.input('reply','Fresh draft');assert.equal(f.node('send').disabled,true);release();await tick();assert.equal(f.node('send').disabled,false);assert.equal(f.node('reply').value,'Fresh draft');assert.doesNotMatch(f.container.textContent,/PRIVATE_PENDING_TEXT/);assert.equal(f.node('messages').querySelectorAll('.vk-message-out').length,0);}finally{f.close();}
});
