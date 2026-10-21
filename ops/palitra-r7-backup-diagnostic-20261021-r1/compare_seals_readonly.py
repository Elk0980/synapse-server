"""Root-only diagnostic. Never installs, changes guards, emits admission or rows.

Reads the completed R7 full phase and actual pinned readonly seal functions.
Two existing SQLite databases, mode=ro/query_only consistent transactions;
requires existing WAL+SHM to avoid creating a missing journal family.
Outputs only domain/table names, types, counts and SHA256. No private values.
"""
import argparse,collections,hashlib,json,os,re,sqlite3,stat,time
from contextlib import closing
from pathlib import Path

BUNDLE_SHA='81b2a1bcf492c1ccebdb6910b5e5b5e8e1ab3ec63bca57b4b121666168a45ef3'
PACKAGE_SHA='fd60d0f17369a41527c1f0b3fa67c32724d9b24a2896cfee476dd753958cb676'
NS='palitra-unified-orders-20261021-r7'
DATA=Path('/var/lib/docker/volumes/synapse_content_data/_data')
def need(value,code):
    if not value:raise ValueError(code)
def encoded(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def sha(raw):return hashlib.sha256(raw).hexdigest()
def exact(p):
    p=Path(p);need(p.is_absolute() and all(not x.is_symlink() for x in [p,*p.parents]),'NO_PATH_ALIAS');return p
def pinned(p,pin,limit):
    p=exact(p);s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and s.st_size<=limit,'BOUNDED_ROOT_INPUT');raw=p.read_bytes();z=p.lstat();need((s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(z.st_dev,z.st_ino,z.st_size,z.st_mtime_ns,z.st_ctime_ns) and len(raw)==s.st_size and sha(raw)==pin,'EXACT_INPUT_PIN');return raw
def lease(pid,ticks):
    need(pid>1 and ticks.isdigit(),'EXPECTED_ROOT_LEASE_INPUT');p=Path('/proc')/str(pid)/'stat';raw=p.read_text();tail=raw[raw.rfind(')')+2:].split();need(tail[19]==ticks and p.lstat().st_uid==0,'CURRENT_LEASE_PROCESS_CHANGED')
def functions(bundle):
    need(all(bundle.get(k) is False for k in ('nativeConstructorCompiled','oldEntryImported','oldStableCompiled')),'ISOLATED_FROZEN_BUNDLE_ONLY')
    result={}
    for domain,source in [('report','report'),('content','content_functions')]:
        # Exactly the frozen isolated definitions. No Factory, Native, engine,
        # backend, constructor or old writer is imported or invoked.
        env={'__builtins__':__builtins__,'collections':collections,'closing':closing,'hashlib':hashlib,'json':json,'os':os,'Path':Path,'re':re,'sqlite3':sqlite3,'stat':stat,'time':time}
        exec(compile(bundle['sources'][source],'<pinned-diagnostic-'+source+'>','exec'),env);result[domain]=env['connection_seal']
    return result
def family(path,mode):
    result={}
    for key,suffix in [('db',''),('wal','-wal'),('shm','-shm')]:
        p=exact(str(path)+suffix);need(p.exists(),'EXISTING_WAL_SHM_FAMILY_REQUIRED_NO_CREATION');s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==mode and s.st_size<=512*1024*1024,'EXACT_EXISTING_DATABASE_FILE_FAMILY')
        result[key]={'device':s.st_dev,'inode':s.st_ino,'uid':s.st_uid,'mode':mode,'bytes':s.st_size,'mtimeNs':s.st_mtime_ns,'ctimeNs':s.st_ctime_ns}
    return result
def read_domain(domain,seal):
    path=DATA/('salon-reports.sqlite' if domain=='report' else 'content.sqlite');mode=0o600 if domain=='report' else 0o644;before=family(path,mode)
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=5)) as db:
        db.execute('PRAGMA query_only=ON');db.execute('BEGIN');need(db.execute('PRAGMA query_only').fetchone()==(1,),'QUERY_ONLY_REQUIRED');value=seal(db);db.rollback()
    after=family(path,mode);keys=('device','inode','uid','mode');identity={k:after['db'][k] for k in keys};need(identity=={k:before['db'][k] for k in keys},'DATABASE_IDENTITY_CHANGED_DURING_DIAGNOSTIC')
    return {'identity':identity,'content':value,'family':after,'familyMetadataChangedDuringRead':before!=after}
