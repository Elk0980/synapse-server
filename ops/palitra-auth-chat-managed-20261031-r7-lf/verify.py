"""UI-only evidence/backup/readback. No Save, application imports, SQL writes or network."""
import argparse,hashlib,json,os,re,sqlite3,stat,subprocess,sys,time
from pathlib import Path,PurePosixPath
from datetime import datetime,timezone
SITE='site-44bbe13f1bad5e005b2a';COMPANY='palitra-love'
DATA=Path('/var/lib/docker/volumes/synapse_content_data/_data')
NAME='palitra-auth-chat-managed-20261031-r7-lf';ROOT=Path('/opt/synapse');AREA=ROOT/'releases'/NAME
RELEASE_AREA=ROOT/'releases/palitra-auth-chat-production-20261031-r7'
RELEASE_PACKAGE='palitra-auth-chat-production-20261031-r7'
RELEASE_HELPER_SHA='473028a50555fced995708ece843b9695fb4d5c0ee88d282c2ca806436e68838'
RELEASE_MANIFEST_SHA='7ed89e7d55b7919605c597b62ebbc933507dfa1f90d969cc5e920f51dafa0427'
SELF=Path(__file__).resolve();LOCK=ROOT/'.palitra-app-release.lock'
BASE_REV='4d8e767175cb2d3c5f06a8e61ec40ab0122113e77691776f8ef04212e75055db';BASE_VERSION=337;HISTORY_COUNT=337
TARGET='assets/storefront.js';BEFORE='008f75eecee63f7bd6657408d844f08f9f37472e1d1d3c81256f52505423a808';AFTER='e564f807d1de31c2d9fd1a0f89581afd52a57042ce5b8a444aa3fa8ae793c5e8';BEFORE_BYTES=64755;AFTER_BYTES=81128
REGISTER='account/register/index.html';REGISTER_SHA='8d5f8e165307dfc9272cbe8ec3851f0f85a2e6db370558b52face10dfb74dbf0'
PRICE_SHA='47878c70b8e65e3612fb5953c6dabe2659d80c54ea9828941e6951deb934fc12'
HEX=re.compile('[a-f0-9]{64}');LIMIT=16*1024*1024;PERMIT_SECONDS=180
NAMES=('synapse-crm-1','synapse-content-1','synapse-hugh-runtime-1','synapse-chat-1','caddy')
IMAGES={'caddy':'sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648','synapse-chat-1':'sha256:4d5b047dc76bae1d2b82067406f98c344eea4033f83f35a54cdef7cd355ed2ae','synapse-content-1':'sha256:e22ca4d3892a01454d749fbef49c10c2a1a93f0a863d977914f32ae21455a343','synapse-crm-1':'sha256:b74d9196617cd1ba4945d0b13b69a0648552c170c5c1680b76fab51cdb73b327','synapse-hugh-runtime-1':'sha256:1d89b9652c514c238c7509bd0d81f7a0a4d198cf7cd9990c90c7e3e05b045018'}
HOST_PINS={'/opt/synapse/sites/synapse/cabinet/palitra-orders/native-host.js': '597a495e414d6f696dc86cf09b35bdcaa29556ac9f25d24f8e204f9edd1c485b', '/opt/synapse/sites/synapse/cabinet/palitra-orders/shell.js': 'ce05204609d4a63940df7c47771d6cf0deba1b116283d61bfc20fe3c32ee51d6'}
RUNTIME_AFTER={'/app/server.js': '755e27e780f48ff1c44fac4e153b4a003f0addaa408e54c66a629b6784a37115', '/app/draft-account-service.cjs': 'cfb53698fc501d66e0adf70733edac468242851c52c59b1fe20f9c99203ee54c', '/app/site-workspace-feature.js': 'f444e576912653971374772b666e497b98bc88fec5dfb8bc5a243b0365aadcf3', '/app/customer-chat.js': '8f6060894d066080ca8f9d878e531fd9688984ed55b7d031755da314711448f2', '/app/customer-chat-http.cjs': 'd97707678c795241cd3ff7b62d1e38c4c17c0ae3fd7f88a756be202f1f5b6dff', '/app/palitra-manager-attention.cjs': '031610cb51a5748913a3d26f1377d06eb9945d876affb199d06271f0209a1c80', '/app/site-orders.js': '3a2f275b55e91a6db94c3a97e9c98f424c5ae3d6aebf2b960b1a8cf07dc25859', '/app/palitra-push-host.cjs': '4e6e303a0d7d4130762f624b84c8903d96b1b7b161d9112f5521822625510d0a', '/app/account-auth-outcome.cjs': 'b9318b19b78630111590977dd4b533a0b20e6fedd647c93819e81e8cd66b1c45', '/app/palitra-review-public/palitra-chat.js': '07e331c1130c9fc05cbdf932777cb56fe3fb04e293ba8f098409fdf3a22ed2d8', '/app/palitra-orders-public/native-host.js': 'd8f8f04f5e833d4c0b3399037bb7ec8adb23e873a7baaa5dbc32d941ab3c2af0', '/app/palitra-orders-public/shell.js': '173325f501d2ab881b18a4a842d68000d386932218023cc9a468f3a3c4180553'}
TABLES=('managed_sites','site_workspaces','site_workspace_revisions','documents')
enc=lambda v:(json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':'))+'\n').encode()
sha=lambda v:hashlib.sha256(v).hexdigest()


