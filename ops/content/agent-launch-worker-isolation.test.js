'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const execute=require('node:util').promisify(require('node:child_process').execFile);
const {permissionProfile,credentialDenyPaths,verifyRuntimeIsolation}=require('./agent-launch-worker-isolation');
const {childEnvironment,loadConfig}=require('./agent-launch-local-worker');
async function fixture(t,{native=false}={}){
 const baseRoot=native?path.dirname(path.resolve(__dirname,'../..')):os.tmpdir();
 const base=await fs.mkdtemp(path.join(baseRoot,'agent-isolation-test-'));
 const config={worktrees:path.join(base,'trees'),stateDir:path.join(base,'state'),repo:path.join(base,'repo'),
  sourceCodexHome:path.join(base,'owner','.codex'),ownerHome:path.join(base,'owner'),
  ownerHomes:[path.join(base,'owner'),os.homedir()],
  ownerAppData:path.join(base,'owner','AppData','Roaming'),ownerLocalAppData:path.join(base,'owner','AppData','Local'),
  codexBin:process.env.CODEX_APP_RUNTIME_CLI_PATH||process.execPath,windowsSandbox:'mxc'};
 await Promise.all([config.repo,config.ownerHome,config.sourceCodexHome].map(p=>fs.mkdir(p,{recursive:true})));
 t.after(async()=>{assert.equal(path.dirname(path.resolve(base)),path.resolve(baseRoot));await fs.rm(base,{recursive:true,force:true});});
 return{base,config};
}
const baseline={reads:[true,true,true,true,true],ownWrite:true,outsideWrite:true,loopback:true,external:true,homeIsEmpty:true,userProfileIsEmpty:true};
const isolated={...baseline,reads:[false,false,false,false,false],outsideWrite:false,loopback:false,external:false};

test('custom profile закрывает source/own/sibling credentials и не смешивается с legacy sandbox',async t=>{
 const {config}=await fixture(t);config.ghExecutables=[path.join(path.dirname(config.ownerHome),'gh.exe')];
 const p=permissionProfile(config).join('\n'),denied=credentialDenyPaths(config);
 assert.ok(p.includes('default_permissions = "synapse_agent"'));assert.ok(p.includes('sandbox = "mxc"'));assert.ok(p.includes('enabled = false'));
 assert.ok(!p.includes('sandbox_mode'));assert.ok(!p.includes('sandbox_workspace_write'));
 for(const dir of [config.stateDir,config.sourceCodexHome,config.repo,config.ownerHome,config.ghExecutables[0]]){
  assert.ok(denied.includes(dir));assert.ok(p.includes(JSON.stringify(dir)+' = "deny"'));
 }
 const e=childEnvironment({PATH:['C:/Windows','C:/Program Files/GitHub CLI','C:/Program Files/Git/cmd'].join(path.delimiter),HOME:config.ownerHome,GH_TOKEN:'SYNTHETIC_OWNER_TOKEN'},path.join(config.stateDir,'own-run'),path.join(config.worktrees,'empty'));
 assert.ok(!e.PATH.includes('GitHub CLI'));assert.ok(!JSON.stringify(e).includes('SYNTHETIC_OWNER_TOKEN'));assert.notEqual(e.HOME,config.ownerHome);
 assert.throws(()=>permissionProfile({...config,windowsSandbox:'unelevated'}),{code:'READ_ISOLATION_UNAVAILABLE'});
});

test('guard требует успешный direct baseline и реальные read/network/write границы, не доверяя только config', {skip:process.platform!=='win32'},async t=>{
 const {config}=await fixture(t);let calls=0;
 const fake=async(file,args,options)=>{calls++;assert.equal(options.shell,false);return{stdout:args.includes('-NoProfile')?'SHELL_PROBE_OK':JSON.stringify(calls===1?baseline:isolated)};};
 const proof=await verifyRuntimeIsolation(config,{childEnvironment,execImpl:fake});
 assert.deepEqual(proof.evidence,{syntheticReadsDenied:5,outsideWriteDenied:true,loopbackDenied:true,externalDenied:true,directBaselinePassed:true,shellReady:true});assert.equal(calls,3);
 assert.deepEqual(await fs.readdir(config.worktrees),[],'все guard fixtures убраны');
 for(const [first,second,reason]of [
  [{...baseline,external:false},isolated,'BASELINE_UNAVAILABLE'],
  [baseline,{...isolated,reads:[false,false,true,false,false]},'BOUNDARY_CHECK_FAILED'],
  [baseline,{...isolated,loopback:true},'BOUNDARY_CHECK_FAILED'],
  [baseline,{...isolated,external:true},'BOUNDARY_CHECK_FAILED'],
  [baseline,{...isolated,outsideWrite:true},'BOUNDARY_CHECK_FAILED'],
  [baseline,{...isolated,ownWrite:false},'BOUNDARY_CHECK_FAILED']
 ]){let n=0;await assert.rejects(verifyRuntimeIsolation(config,{childEnvironment,execImpl:async()=>({stdout:JSON.stringify(++n===1?first:second)})}),e=>e.code==='READ_ISOLATION_UNAVAILABLE'&&e.reason===reason);}
});

