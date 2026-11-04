#!/usr/bin/env python3
"""PR479: только MCP documents.js/server.js; приватный канон устанавливается отдельно."""
from pathlib import Path,PurePosixPath
import base64,copy,hashlib,io,json,os,re,shutil,sqlite3,stat,subprocess as sp,sys,time,types,zipfile,zlib
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1');R1=P/'release-475-476-25-r1'
N=P/'release-479-24-r1';PRIOR=P/'release-477-40-r2';PRIOR_B=P/'release-477-40-bootstrap-r2'
PARENT_SOURCE=P/'release477-resume-r2.py';PARENT_SHA='1a758b6c1609bec8e8aa431d6703d2380d334a2936a76c4a27ec1f8f52903cd8'
VERIFY477_SHA='0819c98f90e1e4ada335cc0135eee0d4929627bb76afca2e1b4af28de0272d49'
ACCEPTED='1dc980080a1953d03f7dee50b775f05ed7e9bd7d';BASE='4ed9a32f8b46bc6e7b6bcf470d5d54afcd500b3f'
MERGE479='3742e954fff27849e6ef32bdba327b203e9705a7';HEAD477='18a1d070e34bf696683d65ec7cb2e12596ed5867'
PRIOR_MARKER_SHA='754acb7e29f04ea298ee01c5c8830dc9d45105bf3fd8df8fdba358288b5e064b'
REBIND_RECEIPT_SHA='25a52ac0339364a9fe6c7d5ae15c0e74950cb636156fd73fde11320071985fa5'
REBIND_PROOF_SHA='f09c6bef23363a1ee801d165b785fb356cd8b710f5f42fe31c6b7594894268a4'
REBIND_HELPER_SHA='0ba9c106ac274bb194a55fb4f29052f53df9f94df99cb4b0dd701ef0a7f01dc9'
REBIND_OUTER_SHA='3788ad6c2952bbb6d56543ff97253ad98c77bb8d3f2167503c862c364d515725'
MANIFEST_SHA='82968f0283627206e2c4f3c32304c1d5367a2283b0831d13ec0350fe6d1bafa8'
PACKAGE_SHA='18f14109cdbd559df97c5c97c3fb5ff2b3902900dc014c6e508d323d9a859fa0'
TOOLS_SHA='2aaf399d240f693888d046dc540b5f0086e427b95a2b0d99634530dcb2f29880'
LOCK=Path('/opt/synapse/.palitra-app-release.lock');TARGET='synapse-tasks-mcp-1'
LABEL='synapse.release479.operator';SOURCE_SHA=None;R=None;OWNED={};COUNT=0
PROBE_CODE="process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);"
INDEX_JS=r"""const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
const skip=JSON.parse(process.argv[1]);if(!Array.isArray(skip)||skip.some(x=>typeof x!=='string'||x==='/app'||!x.startsWith('/app/')))throw Error('EXACT_SKIP');
const out=[];function walk(f){if(skip.some(x=>f===x||f.startsWith(x+'/')))return 0;const s=fs.lstatSync(f),row={path:f,mode:s.mode&4095,uid:s.uid,gid:s.gid};let count=0;
if(s.isSymbolicLink()){out.push({...row,type:'symlink',target:fs.readlinkSync(f)});return 1;}
if(s.isDirectory()){for(const name of fs.readdirSync(f).sort())count+=walk(p.join(f,name));if(f==='/app'||count||!skip.some(x=>x.startsWith(f+'/')))out.push({...row,type:'directory'});return count;}
if(!s.isFile())throw Error('NON_REGULAR_RUNTIME');const b=fs.readFileSync(f);out.push({...row,type:'file',bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')});return 1;}
walk('/app');out.sort((a,b)=>a.path.localeCompare(b.path));process.stdout.write(JSON.stringify(out));"""
MAP_PROBE_JS=r"""const fs=require('node:fs'),p=require('node:path'),{loadConfig}=require('/app/server.js'),{readMap}=require('/app/documents.js');
(async()=>{const root=loadConfig().docsDir;let missing=false;for(let q=p.resolve(root);;q=p.dirname(q)){try{const s=fs.lstatSync(q);if(s.isSymbolicLink())throw Error('SYMLINK');}catch(e){if(e.code!=='ENOENT')throw e;}if(p.dirname(q)===q)break;}
try{const s=fs.lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink())throw Error('ROOT');try{fs.lstatSync(p.join(root,'MAP.json'));}catch(e){if(e.code!=='ENOENT')throw e;missing=true;}}catch(e){if(e.code!=='ENOENT')throw e;missing=true;}
if(!missing){console.log(JSON.stringify({verified:true,state:'PENDING_PRIVATE_CANON_PRESENT',private_documents_read:false,session_created:false,full_session_acceptance:false}));return;}
try{await readMap(root);throw Error('EXPECTED_503');}catch(e){if(e.status!==503||e.code!=='MAP_NOT_INSTALLED')throw Error('MISSING_MAP_CONTRACT');}
console.log(JSON.stringify({verified:true,state:'MISSING_MAP_503_VERIFIED',private_documents_read:false,session_created:false,full_session_acceptance:false}));})().catch(()=>{console.error('PR479_MAP_READONLY_PROBE_REFUSED');process.exitCode=1;});"""
COMMENT_JS=r"""const fs=require('node:fs'),{loadConfig,crmClient}=require('/app/server.js');(async()=>{const input=JSON.parse(fs.readFileSync(0,'utf8')),call=crmClient(loadConfig());let offset=0;for(;;){const t=await call('task_get',{task_id:24,comments_limit:20,comments_offset:offset,subtasks_limit:1}),found=t.comments.find(x=>x.text.includes(input.marker));if(found){if(found.author!==input.author||found.text!==input.text)throw Error('MARKER');console.log(JSON.stringify({comment_id:found.id,status:'ALREADY_POSTED'}));return;}offset+=t.comments.length;if(offset>=t.comments_pagination.total)break;if(!t.comments.length)throw Error('PAGE');}const r=await call('task_comment',{task_id:24,author:input.author,text:input.text});if(!Number.isSafeInteger(r.comment?.id))throw Error('COMMENT');console.log(JSON.stringify({comment_id:r.comment.id,status:'POSTED'}));})().catch(()=>{console.error('REPORT_PENDING_INSPECT_BEFORE_RETRY');process.exitCode=1;});"""
class Refusal(Exception):pass
def need(ok,code):
 if not ok:raise Refusal(code)
