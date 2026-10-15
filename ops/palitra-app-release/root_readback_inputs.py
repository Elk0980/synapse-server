"""Readonly native/public observations -> new private proof/input artifacts only.
No deployment, auth/cookie extraction, account/order/message creation, DB writes or retries.
"""
import argparse,hashlib,json,os,re,stat,subprocess,sys,threading,types
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
MANIFEST_SHA='dd82ce11f239823d005a0e05132f92b640776984f01013094d07e07e62c6d812'
FRONTEND_SHA='0fcb4ddc53d52a5c38b3699d99cdba938cc923e4cd8f4f1e0a719b1f9755f86a'
RUNTIME_SHA='a0a35ddd0a96391fb51a5e6601dd76e02a7ef26e175e22eeff187c727898f426'
BOT_HELPER_SHA='6cf71b616ef481c8fbd3e644246454a7e9cec0ea10eff33ed7c3ca70db7fd5c8'
CANDIDATE_SHA='c23c78fd5d86f30a3bd538de3298a0e844e775a63ffad6403581a3f14f7997ea'
ROW_KEYS={'method','origin','path','status','projection','responseSha256','observationId','observedAtUtc'}
GET_JS=r"""'use strict';
const crypto=require('node:crypto');
const entries=[
 {key:'health',url:'http://127.0.0.1:8080/health',origin:'native-content',path:'/health',status:200,limit:4096},
 {key:'crmScript',url:'https://palitra-love.ru/palitra-app/crm-session.js',origin:'https://palitra-love.ru',path:'/palitra-app/crm-session.js',status:200,limit:262144},
 {key:'chatRoute',url:'https://palitra-love.ru/api/customer-chat/session',origin:'https://palitra-love.ru',path:'/api/customer-chat/session',status:405,limit:8192}
];
async function observe(e){
 let status=0;
 try{
  const headers={'accept-encoding':'identity',accept:e.key==='crmScript'?'text/javascript':'application/json'};
  if(e.origin!=='native-content')headers.origin=e.origin;
  const response=await fetch(e.url,{method:'GET',headers,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(12000)});status=response.status;
  if(response.url!==e.url)throw Error('FINAL_URL');
  const declared=response.headers.get('content-length');if(declared&&/^\d+$/.test(declared)&&Number(declared)>e.limit){await response.body?.cancel();throw Error('SIZE');}
  const reader=response.body?.getReader();const parts=[];let count=0;
  if(reader){for(;;){const item=await reader.read();if(item.done)break;count+=item.value.length;if(count>e.limit){await reader.cancel();throw Error('SIZE');}parts.push(Buffer.from(item.value));}}
  const bytes=Buffer.concat(parts);if(status!==e.status)throw Error('STATUS');
  let projection={};
  if(e.key==='chatRoute'){const data=JSON.parse(bytes.toString('utf8'));const allow=response.headers.get('allow');if(data.code!=='METHOD'||allow!=='POST')throw Error('METHOD_SHAPE');projection={code:'METHOD',allow};}
  return {key:e.key,row:{method:'GET',origin:e.origin,path:e.path,status,projection,responseSha256:crypto.createHash('sha256').update(bytes).digest('hex'),observationId:'native-content:'+e.key+':'+crypto.randomUUID(),observedAtUtc:new Date().toISOString()}};
 }catch(error){return {key:e.key,failure:{code:['FINAL_URL','SIZE','STATUS','ACCOUNT_SHAPE','METHOD_SHAPE'].includes(error.message)?error.message:'GET_REFUSED',status}};}
}
Promise.all(entries.map(observe)).then(results=>{const observations={},failures=[];for(const r of results){if(r.failure)failures.push({key:r.key,...r.failure});else observations[r.key]=r.row;}console.log(JSON.stringify({schema:1,observations,failures}));}).catch(()=>{console.log(JSON.stringify({schema:1,observations:{},failures:[{key:'collector',code:'GET_REFUSED',status:0}]}));});
"""
def sha(raw):return hashlib.sha256(raw).hexdigest()
def load_code(path,pin):
 path=Path(path)
 if not path.is_absolute() or '..' in path.parts:raise ValueError('Absolute code path required')
 for p in [*reversed(path.parents),path]:
  st=p.lstat()
  if stat.S_ISLNK(st.st_mode) or getattr(st,'st_file_attributes',0)&0x400:raise ValueError('Code symlink/reparse refused')
 before=path.stat()
 if not stat.S_ISREG(before.st_mode) or not 0<before.st_size<=1024*1024:raise ValueError('Bounded code dependency required')
 raw=path.read_bytes();after=path.stat()
 if sha(raw)!=pin or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):raise ValueError('Frozen code SHA/identity changed')
 module=types.ModuleType(path.stem);module.__file__=str(path);exec(compile(raw,str(path),'exec'),module.__dict__);return module
