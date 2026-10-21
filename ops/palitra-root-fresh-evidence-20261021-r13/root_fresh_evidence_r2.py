import json,hashlib,os,sys,time,types,subprocess,urllib.request,ast,io,contextlib,re
from pathlib import Path
from datetime import datetime,timezone,timedelta
sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
NAMESPACE='palitra-order-cleanup-20261021-r11-21855a98e0e02343ad3ac1c132c525b6'
NONCE='21855a98e0e02343ad3ac1c132c525b6'
CODE=ROOT/(NAMESPACE+'-code')
COPY=ROOT/('palitra-order-cleanup-copy-20261021-r10-'+NONCE)
PINS_SHA='22cba233a6087c36df94a50c068ab9cab095bb3ab4ff55b835f94dd8004a44dd'
REFS={'guardReceipt': {'path': '/opt/synapse/releases/palitra-app-20261015/palitra-clear-orders-guard-20261020-r1-journal.json', 'sha256': '34ce6389ef04a5db158d5b1a27734e2d09c919df28b35a9dad4561af48d42892'}, 'guardDecision': {'path': '/opt/synapse/releases/palitra-app-20261015/palitra-clear-orders-guard-20261020-r1-decision.json', 'sha256': 'e57ab17a927f10629755ac1d22b05f5b4286a859b369d0740c29834fa9428de8'}, 'guardPreflight': {'path': '/opt/synapse/releases/palitra-app-20261015/palitra-clear-orders-guard-20261020-r1-preflight.json', 'sha256': '43fbfab4a8075de2d81b439dc3e6f0a2e11a494c2cab63497e130177c09235c3'}, 'guardAcceptance': {'path': '/opt/synapse/releases/palitra-app-20261015/palitra-clear-orders-guard-20261020-r1-root-acceptance.json', 'sha256': '442975bc079ece34d50cbec60eb3b7f4499bd7885fb96faf463623aa41804fc7'}, 'productTests': {'path': '/opt/synapse/releases/palitra-app-20261015/palitra-order-cleanup-product-tests-20261021-root-r1.json', 'sha256': 'e7227a33bbd8db285d8bb7465c844bf3ed32d7173d4a4cdb3627bd364a5c951e'}}
HUMAN_PATH='/opt/synapse/releases/palitra-app-20261015/palitra-cleanup-human-confirmation-5de119.json'
HUMAN_SHA='13cc8030240f81d790af82f24db6029c636dddfe2788986795b8c8a8f27ce822'
def stamp():return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def load_module(name,path,pin):
 raw=path.read_bytes();assert hashlib.sha256(raw).hexdigest()==pin
 m=types.ModuleType(name);m.__file__=str(path);exec(compile(raw,str(path),'exec'),m.__dict__);return m
def write_new(path,d):
 raw=(json.dumps(d,ensure_ascii=False,sort_keys=True,indent=2)+chr(10)).encode();fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
 assert path.read_bytes()==raw;return {'path':str(path),'sha256':hashlib.sha256(raw).hexdigest()}
def fetched(url,pin):
 with urllib.request.urlopen(url,timeout=30) as f:raw=f.read(200001)
 assert len(raw)<200000 and hashlib.sha256(raw).hexdigest()==pin;return raw
def module(raw,name,file):
 m=types.ModuleType(name);m.__file__=str(file);exec(compile(raw,str(file),'exec'),m.__dict__);return m
def held():
 rows=[x.split(maxsplit=1)for x in subprocess.check_output(['lslocks','-n','-o','pid,path']).decode().splitlines()]
 assert [x for x in rows if len(x)==2 and x[1]=='/opt/synapse/.palitra-app-release.lock']==[['3478554','/opt/synapse/.palitra-app-release.lock']]
 assert Path('/proc/3478554/stat').read_text().rsplit(')',1)[1].split()[19]=='464494349'
