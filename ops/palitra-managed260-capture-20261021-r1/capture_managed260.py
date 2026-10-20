"""Read-only data capture. Does not import any old executable release entry."""
import hashlib, json, os
from pathlib import Path
import re, stat, subprocess, sys

ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
OLD=ROOT/'multi-company-app-20261019-r7c-managed-proof.json'
OLD_SHA='40ef3d261c68fcdca488a31da328e245f70066066bbc92cfebba28a4f19c453d'
LOCK='/opt/synapse/.palitra-app-release.lock'
sha=lambda b:hashlib.sha256(b).hexdigest()
def need(v,c):
    if not v: raise ValueError(c)
def read(p,maximum):
    for part in [p,*p.parents]:need(not part.is_symlink(),'PATH_ALIAS_REFUSED')
    s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==s.st_gid==0 and s.st_nlink==1 and s.st_size<=maximum,'ROOT_REGULAR_BOUND_REQUIRED')
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        a=os.fstat(fd);raw=os.read(fd,maximum+1);z=os.fstat(fd)
        need(len(raw)==s.st_size and (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(z.st_dev,z.st_ino,z.st_size,z.st_mtime_ns,z.st_ctime_ns),'FILE_CHANGED_DURING_READ')
        return raw
    finally:os.close(fd)
def lease(pid):
    r=subprocess.run(['lslocks','--noheadings','--output','PID,PATH'],check=True,capture_output=True,timeout=10)
    need(not r.stderr and len(r.stdout)<=1024*1024,'LEASE_OUTPUT_BOUND')
    rows=[s.strip().split(maxsplit=1) for s in r.stdout.decode().splitlines()]
    need([x for x in rows if len(x)==2 and x[1]==LOCK]==[[str(pid),LOCK]],'EXACT_FRESH_ROOT_LEASE_REQUIRED')
    text=(Path('/proc')/str(pid)/'stat').read_text();return text.rsplit(') ',1)[1].split()[19]
def main():
    need(os.name=='posix' and os.geteuid()==0,'ROOT_LINUX_ONLY')
    need(len(sys.argv)==3 and sys.argv[1]=='--lease-pid' and re.fullmatch('[1-9][0-9]{0,9}',sys.argv[2]),'EXPLICIT_ROOT_LEASE_REQUIRED')
    pid=int(sys.argv[2]);ticks=lease(pid)
    raw=read(OLD,128*1024);need(sha(raw)==OLD_SHA,'FROZEN_MANAGED259_PROOF_CHANGED')
    script=read(Path(__file__).with_name('managed260-probe.cjs'),128*1024)
    # Script explicitly calls capture260; require.main semantics are not relied on under node -e.
    invocation=script.decode()+"\nconst result=JSON.stringify(module.exports.capture260(JSON.parse(process.argv[1])));if(Buffer.byteLength(result)>524288)throw Error('OUTPUT_BOUND');process.stdout.write(result);"
    r=subprocess.run(['docker','exec','synapse-content-1','node','--disable-warning=ExperimentalWarning','-e',invocation,json.dumps(json.loads(raw),ensure_ascii=False,separators=(',',':'))],check=True,capture_output=True,timeout=60)
    need(not r.stderr and len(r.stdout)<=512*1024,'BOUNDED_READONLY_CAPTURE_REQUIRED')
    need(lease(pid)==ticks and read(OLD,128*1024)==raw,'CAPTURE_BOUNDARY_CHANGED')
    result=json.loads(r.stdout);need(result['runtimeWrites']==0,'NO_RUNTIME_WRITES_REQUIRED')
    result.update(frozenManagedProofSha256=OLD_SHA,probeSha256=sha(script),leasePid=pid,leaseStartTicks=ticks)
    print(json.dumps(result,ensure_ascii=False,separators=(',',':')))
if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'status':'READONLY_CAPTURE_REFUSED','errorType':type(e).__name__,'messageSha256':sha(str(e).encode()),'runtimeWrites':0}),file=sys.stderr);sys.exit(2)
