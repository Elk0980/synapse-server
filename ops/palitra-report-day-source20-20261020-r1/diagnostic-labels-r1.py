"""Read-only, three-label facts only. Does not invoke any preflight or snapshot."""
import sys
sys.dont_write_bytecode = True
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import stat
import types

NAME = 'report-day-source20-cache-20261020-r1'
DIAGNOSTIC_PATH = Path('/tmp/report-day-source20-diagnostic-r1.py')
DIAGNOSTIC_SHA = '82524540b3e05e7dc204721c3a24412ac2bce9ab02178c8c3358016ae5465714'
NATIVE_SHA = '81c06fb50820ac4507766d5c1540cc0b34945813b180718d6d37f24dd0167874'
PARENT = 'sha256:0d8a86b8ace8ea919c389aa07cef2ce71e527fd618f2e7acf290c6b2ede9032c'
RELEASED_PIDS = frozenset({3161783, 3196874, 3200094, 3202295, 3204327, 3205870})
KEYS = ('com.docker.compose.config-hash', 'com.docker.compose.image',
        'com.docker.compose.project.config_files')
ALLOWED_API = ('platform_guard', 'lease', 'verify_code', 'load_native', 'error_summary')
NOFOLLOW = getattr(os, 'O_NOFOLLOW', None)
MAX_LABEL = 32768


def need(ok, code):
    if not ok:
        raise ValueError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def facts(path):
    return os.lstat(path)


def opened(fd):
    return os.fstat(fd)


def identity(info):
    return tuple(getattr(info, name) for name in (
        'st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_nlink',
        'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def bootstrap_platform():
    need(os.name == 'posix' and os.geteuid() == os.getegid() == 0
         and NOFOLLOW is not None, 'POSIX_ROOT_LABEL_DIAGNOSTIC_REQUIRED')


def parent_facts(path):
    result = []
    for parent in reversed(path.parents):
        info = facts(parent)
        mode = stat.S_IMODE(info.st_mode)
        writable_tmp = parent == Path('/tmp') and mode == 0o1777
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0
             and (not mode & 0o022 or writable_tmp), 'ROOT_PARENT_OR_EXACT_STICKY_TMP_REQUIRED')
        result.append((str(parent), info.st_dev, info.st_ino, info.st_uid, info.st_gid, mode))
    return result


def read_dependency(path):
    need(type(path) is type(DIAGNOSTIC_PATH) and path.is_absolute() and path == DIAGNOSTIC_PATH,
         'EXACT_KNOWN_DIAGNOSTIC_PATH_REQUIRED')
    parents_before = parent_facts(path)
    before = facts(path)
    need(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0
         and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) in (0o600, 0o644)
         and 0 < before.st_size <= 2 * 1024 * 1024, 'ROOT_SINGLE_LINK_PINNED_DIAGNOSTIC_REQUIRED')
    fd = os.open(path, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK)
    try:
        need(identity(opened(fd)) == identity(before), 'DIAGNOSTIC_OPEN_CHANGED')
        with os.fdopen(fd, 'rb', closefd=False) as file:
            raw = file.read(2 * 1024 * 1024 + 1)
        need(len(raw) == before.st_size and identity(opened(fd)) == identity(before)
             and identity(facts(path)) == identity(before) and parent_facts(path) == parents_before,
             'DIAGNOSTIC_CHANGED_DURING_READ')
        need(sha(raw) == DIAGNOSTIC_SHA, 'EXACT_8252_DIAGNOSTIC_REQUIRED')
        return raw
    finally:
        os.close(fd)


def load_dependency(path):
    raw = read_dependency(path)
    module = types.ModuleType('exact_8252_readonly_label_dependency')
    module.__file__ = str(path)
    # Exact reviewed module: only imports/constants/definitions execute. Its
    # __main__ branch is false. Expose only these five reviewed callable seams.
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    need(all(callable(getattr(module, name, None)) for name in ALLOWED_API), 'CLOSED_DIAGNOSTIC_API_REQUIRED')
    return types.SimpleNamespace(**{name: getattr(module, name) for name in ALLOWED_API})


class Discard:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def quiet(method, *args):
    with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
        return method(*args)


def bounded_string(value):
    return type(value) is str and 0 < len(value) <= MAX_LABEL \
        and len(value.encode('utf-8')) <= MAX_LABEL


def value_fact(actual, expected):
    need(bounded_string(expected), 'BOUNDED_EXPECTED_LABEL_REQUIRED')
    valid = bounded_string(actual)
    return {'actualIsBoundedString': valid, 'equalsExpected': valid and actual == expected,
            'actualSha256': sha(actual.encode()) if valid else None,
            'expectedSha256': sha(expected.encode())}


