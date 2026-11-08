'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {once, EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {randomUUID} = require('node:crypto');
const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const {loadConfig, childEnvironment, codexInvocation, createMcpClient, validateJob, buildPrompt, loadLocalInstructions, prepareCodexHome, terminateTree, AgentLaunchWorker} = require('./agent-launch-local-worker');
const actualArgs = invocation => invocation.settings.env.TASKS_AGENT_EXEC_JSON ? JSON.parse(invocation.settings.env.TASKS_AGENT_EXEC_JSON).arguments : invocation.args;
const resumeArgs = invocation => {const args=actualArgs(invocation);return args.slice(args.indexOf('resume'),args.indexOf('resume')+2);};
const finishReady = child => {child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({outcome:'ready',summary:'SAMPLE готово'})}})+'\n');child.stdout.write(JSON.stringify({type:'turn.completed'})+'\n');child.end(0);};
const syntheticIsolation = async()=>({implementation:'mxc',readIsolation:true,networkIsolation:true,workspaceWrite:true});

const job = (fields = {}) => ({run_id:randomUUID(), task_id:40, company_code:'synapse-business', executor_profile:'codex-code',
  code_only:true,allowed_paths:['sample.txt'],title:'SAMPLE локальная задача', description:'Только тестовые данные', lease_token:randomUUID(), lease_until:new Date(Date.now() + 180000).toISOString(), ...fields});
const tick = async (predicate, attempts=100) => { for (let i=0; i<attempts; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('Тестовое ожидание истекло'); };
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-worker-'));
  const config = {repo:path.join(dir, 'repo'), worktrees:path.join(dir, 'trees'), stateDir:path.join(dir, 'state'),
    sourceCodexHome:path.join(dir, 'source'), endpoint:'https://tasks.example.test/mcp/' + 's'.repeat(32), codexBin:'codex',
    ownerHome:path.join(dir,'owner'),ownerAppData:path.join(dir,'owner','AppData','Roaming'),ownerLocalAppData:path.join(dir,'owner','AppData','Local'),
    windowsSandbox:'mxc',maxConcurrent:3, pollMs:5000, heartbeatMs:20000, timeoutMs:60000};
  const calls = [], children = [], spawns = [], commands = [];
  let proxyClosed = 0;
  const call = async (name, args) => { calls.push({name, args}); return options.call ? options.call(name, args) : {run:{state:'running', stop_requested:false}}; };
  function spawnImpl(command, args, settings) {
    spawns.push({command, args, settings});
    const child = new EventEmitter(); child.pid = 900000 + children.length; child.exitCode = null;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.end = code => { child.exitCode = code; child.emit('close', code); };
    children.push(child); return child;
  }
  const worker = new AgentLaunchWorker(config, {call, spawnImpl,
    execImpl:async (command, args, settings) => { commands.push({command,args,settings}); return {stdout:options.branch || ''}; },
    killTree:async child => { if (child.exitCode === null) child.end(1); },
    createChildMcp:async () => ({endpoint:'http://127.0.0.1:54321/mcp/test', close:async () => { proxyClosed++; }}),
    publishImpl:async()=>({pr_url:'https://github.com/example/sample/pull/1',commit:'a'.repeat(40)}),
    loadPolicy:async()=>'SAMPLE runtime-пакет обязательных правил.',
    verifyIsolation:syntheticIsolation,
    checkProjectConfig:async()=>{},
    prepareHome:async () => path.join(config.stateDir, 'codex-home'),
    env:{PATH:process.env.PATH, OPENAI_API_KEY:'fake-api-key', TASKS_MCP_ENDPOINT:'fake-owner-endpoint', GH_TOKEN:'fake-gh-token'}, ...options.dependencies});
  await worker.init();
  t.after(async () => {
    await worker.stop();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, {recursive:true, force:true});
  });
  return {dir, config, worker, calls, children, spawns, commands, proxyClosed:() => proxyClosed};
}

test('конфигурация требует явные внешние каталоги и не разрешает HTTP за пределами loopback', () => {
  const base = path.resolve(os.tmpdir(), 'agent-config');
  const env = {TASKS_MCP_ENDPOINT:'https://tasks.example.test/mcp/' + 't'.repeat(32), TASKS_AGENT_REPO:path.join(base,'repo'),
    TASKS_AGENT_WORKTREE_DIR:path.join(base,'trees'), TASKS_AGENT_STATE_DIR:path.join(base,'state')};
  const c = loadConfig(env); assert.equal(c.maxConcurrent,3); assert.equal(c.heartbeatMs,20000);
  assert.throws(() => loadConfig({...env,TASKS_AGENT_STATE_DIR:path.join(base,'repo','private')}), /DIRECTORIES_OVERLAP/);
  assert.throws(() => loadConfig({...env,TASKS_MCP_ENDPOINT:'http://tasks.example.test/mcp/' + 'x'.repeat(32)}), /ENDPOINT_INVALID/);
  assert.throws(() => loadConfig({...env,TASKS_AGENT_CODEX_BIN:'codex.cmd'}), /CODEX_DIRECT_BINARY_REQUIRED/);
  assert.throws(() => loadConfig({...env,TASKS_AGENT_WINDOWS_SANDBOX:'unelevated'}), /READ_ISOLATION_UNSUPPORTED/);
  assert.doesNotMatch(JSON.stringify(childEnvironment({...process.env,OPENAI_API_KEY:'secret1',GH_TOKEN:'secret2',TASKS_MCP_ENDPOINT:'secret3'},base)), /secret[123]/);
  const isolated=childEnvironment({HOME:'owner-home',USERPROFILE:'owner-profile',APPDATA:'owner-roaming',LOCALAPPDATA:'owner-local',TEMP:'owner-temp',TMP:'owner-tmp'},base);
  assert.doesNotMatch(JSON.stringify(isolated),/owner-/);
  assert.equal(isolated.HOME,isolated.USERPROFILE);assert.notEqual(isolated.HOME,base);assert.equal(isolated.CODEX_HOME,base);
});

