"""Root-only column diagnostic; no acceptance, action, write or installer.

Reads exact R7 CAPTURE_RESULT/private raw ref and current SQLite readonly.
Raw rows remain in this process. stdout contains only names/counts/SHA, valid
heartbeat timestamps and integer sequence values explicitly requested by Root.
"""
import argparse,copy,hashlib,json,os,re,sqlite3,stat
from contextlib import closing
from datetime import datetime,timezone
from pathlib import Path

ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
CAPTURE=ROOT/'palitra-unified-post-cleanup-20261021-r4-9118e6bd28e0097bdd6bcfb1f791009a/CAPTURE_RESULT.json'
DB=Path('/var/lib/docker/volumes/synapse_content_data/_data/content.sqlite')
BRIDGE='client_bot_bridge_state';SEQ='sqlite_sequence';ALERT='hugh_owner_alerts'
COLUMNS={'bot_key','ok','username','telegram_bot_id','error','checked_at'}
BLOB='__palitra_sqlite_blob_hex_v1__'
def need(v,c):
    if not v:raise ValueError(c)
def packed(v):return json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'),default=lambda b:{'blobSha256':hashlib.sha256(b).hexdigest()}).encode()
def sha(v):return hashlib.sha256(v if type(v) is bytes else packed(v)).hexdigest()
def row_seal(rows):return sha(sorted(sha(row) for row in rows))
def exact(p):
    p=Path(p);need(p.is_absolute() and all(not x.is_symlink() for x in [p,*p.parents]),'NO_PATH_ALIAS');return p
def read_pin(p,pin,limit):
    p=exact(p);s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<=limit,'BOUNDED_ROOT600_PRIVATE_INPUT')
    raw=p.read_bytes();z=p.lstat();need((s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(z.st_dev,z.st_ino,z.st_size,z.st_mtime_ns,z.st_ctime_ns) and len(raw)==s.st_size and sha(raw)==pin,'EXACT_PRIVATE_INPUT_PIN');return raw
def reference(parent,name,ref):
    need(type(ref) is dict and set(ref)=={'path','sha256'} and ref['path']==str(parent/name) and re.fullmatch('[a-f0-9]{64}',ref['sha256']),'EXACT_CAPTURE_FILE_REFERENCE');return ref
def blob_hook(value):
    if set(value)=={BLOB}:
        v=value[BLOB];need(type(v) is str and len(v)%2==0 and re.fullmatch('[a-f0-9]*',v) is not None,'EXACT_LOSSLESS_BLOB_TAG');return bytes.fromhex(v)
    return value
def whole(value):
    tables={name:{'count':len(rows),'rowMultisetSha256':row_seal(rows)} for name,rows in sorted(value['tables'].items())}
    return {'schemaSha256':sha(value['schema']),'tables':tables,'wholeRowsSha256':sha(tables)}
def lease(pid,ticks):
    need(pid>1 and ticks.isdigit(),'ROOT_LEASE_PROCESS_INPUT');p=Path('/proc')/str(pid)/'stat';raw=p.read_text();need(raw[raw.rfind(')')+2:].split()[19]==ticks and p.lstat().st_uid==0,'LEASE_PROCESS_CHANGED')
def database_family():
    rows={}
    for suffix in ('','-wal','-shm'):
        p=exact(str(DB)+suffix);need(p.exists(),'EXISTING_WAL_SHM_REQUIRED_NO_CREATION');s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o644 and s.st_size<=512*1024*1024,'EXACT_CURRENT_CONTENT_FILE_FAMILY')
        rows[suffix]=[s.st_dev,s.st_ino,s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_size,s.st_mtime_ns,s.st_ctime_ns]
    return rows
def ident(name):need(type(name) is str and re.fullmatch('[A-Za-z_][A-Za-z0-9_]*',name),'CLOSED_SQL_IDENTIFIER');return '"'+name+'"'
def records(db,sql):
    cur=db.execute(sql);names=[d[0] for d in cur.description];values=cur.fetchmany(50001);need(len(values)<=50000,'TABLE_ROW_BOUND');return [dict(zip(names,row)) for row in values]
