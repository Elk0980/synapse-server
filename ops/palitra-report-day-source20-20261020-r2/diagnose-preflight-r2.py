"""Read-only phase diagnostic; no entry/controller execution or attempt writes."""
import sys
sys.dont_write_bytecode = True
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import types

NAME = 'report-day-source20-cache-20261020-r2'
ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
CODE = ROOT / (NAME + '-code')
LOCK = '/opt/synapse/.palitra-app-release.lock'
RELEASED_PIDS = frozenset({3161783, 3196874, 3200094, 3202295, 3204327, 3205870, 3207300, 3208973})
MANIFEST_SHA = '47fa0af50afe0274fd48152661dca6cbe700e1339d885c0d74b81a92e32d8e38'
ENTRY_SHA = '4a31bf84c3686b603a994d85834fdd7737c9ad85b7b2dd15dd0ee45ef50f0638'
NATIVE_SHA = 'a759e89e59eb8f0ac1e872dfba1895248a5b36b0eafbf7c65f4744fe5b7cebbb'
FILES = {
    'company-app.py': {'bytes': 4026, 'sha256': ENTRY_SHA},
    'content-db.py': {'bytes': 7788, 'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be'},
    'controller.py': {'bytes': 14806, 'sha256': '94a9a892d0891cf9e3d5789f9bc5d1ff79b4b2a024dcf55f2749f26d64d841fa'},
    'manifest.json': {'bytes': 2316, 'sha256': MANIFEST_SHA},
    'native.py': {'bytes': 27489, 'sha256': NATIVE_SHA},
    'parent-darya-r2.py': {'bytes': 9446, 'sha256': 'b77efd257d3e7b1076d72c0405a67c9f00e99c8de2eac67dd35313a40132b4d1'},
    'payload/customer-report-cache.cjs': {'bytes': 12842, 'sha256': '5fb7f5ca7f897d04bd2c4907ad8422122209fa1df37d2a8a52b5fcdb4fbf7e70'},
    'report-db.py': {'bytes': 7626, 'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63'},
    'rollback-plan.py': {'bytes': 3491, 'sha256': '73c940753ea8d871efb46cdbbcaf39fd27fbd74ce5e762bc4d5d761131054bbd'},
    'traffic-db.py': {'bytes': 12391, 'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f'},
}
NOFOLLOW = getattr(os, 'O_NOFOLLOW', None)
MAX_ARTIFACT = 64 * 1024 * 1024
ARTIFACTS = ('preflight', 'decision', 'journal', 'overlay', 'context', 'backup')
# Closed literal admission only. Unknown messages, including uppercase secrets in
# suppressed dependency exceptions, are always hash-only. Native entries below
# were checked against the exact NATIVE_SHA source, not inferred from message shape.
SAFE_GUARD_CODES = frozenset({
    'EXACT_ROOT_DIRECTORY_REQUIRED', 'PRIVATE_SINGLE_LINK_BOUNDED_FILE_REQUIRED',
    'FILE_OPEN_CHANGED', 'FILE_CHANGED_DURING_READ', 'POSIX_ROOT_REQUIRED',
    'FRESH_EXPLICIT_LEASE_PID_REQUIRED', 'BOUNDED_LEASE_REQUIRED',
    'EXACT_OWN_FRESH_LEASE_REQUIRED', 'LEASE_READ_REFUSED',
    'CLOSED_TEN_CODE_FILES_REQUIRED', 'EXACT_FROZEN_CODE_REQUIRED',
    'EXACT_CODE_ONLY_MANIFEST_REQUIRED', 'EXACT_MANIFEST_FILE_CLOSURE_REQUIRED',
    'EXACT_NATIVE_BEFORE_LOAD_REQUIRED', 'CLOSED_SNAPSHOT_SUMMARY_REQUIRED',
    'CLOSED_CHECKPOINT_SUMMARY_REQUIRED', 'OWN_ARTIFACTS_CHANGED_DURING_DIAGNOSTIC',
    'EXPLICIT_LEASE_ARGUMENT_REQUIRED',
    'NATIVE_BRIDGE_REFUSED_OR_UNKNOWN_NO_RETRY',
    'NATIVE_COMMAND_REFUSED_OR_UNKNOWN_NO_RETRY', 'BOUNDED_NATIVE_OUTPUT_REQUIRED',
    'FRESH_CACHE_ACTUAL_PID_REQUIRED', 'BRIDGE_CODE_ALIAS_REFUSED',
    'EXACT_PARENT_SEAM_REQUIRED', 'EXACT_PARENT239_43_42_REQUIRED',
    'EXACT_DATABASE_HELPER_REQUIRED', 'BRIDGE_OR_GUARD_CODE_CHANGED',
    'FULL_APP_UNCHANGED_EXCEPT_CACHE_REQUIRED', 'FULL239_ROOT_SOURCE_FACTS_REQUIRED',
    'EXACT_EFFECTIVE_ENVIRONMENT_REQUIRED', 'EXACT_RUNTIME_COMPOSE_LABEL_REQUIRED',
    'BOTH_REPORT_REVISIONS3_OR_NEWER_REQUIRED',
    'EXACT_FULL_PLATFORM_IMAGE_TARGET_REQUIRED',
    'EXACT_FULL_IMAGE_DESCRIPTOR_REQUIRED',
    'EXACT_FULL_LINUX_AMD64_PLATFORM_REQUIRED',
    'EXACT_FULL_PLATFORM_CONFIG_AND_LAYERS_REQUIRED',
    'ONE_SELECTED_PLATFORM_IMAGE_REQUIRED',
    'EXACT_SELECTED_IMAGE_MANIFEST_REQUIRED',
    'EXACT_SELECTED_LINUX_AMD64_PLATFORM_REQUIRED',
    'SELECTED_PLATFORM_CONFIG_AND_LAYERS_MUST_MATCH_FULL_TARGET',
    'EXACT_KNOWN_DARYA_PLATFORM_MANIFEST_REQUIRED',
    'CHILD_PLATFORM_MANIFEST_MUST_DIFFER_FROM_PARENT',
    'CONTAINER_MANIFEST_MUST_MATCH_INDEPENDENT_PLATFORM_IMAGE',
    'CONTAINER_DESCRIPTOR_PLATFORM_CHANGED',
})


