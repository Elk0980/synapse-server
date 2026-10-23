from pathlib import Path
import json,hashlib,sys
sys.dont_write_bytecode=True
p=Path('/tmp/pc-issued-r1.py');b=p.read_bytes();assert hashlib.sha256(b).hexdigest()=='e02a8da6af3fe713ec6051fa03c42cf6488347d255d496091cb5845ef37f3202'
s={'__name__':'readonly_guard_diagnosis','__file__':str(p)};exec(compile(b,str(p),'exec'),s)
staged,bundle,m=s['package']();product,native,reader,contract=s['old']['primitive']();lease=s['own_lease'](native)
o=object.__new__(s['Apply']);o.staged,o.bundle,o.m=staged,bundle,m;o.product,o.native,o.reader,o.contract=product,native,reader,contract
o.action,o.base=s['load'](s['AREA']/'action.json'),s['load'](s['AREA']/'base.json');o.readLease=lease;o.children,o.plan,o.published={},None,set();o.seq=0;o.journal=s['ROOT']/(o.action['namespace']+'-apply')
def diff(a,b,p=''):
 if type(a)is not type(b):return[p+':type']
 if isinstance(a,dict):return sum([diff(a[k],b[k],p+'/'+str(k))if k in a and k in b else[p+'/'+str(k)+':presence'] for k in sorted(set(a)|set(b))],[])[:80]
 if isinstance(a,list):return ([p+':length']if len(a)!=len(b)else[])+sum([diff(x,y,p+'/'+str(i))for i,(x,y)in enumerate(zip(a,b))],[])[:80]
 return []if a==b else[p]
print(json.dumps({'status':'READ_ONLY_DIAGNOSIS','journalExists':o.journal.exists(),'journalNames':sorted(p.name for p in o.journal.iterdir())if o.journal.exists()else[],'installedReceiptExists':(s['AREA']/'installed.json').exists(),'lease':lease}),flush=True)
for i in range(3):
 try:print(json.dumps({'sample':i,'status':'ORIGINAL_FULL_GUARD_PASS','snapshot':o.guard(False)}),flush=True)
 except Exception as e:
  tb=e.__traceback__;paths=[]
  while tb:
   v=tb.tb_frame.f_locals
   if tb.tb_frame.f_code.co_name=='guard'and'actual'in v and'want'in v:paths=diff(v['want'],v['actual'])
   tb=tb.tb_next
  print(json.dumps({'sample':i,'status':'REFUSAL','code':str(e)if isinstance(e,ValueError)else type(e).__name__,'paths':paths,'productionWrites':0}),flush=True)
