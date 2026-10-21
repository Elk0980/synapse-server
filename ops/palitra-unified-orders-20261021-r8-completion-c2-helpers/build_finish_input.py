"""Root-only C2 current-price capture and finish-input preparation.
No completion entry, Controller, service save, migration or publication runs.
"""
import argparse,hashlib,importlib,json,os,re,secrets,sqlite3,stat,subprocess,sys,time,types
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
DATA=Path('/var/lib/docker/volumes/synapse_content_data/_data')
RUNTIME='palitra-unified-orders-20261021-r8'
SAVED_COMPLETION_NAME=RUNTIME+'-completion-c1'
NAME=RUNTIME+'-completion-c2'
PACKAGE=ROOT/(RUNTIME+'-code')
COMPLETION=ROOT/(NAME+'-code')
PACKAGE_SHA='a0d12a5bc58a99c5b554d8204db26796fec3f86684ca65b3213f5de6f8e2fff0'
ENTRY_SHA='99d23faeeb8f7c0375802c0dd2b719570dc8436c98de696846a6b475a9ddd9c3'
SAVED_COMPLETION_SHA='88ecc0018d4e5d7686b89e55b4561059ba36ca5f79cfb0dce455b54364707c3e'
COMPLETION_ENTRY_SHA='a2ebbcdbb0fa27014e6d487d4d3df44b1b5451d807df42668bbeb9b7b74e1b6c'
COMPLETION_MANIFEST_SHA='45e940fbad45a24d80f69663eced983ff8f157446395c50523576401e160eb1d'
INSPECTOR_SHA='7de083ac3cf4b39c352ed7b3c60d35e447480f0ab836915d2c87482ef8125c09'
LOCK='/opt/synapse/.palitra-app-release.lock'
SITE='site-44bbe13f1bad5e005b2a'
SMALL=16*1024*1024
sha=lambda raw:hashlib.sha256(raw).hexdigest()
digest=lambda v:type(v)is str and re.fullmatch('[a-f0-9]{64}',v)is not None
encode=lambda v:(json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode()

def need(ok,code):
    if not ok:raise ValueError(code)

def identity(s):return tuple(getattr(s,k)for k in ('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns'))

def path_guard(path):
    p=Path(path);need(p.is_absolute() and p.is_relative_to(ROOT) and '..' not in p.parts,'ROOT_RELEASE_PRIVATE_PATH_REQUIRED')
    for part in (p,*p.parents):need(not part.is_symlink(),'PRIVATE_PATH_ALIAS_REFUSED')
    return p

def private_file(path,pin,*,maximum=SMALL,stream_only=False):
    p=path_guard(path);need(digest(pin),'EXACT_RAW_FILE_SHA_REQUIRED');s=p.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<=maximum,'ROOT600_BOUNDED_SINGLE_PRIVATE_FILE_REQUIRED')
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK);h=hashlib.sha256();parts=[];size=0
    try:
        need(identity(s)==identity(os.fstat(fd)),'PRIVATE_FILE_OPEN_RACE')
        with os.fdopen(fd,'rb',closefd=False)as f:
            for block in iter(lambda:f.read(65536),b''):
                size+=len(block);need(size<=maximum,'PRIVATE_FILE_READ_BOUND');h.update(block)
                if not stream_only:parts.append(block)
        need(size==s.st_size and identity(s)==identity(os.fstat(fd))==identity(p.lstat()) and h.hexdigest()==pin,'PRIVATE_FILE_CHANGED_OR_SHA_MISMATCH')
    finally:os.close(fd)
    return size if stream_only else b''.join(parts)

def checked_ref(ref,*,json_value=True):
    need(type(ref)is dict and set(ref)=={'path','sha256'},'EXACT_PRIVATE_FILE_REFERENCE_REQUIRED')
    raw=private_file(ref['path'],ref['sha256'])
    return json.loads(raw)if json_value else raw

