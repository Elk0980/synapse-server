"""Read-only exact candidate before-pin differences; no application import or writes."""
import hashlib,json
from pathlib import Path
p=Path('/tmp/pc-i2.py');b=p.read_bytes();assert hashlib.sha256(b).hexdigest()=='7538349eecc4a56e7a66af956d6b4175251d031f3cf930a41da2faaae8aa92ca'
n={'__name__':'read_compare','__file__':str(p)};exec(compile(b,str(p),'exec'),n)
staged,bundle,m=n['package']();product,native,reader,contract=n['primitive']();trees={'content':n['tree'](n['CONTENT'],reader),'crm':n['tree'](n['CRM'],reader)};differences=[]
for row in m['files']:
 parts=row['file'].split('/',2)
 if parts[1]=='static':continue
 rel=parts[2];actual=trees[parts[1]].get(rel);pin=actual.get('sha256') if actual else None
 if pin!=row['beforeSha256']:differences.append({'file':row['file'],'expected':row['beforeSha256'],'actual':pin,'metadata':actual})
print(json.dumps({'status':'READ_ONLY_DIFFERENCES','differences':differences,'productionOperations':0}))