test('без живого доказательства изоляции worker не забирает задания и не копирует auth', async t => {
  const f=await fixture(t), blockedConfig={...f.config,stateDir:path.join(f.dir,'blocked-state')};
  let claims=0,spawns=0,copies=0;
  const worker=new AgentLaunchWorker(blockedConfig,{call:async()=>{claims++;},spawnImpl:()=>{spawns++;},prepareHome:async()=>{copies++;}});
  await assert.rejects(worker.init(),{code:'READ_ISOLATION_UNAVAILABLE'});
  assert.deepEqual([claims,spawns,copies],[0,0,0]);
  await assert.rejects(fs.access(blockedConfig.stateDir),{code:'ENOENT'});
  for(const proof of [null,{implementation:'mxc',readIsolation:false,networkIsolation:true,workspaceWrite:true},
    {implementation:'unelevated',readIsolation:true,networkIsolation:true,workspaceWrite:true}]) {
    const invalid=new AgentLaunchWorker(blockedConfig,{verifyIsolation:async()=>proof});
    await assert.rejects(invalid.init(),{code:'READ_ISOLATION_UNAVAILABLE'});
  }
});

test('проверка job исключает ветки-пути, устаревшие lease и resume без ID сообщения', () => {
  const j = job(); assert.match(validateJob(j).branch,/^codex\/agent-task-40-/);
  assert.throws(() => validateJob({...j,branch:'../../outside'}),/INVALID_BRANCH/);
  assert.throws(() => validateJob({...j,lease_until:new Date(0).toISOString()}),/INVALID_JOB/);
  assert.throws(() => validateJob({...j,session_id:randomUUID()}),/MESSAGE_ID_REQUIRED/);
  assert.throws(() => validateJob({...j,code_only:false}),/CODE_ONLY_REQUIRED/);
  assert.throws(() => validateJob({...j,code_only:undefined}),/CODE_ONLY_REQUIRED/);
  for(const allowed_paths of [undefined,[],['.'],['../other'],['src/*'],['C:/private'],['src\\x'],[' src/']])assert.throws(()=>validateJob({...j,allowed_paths}),/INVALID_SCOPE/);
  const prompt = buildPrompt(validateJob(j));
  for (const name of ['session_start','task_get','task_update','agent_report','task_comment','ВОПРОС → Claude']) assert.ok(prompt.includes(name));
  assert.ok(prompt.includes('Merge, deploy')); assert.ok(prompt.includes('PR без merge'));
});

test('runtime-пакет читает только два фиксированных документа с ограничением размера', async t => {
  const f=await fixture(t);await fs.mkdir(f.config.repo,{recursive:true});
  await fs.writeFile(path.join(f.config.repo,'.env'),'SYNTHETIC_ENV_MUST_NOT_BE_READ');
  await fs.writeFile(path.join(f.config.repo,'AGENTS.md'),'SAMPLE_LOCAL_AGENTS');
  await fs.writeFile(path.join(f.config.repo,'AGENT-ECONOMY.md'),'SAMPLE_LOCAL_ECONOMY');
  let context=await loadLocalInstructions(f.config.repo);
  assert.ok(context.includes('SAMPLE_LOCAL_AGENTS'));assert.ok(context.includes('SAMPLE_LOCAL_ECONOMY'));assert.ok(!context.includes('SYNTHETIC_ENV_MUST_NOT_BE_READ'));
  await fs.writeFile(path.join(f.config.repo,'AGENTS.md'),'OVERSIZED_POLICY'.repeat(5000));
  context=await loadLocalInstructions(f.config.repo);assert.ok(!context.includes('OVERSIZED_POLICY'));assert.ok(context.includes('SAMPLE_LOCAL_ECONOMY'));
  await fs.writeFile(path.join(f.config.repo,'AGENTS.md'),'A'.repeat(64*1024));
  await fs.writeFile(path.join(f.config.repo,'AGENT-ECONOMY.md'),'B'.repeat(64*1024));
  context=await loadLocalInstructions(f.config.repo);assert.ok(context.includes('A'.repeat(64*1024)));assert.ok(!context.includes('B'.repeat(64*1024)),'суммарный лимит96KiB соблюдён');
  await fs.unlink(path.join(f.config.repo,'AGENTS.md'));await fs.unlink(path.join(f.config.repo,'AGENT-ECONOMY.md'));
  context=await loadLocalInstructions(f.config.repo);assert.ok(context.includes('LOCAL_POLICY_UNAVAILABLE'));assert.ok(context.includes('outcome=blocked'));
});

