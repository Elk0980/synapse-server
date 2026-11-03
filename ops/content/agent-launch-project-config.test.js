'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {assertNoProjectConfig}=require('./agent-launch-project-config');

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-project-policy-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const owner=path.join(root,'owner'),tree=path.join(owner,'trees','task');await fs.mkdir(tree,{recursive:true});
  return {root,owner,tree,ownerHomes:[owner,os.homedir()]};
}

test('project config is rejected without reading, modifying or deleting it',async t=>{
  const f=await fixture(t);await assertNoProjectConfig(f.tree,{ownerHomes:f.ownerHomes});
  const folder=path.join(f.tree,'.codex');await fs.mkdir(folder);
  const file=path.join(folder,'config.toml'),data='default_permissions=":danger-full-access"\n[mcp_servers.synthetic]\ncommand="SAMPLE"\n';
  await fs.writeFile(file,data);
  await assert.rejects(assertNoProjectConfig(f.tree,{ownerHomes:f.ownerHomes}),{code:'PROJECT_CONFIG_UNSUPPORTED'});
  assert.equal(await fs.readFile(file,'utf8'),data);
});

test('ancestor project config is rejected while unused owner global config is preserved',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.owner,'.codex'));
  await fs.writeFile(path.join(f.owner,'.codex','config.toml'),'SAMPLE_OWNER_GLOBAL_CONFIG');
  await assertNoProjectConfig(f.tree,{ownerHomes:f.ownerHomes});
  const parent=path.dirname(f.tree);await fs.mkdir(path.join(parent,'.codex'));
  await fs.writeFile(path.join(parent,'.codex','config.toml'),'SAMPLE_PARENT_EXECUTABLE_CONFIG');
  await assert.rejects(assertNoProjectConfig(f.tree,{ownerHomes:f.ownerHomes}),{code:'PROJECT_CONFIG_UNSUPPORTED'});
});

test('canonical cwd and linked .codex cannot hide project executable config', {skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),actual=path.join(f.root,'actual'),link=path.join(f.root,'link');await fs.mkdir(actual);
  await fs.mkdir(path.join(actual,'.codex'));await fs.writeFile(path.join(actual,'.codex','config.toml'),'SAMPLE');
  await fs.symlink(actual,link,'junction');
  await assert.rejects(assertNoProjectConfig(link,{ownerHomes:f.ownerHomes}),{code:'PROJECT_CONFIG_UNSUPPORTED'});
  await fs.symlink(path.join(actual,'.codex'),path.join(f.tree,'.codex'),'junction');
  await assert.rejects(assertNoProjectConfig(f.tree,{ownerHomes:f.ownerHomes}),{code:'PROJECT_CONFIG_UNSUPPORTED'});
});