def held(pid,ticks):
    need(type(pid)is int and pid>1 and type(ticks)is str and re.fullmatch('[1-9][0-9]*',ticks),'ACTUAL_ROOT_LEASE_ARGUMENTS_REQUIRED')
    r=subprocess.run(['lslocks','-n','-o','PID,PATH'],check=True,capture_output=True,timeout=10)
    need(not r.stderr and len(r.stdout)<=1048576,'BOUNDED_LEASE_READ_REQUIRED')
    rows=[line.split(maxsplit=1)for line in r.stdout.decode().splitlines()]
    need([row for row in rows if len(row)==2 and row[1]==LOCK]==[[str(pid),LOCK]],'EXACT_SINGLE_HELD_ROOT_LEASE_REQUIRED')
    text=(Path('/proc')/str(pid)/'stat').read_text()
    need(len(text)<=8192 and text.rsplit(')',1)[1].split()[19]==ticks,'ROOT_LEASE_PROCESS_REUSED')
    return {'pid':pid,'startTicks':ticks}

def load_validators():
    raw=private_file(PACKAGE/'native_entry.py',ENTRY_SHA)
    native=types.ModuleType('root_readonly_package_validator');native.__file__=str(PACKAGE/'native_entry.py')
    exec(compile(raw,native.__file__,'exec'),native.__dict__)
    package,manifest=native.load_package(PACKAGE,PACKAGE_SHA)
    names=('manifest_inputs','schema_migration','private_files','install_protocol','post_cleanup_basis')
    need(not any(name in sys.modules for name in names),'FRESH_ROOT_BUILDER_PROCESS_REQUIRED')
    sys.path.insert(0,str(PACKAGE));modules={name:importlib.import_module(name)for name in names}
    for name,m in modules.items():
        need(Path(m.__file__)==PACKAGE/(name+'.py'),'EXACT_LOADED_FROZEN_R5_MODULE_REQUIRED')
        private_file(m.__file__,manifest['files'][name+'.py'])
    return native,package,modules['install_protocol'],modules['post_cleanup_basis'],modules['manifest_inputs']

def inspector_code(directory):
    directory=path_guard(directory);need(directory.parent==ROOT,'DIRECT_ROOT_INSPECTOR_DIRECTORY_REQUIRED')
    s=directory.lstat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o700,'ROOT700_INSPECTOR_CODE_REQUIRED')
    manifest=json.loads(private_file(directory/'readonly-code-pins.json',INSPECTOR_SHA))
    need(manifest.get('runtimeAuthorization')is False and type(manifest.get('files'))is dict and len(manifest['files'])==14,'EXACT_R6_CODE_MANIFEST_REQUIRED')
    need({p.name for p in directory.iterdir()}==set(manifest['files'])|{'readonly-code-pins.json'},'CLOSED_R6_CODE_REQUIRED')
    for name,pin in manifest['files'].items():
        need(Path(name).name==name,'INSPECTOR_BASENAME_REQUIRED');private_file(directory/name,pin)

def new_file(path,raw):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
    ref={'path':str(path),'sha256':sha(raw)};need(private_file(path,ref['sha256'])==raw,'NEW_ROOT_INPUT_READBACK_REQUIRED');return ref

def native_outcome(ref):
    need(type(ref)is dict and set(ref)=={'path','sha256'}and digest(ref['sha256']),'ACTUAL_NATIVE_OUTCOME_REFERENCE_REQUIRED')
    path=Path(ref['path']);need(path==DATA/(SAVED_COMPLETION_NAME+'-save')/'NATIVE_SAVE_OUTCOME.json','EXACT_NATIVE_OUTCOME_PRIVATE_PATH_REQUIRED')
    for part in (path,*path.parents):need(not part.is_symlink(),'NATIVE_OUTCOME_ALIAS_REFUSED')
    s=path.lstat();need(stat.S_ISREG(s.st_mode)and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<=4*1024*1024,'ROOT600_NATIVE_OUTCOME_REQUIRED')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        with os.fdopen(fd,'rb',closefd=False)as f:raw=f.read(4*1024*1024+1)
        need(identity(s)==identity(os.fstat(fd))==identity(path.lstat())and len(raw)==s.st_size and sha(raw)==ref['sha256'],'NATIVE_OUTCOME_CHANGED_OR_HASH_MISMATCH')
    finally:os.close(fd)
    return json.loads(raw)

