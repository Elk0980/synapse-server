"""Root-only code phase: build exact one-file child and atomically update cabinet.
No runtime restart, Compose, config, DB, HTTP, auth or external messages.
"""
import argparse, hashlib, json, os, re, stat, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

BASE_SHA = 'b6204caab72403a86a41f0535547b6cddf19f990faf50d2f5136070b7ee9d8db'
CANDIDATE_SHA = 'c23c78fd5d86f30a3bd538de3298a0e844e775a63ffad6403581a3f14f7997ea'
CABINET_ROOT = '/opt/synapse/sites/synapse'
RELEASE_ROOT = '/opt/synapse/releases/palitra-app-20261015'
CABINET_REL = 'cabinet/palitra-orders/native-host.js'
RUNTIME_PATH = '/app/palitra-orders-public/native-host.js'
LEASE = {'pid': 2744197, 'path': '/opt/synapse/.palitra-app-release.lock'}
CONTENT = 'synapse-content-1'
CHAT = 'synapse-chat-1'
SELECTED = ['PALITRA_CHECKOUT_ENABLED', 'PALITRA_CRM_ENABLED',
            'PALITRA_CUSTOMER_CHAT_ENABLED', 'PALITRA_WEB_UPLOADS_ENABLED',
            'PALITRA_MAIN_ORIGIN', 'PALITRA_SHOP_ORIGIN',
            'PALITRA_CRM_SYNAPSE_ORIGIN', 'PALITRA_CRM_BOT_ID']
READBACK_KEYS = ('health', 'owner', 'account', 'crmScript', 'chatRoute')
ENV_JS = 'const o={};for(const k of ' + json.dumps(SELECTED) + '){o[k]=process.env[k]===undefined?null:process.env[k]}console.log(JSON.stringify(o));'
FILE_JS = "const f=require('fs'),c=require('crypto'),p=process.argv[1],q=require('path');for(let x=p;x!==q.dirname(x);x=q.dirname(x)){const s=f.lstatSync(x);if(s.isSymbolicLink()||(x!==p&&!s.isDirectory()))process.exit(31)}const fd=f.openSync(p,f.constants.O_RDONLY|(f.constants.O_NOFOLLOW||0));try{const a=f.fstatSync(fd);if(!a.isFile()||a.size>1048576)process.exit(31);const d=f.readFileSync(fd),b=f.fstatSync(fd),s=f.lstatSync(p);if(a.ino!==b.ino||a.dev!==b.dev||a.size!==b.size||a.mtimeMs!==b.mtimeMs||a.ino!==s.ino||a.dev!==s.dev||f.realpathSync(p)!==p||d.length!==a.size)process.exit(31);console.log(c.createHash('sha256').update(d).digest('hex'))}finally{f.closeSync(fd)}"

class Refused(Exception): pass
def need(ok, message):
    if not ok: raise Refused(message)
def sha(raw): return hashlib.sha256(raw).hexdigest()
def hash_ok(value): return type(value) is str and re.fullmatch('[0-9a-f]{64}', value) is not None
def image_ok(value): return type(value) is str and re.fullmatch('sha256:[0-9a-f]{64}', value) is not None
def path(value, missing=False):
    p = Path(value)
    need(p.is_absolute() and '..' not in p.parts, 'Absolute canonical path required')
    for x in [*reversed(p.parents), p]:
        try: s = x.lstat()
        except FileNotFoundError:
            need(missing, 'Required file absent'); continue
        need(not stat.S_ISLNK(s.st_mode) and not (getattr(s, 'st_file_attributes', 0) & 0x400), 'Symlink/reparse refused')
        if x != p: need(stat.S_ISDIR(s.st_mode), 'Ancestor is not a directory')
    return p
def read(value):
    p = path(value); fd = os.open(p, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= 16*1024*1024, 'Bounded regular file required')
        with os.fdopen(fd, 'rb', closefd=False) as f: raw = f.read(16*1024*1024 + 1)
        after = os.fstat(fd); current = p.lstat()
        need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) ==
             (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns), 'File replaced/changed during read')
        need(len(raw) == before.st_size, 'Short source read'); return raw
    finally: os.close(fd)
