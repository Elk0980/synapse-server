"""Root only: targeted backup and permanent cleanup of confirmed test orders 7,8.
No API calls, sends, new schema, accounts, customer deletion or runtime changes.
"""
import argparse,hashlib,json,os,re,sqlite3,stat,subprocess,sys,types
from datetime import datetime,timezone
from pathlib import Path
sys.dont_write_bytecode=True
RELEASE=Path('/opt/synapse/releases/palitra-app-20261015')
PRIVATE=Path('/opt/synapse/.palitra-test-order-cleanup-7-8-r1')
DB=Path('/var/lib/docker/volumes/synapse_content_data/_data/content.sqlite')
CORE_SHA='60a129b3467068932e0d1ca5529f808a76f36f52027990d71bd19d588149db4b'
INC_SHA='f7170af089f3ca6e951426320f74b139294e85eda18a56296726c360c1f807d7'
IMAGE='sha256:5cceeb7019e78fa1269e7e5ed1c5f93951ab26afae6aa73457cfb1622aaefa0e'
WORKER_CID='7d7ec369e7ce44e492874137813caf3399b21b0242438b3b6df1281e4f379415'
CONFIRM='USER_APPROVED_DELETE_ONLY_7_8_ROOT_VERIFIED_TEST_CONTACTS'
IDS=(7,8);KEYS=tuple('palitra-love/order-workflow/orders/'+str(i)for i in IDS)
DELETE_TABLES=('site_order_work_events','site_order_checklist_events','site_order_checklist','site_order_work','site_order_outbox','client_bot_map','client_order_links','documents','site_orders')
SOURCE={
 'server.js':'43bd9ad6a4a40870d6022705ab94bddffde38df3a318e252414ebc8fcc8c0660',
 'site-orders.js':'da10aa8c05af59e50d4d75406dbff4c90a05837f7ede4831a2c3812d7018e51f',
 'client-dialogs.js':'753c53071335db26030bdd866a5b0bcaf9d1d36caaff4c7ec6e5069e000b98aa',
 'customer-chat.js':'e4b5fa1ad7489d3bb7dc06e40e941f2173e7be9e812e92b352dda12dd53d1233',
 'palitra-workflow.cjs':'de8789a7298419677e99da0ac2811b59bb93f37849c0d1d2097552ca1c2ccc91',
 'palitra-crm/app/lib/workspace.js':'b8ca5c0e163dccde3437218e6b872335d6c8f7a2e9810956fa5e7ae4f1c22956',
 'palitra-orders-public/shell.js':'102daf2d7a9439918258955e7673149ec49c81aee46a6c58a16ef162da22b13d'}
for _value in (CORE_SHA,INC_SHA,WORKER_CID,*SOURCE.values()):
 if re.fullmatch('[0-9a-f]{64}',_value)is None:raise ValueError('BAD_PRODUCTION_SHA_LITERAL')
if re.fullmatch('sha256:[0-9a-f]{64}',IMAGE)is None:raise ValueError('BAD_PRODUCTION_IMAGE_LITERAL')
def sha(raw):return hashlib.sha256(raw).hexdigest()
def data(value):return (json.dumps(value,sort_keys=True,ensure_ascii=True,separators=(',',':'))+'\n').encode()
class Refused(Exception):
 def __init__(self,code,counts=None):self.code=code;self.counts=counts;super().__init__(code)
def need(value,code,counts=None):
 if not value:raise Refused(code,counts)
def quoted(name):
 need(type(name)is str and re.fullmatch('[A-Za-z_][A-Za-z0-9_]*',name)is not None,'UNREVIEWED_SQL_IDENTIFIER');return '"'+name+'"'
def safe_path(path):
 path=Path(path);need(path.is_absolute()and'..'not in path.parts,'ABSOLUTE_PATH_REQUIRED')
 for part in [*reversed(path.parents),path]:
  if part.exists():need(not part.is_symlink()and not(getattr(part.lstat(),'st_file_attributes',0)&0x400),'LINK_REFUSED')
 return path
