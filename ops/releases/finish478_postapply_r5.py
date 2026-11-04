#!/usr/bin/env python3
"""Finish the verified R5 activation. No DDL, application restart, or DB restore."""
from pathlib import Path
import copy,fcntl,hashlib,json,os,re,stat,subprocess as sp,sys,time,types,urllib.request
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1')
OLD=P/'release-478-35-r5'
Q=P/'finish-478-r5-20261104-r1'
LOCK=Path('/opt/synapse/.palitra-app-release.lock')
R5_SOURCE=P/'operator478-onefile-r5.py'
R5_SHA='24169c8092e711000d858bb3b4329931c91dd81cc1d61669aae1f86632e3952e'
PLAN_SHA='95b5e62cb499ef4915170f97c32a0f07162542d3d9d5f29695c4f6ecc04950a6'
DIAG_SHA='1207033f5d3762827664649bbd5e8c40bf442c739d693d278c5954652c9f2dad'
DIAG=OLD/'postapply-diagnostic-r5a.redacted.json'
MARKER='RELEASE478_POSTAPPLY_FINISH_VERIFIED_R1'
SOURCE_SHA=None
def need(value,code):
    if not value:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def read(p):return json.loads(p.read_bytes())
def regular(p,directory=False):
    for x in [p,*p.parents]:need(not x.is_symlink(),'SYMLINK')
    s=p.stat();need(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode),'TYPE')
    need(s.st_uid==0 and stat.S_IMODE(s.st_mode)==(0o700 if directory else 0o600),'PRIVATE_MODE')
def write(p,v):
    need(p.parent in [Q,OLD],'OUTPUT_SCOPE')
    fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(canonical(v)+b'\n');f.flush();os.fsync(f.fileno())
def module(p,name,digest):
    regular(p);raw=p.read_bytes();need(sha(raw)==digest,'LIBRARY_PIN')
    m=types.ModuleType(name);m.__file__=str(p);exec(compile(raw,str(p),'exec'),m.__dict__);return m
def target_gate(r,plan,diag):
    for service in ['crm','content']:
        now=r.inspect('synapse-'+service+'-1');before=plan['before'][service];d=diag['services'][service]
        need(now['Id']==d['id'] and now['Image']==plan['images'][service] and now['Image']==d['image'],'CURRENT_TARGET_PIN')
        need(now['State']['Running'] and now['RestartCount']==0,'TARGET_HEALTH_STATE')
        need(r.normalized_config(now)==r.normalized_config(before),'CONFIG_ENV_DRIFT')
        need(r.MODULE.mounts(now)==r.MODULE.mounts(before) and r.network(now)==r.network(before),'MOUNT_NETWORK_DRIFT')
        a=copy.deepcopy(before['HostConfig']);b=copy.deepcopy(now['HostConfig'])
        need(sha(canonical(b))==d['hostconfig_sha256'],'DIAGNOSTIC_HOSTCONFIG_PIN')
        if service=='content':
            need(set(d['hostconfig_diff'])=={'Binds'} and d['hostconfig_diff']['Binds']['list_order_only'] is True,'DIAGNOSTIC_NOT_ORDER_ONLY')
            aa=a.pop('Binds');bb=b.pop('Binds')
            need(isinstance(aa,list) and isinstance(bb,list) and all(isinstance(x,str) for x in aa+bb),'BINDS_TYPE')
            need(sorted(aa)==sorted(bb) and len(set(aa))==len(aa),'EXACT_BIND_MULTISET')
            destinations=[x.split(':')[1] for x in aa];need(len(destinations)==len(set(destinations)),'DUPLICATE_BIND_DESTINATION')
        else:need(not d['hostconfig_diff'],'CRM_HOSTCONFIG_DIFF')
        need(a==b,'OTHER_HOSTCONFIG_DRIFT');r.MODULE.flags(now)
        need(sha(canonical(r.MODULE.env_map(now)))==d['env_sha256'],'DIAGNOSTIC_ENV_PIN')
    r.stable(plan)
