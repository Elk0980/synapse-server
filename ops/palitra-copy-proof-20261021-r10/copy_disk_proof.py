"""One new selected-media proof over an immutable private R10 backup only.

No live DB is opened. No old module/entry/test/own-inspect artifact executes or
is created. Raw env, messages, contacts and disk filenames are never exported.
"""
import argparse,hashlib,json,os,re,sqlite3,stat,subprocess,sys
from datetime import datetime,timezone
from pathlib import Path,PurePosixPath
sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
NAME='palitra-order-cleanup-copy-20261021-r10'
NONCE='90c225bf0dfa540a6943bd75aa8401fa'
FOLDER=ROOT/(NAME+'-'+NONCE);CODE=ROOT/(NAME+'-code')
IMAGE='sha256:951db09e9e6c4781350bbced7e7a9e4ef099077a368e38a6b1fac40e0a4a6a22'
SCOPE='b2ea3bed6bd0d74f9a4ab46ad798dde1f6d41c25d3d44ac059763000b8b6b58a'
LOCK='/opt/synapse/.palitra-app-release.lock'
MANIFEST_SHA='cc30b814fa4ec3fc9391d6114ee118bd7afe8639d34829db88f8bdebc1b3aaef'
PINS={'backup-proof.json':'578ef78e575da91b35c6aebd8c1c9c9a7b58718b464b8acc3ea0b19a893de6d4','preview.json':'aa14dec9cab0e2bc2da2a2bc38a2bcc7cd18d362c9434e6b98ec3eac882a2d37','dryrun.json':'7d3bd2549f0928fe6b14449c1faf116c99e7e02cdc1e2cc152b089812a8d2829','COPY_ONLY.json':'63374035710f8787d3b3ebf77141ba04d2c1bca526e0912d5abe9a837b6aac6b','PREPARED.json':'ef1dcdaac16c9886d0cce4e13b3f2f0f6e7fb63e2c769bdf9aecb5f01c052b05'}
CODE_PINS={'LOCAL_CODE_PINS.json':'556cff84fb6c8aff6ee00e3f77c903588f7cd29e217bc11d43ebde3a5c377b85','cleanup_runtime.py':'6bd4b9f29ff1ffd4e553750d43df437444b5651485748e1eeca82163c8259861','copy_prepare.py':'8d96092beec7779de66eba919f6beb95c8bef42b173c4a0ed7db6c69d5dbb748','live_entry.py':'16600560cef5f63f6e799113cebafff2164b3e765472bc4d46c1bdfc8c656935','prepare_preview.py':'69197d0c9e14cd794a9c5e4c45d81f20c49084cea5183cd8192b3a7ca9df5284'}
COPY_FILES={'before.sqlite','dryrun.sqlite',*PINS}
ENV_JS="const p=require('node:path'),database=process.env.DATABASE_PATH||'/data/content.sqlite',assets=process.env.ASSETS_DIR||p.join(p.dirname(database),'assets');process.stdout.write(JSON.stringify({database,assets}));"
sha=lambda b:hashlib.sha256(b).hexdigest()
def need(v,c):
 if not v:raise ValueError(c)
def digest(v):return type(v)is str and re.fullmatch('[a-f0-9]{64}',v)is not None
def stamp():return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def facts(path,directory=False,mode=None,maximum=None):
 path=Path(path)
 for p in (path,*path.parents):need(not p.is_symlink(),'ROOT_PROOF_PATH_ALIAS_REFUSED')
 s=path.lstat();need(s.st_uid==s.st_gid==0 and (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink==1),'ROOT_SINGLE_PROOF_INPUT_REQUIRED')
 need(mode is None or stat.S_IMODE(s.st_mode)==mode,'EXACT_PRIVATE_PROOF_MODE_REQUIRED')
 need(maximum is None or s.st_size<=maximum,'PROOF_INPUT_BOUND_EXCEEDED');return s
def identity(s):return tuple(getattr(s,k) for k in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns'))
def read_pinned(path,pin,maximum=4*1024*1024):
 before=facts(path,mode=0o600,maximum=maximum);fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  with os.fdopen(fd,'rb',closefd=False) as f:raw=f.read(maximum+1)
  need(identity(before)==identity(os.fstat(fd))==identity(facts(path,mode=0o600)) and len(raw)==before.st_size and sha(raw)==pin,'EXACT_PROOF_INPUT_BYTES_REQUIRED');return raw
 finally:os.close(fd)
def file_sha(path):
 before=facts(path,mode=0o600,maximum=1024**3);h=hashlib.sha256();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK);size=0
 try:
  with os.fdopen(fd,'rb',closefd=False) as f:
   while True:
    raw=f.read(65536)
    if not raw:break
    size+=len(raw);need(size<=before.st_size,'COPY_FILE_GREW');h.update(raw)
  need(size==before.st_size and identity(before)==identity(os.fstat(fd))==identity(facts(path,mode=0o600)),'PRIVATE_COPY_BYTES_RACED');return h.hexdigest()
 finally:os.close(fd)
