#!/usr/bin/env python3
"""PR478 early-stop diagnosis. Read-only; fixed redacted output only."""
from pathlib import Path
import hashlib,json,re,sqlite3,subprocess as sp
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1')
N=P/'release-478-35-r1'
def load(p): return json.loads(p.read_bytes())
def run(a):
 r=sp.run(a,capture_output=True,timeout=60)
 return r
rc=[{'file':p.name,**load(p)} for p in sorted(N.glob('*.rc.json'))]
print('R478_RC_TAIL',json.dumps(rc[-8:]),flush=True)
before=load(N/'containers.private.json')
facts=[]
for name in ['synapse-crm-1','synapse-content-1','synapse-tasks-mcp-1']:
 old=next(x for x in before if x['Name']=='/'+name)
 r=run(['docker','inspect',name]);assert r.returncode==0
 row=json.loads(r.stdout)[0]
 facts.append({'service':name,'same_id':row['Id']==old['Id'],'same_image':row['Image']==old['Image'],'same_start':row['State']['StartedAt']==old['State']['StartedAt'],'same_restarts':row['RestartCount']==old['RestartCount'],'running':row['State']['Running'],'same_config':row['Config']==old['Config'],'same_mounts':row['Mounts']==old['Mounts']})
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
print('R478_DIAGNOSTIC_DONE',flush=True)
