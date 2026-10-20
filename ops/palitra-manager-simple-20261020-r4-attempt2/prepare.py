"""Future explicit local archive staging only. Never downloads or installs runtime."""
import hashlib,io,json,os,stat,sys,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-manager-simple-20261020-r4-attempt2-code')
FROZEN=True
sys.dont_write_bytecode=True
DIRS=('payload','payload/backend','payload/product','payload/backend/company-app')
ZIP_SHA = 'ab9c1d9e5b364d8ef1d9c04d1cb2f8bf133cdcbff7b42fc6e770a3cd36094a6b'
FILES = {'company-app.py': {'bytes': 4782, 'sha256': 'f069fae8cd22d9face5b285624ccdc9e7ae056f13e0875eda015e2ad6e774884'}, 'content-db.py': {'bytes': 7788, 'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be'}, 'controller.py': {'bytes': 18031, 'sha256': 'f8a0ea301e214352fed5b84a056112cb7826a17a1e0a6800497d955e10d5d35d'}, 'manifest.json': {'bytes': 3173, 'sha256': 'd71abd5e70d25bf967eb2bcc28fab114997f95caf8214ddceef2cabae3c320de'}, 'native.py': {'bytes': 33633, 'sha256': 'fa2b64c3e399427fe2e673cb475d726aff074679bad3d430f444fda9fc9dbae3'}, 'parent-darya-r2.py': {'bytes': 9462, 'sha256': 'fa34b575513cc735244cfa3c949ea745d8b5667ea7f3740b9f863c921adcd20b'}, 'payload/backend/company-app/customer-report-cache.cjs': {'bytes': 12842, 'sha256': '5fb7f5ca7f897d04bd2c4907ad8422122209fa1df37d2a8a52b5fcdb4fbf7e70'}, 'payload/product/cabinet.html': {'bytes': 2731, 'sha256': 'd25e61dda3db78f5368c655161d2782250489b6a35c855c37a80969488cf773d'}, 'payload/product/shell.css': {'bytes': 70708, 'sha256': '2c79b7c2bfecf27079e11eadd7cc082f0a0acbd1794e7ac67e0b2cdbc5d8b47c'}, 'payload/product/shell.js': {'bytes': 303529, 'sha256': '5d5cbf71f2f8409fc526742e9fb2db35c0b918b9a3c2b82240b339d5ac1976dc'}, 'payload/product/shop.html': {'bytes': 2257, 'sha256': 'bf4ed01678545dbf656afbf55752faa17550ae053201442d4caadab0ab318a97'}, 'records.json': {'bytes': 1805, 'sha256': '66e914eae4db1f20625ae17eafd123d07dc204230f0df4d92b029563bc349421'}, 'report-db.py': {'bytes': 7626, 'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63'}, 'rollback-plan.py': {'bytes': 3178, 'sha256': '8a012cc7c9d596df99839d314f53e50e2d3811d45a3e5329d1f722e79570f964'}, 'static-files.py': {'bytes': 5607, 'sha256': 'acbf42b367a1ed30788c603cd05adcff2fabef3c4036c087ff6811b9f02e4891'}, 'traffic-db.py': {'bytes': 12391, 'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'}}
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
