"""Fresh archive-construction installer; no old attempt replay, guards unchanged."""
import hashlib,json,os,re,stat,sys,urllib.request
from pathlib import Path
sys.dont_write_bytecode=True
H=Path('/tmp/tg-r1.py');s=H.lstat()
if H.is_symlink() or not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1:raise ValueError('HELPER_BOUNDARY')
raw=H.read_bytes()
if hashlib.sha256(raw).hexdigest()!='dc20b9135921087c620949e35e4da20b8154af7f4831a7af94319d6343c66be0':raise ValueError('HELPER_PIN')
text=raw.decode()
for old,new in [("AREA=ROOT/'palitra-tg-native-install-20261021-r1'","AREA=ROOT/'palitra-tg-native-install-20261021-r3'"),("CODE=ROOT/'palitra-tg-r7-installer-readbinding-r1-code'","CODE=ROOT/'palitra-tg-r7-installer-archive-r3-code'"),("INSTALLER_SHA='d52031302191b3fce9b0ebc549164c412c31091677d1a0a64716446c6ff96ac2'","INSTALLER_SHA='596436aa20a9732bfc0263a6be47de04cc8eee6c3781bca0f4c86c04cfee7157'")]:
 if text.count(old)!=1:raise ValueError('EXACT_SUCCESSOR_BINDING')
 text=text.replace(old,new)
d={'__name__':'root_archive_successor','__file__':str(H)};exec(compile(text,str(H),'exec'),d)
def stage(commit):
 need=d['need'];need(re.fullmatch('[a-f0-9]{40}',commit),'EXACT_COMMIT');need(not d['AREA'].exists() and not d['CODE'].exists(),'NEW_STAGE_EXISTS_INSPECT_ONLY')
 with urllib.request.urlopen('https://raw.githubusercontent.com/Elk0980/synapse-server/'+commit+'/ops/palitra-tg-native-20261021-r1/installer-r3.zip',timeout=45) as response:raw=response.read(355918)
 need(len(raw)==355917 and d['sha'](raw)=='0816a8f17f9867567b06249727bc3862f0fcf38607d5c842464f5855c59bf9f2','SUCCESSOR_ZIP_PIN')
 mb,_,files=d['unpack'](raw,'code-manifest.json',d['INSTALLER_SHA'])
 old=d['ROOT']/'palitra-tg-native-install-20261021-r1';rm=d['private_read'](old/'reader-manifest.json');need(d['sha'](rm)==d['READER_SHA'],'READER_PIN')
 for p in (d['AREA'],d['CODE']):p.mkdir(mode=0o700)
 for name,b in files.items():
  dest=d['CODE']/name;dest.parent.mkdir(mode=0o700,parents=True,exist_ok=True);d['write'](dest,b)
 d['write'](d['CODE']/'code-manifest.json',mb);d['write'](d['AREA']/'reader-manifest.json',rm)
 d['write'](d['AREA']/'installer-code-acceptance.json',d['encoded']({'schema':'palitra-tg-installer-acceptance/v1','status':'ROOT_ACCEPTED_EXACT_INSTALLER_CODE','manifestSha256':d['INSTALLER_SHA'],'readonlyAdapterManifestSha256':d['READER_SHA']}))
 d['load']();print(json.dumps({'status':'ARCHIVE_SUCCESSOR_CODE_STAGED_NOT_APPLIED','installer':d['INSTALLER_SHA'],'reader':d['READER_SHA']}))
def main():
 if os.name!='posix' or os.geteuid()!=0:raise ValueError('LINUX_ROOT_ONLY')
 mode=sys.argv[1]
 if mode=='stage':stage(sys.argv[2])
 elif mode=='capture':d['capture'](int(sys.argv[2]))
 elif mode=='apply':return d['apply']()
 elif mode=='inspect':d['inspect'](int(sys.argv[2]))
 elif mode=='status':d['status']()
 else:raise ValueError('UNKNOWN_MODE')
 return 0
if __name__=='__main__':
 try:raise SystemExit(main())
 except Exception as e:
  code=str(e);print(json.dumps({'status':'STOP_INSPECT_ONLY_NO_RETRY','error':type(e).__name__,'code':code if isinstance(e,ValueError) and re.fullmatch('[A-Z0-9_]{1,96}',code) else 'SUCCESSOR_OPERATION_FAILED'}));raise SystemExit(2)
