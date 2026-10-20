"""Future explicit local archive staging only. Never downloads or installs runtime."""
import hashlib,io,json,os,stat,sys,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-clear-orders-guard-20261020-r1-code')
FROZEN = True
sys.dont_write_bytecode=True
DIRS = ('payload', 'payload/palitra-orders-public')
ZIP_SHA = 'ddc6b64fd690b36ade5c49c96579df59dd135147e8dab90da512ccc29a8c5ace'
FILES = {'company-app.py': {'bytes': 5078, 'sha256': '283e6211887e7b50d4aa134a97d86de04d160f818fff0284a722de692aa20e9c'}, 'content-db.py': {'bytes': 7788, 'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be'}, 'controller.py': {'bytes': 17934, 'sha256': '94bf585d81ef259c846f67b30cdd20495fbdae24b10f482541f05c343e3ae8e3'}, 'manifest.json': {'bytes': 3227, 'sha256': '86abb1a09c3244fe58cd7dceca40faf379c7d058a22c71e78fb543056d7c5282'}, 'native.py': {'bytes': 37172, 'sha256': '6a25e99e0a604a2ad96fa370c009b068e17cd396709135ec56a15e46b578c250'}, 'parent-request-groups-r2.py': {'bytes': 12931, 'sha256': 'f5bb203ffd3eba2b917a17911a302772f65f2099c5075e004e277602472dcdd8'}, 'payload/palitra-orders-public/cabinet.html': {'bytes': 2789, 'sha256': '91277f53ec62bd700395d53f26a494c25ed8238f87b8973d647f96ab881a9187'}, 'payload/palitra-orders-public/shell.js': {'bytes': 323357, 'sha256': '60502c40ecfb7a5f75972b7a841a197fb75b372fba76ade072cef9d3db5f9e4b'}, 'payload/palitra-orders-public/shop.html': {'bytes': 2366, 'sha256': '862f294019ed0033c4daf70283654f6df895fe7cb203cbfb93d03de35e9f095b'}, 'payload/server.js': {'bytes': 131177, 'sha256': 'd1e0a83cfc23a5cf6558a1023438257240e78fc9c4c997c49f0ca23e36da093f'}, 'payload/site-orders.js': {'bytes': 64375, 'sha256': '4826cc1d35bc0ac5216ab765f8dde31bb91ca96b935d5aee01537724eff6ef94'}, 'records.json': {'bytes': 1752, 'sha256': '9cb2e0ac508cfa266bcec7b631dd798478a3c66b12b77beb3d2115bd75554ef4'}, 'report-db.py': {'bytes': 7626, 'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63'}, 'rollback-plan.py': {'bytes': 3171, 'sha256': '9c17243ae4c63eb2188d7bd2f735bc06be356e03596bd3a50a387791659f4718'}, 'static-files.py': {'bytes': 5605, 'sha256': '741f613a125374ccae43550a265526fc1144efd0ba6f789087eb788cd2b093b0'}, 'traffic-db.py': {'bytes': 12391, 'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'}}
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
