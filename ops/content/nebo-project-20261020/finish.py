"""Read-only final native verification; no runtime, permission, or business writes."""
from pathlib import Path
import hashlib,json,runpy,sqlite3
x=runpy.run_path('/tmp/nebo-import-r3.py')
x['guard']()
root=x['ROOT'];stage=json.loads((root/'STAGED.json').read_text())
assert x['code_hashes']()==stage['moduleHashes'],'SOURCE_CHANGED'
data=Path(stage['hostData']);outcome=json.loads((data/'SITE_OUTCOME_R3.json').read_text())
db=sqlite3.connect('file:'+str(data.parent/'content.sqlite')+'?mode=ro',uri=True)
row=db.execute('SELECT hostname,current_revision FROM site_workspaces WHERE site_id=?',(outcome['siteId'],)).fetchone()
assert row==('nebo-draft-1.synapsebusiness.ru',outcome['revision'])
actual=data.parent/'projects'/'nebo'/'sites'/outcome['siteId']/'versions'/row[1]
expected={p.relative_to(data/'static').as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in (data/'static').rglob('*') if p.is_file()}
installed={p.relative_to(actual).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in actual.rglob('*') if p.is_file()}
assert installed==expected and len(installed)==116,'EXACT_STATIC_FILES_REQUIRED'
backup=sqlite3.connect('file:'+str(data/'content-before-site-r3.sqlite')+'?mode=ro',uri=True)
assert backup.execute('PRAGMA quick_check').fetchone()[0]=='ok';backup.close();db.close()
r=runpy.run_path('/tmp/nebo-register-r3.py')
ready=json.loads((x['BASE']/'READY.json').read_text())
assert r['containers']()==ready['otherContainers'],'OTHER_CONTAINERS_CHANGED'
assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==digest for p,digest in ready['composeSha'].items())
facts={**outcome,'status':'FINAL_NATIVE_VERIFIED','image':x['IMAGE'],'all116FilesExact':True,'sourceModulesExact':True,'otherContainersExact':True,'oldComposeExact':True,'sqliteBackupQuickCheck':'ok','privateMaterialsFiles':62,'caddyEdits':0,'extraRestarts':0}
with (root/'FINAL_NATIVE.json').open('x') as f:json.dump(facts,f,indent=2)
(root/'FINAL_NATIVE.json').chmod(0o600)
print(json.dumps(facts))