class Runner:
 def __call__(self,args,input=None):
  # These commands have bounded, selected output by construction. Drain both pipes without retaining raw diagnostics.
  p=subprocess.Popen(args,stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,shell=False);out={}
  def drain(stream,key,limit):
   kept=bytearray();count=0;digest=hashlib.sha256()
   try:
    while True:
     block=stream.read(65536)
     if not block:break
     count+=len(block);digest.update(block)
     if len(kept)<limit:kept.extend(block[:limit-len(kept)])
   finally:stream.close();out[key]=(bytes(kept),count,digest.hexdigest())
  workers=[threading.Thread(target=drain,args=(p.stdout,'stdout',65536),daemon=True),threading.Thread(target=drain,args=(p.stderr,'stderr',4096),daemon=True)]
  for t in workers:t.start()
  if input is not None:
   try:p.stdin.write(input);p.stdin.close()
   except BrokenPipeError:pass
  try:code=p.wait(timeout=60)
  except subprocess.TimeoutExpired:p.kill();p.wait(timeout=10);raise ValueError('NATIVE_READBACK_TIMEOUT_NO_RETRY')
  for t in workers:t.join(timeout=5)
  if set(out)!={'stdout','stderr'} or code or out['stdout'][1]>65536:raise ValueError('NATIVE_READBACK_COMMAND_REFUSED_NO_RETRY')
  return out['stdout'][0]
