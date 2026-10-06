'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const {spawn} = require('node:child_process'), {once} = require('node:events'), {randomBytes} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {createAuthStore} = require('./auth-store'), {hashPassword} = require('./passwords');

test('VK events proxy isolates public callback from owner routes, cookies and CSRF', {timeout: 40000}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-events-proxy-'));
  const dbPath = path.join(dir, 'content.sqlite'), password = 'Synthetic-test-only-password', key = randomBytes(32).toString('hex');
  const db = new DatabaseSync(dbPath), auth = createAuthStore(db, `owner:owner:${hashPassword(password)}`);
  const owner = auth.getByLogin('owner');
  auth.create(owner.id, {login:'reader', displayName:'Fixture reader', password, companies:['avokado'], permissions:['crm.view']}, hashPassword(password));
  db.close();
  const received = [];
  const upstream = http.createServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({url:req.url, headers:req.headers, body:Buffer.concat(chunks).toString()});
    if (req.url.startsWith('/vk-events/callback/')) {res.writeHead(200, {'content-type':'text/plain'}); res.end('ok');}
    else {res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({companyCode:'avokado', configured:false}));}
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0,'127.0.0.1',resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname,'server.js')], {windowsHide:true, stdio:['ignore','ignore','pipe'],
    env:{...process.env, PORT:String(port), DATABASE_PATH:dbPath, AUTH_USERS:'', API_KEY:'', CRM_URL:`http://127.0.0.1:${upstream.address().port}`,
      CRM_API_KEY:key, SEED_DIR:dir, ASSETS_DIR:path.join(dir,'assets'), SESSION_SECRET:randomBytes(32).toString('hex')}});
  let stderr=''; child.stderr.on('data', chunk => stderr += chunk);
  t.after(async () => {
    if(child.exitCode===null && child.signalCode===null) {const done=once(child,'exit'); child.kill(); await done;}
    await new Promise(resolve => upstream.close(resolve));
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep)); await fs.rm(dir,{recursive:true,force:true});
  });
  const base=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let i=0;i<150;i++) {
    if(child.exitCode!==null) throw Error('Content failed: '+stderr);
    try {const r=await fetch(base+'/health',{signal:AbortSignal.timeout(300)}); await r.text(); ready=true; break;}
    catch {await new Promise(resolve=>setTimeout(resolve,25));}
  }
  assert.ok(ready,stderr);
  const req=async (route, options={}) => {const r=await fetch(base+route,{...options,signal:AbortSignal.timeout(8000)}); return {status:r.status,text:await r.text(),headers:r.headers};};
  const session=async login => {
    const r=await req('/content/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login,password})});
    assert.equal(r.status,200); const cookie=r.headers.get('set-cookie').split(';')[0];
    const who=await req('/content/whoami',{headers:{cookie}}); return {cookie,'x-csrf-token':JSON.parse(who.text).csrfToken};
  };
  const own=await session('owner'), reader=await session('reader'), route='/content/crm/vk-events/settings?companyCode=avokado';
  assert.equal((await req(route)).status,401);
  assert.equal((await req(route,{headers:reader})).status,403);
  assert.equal((await req('/content/crm/vk-events/settings',{headers:own})).status,400);
  assert.equal((await req(route,{method:'PUT',headers:{cookie:own.cookie,'content-type':'application/json'},body:'{}'})).status,403);
  assert.equal(received.length,0);
  assert.equal((await req(route,{headers:own})).status,200);
  assert.equal((await req(route,{method:'PUT',headers:{...own,'content-type':'application/json'},body:'{"revision":0}'})).status,200);
  const endpoint='A'.repeat(32), callback='/public-vk-callback/'+endpoint;
  const reply=await req(callback,{method:'POST',headers:{cookie:own.cookie,'x-csrf-token':own['x-csrf-token'],'content-type':'application/json'},body:'{"type":"fixture"}'});
  assert.equal(reply.status,200); assert.equal(reply.text,'ok'); assert.match(reply.headers.get('content-type'),/^text\/plain/);
  const forwarded=received.at(-1); assert.equal(forwarded.url,'/vk-events/callback/'+endpoint); assert.equal(forwarded.headers['x-api-key'],key);
  for(const header of ['cookie','x-csrf-token','x-synapse-crm-identity','authorization']) assert.equal(forwarded.headers[header],undefined);
  const count=received.length;
  assert.equal((await req('/content/crm/vk-events/callback/'+endpoint+'?companyCode=avokado',{method:'POST',headers:{...own,'content-type':'application/json'},body:'{}'})).status,404);
  assert.equal((await req(callback,{method:'GET'})).status,404);
  assert.equal((await req('/public-vk-callback/short',{method:'POST',body:'{}'})).status,404);
  assert.equal((await req(callback,{method:'POST',body:'x'.repeat(256*1024+1)})).status,413);
  assert.equal(received.length,count);
});
