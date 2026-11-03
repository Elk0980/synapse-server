#!/usr/bin/env python3
"""Однократный preflight R4: два sleep-контейнера, без запуска приложений и DDL."""
from pathlib import Path,PurePosixPath
import copy,hashlib,json,os,re,stat,subprocess as sp,sys,types
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1')
N=P/'release-478-35-r4';B=P/'release-478-35-bootstrap-r4'
W=P/'prepared-478-recipe-probe-r4';LOCK=Path('/opt/synapse/.palitra-app-release.lock')
SOURCE_R4='247f22a6b652ae3c5b4ca1c9e5802f8eb61ba61ff0746b7d1dec546cefa1a9b0'
META_SHA='6f1229e7bf94546b987bdfbc8bb7d34c2581ad555d16b460ab4646e3883fa100'
MANIFEST_SHA='d5b8f1081c11b35e7e7051f8cec1ff68786a2a30ec2a7e51e15ab379899cec54'
HEAD='7cfe5a474a7a59bb7f19afc76e314ae4359a6d15';MERGE='fb598368ba0d05447e04d254bb8fd67807d891fa'
OVERLAYS=['/opt/synapse/releases/palitra-customer-content-durable-20261030-r7/content-image-only.json',
 '/opt/synapse/releases/palitra-auth-chat-production-20261031-r7/content-image-only.json']
MARKER='R478_PREPARED_RECIPE_PROBE_R4';LABEL='synapse.prepared478.recipe-probe'
MODULE=None;ENV=None;SOURCE_SHA=None;PINS={};OWNED={};BEFORE=None;META=None
class Refusal(Exception):pass
def need(value,code):
 if not value:raise Refusal(code)
def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def sha(value):return hashlib.sha256(value).hexdigest()
def load(path):return json.loads(Path(path).read_bytes())
def filehash(path):return sha(Path(path).read_bytes())
def write(path,value):
 need(path.parent==W and not path.exists() and not path.is_symlink(),'PROBE_OUTPUT_ONCE')
 with path.open('xb') as f:f.write(canonical(value)+b'\n');f.flush();os.fsync(f.fileno())
 path.chmod(0o600)
def run(args,data=None,env=None,accepted=(0,),timeout=120):
 try:r=sp.run(args,input=data,capture_output=True,env=ENV if env is None else env,timeout=timeout,cwd='/opt/synapse')
 except sp.TimeoutExpired:raise Refusal('COMMAND_UNKNOWN_INSPECT_ONLY_NO_REPLAY') from None
 need(r.returncode in accepted,'COMMAND_FAILED_INSPECT_ONLY');return r
def image(value):return json.loads(run(['docker','image','inspect',value]).stdout)[0]
def inspect(value):
 rows=json.loads(run(['docker','inspect',value]).stdout);need(len(rows)==1,'ONE_CONTAINER_REQUIRED');return rows[0]
def networks(row):return {key:value['NetworkID'] for key,value in row['NetworkSettings']['Networks'].items()}
def lease():
 rows=json.loads(run(['lslocks','--json','-o','PID,PATH,TYPE']).stdout).get('locks',[])
 same=[r for r in rows if r.get('path')==str(LOCK)]
 need(len(same)==1 and int(same[0]['pid'])==os.getpid() and same[0].get('type')=='FLOCK','OWN_FLOCK_REQUIRED')
def live():
 ids=run(['docker','ps','-q','--no-trunc']).stdout.decode().split()
 return json.loads(run(['docker','inspect',*ids]).stdout) if ids else []
