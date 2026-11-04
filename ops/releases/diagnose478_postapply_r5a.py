#!/usr/bin/env python3
"""Read-only R5 post-apply classifier. No application/DDL/restore/restart actions."""
from pathlib import Path
import copy,fcntl,hashlib,json,os,re,sqlite3,stat,subprocess as sp
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1')
N=P/'release-478-35-r5'
MARKER='R478_POSTAPPLY_DIAG_R5A'
IMAGES={'crm':'sha256:1a54d48df019ea75519430ea8c344132d885a7963aeda54f737f2b0289842041','content':'sha256:106951ba98c8d3ff37c0c4336d3d130fe840d598a4fe5ff463740d065412580c'}
def need(v):
    if not v:raise RuntimeError('READONLY_PRECONDITION')
def digest(b):return hashlib.sha256(b).hexdigest()
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def run(a,timeout=45):
    r=sp.run(a,capture_output=True,timeout=timeout);need(r.returncode==0);return r.stdout
def load(p):return json.loads(p.read_bytes())
def inspect(name):
    r=json.loads(run(['docker','inspect',name]));need(len(r)==1);return r[0]
def env(row):
    result={}
    for x in row['Config'].get('Env',[]):
        k,_,v=x.partition('=');need(k not in result);result[k]=v
    return result
def cfg(row):
    v=copy.deepcopy(row['Config']);v.pop('Image',None);v['Env']=env(row)
    if v.get('Hostname')==row['Id'][:12]:v.pop('Hostname',None)
    v['Labels']={k:x for k,x in (v.get('Labels') or {}).items() if not k.startswith('com.docker.compose.')}
    return v
def mounts(row):return sorted(row.get('Mounts',[]),key=lambda m:(m['Destination'],m['Source'],m['Type']))
def network(row):return {k:v['NetworkID'] for k,v in row['NetworkSettings']['Networks'].items()}
def diffkeys(a,b):return sorted(k for k in set(a)|set(b) if a.get(k)!=b.get(k))
def database(p):
    need(p.is_absolute() and p.is_file() and not p.is_symlink())
    d=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=15)
    try:
        d.execute('PRAGMA query_only=ON');d.execute('BEGIN')
        ok=d.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
        fk=len(d.execute('PRAGMA foreign_key_check').fetchall())
        schema=d.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name,tbl_name,sql').fetchall()
        metadata=[(k,d.execute('PRAGMA '+k).fetchone()[0]) for k in ['user_version','application_id','encoding','page_size']]
        tables={x[1] for x in schema if x[0]=='table'}
        versions=[x[0] for x in d.execute('SELECT version FROM schema_migrations ORDER BY version')] if 'schema_migrations' in tables else []
        archive=sum(1 for x in schema if x[1].startswith('module_archive_') or x[2].startswith('module_archive_'))
        people={k:d.execute('SELECT count(*) FROM "'+k+'"').fetchone()[0] for k in ['people_notification_preferences','people_push_subscriptions','people_notification_outbox','people_friday_rules'] if k in tables}
        return {'integrity_ok':ok,'foreign_key_violations':fk,'schema_sha256':digest(canonical(schema)),'metadata_sha256':digest(canonical(metadata)),'versions':versions,'archive_objects':archive,'people_table_counts':people}
    finally:d.close()
def health(name,service):
    url='http://127.0.0.1:8080'+('/summary?from=2026-11-03&to=2026-11-03' if service=='crm' else '/health')
    opts='{signal:AbortSignal.timeout(10000)'+(',headers:{"x-api-key":process.env.API_KEY}' if service=='crm' else '')+'}'
    code='fetch('+json.dumps(url)+','+opts+').then(async r=>{let v;try{v=await r.json()}catch{};console.log(JSON.stringify({status:r.status,json_object:!!v&&typeof v==="object"}));}).catch(()=>{console.log(JSON.stringify({status:0,json_object:false}));});'
    v=json.loads(run(['docker','exec',name,'node','-e',code],25));need(set(v)=={'status','json_object'});return v