def need(ok,code):
 if not ok:raise ValueError(code)

def pairs(items):
 result={}
 for k,v in items:need(k not in result,'DUPLICATE_JSON_KEY');result[k]=v
 return result

def parse(raw):return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in()).throw(ValueError('NONFINITE_JSON')))

def safe(path,limit=LIMIT):
 path=Path(path);need(path.is_absolute()and path.resolve()==path,'CANONICAL_FILE_REQUIRED')
 before=path.lstat();need(stat.S_ISREG(before.st_mode)and not path.is_symlink()and before.st_size<=limit,'REGULAR_BOUNDED_FILE_REQUIRED')
 with path.open('rb')as f:raw=f.read(limit+1);inside=os.fstat(f.fileno())
 after=path.lstat();keys=('st_dev','st_ino','st_size','st_mode','st_uid','st_gid','st_nlink','st_mtime_ns','st_ctime_ns')
 need(len(raw)<=limit and all(getattr(before,k)==getattr(inside,k)==getattr(after,k)for k in keys),'READ_FILE_CHANGED');return raw

def closed_inspect(name):
 need(name in NAMES,'CLOSED_CONTAINER_NAME')
 p=subprocess.run(['docker','inspect',name],stdin=subprocess.DEVNULL,capture_output=True,timeout=20,check=False)
 need(p.returncode==0 and len(p.stdout)<=2*LIMIT and len(p.stderr)<=1024*1024,'INSPECT_REFUSED')
 rows=parse(p.stdout);need(type(rows)is list and len(rows)==1,'ONE_CONTAINER_REQUIRED');r=rows[0]
 need(r['Name'].lstrip('/')==name and HEX.fullmatch(r['Id'])and r['State']['Running']and not r['State'].get('Paused')and not r['State'].get('Dead')and not r['State']['Restarting']and not r['State']['OOMKilled']and r['State'].get('Health',{}).get('Status')in(None,'healthy'),'RUNNING_HEALTHY_REQUIRED')
 return r

def container_identity(r):
 identity={k:r.get(k)for k in('Id','Image','Config','HostConfig','NetworkSettings','Mounts','RestartCount')}
 mounts=identity['Mounts'];need(type(mounts)is list and all(type(m)is dict and type(m.get('Destination'))is str for m in mounts),'MOUNT_RECORDS_REQUIRED')
 need(len({m['Destination']for m in mounts})==len(mounts),'DUPLICATE_MOUNT_DESTINATION')
 identity['Mounts']=sorted(mounts,key=lambda m:m['Destination'])
 identity['state']={k:r['State'].get(k)for k in('Running','Paused','Restarting','OOMKilled','Dead','StartedAt','FinishedAt')}
 return identity