def obj(raw):
    def pairs(items):
        d = {}
        for k,v in items: need(k not in d, 'Duplicate JSON key'); d[k] = v
        return d
    try: return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs)
    except (ValueError, UnicodeError): raise Refused('Malformed JSON')
def encoded(value): return (json.dumps(value, ensure_ascii=False, indent=2)+'\n').encode()
def write_new(value, raw, mode=0o600):
    p = path(value, True); need(p.parent.is_dir() and not p.exists(), 'Fresh output required; never repeat unknown execution')
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'wb') as f: f.write(raw); f.flush(); os.fsync(f.fileno())
    need(read(p) == raw, 'Private artifact readback failed')
def replace_json(p, value):
    temporary = Path(str(p)+'.pending'); write_new(temporary, encoded(value)); os.replace(temporary, p)
def utc(value):
    need(type(value) is str, 'UTC timestamp required')
    try: d = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError: raise Refused('Invalid UTC timestamp')
    need(d.tzinfo is not None and d.utcoffset().total_seconds() == 0, 'Explicit UTC timestamp required'); return d
def fresh(value, now): need(-30 <= (now-utc(value)).total_seconds() <= 300, 'Native backend proof is stale/future')
def native(args):
    r = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300, shell=False)
    need(r.returncode == 0, 'Native command failed/unknown; inspect journal without retry'); return r.stdout

