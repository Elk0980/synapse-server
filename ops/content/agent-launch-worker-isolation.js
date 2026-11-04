'use strict';

// Штатная Windows MXC проверяется без модели, подписки и настоящих секретов.
// Read-deny обязательно: unelevated не считается допустимой заменой.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execute = promisify(execFile);
const fail = reason => { throw Object.assign(new Error('READ_ISOLATION_UNAVAILABLE'),{code:'READ_ISOLATION_UNAVAILABLE',reason}); };
const PROFILE = 'synapse_agent';
const within = (root,target) => {const r=path.relative(root,target);return r && r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};

function credentialDenyPaths(config) {
  const homes = config.ownerHomes || [config.ownerHome];
  const values = config.credentialReadDenyRoots || [config.stateDir,config.sourceCodexHome,config.repo,...homes,config.ownerGhConfigDir,...(config.ghExecutables || [])];
  return [...new Set(values.filter(p=>typeof p==='string'&&path.isAbsolute(p)).map(p=>path.resolve(p)))];
}

function permissionProfile(config, {extraDenied = []} = {}) {
  if (!['mxc','elevated'].includes(config.windowsSandbox)) fail('IMPLEMENTATION_UNSUPPORTED');
  const denied=[...new Set([...credentialDenyPaths(config),...extraDenied.map(p=>path.resolve(p))])];
  if (!config.stateDir || !config.sourceCodexHome || !config.ownerHome || !denied.length) fail('CREDENTIAL_BOUNDARIES_MISSING');
  return [
    `default_permissions = "${PROFILE}"`,
    '[windows]',`sandbox = ${JSON.stringify(config.windowsSandbox)}`,
    `[permissions.${PROFILE}]`,'extends = ":workspace"',
    `[permissions.${PROFILE}.filesystem]`,'":root" = "read"',
    ...denied.map(p=>`${JSON.stringify(p)} = "deny"`),
    ...(config.runtimeReadRoots||[path.dirname(process.execPath),...(path.isAbsolute(config.codexBin||'')?[path.dirname(config.codexBin)]:[])]).map(p=>`${JSON.stringify(p)} = "read"`),
    `[permissions.${PROFILE}.filesystem.":workspace_roots"]`,'"." = "write"',
    `[permissions.${PROFILE}.network]`,'enabled = false'
  ];
}

