"""Inspect a failed own build; never apply/retry/restore or print secrets."""
import hashlib,json,os,re,stat,sys
from pathlib import Path
sys.dont_write_bytecode=True
H=Path('/tmp/tg-r1.py')
s=H.lstat()
if H.is_symlink() or not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1:raise ValueError('HELPER_BOUNDARY')
fd=os.open(H,os.O_RDONLY|os.O_NOFOLLOW)
try:
 raw=os.read(fd,128*1024)
 if hashlib.sha256(raw).hexdigest()!='dc20b9135921087c620949e35e4da20b8154af7f4831a7af94319d6343c66be0':raise ValueError('HELPER_PIN')
finally:os.close(fd)
d={'__name__':'root_verified_helper','__file__':str(H)}
exec(compile(raw,str(H),'exec'),d)
entry,package,native,reader,contract=d['load']()
A=d['AREA'];ROOT=d['ROOT'];action=json.loads((A/'action.json').read_bytes());base=json.loads((A/'native-base.json').read_bytes())
native.Ticket.native_lease(action['lease'])
journal=ROOT/(action['namespace']+'-apply')
phases=[json.loads(p.read_bytes()) for p in sorted(journal.glob('[0-9][0-9][0-9].json'))]
if any(p['phase'] in ('single-miniapp-schema','content-up') for p in phases):raise ValueError('LATER_PHASE_PRESENT_STOP')
child=native.read(journal/'context/image.id',native=True).decode().strip()
if not re.fullmatch('sha256:[a-f0-9]{64}',child):raise ValueError('CHILD_ID')
g=object.__new__(native.Native);g.command=d['run'];g.before=base;g.bindings=action['bindings'];g.forward_plan=None;g.allowed_images={package['parentImage'],child};g.read_scripts=set(contract['readScriptSha256']);g.read_scopes=contract['readScriptScopes']
r=reader.create(g.read_command)
actual=r.snapshot();parent=r.image(package['parentImage']);new=r.image(child)
expected=package['appTreeAfter'];got=new['appTree']
diff=[{'path':name,'expected':expected.get(name),'actual':got.get(name)} for name in sorted(set(expected)|set(got)) if expected.get(name)!=got.get(name)]
keys=set(parent['config'])|set(new['config'])
report={'status':'READ_ONLY_OWN_BUILD_DIAGNOSIS','runtimeFullBaseUnchanged':actual==base,'runtimeImage':actual['image'],'childId':child,'oneAddedLayer':new['layers'][:-1]==parent['layers'] and len(new['layers'])==len(parent['layers'])+1,'sameImageConfig':new['config']==parent['config'],'imageConfigDiffKeys':[k for k in sorted(keys) if parent['config'].get(k)!=new['config'].get(k)],'appTreeDifferenceCount':len(diff),'appTreeDifferences':diff[:25],'umaskLine':next((x for x in Path('/proc/self/status').read_text().splitlines() if x.startswith('Umask:')),None),'schemaPhaseAbsent':True,'upPhaseAbsent':True,'phases':[{'phase':p['phase'],'status':p['status']} for p in phases]}
d['write'](A/'onecopy-readonly-diagnosis.json',d['encoded'](report))
print(json.dumps(report))
