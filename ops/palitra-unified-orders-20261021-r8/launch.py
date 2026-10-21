"""Root-reviewed separate R8 launchers. No automatic acceptance or retry.

Authoring this file performs nothing. Each explicit Root invocation executes
only its selected step, using actual server references and frozen validators.
"""
import argparse,contextlib,datetime,hashlib,io,json,os,re,stat,subprocess,sys,types
from pathlib import Path
from urllib.request import HTTPRedirectHandler,Request,build_opener

sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
NAME='palitra-unified-orders-20261021-r8'
PACKAGE=ROOT/(NAME+'-code')
MANIFEST='a0d12a5bc58a99c5b554d8204db26796fec3f86684ca65b3213f5de6f8e2fff0'
REPOSITORY='https://raw.githubusercontent.com/Elk0980/synapse-server/'
HELPERS={'build_followup_action.py':'8af2ce3da2acb12578d2af59f8306cf8f4a9df41d898651ab7dd38546f441952',
 'public_readback.py':'4b6b46f1f1c4fadc55c15a35e517b67e23fc8fc78ddc944e7bae7a2a41e78d8a'}
DRAFT='https://palitra-love-draft-1.synapsebusiness.ru/'
MAIN='https://palitra-love.ru/'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def need(ok,code):
    if not ok:raise ValueError(code)
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('CODE_REDIRECT_REFUSED')
def checked_code(response,url,pin):
    need(response.status==200 and response.geturl()==url,'EXACT_CODE_URL_AND_200_REQUIRED')
    need(response.headers.get('Content-Encoding','identity').lower() in ('','identity'),'IDENTITY_CODE_BYTES_REQUIRED')
    raw=response.read(128*1024+1)
    need(0<len(raw)<=128*1024 and sha(raw)==pin,'PINNED_FROZEN_HELPER_REQUIRED')
    return raw
def helper_url(publication_commit,name):
    need(type(publication_commit)is str and re.fullmatch('[a-f0-9]{40}',publication_commit),'EXPLICIT_ROOT_HELPER_PUBLICATION_COMMIT_REQUIRED')
    need(name in HELPERS,'EXACT_FROZEN_HELPER_REQUIRED')
    return REPOSITORY+publication_commit+'/ops/'+NAME+'/'+name
def helper(name,publication_commit):
    url=helper_url(publication_commit,name)
    request=Request(url,method='GET',headers={'Accept':'text/plain','Accept-Encoding':'identity','Cache-Control':'no-cache'})
    with build_opener(NoRedirect()).open(request,timeout=20) as response:
        raw=checked_code(response,url,HELPERS[name])
    module=types.ModuleType('_root_launch_r8_'+name.replace('.','_'))
    module.__file__=str(ROOT/('root-reviewed-r8-'+name))
    exec(compile(raw,module.__file__,'exec'),module.__dict__)
    return module
def actual_ref(H,path):
    # Pin the actual bounded ROOT600 bytes, then reread through the frozen
    # stable identity/hash guard. No manual transcription of evidence SHA.
    path=H.path_guard(path);s=path.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<=H.SMALL,'ROOT600_ACTUAL_RESULT_REQUIRED')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        need(H.identity(s)==H.identity(os.fstat(fd)),'RESULT_OPEN_RACE')
        with os.fdopen(fd,'rb',closefd=False) as f:raw=f.read(H.SMALL+1)
        need(len(raw)==s.st_size and H.identity(s)==H.identity(os.fstat(fd))==H.identity(path.lstat()),'RESULT_READ_RACE')
    finally:os.close(fd)
    ref={'path':str(path),'sha256':sha(raw)}
    need(H.private_file(path,ref['sha256'])==raw,'RESULT_CHANGED_BEFORE_USE')
    return ref,json.loads(raw)
