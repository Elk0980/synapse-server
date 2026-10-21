"""Root-only public readback after the completed C1 save over immutable R8 runtime; never a save/apply entry.

Only three explicit public asset GETs. No authentication/cookies, redirect follow,
retry, install, database open, account bootstrap, consent or publication action.
"""
import argparse,datetime,hashlib,importlib.util,ipaddress,json,os,re,signal,stat,sys
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler,Request,build_opener

sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
RUNTIME='palitra-unified-orders-20261021-r8'
NAME=RUNTIME+'-completion-c1'
COMPLETION_ENTRY='0ddc393d0b694cab92e98e117d987407a20570b218791c7ddae7884de93898b0'
COMPLETION_MANIFEST='88ecc0018d4e5d7686b89e55b4561059ba36ca5f79cfb0dce455b54364707c3e'
MANIFEST='a0d12a5bc58a99c5b554d8204db26796fec3f86684ca65b3213f5de6f8e2fff0'
ENTRY='99d23faeeb8f7c0375802c0dd2b719570dc8436c98de696846a6b475a9ddd9c3'
PUBLIC_BASE='https://palitra-love-draft-1.synapsebusiness.ru/'
MAIN_BASE='https://palitra-love.ru/'
DATA=Path('/var/lib/docker/volumes/synapse_content_data/_data')/(NAME+'-save')
EXPECTED={'assets/order.js':'cc52878ac147168ddc6195ed5ccd13383211e921f46b536eb1645e154e111b2f',
 'assets/storefront.js':'9b7652e4771076a8d3146412fb76866ce2d1ed2098d989b8c46512e2b3866e91',
 'assets/palitra-attribution.js':'f0387cddfc7f251b75adc6eaab141869e5b5d2fcd82e3ceb8643a232d34098a3'}
sha=lambda raw:hashlib.sha256(raw).hexdigest()
encoded=lambda v:json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def need(v,code):
    if not v:raise ValueError(code)
def digest(v):return type(v) is str and re.fullmatch('[a-f0-9]{64}',v) is not None
def public_base(value):
    need(type(value) is str and value==value.strip() and len(value)<=512,'EXPLICIT_ROOT_VERIFIED_PUBLIC_BASE_REQUIRED')
    p=urlsplit(value)
    need(p.scheme=='https' and p.hostname and p.netloc==p.hostname and not p.username and not p.password and not p.port and not p.query and not p.fragment and p.path in ('','/'),'PUBLIC_HTTPS_SITE_ROOT_ONLY')
    need(p.hostname.isascii() and re.fullmatch('[a-z0-9.-]+',p.hostname) and '.' in p.hostname and not p.hostname.endswith(('.local','.localhost')),'PUBLIC_SITE_HOST_REQUIRED')
    try:ipaddress.ip_address(p.hostname)
    except ValueError:pass
    else:raise ValueError('PUBLIC_SITE_HOST_REQUIRED')
    return 'https://'+p.hostname+'/'
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('PUBLIC_REDIRECT_REFUSED')
def check_response(response,url,path,pin,size):
    need(type(size) is int and 0<size<=2*1024*1024,'EXACT_BOUNDED_ASSET_SIZE_REQUIRED')
    need(response.status==200 and response.geturl()==url,'PUBLIC_EXACT_URL_AND_200_REQUIRED')
    mime=response.headers.get('Content-Type','').split(';',1)[0].strip().lower()
    need(mime in ('application/javascript','text/javascript'),'PUBLIC_JAVASCRIPT_MIME_REQUIRED')
    need(response.headers.get('Content-Encoding','identity').strip().lower() in ('','identity'),'PUBLIC_IDENTITY_BYTES_REQUIRED')
    raw=response.read(size+1)
    need(len(raw)==size and sha(raw)==pin,'PUBLIC_ASSET_BYTES_CHANGED')
    cache={k:response.headers[k][:1024] for k in ('Content-Type','Content-Length','Cache-Control','ETag','Last-Modified','Expires','Age','Vary','Date') if k in response.headers}
    return {'path':path,'url':url,'status':200,'bytes':len(raw),'sha256':pin,'mime':mime,'headers':cache,'redirectsFollowed':0}