class Frontend:
    def __init__(self, runner=native, now=None): self.run=runner; self.now=now or (lambda:datetime.now(timezone.utc))
    def lease(self):
        rows = self.run(['lslocks','--noheadings','--output','PID,PATH']).decode().splitlines()
        need(any(row.strip().split(maxsplit=1) == [str(LEASE['pid']),LEASE['path']] for row in rows), 'Root lease absent/changed')
    def image(self, container):
        v=self.run(['docker','inspect','--format','{{.Image}}',container]).decode().strip()
        need(image_ok(v),'Invalid current image'); return v
    def file_hash(self, container):
        v=self.run(['docker','exec',container,'node','-e',FILE_JS,'--',RUNTIME_PATH]).decode().strip()
        need(hash_ok(v),'Invalid fixed runtime file digest'); return v
    def layers(self, image):
        value=obj(self.run(['docker','image','inspect','--format','{{json .RootFS.Layers}}',image]))
        need(type(value)is list and 0<len(value)<=200 and all(image_ok(item) for item in value),'Invalid fixed image layer projection'); return value
    def local_id(self, reference):
        value=self.run(['docker','image','inspect','--format','{{.Id}}',reference]).decode().strip()
        need(image_ok(value),'Invalid local image identity'); return value
    def verify_alias(self, alias, expected, layers):
        need(self.local_id(alias)==expected and self.local_id(expected)==expected,'Local base alias or exact source image changed')
        need(self.layers(alias)==layers and self.layers(expected)==layers,'Local alias does not preserve exact backend layers')
    def artifacts(self, bundle, manifest_sha, build, build_sha, activation, activation_sha, candidate):
        bundle=path(bundle); snapshots={}
        def pinned(p,pin):
            need(hash_ok(pin),'Independent SHA256 required'); raw=read(p); need(sha(raw)==pin,'Artifact SHA mismatch: '+Path(p).name); snapshots[path(p)]=pin; return obj(raw)
        m=pinned(bundle/'manifest.json',manifest_sha); j=pinned(build,build_sha); a=pinned(activation,activation_sha)
        need(m.get('schema')==1 and m.get('status')=='SOURCE_ONLY_NOT_INSTALLED' and m.get('flagsEnabled') is False and m.get('dbWrites') is False,'Original disabled source manifest required')
        need(m.get('lease')==LEASE and m.get('roots',{}).get('cabinet')==CABINET_ROOT and m.get('customerStaticPlacement')=='immutable-content-image:/app/palitra-orders-public','Native roots/lease changed')
        content=[r for r in m['content'] if r['target']=='palitra-orders-public/native-host.js']
        static=[r for r in m['static'] if r['group']=='cabinet' and r['target']==CABINET_REL]
        need(len(content)==len(static)==1 and content[0]['sha256']==static[0]['sha256']==BASE_SHA,'Builder counterpart/source pin mismatch')
        for row in content+static:
            rel=row['payload']; need(type(rel)is str and '\\' not in rel and ':' not in rel and '..' not in rel.split('/') and not rel.startswith('/'),'Unsafe manifest payload')
            p=path(bundle/rel); need(p.resolve().is_relative_to(bundle.resolve()),'Payload escaped bundle')
            need(sha(read(p))==BASE_SHA and m['sourceFiles'][rel]['sha256']==BASE_SHA,'Original payload changed'); snapshots[p]=BASE_SHA
        need(j.get('phase')=='BUILT_NOT_ACTIVATED' and j.get('releaseId')==m['releaseId'] and image_ok(j.get('contentImage')),'Native build journal incomplete')
        worker=j.get('workerImage',m['images']['worker']); need(image_ok(worker),'Expected worker image missing')
        expected={'content':j['contentImage'],'chat':worker}
        need(a.get('phase')=='IMAGES_AND_SELECTED_CONFIG_APPLIED_NOT_BACKEND_PROOF' and a.get('newImages')==expected and a['after']['afterImages']==expected,'Backend activation receipt/image mismatch')
        need(a['after']['lease']==LEASE,'Backend receipt lease mismatch')
        c=path(candidate); raw=read(c); need(sha(raw)==CANDIDATE_SHA,'Exact candidate SHA mismatch'); snapshots[c]=CANDIDATE_SHA
        original=read(bundle/content[0]['payload']); old=b'const FLAGS = Object.freeze({ network: false, crm: false, e1Native: false });'; new=b'const FLAGS = Object.freeze({ network: true, crm: true, e1Native: true });'
        need(original.count(old)==1 and original.replace(old,new,1)==raw,'Candidate includes other changes')
        target=path(Path(m['roots']['cabinet'])/static[0]['target'])
        return {'manifest':m,'build':j,'activation':a,'images':expected,'candidate':raw,'target':target,'snapshots':snapshots,
                'manifestSha256':manifest_sha,'buildSha256':build_sha,'activationSha256':activation_sha}
    def runtime(self, x, expected_file=BASE_SHA):
        self.lease(); before={s:self.image(c) for s,c in [('content',CONTENT),('chat',CHAT)]}; need(before==x['images'],'Live backend images changed')
        meta=obj(self.run(['docker','inspect','--format','{"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}',CONTENT]))
        need(meta.get('running') is True and meta.get('health') in [None,'healthy'],'Backend container is not stable/healthy')
        selected=obj(self.run(['docker','exec',CONTENT,'node','-e',ENV_JS])); need(set(selected)==set(SELECTED),'Unapproved env projection')
        need(selected==x['activation']['after']['selected']['content'],'Backend selected config changed since activation')
        need(selected['PALITRA_CHECKOUT_ENABLED']=='true' and selected['PALITRA_CRM_ENABLED']=='true' and selected['PALITRA_CUSTOMER_CHAT_ENABLED']=='true' and selected['PALITRA_WEB_UPLOADS_ENABLED']!='true' and selected['PALITRA_MAIN_ORIGIN']=='https://palitra-love.ru','Required backend gates/origin not ready')
        need(type(selected['PALITRA_CRM_BOT_ID']) is str and re.fullmatch('[1-9][0-9]{0,19}',selected['PALITRA_CRM_BOT_ID']) is not None,'Verified existing bot ID missing')
        need(selected['PALITRA_CRM_BOT_ID']==x['activation'].get('botId'),'Native configured bot ID differs from Root activation identity')
        need(self.file_hash(CONTENT)==expected_file,'Live immutable frontend BASE changed')
        need({s:self.image(c) for s,c in [('content',CONTENT),('chat',CHAT)]}==before,'Concurrent image change'); self.lease()
        return {'images':before,'selected':selected,'health':meta}
    def proof(self,x, proof, proof_sha):
        raw=read(proof); need(hash_ok(proof_sha) and sha(raw)==proof_sha,'Independent Root backend proof SHA mismatch'); p=obj(raw); x['snapshots'][path(proof)]=proof_sha; now=self.now()
        need(set(p)=={'schema','status','rootApproved','observedAtUtc','releaseId','buildJournalSha256','activationJournalSha256','images','lease','dbWrites','externalMessages','apiReadbacks','existingBotReadback'},'Only selected proof fields allowed; no raw session/credentials')
        need(p.get('schema')==1 and p.get('status')=='ROOT_BACKEND_NATIVE_READBACK' and p.get('rootApproved') is True,'Fresh Root readback artifact required')
        fresh(p.get('observedAtUtc'),now)
        need(p.get('releaseId')==x['manifest']['releaseId'] and p.get('buildJournalSha256')==x['buildSha256'] and p.get('activationJournalSha256')==x['activationSha256'] and p.get('images')==x['images'] and p.get('lease')==LEASE,'Proof does not identify exact active release')
        need(p.get('dbWrites')==0 and p.get('externalMessages')==0 and set(p.get('apiReadbacks',{}))==set(READBACK_KEYS),'Proof scope or readback inventory invalid')
        r=p['apiReadbacks']
        projections={'health':set(),'owner':{'userId','role','companyIds'},'account':{'loggedIn'},'crmScript':set(),'chatRoute':{'code','allow'}}
        for name,row in r.items():
            need(set(row)=={'method','origin','path','status','projection','responseSha256','observationId','observedAtUtc'} and type(row['projection'])is dict and set(row['projection'])==projections[name],'Only safe selected readback fields allowed')
            need(row.get('method')=='GET' and hash_ok(row.get('responseSha256')) and type(row.get('observationId'))is str and re.fullmatch('[A-Za-z0-9_:/.-]{1,200}',row['observationId']) is not None,'Actual GET observation/response digest required')
            fresh(row.get('observedAtUtc'),now)
        need(r['health']['origin']=='native-content' and r['health']['path']=='/health' and r['health']['status']==200,'Actual native health HTTP readback required')
        owner=r['owner']; need(owner['origin']=='https://synapse.synapsebusiness.ru' and owner['path']=='/content/whoami' and owner['status']==200 and str(owner['projection'].get('userId'))=='1' and owner['projection'].get('role')=='owner' and 'palitra-love' in owner['projection'].get('companyIds',[]),'Existing native owner/company role readback required')
        account=r['account']; need(account['origin']=='https://palitra-love.ru' and account['path']=='/api/draft-account/session' and account['status']==200 and type(account['projection'].get('loggedIn'))is bool,'Existing Main account session readback required; guest is allowed')
        script=r['crmScript']; need(script['origin']=='https://palitra-love.ru' and script['path']=='/palitra-app/crm-session.js' and script['status']==200,'Enabled existing CRM script readback required')
        crm_target='palitra-crm/app/public/crm-session.js'; rows=[r for r in x['manifest']['content'] if r['target']==crm_target]
        if rows: need(len(rows)==1,'Duplicate CRM payload'); pin=rows[0]['sha256']
        else:
            rows=[r for r in x['manifest']['capture']['inventory'] if r['target']=='content/'+crm_target]; need(len(rows)==1 and rows[0]['sha256'] is not None,'CRM source readback pin absent'); pin=rows[0]['sha256']
        need(script['responseSha256']==pin,'Served CRM script differs from accepted installed source')
        chat=r['chatRoute']; need(chat['origin']=='https://palitra-love.ru' and chat['path']=='/api/customer-chat/session' and chat['status']==405 and chat['projection'].get('code')=='METHOD' and chat['projection'].get('allow')=='POST','Enabled chat route readonly method guard readback required')
        bot=p.get('existingBotReadback',{}); need(set(bot)=={'observedAtUtc','checkedAtUtc','botKey','username','botId','responseSha256','bridgeConfirmed','usernameMatches'},'Only selected public bot identity fields allowed'); fresh(bot.get('observedAtUtc'),now); fresh(bot.get('checkedAtUtc'),now)
        need(bot.get('botKey')=='palitra' and bot.get('username')=='palitra_love_orders_bot' and str(bot.get('botId'))==x['activation']['botId'] and hash_ok(bot.get('responseSha256')) and bot.get('bridgeConfirmed') is True and bot.get('usernameMatches') is True,'Fresh existing bot identity/bridge readback required')
        return p
    def stable(self,x):
        for p,pin in x['snapshots'].items(): need(sha(read(p))==pin,'Input changed after preflight: '+p.name)
    def check(self,x,proof,proof_sha):
        p=self.proof(x,proof,proof_sha); r=self.runtime(x); need(sha(read(x['target']))==BASE_SHA,'Cabinet static BASE changed'); self.stable(x)
        return {'status':'FRONTEND_CHECK_ONLY','images':r['images'],'candidateSha256':CANDIDATE_SHA,'cabinetTarget':str(x['target']),'backendObservedAtUtc':p['observedAtUtc'],'runtimeRestarts':0,'dbWrites':0,'externalMessages':0}
    def inspect(self,x):
        r=self.runtime(x); need(sha(read(x['target']))==BASE_SHA,'Cabinet static BASE changed'); self.stable(x)
        return {'status':'FRONTEND_INSPECT_ONLY_NOT_APPROVED','images':r['images'],'cabinetTarget':str(x['target']),'cabinetSHA256':BASE_SHA,'runtimeSHA256':BASE_SHA,'candidateSHA256':CANDIDATE_SHA,'runtimeRestarts':0,'dbWrites':0}
    def apply(self,x,proof,proof_sha,context,journal,apply=False):
        need(apply is True,'Explicit --apply required'); self.check(x,proof,proof_sha)
        context=path(context,True); journal=path(journal,True)
        release_root=path(RELEASE_ROOT); need(context.resolve(strict=False).is_relative_to(release_root.resolve()) and journal.resolve(strict=False).is_relative_to(release_root.resolve()) and context!=release_root and journal!=release_root,'Outputs must stay inside explicit private release directory')
        need(not context.exists() and context.parent.is_dir() and not journal.exists() and journal.parent.is_dir(),'New context/journal required')
        need(not journal.resolve(strict=False).is_relative_to(context.resolve(strict=False)) and not context.resolve(strict=False).is_relative_to(x['target'].parent.resolve()),'Output intersects live cabinet')
        release=x['manifest']['releaseId']; need(type(release)is str and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,63}',release) is not None,'Invalid release ID')
        tag='palitra-frontend:'+release; alias='palitra-frontend-base:'+release
        need(self.run(['docker','image','ls','--quiet',tag]).strip()==b'','Unique frontend image tag already exists')
        need(self.run(['docker','image','ls','--quiet',alias]).strip()==b'','Unique local base alias already exists')
        need(self.local_id(x['images']['content'])==x['images']['content'],'Exact native backend image unavailable locally; never pull')
        self.stable(x); context.mkdir(mode=0o700); old=read(x['target']); s=x['target'].stat(); need(sha(old)==BASE_SHA,'Live cabinet changed before backup')
        write_new(context/'cabinet-native-host.backup.js',old); write_new(context/'native-host.js',x['candidate'])
        # A config image ID is not a registry digest: BuildKit interprets FROM sha256:<id>
        # as docker.io/library/sha256:<tag>. Pin a new local alias to the exact ID instead.
        dockerfile=('FROM '+alias+'\nCOPY native-host.js '+RUNTIME_PATH+'\n').encode(); write_new(context/'Dockerfile',dockerfile)
        state={'schema':1,'phase':'FRONTEND_LOCAL_BASE_ALIAS_STARTED_UNKNOWN','releaseId':release,'backendImages':x['images'],'baseAlias':alias,'baseAliasImage':x['images']['content'],'childTag':tag,'context':str(context),'cabinetTarget':str(x['target']),'baseSha256':BASE_SHA,'candidateSha256':CANDIDATE_SHA,'backupSha256':sha(old),'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid,'backendProofSha256':proof_sha,'manifestSha256':x['manifestSha256'],'buildJournalSha256':x['buildSha256'],'activationJournalSha256':x['activationSha256'],'runtimeRestarts':0,'dbWrites':0}
        write_new(journal,encoded(state)); self.check(x,proof,proof_sha)
        need(read(context/'Dockerfile')==dockerfile and sha(read(context/'native-host.js'))==CANDIDATE_SHA,'Build context changed')
        iid=context/'frontend-image.iid'; need(not iid.exists(),'Image ID output unexpectedly exists'); layers=self.layers(x['images']['content'])
        need(self.run(['docker','image','ls','--quiet',alias]).strip()==b'','Local base alias appeared before tagging')
        self.run(['docker','image','tag',x['images']['content'],alias]); self.verify_alias(alias,x['images']['content'],layers)
        self.check(x,proof,proof_sha); state['phase']='FRONTEND_BUILD_STARTED_UNKNOWN'; replace_json(journal,state)
        self.run(['docker','build','--network=none','--pull=false','--iidfile',str(iid),'--tag',tag,'--file',str(context/'Dockerfile'),str(context)])
        self.verify_alias(alias,x['images']['content'],layers); self.check(x,proof,proof_sha)
        child=read(iid).decode('ascii').strip(); need(image_ok(child) and child!=x['images']['content'],'Invalid one-file build image ID')
        need(self.run(['docker','image','inspect','--format','{{.Id}}',tag]).decode().strip()==child,'Image tag changed after build')
        child_layers=self.layers(child); need(child_layers[:-1]==layers and len(child_layers)==len(layers)+1,'Child image does not preserve exact backend layers plus one COPY')
        verified=self.run(['docker','run','--rm','--network','none','--read-only','--entrypoint','node',child,'-e',FILE_JS,'--',RUNTIME_PATH]).decode().strip(); need(verified==CANDIDATE_SHA,'Child frontend readback failed')
        state.update(phase='FRONTEND_BUILT_NOT_ACTIVATED',frontendImage=child); replace_json(journal,state)
        self.check(x,proof,proof_sha); need(sha(read(context/'cabinet-native-host.backup.js'))==BASE_SHA,'Backup changed'); t=x['target']; current=t.stat()
        need((current.st_dev,current.st_ino,current.st_mtime_ns,current.st_size)==(s.st_dev,s.st_ino,s.st_mtime_ns,s.st_size),'Cabinet replaced after backup')
        temporary=t.with_name(t.name+'.frontend.pending'); write_new(temporary,x['candidate'],stat.S_IMODE(s.st_mode)); os.chmod(temporary,stat.S_IMODE(s.st_mode))
        if os.name=='posix': os.chown(temporary,s.st_uid,s.st_gid)
        # The single Root lease + fresh native proof guards both known destinations.
        self.check(x,proof,proof_sha); state['phase']='CABINET_ATOMIC_WRITE_STARTED_UNKNOWN'; replace_json(journal,state); os.replace(temporary,t)
        need(sha(read(t))==CANDIDATE_SHA,'Cabinet atomic write readback failed'); self.runtime(x); self.stable(x)
        state['phase']='FRONTEND_CODE_READY_IMAGE_NOT_ACTIVATED'; replace_json(journal,state)
        return {'status':state['phase'],'frontendImage':child,'backendImage':x['images']['content'],'workerImage':x['images']['chat'],'cabinetSHA256':CANDIDATE_SHA,'journalSha256':sha(read(journal)),'nextAction':'Root separately activates exact frontendImage, preserving backend config/worker, then performs public customer/admin proof','runtimeRestarts':0,'dbWrites':0,'publicReady':False}
    def rollback(self,x,journal,journal_sha,apply=False):
        need(apply is True,'Explicit --apply rollback required'); raw=read(journal); need(hash_ok(journal_sha) and sha(raw)==journal_sha,'Exact successful frontend journal SHA required'); r=obj(raw)
        need(r.get('schema')==1 and r.get('phase')=='FRONTEND_CODE_READY_IMAGE_NOT_ACTIVATED' and r.get('backendImages')==x['images'] and r.get('manifestSha256')==x['manifestSha256'] and r.get('buildJournalSha256')==x['buildSha256'] and r.get('activationJournalSha256')==x['activationSha256'] and r.get('cabinetTarget')==str(x['target']) and r.get('baseSha256')==BASE_SHA and r.get('candidateSha256')==CANDIDATE_SHA and image_ok(r.get('frontendImage')),'Unknown/partial execution: inspect manually, do not replay rollback')
        # Root first restores backend image if the child was activated. This helper never restarts it.
        self.runtime(x); self.stable(x); t=x['target']; need(sha(read(t))==CANDIDATE_SHA,'Live cabinet changed since activation; refuse rollback')
        backup=path(Path(r['context'])/'cabinet-native-host.backup.js'); old=read(backup); need(sha(old)==r.get('backupSha256')==BASE_SHA,'Exact backup changed')
        temporary=t.with_name(t.name+'.frontend.rollback.pending'); write_new(temporary,old,r['mode']); os.chmod(temporary,r['mode'])
        if os.name=='posix': os.chown(temporary,r['uid'],r['gid'])
        self.runtime(x); need(sha(read(t))==CANDIDATE_SHA,'Live cabinet changed before rollback'); r['phase']='FRONTEND_STATIC_ROLLBACK_STARTED_UNKNOWN'; replace_json(journal,r); os.replace(temporary,t)
        need(sha(read(t))==BASE_SHA,'Static rollback readback failed'); r['phase']='FRONTEND_STATIC_ROLLED_BACK_CHILD_RETAINED'; replace_json(journal,r)
        return {'status':r['phase'],'cabinetSHA256':BASE_SHA,'runtimeRestarts':0,'dbWrites':0,'childImageDeleted':False}

def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('operation',choices=['inspect','check','apply','rollback'])
    for k in ['bundle','build-journal','activation-journal','candidate']: p.add_argument('--'+k,type=Path)
    for k in ['manifest-sha','build-journal-sha','activation-journal-sha']: p.add_argument('--'+k)
    p.add_argument('--inputs',type=Path); p.add_argument('--inputs-sha')
    p.add_argument('--backend-proof',type=Path); p.add_argument('--backend-proof-sha'); p.add_argument('--context',type=Path); p.add_argument('--journal',type=Path); p.add_argument('--journal-sha'); p.add_argument('--apply',action='store_true'); a=p.parse_args()
    try:
        private_input=None
        if a.inputs:
            need(hash_ok(a.inputs_sha),'Explicit independent inputs SHA required'); private_input=path(a.inputs); raw=read(private_input); need(sha(raw)==a.inputs_sha,'Private inputs changed'); values=obj(raw)
            allowed={'bundle','build_journal','activation_journal','candidate','manifest_sha','build_journal_sha','activation_journal_sha','backend_proof','backend_proof_sha','context','journal'}
            need(set(values)==allowed,'Exact private input field inventory required')
            for name in allowed:
                need(getattr(a,name) is None,'Do not mix private inputs and individual arguments'); value=values[name]
                need(type(value)is str and value,'Explicit input string required'); setattr(a,name,Path(value) if name in {'bundle','build_journal','activation_journal','candidate','backend_proof','context','journal'} else value)
        else: need(a.inputs_sha is None,'Inputs path required with inputs SHA')
        f=Frontend(); x=f.artifacts(a.bundle,a.manifest_sha,a.build_journal,a.build_journal_sha,a.activation_journal,a.activation_journal_sha,a.candidate)
        if private_input is not None: x['snapshots'][private_input]=a.inputs_sha
        if a.operation=='inspect': result=f.inspect(x)
        elif a.operation=='check': result=f.check(x,a.backend_proof,a.backend_proof_sha)
        elif a.operation=='apply': result=f.apply(x,a.backend_proof,a.backend_proof_sha,a.context,a.journal,a.apply)
        else: result=f.rollback(x,a.journal,a.journal_sha,a.apply)
        print(json.dumps(result,ensure_ascii=False)); return 0
    except Exception as e:
        print(json.dumps({'status':'REFUSED','reason':str(e),'automaticRetry':False,'runtimeRestarts':0,'dbWrites':0},ensure_ascii=False)); return 2
if __name__=='__main__': sys.exit(main())
