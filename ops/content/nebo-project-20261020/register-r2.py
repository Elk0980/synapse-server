"""Append the NEBO company to the exact installed registry, preserving all data.

Two phases: prepare creates and verifies an image; apply recreates content only.
No credentials, grants, database edits, migrations, or worker operations.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path('/opt/synapse/releases/nebo-project-20261020')
BASE_IMAGE = 'sha256:c159821e06c4d8913d786ec31176812cce783031379ca9e288baae7beba5d7cf'
BASE_AUTH = '8171611ed8c5cef7515740a81cc4b44151c63e036b600c2c932eee21ada94b8e'
TAG = 'synapse-nebo-company:20261020-r1'
CONTAINER = 'synapse-content-1'
LOCK = '/opt/synapse/.palitra-app-release.lock'

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def save(name, value):
    target = ROOT / name
    with target.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
    target.chmod(0o600)

def lease(pid):
    lines = run('lslocks', '-n', '-o', 'pid,path').splitlines()
    holders = [line.split()[0] for line in lines if line.split()[-1:] == [LOCK]]
    assert holders == [str(pid)], 'EXACT_OWN_LEASE_REQUIRED'

def inspect():
    return json.loads(run('docker', 'inspect', CONTAINER))[0]

def code():
    return subprocess.check_output(['docker', 'exec', CONTAINER, 'cat', '/app/auth-store.js'])

def compose_args(row):
    files = row['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
    assert files and all(Path(p).is_file() for p in files), 'COMPOSE_FILES_REQUIRED'
    return ['docker', 'compose'] + [v for p in files for v in ('-f', p)]

def invariant(row):
    # Values are hashed, never printed. Includes existing secret env without disclosing it.
    value = {k: row['Config'].get(k) for k in ['Env', 'Cmd', 'Entrypoint', 'User', 'WorkingDir', 'ExposedPorts']}
    value['mounts'] = sorted([{k: m.get(k) for k in ['Type', 'Source', 'Destination', 'RW']} for m in row['Mounts']], key=lambda m:m['Destination'])
    value['networks'] = sorted(row['NetworkSettings']['Networks'])
    value['restart'] = row['HostConfig']['RestartPolicy']
    return sha(json.dumps(value, sort_keys=True).encode())

def containers():
    rows = run('docker', 'ps', '--format', '{{.Names}} {{.ID}}').splitlines()
    return dict(line.split() for line in rows if not line.startswith(CONTAINER + ' '))

TREE_SCRIPT = r"""const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');let out={};function walk(d){for(const n of fs.readdirSync(d)){const f=p.join(d,n),s=fs.lstatSync(f);if(s.isSymbolicLink())out[f]='LINK:'+fs.readlinkSync(f);else if(s.isDirectory())walk(f);else if(s.isFile())out[f]=c.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}}walk('/app');console.log(JSON.stringify(out));"""

def tree(image):
    return json.loads(run('docker', 'run', '--rm', '--network', 'none', image, 'node', '-e', TREE_SCRIPT))

def registry(image):
    return json.loads(run('docker', 'run', '--rm', '--network', 'none', image, 'node', '-e', "let x=require('/app/auth-store');console.log(JSON.stringify({companies:x.COMPANIES,permissions:x.PERMISSIONS,dependencies:x.DEPENDENCIES,tatyana:x.TATYANA_PERMISSIONS}));"))

