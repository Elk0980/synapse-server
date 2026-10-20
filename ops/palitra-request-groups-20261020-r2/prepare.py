"""Future explicit local archive staging only. Never downloads or installs runtime."""
import hashlib,io,json,os,stat,sys,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-request-groups-20261020-r2-code')
FROZEN = True
sys.dont_write_bytecode=True
DIRS = ('payload', 'payload/palitra-orders-public')
ZIP_SHA = '45459e991317bf2fd1b6f92450a86c0bcbf22d0232d154427893238bafeb40ac'
FILES = {'company-app.py': {'bytes': 5070, 'sha256': 'c080ff005ce6ad2241ffff5b2ac459cc20a1bec8eec5f4249dd09c4bf2b843f9'}, 'content-db.py': {'bytes': 7788, 'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be'}, 'controller.py': {'bytes': 17930, 'sha256': '2589131b7fc935fb5096a8de9bc2884dc916092f1c039988590a6f07ef9e30e9'}, 'manifest.json': {'bytes': 3086, 'sha256': '90fc77a9e6e73e0e7b674451270348ffc2aa1739525d0975660bc71a17ccd586'}, 'native.py': {'bytes': 37201, 'sha256': '25e3aa48bac06a311d1e24461cc2de840ebb0daff3f047b7cd22a6547486798b'}, 'parent-request-groups-r1.py': {'bytes': 12524, 'sha256': '5b0456c109d4808a551c5c95055ff500b5b980e3809afe1120fa602f6b421ed2'}, 'payload/palitra-orders-public/cabinet.html': {'bytes': 2791, 'sha256': 'a60cdbe99656de5e18e064caadaa8625506728b4addbc5ea8013c447a436f3a9'}, 'payload/palitra-orders-public/shell.css': {'bytes': 69699, 'sha256': '3b4fff371851e274dad102e0c786b17333500261d945d7a1c5f47aecb0a116da'}, 'payload/palitra-orders-public/shell.js': {'bytes': 322584, 'sha256': '5c74d60ecd93b29226c664bb546d6634c9e63e6f6da6d4d675541ae4e7607553'}, 'payload/palitra-orders-public/shop.html': {'bytes': 2368, 'sha256': 'c8f15de7cbcc4c5c1c6487925eca899bd5ce30873a233b209e74add75470724d'}, 'records.json': {'bytes': 1494, 'sha256': '18146827482c784b5086b556615345c98abbcfd1310cd9f3c73576e6343bc84a'}, 'report-db.py': {'bytes': 7626, 'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63'}, 'rollback-plan.py': {'bytes': 3169, 'sha256': '55257067e2117317ff9ca91d1b33d7ec0d9e85816c1b584dff67219f3d99c1ed'}, 'static-files.py': {'bytes': 5607, 'sha256': 'acbf42b367a1ed30788c603cd05adcff2fabef3c4036c087ff6811b9f02e4891'}, 'traffic-db.py': {'bytes': 12391, 'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'}}
def need(ok,code):
    if not ok:raise ValueError(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def checked_archive(raw):
    need(len(raw)<=4*1024*1024 and sha(raw)==ZIP_SHA,'EXACT_CLOSED_ZIP_REQUIRED')
    need(all(type(name) is str and not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts and PurePosixPath(name).as_posix()==name for name in FILES),'CLOSED_RELATIVE_CODE_PATHS_REQUIRED')
    need({str(p) for name in FILES for p in PurePosixPath(name).parents if str(p)!='.'}==set(DIRS),'CLOSED_NESTED_CODE_DIRECTORIES_REQUIRED')
    unpacked={}
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        entries=z.infolist();need(len(entries)==len(FILES) and {i.filename for i in entries}==set(FILES),'CLOSED_ZIP_RECORDS_REQUIRED')
        for info in entries:
            record=FILES[info.filename]
            need(not info.is_dir() and info.file_size==record['bytes'] and info.file_size<=4*1024*1024 and info.flag_bits&1==0,'BOUNDED_UNENCRYPTED_FILE_REQUIRED')
            mode=(info.external_attr>>16)&0xffff;need(stat.S_ISREG(mode),'ZIP_REGULAR_ENTRIES_REQUIRED')
            value=z.read(info);need(sha(value)==record['sha256'],'EXACT_ARCHIVE_FILE_REQUIRED');unpacked[info.filename]=value
    return unpacked
def main():
    need(FROZEN is True, 'DRAFT_PREPARE_NOT_AUTHORIZED')
    need(os.name=='posix' and os.geteuid()==0 and len(sys.argv)==2,'ROOT_AND_EXPLICIT_LOCAL_ARCHIVE_REQUIRED')
    archive=Path(sys.argv[1]);need(archive.is_absolute(),'ABSOLUTE_LOCAL_ARCHIVE_REQUIRED')
    for path in [archive,*archive.parents,CODE,*CODE.parents]:need(not path.is_symlink(),'PATH_ALIAS_REFUSED')
    s=archive.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=4*1024*1024,'BOUNDED_REGULAR_ARCHIVE_REQUIRED')
    unpacked=checked_archive(archive.read_bytes())
    need(not os.path.lexists(CODE),'NEW_CODE_NAMESPACE_REQUIRED_NO_RETRY')
    parent=CODE.parent.lstat();need(stat.S_ISDIR(parent.st_mode) and parent.st_uid==parent.st_gid==0 and not stat.S_IMODE(parent.st_mode)&0o022,'PRIVATE_ROOT_PARENT_REQUIRED')
    # All bytes validated before EXCL staging; partial output is UNKNOWN, never retried.
    os.mkdir(CODE,0o700)
    for name in DIRS:os.mkdir(CODE/name,0o700)
    for name,value in unpacked.items():
        fd=os.open(CODE/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as file:file.write(value);file.flush();os.fsync(file.fileno())
    need({p.relative_to(CODE).as_posix() for p in CODE.rglob('*') if p.is_file()}==set(FILES),'STAGED_CLOSURE_CHANGED')
    need({p.relative_to(CODE).as_posix() for p in CODE.rglob('*') if p.is_dir()}==set(DIRS),'STAGED_DIRECTORY_CLOSURE_CHANGED')
    for name in ('',*DIRS):
        path=CODE/name;s=path.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o700 and not path.is_symlink(),'STAGED_PRIVATE_DIRECTORY_REQUIRED')
    for name,record in FILES.items():
        path=CODE/name;s=path.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600 and sha(path.read_bytes())==record['sha256'],'STAGED_EXACT_BYTES_REQUIRED')
    print(json.dumps({'status':'CODE_STAGED_NOT_RUNTIME_AUTHORIZATION','files':len(FILES),'runtimeWrites':0}))
if __name__=='__main__':main()