def state(db):
    schema=records(db,'SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name');need(len(schema)<=600,'SCHEMA_BOUND')
    names=[r['name'] for r in schema if r['type']=='table'];need(len(names)<=200,'TABLE_BOUND');tables={n:records(db,'SELECT * FROM '+ident(n)) for n in names}
    need(sum(len(r) for r in tables.values())<=250000,'SNAPSHOT_ROW_BOUND');need(db.execute('PRAGMA quick_check').fetchall()==[('ok',)] and not db.execute('PRAGMA foreign_key_check').fetchone(),'SQLITE_CHECKS_REQUIRED');return {'schema':schema,'tables':tables}
def readonly_authorizer(action,first,second,database,trigger):
    if action in {sqlite3.SQLITE_SELECT,sqlite3.SQLITE_READ,sqlite3.SQLITE_FUNCTION,sqlite3.SQLITE_TRANSACTION,getattr(sqlite3,'SQLITE_RECURSIVE',-999)}:return sqlite3.SQLITE_OK
    if action==sqlite3.SQLITE_PRAGMA and first in ('quick_check','foreign_key_check') and second is None:return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY
def timestamp(v):
    if type(v) is not str or re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z',v) is None:return None
    try:return datetime.fromisoformat(v[:-1]+'+00:00')
    except ValueError:return None
def safe_name(v):return v if type(v) is str and re.fullmatch('[A-Za-z_][A-Za-z0-9_-]{0,63}',v) else '<key-sha256:'+sha(v)+'>'
def keymap(rows,key):
    need(type(rows) is list and all(type(row) is dict and type(row.get(key)) is str for row in rows),'EXACT_NAMED_ROW_LIST');result={r[key]:r for r in rows};need(len(result)==len(rows),'DUPLICATE_SERVICE_ROW_KEY');return result
def compare(old,new):
    need(type(old) is dict and type(new) is dict and set(old)==set(new)=={'schema','tables'},'EXACT_RAW_STATE_SHAPE')
    tables=[]
    for name in sorted(set(old['tables'])|set(new['tables'])):
        a=old['tables'].get(name);b=new['tables'].get(name)
        if a is None or b is None or row_seal(a)!=row_seal(b):tables.append({'table':safe_name(name),'beforeCount':None if a is None else len(a),'currentCount':None if b is None else len(b),'beforeSha256':None if a is None else row_seal(a),'currentSha256':None if b is None else row_seal(b)})
    before=keymap(old['tables'].get(BRIDGE,[]),'bot_key');after=keymap(new['tables'].get(BRIDGE,[]),'bot_key');bridge=[];bridge_ok=set(before)==set(after)
    for key in sorted(set(before)|set(after)):
        a=before.get(key);b=after.get(key);columns=sorted(set(a or {})|set(b or {}));changed=[c for c in columns if a is None or b is None or type(a.get(c)) is not type(b.get(c)) or a.get(c)!=b.get(c)]
        shape=a is not None and b is not None and set(a)==set(b)==COLUMNS
        at=timestamp(a.get('checked_at')) if a else None;bt=timestamp(b.get('checked_at')) if b else None
        stable_a=None if a is None else {k:v for k,v in a.items() if k!='checked_at'};stable_b=None if b is None else {k:v for k,v in b.items() if k!='checked_at'}
        stable=packed(stable_a)==packed(stable_b);monotonic=at is not None and bt is not None and bt>=at
        bridge_ok=bridge_ok and shape and stable and monotonic
        bridge.append({'botKey':safe_name(key),'changedColumns':[safe_name(c) for c in changed],'beforeOtherFieldsSha256':None if stable_a is None else sha(stable_a),'currentOtherFieldsSha256':None if stable_b is None else sha(stable_b),'otherFieldsExact':stable,'columnSetExact':shape,'timestampValid':at is not None and bt is not None,'timestampNondecreasing':monotonic,'beforeCheckedAt':a['checked_at'] if at else None,'currentCheckedAt':b['checked_at'] if bt else None})
    before_seq=keymap(old['tables'].get(SEQ,[]),'name');after_seq=keymap(new['tables'].get(SEQ,[]),'name');sequence=[];seq_ok=set(before_seq)==set(after_seq)
    for key in sorted(set(before_seq)|set(after_seq)):
        a=before_seq.get(key);b=after_seq.get(key);av=None if a is None else a.get('seq');bv=None if b is None else b.get('seq');shape=a is not None and b is not None and set(a)==set(b)=={'name','seq'};valid=shape and type(av) is int and type(bv) is int and av>=0 and bv>=0
        allowed=valid and (bv>=av if key==ALERT else av==bv);seq_ok=seq_ok and allowed
        if a!=b or key==ALERT:sequence.append({'name':safe_name(key),'before':av if type(av) is int else None,'current':bv if type(bv) is int else None,'beforeType':type(av).__name__,'currentType':type(bv).__name__,'presenceExact':a is not None and b is not None,'knownAllowedCounter':key==ALERT,'nonnegativeIntegers':valid,'allowedProgress':allowed})
    others=[r for r in tables if r['table'] not in (BRIDGE,SEQ)];schema_equal=old['schema']==new['schema'];cohort=set(old['tables'])==set(new['tables'])
    return {'schemaExact':schema_equal,'tableSetExact':cohort,'changedTables':tables,'bridge':{'beforeCount':len(before),'currentCount':len(after),'keySetExact':set(before)==set(after),'rows':bridge},'sequence':{'beforeCount':len(before_seq),'currentCount':len(after_seq),'keySetExact':set(before_seq)==set(after_seq),'changedOrKnownRows':sequence},'otherBusinessTablesExact':not others,'onlyKnownVolatileProgressObserved':schema_equal and cohort and not others and bridge_ok and seq_ok,'runtimeAuthorization':False,'rootAcceptanceCreated':False,'rawRowsEmitted':False}