def result_path(kind):return ROOT/(NAME+'-root-'+kind+'-input-result.json')
def inputs(H):
    result_ref,value=actual_ref(H,ROOT/(NAME+'-root-inputs-result.json'))
    need(value.get('status')=='ROOT_INPUTS_CREATED_ORIGINAL_ADMISSION_CHECK_PASSED_NOT_EXECUTED' and value.get('packageManifestSha256')==MANIFEST and all(value.get(k)is False for k in ('runtimeExecuted','applyPerformed','nativePublicationPerformed','wholeAppAcceptanceCreated','automaticRetry')),'ACTUAL_ORIGINAL_ROOT_INPUT_RESULT_REQUIRED')
    apply_ref=value['action'];action=H.checked_ref(apply_ref)
    H.historical_action(action,'apply',MANIFEST)
    plan_ref=value['managedAdoptionPlan'];H.checked_ref(plan_ref)
    need(action['bindings']['managedAdoptionPlan']==plan_ref,'SAME_ACTUAL_PLAN_REQUIRED')
    pending_ref,pending=actual_ref(H,ROOT/(NAME+'-apply')/'pending-native-adoption.json')
    need(pending.get('rootActionSha256')==apply_ref['sha256'],'ACTUAL_APPLY_MUST_HAVE_COMPLETED')
    return {'rootInputs':result_ref,'apply_action':apply_ref,'pending':pending_ref,'managed_plan':plan_ref},action['bindings']['inspectorDirectory']
def followup_ref(H,mode):
    result_ref,value=actual_ref(H,result_path(mode))
    need(value.get('status')=='ROOT_FOLLOWUP_ACTION_CREATED_ORIGINAL_ADMISSION_CHECK_PASSED_NOT_EXECUTED' and value.get('mode')==mode and value.get('packageManifestSha256')==MANIFEST and all(value.get(k)is False for k in ('runtimeExecuted','serviceSaveExecuted','acceptanceProofCreated','automaticRetry')),'ACTUAL_FOLLOWUP_RESULT_REQUIRED')
    action=H.checked_ref(value['action']);H.historical_action(action,mode,MANIFEST)
    return result_ref,value['action'],action
def call(module,args):
    # Frozen main(argv) functions receive a list. Preserve argv even if a
    # future stdlib/import path observes it; no shell interpolation is used.
    previous=sys.argv[:]
    try:
        sys.argv=[module.__file__,*args]
        with contextlib.redirect_stdout(io.StringIO()) as output:status=module.main(args)
        need(status in (None,0),'FROZEN_ENTRY_NONZERO_RESULT')
        raw=output.getvalue();need(len(raw)<=1024*1024,'BOUNDED_FROZEN_RESULT_REQUIRED')
        return json.loads(raw)
    finally:sys.argv=previous
def prepare(H,a,mode):
    target=result_path(mode);started=ROOT/(NAME+'-root-'+mode+'-input-launch-STARTED.json')
    need(not os.path.lexists(target) and not os.path.lexists(started),'FOLLOWUP_RESULT_EXISTS_OR_UNKNOWN_NO_REPLAY')
    refs,inspector=inputs(H)
    if mode=='finish':
        _,refs['save_action'],_=followup_ref(H,'save')
        refs['save_result'],_=actual_ref(H,ROOT/(NAME+'-save')/'SAVED_REQUIRES_PUBLIC_READBACK.json')
        refs['native_adoption'],_=actual_ref(H,ROOT/(NAME+'-public-readback')/'NATIVE_ADOPTION_RECEIPT.json')
    args=['--build-root-followup-input','--root-review-accepted','--root-queue-clear','--mode',mode,'--package-sha',MANIFEST,'--inspector-directory',inspector,'--lease-pid',str(a.lease_pid),'--lease-start-ticks',a.lease_start,'--ttl-seconds',str(a.ttl_seconds)]
    for key,ref in refs.items():
        if key=='rootInputs':continue
        flag='--'+key.replace('_','-');args.extend([flag,ref['path'],flag+'-sha',ref['sha256']])
    H.held(a.lease_pid,a.lease_start)
    H.new_file(started,H.encode({'status':'ROOT_FOLLOWUP_BUILDER_STARTED_UNKNOWN_NOT_ACTION_PROOF','mode':mode,'packageSha256':MANIFEST,'lease':{'pid':a.lease_pid,'startTicks':a.lease_start},'automaticRetry':False,'runtimeAcceptance':False}))
    value=call(H,args)
    need(value.get('status')=='ROOT_FOLLOWUP_ACTION_CREATED_ORIGINAL_ADMISSION_CHECK_PASSED_NOT_EXECUTED' and value.get('mode')==mode,'ORIGINAL_FOLLOWUP_BUILDER_SUCCESS_REQUIRED')
    H.held(a.lease_pid,a.lease_start)
    return {'status':value['status'],'mode':mode,'result':H.new_file(target,H.encode(value)),'action':value['action'],'runtimeExecuted':False,'automaticRetry':False}