def code_guard():
 facts(CODE,True,0o700);need({p.name for p in CODE.iterdir()}=={*CODE_PINS,'COPY_ONLY_MANIFEST.json'},'CLOSED_COPY_R10_CODE_REQUIRED')
 m=json.loads(read_pinned(CODE/'COPY_ONLY_MANIFEST.json',MANIFEST_SHA))
 need(set(m)=={'files','fullGuardAccepted','liveApplyEnabled','namespace','runtimeAuthorization','schema','status'} and m['namespace']==NAME and m['schema']==1 and m['status']=='CODE_ONLY_NOT_RUNTIME_AUTHORIZATION' and m['runtimeAuthorization']is m['fullGuardAccepted']is m['liveApplyEnabled']is False and set(m['files'])==set(CODE_PINS),'EXACT_COPY_R10_MANIFEST_REQUIRED')
 for name,pin in CODE_PINS.items():
  raw=read_pinned(CODE/name,pin);need(m['files'][name]=={'bytes':len(raw),'sha256':pin},'CLOSED_R10_CODE_PIN_CHANGED')
def artifacts():
 facts(ROOT,True,0o755);facts(FOLDER,True,0o700)
 need({p.name for p in FOLDER.iterdir()}==COPY_FILES,'FRESH_CLOSED_COPY_AREA_REQUIRED_NO_RETRY')
 values={name:json.loads(read_pinned(FOLDER/name,pin)) for name,pin in PINS.items()}
 return values
def validated_documents(values):
 bp,p,d,copy,prepared=(values[n] for n in ('backup-proof.json','preview.json','dryrun.json','COPY_ONLY.json','PREPARED.json'))
 need(p['status']=='SQLITE_COPY_PREVIEW_NOT_ACCEPTANCE' and d['status']=='SQLITE_COPY_DRYRUN_ROLLED_BACK_NOT_ACCEPTANCE' and bp['status']=='VERIFIED_PRIVATE_SQLITE_BACKUP' and prepared['status']=='PRIVATE_COPY_PREPARED_NOT_ACTION_AUTHORIZATION' and copy['status']=='COPY_ONLY_NOT_RUNTIME_AUTHORIZATION','EXACT_COPY_PROOF_STATUSES_REQUIRED')
 need(all(v['scopeSha256']==SCOPE for v in values.values()) and p['snapshotSha256']==d['snapshotSha256']==bp['snapshotSha256']==copy['snapshotSha256'] and p['schemaSha256']==d['schemaSha256']==bp['schemaSha256'],'EXACT_COPY_SCOPE_SNAPSHOT_SCHEMA_BINDING_REQUIRED')
 for name,key in [('backup-proof.json','backupProof'),('preview.json','preview'),('dryrun.json','dryrun')]:
  expected={'path':str(FOLDER/name),'sha256':PINS[name]};need(copy[key]==prepared[key]==expected,'EXACT_COPY_ARTIFACT_LINK_REQUIRED')
 need(copy['namespace']==NAME and copy['guardImage']==prepared['guardImage']==bp['guardImage']==IMAGE and copy['inheritedPrepared']=={'path':str(FOLDER/'PREPARED.json'),'status':prepared['status']},'EXACT_R10_COPY_NAMESPACE_IMAGE_REQUIRED')
 need(copy['runtimeDatabaseWrites']==prepared['runtimeDatabaseWrites']==0 and copy['fullGuardAccepted']is copy['nativeInspectExecuted']is copy['deletionAdmissionCompatible']is copy['cleanupAcceptance']is copy['liveApplyEnabled']is copy['automaticRetry']is copy['automaticRestore']is False,'COPY_ONLY_NOT_DELETION_AUTHORIZATION_REQUIRED')
 need(copy['sourceQueryOnlyBeforeAfter']is copy['sourceScopeBeforeAfterEqual']is copy['privateBackupDryrunFullRowsEqual']is copy['consistentCommittedWal']is bp['consistentCommittedWal']is bp['privateRoot0600']is True and copy['sourceConnectionTotalChanges']==0 and copy['quickCheck']==bp['quickCheck']=='ok' and copy['foreignKeyViolations']==bp['foreignKeyViolations']==0 and digest(copy['privateCopyFullRowsSha256']),'EXACT_COPY_READONLY_ROLLBACK_PROOF_REQUIRED')
 safe={k:v for k,v in p.items() if k not in ('status','createdAtUtc')};need(safe=={k:v for k,v in d.items() if k not in ('status','createdAtUtc')},'EXACT_PREVIEW_DRYRUN_RESULT_REQUIRED')
 need(p['cleanupAcceptance']is p['liveApplyEnabled']is False and prepared['cleanupAcceptance']is prepared['liveApplyEnabled']is False,'COPY_RESULT_NOT_LIVE_ACCEPTANCE_REQUIRED')
 need(p['legacyDialogIds']==[1] and [r['id'] for r in p['orderMap']]==list(range(18,29)) and all(set(r)=={'id','requestUuidSha256'} and digest(r['requestUuidSha256']) for r in p['orderMap']),'EXACT_ELEVEN_ORDER_SCOPE_REQUIRED')
 threads=p['threadMap'];need(len(threads)==11 and [r['id'] for r in threads]==list(range(10,21)) and sorted(r['orderId'] for r in threads)==list(range(18,29)) and all(set(r)=={'id','orderId'} and type(r['id'])is int and type(r['orderId'])is int for r in threads),'EXACT_ELEVEN_THREAD_MAP_REQUIRED')
 need(type(p['targetCounts'])is dict and all(type(v)is int and v>=0 for v in p['targetCounts'].values()) and p['targetCounts']['site_orders']==p['targetCounts']['chat_threads']==11 and p['targetCounts']['client_dialogs']==1 and all(p['targetCounts'][t]==0 for t in ('chat_thread_attachments','client_dialog_attachments','chat_web_uploads')),'EXACT_SELECTED_ZERO_MEDIA_SCOPE_REQUIRED')
 need(bp['backupPath']==str(FOLDER/'before.sqlite') and bp['databasePath']=='/var/lib/docker/volumes/synapse_content_data/_data/content.sqlite' and digest(bp['backupSha256']) and type(p['sessionsRetained'])is int and p['sessionsRetained']>=0,'EXACT_PRIVATE_BACKUP_BINDING_REQUIRED')
 return bp,p
