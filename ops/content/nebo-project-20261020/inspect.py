"""Read-only, narrow inventory for the user-authorized NEBO import. No secrets."""
import hashlib
import json
import subprocess

def run(*args):
    return subprocess.check_output(args, text=True).strip()

row = json.loads(run('docker', 'inspect', 'synapse-content-1'))[0]
labels = row['Config'].get('Labels', {})
auth = subprocess.check_output(['docker', 'exec', 'synapse-content-1', 'cat', '/app/auth-store.js'])
companies = json.loads(run('docker', 'exec', 'synapse-content-1', 'node', '-e', "console.log(JSON.stringify(require('/app/auth-store').COMPANIES))"))
print(json.dumps({
    'mode': 'READ_ONLY_NEBO',
    'image': row['Image'],
    'containerId': row['Id'],
    'composeFiles': labels.get('com.docker.compose.project.config_files'),
    'composeWorkingDir': labels.get('com.docker.compose.project.working_dir'),
    'authSha256': hashlib.sha256(auth).hexdigest(),
    'companies': companies,
    'mounts': [{k: m.get(k) for k in ['Type', 'Source', 'Destination', 'RW']} for m in row['Mounts']],
}, ensure_ascii=False, indent=2))
