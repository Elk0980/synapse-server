'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
const {publishRun,githubRepo,safePath,publisherEnvironment}=require('./agent-launch-publisher');

async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-publisher-test-'));
  t.after(async()=>{
    const full=path.resolve(dir);
    assert.equal(path.dirname(full),path.resolve(os.tmpdir()));
    assert.ok(path.basename(full).startsWith('agent-publisher-test-'));
    await fs.rm(full,{recursive:true,force:true});
  });
  const repo=path.join(dir,'repo'), worktree=path.join(dir,'worktree');
  await fs.mkdir(repo);
  const git=async(cwd,args)=>(await execute('git',['-C',cwd,...args],{windowsHide:true})).stdout;
  await git(repo,['init','-b','main']);
  await git(repo,['config','user.name','SAMPLE test']);
  await git(repo,['config','user.email','sample@example.invalid']);
  await git(repo,['config','commit.gpgsign','false']);
  await fs.writeFile(path.join(repo,'README.md'),'SAMPLE baseline\n');
  await git(repo,['add','README.md']);
  await git(repo,['commit','-m','SAMPLE baseline']);
  await git(repo,['remote','add','origin','https://github.com/sample-owner/sample-project.git']);
  await git(repo,['update-ref','refs/remotes/origin/main','HEAD']);
  const runId='bb7d7fc7-8fe5-46e4-ae88-e925beed0466', taskId=123;
  const branch=`codex/agent-task-${taskId}-${runId.slice(0,8)}`;
  await git(repo,['worktree','add','-b',branch,worktree,'origin/main']);
  const calls=[];
  let published=false;
  const prUrl='https://github.com/sample-owner/sample-project/pull/5';
  const execImpl=async(file,args,opts)=>{
    calls.push({file,args:[...args],opts});
    if(file==='git'&&args.includes('push'))return {stdout:'',stderr:''};
    if(file==='gh') {
      assert.equal(opts.shell,false);
      assert.equal(opts.windowsHide,true);
      assert.equal(args[0],'pr');
      assert.ok(args.includes('--repo'));
      assert.equal(args[args.indexOf('--repo')+1],'sample-owner/sample-project');
      if(args[1]==='list')return {stdout:JSON.stringify(published?[{url:prUrl}]:[])};
      assert.equal(args[1],'create');
      assert.ok(args.includes('--draft'));
      assert.equal(args[args.indexOf('--base')+1],'main');
      const body=await fs.readFile(args[args.indexOf('--body-file')+1],'utf8');
      assert.ok(!body.includes('PRIVATE INPUT TITLE'));
      published=true;
      return {stdout:prUrl+'\n'};
    }
    return execute(file,args,opts);
  };
  return {dir,repo,worktree,runId,taskId,branch,git,calls,execImpl,prUrl,
    args:{repo,worktree,runId,taskId,branch,title:'PRIVATE INPUT TITLE'}};
}

test('trusted publisher commits a real worktree and creates one draft PR with fixed argv',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.worktree,'README.md'),'SAMPLE changed\n');
  await fs.writeFile(path.join(f.worktree,'feature.js'),'module.exports = 42;\n');
  const first=await publishRun(f.args,{execImpl:f.execImpl,env:{...process.env,GIT_DIR:'wrong',GH_REPO:'foreign/private'}});
  assert.equal(first.pr_url,f.prUrl);
  assert.equal(first.commit.trim(),(await f.git(f.worktree,['rev-parse','HEAD'])).trim());
  assert.equal((await f.git(f.worktree,['status','--porcelain'])).trim(),'');
  const second=await publishRun(f.args,{execImpl:f.execImpl});
  assert.deepEqual(second,first);
  assert.equal(f.calls.filter(call=>call.file==='gh'&&call.args[1]==='create').length,1);
  assert.equal((await f.git(f.worktree,['rev-list','--count','origin/main..HEAD'])).trim(),'1');
  for(const call of f.calls) {
    assert.equal(call.opts.env.GIT_DIR,undefined);
    assert.equal(call.opts.env.GH_REPO,undefined);
    assert.ok(!call.args.includes('merge'));
  }
  const push=f.calls.find(call=>call.file==='git'&&call.args.includes('push'));
  assert.deepEqual(push.args.slice(push.args.indexOf('push')),['push','--set-upstream','origin',`HEAD:refs/heads/${f.branch}`]);
});