def baseline():
 lease();need(filehash(Path(__file__))==SOURCE_SHA,'PROBE_SOURCE_DRIFT')
 for path,digest in PINS.items():MODULE.regular(path);need(filehash(path)==digest,'INPUT_PIN_DRIFT')
 for path,expected in META['guards'].items():
  info=MODULE.regular(path);need({'sha256':filehash(path),'uid':info.st_uid,'gid':info.st_gid,'mode':stat.S_IMODE(info.st_mode)}==expected,'GUARD_DRIFT')
 for unit in ['synapse-sync.service','synapse-sync.timer']:
  need(run(['systemctl','show',unit,'-p','ActiveState','--value']).stdout.strip()==b'inactive','LEGACY_SYNC_ACTIVE')
 need(run(['systemctl','is-enabled','synapse-sync.timer'],accepted=(0,1,3)).stdout.strip()==b'disabled','SYNC_TIMER_ENABLED')
 need(run(['git','--no-optional-locks','-C','/opt/synapse','rev-parse','HEAD']).stdout.strip()==b'28fbec23b055cd57f793f77dbfe3f1c9d18c2f24','HOST_CHECKOUT_CHANGED')
 rows=[r for r in live() if r['Id'] not in {v['id'] for v in OWNED.values() if v.get('id')}]
 need({r['Id']:MODULE.fact(r) for r in rows}=={r['Id']:MODULE.fact(r) for r in BEFORE},'ORIGINAL_CONTAINERS_CHANGED')
def prefix(command):
 need(command[:2]==['docker','compose'],'COMPOSE_PREFIX')
 need(len(command)%2==0 and all(command[i] in ['--env-file','-f','--file','-p','--project-name','--project-directory','--profile','--ansi','--progress'] for i in range(2,len(command),2)),'COMPOSE_PREFIX_OPTIONS')
def paths(command,flags):return [command[i+1] for i in range(2,len(command),2) if command[i] in flags]
def subseq(a,b):
 it=iter(b);return all(any(y==x for y in it) for x in a)
def image_only(value):
 need(isinstance(value,dict) and set(value)=={'services'} and isinstance(value['services'],dict) and set(value['services'])=={'content'},'EXACT_CONTENT_IMAGE_OVERLAY')
 service=value['services']['content'];need(isinstance(service,dict) and set(service)=={'image'} and isinstance(service['image'],str) and service['image'],'EXACT_CONTENT_IMAGE_OVERLAY')
def cleanup():
 for name,proof in OWNED.items():
  if not proof.get('id') or proof.get('removed'):continue
  row=inspect(proof['id'])
  need(row['Id']==proof['id'] and row['Name']=='/'+name and row['Image']==proof['image'] and row['Config'].get('Labels',{}).get(LABEL)==SOURCE_SHA,'OWN_PROBE_IDENTITY_REQUIRED')
  run(['docker','rm','-f',row['Id']]);proof['removed']=True