def execute(H,a,mode):
    _,ref,action=followup_ref(H,mode)
    need(action['lease']=={'pid':a.lease_pid,'startTicks':a.lease_start},'SAME_FRESH_FOLLOWUP_LEASE_REQUIRED')
    native,package,I,_,_=H.load_validators();I.Admission(ref,MANIFEST,mode).check()
    attempt=ROOT/(NAME+'-'+mode);need(not os.path.lexists(attempt),'EXISTING_OR_UNKNOWN_STEP_NO_REPLAY')
    script=PACKAGE/('native_workspace_save.py' if mode=='save' else 'native_entry.py')
    native.load_package(PACKAGE,MANIFEST);H.held(a.lease_pid,a.lease_start)
    args=[sys.executable,'-B',str(script),'--manifest-sha',MANIFEST,'--action',ref['path'],'--action-sha',ref['sha256']]
    if mode=='finish':args.extend(['--mode','finish'])
    # The original entry owns its STARTED marker, one call and all admission
    # checks. Do not catch and retry a failed/unknown subprocess.
    completed=subprocess.run(args,check=False)
    need(completed.returncode==0,'ORIGINAL_STEP_REFUSED_OR_UNKNOWN_NO_REPLAY')
    path=attempt/('SAVED_REQUIRES_PUBLIC_READBACK.json' if mode=='save' else 'installed-pending-acceptance.json')
    result_ref,value=actual_ref(H,path)
    need(value.get('status')==('NATIVE_SERVICE_SAVED_REQUIRES_ROOT_PUBLIC_READBACK' if mode=='save' else 'INSTALLED_PENDING_ROOT_ACCEPTANCE') and value.get('runtimeAcceptance')is False,'ACTUAL_STEP_RESULT_REQUIRED_NOT_ACCEPTANCE')
    return {'status':value['status'],'result':result_ref,'runtimeAcceptance':False,'automaticRetry':False}
def draft_public(H,P,a):
    _,save_ref,_=followup_ref(H,'save')
    saved_ref,_=actual_ref(H,ROOT/(NAME+'-save')/'SAVED_REQUIRES_PUBLIC_READBACK.json')
    return call(P,['--code-directory',str(PACKAGE),'--save-sha',saved_ref['sha256'],'--save-action',save_ref['path'],'--public-base',DRAFT,'--lease-pid',str(a.lease_pid),'--lease-start',a.lease_start])
