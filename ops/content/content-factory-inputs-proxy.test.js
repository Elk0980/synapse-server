'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const {spawn} = require('node:child_process'), {once} = require('node:events');
const {randomBytes} = require('node:crypto'), {DatabaseSync} = require('node:sqlite');
const http=require('node:http');
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
test('вводные контент-завода через прокси: права, CSRF, валидация, ревизии и изоляция', {timeout: 60000}, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-factory-inputs-proxy-')), children = [];
    const contentDb = path.join(directory, 'content.sqlite'), crmDb = path.join(directory, 'crm.sqlite');
    const blockedNetwork = path.join(directory, 'blocked-network.log');
    const receivingMarker=path.join(directory,'receiving-body.log');
    const password = 'Local-media-mentor-password', key = randomBytes(32).toString('hex');
    t.after(async () => {
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
    const incoming=require('node:http').IncomingMessage.prototype,originalOn=incoming.on;
    incoming.on=function(event,listener){
      if((event==='data'||event==='readable')&&this.url?.startsWith('/content/crm/')&&
        ((this.url.includes('/media-mentor/workflow')&&this.method==='PUT')||
         (this.url.includes('/variants')&&this.method==='POST')))
        fs.appendFileSync(${JSON.stringify(receivingMarker)},'receiving\\n');
      return originalOn.call(this,event,listener);
    };
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

    const SCOPE = '?companyCode=avokado', INPUTS = '/media-mentor/inputs', MONTH = '/media-mentor/inputs/months/2026-10';
    // Без сессии и без выбора компании — отказ.
    assert.equal((await request(contentBase, '/content/crm' + INPUTS + SCOPE)).status, 401);
    assert.equal((await through('owner', INPUTS)).status, 400);
    // Чтение — autoposting.view своей компании; чужая компания и crm.view — 403.
    assert.equal((await through('crmonly', INPUTS + SCOPE)).status, 403);
    assert.equal((await through('stranger', INPUTS + SCOPE)).status, 403);
    const read = await through('viewer', INPUTS + SCOPE);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.companyCode, 'avokado');
    assert.equal(read.body.profile.revision, 0);
    assert.match(read.headers.get('cache-control'), /no-store/);
    // Запись — autoposting.edit и CSRF.
    const profile = {revision: 0, profile: {genders: ['women', 'men'], ageFrom: 25, ageTo: null, geography: 'Город N'}};
    assert.equal((await through('viewer', INPUTS + SCOPE, {method: 'PUT', body: profile})).status, 403);
    assert.equal((await through('stranger', INPUTS + SCOPE, {method: 'PUT', body: profile})).status, 403);
    assert.equal((await through('editor', INPUTS + SCOPE, {method: 'PUT', body: profile, headers: {'x-csrf-token': ''}})).status, 403);
    assert.equal((await through('viewer', INPUTS + SCOPE, {method: 'PUT', body: profile, headers: {'x-synapse-crm-identity': forged()}})).status, 403);
    const saved = await through('editor', INPUTS + SCOPE, {method: 'PUT', body: profile});
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.profile.fields.genders, ['women', 'men']);
    assert.equal(saved.body.profile.history[0].actorName, 'editor', 'автор — из сессии');
    // Серверная валидация и ревизии.
    for (const bad of [{genders: ['both']}, {ageFrom: 50, ageTo: 20}, {income: 'высокий'}])
      assert.equal((await through('editor', INPUTS + SCOPE, {method: 'PUT', body: {revision: 1, profile: bad}})).status, 400, JSON.stringify(bad));
    assert.equal((await through('editor', INPUTS + SCOPE, {method: 'PUT', body: profile})).status, 409);
    // Месяц.
    const month = {revision: 0, inputs: {platforms: ['telegram'], perDay: {telegram: 2}, excludedDays: ['2026-10-31']}};
    assert.equal((await through('viewer', MONTH + SCOPE, {method: 'PUT', body: month})).status, 403);
    const savedMonth = await through('editor', MONTH + SCOPE, {method: 'PUT', body: month});
    assert.equal(savedMonth.status, 200, JSON.stringify(savedMonth.body));
    assert.equal(savedMonth.body.publicationCount, 60);
    assert.equal((await through('editor', MONTH + SCOPE, {method: 'PUT', body: {revision: 1, inputs: {excludedDays: ['2026-11-01']}}})).status, 400);
    assert.equal((await through('editor', '/media-mentor/inputs/months/2026-13' + SCOPE)).status, 400);
    // Изоляция: другая компания своего профиля не видит и чужой не правит.
    const other = await through('owner', INPUTS + '?companyCode=alvi');
    assert.equal(other.status, 200);
    assert.equal(other.body.profile.revision, 0);
    assert.deepEqual(other.body.profile.fields.genders, []);
    assert.equal((await through('stranger', INPUTS + '?companyCode=alvi')).status, 200, 'своя компания читается');
    assert.equal((await through('owner', MONTH + '?companyCode=alvi')).body.revision, 0);
    // Бриф наставника не изменился от вводных.
    assert.equal((await through('viewer', '/media-mentor' + SCOPE)).body.brief.revision, 0);
    // CF2 uses the same real proxy/CRM trust boundary: no extra permissions or forged context.
    const GENERATION='/media-mentor/generation', generationRequest={clientRequestId:'generation_qa_01',month:'2026-10'};
    assert.equal((await through('viewer',GENERATION+SCOPE,{method:'POST',body:generationRequest})).status,403);
    assert.equal((await through('stranger',GENERATION+SCOPE,{method:'POST',body:generationRequest})).status,403);
    assert.equal((await through('editor',GENERATION+SCOPE,{method:'POST',body:generationRequest,headers:{'x-csrf-token':''}})).status,403);
    assert.equal((await through('editor',GENERATION+SCOPE,{method:'POST',body:{...generationRequest,snapshot:{product:'forged'}}})).status,400);
    const created=await through('editor',GENERATION+SCOPE,{method:'POST',body:generationRequest});
    assert.equal(created.status,200,JSON.stringify(created.body));
    assert.equal(created.body.job.status,'needs_input');assert.ok(created.body.job.questions.some(q=>q.target==='brief.product'));
    const repeated=await through('editor',GENERATION+SCOPE,{method:'POST',body:generationRequest});
    assert.equal(repeated.body.job.id,created.body.job.id);
    assert.equal((await through('viewer',GENERATION+'/'+created.body.job.id+SCOPE)).status,200);
    assert.equal((await through('owner',GENERATION+'/'+created.body.job.id+'?companyCode=alvi')).status,404);
    assert.equal((await through('viewer',GENERATION+SCOPE+'&month=2026-10')).body.jobs.length,1);
    assert.equal((await through('crmonly',GENERATION+SCOPE+'&month=2026-10')).status,403);
    // Service-only generation routes: real HTTP, no browser identity and no proxy access.
    const INTERNAL='/internal/content-plan/';
    assert.equal((await request(crmBase,INTERNAL+'claim',{method:'POST',body:{}})).status,401);
    assert.equal((await direct(INTERNAL+'claim',{method:'POST',body:{}})).status,403);
    assert.equal((await through('owner',INTERNAL+'claim',{method:'POST',body:{}})).status,403);
    const service=(action,body={})=>request(crmBase,INTERNAL+action,{method:'POST',headers:{'x-api-key':key},body});
    assert.equal((await service('claim')).body.task,null,'needs_input не запускается');
    const queueDb=new DatabaseSync(crmDb);
    const jobs=require('../crm/content-plan-jobs').createContentPlanJobs(queueDb);
    const prepared=jobs.enqueue('avokado',{clientRequestId:'real_http_queue',month:'2026-10',snapshot:{brief:{assets:[]},
      monthInputs:{platforms:['telegram'],perDay:{telegram:2},excludedDays:Array.from({length:30},(_,i)=>'2026-10-'+String(i+2).padStart(2,'0'))}}});
    queueDb.close();
    const first=(await service('claim')).body.task;
    assert.equal((await service('next',{lease:{...first.lease,token:'wrong'}})).status,409);
    assert.equal((await service('renew',{lease:first.lease})).status,200);
    assert.equal((await service('result',{lease:first.lease,partIndex:0,text:'{"proposals":[]}',model:'synthetic'})).status,400);
    const resultBody={lease:first.lease,partIndex:0,model:'synthetic-http',text:JSON.stringify({proposals:[{
      date:'2026-10-01',platform:'telegram',format:'post',role:'reach',topic:'Первая тема',text:'Синтетическая проверка'}]})};
    const next=await service('result',resultBody);assert.equal(next.status,200);assert.equal(next.body.partIndex,1);
    // The first response could be lost. Re-sending the same result returns the same next part.
    const same=await service('result',resultBody);assert.equal(same.status,200);assert.equal(same.body.partIndex,1);
    const last=await service('result',{...resultBody,partIndex:1,text:resultBody.text.replace('Первая тема','Вторая тема')});
    assert.equal(last.body.done,true);
    const done=await through('viewer',GENERATION+'/'+prepared.id+SCOPE);
    assert.equal(done.body.job.status,'succeeded');assert.equal(done.body.job.proposals.length,2);
    const transfer='/media-mentor/generation/'+prepared.id+'/drafts'+SCOPE;
    const ids=done.body.job.proposals.map(p=>p.ideaId);
    const drafts=await through('editor',transfer,{method:'POST',body:{proposalIds:ids}});
    assert.equal(drafts.status,200,JSON.stringify(drafts.body));assert.equal(drafts.body.createdCount,2);
    const duplicate=await through('editor',transfer,{method:'POST',body:{proposalIds:ids}});
    assert.equal(duplicate.body.createdCount,0);assert.deepEqual(duplicate.body.drafts,drafts.body.drafts);
    if(process.env.CONTENT_PLAN_UI_PROBE==='1'){
      const summary=await require('./content-plan-ui-probe').runContentPlanUiProbe({through,crmBase,key});
      assert.deepEqual(summary,{proposals:2,drafts:2,modelCalls:2,uiErrors:0});
      console.log('UI_HTTP_WORKER_PROBE',JSON.stringify(summary));
    }
    // CF4: remarks use the existing reject route, identity and CSRF checks.
    const postId=drafts.body.drafts[0].postId;
    const postRoute='/autoposting/posts/'+postId;
    const beforeNote=await through('owner',postRoute+SCOPE);
    const noteBody={revision:beforeNote.body.revision,comment:'Правка монтажа',annotations:[{
      category:'text',comment:'Титр на 00:12',timingKind:'editing_wish',startMs:12000}]};
    const rejectRoute=postRoute+'/reject'+SCOPE;
    for(const who of ['viewer','editor','stranger'])assert.equal((await through(who,rejectRoute,{method:'POST',body:noteBody})).status,403);
    assert.equal((await through('owner',rejectRoute,{method:'POST',body:noteBody,headers:{'x-csrf-token':''}})).status,403);
    assert.equal((await through('owner',rejectRoute,{method:'POST',body:{...noteBody,annotations:[{...noteBody.annotations[0],startMs:-1}]}})).status,400);
    assert.equal((await through('owner',postRoute+SCOPE)).body.revision,beforeNote.body.revision);
    const savedNote=await through('owner',rejectRoute,{method:'POST',body:noteBody});
    assert.equal(savedNote.status,200,JSON.stringify(savedNote.body));
    assert.equal(savedNote.body.reviewNotes[0].annotations[0].startMs,12000);
    assert.equal((await through('owner',rejectRoute,{method:'POST',body:noteBody})).status,409);
    const archiveRoute=postRoute+'/archive'+SCOPE;
    const archiveBody={revision:savedNote.body.revision};
    assert.equal((await through('editor',archiveRoute,{method:'POST',body:archiveBody,headers:{'x-csrf-token':''}})).status,403);
    for(const who of ['viewer','stranger'])assert.equal((await through(who,archiveRoute,{method:'POST',body:archiveBody})).status,403);
    const archived=await through('editor',archiveRoute,{method:'POST',body:archiveBody});
    assert.equal(archived.status,200);assert.ok(archived.body.archive.archivedAt);
    const repeatTransfer=await through('editor',transfer,{method:'POST',body:{proposalIds:ids}});
    assert.equal(repeatTransfer.body.createdCount,0);assert.equal(repeatTransfer.body.drafts[0].postId,postId);assert.ok(repeatTransfer.body.drafts[0].archivedAt);
    assert.equal((await through('editor',postRoute+'/restore'+SCOPE,{method:'POST',body:{revision:archived.body.revision},headers:{'x-csrf-token':''}})).status,403);
    const restored=await through('editor',postRoute+'/restore'+SCOPE,{method:'POST',body:{revision:archived.body.revision}});
    assert.equal(restored.status,200);assert.equal(restored.body.archive.archivedAt,null);assert.equal(restored.body.approval.approved,false);

    assert.deepEqual((await through('viewer',postRoute+SCOPE)).body.reviewNotes,savedNote.body.reviewNotes);
    // CF20–22/073: новые контракты используют тот же настоящий session/company/CSRF transport.
    const WORKFLOW='/media-mentor/workflow'+SCOPE;
    assert.equal((await request(contentBase,'/content/crm'+WORKFLOW)).status,401);
    const defaults=await through('viewer',WORKFLOW);assert.equal(defaults.status,200);
    assert.equal(defaults.body.configured,false);assert.equal(defaults.headers.get('cache-control'),'no-store');
    const workflowBody={revision:0,fields:{releaseMode:'manual',hours:['18:00'],preparationDays:3,reviewDays:2,publisherName:'Указанный ответственный'}};
    for(const who of ['viewer','stranger','crmonly'])assert.equal((await through(who,WORKFLOW,{method:'PUT',body:workflowBody})).status,403);
    assert.equal((await through('editor',WORKFLOW,{method:'PUT',body:workflowBody,headers:{'x-csrf-token':''}})).status,403);
    assert.equal((await through('viewer',WORKFLOW,{method:'PUT',body:workflowBody,headers:{'x-synapse-crm-identity':forged()}})).status,403);
    const workflowSaved=await through('editor',WORKFLOW,{method:'PUT',body:workflowBody});assert.equal(workflowSaved.status,200,JSON.stringify(workflowSaved.body));
    assert.equal(workflowSaved.body.revision,1);assert.equal(workflowSaved.body.configured,true);
    assert.equal((await through('editor',WORKFLOW,{method:'PUT',body:workflowBody})).status,409);
    assert.equal((await through('owner','/media-mentor/workflow?companyCode=alvi')).body.configured,false);
    const contextJob=await through('editor',GENERATION+SCOPE,{method:'POST',body:{clientRequestId:'workflow_http_context',month:'2026-10'}});
    assert.equal(contextJob.status,200);assert.equal(contextJob.body.job.inputs.workflowRevision,1);
    const contextDb=new DatabaseSync(crmDb);
    const contextSnapshot=JSON.parse(contextDb.prepare('SELECT snapshot FROM content_plan_jobs WHERE id=?').get(contextJob.body.job.id).snapshot);
    assert.deepEqual(contextSnapshot.workflow,{companyCode:'avokado',revision:1,configured:true,fields:{releaseMode:'manual',hours:['18:00'],preparationDays:3,reviewDays:2}});
    assert.doesNotMatch(JSON.stringify(contextSnapshot.workflow),/publisherName|actor|Указанный ответственный/);
    assert.equal(contextDb.prepare('SELECT actor_name FROM content_factory_workflow_versions WHERE company_id=(SELECT id FROM companies WHERE code=?)').get('avokado').actor_name,'editor');
    contextDb.close();
    let current=(await through('editor',postRoute+SCOPE)).body;
    for(let i=0;i<3;i++){
      const edit=await through('editor',postRoute+SCOPE,{method:'PATCH',body:{revision:current.revision,title:'История через кабинет '+i}});
      assert.equal(edit.status,200);current=edit.body;
    }
    assert.equal((await through('editor',postRoute+'/schedule'+SCOPE,{method:'POST',body:{revision:current.revision,scheduledAt:'2099-01-01T18:00:00Z'}})).status,409);
    const variantRoute=postRoute+'/variants'+SCOPE,variantBody={revision:current.revision,clientRequestId:'proxy_variant_01',platformId:'vk'};
    for(const who of ['viewer','stranger','crmonly'])assert.equal((await through(who,variantRoute,{method:'POST',body:variantBody})).status,403);
    assert.equal((await through('editor',variantRoute,{method:'POST',body:variantBody,headers:{'x-csrf-token':''}})).status,403);
    const variant=await through('editor',variantRoute,{method:'POST',body:variantBody,headers:{'x-synapse-crm-identity':forged()}});
    assert.equal(variant.status,201,JSON.stringify(variant.body));assert.equal(variant.body.post.approvalRequired,true);
    assert.deepEqual(variant.body.post.platformIds,['vk']);assert.equal(variant.body.post.variantOf.postId,postId);
    const childRoute='/autoposting/posts/'+variant.body.post.id;
    const changed=await through('editor',childRoute+SCOPE,{method:'PATCH',body:{revision:variant.body.post.revision,title:'Ручная версия'}});
    assert.equal(changed.status,200);assert.equal(changed.body.approvalRequired,true);
    const recovered=await through('editor',variantRoute,{method:'POST',body:variantBody});assert.equal(recovered.status,200);
    assert.equal(recovered.body.created,false);assert.equal(recovered.body.post.id,variant.body.post.id);
    assert.equal((await through('viewer',childRoute+SCOPE)).body.title,'Ручная версия');
    assert.equal((await through('owner',childRoute+'?companyCode=alvi')).status,404);
    const history=await through('viewer',postRoute+'/history'+SCOPE+'&limit=2');assert.equal(history.status,200);
    assert.equal(history.headers.get('cache-control'),'no-store');assert.equal(history.body.items.length,2);assert.equal(history.body.hasMore,true);
    const more=await through('viewer',postRoute+'/history'+SCOPE+'&before='+history.body.nextBefore);
    assert.equal(more.status,200);assert.ok(more.body.items.every(item=>item.id<history.body.nextBefore));
    assert.equal((await through('stranger',postRoute+'/history'+SCOPE)).status,403);
    assert.equal((await through('owner',postRoute+'/history?companyCode=alvi')).status,404);
    assert.equal((await through('viewer',postRoute+'/history'+SCOPE+'&limit=0')).status,400);
    // CF24/076: существующий plan-linked путь через настоящие сессии Content+CRM.
    const legacyBefore=(await through('editor','/media-mentor'+SCOPE)).body;
    const legacyBrief=await through('editor','/media-mentor/brief'+SCOPE,{method:'PUT',body:{revision:legacyBefore.brief.revision,brief:{
      goal:'Синтетическая цель',product:'Продукт',audience:'Аудитория',platforms:['telegram','vk'],
      assets:[{id:'legacy_asset',title:'Съёмка',kind:'photo',note:'Описание'}],shootingComfort:{level:'hands_only',notes:''}}}});
    assert.equal(legacyBrief.status,200,JSON.stringify(legacyBrief.body));
    const legacyDays=Array.from({length:7},(_,i)=>({ideaId:'http-legacy-'+i,date:'2026-10-'+String(i+12).padStart(2,'0'),platform:'telegram',format:'post',role:'reach',topic:'Идея '+i,assetId:'legacy_asset',
      variants:i?{telegram:{text:''}}:{telegram:{text:'Текст Telegram'},vk:{text:'Текст ВКонтакте'}}}));
    let legacyPlan=await through('editor','/media-mentor/plan'+SCOPE,{method:'PUT',body:{planRevision:legacyBefore.plan?.revision??0,briefRevision:legacyBrief.body.brief.revision,days:legacyDays}});
    assert.equal(legacyPlan.status,200,JSON.stringify(legacyPlan.body));
    const decisionRoute='/media-mentor/plan/variants/decision'+SCOPE,selectedTransferRoute='/media-mentor/plan/variants/transfer'+SCOPE;
    const legacyDecision=()=>({planRevision:legacyPlan.body.plan.revision,briefRevision:legacyBrief.body.brief.revision,scope:'plan',decision:'approved',comment:''});
    const legacySelection=()=>({planRevision:legacyPlan.body.plan.revision,briefRevision:legacyBrief.body.brief.revision,
      selection:{ideaId:legacyPlan.body.plan.days[0].ideaId,platform:'telegram',contentRevision:legacyPlan.body.plan.days[0].variants.telegram.contentRevision}});
    for(const who of ['viewer','editor','stranger'])assert.equal((await through(who,decisionRoute,{method:'POST',body:legacyDecision()})).status,403);
    assert.equal((await through('owner',decisionRoute,{method:'POST',body:legacyDecision(),headers:{'x-csrf-token':''}})).status,403);
    assert.equal((await through('editor',selectedTransferRoute,{method:'POST',body:legacySelection()})).status,409,'не согласован');
    assert.equal((await through('owner',decisionRoute,{method:'POST',body:legacyDecision()})).status,201);
    const legacyCreated=await through('editor',selectedTransferRoute,{method:'POST',body:legacySelection()});
    assert.equal(legacyCreated.status,201,JSON.stringify(legacyCreated.body));assert.equal(legacyCreated.body.createdCount,1);
    assert.deepEqual(legacyCreated.body.created.map(item=>item.platform),['telegram'],'согласованный сосед VK не переносится');
    let legacyPost=legacyCreated.body.posts[0];const legacyPostRoute='/autoposting/posts/'+legacyPost.id;
    assert.equal(legacyPost.planLink.ideaId,legacySelection().selection.ideaId);assert.deepEqual(legacyPost.platformIds,[]);assert.equal(legacyPost.scheduledAt,null);
    assert.equal((await through('editor',legacyPostRoute+'/variants'+SCOPE,{method:'POST',body:{revision:legacyPost.revision,clientRequestId:'blocked_legacy_clone',platformId:'vk'}})).status,409);
    legacyPost=(await through('editor',legacyPostRoute+SCOPE,{method:'PATCH',body:{revision:legacyPost.revision,title:'Ручная legacy правка'}})).body;
    const legacyArchived=await through('editor',legacyPostRoute+'/archive'+SCOPE,{method:'POST',body:{revision:legacyPost.revision}});assert.equal(legacyArchived.status,200);
    const legacyReplay=await through('editor',selectedTransferRoute,{method:'POST',body:legacySelection()});assert.equal(legacyReplay.status,200);assert.equal(legacyReplay.body.createdCount,0);
    assert.equal(legacyReplay.body.skipped[0].postId,legacyPost.id);assert.equal(legacyReplay.body.skipped[0].archivedAt,legacyArchived.body.archive.archivedAt);
    assert.equal((await through('owner',legacyPostRoute+SCOPE)).body.title,'Ручная legacy правка');
    const staleSelection=legacySelection();
    legacyDays[0].variants.telegram.text='Новая плановая версия';
    legacyPlan=await through('editor','/media-mentor/plan'+SCOPE,{method:'PUT',body:{planRevision:legacyPlan.body.plan.revision,briefRevision:legacyBrief.body.brief.revision,days:legacyDays}});
    assert.equal(legacyPlan.status,200);assert.equal((await through('editor',selectedTransferRoute,{method:'POST',body:staleSelection})).status,409);
    assert.equal((await through('editor',selectedTransferRoute,{method:'POST',body:legacySelection()})).status,409);
    assert.equal((await through('owner',decisionRoute,{method:'POST',body:legacyDecision()})).status,201);
    const legacyNew=await through('editor',selectedTransferRoute,{method:'POST',body:legacySelection()});assert.equal(legacyNew.status,201);assert.notEqual(legacyNew.body.posts[0].id,legacyPost.id);
    assert.equal(legacyNew.body.posts[0].planLink.contentRevision,legacySelection().selection.contentRevision);
    assert.equal((await through('owner',legacyPostRoute+'?companyCode=alvi')).status,404);
    // Actual mid-body session change: marker появляется при чтении body ПОСЛЕ initial auth.
    async function slowRequest(who,route,method,body,change,{chunked=false}={}){
      await fs.rm(receivingMarker,{force:true});
      const payload=Buffer.from(JSON.stringify(body));let inflight;
      const result=new Promise((resolve,reject)=>{
        inflight=http.request(contentBase+'/content/crm'+route,{method,headers:{...sessions[who],'content-type':'application/json',
          ...(!chunked?{'content-length':payload.length}:{})}},response=>{
          let text='';response.on('data',chunk=>{text+=chunk;});response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(text)}));
        });inflight.on('error',reject);inflight.write(payload.subarray(0,1));
      });
      t.after(()=>inflight.destroy());
      for(let i=0;i<200;i++){if(await fs.stat(receivingMarker).then(()=>true,()=>false))break;await new Promise(resolve=>setTimeout(resolve,10));}
      assert.ok(await fs.stat(receivingMarker).then(()=>true,()=>false),'initial auth прошла, поток body принят');
      const freshAuth=new DatabaseSync(contentDb);try{change(freshAuth);}finally{freshAuth.close();}
      inflight.end(payload.subarray(1));return result;
    }
    const revokeEdit=db=>db.prepare("DELETE FROM auth_user_permissions WHERE user_id=(SELECT id FROM auth_users WHERE login='editor') AND permission='autoposting.edit'").run();
    const restoreEdit=()=>{const db=new DatabaseSync(contentDb);db.prepare("INSERT INTO auth_user_permissions(user_id,permission) SELECT id,'autoposting.edit' FROM auth_users WHERE login='editor'").run();db.close();};
    const freshActor=await slowRequest('editor',variantRoute,'POST',{...variantBody,clientRequestId:'proxy_fresh_actor'},db=>{
      db.prepare("UPDATE auth_users SET display_name=? WHERE login='editor'").run('Актуальный редактор');
    },{chunked:true});
    assert.equal(freshActor.status,201,JSON.stringify(freshActor.body));
    const freshActorDb=new DatabaseSync(crmDb);
    assert.equal(freshActorDb.prepare('SELECT actor_name FROM autoposting_platform_reviews WHERE post_id=?').get(freshActor.body.post.id).actor_name,
      'Актуальный редактор','CRM получила свежую личность, chunked тело корректно');freshActorDb.close();
    const deniedVariant=await slowRequest('editor',variantRoute,'POST',{...variantBody,clientRequestId:'proxy_revoked_variant'},revokeEdit);
    assert.equal(deniedVariant.status,403,'после отзыва не создан вариант');restoreEdit();
    const deniedTransfer=await slowRequest('editor',selectedTransferRoute,'POST',legacySelection(),revokeEdit);
    assert.equal(deniedTransfer.status,403,'после отзыва не передан вариант плана');restoreEdit();
    const deniedDecision=await slowRequest('owner',decisionRoute,'POST',legacyDecision(),db=>{
      db.prepare("UPDATE auth_users SET role='editor' WHERE login='owner'").run();
      db.prepare("INSERT INTO auth_user_companies(user_id,company_code) SELECT id,'avokado' FROM auth_users WHERE login='owner'").run();
      db.prepare("INSERT INTO auth_user_permissions(user_id,permission) SELECT id,'autoposting.edit' FROM auth_users WHERE login='owner'").run();
    });
    assert.equal(deniedDecision.status,403,'право edit не заменяет роль owner при согласовании');
    const restoreOwner=new DatabaseSync(contentDb);restoreOwner.prepare("UPDATE auth_users SET role='owner' WHERE login='owner'").run();restoreOwner.close();
    const denied=await slowRequest('editor',WORKFLOW,'PUT',{revision:1,fields:{reviewDays:4}},revokeEdit);
    assert.equal(denied.status,403,'право отозвано во время body');
    assert.equal((await through('owner',WORKFLOW)).body.revision,1,'отказ не сохранил новую версию');
    assert.equal(await fs.readFile(blockedNetwork, 'utf8').catch(() => ''), '', 'внешних вызовов нет');
  });
