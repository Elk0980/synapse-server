#!/usr/bin/env python3
"""Отдельный однократный этап agent_access после фактической проверки PR477.

Публичный source-only установщик: неизменённый проверенный helper встроен ниже.
Не запускает worker, не меняет имена, права, ключи, окружение и контейнеры.
Неизвестный результат требует разбора; повтор всего установщика запрещён.
"""
from pathlib import Path
import base64,hashlib,json,os,re,stat,subprocess as sp,sys,zlib

P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1')
RELEASE=P/'release-477-40-r2'
MARKER=RELEASE/'final-verified.redacted.json'
WORK=RELEASE/'agent-access-rebind-r1'
HELPER=RELEASE/'agent-access-rebind-bootstrap-r1.py'
LOCK=Path('/opt/synapse/.palitra-app-release.lock')
HEAD='18a1d070e34bf696683d65ec7cb2e12596ed5867'
HELPER_SHA='0ba9c106ac274bb194a55fb4f29052f53df9f94df99cb4b0dd701ef0a7f01dc9'
MCP='synapse-tasks-mcp-1'
COMMENT_MARKER='AGENT_ACCESS_REBIND_VERIFIED_R1'
COMMENT_AUTHOR='Codex — Перепривязка agent_access'
ARCHIVE38_RECEIPT_SHA='eda0047fddd7075a1345ea5733bce37b58d7a32672385925340233225f6366b8'
ARCHIVE38_EXACT_SHA='a52816380385f789289df635deb9a6d89de133c7294532691fdc84d130c77736'
SOURCE_SHA=None

class Refusal(Exception):pass

def need(ok,code):
    if not ok:raise Refusal(code)

def sha(value):return hashlib.sha256(value).hexdigest()

def canonical(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()

def regular(path,directory=False,protected=False):
    path=Path(path);need(path.is_absolute(),'ABSOLUTE_PATH_REQUIRED')
    need(not any(item.is_symlink() for item in [path,*path.parents]),'SYMLINK_REFUSED')
    info=path.stat()
    need(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),'FILE_TYPE_REFUSED')
    if protected:
        need(info.st_uid==0 and stat.S_IMODE(info.st_mode)==(0o700 if directory else 0o600),'PRIVATE_PERMISSIONS_REQUIRED')
        if not directory:need(info.st_nlink==1,'PRIVATE_HARDLINK_REFUSED')
    return info

def filehash(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(65536),b''):digest.update(block)
    return digest.hexdigest()

def write_once(path,value,raw=False):
    path=Path(path)
    need(path==HELPER or path.is_relative_to(WORK),'OUTPUT_SCOPE_REFUSED')
    regular(path.parent,directory=True,protected=True)
    need(not path.exists() and not path.is_symlink(),'OUTPUT_ALREADY_EXISTS_INSPECT_ONLY')
    with path.open('xb') as stream:
        stream.write(value if raw else canonical(value)+b'\n');stream.flush();os.fsync(stream.fileno())
    path.chmod(0o600);regular(path,protected=True)
    descriptor=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)

def source_guard():
    regular(Path(__file__).absolute())
    actual=filehash(Path(__file__))
    need(actual==os.environ.get('SB_AGENT_REBIND_SCRIPT_SHA'),'REVIEWED_SOURCE_SHA_REQUIRED')
    need(SOURCE_SHA is None or actual==SOURCE_SHA,'OUTER_SOURCE_CHANGED')
    return actual

def command(args,timeout=120,data=None):
    try:result=sp.run(args,input=data,capture_output=True,timeout=timeout)
    except sp.TimeoutExpired:raise Refusal('COMMAND_RESULT_UNKNOWN_INSPECT_ONLY') from None
    need(result.returncode==0,'COMMAND_FAILED_INSPECT_ONLY')
    return result.stdout

def lease(pid):
    need(type(pid) is int and pid>1 and pid==os.getpid(),'OWN_PARENT_PID_REQUIRED')
    rows=json.loads(command(['lslocks','--json','-o','PID,PATH,TYPE'])).get('locks',[])
    same=[row for row in rows if row.get('path')==str(LOCK)]
    need(len(same)==1 and int(same[0]['pid'])==pid and same[0].get('type')=='FLOCK','OWN_FRESH_FLOCK_REQUIRED')

