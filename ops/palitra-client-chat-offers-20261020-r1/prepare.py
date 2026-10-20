"""Future explicit local archive staging only. Never downloads or installs runtime."""
import hashlib,io,json,os,stat,sys,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-client-chat-offers-20261020-r1-code')
FROZEN = True
sys.dont_write_bytecode=True
DIRS = ('payload', 'payload/palitra-orders-public', 'payload/palitra-review-public')
ZIP_SHA = 'dab732ef696cfd0266d1257a2a6544120170983647b84f3efbae2be7bc866cba'
FILES = {'company-app.py': {'bytes': 5078, 'sha256': '40b51e92636ff82601382881c143ffc0ee5852042c321cdea14b139e69258020'}, 'content-db.py': {'bytes': 7788, 'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be'}, 'controller.py': {'bytes': 18473, 'sha256': '76c782a38d55f71c79267d71221c8759162eb294c02b164a1940534c9cf74a49'}, 'manifest.json': {'bytes': 5169, 'sha256': '21569bfe0acd9d08eb29b888b0c26df9b42e856d20fbe33fc6e467f20cfb7fd1'}, 'native.py': {'bytes': 39306, 'sha256': 'ad97cff6b04fcf0e312c97559d1782c86f1963ee2446ec404a5eab4ada2f2214'}, 'parent-merged-r4.py': {'bytes': 11796, 'sha256': '22539810474bcdb6d18e9c4476db0b8c8d5551bb3a4ce85e4abd07debdcd78a3'}, 'payload/customer-chat-native-adapter.cjs': {'bytes': 40365, 'sha256': 'de15d7c0dad1507e0264a1919efe5692e78856038b01d79ad4495e64199fe890'}, 'payload/customer-chat.js': {'bytes': 147883, 'sha256': 'fd697663999065dab39b09aae2db2537096b57d50590f9f16aa75edd96cbfa14'}, 'payload/palitra-order-memo.cjs': {'bytes': 9680, 'sha256': 'dfb7636cd0238bce929e912f32cad41af0455654789aac07f4522311472eb36c'}, 'payload/palitra-orders-public/cabinet.html': {'bytes': 2803, 'sha256': 'bab9214dfedc39b68ae6036f413ca866ae231e6653b1084d56610b6b40df42b4'}, 'payload/palitra-orders-public/native-host.js': {'bytes': 34808, 'sha256': '4c79ae79f90a9f69660bb40f0d8c8a7a055552edba5094c6e7ee60a4333c9966'}, 'payload/palitra-orders-public/push-adapter.js': {'bytes': 8675, 'sha256': 'f260f77e2bc5acaa8fd2f364c31a416509988bafea5a03a9801d46b25aaaf196'}, 'payload/palitra-orders-public/shell.css': {'bytes': 68908, 'sha256': '9a271357250110bd80f3860209f595eb53a401b722b6e1b2e71f8a4ca872b821'}, 'payload/palitra-orders-public/shell.js': {'bytes': 319771, 'sha256': '0ab36f339aaf72c33ad53988e070f1244fe4de33d46e1d14120102547df1a1ae'}, 'payload/palitra-orders-public/shop.html': {'bytes': 2380, 'sha256': '9ca31603ce83082491af1254d2e5f52b8f60b9d011b445ecd517321b683da2f5'}, 'payload/palitra-orders-public/workflow-ui.css': {'bytes': 8462, 'sha256': 'b3f2f29264ebf49ff9fbb07d80fae100781e80a97935ce241507a5a4d6f106ed'}, 'payload/palitra-orders-public/workflow-ui.js': {'bytes': 107880, 'sha256': '80ba64a3099f82723e9421fc143c7fb41da590309599b3f67ad34a60026b4a14'}, 'payload/palitra-review-public/palitra-chat.css': {'bytes': 14623, 'sha256': '6fef4d032d7d9526ea416ca98f5b144645803cb047c94634c5303309866ed550'}, 'payload/palitra-review-public/palitra-chat.html': {'bytes': 4160, 'sha256': '6063e6de1dff6f734eaccf285c4192114313d339eaf6b62c39854271871656f1'}, 'payload/palitra-review-public/palitra-chat.js': {'bytes': 97181, 'sha256': 'a4a2671b579eb0e0f8fa47361aa5f3d9c280ec066e56951fc1e21c0950238f9d'}, 'payload/palitra-workflow.cjs': {'bytes': 56041, 'sha256': '97e5453b94d9928924abb0864fa7f27d4d094abd26efa20425c81cf66174c675'}, 'payload/server.js': {'bytes': 131116, 'sha256': '5230baec0aa430f201ed18438842e95f0a642b26cbab9168ae5cba9956ef6ade'}, 'records.json': {'bytes': 5515, 'sha256': '1d4a8b66506dd7d68a777cbffae920f07354c9438613077f35c634459a46ace1'}, 'report-db.py': {'bytes': 7626, 'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63'}, 'rollback-plan.py': {'bytes': 3259, 'sha256': '3897a9073de76815723417edd34b5a2269e8212690784dfd59892009691a86dc'}, 'static-files.py': {'bytes': 6071, 'sha256': 'e7ad7968a16439c70b2186d5c6a8d1898fcc51ef94774706357c7a66388a2d82'}, 'traffic-db.py': {'bytes': 12391, 'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'}}
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
