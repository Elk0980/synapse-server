"""Code hashes only; diagnose a refused readonly R7 constructor. No mutations."""
from pathlib import Path
import hashlib,json,subprocess,sys,types

def need(v,c):
    if not v:raise ValueError(c)
def main():
    pid=int(sys.argv[1]);lock='/opt/synapse/.palitra-app-release.lock'
    rows=[x.strip().split(maxsplit=1) for x in subprocess.check_output(['lslocks','--noheadings','--output','PID,PATH']).decode().splitlines()]
    need([r for r in rows if len(r)==2 and r[1]==lock]==[[str(pid),lock]],'OWN_LEASE_REQUIRED')
    code=Path('/opt/synapse/releases/palitra-app-20261015/multi-company-app-20261019-r7-code');p=code/'release-native.py';raw=p.read_bytes()
    need(hashlib.sha256(raw).hexdigest()=='bfde08a3d60ffd6ef9debae4a959f11184e1a1e88c8a5930deecac7a29302e54','EXACT_STAGED_R7_REQUIRED')
    m=types.ModuleType('readonly_r7');m.__file__=str(p);exec(compile(raw,str(p),'exec'),m.__dict__)
    a,b,prior,current=m.load_current_r6(pid)
    records=m.validate_records(json.loads((code/'payload/MANIFEST.json').read_text()))
    count=0
    for row in records.values():
        target=row['target']
        if target.startswith('external-cabinet/'):continue
        sealed=current.source.get(target);declared=row['beforeSourceSha256']
        if sealed==declared:continue
        count+=1
        print('MISMATCH',target)
        print('SEALED',sealed or 'ABSENT')
        print('DECLARED',declared or 'ABSENT')
        value=subprocess.check_output(['docker','exec','synapse-content-1','sha256sum','/app/'+target]).decode().split()[0]
        print('ACTUAL_RUNTIME',value)
    print('SOURCE_COUNT',len(current.source),'MISMATCH_COUNT',count,'READONLY_COMPLETE')
if __name__=='__main__':
    try:main()
    except Exception as e:print('READONLY_DIAG_REFUSED',str(e) if type(e) is ValueError else type(e).__name__);raise SystemExit(2)
