"""One-file Forms layout update. No service, database, model or permission changes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
from datetime import datetime, timezone

RELEASE = Path('/opt/synapse/releases/forms-fullscreen-20261016')
TARGET = Path('/opt/synapse/sites/synapse/cabinet/project-forms.js')
CABINET = TARGET.parent.parent / 'cabinet.html'
LOCK = '/opt/synapse/.palitra-app-release.lock'
LEASE = 2863566
BEFORE = 'aa6c2893e5797df189bb0b5f163fee0354a8e7e86b3fc521603d570e72dea0b5'
AFTER = '59f65e501267d8304aed0795e6d05b270242cfa69d3e2a72391064f8ce0abcfe'
CABINET_SHA = '21a7807236973549c9c9ced75a5a0e255db8abd6cb1068fcf7784097130fd869'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def read_regular(path, maximum=200000):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size > maximum:
        raise RuntimeError('UNEXPECTED_FILE_TYPE_OR_SIZE')
    return path.read_bytes(), info

def save_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    directory = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)

def guards():
    if os.geteuid() != 0 or Path(__file__).resolve().parent != RELEASE:
        raise RuntimeError('ROOT_FIXED_RELEASE_REQUIRED')
    for path in [RELEASE, TARGET.parent, CABINET.parent]:
        if path.is_symlink() or path.resolve() != path:
            raise RuntimeError('UNEXPECTED_PATH_ALIAS')
    locks = json.loads(subprocess.check_output(['lslocks', '--json', '-o', 'PID,PATH'], timeout=10))['locks']
    if sum(row.get('pid') == LEASE and row.get('path') == LOCK for row in locks) != 1:
        raise RuntimeError('FRESH_ROOT_LEASE_REQUIRED')
    cabinet, _ = read_regular(CABINET)
    if digest(cabinet) != CABINET_SHA:
        raise RuntimeError('CABINET_BASE_CHANGED')
    data, info = read_regular(TARGET, 16000)
    return data, info

def replace(data, info):
    temp = TARGET.with_name('.project-forms.fullscreen-20261016.tmp')
    save_new(temp, data)
    os.chown(temp, info.st_uid, info.st_gid)
    os.chmod(temp, stat.S_IMODE(info.st_mode))
    # Recheck the live bytes immediately before replacing the one expected file.
    live, _ = read_regular(TARGET, 16000)
    if digest(live) != (BEFORE if digest(data) == AFTER else AFTER):
        temp.unlink()
        raise RuntimeError('TARGET_CHANGED_BEFORE_REPLACE')
    os.replace(temp, TARGET)
    directory = os.open(TARGET.parent, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)
    if digest(TARGET.read_bytes()) != digest(data):
        raise RuntimeError('READBACK_FAILED_DO_NOT_REPLAY')

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['inspect', 'apply', 'rollback'])
args = parser.parse_args()
live, info = guards()
if args.action == 'inspect':
    print(json.dumps({'status': 'FORMS_STATIC_OBSERVED', 'targetSha256': digest(live), 'bytes': len(live), 'lease': LEASE, 'cabinetSha256': CABINET_SHA}))
elif args.action == 'apply':
    candidate, _ = read_regular(RELEASE / 'project-forms.js', 16000)
    if digest(live) != BEFORE or digest(candidate) != AFTER:
        raise RuntimeError('EXACT_BEFORE_AND_CANDIDATE_REQUIRED')
    save_new(RELEASE / 'before.js', live)
    save_new(RELEASE / 'apply-started.json', json.dumps({'before': BEFORE, 'after': AFTER, 'at': datetime.now(timezone.utc).isoformat()}).encode())
    replace(candidate, info)
    result = {'status': 'FORMS_FULLSCREEN_ONE_STATIC_FILE_APPLIED', 'before': BEFORE, 'after': AFTER, 'bytes': len(candidate), 'lease': LEASE, 'serviceRestarts': 0, 'databaseWrites': 0, 'at': datetime.now(timezone.utc).isoformat()}
    save_new(RELEASE / 'applied.json', json.dumps(result).encode())
    print(json.dumps(result))
else:
    backup, _ = read_regular(RELEASE / 'before.js', 16000)
    if digest(live) != AFTER or digest(backup) != BEFORE:
        raise RuntimeError('EXACT_INSTALLED_AND_BACKUP_REQUIRED')
    save_new(RELEASE / 'rollback-started.json', b'{}')
    replace(backup, info)
    save_new(RELEASE / 'rolled-back.json', b'{"status":"ONE_STATIC_FILE_RESTORED"}')
    print('ONE_STATIC_FILE_RESTORED')