def sha(data):return hashlib.sha256(data).hexdigest()
def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),default=lambda x:str(x) if isinstance(x,Path) else (_ for _ in ()).throw(TypeError('PRIVATE_JSON_TYPE'))).encode()
def load(path):return json.loads(Path(path).read_bytes())
def filehash(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for block in iter(lambda:f.read(65536),b''):h.update(block)
 return h.hexdigest()
def regular(path,directory=False,protected=False):
 path=Path(path);need(path.is_absolute() and not any(x.is_symlink() for x in [path,*path.parents]),'REGULAR_ABSOLUTE_PATH_REQUIRED')
 s=path.stat();need(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode),'REGULAR_FILE_TYPE_REQUIRED')
 if protected:need(s.st_uid==0 and stat.S_IMODE(s.st_mode)==(0o700 if directory else 0o600) and (directory or s.st_nlink==1),'PRIVATE_PERMISSIONS_REQUIRED')
 return s
def write(path,value,raw=False):
 path=Path(path);need(path.is_relative_to(N) and not path.exists() and not path.is_symlink(),'PRIVATE_OUTPUT_ONCE_SCOPE')
 path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 with path.open('xb') as f:f.write(value if raw else canonical(value)+b'\n');f.flush();os.fsync(f.fileno())
 path.chmod(0o600)
def event(code):
 with (N/'events.redacted.jsonl').open('ab') as f:f.write(canonical({'phase':code,'at':time.time()})+b'\n');f.flush();os.fsync(f.fileno())
 print('PR479_'+code,flush=True)
def source_guard():
 need(re.fullmatch('[0-9a-f]{40}',MERGE479) is not None and MERGE479 not in [ACCEPTED,BASE],'ACTUAL_MERGE479_PIN_PENDING')
 regular(Path(__file__));need(filehash(Path(__file__))==SOURCE_SHA==os.environ.get('SB479_SCRIPT_SHA'),'REVIEWED_ONEFILE_SOURCE_PIN')
 regular(PARENT_SOURCE,protected=True);need(filehash(PARENT_SOURCE)==PARENT_SHA,'FROZEN_PARENT_SOURCE_PIN')
def library():
 global R
 regular(PARENT_SOURCE,protected=True);need(filehash(PARENT_SOURCE)==PARENT_SHA,'FROZEN_PARENT_SOURCE_PIN')
 mod=types.ModuleType('reviewed_477_library_for_479');mod.__file__=str(PARENT_SOURCE)
 exec(compile(PARENT_SOURCE.read_bytes(),str(PARENT_SOURCE),'exec'),mod.__dict__)
 # Импорт только определяет функции; child/apply/constructors/tools не вызываются.
 mod.N=N;mod.B=PRIOR_B;mod.SOURCE_SHA=PARENT_SHA;mod.RUN_NUMBER=30000;R=mod
def run(args,purpose,**kwargs):return R.run(args,purpose,**kwargs).stdout
def lease():
 pid=os.environ.get('SB479_LEASE_PID','');need(pid.isdigit() and int(pid)==os.getppid(),'FRESH_PARENT_LEASE_REQUIRED')
 rows=json.loads(run(['lslocks','--json','-o','PID,PATH,TYPE'],'lease479')).get('locks',[]);same=[x for x in rows if x.get('path')==str(LOCK)]
 need(len(same)==1 and int(same[0]['pid'])==int(pid) and same[0].get('type')=='FLOCK','OWN_FRESH_RELEASE_FLOCK_REQUIRED')
def pins(plan):source_guard();lease();R.pins(plan)
def foreign():
 result={}
 for row in R.running():
  if row['Name']=='/'+TARGET:continue
  item=OWNED.get(row['Name'][1:])
  if item:
   need(row['Image']==item['image'] and row['Config'].get('Labels',{}).get(LABEL)==SOURCE_SHA,'OWN_HELPER_DRIFT');continue
  result[row['Name']]=R.fact(row)
 return result
def stable(plan):
 pins(plan);need(foreign()==plan['foreign_before'],'CRM_CONTENT_OR_OTHER_CONTAINER_CHANGED')
 need(R.checkout_snapshot(set())==plan['checkout_before'],'CHECKOUT_FILES_CHANGED')
def same_target(plan):
 stable(plan);need(R.fact(R.inspect(TARGET))==R.fact(plan['before']),'ORIGINAL_MCP_CHANGED_BEFORE_RELEASE')