def type_counts(value):
    result=collections.Counter()
    def visit(v):
        result[type(v).__name__]+=1
        if type(v) is dict:
            for k,z in v.items():visit(k);visit(z)
        elif type(v) in (list,tuple):
            for z in v:visit(z)
    visit(value);return dict(sorted(result.items()))
def compare(domain,before,current):
    content=current['content'];content_hash=sha(encoded(content));after_json=json.loads(encoded(content));tables=[]
    for name in sorted(set(before.get('tables',{}))|set(content.get('tables',{}))):
        old=before.get('tables',{}).get(name);row=content.get('tables',{}).get(name)
        new=None if row is None else {'count':row['count'],'rowMultisetSha256':sha(encoded(row['rows'])),'columnsSha256':sha(encoded(row['columns']))}
        if old!=new:tables.append({'table':name,'before':old,'current':new,'changedKeys':sorted(set(old or {})|set(new or {})) if old is None or new is None else [k for k in sorted(old) if old[k]!=new[k]]})
    value={'domain':domain,'identityChanged':before.get('identity')!=current['identity'],'beforeContentSha256':before['contentSha256'],'currentContentSha256':content_hash,'canonicalContentChanged':before['contentSha256']!=content_hash,'currentContentTypes':type_counts(content),'currentJsonRoundtripExact':after_json==content,'familyMetadataChangedDuringRead':current['familyMetadataChangedDuringRead'],'changedTables':tables}
    if domain=='content':value.update(beforeSchemaSha256=before.get('schemaSha256'),currentSchemaSha256=content.get('schemaSha256'))
    else:value['reportSummary']={'cacheRevisions':{k:r['revision'] for k,r in content['cache'].items()},'cacheSha256':sha(encoded(content['cache'])),'historyCount':len(content['history']),'historySha256':sha(encoded(content['history'])),'importsCount':len(content['imports']),'importsSha256':sha(encoded(content['imports']))}
    return value
def main():
    p=argparse.ArgumentParser();p.add_argument('--bundle',type=Path,required=True);p.add_argument('--phase',type=Path,required=True);p.add_argument('--phase-sha',required=True);p.add_argument('--lease-pid',type=int,required=True);p.add_argument('--lease-start',required=True);a=p.parse_args()
    need(os.name=='posix' and os.geteuid()==0,'ROOT_LINUX_READONLY_DIAGNOSTIC_ONLY');lease(a.lease_pid,a.lease_start)
    bundle=json.loads(pinned(a.bundle,BUNDLE_SHA,2*1024*1024));phase=json.loads(pinned(a.phase,a.phase_sha,2*1024*1024))
    need(phase.get('namespace')==NS and phase.get('phase')=='fresh-full-forward-basis' and phase.get('status')=='COMPLETED_NOT_CUSTOMER_ACCEPTANCE' and phase.get('bindings',{}).get('packageSha256')==PACKAGE_SHA,'EXACT_COMPLETED_R7_FULL_PHASE_REQUIRED')
    seals=phase['facts']['currentDatabaseSeals'];fns=functions(bundle);rows=[]
    for domain in ('report','content'):
        lease(a.lease_pid,a.lease_start);rows.append(compare(domain,seals[domain],read_domain(domain,fns[domain])));lease(a.lease_pid,a.lease_start)
    pinned(a.phase,a.phase_sha,2*1024*1024);pinned(a.bundle,BUNDLE_SHA,2*1024*1024)
    print(json.dumps({'schema':'palitra-r7-readonly-backup-change-diagnostic/v1','status':'DIAGNOSTIC_NOT_RETRY_OR_ADMISSION','phaseSha256':a.phase_sha,'domains':rows,'sqlWrites':0,'applicationCalls':0,'runtimeAuthorization':False,'runtimeAcceptance':False,'privateValuesEmitted':False,'freshReadComparedToJournalNotLostInMemoryMinimum':True,'limitation':'Later current read cannot reconstruct the exact transient value from the failed call. SQLite query_only protects SQL rows; existing WAL+SHM required.'},separators=(',',':')))
if __name__=='__main__':
    try:main()
    except Exception as e:print(json.dumps({'status':'READONLY_DIAGNOSTIC_REFUSED','code':str(e) if type(e) is ValueError and re.fullmatch('[A-Z0-9_]+',str(e)) else type(e).__name__,'runtimeAuthorization':False}));raise SystemExit(2)
