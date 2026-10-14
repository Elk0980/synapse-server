"""PRIVATE one-off existing documents import. No DDL/auth/env/API/network reads."""
import argparse,base64,gzip,hashlib,json,os,re,sqlite3,stat,subprocess,sys,time
from pathlib import Path
from datetime import datetime,timezone
KEY='project-forms/palitra-love/palitra-orders';FEATURE='04c85b427ad034c78a6450205408d9af1fe35aa16ad96a853ac74c52f4302801'
MAX_PLAIN=64*1024*1024;MAX_COMPRESSED=8*1024*1024;MAX_MODEL=1024*1024
class Refused(Exception):pass
def need(v,m):
 if not v:raise Refused(m)
def sha(v):return hashlib.sha256(v).hexdigest()
def encode(v):return json.dumps(v,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf8')
def decode(v):
 def pairs(items):
  o={}
  for k,x in items:need(k not in o,'Duplicate JSON key');o[k]=x
  return o
 def bad(_):raise Refused('Nonfinite JSON number')
 try:return json.loads(v.decode('utf-8-sig'),object_pairs_hook=pairs,parse_constant=bad)
 except (ValueError,UnicodeError,RecursionError):raise Refused('Malformed UTF-8/JSON')
def safe(p,missing=False):
 p=Path(p).absolute();need('..' not in p.parts,'Unsafe path')
 for x in [*reversed(p.parents),p]:
  try:s=x.lstat()
  except FileNotFoundError:need(missing,'Required file absent');continue
  need(not stat.S_ISLNK(s.st_mode) and not(getattr(s,'st_file_attributes',0)&0x400),'Symlink/reparse refused')
  if x!=p:need(stat.S_ISDIR(s.st_mode),'Non-directory ancestor')
 return p
def read(p,limit=MAX_PLAIN):
 p=safe(p);a=p.stat();need(stat.S_ISREG(a.st_mode) and 0<a.st_size<=limit,'Regular bounded file required');fd=os.open(p,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
 try:
  with os.fdopen(fd,'rb',closefd=False) as f:b=f.read(limit+1)
  c=os.fstat(fd);d=p.stat();need((a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns)==(c.st_dev,c.st_ino,c.st_size,c.st_mtime_ns)==(d.st_dev,d.st_ino,d.st_size,d.st_mtime_ns),'File changed during read');return b
 finally:os.close(fd)
def newfile(p,data):
 p=safe(p,True);need(p.parent.is_dir() and not p.exists(),'New private file required');fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
def private_cli_path(p,exists=False):
 # Native Linux operations may never put the actual model/history under sites
 # or the repository. Windows tests use only their task-owned temp directory.
 if os.name!='posix':return
 root=safe('/opt/synapse/.palitra-private-0248');target=safe(p,not exists)
 need(os.geteuid()==0 and root.is_dir() and root.stat().st_uid==0 and stat.S_IMODE(root.stat().st_mode)==0o700,'Confirmed Root-owned private directory0700 required')
 need(target.is_relative_to(root) and target!=root,'Private artifacts outside exact task directory refused')
 if exists:need(target.stat().st_uid==0 and stat.S_IMODE(target.stat().st_mode)&0o077==0,'Private input must be Root-only0600')
def unpack(raw):
 need(0<len(raw)<MAX_COMPRESSED*2,'Transfer envelope oversized');e=decode(raw)
 need(type(e)==dict and set(e)=={'schema','kind','compressedLength','compressedSha256','plainLength','plainSha256','base64'},'Unexpected/duplicated envelope')
 need(e['schema']==1 and e['kind']=='PRIVATE_PALITRA_FORMS_GZIP_V1','Wrong private transfer type')
 need(type(e['compressedLength']) is int and 0<e['compressedLength']<=MAX_COMPRESSED and type(e['plainLength']) is int and 0<e['plainLength']<=MAX_PLAIN,'Invalid lengths')
 need(type(e['base64']) is str and re.fullmatch(r'[A-Za-z0-9+/]*={0,2}',e['base64']) is not None,'Only data-only canonical base64 accepted')
 try:blob=base64.b64decode(e['base64'],validate=True)
 except ValueError:raise Refused('Invalid base64')
 need(base64.b64encode(blob).decode()==e['base64'] and len(blob)==e['compressedLength'] and sha(blob)==e['compressedSha256'],'Compressed checksum/length mismatch')
 import zlib
 d=zlib.decompressobj(16+zlib.MAX_WBITS)
 try:plain=d.decompress(blob,MAX_PLAIN+1)
 except zlib.error:raise Refused('Malformed gzip')
 need(d.eof and not d.unused_data and not d.unconsumed_tail and len(plain)==e['plainLength'] and sha(plain)==e['plainSha256'],'Plain checksum/length/duplicated gzip mismatch')
 p=decode(plain);need(type(p)==dict and set(p)=={'schema','kind','namespace','source','documents','auxiliaryExports'} and p['schema']==1 and p['kind']=='PRIVATE_PROJECT_FORMS_DOCUMENTS' and p['namespace']==KEY,'Wrong private payload')
 need(type(p['documents']) is list and 1<=len(p['documents'])<=501 and type(p['auxiliaryExports']) is list and len(p['auxiliaryExports'])<=5,'Invalid history inventory')
 versions=set()
 for rec in p['documents']:
  need(set(rec)=={'sourceId','sourceRevision','createdAt','sourceSha256','sourceBytes','model'} and type(rec['sourceRevision']) is int and rec['sourceRevision']>0 and rec['sourceRevision'] not in versions,'Repeated/malformed history revision');versions.add(rec['sourceRevision'])
  need(rec['model']['revision']==rec['sourceRevision'] and rec['model'].get('schema')==1 and len(encode(rec['model']))<=MAX_MODEL,'Invalid history model')
 need([r['sourceRevision'] for r in p['documents']]==sorted(versions) and p['documents'][-1]['sourceRevision']==p['source']['latestRevision'],'Latest snapshot not last')
 ids=set()
 for rec in p['auxiliaryExports']:
  need(set(rec)=={'sourceId','sourceRevision','createdAt','sourceSha256','sourceBytes','model'} and type(rec['sourceId']) is str and rec['sourceId'] not in ids and rec['model']['revision']==rec['sourceRevision'] and len(encode(rec['model']))<=MAX_MODEL,'Malformed auxiliary export');ids.add(rec['sourceId'])
 return p,e
def chunks(raw):
 _,e=unpack(raw);body=e['base64'];parts=[body[i:i+800] for i in range(0,len(body),800)];pin=sha(raw)
 head=f"#PALITRA_PRIVATE_CHUNKS_V1 {len(raw)} {pin} {e['compressedLength']} {e['compressedSha256']} {e['plainLength']} {e['plainSha256']} {len(parts)}"
 lines=[head]+[f'#P{i:06d}:{part}' for i,part in enumerate(parts,1)]+[f'#END_PALITRA_PRIVATE_CHUNKS_V1 {len(parts)} {pin}']
 need(all(len(x)<=1000 for x in lines),'Chunk line limit');return ('\n'.join(lines)+'\n').encode('ascii')
def unchunks(text,expected):
 need(0<len(text)<=MAX_COMPRESSED*3,'Paste text oversized');text=text.replace(b'\r\n',b'\n');need(all(c==10 or 32<=c<=126 for c in text),'Clipboard control/UTF8 byte refused');lines=text.decode('ascii').splitlines()
 need(lines and all(0<len(x)<=1000 for x in lines),'Canonical terminal line limit exceeded');head=lines[0].split(' ')
 need(len(head)==8 and head[0]=='#PALITRA_PRIVATE_CHUNKS_V1','Fixed paste header required')
 for index in [1,3,5,7]:need(re.fullmatch(r'[1-9][0-9]*',head[index]) is not None,'Malformed paste length/sequence')
 for index in [2,4,6]:need(re.fullmatch(r'[0-9a-f]{64}',head[index]) is not None,'Malformed paste SHA')
 n=int(head[7]);need(1<=n<=20000 and len(lines)==n+2,'Duplicate/truncated paste inventory');need(lines[-1]==f'#END_PALITRA_PRIVATE_CHUNKS_V1 {n} {head[2]}','Exact finish marker required')
 parts=[]
 for index,line in enumerate(lines[1:-1],1):
  prefix=f'#P{index:06d}:';need(line.startswith(prefix),'Duplicated/out-of-order chunk sequence');part=line[len(prefix):]
  need((len(part)==800 if index<n else 0<len(part)<=800) and re.fullmatch(r'[A-Za-z0-9+/]+={0,2}',part) is not None,'Malformed data-only chunk');parts.append(part)
 e={'schema':1,'kind':'PRIVATE_PALITRA_FORMS_GZIP_V1','compressedLength':int(head[3]),'compressedSha256':head[4],'plainLength':int(head[5]),'plainSha256':head[6],'base64':''.join(parts)};raw=encode(e)
 need(len(raw)==int(head[1]) and sha(raw)==head[2]==expected,'Whole envelope checksum mismatch');unpack(raw);return raw
def native_validator(models,approval):
 expected=approval['contentImage'];need(re.fullmatch(r'sha256:[0-9a-f]{64}',expected or '') is not None,'Exact native image required')
 r=subprocess.run(['docker','inspect','--format','{{.Image}}','synapse-content-1'],capture_output=True,timeout=20);need(r.returncode==0 and r.stdout.decode().strip()==expected,'Native image changed')
 code="const fs=require('fs'),c=require('crypto'),p='/app/project-forms.cjs',pin=process.argv[1];if(fs.realpathSync(p)!==p||fs.lstatSync(p).isSymbolicLink()||c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==pin)process.exit(31);const {validateModel}=require(p);let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{s+=x;if(Buffer.byteLength(s)>67108864)process.exit(31)});process.stdin.on('end',()=>{const m=JSON.parse(s);for(const v of m)validateModel(v);console.log(JSON.stringify({validated:m.length,feature:pin}))});"
 r=subprocess.run(['docker','exec','-i','synapse-content-1','node','-e',code,'--',FEATURE],input=encode(models),capture_output=True,timeout=60);need(r.returncode==0,'Native exact validator refused model');need(decode(r.stdout)=={'validated':len(models),'feature':FEATURE},'Native validator result mismatch')
def lease(a):
 need(a['lease']['path']=='/opt/synapse/.palitra-app-release.lock' and type(a['lease']['pid']) is int and a['lease']['pid']>0,'Exact existing Root lease required')
 r=subprocess.run(['lslocks','--noheadings','--output','PID,PATH'],capture_output=True,timeout=15)
 need(r.returncode==0 and any(x.strip().split(maxsplit=1)==[str(a['lease']['pid']),a['lease']['path']] for x in r.stdout.decode().splitlines()),'Root lease changed')
def identity(a,proof_reader):
 raw=proof_reader();need(sha(raw)==a['ownerProofSha256'],'Owner proof changed');p=decode(raw)
 need(p.get('rootConfirmed') is True and p.get('host')=='synapse.synapsebusiness.ru','Independent native identity proof required')
 i=p['identity'];need(i==a['owner'] and i.get('role')=='owner' and i.get('company')=='palitra-love' and i.get('board')=='palitra-orders' and type(i.get('id')) is str and i['id'],'Owner/company identity changed')
 stamp=datetime.fromisoformat(p['observedAt']).timestamp();need(0<=time.time()-stamp<=300,'Native owner proof stale');return i
def schema(db):
 columns=[tuple(x) for x in db.execute('PRAGMA table_info(documents)')]
 expected=[(0,'id','INTEGER',0,None,1),(1,'key','TEXT',1,None,0),(2,'version','INTEGER',1,None,0),(3,'created_at','TEXT',1,None,0),(4,'author','TEXT',0,None,0),(5,'body','TEXT',1,None,0)]
 need(columns==expected,'Existing documents schema changed/absent')
 indexes=[];unique=False
 for row in db.execute('PRAGMA index_list(documents)'):
  name=row[1];need(re.fullmatch(r'[A-Za-z0-9_]+',name) is not None,'Unexpected index name');cols=[r[2] for r in db.execute('PRAGMA index_info("'+name+'")')];sql=db.execute("SELECT sql FROM sqlite_master WHERE type='index' AND name=? AND tbl_name='documents'",(name,)).fetchone();indexes.append([name,row[2],row[3],row[4],cols,sql[0] if sql else None]);unique=unique or (row[2]==1 and row[4]==0 and cols==['key','version'])
 need(unique and not list(db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='documents'")) and not list(db.execute('PRAGMA foreign_key_list(documents)')),'Unique key/version missing, triggers or foreign keys present')
 ddl=db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'").fetchone()[0]
 return sha(encode({'columns':columns,'indexes':sorted(indexes),'tableDDL':ddl}))
def rows(db):return [list(r) for r in db.execute('SELECT id,version,created_at,author,body FROM documents WHERE key=? ORDER BY version ASC',(KEY,))]
def snapshot(db):
 r=rows(db);need(len({x[1] for x in r})==len(r) and all(type(x[1]) is int and 0<x[1]<2**53 for x in r),'Duplicate/invalid native versions');return {'count':len(r),'tip':r[-1][1] if r else 0,'digest':sha(encode(r)),'authors':sorted(set(x[3] for x in r),key=lambda x:str(x))}
def connect(dbpath,write=False,expected=None):
 p=safe(dbpath);s=p.stat();need(stat.S_ISREG(s.st_mode),'Existing regular DB required')
 if expected:need(str(p)==expected['path'] and [s.st_dev,s.st_ino]==expected['deviceInode'],'Native DB binding changed')
 uri=p.as_uri()+'?mode='+('rw' if write else 'ro');db=sqlite3.connect(uri,uri=True,isolation_level=None,timeout=0)
 now=p.stat();need([s.st_dev,s.st_ino]==[now.st_dev,now.st_ino],'DB replaced while opening');return db
def plan(p,base,owner):
 ordered=[*p['documents'][:-1],*p['auxiliaryExports'],p['documents'][-1]];result=[]
 for index,rec in enumerate(ordered,1):
  need(base['tip']+index<2**53,'Native version limit');datetime.fromisoformat(rec['createdAt'].replace('Z','+00:00'))
  body={**rec['model'],'revision':base['tip']+index};result.append({'sourceId':rec['sourceId'],'sourceRevision':rec['sourceRevision'],'version':body['revision'],'createdAt':rec['createdAt'],'author':owner['id'],'body':encode(body).decode()})
 return result
def check(a,p,e,proof_reader,lease_check):
 need(a.get('schema')==1 and a.get('rootApproved') is True and a.get('namespace')==KEY and a.get('databaseBindingVerified') is True and a.get('sourceSnapshotFrozen') is True,'Explicit private Root approval/binding/freeze required')
 need(a.get('compressedSha256')==e['compressedSha256'] and a.get('plainSha256')==e['plainSha256'] and a.get('sourceLatestSha256')==p['source']['latestRawSha256'],'Approved private snapshot changed')
 need(a.get('includeAuxiliaryExports')==[r['sourceId'] for r in p['auxiliaryExports']],'Aux export decision changed');need(a.get('featureSha256')==FEATURE,'Native feature BASE changed');lease_check(a);return identity(a,proof_reader)
def inspect(dbpath):
 p=safe(dbpath);db=connect(p)
 try:return {'namespace':KEY,'db':{'path':str(p),'deviceInode':[p.stat().st_dev,p.stat().st_ino],'schemaDigest':schema(db)},'base':snapshot(db),'dbWrites':0}
 finally:db.close()
def import_payload(raw,a,dbpath,proof_reader,*,apply=False,journal=None,validator=native_validator,lease_check=lease,inject=None):
 p,e=unpack(raw);owner=check(a,p,e,proof_reader,lease_check);validator([r['model'] for r in p['documents']+p['auxiliaryExports']],a)
 db=connect(dbpath,apply,a['db'])
 try:
  need(schema(db)==a['db']['schemaDigest'],'Native schema BASE changed');base=snapshot(db);need(base==a['base'],'Namespace CAS changed');need(all(x in a.get('allowedExistingAuthors',[]) for x in base['authors']),'Namespace belongs to another owner')
  planned=plan(p,base,owner)
  if not apply:return {'status':'DRY_RUN_NO_WRITES','documents':len(planned),'latestSourceRevision':p['source']['latestRevision'],'latestNativeVersion':planned[-1]['version'],'dbWrites':0}
  need(journal is not None,'Unique private journal required');newfile(journal,encode({'phase':'IMPORT_STARTED_UNKNOWN','namespace':KEY,'plainSha256':e['plainSha256']}))
  db.execute('BEGIN IMMEDIATE')
  try:
   need(schema(db)==a['db']['schemaDigest'] and snapshot(db)==base,'Namespace/schema changed at CAS');check(a,p,e,proof_reader,lease_check)
   for index,rec in enumerate(planned):
    if inject:inject(index,db)
    db.execute('INSERT INTO documents (key,version,created_at,author,body) VALUES (?,?,?,?,?)',(KEY,rec['version'],rec['createdAt'],rec['author'],rec['body']))
   added=rows(db)[base['count']:];need(len(added)==len(planned) and all(row[1:]==[rec['version'],rec['createdAt'],rec['author'],rec['body']] for row,rec in zip(added,planned)),'Import readback failed');check(a,p,e,proof_reader,lease_check);after=snapshot(db);db.execute('COMMIT')
  except Exception:db.execute('ROLLBACK');raise
  receipt={'phase':'IMPORTED_DOCUMENTS_ONLY','namespace':KEY,'base':base,'after':after,'ownerId':owner['id'],'mapping':[{'sourceId':r['sourceId'],'sourceRevision':r['sourceRevision'],'nativeVersion':r['version']} for r in planned],'inserted':[{'id':r[0],'version':r[1],'sha256':sha(encode(r))} for r in added]}
  temp=Path(str(journal)+'.complete');newfile(temp,encode(receipt));os.replace(temp,journal);return {'status':receipt['phase'],'documents':len(planned),'latestNativeVersion':planned[-1]['version'],'dbRowsInserted':len(planned),'journalSha256':sha(read(journal))}
 finally:db.close()
def rollback(a,dbpath,proof_reader,journal,*,apply=False,expected_journal_sha=None,lease_check=lease):
 need(apply is True and a.get('rootApproved') is True,'Explicit approved rollback required');lease_check(a);owner=identity(a,proof_reader);raw=read(journal);need(sha(raw)==expected_journal_sha,'Independent journal SHA mismatch');receipt=decode(raw);need(receipt['phase']=='IMPORTED_DOCUMENTS_ONLY' and receipt['namespace']==KEY and receipt['ownerId']==owner['id'],'Unknown journal/new owner');db=connect(dbpath,True,a['db'])
 try:
  db.execute('BEGIN IMMEDIATE')
  try:
   need(schema(db)==a['db']['schemaDigest'] and snapshot(db)==receipt['after'],'Native documents changed after import; rollback refused');lease_check(a);identity(a,proof_reader)
   current=rows(db);imported=current[receipt['base']['count']:];need(len(imported)==len(receipt['inserted']),'Rollback inventory changed')
   for row,saved in zip(imported,receipt['inserted']):need(row[0]==saved['id'] and row[1]==saved['version'] and sha(encode(row))==saved['sha256'],'Imported row changed')
   for saved in reversed(receipt['inserted']):need(db.execute('DELETE FROM documents WHERE id=? AND key=? AND version=?',(saved['id'],KEY,saved['version'])).rowcount==1,'Rollback delete mismatch')
   need(snapshot(db)==receipt['base'],'Rollback BASE readback mismatch');identity(a,proof_reader);db.execute('COMMIT')
  except Exception:db.execute('ROLLBACK');raise
  receipt['phase']='ROLLED_BACK_IMPORTED_DOCUMENTS_ONLY';temp=Path(str(journal)+'.rollback');newfile(temp,encode(receipt));os.replace(temp,journal);return {'status':receipt['phase'],'dbRowsDeleted':len(receipt['inserted'])}
 finally:db.close()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['receive','receive-lines','inspect','import','rollback']);p.add_argument('--payload',type=Path);p.add_argument('--expected-envelope-sha');p.add_argument('--output',type=Path);p.add_argument('--db-path',type=Path);p.add_argument('--approval',type=Path);p.add_argument('--owner-proof',type=Path);p.add_argument('--journal',type=Path);p.add_argument('--expected-journal-sha');p.add_argument('--apply',action='store_true');x=p.parse_args()
 try:
  if x.operation in ['receive','receive-lines']:
   private_cli_path(x.output)
   # Consume through explicit EOF, including any duplicate paste. Every chunk
   # is also a shell comment; queued duplicate lines can never become commands.
   print('PRIVATE_RECEIVER_ACTIVE_WAITING_FOR_DATA_AND_EOF',file=sys.stderr,flush=True)
   received=sys.stdin.buffer.read(MAX_COMPRESSED*3+1);raw=unchunks(received,x.expected_envelope_sha) if x.operation=='receive-lines' else received
   need(sha(raw)==x.expected_envelope_sha,'Clipboard/duplicate envelope checksum mismatch');payload,envelope=unpack(raw);newfile(x.output,raw);result={'status':'PRIVATE_DATA_RECEIVED_ONLY','documents':len(payload['documents']),'auxiliaryExports':len(payload['auxiliaryExports']),'plainSha256':envelope['plainSha256'],'dbWrites':0}
  elif x.operation=='inspect':result=inspect(x.db_path)
  else:
   private_cli_path(x.approval,True);private_cli_path(x.owner_proof,True)
   if x.payload:private_cli_path(x.payload,True)
   if x.journal:private_cli_path(x.journal,x.operation=='rollback')
   a=decode(read(x.approval));reader=lambda:read(x.owner_proof)
   if x.operation=='import':raw=read(x.payload,MAX_COMPRESSED*2);need(sha(raw)==x.expected_envelope_sha,'Private envelope changed');result=import_payload(raw,a,x.db_path,reader,apply=x.apply,journal=x.journal)
   else:result=rollback(a,x.db_path,reader,x.journal,apply=x.apply,expected_journal_sha=x.expected_journal_sha)
  print(json.dumps(result,ensure_ascii=False));return 0
 except (Refused,OSError,KeyError,ValueError,TypeError,sqlite3.Error,subprocess.TimeoutExpired) as e:print(json.dumps({'status':'REFUSED','reason':str(e)},ensure_ascii=False));return 2
if __name__=='__main__':sys.exit(main())