class Collector:
 def __init__(self,frontend,root=ROOT,runner=None,now=None):self.f=frontend;self.root=frontend.path(root);self.run=runner or Runner();self.now=now or (lambda:datetime.now(timezone.utc));self.frontend=frontend.Frontend(self.run,self.now)
 def basename(self,value):self.f.need(type(value)is str and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,79}',value) is not None and '..' not in value,'Explicit private basename required');return value
 def file(self,name):return self.root/self.basename(name)
 def pin(self,name,pin):
  self.f.need(self.f.hash_ok(pin),'Independent private artifact SHA required');path=self.file(name);raw=self.f.read(path);self.f.need(sha(raw)==pin,'Private artifact SHA changed: '+name);return self.f.obj(raw)
 def owner(self,name,pin):
  row=self.pin(name,pin);self.f.need(set(row)==ROW_KEYS and row['method']=='GET' and row['origin']=='https://synapse.synapsebusiness.ru' and row['path']=='/content/whoami' and row['status']==200 and type(row['projection'])is dict and set(row['projection'])=={'userId','role','companyIds'},'Exact selected owner GET proof required')
  p=row['projection'];self.f.need(type(p['userId'])in (int,str) and str(p['userId'])=='1' and p['role']=='owner' and type(p['companyIds'])is list and 0<len(p['companyIds'])<=50 and len(set(p['companyIds']))==len(p['companyIds']) and all(type(v)is str and re.fullmatch('[a-z0-9-]{1,64}',v) for v in p['companyIds']) and 'palitra-love' in p['companyIds'],'Existing owner/company projection required')
  self.f.need(self.f.hash_ok(row['responseSha256']) and type(row['observationId'])is str and re.fullmatch('[A-Za-z0-9_:/.-]{1,200}',row['observationId']) is not None,'Actual owner response digest/request observation required');self.f.fresh(row['observedAtUtc'],self.now());return row
 def inputs(self):
  f=self.f;buildpath=self.file('native-build-r3.json');activationpath=self.file('activation-r3-journal.json');buildraw=f.read(buildpath);activationraw=f.read(activationpath);build=f.obj(buildraw);activation=f.obj(activationraw)
  f.need(build.get('phase')=='BUILT_NOT_ACTIVATED' and build.get('attemptId')=='root-final-r3' and build.get('workerUnchanged') is True and build.get('mediaUploadsEnabled') is False and build.get('copyCounts')=={'content':39,'worker':0} and activation.get('workerUnchanged') is True and activation.get('workerTargetInstalled') is False and activation.get('mediaUploadsEnabled') is False and activation.get('buildJournalSha256')==sha(buildraw),'Exact completed media-off R3 receipts required')
  decision=activation.get('decisionFile');self.basename(decision);decisionpin=activation.get('decisionSha256');d=self.pin(decision,decisionpin);f.need(d.get('rootApproved') is True and d.get('contentOnlyDecision') is True and d.get('mediaUploadsDisabled') is True and d.get('workerMustRemainRunning') is True and build.get('decisionSha256')==decisionpin and activation.get('botId')==d.get('botId'),'Explicit Root media-off R3 decision binding required')
  x=self.frontend.artifacts(self.root/'bundle-root-final',MANIFEST_SHA,buildpath,sha(buildraw),activationpath,sha(activationraw),self.root/'native-host-activated-candidate.js')
  self.frontend.runtime(x);self.worker(activation,d);return x,buildraw,activationraw,d
 def account(self,name,pin):
  row=self.pin(name,pin);self.f.need(set(row)==ROW_KEYS and row['method']=='GET' and row['origin']=='https://palitra-love.ru' and row['path']=='/api/draft-account/session' and row['status']==200 and type(row['projection'])is dict and set(row['projection'])=={'loggedIn'} and type(row['projection']['loggedIn'])is bool,'Exact Root selected account GET proof required')
  self.f.need(self.f.hash_ok(row['responseSha256']) and type(row['observationId'])is str and re.fullmatch('[A-Za-z0-9_:/.-]{1,200}',row['observationId']) is not None,'Actual account response digest/request observation required');self.f.fresh(row['observedAtUtc'],self.now());return row
 def worker(self,activation,decision):
  actual=self.run(['docker','inspect','--format','{{.Id}}','synapse-chat-1']).decode().strip();self.f.need(re.fullmatch('[0-9a-f]{64}',actual) is not None and actual==decision.get('workerContainerId')==activation.get('workerProof',{}).get('containerId'),'Unchanged actual worker container required')
  expected=decision.get('workerSourceSha256');self.f.need(self.f.hash_ok(expected) and expected==activation.get('workerProof',{}).get('sourceSha256'),'Exact unchanged worker source proof required');source=self.run(['docker','exec','synapse-chat-1','sha256sum','/app/client-bot-bridge.js']).decode().strip();self.f.need(source==expected+'  /app/client-bot-bridge.js','Actual worker source changed')
 def stable_decision(self,x,decision):self.f.need(self.pin(x['activation']['decisionFile'],x['activation']['decisionSha256'])==decision,'Root decision changed during readback')
 def gets(self):
  result=self.f.obj(self.run(['docker','exec','-i','synapse-content-1','node'],input=GET_JS.encode()));self.f.need(set(result)=={'schema','observations','failures'} and result['schema']==1 and type(result['failures'])is list,'Selected GET collector shape required')
  if result['failures']:
   row=result['failures'][0];key=row.get('key') if row.get('key') in ['health','account','crmScript','chatRoute','collector'] else 'unknown';status=row.get('status') if type(row.get('status'))is int and 0<=row['status']<=599 else 0
   raise ValueError('READBACK_GET_FAILED_'+key+'_'+str(status))
  self.f.need(set(result['observations'])=={'health','crmScript','chatRoute'},'Actual fixed readonly GET observations incomplete');return result['observations']
 def bot(self,botid):
  path=self.root/'read-existing-bot-identity.cjs';raw=self.f.read(path);self.f.need(sha(raw)==BOT_HELPER_SHA,'Exact readonly bot helper SHA required');response=self.run(['docker','exec','-i','synapse-content-1','node'],input=raw);value=self.f.obj(response)
  keys={'status','site','companyCode','botKey','configuredUsername','bridgeUsername','botId','bridgeConfirmed','usernameMatches','fresh','checkedAt','dbWrites','network'}
  self.f.need(set(value)==keys and value['status']=='EXISTING_BINDING_READ' and value['site']=='palitra' and value['companyCode']=='palitra-love' and value['botKey']=='palitra' and value['configuredUsername']==value['bridgeUsername']=='palitra_love_orders_bot' and value['botId']==botid and value['bridgeConfirmed'] is True and value['usernameMatches'] is True and value['fresh'] is True and value['dbWrites']==value['network']==0,'Fresh existing bot readonly identity proof required');self.f.fresh(value['checkedAt'],self.now())
  self.f.need(sha(self.f.read(path))==BOT_HELPER_SHA,'Bot helper changed during observation');return {'observedAtUtc':self.now().isoformat().replace('+00:00','Z'),'checkedAtUtc':value['checkedAt'],'botKey':'palitra','username':'palitra_love_orders_bot','botId':botid,'responseSha256':sha(response),'bridgeConfirmed':True,'usernameMatches':True}
 def prepare(self,owner_name,owner_sha,account_name,account_sha,name,apply=False):
  f=self.f;f.need(apply is True,'Explicit Root --apply creates private artifacts only');self.basename(name);owner=self.owner(owner_name,owner_sha);account=self.account(account_name,account_sha);x,buildraw,activationraw,decision=self.inputs();proofname='backend-proof-'+name+'.json';inputsname='frontend-inputs-'+name+'.json';journalname='readback-prep-'+name+'.json'
  outputs=[self.file(n) for n in [proofname,inputsname,journalname]];context=self.file('frontend-'+name);frontjournal=self.file('frontend-journal-'+name+'.json');f.need(all(not p.exists() for p in [*outputs,context,frontjournal]),'New output/context/journal required; inspect previous results, never overwrite')
  rows=self.gets();rows['owner']=owner;rows['account']=account;bot=self.bot(x['activation']['botId']);self.owner(owner_name,owner_sha);self.account(account_name,account_sha);self.frontend.runtime(x);self.frontend.stable(x);self.worker(x['activation'],decision);self.stable_decision(x,decision)
  proof={'schema':1,'status':'ROOT_BACKEND_NATIVE_READBACK','rootApproved':True,'observedAtUtc':self.now().isoformat().replace('+00:00','Z'),'releaseId':x['manifest']['releaseId'],'buildJournalSha256':sha(buildraw),'activationJournalSha256':sha(activationraw),'images':x['images'],'lease':f.LEASE,'dbWrites':0,'externalMessages':0,'apiReadbacks':rows,'existingBotReadback':bot}
  state={'schema':1,'phase':'PRIVATE_READBACK_PREP_STARTED_UNKNOWN','ownerProofFile':owner_name,'ownerProofSha256':owner_sha,'accountProofFile':account_name,'accountProofSha256':account_sha,'dbWritesMeaning':'collector direct SQL/business-data writes only; Root normal browser session/rate handling is separately authorized and is not claimed absent','collectorAccountGets':0,'outputs':[p.name for p in outputs[:2]],'runtimeRestarts':0,'dbWrites':0,'externalMessages':0};f.write_new(outputs[2],f.encoded(state))
  try:
   f.write_new(outputs[0],f.encoded(proof));proofsha=sha(f.read(outputs[0]));self.frontend.check(x,outputs[0],proofsha)
   value={'bundle':str(self.root/'bundle-root-final'),'manifest_sha':MANIFEST_SHA,'build_journal':str(self.file('native-build-r3.json')),'build_journal_sha':sha(buildraw),'activation_journal':str(self.file('activation-r3-journal.json')),'activation_journal_sha':sha(activationraw),'candidate':str(self.root/'native-host-activated-candidate.js'),'backend_proof':str(outputs[0]),'backend_proof_sha':proofsha,'context':str(context),'journal':str(frontjournal)}
   self.owner(owner_name,owner_sha);self.account(account_name,account_sha);self.frontend.stable(x);self.stable_decision(x,decision);f.write_new(outputs[1],f.encoded(value));state.update(phase='PRIVATE_READBACK_PROOF_AND_INPUTS_READY',proofSha256=proofsha,inputsSha256=sha(f.read(outputs[1])));f.replace_json(outputs[2],state)
   return {'status':state['phase'],'proofFile':proofname,'proofSha256':proofsha,'inputsFile':inputsname,'inputsSha256':state['inputsSha256'],'journalFile':journalname,'observedAtUtc':proof['observedAtUtc'],'runtimeRestarts':0,'dbWrites':0,'externalMessages':0,'publicReady':False}
  except BaseException:
   state['phase']='PRIVATE_READBACK_PREP_FAILED_INSPECT_ARTIFACTS';f.replace_json(outputs[2],state);raise
 def runtime_inputs(self,frontend_inputs,frontend_inputs_sha,name,apply=False,runtime=None,core=None):
  f=self.f;f.need(apply is True,'Explicit Root --apply creates private artifact only');self.basename(name);values=self.pin(frontend_inputs,frontend_inputs_sha);required={'bundle','manifest_sha','build_journal','build_journal_sha','activation_journal','activation_journal_sha','candidate','backend_proof','backend_proof_sha','context','journal'};f.need(set(values)==required,'Exact earlier frontend inputs required')
  for key in ['build_journal','activation_journal','backend_proof','journal']:f.need(Path(values[key]).parent==self.root,'Private frontend paths escaped Root release')
  x,buildraw,activationraw,decision=self.inputs();f.need(values['build_journal_sha']==sha(buildraw) and values['activation_journal_sha']==sha(activationraw),'Earlier frontend inputs do not bind current R3 receipts')
  frontendpath=Path(values['journal']);raw=f.read(frontendpath);front=f.obj(raw);f.need(front.get('phase')=='FRONTEND_CODE_READY_IMAGE_NOT_ACTIVATED' and front.get('backendProofSha256')==values['backend_proof_sha'],'Completed original frontend code/proof binding required')
  value={'backendReceipt':'activation-r3-journal.json','backendReceiptSha256':sha(activationraw),'frontendReceipt':frontendpath.name,'frontendReceiptSha256':sha(raw),'backendProof':Path(values['backend_proof']).name}
  if runtime is None:runtime=load_code(self.root/'frontend_runtime.py',RUNTIME_SHA)
  if core is None:core=runtime.load_dependency(self.root/'activate_root.py')
  runtime.Switch(core,self.root,self.run,self.now).check(value);self.pin(frontend_inputs,frontend_inputs_sha);f.need(sha(f.read(frontendpath))==value['frontendReceiptSha256'],'Frontend receipt changed during readonly check');self.worker(x['activation'],decision);self.frontend.stable(x);self.stable_decision(x,decision)
  output=self.file('frontend-runtime-inputs-'+name+'.json');f.write_new(output,f.encoded(value));return {'status':'PRIVATE_FRONTEND_RUNTIME_INPUTS_READY','inputsFile':output.name,'inputsSha256':sha(f.read(output)),'runtimeRestarts':0,'dbWrites':0,'externalMessages':0,'publicReady':False}
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['prepare','runtime-inputs']);p.add_argument('--name',required=True);p.add_argument('--owner-proof');p.add_argument('--owner-sha');p.add_argument('--account-proof');p.add_argument('--account-sha');p.add_argument('--frontend-inputs');p.add_argument('--frontend-inputs-sha');p.add_argument('--apply',action='store_true');a=p.parse_args()
 try:
  if os.name!='posix' or os.geteuid()!=0:raise ValueError('Native Root required')
  frontend=load_code(ROOT/'frontend_activation.py',FRONTEND_SHA);o=Collector(frontend)
  result=o.prepare(a.owner_proof,a.owner_sha,a.account_proof,a.account_sha,a.name,a.apply) if a.operation=='prepare' else o.runtime_inputs(a.frontend_inputs,a.frontend_inputs_sha,a.name,a.apply)
  print(json.dumps(result,separators=(',',':')));return 0
 except Exception as error:print(json.dumps({'status':'REFUSED','reason':str(error),'automaticRetry':False},separators=(',',':')));return 2
if __name__=='__main__':sys.exit(main())
