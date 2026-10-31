"""Readonly exact managed-history witness, adapted from reviewed QA_R4 primitives.
No network/application imports/SQL writes/repair. Full SHA before/after; full stat between.
"""
from pathlib import Path,PurePosixPath
import hashlib,json,os,re,stat,time
SITE='site-44bbe13f1bad5e005b2a';COMPANY='palitra-love';HEX=re.compile('[a-f0-9]{64}')
LIMIT=16*1024*1024;TOTAL=6*1024**3;MAXFILES=250000;SECONDS=180;HISTORY_COUNT=337
PINS={'assets/order.js':'37c87769cbffad6a2751df40b6911b48bf1a5646606fcb61937027755b103e6e','assets/storefront.js':'008f75eecee63f7bd6657408d844f08f9f37472e1d1d3c81256f52505423a808','account/register/index.html':'8d5f8e165307dfc9272cbe8ec3851f0f85a2e6db370558b52face10dfb74dbf0'}
enc=lambda v:(json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':'))+'\n').encode();sha=lambda v:hashlib.sha256(v).hexdigest()
def need(ok,code):
 if not ok:raise ValueError(code)
def pairs(items):
 out={}
 for k,v in items:need(k not in out,'HISTORY_DUPLICATE_JSON_KEY');out[k]=v
 return out
def parse(raw):return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in()).throw(ValueError('HISTORY_NONFINITE_JSON')))
def relative(name):
 need(type(name)is str and name and '\\'not in name and not any(ord(c)<32 for c in name),'HISTORY_PATH_INVALID');p=PurePosixPath(name);need(not p.is_absolute()and all(v not in('','.','..')for v in name.split('/'))and str(p)==name,'HISTORY_PATH_INVALID');return name
def meta(path):
 s=path.lstat();return [s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,str(s.st_mtime_ns),str(s.st_ctime_ns)]
def safe(path):
 need(path.is_absolute()and path.resolve()==path,'HISTORY_CANONICAL_FILE');before=path.lstat();need(stat.S_ISREG(before.st_mode)and not path.is_symlink()and before.st_size<=LIMIT,'HISTORY_REGULAR_BOUND')
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_BINARY',0))
 with os.fdopen(fd,'rb')as f:raw=f.read(LIMIT+1);inside=os.fstat(f.fileno())
 after=path.lstat();keys=('st_dev','st_ino','st_size','st_mode','st_uid','st_gid','st_nlink','st_mtime_ns','st_ctime_ns');need(len(raw)<=LIMIT and all(getattr(before,k)==getattr(inside,k)==getattr(after,k)for k in keys),'HISTORY_READ_CHANGED');return raw
def tree(folder,budget,full,expected=None):
 need(folder.is_dir()and not folder.is_symlink()and folder.resolve()==folder,'HISTORY_CANONICAL_DIRECTORY');files={};dirs={'.':meta(folder)}
 def walk_error(error):raise error
 for current,subdirs,names in os.walk(folder,followlinks=False,onerror=walk_error):
  for n in subdirs:
   p=Path(current)/n;need(not p.is_symlink(),'HISTORY_DIRECTORY_ALIAS');dirs[relative(p.relative_to(folder).as_posix())]=meta(p)
  for n in names:
   p=Path(current)/n;name=relative(p.relative_to(folder).as_posix());info=p.lstat();need(not p.is_symlink()and stat.S_ISREG(info.st_mode)and info.st_size<=LIMIT,'HISTORY_REGULAR_BOUND');before=meta(p)
   budget[0]+=info.st_size;budget[1]+=1;need(budget[0]<=TOTAL and budget[1]<=MAXFILES and time.monotonic()-budget[2]<=SECONDS,'HISTORY_SCAN_BOUND')
   if full:digest=sha(safe(p))
   else:
    need(expected is not None and name in expected['files']and expected['files'][name]['stat']==before,'HISTORY_STAT_CHANGED');digest=expected['files'][name]['sha256']
   need(meta(p)==before,'HISTORY_STAT_CHANGED');files[name]={'sha256':digest,'bytes':info.st_size,'stat':before}
 result={'files':files,'directories':dirs}
 if expected is not None:need(enc(result)==enc(expected),'HISTORY_TREE_CHANGED')
 return result