def verify_database(plan):
 db=Path(plan['database']);regular(db);c=sqlite3.connect(db.as_uri()+'?mode=ro',uri=True,timeout=15,isolation_level=None)
 try:
  c.execute('PRAGMA query_only=ON');c.execute('BEGIN')
  need(c.execute('PRAGMA integrity_check').fetchall()==[('ok',)] and not c.execute('PRAGMA foreign_key_check').fetchall(),'CRM_INTEGRITY_FK')
  value=R.archive_sqlite_contract(c,plan['archive38'],expected_schema=plan['prior477']['crm_schema_sha256'])
  need(value['metadata_sha256']==plan['prior477']['crm_metadata_sha256'],'CRM_METADATA_CHANGED')
  need(c.execute('SELECT count(*) FROM pragma_table_info(?)',('task_dispatch_agent_runs',)).fetchone()[0]==20,'AGENT477_TWENTY_COLUMNS_REQUIRED')
  for table in ['task_dispatch_agent_runs','task_dispatch_agent_requests','task_dispatch_agent_messages']:
   need(c.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone()[0]==1,'AGENT477_TABLES_REQUIRED')
  return value
 finally:
  if c.in_transaction:c.execute('ROLLBACK')
  c.close()
def prerequisites():
 marker=PRIOR/'final-verified.redacted.json';planpath=PRIOR/'release-plan.private.json';helper=PRIOR/'agent-access-rebind-bootstrap-r1.py';work=PRIOR/'agent-access-rebind-r1'
 for folder in [PRIOR,PRIOR_B,work]:regular(folder,directory=True,protected=True)
 paths=[marker,planpath,helper,work/'receipt.redacted.json',work/'attempt.once',work/'outer-verified.redacted.json']
 for path in paths:regular(path,protected=True)
 for path,digest in [(marker,PRIOR_MARKER_SHA),(work/'receipt.redacted.json',REBIND_RECEIPT_SHA),(work/'outer-verified.redacted.json',REBIND_PROOF_SHA),(helper,REBIND_HELPER_SHA)]:need(filehash(path)==digest,'ACTUAL477_REBIND_RAW_RECEIPT_PIN')
 proof=load(marker);previous=load(planpath);rebind=load(work/'receipt.redacted.json');attempt=load(work/'attempt.once');outer=load(work/'outer-verified.redacted.json')
 need(proof.get('verified') is True and proof.get('approved_head')==HEAD477 and proof.get('merge')==BASE and proof.get('source_sha256')==PARENT_SHA and proof.get('verifier_sha256')==VERIFY477_SHA and proof.get('schema')==10 and proof.get('tools')==19,'ACTUAL_VERIFIED477_R2_REQUIRED')
 for key in ['prior478_preserved','old_typed_rows_before_commit_verified','guards_environment_keys_projects_foreign_preserved','checkout_unchanged']:need(proof.get(key) is True,'PRIOR477_PRESERVATION_REQUIRED')
 need(proof.get('database_restored') is False and proof.get('worker_started') is False and proof.get('agent_mutating_tools_called') is False,'PRIOR477_SCOPE_REQUIRED')
 archive,_=R.archive_receipts();need(proof.get('archive38_receipt_sha256')==R.ARCHIVE38_RECEIPT_SHA and proof.get('archive38_schema_metadata_sha256')==R.ARCHIVE38_EXACT_SHA,'PRIOR477_ARCHIVE_RECEIPTS_REQUIRED')
 need(re.fullmatch('[0-9a-f]{64}',proof.get('crm_schema_sha256','')) and proof.get('crm_metadata_sha256')==archive['metadata_sha256'],'PRIOR477_SCHEMA_PIN_REQUIRED')
 R.archive_check_result(proof.get('archive_contract',{}),archive,expected_schema=proof['crm_schema_sha256'])
 need(outer.get('verified') is True and outer.get('approved_head')==HEAD477 and outer.get('schema')==10 and outer.get('tools')==19 and outer.get('owner_id')==1 and outer.get('helper_source_sha256')==REBIND_HELPER_SHA and outer.get('outer_source_sha256')==REBIND_OUTER_SHA and outer.get('marker_sha256')==PRIOR_MARKER_SHA,'ACTUAL_REBIND_R2_OUTER_PROOF_REQUIRED')
 need(outer.get('live_agents_list_verified') is True and outer.get('helper_receipt_requires_live_confirmation') is True and outer.get('helper_receipt_sha256')==REBIND_RECEIPT_SHA,'REBIND_LIVE_CONFIRMATION_REQUIRED')
 ids=rebind.get('selected_ids');need(isinstance(ids,list) and ids and all(type(x) is int and x>0 for x in ids) and len(ids)==len(set(ids)) and 28 not in ids and ids==outer.get('selected_ids')==attempt.get('selected_ids') and outer.get('visible_ids')==sorted(set([*ids,14,28])),'REBIND_SELECTED_IDENTITIES_REQUIRED')
 need(rebind.get('verified') is True and rebind.get('approved_head')==HEAD477 and rebind.get('marker_sha256')==PRIOR_MARKER_SHA and rebind.get('owner_id')==1 and attempt.get('source_sha256')==REBIND_HELPER_SHA and attempt.get('marker_sha256')==PRIOR_MARKER_SHA,'REBIND_SEALED_HELPER_RECEIPT_REQUIRED')
 for value in [rebind,outer]:
  for key in ['schema_and_other_tables_preserved','names_ids_metadata_history_sessions_preserved','agent28_unchanged','token_permissions_environment_unchanged','archive_schema_preserved']:need(value.get(key) is True,'REBIND_SCOPE_PRESERVATION_REQUIRED')
  need(value.get('restarts')==0 and value.get('agent_report_called') is False and value.get('archive38_receipt_sha256')==R.ARCHIVE38_RECEIPT_SHA and value.get('archive38_schema_metadata_sha256')==R.ARCHIVE38_EXACT_SHA,'REBIND_ARCHIVE_AND_NO_RESTART_REQUIRED')
 need(rebind.get('crm_schema_sha256')==proof['crm_schema_sha256'] and rebind.get('crm_metadata_sha256')==proof['crm_metadata_sha256'] and outer.get('agent_launch_or_worker_called') is False,'REBIND_POST477_CONTINUITY_REQUIRED')
 for filename,key in [('before.sqlite','backup_sha256'),('after.sqlite','after_backup_sha256')]:
  path=work/filename;regular(path,protected=True);need(filehash(path)==rebind[key],'REBIND_PROTECTED_BACKUP_PIN');paths.append(path)
 rows={row['Name']:row for row in R.running()};need(all('/synapse-'+s+'-1' in rows for s in ['crm','content','tasks-mcp']),'THREE_SERVICES_REQUIRED')
 crm=rows['/synapse-crm-1'];content=rows['/synapse-content-1'];mcp=rows['/'+TARGET]
 need(R.matching_fact(crm,proof['crm']) and R.matching_fact(mcp,proof['mcp']) and R.fact(content)==previous['content_before'],'ACTUAL_VERIFIED_SERVICE_FACTS_CHANGED')
 for row in [crm,content,mcp]:
  need(row['State']['Running'] and row['RestartCount']==0 and row['Config'].get('Labels',{}).get('com.docker.compose.project')=='synapse','SERVICE_IDENTITY_REQUIRED');R.flags(row)
 r1path=R1/'pr476/prepared-plan.json';regular(r1path,protected=True);r1=load(r1path);canonical_env=R1/'.env';regular(canonical_env,protected=True)
 original=r1.get('compose_command');R.verify_prefix(original)
 need(r1.get('canonical_environment_file')==str(canonical_env) and original[-4:]==['--env-file',str(canonical_env),'-f',str(R1/'pr476/candidate.json')],'CANONICAL_R1476_RECIPE_REQUIRED')
 historical=['/opt/synapse/releases/palitra-customer-content-durable-20261030-r7/content-image-only.json','/opt/synapse/releases/palitra-auth-chat-production-20261031-r7/content-image-only.json']
 expected_common=original+sum((['-f',x] for x in historical),[])+['-f',str(P/'release-478-35-r5/candidate.json')]
 need(previous.get('common')==expected_common,'FULL_477_BASE_RECIPE_REQUIRED');command=previous.get('command');R.verify_prefix(command)
 need(command==expected_common+['-f',str(P/'release-477-40-r1/candidate.json')] and command==previous.get('reuse_old_plan',{}).get('command'),'FULL_VERIFIED_N2_PREPARED_RECIPE_REQUIRED')
 files=[command[i+1] for i,v in enumerate(command[:-1]) if v in ['-f','--file']];envfiles=[command[i+1] for i,v in enumerate(command[:-1]) if v=='--env-file']
 need(envfiles and envfiles[-1]==str(canonical_env),'CANONICAL_ENV_MUST_BE_LAST')
 for row in [crm,content,mcp]:
  context=R.compose_context(row);need(R.subsequence(context['config_files'],files) and R.subsequence(context['environment_files'],envfiles),'CURRENT_CONTEXT_COVERAGE_REQUIRED')
 envpath=Path(r1['child_environment_file']);regular(envpath,protected=True);R.GLOBAL_ENV=load(envpath)
 need(isinstance(R.GLOBAL_ENV,dict) and all(isinstance(k,str) and isinstance(v,str) for k,v in R.GLOBAL_ENV.items()) and not any(k.startswith(('TASKS_','SB472_','SB477_','SB479_','COMPOSE_','PEOPLE_','VAPID_')) for k in R.GLOBAL_ENV),'CLEAN_CANONICAL_COMPOSE_CHILD_ENV_REQUIRED')
 db=R.db_host_path(crm,'crm');need(db['container_path']=='/data/crm.sqlite' and Path(db['host_path']).name=='crm.sqlite' and db['host_path']==previous['databases']['crm'],'EXACT_VERIFIED_CRM_DATABASE_REQUIRED')
 database=Path(db['host_path']);regular(database);need(shutil.disk_usage(database.parent).free>max(2*1024**3,database.stat().st_size*4),'BACKUP_DISK_SPACE')
 docs=R.env_map(mcp).get('TASKS_MCP_DOCS_DIR') or '/app/docs/handoff';need(docs.startswith('/') and '..' not in PurePosixPath(docs).parts and docs not in ['/','/app'],'BOUNDED_DOCS_SKIP_REQUIRED')
 inputs=copy.deepcopy(previous['input_pins'])
 for path,digest in previous['input_pins'].items():regular(path);need(filehash(path)==digest,'PRIOR477_PINNED_INPUT_CHANGED')
 for path in [*paths,PARENT_SOURCE,Path(__file__),r1path,envpath,canonical_env,*map(Path,files+envfiles)]:regular(path);inputs[str(path)]=filehash(path)
 plan={'before':mcp,'crm_before':R.fact(crm),'content_before':R.fact(content),'foreign_before':foreign(),'guards':previous['guards'],'input_pins':inputs,'database':database,'common':command,'checkout_before':R.checkout_snapshot(set()),'prior477':proof,'prior477_marker_sha256':PRIOR_MARKER_SHA,'rebind_outer_sha256':REBIND_PROOF_SHA,'rebind_helper_receipt_sha256':REBIND_RECEIPT_SHA,'archive38':archive,'docs_skip':[docs] if docs.startswith('/app/') else [],'selected_ids':ids}
 stable(plan);verify_database(plan)
 archive_live=json.loads(run(['docker','exec','synapse-crm-1','node','-e',R.ARCHIVE_CONTRACT_JS],'archive38-readonly-preflight'));R.archive_check_result(archive_live,archive,expected_schema=proof['crm_schema_sha256'])
 write(N/'prerequisites.redacted.json',{'verified':True,'actual477_marker_sha256':PRIOR_MARKER_SHA,'actual_rebind_outer_sha256':REBIND_PROOF_SHA,'actual_rebind_helper_receipt_sha256':REBIND_RECEIPT_SHA,'archive38_receipt_sha256':R.ARCHIVE38_RECEIPT_SHA,'schema':10,'tools':19,'private_canon_installed_by_this_release':False,'secretValue':'REDACTED'})
 event('VERIFIED477_REBIND_ARCHIVE_AND_CURRENT_BASELINE');return plan