for(const [name,content,expected] of [
  ['.env','SAMPLE=value\n','PUBLISH_SECRET_PATH'],
  ['feature.js',`const value = '${'sk-proj-'+'A'.repeat(45)}';\n`,'PUBLISH_SECRET_DETECTED'],
  ['feature.js','-----BEGIN '+'PRIVATE KEY-----\nSAMPLE\n','PUBLISH_SECRET_DETECTED'],
  ['session.json','{}\n','PUBLISH_SECRET_PATH']
]) test(`publisher rejects ${expected} before staging`,async t=>{
  const f=await fixture(t), before=(await f.git(f.worktree,['rev-parse','HEAD'])).trim();
  await fs.writeFile(path.join(f.worktree,name),content);
  await assert.rejects(publishRun(f.args,{execImpl:f.execImpl}),error=>error.code===expected);
  assert.equal((await f.git(f.worktree,['diff','--cached','--name-only'])).trim(),'');
  assert.equal((await f.git(f.worktree,['rev-parse','HEAD'])).trim(),before);
  assert.ok(!f.calls.some(call=>call.file==='gh'||call.args.includes('push')||call.args.includes('add')));
});

test('publisher detects a literal secret removed by a later existing commit',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.worktree,'feature.js'),`const key = '${'ghp_'+'A'.repeat(35)}';\n`);
  await f.git(f.worktree,['add','feature.js']);
  await f.git(f.worktree,['commit','-m','SAMPLE intermediate']);
  await fs.writeFile(path.join(f.worktree,'feature.js'),'module.exports = 1;\n');
  await f.git(f.worktree,['commit','-am','SAMPLE removal']);
  await assert.rejects(publishRun(f.args,{execImpl:f.execImpl}),error=>error.code==='PUBLISH_SECRET_DETECTED');
  assert.ok(!f.calls.some(call=>call.file==='gh'||call.args.includes('push')));
});

test('publisher rejects an intermediate binary blob even after a later commit removes it',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.worktree,'feature.png'),Buffer.from([0,1,2,3,4,5]));
  await f.git(f.worktree,['add','feature.png']);
  await f.git(f.worktree,['commit','-m','SAMPLE intermediate binary']);
  await fs.unlink(path.join(f.worktree,'feature.png'));
  await f.git(f.worktree,['commit','-am','SAMPLE binary removal']);
  assert.equal((await f.git(f.worktree,['status','--porcelain'])).trim(),'');
  const before=(await f.git(f.worktree,['rev-parse','HEAD'])).trim();
  await assert.rejects(publishRun(f.args,{execImpl:f.execImpl}),error=>error.code==='PUBLISH_BINARY_REJECTED');
  assert.equal((await f.git(f.worktree,['rev-parse','HEAD'])).trim(),before);
  assert.equal((await f.git(f.worktree,['diff','--cached','--name-only'])).trim(),'');
  assert.ok(!f.calls.some(call=>call.file==='gh'||call.args.includes('add')||call.args.includes('push')));
});