def scan(conn,data,facts,required_revision,full=True,expected=None):
 need(type(required_revision)is str and HEX.fullmatch(required_revision),'HISTORY_REVIEWED337_REV_REQUIRED')
 row=conn.execute('SELECT m.id,m.company_code,m.is_active,m.deleted_at,w.hostname,w.runtime,w.current_revision FROM managed_sites m JOIN site_workspaces w ON w.site_id=m.id WHERE m.id=?',(SITE,)).fetchone();need(row and row[:6]==(SITE,COMPANY,1,None,'palitra-love-draft-1.synapsebusiness.ru','palitra-draft')and row[6]==required_revision,'HISTORY_FIXED_SITE337_REQUIRED')
 tables=('managed_sites','site_workspaces','site_workspace_revisions');need(all(t in facts['tables']for t in tables),'HISTORY_MANAGED_TABLES_REQUIRED')
 managed={'schema':[r for r in facts['schema']if r[2]in tables],'tables':{t:facts['tables'][t]for t in tables}}
 cols=[r[1]for r in conn.execute('PRAGMA table_info(site_workspace_revisions)')];need({'site_id','revision','version','manifest_json'}<=set(cols),'HISTORY_KNOWN_SCHEMA')
 rows=conn.execute('SELECT * FROM site_workspace_revisions WHERE site_id=? ORDER BY version,revision',(SITE,)).fetchall();need(len(rows)==HISTORY_COUNT,'HISTORY_EXACT337_REVISION_COUNT');versions=data/'projects'/COMPANY/'sites'/SITE/'versions';need(versions.resolve()==versions and versions.is_dir()and not versions.is_symlink(),'HISTORY_VERSIONS_ROOT');records={};budget=[0,0,time.monotonic()];current_doc=None
 for values in rows:
  record=dict(zip(cols,values));rev=record['revision'];need(type(rev)is str and HEX.fullmatch(rev)and rev not in records and type(record['version'])is int,'HISTORY_REVISION_IDENTITY')
  doc=parse(record['manifest_json']);prior=None if expected is None else expected['history'].get(rev);need(expected is None or prior is not None,'HISTORY_UNEXPECTED_REVISION')
  actual=tree(versions/rev,budget,full,None if prior is None else prior['tree']);need(type(doc)is dict and set(doc)==set(actual['files']),'HISTORY_MANIFEST_FILESET')
  records[rev]={'version':record['version'],'rowSha256':sha(enc(list(values))),'manifestSha256':sha(record['manifest_json'].encode()),'tree':actual}
  if rev==required_revision:
   need(record['version']==337 and len(doc)==141,'HISTORY_EXACT337_141')
   for name,item in doc.items():relative(name);need(item['sha256']==actual['files'][name]['sha256']and item['bytes']==actual['files'][name]['bytes'],'HISTORY_CURRENT_CONTENT_MISMATCH')
   need(all(doc.get(k,{}).get('sha256')==v for k,v in PINS.items()),'HISTORY_ACCEPTED_FORMS_CHANGED');current_doc=doc
 need(current_doc is not None and {p.name for p in versions.iterdir()}==set(records),'HISTORY_CURRENT_OR_PATHSET_CHANGED');need(conn.total_changes==0,'HISTORY_READONLY_REQUIRED')
 result={'siteId':SITE,'companyCode':COMPANY,'version':337,'revision':required_revision,'managedRows':managed,'history':records,'manifestSha256':sha(enc(current_doc)),'files':budget[1],'bytes':budget[0]}
 if expected is not None:need(enc(result)==enc(expected),'HISTORY_ROWS_OR_CONTENT_CHANGED')
 return result


# Original FULL definitions above are verbatim from reviewed 69690754. The dispatch
# below changes only FAST operation; FULL continues through the original code.
_FULL_TREE=tree
_FULL_SCAN=scan


def _shape(value,keys,code):
 need(type(value)is dict and set(value)==set(keys),code)


def _scalar_equal(actual,expected):
 # Generated actual scalar fields are int/string, not floating-point or bool.
 # JSON serialization distinguishes 1/True/1.0 and -0.0/0.0.
 return type(actual)is type(expected)and actual==expected