def main():
    p=argparse.ArgumentParser();p.add_argument('--capture-sha',required=True);p.add_argument('--lease-pid',type=int,required=True);p.add_argument('--lease-start',required=True);a=p.parse_args();need(os.name=='posix' and os.geteuid()==0,'ROOT_LINUX_READONLY_ONLY');lease(a.lease_pid,a.lease_start)
    result=json.loads(read_pin(CAPTURE,a.capture_sha,1024*1024));need(result.get('schema')=='palitra-post-cleanup-private-capture-result/v2' and result.get('runtimeAuthorization') is False and result.get('databaseWrites')==0,'ACTUAL_R7_CAPTURE_RESULT_REQUIRED')
    files=result['files'];rawref=reference(CAPTURE.parent,'raw-content-minimum.json',files['raw-content-minimum.json']);compactref=reference(CAPTURE.parent,'post-content-capture.json',files['post-content-capture.json']);compact=json.loads(read_pin(compactref['path'],compactref['sha256'],16*1024*1024));external=compact['rawPrivateMinimumRef']
    need(external.get('schema')=='palitra-post-cleanup-raw-minimum-ref/v1' and external.get('encoding')=='JSON_SQLITE_BYTES_HEX_V1' and {k:external[k] for k in ('path','sha256')}==rawref,'COMPACT_RAW_REF_LINK_REQUIRED')
    raw=read_pin(rawref['path'],rawref['sha256'],256*1024*1024);need(len(raw)==external['bytes'],'RAW_BYTES_EXACT');old=json.loads(raw,object_hook=blob_hook);need(whole(old)==compact['wholeCurrent'] and compact['typedContentSha256']==result['typedContentSha256'],'RAW_CAPTURE_WHOLE_SEAL_LINK_REQUIRED');del raw
    lease(a.lease_pid,a.lease_start);before=database_family()
    with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True,timeout=5)) as db:
        db.execute('PRAGMA foreign_keys=ON');db.execute('PRAGMA query_only=ON');db.set_authorizer(readonly_authorizer);db.execute('BEGIN');new=state(db);db.rollback()
    after=database_family();need(before[''][:5]==after[''][:5],'CONTENT_IDENTITY_CHANGED_DURING_READ');lease(a.lease_pid,a.lease_start)
    report=compare(old,new);report.update(schema='palitra-r7-readonly-columns-sequence-diagnostic/v1',captureResultSha256=a.capture_sha,rawMinimumSha256=rawref['sha256'],freshReadAtUtc=datetime.now(timezone.utc).isoformat(),familyMetadataChangedDuringRead=before!=after,sqlWrites=0,outputFilesCreated=0,oldArtifactsChanged=0)
    read_pin(CAPTURE,a.capture_sha,1024*1024);print(json.dumps(report,ensure_ascii=False,separators=(',',':')))
if __name__=='__main__':
    try:main()
    except Exception as e:print(json.dumps({'status':'READONLY_COLUMN_DIAGNOSTIC_REFUSED','code':str(e) if type(e) is ValueError and re.fullmatch('[A-Z0-9_]+',str(e)) else type(e).__name__,'runtimeAuthorization':False,'privateValuesEmitted':False}));raise SystemExit(2)
