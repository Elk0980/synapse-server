"""New, single-file supplement: refresh two script references in the existing editor entry.
No replay or modification of the installed parent transaction.
"""
import hashlib,json,os,re,stat,sys,time,urllib.request
from pathlib import Path
sys.dont_write_bytecode=True
sha=lambda b:hashlib.sha256(b).hexdigest()
def need(ok,code):
    if not ok:raise ValueError(code)
HELPER=Path('/tmp/palitra-home.py')
need(sha(HELPER.read_bytes())=='ddf343781c9a8ffcadfa806d62ec050e4e0b48f54e2e2691815ebc2a16d87e88','EXACT_INSTALLED_PARENT_HELPER')
n={'__name__':'installed_category_parent_read_only','__file__':str(HELPER)}
exec(compile(HELPER.read_bytes(),str(HELPER),'exec'),n)
TARGET='/opt/synapse/sites/synapse/price-editor-palitra.html'
BEFORE='ef044fb4e20d17881a238d9f6ac1b211c1e3d4fb625b813515716a2936ae80dc'
AFTER='10ae574b49dc678f76ea11f9447945029e71eb9ee58e13bca3f33b241bbe0f90'
AREA=n['AREA']/'entry-cache-fix-r1'
def execute(commit):
    need(os.name=='posix' and os.geteuid()==0,'LINUX_ROOT_ONLY')
    need(re.fullmatch('[a-f0-9]{40}',commit),'EXACT_CODE_COMMIT')
    need(not AREA.exists(),'ATTEMPT_EXISTS_INSPECT_ONLY')
    staged,bundle,m=n['package']()
    product,native,reader,contract=n['old']['primitive']()
    lease=n['own_lease'](native)
    action=n['load'](n['AREA']/'action.json')
    result=n['load'](n['AREA']/'installed.json')
    need(sha(n['read'](n['AREA']/'installed.json'))=='9a06c381462fa1bf6955b137cd55976865cee5c5529cb9663ac3e7ee52b00a0','EXACT_INSTALLED_PARENT_RESULT')
    obj=object.__new__(n['Apply'])
    obj.staged,obj.bundle,obj.m=staged,bundle,m
    obj.product,obj.native,obj.reader,obj.contract=product,native,reader,contract
    obj.action,obj.readLease,obj.base=action,lease,n['load'](n['AREA']/'base.json')
    obj.children,obj.plan,obj.published=result['images'],result['plan'],set(obj.base['statics'])
    obj.guard(True)
    raw=n['read'](TARGET)
    need(sha(raw)==BEFORE,'FRESH_ENTRY_BEFORE_PIN')
    info=Path(TARGET).stat()
    payload=urllib.request.urlopen('https://raw.githubusercontent.com/Elk0980/synapse-server/'+commit+'/ops/palitra-category-20261022/entry.html',timeout=30).read(64*1024)
    need(sha(payload)==AFTER,'EXACT_ENTRY_PAYLOAD')
    expected=raw.replace(b'palitra-editor-model.js?v=20261013-36',b'palitra-editor-model.js?v=20261022-category-home-r1').replace(b'palitra-editor.js?v=20261021-orders-unified-r1',b'palitra-editor.js?v=20261022-category-home-r1')
    need(payload==expected,'ONLY_TWO_RESOURCE_REFERENCES')
    obj.base['statics'][TARGET]={'sha256':BEFORE,'afterSha256':AFTER,'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid,'file':'supplemental-entry.html'}
    started=time.time()
    def ticket():
        need(time.time()-started<120,'FRESH_SUPPLEMENTAL_ACTION')
        native.Ticket.native_lease(lease)
        obj.guard(True)
    ticket()
    AREA.mkdir(mode=0o700)
    n['write'](AREA/'STARTED.json',n['enc']({'lease':lease,'target':TARGET,'beforeSha256':BEFORE,'afterSha256':AFTER,'helperSha256':sha(n['read'](__file__)),'singleWriter':'Root','replayForbidden':True,'authorization':'Direct category/editor fix; Root exact supplemental cache-reference review'}))
    n['write'](AREA/'entry.before.html',raw)
    n['write'](AREA/'fresh-extended-base.json',n['enc'](obj.base))
    native.cas(TARGET,BEFORE,payload,stat.S_IMODE(info.st_mode),ticket)
    obj.published.add(TARGET)
    observed=obj.guard(True)
    need(sha(n['read'](TARGET))==AFTER,'ENTRY_READBACK')
    out={'status':'SUPPLEMENTAL_ENTRY_INSTALLED_FULL_READBACK_PASS','target':TARGET,'afterSha256':AFTER,'snapshotSha256':observed,'schemaWrites':0,'runtimeRecreation':0,'businessRowsWritten':0,'parentUnchanged':True}
    n['write'](AREA/'result.json',n['enc'](out))
    print(json.dumps(out))
if __name__=='__main__':
    try:execute(sys.argv[1])
    except Exception as error:
        code=str(error);print(json.dumps({'status':'STOP_INSPECT_ONLY_NO_AUTOMATIC_RETRY','error':type(error).__name__,'code':code if isinstance(error,ValueError) and re.fullmatch('[A-Z0-9_]{1,96}',code) else 'NATIVE_OPERATION_FAILED'}));raise SystemExit(2)