def prepare():
 global MODULE,META,BEFORE,ENV
 for folder in [P,N,B]:
  need(not any(p.is_symlink() for p in [folder,*folder.parents]),'SYMLINK_REFUSED')
  info=folder.stat();need(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o700,'PRIVATE_RELEASE_REQUIRED')
 meta_path=B/'meta478.py';need(filehash(meta_path)==META_SHA,'META_SOURCE_PIN')
 MODULE=types.ModuleType('recipe_probe_meta');MODULE.__file__=str(meta_path);exec(compile(meta_path.read_bytes(),str(meta_path),'exec'),MODULE.__dict__)
 MODULE.regular(meta_path,protected=True)
 need(load(B/'bootstrap.attempt.once.json').get('onefile_sha256')==SOURCE_R4,'R4_BOOTSTRAP_PIN')
 attempt=load(N/'attempt.once.json');need(attempt.get('head')==HEAD and attempt.get('merge')==MERGE and attempt.get('onefile_sha256')==SOURCE_R4 and attempt.get('meta_sha256')==META_SHA,'R4_ATTEMPT_PIN')
 seal=load(N/'snapshot.sealed.json');need(seal.get('metadata_only') is True and seal.get('ready') is True and seal.get('files'),'SEALED_METADATA_REQUIRED')
 for name,digest in seal['files'].items():
  need(len(PurePosixPath(name).parts)==1 and name not in ['.','..'],'SEALED_PATH')
  path=N/name;MODULE.regular(path,protected=True);need(filehash(path)==digest,'SEALED_METADATA_CHANGED');PINS[str(path)]=digest
 for name in ['candidate.json','release-plan.private.json','online-trial','cold-raw','cold-trial','actual-post','verified.native.redacted.json','failure.redacted.json']:
  need(not (N/name).exists() and not (N/name).is_symlink(),'R4_APPLICATION_STAGE_REACHED')
 events=[json.loads(line)['phase'] for line in (N/'events.redacted.jsonl').read_bytes().splitlines() if line]
 need([p for p in events if p.startswith('BUILD_')]==['BUILD_CRM_START','BUILD_CRM_PASS','BUILD_CONTENT_START','BUILD_CONTENT_PASS'] and events[-1]=='BUILD_CONTENT_PASS','BOTH_R4_IMAGES_BUILD_PASS_REQUIRED')
 META=load(N/'metadata.redacted.json');BEFORE=load(N/'containers.private.json')
 need(META.get('metadata_only') is True and META.get('script_sha256')==META_SHA and len(META['guards'])==5,'R4_META_CONTRACT')
 PINS.update(META['compose_source_files'])
 plan=load(N/'prepared-plan476.private.json');envpath=Path(plan['child_environment_file']);MODULE.regular(envpath,protected=True);ENV=load(envpath)
 need(isinstance(ENV,dict) and all(isinstance(k,str) and isinstance(v,str) for k,v in ENV.items()) and not any(k.startswith(('TASKS_','SB472_','COMPOSE_','PEOPLE_','VAPID_')) for k in ENV),'CLEAN_CHILD_ENV_REQUIRED')
 for path in [meta_path,N/'snapshot.sealed.json',N/'attempt.once.json',B/'bootstrap.attempt.once.json',N/'events.redacted.jsonl',envpath,N/'source-plan.private.json']:
  MODULE.regular(path,protected=True);PINS[str(path)]=filehash(path)
 manifest=N/'package478/manifest.json';MODULE.regular(manifest,protected=True);need(filehash(manifest)==MANIFEST_SHA,'MANIFEST_PIN');PINS[str(manifest)]=MANIFEST_SHA
 sources=load(N/'source-plan.private.json');need(set(sources)==set(load(manifest)['runtime_paths']) and len(sources)==17,'EXACT_SOURCE17_REQUIRED')
 for path,row in sources.items():
  staged=N/'source'/row['service']/Path(path).name
  need(row['service'] in ['crm','content'] and row['target']=='/app/'+Path(path).name and row['source']==str(staged),'STAGED_SOURCE_LOCATION')
  MODULE.regular(staged,protected=True);need(filehash(staged)==row['after_sha256'],'STAGED_SOURCE_PIN');PINS[str(staged)]=row['after_sha256']
 common=load(N/'compose-contexts.private.json')['pr476_full_recipe'];prefix(common)
 envfiles=paths(common,{'--env-file'});need(envfiles and envfiles[-1]==str(P/'release-475-476-25-r1/.env'),'CANONICAL_R1_ENV_MUST_BE_LAST')
 need(all(path not in paths(common,{'-f','--file'}) for path in OVERLAYS),'OVERLAY_ALREADY_IN_RECIPE')
 for path in OVERLAYS:MODULE.regular(path);image_only(load(path));PINS[path]=filehash(path)
 new=common+sum((['-f',path] for path in OVERLAYS),[]);prefix(new)
 for context in META['contexts'].values():need(subseq(context['config_files'],paths(new,{'-f','--file'})) and subseq(context['environment_files'],envfiles),'ALL_ACTUAL_CONTEXTS_REQUIRED')
 baseline();return common,new,sources
