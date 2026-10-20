"""Explicit, one-attempt code staging only; never runtime authorization."""
import sys
sys.dont_write_bytecode = True
import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import ssl
import stat
import subprocess
import time
import urllib.request
import zipfile

NAME = 'report-day-source20-cache-20261020-r1'
ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
LOCK = '/opt/synapse/.palitra-app-release.lock'
RELEASED_PIDS = frozenset({3161783, 3196874, 3200094, 3202295})
ZIP_SHA = 'cc330d71455321c1e102a4c83f89aee30b9340044365e49f0ec23a76b6e8ec82'
PREPARE_SHA = '2973af9c6108134dbf4e6d4948cd26c640c573a0338f55aa12ccb4461d907f44'
MANIFEST_SHA = 'af27d93d443302d70f80e1228e73dc9c05b295cd2418e6d7d40f5c7122454f7d'
ENTRY_SHA = '20808ae4aaaecbe2eec53d13fe8613fa1b17b42bbdba573c9465a45cbddb393f'
FILES = {
    'company-app.py': {'bytes': 3957, 'sha256': ENTRY_SHA},
    'content-db.py': {'bytes': 7788, 'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be'},
    'controller.py': {'bytes': 14806, 'sha256': '96710b3b02f1dda00ba234ddbc0f8997eefa288124c865a7e1d64b868f7fa77f'},
    'manifest.json': {'bytes': 2043, 'sha256': MANIFEST_SHA},
    'native.py': {'bytes': 24074, 'sha256': '81c06fb50820ac4507766d5c1540cc0b34945813b180718d6d37f24dd0167874'},
    'parent-darya-r2.py': {'bytes': 9414, 'sha256': '664b6369c8251b61a1ab3d9a0baa5a5c71998fbdd44404f21cdb19d93853c756'},
    'payload/customer-report-cache.cjs': {'bytes': 12842, 'sha256': '5fb7f5ca7f897d04bd2c4907ad8422122209fa1df37d2a8a52b5fcdb4fbf7e70'},
    'report-db.py': {'bytes': 7626, 'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63'},
    'rollback-plan.py': {'bytes': 3491, 'sha256': 'f156f6837fabf64a184a8a25766c65d2b85cf54d8bb81adfbf617fe134cbac4c'},
    'traffic-db.py': {'bytes': 12391, 'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'},
}
MAX_ZIP = 4 * 1024 * 1024
MAX_PREPARE = 65536
DOWNLOAD_SECONDS = 60
NOFOLLOW = getattr(os, 'O_NOFOLLOW', None)


def need(ok, code):
    if not ok:
        raise ValueError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def platform_guard():
    need(os.name == 'posix' and os.geteuid() == os.getegid() == 0
         and NOFOLLOW is not None, 'POSIX_ROOT_REQUIRED')


def facts(path):
    return os.lstat(path)


def opened(fd):
    return os.fstat(fd)


def identity(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid,
            s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def directory(path, private=False):
    s = facts(path)
    need(stat.S_ISDIR(s.st_mode) and s.st_uid == s.st_gid == 0
         and not stat.S_IMODE(s.st_mode) & 0o022
         and (not private or stat.S_IMODE(s.st_mode) == 0o700),
         'EXACT_ROOT_DIRECTORY_REQUIRED')
    return (s.st_dev, s.st_ino, s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode))


def path_guard(path):
    need(path.is_absolute(), 'ABSOLUTE_PATH_REQUIRED')
    for parent in reversed((path.parent, *path.parent.parents)):
        directory(parent)


def absent(path):
    need(not os.path.lexists(path), 'PRIOR_ATTEMPT_REFUSED_NO_RETRY')


