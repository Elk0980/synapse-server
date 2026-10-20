"""Future explicit local archive staging only. Never downloads or installs runtime."""
import hashlib,io,json,os,stat,sys,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-request-groups-20261020-r1-code')
FROZEN = True
sys.dont_write_bytecode=True
DIRS = ('payload', 'payload/palitra-orders-public')
ZIP_SHA = '623ab8ef61aa2fc0d38c1894fb5090e993d643ab5dda4f87390f73666cf481b1'
FILES = {'company-app.py': {'bytes': 5070, 'sha256': '830369005566318fbeb929de9836252977f04d7c9f616f15606477e6a5dbc890'}, 'content-db.py': {'bytes': 7788, 'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be'}, 'controller.py': {'bytes': 17930, 'sha256': '5b518c54a8ea6b22ac694232beb8ce6505cd08b80f2a89b35af4bbf5e0e01784'}, 'manifest.json': {'bytes': 3443, 'sha256': '045467934f93a22d07464dbbd6811fab4fe423fa4f1ff9fd902a0ec3cf8a1add'}, 'native.py': {'bytes': 37400, 'sha256': 'bf3354c6c7d88dbf354f90d9c445535b430c955a886942df8b5afd73d313f708'}, 'parent-client-chat-offers-r1.py': {'bytes': 12912, 'sha256': '5d1fc08571068b82af0e8bf2ad21c91230bca0f4bc2a4ae854e81bc7d12ec8ea'}, 'payload/palitra-manager-attention.cjs': {'bytes': 18619, 'sha256': 'e3def7a1786e5999655cf65289e757d158172c6865af6088bd2352f7d99e8730'}, 'payload/palitra-orders-public/cabinet.html': {'bytes': 2791, 'sha256': 'fd98e4346468d360a4532879310a49a73788a7495a9d01f372bcbefb6486c37a'}, 'payload/palitra-orders-public/native-host.js': {'bytes': 36339, 'sha256': 'cff72e8ce18ee1434775159c7bc20c69ffbcd8268e5af62a6b29feeb711a5a39'}, 'payload/palitra-orders-public/shell.css': {'bytes': 69405, 'sha256': '426cc2da09ad06792a375a757fe56dbffb34b7f1b37fa1349215bb6a4133740f'}, 'payload/palitra-orders-public/shell.js': {'bytes': 323064, 'sha256': 'c86f36a010b1f72906638775cc3c8321f6819c0fcd44f74d15815351119238e8'}, 'payload/palitra-orders-public/shop.html': {'bytes': 2368, 'sha256': 'cbfb640af3254c459cba78485cefe532ef391612f49e8f431937a9c6d3b6e97c'}, 'records.json': {'bytes': 2188, 'sha256': '10ccedc0872dc3fdf2029e089aa093e26e6c6ac5ed410b6f0630e856dd18ff93'}, 'report-db.py': {'bytes': 7626, 'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63'}, 'rollback-plan.py': {'bytes': 3168, 'sha256': 'e9d8743908fcab20900691028ec097d1d1889f3070dbb7ce43abed844d22ed37'}, 'static-files.py': {'bytes': 5606, 'sha256': '7d7772364ba0848fc178aa0f4e0e99cad56f895140b7d5d780f7403646bbc676'}, 'traffic-db.py': {'bytes': 12391, 'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'}}
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
