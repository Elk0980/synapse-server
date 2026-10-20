"""Future explicit local archive staging only. Never downloads or installs runtime."""
import hashlib,io,json,os,stat,sys,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-client-quickfix-20261020-r4-code')
FROZEN = True
sys.dont_write_bytecode=True
DIRS = ('payload', 'payload/palitra-orders-public')
ZIP_SHA = '546a3862106d8bf4485283e900a0583b46d6a5f443cc5ba16448a3b89d6e5c8d'
FILES = {'company-app.py': {'bytes': 5072, 'sha256': '25f1920555eccca9f6a46cbd0a2335001e222051b4284d45bad30192966e8d06'}, 'content-db.py': {'bytes': 7788, 'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be'}, 'controller.py': {'bytes': 17931, 'sha256': '519d10bc9f460775693b9f22476d9d12475036f30cc7ca91361b6ea8c88ddd0d'}, 'manifest.json': {'bytes': 3512, 'sha256': '4ab04df210ccdf4e393e9a471f56a8db8eae3000248800bd74c854281b5a77ea'}, 'native.py': {'bytes': 36959, 'sha256': '6bc8c0164dc1aae7d25cc9d2c2db48fc4292f8b0547351ebb68539cd95a1ac5d'}, 'parent-ack-r3.py': {'bytes': 11646, 'sha256': 'c463df64788236e1659c4d15d1310916cdb708eb5d2b2b70354c99c3628bcc93'}, 'payload/client-dialogs.js': {'bytes': 124972, 'sha256': 'fd9bfb826551e2da77fc245239a4eccb37e76ccf574d79eadd780ff9532e04ef'}, 'payload/customer-chat-native-adapter.cjs': {'bytes': 39170, 'sha256': '0355c532b72a8924803ad72cc00476e63346c58852e581e12e3e29919e50cdc1'}, 'payload/palitra-orders-public/cabinet.html': {'bytes': 2741, 'sha256': '2ba7f1edd942b01ab03f25b0f39fb86387c1b1feec74b83a2487cfe0aa2a2025'}, 'payload/palitra-orders-public/shell.js': {'bytes': 314089, 'sha256': '26bd6cfbe8ef115d8ab09894e0106f38458447cf3e56ce08e2af0078f46efc6d'}, 'payload/palitra-orders-public/shop.html': {'bytes': 2267, 'sha256': 'b7b910cbddde99d1e61a56ac69d102ccb5d571b576a30b3ef110efa91953655f'}, 'payload/palitra-push.cjs': {'bytes': 19821, 'sha256': 'e88222fbb1e2e0dd42408aa5bfbaa502a44087eea01421e4142a80ce2cf845d7'}, 'payload/site-orders.js': {'bytes': 63365, 'sha256': '5f08e7dca695683c164132cb8a7faeab37a2e1839293a200f4fb54fc7a4aad08'}, 'records.json': {'bytes': 2413, 'sha256': 'e968280bfed1823973186399a985a473d4c1ea9c126f431a0c0e0d89b71687d7'}, 'report-db.py': {'bytes': 7626, 'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63'}, 'rollback-plan.py': {'bytes': 3170, 'sha256': 'e82f75697129d238b9742fe175ca3f6820c73fb8ffbe37fae8e0b07eed4c8ad8'}, 'static-files.py': {'bytes': 5605, 'sha256': '741f613a125374ccae43550a265526fc1144efd0ba6f789087eb788cd2b093b0'}, 'traffic-db.py': {'bytes': 12391, 'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'}}
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