def probe(common,new,sources):
 before=json.loads(run(common+['config','--format','json']).stdout);base=json.loads(run(new+['config','--format','json']).stdout)
 expected=copy.deepcopy(before);expected['services']['content']['image']=base['services']['content']['image']
 need(base==expected and before['services']['content']['image']!=base['services']['content']['image'],'DRY_RENDER_ONLY_CONTENT_IMAGE_DELTA')
 originals={s:next(r for r in BEFORE if r['Name']=='/synapse-'+s+'-1') for s in ['crm','content','tasks-mcp']}
 for service,row in originals.items():need(image(base['services'][service]['image'])['Id']==row['Image'],'NEW_RECIPE_MUST_RESOLVE_CURRENT_IMAGES')
 candidates={};tags={}
 for service in ['crm','content']:
  parent=image(originals[service]['Image']);tag='synapse-'+service+':pr478-20261103-r4';base_tag='synapse-'+service+':pr478-base-20261103-r4';candidate=image(tag)
  need(image(base_tag)['Id']==parent['Id'] and candidate['Id']!=parent['Id'],'PINNED_R4_PARENT_TAG')
  need(candidate['Config']==parent['Config'] and candidate['RootFS']['Layers'][:len(parent['RootFS']['Layers'])]==parent['RootFS']['Layers'] and len(candidate['RootFS']['Layers'])>len(parent['RootFS']['Layers']),'CANDIDATE_PARENT_CONFIG_ROOTFS')
  need(not candidate['Config'].get('Healthcheck') or candidate['Config']['Healthcheck'].get('Test')==['NONE'],'IMAGE_HEALTHCHECK_NEEDS_PLAN')
  candidates[service]=candidate['Id'];tags[tag]=candidate['Id'];tags[base_tag]=parent['Id']
 overlay=W/'probe-candidate.json';write(overlay,{'services':{s:{'image':v} for s,v in candidates.items()}});PINS[str(overlay)]=filehash(overlay)
 command=new+['-f',str(overlay)];rendered=json.loads(run(command+['config','--format','json']).stdout);expected=copy.deepcopy(base)
 for service,value in candidates.items():expected['services'][service]['image']=value
 need(rendered==expected,'PROBE_CONFIG_ONLY_TWO_IMAGES')
 results={}
 try:
  for service in ['crm','content']:
   definition=rendered['services'][service];need(not definition.get('healthcheck') or definition['healthcheck'].get('disable') is True,'SERVICE_HEALTHCHECK_NEEDS_PLAN')
   need(not any(definition.get(key) for key in ['post_start','pre_stop','hooks']),'SERVICE_HOOK_NEEDS_PLAN')
   name='sb478-prepared-recipe-r4-'+service
   need(not run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$']).stdout.strip(),'OWN_PROBE_NAME_ALREADY_EXISTS')
   baseline();OWNED[name]={'image':candidates[service]}
   try:r=run(command+['run','--detach','--no-deps','--pull','never','--name',name,'--label',LABEL+'='+SOURCE_SHA,'--entrypoint','sleep',service,'120'])
   finally:
    found=run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$']).stdout.decode().split()
    if found:
     need(len(found)==1,'OWN_PROBE_NAME_AMBIGUOUS');row=inspect(found[0]);need(row['Name']=='/'+name and row['Image']==candidates[service] and row['Config'].get('Labels',{}).get(LABEL)==SOURCE_SHA,'OWN_PROBE_CAPTURE_IDENTITY');OWNED[name]['id']=row['Id']
   need(OWNED[name].get('id') and r.stdout.decode().strip()==OWNED[name]['id'],'PROBE_CREATE_RESULT_UNKNOWN')
   row=inspect(OWNED[name]['id']);old=originals[service]
   keys=sorted(k for k in set(MODULE.env_map(row))|set(MODULE.env_map(old)) if MODULE.env_map(row).get(k)!=MODULE.env_map(old).get(k))
   results[service]={'environment_equal':not keys,'environment_different_keys':keys,'environment_sha256':sha(canonical(MODULE.env_map(row))), 'expected_environment_sha256':sha(canonical(MODULE.env_map(old)))}
   write(W/(service+'-environment-check.redacted.json'),results[service])
   need(not keys and MODULE.mounts(row)==MODULE.mounts(old) and networks(row)==networks(old),'SLEEP_ENV_MOUNTS_NETWORK_MISMATCH')
   need(row['State']['Running'] and row['Image']==candidates[service] and row['Config']['User']==old['Config']['User'] and row['Config']['WorkingDir']==old['Config']['WorkingDir'] and row['Config']['Entrypoint']==['sleep'] and row['Config']['Cmd']==['120'],'SLEEP_PROCESS_IDENTITY')
   MODULE.flags(row)
   expected_index={x['path']:x for x in load(N/(service+'.runtime-index.private.json'))}
   for source in sources.values():
    if source['service']==service:expected_index[source['target']]={'path':source['target'],'bytes':Path(source['source']).stat().st_size,'sha256':source['after_sha256']}
   observed=json.loads(run(['docker','exec',row['Id'],'node','-e',MODULE.RUNTIME_INDEX_JS]).stdout)
   need({x['path']:x for x in observed}==expected_index,'PREPARED_IMAGE_FULL_RUNTIME_INDEX')
   results[service].update(sleep_verified=True,full_runtime_index_equal=True,user_workdir_image_equal=True)
  for tag,value in tags.items():need(image(tag)['Id']==value,'LATE_IMAGE_TAG_DRIFT')
 finally:cleanup()
 baseline()
 proof={'verified':True,'source_sha256':SOURCE_SHA,'r4_source_sha256':SOURCE_R4,'meta_sha256':META_SHA,'manifest_sha256':MANIFEST_SHA,
  'candidate_ids':candidates,'overlay_paths':OVERLAYS,'common_prefix':new,'input_pins':PINS,'sleep_probe_verified':True,'environment_checks':results,
  'source17_full_runtime_index_verified':True,'original_container_facts_unchanged':True,'input_files_unchanged':True,
  'docker_probe_containers_created':True,'probe_containers_removed':all(p.get('removed') for p in OWNED.values()),'app_services_started':False,'app_restarts':0,'ddl_applied':False,'source_files_unchanged':True,'secretValue':'REDACTED'}
 write(W/'preflight-proof.redacted.json',proof)
 report={k:proof[k] for k in ['verified','source_sha256','r4_source_sha256','meta_sha256','candidate_ids','overlay_paths','sleep_probe_verified','environment_checks','source17_full_runtime_index_verified','original_container_facts_unchanged','input_files_unchanged','docker_probe_containers_created','probe_containers_removed','app_services_started','app_restarts','ddl_applied','source_files_unchanged','secretValue']}
 report.update(proof_path=str(W/'preflight-proof.redacted.json'),proof_sha256=filehash(W/'preflight-proof.redacted.json'),common_prefix_sha256=sha(canonical(new)),input_pins_sha256=sha(canonical(PINS)))
 return report
def publish(report):
 text=MARKER+'\n'+canonical(report).decode();need(len(text.encode())<=9000,'COMPACT_REPORT_LIMIT')
 try:
  result=json.loads(run(['docker','exec','-i','synapse-tasks-mcp-1','node','-e',COMMENT_JS],data=canonical({'marker':MARKER,'text':text})).stdout)
  need(type(result.get('comment_id')) is int,'COMMENT_RESULT_UNKNOWN');write(W/'task35-comment.redacted.json',result);print('R478_RECIPE_PROBE_REPORTED',flush=True)
 except BaseException:
  try:write(W/'report-pending.redacted.json',{'retry_comment_only':True,'marker':MARKER,'text':text})
  except BaseException:pass
  print('R478_RECIPE_PROBE_REPORT_PENDING',flush=True)
def main():
 global SOURCE_SHA
 os.umask(0o077);need(sys.platform.startswith('linux') and os.geteuid()==0 and sys.argv==[sys.argv[0]],'LINUX_ROOT_NO_ARGUMENTS_REQUIRED')
 SOURCE_SHA=filehash(Path(__file__));need(SOURCE_SHA==os.environ.get('SB478_RECIPE_PROBE_SHA'),'REVIEWED_PROBE_SOURCE_REQUIRED')
 need(run(['hostname']).stdout.decode().strip()=='msk-1-vm-tgnt' and not LOCK.is_symlink(),'HOST_AND_LOCK_REQUIRED')
 import fcntl
 with LOCK.open('a+b') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise Refusal('ANOTHER_WRITER_HOLDS_LOCK') from None
  print('R478_RECIPE_PROBE_LOCK_ACQUIRED',flush=True)
  created=False
  try:
   need(not any(path.is_symlink() for path in [P,*P.parents]) and P.is_dir() and P.stat().st_uid==0 and stat.S_IMODE(P.stat().st_mode)==0o700,'PRIVATE_PROBE_PARENT_REQUIRED')
   need(not W.exists() and not W.is_symlink(),'PREVIOUS_PROBE_INSPECT_ONLY_NO_REPLAY');W.mkdir(mode=0o700);created=True
   common,new,sources=prepare();report=probe(common,new,sources)
   print('R478_PREPARED_RECIPE_PROBE_VERIFIED',flush=True)
   publish(report)
  except BaseException as error:
   cleanup();unchanged=False
   if MODULE is not None and META is not None and BEFORE is not None:
    try:baseline();unchanged=True
    except BaseException:pass
   code=str(error) if isinstance(error,Refusal) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'INSPECT_PRIVATE_PROBE_NO_REPLAY'
   if created:
    checks={s:load(W/(s+'-environment-check.redacted.json')) for s in ['crm','content'] if (W/(s+'-environment-check.redacted.json')).is_file()}
    failure={'verified':False,'source_sha256':SOURCE_SHA,'code':code,'environment_checks':checks,'original_container_facts_and_inputs_unchanged':unchanged,'docker_probe_containers_created':any(p.get('id') for p in OWNED.values()),'probe_containers_removed':all(p.get('removed') for p in OWNED.values() if p.get('id')),'app_services_started':False,'app_restarts':0,'ddl_applied':False,'secretValue':'REDACTED'}
    write(W/'failure.redacted.json',failure)
    if MODULE is not None:publish(failure)
   raise
  finally:
   try:cleanup()
   finally:fcntl.flock(lock,fcntl.LOCK_UN);print('R478_RECIPE_PROBE_LOCK_RELEASED',flush=True)
COMMENT_JS="const fs=require('node:fs'),{loadConfig,crmClient}=require('/app/server.js');(async()=>{const i=JSON.parse(fs.readFileSync(0,'utf8')),c=crmClient(loadConfig());let o=0;for(;;){const t=await c('task_get',{task_id:35,comments_limit:20,comments_offset:o,subtasks_limit:1});const f=t.comments.find(x=>x.text.includes(i.marker));if(f){if(f.author!=='Codex — Выпуск PR478/#35'||f.text!==i.text)throw Error('MARKER');console.log(JSON.stringify({comment_id:f.id,status:'ALREADY_POSTED'}));return;}o+=t.comments.length;if(o>=t.comments_pagination.total)break;if(!t.comments.length)throw Error('PAGE');}const r=await c('task_comment',{task_id:35,author:'Codex — Выпуск PR478/#35',text:i.text});if(!Number.isSafeInteger(r.comment?.id))throw Error('COMMENT');console.log(JSON.stringify({comment_id:r.comment.id,status:'POSTED'}));})().catch(()=>{console.error('REPORT_UNKNOWN');process.exitCode=1;});"
if __name__=='__main__':
 try:main()
 except BaseException as error:
  if isinstance(error,SystemExit):raise
  code=str(error) if isinstance(error,Refusal) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'INSPECT_PRIVATE_PROBE_NO_REPLAY'
  print('R478_RECIPE_PROBE_STOP_'+code,flush=True);sys.exit(1)