def runtime_sources(r,plan):
    source=read(OLD/'source-plan.private.json');need(len(source)==17,'SOURCE_COUNT')
    for service in ['crm','content']:
        selected=[v for v in source.values() if v['service']==service]
        for v in selected:need(sha(Path(v['source']).read_bytes())==v['after_sha256'],'FROZEN_SOURCE_DRIFT')
        targets=[v['target'] for v in selected]
        code='const f=require("node:fs"),c=require("node:crypto");console.log(JSON.stringify(JSON.parse(process.argv[1]).map(p=>({path:p,sha256:c.createHash("sha256").update(f.readFileSync(p)).digest("hex")}))));'
        result=r.run(['docker','exec','synapse-'+service+'-1','node','-e',code,json.dumps(targets)],'finish-source-hashes')
        actual={v['path']:v['sha256'] for v in json.loads(result.stdout)}
        need(actual=={v['target']:v['after_sha256'] for v in selected},'RUNTIME_SOURCE_DRIFT')
def publish(r,manifest,intents):
    entries={Path(e['path']).name:e for e in manifest['entries'] if e['scope']=='host-static'}
    order=['people.css','people.js','people-sw.js','people.webmanifest','people.html'];need(set(entries)==set(order),'STATIC_SCOPE')
    for name in order:
        e=entries[name];p=r.REPO/e['path'];need(p.parent==r.STATIC_ROOT and not p.exists() and not p.is_symlink(),'STATIC_ABSENT_CAS')
        b=(OLD/'package478'/e['payload']).read_bytes();need(sha(b)==e['after']['sha256'],'STATIC_PAYLOAD_PIN')
        tmp=p.with_name(name+'.sb478-finish-r1.tmp');need(not tmp.exists() and not tmp.is_symlink(),'STATIC_TEMP_CAS')
        st=p.parent.stat();intents.append((p,sha(b)));r.event('FINISH_STATIC_INTENT',path=str(p))
        try:
            with tmp.open('xb') as f:f.write(b);f.flush();os.fsync(f.fileno())
            os.chown(tmp,st.st_uid,st.st_gid);tmp.chmod(0o644)
            need(not p.exists() and not p.is_symlink(),'STATIC_LATE_CAS');os.replace(tmp,p)
        finally:
            if tmp.is_file() and not tmp.is_symlink() and sha(tmp.read_bytes())==sha(b):tmp.unlink()
        need(sha(p.read_bytes())==sha(b),'STATIC_READBACK')
def public(r,manifest,plan):
    entries=[e for e in manifest['entries'] if e['scope']=='host-static']
    targets=[(e['path'],e['after']['sha256']) for e in entries]
    for path in ['sites/synapse/cabinet.html','sites/synapse/cabinet/task-board.js']:
        v=plan['checkout_before'][path];need(v['type']=='file','OLD_STATIC_RECORD');targets.append((path,v['sha256']))
    for path,digest in targets:
        url='https://synapse.synapsebusiness.ru/'+path.removeprefix('sites/synapse/')
        for query in ['', '?v=20261103-people-1']:
            with urllib.request.urlopen(urllib.request.Request(url+query,headers={'Cache-Control':'no-cache'}),timeout=30) as response:
                need(response.status==200 and sha(response.read())==digest,'PUBLIC_STATIC_HASH')
