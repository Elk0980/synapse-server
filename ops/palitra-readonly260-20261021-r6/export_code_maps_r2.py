"""Root-only successorR2: exact native211 map and canonical touched modes2.

Exact sealed receipts are read but never printed. Output contains only code
paths, code hashes/modes/types and compose dependency file pins. Static hashes
are OBSERVATIONS, not accepted historical expectations; final fresh inspector
must close/compare them independently before runtime admission.
"""
import argparse,base64,hashlib,json,os,re,stat,zlib
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
GUARD=ROOT/'palitra-clear-orders-guard-20261020-r1-journal.json'
GUARD_SHA='34ce6389ef04a5db158d5b1a27734e2d09c919df28b35a9dad4561af48d42892'
BASE36=ROOT/'palitra-chat-open-layout-r1-journal.json'
BASE36_SHA='82239c55f1d5d05ac84ffdb70c1eac28d61024d41bb6fd8e288da254d9ed5cea'
IMAGE='sha256:951db09e9e6c4781350bbced7e7a9e4ef099077a368e38a6b1fac40e0a4a6a22'
BASE36_IMAGE='sha256:83b1873906d0740fc238acbf464bed02e88564e885e472f1cc68be3de336c063'
sha=lambda b:hashlib.sha256(b).hexdigest()
encoded=lambda v:json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def need(v,c):
    if not v:raise ValueError(c)
def digest(v):return type(v) is str and re.fullmatch('[a-f0-9]{64}',v) is not None
def relative(v):return type(v) is str and 0<len(v)<=2048 and not v.startswith('/') and '\\' not in v and ':' not in v and all(p not in ('','.','..') for p in v.split('/'))
def exact_read(path,limit=16*1024*1024):
    path=Path(path)
    for p in [path,*path.parents]:need(not p.is_symlink(),'MAP_EXPORT_ALIAS_REFUSED')
    s=path.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and s.st_size<=limit,'ROOT_BOUNDED_MAP_INPUT_REQUIRED')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        with os.fdopen(fd,'rb',closefd=False) as f:raw=f.read(limit+1)
        facts=lambda a:(a.st_dev,a.st_ino,a.st_mode,a.st_uid,a.st_gid,a.st_nlink,a.st_size,a.st_mtime_ns,a.st_ctime_ns)
        need(facts(s)==facts(os.fstat(fd))==facts(path.lstat()) and len(raw)==s.st_size,'MAP_INPUT_CHANGED_DURING_READ');return raw
    finally:os.close(fd)
def pinned(path,pin,reader=exact_read):
    raw=reader(path);need(sha(raw)==pin,'EXACT_SEALED_MAP_JOURNAL_REQUIRED');return json.loads(raw)
