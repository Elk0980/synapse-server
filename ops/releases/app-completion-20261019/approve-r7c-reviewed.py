"""Create a new exact Root acceptance and decision only; never installs or replays."""
from pathlib import Path
import hashlib, json, os, re, subprocess, sys, stat
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
CODE=ROOT/'multi-company-app-20261019-r7c-code'
PROOF=ROOT/'multi-company-app-20261019-r7c-managed-proof.json'
PINS={'release-native.py':'3ed553c0abc38e301792b15558c9eb7cf1656fb53bb58fafcc162a363e5b3020',
      'company-app.py':'376e1451bf30d84d0f552f9d0889f48a35ad3c7c3c111c5a80e025d30ef55bda',
      'ROLLBACK.md':'62bfb699e248e22560aac5386d2b157d931bfbabcac1fde3ce3066038cf537da'}
MANAGED_SHA='40ef3d261c68fcdca488a31da328e245f70066066bbc92cfebba28a4f19c453d'
SHA=lambda raw:hashlib.sha256(raw).hexdigest()
def need(ok,code):
    if not ok:raise ValueError(code)
def read(path,pin,private=False):
    need(not any(p.is_symlink() for p in [path,*path.parents]),'PATH_ALIAS_REFUSED')
    s=path.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==0,'ROOT_SINGLE_LINK_FILE_REQUIRED')
    if private:need(stat.S_IMODE(s.st_mode)==0o600,'PRIVATE_FILE_REQUIRED')
    raw=path.read_bytes();need(len(raw)<=2*1024*1024 and SHA(raw)==pin,'EXACT_PIN_REQUIRED');return raw
def write(path,raw):
    need(not os.path.lexists(path) and not any(p.is_symlink() for p in path.parents),'NEW_NAMESPACE_REQUIRED_NO_REPLAY')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
    with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
def main():
    need(os.name=='posix' and os.geteuid()==0 and len(sys.argv)==3,'ROOT_AND_EXACT_PREFLIGHT_PIN_REQUIRED')
    pid=int(sys.argv[1]);pin=sys.argv[2];need(pid>1 and re.fullmatch('[a-f0-9]{64}',pin),'EXACT_INPUTS_REQUIRED')
    lock='/opt/synapse/.palitra-app-release.lock'
    rows=[r.strip().split(maxsplit=1) for r in subprocess.check_output(['lslocks','--noheadings','--output','PID,PATH']).decode().splitlines()]
    need([r for r in rows if len(r)==2 and r[1]==lock]==[[str(pid),lock]],'OWN_EXACT_LEASE_REQUIRED')
    for name,wanted in PINS.items():read(CODE/name,wanted)
    pre=json.loads(read(Path('/tmp/r7c-readonly-'+str(pid)+'.json'),pin,True))
    need(pre.get('status')=='CURRENT_R6_READONLY_NOT_APPROVED' and pre.get('runtimeWrites')==0
         and (pre.get('sourceFiles'),pre.get('sealedSourceFiles'),pre.get('supplementalExistingSourceFiles'),pre.get('staticFiles'),pre.get('chainFiles'),pre.get('candidateSourceFiles'),pre.get('candidateStaticFiles'))==(228,227,1,35,38,235,41),'EXACT_PASSED_PREFLIGHT_REQUIRED')
    supplement={'path':'project-chat.js','sha256':'f60b18567b81c8ed0ea28e1609c208d75fa78e95bad3cbbd6d24ea595d9bbf44','bytes':179739,'uid':0,'gid':0,'mode':0o600,'nlink':1,'regular':True,'symlink':False,'canonical':True}
    need(pre.get('sourceSupplement')==supplement,'EXACT_OBSERVED_SUPPLEMENT_REQUIRED')
    managed=json.loads(read(PROOF,MANAGED_SHA,True))
    need(managed['current']['version']==259 and managed['historical']['version']==257 and managed['current']['mismatches']==[],'EXACT_MANAGED_CURRENT_REQUIRED')
    name='multi-company-app-20261019-r7c'
    for suffix in ('decision.json','journal.json','overlay.json','context','backup'):
        need(not os.path.lexists(ROOT/(name+'-'+suffix)) and not os.path.lexists(str(ROOT/(name+'-'+suffix))+'.pending'),'OWN_ATTEMPT_EXISTS_NO_REPLAY')
    acceptance={'schema':1,'status':'ACCEPTED_R7C_PRODUCT_AND_INSTALLER','installerStatus':'ACCEPTED_NATIVE_R7C_INSTALLER_AND_ROLLBACK',
        'runtimeApplyAuthorized':True,'workerActivationAuthorized':False,
        'writerThreadId':'01a0a408-4f98-7713-a652-e6a741da834c','reviewerThreadId':'01a0a408-4f98-7713-a652-e6a741da834c',
        'parentReceiptSha256':'70c0489236d120a84074b3a45acacc21c3e26e3fe42408b8324af8439280d0ea',
        'productReviewSha256':'c45c91f084c3f5a5b08a21cea3f79cc99ca294e77ab48c77cb1c1ebccffdc971',
        'manifestSha256':'af7bd62072e4a6eb369b46e04ca6c7dc5a4c3bc2e9350a605483af12fc551b0d',
        'dbGuardSha256':'08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63',
        'contentDbGuardSha256':'d6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be',
        'contentMigrationSha256':'84e3e34c782a36f555a850cff6ea761823ef625059d1c782f5039f328dc27100',
        'helperSha256':PINS['release-native.py'],'rollbackSha256':PINS['ROLLBACK.md'],
        'managedProofSha256':MANAGED_SHA,'managedProbeSha256':'6adf008d2a6016031b6ad6812c3550a557694293a9a855a92cfb64e6c964ca6f',
        'mapOutcomeSha256':'7c206110ddb478f1be1221e689ea346e125b9e438096b59af39a7eb84ebc2c42','managedSourceProof':managed,
        'sourceSupplement':supplement,'sourceCounts':{'sealed':227,'supplementalExisting':1,'before':228,'after':235},
        'rootPreflightSha256':pin,'rootLocalTests':{'pythonFrozen':52,'realSQLiteFilesystem':9},'fullCustomerAcceptance':False}
    raw=(json.dumps(acceptance,sort_keys=True,separators=(',',':'))+'\n').encode();acceptance_pin=SHA(raw)
    write(CODE/'ROOT_ACCEPTANCE.json',raw)
    print(json.dumps({'status':'EXACT_NEW_ROOT_ACCEPTANCE_SAVED_NOT_APPLIED','acceptanceSha256':acceptance_pin}),flush=True)
    result=subprocess.run(['python3',str(CODE/'company-app.py'),'approve-current','--lease-pid',str(pid),'--acceptance-sha',acceptance_pin,'--apply'],capture_output=True,timeout=180)
    need(len(result.stdout)<=2*1024*1024,'BOUNDED_APPROVAL_RESULT_REQUIRED')
    write(Path('/tmp/r7c-approval-'+str(pid)+'.json'),result.stdout)
    value=json.loads(result.stdout);value['approvalOutputSha256']=SHA(result.stdout);value['exitCode']=result.returncode
    print(json.dumps(value,separators=(',',':')))
    return result.returncode
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:print(json.dumps({'status':'APPROVAL_REFUSED_OR_UNKNOWN_NO_REPLAY','code':str(error) if type(error) is ValueError else type(error).__name__}));sys.exit(2)