def relative(name):
 need(type(name)is str and name and '\\'not in name and not any(ord(c)<32 for c in name),'MANAGED_PATH_INVALID')
 p=PurePosixPath(name);need(not p.is_absolute()and all(v not in('','.','..')for v in name.split('/'))and str(p)==name,'MANAGED_PATH_INVALID');return name

def tree(folder,budget):
 need(folder.is_dir()and not folder.is_symlink()and folder.resolve()==folder,'CANONICAL_VERSION_DIRECTORY')
 entries={};dirs={}
 def metadata(p):
  s=p.lstat();return [s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,str(s.st_mtime_ns),str(s.st_ctime_ns)]
 def walk_error(error):raise error
 dirs['.']=metadata(folder)
 for current,subdirs,files in os.walk(folder,followlinks=False,onerror=walk_error):
  for n in subdirs:
   p=Path(current)/n;need(not p.is_symlink(),'VERSION_SYMLINK_REFUSED');dirs[p.relative_to(folder).as_posix()]=metadata(p)
  for n in files:
   p=Path(current)/n;name=relative(p.relative_to(folder).as_posix());raw=safe(p);s=p.lstat()
   budget[0]+=len(raw);budget[1]+=1;need(budget[0]<=6*1024**3 and budget[1]<=250000 and time.monotonic()-budget[2]<=180,'HISTORICAL_TREE_SCAN_BOUND')
   entries[name]={'sha256':sha(raw),'bytes':len(raw),'stat':[s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,str(s.st_mtime_ns),str(s.st_ctime_ns)]}
 return {'files':entries,'directories':dirs}

def manifest_files(doc,files):
 need(type(doc)is dict and len(doc)==141 and set(doc)==set(files),'EXACT141_MANIFEST_FILES')
 for name,entry in doc.items():
  relative(name);need(type(entry)is dict and type(entry.get('sha256'))is str and HEX.fullmatch(entry['sha256'])and type(entry.get('bytes'))is int and entry['sha256']==files[name]['sha256']and entry['bytes']==files[name]['bytes'],'MANIFEST_FILE_CONTENT_MISMATCH')

def manifest_projection(doc):
 return {name:{'sha256':entry['sha256'],'bytes':entry['bytes'],'metadataSha256':sha(enc({k:v for k,v in entry.items()if k not in('sha256','bytes')}))}for name,entry in doc.items()}


def own_lease():
 p=subprocess.run(['lslocks','--json','--output','PID,PATH'],stdin=subprocess.DEVNULL,capture_output=True,timeout=10,check=False)
 need(p.returncode==0 and len(p.stdout)<=1024*1024 and len(p.stderr)<=1024*1024,'LEASE_METADATA_REFUSED')
 rows=[r for r in parse(p.stdout)['locks']if r.get('path')==str(LOCK)];need(len(rows)==1,'ONE_FRESH_OWN_LEASE_REQUIRED');pid=int(rows[0]['pid']);ancestors=set();parent=os.getppid()
 while parent>1 and parent not in ancestors:
  ancestors.add(parent);value=Path('/proc/'+str(parent)+'/stat').read_text();parent=int(value[value.rfind(')')+2:].split()[1])
 need(pid in ancestors,'OWN_ANCESTOR_LEASE_REQUIRED');value=Path('/proc/'+str(pid)+'/stat').read_text();return {'pid':pid,'startTicks':value[value.rfind(')')+2:].split()[19]}

def file_meta(path):
 s=path.lstat();return [s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,str(s.st_mtime_ns),str(s.st_ctime_ns)]

def host_static():
 result={}
 for name,pin in HOST_PINS.items():
  path=Path(name);raw=safe(path);s=path.lstat();need(s.st_nlink==1 and sha(raw)==pin,'HOST_STATIC_EXACT_BEFORE_REQUIRED')
  if os.name=='posix':need(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600,'HOST_STATIC_ROOT600_REQUIRED')
  result[name]={'sha256':sha(raw),'bytes':len(raw),'stat':file_meta(path)}
 return result

