'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {randomBytes} = require('node:crypto');
const {mkdtemp, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createAuthStore} = require('./auth-store');
const {hashPassword} = require('./passwords');
const {createEmailUnsubscribeProxy} = require('./email-unsubscribe-proxy');
const token = 'a'.repeat(43), secondToken = 'b'.repeat(43);
const confirmation = '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Отписка</title><form method="post"><button>Отписаться</button></form></html>';
const statusIs = status => error => error.status === status;
const htmlResponse = (body = confirmation, status = 200, contentType = 'text/html; charset=utf-8') =>
  new Response(body, {status, headers:{'content-type':contentType}});

function assertSafeHtml(result, status, {head = false} = {}) {
  assert.equal(result.status, status);
  assert.match(result.headers.get('content-type'), /^text\/html/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  const csp = result.headers.get('content-security-policy');
  for (const expected of ["default-src 'none'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(expected));
  assert.ok(!csp.includes("script-src 'unsafe-inline'"));
  if (!head) assert.match(result.text, /<!doctype html>/i);
  assert.doesNotMatch(result.text, /PRIVATE|recipient@example|browser-secret|fixture-key/);
}

test('unsubscribe bridge supports GET and one-click POST with only trusted upstream headers', async () => {
  const calls = [];
  const unsubscribe = createEmailUnsubscribeProxy({crmUrl:'http://127.0.0.1:9000', apiKey:'fixture-internal-key',
    fetch:async (url, options) => {calls.push({url, options});return htmlResponse();}});
  for (const method of ['GET','POST']) {
    const result = await unsubscribe({token, method, body:'List-Unsubscribe=One-Click',
      headers:{cookie:'browser-cookie', authorization:'browser-secret'}, url:'https://other.example.test'});
    assert.deepEqual(result, {status:200, html:confirmation});
    const call = calls.at(-1);
    assert.equal(call.url, `http://127.0.0.1:9000/email-unsubscribe/${token}`);
    assert.equal(call.options.method, method);
    assert.deepEqual(call.options.headers, {'x-api-key':'fixture-internal-key', accept:'text/html',
      ...(method === 'POST' ? {'content-type':'application/x-www-form-urlencoded'} : {})});
    assert.equal(call.options.body, method === 'POST' ? 'List-Unsubscribe=One-Click' : undefined);
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test('invalid tokens, methods and oversized request bodies are rejected before contacting CRM', async () => {
  let calls = 0;
  const unsubscribe = createEmailUnsubscribeProxy({crmUrl:'http://127.0.0.1:9000', apiKey:'fixture-key',
    fetch:async () => {calls++;return htmlResponse();}});
  for (const invalid of ['', null, 'short', 'a'.repeat(44), 'a'.repeat(42) + '/', 'a'.repeat(42) + '%']) {
    await assert.rejects(unsubscribe({token:invalid, method:'GET'}), statusIs(404));
  }
  for (const method of ['PUT','PATCH','DELETE','HEAD','get']) await assert.rejects(unsubscribe({token, method}), statusIs(404));
  for (const body of ['a'.repeat(1025), 'я'.repeat(513), {}, null]) {
    await assert.rejects(unsubscribe({token, method:'POST', body}), statusIs(413));
  }
  assert.equal(calls, 0);
  const unavailable = createEmailUnsubscribeProxy({crmUrl:'http://127.0.0.1:9000', apiKey:'', fetch:async () => {calls++;}});
  await assert.rejects(unavailable({token, method:'GET'}), statusIs(503));
  assert.equal(calls, 0);
  await unsubscribe({token, method:'POST', body:'я'.repeat(512)});
  assert.equal(calls, 1, 'the 1024-byte boundary is accepted');
});

test('only bounded HTML success is relayed; missing and failed upstream responses never disclose private details', async () => {
  for (const makeResponse of [
    () => htmlResponse('PRIVATE_UPSTREAM', 500),
    () => htmlResponse('{"private":"PRIVATE_UPSTREAM"}', 200, 'application/json'),
    () => htmlResponse('PRIVATE_UPSTREAM', 200, 'text/html-malicious'),
    () => htmlResponse('я'.repeat(32769)),
    () => {throw new Error('PRIVATE_UPSTREAM fixture-key');},
  ]) {
    const unsubscribe = createEmailUnsubscribeProxy({crmUrl:'http://127.0.0.1:9000', apiKey:'fixture-key', fetch:async () => makeResponse()});
    await assert.rejects(unsubscribe({token, method:'GET'}), error => error.status === 502 && !/PRIVATE|fixture/.test(error.message));
  }
  const missing = createEmailUnsubscribeProxy({crmUrl:'http://127.0.0.1:9000', apiKey:'fixture-key',
    fetch:async () => htmlResponse('PRIVATE_UPSTREAM recipient@example.test', 404)});
  const result = await missing({token, method:'GET'});
  assert.equal(result.status, 404);
  assert.match(result.html, /<!doctype html>/i);
  assert.doesNotMatch(result.html, /PRIVATE|recipient@example/);
});

async function freePort() {
  const server = http.createServer();server.listen(0, '127.0.0.1');await once(server, 'listening');
  const port = server.address().port;await new Promise(resolve => server.close(resolve));return port;
}
async function fixture(t, {crmConfigured = true} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'content-unsubscribe-'));
  const password = 'Fixture account password', apiKey = randomBytes(24).toString('hex');
  const databasePath = path.join(directory, 'content.sqlite');
  const db = new DatabaseSync(databasePath);
  try {
    const auth = createAuthStore(db, `owner:owner:${hashPassword(password)}`), owner = auth.getByLogin('owner');
    for (const [login, permissions] of [['editor',['crm.view','crm.edit','settings.view','settings.edit']], ['viewer',['crm.view']]]) {
      const user = auth.create(owner.id, {login, displayName:login, password}, hashPassword(password));
      auth.updateAccess(owner.id, user.id, ['alvi','avokado'], permissions);
    }
  } finally {db.close();}
  const calls = [];
  let handler = (request, response) => {
    if (request.url.startsWith('/email-unsubscribe/')) {response.writeHead(200, {'content-type':'text/html'});response.end(confirmation);}
    else {response.writeHead(200, {'content-type':'application/json'});response.end('{"ok":true}');}
  };
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];for await (const chunk of request) chunks.push(chunk);
    calls.push({method:request.method, url:request.url, headers:{...request.headers}, body:Buffer.concat(chunks).toString('utf8')});
    handler(request, response);
  });
  upstream.listen(0, '127.0.0.1');await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`, port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env:{...process.env, PORT:String(port), DATABASE_PATH:databasePath, SEED_DIR:directory,
      ASSETS_DIR:path.join(directory,'assets'), API_KEY:'', AUTH_USERS:'', SESSION_SECRET:randomBytes(32).toString('hex'),
      CRM_URL:upstreamUrl, CRM_API_KEY:crmConfigured ? apiKey : ''}, stdio:['ignore','ignore','pipe'], windowsHide:true,
  });
  let errors = '';child.stderr.on('data', chunk => {errors += chunk;});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {const ended=once(child,'exit');child.kill();await ended;}
    upstream.closeAllConnections();await new Promise(resolve => upstream.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    await rm(directory, {recursive:true, force:true});
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (pathname, options = {}) => {
    const response = await fetch(base + pathname, {...options, signal:AbortSignal.timeout(8000)});
    const text = await response.text();
    return {status:response.status, text, headers:response.headers,
      json:response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : null};
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Content service failed: ${errors}`);
    try {if ((await request('/health')).status === 200) break;} catch {}
    if (attempt === 99) throw new Error('Content service did not start');
    await new Promise(resolve => setTimeout(resolve,20));
  }
  const login = async name => {
    const signed = await request('/content/login', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:name,password})});
    assert.equal(signed.status,200);
    const cookie=signed.headers.get('set-cookie').split(';')[0];
    const who=await request('/content/whoami',{headers:{cookie}});
    return {cookie, csrf:who.json.csrfToken};
  };
  return {base, request, login, calls, apiKey, upstreamUrl, respondWith:next => {handler=next;}};
}