def unpack(plan):
 raw=zlib.decompress(base64.b64decode(PACKAGE_B64));need(sha(raw)==PACKAGE_SHA,'PACKAGE_SOURCE_ZIP_PIN');z=zipfile.ZipFile(io.BytesIO(raw));manifest=z.read('manifest.json');need(sha(manifest)==MANIFEST_SHA,'PACKAGE_MANIFEST_PIN');m=json.loads(manifest)
 names={'manifest.json'}|{v['path'] for v in m['artifacts']};need(set(z.namelist())==names and len(z.namelist())==len(names),'PACKAGE_ENTRY_SET')
 need(m.get('accepted_runtime_head')==ACCEPTED and m.get('public_base')==BASE and m.get('runtime_paths')==['ops/tasks-mcp/documents.js','ops/tasks-mcp/server.js'] and m.get('tools_preserved_sha256')==TOOLS_SHA and m.get('schema_changes')==0 and m.get('dependency_changes')==0 and m.get('private_documents_included') is False,'PACKAGE_SCOPE_ONLY_TWO_MCP_FILES')
 for value in m['artifacts']:need(sha(z.read(value['path']))==value['sha256'] and len(z.read(value['path']))==value['bytes'],'PACKAGE_ARTIFACT_PIN')
 for name in sorted(names):
  need(not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts,'PACKAGE_PATH');write(N/'package479'/name,z.read(name),True)
 plan['input_pins'][str(N/'package479/manifest.json')]=MANIFEST_SHA;return load(N/'package479/runtime-hunks.json')