def _file_stat_equal(actual,expected):
 # The original FAST has expected.stat == before(list), followed by canonical
 # JSON comparison. Preserve its list-only rule and scalar type distinctions.
 if type(expected)is not list or len(actual)!=len(expected):return False
 if type(actual)is not list or len(actual)!=9:return all(_scalar_equal(a,b)for a,b in zip(actual,expected))
 return bool(type(actual[0])is type(expected[0])and actual[0]==expected[0] and type(actual[1])is type(expected[1])and actual[1]==expected[1] and type(actual[2])is type(expected[2])and actual[2]==expected[2] and type(actual[3])is type(expected[3])and actual[3]==expected[3] and type(actual[4])is type(expected[4])and actual[4]==expected[4] and type(actual[5])is type(expected[5])and actual[5]==expected[5] and type(actual[6])is type(expected[6])and actual[6]==expected[6] and type(actual[7])is type(expected[7])and actual[7]==expected[7] and type(actual[8])is type(expected[8])and actual[8]==expected[8]
)


def _stat_result(s):
 return [s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,str(s.st_mtime_ns),str(s.st_ctime_ns)]


# Exact lexical equivalent of relative() for FAST; FULL retains original parser.
_FAST_BAD_PATH=re.compile(r'[\\\x00-\x1f]')
def _fast_relative(name):
 need(type(name)is str and bool(name)and _FAST_BAD_PATH.search(name)is None,'HISTORY_PATH_INVALID')
 parts=name.split('/')
 need(name[0]!='/'and ''not in parts and '.'not in parts and '..'not in parts,'HISTORY_PATH_INVALID')
 return name


def _fast_tree(folder,budget,expected):
 _shape(expected,('files','directories'),'HISTORY_TREE_CHANGED')
 need(type(expected['files'])is dict and type(expected['directories'])is dict,'HISTORY_TREE_CHANGED')
 need(folder.is_dir()and not folder.is_symlink()and folder.resolve()==folder,'HISTORY_CANONICAL_DIRECTORY')
 # Directory metadata previously used canonical enc, which intentionally treats
 # SQLite/Python tuples and loaded JSON lists alike. These arrays remain small.
 need('.'in expected['directories']and enc(meta(folder))==enc(expected['directories']['.']),'HISTORY_TREE_CHANGED')
 seen_files=set();seen_dirs={'.'}
 def walk_error(error):raise error
 for current,subdirs,names in os.walk(folder,followlinks=False,onerror=walk_error):
  current_path=Path(current);prefix=current_path.relative_to(folder).as_posix();prefix=''if prefix=='.'else _fast_relative(prefix)+'/'
  for n in subdirs:
   p=current_path/n;name=_fast_relative(prefix+n);info=p.lstat()
   need(stat.S_ISDIR(info.st_mode)and not stat.S_ISLNK(info.st_mode),'HISTORY_DIRECTORY_ALIAS')
   need(name not in seen_dirs and name in expected['directories']and enc(_stat_result(info))==enc(expected['directories'][name]),'HISTORY_TREE_CHANGED');seen_dirs.add(name)
  for n in names:
   p=current_path/n;name=_fast_relative(prefix+n);info=p.lstat()
   need(stat.S_ISREG(info.st_mode)and info.st_size<=LIMIT,'HISTORY_REGULAR_BOUND')
   before=_stat_result(info);need(name not in seen_files and name in expected['files'],'HISTORY_STAT_CHANGED');prior=expected['files'][name]
   _shape(prior,('sha256','bytes','stat'),'HISTORY_TREE_CHANGED')
   need(_file_stat_equal(before,prior['stat'])and _scalar_equal(info.st_size,prior['bytes']),'HISTORY_STAT_CHANGED')
   budget[0]+=info.st_size;budget[1]+=1;need(budget[0]<=TOTAL and budget[1]<=MAXFILES and time.monotonic()-budget[2]<=SECONDS,'HISTORY_SCAN_BOUND')
   # A second fresh observation is mandatory; no stat/PASS is reused across calls.
   need(_file_stat_equal(_stat_result(p.lstat()),before),'HISTORY_STAT_CHANGED');seen_files.add(name)
 need(seen_files==set(expected['files'])and seen_dirs==set(expected['directories']),'HISTORY_TREE_CHANGED')
 return expected