test('MCP transport использует POST JSON RPC и не раскрывает URL/тело ошибки', async t => {
  const requests=[];
  const server=http.createServer(async (req,res) => {
    let body=''; for await(const chunk of req) body+=chunk; requests.push(JSON.parse(body));
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({jsonrpc:'2.0',id:requests.at(-1).id,result:{content:[],structuredContent:{job:null}}}));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call=createMcpClient(`http://127.0.0.1:${server.address().port}/mcp/secret`);
  assert.deepEqual(await call('agent_worker_claim',{worker_id:randomUUID()}),{job:null});
  assert.equal(requests[0].params.name,'agent_worker_claim');
  const failing=createMcpClient('https://secret.invalid/mcp/token',{fetchImpl:async()=>{throw Error('private URL/token');}});
  await assert.rejects(failing('x',{}),e=>e.message==='MCP_UNAVAILABLE'&&!e.stack.includes('private URL'));
  const noMap=createMcpClient('https://tasks.example.test/mcp/fake',{fetchImpl:async()=>new Response(JSON.stringify({result:{isError:true,
    structuredContent:{error:{status:503,message:'Карта не установлена'}}}}))});
  await assert.rejects(noMap('session_start',{}),{code:'MAP_NOT_INSTALLED'});
});

test('MCP сохраняет большие старые задачи и останавливает чтение ответа больше32MiB', async () => {
  const content={task:{id:40,description:'SAMPLE'.repeat(30000),comments:Array.from({length:20},()=>({text:'SAMPLE'.repeat(1000)}))}};
  const call=createMcpClient('https://tasks.example.test/mcp/fake',{fetchImpl:async()=>new Response(JSON.stringify({result:{structuredContent:content}}))});
  assert.deepEqual(await call('task_get',{task_id:40}),content);
  let cancelled=false,pulls=0;
  const oversized=createMcpClient('https://tasks.example.test/mcp/fake',{fetchImpl:async()=>new Response(new ReadableStream({
    pull(controller){pulls++;controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}
  }))});
  await assert.rejects(oversized('task_get',{task_id:40}),{code:'MCP_UNAVAILABLE'});
  assert.equal(cancelled,true);assert.ok(pulls<=34,'поток отменён сразу после превышения лимита');
  let earlyCancelled=false,earlyPulls=0;
  const declared=createMcpClient('https://tasks.example.test/mcp/fake',{fetchImpl:async()=>new Response(new ReadableStream({
    pull(){earlyPulls++;},cancel(){earlyCancelled=true;}
  }),{headers:{'content-length':String(32*1024*1024+1)}})});
  await assert.rejects(declared('task_get',{task_id:40}),{code:'MCP_UNAVAILABLE'});
  assert.equal(earlyCancelled,true);assert.ok(earlyPulls<=1,'Content-Length отклонён до чтения тела');
});

test('приватный CODEX_HOME копирует только subscription auth и подключает loopback proxy', async t => {
  const f=await fixture(t); await fs.mkdir(f.config.sourceCodexHome,{recursive:true});
  await fs.writeFile(path.join(f.config.sourceCodexHome,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic-token'}}));
  const runId=randomUUID(), endpoint='http://127.0.0.1:54321/mcp/nonce';
  const home=await prepareCodexHome(f.config,{endpoint,runId});
  const config=await fs.readFile(path.join(home,'config.toml'),'utf8');
  assert.ok(config.includes(endpoint)); assert.ok(config.includes('[permissions.synapse_agent.network]\nenabled = false')); assert.ok(config.includes('forced_login_method = "chatgpt"'));
  assert.ok(config.includes('default_permissions = "synapse_agent"'));assert.ok(!config.includes('sandbox_mode'));
  assert.ok(config.includes(JSON.stringify(f.config.stateDir)+' = "deny"'));assert.ok(config.includes(JSON.stringify(f.config.sourceCodexHome)+' = "deny"'));
  assert.equal((config.match(/approval_mode = "approve"/g)||[]).length,7);
  assert.ok(config.includes('[mcp_servers.synapse_tasks.tools.task_get]')); assert.ok(!config.includes('codex_hooks'));
  assert.ok(config.includes('view_image = false'));
  if(process.platform==='win32')assert.ok(config.includes('[windows]\nsandbox = "mxc"'));
  assert.ok(!config.includes(f.config.endpoint)); assert.ok(!config.includes('synthetic-token'));
  assert.deepEqual((await fs.readdir(home)).sort(),['auth.json','config.toml','result-schema.json']);
  await assert.rejects(prepareCodexHome(f.config,{endpoint:f.config.endpoint,runId}),/CHILD_PROXY_REQUIRED/);
  await fs.writeFile(path.join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic-refreshed'}}));
  await fs.writeFile(path.join(f.config.sourceCodexHome,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'synthetic-api'}));
  await prepareCodexHome(f.config,{endpoint,runId});
  assert.ok((await fs.readFile(path.join(home,'auth.json'),'utf8')).includes('synthetic-refreshed'));
  await assert.rejects(prepareCodexHome(f.config,{endpoint,runId:randomUUID()}),/CODEX_SUBSCRIPTION_LOGIN_REQUIRED/);
});

test('exec и resume используют один worktree/session; сырые тексты и секреты не попадают в status', async t => {
  const j=job(), branch=validateJob(j).branch, session=randomUUID();
  const f=await fixture(t,{branch});
  await f.worker.startJob(j);
  assert.equal(f.spawns.length,1); const first=f.spawns[0];
  assert.equal(first.settings.shell,false); assert.equal(first.settings.windowsHide,true);
  assert.equal(first.settings.env.OPENAI_API_KEY,undefined); assert.equal(first.settings.env.GH_TOKEN,undefined); assert.equal(first.settings.env.TASKS_MCP_ENDPOINT,undefined);
  assert.ok(first.settings.env.HOME.startsWith(f.config.worktrees));assert.equal(first.settings.env.USERPROFILE,first.settings.env.HOME);
  for(const name of ['HOME','APPDATA','LOCALAPPDATA','TEMP'])assert.ok((await fs.stat(first.settings.env[name])).isDirectory());
  assert.ok(!actualArgs(first).includes('-s'));assert.ok(!actualArgs(first).some(arg=>arg.includes('sandbox_mode')||arg.includes('sandbox_workspace_write')));
  f.children[0].stdout.write(JSON.stringify({type:'thread.started',thread_id:session})+'\n');
  f.children[0].stdout.write(JSON.stringify({type:'item.completed',item:{text:'synthetic-client-secret'}})+'\n');
  f.children[0].stderr.write('synthetic-raw-error'); finishReady(f.children[0]);
  await tick(()=>f.worker.active.size===0);
  assert.equal(f.worker.records[j.run_id].status,'complete');
  assert.equal(f.proxyClosed(),1);
  const state=await fs.readFile(path.join(f.config.stateDir,'state.json'),'utf8');
  assert.doesNotMatch(state,/synthetic-client-secret|synthetic-raw-error|fake-api-key|fake-owner-endpoint|fake-gh-token/);
  await f.worker.startJob({...j,session_id:session,message_id:1,message:'SAMPLE доработка',lease_token:randomUUID()});
  assert.deepEqual(resumeArgs(f.spawns[1]),['resume',session]);
  assert.ok(actualArgs(f.spawns[1]).indexOf('--output-schema')<actualArgs(f.spawns[1]).indexOf('resume'));
  assert.equal(f.spawns[1].settings.cwd,first.settings.cwd); assert.ok(!f.spawns[1].args.includes('--last'));
  assert.equal(f.commands.filter(x=>x.args.includes('worktree')).length,1,'новый worktree при resume не создаётся');
  finishReady(f.children[1]); await tick(()=>f.worker.active.size===0);
  await assert.rejects(f.worker.startJob({...j,session_id:session,message_id:1}),/DUPLICATE_OR_UNKNOWN_RUN/);
  await assert.rejects(f.worker.startJob({...j,session_id:session,message_id:2,allowed_paths:['other.txt']}),/SCOPE_CHANGED/);
});

test('неизменяемые code_only/allowed_paths из очереди сохраняются и передаются publisher', async t => {
  let published;
  const f=await fixture(t,{dependencies:{publishImpl:async args=>{published=args;return{pr_url:'https://github.com/example/sample/pull/1',commit:'a'.repeat(40)};}}});
  const j=job({allowed_paths:['src/','sample.txt']});await f.worker.startJob(j);j.allowed_paths.push('unexpected/');
  f.children[0].stdout.write(JSON.stringify({type:'thread.started',thread_id:randomUUID()})+'\n');finishReady(f.children[0]);await tick(()=>f.worker.active.size===0);
  assert.equal(published.code_only,true);assert.deepEqual(published.allowed_paths,['src/','sample.txt']);
  assert.deepEqual(f.worker.records[j.run_id].allowed_paths,['src/','sample.txt']);
});

test('project config в новом worktree блокирует authcopy и запуск модели', async t => {
  const {assertNoProjectConfig}=require('./agent-launch-project-config');
  let homes=0;
  const f=await fixture(t,{dependencies:{prepareHome:async()=>{homes++;return'UNUSED';}}});
  f.worker.config.ownerHomes=[os.homedir()];f.worker.checkProjectConfig=assertNoProjectConfig;
  f.worker.prepareWorktree=async j=>{const cwd=path.join(f.config.worktrees,'task-'+j.run_id);await fs.mkdir(path.join(cwd,'.codex'),{recursive:true});
    await fs.writeFile(path.join(cwd,'.codex','config.toml'),'[windows]\nsandbox="unelevated"\n');return cwd;};
  const j=job();await f.worker.startJob(j);
  assert.equal(homes,0);assert.equal(f.spawns.length,0);assert.equal(f.worker.records[j.run_id].status,'failed');
});

test('добавленный project config перед resume повторно блокирует authcopy и spawn', async t => {
  const {assertNoProjectConfig}=require('./agent-launch-project-config');let homes=0;
  const f=await fixture(t,{dependencies:{prepareHome:async()=>{homes++;return path.join(f.config.stateDir,'fake-home');}}});
  f.worker.config.ownerHomes=[os.homedir()];f.worker.checkProjectConfig=assertNoProjectConfig;
  f.worker.prepareWorktree=async j=>{const cwd=path.join(f.config.worktrees,'task-'+j.run_id);await fs.mkdir(cwd,{recursive:true});return cwd;};
  const j=job(),session=randomUUID();await f.worker.startJob(j);f.children[0].stdout.write(JSON.stringify({type:'thread.started',thread_id:session})+'\n');finishReady(f.children[0]);await tick(()=>f.worker.active.size===0);
  const cwd=f.worker.records[j.run_id].worktree;await fs.mkdir(path.join(cwd,'.codex'));await fs.writeFile(path.join(cwd,'.codex','config.toml'),'[mcp_servers.untrusted]\ncommand="SYNTHETIC_NOT_RUN"\n');
  homes=0;await f.worker.startJob({...j,session_id:session,message_id:2,lease_token:randomUUID()});
  assert.equal(homes,0);assert.equal(f.spawns.length,1);assert.equal(f.worker.records[j.run_id].status,'failed');
});

test('project config проверяется повторно после подготовки auth, прямо перед spawn', async t => {
  let checks=0,homes=0;
  const f=await fixture(t,{dependencies:{checkProjectConfig:async()=>{checks++;if(checks===2)throw Object.assign(Error('PROJECT_CONFIG_UNSUPPORTED'),{code:'PROJECT_CONFIG_UNSUPPORTED'});},
    prepareHome:async()=>{homes++;return path.join(f.config.stateDir,'fake-home');}}});
  const j=job();await f.worker.startJob(j);assert.equal(checks,2);assert.equal(homes,1);assert.equal(f.spawns.length,0);assert.equal(f.worker.records[j.run_id].status,'failed');
});

test('poll держит максимум три процесса даже если сервер отдаёт больше', async t => {
  const jobs=Array.from({length:5},()=>job()); let claims=0;
  const f=await fixture(t,{call:async name => name==='agent_worker_claim'?{job:jobs[claims++]}:{run:{stop_requested:false}}});
  await f.worker.poll(); assert.equal(f.children.length,3); assert.equal(claims,3); assert.equal(f.worker.active.size,3);
});

test('heartbeat stop завершает дерево до stopped ack и не запускает повтор', async t => {
  const f=await fixture(t,{call:async(name,args)=>({run:{stop_requested:args?.event==='heartbeat'&&f?.children.length>0}})});
  await f.worker.startJob(job()); await f.worker.heartbeat(); await tick(()=>f.worker.active.size===0);
  assert.equal(f.children[0].exitCode,1);
  assert.ok(f.calls.some(x=>x.args.event==='stopped')); assert.equal(f.spawns.length,1);
});

test('stop во время подготовки git предотвращает сам spawn', async t => {
  let heartbeats=0;
  const f=await fixture(t,{call:async(name,args)=>({run:{stop_requested:args.event==='heartbeat'&&++heartbeats===2}})});
  await f.worker.startJob(job());
  assert.equal(f.spawns.length,0); assert.ok(f.calls.some(x=>x.args.event==='stopped')); assert.equal(f.proxyClosed(),1);
});

test('потеря heartbeat останавливает процесс и сохраняет подтверждённый stopped', async t => {
  let fail=false;
  const f=await fixture(t,{call:async(name,args)=>{if(fail&&args.event==='heartbeat')throw Error('transport');return{run:{stop_requested:false}};}});
  const j=job(); await f.worker.startJob(j); fail=true;
  await f.worker.heartbeat(); await tick(()=>f.worker.active.size===0);
  assert.equal(f.children[0].exitCode,1); assert.equal(f.worker.records[j.run_id].status,'stopped');
  assert.ok(f.worker.records[j.run_id].log_tail.includes('LEASE_OR_TRANSPORT_LOST'));
});

test('неизвестное complete блокирует новые claims; перезапуск не порождает второй процесс', async t => {
  let claims=0;
  const f=await fixture(t,{call:async(name,args)=>{if(name==='agent_worker_claim'){claims++;return{job:null};} if(args.event==='complete')throw Error('lost');return{run:{stop_requested:false}};}});
  const j=job(); await f.worker.startJob(j); f.children[0].stdout.write(JSON.stringify({type:'thread.started',thread_id:randomUUID()})+'\n'); finishReady(f.children[0]);
  await tick(()=>f.worker.active.size===0); assert.equal(f.worker.records[j.run_id].status,'unknown');
  await f.worker.poll(); assert.equal(claims,0);
  await f.worker.releaseLock();
  const restarted=new AgentLaunchWorker(f.config,{verifyIsolation:syntheticIsolation,call:async()=>{claims++;return{job:null};}});
  await restarted.init(); await restarted.poll(); assert.equal(claims,0); assert.equal(restarted.workerId,f.worker.workerId);
  await restarted.stop();
});

test('подтверждённый failed с session продолжается, неизвестный запуск не возобновляется', async t => {
  const j=job(), session=randomUUID(), branch=validateJob(j).branch, f=await fixture(t,{branch});
  await f.worker.startJob(j); f.children[0].stdout.write(JSON.stringify({type:'thread.started',thread_id:session})+'\n'); f.children[0].end(1);
  await tick(()=>f.worker.active.size===0); assert.equal(f.worker.records[j.run_id].status,'failed');
  await f.worker.startJob({...j,session_id:session,message_id:2,lease_token:randomUUID()});
  assert.deepEqual(resumeArgs(f.spawns[1]),['resume',session]);
});

test('ошибка publisher сохраняет готовый turn с PR_PENDING и не запускает codex второй раз', async t => {
  const j=job(), f=await fixture(t,{dependencies:{publishImpl:async()=>{throw Object.assign(Error('private failure'),{code:'PUBLISH_FAILED'});}}});
  await f.worker.startJob(j); f.children[0].stdout.write(JSON.stringify({type:'thread.started',thread_id:randomUUID()})+'\n'); finishReady(f.children[0]);
  await tick(()=>f.worker.active.size===0);
  const complete=f.calls.find(x=>x.args.event==='complete');
  assert.ok(complete.args.summary.includes('PR_PENDING: PUBLISH_FAILED')); assert.ok(!complete.args.summary.includes('private failure'));
  assert.equal(f.worker.records[j.run_id].status,'complete'); assert.equal(f.spawns.length,1);
});

test('exit0 с BLOCKER, structured blocked или без turn.completed не считается готовым и не публикуется', async t => {
  let publishes=0;
  const f=await fixture(t,{dependencies:{publishImpl:async()=>{publishes++;throw Error('не должен вызываться');}}});
  for(const [message,turnComplete] of [
    ['BLOCKER: synthetic-private-details',true],
    [JSON.stringify({outcome:'blocked',summary:'synthetic-private-details'}),true],
    [JSON.stringify({outcome:'ready',summary:'synthetic-private-details'}),false]
  ]) {
    const j=job();await f.worker.startJob(j);const child=f.children.at(-1);
    child.stdout.write(JSON.stringify({type:'thread.started',thread_id:randomUUID()})+'\n');
    child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:message}})+'\n');
    if(turnComplete)child.stdout.write(JSON.stringify({type:'turn.completed'})+'\n');
    child.end(0);await tick(()=>f.worker.active.size===0);
    assert.equal(f.worker.records[j.run_id].status,'failed');
    assert.doesNotMatch(JSON.stringify(f.worker.records[j.run_id]),/synthetic-private-details/);
  }
  assert.equal(publishes,0);
  assert.ok(f.calls.filter(x=>x.args.event==='failed').length===3);
});