async function prepareBoundaryConfig(config) {
  // Только свои пустые state/worktrees. Каталоги владельца не создаём и ACL не меняем.
  await fs.mkdir(config.stateDir,{recursive:true,mode:0o700});
  await fs.mkdir(config.worktrees,{recursive:true});
  const homes=[...new Set(config.ownerHomes||[config.ownerHome])],roots=[];
  for(const home of homes){try{if(!(await fs.stat(home)).isDirectory())fail('OWNER_HOME_UNAVAILABLE');roots.push(await fs.realpath(home));}catch{fail('OWNER_HOME_UNAVAILABLE');}}
  let source;
  try {if(!(await fs.stat(config.sourceCodexHome)).isDirectory())fail('SOURCE_HOME_UNAVAILABLE');source=await fs.realpath(config.sourceCodexHome);}catch{fail('SOURCE_HOME_UNAVAILABLE');}
  const state=await fs.realpath(config.stateDir),trees=await fs.realpath(config.worktrees);
  if(state===trees||within(state,trees)||within(trees,state))fail('DIRECTORIES_OVERLAP');
  let repo;try{repo=await fs.realpath(config.repo);}catch{fail('REPO_UNAVAILABLE');}
  if(repo===state||within(repo,state)||repo===trees||within(repo,trees)||within(state,repo)||within(trees,repo))fail('DIRECTORIES_OVERLAP');
  roots.push(state,source,repo);
  const existingCredentials=[...homes.flatMap(home=>['.codex','.ssh','.config/gh','.git-credentials','.aws'].map(p=>path.join(home,p))),
    ...(config.ownerAppData?['GitHub CLI','gh'].map(p=>path.join(config.ownerAppData,p)):[]),
    ...(config.ownerLocalAppData?['GitHub CLI','gh'].map(p=>path.join(config.ownerLocalAppData,p)):[])];
  for(const candidate of existingCredentials){try{roots.push(await fs.realpath(candidate));}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')fail('CREDENTIAL_PATH_UNAVAILABLE');}}
  for(const extra of [config.ownerGhConfigDir,...(config.ghExecutables||[])].filter(Boolean)){
    try{roots.push(await fs.realpath(extra));}catch{fail('CREDENTIAL_PATH_UNAVAILABLE');}
  }
  const runtimeDirs=[...new Set([await fs.realpath(path.dirname(process.execPath)),await fs.realpath(path.dirname(config.codexBin)),
    ...await Promise.all((config.shellExecutables||[]).map(file=>fs.realpath(path.dirname(file))))])];
  const credentials=[state,source,repo,...homes.flatMap(home=>['.codex','.ssh','.config/gh','.aws'].map(p=>path.join(home,p))),
    ...(config.ownerAppData?['GitHub CLI','gh'].map(p=>path.join(config.ownerAppData,p)):[]),
    ...(config.ownerLocalAppData?['GitHub CLI','gh'].map(p=>path.join(config.ownerLocalAppData,p)):[]),config.ownerGhConfigDir].filter(Boolean);
  for(const dir of runtimeDirs){
    if(dir===path.parse(dir).root||homes.some(home=>path.resolve(home)===dir)||credentials.some(credential=>dir===credential||within(dir,credential)||within(credential,dir)))fail('RUNTIME_GRANT_UNSAFE');
  }
  config.stateDir=state;config.worktrees=trees;config.repo=repo;config.sourceCodexHome=source;
  config.credentialReadDenyRoots=[...new Set(roots)];config.runtimeReadRoots=runtimeDirs;
}

async function findGhExecutables(env) {
  const source=Object.entries(env).find(([key])=>key.toUpperCase()==='PATH')?.[1]||'';
  const found=[];
  for (const folder of source.split(path.delimiter).filter(Boolean)) {
    const file=path.join(folder,process.platform==='win32'?'gh.exe':'gh');
    try {if((await fs.stat(file)).isFile())found.push(await fs.realpath(file));}catch{}
  }
  return [...new Set(found)];
}

async function findShellExecutables(env) {
  const source=Object.entries(env).find(([key])=>key.toUpperCase()==='PATH')?.[1]||'';
  for(const name of ['pwsh.exe','powershell.exe'])for(const folder of source.split(path.delimiter).filter(folder=>folder&&path.isAbsolute(folder))){
    try{const file=path.join(folder,name);if((await fs.stat(file)).isFile())return[await fs.realpath(file)];}catch{}
  }
  fail('SHELL_RUNTIME_UNAVAILABLE');
}

function command(bin,args) {return /\.m?js$/i.test(bin)?{file:process.execPath,args:[bin,...args]}:{file:bin,args};}
function parseProbe(stdout) {
  try {
    const lines=String(stdout).trim().split(/\r?\n/), result=JSON.parse(lines.at(-1));
    if(!result||!Array.isArray(result.reads)||result.reads.length!==5||result.reads.some(v=>typeof v!=='boolean')||
      ['ownWrite','outsideWrite','loopback','external','homeIsEmpty','userProfileIsEmpty'].some(k=>typeof result[k]!=='boolean'))fail('PROBE_RESULT_INVALID');
    return result;
  }catch{fail('PROBE_RESULT_INVALID');}
}

async function verifyRuntimeIsolation(config,{env=process.env,execImpl=execute,childEnvironment,
  checkProjectConfig=(cwd,options)=>require('./agent-launch-project-config').assertNoProjectConfig(cwd,options)}={}) {
  if(process.platform!=='win32'||!['mxc','elevated'].includes(config.windowsSandbox)||typeof childEnvironment!=='function')fail('PLATFORM_UNVERIFIED');
  if(config.windowsSandbox!=='mxc')fail('ELEVATED_REQUIRES_SEPARATE_PROVISIONING');
  if(!path.isAbsolute(config.codexBin||''))fail('CLI_NOT_EXPLICIT');
  let base,server;
  try {
    config.shellExecutables=await findShellExecutables(env);
    await prepareBoundaryConfig(config);
    base=await fs.mkdtemp(path.join(config.worktrees,'.agent-isolation-'));
    const workspace=path.join(base,'workspace'),privateDir=path.join(base,'private'),emptyHome=path.join(base,'empty-home'),codexHome=path.join(base,'codex-home');
    await Promise.all([workspace,privateDir,emptyHome,codexHome].map(p=>fs.mkdir(p,{recursive:true,mode:0o700})));
    const protectedPaths=['owner/.codex/auth.json','state/run/auth.json','state/sibling/auth.json','owner/.ssh/id_ed25519','owner/gh/hosts.yml'].map(p=>path.join(privateDir,p));
    for(const file of protectedPaths){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'SYNTHETIC_ISOLATION_CANARY',{mode:0o600});}
    server=net.createServer(socket=>socket.end());await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const probePath=path.join(workspace,'probe.js'),outside=path.join(privateDir,'outside-write.txt'),port=server.address().port;
    await fs.writeFile(probePath,`'use strict';const fs=require('node:fs'),net=require('node:net');
const reads=${JSON.stringify(protectedPaths)}.map(p=>{try{fs.readFileSync(p);return true;}catch{return false;}});
let ownWrite=false,outsideWrite=false;try{fs.writeFileSync('own-write.txt','SAMPLE');ownWrite=true;}catch{}
try{fs.writeFileSync(${JSON.stringify(outside)},'SAMPLE');outsideWrite=true;}catch{}
const connect=(host,port)=>new Promise(resolve=>{const s=net.connect({host,port});let done=false;const end=v=>{if(done)return;done=true;s.destroy();resolve(v);};s.setTimeout(2500,()=>end(false));s.on('connect',()=>end(true));s.on('error',()=>end(false));});
(async()=>console.log(JSON.stringify({reads,ownWrite,outsideWrite,loopback:await connect('127.0.0.1',${port}),external:await connect('1.1.1.1',443),homeIsEmpty:process.env.HOME===${JSON.stringify(emptyHome)},userProfileIsEmpty:process.env.USERPROFILE===${JSON.stringify(emptyHome)}})))();\n`);
    const childEnv=childEnvironment(env,codexHome,emptyHome);
    for(const dir of [childEnv.HOME,childEnv.APPDATA,childEnv.LOCALAPPDATA,childEnv.TEMP])await fs.mkdir(dir,{recursive:true,mode:0o700});
    const options={cwd:workspace,env:childEnv,shell:false,windowsHide:true,timeout:30000,maxBuffer:256*1024};
    const baseline=parseProbe((await execImpl(process.execPath,[probePath],options)).stdout);
    if(!baseline.reads.every(Boolean)||!baseline.ownWrite||!baseline.outsideWrite||!baseline.loopback||!baseline.external||!baseline.homeIsEmpty||!baseline.userProfileIsEmpty)fail('BASELINE_UNAVAILABLE');
    // Только synthetic canaries: реальный auth/SSH/gh не читается и не копируется.
    await checkProjectConfig(workspace,{ownerHomes:config.ownerHomes||[config.ownerHome]});
    await fs.writeFile(path.join(codexHome,'config.toml'),['approval_policy = "never"',...permissionProfile(config,{extraDenied:[privateDir,codexHome]}),''].join('\n'),{mode:0o600});
    const selected=command(config.codexBin,['sandbox','-C',workspace,'-P',PROFILE,'--include-managed-config','--',process.execPath,probePath]);
    const isolated=parseProbe((await execImpl(selected.file,selected.args,options)).stdout);
    if(isolated.reads.some(Boolean)||!isolated.ownWrite||isolated.outsideWrite||isolated.loopback||isolated.external||!isolated.homeIsEmpty||!isolated.userProfileIsEmpty)fail('BOUNDARY_CHECK_FAILED');
    const shellCommand="Set-Content -LiteralPath 'shell-write-probe.txt' -Value 'SAMPLE' -NoNewline;if((Get-Content -LiteralPath 'shell-write-probe.txt' -Raw) -ne 'SAMPLE'){exit 7};Write-Output SHELL_PROBE_OK";
    const shell=command(config.codexBin,['sandbox','-C',workspace,'-P',PROFILE,'--include-managed-config','--',config.shellExecutables[0],
      '-NoLogo','-NoProfile','-NonInteractive','-Command',shellCommand]);
    if(String((await execImpl(shell.file,shell.args,options)).stdout).trim().split(/\r?\n/).at(-1)!=='SHELL_PROBE_OK')fail('SHELL_RUNTIME_FAILED');
    return {implementation:config.windowsSandbox,readIsolation:true,networkIsolation:true,workspaceWrite:true,
      evidence:{syntheticReadsDenied:5,outsideWriteDenied:true,loopbackDenied:true,externalDenied:true,directBaselinePassed:true,shellReady:true}};
  }catch(e){if(e.code==='READ_ISOLATION_UNAVAILABLE')throw e;fail('SANDBOX_COMMAND_FAILED');}
  finally {
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    if(base){const root=await fs.realpath(config.worktrees),target=await fs.realpath(base);if(!within(root,target)||path.dirname(target)!==root)fail('CLEANUP_PATH_INVALID');await fs.rm(target,{recursive:true,force:true});}
  }
}

module.exports={PROFILE,credentialDenyPaths,permissionProfile,findGhExecutables,findShellExecutables,verifyRuntimeIsolation};