def prerequisites():
    regular(P,directory=True,protected=True);regular(RELEASE,directory=True,protected=True)
    regular(MARKER,protected=True);raw=MARKER.read_bytes();marker=json.loads(raw)
    need(marker.get('verified') is True and marker.get('approved_head')==HEAD and marker.get('schema')==10 and marker.get('tools')==19,'ACTUAL_PR477_VERIFIED_REQUIRED')
    need(marker.get('archive38_receipt_sha256')==ARCHIVE38_RECEIPT_SHA and marker.get('archive38_schema_metadata_sha256')==ARCHIVE38_EXACT_SHA and re.fullmatch('[0-9a-f]{64}',marker.get('crm_schema_sha256','')),'ACTUAL477_ARCHIVE_CONTINUITY_REQUIRED')
    need((P/'.gitignore').read_bytes().strip()==b'*','PRIVATE_PARENT_IGNORE_REQUIRED')
    return raw

def sealed_receipt(marker_bytes):
    regular(WORK,directory=True,protected=True)
    receipt_path=WORK/'receipt.redacted.json';attempt_path=WORK/'attempt.once'
    regular(receipt_path,protected=True);regular(attempt_path,protected=True)
    raw=receipt_path.read_bytes();receipt=json.loads(raw);attempt=json.loads(attempt_path.read_bytes())
    ids=receipt.get('selected_ids')
    need(isinstance(ids,list) and ids and all(type(value) is int and value>0 for value in ids) and len(ids)==len(set(ids)) and 28 not in ids,'SEALED_SELECTED_IDS_REQUIRED')
    need(receipt.get('verified') is True and receipt.get('approved_head')==HEAD and receipt.get('owner_id')==1 and receipt.get('marker_sha256')==sha(marker_bytes),'SEALED_RECEIPT_CONTRACT')
    need(attempt.get('source_sha256')==HELPER_SHA and attempt.get('approved_head')==HEAD and attempt.get('marker_sha256')==sha(marker_bytes) and attempt.get('owner_id')==1 and attempt.get('selected_ids')==ids,'SEALED_HELPER_SOURCE_AND_IDS_REQUIRED')
    need(receipt.get('old_projects')==attempt.get('old_projects') and receipt.get('new_projects')==attempt.get('new_projects') and receipt.get('old_projects')!=receipt.get('new_projects'),'SEALED_SCOPE_CONTRACT')
    for key in ['schema_and_other_tables_preserved','names_ids_metadata_history_sessions_preserved','agent28_unchanged','token_permissions_environment_unchanged','live_agents_list_confirmation_required']:
        need(receipt.get(key) is True,'SEALED_PRESERVATION_PROOF_REQUIRED')
    marker=json.loads(marker_bytes)
    need(receipt.get('archive38_receipt_sha256')==ARCHIVE38_RECEIPT_SHA and receipt.get('archive38_schema_metadata_sha256')==ARCHIVE38_EXACT_SHA and receipt.get('archive_schema_preserved') is True and receipt.get('crm_schema_sha256')==marker.get('crm_schema_sha256') and receipt.get('crm_metadata_sha256')==marker.get('crm_metadata_sha256'),'SEALED_REBIND_ARCHIVE_CONTINUITY_REQUIRED')
    need(receipt.get('restarts')==0 and receipt.get('agent_report_called') is False,'SEALED_NO_RESTART_OR_REPORT_REQUIRED')
    for filename,key in [('before.sqlite','backup_sha256'),('after.sqlite','after_backup_sha256')]:
        path=WORK/filename;regular(path,protected=True)
        need(isinstance(receipt.get(key),str) and re.fullmatch('[0-9a-f]{64}',receipt[key]) and filehash(path)==receipt[key],'SEALED_BACKUP_HASH_REQUIRED')
    need(MARKER.read_bytes()==marker_bytes and filehash(HELPER)==HELPER_SHA,'POST_HELPER_SOURCE_OR_MARKER_DRIFT')
    return receipt,sha(raw)