test('stop перед publisher не начинает push; stop во время publisher отменяет его signal', async t => {
  let stop=false,publishing=false,published=0,aborted=false;
  const f=await fixture(t,{call:async(name,args)=>({run:{stop_requested:stop&&args.event==='heartbeat'}}),dependencies:{
    publishImpl:async(run,{signal})=>{published++;publishing=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true}));}
  }});
  const j=job(); await f.worker.startJob(j); f.children[0].stdout.write(JSON.stringify({type:'thread.started',thread_id:randomUUID()})+'\n');
  stop=true; finishReady(f.children[0]); await tick(()=>f.worker.active.size===0); assert.equal(published,0);
  stop=false; const next=job(); await f.worker.startJob(next); f.children[1].stdout.write(JSON.stringify({type:'thread.started',thread_id:randomUUID()})+'\n'); finishReady(f.children[1]);
  await tick(()=>publishing); assert.equal(f.worker.active.size,1,'слот удерживается до завершения publisher');
  stop=true; await f.worker.heartbeat(); await tick(()=>f.worker.active.size===0);
  assert.equal(aborted,true); assert.equal(f.worker.records[next.run_id].status,'stopped');
});

test('Windows stop использует taskkill PID/T/F с отключённым окном', async () => {
  const calls=[]; await terminateTree({pid:12345,exitCode:null},{platform:'win32',execImpl:async(...args)=>{calls.push(args);}});
  assert.equal(calls[0][0],'taskkill.exe'); assert.deepEqual(calls[0][1],['/PID','12345','/T','/F']); assert.equal(calls[0][2].windowsHide,true);
});