test('native Windows MXC: synthetic credential reads и TCP запрещены, свой workspace доступен',
 {skip:process.platform!=='win32'||!process.env.CODEX_APP_RUNTIME_CLI_PATH||!process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY,timeout:60000},async t=>{
  const {config}=await fixture(t,{native:true});
  // Только metadata настоящих credential-каталогов для deny; читает probe лишь synthetic canaries.
  const native=loadConfig({...process.env,TASKS_MCP_ENDPOINT:'https://tasks.example.test/mcp/'+'f'.repeat(32),
    TASKS_AGENT_REPO:config.repo,TASKS_AGENT_WORKTREE_DIR:config.worktrees,TASKS_AGENT_STATE_DIR:config.stateDir,TASKS_AGENT_WINDOWS_SANDBOX:'mxc'});
  const sourceEnv=path.join(config.repo,'.env'),canary='SYNTHETIC_ORIGINAL_REPO_ENV_MUST_REMAIN_PRIVATE';await fs.writeFile(sourceEnv,canary);
  const proof=await verifyRuntimeIsolation(native,{childEnvironment});
  assert.equal(proof.readIsolation,true);assert.equal(proof.networkIsolation,true);assert.equal(proof.workspaceWrite,true);
  assert.equal(proof.evidence.syntheticReadsDenied,5);assert.equal(proof.evidence.directBaselinePassed,true);
  assert.equal(proof.evidence.shellReady,true);
  assert.deepEqual(await fs.readdir(config.worktrees),[]);
  assert.ok(native.credentialReadDenyRoots.includes(await fs.realpath(config.repo)));
  const home=path.join(native.stateDir,'env-test-home'),workspace=path.join(native.worktrees,'env-test-workspace');
  await fs.mkdir(home,{recursive:true});await fs.mkdir(workspace,{recursive:true});
  const env=childEnvironment(process.env,home,path.join(native.worktrees,'env-test-empty-home'));
  for(const dir of[env.HOME,env.APPDATA,env.LOCALAPPDATA,env.TEMP])await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(home,'config.toml'),['approval_policy="never"',...permissionProfile(native),''].join('\n'));
  const script=path.join(workspace,'read-source-env.js');await fs.writeFile(script,"let readable=false;try{require('node:fs').readFileSync(process.argv[2]);readable=true;}catch{};console.log(JSON.stringify({readable}));");
  const response=await execute(native.codexBin,['sandbox','-C',workspace,'-P','synapse_agent','--include-managed-config','--',process.execPath,script,sourceEnv],
    {cwd:workspace,env,windowsHide:true,shell:false,timeout:30000,maxBuffer:1024*1024});
  assert.deepEqual(JSON.parse(response.stdout.trim()),{readable:false},'ignored .env исходного checkout не читается');
  assert.equal(await fs.readFile(sourceEnv,'utf8'),canary,'исходный synthetic .env сохранён');
 });

test('shell runtime grant внутри credential-папки отклоняется до выполнения команд', {skip:process.platform!=='win32'},async t=>{
 const {config}=await fixture(t),shellDir=path.join(config.ownerHome,'.ssh');await fs.mkdir(shellDir);await fs.writeFile(path.join(shellDir,'pwsh.exe'),'SYNTHETIC_EXECUTABLE_NOT_RUN');let execs=0;
 await assert.rejects(verifyRuntimeIsolation(config,{childEnvironment,env:{PATH:shellDir},execImpl:async()=>{execs++;throw Error('не должен вызываться');}}),e=>e.code==='READ_ISOLATION_UNAVAILABLE'&&e.reason==='RUNTIME_GRANT_UNSAFE');
 assert.equal(execs,0);
});

test('physical state junction в checkout отклоняется до запуска sandbox и authcopy', {skip:process.platform!=='win32'},async t=>{
 const {config}=await fixture(t),target=path.join(config.repo,'auth-leak');await fs.mkdir(target);
 await fs.symlink(target,config.stateDir,'junction');let execs=0;
 await assert.rejects(verifyRuntimeIsolation(config,{childEnvironment,execImpl:async()=>{execs++;throw Error('не должен запускаться');}}),e=>e.code==='READ_ISOLATION_UNAVAILABLE'&&e.reason==='DIRECTORIES_OVERLAP');
 assert.equal(execs,0);assert.deepEqual(await fs.readdir(target),[]);
});

test('source auth и SSH junction вне ownerHOME получают canonical deny targets', {skip:process.platform!=='win32'},async t=>{
 const {config,base}=await fixture(t),source=path.join(base,'outside-auth'),ssh=path.join(base,'outside-ssh');
 await fs.mkdir(source);await fs.mkdir(ssh);await fs.rmdir(config.sourceCodexHome);
 await fs.symlink(source,config.sourceCodexHome,'junction');await fs.symlink(ssh,path.join(config.ownerHome,'.ssh'),'junction');
 let n=0;await verifyRuntimeIsolation(config,{childEnvironment,execImpl:async(file,args)=>({stdout:args.includes('-NoProfile')?'SHELL_PROBE_OK':JSON.stringify(++n===1?baseline:isolated)})});
 assert.equal(config.sourceCodexHome,await fs.realpath(source));
 assert.ok(config.credentialReadDenyRoots.includes(await fs.realpath(source)));assert.ok(config.credentialReadDenyRoots.includes(await fs.realpath(ssh)));
});

test('loadConfig предпочитает установленный app CLI; unsupported isolation не включает обход',()=>{
 const root=path.resolve(os.tmpdir(),'agent-config-isolation');
 const c=loadConfig({TASKS_MCP_ENDPOINT:'https://tasks.example.test/mcp/'+'f'.repeat(32),TASKS_AGENT_REPO:path.join(root,'repo'),
  TASKS_AGENT_WORKTREE_DIR:path.join(root,'trees'),TASKS_AGENT_STATE_DIR:path.join(root,'state'),CODEX_APP_RUNTIME_CLI_PATH:path.join(root,'codex.exe')});
 if(process.platform==='win32')assert.equal(c.codexBin,path.join(root,'codex.exe'));
 assert.equal(c.windowsSandbox,'mxc');
});
