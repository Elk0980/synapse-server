"""Fixed receive-lines invocation; temporarily hide terminal echo, never import DB."""
import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import runpy
import signal
import stat
import sys

PRIVATE_ROOT = Path('/opt/synapse/.palitra-private-0248')
HELPER = PRIVATE_ROOT / 'private_migration.py'
OUTPUT = PRIVATE_ROOT / 'payload.json'
HELPER_SHA = '97af08c01ac2767b4c2886d4084e6f0f132c2a361b7eedf6cf9aabf27790b46d'
ENVELOPE_SHA = '050069118ebedc69b53f32d5bb4e5c14ebab43de77647086c09b9a7f4c6105cf'
FIXED_ARGV = [str(HELPER), 'receive-lines', '--output', str(OUTPUT),
              '--expected-envelope-sha', ENVELOPE_SHA]


class Refused(Exception):
    pass


class Interrupted(BaseException):
    def __init__(self, signum):
        self.signum = signum


def metadata(code):
    print(json.dumps({'status': 'REFUSED', 'code': code}, separators=(',', ':')), file=sys.stderr, flush=True)


def verify_helper():
    if os.name != 'posix' or not hasattr(os, 'geteuid') or os.geteuid() != 0:
        raise Refused('ROOT_LINUX_REQUIRED')
    for path in reversed([PRIVATE_ROOT, *PRIVATE_ROOT.parents]):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise Refused('PRIVATE_PARENT_UNSAFE')
    root_info = PRIVATE_ROOT.lstat()
    if root_info.st_uid != 0 or stat.S_IMODE(root_info.st_mode) != 0o700:
        raise Refused('PRIVATE_ROOT_MODE')
    # The destination is fixed and new; a prior attempt must be checked by Root.
    try:
        OUTPUT.lstat()
    except FileNotFoundError:
        pass
    else:
        raise Refused('OUTPUT_ALREADY_EXISTS')
    named = HELPER.lstat()
    if not stat.S_ISREG(named.st_mode) or named.st_uid != 0 or stat.S_IMODE(named.st_mode) != 0o600:
        raise Refused('HELPER_MODE_OR_TYPE')
    fd = os.open(HELPER, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        before = os.fstat(fd)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(1024 * 1024 + 1)
        after = os.fstat(fd)
        attrs = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_mode)
        if (attrs(named) != attrs(before) or attrs(before) != attrs(after)
                or attrs(after) != attrs(HELPER.lstat()) or len(raw) != after.st_size
                or hashlib.sha256(raw).hexdigest() != HELPER_SHA):
            raise Refused('HELPER_SHA_OR_RACE')
    finally:
        os.close(fd)
    return raw


@contextmanager
def sealed_snapshot(raw):
    """Runpy reads immutable verified code bytes, never a private data envelope."""
    if not isinstance(raw, bytes) or hashlib.sha256(raw).hexdigest() != HELPER_SHA:
        raise Refused('SNAPSHOT_SHA')
    import fcntl
    flags = os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING
    fd = os.memfd_create('palitra-receive-code', flags)
    try:
        remaining = memoryview(raw)
        while remaining:
            wrote = os.write(fd, remaining)
            if wrote <= 0:
                raise Refused('SNAPSHOT_WRITE_FAILED')
            remaining = remaining[wrote:]
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS,
                    fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
        os.lseek(fd, 0, os.SEEK_SET)
        yield '/proc/self/fd/' + str(fd)
    finally:
        os.close(fd)


class EchoGuard:
    def __init__(self, stream, termios_module=None):
        self.stream = stream
        self.termios = termios_module
        self.fd = None
        self.original = None
        self.active = False

    def disable(self):
        if not self.stream.isatty():
            return
        if self.termios is None:
            import termios
            self.termios = termios
        self.fd = self.stream.fileno()
        self.original = self.termios.tcgetattr(self.fd)
        quiet = list(self.original)
        quiet[6] = list(self.original[6])
        quiet[3] &= ~self.termios.ECHO
        # Mark first so finally restores even if tcsetattr partially succeeds.
        self.active = True
        self.termios.tcsetattr(self.fd, self.termios.TCSANOW, quiet)

    def restore(self):
        if self.active:
            self.termios.tcsetattr(self.fd, self.termios.TCSANOW, self.original)
            self.active = False


def receive(stream=None, execute=None, verify=None, termios_module=None, snapshot=None):
    stream = sys.stdin if stream is None else stream
    execute = runpy.run_path if execute is None else execute
    verify = verify_helper if verify is None else verify
    snapshot = sealed_snapshot if snapshot is None else snapshot
    verify()
    guard = EchoGuard(stream, termios_module)
    old_argv = sys.argv
    old_handlers = {}
    old_mask = None
    exit_code = 0
    failure = None
    restore_failed = False
    phase = {'interrupted': False, 'cleanup': False}
    def on_interrupt(signum, _frame):
        # After the first interrupt, repetitions cannot unwind a finalizer.
        if phase['interrupted'] or phase['cleanup']:
            return
        phase['interrupted'] = True
        raise Interrupted(signum)
    try:
        watched = [getattr(signal, name, None) for name in ('SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP')]
        for signum in dict.fromkeys(value for value in watched if value is not None):
            old_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, on_interrupt)
        guard.disable()
        raw = verify()
        with snapshot(raw) as verified_path:
            sys.argv = list(FIXED_ARGV)
            execute(verified_path, run_name='__main__')
    except SystemExit as error:
        exit_code = error.code if isinstance(error.code, int) else (0 if error.code is None else 2)
    except Interrupted as error:
        exit_code = 128 + error.signum
        failure = 'RECEIVE_INTERRUPTED'
    except BaseException:
        exit_code = 2
        failure = 'RECEIVE_FAILED'
    finally:
        # A second catchable signal must not interrupt terminal restoration.
        # Pending repetitions are discarded while temporarily ignored. Restore
        # every original handler/mask once the original terminal is back.
        try:
            phase['cleanup'] = True
            mask_api = getattr(signal, 'pthread_sigmask', None)
            if mask_api and old_handlers:
                old_mask = mask_api(signal.SIG_BLOCK, set(old_handlers))
            for signum in old_handlers:
                signal.signal(signum, signal.SIG_IGN)
        except BaseException:
            restore_failed = True
        finally:
            try:
                guard.restore()
            except BaseException:
                restore_failed = True
        sys.argv = old_argv
        if old_mask is not None:
            try:
                signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
            except BaseException:
                restore_failed = True
        for signum, handler in old_handlers.items():
            try:
                signal.signal(signum, handler)
            except BaseException:
                restore_failed = True
    if restore_failed:
        metadata('TERMINAL_RESTORE_FAILED')
        return 2
    if failure:
        metadata(failure)
    return exit_code


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv:
        metadata('NO_RUNTIME_ARGUMENTS')
        return 2
    try:
        return receive()
    except BaseException:
        metadata('FIXED_RECEIVER_CHECK_FAILED')
        return 2


if __name__ == '__main__':
    sys.exit(main())