def prepare(pid):
    lease(pid)
    before = inspect()
    assert before['Image'] == BASE_IMAGE and sha(code()) == BASE_AUTH, 'FRESH_EXACT_BASE_REQUIRED'
    assert not ROOT.exists(), 'NEW_NAMESPACE_REQUIRED'
    ROOT.mkdir(mode=0o700)
    source = code()
    anchor = b'const COMPANIES = Object.freeze({\n'
    assert source.count(anchor) == 1 and b'  nebo:' not in source, 'EXACT_REGISTRY_ANCHOR_REQUIRED'
    candidate = source.replace(anchor, anchor + "  nebo: { name: 'Небо', contentSiteId: null },\n".encode('utf-8'), 1)
    assert candidate.replace("  nebo: { name: 'Небо', contentSiteId: null },\n".encode('utf-8'), b'', 1) == source
    (ROOT / 'auth-store.before.js').write_bytes(source)
    build = ROOT / 'build'
    build.mkdir(mode=0o700)
    (build / 'auth-store.js').write_bytes(candidate)
    (build / 'Dockerfile').write_text('FROM ' + BASE_IMAGE + '\nCOPY auth-store.js /app/auth-store.js\n', encoding='utf-8')
    with (ROOT / 'build.log').open('xb') as log:
        subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', TAG, str(build)], stdout=log, stderr=log, check=True)
    next_image = run('docker', 'image', 'inspect', TAG, '--format', '{{.Id}}')
    run('docker', 'run', '--rm', '--network', 'none', next_image, 'node', '--check', '/app/auth-store.js')
    old_tree, new_tree = tree(BASE_IMAGE), tree(next_image)
    delta = [p for p in set(old_tree) | set(new_tree) if old_tree.get(p) != new_tree.get(p)]
    assert delta == ['/app/auth-store.js'], 'ONLY_REGISTRY_MAY_CHANGE'
    old_reg, new_reg = registry(BASE_IMAGE), registry(next_image)
    assert new_reg['companies'].pop('nebo') == {'name':'Небо','contentSiteId':None}
    assert new_reg == old_reg, 'EXISTING_REGISTRY_AND_PERMISSIONS_MUST_MATCH'
    args = compose_args(before)
    files = args[3::2]
    overlay = ROOT / 'nebo-company-overlay.json'
    overlay.write_text(json.dumps({'services':{'content':{'image':next_image}}}), encoding='utf-8')
    config = json.loads(run(*args, '-f', str(overlay), 'config', '--format', 'json'))
    assert config['services']['content']['image'] == next_image
    save('READY.json', {'status':'PREPARED_ONLY', 'baseImage':BASE_IMAGE, 'nextImage':next_image,
        'authBefore':BASE_AUTH,'authAfter':sha(candidate),'files':len(old_tree),'delta':delta,
        'containerId':before['Id'],'configInvariant':invariant(before),
        'composeFiles':files,'composeSha':{p:sha(Path(p).read_bytes()) for p in files},
        'otherContainers':containers(),'helperSha':sha(Path(__file__).read_bytes()),'leasePid':pid})
    save('ROLLBACK_PLAN.json', {'scope':'image only; never restore databases',
        'requiredCurrentImage':next_image,'restoreImage':BASE_IMAGE,'command':args + ['up','-d','--no-deps','content'],
        'requiresExactOwnLease':pid,'composeFilesUnchanged':True})
    print(json.dumps({'status':'PREPARED_ONLY','image':next_image,'files':len(old_tree),'delta':delta,'permissionsChanged':False,'databaseWrites':0}))

def apply(pid):
    lease(pid)
    ready = json.loads((ROOT / 'READY.json').read_text())
    assert ready['helperSha'] == sha(Path(__file__).read_bytes()) and ready['leasePid'] == pid
    before = inspect()
    assert before['Image'] == BASE_IMAGE and before['Id'] == ready['containerId'] and sha(code()) == BASE_AUTH
    assert invariant(before) == ready['configInvariant']
    assert containers() == ready['otherContainers']
    assert all(sha(Path(p).read_bytes()) == digest for p,digest in ready['composeSha'].items())
    save('APPLY_STARTED.json', {'time':time.time(),'image':ready['nextImage']})
    # Consistent private native SQLite backups; no restoration and no live row changes.
    backup_js = r"""const fs=require('node:fs');const {DatabaseSync,backup}=require('node:sqlite');(async()=>{const d='/data/nebo-project-backup-20261020';fs.mkdirSync(d,{mode:0o700});let out=[];for(const n of ['content.sqlite','salon-reports.sqlite']){const p='/data/'+n;if(!fs.existsSync(p))continue;const db=new DatabaseSync(p,{readOnly:true});const to=d+'/'+n;await backup(db,to);db.close();fs.chmodSync(to,0o600);out.push(n);}console.log(JSON.stringify({backup:out}));})().catch(e=>{console.error(e.message);process.exit(1)});"""
    backup = json.loads(run('docker', 'exec', CONTAINER, 'node', '-e', backup_js))
    save('BACKUP.json', backup)
    args = compose_args(before)
    with (ROOT / 'apply.log').open('xb') as log:
        subprocess.run(args + ['-f',str(ROOT/'nebo-company-overlay.json'),'up','-d','--no-deps','content'], stdout=log, stderr=log, check=True)
    after = inspect()
    assert after['Image'] == ready['nextImage'] and invariant(after) == ready['configInvariant']
    assert sha(code()) == ready['authAfter'] and containers() == ready['otherContainers']
    after_tree = json.loads(run('docker','exec',CONTAINER,'node','-e',TREE_SCRIPT))
    expected = tree(ready['nextImage'])
    assert after_tree == expected, 'RUNTIME_FILES_MUST_MATCH'
    save('OUTCOME.json', {'status':'REGISTERED_NEBO','baseImage':BASE_IMAGE,'image':after['Image'],
        'authSha':ready['authAfter'],'sourceFiles':len(after_tree),'changedFiles':['/app/auth-store.js'],
        'configPreserved':True,'otherContainersPreserved':True,'permissionsChanged':False,
        'databaseWrites':0,'backup':backup,'at':time.time()})
    print('REGISTERED_NEBO; all existing code except one registry entry preserved; database writes 0; other containers preserved')

if __name__ == '__main__':
    assert len(sys.argv) == 3 and sys.argv[1] in ['prepare','apply'], 'MODE_AND_OWN_PID_REQUIRED'
    assert os.geteuid() == 0, 'NATIVE_ROOT_REQUIRED'
    {'prepare':prepare,'apply':apply}[sys.argv[1]](int(sys.argv[2]))
