"""Frozen R11 full read-only preflight with third-store evidence. Never approve/apply."""
import hashlib,json,os,stat,subprocess,sys,types
from pathlib import Path
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-notify-update-20261020-r2-code')
PINS={'release-native.py': '0e2a1f5487cb62578846d55f8d91bd2a9869afb8dca8f927bea0df5e7b9e9016', 'company-app.py': '15c16be0e3d132fdc0416cb8fdec6175d12b1c828fbddc5b2243d2c6c71b75a1', 'traffic-db.py': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'}
SHA=lambda b:hashlib.sha256(b).hexdigest()
def need(ok,code):
    if not ok:raise ValueError(code)
def main():
    need(os.name=='posix' and os.geteuid()==0 and len(sys.argv)==2,'ROOT_FRESH_PID_REQUIRED')
    pid=int(sys.argv[1]);need(pid>1,'FRESH_PID_REQUIRED')
    lock='/opt/synapse/.palitra-app-release.lock'
    rows=[r.strip().split(maxsplit=1) for r in subprocess.check_output(['lslocks','--noheadings','--output','PID,PATH']).decode().splitlines()]
    need([r for r in rows if len(r)==2 and r[1]==lock]==[[str(pid),lock]],'OWN_EXACT_LEASE_REQUIRED')
    for name,pin in PINS.items():
        p=CODE/name;s=p.lstat()
        need(not any(v.is_symlink() for v in [p,*p.parents]) and stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and SHA(p.read_bytes())==pin,'EXACT_PRIVATE_FROZEN_CODE_REQUIRED')
    output=Path('/tmp/notify-r2-readonly-'+str(pid)+'.json')
    need(not os.path.lexists(output),'OWN_READONLY_PROOF_EXISTS_NO_REPLAY')
    m=types.ModuleType('frozen_r11_readonly');m.__file__=str(CODE/'release-native.py')
    exec(compile((CODE/'release-native.py').read_bytes(),m.__file__,'exec'),m.__dict__)
    need(m.FROZEN is True,'FROZEN_R11_REQUIRED')
    a,b,prior,current=m.load_current_r7c(pid)
    release=m.Release(a,b,prior,current,pid)
    value=release.inspect_current()
    value['trafficDatabaseBefore']=release.traffic.read()
    value['parentPostSchemaSha256']=current.content_migration['afterSchemaSha256']
    value['productReviewSha256']=m.PRODUCT_REVIEW_SHA
    release.lease()
    raw=(json.dumps(value,sort_keys=True,separators=(',',':'))+chr(10)).encode()
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    summary={k:value[k] for k in ('status','sourceFiles','staticFiles','chainFiles','candidateSourceFiles','candidateStaticFiles','runtimeWrites','contentSchemaObjectsCreated','parentPostSchemaSha256')}
    summary.update(proofPath=str(output),proofSha256=SHA(raw),trafficStatus=value['trafficDatabaseBefore']['status'],exitCode=0)
    print(json.dumps(summary,separators=(',',':')));return 0
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:print(json.dumps({'status':'R11_READONLY_REFUSED_NO_APPLY','code':str(error) if type(error) is ValueError else type(error).__name__}));sys.exit(2)