assert sys.argv[1:]==['--prepare-root-evidence-not-apply'] and os.geteuid()==os.getegid()==0
held();assert not COPY.exists() and not CODE.exists()
ORIGIN_CODE=ROOT/'palitra-order-cleanup-20261021-r11-5de119ea7e40cd9213adc28a0d6a51ee-code'
L=load_module('root_reviewed_entry',ORIGIN_CODE/'live_entry.py','8e2c81be05deedef8b4ca16c7b396dbd9a5e190fa42b11c65b7d80102365dc92')
L.ADAPTER=load_module('root_reviewed_adapter',ORIGIN_CODE/'runtime_inspector_adapter.py','4c14a6c97d3a4edb02cd5cc238531b2deafadb96ba7c4e34e758e2cdfea1ac5b')
human=json.loads(L.private_read(HUMAN_PATH,HUMAN_SHA))
assert human['answer']=='Да, удалить эти старые записи' and human['confirmedScope']=={'orderIds':list(range(18,29)),'siteChats':11,'legacyChats':1,'messages':49,'businessOutbox':24,'attachments':0} and human['humanReplyExactTimestampKnown'] is False
cp=subprocess.run(['python3','-B',str(ROOT/'palitra-order-cleanup-copy-20261021-r10-code/copy_prepare.py'),'--prepare-copy','--manifest-sha','cc30b814fa4ec3fc9391d6114ee118bd7afe8639d34829db88f8bdebc1b3aaef','--lease-pid','3478554','--lease-start-ticks','464494349','--nonce',NONCE],capture_output=True,timeout=90)
assert cp.returncode==0 and not cp.stderr;copy=json.loads(cp.stdout);assert copy['status']=='COPY_ONLY_NOT_RUNTIME_AUTHORIZATION'
print('ROOT_FRESH_COPY_COMPLETE',flush=True)
stage_raw=fetched('https://raw.githubusercontent.com/Elk0980/synapse-server/33b519c89c563b0f1a0b8649fc527670c7b2fd76/ops/palitra-cleanup-live-20261021-r11-21855a98e0e02343ad3ac1c132c525b6/stage.py','18448086eadd767bce58011c9a2741d7d0bb5b21dadf1815e4e59bd95014e5ea')
S=module(stage_raw,'root_reviewed_fresh_code_stage','<Root-reviewed-code-stage>');prior_argv=list(sys.argv);sys.argv=['stage.py','--stage-code-only','--commit','33b519c89c563b0f1a0b8649fc527670c7b2fd76','--lease-pid','3478554','--lease-start-ticks','464494349']
try:S.main()
finally:sys.argv=prior_argv
pins=json.loads(L.private_read(CODE/'LOCAL_CODE_PINS.json',PINS_SHA))
assert L.private_read(CODE/'live_entry.py','8e2c81be05deedef8b4ca16c7b396dbd9a5e190fa42b11c65b7d80102365dc92')==L.private_read(ORIGIN_CODE/'live_entry.py','8e2c81be05deedef8b4ca16c7b396dbd9a5e190fa42b11c65b7d80102365dc92')

fr=subprocess.run(['python3','-B',str(ROOT/'palitra-clear-readonly260-20261021-r6-code/readonly_entry.py'),'--mode','full','--lease-pid','3478554','--code-pins-sha','7de083ac3cf4b39c352ed7b3c60d35e447480f0ab836915d2c87482ef8125c09'],capture_output=True,timeout=180)
assert fr.returncode==0 and not fr.stderr;full=json.loads(fr.stdout);assert full['fullInspection']is True and full['runtimeAdmission']is False and full['sourceFiles']==240 and full['staticFiles']==43 and full['chainFiles']==49
fullpath=ROOT/(NAMESPACE+'-pre-full.json');fd=os.open(fullpath,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'wb') as f:f.write(fr.stdout);f.flush();os.fsync(f.fileno())
assert fullpath.read_bytes()==fr.stdout
print('ROOT_FRESH_FULL_COMPLETE',flush=True)
proofpins={name:hashlib.sha256(L.private_read(COPY/name)).hexdigest()for name in ['backup-proof.json','preview.json','dryrun.json','COPY_ONLY.json','PREPARED.json']}
compraw=fetched('https://raw.githubusercontent.com/Elk0980/synapse-server/8dc57ea4327497f6b31758268bfb1165c9303f11/ops/palitra-root-action-20261021-r12/compare_private_backups.py','8825e8388ab9bb1a19bb0b555936e81ae5e535bb8068dc5acf1422eeb0f48956');C=module(compraw,'root_reviewed_selected_compare','<Root-reviewed-compare>');buffer=io.StringIO()
with contextlib.redirect_stdout(buffer):C.main(['--compare-private-backups','--fresh-backup-proof',str(COPY/'backup-proof.json'),'--fresh-backup-proof-sha',proofpins['backup-proof.json'],'--lease-pid','3478554','--lease-start-ticks','464494349'])
comparison=json.loads(buffer.getvalue());assert comparison['selectedRowsUnchanged']is True and comparison['schemaUnchanged']is True and comparison['status']=='SELECTED_SCOPE_UNCHANGED_NOT_USER_PROOF_NOT_ADMISSION'
write_new(ROOT/(NAMESPACE+'-selected-comparison.json'),comparison)
preview=json.loads(L.private_read(COPY/'preview.json',proofpins['preview.json']));SCOPE=preview['scopeSha256'];SNAPSHOT=preview['snapshotSha256']
base=fetched('https://raw.githubusercontent.com/Elk0980/synapse-server/984acb68256466146cd1cb96b9b34816ab70aca2/ops/palitra-copy-proof-20261021-r10/copy_disk_proof.py','d148d824876bf36c9eb91c130492de4e6c717d2453f60aa201da37eda5ec6764')
lines=base.decode().splitlines(keepends=True);new=list(lines);values={'NONCE':NONCE,'SCOPE':SCOPE,'PINS':proofpins};changed=[]
for node in ast.parse(base).body:
 if isinstance(node,ast.Assign)and len(node.targets)==1 and isinstance(node.targets[0],ast.Name)and node.targets[0].id in values:
  key=node.targets[0].id;idx=node.lineno-1;assert node.end_lineno==node.lineno and lines[idx].startswith(key+'=');eol='\r\n'if lines[idx].endswith('\r\n')else'\n';new[idx]=key+'='+repr(values[key])+eol;changed.append(idx)
