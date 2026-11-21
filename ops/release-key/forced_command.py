#!/usr/bin/python3
"""Ограниченный SSH-вход для существующего /root/claude-rel; без shell=True."""
import base64
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import subprocess
import sys

ROOT = PurePosixPath('/root/claude-rel')
INSTALLED = Path('/usr/local/sbin/synapse-release-key')
TAG = 'synapse-release-codex-20261121'
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
NUMBER = r'[1-9][0-9]{0,5}'
SHA = r'[a-f0-9]{40}'
STATIC = r'sites/synapse/(?:cabinet\.html|cabinet/[a-z0-9][a-z0-9-]*\.(?:js|css))'
SOURCE = rf'(?:ops/(?:crm|content)/[a-z0-9][a-z0-9-]*\.js|{STATIC})'
BACKUP = r'/root/claude-rel/bk/[0-9]{8}T[0-9]{6}Z-pr[1-9][0-9]{0,5}(?:-[a-z0-9-]+)?'
VOLUMES = {'crm_data:crm.sqlite', 'content_data:content.sqlite'}
UNITS = {'synapse-sync.service', 'synapse-autosync.service'}


class Denied(ValueError):
    pass


def audit(kind, argv=None):
    """В syslog — только проверенные аргументы; отказ не раскрывает ввод."""
    import syslog
    record = {'event': 'accepted' if argv is not None else 'denied'}
    if argv is not None:
        record.update(kind=kind, argv=argv)
    syslog.openlog('synapse-release-key', syslog.LOG_PID, syslog.LOG_AUTHPRIV)
    syslog.syslog(syslog.LOG_INFO, json.dumps(record, separators=(',', ':')))


def all_match(pattern, values):
    return bool(values) and all(re.fullmatch(pattern, value) for value in values)


def plan(command):
    """Только синтаксический разбор; никаких файлов/сети/выполнения при импорте."""
    if not isinstance(command, str) or not command or len(command) > 4096 or any(c in command for c in '\r\n\x00'):
        raise Denied()
    try:
        a = shlex.split(command)
    except ValueError:
        raise Denied() from None
    if a == ['status']:
        return 'status', []
    if a == ['docker', 'ps']:
        return 'read', ['/usr/bin/docker', 'ps', '--format', '{{.ID}} {{.Names}} {{.Image}} {{.Status}}']
    if a == ['df', '-h', '/']:
        return 'read', ['/usr/bin/df', '-h', '/']
    if (len(a) == 9 and a[:2] == ['journalctl', '-u'] and a[2] in UNITS and a[3] == '-n'
            and a[4].isdigit() and 1 <= int(a[4]) <= 300 and a[5:] == ['--no-pager', '-o', 'cat', '--utc']):
        return 'read', ['/usr/bin/journalctl', *a[1:]]
    # Полные имена скриптов, ./имена и короткие имена означают один фиксированный файл.
    if a and a[0] in ('prpatch.sh', './prpatch.sh', str(ROOT / 'prpatch.sh')):
        if len(a) >= 5 and re.fullmatch(NUMBER, a[1]) and all_match(SHA, a[2:4]) and all_match(SOURCE, a[4:]) and len(a[4:]) <= 30 and len(set(a[4:])) == len(a[4:]):
            return 'release', ['/bin/bash', str(ROOT / 'prpatch.sh'), *a[1:]]
    if a and a[0] in ('prgo.sh', './prgo.sh', str(ROOT / 'prgo.sh')):
        if len(a) in (2, 3, 4) and re.fullmatch(NUMBER, a[1]) and all(s in ('crm', 'content') for s in a[2:]) and len(set(a[2:])) == len(a[2:]):
            return 'release', ['/bin/bash', str(ROOT / 'prgo.sh'), *a[1:]]
    if a and a[0] in ('rel.sh', './rel.sh', str(ROOT / 'rel.sh')):
        if len(a) >= 3 and a[1] == 'snap' and re.fullmatch(r'pr' + NUMBER + r'(?:-[a-z0-9-]+)?', a[2]) and (not a[3:] or all_match(STATIC, a[3:])) and len(a[3:]) <= 30:
            return 'release', ['/bin/bash', str(ROOT / 'rel.sh'), *a[1:]]
        if len(a) in (4, 5) and a[1] == 'dbsnap' and re.fullmatch(BACKUP, a[2]) and all(v in VOLUMES for v in a[3:]) and len(set(a[3:])) == len(a[3:]):
            return 'release', ['/bin/bash', str(ROOT / 'rel.sh'), *a[1:]]
    if len(a) == 1 and re.fullmatch(r'(?:\./|/root/claude-rel/)?w' + NUMBER + r'/rollback\.sh', a[0]):
        number = re.search(r'w(' + NUMBER + r')/rollback', a[0])[1]
        return 'release', ['/bin/bash', str(ROOT / ('w' + number) / 'rollback.sh')]
    raise Denied()