test('real public unsubscribe GET and POST need no session, isolate browser credentials and serve constrained HTML', async t => {
  const f=await fixture(t), url=`/public-email-unsubscribe/${token}`;
  for (const method of ['GET','POST']) {
    const body=method==='POST'?'List-Unsubscribe=One-Click':undefined;
    const result=await f.request(url+'?company=alvi&token=other', {method,body,
      headers:{cookie:'synapse_session=untrusted-browser-cookie',authorization:'Bearer browser-secret',
        'x-api-key':'browser-key','x-synapse-crm-identity':'browser-identity','x-csrf-token':'browser-csrf',
        ...(method==='POST'?{'content-type':'text/plain'}:{})}});
    assertSafeHtml(result,200);assert.equal(result.text,confirmation);
    const call=f.calls.at(-1);
    assert.equal(call.url,`/email-unsubscribe/${token}`);assert.equal(call.method,method);
    assert.equal(call.headers['x-api-key'],f.apiKey);assert.equal(call.headers.accept,'text/html');
    assert.equal(call.body,body||'');
    for (const header of ['cookie','authorization','x-synapse-crm-identity','x-csrf-token']) assert.equal(call.headers[header],undefined);
    if (method==='POST') assert.equal(call.headers['content-type'],'application/x-www-form-urlencoded');
  }
  const before=f.calls.length;
  for (const path of ['/public-email-unsubscribe/short',`/public-email-unsubscribe/${token}/extra`,'/public-email-unsubscribe']) {
    assertSafeHtml(await f.request(path),404);
  }
  for (const method of ['PUT','PATCH','DELETE','HEAD']) assertSafeHtml(await f.request(url,{method}),404,{head:method==='HEAD'});
  assertSafeHtml(await f.request(url,{method:'POST',body:'я'.repeat(513)}),413);
  assert.equal(f.calls.length,before,'invalid requests must never reach CRM');
  f.respondWith((request,response)=>{response.writeHead(404,{'content-type':'text/html'});response.end('PRIVATE recipient@example.test');});
  const missing=await f.request(url);assertSafeHtml(missing,404);
  assert.doesNotMatch(missing.text,/PRIVATE|recipient@example/);
  f.respondWith((request,response)=>{response.writeHead(302,{location:f.upstreamUrl+'/redirect-target'});response.end();});
  const redirects=f.calls.length;assertSafeHtml(await f.request(url),502);
  assert.equal(f.calls.length,redirects+1,'unsubscribe redirects cannot carry the internal key elsewhere');
});

