"""Read-only difference paths after a refused attempt. Never prints source, secrets or data."""
from pathlib import Path
import hashlib, json, sys
sys.dont_write_bytecode = True
helper = Path('/tmp/pc-care-13e3b12.py')
raw = helper.read_bytes()
assert hashlib.sha256(raw).hexdigest() == 'e964640f33b6e87a61cc6babc4c415e1760f6ca8a225f7ab4cb15f0242e0a7fe'
scope = {'__name__':'read_only_refusal_diagnosis','__file__':str(helper)}
exec(compile(raw,str(helper),'exec'),scope)
scope['package']()
_, native, reader, contract = scope['old']['primitive']()
scope['own_lease'](native)
area = scope['AREA']
base = scope['load'](area/'base.json')
actual = scope['old']['content_snapshot'](native,reader,contract)
paths = []
def diff(a,b,path=''):
    if len(paths) >= 80: return
    if type(a) is not type(b): paths.append(path+':type'); return
    if isinstance(a,dict):
        for key in sorted(set(a)|set(b)):
            if key not in a or key not in b: paths.append(path+'/'+str(key)+':presence')
            else: diff(a[key],b[key],path+'/'+str(key))
    elif isinstance(a,list):
        if len(a)!=len(b): paths.append(path+':length')
        for i,(x,y) in enumerate(zip(a,b)): diff(x,y,path+'/'+str(i))
    elif a!=b: paths.append(path)
diff(base['content'],actual)
action=scope['load'](area/'action.json')
journal=scope['ROOT']/(action['namespace']+'-apply')
print(json.dumps({'status':'READONLY_REFUSAL_DIAGNOSIS','differentPaths':paths,'pathCountBound':80,
 'journalExists':journal.exists(),'installedReceiptExists':(area/'installed.json').exists(),
 'journalFiles':sorted(p.name for p in journal.iterdir()) if journal.exists() else [],
 'productionWritesByDiagnosis':0,'secretsOrBusinessValuesPrinted':False}))
