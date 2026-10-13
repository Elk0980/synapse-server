'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {run}=require('./bulk-save.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const siteId='site-44bbe13f1bad5e005b2a';
const database=process.env.DATABASE_PATH||'/data/content.sqlite';
const candidate='/tmp/palitra-main-site';
const planFile='/tmp/palitra-bulk-plan-20261013.json';
const [action,ownerId,storeSha,authSha,metaSha]=process.argv.slice(2);
const fail=message=>{throw new Error(message);};
if(action==='apply') {
  if(fs.lstatSync(planFile).isSymbolicLink())fail('Plan symlink');
  const args=JSON.parse(fs.readFileSync(planFile,'utf8'));
  delete args.check;args.apply=true;run(args);
} else {
  if(!['inspect','prepare'].includes(action))fail('Choose inspect, prepare or apply');
  const db=new DatabaseSync(database,{readOnly:true});
  let owners,current;
  try {
    owners=db.prepare("SELECT id,login,role FROM auth_users WHERE role='owner'").all();
    current=db.prepare(`SELECT s.id,s.company_code,s.publication_status,s.deleted_at,w.current_revision,r.version
      FROM managed_sites s JOIN site_workspaces w ON w.site_id=s.id
      JOIN site_workspace_revisions r ON r.site_id=s.id AND r.revision=w.current_revision WHERE s.id=?`).get(siteId);
  } finally {db.close();}
  const meta=fs.readFileSync(path.join(candidate,'META.json'));
  const hashes={store:hash(fs.readFileSync('/app/site-workspaces.js')),auth:hash(fs.readFileSync('/app/auth-store.js')),meta:hash(meta)};
  if(action==='inspect') {console.log(JSON.stringify({owners,current,hashes}));}
  else {
    if(!/^[1-9][0-9]*$/.test(ownerId||'')||!owners.some(o=>o.id===Number(ownerId)))fail('Existing owner required');
    if(hashes.store!==storeSha||hashes.auth!==authSha||hashes.meta!==metaSha)fail('Reviewed digests differ');
    if(!current||current.version!==248||current.company_code!=='palitra-love'||current.publication_status!=='draft'||current.deleted_at)fail('Fresh target changed');
    const args={check:true,database,'workspace-root':path.join(path.dirname(database),'projects'),'module-dir':'/app',
      'store-sha256':storeSha,'auth-sha256':authSha,'site-id':siteId,company:'palitra-love','owner-id':Number(ownerId),
      'expected-version':248,'expected-revision':current.current_revision,'candidate-dir':candidate,
      meta:path.join(candidate,'META.json'),'meta-sha256':metaSha,'expected-files':44,'expected-changed':40,
      message:'Root: Palitra — рабочее оформление и перенос принятых страниц'};
    run(args);
    fs.writeFileSync(planFile,JSON.stringify(args),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({status:'PLAN_FROZEN',baseRevision:current.current_revision}));
  }
}
