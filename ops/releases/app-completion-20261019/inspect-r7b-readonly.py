"""Run only frozen R7B inspect-current and retain its complete read-only proof."""
import hashlib,json,os,subprocess,sys
from pathlib import Path

CODE=Path('/opt/synapse/releases/palitra-app-20261015/multi-company-app-20261019-r7b-code')
PINS={'release-native.py':'5610ff8008b25b334c184388873d3633df5e9a92fa409c96ab7dca42bb441ff9',
      'company-app.py':'5fd92095440c9a8d1d59cd6d1036e3d5c509a8dba161acf9a629d23792b9c829'}
SHA=lambda raw:hashlib.sha256(raw).hexdigest()

def need(value,code):
    if not value:raise ValueError(code)

def main():
    need(os.name=='posix' and os.geteuid()==0,'ROOT_REQUIRED')
    pid=int(sys.argv[1]);need(pid>1,'FRESH_PID_REQUIRED')
    lock='/opt/synapse/.palitra-app-release.lock'
    rows=[r.strip().split(maxsplit=1) for r in subprocess.check_output(['lslocks','--noheadings','--output','PID,PATH']).decode().splitlines()]
    need([r for r in rows if len(r)==2 and r[1]==lock]==[[str(pid),lock]],'OWN_EXACT_LEASE_REQUIRED')
    for name,pin in PINS.items():
        path=CODE/name
        need(not any(p.is_symlink() for p in [path,*path.parents]) and SHA(path.read_bytes())==pin,'EXACT_FROZEN_CODE_REQUIRED')
    output=Path('/tmp/r7b-readonly-'+str(pid)+'.json')
    need(not os.path.lexists(output),'OWN_READONLY_PROOF_EXISTS_NO_REPLAY')
    result=subprocess.run(['python3',str(CODE/'company-app.py'),'inspect-current','--lease-pid',str(pid)],capture_output=True,timeout=180)
    need(len(result.stdout)<2*1024*1024,'BOUNDED_READONLY_PROOF_REQUIRED')
    value=json.loads(result.stdout)
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
    with os.fdopen(fd,'wb') as stream:stream.write(result.stdout);stream.flush();os.fsync(stream.fileno())
    summary={k:value[k] for k in ('status','code','messageSha256','sourceFiles','sealedSourceFiles','supplementalExistingSourceFiles','staticFiles','chainFiles','candidateSourceFiles','candidateStaticFiles','sourceSupplement','reportDatabaseBefore','runtimeWrites') if k in value}
    summary.update(proofPath=str(output),proofSha256=SHA(result.stdout),exitCode=result.returncode)
    print(json.dumps(summary,separators=(',',':')))
    return result.returncode

if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:print(json.dumps({'status':'READONLY_WRAPPER_REFUSED','error':str(error) if type(error) is ValueError else type(error).__name__}));sys.exit(2)
