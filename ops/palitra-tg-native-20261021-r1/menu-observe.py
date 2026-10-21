"""Read only actual menu values after a write/readback disagreement."""
import hashlib,stat,json,time
from pathlib import Path
H=Path('/tmp/tg-m2.py');raw=H.read_bytes();s=H.lstat()
assert not H.is_symlink() and s.st_uid==0 and s.st_nlink==1 and stat.S_ISREG(s.st_mode)
assert hashlib.sha256(raw).hexdigest()=='8a96fb19a1af1b618d8d589ba38a87078efefd1b793ae0689c5988e00e5ff7e1'
text=raw.decode();assert text.count('mode=sys.argv[1]')==1
n={'__name__':'root_menu_readonly','__file__':str(H)};exec(compile(text.split('mode=sys.argv[1]')[0],str(H),'exec'),n)
rows=n['read_all']();folder=n['folder'];report={'status':'MENU_OBSERVED_NO_WRITE','menus':[r['menu'] for r in rows],'startedCount':len(list(folder.glob('started-*'))),'doneCount':len(list(folder.glob('done-*')))}
n['d']['write'](n['A']/('menu-observed-'+str(time.time_ns())+'.json'),n['d']['encoded'](report));print(json.dumps(report,ensure_ascii=False))
