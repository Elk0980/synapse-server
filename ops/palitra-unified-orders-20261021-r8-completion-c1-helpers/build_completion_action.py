"""Root preparation of C1 save/finish action only. Never executes completion.

Read helpers below retain exact reviewed R8 filesystem/lease/package semantics.
The expired R8 apply is historical provenance, never current authorization.
"""
import argparse,hashlib,importlib,json,os,re,secrets,stat,subprocess,sys,time,types
from datetime import datetime,timezone
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
RUNTIME='palitra-unified-orders-20261021-r8'
NAME=RUNTIME+'-completion-c1'
PACKAGE=ROOT/(RUNTIME+'-code')
COMPLETION=ROOT/(NAME+'-code')
COMPLETION_ENTRY_SHA='0ddc393d0b694cab92e98e117d987407a20570b218791c7ddae7884de93898b0'
COMPLETION_MANIFEST_SHA='88ecc0018d4e5d7686b89e55b4561059ba36ca5f79cfb0dce455b54364707c3e'
PACKAGE_SHA='a0d12a5bc58a99c5b554d8204db26796fec3f86684ca65b3213f5de6f8e2fff0'
ENTRY_SHA='99d23faeeb8f7c0375802c0dd2b719570dc8436c98de696846a6b475a9ddd9c3'
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

DATA=Path('/var/lib/docker/volumes/synapse_content_data/_data')
def ref_arg(a,name,required=True):
    path=getattr(a,name);pin=getattr(a,name+'_sha')
    need(not required or path is not None and digest(pin),'ACTUAL_FOLLOWUP_PROOF_REFERENCE_REQUIRED')
    if path is None and pin is None:return None
    need(path is not None and digest(pin),'CLOSED_OPTIONAL_PROOF_REFERENCE_REQUIRED')
    return {'path':str(path),'sha256':pin}
def native_outcome(ref):
    need(type(ref)is dict and set(ref)=={'path','sha256'}and digest(ref['sha256']),'ACTUAL_NATIVE_OUTCOME_REFERENCE_REQUIRED')
    path=Path(ref['path']);need(path==DATA/(NAME+'-save')/'NATIVE_SAVE_OUTCOME.json','EXACT_NATIVE_OUTCOME_PRIVATE_PATH_REQUIRED')
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

def completion_loader(pin):
    raw=private_file(COMPLETION/'completion_entry.py',COMPLETION_ENTRY_SHA)
    entry=types.ModuleType('root_prepare_c1_reviewed_entry');entry.__file__=str(COMPLETION/'completion_entry.py')
    exec(compile(raw,entry.__file__,'exec'),entry.__dict__)
    entry.load_completion(COMPLETION,pin)
    need(entry.RUNTIME_SHA==PACKAGE_SHA and entry.ENTRY_SHA==ENTRY_SHA and entry.NAME==NAME,'EXACT_REVIEWED_COMPLETION_ENTRY_REQUIRED')
    return entry

def reviewed_bounds(a):
    need(a.root_authorize_completion_only and a.root_review_accepted and a.root_queue_clear,'EXPLICIT_COMPLETION_ONLY_ROOT_REVIEW_QUEUE_REQUIRED')
    need(a.mode in ('save','finish') and a.completion_manifest_sha==COMPLETION_MANIFEST_SHA and 1<=a.ttl_seconds<=1800,'EXACT_COMPLETION_MODE_MANIFEST_AND_TTL_REQUIRED')
    need(type(a.lease_pid) is int and a.lease_pid>1 and type(a.lease_start_ticks) is str and re.fullmatch('[1-9][0-9]*',a.lease_start_ticks),'ACTUAL_ROOT_LEASE_ARGUMENTS_REQUIRED')
    need((a.mode=='finish')==(a.save_action is not None),'SAVE_ACTION_REQUIRED_ONLY_FOR_FINISH')