COMMENT_JS="const fs=require('node:fs'),{loadConfig,crmClient}=require('/app/server.js');(async()=>{const i=JSON.parse(fs.readFileSync(0,'utf8')),call=crmClient(loadConfig());let offset=0;for(;;){const t=await call('task_get',{task_id:35,comments_limit:20,comments_offset:offset,subtasks_limit:1});const f=t.comments.find(c=>c.text.includes(i.marker));if(f){if(f.author!=='Codex — Выпуск PR478/#35'||f.text!==i.text)throw Error('MARKER');console.log(JSON.stringify({comment_id:f.id,status:'ALREADY_POSTED'}));return;}offset+=t.comments.length;if(offset>=t.comments_pagination.total)break;if(!t.comments.length)throw Error('PAGE');}const r=await call('task_comment',{task_id:35,author:'Codex — Выпуск PR478/#35',text:i.text});if(!Number.isSafeInteger(r.comment?.id))throw Error('COMMENT');console.log(JSON.stringify({comment_id:r.comment.id,status:'POSTED'}));})().catch(()=>{console.error('REPORT_UNKNOWN');process.exitCode=1;});"
def main():
    need(os.geteuid()==0 and run(['hostname']).strip()==b'msk-1-vm-tgnt')
    for p in [P,N,*P.parents]:need(not p.is_symlink())
    need(P.stat().st_uid==0 and stat.S_IMODE(P.stat().st_mode)==0o700)
    receipt=N/'postapply-diagnostic-r5a.redacted.json';need(not receipt.exists() and not receipt.is_symlink())
    lease=os.open('/opt/synapse/.palitra-app-release.lock',os.O_RDWR|os.O_NOFOLLOW)
    try:
        fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
        planpath=N/'release-plan.private.json';plan=load(planpath);need(plan['images']==IMAGES)
        failure=load(N/'failure.redacted.json');code=failure.get('code');need(isinstance(code,str) and re.fullmatch('[A-Z_0-9]+',code))
        report={'plan_sha256':digest(planpath.read_bytes()),'failure':{'code':code,**{k:failure.get(k) for k in ['stopped','constructor_intent','up_intent','no_blind_retry']}},'services':{},'databases':{},'guards':{},'read_only':True}
        for s in ['crm','content']:
            old=plan['before'][s];now=inspect('synapse-'+s+'-1');a=old['HostConfig'];b=now['HostConfig'];keys=diffkeys(a,b)
            hostdiff={k:{'before_sha256':digest(canonical(a.get(k))),'now_sha256':digest(canonical(b.get(k))),'list_order_only':isinstance(a.get(k),list) and isinstance(b.get(k),list) and sorted(map(canonical,a[k]))==sorted(map(canonical,b[k]))} for k in keys}
            eold=env(old);enow=env(now);ediff=diffkeys(eold,enow)
            flags={k:(str(v).lower() in ['','0','false','off','no']) for k,v in enow.items() if k.startswith('PEOPLE_') and k.endswith('_ENABLED')}
            vapid=all(not v for k,v in enow.items() if 'VAPID' in k)
            report['services'][s]={'id':now['Id'],'image':now['Image'],'expected_image':now['Image']==IMAGES[s],'running':now['State']['Running'],'restart_count':now['RestartCount'],'exit_code':now['State']['ExitCode'],'normalized_config_diff_keys':diffkeys(cfg(old),cfg(now)),'env_diff_keys':ediff,'env_sha256':digest(canonical(enow)),'mounts_equal':mounts(old)==mounts(now),'networks_equal':network(old)==network(now),'hostconfig_diff':hostdiff,'hostconfig_sha256':digest(canonical(b)),'people_flags_off':all(flags.values()),'vapid_empty':vapid,'health':health('synapse-'+s+'-1',s)}
            live=database(Path(plan['databases'][s]));expected=database(N/'actual-post'/s/'db.sqlite')
            live['schema_matches_verified_post']=live['schema_sha256']==expected['schema_sha256'];live['metadata_matches_verified_post']=live['metadata_sha256']==expected['metadata_sha256'];report['databases'][s]=live
        m=inspect('synapse-tasks-mcp-1');report['mcp']={'running':m['State']['Running'],'restarts':m['RestartCount'],'id':m['Id'],'image':m['Image']}
        for p,v in plan['guards'].items():
            q=Path(p);st=q.stat();report['guards'][p]={'sha_match':digest(q.read_bytes())==v['sha256'],'ownership_mode_match':(st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode))==(v['uid'],v['gid'],v['mode'])}
        data=canonical(report)
        fd=os.open(receipt,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        print('R478_POSTAPPLY_DIAG_READY',flush=True)
    finally:os.close(lease)
    text=MARKER+'\n'+data.decode();need(len(text)<=9500)
    print(text,flush=True)
    r=sp.run(['docker','exec','-i','synapse-tasks-mcp-1','node','-e',COMMENT_JS],input=canonical({'marker':MARKER,'text':text}),capture_output=True,timeout=120)
    if r.returncode==0:
        v=json.loads(r.stdout);need(isinstance(v.get('comment_id'),int));print('R478_POSTAPPLY_REPORTED',v['comment_id'],flush=True)
    else:print('R478_POSTAPPLY_REPORT_PENDING_INSPECT_ONLY',flush=True)
if __name__=='__main__':
    try:main()
    except BaseException:print('R478_POSTAPPLY_READONLY_STOP',flush=True);raise SystemExit(1)