def provenance():
 need(RELEASE_AREA==ROOT/'releases/palitra-auth-chat-production-20261031-r7'and RELEASE_AREA.resolve()==RELEASE_AREA,'CLOSED_RELEASE_PROVENANCE_AREA')
 package_raw=safe(RELEASE_AREA/'manifest.json');package=parse(package_raw);stage=parse(safe(RELEASE_AREA/'stage.json'))
 need(package.get('packageId')==RELEASE_PACKAGE and sha(package_raw)==RELEASE_MANIFEST_SHA and package['helperSha256']==RELEASE_HELPER_SHA,'EXACT_REVIEWED_R3_RELEASE_REQUIRED')
 need(sha(package_raw)==stage['manifestSha256']and package['helperSha256']==stage['helperSha256'],'RELEASE_STAGED_MANIFEST_REQUIRED')
 need({r['target']:r['afterSha256']for r in package['files']}==RUNTIME_AFTER and len(package['files'])==12,'TWELVE_SOURCE_PROVENANCE_REQUIRED')
 child_raw=safe(RELEASE_AREA/'child.json');child=parse(child_raw);accepted_raw=safe(RELEASE_AREA/'runtime-accepted.json');accepted=parse(accepted_raw)
 need(accepted['status']=='AFTER_INDEPENDENT_READBACK_PASS'and accepted['childSha256']==sha(child_raw)and accepted['baseSha256']==sha(safe(RELEASE_AREA/'base.json'))and accepted['historyWitnessSha256']==sha(safe(RELEASE_AREA/'history-witness.json')),'RELEASE_INDEPENDENT_ACCEPTANCE_REQUIRED')
 need(child['parent']==IMAGES['synapse-content-1']and child['image']!=child['parent']and re.fullmatch('sha256:[a-f0-9]{64}',child['image']),'EXACT_CONTENT_CHILD_REQUIRED')
 return {'manifestSha256':sha(package_raw),'childSha256':sha(child_raw),'acceptedSha256':sha(accepted_raw),'image':child['image'],'identities':accepted['identities']}

def runtime():
 proof=provenance();result={}
 for name in NAMES:
  row=closed_inspect(name);expected=proof['image']if name=='synapse-content-1'else IMAGES[name]
  need(row['Image']==expected and row['RestartCount']==0,'EXACT_RELEASE_FIVE_IMAGES_RESTARTS_REQUIRED')
  release_identity={key:row[key]for key in('Id','Image','Config','HostConfig','NetworkSettings')}
  release_identity['Mounts']=sorted(row['Mounts'],key=lambda value:value['Destination'])
  release_identity['state']={key:row['State'].get(key)for key in('Running','Paused','Restarting','OOMKilled','Dead','ExitCode','Error','StartedAt','FinishedAt')}
  release_identity['restarts']=row.get('RestartCount')
  need(sha(enc(release_identity))==proof['identities'][name],'ACCEPTED_CONTAINER_CONFIG_IDENTITY_CHANGED')
  identity=sha(enc(container_identity(row)))
  if name=='synapse-content-1':
   mounts=[m for m in row['Mounts']if m['Destination']=='/data'];need(len(mounts)==1 and mounts[0]['Source']==str(DATA),'EXACT_CONTENT_DATA_MOUNT')
  result[name]={'image':row['Image'],'identitySha256':identity}
 return result

def authorizer(action,arg1,arg2,db,trigger):
 if action in(sqlite3.SQLITE_SELECT,sqlite3.SQLITE_FUNCTION,sqlite3.SQLITE_TRANSACTION):return sqlite3.SQLITE_OK
 if action==sqlite3.SQLITE_READ and arg1 in(*TABLES,'sqlite_master','sqlite_schema'):return sqlite3.SQLITE_OK
 if action==sqlite3.SQLITE_PRAGMA and arg1=='table_info'and arg2 in TABLES:return sqlite3.SQLITE_OK
 return sqlite3.SQLITE_DENY

