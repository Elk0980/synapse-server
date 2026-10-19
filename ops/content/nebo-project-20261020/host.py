"""Inspect and add one NEBO HTTPS host; retain all old Caddy bytes."""
from pathlib import Path
import hashlib,json,re,subprocess,sys,os
ROOT=Path('/opt/synapse/releases/nebo-project-20261020-r3/site-import')
HOST='nebo-draft-1.synapsebusiness.ru'
def run(*a):return subprocess.check_output(a,text=True).strip()
def sha(b):return hashlib.sha256(b).hexdigest()
def save(n,v):
    with (ROOT/n).open('x') as f:json.dump(v,f,indent=2)
    (ROOT/n).chmod(0o600)
def guard():
    lines=run('lslocks','-n','-o','pid,path').splitlines()
    assert [l.split()[0] for l in lines if l.split()[-1:]==['/opt/synapse/.palitra-app-release.lock']]==['3153782']
def inspect():
    guard();names=run('docker','ps','--format','{{.Names}}').splitlines()
    names=[n for n in names if 'caddy' in n];assert len(names)==1
    row=json.loads(run('docker','inspect',names[0]))[0]
    mounts=[{k:m.get(k) for k in ['Type','Source','Destination','RW']} for m in row['Mounts']]
    source=next((m['Source']+('/Caddyfile' if m['Destination']=='/etc/caddy' else '') for m in mounts if m['Destination'] in ['/etc/caddy','/etc/caddy/Caddyfile']),None)
    assert source and Path(source).is_file()
    b=Path(source).read_bytes();s=b.decode()
    safe=[l for l in s.splitlines() if re.search(r'draft|^\s*import\s|reverse_proxy|^\S+synapsebusiness\.ru',l)]
    facts={'container':names[0],'config':source,'sha256':sha(b),'mounts':mounts,'safeRoutingLines':safe}
    save('HOST_INSPECT.json',facts);print(json.dumps(facts,ensure_ascii=False,indent=2))
def prepare():
    guard();v=json.loads((ROOT/'HOST_INSPECT.json').read_text());f=Path(v['config']);b=f.read_bytes()
    assert sha(b)==v['sha256'] and HOST.encode() not in b
    assert (ROOT/'OUTCOME_R3.json').exists(),'IMPORTED_SITE_REQUIRED'
    addition=('\n\n# NEBO native workspace — 20.10.2026\n'+HOST+' {\n  encode zstd gzip\n  reverse_proxy content:8080\n}\n').encode()
    candidate=b+addition
    (ROOT/'Caddyfile.before').write_bytes(b);(ROOT/'Caddyfile.nebo').write_bytes(candidate)
    (ROOT/'Caddyfile.before').chmod(0o600);(ROOT/'Caddyfile.nebo').chmod(0o600)
    subprocess.run(['docker','cp',str(ROOT/'Caddyfile.nebo'),v['container']+':/tmp/nebo-Caddyfile'],check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['docker','exec',v['container'],'caddy','validate','--config','/tmp/nebo-Caddyfile','--adapter','caddyfile'],check=True)
    save('HOST_READY.json',{'before':sha(b),'after':sha(candidate),'config':v['config'],'container':v['container']})
    print('NEBO_HOST_VALIDATED; original bytes retained; one new reverse_proxy host')
def apply():
    guard();v=json.loads((ROOT/'HOST_READY.json').read_text());f=Path(v['config']);b=f.read_bytes()
    assert sha(b)==v['before'],'FRESH_CONFIG_REQUIRED'
    assert not (ROOT/'HOST_STARTED.json').exists(),'NO_REPEATED_HOST_APPLY'
    candidate=(ROOT/'Caddyfile.nebo').read_bytes();assert sha(candidate)==v['after'] and candidate.startswith(b)
    save('HOST_STARTED.json',v)
    # Keep the bind-mounted inode; all old bytes are preserved verbatim.
    with f.open('r+b') as stream:stream.write(candidate);stream.truncate();stream.flush();os.fsync(stream.fileno())
    subprocess.run(['docker','exec',v['container'],'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],check=True)
    assert sha(f.read_bytes())==v['after']
    save('HOST_OUTCOME.json',{'status':'NEBO_HTTPS_HOST_RELOADED','hostname':HOST,'before':v['before'],'after':v['after']});print('NEBO_HTTPS_HOST_RELOADED')
if __name__=='__main__':
    assert len(sys.argv)==2
    {'inspect':inspect,'prepare':prepare,'apply':apply}[sys.argv[1]]()
