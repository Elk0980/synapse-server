'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const {spawn} = require('node:child_process'), {once} = require('node:events');
const {randomBytes} = require('node:crypto'), {DatabaseSync} = require('node:sqlite');
const {createAuthStore} = require('./auth-store'), {hashPassword} = require('./passwords');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// CF1: вводные контент-завода через настоящие сервисы контента и CRM. Права — существующее правило
// /media-mentor (autoposting.view/edit своей компании, CSRF на запись), автор из сессии, изоляция компаний,
// бриф наставника не меняется. Синтетические данные.
test('библиотека через реальные content/CRM: загрузка, закрытый attach и usage', {timeout: 60000}, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-factory-inputs-proxy-')), children = [];let inspectionDb=null;
    const contentDb = path.join(directory, 'content.sqlite'), crmDb = path.join(directory, 'crm.sqlite');
    const blockedNetwork = path.join(directory, 'blocked-network.log');
    const password = 'Local-media-mentor-password', key = randomBytes(32).toString('hex');
    t.after(async () => {
      if(inspectionDb){inspectionDb.close();inspectionDb=null;}
      for (const child of children.reverse()) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit'); child.kill(); await exited;
        }
      }
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      await fs.rm(directory, {recursive: true, force: true});
    });

    const authDb = new DatabaseSync(contentDb);
    const auth = createAuthStore(authDb, `owner:owner:${hashPassword(password)}`), owner = auth.getByLogin('owner');
    const view = ['company-information.view', 'autoposting.view'];
    const edit = [...view, 'autoposting.edit'];
    for (const [login, companies, permissions] of [
      ['editor', ['avokado'], edit],
      ['viewer', ['avokado'], view],
      ['stranger', ['alvi'], edit],
      ['crmonly', ['avokado'], ['crm.view']],
    ]) auth.create(owner.id, {login, displayName: login, password, companies, permissions}, hashPassword(password));
    authDb.close();

    const crmPort = await freePort(), contentPort = await freePort();
    const crmBase = `http://127.0.0.1:${crmPort}`, contentBase = `http://127.0.0.1:${contentPort}`;
    const preload = path.join(directory, 'local-network-only.cjs');
    await fs.writeFile(preload, `
    'use strict';
    const fs=require('node:fs'),net=require('node:net');
    const allowed=process.env.MENTOR_TEST_ALLOWED_ORIGIN?new URL(process.env.MENTOR_TEST_ALLOWED_ORIGIN):null;
    function blocked(){fs.appendFileSync(${JSON.stringify(blockedNetwork)},'blocked\\n');throw new Error('External network disabled by media mentor fixture');}
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!allowed||url.origin!==allowed.origin)blocked();return originalFetch(input,options);};
    const originalConnect=net.Socket.prototype.connect;
    net.Socket.prototype.connect=function(...args){const values=Array.isArray(args[0])?args[0]:args;const options=typeof values[0]==='object'?values[0]:{port:values[0],host:typeof values[1]==='string'?values[1]:'localhost'};
     if(!allowed||options.host!==allowed.hostname||String(options.port)!==allowed.port)blocked();return originalConnect.apply(this,args);};
    require('node:tls').connect=blocked;
    `);
    async function start(file, env, base) {
      let errors = '';
      const child = spawn(process.execPath, ['--require', preload, file],
        {env: {...process.env, ...env}, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
      children.push(child);
      child.stderr.on('data', (chunk) => { errors += chunk; });
      for (let attempt = 0; attempt < 200; attempt++) {
        if (child.exitCode !== null) throw Error('Service failed: ' + errors);
        try { const response = await fetch(base + '/health', {signal: AbortSignal.timeout(500)}); await response.text(); return; }
        catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
      }
      throw Error('Service not ready: ' + errors);
    }
    await start(path.join(__dirname, '../crm/server.js'), {PORT: String(crmPort), DATABASE_PATH: crmDb,
      API_KEY: key, RATE_LIMIT_MAX: '10000', STRICT_ORIGIN: '', MENTOR_TEST_ALLOWED_ORIGIN: '',
      LEADS_SMTP_HOST: '', LEADS_SMTP_PORT: '465', LEADS_SMTP_USER: '', LEADS_SMTP_PASSWORD: '',
      LEADS_MAIL_FROM: '', LEADS_NOTIFY_EMAIL: '', LEADS_NOTIFY_EMAIL_ALVI: '', LEADS_NOTIFY_EMAIL_AVOKADO: ''}, crmBase);
    await start(path.join(__dirname, 'server.js'), {PORT: String(contentPort), DATABASE_PATH: contentDb,
      AUTH_USERS: '', API_KEY: '', CRM_URL: crmBase, CRM_API_KEY: key, SEED_DIR: directory,
      ASSETS_DIR: path.join(directory, 'assets'), SESSION_SECRET: randomBytes(32).toString('hex'),
      MENTOR_TEST_ALLOWED_ORIGIN: crmBase, HUGH_RUNNER_URL: '', CHAT_URL: '', CHAT_API_KEY: '',CONTENT_PLAN_WORKER_ENABLED:'0'}, contentBase);

    const forged = (permissions = ['autoposting.edit'], role = 'owner', companyCodes = ['alvi', 'avokado']) =>
      Buffer.from(JSON.stringify({v: 1, userId: 1, role, permissions, companyCodes})).toString('base64url');
    async function request(base, route, {method = 'GET', body, headers = {}} = {}) {
      const response = await fetch(base + route, {method,
        headers: {...headers, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000)});
      const text = await response.text();
      return {status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers};
    }
    const direct = (route, options = {}) => request(crmBase, route,
      {...options, headers: {'x-api-key': key, 'x-synapse-crm-identity': forged(), ...options.headers}});
    for (const code of ['avokado', 'alvi']) {
      assert.equal((await direct('/companies', {method: 'POST', body: {code, name: 'Local ' + code, timezone: 'UTC'}})).status, 201);
    }
    const sessions = {};
    for (const login of ['owner', 'editor', 'viewer', 'stranger', 'crmonly']) {
      const signed = await request(contentBase, '/content/login', {method: 'POST', body: {login, password}});
      assert.equal(signed.status, 200, login);
      const cookie = signed.headers.get('set-cookie').split(';')[0];
      const profile = await request(contentBase, '/content/whoami', {headers: {cookie}});
      sessions[login] = {cookie, 'x-csrf-token': profile.body.csrfToken};
    }
    const through = (who, route, options = {}) => request(contentBase, '/content/crm' + route,
      {...options, headers: {...sessions[who], ...options.headers}});

    const library='/content/telegram-sources/avokado',scope='?companyCode=avokado';
    const delayBody={afterTaskId:0,limit:100},delayRoute='/internal/content-factory/review-delays';
    assert.equal((await request(crmBase,delayRoute,{method:'POST',body:delayBody})).status,401);
    assert.equal((await direct(delayRoute,{method:'POST',body:delayBody})).status,403);
    const delayRead=await request(crmBase,delayRoute,{method:'POST',body:delayBody,headers:{'x-api-key':key}});
    assert.equal(delayRead.status,200);assert.deepEqual(delayRead.body.items,[]);assert.match(delayRead.headers.get('cache-control'),/no-store/);
    assert.equal((await through('owner',delayRoute,{method:'POST',body:delayBody})).status,403);
    const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(64)]);
    async function upload(who){
      const form=new FormData();form.append('file',new Blob([bytes],{type:'image/png'}),'test.png');
      form.append('metadata',JSON.stringify({formats:['post'],materialState:'source'}));
      const response=await fetch(contentBase+library+'/upload',{method:'POST',headers:sessions[who],body:form});
      return {status:response.status,body:await response.json()};
    }
    assert.equal((await upload('viewer')).status,403);
    assert.equal((await upload('stranger')).status,403);
    const uploaded=await upload('editor');assert.equal(uploaded.status,201,JSON.stringify(uploaded.body));
    const item=uploaded.body.item;assert.equal(item.metadata.materialState,'source');
    const file=await fetch(contentBase+item.fileUrl,{headers:sessions.viewer});assert.equal(file.status,200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);assert.match(file.headers.get('cache-control'),/private/);
    const body={clientRequestId:'full-proxy-attach-1',sourceRevision:item.revision,newPost:{title:'Проверка исходника',format:'post',ovpRole:'reach'}};
    const call=(who,action,options={})=>request(contentBase,library+'/'+item.id+'/'+action,{...options,headers:{...sessions[who],...options.headers}});
    assert.equal((await call('editor','attach',{method:'POST',body})).status,409);
    assert.equal((await call('viewer','attach',{method:'POST',body})).status,403);
    assert.equal((await call('stranger','usage')).status,403);
    assert.equal((await call('editor','attach',{method:'POST',body,headers:{'x-csrf-token':''}})).status,403);
    const ready=await call('editor','metadata',{method:'PATCH',body:{revision:item.revision,metadata:{materialState:'ready'}}});
    assert.equal(ready.status,200,JSON.stringify(ready.body));body.sourceRevision=ready.body.item.revision;
    const attached=await call('editor','attach',{method:'POST',body});assert.equal(attached.status,200,JSON.stringify(attached.body));
    assert.equal(attached.body.post.status,'draft');assert.equal(attached.body.post.scheduledAt,null);
    assert.equal(attached.body.link.sourceId,item.id);assert.equal(attached.body.link.sourceRevision,body.sourceRevision);
    const repeat=await call('editor','attach',{method:'POST',body});assert.equal(repeat.status,200);assert.equal(repeat.body.duplicate,true);
    assert.equal(repeat.body.post.id,attached.body.post.id);
    const usage=await call('viewer','usage');assert.equal(usage.status,200);assert.equal(usage.body.usages.length,1);
    assert.equal(usage.body.usages[0].current,true);
    assert.equal((await request(crmBase,'/internal/content-factory/source-usage'+scope,{method:'POST',body:{sourceId:item.id},headers:{'x-synapse-crm-identity':forged()}})).status,401);
    assert.equal((await through('owner','/internal/content-factory/source-attach'+scope,{method:'POST',body:{}})).status,403);
    assert.equal((await direct('/internal/content-factory/source-usage'+scope,{method:'POST',body:{sourceId:item.id},headers:{'x-synapse-crm-identity':''}})).status,403);
    assert.equal((await request(contentBase,library+'/'+item.id+'/usage',{headers:{'x-synapse-crm-identity':forged()}})).status,401);
    const copied=await fetch(contentBase+new URL(attached.body.link.url).pathname);assert.equal(copied.status,200);
    assert.deepEqual(Buffer.from(await copied.arrayBuffer()),bytes);
    assert.equal((await request(contentBase,item.fileUrl)).status,401);
    assert.equal((await upload('editor')).body.duplicate,true);
    // Браузер по-прежнему передаёт только месяц/key; контекст библиотеки составляет Content.
    const profileUpdate=await through('owner','/media-mentor/inputs'+scope,{method:'PUT',body:{revision:0,profile:{genders:['women','men'],geography:'Демо-город',targetAction:''}}});
    assert.equal(profileUpdate.status,200,JSON.stringify(profileUpdate.body));assert.deepEqual(profileUpdate.body.profile.fields.genders,['women','men']);
    const planBody={month:'2026-10',clientRequestId:'source-library-plan-1'};
    const plan=await through('editor','/media-mentor/generation'+scope,{method:'POST',body:planBody});
    assert.equal(plan.status,200,JSON.stringify(plan.body));assert.equal(plan.body.job.status,'needs_input');
    const inspect=inspectionDb=new DatabaseSync(crmDb);
    const saved=JSON.parse(inspect.prepare('SELECT snapshot FROM content_plan_jobs WHERE id=?').get(plan.body.job.id).snapshot);
    assert.equal(Object.hasOwn(saved,'planningInsights'),false,'editor без analytics.view не читает статистику');
    const ownerPlan=await through('owner','/media-mentor/generation'+scope,{method:'POST',body:{month:'2026-10',clientRequestId:'owner-statistics-plan'}});
    assert.equal(ownerPlan.status,200,JSON.stringify(ownerPlan.body));
    const ownerSnapshot=JSON.parse(inspect.prepare('SELECT snapshot FROM content_plan_jobs WHERE id=?').get(ownerPlan.body.job.id).snapshot);
    assert.equal(ownerSnapshot.planningInsights.companyCode,'avokado');assert.equal(ownerSnapshot.planningInsights.source.kind,'saved_social_stats');
    assert.deepEqual(ownerSnapshot.planningInsights.source.period,{from:'2026-09-01',to:'2026-09-30',timezone:'UTC'});
    assert.ok(ownerSnapshot.planningInsights.platforms.every(p=>p.coverage==='missing'&&p.editorialRecommendations.length===0));
    assert.equal((await through('owner','/media-mentor/generation'+scope,{method:'POST',body:{month:'2026-10',clientRequestId:'forged-statistics-plan',planningInsights:{}}})).status,400);
    assert.equal(saved.sourceLibrary.companyCode,'avokado');assert.equal(saved.sourceLibrary.assets.length,1);
    assert.equal(saved.sourceLibrary.assets[0].id,item.id);assert.equal(saved.sourceLibrary.assets[0].revision,2);
    for(const key of ['fileUrl','disk_name','chat_id','imported_by','provenance'])assert.equal(key in saved.sourceLibrary.assets[0],false);
    const changed=await call('editor','metadata',{method:'PATCH',body:{revision:2,metadata:{occasion:'Новый повод'}}});assert.equal(changed.status,200);
    // Потерянный ответ attach восстанавливается по первоначальному ключу даже после правки metadata.
    const replayAfterMetadata=await call('editor','attach',{method:'POST',body});
    assert.equal(replayAfterMetadata.status,200,JSON.stringify(replayAfterMetadata.body));
    assert.deepEqual(replayAfterMetadata.body,{...attached.body,duplicate:true});
    assert.equal((await call('editor','attach',{method:'POST',body:{...body,clientRequestId:'new-key-stale-source'}})).status,409);
    assert.equal((await call('editor','attach',{method:'POST',body:{...body,newPost:{...body.newPost,title:'Другая цель'}}})).status,409);
    const lookupRoute='/internal/content-factory/source-attach-lookup'+scope;
    assert.equal((await through('owner',lookupRoute,{method:'POST',body:{}})).status,403);
    assert.equal((await request(crmBase,lookupRoute,{method:'POST',body:{}})).status,401);
    assert.equal((await direct(lookupRoute,{method:'POST',body:{},headers:{'x-synapse-crm-identity':''}})).status,403);
    const repeated=await through('editor','/media-mentor/generation'+scope,{method:'POST',body:planBody});
    assert.equal(repeated.status,200);assert.equal(repeated.body.job.id,plan.body.job.id);
    assert.deepEqual(JSON.parse(inspect.prepare('SELECT snapshot FROM content_plan_jobs WHERE id=?').get(plan.body.job.id).snapshot),saved);
    const next=await through('editor','/media-mentor/generation'+scope,{method:'POST',body:{month:'2026-11',clientRequestId:'source-library-plan-2'}});
    assert.equal(next.status,200);const nextSnapshot=JSON.parse(inspect.prepare('SELECT snapshot FROM content_plan_jobs WHERE id=?').get(next.body.job.id).snapshot);
    assert.equal(nextSnapshot.sourceLibrary.assets[0].metadata.occasion,'Новый повод');assert.equal(nextSnapshot.sourceLibrary.assets[0].revision,3);
    assert.notEqual(nextSnapshot.sourceLibrary.hash,saved.sourceLibrary.hash);
    assert.equal((await through('editor','/media-mentor/generation'+scope,{method:'POST',body:{...planBody,sourceLibrary:saved.sourceLibrary}})).status,400);
    assert.equal((await through('editor','/media-mentor/generation'+scope,{method:'POST',body:{...planBody,month:'2026-11'}})).status,409);
    assert.equal((await through('viewer','/media-mentor/generation'+scope,{method:'POST',body:planBody})).status,403);
    assert.equal((await through('stranger','/media-mentor/generation'+scope,{method:'POST',body:planBody})).status,403);
    assert.equal((await through('owner','/internal/content-factory/plan-start'+scope,{method:'POST',body:{request:planBody,sourceLibrary:saved.sourceLibrary}})).status,403);
    assert.equal(await fs.readFile(blockedNetwork,'utf8').catch(()=>''),'');
});