def private_read(path, maximum):
    path_guard(path)
    before = facts(path)
    need(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0
         and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o600
         and 0 < before.st_size <= maximum, 'PRIVATE_SINGLE_REGULAR_FILE_REQUIRED')
    fd = os.open(path, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK)
    try:
        need(identity(opened(fd)) == identity(before), 'PRIVATE_FILE_OPEN_CHANGED')
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            raw = handle.read(maximum + 1)
        need(len(raw) == before.st_size and len(raw) <= maximum
             and identity(opened(fd)) == identity(before)
             and identity(facts(path)) == identity(before), 'PRIVATE_FILE_CHANGED')
        return raw
    finally:
        os.close(fd)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path, raw):
    path_guard(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(fd)
        need(private_read(path, max(1, len(raw))) == raw, 'EXCLUSIVE_WRITE_CHANGED')
    finally:
        os.close(fd)
    sync_directory(path.parent)


def lease(pid):
    need(type(pid) is int and 1 < pid <= 2 ** 31 - 1 and pid not in RELEASED_PIDS,
         'FRESH_EXPLICIT_LEASE_PID_REQUIRED')
    try:
        result = subprocess.run(['lslocks', '--noheadings', '--output', 'PID,PATH'],
                                check=True, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=10)
        need(type(result.stdout) is bytes and len(result.stdout) <= 1048576,
             'BOUNDED_LEASE_OUTPUT_REQUIRED')
        rows = [line.strip().split(maxsplit=1)
                for line in result.stdout.decode('utf-8', 'strict').splitlines()]
        matching = [row for row in rows if len(row) == 2 and row[1] == LOCK]
        need(matching == [[str(pid), LOCK]], 'EXACT_OWN_FRESH_LEASE_REQUIRED')
    except ValueError:
        raise
    except Exception:
        raise ValueError('LEASE_READ_REFUSED') from None


def urls(commit):
    need(type(commit) is str and re.fullmatch('[0-9a-f]{40}', commit) is not None,
         'IMMUTABLE_COMMIT_REQUIRED')
    base = ('https://raw.githubusercontent.com/Elk0980/synapse-server/'
            + commit + '/ops/palitra-report-day-source20-20261020-r1/')
    return {'installer-code.zip': base + 'installer-code.zip',
            'prepare.py': base + 'prepare.py'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('REDIRECT_REFUSED')


def download(url, allowed, maximum):
    need(url in allowed and url.startswith('https://raw.githubusercontent.com/'),
         'CLOSED_DOWNLOAD_URL_REQUIRED')
    # No environment proxy/credentials, redirects, cookies, or alternate hosts.
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    started = time.monotonic()
    try:
        request = urllib.request.Request(url, headers={
            'User-Agent': 'Synapse-Report-Cache-Code-Stage/1',
            'Accept': 'application/octet-stream', 'Accept-Encoding': 'identity'})
        with opener.open(request, timeout=DOWNLOAD_SECONDS) as response:
            need(response.status == 200 and response.geturl() == url,
                 'EXACT_TLS_RESPONSE_REQUIRED')
            length = response.headers.get('Content-Length')
            need(length is None or (re.fullmatch('[0-9]+', length) is not None
                 and 0 < int(length) <= maximum), 'BOUNDED_DOWNLOAD_LENGTH_REQUIRED')
            need(response.headers.get('Content-Encoding', 'identity') == 'identity',
                 'ENCODED_RESPONSE_REFUSED')
            chunks = []
            total = 0
            while True:
                remaining = DOWNLOAD_SECONDS - (time.monotonic() - started)
                need(remaining > 0, 'DOWNLOAD_DEADLINE_EXCEEDED')
                # HTTPResponse's single socket read obeys the remaining total budget.
                sock = response.fp.raw._sock
                sock.settimeout(remaining)
                chunk = response.read1(min(65536, maximum - total + 1))
                need(type(chunk) is bytes, 'BINARY_DOWNLOAD_REQUIRED')
                if not chunk:
                    break
                total += len(chunk)
                need(total <= maximum, 'DOWNLOAD_TOO_LARGE')
                chunks.append(chunk)
                if length is not None and total == int(length):
                    break
            need(time.monotonic() - started <= DOWNLOAD_SECONDS and total > 0
                 and (length is None or total == int(length)), 'COMPLETE_BOUNDED_DOWNLOAD_REQUIRED')
            return b''.join(chunks)
    except ValueError:
        raise
    except Exception:
        raise ValueError('DOWNLOAD_REFUSED_OR_UNKNOWN_NO_RETRY') from None


def checked_zip(raw):
    need(type(raw) is bytes and 0 < len(raw) <= MAX_ZIP and sha(raw) == ZIP_SHA,
         'EXACT_CLOSED_ZIP_REQUIRED')
    result = {}
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            names = [info.filename for info in entries]
            need(len(names) == 10 and len(set(names)) == 10 and set(names) == set(FILES),
                 'CLOSED_UNIQUE_TEN_FILES_REQUIRED')
            for info in entries:
                path = PurePosixPath(info.filename)
                need(not path.is_absolute() and '..' not in path.parts
                     and '\\' not in info.filename and path.as_posix() == info.filename,
                     'ZIP_PATH_REFUSED')
                record = FILES[info.filename]
                need(not info.is_dir() and stat.S_ISREG(info.external_attr >> 16)
                     and info.flag_bits & 1 == 0 and info.file_size == record['bytes']
                     and 0 < info.file_size <= MAX_ZIP, 'BOUNDED_REGULAR_ZIP_ENTRY_REQUIRED')
                value = archive.read(info)
                need(len(value) == record['bytes'] and sha(value) == record['sha256'],
                     'EXACT_INNER_FILE_REQUIRED')
                result[info.filename] = value
    except ValueError:
        raise
    except Exception:
        raise ValueError('ZIP_VALIDATION_REFUSED') from None
    return result


def execute_prepare(prepare_path, archive_path, expected_raw):
    # Execute only the already pinned local module, once, in this interpreter.
    raw = private_read(prepare_path, MAX_PREPARE)
    need(raw == expected_raw and sha(raw) == PREPARE_SHA, 'EXACT_PREPARE_REQUIRED')
    old_argv, old_bytecode = sys.argv, sys.dont_write_bytecode
    try:
        sys.argv = [str(prepare_path), str(archive_path)]
        sys.dont_write_bytecode = True
        namespace = {'__name__': '_report_cache_exact_prepare', '__file__': str(prepare_path)}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(raw, str(prepare_path), 'exec'), namespace)
            need(namespace.get('FILES') == FILES and namespace.get('ZIP_SHA') == ZIP_SHA,
                 'PREPARE_BINDING_REQUIRED')
            namespace['main']()
    finally:
        sys.argv = old_argv
        sys.dont_write_bytecode = old_bytecode


def staged_guard(code, unpacked):
    directory(code, private=True)
    directory(code / 'payload', private=True)
    actual = {p.relative_to(code).as_posix() for p in code.rglob('*')}
    need(actual == set(FILES) | {'payload'}, 'STAGED_CODE_CLOSURE_REQUIRED')
    for name, value in unpacked.items():
        need(private_read(code / name, MAX_ZIP) == value, 'STAGED_CODE_BYTES_REQUIRED')


def stage(pid, commit):
    platform_guard()
    downloads = urls(commit)
    code = ROOT / (NAME + '-code')
    folder = ROOT / (NAME + '-transport-r1')
    unknown = ROOT / (NAME + '-transport-r1-UNKNOWN.json')
    path_guard(ROOT / 'root-check')
    root_identity = directory(ROOT)
    for path in (code, folder, unknown):
        absent(path)
    lease(pid)
    intent = {'schema': 1, 'name': NAME, 'status': 'UNKNOWN_NO_AUTOMATIC_RETRY',
              'commit': commit, 'leasePid': pid, 'zipSha256': ZIP_SHA,
              'prepareSha256': PREPARE_SHA, 'runtimeWrites': 0,
              'atEpoch': int(time.time())}
    # The durable EXCL journal precedes even the staging-directory creation.
    write_new(unknown, encoded(intent))
    need(directory(ROOT) == root_identity, 'ROOT_DIRECTORY_CHANGED')
    os.mkdir(folder, 0o700)
    sync_directory(ROOT)
    folder_identity = directory(folder, private=True)
    raw = {}
    for name, maximum, pin in [('installer-code.zip', MAX_ZIP, ZIP_SHA),
                               ('prepare.py', MAX_PREPARE, PREPARE_SHA)]:
        lease(pid)
        need(directory(folder, private=True) == folder_identity, 'TRANSPORT_DIRECTORY_CHANGED')
        value = download(downloads[name], frozenset(downloads.values()), maximum)
        need(sha(value) == pin, 'EXACT_DOWNLOADED_FILE_REQUIRED')
        write_new(folder / name, value)
        raw[name] = value
    unpacked = checked_zip(raw['installer-code.zip'])
    need(private_read(unknown, 16384) == encoded(intent), 'UNKNOWN_JOURNAL_CHANGED')
    need(directory(ROOT) == root_identity and directory(folder, private=True) == folder_identity,
         'TRANSPORT_ROOT_CHANGED')
    need({p.name for p in folder.iterdir()} == {'installer-code.zip', 'prepare.py'},
         'TRANSPORT_CLOSURE_REQUIRED')
    for name, value in raw.items():
        need(private_read(folder / name, MAX_ZIP) == value, 'DOWNLOADED_BYTES_CHANGED')
    absent(code)
    lease(pid)
    execute_prepare(folder / 'prepare.py', folder / 'installer-code.zip', raw['prepare.py'])
    staged_guard(code, unpacked)
    lease(pid)
    need(private_read(unknown, 16384) == encoded(intent)
         and directory(ROOT) == root_identity and directory(folder, private=True) == folder_identity,
         'FINAL_TRANSPORT_BINDING_CHANGED')
    proof = {'schema': 1, 'name': NAME, 'status': 'CODE_STAGED_NOT_RUNTIME_AUTHORIZATION',
             'commit': commit, 'leasePid': pid, 'files': 10, 'runtimeWrites': 0,
             'databaseWrites': 0, 'zipSha256': ZIP_SHA, 'prepareSha256': PREPARE_SHA,
             'manifestSha256': MANIFEST_SHA, 'entrySha256': ENTRY_SHA,
             'filePinsSha256': sha(encoded(FILES)), 'unknownJournalSha256': sha(encoded(intent)),
             'atEpoch': int(time.time()), 'retryAllowed': False}
    write_new(folder / 'COMPLETED.json', encoded(proof))
    return proof


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('EXPLICIT_ARGUMENTS_REQUIRED')


def main(argv=None):
    try:
        parser = SafeParser(description='One-attempt code staging; no runtime actions')
        parser.add_argument('--lease-pid', required=True, type=int)
        parser.add_argument('--commit', required=True)
        args = parser.parse_args(argv)
        proof = stage(args.lease_pid, args.commit)
        print(json.dumps(proof, sort_keys=True))
        return 0
    except BaseException as error:
        code = str(error) if isinstance(error, ValueError) else ''
        if not re.fullmatch('[A-Z][A-Z0-9_]{0,100}', code):
            code = 'STAGE_REFUSED_OR_UNKNOWN_NO_AUTOMATIC_RETRY'
        print(json.dumps({'status': 'REFUSED_OR_UNKNOWN_NO_AUTOMATIC_RETRY',
                          'code': code, 'runtimeWrites': 0, 'databaseWrites': 0}, sort_keys=True))
        return 1


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    raise SystemExit(main())