test('Windows JobObject убирает background child и при обычном выходе, и при stop', {skip:process.platform!=='win32'}, async t => {
  const f=await fixture(t), leader=path.join(f.dir,'leader.js');
  await fs.writeFile(leader, `const {spawn}=require('node:child_process');\nconst c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});c.unref();\nconsole.log('CHILD_PID='+c.pid);if(process.argv[2]==='exit')process.exitCode=7;else setInterval(()=>{},1000);\n`);
  const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
  for(const mode of ['exit','wait']) {
    const invocation=codexInvocation(leader,[mode],childEnvironment(process.env,path.join(f.dir,'home')));
    const child=spawn(invocation.executable,invocation.args,{env:invocation.env,cwd:f.dir,windowsHide:true,stdio:['pipe','pipe','pipe']});
    t.after(async()=>{if(child.exitCode===null)await terminateTree(child);});
    let output='',stderr='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.end('');
    const closed=once(child,'close');
    await tick(()=>/CHILD_PID=(\d+)/.test(output)||child.exitCode!==null,1000);
    const pid=Number(output.match(/CHILD_PID=(\d+)/)?.[1]);
    assert.ok(pid,`supervisor не создал synthetic child: ${stderr.slice(-500)}`);
    if(mode==='wait') await terminateTree(child);
    const [code]=await closed;
    if(mode==='exit') assert.equal(code,7,'supervisor сохраняет exit code лидера');
    await tick(()=>!alive(pid)); assert.equal(alive(pid),false);
  }
});