assert len(changed)==3 and all(new[i]==lines[i]for i in range(len(lines))if i not in changed)
D=module(''.join(new).encode(),'root_reviewed_exact_binding_disk_proof','<Root-exact-three-literal-disk-proof>');disk=D.prove(3478554,'464494349')
print('ROOT_SELECTED_AND_DISK_COMPLETE',flush=True)
refs=dict(REFS)
for key,name in [('copyOnlyReceipt','COPY_ONLY.json'),('backupProof','backup-proof.json'),('preview','preview.json'),('dryrun','dryrun.json')]:refs[key]={'path':str(COPY/name),'sha256':proofpins[name]}
refs['runtimeInspection']={'path':str(fullpath),'sha256':hashlib.sha256(fr.stdout).hexdigest()};refs['diskProbe']=disk['diskProof']
d={k:json.loads(L.private_read(x['path'],x['sha256']))for k,x in refs.items()};p=d['preview'];counts=p['targetCounts'];ids=p['targetInternalIds']
assert [x['id']for x in p['orderMap']]==list(range(18,29)) and counts['chat_thread_messages']==39 and counts['client_dialog_messages']==10 and counts['site_order_outbox']==14 and counts['client_bot_outbox']==10
user={'status':'USER_CONFIRMED_PERMANENT_PALITRA_CLEANUP','namespace':NAMESPACE,'nonce':NONCE,'scopeSha256':SCOPE,'snapshotSha256':SNAPSHOT,'guardImage':'sha256:951db09e9e6c4781350bbced7e7a9e4ef099077a368e38a6b1fac40e0a4a6a22','backupSha256':d['backupProof']['backupSha256'],'dryrunSha256':refs['dryrun']['sha256'],'permanentDeleteConfirmed':True,'legacyIncluded':True,'orderIds':[x['id'] for x in p['orderMap']],'threadIds':[x['id'] for x in p['threadMap']],'webMessages':39,'legacyDialogIds':[1],'legacyMessages':10,'businessOutboxIds':{'site':ids['site_order_outbox'],'client':ids['client_bot_outbox']},'uncertainBusinessOutboxIncluded':True,'encryptedPushAuditRetained':True,'previewSha256':refs['preview']['sha256'],'runtimeInspectionSha256':refs['runtimeInspection']['sha256'],'createdAtUtc':stamp(),'humanConfirmation':human,'selectedComparisonFingerprintSha256':comparison['selectedFingerprintSha256']}
d['userApproval']=user
now=datetime.now(timezone.utc);a={'schema':2,'enabled':True,'namespace':NAMESPACE,'site':'palitra','companyCode':'palitra-love','serverId':8936001,'account':'sa133295','entrySha256':'8e2c81be05deedef8b4ca16c7b396dbd9a5e190fa42b11c65b7d80102365dc92','codePinsSha256':PINS_SHA,'engineSha256':'6bd4b9f29ff1ffd4e553750d43df437444b5651485748e1eeca82163c8259861','guardImage':'sha256:951db09e9e6c4781350bbced7e7a9e4ef099077a368e38a6b1fac40e0a4a6a22','scopeSha256':SCOPE,'snapshotSha256':SNAPSHOT,'artifacts':refs,'lease':{'pid':3478554,'startTicks':'464494349','lockPath':str(L.LOCK)},'nonce':NONCE,'issuedAtUtc':now.isoformat().replace('+00:00','Z'),'expiresAtUtc':(now+timedelta(minutes=8)).isoformat().replace('+00:00','Z'),'oneApply':True,'userActionTimeConfirmed':True,'inspectorManifestSha256':pins['inspector']['manifestSha256'],'inspectorAdapterSha256':pins['inspectorAdapterSha256']}
userpath=ROOT/(NAMESPACE+'-user-approval.json');refs['userApproval']={'path':str(userpath),'sha256':hashlib.sha256((json.dumps(user,ensure_ascii=False,sort_keys=True,indent=2)+chr(10)).encode()).hexdigest()}
L.validate_admission(a,pins,time.time());L.validate_evidence(a,pins,d,time.time())
locks=[x.split(maxsplit=1) for x in subprocess.check_output(['lslocks','-n','-o','pid,path']).decode().splitlines()];assert [x for x in locks if len(x)==2 and x[1]==str(L.LOCK)]==[['3478554',str(L.LOCK)]];assert Path('/proc/3478554/stat').read_text().rsplit(')',1)[1].split()[19]=='464494349'
u=write_new(userpath,user);assert u==refs['userApproval'];result=write_new(ROOT/(NAMESPACE+'-admission.json'),a)
print(json.dumps({'status':'ROOT_REVIEWED_PRIVATE_12_EVIDENCE_VALIDATED_ADMISSION_CREATED_NOT_APPLIED','admission':result,'userApproval':u,'diskProbe':refs['diskProbe'],'actualDeletionPerformed':False,'runtimeWrites':0},sort_keys=True))