def main_public_collect(P,package,sizes,get,guard,publish,refs):
    results=[];guard()
    for path,pin in P.EXPECTED.items():
        guard();row=get(MAIN+path,path,pin,sizes[path])
        need(row.get('path')==path and row.get('url')==MAIN+path and row.get('status')==200 and row.get('bytes')==sizes[path] and row.get('sha256')==pin and row.get('redirectsFollowed')==0 and row.get('mime')in('application/javascript','text/javascript'),'EXACT_MAIN_THREE_RESULTS_REQUIRED')
        results.append(row)
    guard()
    proof={'schema':'palitra-unified-main-three-assets-readback/v1','status':'MAIN_THREE_ASSETS_MATCH_NOT_NATIVE_ADOPTION_NOT_WHOLE_APP_ACCEPTANCE','capturedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'publicBase':MAIN,'packageSha256':MANIFEST,'assets':results,'requests':3,'authenticatedRequests':0,'redirectsFollowed':0,'socketTimeoutSeconds':12,'perRequestDeadlineSeconds':12,'basisRefs':refs,'runtimeAcceptance':False,'nativeAdoptionCreated':False,'serviceWrites':0,'databaseWrites':0,'automaticRetry':False}
    return publish(proof)
def main_public(H,P,a):
    target=ROOT/(NAME+'-main-public-readback.json');need(not os.path.lexists(target),'MAIN_PUBLIC_PROOF_EXISTS_NO_REPLAY')
    native,package,I,_,_=H.load_validators()
    saved_ref,saved=actual_ref(H,ROOT/(NAME+'-save')/'SAVED_REQUIRES_PUBLIC_READBACK.json')
    adopted_ref,adopted=actual_ref(H,ROOT/(NAME+'-public-readback')/'NATIVE_ADOPTION_RECEIPT.json')
    pending_ref,pending=actual_ref(H,ROOT/(NAME+'-apply')/'pending-native-adoption.json')
    I.require_native_adoption(adopted,package,pending)
    outcome=H.native_outcome(saved['outcome'])
    need(adopted['nativeSaveReceiptSha256']==saved['outcome']['sha256'] and adopted['currentRevision']==saved['currentRevision']==outcome['currentRevision'],'ACTUAL_DRAFT_SAVE_BASIS_REQUIRED')
    sizes=P.asset_sizes(package,lambda index:H.private_file(PACKAGE/'native-adoption'/str(index),package['map']['managedRecords'][index]['input']['sha256']))
    refs={'saved':saved_ref,'draftAdoption':adopted_ref,'pending':pending_ref}
    def guard():
        need(not os.path.lexists(target),'MAIN_PUBLIC_PROOF_EXISTS_NO_REPLAY');H.held(a.lease_pid,a.lease_start);native.load_package(PACKAGE,MANIFEST)
        for ref in refs.values():H.checked_ref(ref)
        H.native_outcome(saved['outcome'])
    opener=build_opener(P.NoRedirect())
    return main_public_collect(P,package,sizes,lambda *args:P.http_get(opener,*args),guard,lambda proof:{'status':proof['status'],'mainPublicReadback':H.new_file(target,H.encode(proof)),'runtimeAcceptance':False,'nativeAdoptionCreated':False},refs)
def main(argv=None):
    parser=argparse.ArgumentParser(description='One explicit reviewed R8 step; never apply/accept/retry')
    parser.add_argument('--helpers-publication-commit',required=True)
    parser.add_argument('--step',required=True,choices=('prepare-save','save','public','main-public','prepare-finish','finish'))
    parser.add_argument('--root-review-accepted',action='store_true');parser.add_argument('--root-queue-clear',action='store_true');parser.add_argument('--execute-one-reviewed-step',action='store_true')
    parser.add_argument('--lease-pid',type=int,required=True);parser.add_argument('--lease-start',required=True);parser.add_argument('--ttl-seconds',type=int,default=900)
    a=parser.parse_args(argv)
    need(os.name=='posix' and os.geteuid()==os.getegid()==0 and a.root_review_accepted and a.root_queue_clear and a.lease_pid>1 and re.fullmatch('[1-9][0-9]*',a.lease_start) and 1<=a.ttl_seconds<=1800,'EXPLICIT_ROOT_REVIEW_QUEUE_AND_FRESH_LEASE_REQUIRED')
    need(a.execute_one_reviewed_step==(a.step in ('save','finish')),'EXPLICIT_SINGLE_MUTATING_STEP_FLAG_REQUIRED')
    H=helper('build_followup_action.py',a.helpers_publication_commit);H.held(a.lease_pid,a.lease_start)
    if a.step.startswith('prepare-'):result=prepare(H,a,a.step.removeprefix('prepare-'))
    elif a.step in ('save','finish'):result=execute(H,a,a.step)
    else:
        P=helper('public_readback.py',a.helpers_publication_commit)
        result=draft_public(H,P,a) if a.step=='public' else main_public(H,P,a)
    print(json.dumps(result,sort_keys=True));return 0
if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        code=str(error)if type(error)is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,120}',str(error))else type(error).__name__
        print(json.dumps({'status':'LAUNCH_REFUSED_OR_UNKNOWN_INSPECT_ACTUAL_OUTPUT_NO_REPLAY','code':code,'automaticRetry':False,'automaticRestore':False,'runtimeAcceptance':False}));raise SystemExit(2)