test('быстрый exit ждёт delayed started ACK до terminal и не превращается в unknown', async t => {
  let release; const delayed=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{call:async(name,args)=>{if(args.event==='started'&&!args.session_id)await delayed;return{run:{stop_requested:false}};}});
  const j=job(), starting=f.worker.startJob(j); await tick(()=>f.children.length===1);
  f.children[0].end(1); await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(!f.calls.some(x=>x.args.event==='failed'));
  release(); await starting; await tick(()=>f.worker.active.size===0);
  assert.equal(f.worker.records[j.run_id].status,'failed'); assert.equal(f.spawns.length,1);
});

test('подготовка создаёт настоящий отдельный git worktree от origin/main', async t => {
  const f=await fixture(t);
  const remote=path.join(f.dir,'remote.git');
  await exec('git',['init','--bare',remote],{windowsHide:true});
  await exec('git',['init','-b','main',f.config.repo],{windowsHide:true});
  await exec('git',['-C',f.config.repo,'config','core.autocrlf','false'],{windowsHide:true});
  await fs.writeFile(path.join(f.config.repo,'sample.txt'),'SAMPLE\n');
  await exec('git',['-C',f.config.repo,'add','sample.txt'],{windowsHide:true});
  await exec('git',['-C',f.config.repo,'-c','user.name=SAMPLE','-c','user.email=sample@example.test','commit','-m','SAMPLE'],{windowsHide:true});
  await exec('git',['-C',f.config.repo,'remote','add','origin',remote],{windowsHide:true});
  await exec('git',['-C',f.config.repo,'push','origin','main'],{windowsHide:true});
  await fs.writeFile(path.join(f.config.repo,'AGENTS.md'),'SAMPLE_UNTRACKED_ORIGINAL_POLICY');
  await fs.writeFile(path.join(f.config.repo,'AGENT-ECONOMY.md'),'SAMPLE_UNTRACKED_ECONOMY');
  f.worker.exec=exec; const j=validateJob(job()), target=await f.worker.prepareWorktree(j);
  const {stdout}=await exec('git',['-C',target,'branch','--show-current'],{windowsHide:true});
  assert.equal(stdout.trim(),j.branch); assert.equal(await fs.readFile(path.join(target,'sample.txt'),'utf8'),'SAMPLE\n');
  const prompt=buildPrompt(j,await loadLocalInstructions(f.config.repo));
  assert.ok(prompt.includes('SAMPLE_UNTRACKED_ORIGINAL_POLICY'));assert.ok(prompt.includes('SAMPLE_UNTRACKED_ECONOMY'));
  await assert.rejects(fs.access(path.join(target,'AGENTS.md')),{code:'ENOENT'});
  await assert.rejects(fs.access(path.join(target,'AGENT-ECONOMY.md')),{code:'ENOENT'});
  await exec('git',['-C',f.config.repo,'worktree','remove',target],{windowsHide:true});
});

