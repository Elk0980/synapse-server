#!/usr/bin/env python3
"""PR478 early-stop diagnosis. Read-only; fixed redacted output only."""
from pathlib import Path
import hashlib,json,re,sqlite3,subprocess as sp
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1')
N=P/'release-478-35-r3'
def load(p): return json.loads(p.read_bytes())
def run(a):
 r=sp.run(a,capture_output=True,timeout=60)
 return r
import io,contextlib,os

COMMENT_JS="const fs=require('node:fs'),{loadConfig,crmClient}=require('/app/server.js');(async()=>{const input=JSON.parse(fs.readFileSync(0,'utf8')),call=crmClient(loadConfig());let offset=0;for(;;){const t=await call('task_get',{task_id:35,comments_limit:20,comments_offset:offset,subtasks_limit:1});const f=t.comments.find(c=>c.text.includes(input.marker));if(f){if(f.author!=='Codex — Выпуск PR478/#35'||f.text!==input.text)throw Error('MARKER');console.log(JSON.stringify({comment_id:f.id,status:'ALREADY_POSTED'}));return;}offset+=t.comments.length;if(offset>=t.comments_pagination.total)break;if(!t.comments.length)throw Error('PAGE');}const r=await call('task_comment',{task_id:35,author:'Codex — Выпуск PR478/#35',text:input.text});if(!Number.isSafeInteger(r.comment?.id))throw Error('COMMENT');console.log(JSON.stringify({comment_id:r.comment.id,status:'POSTED'}));})().catch(()=>{console.error('REPORT_UNKNOWN_READ_BEFORE_RETRY');process.exitCode=1;});"