def historical_action(value,mode,package_sha):
    need(value.get('schema')=='palitra-unified-root-action/v1'and value.get('status')=='ROOT_AUTHORIZED_ONE_ATTEMPT'and value.get('mode')==mode and value.get('namespace')==RUNTIME and value.get('packageSha256')==package_sha and value.get('runtimeAuthorization')is True,'EXACT_COMPLETED_PREDECESSOR_ACTION_REQUIRED')
    # Completed predecessor times are immutable, never renewed or used as current authorization.
    return value['bindings']

def pending_chain(package,I,apply,apply_ref,pending,pending_ref,plan,plan_ref):
    bindings=historical_action(apply,'apply',PACKAGE_SHA);I.validate_bindings('apply',bindings)
    I.require_native_plan(plan,package)
    need(bindings.get('managedAdoptionPlan')==plan_ref and bindings.get('compatibilityInspectorManifestSha256')==INSPECTOR_SHA,'APPLY_MUST_BIND_SAME_NATIVE_PLAN_AND_INSPECTOR')
    need(pending.get('schema')=='palitra-unified-pending-native-adoption/v1'and pending.get('status')=='RUNTIME_CODE_SCHEMA_READY_REQUIRES_NATIVE_WORKSPACE_ADOPTION'and pending.get('runtimeAcceptance')is False and pending.get('packageSha256')==PACKAGE_SHA and pending.get('rootActionSha256')==apply_ref['sha256']and pending.get('mapSha256')==package['map']['closureSha256'],'ACTUAL_COMPLETED_APPLY_AND_PENDING_REQUIRED')
    need(pending.get('managedAdoptionPlanSha256')==plan_ref['sha256']and pending.get('managedAdoptionTransport')==plan['transport']=='native-workspace-service'and pending.get('managedAdoptionBaseRevision')==plan['baseRevision'],'SAME_NATIVE_SERVICE_PLAN_THROUGH_FOLLOWUP_REQUIRED')
    need(pending.get('automaticRetry')is False and pending.get('automaticRestore')is False and pending.get('child',{}).get('oneCopyLayer')is True and pending.get('child',{}).get('parentImage')==apply['parentImage']and pending.get('migration',{}).get('nativeCommitStatus')=='SCHEMA_COMMITTED_WITH_PROTECTED_CONTENT_PRESERVED','EXACT_APPLIED_CHILD_AND_SCHEMA_REQUIRED')
    return sha(I.encoded(pending))

def actual_ref(path):
    """Derive a raw SHA from actual ROOT600 bytes; never transcribe evidence."""
    path=path_guard(path);s=path.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<=SMALL,'ROOT600_ACTUAL_INPUT_REQUIRED')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        need(identity(s)==identity(os.fstat(fd)),'ACTUAL_INPUT_OPEN_RACE')
        with os.fdopen(fd,'rb',closefd=False) as f:raw=f.read(SMALL+1)
        need(len(raw)==s.st_size and identity(s)==identity(os.fstat(fd))==identity(path.lstat()),'ACTUAL_INPUT_READ_RACE')
    finally:os.close(fd)
    ref={'path':str(path),'sha256':sha(raw)}
    need(private_file(path,ref['sha256'])==raw,'ACTUAL_INPUT_CHANGED');return ref,json.loads(raw)

