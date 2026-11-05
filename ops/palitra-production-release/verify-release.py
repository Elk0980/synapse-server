#!/usr/bin/env python3
"""Verify a reviewed package and current native baseline. Root runs activation separately."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / 'manifest.json').read_text('utf-8'))
def sha(data): return hashlib.sha256(data).hexdigest()
def verify_package():
    for row in MANIFEST['files']:
        target = ROOT / row['relativepath']
        if target.is_symlink() or not target.resolve().is_relative_to(ROOT): raise SystemExit('STOP: package path')
        data = target.read_bytes()
        if len(data) != row['bytes'] or sha(data) != row['sha256']: raise SystemExit('STOP: package digest ' + row['relativepath'])
def runtime_baseline():
    names = [r['relativepath'] for r in MANIFEST['expected_runtime_baseline']]
    result = subprocess.check_output(['docker','exec','synapse-content-1','sha256sum', *['/app/'+n for n in names]],text=True)
    actual = {line.split()[1].removeprefix('/app/'):line.split()[0] for line in result.splitlines()}
    for row in MANIFEST['expected_runtime_baseline']:
        if actual.get(row['relativepath']) != row['sha256']: raise SystemExit('STOP: runtime changed '+row['relativepath'])
    return actual
def static_baseline():
    target = Path('/opt/synapse/sites/synapse/palitra-editor.js')
    if target.is_symlink() or sha(target.read_bytes()) != MANIFEST['expected_static_baseline'][0]['sha256']:
        raise SystemExit('STOP: editor source changed')
    return target

p=argparse.ArgumentParser()
p.add_argument('action',choices=['package','preflight','static'])
p.add_argument('--state',default='/opt/palitra-production-20261013')
a=p.parse_args()
verify_package()
if a.action=='package':
    print(json.dumps({'package':'verified','files':len(MANIFEST['files'])}));raise SystemExit(0)
if a.action=='preflight':
    baseline=runtime_baseline();static_baseline()
    print(json.dumps({'baseline':'verified','files':baseline,'static':'verified'}));raise SystemExit(0)
target=static_baseline()
state=Path(a.state).resolve()
if not str(state).startswith('/opt/palitra-production-') or state.is_symlink(): raise SystemExit('STOP: state path')
state.mkdir(mode=0o700,exist_ok=True)
backup=state/'palitra-editor.js.BASE'
if backup.exists(): raise SystemExit('STOP: static backup exists; read result before repeating')
shutil.copy2(target,backup);os.chmod(backup,0o600)
candidate=(ROOT/'payload/static/palitra-editor.js').read_bytes()
mode=target.stat().st_mode & 0o777
temporary=target.with_name('palitra-editor.js.production-copy.tmp')
with temporary.open('xb') as f: f.write(candidate);f.flush();os.fsync(f.fileno())
os.chmod(temporary,mode)
if sha(target.read_bytes())!=MANIFEST['expected_static_baseline'][0]['sha256']: raise SystemExit('STOP: editor changed during stage')
os.replace(temporary,target)
if target.read_bytes()!=candidate: raise SystemExit('STOP: editor readback')
print(json.dumps({'static':'published','sha256':sha(candidate)}))