def http_get(opener,url,path,pin,size):
    # Fresh stdlib opener has no CookieJar or authenticated handler.
    request=Request(url,method='GET',headers={'Accept':'application/javascript, text/javascript','Cache-Control':'no-cache','Pragma':'no-cache','User-Agent':'PalitraRootPublicReadback/1'})
    def deadline(_signum,_frame):raise ValueError('PUBLIC_READBACK_DEADLINE')
    previous=signal.signal(signal.SIGALRM,deadline);signal.setitimer(signal.ITIMER_REAL,12)
    try:
        with opener.open(request,timeout=12) as response:return check_response(response,url,path,pin,size)
    finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
def asset_sizes(package,read_payload):
    rows=package['map']['managedRecords'];need({r['managedPath']:r['input']['sha256'] for r in rows}==EXPECTED,'EXACT_R8_THREE_ASSETS_REQUIRED')
    sizes={}
    for index,row in enumerate(rows):
        raw=read_payload(index);need(0<len(raw)<=2*1024*1024 and sha(raw)==EXPECTED[row['managedPath']],'EXACT_STAGED_ASSET_BYTES_REQUIRED');sizes[row['managedPath']]=len(raw)
    return sizes
def make_receipt(context,public_ref):
    outcome=context['outcome'];receipt={'schema':'palitra-unified-native-workspace-adoption/v1',
      'status':'ROOT_VERIFIED_NATIVE_SERVICE_SAVE_AND_PUBLIC_READBACK','transport':'native-workspace-service',
      'serviceMethod':outcome['serviceMethod'],'saveCalls':outcome['saveCalls'],'existingOwner':outcome['existingOwner'],
      'permissionsUnchanged':outcome['permissionsUnchanged'],'serviceCodeUnchanged':outcome['serviceCodeUnchanged'],
      'packageSha256':MANIFEST,'runtimePackageSha256':MANIFEST,'completionManifestSha256':context['completionManifestSha256'],
      'completionRootActionSha256':context['actionRef']['sha256'],'completionOutcome':context['outcomeRef'],
      'rootSaveReceipt':context['savedRef'],'rootSaveReceiptSha256':context['savedRef']['sha256'],
      'planSha256':context['planSha256'],'parentVersion':260,'currentVersion':outcome['currentVersion'],
      'baseRevision':outcome['baseRevision'],'currentRevision':outcome['currentRevision'],'rawRuntimeFileWrites':outcome['rawRuntimeFileWrites'],
      'filesBefore':outcome['filesBefore'],'filesAfter':outcome['filesAfter'],'other137Unchanged':outcome['other137Unchanged'],
      'priceUnchanged':outcome['priceUnchanged'],'changedFiles':outcome['changedFiles'],'full141FactsSha256':outcome['full141FactsSha256'],
      'nativeSaveReceiptSha256':context['outcomeSha256'],'nativeBackupSha256':context['backupSha256'],
      'publicReadback':public_ref,'runtimeAcceptance':False,'automaticRetry':False,'automaticRestore':False}
    context['validateReceipt'](receipt,context['package'],context['pending'])
    return receipt