def price_capture(connection,lease,revision,nonce,clock=time.time):
    """One readonly SQLite snapshot; body exists in memory only, never output."""
    need(not connection.in_transaction and digest(revision) and digest(nonce),'FRESH_READONLY_PRICE_CAPTURE_REQUIRED')
    connection.execute('PRAGMA query_only=ON')
    allowed_tables={'documents','managed_sites','site_workspaces','site_workspace_revisions'}
    def authorize(operation,first,second,database,trigger):
        if operation==sqlite3.SQLITE_SELECT:return sqlite3.SQLITE_OK
        if operation==sqlite3.SQLITE_READ and database=='main' and first in allowed_tables:return sqlite3.SQLITE_OK
        if operation==sqlite3.SQLITE_FUNCTION and second=='length':return sqlite3.SQLITE_OK
        if operation==sqlite3.SQLITE_TRANSACTION and first in ('BEGIN','ROLLBACK'):return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY
    connection.set_authorizer(authorize)
    try:
        connection.execute('BEGIN')
        workspace=connection.execute('SELECT m.company_code,w.current_revision,r.version FROM managed_sites m JOIN site_workspaces w ON w.site_id=m.id JOIN site_workspace_revisions r ON r.site_id=w.site_id AND r.revision=w.current_revision WHERE m.id=?',(SITE,)).fetchall()
        need(workspace==[('palitra-love',revision,261)],'ACTUAL_SAVED_NATIVE261_POINTER_REQUIRED')
        rows=connection.execute('SELECT id,version,CASE WHEN length(CAST(body AS BLOB)) BETWEEN 1 AND ? THEN body ELSE NULL END FROM documents WHERE key=? ORDER BY version DESC LIMIT 1',(SMALL,'palitra/price')).fetchall()
        need(len(rows)==1,'CURRENT_API_PRICE_DOCUMENT_REQUIRED');document_id,version,body=rows[0]
        need(type(document_id) is int and type(version) is int and 0<document_id<=9007199254740991 and 0<version<=9007199254740991 and type(body) is str,'EXACT_API_PRICE_METADATA_TYPES_REQUIRED')
        raw=body.encode('utf-8');need(0<len(raw)<=SMALL,'BOUNDED_CURRENT_API_PRICE_REQUIRED')
        document={'id':document_id,'version':version,'sha256':sha(raw),'bytes':len(raw)}
        return {'schema':'palitra-completion-current-api-price/v1','key':'palitra/price','document':document,'nonce':nonce,'lease':lease,'capturedAtUnix':clock(),'runtimePackageSha256':PACKAGE_SHA,'savedCompletionManifestSha256':SAVED_COMPLETION_SHA,'currentRevision':revision,'currentVersion':261,'runtimeWrites':0,'runtimeAuthorization':False}
    finally:
        if connection.in_transaction:connection.execute('ROLLBACK')

def capture_actual_price(lease,revision,nonce):
    """Called only by Root on Linux; URI readOnly and query_only, no DML."""
    path=DATA/'content.sqlite'
    for part in (path,*path.parents):need(not part.is_symlink(),'CONTENT_PRICE_CAPTURE_ALIAS_REFUSED')
    def file_identity():
        s=path.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o644 and s.st_size<=512*1024*1024,'EXACT_CONTENT_PRICE_CAPTURE_FILE_REQUIRED')
        # Normal WAL traffic may change size/times; inode/owner/mode cannot.
        return tuple(getattr(s,k) for k in ('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink'))
    before=file_identity();held(lease['pid'],lease['startTicks'])
    connection=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=10,isolation_level=None)
    try:
        need(connection.execute('PRAGMA journal_mode').fetchone()==('wal',),'EXISTING_WAL_PRICE_CAPTURE_REQUIRED')
        value=price_capture(connection,lease,revision,nonce)
    finally:connection.close()
    need(file_identity()==before,'CONTENT_IDENTITY_CHANGED_DURING_PRICE_CAPTURE');held(lease['pid'],lease['startTicks']);return value

def completion_loader(pin):
    raw=private_file(COMPLETION/'completion_entry.py',COMPLETION_ENTRY_SHA)
    entry=types.ModuleType('root_prepare_c2_reviewed_entry');entry.__file__=str(COMPLETION/'completion_entry.py')
    exec(compile(raw,entry.__file__,'exec'),entry.__dict__);entry.load_completion(COMPLETION,pin)
    need(entry.RUNTIME_SHA==PACKAGE_SHA and entry.ENTRY_SHA==ENTRY_SHA and entry.NAME==NAME and entry.SAVED_MANIFEST==SAVED_COMPLETION_SHA,'EXACT_REVIEWED_C2_RUNTIME_AND_C1_REQUIRED')
    return entry