def trusted(path, directory=False):
    """Проверяет каждый компонент: root, без symlink и записи для группы/прочих."""
    path = Path(path)
    if not path.is_absolute():
        raise Denied()
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise Denied()
    info = path.lstat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise Denied()


def run(command):
    kind, argv = plan(command)
    trusted(ROOT, directory=True)
    if kind == 'status':
        audit(kind, argv)
        for item in ('docker ps', 'df -h /', 'journalctl -u synapse-autosync.service -n 8 --no-pager -o cat --utc'):
            code = run(item)
            if code:
                return code
        return 0
    if kind == 'release':
        import fcntl
        trusted(argv[1])
        lock = os.open('/run/lock/synapse-release-key.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(lock, 'a') as stream:
            info = os.fstat(stream.fileno())
            if info.st_uid != 0 or info.st_mode & 0o077:
                raise Denied()
            audit(kind, argv)
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print('RELEASE_BUSY', file=sys.stderr)
                return 75
            return subprocess.run(argv, cwd=ROOT, env=ENV, stdin=subprocess.DEVNULL, timeout=3600, check=False).returncode
    audit(kind, argv)
    return subprocess.run(argv, cwd=ROOT, env=ENV, stdin=subprocess.DEVNULL, timeout=45, check=False).returncode


def stage():
    if os.geteuid() != 0 or os.environ.get('SSH_CONNECTION') or os.environ.get('SSH_ORIGINAL_COMMAND'):
        raise Denied()
    trusted(INSTALLED.parent, directory=True)
    data = Path(__file__).read_bytes()
    if INSTALLED.exists():
        trusted(INSTALLED)
        if INSTALLED.read_bytes() != data:
            raise Denied()
    else:
        fd = os.open(INSTALLED, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
    print('WRAPPER_STAGED ' + str(INSTALLED))


def authorize(encoded):
    """Только локальная root-консоль; недостижимо через forced command."""
    if os.geteuid() != 0 or os.environ.get('SSH_CONNECTION') or os.environ.get('SSH_ORIGINAL_COMMAND'):
        raise Denied()
    if not re.fullmatch(r'[A-Za-z0-9+/]{68}', encoded):
        raise Denied()
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) != 51 or raw[:19] != b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20':
        raise Denied()
    trusted(INSTALLED)
    if INSTALLED.read_bytes() != Path(__file__).read_bytes():
        raise Denied()
    auth = Path('/root/.ssh/authorized_keys')
    trusted(auth)
    import fcntl
    fd = os.open(auth, os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW)
    with os.fdopen(fd, 'r+b') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        before = stream.read()
        if TAG.encode() in before or encoded.encode() in before:
            raise Denied()
        line = ('restrict,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc,'
                'command="/usr/bin/python3 -I /usr/local/sbin/synapse-release-key" '
                'ssh-ed25519 ' + encoded + ' ' + TAG + '\n').encode('ascii')
        prefix = b'' if not before or before.endswith(b'\n') else b'\n'
        # Один append под блокировкой; прежние строки и их режим не переписываются.
        if os.write(stream.fileno(), prefix + line) != len(prefix + line):
            os.ftruncate(stream.fileno(), len(before))
            raise OSError('short write')
        os.fsync(stream.fileno())
    print('RELEASE_KEY_AUTHORIZED tag=' + TAG)


def main():
    try:
        if sys.argv[1:] == ['--stage-wrapper']:
            stage()
            return 0
        if len(sys.argv) == 3 and sys.argv[1] == '--authorize-public-key':
            authorize(sys.argv[2])
            return 0
        if len(sys.argv) != 1:
            raise Denied()
        return run(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    except (Denied, ValueError):
        audit('denied')
        print('DENIED', file=sys.stderr)
        return 126
    except (OSError, subprocess.TimeoutExpired):
        # Не печатать секреты/окружение/непроверенную исходную команду в журнал.
        print('RELEASE_CHANNEL_ERROR', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
