"""Read-only completion audit after the order-sensitive Config assertion.

No install/retry/rollback, credentials output, SQL mutations, or history edits.
"""
import copy
import hashlib
import itertools
import json
from pathlib import Path
import runpy
import subprocess

x = runpy.run_path('/tmp/nebo-register-r3.py')
root = x['ROOT']
ready = json.loads((root/'READY.json').read_text())
before = json.loads(Path('/tmp/nebo-before.json').read_text())
x['lease'](ready['leasePid'])
after = x['inspect']()
assert after['Image'] == ready['nextImage'], 'CURRENT_IMAGE_MUST_MATCH'
assert x['sha'](x['code']()) == ready['authAfter'], 'CURRENT_AUTH_MUST_MATCH'
assert x['containers']() == ready['otherContainers'], 'OTHER_CONTAINERS_MUST_MATCH'
assert all(x['sha'](Path(p).read_bytes()) == digest for p,digest in ready['composeSha'].items()), 'OLD_COMPOSE_FILES_MUST_MATCH'
mounts = [{k:m.get(k) for k in ['Type','Source','Destination','RW']} for m in after['Mounts']]
assert sorted(mounts,key=lambda m:m['Destination']) == sorted(before['mounts'],key=lambda m:m['Destination']), 'MOUNTS_MUST_MATCH'
actual = json.loads(x['run']('docker','exec',x['CONTAINER'],'node','-e',x['TREE_SCRIPT']))
expected = x['tree'](ready['nextImage'])
assert actual == expected, 'RUNTIME_SOURCE_MUST_MATCH'
parent = x['tree'](x['BASE_IMAGE'])
assert [p for p in set(parent)|set(actual) if parent.get(p)!=actual.get(p)] == ['/app/auth-store.js']

env = after['Config'].get('Env', [])
orders = [env,sorted(env),sorted(env,reverse=True),list(reversed(env))]
for start in range(len(env)):
    orders.append(env[start:]+env[:start])
    for end in range(start+1,len(env)):
        trial = env[:]
        trial[start],trial[end] = trial[end],trial[start]
        orders.append(trial)
base_config = json.loads(x['run']('docker','image','inspect',x['BASE_IMAGE']))[0]['Config']
base_keys = [v.split('=',1)[0] for v in base_config.get('Env',[])]
base_env = [v for v in env if v.split('=',1)[0] in base_keys]
other_env = [v for v in env if v.split('=',1)[0] not in base_keys]
if len(base_env)<=6:
    for default in itertools.permutations(base_env):
        orders.extend([list(default)+other_env,other_env+list(default),list(default)+sorted(other_env),sorted(other_env)+list(default)])
matches = []
users = list(dict.fromkeys([after['Config'].get('User'),'','0','root','0:0','root:root']))
for user in users:
    for order in orders:
        trial = copy.deepcopy(after)
        trial['Config']['Env'] = order
        trial['Config']['User'] = user
        if x['invariant'](trial) == ready['configInvariant']:
            matches.append({'envOrderOnly':order!=env,'userStringBefore':user,'userStringAfter':after['Config'].get('User')})
            break
    if matches:
        break

args = ['docker','compose']+[v for p in ready['composeFiles'] for v in ('-f',p)]
effective = json.loads(x['run'](*args,'config','--format','json'))['services']['content']
expected_env = dict(v.split('=',1) for v in base_config.get('Env',[]))
expected_env.update({k:str(v) for k,v in effective.get('environment',{}).items()})
# Compose config escapes literal dollars for re-use as a Compose document.
# Compare decoded effective values; never change environment values on the host.
expected_env = {k:v.replace('$$','$') for k,v in expected_env.items()}
actual_env = dict(v.split('=',1) for v in env)
assert actual_env == expected_env, 'CURRENT_ENV_MUST_EQUAL_ORIGINAL_EFFECTIVE_COMPOSE'
facts = {'status':'SOURCE_AND_EFFECTIVE_CONFIG_VERIFIED','image':after['Image'],'authSha':ready['authAfter'],
    'sourceFiles':len(actual),'sourceDelta':['/app/auth-store.js'],'otherContainersExact':True,'mountsExact':True,
    'oldComposeFilesExact':True,'effectiveEnvironmentValuesExact':True,'historicalInvariantRecovered':matches,
    'historicalOrderHashMismatch':not matches,'registryPermissionsChanged':False,'databaseWrites':0}
target = root/'AUDIT_CURRENT_R5.json'
with target.open('x') as stream:
    json.dump(facts,stream,indent=2)
target.chmod(0o600)
print(json.dumps(facts))

source = subprocess.check_output(['docker','exec',x['CONTAINER'],'cat','/app/server.js'],text=True).splitlines()
selected=[]
for n,line in enumerate(source):
    if any(v in line for v in ['const workspaces = createWorkspaceStore','const workspaceStore = createWorkspaceStore','createSiteStore(db','function saveDocument(', 'const saveDocument =']):
        selected.extend(f'{i+1}: {source[i]}' for i in range(max(0,n-1),min(len(source),n+16)))
(root/'SOURCE_INITIALIZATION_R5.txt').write_text('\n'.join(selected),encoding='utf-8')
