"""Bounded cipher-only FIFO transport for the reviewed backup-v2 format.

The separately started root service produces bytes. The forced SSH reader only
reads root-owned metadata/FIFOs; it cannot start a service or read source data.
No plaintext tar or complete ciphertext archive is written on the server.
"""
import contextlib
import datetime as dt
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import sqlite3
import stat
import subprocess as sp
import sys
import tarfile
import tempfile
import threading
import time

if os.name != 'nt':
    import fcntl as _fcntl

import backup_v2 as b

TRANSPORT = 'stream-v1'
META = 'stream.json'
MARKER = '.stream-output.json'
META_LIMIT = 65536
MARGIN = 1024**3
BLOCK = 65536


class ConfigurationError(b.BackupError):
    """Permanent inventory/policy error: the service must not retry it forever."""


class NightComplete(b.BackupError):
    """The timer may start a new night; automatic restarts must stop now."""


def fail(code):
    raise b.BackupError(code)


def checked_path(path):
    path = Path(path)
    if not path.is_absolute() or any(p.is_symlink() for p in [path, *path.parents]):
        raise ConfigurationError('UNSAFE_DESTINATION')
    return path


def open_source(path, directory=False):
    """Bind every parent with openat/O_NOFOLLOW, not merely the final leaf."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        fail('SOURCE_CHANGED')
    parent = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        if path == Path(path.anchor):
            return os.dup(parent)
        for component in path.parts[1:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = next_fd
        return os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if directory else 0), dir_fd=parent)
    finally:
        os.close(parent)


class SQLiteSourceBinding:
    """SQLite needs its real WAL path. Verify its opened FDs against pinned data.

    Do not substitute /proc/self/fd/main for the SQLite URI: that can hide WAL.
    Instead pin the real source through no-follow parent FDs, then fail before
    export if SQLite opened a different inode or an outside sidecar. The same
    check runs during VACUUM as well as before/after it.
    """
    def __init__(self, source, target):
        self.source, self.target = source, target
        self.parent = open_source(source.parent, directory=True)
        self.pin = None
        try:
            self.pin = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.parent)
            info = os.fstat(self.pin)
            if not stat.S_ISREG(info.st_mode):
                fail('SOURCE_CHANGED')
            self.main = (info.st_dev, info.st_ino)
            self.allowed = {self.main}
            self.initial = self.fds()
        except BaseException:
            self.close()
            raise

    @staticmethod
    def fds():
        result = {}
        for name in os.listdir('/proc/self/fd'):
            try:
                info = os.fstat(int(name))
            except (OSError, ValueError):
                continue
            result[int(name)] = info
        return result

    def verify(self, maximum):
        for suffix in ['', '-wal', '-shm', '-journal']:
            try:
                info = os.stat(self.source.name + suffix, dir_fd=self.parent, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode):
                fail('SOURCE_CHANGED')
            self.allowed.add((info.st_dev, info.st_ino))
            if not suffix and (info.st_dev, info.st_ino) != self.main:
                fail('SOURCE_CHANGED')
        found, private = False, {}
        for fd, info in self.fds().items():
            if not stat.S_ISREG(info.st_mode):
                continue
            identity = (info.st_dev, info.st_ino)
            old = self.initial.get(fd)
            if old is not None and (old.st_dev, old.st_ino) == identity:
                continue
            if identity in self.allowed:
                found = found or identity == self.main
                continue
            link = os.readlink('/proc/self/fd/' + str(fd)).removesuffix(' (deleted)')
            if Path(link).parent != self.target.parent:
                fail('SOURCE_CHANGED')
            private[identity] = info.st_size
        if not found:
            fail('SOURCE_CHANGED')
        if sum(private.values()) > maximum:
            fail('NO_SPACE_SERVER')

    def close(self):
        if self.pin is not None:
            os.close(self.pin)
            self.pin = None
        os.close(self.parent)


def root_entry(path, kind='file'):
    path = checked_path(path)
    info = path.lstat()
    expected = {'file': stat.S_ISREG, 'directory': stat.S_ISDIR, 'fifo': stat.S_ISFIFO}[kind]
    if not expected(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o027:
        raise ConfigurationError('UNSAFE_DESTINATION')
    if kind != 'directory' and info.st_nlink != 1:
        raise ConfigurationError('UNSAFE_DESTINATION')
    return info


def atomic_metadata(path, value, gid):
    path = checked_path(path)
    data = json.dumps(value, ensure_ascii=False, sort_keys=True).encode() + b'\n'
    if len(data) > META_LIMIT:
        fail('BAD_RECEIPT')
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.chown(temporary, 0, gid)
        os.chmod(temporary, 0o640)
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_metadata(path):
    info = root_entry(path)
    if info.st_size > META_LIMIT:
        fail('BAD_RECEIPT')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        now = os.fstat(fd)
        if (now.st_dev, now.st_ino) != (info.st_dev, info.st_ino):
            fail('UNSAFE_DESTINATION')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return json.loads(stream.read(META_LIMIT + 1))
    finally:
        os.close(fd)


def duration(c, key, default, maximum):
    value = c.get(key, default)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 < value <= maximum:
        raise ConfigurationError('CREATE_FAILED')
    return float(value)


def time_left(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        fail('STREAM_TIMEOUT')
    return value


class Children:
    """Track and terminate only processes started by this backup attempt."""
    def __init__(self):
        self.items = []
        self.guard = threading.Lock()
        self.closed = False

    def start(self, args, **kwargs):
        with self.guard:
            if self.closed:
                fail('CREATE_FAILED')
            proc = sp.Popen(args, start_new_session=os.name != 'nt', **kwargs)
            self.items.append(proc)
        return proc

    def stop(self, proc):
        if proc.poll() is None:
            if os.name != 'nt':
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGTERM)
            else:
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except sp.TimeoutExpired:
                if os.name != 'nt':
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(proc.pid, signal.SIGKILL)
                else:
                    proc.kill()
                proc.wait(timeout=5)
        else:
            proc.wait()

    def close(self):
        with self.guard:
            self.closed = True
            items = list(self.items)
        for proc in reversed(items):
            self.stop(proc)


def _write_all(fd, data, deadline, stall):
    view = memoryview(data)
    last = time.monotonic()
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_WRITE)
        while view:
            remaining = min(time_left(deadline), stall - (time.monotonic() - last))
            if remaining <= 0:
                fail('STREAM_STALLED')
            try:
                count = os.write(fd, view)
            except BlockingIOError:
                selector.select(min(remaining, 0.25))
                continue
            if count <= 0:
                fail('STREAM_DISCONNECTED')
            view = view[count:]
            last = time.monotonic()


def _writer(fifo, deadline):
    info = root_entry(fifo, 'fifo')
    while True:
        time_left(deadline)
        try:
            fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        except OSError as error:
            if error.errno != errno.ENXIO:
                raise
            time.sleep(min(0.1, time_left(deadline)))
            continue
        now = os.fstat(fd)
        if not stat.S_ISFIFO(now.st_mode) or (now.st_dev, now.st_ino) != (info.st_dev, info.st_ino):
            os.close(fd)
            fail('UNSAFE_DESTINATION')
        return fd


def stream_cipher(c, fifo, producer, deadline, on_connected=None, children=None):
    """producer writes plaintext only to age.stdin; the main loop pumps cipher."""
    owned = children or Children()
    fifo_fd = _writer(fifo, min(deadline, time.monotonic() + duration(c, 'stream_reader_wait_seconds', 10800, 21600)))
    proc = None
    worker = None
    errors = []
    finished = threading.Event()
    done_at = None
    digest, size = hashlib.sha256(), 0
    success = False
    try:
        if on_connected:
            on_connected()
        proc = owned.start([c.get('age', 'age'), '-r', c['recipient']], stdin=sp.PIPE, stdout=sp.PIPE, stderr=sp.DEVNULL)
        def feed():
            try:
                producer(proc.stdin)
            except BaseException as error:
                errors.append(error)
            finally:
                with contextlib.suppress(BrokenPipeError, OSError):
                    proc.stdin.close()
                finished.set()
        worker = threading.Thread(target=feed, name='backup-age-input', daemon=True)
        worker.start()
        os.set_blocking(proc.stdout.fileno(), False)
        stall = duration(c, 'stream_stall_seconds', 120, 1800)
        bound = int(c['_remaining_cipher_bytes'])
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            while True:
                time_left(deadline)
                if errors:
                    raise errors[0]
                if finished.is_set():
                    done_at = done_at or time.monotonic()
                    if time.monotonic() - done_at > max(stall, 30):
                        fail('STREAM_TIMEOUT')
                try:
                    chunk = os.read(proc.stdout.fileno(), BLOCK)
                except BlockingIOError:
                    selector.select(min(time_left(deadline), 0.1))
                    continue
                if not chunk:
                    break
                size += len(chunk)
                if size > bound:
                    fail('RESTORE_BUDGET_EXCEEDED')
                _write_all(fifo_fd, chunk, deadline, stall)
                digest.update(chunk)
                if finished.is_set():
                    done_at = time.monotonic()
        worker.join(timeout=min(time_left(deadline), 5))
        if worker.is_alive() or errors or proc.wait(timeout=min(time_left(deadline), 5)) != 0 or not size:
            fail('CREATE_FAILED')
        success = True
        return {'sha256': digest.hexdigest(), 'bytes': size}
    finally:
        # Killing age breaks blocked stdin; killing docker/snapshot releases feed.
        if not success or children is None:
            owned.close()
        elif proc is not None:
            owned.stop(proc)
        if worker is not None:
            worker.join(timeout=5)
        if proc is not None:
            for stream in [proc.stdin, proc.stdout]:
                with contextlib.suppress(OSError):
                    stream.close()
        os.close(fifo_fd)


def _snapshot_worker(source, target, maximum, margin, deadline):
    """Dedicated Linux child: VACUUM cannot exceed its hard file-size quota."""
    if os.name == 'nt' or os.geteuid() != 0:
        raise ConfigurationError('CREATE_FAILED')
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))
    source, target = checked_path(source), checked_path(target)
    if target.exists() or target.is_symlink():
        fail('UNSAFE_DESTINATION')
    binding = SQLiteSourceBinding(source, target)
    try:
        with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
            db.execute('PRAGMA busy_timeout=5000')
            if db.execute('PRAGMA page_count').fetchone()[0] * db.execute('PRAGMA page_size').fetchone()[0] > maximum:
                fail('NO_SPACE_SERVER')
            binding.verify(maximum)
            def cancel():
                try:
                    binding.verify(maximum)
                    return int(time.monotonic() >= deadline or shutil.disk_usage(target.parent).free < margin
                               or target.exists() and target.stat().st_size > maximum)
                except (b.BackupError, OSError):
                    return 1
            db.set_progress_handler(cancel, 1000)
            db.execute('VACUUM INTO ?', (str(target),))
            binding.verify(maximum)
    finally:
        binding.close()
    target.chmod(0o600)
    if target.stat().st_size > maximum:
        fail('NO_SPACE_SERVER')
    with contextlib.closing(sqlite3.connect(target.as_uri() + '?mode=ro', uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or db.execute('PRAGMA foreign_key_check').fetchall():
            fail('BAD_SHA')


def snapshot_one(source, target, max_bytes, margin, deadline, children=None):
    owned = children or Children()
    if shutil.disk_usage(Path(target).parent).free < max_bytes + margin:
        fail('NO_SPACE_SERVER')
    proc = owned.start([sys.executable, str(Path(__file__).resolve()), '_snapshot', str(source), str(target),
                        str(max_bytes), str(margin), str(deadline)], stdout=sp.DEVNULL, stderr=sp.DEVNULL,
                       env=dict(os.environ, SQLITE_TMPDIR=str(Path(target).parent), TMPDIR=str(Path(target).parent)))
    try:
        if proc.wait(timeout=min(time_left(deadline), 1800)) != 0:
            fail('CREATE_FAILED')
        if not Path(target).is_file() or Path(target).stat().st_size > max_bytes:
            fail('NO_SPACE_SERVER')
    finally:
        owned.stop(proc)


def _facts(metadata):
    return [{k: row[k] for k in ['Id', 'Image', 'Name', 'Config', 'Mounts']}
            | {'StartedAt': row['State']['StartedAt'], 'RestartCount': row['RestartCount']}
            for row in sorted(metadata, key=lambda x: x['Id'])]


def inventory(c):
    """Reuse accepted root/mount/link policy. No hidden exclusions are added."""
    def budget():
        return min(30, time_left(c['_night_deadline'])) if '_night_deadline' in c else 30
    budget()
    roots = [checked_path(Path(x).absolute()).resolve() for x in c['roots']]
    output, scratch = checked_path(Path(c['output']).absolute()), checked_path(Path(c['scratch_dir']).absolute())
    if not roots or any(not p.is_dir() or p == Path('/') for p in roots):
        raise ConfigurationError('CREATE_FAILED')
    if any(a != z and a.is_relative_to(z) for a in roots for z in roots):
        raise ConfigurationError('CREATE_FAILED')
    if any(output.is_relative_to(p) or p.is_relative_to(output) or scratch.is_relative_to(p) or p.is_relative_to(scratch) for p in roots):
        raise ConfigurationError('UNSAFE_DESTINATION')
    if scratch.is_relative_to(output) or output.is_relative_to(scratch):
        raise ConfigurationError('UNSAFE_DESTINATION')
    maximum, bound = int(c['max_single_sqlite_bytes']), int(c['max_bundle_bytes'])
    if min(maximum, bound) <= 0:
        raise ConfigurationError('NO_SPACE_SERVER')
    ids = b.run(['docker', 'ps', '-q'], capture_output=True, text=True, timeout=budget()).stdout.split()
    metadata = json.loads(b.run(['docker', 'inspect', *ids], capture_output=True, timeout=budget()).stdout) if ids else []
    if {x['Name'].lstrip('/') for x in metadata} != set(c['containers']):
        raise ConfigurationError('CREATE_FAILED')
    for item in metadata:
        for mount in item['Mounts']:
            source = Path(mount['Source']).resolve()
            if mount['Type'] not in ('bind', 'volume') or not any(source.is_relative_to(root) for root in roots):
                raise ConfigurationError('CREATE_FAILED')
    entries, databases, total = [], set(), 0
    for root in roots:
        paths = []
        for path in root.rglob('*'):
            budget()
            paths.append(path)
        for path in sorted(paths):
            budget()
            if path.is_symlink():
                try:
                    b.link_target(path, roots)
                except ValueError as error:
                    raise ConfigurationError('LINK_OUTSIDE_ROOTS') from error
            elif path.is_file():
                initial = path.lstat()
                with os.fdopen(open_source(path), 'rb') as stream:
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or (initial.st_dev, initial.st_ino) != (info.st_dev, info.st_ino):
                        fail('SOURCE_CHANGED')
                    sqlite = stream.read(16) == b'SQLite format 3\0'
                    after = os.fstat(stream.fileno())
                    if (info.st_size, info.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        fail('SOURCE_CHANGED')
                total += info.st_size
                if sqlite:
                    databases.add(path)
                    if info.st_size > maximum:
                        raise ConfigurationError('NO_SPACE_SERVER')
            elif not path.is_dir():
                raise ConfigurationError('CREATE_FAILED')
            entries.append(path)
    images = sorted({x['Image'] for x in metadata})
    if not images:
        raise ConfigurationError('CREATE_FAILED')
    sizes = json.loads(b.run(['docker', 'image', 'inspect', *images], capture_output=True, timeout=budget()).stdout)
    budget()
    total += sum(x['Size'] for x in sizes)
    if total * 1.1 > bound:
        raise ConfigurationError('NO_SPACE_SERVER')
    return {'roots': roots, 'entries': entries, 'databases': databases, 'metadata': metadata,
            'images': images, 'raw_bytes': total, 'max_snapshot': maximum, 'bound': bound}


def _same_inventory(expected, fresh, same_databases=False):
    if (fresh['roots'] != expected['roots'] or fresh['bound'] != expected['bound']
            or fresh['max_snapshot'] != expected['max_snapshot'] or fresh['images'] != expected['images']
            or _facts(fresh['metadata']) != _facts(expected['metadata'])
            or same_databases and fresh['databases'] != expected['databases']):
        fail('SOURCE_CHANGED')


def _data_producer(c, inv, scratch, children, deadline, name, refresh=None):
    def members():
        # Snapshot/stream/delete each DB BEFORE the filesystem catalogue. New
        # attachments committed while a PC was offline are not omitted by an
        # hours-old offer catalogue. No two SQL snapshots coexist.
        yield from sorted(inv['databases'])
        if refresh is not None:
            fresh = refresh()
            _same_inventory(inv, fresh, same_databases=True)
            inv.update(fresh)
        for path in inv['entries']:
            if path not in inv['databases']:
                yield path
    def tar_info(arc, info, kind):
        value = tarfile.TarInfo(arc)
        value.uid, value.gid, value.mode, value.mtime = info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_mtime
        value.type = kind
        value.size = info.st_size if kind == tarfile.REGTYPE else 0
        return value
    def produce(pipe):
        inv['streamed_data_bytes'] = 0
        manifest = {'schema': 2, 'created': name, 'roots': [str(x) for x in inv['roots']], 'files': {}, 'sqlite': []}
        with tarfile.open(fileobj=pipe, mode='w|gz', dereference=False) as archive:
            for original in members():
                time_left(deadline)
                if any(str(original) == str(db) + suffix for db in inv['databases'] for suffix in ['-wal', '-shm', '-journal']):
                    continue
                snapshot = scratch / 'snapshot.sqlite'
                source = original
                try:
                    if original in inv['databases']:
                        if any(scratch.iterdir()):
                            fail('CREATE_FAILED')
                        snapshot_one(original, snapshot, inv['max_snapshot'], MARGIN, deadline, children)
                        source = snapshot
                    arc = 'rootfs/' + original.as_posix().lstrip('/')
                    parent_fd = open_source(source.parent, directory=True)
                    try:
                        live = os.stat(source.name, dir_fd=parent_fd, follow_symlinks=False)
                        raw_link = os.readlink(source.name, dir_fd=parent_fd) if stat.S_ISLNK(live.st_mode) else None
                    finally:
                        os.close(parent_fd)
                    if raw_link is not None:
                        target = Path(os.path.normpath(raw_link if os.path.isabs(raw_link) else original.parent / raw_link))
                        if not any(target.is_relative_to(root) for root in inv['roots']):
                            fail('LINK_OUTSIDE_ROOTS')
                        info = tar_info(arc, live, tarfile.SYMTYPE)
                        info.linkname = os.path.relpath(target, original.parent).replace(os.sep, '/')
                        archive.addfile(info)
                    elif stat.S_ISREG(live.st_mode):
                        fd = open_source(source)
                        with os.fdopen(fd, 'rb') as stream:
                            before = os.fstat(stream.fileno())
                            if not stat.S_ISREG(before.st_mode) or (before.st_dev, before.st_ino) != (live.st_dev, live.st_ino):
                                fail('SOURCE_CHANGED')
                            info = tar_info(arc, before, tarfile.REGTYPE)
                            reader = b.HashReader(stream)
                            archive.addfile(info, reader)
                            inv['streamed_data_bytes'] += info.size
                            after = os.fstat(stream.fileno())
                            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                                fail('SOURCE_CHANGED')
                            manifest['files'][arc] = reader.digest.hexdigest()
                        if original in inv['databases']:
                            manifest['sqlite'].append(arc)
                    elif stat.S_ISDIR(live.st_mode):
                        fd = open_source(source, directory=True)
                        try:
                            now = os.fstat(fd)
                            if (now.st_dev, now.st_ino) != (live.st_dev, live.st_ino):
                                fail('SOURCE_CHANGED')
                            archive.addfile(tar_info(arc, now, tarfile.DIRTYPE))
                        finally:
                            os.close(fd)
                    else:
                        fail('SOURCE_CHANGED')
                finally:
                    # At most this ONE plaintext database; tar has handed all its
                    # bytes into age before the next snapshot can be created.
                    for suffix in ['', '-wal', '-shm', '-journal']:
                        with contextlib.suppress(FileNotFoundError):
                            Path(str(snapshot) + suffix).unlink()
            for arc, value in [('manifest.json', manifest), ('containers.json', inv['metadata'])]:
                data = json.dumps(value).encode()
                info = tarfile.TarInfo(arc)
                info.size, info.mode = len(data), 0o600
                archive.addfile(info, io.BytesIO(data))
                inv['streamed_data_bytes'] += len(data)
    return produce


def _prepare_output(c):
    import grp
    output = checked_path(Path(c['output']).absolute())
    gid = grp.getgrnam(c['reader_group']).gr_gid
    if not output.exists():
        output.mkdir(mode=0o750)
        os.chown(output, 0, gid)
        output.chmod(0o750)
    info = root_entry(output, 'directory')
    if stat.S_IMODE(info.st_mode) != 0o750 or info.st_gid != gid:
        raise ConfigurationError('UNSAFE_DESTINATION')
    marker = output / MARKER
    if not marker.exists():
        if list(output.iterdir()):
            raise ConfigurationError('UNSAFE_DESTINATION')
        atomic_metadata(marker, {'schema': 1, 'transport': TRANSPORT}, gid)
    if read_metadata(marker) != {'schema': 1, 'transport': TRANSPORT}:
        raise ConfigurationError('UNSAFE_DESTINATION')
    return output, gid


def _session(output, name):
    if not b.ID.fullmatch(name):
        fail('BAD_RECEIPT')
    directory = output / name
    root_entry(directory, 'directory')
    return directory


def cleanup_sessions(output, keep=4):
    """Only old terminal metadata/FIFOs in this marked transport namespace."""
    sessions = sorted((p for p in output.iterdir() if b.ID.fullmatch(p.name)), reverse=True)
    for directory in sessions[keep:]:
        root_entry(directory, 'directory')
        state = read_metadata(directory / META)
        if state.get('state') not in ['COMMITTED', 'FAILED'] and time.time() < state.get('expires_at', 0):
            continue
        allowed = {META, 'receipt.json', *b.FILES, *['.' + x + '.lock' for x in b.FILES]}
        for path in directory.iterdir():
            if path.name not in allowed:
                raise ConfigurationError('UNSAFE_DESTINATION')
            root_entry(path, 'fifo' if path.name in b.FILES else 'file')
        for path in directory.iterdir():
            path.unlink()
        directory.rmdir()


def retire_interrupted_sessions(output, gid):
    # Caller holds the same writer flock. A previous root producer is gone;
    # never advertise its one-shot FIFOs as resumable after a service restart.
    for directory in output.iterdir():
        if not b.ID.fullmatch(directory.name):
            continue
        root_entry(directory, 'directory')
        if not (directory / META).exists():
            if list(directory.iterdir()):
                raise ConfigurationError('UNSAFE_DESTINATION')
            directory.rmdir()
            continue
        state = _reader_state(directory)
        if state['state'] not in ['COMMITTED', 'FAILED']:
            state.update(state='FAILED', error='STREAM_INTERRUPTED')
            atomic_metadata(directory / META, state, gid)
        for filename in b.FILES:
            path = directory / filename
            if path.exists() or path.is_symlink():
                root_entry(path, 'fifo')
                path.unlink()


def bangkok_day(name=None):
    if name is None:
        value = dt.datetime.now(dt.timezone.utc)
    else:
        if not isinstance(name, str) or not b.ID.fullmatch(name):
            fail('BAD_RECEIPT')
        try:
            value = dt.datetime.strptime(name[8:], '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
        except ValueError:
            fail('BAD_RECEIPT')
    return value.astimezone(dt.timezone(dt.timedelta(hours=7))).date().isoformat()


def night_window():
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=7)))
    end = now.replace(hour=6, minute=0, second=0, microsecond=0)
    return 1 <= now.hour < 6, max(0.0, (end - now).total_seconds())


def server_daily_success(c, output, gid):
    """No success inference from a FIFO EOF or a server-only receipt."""
    marker = output / '.daily-success.json'
    today = bangkok_day()
    if marker.exists() or marker.is_symlink():
        saved = read_metadata(marker)
        if (saved.get('day') == today and saved.get('transport') == TRANSPORT
                and isinstance(saved.get('id'), str) and b.ID.fullmatch(saved['id'])
                and bangkok_day(saved.get('id')) == today
                and re.fullmatch('[a-f0-9]{64}', saved.get('receipt_sha', ''))):
            return True
    if not c.get('board_endpoint_file'):
        return False
    for path in sorted(output.iterdir(), reverse=True):
        if not b.ID.fullmatch(path.name) or bangkok_day(path.name) != today:
            continue
        directory = _session(output, path.name)
        state = _reader_state(directory)
        receipt_path = directory / 'receipt.json'
        if state.get('state') != 'COMMITTED' or not receipt_path.exists():
            continue
        receipt = read_metadata(receipt_path)
        _validate_receipt(receipt, path.name, c['max_bundle_bytes'])
        digest = b.sha(receipt_path)
        try:
            confirmed = b.board_report.acknowledged(c, path.name, digest)
        except Exception:
            return False  # PENDING/unknown is not a successful backup.
        if confirmed:
            atomic_metadata(marker, {'transport': TRANSPORT, 'day': today,
                                     'id': path.name, 'receipt_sha': digest}, gid)
            return True
    return False


def produce(c):
    if os.name == 'nt' or os.geteuid() != 0 or c.get('transport') != TRANSPORT or c.get('reviewed_inventory') is not True:
        raise ConfigurationError('CREATE_FAILED')
    os.umask(0o077)
    output, gid = _prepare_output(c)
    # COMMITTED is not D-side success: a reader can have received a truncated
    # stream. Only an exact, authenticated D-side ACK may suppress this day.
    with b.lock(output / '.writer.lock'):
        if server_daily_success(c, output, gid):
            raise NightComplete('DAILY_SUCCESS_ALREADY_ACKNOWLEDGED')
        active, remaining = night_window()
        if not active:
            if remaining == 0:
                publish(c, output, {'phase': 'night-summary', 'result': 'ERROR', 'error': 'NO_BACKUP'})
            raise NightComplete('WAIT_NEXT_NIGHT')
    c = dict(c, _night_deadline=time.monotonic() + remaining)
    # Strict links, roots, inventory and capacity are checked before advertising.
    try:
        try:
            inv = inventory(c)
        except (KeyError, TypeError, FileNotFoundError, NotADirectoryError) as error:
            raise ConfigurationError('CREATE_FAILED') from error
        scratch_base = checked_path(Path(c['scratch_dir']).absolute())
        root_entry(scratch_base, 'directory')
        if stat.S_IMODE(scratch_base.stat().st_mode) != 0o700:
            raise ConfigurationError('UNSAFE_DESTINATION')
        if shutil.disk_usage(scratch_base).free < inv['max_snapshot'] + MARGIN:
            raise ConfigurationError('NO_SPACE_SERVER')
        # A power loss can leave private SQLite scratch. Never create a SECOND
        # base or blindly delete an unconfirmed old worker's files on restart.
        if any(scratch_base.glob('stream-sqlite-*')):
            raise ConfigurationError('STALE_SQLITE_SCRATCH_REVIEW_REQUIRED')
    except Exception as error:
        # Output is already checked/owned. Report permanent preflight failures
        # before exit78; no-reader/timeouts remain quiet in the publisher.
        code = str(error) if isinstance(error, b.BackupError) and re.fullmatch('[A-Z0-9_]+', str(error)) else 'CREATE_FAILED'
        publish(c, output, {'phase': 'create-stream', 'result': 'ERROR', 'error': code})
        raise
    with b.lock(output / '.writer.lock'):
        active, remaining = night_window()
        if not active:
            raise NightComplete('WAIT_NEXT_NIGHT')
        retire_interrupted_sessions(output, gid)
        cleanup_sessions(output)
        name = 'synapse-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        directory = output / name
        directory.mkdir(mode=0o750)
        os.chown(directory, 0, gid)
        directory.chmod(0o750)
        deadline = time.monotonic() + min(remaining, duration(c, 'stream_total_seconds', 21600, 21600))
        state = {'schema': 1, 'transport': TRANSPORT, 'id': name, 'state': 'OFFERED',
                 'created_at': time.time(), 'expires_at': time.time() + time_left(deadline),
                 'max_total_bytes': inv['bound'], 'files': {x: {'state': 'WAITING'} for x in b.FILES}}
        owned, committed = Children(), False
        status = {'phase': 'create-stream', 'id': name, 'result': 'ERROR', 'sha': 'UNKNOWN'}
        try:
            for filename in b.FILES:
                fifo = directory / filename
                os.mkfifo(fifo, mode=0o640)
                os.chown(fifo, 0, gid)
                fifo.chmod(0o640)
                lock = directory / ('.' + filename + '.lock')
                with lock.open('xb'):
                    pass
                os.chown(lock, 0, gid)
                lock.chmod(0o640)
            atomic_metadata(directory / META, state, gid)
            hashes = {}
            with tempfile.TemporaryDirectory(prefix='stream-sqlite-', dir=scratch_base) as temporary:
                scratch = Path(temporary)
                scratch.chmod(0o700)
                producers = [_data_producer(c, inv, scratch, owned, deadline, name,
                                            refresh=lambda: inventory(c)), None]
                def images(pipe):
                    inv['streamed_images_bytes'] = 0
                    proc = owned.start(['docker', 'image', 'save', *inv['images']], stdout=sp.PIPE, stderr=sp.DEVNULL)
                    try:
                        while chunk := proc.stdout.read(BLOCK):
                            pipe.write(chunk)
                            inv['streamed_images_bytes'] += len(chunk)
                        if proc.wait(timeout=min(time_left(deadline), 30)) != 0:
                            fail('CREATE_FAILED')
                    finally:
                        owned.stop(proc)
                        proc.stdout.close()
                producers[1] = images
                for index, filename in enumerate(b.FILES):
                    def connected(filename=filename):
                        if filename == b.FILES[0]:
                            fresh = inventory(c)
                            _same_inventory(inv, fresh)
                            inv.update(fresh)
                        state['state'] = 'STREAMING'
                        state['files'][filename]['state'] = 'STREAMING'
                        atomic_metadata(directory / META, state, gid)
                    settings = dict(c, _remaining_cipher_bytes=inv['bound'] - sum(x['bytes'] for x in hashes.values()))
                    if index:
                        settings['stream_reader_wait_seconds'] = duration(c, 'stream_next_reader_wait_seconds', 300, 1800)
                    hashes[filename] = stream_cipher(settings, directory / filename, producers[index], deadline, connected, owned)
                    state['files'][filename]['state'] = 'DONE'
                    atomic_metadata(directory / META, state, gid)
            current = json.loads(b.run(['docker', 'inspect', *[x['Id'] for x in inv['metadata']]], capture_output=True, timeout=30).stdout)
            if _facts(current) != _facts(inv['metadata']):
                fail('SOURCE_CHANGED')
            raw_estimate = max(inv['raw_bytes'], inv['streamed_data_bytes'] + inv['streamed_images_bytes'])
            receipt = {'schema': 2, 'transport': TRANSPORT, 'id': name,
                       'restore_bytes': raw_estimate * 3 + MARGIN, 'files': hashes}
            atomic_metadata(directory / 'receipt.json', receipt, gid)
            state['state'] = 'COMMITTED'
            atomic_metadata(directory / META, state, gid)
            committed = True
            status.update(result='OK', sha='OK', bytes=sum(x['bytes'] for x in hashes.values()))
            return receipt
        except BaseException as error:
            code = str(error) if isinstance(error, b.BackupError) and re.fullmatch('[A-Z0-9_]+', str(error)) else 'CREATE_FAILED'
            state.update(state='FAILED', error=code)
            atomic_metadata(directory / META, state, gid)
            status['error'] = code
            if code not in {'STREAM_TIMEOUT', 'STREAM_STALLED', 'STREAM_DISCONNECTED', 'STREAM_INTERRUPTED'}:
                publish(c, output, status)
            raise
        finally:
            owned.close()
            for filename in b.FILES:
                fifo = directory / filename
                if fifo.exists():
                    root_entry(fifo, 'fifo')
                    fifo.unlink()
            if not committed and state['state'] != 'FAILED':
                state.update(state='FAILED', error='CREATE_FAILED')
                atomic_metadata(directory / META, state, gid)
            b.write_json(output / 'status.json', status)
            # Offers/no-reader/retries are local state, not board reports. Only
            # the verified D-side pull publishes the authoritative ACK.
            if not night_window()[0] and not server_daily_success(c, output, gid):
                publish(c, output, {'phase': 'night-summary', 'result': 'ERROR', 'error': 'NO_BACKUP'})


def _reader_state(directory):
    state = read_metadata(directory / META)
    if state.get('id') != directory.name or state.get('transport') != TRANSPORT or state.get('schema') != 1:
        fail('BAD_RECEIPT')
    return state


def prune(c):
    if os.name == 'nt' or os.geteuid() != 0 or c.get('transport') != TRANSPORT:
        raise ConfigurationError('CREATE_FAILED')
    root = checked_path(Path(c['output']).absolute())
    root_entry(root, 'directory')
    if read_metadata(root / MARKER) != {'schema': 1, 'transport': TRANSPORT}:
        fail('BAD_RECEIPT')
    with b.lock(root / '.writer.lock'):
        cleanup_sessions(root)


def read_fifo(c, directory, filename, output):
    state = _reader_state(directory)
    if state['files'].get(filename, {}).get('state') != 'WAITING' or state['expires_at'] <= time.time():
        fail('STREAM_ALREADY_CONSUMED')
    if filename == b.FILES[1] and state['files'][b.FILES[0]]['state'] != 'DONE':
        fail('STREAM_FILE_ORDER')
    lockpath = directory / ('.' + filename + '.lock')
    info = root_entry(lockpath)
    lease = os.open(lockpath, os.O_RDONLY | os.O_NOFOLLOW)
    fifo_fd = None
    try:
        if (os.fstat(lease).st_dev, os.fstat(lease).st_ino) != (info.st_dev, info.st_ino):
            fail('UNSAFE_DESTINATION')
        try:
            _fcntl.flock(lease, _fcntl.LOCK_EX | _fcntl.LOCK_NB)
        except BlockingIOError:
            fail('STREAM_CONSUMER_BUSY')
        state = _reader_state(directory)
        if state['files'][filename]['state'] != 'WAITING':
            fail('STREAM_ALREADY_CONSUMED')
        fifo = directory / filename
        before = root_entry(fifo, 'fifo')
        fifo_fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        if (os.fstat(fifo_fd).st_dev, os.fstat(fifo_fd).st_ino) != (before.st_dev, before.st_ino):
            fail('UNSAFE_DESTINATION')
        deadline = time.monotonic() + min(duration(c, 'stream_total_seconds', 21600, 21600), max(0, state['expires_at'] - time.time()))
        out_fd = output.fileno()
        old_blocking = os.get_blocking(out_fd)
        os.set_blocking(out_fd, False)
        try:
            while True:
                time_left(deadline)
                try:
                    chunk = os.read(fifo_fd, BLOCK)
                except BlockingIOError:
                    time.sleep(0.05)
                    continue
                if chunk:
                    _write_all(out_fd, chunk, deadline, duration(c, 'stream_stall_seconds', 120, 1800))
                    continue
                state = _reader_state(directory)
                if state['state'] == 'FAILED':
                    fail('CREATE_FAILED')
                if state['files'][filename]['state'] == 'DONE':
                    return
                time.sleep(min(0.05, time_left(deadline)))
        finally:
            os.set_blocking(out_fd, old_blocking)
    finally:
        if fifo_fd is not None:
            os.close(fifo_fd)
        os.close(lease)


def serve(c):
    if os.name == 'nt':
        fail('CREATE_FAILED')
    root = checked_path(Path(c['output']).absolute())
    root_entry(root, 'directory')
    if read_metadata(root / MARKER) != {'schema': 1, 'transport': TRANSPORT}:
        fail('BAD_RECEIPT')
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '').split()
    if command == ['list']:
        ids = []
        for path in root.iterdir():
            if b.ID.fullmatch(path.name):
                state = _reader_state(_session(root, path.name))
                if state['state'] == 'COMMITTED' or state['state'] != 'FAILED' and state['expires_at'] > time.time():
                    ids.append(path.name)
        sys.stdout.write(json.dumps(sorted(ids)))
        return
    if len(command) != 3 or command[0] != 'get' or command[2] not in [META, 'receipt.json', *b.FILES]:
        fail('STREAM_ONLY_LIST_GET_ALLOWED')
    directory = _session(root, command[1])
    if command[2] in b.FILES:
        read_fifo(c, directory, command[2], sys.stdout.buffer)
    else:
        value = read_metadata(directory / command[2])
        sys.stdout.buffer.write(json.dumps(value, sort_keys=True).encode() + b'\n')


def ssh_receive(c, command, target, maximum, timeout):
    """Bound stdout on Windows too; keep one owned SSH child, never a shell."""
    args = [c.get('ssh', 'ssh'), '-T', '-oBatchMode=yes', '-oIdentitiesOnly=yes', '-oStrictHostKeyChecking=yes',
            '-oConnectTimeout=20', '-oServerAliveInterval=30', '-oServerAliveCountMax=3',
            '-oUserKnownHostsFile=' + c['known_hosts'], '-i', c['ssh_key'], c['host'], command]
    owned, errors, count = Children(), [], [0]
    proc = owned.start(args, stdout=sp.PIPE, stderr=sp.DEVNULL)
    def read():
        try:
            while chunk := proc.stdout.read(BLOCK):
                count[0] += len(chunk)
                if count[0] > maximum:
                    fail('BAD_RECEIPT')
                target.write(chunk)
        except BaseException as error:
            errors.append(error)
    worker = threading.Thread(target=read, name='backup-ssh-output', daemon=True)
    worker.start()
    deadline = time.monotonic() + timeout
    try:
        while worker.is_alive():
            if errors:
                raise errors[0]
            worker.join(timeout=min(time_left(deadline), 0.1))
        if errors:
            raise errors[0]
        return proc.wait(timeout=min(time_left(deadline), 5))
    finally:
        owned.close()
        proc.stdout.close()
        worker.join(timeout=5)


def remote_json(c, command):
    out = io.BytesIO()
    if ssh_receive(c, command, out, META_LIMIT, 30) != 0:
        fail('NO_BACKUP')
    return json.loads(out.getvalue())


def _local_root(root):
    root = checked_path(root)
    stage = root / '.stream-partials'
    if stage.is_symlink():
        fail('UNSAFE_DESTINATION')
    stage.mkdir(mode=0o700, exist_ok=True)
    b.private_dir(stage)
    return stage


def cleanup_local(root):
    for label in ['.stream-partials', '.stream-quarantine']:
        stage = checked_path(root) / label
        if not stage.exists():
            continue
        checked_path(stage)
        for path in stage.iterdir():
            _owned_stage(root, path, label)
            if time.time() - path.stat().st_mtime > 86400:
                shutil.rmtree(path)


def _outside_private_paths(c, root):
    for key in ['identity', 'verify_temp_dir']:
        if key not in c or Path(c[key]).resolve().is_relative_to(root):
            fail('IDENTITY_MUST_BE_OUTSIDE_BACKUPS' if key == 'identity' else 'TEMP_MUST_BE_OUTSIDE_BACKUPS')


def _validate_receipt(receipt, name, maximum):
    if receipt.get('schema') != 2 or receipt.get('transport') != TRANSPORT or receipt.get('id') != name or set(receipt.get('files', {})) != set(b.FILES):
        fail('BAD_RECEIPT')
    total = 0
    for info in receipt['files'].values():
        if type(info.get('bytes')) is not int or not 0 < info['bytes'] <= maximum or re.fullmatch('[a-f0-9]{64}', info.get('sha256', '')) is None:
            fail('BAD_RECEIPT')
        total += info['bytes']
    if total > maximum:
        fail('BAD_RECEIPT')


def fresh_id(name):
    if not isinstance(name, str) or not b.ID.fullmatch(name):
        fail('BAD_RECEIPT')
    try:
        date = dt.datetime.strptime(name[8:16], '%Y%m%d').date()
    except ValueError:
        fail('BAD_RECEIPT')
    return 0 <= (dt.datetime.now(dt.timezone.utc).date() - date).days <= 1


def _staged_complete(stage):
    if (stage / 'receipt.json').is_symlink():
        fail('UNSAFE_DESTINATION')
    if not (stage / 'receipt.json').exists():
        return None
    return b.validate_bundle(stage)


def _owned_stage(root, stage, label='.stream-partials'):
    checked_path(stage)
    if stage.parent != root / label or not b.ID.fullmatch(stage.name) or not stage.is_dir():
        fail('UNSAFE_DESTINATION')
    for path in stage.iterdir():
        if path.name not in {META, 'receipt.json', *b.FILES, '.receipt.tmp', META + '.tmp', 'receipt.json.tmp'} or path.is_symlink() or not path.is_file():
            fail('UNSAFE_DESTINATION')
        if path.name.endswith('.tmp') and path.stat().st_nlink != 1:
            fail('UNSAFE_DESTINATION')


def quarantine(root, stage):
    """Retain invalid OWN ciphertext, never reopen/append its consumed FIFO."""
    root = checked_path(root)
    _owned_stage(root, stage)
    destination = root / '.stream-quarantine'
    checked_path(destination)
    destination.mkdir(mode=0o700, exist_ok=True)
    b.private_dir(destination)
    target = destination / stage.name
    if target.exists() or target.is_symlink():
        fail('UNSAFE_DESTINATION')
    os.replace(stage, target)


def _canonical_receipt(path, receipt):
    """Match the root/serve bytes exactly, so the D-side ACK hash matches."""
    checked_path(path)
    data = json.dumps(receipt, ensure_ascii=False, sort_keys=True).encode() + b'\n'
    if len(data) > META_LIMIT:
        fail('BAD_RECEIPT')
    temporary = path.with_name('.receipt.tmp')
    with temporary.open('xb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)


def _valid_stage(c, root, stage, receipt=None):
    _owned_stage(root, stage)
    if any((stage / name).exists() for name in ['.receipt.tmp', META + '.tmp', 'receipt.json.tmp']):
        quarantine(root, stage)
        fail('BAD_SHA')  # Own interrupted metadata writes are not resumable.
    try:
        if receipt is not None:
            _validate_receipt(receipt, stage.name, c['max_bundle_bytes'])
            _canonical_receipt(stage / 'receipt.json', receipt)
        value = _staged_complete(stage)
        if value is not None:
            _validate_receipt(value, stage.name, c['max_bundle_bytes'])
        return value
    except (OSError, ValueError, KeyError, TypeError):
        quarantine(root, stage)
        raise b.BackupError('BAD_SHA') from None


def daily_success(c, root):
    """Reuse only a promoted, checked copy CREATED on this Bangkok day."""
    marker = checked_path(root / '.stream-success.json')
    if not marker.exists():
        return None
    try:
        if marker.stat().st_size > META_LIMIT:
            fail('BAD_RECEIPT')
        saved = json.loads(marker.read_text(encoding='utf-8'))
        name = saved['id']
        if saved.get('transport') != TRANSPORT or saved.get('day') != bangkok_day() or bangkok_day(name) != saved['day']:
            return None
        final = checked_path(root / name)
        checked_path(final / 'receipt.json')
        receipt = b.validate_bundle(final)
        _validate_receipt(receipt, name, c['max_bundle_bytes'])
        if b.sha(final / 'receipt.json') != saved['receipt_sha']:
            fail('BAD_SHA')
        return final, receipt
    except (OSError, ValueError, KeyError, TypeError):
        # A damaged/missing local final must not masquerade as today's success.
        return None


def mark_success(c, root, bundle):
    """Only pull(), after weekly verification/promotion, may persist this gate."""
    root, bundle = checked_path(root), checked_path(bundle)
    if bundle.parent != root or not b.ID.fullmatch(bundle.name):
        fail('UNSAFE_DESTINATION')
    checked_path(bundle / 'receipt.json')
    receipt = b.validate_bundle(bundle)
    _validate_receipt(receipt, bundle.name, c['max_bundle_bytes'])
    if bangkok_day(bundle.name) != bangkok_day():
        return False  # Restoring yesterday's valid copy cannot suppress today.
    path = checked_path(root / '.stream-success.json')
    b.write_json(path, {'transport': TRANSPORT, 'day': bangkok_day(bundle.name),
                        'id': bundle.name, 'receipt_sha': b.sha(bundle / 'receipt.json')})
    return True


def publish(c, root, status):
    """Bounded stream-only outbox. Unknown sends are read back, never retried."""
    quiet = {'NO_BACKUP', 'STREAM_TIMEOUT', 'STREAM_STALLED', 'STREAM_DISCONNECTED',
             'STREAM_NEW_SESSION_REQUIRED', 'STREAM_INTERRUPTED', 'WAIT_NEXT_NIGHT'}
    success = status.get('phase') == 'pull' and status.get('result') == 'OK'
    safe = None
    if success:
        if not b.ID.fullmatch(status.get('id', '')) or re.fullmatch('[a-f0-9]{64}', status.get('receipt_sha', '')) is None:
            return False
        safe = {k: status[k] for k in ['phase', 'id', 'bytes', 'sha', 'result', 'receipt_sha']}
    elif status.get('phase') == 'night-summary' or status.get('error') not in quiet:
        safe = {'phase': 'night-summary' if status.get('phase') == 'night-summary' else 'pull',
                'result': 'ERROR', 'date': bangkok_day(),
                'error': status.get('error') if status.get('error') in b.board_report.ERRORS else 'PULL_OR_VERIFY_FAILED'}
    try:
        root = checked_path(root)
        outbox = checked_path(root / '.stream-reports')
        outbox.mkdir(mode=0o700, exist_ok=True)
        b.private_dir(outbox)
        entries = {}
        for path in outbox.iterdir():
            checked_path(path)
            if re.fullmatch(r'[a-f0-9]{64}\.json', path.name) is None or not path.is_file() or path.stat().st_size > META_LIMIT:
                return False
            saved = json.loads(path.read_text(encoding='utf-8'))
            if saved.get('state') not in ['pending', 'sending', 'sent'] or saved.get('marker') != 'BACKUP58_STREAM_REPORT ' + path.stem:
                return False
            entries[path] = saved
        current = None
        if safe is not None:
            digest = hashlib.sha256(json.dumps(safe, sort_keys=True).encode()).hexdigest()
            current = outbox / (digest + '.json')
            if current not in entries and sum(x['state'] != 'sent' for x in entries.values()) < 32:
                marker = 'BACKUP58_STREAM_REPORT ' + digest
                if success:
                    text = f"Копия за {bangkok_day(safe['id'])}: {safe['id']}; размер {safe['bytes']}; SHA OK; OK"
                    text += '\n' + marker + '\n' + b.board_report.ACK + json.dumps(
                        {'id': safe['id'], 'receipt_sha': safe['receipt_sha']}, sort_keys=True)
                else:
                    text = (f"Итог копии за {safe['date']}: нет подтверждённой копии"
                            if safe['phase'] == 'night-summary' else f"Проверка копии за {safe['date']}: ERROR; {safe['error']}")
                    text += '\n' + marker
                entries[current] = {'marker': marker, 'text': text, 'state': 'pending'}
                b.write_json(current, entries[current])
        if c.get('board_endpoint_file') and any(x['state'] != 'sent' for x in entries.values()):
            session_id = None
            try:
                try:
                    session = b.board_report.rpc(c, 'session_start', {'agent': b.board_report.AUTHOR, 'kind': 'codex',
                                                                    'request': 'Короткий отчёт резервного копирования №58'})
                    session_id = session.get('session_id')
                    for document in session.get('documents', []):
                        b.board_report.rpc(c, 'doc_read', {'path': document['path']})
                except Exception:
                    pass
                seen = {x.get('text', '') for x in b.board_report.comments(c) if x.get('author') == b.board_report.AUTHOR}
                for path, saved in sorted(entries.items()):
                    if saved['state'] == 'sent':
                        continue
                    if any(saved['marker'] in text for text in seen):
                        saved['state'] = 'sent'
                    elif saved['state'] == 'sending':
                        continue
                    else:
                        saved['state'] = 'sending'
                        b.write_json(path, saved)
                        b.board_report.rpc(c, 'task_comment', {'task_id': 58, 'author': b.board_report.AUTHOR, 'text': saved['text']})
                        saved['state'] = 'sent'
                    b.write_json(path, saved)
            finally:
                if session_id:
                    with contextlib.suppress(Exception):
                        b.board_report.rpc(c, 'session_end', {'session_id': session_id,
                            'summary': 'Отчёт резервного копирования №58; состояние в outbox', 'state': 'idle'})
        # Only confirmed sent files are expendable. Never evict pending/sending,
        # including unknown success delivery, merely to make room for a retry.
        sent = sorted((p for p, x in entries.items() if x['state'] == 'sent'),
                      key=lambda p: (p == current, p.stat().st_mtime), reverse=True)
        for path in sent[8:]:
            path.unlink()
        return current in entries and entries[current]['state'] == 'sent'
    except Exception:
        return False


def download(c, root):
    """Return staged cipher only. pull() runs its mandatory weekly check next."""
    root = checked_path(root)
    if checked_path(Path(c['destination']).absolute()).resolve() != root:
        fail('UNSAFE_DESTINATION')
    _outside_private_paths(c, root)
    already = daily_success(c, root)
    if already is not None:
        return already
    stage_root = _local_root(root)
    cleanup_local(root)
    # A complete staged bundle survives failed weekly verification/unknown ACK.
    for path in sorted(stage_root.iterdir(), reverse=True):
        try:
            receipt = _valid_stage(c, root, path)
        except b.BackupError as error:
            if str(error) != 'BAD_SHA':
                raise
            continue  # Invalid own cipher is quarantined, not a sticky retry.
        if receipt:
            _validate_receipt(receipt, path.name, c['max_bundle_bytes'])
            if fresh_id(path.name):
                return path, receipt
            continue  # Preserve old cipher for recovery, but wait for fresh data.
        # If both streams reached disk but the last SSH result/receipt fetch was
        # unknown, reconcile the OLD id before looking for a new offer. Never
        # reopen either consumed FIFO or append bytes.
        if fresh_id(path.name) and all((path / name).is_file() and not (path / name).is_symlink() for name in b.FILES):
            try:
                receipt = remote_json(c, f'get {path.name} receipt.json')
            except b.BackupError:
                continue
            try:
                _valid_stage(c, root, path, receipt)
            except b.BackupError as error:
                if str(error) != 'BAD_SHA':
                    raise
                continue
            return path, receipt
    # A crash after promotion but before its daily marker is still recoverable
    # during the day. pull() must reapply its weekly policy before marking OK.
    for final in b.completed(root):
        if bangkok_day(final.name) != bangkok_day():
            continue
        checked_path(final)
        checked_path(final / 'receipt.json')
        receipt = b.validate_bundle(final)
        _validate_receipt(receipt, final.name, c['max_bundle_bytes'])
        return final, receipt
    if not night_window()[0]:
        fail('WAIT_NEXT_NIGHT')  # No new FIFO may trigger daytime production.
    wait = time.monotonic() + duration(c, 'stream_offer_wait_seconds', 300, 1800)
    while True:
        if not night_window()[0]:
            fail('WAIT_NEXT_NIGHT')
        try:
            ids = remote_json(c, 'list')
        except b.BackupError:
            time.sleep(min(2, time_left(wait)))
            continue
        if not isinstance(ids, list) or any(not isinstance(x, str) or not b.ID.fullmatch(x) for x in ids):
            fail('BAD_RECEIPT')
        if ids:
            name = max(ids)
            if (root / '.stream-quarantine' / name).exists():
                time.sleep(min(2, time_left(wait)))
                continue
            if not fresh_id(name):
                time.sleep(min(2, time_left(wait)))
                continue
            final = root / name
            if final.exists():
                checked_path(final)
                receipt = b.validate_bundle(final)
                _validate_receipt(receipt, name, c['max_bundle_bytes'])
                return final, receipt
            offer = remote_json(c, f'get {name} {META}')
            if offer.get('schema') != 1 or offer.get('transport') != TRANSPORT or offer.get('id') != name or type(offer.get('max_total_bytes')) is not int:
                fail('BAD_RECEIPT')
            # A completed one-shot stream without a local copy cannot be replayed.
            # The independent root service will prepare another fresh offer.
            if offer.get('state') == 'OFFERED' and offer.get('expires_at', 0) > time.time():
                break
        time.sleep(min(2, time_left(wait)))
    maximum = offer['max_total_bytes']
    if not 0 < maximum <= c['max_bundle_bytes']:
        fail('BAD_RECEIPT')
    pending = stage_root / name
    if pending.exists():
        # Never append/resume FIFO bytes. Only final receipt reconciliation below.
        checked_path(pending)
        if not all((pending / f).is_file() and not (pending / f).is_symlink() for f in b.FILES):
            fail('STREAM_NEW_SESSION_REQUIRED')
    else:
        if shutil.disk_usage(root).free < maximum + MARGIN:
            fail('NO_SPACE_D')
        pending.mkdir(mode=0o700)
        b.private_dir(pending)
        b.write_json(pending / META, offer)
        used = 0
        for filename in b.FILES:
            active, remaining = night_window()
            if not active:
                fail('WAIT_NEXT_NIGHT')
            path = pending / filename
            with path.open('xb') as out:
                code = ssh_receive(c, f'get {name} {filename}', out, maximum - used, min(3600, remaining))
                out.flush()
                os.fsync(out.fileno())
            used += path.stat().st_size
            if code != 0:
                state = remote_json(c, f'get {name} {META}')
                if state.get('files', {}).get(filename, {}).get('state') != 'DONE':
                    fail('STREAM_NEW_SESSION_REQUIRED')
    deadline = time.monotonic() + duration(c, 'stream_receipt_wait_seconds', 60, 300)
    while True:
        try:
            receipt = remote_json(c, f'get {name} receipt.json')
            break
        except b.BackupError:
            state = remote_json(c, f'get {name} {META}')
            if state.get('state') == 'FAILED':
                fail('CREATE_FAILED')
            time.sleep(min(1, time_left(deadline)))
    _valid_stage(c, root, pending, receipt)
    return pending, receipt


def promote(c, root, staged):
    root, staged = checked_path(root), checked_path(staged)
    final = root / staged.name
    if staged == final:
        b.validate_bundle(final)
        return final
    if staged.parent != root / '.stream-partials' or not b.ID.fullmatch(staged.name):
        fail('UNSAFE_DESTINATION')
    b.validate_bundle(staged)
    if final.exists() or final.is_symlink():
        fail('UNSAFE_DESTINATION')
    # Only pull() calls this AFTER its existing weekly_verify succeeded or the
    # existing verified_at policy said verification is not yet due.
    os.replace(staged, final)
    b.validate_bundle(final)
    return final


def main():
    if len(sys.argv) == 7 and sys.argv[1] == '_snapshot':
        def interrupted(*args):
            raise InterruptedError('SNAPSHOT_INTERRUPTED')
        signal.signal(signal.SIGTERM, interrupted)
        _snapshot_worker(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6]))
        return
    raise ConfigurationError('CREATE_FAILED')


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        print('SQLITE_SNAPSHOT_FAILED', file=sys.stderr)
        sys.exit(1)