def compare(rows, metadata):
    need(type(metadata) is dict and type(metadata.get('content')) is dict
         and metadata['content'].get('image') == PARENT, 'EXACT_PARENT_METADATA_REQUIRED')
    need(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict,
         'ONE_CURRENT_CONTENT_INSPECT_REQUIRED')
    row = rows[0]
    need(row.get('Image') == PARENT, 'FULL_RUNNING_IMAGE_MUST_EQUAL_PARENT')
    config = row.get('Config')
    need(type(config) is dict and type(config.get('Labels')) is dict, 'EXACT_CURRENT_CONFIG_LABELS_REQUIRED')
    labels = config['Labels']
    expected = {KEYS[0]: metadata['content'].get('configHash'), KEYS[1]: metadata['content']['image'],
                KEYS[2]: metadata['content'].get('configFiles')}
    facts_by_key = {key: value_fact(labels.get(key), expected[key]) for key in KEYS}
    return {'labels': facts_by_key, 'allThreeLabelsEqualExpected': all(
                value['equalsExpected'] for value in facts_by_key.values()),
            'fullImageEqualsParent': True, 'fullImageSha256': sha(row['Image'].encode()),
            'configImage': value_fact(config.get('Image'), PARENT),
            'composeImageLabelEqualsMetadataImage': facts_by_key[KEYS[1]]['equalsExpected']}


def fallback_error(error):
    try:
        raw = str(error).encode('utf-8', 'backslashreplace')
    except BaseException:
        raw = b'<unprintable>'
    return {'class': type(error).__name__ if type(error).__module__ == 'builtins' else 'Exception',
            'messageSha256': sha(raw)}


def diagnose(pid, path):
    output = {'schema': 1, 'name': NAME, 'status': 'READ_ONLY_LABEL_DIAGNOSTIC_REFUSED',
              'leasePid': pid, 'runtimeAuthorization': False, 'runtimeWrites': 0,
              'directDatabaseWrites': 0, 'diagnosticSha256': DIAGNOSTIC_SHA,
              'nativeSha256': NATIVE_SHA, 'phases': []}
    phase, dependency = 'bootstrap', None
    try:
        bootstrap_platform()
        need(type(pid) is int and 1 < pid <= 2 ** 31 - 1 and pid not in RELEASED_PIDS,
             'FRESH_LABEL_DIAGNOSTIC_PID_REQUIRED')
        phase = 'dependency'
        dependency = quiet(load_dependency, path)
        phase = 'lease'
        quiet(dependency.platform_guard)
        quiet(dependency.lease, pid)
        phase = 'code'
        sealed = quiet(dependency.verify_code)
        need(type(sealed) is dict and len(sealed) == 10 and sha(sealed['native.py']) == NATIVE_SHA,
             'EXACT_TEN_CODE_AND_NATIVE_REQUIRED')
        output['codeVerified'] = True
        phase = 'constructor'
        constructor = quiet(dependency.load_native, sealed)
        native = quiet(constructor, pid)
        output['phases'].append({'phase': phase, 'status': 'PASS'})
        phase = 'stable_before'
        quiet(native.stable)
        quiet(native.lease)
        phase = 'metadata'
        metadata = quiet(native._metadata, PARENT, None, None)
        phase = 'inspect'
        raw = quiet(native.run, ['docker', 'inspect', 'synapse-content-1'])
        need(type(raw) is bytes and len(raw) <= 32 * 1024 * 1024, 'BOUNDED_CURRENT_INSPECT_REQUIRED')
        rows = json.loads(raw)
        phase = 'compare'
        result = compare(rows, metadata)
        phase = 'stable_after'
        quiet(native.stable)
        quiet(native.lease)
        quiet(dependency.lease, pid)
        output['result'] = result
        output['status'] = 'READ_ONLY_THREE_LABEL_FACTS_NOT_AUTHORIZATION'
    except BaseException as error:
        summary = quiet(dependency.error_summary, error) if dependency is not None else fallback_error(error)
        output['phases'].append({'phase': phase, 'status': 'REFUSED', 'error': summary})
    return output


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('EXPLICIT_LABEL_DIAGNOSTIC_ARGUMENTS_REQUIRED')


def main(argv=None):
    try:
        parser = SafeParser(description='Read-only three-label hashes and equalities only')
        parser.add_argument('--lease-pid', required=True, type=int)
        parser.add_argument('--diagnostic-path', required=True)
        args = parser.parse_args(argv)
        output = diagnose(args.lease_pid, Path(args.diagnostic_path))
    except BaseException as error:
        output = {'schema': 1, 'name': NAME, 'status': 'READ_ONLY_LABEL_DIAGNOSTIC_REFUSED',
                  'runtimeAuthorization': False, 'runtimeWrites': 0, 'directDatabaseWrites': 0,
                  'phases': [{'phase': 'arguments', 'status': 'REFUSED', 'error': fallback_error(error)}]}
    print(json.dumps(output, sort_keys=True, separators=(',', ':')))
    return 0 if output['status'] == 'READ_ONLY_THREE_LABEL_FACTS_NOT_AUTHORIZATION' else 1


if __name__ == '__main__':
    raise SystemExit(main())