def reviewed_bounds(a):
    need(a.root_authorize_completion_only and a.root_review_accepted and a.root_queue_clear,'EXPLICIT_C2_FINISH_ROOT_REVIEW_QUEUE_REQUIRED')
    need(a.prepare_finish and a.completion_manifest_sha==COMPLETION_MANIFEST_SHA and 1<=a.ttl_seconds<=1800,'EXACT_C2_FINISH_MANIFEST_TTL_REQUIRED')
    need(type(a.lease_pid) is int and a.lease_pid>1 and type(a.lease_start_ticks) is str and re.fullmatch('[1-9][0-9]*',a.lease_start_ticks),'ACTUAL_ROOT_LEASE_ARGUMENTS_REQUIRED')
    need(a.c1_save_action is not None,'ACTUAL_HISTORICAL_C1_SAVE_ACTION_REQUIRED')

def finish_action(pin,lease,bindings,MI,ttl,price,now):
    need(price['capturedAtUnix']<=now<price['capturedAtUnix']+1800 and price['lease']==lease,'FRESH_CAPTURE_BEFORE_C2_ACTION_REQUIRED')
    return {'schema':'palitra-unified-r8-completion-root-action/v2','status':'ROOT_AUTHORIZED_ONE_ATTEMPT','mode':'finish','namespace':NAME,'runtimePackageSha256':PACKAGE_SHA,'completionManifestSha256':pin,'parentImage':MI.IMAGE,'parentReceiptSha256':MI.RECEIPT,'lease':lease,'createdAtUnix':now,'expiresAtUnix':min(now+ttl,price['capturedAtUnix']+1800),'nonce':price['nonce'],'queue':{'resource':'synapse-content-production','owner':'Root','clear':True},'bindings':bindings,'runtimeAuthorization':True}

