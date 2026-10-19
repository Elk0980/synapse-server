"""Read-only R7 facts. No data rows, secrets, DB backup or application writes."""
import hashlib,json,os,sqlite3,stat,subprocess
from pathlib import Path

def need(value,code):
    if not value:raise ValueError(code)
def code(value):
    return ' '.join(value[n:n+8] for n in range(0,len(value),8))
def regular(p):
    for q in [*reversed(p.parents),p]:need(not q.is_symlink(),'SYMLINK_REFUSED')
    s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'SINGLE_REGULAR_REQUIRED')
    return s
def main():
    need(os.geteuid()==0,'ROOT_REQUIRED')
    c=json.loads(subprocess.check_output(['docker','inspect','synapse-content-1']))[0]
    need(c['Image']=='sha256:40c5bb71533969256a518f3c97fac28484ae2fb43e987fd34642be3e3d4860b3','R6_REQUIRED')
    env=dict(x.split('=',1) for x in c['Config'].get('Env',[]) if '=' in x)
    dbpath=env.get('DATABASE_PATH','/data/content.sqlite');need(dbpath=='/data/content.sqlite','DATA_PATH_CHANGED')
    mount=[m for m in c['Mounts'] if m['Destination']=='/data'];need(len(mount)==1,'ONE_DATA_MOUNT_REQUIRED')
    m=mount[0];need(m['Type']=='volume' and m['Name']=='synapse_content_data' and m['Source']=='/var/lib/docker/volumes/synapse_content_data/_data' and m['RW'] is True,'DATA_MOUNT_CHANGED')
    print('R6_IMAGE_MATCH DATA_PATH_MATCH DATA_MOUNT_MATCH')
    for name in ['project-chat.js','project-chat.css']:
        p=Path('/opt/synapse/sites/synapse/cabinet')/name;s=regular(p)
        print('STATIC',name,s.st_uid,s.st_gid,oct(s.st_mode&511),s.st_size)
        print('SHA',code(hashlib.sha256(p.read_bytes()).hexdigest()))
    directory=Path(m['Source'])
    for name in ['content.sqlite','salon-reports.sqlite']:
        for suffix in ['','-wal','-shm']:
            p=directory/(name+suffix)
            if not p.exists():print('DB',p.name,'ABSENT');continue
            s=regular(p);print('DB',p.name,s.st_uid,s.st_gid,oct(s.st_mode&511),s.st_dev,s.st_ino)
    uri=(directory/'content.sqlite').as_uri()+'?mode=ro'
    with sqlite3.connect(uri,uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        rows=db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall()
        raw=json.dumps(rows,ensure_ascii=False,separators=(',',':')).encode()
        print('SCHEMA',code(hashlib.sha256(raw).hexdigest()))
        print('WORK_OBJECTS',sum(r[1].startswith('project_chat_work_') for r in rows))
    print('READ_ONLY_COMPLETE')
if __name__=='__main__':
    try:main()
    except Exception as e:print('READ_ONLY_REFUSED',str(e) if type(e) is ValueError else type(e).__name__);raise SystemExit(2)
