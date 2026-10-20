"""Future explicit local archive staging only. Never downloads or installs runtime."""
import hashlib,io,json,os,stat,sys,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-client-order-ack-20261020-r1-code')
FROZEN = True
sys.dont_write_bytecode=True
DIRS = ('payload', 'payload/company-app', 'payload/palitra-orders-public')
ZIP_SHA = '19d8548afcefa96e9df2698b030ec7811607675ba701ca3e18dab2c559f207f3'
FILES = {'company-app.py': {'bytes': 5074, 'sha256': '162abcac361a18b478f9ce2e978a39caea1d7e0d07dee04ddfd2aaa2ec044859'}, 'content-db.py': {'bytes': 7788, 'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be'}, 'controller.py': {'bytes': 17932, 'sha256': 'fc34b9c89b4809c8ea96579956ef4c40824d7e7e7ed7c0c38eaeb9a2b1ea2a7c'}, 'manifest.json': {'bytes': 3737, 'sha256': 'e9b1b3e558cb9ed797cab3f3d612bd31246afc4ea9fedc0ced8419f36302f0cf'}, 'native.py': {'bytes': 37159, 'sha256': 'a5f1730afc4a575dc5dedfbaf9e700deb76df131d18db7a6846839e8c16e19da'}, 'parent-entry-r1.py': {'bytes': 12616, 'sha256': '0480caf8201b841ab9ab44724ddef5ec52ec38290aed208ddc926be2261b33a5'}, 'payload/company-app/customer-chat-native-adapter.cjs': {'bytes': 38353, 'sha256': '80d326224873b2e41c1a6710e86e371147a38371f2bb0c72326a8099317efa9e'}, 'payload/company-app/customer-chat.js': {'bytes': 135944, 'sha256': '67fcdc6cdb85b78af175a2988f04733754833dcb8a96a7adc4bb42df27ae4be1'}, 'payload/company-app/palitra-workflow.cjs': {'bytes': 34658, 'sha256': 'c4edf7e0f999d0e921aa5b688206948fdc53af04f82c96740a2ee919a9926ae9'}, 'payload/company-app/server.js': {'bytes': 129395, 'sha256': '3d832d5d1552d9ed48ae579a24ea9ee925cb95e3326f12f97c9879144a3a7596'}, 'payload/palitra-orders-public/cabinet.html': {'bytes': 2735, 'sha256': 'fb9dbf1e2411e79a7a4419bdf597793a52e1df086588ccaacab5bb73629fa508'}, 'payload/palitra-orders-public/shell.css': {'bytes': 67733, 'sha256': '09740927dfd0a5d3b71e60c1b78f99f63f19d7f7cb5f09b027ab8bd66b0fba93'}, 'payload/palitra-orders-public/shell.js': {'bytes': 314119, 'sha256': 'f9887937189bf4f0ed19d42191809bdad1faf97c88633a9995b0563c05b2a640'}, 'payload/palitra-orders-public/shop.html': {'bytes': 2261, 'sha256': 'df36b396d55cc110de18752107f7a525c1cfd6076f10dc8727acd14e39767ef4'}, 'records.json': {'bytes': 2852, 'sha256': 'add530c4ae4098e2f00be1d4a358cf7a8e7c572a7cf4e695a70e6138c0ae4a14'}, 'report-db.py': {'bytes': 7626, 'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63'}, 'rollback-plan.py': {'bytes': 3171, 'sha256': 'cf00a340ae89343b0c6e8725e18129d31d846b31a6ac0f0e9b1ab47c0b2706cc'}, 'static-files.py': {'bytes': 5607, 'sha256': 'acbf42b367a1ed30788c603cd05adcff2fabef3c4036c087ff6811b9f02e4891'}, 'traffic-db.py': {'bytes': 12391, 'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'}}
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