test('publisher rejects force-staged private handoff map before staging or push',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.worktree,'.gitignore'),'docs/handoff/\ndocs/seed/\n');
  await f.git(f.worktree,['add','.gitignore']);
  await f.git(f.worktree,['commit','-m','SAMPLE private directory rules']);
  await fs.mkdir(path.join(f.worktree,'docs','handoff'),{recursive:true});
  await fs.writeFile(path.join(f.worktree,'docs','handoff','MAP.json'),JSON.stringify({sample:'SAMPLE private project notes'}));
  await f.git(f.worktree,['add','-f','--','docs/handoff/MAP.json']);
  const beforeIndex=await f.git(f.worktree,['ls-files','--stage']), beforeHead=(await f.git(f.worktree,['rev-parse','HEAD'])).trim();
  await assert.rejects(publishRun(f.args,{execImpl:f.execImpl}),error=>error.code==='PUBLISH_SECRET_PATH');
  assert.equal(await f.git(f.worktree,['ls-files','--stage']),beforeIndex);
  assert.equal((await f.git(f.worktree,['rev-parse','HEAD'])).trim(),beforeHead);
  assert.ok(!f.calls.some(call=>call.file==='gh'||call.args.includes('add')||call.args.includes('push')));
});

test('publisher rejects historical private seed data after removal',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.worktree,'.gitignore'),'docs/handoff/\ndocs/seed/\n');
  await f.git(f.worktree,['add','.gitignore']);
  await f.git(f.worktree,['commit','-m','SAMPLE private directory rules']);
  await fs.mkdir(path.join(f.worktree,'docs','seed'),{recursive:true});
  await fs.writeFile(path.join(f.worktree,'docs','seed','pult.json'),JSON.stringify({sample:'SAMPLE private client list without credentials'}));
  await f.git(f.worktree,['add','-f','--','docs/seed/pult.json']);
  await f.git(f.worktree,['commit','-m','SAMPLE intermediate private data']);
  await fs.unlink(path.join(f.worktree,'docs','seed','pult.json'));
  await f.git(f.worktree,['commit','-am','SAMPLE private data removal']);
  const before=(await f.git(f.worktree,['rev-parse','HEAD'])).trim();
  assert.equal((await f.git(f.worktree,['status','--porcelain'])).trim(),'');
  await assert.rejects(publishRun(f.args,{execImpl:f.execImpl}),error=>error.code==='PUBLISH_SECRET_PATH');
  assert.equal((await f.git(f.worktree,['rev-parse','HEAD'])).trim(),before);
  assert.ok(!f.calls.some(call=>call.file==='gh'||call.args.includes('add')||call.args.includes('push')));
});

test('publisher rejects repository private configuration prefixes',()=>{
  for(const name of ['docs/handoff/MAP.json','DOCS/SEED/pult.json','.claude/settings.local.json',
    '.claude/projects/local.json','.qwen/settings.json','.agents/sessions/run.json']) {
    assert.throws(()=>safePath(name),error=>error.code==='PUBLISH_SECRET_PATH');
  }
  assert.equal(safePath('docs/public-guide.md'),'docs/public-guide.md');
});

test('publisher rejects a different push URL before any mutation',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.worktree,'README.md'),'SAMPLE change\n');
  await f.git(f.repo,['config','remote.origin.pushurl','https://github.com/foreign-owner/foreign-project.git']);
  await assert.rejects(publishRun(f.args,{execImpl:f.execImpl}),error=>error.code==='PUBLISH_REMOTE_REJECTED');
  assert.ok(!f.calls.some(call=>call.file==='gh'||call.args.includes('add')||call.args.includes('push')));
});

test('publisher refuses the wrong branch and does not run configured hooks',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.worktree,'README.md'),'SAMPLE change\n');
  const hooks=path.join(f.dir,'untrusted-hooks');
  await fs.mkdir(hooks);
  const marker=path.join(f.dir,'HOOK_EXECUTED');
  await fs.writeFile(path.join(hooks,'pre-commit'),`#!/bin/sh\nprintf unsafe > '${marker.replaceAll('\\','/')}'\n`,{mode:0o700});
  await f.git(f.repo,['config','core.hooksPath',hooks]);
  await publishRun(f.args,{execImpl:f.execImpl});
  await assert.rejects(fs.stat(marker),error=>error.code==='ENOENT');
  await assert.rejects(publishRun({...f.args,branch:'main'},{execImpl:f.execImpl}),error=>error.code==='PUBLISH_ARGUMENTS_REJECTED');
});