def backup(plan):
 target=N/'before-build/crm.sqlite';R.backup(plan['database'],target);source=sqlite3.connect(target.as_uri()+'?mode=ro',uri=True);memory=sqlite3.connect(':memory:')
 try:source.backup(memory);need(memory.execute('PRAGMA integrity_check').fetchall()==[('ok',)] and not memory.execute('PRAGMA foreign_key_check').fetchall(),'BACKUP_RESTORE_INTEGRITY_FK')
 finally:source.close();memory.close()
 write(N/'before-build/proof.redacted.json',{'verified':True,'sha256':filehash(target),'integrity_ok':True,'foreign_key_violations':0,'restore_to_memory_verified':True,'schema':10,'database_restored':False});event('CRM_ONLINE_BACKUP_BEFORE_BUILD_VERIFIED')
def helper(image,args,purpose,extra=(),mounts=(),keep=False):
 global COUNT
 COUNT+=1;name='sb479-r1-'+purpose+'-'+str(COUNT);need(R.inspect(name,True) is None,'OWN_HELPER_EXISTS');OWNED[name]={'image':image,'args':list(args),'id':None,'probe':False}
 command=['docker','run','--name',name,'--label',LABEL+'='+SOURCE_SHA,'--network','none']
 if not keep:command+=['--rm']
 for value in mounts:command+=['--mount',value]
 command+=list(extra)+['--entrypoint','node',image]+list(args);return run(command,purpose,timeout=300),name
def remove_owned(name):
 row=R.inspect(name,True)
 if row is None:return
 item=OWNED[name];need(row['Name']=='/'+name and row['Image']==item['image'] and row['Config'].get('Labels',{}).get(LABEL)==SOURCE_SHA and row['Config'].get('Entrypoint')==['node'] and row['Config'].get('Cmd')==item['args'],'OWN_HELPER_IDENTITY_PROCESS_REQUIRED')
 if item.get('id'):need(row['Id']==item['id'],'OWN_HELPER_ID_CHANGED')
 if row['State']['Running']:run(['docker','stop','--time','1',row['Id']],'stop-owned-node-helper',timeout=15);row=R.inspect(name,True)
 if row:need(not row['State']['Running'],'OWN_HELPER_STILL_RUNNING');run(['docker','rm',row['Id']],'rm-owned-node-helper')
def cleanup():
 for name in list(OWNED):remove_owned(name)