def open_db():
 path=DATA/'content.sqlite';need(path.resolve()==path and not path.is_symlink()and stat.S_ISREG(path.lstat().st_mode),'EXACT_ACTIVE_CONTENT_DB')
 conn=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=5);conn.execute('PRAGMA query_only=ON');conn.set_authorizer(authorizer);conn.execute('BEGIN');return conn

def cells(values):return [{'blob':v.hex()}if isinstance(v,bytes)else v for v in values]

def rows(conn,table,order):
 need(table in TABLES,'CLOSED_TABLE');cols=[r[1]for r in conn.execute('PRAGMA table_info('+table+')')];values=conn.execute('SELECT * FROM '+table+' ORDER BY '+order).fetchall();need(len(values)<=100000,'MANAGED_ROW_BOUND');return cols,values

def bindings(conn):
 schema=conn.execute('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN(?,?,?,?) ORDER BY type,name',TABLES).fetchall()
 sites_cols,sites=rows(conn,'managed_sites','id');work_cols,workspaces=rows(conn,'site_workspaces','site_id')
 need({'id','company_code','is_active','deleted_at','updated_at'}<=set(sites_cols)and {'site_id','hostname','runtime','current_revision'}<=set(work_cols),'CURRENT_ROWS_KNOWN_SCHEMA')
 selected=[r for r in sites if r[sites_cols.index('id')]==SITE];selected_w=[r for r in workspaces if r[work_cols.index('site_id')]==SITE];need(len(selected)==len(selected_w)==1,'ONE_FIXED_CURRENT_ROW');site=dict(zip(sites_cols,selected[0]));workspace=dict(zip(work_cols,selected_w[0]))
 need(site['company_code']==COMPANY and site['is_active']==1 and site['deleted_at']is None and workspace['hostname']=='palitra-love-draft-1.synapsebusiness.ru'and workspace['runtime']=='palitra-draft','EXACT_PALITRA_SITE_REQUIRED')
 normalized_sites=[cells(r)for r in sites];normalized_work=[cells(r)for r in workspaces]
 for r in normalized_sites:
  if r[sites_cols.index('id')]==SITE:r[sites_cols.index('updated_at')]={'controlled':'new_revision_created_at'}
 for r in normalized_work:
  if r[work_cols.index('site_id')]==SITE:r[work_cols.index('current_revision')]={'controlled':'new_revision'}
 history_cols=[r[1]for r in conn.execute('PRAGMA table_info(site_workspace_revisions)')];need({'site_id','revision','version','manifest_json','created_at'}<=set(history_cols),'KNOWN_REVISION_SCHEMA_REQUIRED');history=conn.execute('SELECT * FROM site_workspace_revisions WHERE site_id=? ORDER BY version,revision',(SITE,)).fetchall();need(1<=len(history)<=1000,'REVISION_HISTORY_BOUND')
 price_cols=[r[1]for r in conn.execute('PRAGMA table_info(documents)')];need({'key','version','body'}<=set(price_cols),'PRICE_DOCUMENT_SCHEMA');price_row=conn.execute('SELECT * FROM documents WHERE key=? ORDER BY version DESC LIMIT 1',('palitra/price',)).fetchone();need(price_row is not None,'PRICE83_DOCUMENT_REQUIRED');price_doc=dict(zip(price_cols,price_row));body=price_doc['body'];need(price_doc['key']=='palitra/price'and type(price_doc['version'])is int and price_doc['version']==83 and type(body)is str and len(body.encode())<=4*1024*1024 and sha(body.encode())==PRICE_SHA,'PRICE83_EXACT_REQUIRED');parsed=parse(body);need(type(parsed)is dict and type(parsed.get('version'))is int and parsed['version']==83,'PRICE83_BODY_VERSION')
 price={'version':83,'sha256':sha(body.encode()),'fullRowSha256':sha(enc(cells(price_row))),'schemaSha256':sha(enc([r for r in schema if r[2]=='documents']))}
 managed={'schemaSha256':sha(enc(schema)),'sitesColumns':sites_cols,'workspacesColumns':work_cols,'siteRowsSha256':sha(enc(normalized_sites)),'workspaceRowsSha256':sha(enc(normalized_work))}
 return {'managedRows':managed,'updatedAt':site['updated_at'],'revision':workspace['current_revision'],'historyColumns':history_cols,'historyRows':history,'price':price}