def _fast_scan(conn,data,facts,required_revision,expected):
 need(type(required_revision)is str and HEX.fullmatch(required_revision),'HISTORY_REVIEWED337_REV_REQUIRED')
 _shape(expected,('siteId','companyCode','version','revision','managedRows','history','manifestSha256','files','bytes'),'HISTORY_ROWS_OR_CONTENT_CHANGED')
 need(type(expected['history'])is dict,'HISTORY_ROWS_OR_CONTENT_CHANGED')
 row=conn.execute('SELECT m.id,m.company_code,m.is_active,m.deleted_at,w.hostname,w.runtime,w.current_revision FROM managed_sites m JOIN site_workspaces w ON w.site_id=m.id WHERE m.id=?',(SITE,)).fetchone();need(row and row[:6]==(SITE,COMPANY,1,None,'palitra-love-draft-1.synapsebusiness.ru','palitra-draft')and row[6]==required_revision,'HISTORY_FIXED_SITE337_REQUIRED')
 tables=('managed_sites','site_workspaces','site_workspace_revisions');need(all(t in facts['tables']for t in tables),'HISTORY_MANAGED_TABLES_REQUIRED')
 managed={'schema':[r for r in facts['schema']if r[2]in tables],'tables':{t:facts['tables'][t]for t in tables}}
 cols=[r[1]for r in conn.execute('PRAGMA table_info(site_workspace_revisions)')];need({'site_id','revision','version','manifest_json'}<=set(cols),'HISTORY_KNOWN_SCHEMA')
 rows=conn.execute('SELECT * FROM site_workspace_revisions WHERE site_id=? ORDER BY version,revision',(SITE,)).fetchall();need(len(rows)==HISTORY_COUNT,'HISTORY_EXACT337_REVISION_COUNT');versions=data/'projects'/COMPANY/'sites'/SITE/'versions';need(versions.resolve()==versions and versions.is_dir()and not versions.is_symlink(),'HISTORY_VERSIONS_ROOT');seen=set();budget=[0,0,time.monotonic()];current_doc=None
 for values in rows:
  record=dict(zip(cols,values));rev=record['revision'];need(type(rev)is str and HEX.fullmatch(rev)and rev not in seen and type(record['version'])is int,'HISTORY_REVISION_IDENTITY')
  need(rev in expected['history'],'HISTORY_UNEXPECTED_REVISION');prior=expected['history'][rev];_shape(prior,('version','rowSha256','manifestSha256','tree'),'HISTORY_ROWS_OR_CONTENT_CHANGED')
  doc=parse(record['manifest_json']);actual=_fast_tree(versions/rev,budget,prior['tree']);need(type(doc)is dict and set(doc)==set(actual['files']),'HISTORY_MANIFEST_FILESET')
  need(_scalar_equal(record['version'],prior['version'])and _scalar_equal(sha(enc(list(values))),prior['rowSha256'])and _scalar_equal(sha(record['manifest_json'].encode()),prior['manifestSha256']),'HISTORY_ROWS_OR_CONTENT_CHANGED');seen.add(rev)
  if rev==required_revision:
   need(record['version']==337 and len(doc)==141,'HISTORY_EXACT337_141')
   for name,item in doc.items():_fast_relative(name);need(item['sha256']==actual['files'][name]['sha256']and item['bytes']==actual['files'][name]['bytes'],'HISTORY_CURRENT_CONTENT_MISMATCH')
   need(all(doc.get(k,{}).get('sha256')==v for k,v in PINS.items()),'HISTORY_ACCEPTED_FORMS_CHANGED');current_doc=doc
 need(current_doc is not None and {p.name for p in versions.iterdir()}==seen and seen==set(expected['history']),'HISTORY_CURRENT_OR_PATHSET_CHANGED');need(conn.total_changes==0,'HISTORY_READONLY_REQUIRED')
 need(enc(managed)==enc(expected['managedRows']),'HISTORY_ROWS_OR_CONTENT_CHANGED')
 actual_summary={'siteId':SITE,'companyCode':COMPANY,'version':337,'revision':required_revision,'manifestSha256':sha(enc(current_doc)),'files':budget[1],'bytes':budget[0]}
 need(all(_scalar_equal(value,expected[key])for key,value in actual_summary.items()),'HISTORY_ROWS_OR_CONTENT_CHANGED')
 return expected


def tree(folder,budget,full,expected=None):
 if full:return _FULL_TREE(folder,budget,full,expected)
 return _fast_tree(folder,budget,expected)


def scan(conn,data,facts,required_revision,full=True,expected=None):
 if full:return _FULL_SCAN(conn,data,facts,required_revision,full,expected)
 return _fast_scan(conn,data,facts,required_revision,expected)