def read_private(path):
 path=safe_path(path);s=path.stat();need(stat.S_ISREG(s.st_mode)and 0<s.st_size<=2*1024*1024,'BOUNDED_PRIVATE_FILE_REQUIRED')
 if os.name=='posix':need(stat.S_IMODE(s.st_mode)==0o600 and s.st_uid==0,'PRIVATE_0600_ROOT_FILE_REQUIRED')
 raw=path.read_bytes();need((s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)==tuple(getattr(path.stat(),n)for n in ('st_dev','st_ino','st_size','st_mtime_ns')),'PRIVATE_FILE_CHANGED_DURING_READ');return raw
def create(path,value):
 path=safe_path(path);fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
 with os.fdopen(fd,'wb')as f:f.write(data(value));f.flush();os.fsync(f.fileno())
def replace(path,value):
 pending=Path(str(path)+'.pending');create(pending,value);os.replace(pending,path)
def load(path,pin):
 raw=safe_path(path).read_bytes();need(sha(raw)==pin,'ACCEPTED_HELPER_PIN_MISMATCH');module=types.ModuleType('cleanup_accepted_'+path.stem);module.__file__=str(path);exec(compile(raw,str(path),'exec'),module.__dict__);return module

class Runtime:
 def __init__(self):self.c=load(RELEASE/'activate_root.py',CORE_SHA);self.inc=load(RELEASE/'incremental_native.py',INC_SHA)
 def run(self,args):
  result=subprocess.run(args,capture_output=True,stdin=subprocess.DEVNULL,shell=False,timeout=30)
  need(result.returncode==0 and len(result.stdout)<=2*1024*1024 and len(result.stderr)<=2*1024*1024,'READONLY_NATIVE_FAILED_RC_'+str(result.returncode));return result.stdout
 def __call__(self):
  c=self.c;c.Activate(RELEASE,self.run).lease();image=self.run(['docker','inspect','--format','{{.Image}}','synapse-content-1']).decode().strip();need(image==IMAGE,'CURRENT_IMAGE_CHANGED');cid=self.run(['docker','inspect','--format','{{.Id}}','synapse-content-1']).decode().strip();worker=self.run(['docker','inspect','--format','{{.Id}}','synapse-chat-1']).decode().strip();need(re.fullmatch('[0-9a-f]{64}',cid)is not None and worker==WORKER_CID,'CURRENT_CONTAINER_CHANGED');mounts=c.obj(self.run(['docker','inspect','--format','{{json .Mounts}}','synapse-content-1']));need(type(mounts)is list,'ACTUAL_MOUNTS_REQUIRED');need(all(not PRIVATE.is_relative_to(Path(m['Source']))and not Path(m['Source']).is_relative_to(PRIVATE)for m in mounts if type(m.get('Source'))is str),'PRIVATE_BACKUP_OVERLAPS_CONTAINER_MOUNT');rows=[m for m in mounts if m.get('Destination')=='/data'];need(len(rows)==1 and rows[0].get('Type')=='volume'and rows[0].get('Source')==str(DB.parent)and rows[0].get('RW')is True,'EXACT_EXISTING_DB_VOLUME_REQUIRED');probe="const fs=require('fs'),p=process.env.DATABASE_PATH||'/data/content.sqlite';console.log(JSON.stringify({path:p,realpath:fs.realpathSync(p)}));";need(c.obj(self.run(['docker','exec','synapse-content-1','node','-e',probe]))=={'path':'/data/content.sqlite','realpath':'/data/content.sqlite'},'EXACT_DATABASE_PATH_REQUIRED');actual=c.obj(self.run(['docker','exec','synapse-content-1','node','-e',self.inc.HASH_JS,json.dumps(sorted(SOURCE),separators=(',',':'))]));need(actual==SOURCE,'CURRENT_SOURCE_CHANGED');c.Activate(RELEASE,self.run).lease();need(sha(c.read(RELEASE/'activate_root.py'))==CORE_SHA and sha(c.read(RELEASE/'incremental_native.py'))==INC_SHA,'ACCEPTED_HELPER_CHANGED');db=safe_path(DB);s=db.stat();return {'image':image,'contentCid':cid,'workerCid':worker,'mountsSha256':sha(data(mounts)),'sourceSha256':sha(data(actual)),'dbIdentity':[s.st_dev,s.st_ino]}

