'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');
const {createAuthStore,COMPANIES}=require('/app/auth-store.js');
const {createWorkspaceStore,validPath}=require('/app/site-workspaces.js');
const ID='site-44bbe13f1bad5e005b2a',FILE='dostavka-i-oplata/index.html';
const DB=process.env.DATABASE_PATH||'/data/content.sqlite',ROOT=path.join(path.dirname(DB),'projects');
const BACK=path.join(path.dirname(DB),'palitra-map-caption-20261019');
const PINS={"assets/order.js": "4709e5ce6cb4f92474db0bbf09e71a9c44bed3aa00db2ab89036d180184eb7dd", "assets/storefront.js": "04eeff7a7baf9a44b03abede38011a799a4a637d8edf0214127fdf4ea559827d"};
const EDITS=[["<p class=\"dz-credit\">\u0413\u0440\u0430\u043d\u0438\u0446\u044b \u0437\u043e\u043d: \u00a9 <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noopener\">\u0443\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u0438 OpenStreetMap</a></p>", ""], ["const ATTRIBUTION='&copy; <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noopener\">OpenStreetMap</a> contributors';", "const ATTRIBUTION='&copy; <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noopener\">OpenStreetMap</a>';"], ["if(map.attributionControl)map.attributionControl.addAttribution(ATTRIBUTION);", "if(map.attributionControl){map.attributionControl.setPrefix(false);map.attributionControl.addAttribution(ATTRIBUTION);}"]];
const BASE='e43c2b6783a85b4b861bf5439b974e3461d33b60dfac7ff9fc0f02963278b51f';
const AFTER='3f935f8871e1a9fa7c32fbf8efbe23655bded7a909477ebc2b035d568abbf30b';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const need=(v,m)=>{if(!v)throw Error(m);};
function safe(p){for(let q=p;;q=path.dirname(q)){need(!fs.lstatSync(q).isSymbolicLink(),'SYMLINK_REFUSED');if(q===path.dirname(q))break;}return p;}
function auth(db){const row=db.prepare('SELECT id FROM auth_users WHERE login=?').get('vladislav');need(row,'ACTUAL_OWNER_REQUIRED');const service=createAuthStore(db),user=service.getById(row.id);need(user.login==='vladislav'&&user.role==='owner'&&user.companyCodes.includes('palitra-love')&&user.permissions.includes('site_editor.edit'),'ACTUAL_EXISTING_PERMISSION_REQUIRED');return {service,user};}
function state(db){
 const row=db.prepare('SELECT m.id,m.company_code,m.publication_status,w.current_revision FROM managed_sites m JOIN site_workspaces w ON w.site_id=m.id WHERE m.id=?').get(ID);
 need(row&&row.company_code==='palitra-love'&&row.publication_status==='draft','EXACT_DRAFT_REQUIRED');
 const rev=db.prepare('SELECT version,manifest_json FROM site_workspace_revisions WHERE site_id=? AND revision=?').get(ID,row.current_revision);
 const manifest=JSON.parse(rev.manifest_json),folder=path.join(ROOT,'palitra-love','sites',ID,'versions',row.current_revision);safe(folder);
 const files={},mismatches=[];
 for(const [name,pin] of Object.entries(manifest)){need(validPath(name),'INVALID_PATH');const p=safe(path.join(folder,name));need(p.startsWith(folder+'/'),'BOUNDARY');const b=fs.readFileSync(p);files[name]=b;if(sha(b)!==pin.sha256||b.length!==pin.bytes)mismatches.push(name);}
 const pins=Object.fromEntries(Object.entries(files).map(([k,v])=>[k,{bytes:v.length,sha256:sha(v)}]));
 return {row,rev,manifest,folder,files,pins,mismatches,history:db.prepare('SELECT count(*) n FROM site_workspace_revisions WHERE site_id=?').get(ID).n};
}
function baseline(s){need(s.rev.version===257&&Object.keys(s.files).length===140,'EXACT_V257_REQUIRED');need(JSON.stringify(s.mismatches.sort())===JSON.stringify(Object.keys(PINS).sort()),'ONLY_TWO_KNOWN_DRIFTS_ALLOWED');for(const [n,p] of Object.entries(PINS))need(sha(s.files[n])===p,'PRESERVED_PUBLIC_RESOURCE_CHANGED');need(sha(s.files[FILE])===BASE,'EXACT_MAP_BASE_REQUIRED');}
function patch(raw){let text=raw.toString('utf8');need(Buffer.from(text).equals(raw),'UTF8_REQUIRED');for(const [from,to] of EDITS){need(text.split(from).length===2,'EXACT_SINGLE_EDIT_REQUIRED');text=text.replace(from,to);}const b=Buffer.from(text);need(sha(b)===AFTER,'EXACT_MAP_CANDIDATE_REQUIRED');return b;}
function write(name,obj){fs.writeFileSync(path.join(BACK,name),JSON.stringify(obj,null,2),{mode:0o600,flag:'wx'});}
async function main(){
 let db=new DatabaseSync(safe(DB),{readOnly:true});let s;
 try{s=state(db);baseline(s);auth(db);patch(s.files[FILE]);
 if(process.argv[2]!=='--apply'){console.log(JSON.stringify({status:'READONLY_PREFLIGHT_PASS',version:s.rev.version,revision:s.row.current_revision,files:140,knownDrifts:s.mismatches,preservePins:PINS,mapBefore:BASE,mapAfter:AFTER,dbWrites:0,siteWrites:0}));return;}
 need(!fs.existsSync(BACK),'OWN_ATTEMPT_EXISTS_NO_RETRY');safe(path.dirname(BACK));fs.mkdirSync(BACK,{mode:0o700});
 const backupFile=path.join(BACK,'content.sqlite');await backup(db,backupFile);fs.chmodSync(backupFile,0o600);const check=new DatabaseSync(backupFile,{readOnly:true});try{need(check.prepare('PRAGMA quick_check').get().quick_check==='ok','CONSISTENT_BACKUP_REQUIRED');}finally{check.close();}
 write('BEFORE.json',{site:ID,version:257,revision:s.row.current_revision,manifest:s.manifest,pins:s.pins,history:s.history,dbBackup:'native-private-content.sqlite'});
 for(const name of [FILE,...Object.keys(PINS)])fs.writeFileSync(path.join(BACK,name.replaceAll('/','--')),s.files[name],{mode:0o600,flag:'wx'});
 }finally{db.close();}
 db=new DatabaseSync(DB);try{
 const current=state(db);baseline(current);need(current.row.current_revision===s.row.current_revision&&JSON.stringify(current.pins)===JSON.stringify(s.pins),'LAST_BASIS_CHANGED');
 const {service,user}=auth(db);const store=createWorkspaceStore({db,root:ROOT,sources:{},companies:COMPANIES,audit:service.audit});
 const files=[{path:FILE,content:patch(s.files[FILE]).toString('utf8')},...Object.keys(PINS).map(name=>({path:name,content:s.files[name].toString('utf8')}))];
 for(const f of files)if(f.path!==FILE)need(Buffer.from(f.content).equals(s.files[f.path]),'PRESERVED_UTF8_REQUIRED');
 write('SAVE_STARTED.json',{site:ID,version:257,revision:s.row.current_revision,method:'unmodified createWorkspaceStore.save',actor:user.login,actualExistingRole:user.role,files:files.map(f=>f.path),automaticRetry:false});
 const result=store.save(user,ID,{baseRevision:s.row.current_revision,files,message:'Карта доставки: убрать флаг и Leaflet, удалить подпись под картой; сохранить текущую корзину и витрину без изменений'});
 const after=state(db);need(result.version===258&&after.rev.version===258&&after.history===s.history+1&&after.mismatches.length===0,'NEW_TRACKED_VERSION_REQUIRED');
 need(JSON.stringify(Object.keys(after.files).sort())===JSON.stringify(Object.keys(s.files).sort()),'CLOSED_FILE_SET_REQUIRED');
 for(const [name,b] of Object.entries(s.files))need(after.files[name].equals(name===FILE?patch(b):b),'UNRELATED_RESOURCE_CHANGED');
 const oldManifest=db.prepare('SELECT manifest_json FROM site_workspace_revisions WHERE site_id=? AND revision=?').get(ID,s.row.current_revision).manifest_json;need(JSON.stringify(JSON.parse(oldManifest))===JSON.stringify(s.manifest),'OLD_MANIFEST_CHANGED');
 for(const [name,b] of Object.entries(s.files))need(fs.readFileSync(safe(path.join(s.folder,name))).equals(b),'OLD_VERSION_CHANGED');
 const out={status:'SAVED_V258_OFFICIAL_METHOD',site:ID,oldRevision:s.row.current_revision,version:after.rev.version,revision:after.row.current_revision,files:140,oldFilesPreserved:140,otherCurrentFilesExact:139,priorDriftFilesPreserved:PINS,newManifestIntegrity:true,mapSha256:AFTER,mapEdits:3,pricesChanged:false,permissionsChanged:false,serviceCodeChanged:false,runtimeAppImageChanged:false,databaseBackupPrivate:true,automaticRetry:false};write('OUTCOME.json',out);console.log(JSON.stringify(out));
 }finally{db.close();}
}
main().catch(e=>{console.error(JSON.stringify({status:'STOP_NO_AUTOMATIC_RETRY',error:e.message}));process.exitCode=1;});