def binding_digest(value):
 return sha(enc({**value,'historyRows':[cells(r)for r in value['historyRows']]}))

def snapshot():
 begin=time.time();lease=own_lease();images=runtime();host=host_static();source=provenance();conn=open_db()
 try:
  state=bindings(conn);current=state['revision'];cols=state['historyColumns'];versions=DATA/'projects'/COMPANY/'sites'/SITE/'versions';need(versions.resolve()==versions and not versions.is_symlink(),'VERSION_ROOT_CANONICAL');records={};budget=[0,0,time.monotonic()];current_doc=None;current_tree=None
  for values in state['historyRows']:
   record=dict(zip(cols,values));rev=record['revision'];need(type(rev)is str and HEX.fullmatch(rev)and rev not in records and type(record['version'])is int,'REVISION_IDENTITY_REQUIRED');doc=parse(record['manifest_json']);physical=tree(versions/rev,budget);need(type(doc)is dict and set(doc)==set(physical['files']),'HISTORY_MANIFEST_FILESET')
   records[rev]={'version':record['version'],'rowSha256':sha(enc(cells(values))),'treeSha256':sha(enc(physical)),'manifestSha256':sha(record['manifest_json'].encode()),'createdAt':record['created_at']}
   if record['version']==BASE_VERSION+1:need(rev==sha((record['manifest_json']+'\n'+BASE_REV).encode()),'OFFICIAL_NEW_REVISION_DERIVATION_REQUIRED')
   if rev==current:current_doc=doc;current_tree=physical;current_version=record['version'];manifest_files(doc,physical['files'])
  need(current_doc is not None and {p.name for p in versions.iterdir()}==set(records),'UNTRACKED_OR_MISSING_HISTORICAL_VERSION');need(conn.total_changes==0,'NO_DATABASE_WRITES');original=binding_digest(state);conn.rollback()
 finally:conn.close()
 fresh=open_db()
 try:need(binding_digest(bindings(fresh))==original and fresh.total_changes==0,'SQL_CHANGED_DURING_FULL_HISTORY_READ');fresh.rollback()
 finally:fresh.close()
 need(runtime()==images and host_static()==host and provenance()==source and own_lease()==lease,'ENVIRONMENT_CHANGED_DURING_READ')
 current_metadata={'files':{name:entry['stat'][2:6]for name,entry in current_tree['files'].items()},'directories':{name:entry[2:6]for name,entry in current_tree['directories'].items()}}
 return {'schema':1,'siteId':SITE,'companyCode':COMPANY,'version':current_version,'revision':current,'manifest':manifest_projection(current_doc),'history':records,'images':images,'price':state['price'],'hostStatic':host,'provenance':source,'managedRows':state['managedRows'],'targetUpdatedAt':state['updatedAt'],'currentMetadata':current_metadata,'targetStat':file_meta(versions/current/TARGET),'lease':lease,'beganAt':begin,'capturedAt':time.time()}