// №194: профиль codex-review-merge и сигнал присутствия.
const reviewJob = (fields = {}) => job({executor_profile:'codex-review-merge', code_only:false, allowed_paths:[], pr_number:621, ...fields});
const finishReview = (child, outcome) => {
  child.stdout.write(JSON.stringify({type:'thread.started',thread_id:randomUUID()})+'\n');
  child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({outcome,summary:'SAMPLE вердикт'})}})+'\n');
  child.stdout.write(JSON.stringify({type:'turn.completed'})+'\n'); child.end(0);
};
const reviewTools = (mergeResult = {merged:true,accepted:true,merge_commit:'c'.repeat(40)}) => {
  const seen = {prepare:[], merge:[]};
  return {seen, impl:{
    prepareReview:async args => { seen.prepare.push(args); return {remote:'example/sample', reviewedSha:'a'.repeat(40), url:'https://github.com/example/sample/pull/621'}; },
    mergeReviewed:async args => { seen.merge.push(args); if (mergeResult.merged) await args.comment('КОД ПРИНЯТ — SAMPLE'); return mergeResult; }}};
};

test('ревью-задание: только номер PR, пустая область, без продолжения', () => {
  const j = reviewJob(), valid = validateJob(j);
  assert.equal(valid.review,true); assert.match(valid.branch,/^review\/pr-621-/); assert.deepEqual(valid.allowed_paths,[]);
  assert.throws(() => validateJob({...j,code_only:true}),/INVALID_REVIEW_JOB/);
  assert.throws(() => validateJob({...j,allowed_paths:['ops/']}),/INVALID_REVIEW_JOB/);
  assert.throws(() => validateJob({...j,pr_number:0}),/INVALID_REVIEW_JOB/);
  assert.throws(() => validateJob({...j,session_id:randomUUID(),message_id:'1'}),/REVIEW_RESUME_UNSUPPORTED/);
  assert.throws(() => validateJob({...job(),pr_number:5}),/INVALID_JOB/);
  const {buildReviewPrompt} = require('./agent-launch-local-worker');
  const prompt = buildReviewPrompt(valid);
  assert.ok(prompt.includes('PR #621')); assert.ok(prompt.includes('Не пиши «КОД ПРИНЯТ» сам')); assert.ok(prompt.includes('approve|changes|blocked'));
});