test('oversized streamed POST returns readable 413 HTML while the client is still uploading', async t => {
  const f=await fixture(t);
  const result=await new Promise((resolve,reject)=>{
    let finish;
    const request=http.request(f.base+`/public-email-unsubscribe/${token}`, {
      method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
    }, response=>{
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('error',reject);
      response.on('end',()=>resolve({status:response.statusCode,headers:new Headers(response.headers),text:Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error',reject);
    request.setTimeout(3000,()=>request.destroy(new Error('Timed out waiting for the oversized request response')));
    request.on('close',()=>clearTimeout(finish));
    request.flushHeaders();
    request.write('x'.repeat(1025));
    finish=setTimeout(()=>{if(!request.destroyed)request.end('still-uploading');},250);
  });
  assertSafeHtml(result,413);
  assert.equal(f.calls.length,0,'an oversized upload must never reach CRM');
});

test('missing internal CRM configuration serves safe 503 HTML without an upstream request', async t => {
  const f=await fixture(t,{crmConfigured:false});
  assertSafeHtml(await f.request(`/public-email-unsubscribe/${token}`),503);
  assert.equal(f.calls.length,0);
});

test('real owner proxy protects both campaign and subscription prefixes including nested actions and all writes', async t => {
  const f=await fixture(t), owner=await f.login('owner'), editor=await f.login('editor'), viewer=await f.login('viewer');
  const routes=['/email-campaigns','/email-campaigns/1','/email-campaigns/1/send','/email-subscriptions','/email-subscriptions/1'];
  for (const route of routes) for (const method of ['GET','POST','PUT','PATCH','DELETE']) {
    const pathname='/content/crm'+route;
    assert.equal((await f.request(pathname,{method})).status,401);
    for (const session of [editor,viewer]) {
      assert.equal((await f.request(pathname,{method,headers:{cookie:session.cookie,'x-csrf-token':session.csrf}})).status,403);
    }
  }
  assert.equal(f.calls.length,0,'unauthorized requests must never be proxied');
  for (const route of routes) {
    assert.equal((await f.request('/content/crm'+route,{headers:{cookie:owner.cookie}})).status,200);
  }
  const reads=f.calls.length;
  for (const route of routes) for (const method of ['POST','PUT','PATCH','DELETE']) for (const csrf of ['', 'wrong-csrf']) {
    assert.equal((await f.request('/content/crm'+route,{method,headers:{cookie:owner.cookie,...(csrf?{'x-csrf-token':csrf}:{})}})).status,403);
  }
  assert.equal(f.calls.length,reads,'missing/wrong CSRF cannot mutate the upstream service');
  const body=JSON.stringify({subject:'Fixture only'});
  for (const route of ['/email-campaigns/1/send','/email-subscriptions']) {
    const result=await f.request('/content/crm'+route,{method:'POST',body,
      headers:{cookie:owner.cookie,'x-csrf-token':owner.csrf,'content-type':'application/json','x-api-key':'browser-key',
        'x-synapse-crm-identity':'browser-identity'}});
    assert.equal(result.status,200);
    const call=f.calls.at(-1);assert.equal(call.url,route);assert.equal(call.body,body);
    assert.equal(call.headers['x-api-key'],f.apiKey);assert.equal(call.headers.cookie,undefined);
    assert.notEqual(call.headers['x-synapse-crm-identity'],'browser-identity');
  }
});

test('real unsubscribe bridge bounds a stalled upstream connection and body to five seconds', async t => {
  const f=await fixture(t);
  f.respondWith((request,response)=>{
    if (request.url.endsWith(secondToken)) {response.writeHead(200,{'content-type':'text/html'});response.write('<!doctype html>');}
  });
  const started=Date.now();
  const results=await Promise.all([token,secondToken].map(value=>f.request(`/public-email-unsubscribe/${value}`)));
  for (const result of results) {assertSafeHtml(result,502);assert.doesNotMatch(result.text,/fixture|PRIVATE|recipient@example/);}
  assert.ok(Date.now()-started<7500,'both header and body stalls must finish before the client deadline');
  assert.equal(f.calls.length,2);
});