def need(ok, code):
    if not ok:
        raise ValueError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
                      allow_nan=False).encode()


def facts(path):
    return os.lstat(path)


def opened(fd):
    return os.fstat(fd)


def identity(info):
    return tuple(getattr(info, name) for name in (
        'st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
        'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def directory(path, private=False):
    info = facts(path)
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0
         and not stat.S_IMODE(info.st_mode) & 0o022
         and (not private or stat.S_IMODE(info.st_mode) == 0o700),
         'EXACT_ROOT_DIRECTORY_REQUIRED')


def parents(path):
    for parent in reversed((path.parent, *path.parent.parents)):
        directory(parent)


def read_private(path, limit):
    parents(path)
    before = facts(path)
    need(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0
         and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o600
         and 0 < before.st_size <= limit, 'PRIVATE_SINGLE_LINK_BOUNDED_FILE_REQUIRED')
    fd = os.open(path, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK)
    try:
        need(identity(opened(fd)) == identity(before), 'FILE_OPEN_CHANGED')
        with os.fdopen(fd, 'rb', closefd=False) as file:
            raw = file.read(limit + 1)
        need(len(raw) == before.st_size and identity(opened(fd)) == identity(before)
             and identity(facts(path)) == identity(before), 'FILE_CHANGED_DURING_READ')
        return raw
    finally:
        os.close(fd)


def platform_guard():
    need(os.name == 'posix' and os.geteuid() == os.getegid() == 0
         and NOFOLLOW is not None, 'POSIX_ROOT_REQUIRED')


def lease(pid):
    need(type(pid) is int and 1 < pid <= 2 ** 31 - 1 and pid not in RELEASED_PIDS,
         'FRESH_EXPLICIT_LEASE_PID_REQUIRED')
    try:
        result = subprocess.run(['lslocks', '--noheadings', '--output', 'PID,PATH'],
                                check=True, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=10)
        need(type(result.stdout) is bytes and len(result.stdout) <= 1048576,
             'BOUNDED_LEASE_REQUIRED')
        rows = [line.strip().split(maxsplit=1) for line in result.stdout.decode('utf-8', 'strict').splitlines()]
        need([row for row in rows if len(row) == 2 and row[1] == LOCK] == [[str(pid), LOCK]],
             'EXACT_OWN_FRESH_LEASE_REQUIRED')
    except ValueError:
        raise
    except Exception:
        raise ValueError('LEASE_READ_REFUSED') from None


def verify_code():
    parents(CODE / 'root-check')
    directory(CODE, private=True)
    directory(CODE / 'payload', private=True)
    need({p.relative_to(CODE).as_posix() for p in CODE.rglob('*')} == set(FILES) | {'payload'},
         'CLOSED_TEN_CODE_FILES_REQUIRED')
    sealed = {}
    for name, record in FILES.items():
        raw = read_private(CODE / name, 4 * 1024 * 1024)
        need(len(raw) == record['bytes'] and sha(raw) == record['sha256'], 'EXACT_FROZEN_CODE_REQUIRED')
        sealed[name] = raw
    manifest = json.loads(sealed['manifest.json'])
    need(manifest['name'] == NAME and manifest['status'] == 'LOCAL_FROZEN_CODE_ONLY'
         and manifest['runtimeAuthorization'] is False, 'EXACT_CODE_ONLY_MANIFEST_REQUIRED')
    rows = manifest['files']
    wanted = {name: row for name, row in FILES.items() if name not in ('company-app.py', 'manifest.json')}
    need(type(rows) is list and len(rows) == len(wanted)
         and all(type(row) is dict and set(row) == {'path', 'bytes', 'sha256'} for row in rows)
         and len({row['path'] for row in rows}) == len(rows)
         and {row['path']: {'bytes': row['bytes'], 'sha256': row['sha256']} for row in rows} == wanted,
         'EXACT_MANIFEST_FILE_CLOSURE_REQUIRED')
    return sealed


def artifact_facts():
    result = {}
    for name in ARTIFACTS:
        path = ROOT / (NAME + '-' + name + ('.json' if name not in ('context', 'backup') else ''))
        parents(path)
        try:
            info = facts(path)
        except FileNotFoundError:
            result[name] = {'present': False}
            continue
        regular = stat.S_ISREG(info.st_mode)
        row = {'present': True, 'regular': regular, 'directory': stat.S_ISDIR(info.st_mode),
               'symlink': stat.S_ISLNK(info.st_mode), 'mode': stat.S_IMODE(info.st_mode),
               'uid': info.st_uid, 'gid': info.st_gid, 'nlink': info.st_nlink,
               'bytes': info.st_size, 'sha256': None}
        if regular and info.st_uid == info.st_gid == 0 and info.st_nlink == 1 \
                and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= MAX_ARTIFACT:
            row['sha256'] = sha(read_private(path, MAX_ARTIFACT))
        result[name] = row
    return result


def text_digest(value):
    try:
        raw = str(value).encode('utf-8', 'backslashreplace')
    except BaseException:
        raw = b'<unprintable>'
    return sha(raw)


def safe_identifier(value, maximum=100):
    return value if type(value) is str and len(value) <= maximum \
        and re.fullmatch('[A-Za-z0-9_.<>-]+', value) is not None else '<redacted>'


def error_summary(error):
    # Suppressed __context__ is intentional: Native.scrub uses "raise ... from None".
    # No raw messages, locals, argument values, full paths, stderr, or environments.
    result, pending, seen = [], [(error, 'root')], set()
    while pending and len(result) < 8:
        item, via = pending.pop(0)
        if id(item) in seen:
            continue
        seen.add(id(item))
        row = {'via': via, 'class': safe_identifier(type(item).__name__, 64)}
        try:
            message = str(item)
        except BaseException:
            message = ''
        if type(item) is ValueError and message in SAFE_GUARD_CODES:
            row['guardCode'] = message
        else:
            row['messageSha256'] = text_digest(item)
        if isinstance(item, AttributeError):
            row['attributeNameSha256'] = text_digest(item.name)
        if isinstance(item, KeyError):
            row['keySha256'] = text_digest(item)
        trace = item.__traceback__
        frames = []
        frame_count = 0
        while trace is not None and frame_count < 256:
            code = trace.tb_frame.f_code
            basename = code.co_filename.replace('\\', '/').rsplit('/', 1)[-1]
            frames.append({'file': safe_identifier(basename),
                           'function': safe_identifier(code.co_name), 'line': trace.tb_lineno})
            frame_count += 1
            if len(frames) > 12:
                frames.pop(0)  # Keep the innermost location, including the actual failure.
            trace = trace.tb_next
        row['traceback'] = frames
        row['tracebackTruncated'] = frame_count > 12 or trace is not None
        result.append(row)
        for linked, name in ((item.__cause__, 'cause'), (item.__context__, 'context')):
            if isinstance(linked, BaseException) and id(linked) not in seen:
                pending.append((linked, name))
    return {'chain': result, 'chainTruncated': bool(pending)}


def load_native(sealed):
    need(sha(sealed['native.py']) == NATIVE_SHA, 'EXACT_NATIVE_BEFORE_LOAD_REQUIRED')
    module = types.ModuleType('exact_report_cache_diagnostic_native')
    module.__file__ = str(CODE / 'native.py')
    exec(compile(sealed['native.py'], module.__file__, 'exec'), module.__dict__)
    return module.Native


def snapshot_summary(value):
    need(type(value) is dict and type(value.get('sourceModes')) is dict
         and type(value.get('staticModes')) is dict
         and type(value.get('containers', {}).get('content', {}).get('files')) is list,
         'CLOSED_SNAPSHOT_SUMMARY_REQUIRED')
    return {'sha256': sha(canonical(value)), 'sourceFiles': len(value['sourceModes']),
            'staticFiles': len(value['staticModes']),
            'chainFiles': len(value['containers']['content']['files'])}


def checkpoint_summary(value):
    need(type(value) is dict and set(value) == {'report', 'content', 'traffic'},
         'CLOSED_CHECKPOINT_SUMMARY_REQUIRED')
    return {'sha256': sha(canonical(value)), 'stores': 3}


class Discard:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def quiet_call(method, *args):
    with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
        return method(*args)


def diagnose(pid):
    output = {'schema': 1, 'name': NAME, 'status': 'READ_ONLY_DIAGNOSTIC_REFUSED',
              'leasePid': pid, 'runtimeAuthorization': False, 'runtimeWrites': 0,
              'directDatabaseWrites': 0, 'codeVerified': False, 'phases': []}
    phase = 'lease'
    try:
        platform_guard()
        lease(pid)
        phase = 'code'
        sealed = verify_code()
        output['codeVerified'] = True
        phase = 'artifacts'
        before = artifact_facts()
        output['artifacts'] = before
        phase = 'constructor'
        lease(pid)
        constructor = quiet_call(load_native, sealed)
        native = quiet_call(constructor, pid)
        output['phases'].append({'phase': phase, 'status': 'PASS'})
        for phase, method, summarize in (
                ('stable', native.stable, lambda value: None),
                ('snapshot', native.snapshot, snapshot_summary),
                ('checkpoint', native.checkpoint, checkpoint_summary)):
            lease(pid)
            value = quiet_call(method)  # Exactly one direct invocation; stop on the first failure.
            row = {'phase': phase, 'status': 'PASS'}
            summary = summarize(value)
            if summary is not None:
                row['summary'] = summary
            output['phases'].append(row)
        phase = 'final_artifacts'
        lease(pid)
        after = artifact_facts()
        output['ownArtifactsUnchanged'] = before == after
        need(before == after, 'OWN_ARTIFACTS_CHANGED_DURING_DIAGNOSTIC')
        output['status'] = 'READ_ONLY_DIAGNOSTIC_PASS_NOT_AUTHORIZATION'
    except BaseException as error:
        output['phases'].append({'phase': phase, 'status': 'REFUSED', 'error': error_summary(error)})
    return output


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('EXPLICIT_LEASE_ARGUMENT_REQUIRED')


def main(argv=None):
    try:
        parser = SafeParser(description='Read-only diagnostic; no attempt or runtime actions')
        parser.add_argument('--lease-pid', required=True, type=int)
        args = parser.parse_args(argv)
        output = diagnose(args.lease_pid)
    except BaseException as error:
        output = {'schema': 1, 'name': NAME, 'status': 'READ_ONLY_DIAGNOSTIC_REFUSED',
                  'runtimeAuthorization': False, 'runtimeWrites': 0, 'directDatabaseWrites': 0,
                  'phases': [{'phase': 'arguments', 'status': 'REFUSED', 'error': error_summary(error)}]}
    print(json.dumps(output, sort_keys=True, separators=(',', ':')))
    return 0 if output['status'] == 'READ_ONLY_DIAGNOSTIC_PASS_NOT_AUTHORIZATION' else 1


if __name__ == '__main__':
    raise SystemExit(main())
