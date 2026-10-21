"""Fresh own attempt after exact read-only diagnosis of an inherited umask.
Accepted product, reader and installer bytes/guards remain unchanged.
"""
import hashlib,json,os,re,stat,sys
from pathlib import Path
sys.dont_write_bytecode=True
H=Path('/tmp/tg-r1.py');s=H.lstat()
if H.is_symlink() or not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1:raise ValueError('HELPER_BOUNDARY')
fd=os.open(H,os.O_RDONLY|os.O_NOFOLLOW)
try:raw=os.read(fd,128*1024)
finally:os.close(fd)
if hashlib.sha256(raw).hexdigest()!='dc20b9135921087c620949e35e4da20b8154af7f4831a7af94319d6343c66be0':raise ValueError('HELPER_PIN')
d={'__name__':'root_accepted_helper','__file__':str(H)};exec(compile(raw,str(H),'exec'),d)
OLD=d['AREA'];NEW=d['ROOT']/'palitra-tg-native-install-20261021-r2'
def check_diagnosis():
 _,package,native,_,_=d['load']()
 diag=json.loads(native.read(OLD/'onecopy-readonly-diagnosis.json',native=True))
 need=d['need'];need(diag['runtimeFullBaseUnchanged'] is True and diag['oneAddedLayer'] is True and diag['sameImageConfig'] is True and diag['schemaPhaseAbsent'] is True and diag['upPhaseAbsent'] is True,'EXACT_PREWRITE_DIAGNOSIS_REQUIRED')
 need(diag['appTreeDifferenceCount']==1 and len(diag['appTreeDifferences'])==1,'ONE_DIRECTORY_ONLY')
 diff=diag['appTreeDifferences'][0]
 need(diff=={'path':'palitra-orders-public','expected':{'uid':0,'gid':0,'mode':493,'type':'directory'},'actual':{'uid':0,'gid':0,'mode':448,'type':'directory'}},'EXACT_DIRECTORY_MODE_CAUSE')
 action=json.loads(native.read(OLD/'action.json',native=True));folder=d['ROOT']/(action['namespace']+'-apply')
 phases=[json.loads(native.read(p,native=True)) for p in sorted(folder.glob('[0-9][0-9][0-9].json'))]
 need([p['phase'] for p in phases]==['admission','protected-backup','protected-backup','one-copy-build'] and not (folder/'result.json').exists(),'OLD_ATTEMPT_BOUNDARY_CHANGED')
 return native
def main():
 if os.name!='posix' or os.geteuid()!=0:raise ValueError('LINUX_ROOT_ONLY')
 mode=sys.argv[1]
 if mode=='prepare':
  native=check_diagnosis();d['need'](not NEW.exists(),'NEW_AREA_EXISTS_INSPECT_ONLY');NEW.mkdir(mode=0o700)
  for name in ('reader-manifest.json','installer-code-acceptance.json'):d['write'](NEW/name,native.read(OLD/name,native=True))
  d['AREA']=NEW;d['capture'](int(sys.argv[2]))
 elif mode=='apply':
  d['AREA']=NEW
  # Process-local only. Public application COPY directories must be 0755.
  # Existing write_new fchmod600 and mkdir700 keep all private material private.
  previous=os.umask(0o022)
  try:return d['apply']()
  finally:os.umask(previous)
 elif mode=='inspect':
  d['AREA']=NEW;d['inspect'](int(sys.argv[2]))
 elif mode=='status':
  d['AREA']=NEW;d['status']()
 else:raise ValueError('UNKNOWN_MODE')
 return 0
if __name__=='__main__':
 try:raise SystemExit(main())
 except Exception as e:
  code=str(e);print(json.dumps({'status':'STOP_INSPECT_ONLY_NO_RETRY','error':type(e).__name__,'code':code if isinstance(e,ValueError) and re.fullmatch('[A-Z0-9_]{1,96}',code) else 'RECOVERY_PREPARATION_FAILED'}));raise SystemExit(2)