def live_read(ids):
    raw=command(['docker','exec','-i',MCP,'node','-e',AGENTS_READ_JS],data=canonical({'selected_ids':ids}))
    result=json.loads(raw);expected=sorted(set([*ids,14,28]))
    need(result.get('verified') is True and result.get('agents_list_read_only') is True and result.get('visible_ids')==expected,'LIVE_AGENTS_LIST_CONFIRMATION_REQUIRED')
    return result

def proof_for(receipt,receipt_sha,marker_bytes,readback):
    return {'verified':True,'approved_head':HEAD,'schema':10,'tools':19,'owner_id':1,
        'selected_ids':receipt['selected_ids'],'helper_source_sha256':HELPER_SHA,'outer_source_sha256':SOURCE_SHA,
        'archive38_receipt_sha256':ARCHIVE38_RECEIPT_SHA,'archive38_schema_metadata_sha256':ARCHIVE38_EXACT_SHA,'archive_schema_preserved':True,'helper_receipt_sha256':receipt_sha,'marker_sha256':sha(marker_bytes),
        'helper_receipt_requires_live_confirmation':receipt['live_agents_list_confirmation_required'],
        'live_agents_list_verified':readback['verified'],'visible_ids':readback['visible_ids'],
        'schema_and_other_tables_preserved':True,'names_ids_metadata_history_sessions_preserved':True,
        'agent28_unchanged':True,'token_permissions_environment_unchanged':True,
        'restarts':0,'agent_report_called':False,'agent_launch_or_worker_called':False,'secretValue':'REDACTED'}

def report(proof):
    text=COMMENT_MARKER+'\n'+canonical(proof).decode()
    need(len(text)<=10000 and len(text.encode())<=10000,'REPORT_SIZE_BOUND')
    payload={'marker':COMMENT_MARKER,'author':COMMENT_AUTHOR,'text':text}
    try:
        value=json.loads(command(['docker','exec','-i',MCP,'node','-e',COMMENT_JS],data=canonical(payload)))
        need(type(value.get('comment_id')) is int and value['comment_id']>0 and value.get('status') in ['POSTED','ALREADY_POSTED'],'COMMENT_RESULT_UNKNOWN')
        write_once(WORK/'task25-comment.redacted.json',value)
        print('AGENT_ACCESS_REBIND_TASK25_REPORTED',flush=True)
    except BaseException:
        try:write_once(WORK/'report-pending.redacted.json',{'verified':True,'retry_comment_only':True,'helper_must_not_run_again':True,'unknown_comment_result':True,**payload,'secretValue':'REDACTED'})
        except BaseException:pass
        print('AGENT_ACCESS_REBIND_REPORT_PENDING',flush=True)

def under_lease(pid):
    source_guard();lease(pid);marker_bytes=prerequisites()
    need(not HELPER.exists() and not HELPER.is_symlink() and not WORK.exists() and not WORK.is_symlink(),'PREVIOUS_ATTEMPT_INSPECT_ONLY_NO_REPLAY')
    helper=zlib.decompress(base64.b64decode(HELPER_B64));need(sha(helper)==HELPER_SHA,'EMBEDDED_HELPER_PIN')
    write_once(HELPER,helper,raw=True)
    source_guard();lease(pid);need(MARKER.read_bytes()==marker_bytes and filehash(HELPER)==HELPER_SHA,'LAST_HELPER_OR_MARKER_DRIFT')
    print('AGENT_ACCESS_REBIND_HELPER_INTENT',flush=True)
    try:result=sp.run([sys.executable,str(HELPER),'--apply','--lease-pid',str(pid)],capture_output=True,timeout=1800)
    except sp.TimeoutExpired:raise Refusal('HELPER_RESULT_UNKNOWN_INSPECT_ONLY_NO_REPLAY') from None
    need(result.returncode==0,'HELPER_FAILED_INSPECT_ONLY_NO_REPLAY')
    receipt,receipt_sha=sealed_receipt(marker_bytes)
    print('AGENT_ACCESS_REBIND_HELPER_VERIFIED',flush=True)
    source_guard();lease(pid);readback=live_read(receipt['selected_ids'])
    source_guard();lease(pid);proof=proof_for(receipt,receipt_sha,marker_bytes,readback)
    write_once(WORK/'outer-verified.redacted.json',proof)
    print('AGENT_ACCESS_REBIND_LIVE_READ_VERIFIED',flush=True)
    report(proof)