def stamp(value):
 need(type(value)is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',value),'EXACT_SAVE_STAMP_REQUIRED');return datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()

def compare(base,current,stage):
 need(stage in('before','after')and base['schema']==current['schema']==1 and base['siteId']==current['siteId']==SITE and base['companyCode']==current['companyCode']==COMPANY,'FIXED_SITE_EVIDENCE_REQUIRED')
 need(base['version']==BASE_VERSION and base['revision']==BASE_REV and len(base['history'])==HISTORY_COUNT and len(base['manifest'])==141,'EXACT_CURRENT337_BASE_REQUIRED')
 need(max(entry['version']for entry in base['history'].values())==BASE_VERSION,'OFFICIAL_NEXT_VERSION_MUST_BE338')
 need(base['manifest'][TARGET]['sha256']==BEFORE and base['manifest'][TARGET]['bytes']==BEFORE_BYTES and base['manifest'][REGISTER]['sha256']==REGISTER_SHA,'EXACT_ORDER_AND_REGISTER_BASE_REQUIRED')
 need(base['manifest']['assets/order.js']['sha256']=='37c87769cbffad6a2751df40b6911b48bf1a5646606fcb61937027755b103e6e' and base['manifest']['assets/order.js']['bytes']==95200,'EXACT_ACCEPTED337_ORDER_REQUIRED')
 need(base['manifest'][TARGET]['metadataSha256']==sha(enc({})),'TARGET_METADATA_WOULD_BE_DROPPED')
 expected_dirs={'.'}
 for name in base['manifest']:
  for parent in PurePosixPath(name).parents:
   expected_dirs.add(str(parent))
 need(set(base['currentMetadata']['directories'])==expected_dirs,'UNMANIFESTED_CURRENT_DIRECTORY_WOULD_BE_DROPPED')
 if os.name=='posix':
  need(all(value==[stat.S_IFREG|0o600,0,0,1]for value in base['currentMetadata']['files'].values()),'OFFICIAL_WRITER_FILE_MODE_COMPATIBILITY')
  need(all(value[:3]==[stat.S_IFDIR|0o700,0,0]for value in base['currentMetadata']['directories'].values()),'OFFICIAL_WRITER_DIRECTORY_MODE_COMPATIBILITY')
 for key in('images','price','hostStatic','provenance','managedRows','lease'):need(enc(current[key])==enc(base[key]),'PRESERVED_'+key.upper()+'_CHANGED')
 need(all(current['history'].get(rev)==entry for rev,entry in base['history'].items()),'OLD337_ROWS_OR_FULL_TREES_CHANGED')
 if current['version']==BASE_VERSION:
  need(current['revision']==BASE_REV and current['history']==base['history']and current['manifest']==base['manifest']and current['targetUpdatedAt']==base['targetUpdatedAt']and current['currentMetadata']==base['currentMetadata']and current['targetStat']==base['targetStat'],'BEFORE_STATE_CHANGED')
  return 'BEFORE_READY'if stage=='before'else'BEFORE_NO_REPLAY'
 need(stage=='after'and current['version']==BASE_VERSION+1 and len(current['history'])==HISTORY_COUNT+1 and current['revision']not in base['history'],'EXACT_ONE_NEW338_REQUIRED')
 new_record=current['history'].get(current['revision']);need(new_record and new_record['version']==BASE_VERSION+1,'NEW_CURRENT338_REQUIRED');need(current['targetUpdatedAt']==new_record['createdAt'],'EXACT_TWO_FIELD_METADATA_DELTA');saved=stamp(new_record['createdAt']);need(base['capturedAt']<=saved<=base['permitExpires']and saved<=current['capturedAt'],'SAVE_OUTSIDE_FRESH_PERMIT')
 expected=parse(enc(base['manifest']));expected[TARGET]={**expected[TARGET],'sha256':AFTER,'bytes':AFTER_BYTES};need(current['manifest']==expected,'ONLY_ORDER_MANIFEST_DELTA_REQUIRED');need(current['currentMetadata']==base['currentMetadata'],'NEW338_MODE_OWNER_LINK_DIRECTORY_CHANGED')
 return 'AFTER_INDEPENDENT_READBACK_PASS'

def write_new(path,raw):
 need(path.parent.resolve()==path.parent,'CANONICAL_EVIDENCE_PARENT');fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
 with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())

def sync_dir(path):
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_DIRECTORY',0))
 try:os.fsync(fd)
 finally:os.close(fd)

def private_directory():
 need(AREA.resolve()==AREA and AREA.is_dir()and not AREA.is_symlink(),'EXACT_PRIVATE_EVIDENCE_DIRECTORY')
 if os.name=='posix':
  state=AREA.lstat();need(state.st_uid==state.st_gid==0 and stat.S_IMODE(state.st_mode)==0o700,'PRIVATE_EVIDENCE_ROOT700_REQUIRED')