def main():
    assert os.geteuid()==0
    assert run(['hostname']).stdout.decode().strip()=='msk-1-vm-tgnt'
    receipt=N/'build-diagnostic.redacted.txt'
    assert not receipt.exists() and not receipt.is_symlink()
    captured=io.StringIO()
    with contextlib.redirect_stdout(captured):
        rc=[{'file':p.name,**load(p)} for p in sorted(N.glob('*.rc.json'))]
        print('R478_RC_TAIL',json.dumps(rc[-8:]),flush=True)
        before=load(N/'containers.private.json')
        facts=[]
        for name in ['synapse-crm-1','synapse-content-1','synapse-tasks-mcp-1']:
         old=next(x for x in before if x['Name']=='/'+name)
         r=run(['docker','inspect',name]);assert r.returncode==0
         row=json.loads(r.stdout)[0]
         facts.append({'service':name,'same_id':row['Id']==old['Id'],'same_image':row['Image']==old['Image'],'same_start':row['State']['StartedAt']==old['State']['StartedAt'],'same_restarts':row['RestartCount']==old['RestartCount'],'running':row['State']['Running'],'same_config':row['Config']==old['Config'],'same_mounts':sorted(row['Mounts'],key=lambda m:(m['Destination'],m['Source'],m['Type']))==sorted(old['Mounts'],key=lambda m:(m['Destination'],m['Source'],m['Type']))})
        print('R478_BASELINE_FACTS',json.dumps(facts),flush=True)
        m=load(N/'metadata.redacted.json')
        guards={}
        for path,v in m['guards'].items():
         p=Path(path);guards[path]=hashlib.sha256(p.read_bytes()).hexdigest()==v['sha256']
        print('R478_GUARDS',json.dumps(guards),flush=True)
        print('R478_LATE_ARTIFACTS',json.dumps({p:(N/p).exists() for p in ['source-plan.private.json','candidate.json','online-trial','cold-raw','actual-post','verified.native.redacted.json']}),flush=True)
        locks=run(['lslocks','--json','-o','PID,PATH']);assert locks.returncode==0
        print('R478_LOCK_FREE',not any(x.get('path')=='/opt/synapse/.palitra-app-release.lock' for x in json.loads(locks.stdout).get('locks',[])),flush=True)
        name='sb478-r1-readonly-absent-check'
        r=run(['docker','inspect',name]);message=r.stderr.decode('utf-8','replace').strip()
        safe=bool(re.fullmatch(r'(?i)(?:error(?::| response from daemon:)\s*)?no such (?:object|container):?\s*'+re.escape(name),message))
        try: empty_json=json.loads(r.stdout)==[]
        except: empty_json=False
        print('R478_MISSING_INSPECT',json.dumps({'rc':r.returncode,'stdout_empty':r.stdout.strip()==b'','stdout_empty_json':empty_json,'stdout_bytes':len(r.stdout),'stderr_bytes':len(r.stderr),'safe_no_such':safe,'safe_message':message if safe else 'UNCLASSIFIED_REDACTED','stderr_sha256':hashlib.sha256(r.stderr).hexdigest()}),flush=True)
        for service in ['crm','content']:
         p=Path(m['databases'][service]['host_path'])
         db=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=15)
         try:
          db.execute('PRAGMA query_only=ON')
          people=db.execute("SELECT count(*) FROM sqlite_master WHERE name LIKE 'people_%' OR tbl_name LIKE 'people_%'").fetchone()[0]
          result={'service':service,'people_objects':people}
          if service=='crm':result['versions']=[x[0] for x in db.execute('SELECT version FROM schema_migrations ORDER BY version')]
          print('R478_SCHEMA',json.dumps(result),flush=True)
         finally:db.close()
        
        
        plan=load(N/'source-plan.private.json')
        assert len(plan)==17
        source_pins=all(Path(v['source']).is_relative_to(N/'source') and hashlib.sha256(Path(v['source']).read_bytes()).hexdigest()==v['after_sha256'] for v in plan.values())
        print('R478B_PREPARED_SOURCE',json.dumps({'files':len(plan),'all_source_pins':source_pins}),flush=True)
        for service in ['crm','content']:
         path=N/'source'/service/'Dockerfile'
         lines=path.read_text().splitlines() if path.exists() else []
         first=next((s for s in lines if s.startswith('FROM ')),'')
         old=next(x for x in before if x['Name']=='/synapse-'+service+'-1')
         par=run(['docker','image','inspect',old['Image']]);assert par.returncode==0
         parent=json.loads(par.stdout)[0]
         tag='synapse-'+service+':pr478-20261103-r1'
         cand=run(['docker','image','inspect',tag])
         present=cand.returncode==0
         d={'service':service,'dockerfile_exists':bool(lines),'from_is_image_id':first=='FROM '+parent['Id'],'parent_id':parent['Id'],'parent_config_present':isinstance(parent.get('Config'),dict),'parent_rootfs_layers':len(parent.get('RootFS',{}).get('Layers',[])),'candidate_exists':present}
         if present:
          child=json.loads(cand.stdout)[0]
          d.update(candidate_id=child['Id'],config_equal=child.get('Config')==parent.get('Config'),rootfs_prefix=child.get('RootFS',{}).get('Layers',[])[:len(parent.get('RootFS',{}).get('Layers',[]))]==parent.get('RootFS',{}).get('Layers',[]))
         print('R478B_IMAGE_STATE',json.dumps(d),flush=True)
        v=run(['docker','version','--format','{{json .}}'])
        if v.returncode==0:
         version=json.loads(v.stdout)
         print('R478B_DOCKER_VERSION',json.dumps({'client':version.get('Client',{}).get('Version'),'server':version.get('Server',{}).get('Version')}),flush=True)
        print('R478B_DIAGNOSTIC_DONE',flush=True)
        
    value=captured.getvalue()
    with receipt.open('xb') as f:
        f.write(value.encode());f.flush();os.fsync(f.fileno())
    receipt.chmod(0o600)
    print(value,flush=True)
    text='R478_BUILD_DIAG_R3\n'+value
    assert len(text)<=9500
    try:
        r=sp.run(['docker','exec','-i','synapse-tasks-mcp-1','node','-e',COMMENT_JS],input=json.dumps({'marker':'R478_BUILD_DIAG_R3','text':text},ensure_ascii=False).encode(),capture_output=True,timeout=120)
        assert r.returncode==0
        result=json.loads(r.stdout)
        assert isinstance(result.get('comment_id'),int)
        print('R478B_REPORT',json.dumps(result),flush=True)
    except Exception: print('R478B_REPORT_PENDING_INSPECT_TASK35_NO_REPLAY',flush=True)

if __name__=='__main__':
    try:main()
    except Exception:print('R478B_STOP_READONLY_INSPECTION_REQUIRED',flush=True);raise SystemExit(1)