def connect(path,write=False):
 path=safe_path(path);need(path.is_file(),'EXISTING_DATABASE_REQUIRED');connection=sqlite3.connect(path.as_uri()+('?mode=rw'if write else'?mode=ro'),uri=True,timeout=10,isolation_level=None);connection.row_factory=sqlite3.Row;connection.execute('PRAGMA foreign_keys=ON');need(connection.execute('PRAGMA foreign_keys').fetchone()[0]==1,'FOREIGN_KEYS_REQUIRED');return connection
def table_names(conn):return {row[0]for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
def columns(conn,table):return {row['name']for row in conn.execute('PRAGMA table_info('+quoted(table)+')')}
def selected(conn,table,condition,args):
 rows=[dict(r)for r in conn.execute('SELECT * FROM '+quoted(table)+' WHERE '+condition+' ORDER BY rowid LIMIT 101',args)];need(len(rows)<=100,'TARGET_ROW_BOUND_EXCEEDED');return rows
def order_notification_maps(maps,outbox,counts):
 # Only the order ACK INSERT in client-dialogs.js839: never a dialog/message map.
 fields={'bot_key','chat_id','message_id','dialog_id','client_message_id','order_id','created_at'}
 for row in maps:
  need(set(row)==fields and row['bot_key']=='palitra'and type(row['order_id'])is int and row['order_id']in IDS and row['dialog_id']is None and row['client_message_id']is None and type(row['message_id'])is int and row['message_id']>0 and type(row['chat_id'])is str and row['chat_id'],'ORDER_NOTIFICATION_MAP_SCOPE_REFUSED',counts)
  candidates=[job for job in outbox if job.get('site')=='palitra'and job.get('company_code')=='palitra-love'and job.get('order_id')==row['order_id']and job.get('kind')=='order'and job.get('transport')=='client_bot'and job.get('status')in ('sent','error')and job.get('chat_id')==row['chat_id']]
  matched=False
  for job in candidates:
   try:ids=json.loads(job.get('external_ids','[]'))
   except (TypeError,ValueError):raise Refused('ORDER_NOTIFICATION_EXTERNAL_IDS_REFUSED',counts)
   need(type(ids)is list and len(ids)<=100 and all(type(value)is str and re.fullmatch('[0-9]{1,20}',value)is not None for value in ids),'ORDER_NOTIFICATION_EXTERNAL_IDS_REFUSED',counts)
   matched=matched or str(row['message_id'])in ids
  need(matched,'ORDER_NOTIFICATION_MAP_NOT_TERMINAL_OUTBOX',counts)

def state(conn,expected_name,expected_comments):
 tables=table_names(conn);need(set(DELETE_TABLES)<=tables,'EXPECTED_TARGET_TABLES_REQUIRED');schema=[dict(r)for r in conn.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY type,name")];need(len(schema)<=3000,'SCHEMA_BOUND_EXCEEDED');triggers=[r for r in schema if r['type']=='trigger'and r['tbl_name']in DELETE_TABLES];need(not triggers,'TARGET_TRIGGER_REQUIRES_REVIEW')
 rows={};counts={};rows['site_orders']=selected(conn,'site_orders','id IN (?,?)',IDS);need([r['id']for r in rows['site_orders']]==list(IDS),'EXACT_TWO_ORDERS_REQUIRED')
 for row in rows['site_orders']:
  need(row.get('site')=='palitra'and row.get('company_code')=='palitra-love'and row.get('name')==expected_name and type(row.get('comment'))is str and sha(row['comment'].encode('utf-8'))==expected_comments[str(row['id'])],'EXACT_CONFIRMED_TEST_ROWS_REQUIRED');need(bool(str(row.get('contact')or row.get('phone')or'').strip()),'TEST_CONTACT_REQUIRES_ROOT_REVIEW')
 for table in DELETE_TABLES:
  if table=='site_orders':continue
  rows[table]=selected(conn,table,'key IN (?,?)'if table=='documents'else'order_id IN (?,?)',KEYS if table=='documents'else IDS)
 counts={name:len(values)for name,values in rows.items()}
 need(all(r['status']=='new'for r in rows['site_order_work']),'NON_NEW_WORK_REFUSED',counts);need(all(r.get('checked')in (0,None)for t in ('site_order_checklist','site_order_checklist_events')for r in rows[t]),'CHECKLIST_PROGRESS_REFUSED',counts)
 need(all(r.get('site')=='palitra'and r.get('company_code')=='palitra-love'and r.get('kind')=='order'and r.get('status')in ('sent','error')for r in rows['site_order_outbox']),'OUTBOX_INFLIGHT_UNKNOWN_OR_SCOPE_REFUSED',counts)
 need(all(r.get('site')=='palitra'and r.get('bot_key')=='palitra'for r in rows['client_order_links']),'ORDER_LINK_SCOPE_REFUSED',counts)
 order_notification_maps(rows['client_bot_map'],rows['site_order_outbox'],counts)
 for row in rows['documents']:
  body=json.loads(row['body']);need(type(body)is dict and not body.get('confirmations')and not body.get('history')and body.get('stages')and body.get('currentStageId')==body['stages'][0]['id'],'WORKFLOW_PROGRESS_OR_PAYMENT_REFUSED',counts)
 blocked={};known=set(DELETE_TABLES)|{'site_order_rate','site_order_recipients'}
 for table in sorted(tables-known):
  cols=columns(conn,table)
  for field in ('order_id','site_order_id'):
   if field not in cols:continue
   query='SELECT COUNT(*) FROM '+quoted(table)+' WHERE '+quoted(field)+' IN (?,?)';args=list(IDS)
   if 'company_code'in cols:query+=' AND company_code=?';args.append('palitra-love')
   if 'site'in cols:query+=' AND site=?';args.append('palitra')
   n=conn.execute(query,args).fetchone()[0]
   if n:blocked[table]=blocked.get(table,0)+n
 need(not blocked,'CHAT_CRM_MAP_PAYMENT_OR_UNKNOWN_DEPENDENT_REFUSED',{**counts,**{'blocked_'+(k if k in {'chat_threads','client_dialogs','client_bot_map','palitra_crm_orders','palitra_crm_inquiries'}else sha(k.encode())[:12]):v for k,v in blocked.items()}})
 # A used link alone is order metadata; any actual associated dialog still blocks.
 linked=[r['dialog_id']for r in rows['client_order_links']if r.get('dialog_id')is not None]
 if linked and'client_dialogs'in tables:
  n=conn.execute('SELECT COUNT(*) FROM client_dialogs WHERE id IN ('+','.join('?'for _ in linked)+')',linked).fetchone()[0];need(n==0,'LINK_HAS_ACTUAL_DIALOG_REFUSED',counts)
 # Every FK into the delete set must be one of the five reviewed direct edges.
 reviewed={'site_order_work_events','site_order_checklist_events','site_order_checklist','site_order_work','site_order_outbox'}
 for table in tables:
  for fk in conn.execute('PRAGMA foreign_key_list('+quoted(table)+')'):
   if fk['table']not in DELETE_TABLES:continue
   need(table in reviewed and fk['table']=='site_orders'and fk['from']=='order_id'and fk['to']=='id'and fk['on_delete']=='NO ACTION'and fk['on_update']=='NO ACTION','UNREVIEWED_FOREIGN_KEY_REFUSED',counts)
 non_targets=conn.execute('SELECT COUNT(*) FROM site_orders WHERE id NOT IN (?,?)',IDS).fetchone()[0];sequence=[dict(r)for r in conn.execute("SELECT name,seq FROM sqlite_sequence WHERE name='site_orders'")]
 return {'rows':rows,'counts':counts,'schemaSha256':sha(data(schema)),'nonTargetOrderCount':non_targets,'siteOrderSequence':sequence}

class Cleanup:
 def __init__(self,db=DB,private=PRIVATE,probe=None,now=None,expected_name=None,expected_comments=None):
  need(type(expected_comments)is dict and set(expected_comments)=={'7','8'}and all(type(v)is str and re.fullmatch('[0-9a-f]{64}',v)is not None for v in expected_comments.values()),'ROOT_EXACT_COMMENT_HASHES_REQUIRED');self.expected_comments=dict(expected_comments)
  need(type(expected_name)is str and 0<len(expected_name)<=80 and expected_name.strip()==expected_name and not any(ord(ch)<32 for ch in expected_name),'ROOT_EXPECTED_NAME_REQUIRED');self.expected_name=expected_name;self.db=Path(db);self.private=Path(private);self.probe=probe or Runtime();self.now=now or(lambda:datetime.now(timezone.utc));self.receipt=self.private/'preflight.json';self.backup=self.private/'target-backup.json';self.journal=self.private/'apply-journal.json'
 def preflight(self,verified=False):
  need(verified is True,'ROOT_TEST_CONTACTS_VERIFICATION_REQUIRED');need(not self.private.exists(),'EXISTING_PRIVATE_ATTEMPT_REFUSED');started=self.now();runtime=self.probe();conn=connect(self.db)
  try:
   conn.execute('BEGIN');snapshot=state(conn,self.expected_name,self.expected_comments);conn.execute('COMMIT')
  finally:conn.close()
  need(self.probe()==runtime,'RUNTIME_CHANGED_DURING_PREFLIGHT');need(0<=(self.now()-started).total_seconds()<=300,'PREFLIGHT_TOO_OLD');safe_path(self.private).mkdir(mode=0o700);backup={'schema':1,'ids':list(IDS),'targetRows':snapshot['rows']};create(self.backup,backup);backup_sha=sha(read_private(self.backup));record={'schema':1,'phase':'PREFLIGHT_BACKUP_READY_NOT_DELETED','ids':list(IDS),'observedAtUtc':started.isoformat(),'rootVerifiedTestContacts':True,'expectedName':self.expected_name,'expectedComments':self.expected_comments,'runtime':runtime,'snapshotSha256':sha(data(snapshot)),'schemaSha256':snapshot['schemaSha256'],'counts':snapshot['counts'],'backupSha256':backup_sha,'nonTargetOrderCount':snapshot['nonTargetOrderCount'],'siteOrderSequence':snapshot['siteOrderSequence']};create(self.receipt,record);return {'status':record['phase'],'preflightSha256':sha(read_private(self.receipt)),'backupSha256':backup_sha,'counts':record['counts'],'deleted':0,'dbWrites':0}
 def apply(self,pin,confirmation,*,apply=False,fault=None):
  private=safe_path(self.private);need(private.is_dir(),'PRIVATE_BACKUP_DIRECTORY_REQUIRED')
  if os.name=='posix':need(stat.S_IMODE(private.stat().st_mode)==0o700 and private.stat().st_uid==0,'PRIVATE_ROOT_0700_DIRECTORY_REQUIRED')
  need(apply is True and confirmation==CONFIRM,'EXPLICIT_ROOT_USER_APPROVAL_INPUT_REQUIRED');need(not self.journal.exists()and not Path(str(self.journal)+'.pending').exists(),'UNKNOWN_OR_PREVIOUS_APPLY_NO_RETRY');raw=read_private(self.receipt);need(sha(raw)==pin,'PREFLIGHT_PIN_CHANGED');p=json.loads(raw);need(p.get('schema')==1 and p.get('phase')=='PREFLIGHT_BACKUP_READY_NOT_DELETED'and p.get('ids')==list(IDS)and p.get('rootVerifiedTestContacts')is True and p.get('expectedName')==self.expected_name and p.get('expectedComments')==self.expected_comments,'EXACT_PREFLIGHT_REQUIRED');observed=datetime.fromisoformat(p['observedAtUtc']);need(observed.tzinfo is not None and 0<=(self.now()-observed).total_seconds()<=300,'PREFLIGHT_STALE_OR_FUTURE');need(sha(read_private(self.backup))==p['backupSha256'],'PRIVATE_BACKUP_CHANGED');need(self.probe()==p['runtime'],'RUNTIME_CHANGED_BEFORE_APPLY');journal={'schema':1,'phase':'DELETE_STARTED_UNKNOWN_DO_NOT_RETRY','ids':list(IDS),'preflightSha256':pin,'backupSha256':p['backupSha256'],'rootConfirmationInput':confirmation,'counts':p['counts'],'startedAtUtc':self.now().isoformat()};create(self.journal,journal);conn=None;committed=False
  try:
   conn=connect(self.db,True);conn.execute('BEGIN IMMEDIATE');before=state(conn,self.expected_name,self.expected_comments);need(sha(data(before))==p['snapshotSha256'],'EXACT_TARGET_OR_SCHEMA_DRIFT');need(read_private(self.receipt)==raw and sha(read_private(self.backup))==p['backupSha256'],'PRIVATE_INPUT_DRIFT');need(self.probe()==p['runtime'],'LAST_RUNTIME_GUARD_REFUSED');need(read_private(self.receipt)==raw and sha(read_private(self.backup))==p['backupSha256'],'LAST_PRIVATE_INPUT_DRIFT');need(0<=(self.now()-observed).total_seconds()<=300,'PREFLIGHT_STALE_AFTER_LAST_RUNTIME_PROBE');changes=conn.total_changes
   for table in DELETE_TABLES:
    condition='key IN (?,?)'if table=='documents'else'id IN (?,?)'if table=='site_orders'else'order_id IN (?,?)';cursor=conn.execute('DELETE FROM '+quoted(table)+' WHERE '+condition,KEYS if table=='documents'else IDS);need(cursor.rowcount==p['counts'][table],'EXACT_DELETE_COUNT_MISMATCH')
    if fault:fault(table,conn)
   need(conn.total_changes-changes==sum(p['counts'].values()),'UNINTENDED_TRIGGER_OR_CASCADE');need(conn.execute('SELECT COUNT(*) FROM site_orders WHERE id IN (?,?)',IDS).fetchone()[0]==0,'TARGET_ROWS_REMAIN');need(conn.execute('SELECT COUNT(*) FROM site_orders WHERE id NOT IN (?,?)',IDS).fetchone()[0]==p['nonTargetOrderCount'],'OTHER_ORDER_COUNT_CHANGED');need([dict(r)for r in conn.execute("SELECT name,seq FROM sqlite_sequence WHERE name='site_orders'")]==p['siteOrderSequence'],'AUTOINCREMENT_CHANGED');need(read_private(self.receipt)==raw and sha(read_private(self.backup))==p['backupSha256'],'PRIVATE_BACKUP_CHANGED_DURING_DELETE');conn.execute('COMMIT');committed=True;journal.update(phase='ONLY_CONFIRMED_TEST_ORDERS_7_8_DELETED',finishedAtUtc=self.now().isoformat(),deletedOrders=2,deletedRows=sum(p['counts'].values()),otherOrdersUnchanged=True,sequenceUnchanged=True);replace(self.journal,journal);return {'status':journal['phase'],'deletedOrders':2,'deletedCounts':p['counts'],'journalSha256':sha(read_private(self.journal)),'backupSha256':p['backupSha256'],'otherOrdersUnchanged':True,'sequenceUnchanged':True,'runtimeWrites':0,'outboundMessages':0}
  except Exception:
   if conn is not None and conn.in_transaction:conn.execute('ROLLBACK')
   if not committed:
    journal.update(phase='REFUSED_TRANSACTION_ROLLED_BACK_NO_DELETE',finishedAtUtc=self.now().isoformat());replace(self.journal,journal)
   raise
  finally:
   if conn is not None:conn.close()

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('operation',choices=('preflight','apply'));parser.add_argument('--root-verified-test-contacts',action='store_true');parser.add_argument('--expected-name-json',required=True);parser.add_argument('--expected-comments-json',required=True);parser.add_argument('--preflight-sha');parser.add_argument('--confirmation-input');parser.add_argument('--apply',action='store_true');args=parser.parse_args()
 try:
  need(os.name=='posix'and os.geteuid()==0,'NATIVE_ROOT_ONLY');need(args.operation!='preflight'or not args.apply,'PREFLIGHT_NEVER_APPLIES');expected_name=json.loads(args.expected_name_json);expected_comments=json.loads(args.expected_comments_json);cleanup=Cleanup(expected_name=expected_name,expected_comments=expected_comments);result=cleanup.preflight(args.root_verified_test_contacts)if args.operation=='preflight'else cleanup.apply(args.preflight_sha,args.confirmation_input,apply=args.apply);print(json.dumps(result,separators=(',',':')));return 0
 except Exception as error:
  result={'status':'REFUSED_OR_UNKNOWN_CHECK_PRIVATE_JOURNAL_DO_NOT_RETRY','errorClass':type(error).__name__,'code':error.code if isinstance(error,Refused)else'LOCAL_OPERATION_FAILED','messageSha256':sha(str(error).encode()),'automaticRetry':False}
  if isinstance(error,Refused)and error.counts is not None:result['counts']=error.counts
  print(json.dumps(result,separators=(',',':')));return 2
if __name__=='__main__':sys.exit(main())
