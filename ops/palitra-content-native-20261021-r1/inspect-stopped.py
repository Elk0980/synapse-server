"""Read-only stopped-install diagnosis. Hashes/paths only, no secrets, no retry."""
import copy,hashlib,json
from pathlib import Path
p=Path('/tmp/pc-i3.py');b=p.read_bytes();assert hashlib.sha256(b).hexdigest()=='078b2a393a1dd3b6530dbcca19105599dac4bf63c5d45172fa11dc43696e1328'
n={'__name__':'stopped_readonly','__file__':str(p)};exec(compile(b,str(p),'exec'),n)
staged,bundle,m=n['package']();product,native,reader,contract=n['primitive']();a=n['load'](n['AREA']/'action.json');base=n['load'](n['AREA']/'base.json');native.Ticket.native_lease(a['lease']);journal=n['ROOT']/(a['namespace']+'-apply');records=[n['load'](p) for p in sorted(journal.glob('*.json'))];actual=n['content_snapshot'](native,reader,contract);expected=copy.deepcopy(base['content']);children={};published=set()
for r in records:
 if r['status']=='RETURNED_REQUIRES_READBACK' and r['phase'].startswith('build-'):children[n['CONTENT'] if r['phase']=='build-content' else n['CRM']]=r['facts']
 if r['phase']=='static-file' and r['status']=='CAS_READBACK':published.add(r['facts']['path'])
after=actual['image']!=expected['image']
if after:
 obj=object.__new__(n['Apply']);obj.base=base
 expected.update(image=children[n['CONTENT']]['image'],appTree=obj.expected_tree(n['CONTENT']))
 overlay=journal/'content-crm-overlay.json';c=copy.deepcopy(base['content']['compose']);c['files'].append({'path':str(overlay),'sha256':n['sha'](n['read'](overlay))});c['resolved']['services']['content']['image']=children[n['CONTENT']]['image'];c['resolved']['services']['crm']['image']=children[n['CRM']]['image'];expected['compose']=c
 expected['source']={k:expected['appTree'][k]['sha256'] for k in base['content']['source']}
 crm=n['inspect'](n['CRM']);expected['invariants']['foreignContainers'][n['CRM']]=reader.foreign(crm)
 for group in ['authCode','pushCode']:
  hashes=expected['invariants'][group]['files'] if group=='authCode' else expected['invariants'][group]
  for rel,row in base['overlays'][n['CONTENT']].items():
   if rel in hashes:hashes[rel]=row['sha256']
for target in published:
 if target in expected['static']:expected['static'][target]['sha256']=base['statics'][target]['afterSha256']
diffs=[]
def walk(x,y,path=''):
 if type(x)!=type(y):diffs.append([path,'type']);return
 if isinstance(x,dict):
  for k in sorted(set(x)|set(y)):
   if k not in x or k not in y:diffs.append([path+'.'+k,'missing'])
   else:walk(x[k],y[k],path+'.'+k)
 elif x!=y:diffs.append([path,n['sha'](n['enc'](x)),n['sha'](n['enc'](y))])
walk(expected,actual)
report={'status':'READ_ONLY_STOPPED_DIAGNOSIS','namespace':a['namespace'],'afterImages':after,'phases':[[r['phase'],r['status']] for r in records],'differences':diffs,'children':children,'published':sorted(published)};n['write'](n['AREA']/('stopped-read-'+str(__import__('time').time_ns())+'.json'),n['enc'](report))
print(json.dumps({'afterImages':after,'phaseCount':len(records),'lastPhases':report['phases'][-4:],'differenceCount':len(diffs),'children':children}))
for row in diffs[:16]:print(json.dumps(row))
