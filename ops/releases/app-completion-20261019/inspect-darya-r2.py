"""Frozen R2 full read-only preflight of NEBO over notify. Root review required before use. Never approve/apply."""
import hashlib,json,os,re,stat,subprocess,sys,types
TRANSPORT_READY=True
NEBO_BASIS_SHA='bcb5cefafdd9c6de48fab772fe4c0308dcdada273f9714c813f61c7831f02c6a'
from pathlib import Path
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-darya-workspace-20261020-r2-code')
PINS={'release-native.py': '3ab2d48f02418be290dad21fa9b57ca945c03231523f864ebe8c2d547d31e5c0', 'company-app.py': '9f525765313b1fa8d92bbde5815de8b02f1877dd22896cc0e04bc10a3c155e24', 'traffic-db.py': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f', 'parent-notify-r2.py': '58296305f2ee805f4c390b0676cf8f573ee4d8f3cd9cd6b605c377fb10a71915', 'nebo-basis-v5.py': '601c6b8925dbb761465f3072cebb041731b40bb50420394a02df936c6016389c', 'ROOT_PRODUCT_ACCEPTANCE.json': 'e5c6c8b6457393c78d16379485d3a5f0bc6a51ac8851e062049eda0da38ecb05'}
SHA=lambda b:hashlib.sha256(b).hexdigest()
def need(ok,code):
    if not ok:raise ValueError(code)
def main():
    need(TRANSPORT_READY is True and type(NEBO_BASIS_SHA) is str and re.fullmatch('[a-f0-9]{64}',NEBO_BASIS_SHA) and all(type(pin) is str and re.fullmatch('[a-f0-9]{64}',pin) for pin in PINS.values()),'TRANSPORT_FINAL_PINS_PENDING')
    need(os.name=='posix' and os.geteuid()==0 and len(sys.argv)==2,'ROOT_FRESH_PID_REQUIRED')
    pid=int(sys.argv[1]);need(pid>1,'FRESH_PID_REQUIRED')
    lock='/opt/synapse/.palitra-app-release.lock'
    rows=[r.strip().split(maxsplit=1) for r in subprocess.check_output(['lslocks','--noheadings','--output','PID,PATH']).decode().splitlines()]
    need([r for r in rows if len(r)==2 and r[1]==lock]==[[str(pid),lock]],'OWN_EXACT_LEASE_REQUIRED')
    for name,pin in PINS.items():
        p=CODE/name;s=p.lstat()
        need(not any(v.is_symlink() for v in [p,*p.parents]) and stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and SHA(p.read_bytes())==pin,'EXACT_PRIVATE_FROZEN_CODE_REQUIRED')
    output=Path('/tmp/darya-r2-readonly-'+str(pid)+'.json')
    need(not os.path.lexists(output),'OWN_READONLY_PROOF_EXISTS_NO_REPLAY')
    m=types.ModuleType('frozen_manager_readonly');m.__file__=str(CODE/'release-native.py')
    exec(compile((CODE/'release-native.py').read_bytes(),m.__file__,'exec'),m.__dict__)
    need(m.FROZEN is True and m.NEBO_BASIS_SHA==NEBO_BASIS_SHA,'FROZEN_MANAGER_AND_NEBO_BASIS_REQUIRED')
    a,b,prior,current=m.load_current_notify_r2(pid)
    release=m.Release(a,b,prior,current,pid)
    value=release.inspect_current()
    value['trafficDatabaseBefore']=release.traffic.read()
    value['parentPostSchemaSha256']=current.content_migration['afterSchemaSha256']
    value['productReviewSha256']=m.PRODUCT_REVIEW_SHA
    value['rootProductAcceptanceSha256']=m.ROOT_PRODUCT_ACCEPTANCE_SHA
    value['attentionDependencies']=m.ATTENTION_DEPENDENCIES
    value['neboBasisSha256']=m.NEBO_BASIS_SHA
    value['responseModuleSha256']=m.RESPONSE_MODULE_SHA
    release.lease()
    raw=(json.dumps(value,sort_keys=True,separators=(',',':'))+chr(10)).encode()
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    summary={k:value[k] for k in ('status','sourceFiles','staticFiles','chainFiles','candidateSourceFiles','candidateStaticFiles','runtimeWrites','contentSchemaObjectsCreated','parentPostSchemaSha256')}
    summary.update(proofPath=str(output),proofSha256=SHA(raw),trafficStatus=value['trafficDatabaseBefore']['status'],rootProductAccepted=True,attentionDependencies=5,exitCode=0)
    print(json.dumps(summary,separators=(',',':')));return 0
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:print(json.dumps({'status':'MANAGER_READONLY_REFUSED_NO_APPLY','code':str(error) if type(error) is ValueError else type(error).__name__}));sys.exit(2)