def capture(plan,rules):
 same_target(plan);row=plan['before'];parent=R.image(row['Image']);need(parent['Config'].get('WorkingDir')=='/app' and (not parent['Config'].get('Healthcheck') or parent['Config']['Healthcheck'].get('Test')==['NONE']),'APP_IMAGE_WITHOUT_HOOKS_REQUIRED')
 skip=json.dumps(plan['docs_skip']);live=json.loads(run(['docker','exec',row['Id'],'node','-e',INDEX_JS,skip],'active-full-code-index'));raw,_=helper(parent['Id'],['-e',INDEX_JS,skip],'parent-full-code-index');base=json.loads(raw);need(live and live==base,'ACTIVE_IMAGE_RUNTIME_OR_DEPENDENCY_DRIFT')
 changed=run(['docker','diff',row['Id']],'active-container-diff').decode().splitlines()
 for line in changed:
  if ' ' not in line:continue
  path=line.split(' ',1)[1]
  if path=='/app' or path.startswith('/app/'):
   if any(path==s or path.startswith(s+'/') for s in plan['docs_skip']):continue
   # Полный индекс выше исключил изменения файлов; допускаются только mount-ancestor каталоги.
   run(['docker','exec',row['Id'],'node','-e',"const f=require('node:fs'),s=f.lstatSync(process.argv[1]);if(!s.isDirectory()||s.isSymbolicLink())throw Error('UNBAKED_APP');",path],'active-directory-only')
 index={v['path']:v for v in base};need(index.get('/app/tools.js',{}).get('sha256')==TOOLS_SHA,'NINETEEN_TOOL_BYTES_REQUIRED')
 need(rules.get('public_base')==BASE and rules.get('accepted_runtime_head')==ACCEPTED and len(rules.get('files',[]))==2,'TWO_RUNTIME_HUNK_RULES_REQUIRED');sources={}
 for rule in rules['files']:
  target=rule['target'];need(target in ['/app/documents.js','/app/server.js'],'SOURCE_TARGET_SCOPE');meta=index[target];need(meta['type']=='file' and meta['mode']==0o644 and meta['uid']==0 and meta['gid']==0,'SOURCE_REGULAR_ROOT_MODE_REQUIRED')
  need(not any(Path(v['Destination'])==Path(target) or Path(v['Destination']) in Path(target).parents for v in row['Mounts']),'SOURCE_MASKED_BY_MOUNT')
  before=run(['docker','exec',row['Id'],'cat',target],'active-target-source');need(sha(before)==meta['sha256'],'INDEX_SOURCE_SHA_DRIFT');after=before.decode();edits=[]
  for edit in rule['edits']:
   a,c=edit['before'],edit['after'];need(sha(a.encode())==edit['before_sha256'] and sha(c.encode())==edit['after_sha256'] and after.count(a)==1 and after.count(c)==0,'ACTUAL_UNIQUE_PUBLIC_HUNK_REQUIRED');after=after.replace(a,c,1);edits.append((a,c))
  reverse=after
  for a,c in reversed(edits):need(reverse.count(c)==1,'REVERSE_HUNK_AMBIGUOUS');reverse=reverse.replace(c,a,1)
  need(reverse.encode()==before,'HUNK_ROUNDTRIP_REQUIRED');path=N/'source'/Path(target).name;write(path,after.encode(),True);write(N/'source-before'/Path(target).name,before,True)
  sources[target]={'source':str(path),'before_sha256':sha(before),'after_sha256':sha(after.encode()),'bytes':len(after.encode())};plan['input_pins'][str(path)]=filehash(path)
 need(set(sources)=={'/app/documents.js','/app/server.js'},'EXACT_TWO_RUNTIME_SOURCES');plan.update(parent_image=parent['Id'],parent_index=base,sources=sources)
 write(N/'source-plan.private.json',sources);plan['input_pins'][str(N/'source-plan.private.json')]=filehash(N/'source-plan.private.json');same_target(plan);return sources
def build(plan):
 same_target(plan);base_tag='synapse-tasks-mcp:before-pr479-r1';tag='synapse-tasks-mcp:pr479-r1'
 for name in [base_tag,tag]:need(not run(['docker','image','ls','-q','--no-trunc',name],'fresh-image-tag').strip(),'IMAGE_TAG_ALREADY_EXISTS')
 parent=R.image(plan['parent_image']);R.remember_build_secrets(R.GLOBAL_ENV);R.remember_build_secrets(R.env_map(plan['before']))
 dockerfile='FROM '+base_tag+'\nCOPY --chown=0:0 --chmod=0644 documents.js server.js /app/\n';write(N/'source/Dockerfile',dockerfile.encode(),True)
 need(set(x.name for x in (N/'source').iterdir())=={'Dockerfile','documents.js','server.js'},'BUILD_CONTEXT_ONLY_TWO_FILES')
 run(['docker','tag',parent['Id'],base_tag],'tag-local-parent');need(R.image(base_tag)['Id']==parent['Id'],'BASE_TAG_ID_DRIFT');event('MCP_BUILD_START')
 run(['docker','build','--network','none','--pull=false','-t',tag,str(N/'source')],'build-mcp-only',timeout=1200);candidate=R.image(tag)
 need(candidate['Config']==parent['Config'] and candidate['RootFS']['Layers'][:len(parent['RootFS']['Layers'])]==parent['RootFS']['Layers'] and len(candidate['RootFS']['Layers'])>len(parent['RootFS']['Layers']),'MCP_CHILD_CONFIG_LAYERS_CONTRACT')
 need(R.image(base_tag)['Id']==parent['Id'],'LATE_PARENT_TAG_ID_DRIFT');expected={v['path']:v for v in plan['parent_index']}
 for target,item in plan['sources'].items():expected[target]={**expected[target],'bytes':item['bytes'],'sha256':item['after_sha256']}
 raw,_=helper(candidate['Id'],['-e',INDEX_JS,json.dumps(plan['docs_skip'])],'candidate-full-code-index');need({v['path']:v for v in json.loads(raw)}==expected,'MCP_NON_SCOPE_FILES_OR_DEPENDENCIES_CHANGED')
 for target in plan['sources']:helper(candidate['Id'],['--check',target],'candidate-js-syntax')
 same_target(plan);event('MCP_BUILD_AND_FULL_CODE_INDEX_PASS');return candidate['Id']
