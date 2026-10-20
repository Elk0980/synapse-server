'use strict';
// One read-only recipe for Root's initial proof and every R7C managed guard.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const SITE='site-44bbe13f1bad5e005b2a',COMPANY='palitra-love';
const HOST='/var/lib/docker/volumes/synapse_content_data/_data';
const PREFIX='/data/projects/'+COMPANY+'/sites/'+SITE+'/versions/';
const PRICE='79d62dd78fc00347758c248a2b733e407bdacccf6094fe0a8f3e69f01c7a5943';
const PRICE_BYTES=94994,STORED_PRICE='data/price.json',PRICE_KEY='palitra/price';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const need=(ok,code)=>{if(!ok)throw new Error(code);};
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
function relative(name){return typeof name==='string'&&name.length>0&&name.length<1024&&!/[\\:\x00-\x1f]/.test(name)&&!name.startsWith('/')&&name.split('/').every(x=>x&&x!=='.'&&x!=='..');}
function directory(p){const s=fs.lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink()&&fs.realpathSync(p)===p,'EXACT_MANAGED_DIRECTORY_REQUIRED');return {uid:s.uid,gid:s.gid,mode:s.mode&511};}
function inventory(root,manifest){
  const files={},dirs={'.':directory(root)};
  function walk(folder){for(const name of fs.readdirSync(folder).sort()){
    const p=path.posix.join(folder,name),rel=p.slice(root.length+1),s=fs.lstatSync(p);
    need(relative(rel)&&!s.isSymbolicLink()&&fs.realpathSync(p)===p,'MANAGED_ALIAS_REFUSED');
    if(s.isDirectory()){dirs[rel]=directory(p);walk(p);continue;}
    need(s.isFile()&&s.nlink===1&&s.size<=32*1024*1024&&(s.mode&0o7000)===0,'MANAGED_REGULAR_SINGLE_LINK_REQUIRED');
    const bytes=fs.readFileSync(p);need(bytes.length===s.size,'MANAGED_FILE_CHANGED_DURING_READ');
    files[rel]={sha256:hash(bytes),bytes:bytes.length,uid:s.uid,gid:s.gid,mode:s.mode&511,nlink:s.nlink,regular:true,canonical:true};
  }}
  walk(root);need(Object.keys(files).length===140&&Object.keys(manifest).length===140,'EXACT_MANAGED_140_REQUIRED');
  need(canonical(Object.keys(files).sort())===canonical(Object.keys(manifest).sort()),'EXACT_MANAGED_FILE_SET_REQUIRED');
  const mismatches=[];
  for(const name of Object.keys(manifest).sort()){
    const wanted=manifest[name],actual=files[name];
    need(relative(name)&&wanted&&typeof wanted==='object'&&!Array.isArray(wanted)&&/^[a-f0-9]{64}$/.test(wanted.sha256)&&Number.isSafeInteger(wanted.bytes)&&wanted.bytes>=0,'EXACT_STORED_MANIFEST_REQUIRED');
    if(wanted.sha256!==actual.sha256||wanted.bytes!==actual.bytes)mismatches.push({path:name,expectedSha256:wanted.sha256,actualSha256:actual.sha256,expectedBytes:wanted.bytes,actualBytes:actual.bytes});
  }
  const pricePath=STORED_PRICE;need(files[pricePath],'EXACT_STORED_PRICE_PATH_REQUIRED');
  const selected={};for(const name of ['dostavka-i-oplata/index.html','assets/order.js','assets/storefront.js',pricePath]){need(files[name],'MANAGED_SELECTED_FILE_MISSING');selected[name]=files[name];}
  return {rootFacts:dirs['.'],fileCount:140,factsSha256:hash(canonical(files)),directoriesSha256:hash(canonical(dirs)),mismatches,pricePath,selected,files,directories:dirs,manifest};
}
function workspace(db){const r=db.prepare('SELECT m.id,m.company_code,m.publication_status,w.current_revision FROM managed_sites m JOIN site_workspaces w ON w.site_id=m.id WHERE m.id=?').get(SITE);need(r&&r.id===SITE&&r.company_code===COMPANY&&/^[a-f0-9]{64}$/.test(r.current_revision),'EXACT_MANAGED_WORKSPACE_REQUIRED');return {...r};}
function revision(db,id){const r=db.prepare('SELECT version,manifest_json FROM site_workspace_revisions WHERE site_id=? AND revision=?').get(SITE,id);need(r&&Number.isSafeInteger(r.version)&&r.version>0&&typeof r.manifest_json==='string'&&Buffer.byteLength(r.manifest_json)<=1024*1024,'EXACT_STORED_REVISION_REQUIRED');const manifest=JSON.parse(r.manifest_json);need(manifest&&typeof manifest==='object'&&!Array.isArray(manifest),'EXACT_MANIFEST_OBJECT_REQUIRED');return {version:r.version,manifestSha256:hash(r.manifest_json),manifestBytes:Buffer.byteLength(r.manifest_json),manifest};}
function documentPrice(db){
  const r=db.prepare('SELECT id,version,body FROM documents WHERE key=? ORDER BY version DESC LIMIT 1').get(PRICE_KEY);
  need(r&&Number.isSafeInteger(r.id)&&r.id>0&&Number.isSafeInteger(r.version)&&r.version>0&&typeof r.body==='string','EXACT_API_PRICE_DOCUMENT_REQUIRED');
  const body=Buffer.from(r.body,'utf8');need(body.length===PRICE_BYTES&&hash(body)===PRICE,'EXACT_API_PRICE_PIN_REQUIRED');
  return {key:PRICE_KEY,id:r.id,version:r.version,sha256:PRICE,bytes:body.length};
}
function probe(historicalRoot){
  need(typeof historicalRoot==='string','EXACT_HISTORICAL_ROOT_REQUIRED');
  if(historicalRoot.startsWith(HOST+'/'))historicalRoot='/data/'+historicalRoot.slice(HOST.length+1);
  need(historicalRoot.startsWith(PREFIX)&&/^[a-f0-9]{64}$/.test(historicalRoot.slice(PREFIX.length)),'EXACT_HISTORICAL_ROOT_REQUIRED');
  const db=new DatabaseSync('/data/content.sqlite',{readOnly:true});let before,result;
  try{
    db.exec('PRAGMA query_only=ON;BEGIN');before=workspace(db);const apiPrice=documentPrice(db);
    const currentRoot=PREFIX+before.current_revision;need(currentRoot!==historicalRoot,'EXPLICIT_NEW_CURRENT_REVISION_REQUIRED');
    function seal(root){const id=root.slice(PREFIX.length),r=revision(db,id),first=inventory(root,r.manifest),second=inventory(root,r.manifest);need(canonical(first)===canonical(second),'MANAGED_CHANGED_DURING_SEAL');return {revision:id,version:r.version,root,manifestSha256:r.manifestSha256,manifestBytes:r.manifestBytes,...first};}
    result={schema:1,siteId:SITE,companyCode:COMPANY,workspace:before,apiPrice,historical:seal(historicalRoot),current:seal(currentRoot)};
    const oldPrice=result.historical.selected[STORED_PRICE],newPrice=result.current.selected[STORED_PRICE];
    need(oldPrice.sha256===newPrice.sha256&&oldPrice.bytes===newPrice.bytes,'STORED_PRICE_CHANGED_BETWEEN_REVISIONS');
    need(canonical(workspace(db))===canonical(before),'MANAGED_POINTER_CHANGED_DURING_SEAL');
    need(canonical(documentPrice(db))===canonical(apiPrice),'API_PRICE_CHANGED_DURING_SEAL');db.exec('ROLLBACK');
  }finally{db.close();}
  const fresh=new DatabaseSync('/data/content.sqlite',{readOnly:true});try{fresh.exec('PRAGMA query_only=ON;BEGIN');need(canonical(workspace(fresh))===canonical(before),'MANAGED_POINTER_CHANGED_AFTER_SEAL');need(canonical(documentPrice(fresh))===canonical(result.apiPrice),'API_PRICE_CHANGED_AFTER_SEAL');fresh.exec('ROLLBACK');}finally{fresh.close();}
  return result;
}
function projection(value){const out={...value};delete out.files;delete out.directories;delete out.manifest;return out;}
function sealIntegrity(value){
  need(value&&Object.keys(value.files||{}).length===140&&Object.keys(value.manifest||{}).length===140&&hash(canonical(value.files))===value.factsSha256&&hash(canonical(value.directories))===value.directoriesSha256,'FULL_MANAGED140_SEAL_REQUIRED');
  need(canonical(Object.keys(value.files).sort())===canonical(Object.keys(value.manifest).sort()),'FULL_MANAGED140_MANIFEST_SET_REQUIRED');
  for(const name of Object.keys(value.selected))need(canonical(value.selected[name])===canonical(value.files[name]),'MANAGED_SELECTED_FILE_FACTS_CHANGED');
}
function validate260(old,first,second){
  need(old&&old.schema===1&&old.siteId===SITE&&old.companyCode===COMPANY&&old.historical.version===257&&old.current.version===259,'EXACT_FROZEN_257_259_PROOF_REQUIRED');
  need(canonical(projection(first.historical))===canonical(old.historical),'HISTORICAL257_DRIFT');
  need(canonical(projection(second.historical))===canonical(old.current),'HISTORICAL259_DRIFT');
  need(canonical(first.current)===canonical(second.current)&&canonical(first.workspace)===canonical(second.workspace),'CURRENT260_CHANGED_DURING_CAPTURE');
  for(const r of [first.historical,second.historical,first.current,second.current])sealIntegrity(r);
  need(first.current.version===260&&first.current.mismatches.length===0,'EXACT_CLEAN_CURRENT260_REQUIRED');
  need(canonical(first.apiPrice)===canonical(old.apiPrice)&&canonical(second.apiPrice)===canonical(old.apiPrice),'API_PRICE_CHANGED');
  const workspace={...first.workspace,current_revision:old.workspace.current_revision};need(canonical(workspace)===canonical(old.workspace),'MANAGED_WORKSPACE_CHANGED');
  need(first.workspace.current_revision===first.current.revision&&first.current.revision!==old.current.revision,'CURRENT260_POINTER_REQUIRED');
  const before=second.historical,after=first.current;
  need(before.fileCount===140&&after.fileCount===140&&canonical(before.directories)===canonical(after.directories),'MANAGED_DIRECTORY_SET_OR_MODES_CHANGED');
  need(canonical(Object.keys(before.files).sort())===canonical(Object.keys(after.files).sort())&&canonical(Object.keys(before.manifest).sort())===canonical(Object.keys(after.manifest).sort()),'MANAGED140_PATH_SET_CHANGED');
  for(const name of Object.keys(before.files)){
    const a={...before.files[name]},b={...after.files[name]},ma={...before.manifest[name]},mb={...after.manifest[name]};
    if(name==='assets/storefront.js'){
      need(a.sha256==='04eeff7a7baf9a44b03abede38011a799a4a637d8edf0214127fdf4ea559827d'&&a.bytes===37143&&b.sha256==='22ae9cba4684c13d41ba1943cb6e2748be73597b3b9001026d1d44ccea3fc335'&&b.bytes===41643,'EXACT_APPROVED_STOREFRONT260_DELTA_REQUIRED');
      for(const k of ['sha256','bytes']){delete a[k];delete b[k];delete ma[k];delete mb[k];}
    }
    need(canonical(a)===canonical(b)&&canonical(ma)===canonical(mb),'UNAPPROVED_MANAGED_FILE_DELTA');
  }
  return true;
}
function capture260(old){const first=probe(old.historical.root),second=probe(old.current.root);validate260(old,first,second);return {schema:'palitra-managed260-readonly/v1',status:'MANAGED260_CAPTURED_NOT_RUNTIME_INSPECTION',historical257:first.historical,historical259:second.historical,current260:first.current,workspace:first.workspace,apiPrice:first.apiPrice,runtimeWrites:0};}
module.exports={probe,canonical,inventory,projection,sealIntegrity,validate260,capture260};
if(require.main===module){try{const out=JSON.stringify(capture260(JSON.parse(process.argv[2])));need(Buffer.byteLength(out)<=512*1024,'BOUNDED_MANAGED260_PROOF_REQUIRED');process.stdout.write(out+'\n');}catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}}
