"""Root-only preparation of Unified R8 inputs. Never runs the installer."""
import argparse,hashlib,importlib,json,os,re,secrets,stat,subprocess,sys,time,types
from datetime import datetime,timezone
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
NAME='palitra-unified-orders-20261021-r8'
PACKAGE=ROOT/(NAME+'-code')
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
    need(value.get('schema')=='palitra-unified-root-action/v1'and value.get('status')=='ROOT_AUTHORIZED_ONE_ATTEMPT'and value.get('mode')==mode and value.get('namespace')==NAME and value.get('packageSha256')==package_sha and value.get('runtimeAuthorization')is True,'EXACT_COMPLETED_PREDECESSOR_ACTION_REQUIRED')
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
def main(argv=None):
    p=argparse.ArgumentParser(description='Prepare one Root save/finish/accept action only; never execute it')
    p.add_argument('--build-root-followup-input',action='store_true');p.add_argument('--root-review-accepted',action='store_true');p.add_argument('--root-queue-clear',action='store_true')
    p.add_argument('--mode',choices=('save','finish','accept'),required=True)
    for name in ('apply-action','pending','managed-plan','save-action','save-result','native-adoption','installed','finish-action','whole-app-acceptance'):
        p.add_argument('--'+name,type=Path);p.add_argument('--'+name+'-sha')
    p.add_argument('--package-sha',required=True);p.add_argument('--inspector-directory',type=Path,required=True)
    p.add_argument('--lease-pid',type=int,required=True);p.add_argument('--lease-start-ticks',required=True);p.add_argument('--ttl-seconds',type=int,default=900)
    a=p.parse_args(argv)
    need(a.build_root_followup_input and a.root_review_accepted and a.root_queue_clear and os.name=='posix'and os.geteuid()==os.getegid()==0,'EXPLICIT_ROOT_LINUX_FOLLOWUP_PREPARATION_REQUIRED')
    need(a.package_sha==PACKAGE_SHA and 1<=a.ttl_seconds<=1800,'EXACT_R6_PACKAGE_AND_BOUNDED_TTL_REQUIRED')
    lease=held(a.lease_pid,a.lease_start_ticks);native,package,I,B,MI=load_validators();inspector_code(a.inspector_directory)
    required={'apply_action','pending','managed_plan'}
    if a.mode in ('finish','accept'):required|={'save_action','save_result','native_adoption'}
    if a.mode=='accept':required|={'installed','finish_action','whole_app_acceptance'}
    refs={};docs={}
    for name in ('apply_action','pending','managed_plan','save_action','save_result','native_adoption','installed','finish_action','whole_app_acceptance'):
        ref=ref_arg(a,name,name in required)
        need(name in required or ref is None,'UNRELATED_FOLLOWUP_PROOF_REFUSED')
        if ref is not None:refs[name]=ref;docs[name]=checked_ref(ref)
    plan,pending=docs['managed_plan'],docs['pending']
    pending_sha=pending_chain(package,I,docs['apply_action'],refs['apply_action'],pending,refs['pending'],plan,refs['managed_plan'])
    need(docs['apply_action']['bindings']['inspectorDirectory']==str(a.inspector_directory),'SAME_REVIEWED_INSPECTOR_DIRECTORY_REQUIRED')
    binding={'compatibilityInspectorManifestSha256':INSPECTOR_SHA,'inspectorDirectory':str(a.inspector_directory),'managedAdoptionPlan':refs['managed_plan']}
    if a.mode in ('save','finish'):
        binding.update(pendingNativeAdoption=refs['pending'],pendingNativeAdoptionSha256=pending_sha)
    if a.mode in ('finish','accept'):
        save_binding=historical_action(docs['save_action'],'save',PACKAGE_SHA);I.validate_bindings('save',save_binding)
        need(save_binding=={**{k:binding[k]for k in ('compatibilityInspectorManifestSha256','inspectorDirectory','managedAdoptionPlan')},'pendingNativeAdoption':refs['pending'],'pendingNativeAdoptionSha256':pending_sha},'EXACT_SAVE_ACTION_PLAN_AND_PENDING_REQUIRED')
        saved=docs['save_result'];adopted=docs['native_adoption']
        need(saved.get('status')=='NATIVE_SERVICE_SAVED_REQUIRES_ROOT_PUBLIC_READBACK'and saved.get('packageSha256')==PACKAGE_SHA and saved.get('transport')=='native-workspace-service'and saved.get('rootActionSha256')==refs['save_action']['sha256']and saved.get('runtimeAcceptance')is False and saved.get('automaticRetry')is False and saved.get('automaticRestore')is False,'ACTUAL_SEPARATE_NATIVE_SAVE_RESULT_REQUIRED')
        outcome=native_outcome(saved.get('outcome'))
        need(outcome.get('schema')=='palitra-unified-native-service-save-outcome/v1'and outcome.get('status')==saved['status']and outcome.get('packageSha256')==PACKAGE_SHA and outcome.get('planSha256')==refs['managed_plan']['sha256']and outcome.get('pendingSha256')==pending_sha and outcome.get('currentVersion')==saved.get('currentVersion')==261 and outcome.get('currentRevision')==saved.get('currentRevision')and outcome.get('baseRevision')==plan['baseRevision'],'EXACT_RAW_NATIVE_OUTCOME_BINDINGS_REQUIRED')
        I.require_native_adoption(adopted,package,pending)
        need(adopted.get('nativeSaveReceiptSha256')==saved['outcome']['sha256']and adopted.get('nativeBackupSha256')==saved['backup']['sha256']and adopted.get('currentRevision')==outcome['currentRevision']and adopted.get('full141FactsSha256')==outcome['full141FactsSha256']==saved.get('full141FactsSha256'),'RAW_NATIVE_OUTCOME_SHA_NOT_ROOT_WRAPPER_SHA_REQUIRED')
        public=checked_ref(adopted['publicReadback'])
        need(public.get('schema')=='palitra-unified-three-assets-public-readback/v1'and public.get('status')=='EXACT_THREE_ASSETS_PUBLIC_READBACK_NOT_WHOLE_APP_ACCEPTANCE'and public.get('packageSha256')==PACKAGE_SHA and public.get('planSha256')==refs['managed_plan']['sha256']and public.get('nativeSaveReceiptSha256')==saved['outcome']['sha256']and public.get('currentRevision')==outcome['currentRevision']and public.get('requests')==3 and public.get('runtimeAcceptance')is False,'ACTUAL_PUBLIC_READBACK_MUST_EXIST_BEFORE_FINISH')
        refs['public_readback']=adopted['publicReadback']
        expected={row['managedPath']:row['input']['sha256']for row in package['map']['managedRecords']}
        assets=public.get('assets');need(type(assets)is list and len(assets)==3 and {row.get('path'):row.get('sha256')for row in assets}==expected and all(row.get('status')==200 and row.get('redirectsFollowed')==0 for row in assets),'EXACT_THREE_ACTUAL_PUBLIC_ASSETS_REQUIRED')
        if a.mode=='finish':binding['nativeAdoptionReceipt']=refs['native_adoption']
    if a.mode=='accept':
        installed=docs['installed'];finish_binding=historical_action(docs['finish_action'],'finish',PACKAGE_SHA);I.validate_bindings('finish',finish_binding)
        need(installed.get('schema')=='palitra-unified-installed-pending-root-acceptance/v1'and installed.get('status')=='INSTALLED_PENDING_ROOT_ACCEPTANCE'and installed.get('runtimeAcceptance')is False and installed.get('packageSha256')==PACKAGE_SHA and installed.get('mapSha256')==package['map']['closureSha256']and installed.get('finishRootActionSha256')==refs['finish_action']['sha256']and installed.get('snapshotSha256')==sha(I.encoded(installed['snapshot']))and installed.get('managedAdoptionReceiptSha256')==sha(I.encoded(docs['native_adoption'])),'ACTUAL_FINISH_INSTALL_AND_SNAPSHOT_REQUIRED')
        need(finish_binding=={**{k:binding[k]for k in ('compatibilityInspectorManifestSha256','inspectorDirectory','managedAdoptionPlan')},'pendingNativeAdoption':refs['pending'],'pendingNativeAdoptionSha256':pending_sha,'nativeAdoptionReceipt':refs['native_adoption']},'EXACT_FINISH_ACTION_MUST_BIND_SAME_PLAN_AND_RECEIPT')
        accepted=docs['whole_app_acceptance']
        need(accepted.get('schema')=='palitra-unified-whole-app-acceptance/v1'and accepted.get('status')=='ROOT_VERIFIED_OLD_NEW_OPEN_SESSIONS'and accepted.get('packageSha256')==PACKAGE_SHA and accepted.get('managedReceiptSha256')==sha(I.encoded(docs['native_adoption']))and accepted.get('installedReceiptSha256')==refs['installed']['sha256']and accepted.get('snapshotSha256')==installed['snapshotSha256']and all(accepted.get(key)is True for key in ('clientAndStaff','draftAndFilePreserved','oldAndNewQueriesCurrent','bottomComposer')),'ACTUAL_EXISTING_ROOT_WHOLE_APP_ACCEPTANCE_REQUIRED')
        binding.update(installedPendingAcceptance=refs['installed'],nativeAdoptionReceipt=refs['native_adoption'],wholeAppAcceptance=refs['whole_app_acceptance'])
    I.validate_bindings(a.mode,binding)
    attempt=ROOT/(NAME+'-'+a.mode);need(not os.path.lexists(attempt),'EXISTING_OR_UNKNOWN_ATTEMPT_MUST_NOT_REPLAY')
    if a.mode=='save':need(not os.path.lexists(DATA/(NAME+'-save')),'EXISTING_NATIVE_SAVE_ATTEMPT_MUST_NOT_REPLAY')
    now=time.time();nonce=secrets.token_hex(32);output=ROOT/(NAME+'-root-'+a.mode+'-input-'+nonce[:32]);need(not os.path.lexists(output),'NEW_ROOT_INPUT_NAMESPACE_REQUIRED')
    action={'schema':'palitra-unified-root-action/v1','status':'ROOT_AUTHORIZED_ONE_ATTEMPT','mode':a.mode,'namespace':MI.NAMESPACE,'packageSha256':PACKAGE_SHA,'parentImage':MI.IMAGE,'parentReceiptSha256':MI.RECEIPT,'lease':lease,'createdAtUnix':now,'expiresAtUnix':now+a.ttl_seconds,'nonce':nonce,'queue':{'resource':'synapse-content-production','owner':'Root','clear':True},'bindings':binding,'runtimeAuthorization':True}
    for ref in refs.values():checked_ref(ref)
    if a.mode in ('finish','accept'):native_outcome(docs['save_result']['outcome'])
    native.load_package(PACKAGE,PACKAGE_SHA);inspector_code(a.inspector_directory);held(a.lease_pid,a.lease_start_ticks)
    need(not os.path.lexists(attempt),'ATTEMPT_APPEARED_BEFORE_ACTION_CREATION')
    output.mkdir(mode=0o700);s=output.lstat();need(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o700,'NEW_PRIVATE_ROOT700_INPUT_REQUIRED')
    action_ref=new_file(output/(a.mode+'-action.json'),encode(action))
    need(I.Admission(action_ref,PACKAGE_SHA,a.mode).check()==action,'ORIGINAL_ADMISSION_CHECK_REQUIRED')
    held(a.lease_pid,a.lease_start_ticks)
    fd=os.open(output,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
    print(json.dumps({'status':'ROOT_FOLLOWUP_ACTION_CREATED_ORIGINAL_ADMISSION_CHECK_PASSED_NOT_EXECUTED','mode':a.mode,'action':action_ref,'packageManifestSha256':PACKAGE_SHA,'runtimeExecuted':False,'serviceSaveExecuted':False,'acceptanceProofCreated':False,'automaticRetry':False},sort_keys=True))
if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'status':'ROOT_FOLLOWUP_INPUT_REFUSED_OR_PARTIAL_NO_REPLAY','code':str(error)if type(error)is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,120}',str(error))else type(error).__name__,'runtimeExecuted':False,'automaticRetry':False},sort_keys=True));raise SystemExit(2)