def private_read(path,limit=LIMIT):
 raw=safe(path,limit);s=path.lstat();need(s.st_nlink==1,'PRIVATE_ONE_LINK_REQUIRED')
 if os.name=='posix':need(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600,'PRIVATE_ROOT600_REQUIRED')
 return raw

def protect_before():
 need(not os.path.lexists(AREA),'EVIDENCE_NAMESPACE_EXISTS_INSPECT_ONLY');need(AREA.parent.resolve()==AREA.parent,'CANONICAL_RELEASES_REQUIRED');lease=own_lease();AREA.mkdir(mode=0o700);private_directory();helper=sha(safe(SELF));write_new(AREA/'before-intent.json',enc({'helperSha256':helper,'lease':lease,'at':time.time()}));sync_dir(AREA)
 base=snapshot();base['permitExpires']=base['capturedAt']+PERMIT_SECONDS;need(base['lease']==lease,'OWN_LEASE_CHANGED');compare(base,base,'before');target=DATA/'projects'/COMPANY/'sites'/SITE/'versions'/BASE_REV/TARGET;raw=safe(target);need(sha(raw)==BEFORE and len(raw)==BEFORE_BYTES and file_meta(target)==base['targetStat'],'RAW_BEFORE_CHANGED_AFTER_SNAPSHOT');backup=AREA/'order.before.js';write_new(backup,raw);base['rawBefore']={'sha256':sha(private_read(backup)),'bytes':len(raw),'stat':file_meta(backup)};base['helperSha256']=helper
 blob=enc(base);need(len(blob)<=LIMIT,'PROTECTED_METADATA_BOUND');write_new(AREA/'baseline.json',blob);write_new(AREA/'baseline.ready.json',enc({'baselineSha256':sha(blob),'helperSha256':helper,'lease':lease}));sync_dir(AREA);return {'status':'PROTECTED_BEFORE_READY_NOT_SAVED','baselineSha256':sha(blob),'revision':BASE_REV,'version':BASE_VERSION,'permitExpires':base['permitExpires']}

def readback():
 private_directory();ready=parse(private_read(AREA/'baseline.ready.json'));blob=private_read(AREA/'baseline.json');need(sha(blob)==ready['baselineSha256']and sha(safe(SELF))==ready['helperSha256'],'PROTECTED_BASE_OR_HELPER_CHANGED');base=parse(blob);need(base['helperSha256']==ready['helperSha256']and own_lease()==ready['lease']==base['lease'],'FRESH_SAME_OWN_LEASE_REQUIRED');raw=private_read(AREA/'order.before.js');need(sha(raw)==base['rawBefore']['sha256']==BEFORE and len(raw)==base['rawBefore']['bytes']==BEFORE_BYTES and file_meta(AREA/'order.before.js')==base['rawBefore']['stat'],'PROTECTED_RAW_BEFORE_CHANGED');current=snapshot();status=compare(base,current,'after');result={'status':status,'snapshot':current,'baselineSha256':ready['baselineSha256'],'helperSha256':ready['helperSha256'],'at':time.time(),'automaticReplay':False,'databaseRestored':False};write_new(AREA/('readback-'+str(time.time_ns())+'.json'),enc(result));sync_dir(AREA);return {'status':status,'version':current['version'],'revision':current['revision'],'baselineSha256':ready['baselineSha256'],'automaticReplay':False,'databaseRestored':False}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('phase',choices=('before','after'));args=parser.parse_args();need(os.name=='posix'and os.geteuid()==0,'NATIVE_LINUX_ROOT_ONLY');need(AREA==ROOT/'releases'/NAME and AREA.resolve()==AREA,'CLOSED_FRESH_EVIDENCE_NAMESPACE');result=protect_before()if args.phase=='before'else readback();print(json.dumps(result,sort_keys=True,separators=(',',':')))
if __name__=='__main__':
 try:main()
 except Exception as error:
  if isinstance(error,ValueError)and re.fullmatch('[A-Z0-9_]{1,120}',str(error)):print('REFUSED: '+str(error),file=sys.stderr)
  print('REFUSED_UI_READONLY_CHECKER_INSPECT_ONLY',file=sys.stderr);sys.exit(2)