def main(argv=None):
    p=argparse.ArgumentParser(description='Readonly capture current API price and prepare C2 finish JSON; never execute completion')
    for name in ('prepare-finish','root-authorize-completion-only','root-review-accepted','root-queue-clear'):p.add_argument('--'+name,action='store_true')
    p.add_argument('--completion-manifest-sha',required=True);p.add_argument('--c1-save-action',type=Path,required=True)
    p.add_argument('--lease-pid',type=int,required=True);p.add_argument('--lease-start-ticks',required=True);p.add_argument('--ttl-seconds',type=int,default=900)
    a=p.parse_args(argv);reviewed_bounds(a)
    need(os.name=='posix' and os.geteuid()==os.getegid()==0,'ROOT_LINUX_C2_FINISH_INPUT_ONLY')
    lease=held(a.lease_pid,a.lease_start_ticks);native,package,I,B,MI=load_validators();E=completion_loader(a.completion_manifest_sha)
    def codes():native.load_package(PACKAGE,PACKAGE_SHA);E.load_completion(COMPLETION,a.completion_manifest_sha);E.load_saved_completion()
    codes();refs={};docs={}
    refs['rootInputs'],inputs=actual_ref(ROOT/(RUNTIME+'-root-inputs-result.json'))
    need(inputs.get('status')=='ROOT_INPUTS_CREATED_ORIGINAL_ADMISSION_CHECK_PASSED_NOT_EXECUTED' and inputs.get('packageManifestSha256')==PACKAGE_SHA and all(inputs.get(k) is False for k in ('runtimeExecuted','applyPerformed','nativePublicationPerformed','wholeAppAcceptanceCreated','automaticRetry')),'ACTUAL_R8_ROOT_INPUT_RESULT_REQUIRED')
    refs['apply']=inputs['action'];docs['apply']=checked_ref(refs['apply']);refs['plan']=inputs['managedAdoptionPlan'];docs['plan']=checked_ref(refs['plan'])
    refs['pending'],pending=actual_ref(ROOT/(RUNTIME+'-apply')/'pending-native-adoption.json')
    canonical_pending=pending_chain(package,I,docs['apply'],refs['apply'],pending,refs['pending'],docs['plan'],refs['plan'])
    need(pending['migration'].get('oldBusinessRowsChanged')==0 and pending['child'].get('sourceFiles')==244,'ACTUAL_R8_COMMITTED_RUNTIME_REQUIRED')
    inspector=Path(docs['apply']['bindings']['inspectorDirectory']);inspector_code(inspector)
    common={'compatibilityInspectorManifestSha256':INSPECTOR_SHA,'inspectorDirectory':str(inspector),'managedAdoptionPlan':refs['plan']}
    old_pending_bindings={**common,'pendingNativeAdoption':refs['pending'],'pendingNativeAdoptionSha256':canonical_pending}
    refs['failed'],failed=actual_ref(ROOT/(RUNTIME+'-save')/'NATIVE_CALL_META.json')
    refs['saveAction'],save_action=actual_ref(a.c1_save_action)
    need(save_action.get('schema')=='palitra-unified-r8-completion-root-action/v1' and save_action.get('mode')=='save' and save_action.get('namespace')==SAVED_COMPLETION_NAME and save_action.get('status')=='ROOT_AUTHORIZED_ONE_ATTEMPT' and save_action.get('runtimeAuthorization') is True and save_action.get('runtimePackageSha256')==PACKAGE_SHA and save_action.get('completionManifestSha256')==SAVED_COMPLETION_SHA and save_action.get('bindings')=={**old_pending_bindings,'failedSaveMetadata':refs['failed']},'EXACT_HISTORICAL_C1_SAVE_ACTION_REQUIRED')
    refs['saved'],saved=actual_ref(ROOT/(SAVED_COMPLETION_NAME+'-save')/'SAVED_REQUIRES_PUBLIC_READBACK.json')
    need(saved.get('status')=='NATIVE_SERVICE_SAVED_REQUIRES_ROOT_PUBLIC_READBACK' and saved.get('runtimePackageSha256')==PACKAGE_SHA and saved.get('completionManifestSha256')==SAVED_COMPLETION_SHA and saved.get('completionRootActionSha256')==refs['saveAction']['sha256'] and saved.get('runtimeAcceptance') is False and saved.get('automaticRetry') is False and saved.get('automaticRestore') is False,'ACTUAL_IMMUTABLE_C1_SAVE_WRAPPER_REQUIRED')
    raw_outcome=saved.get('outcome');outcome=native_outcome(raw_outcome)
    need(outcome.get('schema')=='palitra-unified-native-service-save-outcome/v1' and outcome.get('status')==saved['status'] and outcome.get('packageSha256')==outcome.get('runtimePackageSha256')==PACKAGE_SHA and outcome.get('completionManifestSha256')==SAVED_COMPLETION_SHA and outcome.get('completionRootActionSha256')==refs['saveAction']['sha256'] and outcome.get('planSha256')==refs['plan']['sha256'] and outcome.get('pendingSha256')==canonical_pending and outcome.get('baseRevision')==docs['plan']['baseRevision'] and outcome.get('currentVersion')==saved.get('currentVersion')==261 and outcome.get('currentRevision')==saved.get('currentRevision') and outcome.get('full141FactsSha256')==saved.get('full141FactsSha256'),'EXACT_RAW_C1_SAVED_OUTCOME_REQUIRED')
    refs['adoption'],adopted=actual_ref(ROOT/(SAVED_COMPLETION_NAME+'-public-readback')/'NATIVE_ADOPTION_RECEIPT.json');I.require_native_adoption(adopted,package,pending)
    need(adopted.get('runtimePackageSha256')==PACKAGE_SHA and adopted.get('completionManifestSha256')==SAVED_COMPLETION_SHA and adopted.get('completionRootActionSha256')==refs['saveAction']['sha256'] and adopted.get('completionOutcome')==raw_outcome and adopted.get('nativeSaveReceiptSha256')==raw_outcome['sha256'] and adopted.get('nativeBackupSha256')==saved['backup']['sha256'] and adopted.get('currentRevision')==outcome['currentRevision'] and adopted.get('full141FactsSha256')==outcome['full141FactsSha256'],'RAW_C1_OUTCOME_SHA_NOT_WRAPPER_SHA_REQUIRED')
    refs['public']=adopted['publicReadback'];public=checked_ref(refs['public'])
    need(Path(refs['public']['path'])==ROOT/(SAVED_COMPLETION_NAME+'-public-readback')/'PUBLIC_READBACK.json' and public.get('schema')=='palitra-unified-three-assets-public-readback/v1' and public.get('status')=='EXACT_THREE_ASSETS_PUBLIC_READBACK_NOT_WHOLE_APP_ACCEPTANCE' and public.get('packageSha256')==PACKAGE_SHA and public.get('planSha256')==refs['plan']['sha256'] and public.get('nativeSaveReceiptSha256')==raw_outcome['sha256'] and public.get('currentRevision')==outcome['currentRevision'] and public.get('requests')==3 and public.get('runtimeAcceptance') is False,'ACTUAL_C1_PUBLIC_READBACK_REQUIRED')
    expected={row['managedPath']:row['input']['sha256'] for row in package['map']['managedRecords']};assets=public.get('assets')
    need(type(assets) is list and len(assets)==3 and {row.get('path'):row.get('sha256') for row in assets}==expected and all(row.get('status')==200 and row.get('redirectsFollowed')==0 for row in assets),'EXACT_ACTUAL_C1_PUBLIC_ASSETS_REQUIRED')
    base_binding={**old_pending_bindings,'nativeAdoptionReceipt':refs['adoption']};I.validate_bindings('finish',base_binding)
    attempt=ROOT/(NAME+'-finish')
    def gates():
        codes();inspector_code(inspector);held(a.lease_pid,a.lease_start_ticks)
        for ref in refs.values():checked_ref(ref)
        native_outcome(raw_outcome);need(not os.path.lexists(attempt),'EXISTING_OR_UNKNOWN_C2_FINISH_NO_REPLAY')
    gates();nonce=secrets.token_hex(32);price=capture_actual_price(lease,outcome['currentRevision'],nonce)
    output=ROOT/(NAME+'-root-finish-input-'+nonce[:32]);need(not os.path.lexists(output),'NEW_C2_ROOT_INPUT_DIRECTORY_REQUIRED')
    price_raw=encode(price);price_ref={'path':str(output/'current-api-price.json'),'sha256':sha(price_raw)}
    bindings={**base_binding,'currentApiPrice':price_ref}
    action=finish_action(a.completion_manifest_sha,lease,bindings,MI,a.ttl_seconds,price,time.time());E.require_price_proof(price,action)
    gates();E.current_api_price(price)
    output.mkdir(mode=0o700);s=output.lstat();need(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o700,'NEW_ROOT700_C2_INPUT_REQUIRED')
    need(new_file(output/'current-api-price.json',price_raw)==price_ref,'CURRENT_PRICE_CAPTURE_BYTES_CHANGED')
    action_ref=new_file(output/'finish-action.json',encode(action))
    need(E.CompletionAdmission(action_ref,a.completion_manifest_sha,'finish',codes).check()==action,'ORIGINAL_C2_ADMISSION_CHECK_REQUIRED');E.require_price_proof(checked_ref(price_ref),action)
    held(a.lease_pid,a.lease_start_ticks)
    fd=os.open(output,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
    print(json.dumps({'status':'ROOT_C2_FINISH_INPUT_CREATED_ORIGINAL_ADMISSION_CHECK_PASSED_NOT_EXECUTED','action':action_ref,'currentApiPrice':price_ref,'runtimePackageSha256':PACKAGE_SHA,'savedCompletionManifestSha256':SAVED_COMPLETION_SHA,'completionManifestSha256':a.completion_manifest_sha,'runtimeExecuted':False,'serviceSaveExecuted':False,'staticPublicationPerformed':False,'wholeAppAcceptanceCreated':False,'automaticRetry':False},sort_keys=True))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'status':'ROOT_C2_INPUT_REFUSED_OR_PARTIAL_NO_REPLAY','code':str(error) if type(error) is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,120}',str(error)) else type(error).__name__,'runtimeExecuted':False,'automaticRetry':False},sort_keys=True));raise SystemExit(2)