def query_summary(db,preview):
 need(db.total_changes==0 and not db.in_transaction,'UNTOUCHED_PRIVATE_READONLY_CONNECTION_REQUIRED')
 db.execute('PRAGMA query_only=ON');db.execute('PRAGMA foreign_keys=ON');db.execute('PRAGMA busy_timeout=0')
 need(db.execute('PRAGMA query_only').fetchone()==(1,) and db.execute('PRAGMA quick_check').fetchall()==[('ok',)] and db.execute('PRAGMA foreign_key_check').fetchall()==[],'PRIVATE_COPY_SQLITE_INTEGRITY_REQUIRED')
 orders=db.execute("SELECT id FROM site_orders WHERE site='palitra' OR company_code='palitra-love' ORDER BY id").fetchall();need(orders==[(i,) for i in range(18,29)],'GLOBAL_COPY_ORDER_IDS_CHANGED')
 owned=db.execute("SELECT count(*) FROM site_orders WHERE site='palitra' AND company_code='palitra-love'").fetchone()[0];need(owned==11,'COPY_ORDER_COMPANY_CHANGED')
 threads=db.execute("SELECT id,order_id,site='palitra' AND company_code='palitra-love' FROM chat_threads WHERE site='palitra' OR company_code='palitra-love' ORDER BY id").fetchall();need(threads==[(r['id'],r['orderId'],1) for r in preview['threadMap']],'COPY_NATIVE_ORDER_MAP_CHANGED')
 legacy=db.execute("SELECT id,order_id FROM client_dialogs WHERE company_code='palitra-love' ORDER BY id").fetchall();need(legacy==[(1,None)],'EXACT_STANDALONE_LEGACY_COPY_REQUIRED')
 count=lambda sql:db.execute(sql).fetchone()[0]
 native="SELECT id FROM chat_threads WHERE site='palitra' AND company_code='palitra-love'"
 mids='SELECT id FROM chat_thread_messages WHERE thread_id IN ('+native+')'
 lmids='SELECT id FROM client_dialog_messages WHERE dialog_id=1'
 actual={'site_orders':len(orders),'chat_threads':len(threads),'client_dialogs':len(legacy),'chat_thread_messages':count('SELECT count(*) FROM chat_thread_messages WHERE thread_id IN ('+native+')'),'client_dialog_messages':count('SELECT count(*) FROM client_dialog_messages WHERE dialog_id=1'),'chat_thread_attachments':count('SELECT count(*) FROM chat_thread_attachments WHERE thread_id IN ('+native+')'),'client_dialog_attachments':count('SELECT count(*) FROM client_dialog_attachments WHERE dialog_id=1 OR message_id IN ('+lmids+')'),'chat_web_uploads':count('SELECT count(*) FROM chat_web_uploads WHERE thread_id IN ('+native+') OR dialog_id=1 OR thread_message_id IN ('+mids+') OR legacy_message_id IN ('+lmids+')')}
 need(all(actual[k]==preview['targetCounts'][k] for k in actual),'ACTUAL_COPY_COUNTS_DO_NOT_MATCH_PREVIEW')
 need(actual['chat_thread_attachments']==actual['client_dialog_attachments']==actual['chat_web_uploads']==0,'SELECTED_DISK_REFERENCE_REQUIRES_NEW_REVIEW')
 sessions=count('SELECT count(*) FROM chat_web_sessions');need(sessions==preview['sessionsRetained'] and db.total_changes==0 and not db.in_transaction,'COPY_SESSIONS_OR_READONLY_STATE_CHANGED')
 return {'orderIds':[r[0] for r in orders],'threadMap':preview['threadMap'],'legacyDialogIds':[1],'counts':actual,'messages':actual['chat_thread_messages']+actual['client_dialog_messages'],'sessionsRetained':sessions,'refs':['order:'+str(r[0]) for r in orders]+['thread:'+str(r[0]) for r in threads]+['legacy:1']}
