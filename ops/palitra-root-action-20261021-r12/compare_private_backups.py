"""Readonly comparison of the approved old selection and a new private copy.

No live content DB, proof/admission creation, mutate/dryrun/apply call, restore
or networking exists. Native main is intended ONLY for separate Root review.
"""
import argparse,hashlib,json,os,re,sqlite3,stat,subprocess,sys,types
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
CODE=ROOT/'palitra-order-cleanup-copy-20261021-r10-code'
OLD_AREA=ROOT/'palitra-order-cleanup-copy-20261021-r10-90c225bf0dfa540a6943bd75aa8401fa'
OLD_PROOF_SHA='578ef78e575da91b35c6aebd8c1c9c9a7b58718b464b8acc3ea0b19a893de6d4'
OLD_SCOPE='b2ea3bed6bd0d74f9a4ab46ad798dde1f6d41c25d3d44ac059763000b8b6b58a'
OLD_SNAPSHOT='ca3fb254644649c6142f757f3735600f64b3cfe2cc2449c3b957d8ca4f7b82a5'
ENGINE_SHA='6bd4b9f29ff1ffd4e553750d43df437444b5651485748e1eeca82163c8259861'
IMAGE='sha256:951db09e9e6c4781350bbced7e7a9e4ef099077a368e38a6b1fac40e0a4a6a22'
LOCK='/opt/synapse/.palitra-app-release.lock'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def need(ok,code):
 if not ok:raise ValueError(code)
def file_facts(path,maximum):
 path=Path(path);need(path.is_absolute() and '..' not in path.parts and path.is_relative_to(ROOT),'EXACT_PRIVATE_RELEASE_FILE_REQUIRED')
 for part in (path,*path.parents):need(not part.is_symlink(),'PRIVATE_BACKUP_ALIAS_REFUSED')
 s=path.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<=maximum,'ROOT600_SINGLE_BOUNDED_FILE_REQUIRED');return s
def identity(s):return tuple(getattr(s,k)for k in ('st_dev','st_ino','st_mode','st_nlink','st_uid','st_gid','st_size','st_mtime_ns','st_ctime_ns'))
def checked_file_sha(path,pin,maximum=2*1024**3):
 need(type(pin)is str and re.fullmatch('[a-f0-9]{64}',pin),'EXACT_BACKUP_PIN_REQUIRED');before=file_facts(path,maximum);h=hashlib.sha256();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  with os.fdopen(fd,'rb',closefd=False)as f:
   for value in iter(lambda:f.read(65536),b''):h.update(value)
  need(identity(before)==identity(os.fstat(fd))==identity(file_facts(path,maximum)) and h.hexdigest()==pin,'EXACT_IMMUTABLE_PRIVATE_FILE_REQUIRED')
 finally:os.close(fd)
 return before
def read_json(path,pin):
 checked_file_sha(path,pin,4194304);raw=Path(path).read_bytes();need(len(raw)<=4194304 and sha(raw)==pin,'EXACT_JSON_PROOF_BYTES_REQUIRED');return json.loads(raw)
def selection(E,planned):
 scope=planned['scope'];fields=('schemaSha256','orderMap','threadMap','legacyDialogIds','targets','documents','tombstoneKeys','businessOutboxBeforeAudit')
 return {key:scope[key]for key in fields}
def compare_plans(E,old,fresh):
 before=selection(E,old);after=selection(E,fresh)
 need(before==after,'SELECTED_ROWS_OR_SCHEMA_CHANGED_REVIEW_REQUIRED')
 return {'schema':'palitra-root-readonly-selected-comparison/v1','status':'SELECTED_SCOPE_UNCHANGED_NOT_USER_PROOF_NOT_ADMISSION','selectedRowsUnchanged':True,'schemaUnchanged':True,'selectedFingerprintSha256':E.sha(before),'oldScopeSha256':old['scopeSha256'],'freshScopeSha256':fresh['scopeSha256'],'oldSnapshotSha256':old['scope']['snapshotSha256'],'freshSnapshotSha256':fresh['scope']['snapshotSha256'],'globalFingerprintChanged':old['scopeSha256']!=fresh['scopeSha256'],'runtimeAuthorization':False,'userProofCreated':False,'admissionCreated':False,'databaseWrites':0}
def require_authorized_counts(E,planned):
 public=E.public(planned,'READONLY_SELECTION_COMPARISON_ONLY');counts=public['targetCounts']
 need([r['id']for r in public['orderMap']]==list(range(18,29)) and [r['id']for r in public['threadMap']]==list(range(10,21))
      and public['legacyDialogIds']==[1] and counts['site_orders']==counts['chat_threads']==11 and counts['client_dialogs']==1
      and counts['chat_thread_messages']==39 and counts['client_dialog_messages']==10 and counts['site_order_outbox']==14 and counts['client_bot_outbox']==10
      and counts['chat_thread_attachments']==counts['client_dialog_attachments']==counts['chat_web_uploads']==0,'HUMAN_CONFIRMED_EXACT_11_49_24_SCOPE_REQUIRED')
