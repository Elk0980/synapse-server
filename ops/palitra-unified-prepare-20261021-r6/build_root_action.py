"""Root-only preparation of Unified R6 inputs. Never runs the installer."""
import argparse,hashlib,importlib,json,os,re,secrets,stat,subprocess,sys,time,types
from datetime import datetime,timezone
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
NAME='palitra-unified-orders-20261021-r6'
PACKAGE=ROOT/(NAME+'-code')
PACKAGE_SHA='a1dfabce477018caa41390520f81b346e91716927f3e1198a2e11900d7aaa69e'
ENTRY_SHA='e639e02b40fa6447fe2352ae978cb79b6eb2314314d69a8bf73ecb038c5e0ece'
INSPECTOR_SHA='7de083ac3cf4b39c352ed7b3c60d35e447480f0ab836915d2c87482ef8125c09'
ENGINE_SHA='6bd4b9f29ff1ffd4e553750d43df437444b5651485748e1eeca82163c8259861'
CLEANUP_RECEIPT_SHA='94301d3154b612fea52a9a18b8b9ca75969b54fd832f4b457edb79adca4d4f7b'
CLEANUP_ADMISSION_SHA='ba6a2ab94b0fcae4aa25eaf82f4db4f134f1a136848d83b9bc4b7d9d89fbdf03'
LOCK='/opt/synapse/.palitra-app-release.lock'
FILES={'raw-content-minimum.json','post-content-capture.json','native-content-minimum.json','guard-proof.json'}
SMALL=16*1024*1024
RAW_MAX=256*1024*1024
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
def main(argv=None):
    p=argparse.ArgumentParser(description='Prepare reviewed Root inputs only; no Controller, Driver, installer, DB or service actions')
    p.add_argument('--build-root-apply-inputs',action='store_true')
    p.add_argument('--root-review-accepted',action='store_true')
    p.add_argument('--root-queue-clear',action='store_true')
    p.add_argument('--native-workspace-plan-reviewed',action='store_true')
    p.add_argument('--capture-result',type=Path,required=True);p.add_argument('--capture-result-sha',required=True)
    p.add_argument('--cleanup-receipt',type=Path,required=True);p.add_argument('--cleanup-receipt-sha',required=True)
    p.add_argument('--cleanup-admission',type=Path,required=True);p.add_argument('--cleanup-admission-sha',required=True)
    p.add_argument('--package-sha',required=True);p.add_argument('--inspector-directory',type=Path,required=True)
    p.add_argument('--lease-pid',type=int,required=True);p.add_argument('--lease-start-ticks',required=True)
    p.add_argument('--ttl-seconds',type=int,default=900)
    a=p.parse_args(argv)
    need(a.build_root_apply_inputs and a.root_review_accepted and a.root_queue_clear and a.native_workspace_plan_reviewed,'EXPLICIT_ROOT_REVIEW_QUEUE_AND_NATIVE_PLAN_REQUIRED')
    need(os.name=='posix'and os.geteuid()==os.getegid()==0,'ROOT_LINUX_INPUT_PREPARATION_ONLY')
    need(a.package_sha==PACKAGE_SHA and a.cleanup_receipt_sha==CLEANUP_RECEIPT_SHA and a.cleanup_admission_sha==CLEANUP_ADMISSION_SHA,'EXACT_R6_PACKAGE_AND_COMMITTED_CLEANUP_REQUIRED')
    need(1<=a.ttl_seconds<=1800,'BOUNDED_ONE_ATTEMPT_TTL_REQUIRED')
    lease=held(a.lease_pid,a.lease_start_ticks)
    native,package,I,B,MI=load_validators();inspector_code(a.inspector_directory)
    result_ref={'path':str(a.capture_result),'sha256':a.capture_result_sha};result=checked_ref(result_ref)
    need(result.get('schema')=='palitra-post-cleanup-private-capture-result/v2'and result.get('status')=='PRIVATE_POST_CLEANUP_CAPTURE_REQUIRES_INDEPENDENT_ROOT_REVIEW'and result.get('runtimeAuthorization')is False and result.get('userApprovalCreated')is False and result.get('admissionCreated')is False and result.get('databaseWrites')==result.get('oldArtifactWrites')==0,'ACTUAL_COMPACT_PRIVATE_CAPTURE_RESULT_REQUIRED')
    files=result.get('files');need(type(files)is dict and set(files)==FILES,'EXACT_COMPACT_CAPTURE_FOUR_FILES_REQUIRED')
    area=path_guard(a.capture_result.parent);s=area.lstat()
    need(a.capture_result.name=='CAPTURE_RESULT.json'and area.parent==ROOT and re.fullmatch('palitra-unified-post-cleanup-20261021-r4-[a-f0-9]{32}',area.name)and stat.S_ISDIR(s.st_mode)and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o700,'ROOT700_ACTUAL_CAPTURE_AREA_REQUIRED')
    need(all(Path(ref['path'])==area/name for name,ref in files.items())and {q.name for q in area.iterdir()}==FILES|{'CAPTURE_RESULT.json'},'CLOSED_CAPTURE_FILE_REFERENCES_REQUIRED')
    capture=checked_ref(files['post-content-capture.json']);minimum=checked_ref(files['native-content-minimum.json']);guard=checked_ref(files['guard-proof.json'])
    need(type(minimum)is dict and set(minimum)=={'identity','family','content'},'EXISTING_CAPTURE_NATIVE_CONTENT_MINIMUM_REQUIRED')
    captured=datetime.fromisoformat(capture['capturedAtUtc'].replace('Z','+00:00'))
    need(captured.tzinfo is not None and captured.utcoffset().total_seconds()==0 and 0<=time.time()-captured.timestamp()<=900,'FRESH_ACTUAL_POSTCOMMIT_CAPTURE_REQUIRED')
    rawref=capture.get('rawPrivateMinimumRef')
    need(type(rawref)is dict and set(rawref)=={'schema','path','sha256','bytes','encoding'}and rawref['schema']=='palitra-post-cleanup-raw-minimum-ref/v1'and rawref['encoding']=='JSON_SQLITE_BYTES_HEX_V1'and {k:rawref[k]for k in ('path','sha256')}==files['raw-content-minimum.json']and type(rawref['bytes'])is int and 0<rawref['bytes']<=RAW_MAX,'EXACT_EXTERNAL_RAW_PRIVATE_MINIMUM_REQUIRED')
    need(private_file(rawref['path'],rawref['sha256'],maximum=RAW_MAX,stream_only=True)==rawref['bytes'],'EXACT_EXTERNAL_RAW_PRIVATE_BYTES_REQUIRED')
    receipt_ref={'path':str(a.cleanup_receipt),'sha256':a.cleanup_receipt_sha};receipt=checked_ref(receipt_ref)
    cleanup=checked_ref({'path':str(a.cleanup_admission),'sha256':a.cleanup_admission_sha})
    need(receipt.get('admissionSha256')==a.cleanup_admission_sha and receipt.get('namespace')==cleanup.get('namespace')and receipt.get('nonce')==cleanup.get('nonce'),'EXACT_COMMITTED_CLEANUP_ADMISSION_LINK_REQUIRED')
    historical={'pid':cleanup['lease']['pid'],'startTicks':cleanup['lease']['startTicks'],'lock':cleanup['lease']['lockPath']}
    cleanup_ref={'path':str(a.cleanup_admission),'sha256':a.cleanup_admission_sha}
    need(capture.get('cleanupAdmission')==guard.get('cleanupAdmission')==cleanup_ref and capture.get('historicalCleanupLease')==guard.get('historicalCleanupLease')==historical,'EXACT_SEPARATE_HISTORICAL_CLEANUP_CAPTURE_BINDING_REQUIRED')
    pre=cleanup['artifacts']['runtimeInspection']['sha256'];approval=cleanup['artifacts']['userApproval']['sha256']
    B.inspect_transaction_receipt(receipt,engine_sha256=ENGINE_SHA,pre_full_sha256=pre,user_approval_sha256=approval)
    need(capture.get('schema')=='palitra-post-cleanup-current-content-capture/v1'and capture.get('runtimeAuthorization')is False and capture.get('cleanupReceiptSha256')==a.cleanup_receipt_sha and capture.get('transactionWholeAfter')==receipt['transactionEvidence']['wholeAfter']and capture.get('nativeContentMinimum')==minimum and digest(capture.get('typedContentSha256'))and result.get('typedContentSha256')==capture['typedContentSha256'],'EXACT_CURRENT_CAPTURE_NATIVE_MINIMUM_AND_COMMIT_REQUIRED')
    need(guard.get('schema')=='palitra-post-cleanup-independent-read-guards/v1'and guard.get('status')=='CURRENT_CONTENT_CAPTURE_WITH_EXISTING_AUXILIARY_AND_RUNTIME_GUARDS_NOT_ACCEPTANCE'and guard.get('runtimeAuthorization')is False and guard.get('runtimeWrites')==guard.get('databaseWrites')==0 and guard.get('cleanupReceiptSha256')==a.cleanup_receipt_sha and guard.get('packageManifestSha256')==PACKAGE_SHA and guard.get('inspectorManifestSha256')==INSPECTOR_SHA and guard.get('engineSha256')==ENGINE_SHA and guard.get('preFullInspectionSha256')==pre and guard.get('userApprovalSha256')==approval and guard.get('sameConnectionNativeMinimum')is True and guard.get('allThreeHistoricalBackupGuardsPassed')is True and guard.get('oldArtifactsChanged')is False,'ACTUAL_INDEPENDENT_POSTCOMMIT_GUARDS_REQUIRED')
    expected_lease={**lease,'lock':LOCK}
    need(capture.get('lease')==guard.get('lease')==expected_lease,'CAPTURE_MUST_USE_THIS_ACTUAL_HELD_LEASE')
    need(package['compatibilityInspectorManifest']['sha256']==INSPECTOR_SHA,'EXACT_PACKAGE_INSPECTOR_REQUIRED')
    now=time.time();started=datetime.fromtimestamp(now,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    need(type(guard.get('managed260'))is dict and set(guard['managed260'])=={'version','revision'} and guard['managed260']['version']==260 and digest(guard['managed260']['revision']),'ACTUAL_CAPTURED_MANAGED260_BASE_REVISION_REQUIRED')
    plan={'schema':'palitra-unified-native-workspace-plan/v1','status':'ROOT_REVIEWED_NATIVE_SERVICE_PLAN_NOT_PUBLICATION','transport':'native-workspace-service','serviceMethod':'originalWorkspaceStore.save','saveCalls':1,'existingOwnerLogin':'vladislav','existingPermission':'site_editor.edit','serviceSourceSha256':'a28a415413a831ab9d1d4f2fa4655f00971f4ce7d88f2681077119401d4a1b96','baseRevision':guard['managed260']['revision'],'runtimeAuthorization':False,'parentVersion':260,'rawRuntimeFileWrites':0,'changedFiles':{r['managedPath']:r['input']['sha256']for r in package['map']['managedRecords']},'priceUnchanged':True,'newTrackerMetadata':{'uid':0,'gid':0,'mode':0o600,'nlink':1,'regular':True,'canonical':True}}
    I.require_native_plan(plan,package)
    basis={'schema':'palitra-post-cleanup-content-basis/v1','status':'ROOT_ACCEPTED_POST_CLEANUP_CONTENT_BASIS_NOT_INSTALL_AUTHORIZATION','runtimeAuthorization':False,'cleanupReceiptSha256':a.cleanup_receipt_sha,'postReadonlyContentCaptureSha256':files['post-content-capture.json']['sha256'],'contentMinimumMode':'NEW_FORWARD_ACCEPTED_MINIMUM_OLD_ARTIFACTS_IMMUTABLE','reportTrafficRuntimeMinimumMode':'UNCHANGED_OLD_GUARDS','oldArtifactWrites':0,'nativeContentMinimumSha256':files['native-content-minimum.json']['sha256'],'typedContentSha256':capture['typedContentSha256'],'captureResult':result_ref,'independentReadGuards':files['guard-proof.json'],'rawPrivateMinimumRef':rawref,'rootReviewedAtUtc':started}
    B.require_accepted_basis(basis,actual_receipt_sha256=a.cleanup_receipt_sha,actual_post_capture_sha256=files['post-content-capture.json']['sha256'])
    nonce=secrets.token_hex(32);output=ROOT/(NAME+'-root-inputs-'+nonce[:32])
    need(not os.path.lexists(output),'NEW_ROOT_INPUT_NAMESPACE_NO_REPLAY')
    plan_raw,basis_raw=encode(plan),encode(basis)
    plan_ref={'path':str(output/'managed-adoption-plan.json'),'sha256':sha(plan_raw)}
    basis_ref={'path':str(output/'accepted-post-cleanup-basis.json'),'sha256':sha(basis_raw)}
    bindings={'compatibilityInspectorManifestSha256':INSPECTOR_SHA,'inspectorDirectory':str(a.inspector_directory),'managedAdoptionPlan':plan_ref,'cleanupReceipt':receipt_ref,'postCapture':files['post-content-capture.json'],'acceptedPostCleanupBasis':basis_ref,'preFullInspectionSha256':pre,'cleanupUserApprovalSha256':approval,'acceptedNativeMinimum':files['native-content-minimum.json'],'beforeContentSha256':capture['typedContentSha256'],'schemaSha256':package['schemaFile']['sha256'],'startedAt':started}
    I.validate_bindings('apply',bindings)
    action={'schema':'palitra-unified-root-action/v1','status':'ROOT_AUTHORIZED_ONE_ATTEMPT','mode':'apply','namespace':MI.NAMESPACE,'packageSha256':PACKAGE_SHA,'parentImage':MI.IMAGE,'parentReceiptSha256':MI.RECEIPT,'lease':lease,'createdAtUnix':now,'expiresAtUnix':now+a.ttl_seconds,'nonce':nonce,'queue':{'resource':'synapse-content-production','owner':'Root','clear':True},'bindings':bindings,'runtimeAuthorization':True}
    # Re-read every actual proof and all immutable package bytes before EXCL.
    checked_ref(result_ref);checked_ref(receipt_ref);checked_ref({'path':str(a.cleanup_admission),'sha256':a.cleanup_admission_sha})
    for name,ref in files.items():
        if name=='raw-content-minimum.json':private_file(ref['path'],ref['sha256'],maximum=RAW_MAX,stream_only=True)
        else:checked_ref(ref)
    native.load_package(PACKAGE,PACKAGE_SHA);inspector_code(a.inspector_directory);held(a.lease_pid,a.lease_start_ticks)
    output.mkdir(mode=0o700);s=output.lstat();need(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o700,'NEW_ROOT700_INPUT_DIRECTORY_REQUIRED')
    need(new_file(output/'managed-adoption-plan.json',plan_raw)==plan_ref,'PLAN_BYTES_CHANGED')
    need(new_file(output/'accepted-post-cleanup-basis.json',basis_raw)==basis_ref,'BASIS_BYTES_CHANGED')
    action_ref=new_file(output/'apply-action.json',encode(action))
    # Original filesystem Admission.check is mandatory, without AST or patches.
    checked=I.Admission(action_ref,PACKAGE_SHA,'apply').check();need(checked==action,'ORIGINAL_ADMISSION_CHECK_MUST_MATCH_EXACT_ACTION')
    held(a.lease_pid,a.lease_start_ticks)
    fd=os.open(output,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
    print(json.dumps({'status':'ROOT_INPUTS_CREATED_ORIGINAL_ADMISSION_CHECK_PASSED_NOT_EXECUTED','action':action_ref,'acceptedPostCleanupBasis':basis_ref,'managedAdoptionPlan':plan_ref,'acceptedNativeMinimum':files['native-content-minimum.json'],'packageManifestSha256':PACKAGE_SHA,'runtimeExecuted':False,'applyPerformed':False,'nativePublicationPerformed':False,'wholeAppAcceptanceCreated':False,'automaticRetry':False},sort_keys=True))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'status':'ROOT_INPUT_PREPARATION_REFUSED_OR_PARTIAL_NO_REPLAY','code':str(error)if type(error)is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,120}',str(error))else type(error).__name__,'applyPerformed':False,'automaticRetry':False},sort_keys=True));raise SystemExit(2)