def prepare_recipe(plan,image):
 common=plan['common'];before=json.loads(run(common+['config','--format','json'],'current-full-config'))
 for service in ['crm','content','tasks-mcp']:need(R.image(before['services'][service]['image'])['Id']==R.inspect('synapse-'+service+'-1')['Image'],'CURRENT_EFFECTIVE_IMAGE_DRIFT')
 overlay=N/'candidate.json';write(overlay,{'services':{'tasks-mcp':{'image':image}}});command=common+['-f',str(overlay)]
 rendered=json.loads(run(command+['config','--format','json'],'candidate-full-config'));expected=copy.deepcopy(before);expected['services']['tasks-mcp']['image']=image
 need(rendered==expected,'ONLY_MCP_IMAGE_MAY_CHANGE');definition=rendered['services']['tasks-mcp'];health=definition.get('healthcheck')
 need((not health or health.get('disable') is True) and not definition.get('post_start') and not definition.get('pre_stop'),'UNPLANNED_COMPOSE_HOOK_OR_HEALTHCHECK')
 rollback=N/'rollback.json';write(rollback,{'services':{'tasks-mcp':{'image':plan['before']['Image']}}});rollback_command=command+['-f',str(rollback)]
 need(json.loads(run(rollback_command+['config','--format','json'],'rollback-full-config'))==before,'MCP_ROLLBACK_CONFIG_DRIFT')
 plan.update(command=command,rollback_command=rollback_command,image=image);plan['input_pins'].update({str(overlay):filehash(overlay),str(rollback):filehash(rollback)})
 name='sb479-r1-node-probe';need(R.inspect(name,True) is None,'OWN_NODE_PROBE_EXISTS');OWNED[name]={'image':image,'args':['-e',PROBE_CODE],'id':None,'probe':True}
 try:
  run(command+['run','--detach','--no-deps','--pull','never','--name',name,'--label',LABEL+'='+SOURCE_SHA,'--entrypoint','node','tasks-mcp','-e',PROBE_CODE],'signal-aware-node-probe')
  row=R.inspect(name);OWNED[name]['id']=row['Id'];old=plan['before'];need(row['Name']=='/'+name and row['State']['Running'] and row['Image']==image and row['Config'].get('Labels',{}).get(LABEL)==SOURCE_SHA,'NODE_PROBE_IDENTITY')
  need(R.env_map(row)==R.env_map(old) and R.mounts(row)==R.mounts(old) and R.network(row)==R.network(old) and row['Config']['User']==old['Config']['User'] and row['Config']['WorkingDir']==old['Config']['WorkingDir'] and row['Config']['Entrypoint']==['node'] and row['Config']['Cmd']==['-e',PROBE_CODE],'NODE_PROBE_ENV_MOUNTS_NETWORK_USER_PROCESS')
 finally:remove_owned(name)
 same_target(plan);write(N/'release-plan.private.json',plan);event('MCP_ONLY_RECIPE_AND_NODE_PROBE_VERIFIED')
def ready():
 code="const c=require('/app/server.js').loadConfig();fetch('http://127.0.0.1:'+c.port+'/health',{signal:AbortSignal.timeout(5000)}).then(async r=>{if(r.status!==200||(await r.json()).status!=='ok')throw Error('HEALTH');console.log('READY');}).catch(()=>{process.exitCode=1;});"
 for _ in range(20):
  result=R.run(['docker','exec',TARGET,'node','-e',code],'mcp-readiness',timeout=15,accepted=(0,1))
  if result.returncode==0 and result.stdout.strip()==b'READY':return
  time.sleep(1)
 raise Refusal('MCP_READINESS_FAILED')
def smoke(plan):
 body=run(['docker','exec','-i',TARGET,'node','-'],'http19-readonly',data=(N/'package479/readonly-smoke.cjs').read_bytes(),timeout=120);value=json.loads(body)
 need(value.get('status')=='PASS' and value.get('tools')==19 and value.get('http_mcp_verified') is True and value.get('agent_mutating_tools_called') is False,'HTTP19_AND_TASK_READ_REQUIRED')
 missing=json.loads(run(['docker','exec',TARGET,'node','-e',MAP_PROBE_JS],'map-missing-readonly',timeout=30))
 need(missing.get('verified') is True and missing.get('state') in ['MISSING_MAP_503_VERIFIED','PENDING_PRIVATE_CANON_PRESENT'] and missing.get('private_documents_read') is False and missing.get('session_created') is False and missing.get('full_session_acceptance') is False,'PRIVATE_CANON_PENDING_CONTRACT')
 verify_database(plan);return missing
def post_report(proof):
 marker='PR479_MCP_CODE_VERIFIED_R1';text=marker+'\n'+canonical(proof).decode();need(len(text.encode())<=10000,'REPORT_SIZE');payload={'marker':marker,'author':'Codex — Выпуск PR479/#24','text':text}
 try:
  receipt=json.loads(run(['docker','exec','-i',TARGET,'node','-e',COMMENT_JS],'task24-report',data=canonical(payload),timeout=120));need(type(receipt.get('comment_id')) is int,'COMMENT_RESULT_UNKNOWN');write(N/'task24-comment.redacted.json',receipt);event('TASK24_REPORTED')
 except BaseException:write(N/'task24-report-pending.redacted.json',{'verified':True,'retry_comment_only':True,'installer_must_not_run_again':True,**payload});event('VERIFIED_COMMENT_PENDING')
