"""Root-only public readback after the completed original R8 save; never a save/apply entry.

Only three explicit public asset GETs. No authentication/cookies, redirect follow,
retry, install, database open, account bootstrap, consent or publication action.
"""
import argparse,datetime,hashlib,importlib.util,ipaddress,json,os,re,signal,stat,sys
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler,Request,build_opener

sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
NAME='palitra-unified-orders-20261021-r8'
MANIFEST='a0d12a5bc58a99c5b554d8204db26796fec3f86684ca65b3213f5de6f8e2fff0'
ENTRY='99d23faeeb8f7c0375802c0dd2b719570dc8436c98de696846a6b475a9ddd9c3'
PUBLIC_BASE='https://palitra-love-draft-1.synapsebusiness.ru/'
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
      'packageSha256':MANIFEST,'planSha256':context['planSha256'],'parentVersion':260,'currentVersion':outcome['currentVersion'],
      'baseRevision':outcome['baseRevision'],'currentRevision':outcome['currentRevision'],'rawRuntimeFileWrites':outcome['rawRuntimeFileWrites'],
      'filesBefore':outcome['filesBefore'],'filesAfter':outcome['filesAfter'],'other137Unchanged':outcome['other137Unchanged'],
      'priceUnchanged':outcome['priceUnchanged'],'changedFiles':outcome['changedFiles'],'full141FactsSha256':outcome['full141FactsSha256'],
      'nativeSaveReceiptSha256':context['outcomeSha256'],'nativeBackupSha256':context['backupSha256'],
      'publicReadback':public_ref,'runtimeAcceptance':False,'automaticRetry':False,'automaticRestore':False}
    context['validateReceipt'](receipt,context['package'],context['pending'])
    return receipt
def collect(context,base,get,guard,publish):
    base=public_base(base);need(base==PUBLIC_BASE,'EXACT_ROOT_VERIFIED_MANAGED_DRAFT_BASE_REQUIRED');results=[];guard()
    for path,pin in EXPECTED.items():
        guard();row=get(base+path,path,pin,context['sizes'][path])
        need(row.get('url')==base+path and row.get('path')==path and row.get('status')==200 and row.get('bytes')==context['sizes'][path] and row.get('sha256')==pin and row.get('redirectsFollowed')==0 and row.get('mime') in ('application/javascript','text/javascript'),'EXACT_THREE_PUBLIC_RESULTS_REQUIRED')
        results.append(row)
    guard()
    proof={'schema':'palitra-unified-three-assets-public-readback/v1','status':'EXACT_THREE_ASSETS_PUBLIC_READBACK_NOT_WHOLE_APP_ACCEPTANCE',
      'capturedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'packageSha256':MANIFEST,'planSha256':context['planSha256'],
      'nativeSaveReceiptSha256':context['outcomeSha256'],'nativeBackupSha256':context['backupSha256'],
      'currentVersion':context['outcome']['currentVersion'],'currentRevision':context['outcome']['currentRevision'],
      'publicBase':base,'lease':context['lease'],'assets':results,'requests':3,'authenticatedRequests':0,'redirectsFollowed':0,
      'runtimeAcceptance':False,'serviceWrites':0,'databaseWrites':0}
    ref={'path':str(context['output']/'PUBLIC_READBACK.json'),'sha256':sha(encoded(proof))}
    receipt=make_receipt(context,ref) # Original R6 validator BEFORE any output file.
    guard();publish(proof,receipt)
    return {'status':receipt['status'],'publicReadback':ref,'nativeAdoptionReceipt':{'path':str(context['output']/'NATIVE_ADOPTION_RECEIPT.json'),'sha256':sha(encoded(receipt))},'runtimeAcceptance':False}
