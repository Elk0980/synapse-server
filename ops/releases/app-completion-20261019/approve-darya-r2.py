"""LOCAL DISABLED template: create exact Root acceptance + decision, never install.
Root must first personally review final frozen code and the fresh native preflight.
All missing exact SHA/PID/test values are deliberate fail-closed placeholders.
"""
from pathlib import Path
import hashlib,json,os,re,stat,subprocess,sys
TRANSPORT_READY=True
EXPECTED_PID=3161783
PREFLIGHT_PIN='630ebb40d53941a8279290dda902b27bb8e01ca72a70b40660cec1eb6227383f'
ROOT_RUNTIME_ACCEPTANCE_SHA='29ed400c9fea3e721f06d3c533f90a5e2f25c525b6880ef738d27c59015fb0fd'
NEBO_BASIS_PIN='bcb5cefafdd9c6de48fab772fe4c0308dcdada273f9714c813f61c7831f02c6a'
ROOT_LOCAL_TESTS={'ui': 137, 'backendStageAndResponse': 12, 'attentionCompatibility': 12, 'hostRouteIntegration': 16, 'independentRegression': 10, 'installer': 146}
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
NAME='palitra-darya-workspace-20261020-r2'
CODE=ROOT/(NAME+'-code')
SHA=lambda raw:hashlib.sha256(raw).hexdigest()
digest=lambda value:type(value) is str and re.fullmatch('[a-f0-9]{64}',value) is not None
PINS={'release-native.py': '3ab2d48f02418be290dad21fa9b57ca945c03231523f864ebe8c2d547d31e5c0', 'company-app.py': '9f525765313b1fa8d92bbde5815de8b02f1877dd22896cc0e04bc10a3c155e24', 'ROLLBACK.md': 'a6d573a17162c750ad07f81c43c80fc8d4d154c24f4389bff1d33b3acb7cb035', 'traffic-db.py': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f', 'ROOT_PRODUCT_ACCEPTANCE.json': 'e5c6c8b6457393c78d16379485d3a5f0bc6a51ac8851e062049eda0da38ecb05', 'parent-notify-r2.py': '58296305f2ee805f4c390b0676cf8f573ee4d8f3cd9cd6b605c377fb10a71915', 'nebo-basis-v5.py': '601c6b8925dbb761465f3072cebb041731b40bb50420394a02df936c6016389c'}
BINDINGS={'parentReceiptSha256': '79c4657ca15402b34b36d51642f4e8565701f8ab1b06fc446e5d629e674172f3', 'productReviewSha256': '57467101d22d8b11e93db549144d7fa5360d6cc832af960845079cae99efcc36', 'rootProductAcceptanceSha256': 'e5c6c8b6457393c78d16379485d3a5f0bc6a51ac8851e062049eda0da38ecb05', 'parentLoaderSha256': '58296305f2ee805f4c390b0676cf8f573ee4d8f3cd9cd6b605c377fb10a71915', 'neboAdapterSha256': '601c6b8925dbb761465f3072cebb041731b40bb50420394a02df936c6016389c', 'parentImage': 'sha256:40c8fc48d96478d65d87e72954a29731cbad9d64e11c2a68df92a86c9aee4717', 'attentionModuleSha256': '63e17f5e1f758446e43f691f42869ed479b8a658e67ab5b908403bebb1360611', 'attentionDependencies': {'palitra-workflow.cjs': 'b103fed76f99e7d88cd9c68308cd2ec694ab34d484809cd021dbcb236f36dc49', 'customer-chat-native-adapter.cjs': '7ab038804f241488df31a19c9cc168d67f20331a82c79b07714a1dc2962e6eb3', 'client-dialogs.js': '21a4ac8c0796f85e4901c647028576d9a2fcd01aeb49d1b6d731ca7f09ecafcc', 'native-contact-followup.cjs': '685fa6cd5effb24c72adf9fec6fa001bc3e39351549165d27d1b320ab2f5caf0', 'customer-chat.js': '2cc2dbd6e24dfaca6876d03a131491660e805c59b3c35255de3574ce2c5f8d55'}, 'afterDependencies': {'palitra-workflow.cjs': '36f7cb0f56e0058022be0815afc251f5ce96f874905dffbe783cffeb5264f112', 'customer-chat-native-adapter.cjs': '7ab038804f241488df31a19c9cc168d67f20331a82c79b07714a1dc2962e6eb3', 'client-dialogs.js': '21a4ac8c0796f85e4901c647028576d9a2fcd01aeb49d1b6d731ca7f09ecafcc', 'native-contact-followup.cjs': '685fa6cd5effb24c72adf9fec6fa001bc3e39351549165d27d1b320ab2f5caf0', 'customer-chat.js': '2cc2dbd6e24dfaca6876d03a131491660e805c59b3c35255de3574ce2c5f8d55'}, 'responseModuleSha256': '62ffa4bc34e041b906a06e5abb0b017c47bdc3fae975479c81307dd8d81e29f2', 'workflowModuleSha256': '36f7cb0f56e0058022be0815afc251f5ce96f874905dffbe783cffeb5264f112', 'observationKey': 'palitra-love/response-time-observation/v1', 'groupReviewSha256': '222ba812eb92208765368f24966e85ca8217081ae8ef8ca9dd606e325b2c6b22', 'queueModuleSha256': 'f46720163a8ec1f6ab75a45a86bc7dd951923e5755293acf537f87073e1df7d7', 'manifestSha256': '5b1fd2fe0e8354cdef1f6273c061b6bb74134efe2713c1610a54dc00d716e9b2', 'dbGuardSha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63', 'contentDbGuardSha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be', 'trafficDbGuardSha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f', 'rollbackSha256': 'a6d573a17162c750ad07f81c43c80fc8d4d154c24f4389bff1d33b3acb7cb035', 'managedProofSha256': '40ef3d261c68fcdca488a31da328e245f70066066bbc92cfebba28a4f19c453d', 'managedProbeSha256': '6adf008d2a6016031b6ad6812c3550a557694293a9a855a92cfb64e6c964ca6f', 'mapOutcomeSha256': '7c206110ddb478f1be1221e689ea346e125b9e438096b59af39a7eb84ebc2c42'}

def need(ok, code):
    if not ok:
        raise ValueError(code)

def read(path, pin):
    need(not any(p.is_symlink() for p in [path, *path.parents]), 'PATH_ALIAS_REFUSED')
    s = path.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == s.st_gid == 0
         and stat.S_IMODE(s.st_mode) == 0o600, 'PRIVATE_ROOT_SINGLE_LINK_REQUIRED')
    raw = path.read_bytes()
    need(len(raw) <= 2 * 1024 * 1024 and SHA(raw) == pin, 'EXACT_PIN_REQUIRED')
    return raw