def apply(plan):
 up_intent=False
 try:
  same_target(plan);verify_database(plan);event('UP_MCP_ONLY_INTENT');up_intent=True
  run(plan['command']+['up','-d','--no-deps','--no-build','--pull','never','tasks-mcp'],'up-mcp-only',timeout=300)
  R.runtime_contract(R.inspect(TARGET),plan['before'],plan['image']);ready();stable(plan);map_state=smoke(plan);stable(plan);cleanup()
  # Старые workers могут менять бизнес-строки: сверяем schema/metadata/архив и факты контейнеров.
  schema=verify_database(plan)
  proof={'verified':True,'accepted_head':ACCEPTED,'merge':MERGE479,'source_sha256':SOURCE_SHA,'manifest_sha256':MANIFEST_SHA,'prior477_marker_sha256':PRIOR_MARKER_SHA,'prior477_source_sha256':PARENT_SHA,'rebind_outer_receipt_sha256':REBIND_PROOF_SHA,'rebind_helper_receipt_sha256':REBIND_RECEIPT_SHA,'tools':19,'tools_js_preserved_sha256':TOOLS_SHA,'schema':10,'crm_schema_sha256':schema['schema_sha256'],'crm_metadata_sha256':schema['metadata_sha256'],'archive38_receipt_sha256':R.ARCHIVE38_RECEIPT_SHA,'archive38_schema_metadata_sha256':R.ARCHIVE38_EXACT_SHA,'archive_contract':schema,'mcp':R.fact(R.inspect(TARGET)),'crm':plan['crm_before'],'content':plan['content_before'],'crm_content_and_other_container_facts_preserved':True,'only_mcp_recreated':True,'database_restored':False,'production_ddl_executed':False,'private_documents_installed':False,'private_documents_read':False,'map_probe':map_state,'full_session_acceptance':'PENDING_PRIVATE_CANON','session_created':False,'agent_mutating_tools_called':False,'worker_started':False,'keys_projects_rights_environment_preserved':True,'secretValue':'REDACTED'}
  write(N/'final-verified.redacted.json',proof);event('NATIVE_MCP_CODE_RELEASE_VERIFIED')
 except BaseException as error:
  code=str(error) if isinstance(error,(Refusal,R.Refusal)) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'PRIVATE_JOURNAL_INSPECTION_REQUIRED'
  write(N/'failure.redacted.json',{'code':code,'mcp_up_intent':up_intent,'crm_content_restart_intent':False,'production_ddl_intent':False,'database_restore':False,'no_blind_retry':True});event('FAILURE_INSPECT_ONLY');cleanup();stable(plan);verify_database(plan)
  if up_intent:
   row=R.inspect(TARGET,True)
   if row:need(row['Image'] in [plan['before']['Image'],plan['image']] and R.normalized_config(row)==R.normalized_config(plan['before']) and R.mounts(row)==R.mounts(plan['before']) and R.network(row)==R.network(plan['before']) and R.normalized_host_config(row)==R.normalized_host_config(plan['before']),'UNKNOWN_MCP_STATE_MANUAL_INSPECTION')
   pins(plan);event('ROLLBACK_MCP_CODE_ONLY_INTENT');run(plan['rollback_command']+['up','-d','--no-deps','--no-build','--pull','never','tasks-mcp'],'rollback-mcp-only',timeout=300)
   R.runtime_contract(R.inspect(TARGET),plan['before'],plan['before']['Image']);ready();stable(plan);verify_database(plan)
   write(N/'rollback.redacted.json',{'verified':True,'only_mcp_code_rollback':True,'crm_content_untouched':True,'database_restored':False,'forward_business_data_preserved':True});event('MCP_CODE_ROLLBACK_VERIFIED')
  else:need(R.fact(R.inspect(TARGET))==R.fact(plan['before']),'PREMUTATION_ORIGINAL_MCP_CHANGED')
  raise
 post_report(proof)
def child():
 global SOURCE_SHA
 os.umask(0o077);need(sys.platform.startswith('linux') and os.geteuid()==0,'LINUX_ROOT_REQUIRED');SOURCE_SHA=filehash(Path(__file__));source_guard()
 need(sp.check_output(['hostname']).decode().strip()=='msk-1-vm-tgnt','HOSTNAME_MISMATCH');regular(P,directory=True,protected=True);need((P/'.gitignore').read_bytes().strip()==b'*','PRIVATE_PARENT_IGNORE_REQUIRED')
 need(not N.exists() and not N.is_symlink(),'PREVIOUS_ATTEMPT_INSPECT_ONLY');N.mkdir(mode=0o700);write(N/'attempt.once.json',{'source_sha256':SOURCE_SHA,'accepted_head':ACCEPTED,'merge':MERGE479,'at':time.time()})
 library();lease();plan=prerequisites();rules=unpack(plan);backup(plan);same_target(plan)
 try:capture(plan,rules);image=build(plan);prepare_recipe(plan,image)
 except BaseException:cleanup();raise
 apply(plan)
def parent():
 global SOURCE_SHA
 need(sys.platform.startswith('linux') and os.geteuid()==0,'LINUX_ROOT_REQUIRED');SOURCE_SHA=filehash(Path(__file__));source_guard()
 need(not LOCK.is_symlink() and LOCK.parent==Path('/opt/synapse'),'RELEASE_LOCK_PATH_REQUIRED')
 if LOCK.exists():s=LOCK.stat();need(s.st_uid==0 and s.st_nlink==1 and stat.S_ISREG(s.st_mode),'RELEASE_LOCK_FILE_REQUIRED')
 import fcntl
 with LOCK.open('a+b') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise Refusal('OTHER_WRITER_LOCK_HELD') from None
  env=dict(os.environ);env.update(SB479_LEASE_PID=str(os.getpid()),SB477_LEASE_PID=str(os.getpid()));print('PR479_LOCK_ACQUIRED',flush=True)
  try:return sp.run([sys.executable,str(Path(__file__).resolve()),'--lease-child'],env=env).returncode
  finally:fcntl.flock(lock,fcntl.LOCK_UN);print('PR479_LOCK_RELEASED',flush=True)
PACKAGE_B64='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'
if __name__=='__main__':
 try:
  if sys.argv==[sys.argv[0],'--lease-child']:child();sys.exit(0)
  need(sys.argv==[sys.argv[0]],'NO_OPERATOR_ARGUMENTS_EXPECTED');sys.exit(parent())
 except BaseException as error:
  code=str(error) if isinstance(error,Refusal) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'PRIVATE_JOURNAL_INSPECTION_REQUIRED'
  print('PR479_STOP_'+code,flush=True);sys.exit(1)