def extract(guard,base36,static_reader):
    need(guard.get('childImage')==IMAGE and guard.get('phase')=='APPLIED_NOT_CUSTOMER_ACCEPTANCE','EXACT_COMPLETED_GUARD_REQUIRED')
    after=guard['after'];tree=after['runtime']['appTree'];modes=after['sourceModes'];statics=after['staticModes']
    need(type(tree) is dict and type(modes) is dict and len(modes)==240 and type(statics) is dict and len(statics)==43,'FULL240_43_CODE_FIELDS_REQUIRED')
    source={};safe_tree={}
    for path,row in tree.items():
        need((path=='' or relative(path)) and type(row) is dict,'CLOSED_CODE_TREE_PATH_REQUIRED')
        kind=row.get('type');keys={'uid','gid','mode','type'}|({'nlink','bytes','sha256'} if kind=='file' else {'nlink','linkSha256'} if kind=='symlink' else set())
        need(kind in ('file','directory','symlink') and set(row)==keys and all(type(row[k]) is int and row[k]>=0 for k in ('uid','gid','mode')),'EXACT_CODE_TREE_FACTS_REQUIRED')
        if kind=='file':need(digest(row['sha256']) and row['nlink']==1 and type(row['bytes']) is int and row['bytes']>=0,'EXACT_CODE_FILE_HASH_REQUIRED')
        if kind=='symlink':need(digest(row['linkSha256']) and row['nlink']==1,'EXACT_CODE_LINK_HASH_REQUIRED')
        safe_tree[path]=row
    for path,mode in modes.items():
        need(relative(path) and set(mode)=={'uid','gid','mode'} and mode['uid']==mode['gid']==0 and mode['mode'] in (0o600,0o644),'EXACT_SOURCE_MODES_REQUIRED')
        row=tree[path];need(row['type']=='file' and all(row[k]==v for k,v in mode.items()),'SOURCE_MODE_TREE_MISMATCH');source[path]=row['sha256']
    old=base36.get('inputs',{}).get('afterSource')
    need(base36.get('name')=='palitra-chat-open-layout-r1' and base36.get('childImage')==BASE36_IMAGE and type(old) is dict and len(old)==211 and all(relative(n) and digest(h) for n,h in old.items()),'FULL_REAL_SEALED_RELEASE36_SOURCE211_REQUIRED_NO_GUESS')
    # Native Root metadata and the exact canonical release36 implementation:
    # source_facts() seals only the two touched files, not the full211 map.
    layout={'product/shell.js':'palitra-orders-public/shell.js','product/shell.css':'palitra-orders-public/shell.css'}
    modes36={n:{'uid':0,'gid':0,'mode':0o644} for n in layout.values()}
    need(base36.get('sourceModes')==modes36 and base36.get('inputs',{}).get('sourceLayout')==layout,'EXACT_SEALED_RELEASE36_TOUCHED_MODES2_REQUIRED')
    before36=base36['inputs'].get('beforeSource')
    need(type(before36) is dict and len(before36)==211 and set(before36)==set(old) and all(digest(h) for h in before36.values()),'FULL_SEALED_RELEASE35_BEFORE211_REQUIRED')
    need({n for n in old if old[n]!=before36[n]}==set(layout.values()),'EXACT_RELEASE36_TWO_FILE_DELTA_OTHER209_PRESERVED')
    need(set(old)<=set(source),'RELEASE36_SOURCE_DOMAIN_MUST_PERSIST')
    chain=after['containers']['content'];need(len(chain['files'])==len(set(chain['files']))==49 and set(chain['filePins'])==set(chain['files']) and all(digest(h) for h in chain['filePins'].values()),'EXACT_CODE_DEPENDENCY_CHAIN49_REQUIRED')
    need(len(base36['after']['containers']['content']['files'])==35,'EXACT_RELEASE36_CHAIN35_REQUIRED')
    static_hashes={}
    for path,mode in statics.items():
        need(type(path) is str and path.startswith('/opt/synapse/sites/') or type(path) is str and path.startswith('/var/lib/docker/volumes/synapse_content_data/_data/projects/palitra-love/sites/'),'EXACT_CODE_STATIC_ROOT_REQUIRED')
        need('..' not in Path(path).parts and mode in (0o600,0o644),'EXACT_STATIC_PATH_MODE_REQUIRED');static_hashes[path]=static_reader(path,mode)
        need(digest(static_hashes[path]),'EXACT_OBSERVED_STATIC_HASH_REQUIRED')
    return {'schema':'palitra-unified-native-map/v1','status':'SEALED_CODE_MAP_WITH_OBSERVED_STATIC_NOT_RUNTIME_INSPECTION','runtimeAuthorization':False,'image':IMAGE,'guardJournalSha256':GUARD_SHA,'release36JournalSha256':BASE36_SHA,'chainFiles':49,'source':source,'static':static_hashes,'staticModes':statics,'staticObservationOnly':True,'release36Source':old,'appTree':safe_tree,'dependencies':chain['filePins'],'runtimeWrites':0,'databaseOpenCount':0}
def frame(value,page):
    raw=encoded(value);packed=zlib.compress(raw,9);b64=base64.b64encode(packed).decode();chunks=[b64[i:i+480] for i in range(0,len(b64),480)]
    need(type(page) is int and 0<=page<(len(chunks)+15)//16,'BOUNDED_MAP_EXPORT_PAGE_REQUIRED')
    header={'schema':'palitra-code-map-transfer/v1','sha256':sha(raw),'rawBytes':len(raw),'compressedSha256':sha(packed),'compressedBytes':len(packed),'chunks':len(chunks),'chunkChars':480,'page':page,'pages':(len(chunks)+15)//16}
    return json.dumps(header,separators=(',',':'))+'\n'+'\n'.join(str(i).zfill(4)+':'+chunks[i] for i in range(page*16,min(len(chunks),(page+1)*16)))
def main():
    p=argparse.ArgumentParser();p.add_argument('--page',type=int,default=0);p.add_argument('--capture',type=Path,required=True);p.add_argument('--create',action='store_true');a=p.parse_args()
    need(os.name=='posix' and os.geteuid()==0 and a.capture.parent==ROOT/'palitra-unified-map-capture-r2' and a.capture.name=='code-maps.json','EXACT_ROOT_CODE_ONLY_CAPTURE_AREA_REQUIRED')
    if a.create:
        area=a.capture.parent;need(area.is_dir() and not area.is_symlink() and stat.S_IMODE(area.lstat().st_mode)==0o700,'PRECREATED_ROOT700_CODE_CAPTURE_AREA_REQUIRED')
        def static_reader(path,mode):
            raw=exact_read(path);need(stat.S_IMODE(Path(path).lstat().st_mode)==mode,'OBSERVED_STATIC_MODE_CHANGED');return sha(raw)
        value=extract(pinned(GUARD,GUARD_SHA),pinned(BASE36,BASE36_SHA),static_reader)
        fd=os.open(a.capture,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as f:f.write(encoded(value));f.flush();os.fsync(f.fileno())
    value=json.loads(exact_read(a.capture));print(frame(value,a.page))
if __name__=='__main__':
    try:main()
    except Exception as e:print(json.dumps({'status':'REFUSED_CODE_MAP_EXPORT','code':str(e) if type(e) is ValueError else type(e).__name__,'runtimeWrites':0,'databaseOpenCount':0}));raise SystemExit(2)