def new_action(mode,pin,lease,bindings,MI,ttl,now,nonce):
    return {'schema':'palitra-unified-r8-completion-root-action/v1','status':'ROOT_AUTHORIZED_ONE_ATTEMPT','mode':mode,'namespace':NAME,'runtimePackageSha256':PACKAGE_SHA,'completionManifestSha256':pin,'parentImage':MI.IMAGE,'parentReceiptSha256':MI.RECEIPT,'lease':lease,'createdAtUnix':now,'expiresAtUnix':now+ttl,'nonce':nonce,'queue':{'resource':'synapse-content-production','owner':'Root','clear':True},'bindings':bindings,'runtimeAuthorization':True}

def historical_completion_save(value,pin,expected):
    # Prior save action may have expired. Its original time is not renewed.
    need(value.get('schema')=='palitra-unified-r8-completion-root-action/v1' and value.get('mode')=='save' and value.get('namespace')==NAME and value.get('status')=='ROOT_AUTHORIZED_ONE_ATTEMPT' and value.get('runtimeAuthorization') is True and value.get('runtimePackageSha256')==PACKAGE_SHA and value.get('completionManifestSha256')==pin and value.get('bindings')==expected,'EXACT_ACTUAL_C1_SAVE_ACTION_REQUIRED')

def main(argv=None):
    p=argparse.ArgumentParser(description='Create private C1 save/finish input only; no service or installer execution')
    for name in ('root-authorize-completion-only','root-review-accepted','root-queue-clear'):p.add_argument('--'+name,action='store_true')
    p.add_argument('--mode',choices=('save','finish'),required=True);p.add_argument('--completion-manifest-sha',required=True)
    p.add_argument('--lease-pid',type=int,required=True);p.add_argument('--lease-start-ticks',required=True);p.add_argument('--ttl-seconds',type=int,default=900)
    p.add_argument('--save-action',type=Path)
    a=p.parse_args(argv);reviewed_bounds(a)
    need(os.name=='posix' and os.geteuid()==os.getegid()==0,'ROOT_LINUX_COMPLETION_INPUT_ONLY')
    lease=held(a.lease_pid,a.lease_start_ticks);native,package,I,B,MI=load_validators();E=completion_loader(a.completion_manifest_sha)
    def codes():native.load_package(PACKAGE,PACKAGE_SHA);E.load_completion(COMPLETION,a.completion_manifest_sha)
    refs={};docs={}
    refs['rootInputs'],inputs=actual_ref(ROOT/(RUNTIME+'-root-inputs-result.json'))
    need(inputs.get('status')=='ROOT_INPUTS_CREATED_ORIGINAL_ADMISSION_CHECK_PASSED_NOT_EXECUTED' and inputs.get('packageManifestSha256')==PACKAGE_SHA and all(inputs.get(k) is False for k in ('runtimeExecuted','applyPerformed','nativePublicationPerformed','wholeAppAcceptanceCreated','automaticRetry')),'ACTUAL_R8_ROOT_INPUT_RESULT_REQUIRED')
    refs['apply']=inputs['action'];docs['apply']=checked_ref(refs['apply'])
    refs['plan']=inputs['managedAdoptionPlan'];docs['plan']=checked_ref(refs['plan'])
    refs['pending'],docs['pending']=actual_ref(ROOT/(RUNTIME+'-apply')/'pending-native-adoption.json')
    canonical_pending=pending_chain(package,I,docs['apply'],refs['apply'],docs['pending'],refs['pending'],docs['plan'],refs['plan'])
    need(docs['pending']['migration'].get('oldBusinessRowsChanged')==0 and docs['pending']['child'].get('sourceFiles')==244,'ACTUAL_R8_COMMITTED_RUNTIME_REQUIRED')
    inspector=Path(docs['apply']['bindings']['inspectorDirectory']);inspector_code(inspector)
    common={'compatibilityInspectorManifestSha256':INSPECTOR_SHA,'inspectorDirectory':str(inspector),'managedAdoptionPlan':refs['plan']}
    pending_bindings={**common,'pendingNativeAdoption':refs['pending'],'pendingNativeAdoptionSha256':canonical_pending}
    failed_ref,failed=actual_ref(ROOT/(RUNTIME+'-save')/'NATIVE_CALL_META.json');refs['failed']=failed_ref
    need(failed.get('returncode')==2 and failed.get('stdoutSha256')==E.FAILED_STDOUT and failed.get('stderrSha256')==sha(b'') and not os.path.lexists(DATA/(RUNTIME+'-save')),'EXACT_CONFIRMED_OLD_PREWRITE_FAILURE_REQUIRED')
    need({q.name for q in (ROOT/(RUNTIME+'-save')).iterdir()}=={'SAVE_STARTED.json','NATIVE_CALL_META.json'},'OLD_R8_FAILURE_EVIDENCE_MUST_REMAIN_EXACT')
    save_bindings={**pending_bindings,'failedSaveMetadata':failed_ref}
    bindings=save_bindings if a.mode=='save' else dict(pending_bindings)
    if a.mode=='finish':
        refs['saveAction'],save_action=actual_ref(a.save_action);historical_completion_save(save_action,a.completion_manifest_sha,save_bindings)
        refs['saved'],saved=actual_ref(ROOT/(NAME+'-save')/'SAVED_REQUIRES_PUBLIC_READBACK.json')
        need(saved.get('status')=='NATIVE_SERVICE_SAVED_REQUIRES_ROOT_PUBLIC_READBACK' and saved.get('runtimePackageSha256')==PACKAGE_SHA and saved.get('completionManifestSha256')==a.completion_manifest_sha and saved.get('completionRootActionSha256')==refs['saveAction']['sha256'] and saved.get('runtimeAcceptance') is False and saved.get('automaticRetry') is False and saved.get('automaticRestore') is False,'ACTUAL_C1_SAVED_WRAPPER_REQUIRED')
        raw_outcome=saved.get('outcome');outcome=native_outcome(raw_outcome)
        need(outcome.get('schema')=='palitra-unified-native-service-save-outcome/v1' and outcome.get('status')==saved['status'] and outcome.get('packageSha256')==outcome.get('runtimePackageSha256')==PACKAGE_SHA and outcome.get('completionManifestSha256')==a.completion_manifest_sha and outcome.get('completionRootActionSha256')==refs['saveAction']['sha256'] and outcome.get('planSha256')==refs['plan']['sha256'] and outcome.get('pendingSha256')==canonical_pending and outcome.get('baseRevision')==docs['plan']['baseRevision'] and outcome.get('currentVersion')==saved.get('currentVersion')==261 and outcome.get('currentRevision')==saved.get('currentRevision') and outcome.get('full141FactsSha256')==saved.get('full141FactsSha256'),'EXACT_RAW_C1_OUTCOME_AND_WRAPPER_REQUIRED')
        refs['adoption'],adopted=actual_ref(ROOT/(NAME+'-public-readback')/'NATIVE_ADOPTION_RECEIPT.json')
        I.require_native_adoption(adopted,package,docs['pending'])
        need(adopted.get('runtimePackageSha256')==PACKAGE_SHA and adopted.get('completionManifestSha256')==a.completion_manifest_sha and adopted.get('completionRootActionSha256')==refs['saveAction']['sha256'] and adopted.get('completionOutcome')==raw_outcome and adopted.get('nativeSaveReceiptSha256')==raw_outcome['sha256'] and adopted.get('nativeBackupSha256')==saved['backup']['sha256'] and adopted.get('currentRevision')==outcome['currentRevision'] and adopted.get('full141FactsSha256')==outcome['full141FactsSha256'],'ACTUAL_RAW_OUTCOME_SHA_NOT_WRAPPER_SHA_REQUIRED')
        refs['public']=adopted['publicReadback'];public=checked_ref(refs['public'])
        need(Path(refs['public']['path'])==ROOT/(NAME+'-public-readback')/'PUBLIC_READBACK.json' and public.get('schema')=='palitra-unified-three-assets-public-readback/v1' and public.get('status')=='EXACT_THREE_ASSETS_PUBLIC_READBACK_NOT_WHOLE_APP_ACCEPTANCE' and public.get('packageSha256')==PACKAGE_SHA and public.get('planSha256')==refs['plan']['sha256'] and public.get('nativeSaveReceiptSha256')==raw_outcome['sha256'] and public.get('currentRevision')==outcome['currentRevision'] and public.get('requests')==3 and public.get('runtimeAcceptance') is False,'ACTUAL_C1_PUBLIC_READBACK_REQUIRED')
        expected={row['managedPath']:row['input']['sha256'] for row in package['map']['managedRecords']};assets=public.get('assets')
        need(type(assets) is list and len(assets)==3 and {row.get('path'):row.get('sha256') for row in assets}==expected and all(row.get('status')==200 and row.get('redirectsFollowed')==0 for row in assets),'EXACT_ACTUAL_THREE_PUBLIC_ASSETS_REQUIRED')
        bindings['nativeAdoptionReceipt']=refs['adoption']
    # Original R8 validators are reused on the compatible binding subset.
    I.validate_bindings(a.mode,{k:v for k,v in bindings.items() if k!='failedSaveMetadata'})
    attempt=ROOT/((NAME if a.mode=='save' else RUNTIME)+'-'+a.mode)
    def gates():
        codes();inspector_code(inspector);held(a.lease_pid,a.lease_start_ticks)
        for ref in refs.values():checked_ref(ref)
        if a.mode=='finish':native_outcome(raw_outcome)
        need(not os.path.lexists(attempt),'EXISTING_OR_UNKNOWN_COMPLETION_PHASE_NO_REPLAY')
        if a.mode=='save':need(not os.path.lexists(DATA/(NAME+'-save')),'EXISTING_NATIVE_COMPLETION_SAVE_NO_REPLAY')
    gates();now=time.time();nonce=secrets.token_hex(32)
    action=new_action(a.mode,a.completion_manifest_sha,lease,bindings,MI,a.ttl_seconds,now,nonce)
    output=ROOT/(NAME+'-root-'+a.mode+'-input-'+nonce[:32]);need(not os.path.lexists(output),'NEW_COMPLETION_ROOT_INPUT_REQUIRED')
    gates();output.mkdir(mode=0o700);s=output.lstat();need(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o700,'NEW_ROOT700_COMPLETION_INPUT_REQUIRED')
    action_ref=new_file(output/(a.mode+'-action.json'),encode(action))
    need(E.CompletionAdmission(action_ref,a.completion_manifest_sha,a.mode,codes).check()==action,'ORIGINAL_COMPLETION_ADMISSION_CHECK_REQUIRED')
    held(a.lease_pid,a.lease_start_ticks)
    fd=os.open(output,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
    print(json.dumps({'status':'ROOT_COMPLETION_ACTION_CREATED_ORIGINAL_ADMISSION_CHECK_PASSED_NOT_EXECUTED','mode':a.mode,'action':action_ref,'runtimePackageSha256':PACKAGE_SHA,'completionManifestSha256':a.completion_manifest_sha,'runtimeExecuted':False,'serviceSaveExecuted':False,'staticPublicationPerformed':False,'wholeAppAcceptanceCreated':False,'automaticRetry':False},sort_keys=True))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'status':'ROOT_COMPLETION_INPUT_REFUSED_OR_PARTIAL_NO_REPLAY','code':str(error) if type(error) is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,120}',str(error)) else type(error).__name__,'runtimeExecuted':False,'automaticRetry':False},sort_keys=True));raise SystemExit(2)