def main(argv=None):
    p=argparse.ArgumentParser();p.add_argument('--code-directory',type=Path,required=True);p.add_argument('--save-sha',required=True);p.add_argument('--save-action',type=Path,required=True);p.add_argument('--public-base',required=True);p.add_argument('--lease-pid',type=int,required=True);p.add_argument('--lease-start',required=True);a=p.parse_args(argv)
    need(os.name=='posix' and os.geteuid()==os.getegid()==0,'ROOT_LINUX_ONLY');public_base(a.public_base)
    need(a.code_directory==ROOT/(NAME+'-code') and digest(a.save_sha) and a.lease_pid>1 and a.lease_start.isdigit(),'EXACT_R8_INPUTS_REQUIRED')
    entry_path=a.code_directory/'native_entry.py'
    for path in [entry_path,*entry_path.parents]:need(not path.is_symlink(),'NATIVE_CODE_ALIAS_REFUSED')
    s=entry_path.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600 and sha(entry_path.read_bytes())==ENTRY,'PINNED_NATIVE_ENTRY_REQUIRED')
    spec=importlib.util.spec_from_file_location('_palitra_public_read_entry',entry_path);entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
    package,manifest=entry.load_package(a.code_directory,MANIFEST)
    sys.path.insert(0,str(a.code_directory))
    from private_files import read,exact,PrivateFiles
    from install_protocol import Admission,validate_bindings,require_native_plan,require_native_adoption
    from forward_guard import load_inspector
    def private(ref,expected=None,limit=16*1024*1024):
        need(type(ref) is dict and set(ref)=={'path','sha256'} and digest(ref['sha256']),'EXACT_PRIVATE_REFERENCE_REQUIRED')
        target=exact(ref['path']);s=target.lstat();need((ROOT in target.parents or DATA==target.parent) and (expected is None or target==expected) and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600,'ROOT600_EXACT_PRIVATE_PROOF_REQUIRED')
        raw=read(target,limit);need(sha(raw)==ref['sha256'],'PRIVATE_PROOF_SHA_CHANGED');return raw
    saved_ref={'path':str(ROOT/(NAME+'-save')/'SAVED_REQUIRES_PUBLIC_READBACK.json'),'sha256':a.save_sha};saved=json.loads(private(saved_ref))
    need(saved.get('status')=='NATIVE_SERVICE_SAVED_REQUIRES_ROOT_PUBLIC_READBACK' and saved.get('transport')=='native-workspace-service' and saved.get('packageSha256')==MANIFEST and saved.get('runtimeAcceptance') is False and saved.get('automaticRetry') is False and saved.get('automaticRestore') is False,'ACTUAL_SAVED_NOT_PUBLIC_ACCEPTANCE_REQUIRED')
    action_ref={'path':str(a.save_action),'sha256':saved['rootActionSha256']};private(action_ref)
    admission=Admission(action_ref,MANIFEST,'save');auth=admission.check();validate_bindings('save',auth['bindings']);binding=auth['bindings']
    lease={'pid':a.lease_pid,'startTicks':a.lease_start};need(auth['lease']==lease,'SAME_FRESH_SAVE_LEASE_REQUIRED')
    plan_ref=binding['managedAdoptionPlan'];plan=json.loads(private(plan_ref));require_native_plan(plan,package);need(plan['transport']=='native-workspace-service','SERVICE_TRANSPORT_REQUIRED')
    pending_ref=binding['pendingNativeAdoption'];pending=json.loads(private(pending_ref));need(sha(encoded(pending))==binding['pendingNativeAdoptionSha256'],'EXACT_PENDING_SAVE_BINDING_REQUIRED')
    need(pending.get('schema')=='palitra-unified-pending-native-adoption/v1' and pending.get('status')=='RUNTIME_CODE_SCHEMA_READY_REQUIRES_NATIVE_WORKSPACE_ADOPTION' and pending.get('packageSha256')==MANIFEST and pending.get('mapSha256')==package['map']['closureSha256'] and pending.get('managedAdoptionPlanSha256')==plan_ref['sha256'] and pending.get('managedAdoptionTransport')=='native-workspace-service' and pending.get('managedAdoptionBaseRevision')==plan['baseRevision'] and pending.get('runtimeAcceptance') is False,'EXACT_APPLY_PLAN_BEFORE_SAVE_REQUIRED')
    outcome_ref=saved['outcome'];backup_ref=saved['backup'];outcome=json.loads(private(outcome_ref,DATA/'NATIVE_SAVE_OUTCOME.json'));private(backup_ref,DATA/'content.sqlite',256*1024*1024)
    need(outcome.get('schema')=='palitra-unified-native-service-save-outcome/v1' and outcome.get('status')==saved['status'] and outcome.get('transport')=='native-workspace-service' and outcome.get('packageSha256')==MANIFEST and outcome.get('planSha256')==plan_ref['sha256'] and outcome.get('pendingSha256')==binding['pendingNativeAdoptionSha256'],'EXACT_VALIDATED_NATIVE_OUTCOME_REQUIRED')
    need(outcome.get('serviceMethod')=='originalWorkspaceStore.save' and type(outcome.get('saveCalls')) is int and outcome['saveCalls']==1 and all(outcome.get(k) is True for k in ('existingOwner','permissionsUnchanged','serviceCodeUnchanged','other137Unchanged','priceUnchanged')),'ORIGINAL_ONE_SAVE_PRESERVATION_PROOF_REQUIRED')
    need(type(outcome.get('currentVersion')) is int and outcome['currentVersion']==saved.get('currentVersion')==261 and outcome.get('currentRevision')==saved.get('currentRevision') and digest(outcome['currentRevision']) and outcome.get('baseRevision')==plan['baseRevision'] and outcome['currentRevision']!=outcome['baseRevision'],'EXACT_FORWARD261_REQUIRED')
    need(outcome.get('filesBefore')==140 and outcome.get('filesAfter')==141 and type(outcome.get('rawRuntimeFileWrites')) is int and outcome['rawRuntimeFileWrites']==0 and all(outcome.get(k) is False for k in ('runtimeAcceptance','automaticRetry','automaticRestore')),'HONEST_NATIVE141_OUTCOME_REQUIRED')
    need(outcome.get('changedFiles')==EXPECTED and outcome.get('full141FactsSha256')==saved.get('full141FactsSha256') and digest(outcome['full141FactsSha256']) and outcome.get('backup')=={'path':'/data/'+NAME+'-save/content.sqlite','sha256':backup_ref['sha256']},'EXACT_NATIVE_PAYLOAD_AND_BACKUP_REQUIRED')
    protected=outcome.get('protectedProof',{});need(protected.get('schemaUnchanged') is True and protected.get('protectedTablesUnchanged') is True and protected.get('auditRowsAdded')==1 and digest(protected.get('auditTableSha256')) and digest(protected.get('auditAfterSha256')),'ACTUAL_PROTECTED_DATABASE_AUDIT_REQUIRED')
    sizes=asset_sizes(package,lambda index:read(a.code_directory/'native-adoption'/str(index)))
    inspector_dir=Path(binding['inspectorDirectory']);need(inspector_dir.parent==ROOT and binding['compatibilityInspectorManifestSha256']==package['compatibilityInspectorManifest']['sha256'],'EXACT_SAVE_INSPECTOR_REQUIRED');inspector,_=load_inspector(inspector_dir,binding['compatibilityInspectorManifestSha256'])
    output=ROOT/(NAME+'-public-readback');need(not output.exists(),'PUBLIC_OUTPUT_EXISTS_NO_REPLAY')
    def guard():
        admission.check();need(inspector.M.lease(a.lease_pid)==a.lease_start,'FRESH_OWN_LEASE_CHANGED');need(not output.exists(),'PUBLIC_OUTPUT_EXISTS_NO_REPLAY')
        entry.load_package(a.code_directory,MANIFEST)
        for ref in (saved_ref,plan_ref,pending_ref,outcome_ref):private(ref)
    def publish(proof,receipt):
        private(backup_ref,DATA/'content.sqlite',256*1024*1024);guard()
        output.mkdir(mode=0o700);store=PrivateFiles(output);store.json(output/'PUBLIC_READBACK.json',proof);store.json(output/'NATIVE_ADOPTION_RECEIPT.json',receipt)
    context={'package':package,'pending':pending,'outcome':outcome,'planSha256':plan_ref['sha256'],'outcomeSha256':outcome_ref['sha256'],'backupSha256':backup_ref['sha256'],'sizes':sizes,'lease':lease,'output':output,'validateReceipt':require_native_adoption}
    opener=build_opener(NoRedirect());result=collect(context,a.public_base,lambda *args:http_get(opener,*args),guard,publish)
    print(json.dumps(result));return 0
if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as e:
        code=str(e) if type(e) is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,120}',str(e)) else type(e).__name__
        print(json.dumps({'status':'REFUSED_OR_UNKNOWN_CHECK_OUTPUT_NO_REPLAY','code':code,'runtimeAcceptance':False,'automaticRetry':False,'automaticRestore':False}));raise SystemExit(2)