def validate_evidence(saved,outcome,auth,refs,plan,pending,completion_sha):
    need(digest(completion_sha) and auth.get('runtimePackageSha256')==MANIFEST and auth.get('completionManifestSha256')==completion_sha and auth.get('namespace')==NAME and auth.get('mode')=='save','EXACT_C1_SAVE_AUTH_REQUIRED')
    need(saved.get('status')=='NATIVE_SERVICE_SAVED_REQUIRES_ROOT_PUBLIC_READBACK' and saved.get('runtimePackageSha256')==MANIFEST and saved.get('completionManifestSha256')==completion_sha and saved.get('completionRootActionSha256')==refs['action']['sha256'] and all(saved.get(k) is False for k in ('runtimeAcceptance','automaticRetry','automaticRestore')),'ACTUAL_DUAL_BOUND_C1_SAVED_WRAPPER_REQUIRED')
    need(refs['saved']['path']==str(ROOT/(NAME+'-save')/'SAVED_REQUIRES_PUBLIC_READBACK.json') and refs['outcome']['path']==str(DATA/'NATIVE_SAVE_OUTCOME.json') and refs['backup']['path']==str(DATA/'content.sqlite') and saved.get('outcome')==refs['outcome'] and saved.get('backup')==refs['backup'],'EXACT_C1_SAVED_HOST_DATA_REFERENCES_REQUIRED')
    need(outcome.get('schema')=='palitra-unified-native-service-save-outcome/v1' and outcome.get('status')==saved['status'] and outcome.get('transport')=='native-workspace-service' and outcome.get('packageSha256')==outcome.get('runtimePackageSha256')==MANIFEST and outcome.get('completionManifestSha256')==completion_sha and outcome.get('completionRootActionSha256')==refs['action']['sha256'],'EXACT_DUAL_BOUND_C1_NATIVE_OUTCOME_REQUIRED')
    binding=auth['bindings']
    need(outcome.get('planSha256')==binding['managedAdoptionPlan']['sha256'] and outcome.get('pendingSha256')==binding['pendingNativeAdoptionSha256'],'EXACT_ACTUAL_PLAN_PENDING_OUTCOME_REQUIRED')
    need(outcome.get('serviceMethod')=='originalWorkspaceStore.save' and type(outcome.get('saveCalls')) is int and outcome['saveCalls']==1 and all(outcome.get(k) is True for k in ('existingOwner','permissionsUnchanged','serviceCodeUnchanged','other137Unchanged','priceUnchanged')),'ORIGINAL_ONE_SAVE_PRESERVATION_PROOF_REQUIRED')
    need(type(outcome.get('currentVersion')) is int and outcome['currentVersion']==saved.get('currentVersion')==261 and outcome.get('currentRevision')==saved.get('currentRevision') and digest(outcome['currentRevision']) and outcome.get('baseRevision')==plan['baseRevision'] and outcome['currentRevision']!=outcome['baseRevision'],'EXACT_FORWARD261_REQUIRED')
    need(type(outcome.get('filesBefore')) is int and outcome['filesBefore']==140 and type(outcome.get('filesAfter')) is int and outcome['filesAfter']==141 and type(outcome.get('rawRuntimeFileWrites')) is int and outcome['rawRuntimeFileWrites']==0 and all(outcome.get(k) is False for k in ('runtimeAcceptance','automaticRetry','automaticRestore')),'HONEST_NATIVE141_OUTCOME_REQUIRED')
    need(outcome.get('changedFiles')==EXPECTED and outcome.get('full141FactsSha256')==saved.get('full141FactsSha256') and digest(outcome['full141FactsSha256']) and outcome.get('backup')=={'path':'/data/'+NAME+'-save/content.sqlite','sha256':refs['backup']['sha256']},'EXACT_NATIVE_PAYLOAD_AND_BACKUP_REQUIRED')
    protected=outcome.get('protectedProof',{})
    need(protected.get('schemaUnchanged') is True and protected.get('protectedTablesUnchanged') is True and protected.get('allCurrentControlRowsProtected') is True and type(protected.get('auditRowsAdded')) is int and protected['auditRowsAdded']==1 and digest(protected.get('auditTableSha256')) and digest(protected.get('auditAfterSha256')),'ACTUAL_PROTECTED_DATABASE_AUDIT_REQUIRED')
    need(pending.get('packageSha256')==MANIFEST and pending.get('managedAdoptionPlanSha256')==binding['managedAdoptionPlan']['sha256'],'SAME_R8_PENDING_PLAN_REQUIRED')
    return True

def collect(context,base,get,guard,publish,mode='draft'):
    need(mode in ('draft','main'),'ONLY_EXPLICIT_PUBLIC_READBACK_MODES')
    base=public_base(base);need(base==({'draft':PUBLIC_BASE,'main':MAIN_BASE}[mode]),'EXACT_ROOT_VERIFIED_PUBLIC_BASE_REQUIRED');results=[];guard()
    for path,pin in EXPECTED.items():
        guard();row=get(base+path,path,pin,context['sizes'][path])
        need(row.get('url')==base+path and row.get('path')==path and row.get('status')==200 and row.get('bytes')==context['sizes'][path] and row.get('sha256')==pin and row.get('redirectsFollowed')==0 and row.get('mime') in ('application/javascript','text/javascript'),'EXACT_THREE_PUBLIC_RESULTS_REQUIRED')
        results.append(row)
    guard()
    proof={'schema':'palitra-unified-three-assets-public-readback/v1','status':'EXACT_THREE_ASSETS_PUBLIC_READBACK_NOT_WHOLE_APP_ACCEPTANCE',
      'capturedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'packageSha256':MANIFEST,'runtimePackageSha256':MANIFEST,
      'completionManifestSha256':context['completionManifestSha256'],'completionRootActionSha256':context['actionRef']['sha256'],
      'completionOutcome':context['outcomeRef'],'rootSaveReceipt':context['savedRef'],'planSha256':context['planSha256'],
      'nativeSaveReceiptSha256':context['outcomeSha256'],'nativeBackupSha256':context['backupSha256'],
      'currentVersion':context['outcome']['currentVersion'],'currentRevision':context['outcome']['currentRevision'],
      'publicBase':base,'publicMode':mode,'managedDraftAdoption':mode=='draft','lease':context['lease'],'assets':results,'requests':3,
      'authenticatedRequests':0,'redirectsFollowed':0,'runtimeAcceptance':False,'serviceWrites':0,'databaseWrites':0}
    ref={'path':str(context['output']/'PUBLIC_READBACK.json'),'sha256':sha(encoded(proof))}
    receipt=make_receipt(context,ref) if mode=='draft' else None
    guard();publish(proof,receipt)
    result={'status':receipt['status'] if receipt else 'MAIN_PUBLIC_THREE_ASSETS_VERIFIED_NOT_ADOPTION',
      'publicReadback':ref,'runtimeAcceptance':False,'runtimePackageSha256':MANIFEST,'completionManifestSha256':context['completionManifestSha256']}
    if receipt:result['nativeAdoptionReceipt']={'path':str(context['output']/'NATIVE_ADOPTION_RECEIPT.json'),'sha256':sha(encoded(receipt))}
    return result