def main():
    global SOURCE_SHA
    os.umask(0o077)
    need(sys.platform.startswith('linux') and os.geteuid()==0,'LINUX_ROOT_REQUIRED')
    need(sys.argv==[sys.argv[0]],'NO_OPERATOR_ARGUMENTS_EXPECTED')
    SOURCE_SHA=source_guard()
    need(command(['hostname']).decode().strip()=='msk-1-vm-tgnt','HOSTNAME_MISMATCH')
    regular(LOCK.parent,directory=True);need(not LOCK.is_symlink(),'LOCK_SYMLINK_REFUSED')
    if LOCK.exists():
        info=regular(LOCK);need(info.st_uid==0 and info.st_nlink==1,'LOCK_OWNER_OR_HARDLINK_REFUSED')
    import fcntl
    with LOCK.open('a+b') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise Refusal('OTHER_WRITER_LOCK_HELD') from None
        print('AGENT_ACCESS_REBIND_LOCK_ACQUIRED',flush=True)
        try:under_lease(os.getpid())
        finally:
            fcntl.flock(lock,fcntl.LOCK_UN)
            print('AGENT_ACCESS_REBIND_LOCK_RELEASED',flush=True)

AGENTS_READ_JS=r'''const fs=require('node:fs');
const {loadConfig,crmClient}=require('/app/server.js');
(async()=>{
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  if(!Array.isArray(input.selected_ids)||!input.selected_ids.length||!input.selected_ids.every(Number.isSafeInteger))throw Error('IDS');
  const expected=[...new Set([...input.selected_ids,14,28])].sort((a,b)=>a-b);
  const result=await crmClient(loadConfig())('agents_list',{});
  if(!result||!Array.isArray(result.agents))throw Error('AGENTS');
  const ids=new Set(result.agents.map(row=>row.id));
  if(!expected.every(id=>ids.has(id)))throw Error('MISSING');
  console.log(JSON.stringify({verified:true,agents_list_read_only:true,visible_ids:expected}));
})().catch(()=>{console.error('AGENT_ACCESS_READ_CONFIRMATION_FAILED');process.exitCode=1;});'''

COMMENT_JS=r'''const fs=require('node:fs');
const {loadConfig,crmClient}=require('/app/server.js');
(async()=>{
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  if(input.marker!=='AGENT_ACCESS_REBIND_VERIFIED_R1'||typeof input.author!=='string'||typeof input.text!=='string'||
    !input.text.startsWith(input.marker+'\n')||input.text.length>10000||Buffer.byteLength(input.text)>10000)throw Error('BOUNDS');
  const call=crmClient(loadConfig());let offset=0;
  for(;;){
    const task=await call('task_get',{task_id:25,comments_limit:20,comments_offset:offset,subtasks_limit:1});
    if(!Array.isArray(task.comments)||!Number.isSafeInteger(task.comments_pagination?.total))throw Error('PAGE');
    const found=task.comments.find(row=>typeof row.text==='string'&&row.text.includes(input.marker));
    if(found){
      if(found.author!==input.author||found.text!==input.text)throw Error('MARKER');
      console.log(JSON.stringify({comment_id:found.id,status:'ALREADY_POSTED'}));return;
    }
    offset+=task.comments.length;
    if(offset>=task.comments_pagination.total)break;
    if(!task.comments.length)throw Error('EMPTY_PAGE');
  }
  const result=await call('task_comment',{task_id:25,author:input.author,text:input.text});
  if(!Number.isSafeInteger(result.comment?.id))throw Error('COMMENT');
  console.log(JSON.stringify({comment_id:result.comment.id,status:'POSTED'}));
})().catch(()=>{console.error('AGENT_ACCESS_COMMENT_RESULT_UNKNOWN_READ_BEFORE_RETRY');process.exitCode=1;});'''

HELPER_B64='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'

if __name__=='__main__':
    try:main()
    except BaseException as error:
        if isinstance(error,SystemExit):raise
        code=str(error) if isinstance(error,Refusal) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'INSPECT_PRIVATE_ATTEMPT_NO_REPLAY'
        print('AGENT_ACCESS_REBIND_STOP_'+code,flush=True);sys.exit(1)