def write(path, raw):
    need(not os.path.lexists(path) and not any(p.is_symlink() for p in path.parents), 'NEW_NAMESPACE_REQUIRED_NO_REPLAY')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def build_acceptance(pre,managed):
    # Pure value construction for review; no filesystem, subprocess, SQL or network.
    return {**BINDINGS,'schema':1,'status':'ACCEPTED_DARYA_WORKSPACE_R2_PRODUCT_AND_INSTALLER',
      'installerStatus':'ACCEPTED_DARYA_WORKSPACE_R2_INSTALLER_AND_ROLLBACK',
      'runtimeApplyAuthorized':True,'productRootReviewAccepted':True,'workerActivationAuthorized':False,
      'writerThreadId':'01a0a408-4f98-7713-a652-e6a741da834c','reviewerThreadId':'01a0a408-4f98-7713-a652-e6a741da834c',
      'neboBasisSha256':NEBO_BASIS_PIN,'featureBootObservationAppendMaximum':1,
      'helperSha256':PINS['release-native.py'],'managedSourceProof':managed,
      'sourceCounts':{'before':235,'after':239},'contentSchemaObjectsCreated':0,
      'parentPostSchemaSha256':pre['parentPostSchemaSha256'],'rootPreflightSha256':PREFLIGHT_PIN,
      'rootLocalTests':ROOT_LOCAL_TESTS,'fullCustomerAcceptance':False}

