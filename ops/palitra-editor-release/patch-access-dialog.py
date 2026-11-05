"""One-file, SHA-guarded UI update after the initial Palitra editor install."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

TARGET = Path('/opt/synapse/sites/synapse/cabinet/site-photos-access.js')
BEFORE = 'f62bd13a10215592812a83566a20666392cc6a71d6324bf08c38bd4072d95d5d'
AFTER = '06771895f1e5aa4fd53932277a90eaa038d9362fbcb1583a098661bd15625600'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def apply(candidate, backup):
    for item in (TARGET, candidate, backup.parent):
        for ancestor in (item, *item.parents):
            if ancestor.is_symlink():
                raise ValueError('Symbolic link rejected')
    if backup.exists():
        raise ValueError('Backup already exists; inspect the previous outcome')
    old, new = TARGET.read_bytes(), candidate.read_bytes()
    if digest(old) != BEFORE or digest(new) != AFTER:
        raise ValueError('Fresh source or candidate SHA mismatch')
    mode = TARGET.stat()
    with backup.open('xb') as output:
        output.write(old)
        output.flush()
        os.fsync(output.fileno())
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=TARGET.parent, prefix='.photo-access-', delete=False) as output:
            temporary = Path(output.name)
            output.write(new)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, stat.S_IMODE(mode.st_mode))
        if hasattr(os, 'chown'):
            os.chown(temporary, mode.st_uid, mode.st_gid)
        if digest(TARGET.read_bytes()) != BEFORE:
            raise ValueError('Source changed after backup; no replacement')
        os.replace(temporary, TARGET)
        temporary = None
        if digest(TARGET.read_bytes()) != AFTER:
            raise ValueError('Installed readback SHA mismatch')
        return {'status': 'applied', 'files': 1, 'sha256': AFTER, 'backup': str(backup), 'runtimeRestarted': False}
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: patch-access-dialog.py CANDIDATE EXISTING_DIR/NEW_BACKUP')
    print(json.dumps(apply(Path(sys.argv[1]), Path(sys.argv[2]))))