def run(args):
 result=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,timeout=25)
 need(result.returncode==0 and not result.stderr and len(result.stdout)<=65536,'READONLY_DOCKER_PROBE_REFUSED');return result.stdout
def lease(pid,ticks):
 need(type(pid)is int and pid>1 and type(ticks)is str and re.fullmatch('[1-9][0-9]*',ticks),'ACTUAL_LEASE_ARGUMENTS_REQUIRED')
 raw=run(['lslocks','--noheadings','--output','PID,PATH']);rows=[r.strip().split(maxsplit=1) for r in raw.decode().splitlines() if len(r.strip().split(maxsplit=1))==2 and r.strip().split(maxsplit=1)[1]==LOCK]
 need(rows==[[str(pid),LOCK]],'EXACT_OWN_SINGLE_LEASE_REQUIRED')
 text=Path('/proc/'+str(pid)+'/stat').read_text();need(text.rsplit(')',1)[1].split()[19]==ticks,'LEASE_START_TICKS_CHANGED')
def storage_path():
 need(run(['docker','inspect','--format','{{.Image}}','synapse-content-1']).decode().strip()==IMAGE,'CURRENT_DOCKER_IMAGE_CHANGED')
 env=json.loads(run(['docker','exec','synapse-content-1','node','-e',ENV_JS]));need(set(env)=={'database','assets'} and env['database']=='/data/content.sqlite','ONLY_EXPECTED_STORAGE_ENV_REQUIRED')
 assets=env['assets'];p=PurePosixPath(assets) if type(assets)is str else None
 need(p is not None and p.is_absolute() and p.as_posix()==assets and '..' not in p.parts and p.is_relative_to('/data'),'EXACT_ASSETS_VOLUME_PATH_REQUIRED')
 return Path('/var/lib/docker/volumes/synapse_content_data/_data')/p.relative_to('/data')/'client-dialogs'
def aggregate_storage(path):
 path=Path(path)
 for part in (path,*path.parents):need(not part.is_symlink(),'STORAGE_ROOT_ALIAS_REFUSED')
 value={'exists':path.exists(),'entries':0,'regularFiles':0,'directories':0,'symlinks':0,'other':0,'temporaryFiles':0,'bytes':0,'scanScope':'DIRECT_ENTRIES_ONLY','complete':True}
 if not value['exists']:return value
 need(path.is_dir() and path.resolve()==path,'EXACT_CLIENT_DIALOGS_STORAGE_REQUIRED');before=path.stat()
 with os.scandir(path) as entries:
  for item in entries:
   value['entries']+=1;need(value['entries']<=100000,'STORAGE_AGGREGATE_ENTRY_BOUND');s=item.stat(follow_symlinks=False)
   if stat.S_ISREG(s.st_mode):value['regularFiles']+=1;value['bytes']+=s.st_size
   elif stat.S_ISDIR(s.st_mode):value['directories']+=1
   elif stat.S_ISLNK(s.st_mode):value['symlinks']+=1
   else:value['other']+=1
   if re.fullmatch(r'[.][a-f0-9-]+[.][a-f0-9]+[.]part',item.name):value['temporaryFiles']+=1
   need(value['bytes']<=2147483648,'STORAGE_AGGREGATE_BYTE_BOUND')
 after=path.stat();value['complete']=all(getattr(before,k)==getattr(after,k) for k in ('st_dev','st_ino','st_mtime_ns','st_ctime_ns'));return value
