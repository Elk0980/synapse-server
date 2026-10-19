"""One bounded read-only diagnostic after a refused R11 attempt. No replay."""
import hashlib, json, os, stat, sys, time, types
from pathlib import Path

ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
CODE = ROOT / 'multi-company-app-20261019-r11-code'
PIN = '003a25c904537b48444c2f73ad814e83ab1aa36522ae2bcea55c891c19a2bc46'
SHA = lambda b: hashlib.sha256(b).hexdigest()


def main():
    if os.name != 'posix' or os.geteuid() != 0 or sys.argv[1:] != ['3126443']:
        raise ValueError('EXACT_ROOT_DIAGNOSTIC_REQUIRED')
    path = CODE / 'release-native.py'
    if any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError('SYMLINK_REFUSED')
    st = path.lstat()
    raw = path.read_bytes()
    if SHA(raw) != PIN or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or not (st.st_uid == st.st_gid == 0) or stat.S_IMODE(st.st_mode) != 0o600:
        raise ValueError('EXACT_PRIVATE_FROZEN_CODE_REQUIRED')
    output = Path('/tmp/r11-diagnostic-3126443.json')
    if os.path.lexists(output):
        raise ValueError('DIAGNOSTIC_EXISTS_NO_REPLAY')
    m = types.ModuleType('r11_readonly_diagnostic')
    m.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), m.__dict__)
    a, b, prior, current = m.load_current_r7c(3126443)
    release = m.Release(a, b, prior, current, 3126443)
    release.lease()
    snap = release.snapshot()
    heart = b.heartbeat(snap['worker']['startedAt'], time.time())
    value = {
        'status': 'R11_REFUSAL_READONLY_DIAGNOSTIC',
        'baselineMatches': snap == release.base,
        'differentTopKeys': sorted(k for k in set(snap) | set(release.base) if snap.get(k) != release.base.get(k)),
        'heartbeat': {'freshAfterWorkerStart': heart.get('freshAfterWorkerStart'), 'returnedFieldNames': sorted(heart)},
        'contentImage': snap['containers']['content']['image'],
        'artifacts': {}, 'imageAliases': {}, 'runtimeWrites': 0,
    }
    for name, p in release.paths.items():
        row = {'exists': os.path.lexists(p), 'pendingExists': os.path.lexists(str(p) + '.pending')}
        if row['exists'] and p.is_file() and not p.is_symlink():
            data = a.read(p)
            row['sha256'] = SHA(data)
            if name == 'journal':
                journal = a.decode(data)
                row.update(phase=journal.get('phase'), writtenStaticCount=len(journal.get('written', [])), childImage=journal.get('childImage'))
        value['artifacts'][name] = row
    for alias in (m.NAME + '-base', m.NAME + '-content'):
        value['imageAliases'][alias] = bool(release.run(['docker', 'image', 'ls', '--quiet', '--filter', 'reference=' + alias]).strip())
    release.lease()
    encoded = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({**value, 'proofSha256': SHA(encoded)}, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'DIAGNOSTIC_REFUSED_NO_APPLY', 'error': str(error) if type(error) is ValueError else type(error).__name__}))
        sys.exit(2)