test('publisher refuses active clean filters without executing them',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.worktree,'feature.js'),'module.exports = 1;\n');
  await fs.writeFile(path.join(f.repo,'.git','info','attributes'),'*.js filter=untrusted\n');
  await f.git(f.repo,['config','filter.untrusted.clean','exit 99']);
  await assert.rejects(publishRun(f.args,{execImpl:f.execImpl}),error=>error.code==='PUBLISH_FILTER_REJECTED');
  assert.ok(!f.calls.some(call=>call.args.includes('add')||call.args.includes('push')));
});

test('publisher also refuses tracked environment files before staging their changes',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.worktree,'.env.local'),'SAMPLE=baseline\n');
  await f.git(f.worktree,['add','.env.local']);
  await f.git(f.worktree,['commit','-m','SAMPLE existing tracked environment']);
  await fs.writeFile(path.join(f.worktree,'.env.local'),'SAMPLE=changed\n');
  const before=(await f.git(f.worktree,['rev-parse','HEAD'])).trim();
  await assert.rejects(publishRun(f.args,{execImpl:f.execImpl}),error=>error.code==='PUBLISH_SECRET_PATH');
  assert.equal((await f.git(f.worktree,['diff','--cached','--name-only'])).trim(),'');
  assert.equal((await f.git(f.worktree,['rev-parse','HEAD'])).trim(),before);
});

test('publisher refuses staged gitlinks and preserves the original index',async t=>{
  const f=await fixture(t), commit=(await f.git(f.worktree,['rev-parse','HEAD'])).trim();
  await f.git(f.worktree,['update-index','--add','--cacheinfo',`160000,${commit},dependency`]);
  const before=await f.git(f.worktree,['ls-files','--stage']);
  await assert.rejects(publishRun(f.args,{execImpl:f.execImpl}),error=>error.code==='PUBLISH_FILE_REJECTED');
  assert.equal(await f.git(f.worktree,['ls-files','--stage']),before);
  assert.ok(!f.calls.some(call=>call.file==='gh'||call.args.includes('push')));
});

test('publisher refuses a different repository even when origin and branch match',async t=>{
  const f=await fixture(t), other=await fixture(t);
  await fs.writeFile(path.join(other.worktree,'README.md'),'SAMPLE changed\n');
  await assert.rejects(publishRun({...f.args,worktree:other.worktree},{execImpl:f.execImpl}),error=>error.code==='PUBLISH_WORKTREE_REJECTED');
  assert.ok(!f.calls.some(call=>call.file==='gh'||call.args.includes('add')||call.args.includes('push')));
});

test('publisher cancellation reaches native commands before staging',async t=>{
  const f=await fixture(t), controller=new AbortController();
  await fs.writeFile(path.join(f.worktree,'README.md'),'SAMPLE changed\n');
  controller.abort();
  await assert.rejects(publishRun(f.args,{execImpl:f.execImpl,signal:controller.signal}),error=>error.code==='PUBLISH_FAILED');
  assert.equal((await f.git(f.worktree,['diff','--cached','--name-only'])).trim(),'');
  assert.ok(!f.calls.some(call=>call.file==='gh'||call.args.includes('add')||call.args.includes('push')));
});

test('publisher repository parsing and environment exclude credentials in remote URLs',()=>{
  assert.equal(githubRepo('git@github.com:sample-owner/sample-project.git'),'sample-owner/sample-project');
  assert.throws(()=>githubRepo('https://token@github.com/sample-owner/sample-project.git'),error=>error.code==='PUBLISH_REMOTE_REJECTED');
  const env=publisherEnvironment({PATH:'sample',GIT_SSH_COMMAND:'sample',GH_HOST:'foreign',CRM_API_KEY:'sample',TASKS_MCP_ENDPOINT:'sample'});
  assert.deepEqual(env,{PATH:'sample'});
});