def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument('--code-directory',type=Path,required=True);p.add_argument('--completion-directory',type=Path,required=True)
    p.add_argument('--completion-manifest-sha',required=True);p.add_argument('--save-sha',required=True);p.add_argument('--save-action',type=Path,required=True)
    p.add_argument('--public-base',required=True);p.add_argument('--mode',choices=('draft','main'),required=True)
    p.add_argument('--lease-pid',type=int,required=True);p.add_argument('--lease-start',required=True);a=p.parse_args(argv)
    need(os.name=='posix' and os.geteuid()==os.getegid()==0,'ROOT_LINUX_ONLY')
    need(public_base(a.public_base)==({'draft':PUBLIC_BASE,'main':MAIN_BASE}[a.mode]),'EXACT_ROOT_VERIFIED_PUBLIC_BASE_REQUIRED')
    need(a.code_directory==ROOT/(RUNTIME+'-code') and a.completion_directory==ROOT/(NAME+'-code') and a.completion_manifest_sha==COMPLETION_MANIFEST and digest(a.save_sha) and a.lease_pid>1 and a.lease_start.isdigit(),'EXACT_RUNTIME_AND_COMPLETION_INPUTS_REQUIRED')
    def load_entry(path,pin,module):
        for target in [path,*path.parents]:need(not target.is_symlink(),'NATIVE_CODE_ALIAS_REFUSED')
        st=path.lstat();need(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_uid==st.st_gid==0 and stat.S_IMODE(st.st_mode)==0o600 and sha(path.read_bytes())==pin,'PINNED_NATIVE_ENTRY_REQUIRED')
        spec=importlib.util.spec_from_file_location(module,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
    completion=load_entry(a.completion_directory/'completion_entry.py',COMPLETION_ENTRY,'_palitra_c1_public_completion')
    completion.load_completion(a.completion_directory,COMPLETION_MANIFEST)
    entry=load_entry(a.code_directory/'native_entry.py',ENTRY,'_palitra_c1_public_runtime')
    package,manifest=entry.load_package(a.code_directory,MANIFEST)
    sys.path.insert(0,str(a.code_directory))
    from private_files import read,exact,PrivateFiles,sync
    from install_protocol import require_native_plan,require_native_adoption
    from forward_guard import load_inspector
    def codes():
        completion.load_completion(a.completion_directory,COMPLETION_MANIFEST);entry.load_package(a.code_directory,MANIFEST)
    def private(ref,expected=None,limit=16*1024*1024):
        need(type(ref) is dict and set(ref)=={'path','sha256'} and digest(ref['sha256']),'EXACT_PRIVATE_REFERENCE_REQUIRED')
        target=exact(ref['path']);st=target.lstat();need((ROOT in target.parents or DATA==target.parent) and (expected is None or target==expected) and st.st_uid==st.st_gid==0 and stat.S_IMODE(st.st_mode)==0o600,'ROOT600_EXACT_PRIVATE_PROOF_REQUIRED')
        raw=read(target,limit);need(sha(raw)==ref['sha256'],'PRIVATE_PROOF_SHA_CHANGED');return raw
    saved_ref={'path':str(ROOT/(NAME+'-save')/'SAVED_REQUIRES_PUBLIC_READBACK.json'),'sha256':a.save_sha};saved=json.loads(private(saved_ref))
    action_ref={'path':str(a.save_action),'sha256':saved['completionRootActionSha256']};private(action_ref)
    admission=completion.CompletionAdmission(action_ref,COMPLETION_MANIFEST,'save',codes);auth=admission.check();binding=auth['bindings']
    lease={'pid':a.lease_pid,'startTicks':a.lease_start};need(auth['lease']==lease,'SAME_FRESH_SAVE_LEASE_REQUIRED')
    plan_ref=binding['managedAdoptionPlan'];plan=json.loads(private(plan_ref));require_native_plan(plan,package);need(plan['transport']=='native-workspace-service','SERVICE_TRANSPORT_REQUIRED')
    pending_ref=binding['pendingNativeAdoption'];pending=json.loads(private(pending_ref));need(sha(encoded(pending))==binding['pendingNativeAdoptionSha256'],'EXACT_PENDING_SAVE_BINDING_REQUIRED')
    need(pending.get('schema')=='palitra-unified-pending-native-adoption/v1' and pending.get('status')=='RUNTIME_CODE_SCHEMA_READY_REQUIRES_NATIVE_WORKSPACE_ADOPTION' and pending.get('packageSha256')==MANIFEST and pending.get('mapSha256')==package['map']['closureSha256'] and pending.get('managedAdoptionPlanSha256')==plan_ref['sha256'] and pending.get('managedAdoptionTransport')=='native-workspace-service' and pending.get('managedAdoptionBaseRevision')==plan['baseRevision'] and pending.get('runtimeAcceptance') is False,'EXACT_APPLY_PLAN_BEFORE_SAVE_REQUIRED')
    failed_ref=binding['failedSaveMetadata'];private(failed_ref,ROOT/(RUNTIME+'-save')/'NATIVE_CALL_META.json')
    outcome_ref=saved['outcome'];backup_ref=saved['backup'];outcome=json.loads(private(outcome_ref,DATA/'NATIVE_SAVE_OUTCOME.json'));private(backup_ref,DATA/'content.sqlite',256*1024*1024)
    validate_evidence(saved,outcome,auth,{'saved':saved_ref,'outcome':outcome_ref,'backup':backup_ref,'action':action_ref},plan,pending,COMPLETION_MANIFEST)
    sizes=asset_sizes(package,lambda index:read(a.code_directory/'native-adoption'/str(index)))
    inspector_dir=Path(binding['inspectorDirectory']);need(inspector_dir.parent==ROOT and binding['compatibilityInspectorManifestSha256']==package['compatibilityInspectorManifest']['sha256'],'EXACT_SAVE_INSPECTOR_REQUIRED');inspector,_=load_inspector(inspector_dir,binding['compatibilityInspectorManifestSha256'])
    output=ROOT/(NAME+('-public-readback' if a.mode=='draft' else '-main-public-readback'));need(not output.exists(),'PUBLIC_OUTPUT_EXISTS_NO_REPLAY')
    def guard():
        admission.check();need(inspector.M.lease(a.lease_pid)==a.lease_start,'FRESH_OWN_LEASE_CHANGED');need(not output.exists(),'PUBLIC_OUTPUT_EXISTS_NO_REPLAY')
        for ref in (saved_ref,action_ref,plan_ref,pending_ref,failed_ref,outcome_ref):private(ref)
    def publish(proof,receipt):
        private(backup_ref,DATA/'content.sqlite',256*1024*1024);guard()
        output.mkdir(mode=0o700);sync(output.parent);store=PrivateFiles(output);store.json(output/'PUBLIC_READBACK.json',proof)
        if receipt is not None:store.json(output/'NATIVE_ADOPTION_RECEIPT.json',receipt)
    context={'package':package,'pending':pending,'outcome':outcome,'planSha256':plan_ref['sha256'],'outcomeSha256':outcome_ref['sha256'],'backupSha256':backup_ref['sha256'],'sizes':sizes,'lease':lease,'output':output,'validateReceipt':require_native_adoption,
      'completionManifestSha256':COMPLETION_MANIFEST,'actionRef':action_ref,'outcomeRef':outcome_ref,'savedRef':saved_ref}
    opener=build_opener(NoRedirect());result=collect(context,a.public_base,lambda *args:http_get(opener,*args),guard,publish,a.mode)
    print(json.dumps(result));return 0
if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as e:
        code=str(e) if type(e) is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,120}',str(e)) else type(e).__name__
        print(json.dumps({'status':'REFUSED_OR_UNKNOWN_CHECK_OUTPUT_NO_REPLAY','code':code,'runtimeAcceptance':False,'automaticRetry':False,'automaticRestore':False}));raise SystemExit(2)