def plan_backup(E,path,proof):
 need(proof['status']=='VERIFIED_PRIVATE_SQLITE_BACKUP' and proof['guardImage']==IMAGE and proof['backupPath']==str(path)
      and proof['databasePath']=='/var/lib/docker/volumes/synapse_content_data/_data/content.sqlite' and proof['consistentCommittedWal']is True
      and proof['quickCheck']=='ok' and proof['foreignKeyViolations']==0,'EXACT_PRIVATE_BACKUP_PROOF_REQUIRED')
 checked_file_sha(path,proof['backupSha256']);need(not any(Path(str(path)+s).exists()for s in ('-wal','-shm','-journal')),'SELF_CONTAINED_PRIVATE_BACKUP_REQUIRED')
 db=sqlite3.connect(path.as_uri()+'?mode=ro&immutable=1',uri=True)
 try:
  db.execute('PRAGMA query_only=ON');db.execute('PRAGMA foreign_keys=ON');db.execute('PRAGMA busy_timeout=0');planned=E.plan(db)
  need(planned['scopeSha256']==proof['scopeSha256'] and planned['scope']['snapshotSha256']==proof['snapshotSha256'] and db.total_changes==0 and not db.in_transaction,'PRIVATE_BACKUP_PROOF_SCOPE_OR_READONLY_CHANGED')
 finally:db.close()
 checked_file_sha(path,proof['backupSha256']);return planned
def held_lease(pid,start):
 need(type(pid)is int and pid>1 and type(start)is str and re.fullmatch('[1-9][0-9]*',start),'FRESH_ROOT_LEASE_ARGUMENTS_REQUIRED')
 r=subprocess.run(['lslocks','--noheadings','--output','PID,PATH'],capture_output=True,check=True,timeout=10);need(not r.stderr and len(r.stdout)<1048576,'BOUNDED_LOCK_OBSERVATION_REQUIRED')
 rows=[row.strip().split(maxsplit=1)for row in r.stdout.decode().splitlines()]
 need([row for row in rows if len(row)==2 and row[1]==LOCK]==[[str(pid),LOCK]],'EXACT_ROOT_LEASE_NOT_HELD')
 raw=(Path('/proc')/str(pid)/'stat').read_text();need(len(raw)<=8192 and raw.rsplit(') ',1)[1].split()[19]==start,'LEASE_PROCESS_REUSED')
def main(argv=None):
 p=argparse.ArgumentParser(description='Readonly old-approved/fresh-private selection comparison; no proof writes')
 p.add_argument('--compare-private-backups',action='store_true');p.add_argument('--fresh-backup-proof',type=Path,required=True);p.add_argument('--fresh-backup-proof-sha',required=True);p.add_argument('--lease-pid',type=int,required=True);p.add_argument('--lease-start-ticks',required=True)
 a=p.parse_args(argv);need(a.compare_private_backups is True and os.name=='posix' and os.geteuid()==0,'EXPLICIT_ROOT_READONLY_COMPARISON_REQUIRED');held_lease(a.lease_pid,a.lease_start_ticks)
 fresh_area=a.fresh_backup_proof.parent;need(a.fresh_backup_proof.name=='backup-proof.json' and fresh_area.parent==ROOT and fresh_area!=OLD_AREA
      and re.fullmatch('palitra-order-cleanup-copy-20261021-r10-[a-f0-9]{32}',fresh_area.name),'NEW_ROOT_COPY_R10_AREA_REQUIRED')
 checked_file_sha(CODE/'cleanup_runtime.py',ENGINE_SHA,4194304);raw=(CODE/'cleanup_runtime.py').read_bytes();need(sha(raw)==ENGINE_SHA,'EXACT_UNCHANGED_ENGINE_REQUIRED')
 E=types.ModuleType('reviewed_readonly_engine');E.__file__=str(CODE/'cleanup_runtime.py');exec(compile(raw,E.__file__,'exec'),E.__dict__)
 old=read_json(OLD_AREA/'backup-proof.json',OLD_PROOF_SHA);fresh=read_json(a.fresh_backup_proof,a.fresh_backup_proof_sha)
 oldplan=plan_backup(E,OLD_AREA/'before.sqlite',old);newplan=plan_backup(E,fresh_area/'before.sqlite',fresh)
 need(oldplan['scopeSha256']==OLD_SCOPE and oldplan['scope']['snapshotSha256']==OLD_SNAPSHOT,'EXACT_ORIGINALLY_APPROVED_BACKUP_REQUIRED')
 require_authorized_counts(E,oldplan);require_authorized_counts(E,newplan);result=compare_plans(E,oldplan,newplan);held_lease(a.lease_pid,a.lease_start_ticks)
 result.update(lease={'pid':a.lease_pid,'startTicks':a.lease_start_ticks},oldBackupProofSha256=OLD_PROOF_SHA,freshBackupProofSha256=a.fresh_backup_proof_sha,liveDatabaseOpened=False,currentRuntimeInspected=False)
 print(json.dumps(result,sort_keys=True))
if __name__=='__main__':
 try:main()
 except Exception as error:print(json.dumps({'status':'SELECTION_COMPARISON_REFUSED','code':str(error)if type(error)is ValueError else type(error).__name__,'runtimeAuthorization':False,'userProofCreated':False,'admissionCreated':False,'databaseWrites':0}));raise SystemExit(2)
