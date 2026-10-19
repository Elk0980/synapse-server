'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {validPath}=require('/app/site-workspaces.js');
const id='site-44bbe13f1bad5e005b2a';
const dbPath=process.env.DATABASE_PATH||'/data/content.sqlite';
const db=new DatabaseSync(dbPath,{readOnly:true});
try {
 const w=db.prepare('SELECT m.id,m.company_code,w.current_revision FROM managed_sites m JOIN site_workspaces w ON w.site_id=m.id WHERE m.id=?').get(id);
 if(!w||w.company_code!=='palitra-love')throw Error('EXACT_PALITRA_REQUIRED');
 const r=db.prepare('SELECT version,manifest_json FROM site_workspace_revisions WHERE site_id=? AND revision=?').get(id,w.current_revision);
 const manifest=JSON.parse(r.manifest_json),root=path.join(path.dirname(dbPath),'projects',w.company_code,'sites',id,'versions',w.current_revision);
 const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
 const mismatches=[];let checked=0;
 for(const [name,pin] of Object.entries(manifest)) {
  if(!validPath(name))throw Error('INVALID_MANIFEST_PATH');
  const target=path.join(root,name);if(!target.startsWith(root+'/'))throw Error('PATH_BOUNDARY');
  if(fs.lstatSync(target).isSymbolicLink())throw Error('SYMLINK_REFUSED');
  const bytes=fs.readFileSync(target);checked++;
  if(sha(bytes)!==pin.sha256||bytes.length!==pin.bytes)mismatches.push({name,expected:pin.sha256,actual:sha(bytes),bytes:bytes.length});
 }
 console.log(JSON.stringify({status:'READONLY_SITE_INTEGRITY',id,company:w.company_code,version:r.version,revision:w.current_revision,root,checked,mismatches,dbWrites:0,siteWrites:0}));
} finally {db.close();}