def child():
    global SOURCE_SHA
    os.umask(0o077);SOURCE_SHA=sha(Path(__file__).read_bytes());need(SOURCE_SHA==os.environ.get('SB478_FINISH_SCRIPT_SHA'),'REVIEWED_SOURCE_PIN')
    need(sys.platform.startswith('linux') and os.geteuid()==0 and sp.check_output(['hostname']).strip()==b'msk-1-vm-tgnt','HOST')
    regular(P,True);regular(OLD,True);need(not Q.exists() and not Q.is_symlink(),'FINISH_ALREADY_ATTEMPTED')
    need((P/'.gitignore').read_bytes().strip()==b'*','PRIVATE_IGNORE')
    regular(OLD/'release-plan.private.json');need(sha((OLD/'release-plan.private.json').read_bytes())==PLAN_SHA,'PLAN_PIN')
    regular(DIAG);need(sha(DIAG.read_bytes())==DIAG_SHA,'DIAGNOSTIC_PIN')
    diag=read(DIAG);plan=read(OLD/'release-plan.private.json')
    need(diag['failure']=={'code':'TARGET_HOST_CONFIG_CHANGED','constructor_intent':True,'no_blind_retry':True,'stopped':True,'up_intent':True},'EXPECTED_FAILURE_ONLY')
    need(read(OLD/'failure.redacted.json')==diag['failure'],'FAILURE_PIN')
    need(not (OLD/'verified.native.redacted.json').exists() and not (OLD/'rollback.redacted.json').exists(),'PRIOR_TERMINAL_OUTCOME')
    phases=[json.loads(x)['phase'] for x in (OLD/'events.redacted.jsonl').read_text().splitlines()]
    need('ACTUAL_CONSTRUCTOR_VERIFIED' in phases and 'START_CONTENT_INTENT' in phases and 'CODE_ROLLBACK_VERIFIED_NO_DATABASE_RESTORE' not in phases,'ACTUAL_PHASES')
    Q.mkdir(mode=0o700);write(Q/'attempt.once.json',{'source_sha256':SOURCE_SHA,'prior_source_sha256':R5_SHA,'plan_sha256':PLAN_SHA,'diagnostic_sha256':DIAG_SHA})
    r=module(R5_SOURCE,'frozen_r5_library',R5_SHA)
    r.MODULE=module(r.B/'meta478.py','frozen_meta478_library',r.META_SHA);r.SOURCE_SHA=R5_SHA;r.N=Q;r.RUN_NUMBER=10000
    old476=read(OLD/'prepared-plan476.private.json');r.GLOBAL_ENV=read(Path(old476['child_environment_file']))
    r.MODULE.lease();target_gate(r,plan,diag);runtime_sources(r,plan)
    manifest_path=OLD/'package478/manifest.json';need(sha(manifest_path.read_bytes())==r.MANIFEST_SHA,'MANIFEST_PIN');manifest=read(manifest_path)
    need(len(manifest['static_paths'])==5,'STATIC_COUNT');r.static_absent(manifest)
    expected=read(OLD/'actual-post-fingerprints.private.json');cold=read(OLD/'cold-trial/proofs.private.json')
    for service in ['crm','content']:
        need(expected[service]==cold[service]['after'],'SEALED_TYPED_POSTSTATE')
        need(r.fingerprint(OLD/'actual-post'/service/'db.sqlite',plan['images'][service],'finish-post-'+service)==expected[service],'POST_BACKUP_PROOF')
        r.readiness('synapse-'+service+'-1',service)
    r.state_check(plan,expected)
    owner=r.run(['docker','exec','synapse-content-1','node','-e',r.OWNER_PROBE_JS],'finish-owner-read',timeout=60)
    need(json.loads(owner.stdout).get('verified') is True,'ACTUAL_OWNER_READ')
    need(r.checkout_snapshot(set(manifest['static_paths']))==plan['checkout_before'],'CHECKOUT_BEFORE_PUBLICATION')
    intents=[]
    try:
        target_gate(r,plan,diag);publish(r,manifest,intents);public(r,manifest,plan)
        target_gate(r,plan,diag);r.state_check(plan,expected);runtime_sources(r,plan)
        need(r.checkout_snapshot(set(manifest['static_paths']))==plan['checkout_before'],'CHECKOUT_OUTSIDE_FIVE_STATIC')
        r.clean_helpers();target_gate(r,plan,diag)
        proof={'verified':True,'source_sha256':SOURCE_SHA,'prior_source_sha256':R5_SHA,'plan_sha256':PLAN_SHA,'diagnostic_sha256':DIAG_SHA,'binds_order_only_verified':True,'no_ddl':True,'no_application_restart':True,'no_database_restore':True,'runtime17_verified':True,'health_both_200':True,'people_actual_owner_read':True,'public_five_and_old_assets_exact':True,'foreign_guards_checkout_unchanged':True,'notifications_off':True}
        write(Q/'verified.redacted.json',proof)
        result={'ready':True,'native_verified':True,'public_static_verified':True,'browser_owner_context_pending':True,'head':r.HEAD,'merge':r.MERGE,'manifest_sha256':r.MANIFEST_SHA,'meta_sha256':r.META_SHA,'verifier_sha256':r.VERIFY_SHA,'containers':{s:r.MODULE.fact(r.inspect('synapse-'+s+'-1')) for s in ['crm','content']},'schema_crm':10,'archive_migration':False,'notifications_off':True,'vapid_generated':False,'scope':'crm/content17runtime+5static','backup_both_databases_verified':True,'old_typed_rows_verified_before_commit':True,'database_restored':False,'foreign_unchanged':True,'guards_unchanged':True,'checkout_outside_five_static_unchanged':True,'people_to_crm_actual_owner_read_verified':True,'finish_receipt':str(Q/'verified.redacted.json'),'finish_receipt_sha256':sha((Q/'verified.redacted.json').read_bytes()),'secretValue':'REDACTED'}
        write(OLD/'verified.native.redacted.json',result);print('PR478_FINISH_NATIVE_VERIFIED',flush=True)
    except BaseException:
        conflicts=r.rollback_static(intents);r.clean_helpers();write(Q/'failure.redacted.json',{'inspect_only':True,'application_restart':False,'ddl':False,'database_restored':False,'static_conflicts':conflicts});raise
    try:
        text=MARKER+': PR478/'+r.MERGE+' выпущен. FrozenR5 миграция content проверена: 4 новые таблицы, прежние typedrows/schema/sequence сохранены до COMMIT; защищённые online/cold backups обеих БД проверены. Отдельное завершение подтвердило строго только перестановку Binds content, неизменные effective mounts/env/network/прочие настройки; без повторного DDL, перезапуска или восстановления БД. CRM/content health200, actualOwner People→CRM read, runtime17, 5 новых assets и старые cabinet/task-board resources exact hashes PASS. CRM ledger10/archive0; PEOPLE/VAPID OFF. MCP/остальные контейнеры/legacy guards/Caddy/checkout вне5static сохранены. Квитанция '+str(OLD/'verified.native.redacted.json')+'; checkpoint '+str(Q/'verified.redacted.json')+'. Browser/human/iPhone приёмка отдельно. SECRET_VALUE=REDACTED.'
        receipt=r.report(text,MARKER);write(Q/'task35-comment.redacted.json',receipt);print('PR478_FINISH_REPORTED',receipt['comment_id'],flush=True)
    except BaseException:write(Q/'report-pending.redacted.json',{'verified':True,'retry_comment_only':True,'marker':MARKER});print('PR478_FINISH_REPORT_PENDING',flush=True)
def parent():
    need(os.environ.get('SB478_FINISH_SCRIPT_SHA')==sha(Path(__file__).read_bytes()),'SOURCE_PIN');need(not LOCK.is_symlink(),'LOCK_SYMLINK')
    fd=os.open(LOCK,os.O_RDWR|os.O_NOFOLLOW)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);e=dict(os.environ);e['SB478_LEASE_PID']=str(os.getpid())
        print('PR478_FINISH_LOCK_ACQUIRED',flush=True);r=sp.run([sys.executable,str(Path(__file__).resolve()),'--lease-child'],env=e);return r.returncode
    finally:os.close(fd);print('PR478_FINISH_LOCK_RELEASED',flush=True)
if __name__=='__main__':
    try:
        if sys.argv==[sys.argv[0],'--lease-child']:child();sys.exit(0)
        need(sys.argv==[sys.argv[0]],'NO_ARGUMENTS');sys.exit(parent())
    except BaseException as e:
        if isinstance(e,SystemExit):raise
        code=str(e) if isinstance(e,RuntimeError) and re.fullmatch('[A-Z_0-9]+',str(e)) else type(e).__name__
        print('PR478_FINISH_STOP_'+code,flush=True);sys.exit(1)
