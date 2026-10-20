"""Future explicit local archive staging only. Never downloads or installs runtime."""
import hashlib,io,json,os,stat,sys,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-my-orders-20261021-r2-code')
FROZEN = True
sys.dont_write_bytecode=True
DIRS = ('payload', 'payload/palitra-orders-public')
ZIP_SHA = 'd5d10ccaf75f93406d357ff4cd7f9cf7382857a2182d4bda3e15df136f255f48'
FILES = {'company-app.py': {'bytes': 5060, 'sha256': '628764a8a9329b910ad0682f1981d3d5aafb93dbf3299df4aa2e32f6c6415ea0'}, 'content-db.py': {'bytes': 7788, 'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be'}, 'controller.py': {'bytes': 17925, 'sha256': 'ca1361c1dd163b878cf456add98aae29ca57218fc80f93291793b2588e76bf54'}, 'manifest.json': {'bytes': 3230, 'sha256': 'ef29147b219ae33e7209f7f2cb9c29af63b86e71a4e881ac180710e5644cd924'}, 'native.py': {'bytes': 37191, 'sha256': '95f79586baf667a7105ddddbc5ffaab70dad468cedfa84aed77fce307d6d87f6'}, 'parent-clear-guard-r1.py': {'bytes': 12892, 'sha256': '256edace89b706966f1e74b2de5787b83b934936f138a8a992713a0c6f211dd7'}, 'payload/customer-chat-http.cjs': {'bytes': 22570, 'sha256': 'ab989ddb1ce78c833db87e56ce44f3158a4786a05cb0d41c94df17e006d9d4d7'}, 'payload/customer-chat.js': {'bytes': 148521, 'sha256': '7237c701d1fff6ae96a7044bb913156b96c553b94e42872e65e6238c57368d0a'}, 'payload/palitra-orders-public/cabinet.html': {'bytes': 2786, 'sha256': '86177f8dc192fdece1310e0f5fb162795f1e85ba3995e7679dc72a68652b8b4a'}, 'payload/palitra-orders-public/shell.js': {'bytes': 323577, 'sha256': '77014fc3ecda2be6c5bc786c40e852afa53f54652e6689be1c10ab3029c27ff5'}, 'payload/palitra-orders-public/shop.html': {'bytes': 2363, 'sha256': 'f474d9a9cd998bdfc0e9477456512a5a0122c9f087e0985a408b76f5ed4db236'}, 'records.json': {'bytes': 1773, 'sha256': '07bd8b5d6e2bd79b48188934b7d42ec0598cb9c704aef0f6704d31335694a677'}, 'report-db.py': {'bytes': 7626, 'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63'}, 'rollback-plan.py': {'bytes': 3162, 'sha256': '55ce0dac6612cd7157fe35d3ea248558c038552ed7bd5d47fd396ac9f11927b6'}, 'static-files.py': {'bytes': 5605, 'sha256': '741f613a125374ccae43550a265526fc1144efd0ba6f789087eb788cd2b093b0'}, 'traffic-db.py': {'bytes': 12391, 'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'}}
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
