"""Future explicit local archive staging only. Never downloads or installs runtime."""
import hashlib,io,json,os,stat,sys,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-client-order-entry-20261020-r1-code')
FROZEN = True
sys.dont_write_bytecode=True
DIRS=('payload','payload/product')
ZIP_SHA = '2a072129c9468a449760cef05dc24a80ca3f943010917946579b7c57b8de1041'
FILES = {'company-app.py': {'bytes': 5078, 'sha256': 'c122a3952eefa2e305eb49b0eb20a5ef18b1181185d15f06cd51a3f1980c3c8b'}, 'content-db.py': {'bytes': 7788, 'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be'}, 'controller.py': {'bytes': 18024, 'sha256': '55a9371cafdb152290a8108e17a383799fc184c320c08be2d676bd439cd8ffb1'}, 'manifest.json': {'bytes': 2979, 'sha256': '2b4469cd2444ec5a6a276efad592ac4fa2e892b2f977756132bf8db1bd4bd553'}, 'native.py': {'bytes': 36443, 'sha256': '0b17f6acdb64c45a48bb2dcb5286b26acee653473b8df3da8a3998ee0e0ed75d'}, 'parent-darya-r2.py': {'bytes': 9462, 'sha256': 'fa34b575513cc735244cfa3c949ea745d8b5667ea7f3740b9f863c921adcd20b'}, 'payload/product/cabinet.html': {'bytes': 2739, 'sha256': 'dae326e3e79a436179e51c69b9f85a682ffb4f3f4fd79806458c0a567b1bba58'}, 'payload/product/shell.css': {'bytes': 67194, 'sha256': '3fbc2bdad94b2955918d6f592522f386203104a30fd0b349cbf63c2733d883cb'}, 'payload/product/shell.js': {'bytes': 312817, 'sha256': '94fafe89342b9f74777b9fcac544b1533e9941e7e099f19ff249cb9e9d8c09ee'}, 'payload/product/shop.html': {'bytes': 2265, 'sha256': '9cfbfcd31d4e67fe3668e0c97c30bd9273a82f23ff9280eea3ed2468c0f8cbdd'}, 'records.json': {'bytes': 1442, 'sha256': '8727be13a09e9b5b01df84443e5a677f06409630767dbeaf5fcdba75c078e526'}, 'report-db.py': {'bytes': 7626, 'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63'}, 'rollback-plan.py': {'bytes': 3169, 'sha256': '61a12aa598ea94e9ac229798e1b2e6f2f24fc65b24cca85bc1d8b88dabf20ef3'}, 'static-files.py': {'bytes': 5607, 'sha256': 'acbf42b367a1ed30788c603cd05adcff2fabef3c4036c087ff6811b9f02e4891'}, 'traffic-db.py': {'bytes': 12391, 'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'}}
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
