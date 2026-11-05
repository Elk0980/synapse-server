"""One-file, SHA-guarded UI update after the initial Palitra editor install."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

TARGET = Path('/opt/synapse/sites/synapse/palitra-editor.js')
BEFORE = 'a9ccdaef0d2a98ff801b9d0b0f02b74dc8bfee0156765d929dea12af864b0e46'
AFTER = '787bd664cc1f0b453adf3a7f85c246ce6103ca64c2ca127924cca2a3400760c3'

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
        raise SystemExit('Usage: patch-editor-timezone.py CANDIDATE EXISTING_DIR/NEW_BACKUP')
    print(json.dumps(apply(Path(sys.argv[1]), Path(sys.argv[2]))))