test('approve → доверенная стадия сливает без publisher; changes → только замечание', async t => {
  let published = 0;
  const tools = reviewTools();
  const f = await fixture(t,{dependencies:{reviewImpl:tools.impl,publishImpl:async()=>{published++;return{};}}});
  const j = reviewJob(); await f.worker.startJob(j);
  assert.equal(tools.seen.prepare[0].prNumber,621);
  finishReview(f.children[0],'approve'); await tick(()=>f.worker.active.size===0);
  assert.equal(published,0); assert.equal(tools.seen.merge[0].reviewedSha,'a'.repeat(40));
  const complete = f.calls.find(x=>x.args.event==='complete');
  assert.match(complete.args.summary,/слит обычным merge/);
  assert.ok(f.calls.some(x=>x.name==='task_comment'&&x.args.text==='КОД ПРИНЯТ — SAMPLE'&&x.args.author==='Обработчик Codex (доверенный)'));
  assert.ok(Number.isFinite(tools.seen.merge[0].deadlineAt));
  assert.match(complete.args.summary,/managed-release не запускался/);
  assert.equal(f.worker.records[j.run_id].merge_commit,'c'.repeat(40));

  const second = reviewTools(), g = await fixture(t,{dependencies:{reviewImpl:second.impl}});
  await g.worker.startJob(reviewJob()); finishReview(g.children[0],'changes'); await tick(()=>g.worker.active.size===0);
  assert.equal(second.seen.merge.length,0);
  assert.match(g.calls.find(x=>x.args.event==='complete').args.summary,/нужны правки/);
  assert.ok(!g.calls.some(x=>x.name==='task_comment'&&/КОД ПРИНЯТ/.test(x.args.text)));
});

test('ревью: «ready» не принимается, blocked не сливает, отказ слияния виден в итоге', async t => {
  const tools = reviewTools(), f = await fixture(t,{dependencies:{reviewImpl:tools.impl}});
  await f.worker.startJob(reviewJob()); finishReview(f.children[0],'ready'); await tick(()=>f.worker.active.size===0);
  assert.equal(tools.seen.merge.length,0); assert.ok(f.calls.some(x=>x.args.event==='failed'));
  const blocked = reviewTools(), g = await fixture(t,{dependencies:{reviewImpl:blocked.impl}});
  await g.worker.startJob(reviewJob()); finishReview(g.children[0],'blocked'); await tick(()=>g.worker.active.size===0);
  assert.equal(blocked.seen.merge.length,0);
  const rejected = reviewTools({merged:false,reason:'CI_FAILED'}), h = await fixture(t,{dependencies:{reviewImpl:rejected.impl}});
  await h.worker.startJob(reviewJob()); finishReview(h.children[0],'approve'); await tick(()=>h.worker.active.size===0);
  assert.match(h.calls.find(x=>x.args.event==='complete').args.summary,/CI_FAILED/);
});

test('сигнал присутствия уходит сразу при старте и затем по таймеру, без run_id', async t => {
  const f = await fixture(t);
  f.worker.config.presenceMs = 20; f.worker.config.pollMs = 60000;
  f.worker.start();
  await tick(()=>f.calls.filter(x=>x.args?.event==='presence').length>=2);
  const signal = f.calls.find(x=>x.args?.event==='presence');
  assert.equal(signal.name,'agent_worker_update'); assert.equal(signal.args.worker_id,f.worker.workerId);
  assert.equal(signal.args.run_id,undefined); assert.equal(signal.args.lease_token,undefined);
  assert.equal(signal.args.active_runs,0);
});