def main():
    need(TRANSPORT_READY is True and type(EXPECTED_PID) is int and EXPECTED_PID>1
         and all(digest(pin) for pin in (PREFLIGHT_PIN,ROOT_RUNTIME_ACCEPTANCE_SHA,NEBO_BASIS_PIN,*PINS.values()))
         and type(ROOT_LOCAL_TESTS) is dict and ROOT_LOCAL_TESTS and all(type(n) is int and n>=0 for n in ROOT_LOCAL_TESTS.values()),'TRANSPORT_FINAL_REVIEW_PINS_PENDING')
    need(os.name=='posix' and os.geteuid()==0 and len(sys.argv)==3,'ROOT_EXACT_PREFLIGHT_REQUIRED')
    pid=int(sys.argv[1]);pin=sys.argv[2]
    need(pid==EXPECTED_PID and pin==PREFLIGHT_PIN,'REVIEWED_ACTUAL_PID_AND_PREFLIGHT_REQUIRED')
    lock='/opt/synapse/.palitra-app-release.lock'
    rows=[r.strip().split(maxsplit=1) for r in subprocess.check_output(['lslocks','--noheadings','--output','PID,PATH']).decode().splitlines()]
    need([r for r in rows if len(r)==2 and r[1]==lock]==[[str(pid),lock]],'OWN_EXACT_LEASE_REQUIRED')
    for name,wanted in PINS.items():read(CODE/name,wanted)
    pre=json.loads(read(Path('/tmp/darya-r2-readonly-'+str(pid)+'.json'),pin))
    need(pre.get('status')=='CURRENT_NEBO_NOTIFY_READONLY_NOT_APPROVED'
         and pre.get('runtimeWrites')==pre.get('contentSchemaObjectsCreated')==0
         and pre.get('productReviewSha256')==BINDINGS['productReviewSha256']
         and pre.get('rootProductAcceptanceSha256')==BINDINGS['rootProductAcceptanceSha256']
         and pre.get('neboBasisSha256')==NEBO_BASIS_PIN
         and pre.get('responseModuleSha256')==BINDINGS['responseModuleSha256']
         and pre.get('attentionDependencies')==BINDINGS['attentionDependencies']
         and (pre.get('sourceFiles'),pre.get('staticFiles'),pre.get('chainFiles'),pre.get('candidateSourceFiles'),pre.get('candidateStaticFiles'))==(235,41,41,239,43),'EXACT_PASSED_PREFLIGHT_REQUIRED')
    need(digest(pre.get('parentPostSchemaSha256')) and pre.get('trafficDatabaseBefore',{}).get('status') in ('ABSENT','EXISTING'),'REVIEWED_SCHEMA_AND_THIRD_STORE_REQUIRED')
    managed=json.loads(read(ROOT/'multi-company-app-20261019-r7c-managed-proof.json',BINDINGS['managedProofSha256']))
    need(managed['current']['version']==259 and managed['historical']['version']==257 and managed['current']['mismatches']==[],'EXACT_MANAGED_SOURCE_REQUIRED')
    for suffix in ('decision.json','journal.json','overlay.json','context','backup'):
        path=ROOT/(NAME+'-'+suffix)
        need(not os.path.lexists(path) and not os.path.lexists(str(path)+'.pending'),'OWN_ATTEMPT_EXISTS_NO_REPLAY')
    acceptance=build_acceptance(pre,managed)
    raw=(json.dumps(acceptance,sort_keys=True,separators=(',',':'))+'\n').encode()
    acceptance_pin=SHA(raw)
    need(acceptance_pin==ROOT_RUNTIME_ACCEPTANCE_SHA,'EXPLICIT_ROOT_REVIEWED_ACCEPTANCE_BYTES_REQUIRED')
    write(CODE/'ROOT_ACCEPTANCE.json',raw)
    print(json.dumps({'status':'EXACT_NEW_ROOT_ACCEPTANCE_SAVED_NOT_APPLIED','acceptanceSha256':acceptance_pin}),flush=True)
    # approve-current writes a decision only; apply-current is never invoked here.
    result=subprocess.run(['python3','-B',str(CODE/'company-app.py'),'approve-current','--lease-pid',str(pid),'--acceptance-sha',acceptance_pin,'--apply'],capture_output=True,timeout=180)
    need(len(result.stdout)<=2*1024*1024,'BOUNDED_APPROVAL_RESULT_REQUIRED')
    write(Path('/tmp/darya-r2-approval-'+str(pid)+'.json'),result.stdout)
    value=json.loads(result.stdout);value['approvalOutputSha256']=SHA(result.stdout);value['exitCode']=result.returncode
    print(json.dumps(value,separators=(',',':')));return result.returncode

if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:
        print(json.dumps({'status':'APPROVAL_REFUSED_OR_UNKNOWN_NO_REPLAY','code':str(error) if type(error) is ValueError else type(error).__name__}));sys.exit(2)