def new_proof(path,value):
 raw=(json.dumps(value,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode();need(len(raw)<=65536,'DISK_PROOF_BOUND_EXCEEDED')
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
 need(read_pinned(path,sha(raw))==raw,'NEW_EXCL_DISK_PROOF_READBACK_REQUIRED');return sha(raw)
def prove(pid,ticks):
 lease(pid,ticks);code_guard();values=artifacts();bp,preview=validated_documents(values);backup=FOLDER/'before.sqlite';before_identity=identity(facts(backup,mode=0o600));need(file_sha(backup)==bp['backupSha256'],'EXACT_IMMUTABLE_BACKUP_SHA_REQUIRED')
 need(not any(Path(str(backup)+suffix).exists() for suffix in ('-wal','-shm','-journal')),'SELF_CONTAINED_IMMUTABLE_BACKUP_REQUIRED')
 db=sqlite3.connect(backup.as_uri()+'?mode=ro&immutable=1',uri=True)
 try:summary=query_summary(db,preview)
 finally:db.close()
 storage=storage_path();aggregate=aggregate_storage(storage);need(file_sha(backup)==bp['backupSha256'] and identity(facts(backup,mode=0o600))==before_identity,'IMMUTABLE_BACKUP_CHANGED_DURING_PROOF');code_guard();need(artifacts()==values,'COPY_ARTIFACTS_CHANGED_DURING_PROOF');lease(pid,ticks);need(storage_path()==storage,'STORAGE_BINDING_CHANGED_DURING_PROOF')
 proof={'schema':1,'status':'ROOT_READONLY_SELECTED_MEDIA_DISK_CHECK_PASSED','scopeSha256':SCOPE,'snapshotSha256':preview['snapshotSha256'],'guardImage':IMAGE,'filesOnDiskChecked':True,'selectedAttachments':0,'selectedUploads':0,'selectedDiskFiles':0,'selectedDiskRefs':0,'allStorageClaimedEmpty':False,'storageAggregate':aggregate,'backupSha256':bp['backupSha256'],'copyProofPins':PINS,'copyCodeManifestSha256':MANIFEST_SHA,'source':'PRIVATE_IMMUTABLE_BEFORE_SQLITE_ONLY','lease':{'pid':pid,'startTicks':ticks},'runtimeDatabaseWrites':0,'actualDeletionPerformed':False,'runtimeAuthorization':False,'capturedAtUtc':stamp()}
 pin=new_proof(FOLDER/'disk-proof.json',proof);need({p.name for p in FOLDER.iterdir()}==COPY_FILES|{'disk-proof.json'},'POST_PROOF_COPY_DIRECTORY_CHANGED')
 summary.update(status='ROOT_R10_PRIVATE_COPY_AND_SELECTED_DISK_VERIFIED_NOT_DELETED',scopeSha256=SCOPE,snapshotSha256=preview['snapshotSha256'],guardImage=IMAGE,diskProof={'path':str(FOLDER/'disk-proof.json'),'sha256':pin},copyProofPins=PINS,copyCodeManifestSha256=MANIFEST_SHA,runtimeDatabaseWrites=0,actualDeletionPerformed=False,runtimeAuthorization=False,fullGuardAccepted=False,liveApplyEnabled=False)
 return summary
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--write-disk-proof',action='store_true');parser.add_argument('--lease-pid',type=int,required=True);parser.add_argument('--lease-start-ticks',required=True);args=parser.parse_args()
 need(args.write_disk_proof is True and os.name=='posix' and os.geteuid()==os.getegid()==0,'EXPLICIT_POSIX_ROOT_SELECTED_PROOF_REQUIRED')
 print(json.dumps(prove(args.lease_pid,args.lease_start_ticks),ensure_ascii=False,sort_keys=True))
if __name__=='__main__':
 try:main()
 except BaseException as error:
  code=str(error) if type(error)is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,120}',str(error)) else 'COPY_DISK_PROOF_REFUSED_NO_RETRY'
  print(json.dumps({'status':'COPY_DISK_PROOF_REFUSED_NOT_DELETION_AUTHORIZATION','code':code,'runtimeDatabaseWrites':0,'actualDeletionPerformed':False,'automaticRetry':False}));raise SystemExit(2)
