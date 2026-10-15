"""Root-only Forms preflight and one-pass approval/dry-run/import wrapper.

No model transfer, DDL, authentication changes, worker changes or UI activation.
Uses the unchanged, SHA-pinned private_migration.py API for all DB operations.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import sys
import types
from datetime import datetime, timezone

PRIVATE = Path('/opt/synapse/.palitra-private-0248')
HELPER_SHA = '97af08c01ac2767b4c2886d4084e6f0f132c2a361b7eedf6cf9aabf27790b46d'
PAYLOAD_SHA = '050069118ebedc69b53f32d5bb4e5c14ebab43de77647086c09b9a7f4c6105cf'
SOURCE_SHA = '2403760685e44680de44c614d0bcc2d41158a3598f0283dfa14561868fb27ddb'
COMPRESSED_SHA = 'e382b8e1707358d11513e32b192bd3e0066e16d1e96e059add151d0b6e98fd36'
PLAIN_SHA = '6dcb0957e9310aa4731c76005a5883a9932fec61f5726b95df837d9a1e4998bd'
FEATURE_SHA = '04c85b427ad034c78a6450205408d9af1fe35aa16ad96a853ac74c52f4302801'
KEY = 'project-forms/palitra-love/palitra-orders'
LEASE = {'path': '/opt/synapse/.palitra-app-release.lock', 'pid': 2744197}
MAX_OWNER = 4096


class Refused(Exception):
    pass


def need(value, message):
    if not value:
        raise Refused(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('ascii')


def timestamp(value):
    need(type(value) is str and len(value) <= 50, 'Invalid proof time')
    try:
        date = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise Refused('Invalid proof time')
    need(date.tzinfo is not None, 'UTC offset required')
    return date.timestamp()


def now():
    return datetime.now(timezone.utc).timestamp()


def safe_read(path, limit=16 * 1024 * 1024):
    # Bootstrap the pinned helper without writing import bytecode or following links.
    path = Path(path).absolute()
    for part in [*reversed(path.parents), path]:
        need(not part.is_symlink(), 'Symlink refused')
    before = path.stat()
    need(path.is_file() and 0 < before.st_size <= limit, 'Bounded existing regular file required')
    with path.open('rb') as file:
        raw = file.read(limit + 1)
        opened = os.fstat(file.fileno())
    after = path.stat()
    signature = lambda stat: (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
    need(signature(before) == signature(opened) == signature(after), 'Input changed while reading')
    return raw


def load_migration(path):
    raw = safe_read(path, 128 * 1024)
    need(digest(raw) == HELPER_SHA, 'Pinned migration helper changed')
    module = types.ModuleType('palitra_accepted_private_migration')
    module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def command(argv, fact='selected'):
    result = subprocess.run(argv, capture_output=True, timeout=25)
    need(result.returncode == 0 and len(result.stdout) <= 64 * 1024, 'Native ' + fact + ' command refused')
    return result.stdout.decode('utf-8').strip()


def native_runtime(migration):
    migration.lease({'lease': LEASE})
    image = command(['docker', 'inspect', '--format', '{{.Image}}', 'synapse-content-1'], 'image')
    need(re.fullmatch(r'sha256:[0-9a-f]{64}', image) is not None, 'Exact current image required')
    feature = command(['docker', 'exec', 'synapse-content-1', 'sha256sum', '/app/project-forms.cjs'], 'feature')
    need(feature.split() == [FEATURE_SHA, '/app/project-forms.cjs'], 'Installed Forms feature changed')
    code = "const fs=require('fs'),p=process.env.DATABASE_PATH||'/data/content.sqlite';console.log(JSON.stringify({path:p,realpath:fs.realpathSync(p)}));"
    configured = json.loads(command(['docker', 'exec', 'synapse-content-1', 'node', '-e', code], 'DB-path'))
    need(set(configured) == {'path', 'realpath'} and configured['path'] == configured['realpath'], 'Container DB symlink/binding refused')
    container = configured['path']
    need(type(container) is str and container.startswith('/') and '..' not in PurePosixPath(container).parts, 'Absolute container DB path required')
    mounts = json.loads(command(['docker', 'inspect', '--format', '{{json .Mounts}}', 'synapse-content-1'], 'mounts'))
    need(type(mounts) is list, 'Selected mount inventory required')
    matching = [m for m in mounts if type(m) is dict and type(m.get('Destination')) is str and
                (container == m['Destination'] or container.startswith(m['Destination'].rstrip('/') + '/'))]
    need(bool(matching), 'No actual DB mount binding')
    longest = max(len(m['Destination']) for m in matching)
    matching = [m for m in matching if len(m['Destination']) == longest]
    need(len(matching) == 1, 'Ambiguous DB mount binding')
    mount = matching[0]
    need(mount.get('Type') in ('volume', 'bind') and mount.get('RW') is True, 'Existing writable data mount required')
    need(type(mount.get('Source')) is str and mount['Source'].startswith('/'), 'Absolute host mount required')
    need('..' not in PurePosixPath(mount['Source']).parts and '..' not in PurePosixPath(mount['Destination']).parts, 'Unsafe mount binding')
    relative = PurePosixPath(container).relative_to(PurePosixPath(mount['Destination']))
    host = migration.safe(Path(mount['Source']).joinpath(*relative.parts))
    need(host.is_file(), 'Existing host DB required')
    stat = host.stat()
    need(command(['docker', 'inspect', '--format', '{{.Image}}', 'synapse-content-1'], 'image') == image,
         'Native image changed during selected fact capture')
    migration.lease({'lease': LEASE})
    return {'image': image, 'featureSha256': FEATURE_SHA, 'lease': LEASE,
            'containerDatabasePath': container,
            'binding': {'type': mount['Type'], 'source': mount['Source'], 'destination': mount['Destination'],
                        'rw': True, 'hostPath': str(host), 'deviceInode': [stat.st_dev, stat.st_ino]}}


class NoEcho:
    def __init__(self, stream, terminal=None):
        self.stream, self.terminal = stream, terminal
        self.original, self.descriptor, self.handlers = None, None, {}

    def interrupted(self, _signum, _frame):
        raise Refused('Owner receiver interrupted; inspect without retry')

    def __enter__(self):
        try:
            need(self.stream.isatty(), 'Root official terminal input required')
            if self.terminal is None:
                import termios
                self.terminal = termios
            self.descriptor = self.stream.fileno()
            self.original = self.terminal.tcgetattr(self.descriptor)
            # Install before masking echo, so TERM/HUP cannot leave an unguarded
            # interval. The accepted frontend receiver uses the same lifecycle.
            for name in ('SIGTERM', 'SIGHUP'):
                signum = getattr(signal, name, None)
                if signum is not None:
                    self.handlers[signum] = signal.getsignal(signum)
                    signal.signal(signum, self.interrupted)
            changed = list(self.original)
            changed[3] &= ~(self.terminal.ECHO | self.terminal.ECHONL)
            self.terminal.tcsetattr(self.descriptor, self.terminal.TCSANOW, changed)
        except BaseException:
            self.restore(True)
            raise
        return self

    def restore(self, flush):
        try:
            if self.original is not None:
                try:
                    if flush:
                        try:
                            self.terminal.tcflush(self.descriptor, self.terminal.TCIFLUSH)
                        except OSError:
                            pass
                finally:
                    self.terminal.tcsetattr(self.descriptor, self.terminal.TCSANOW, self.original)
        finally:
            for signum, handler in self.handlers.items():
                signal.signal(signum, handler)
            self.handlers = {}

    def __exit__(self, kind, _value, _traceback):
        self.restore(kind is not None)
        return False


def owner_input(expected_sha):
    need(re.fullmatch(r'[0-9a-f]{64}', expected_sha or '') is not None, 'Independent owner data SHA format required before receiver')
    with NoEcho(sys.stdin):
        print('FORMS_OWNER_RECEIVER_ACTIVE_NOECHO_SEND_ONE_ASCII_JSON_LINE_AND_EOF', flush=True)
        # Drain through explicit EOF even after overflow; trailing paste must not
        # escape back into the shell as commands. Memory stays bounded.
        pieces, size, overflow = [], 0, False
        while True:
            part = sys.stdin.buffer.read(1024)
            if not part:
                break
            size += len(part)
            if size > MAX_OWNER:
                overflow = True
                pieces.clear()
            elif not overflow:
                pieces.append(part)
        raw = b''.join(pieces)
        need(not overflow and 0 < len(raw) <= MAX_OWNER, 'Owner data oversized/empty')
        need(raw.endswith(b'\n') and raw.count(b'\n') == 1 and all(byte == 10 or 32 <= byte <= 126 for byte in raw),
             'Exactly one ASCII JSON line plus LF required')
        need(digest(raw) == expected_sha, 'Actual owner data SHA mismatch')
        return raw


class Engine:
    def __init__(self, root, migration, runtime_reader, validator=None):
        self.root = Path(root)
        self.m = migration
        self.runtime_reader = runtime_reader
        self.validator = validator or migration.native_validator

    def paths(self, name):
        need(type(name) is str and re.fullmatch(r'forms-r[1-9][0-9]{0,3}', name) is not None, 'New bounded forms-rN name required')
        return {key: self.root / (name + '-' + suffix + '.json') for key, suffix in
                [('preflight', 'preflight'), ('proof', 'owner-proof'), ('approval', 'approval'),
                 ('journal', 'import-journal'), ('complete', 'complete')]}

    def inputs(self):
        need(digest(self.m.read(self.root / 'private_migration.py', 128 * 1024)) == HELPER_SHA, 'Migration helper changed')
        raw = self.m.read(self.root / 'payload.json', 16 * 1024 * 1024)
        need(digest(raw) == PAYLOAD_SHA, 'Received payload changed')
        payload, envelope = self.m.unpack(raw)
        need(payload['namespace'] == KEY and payload['source']['latestRawSha256'] == SOURCE_SHA and
             payload['source']['latestRevision'] == 189 and len(payload['documents']) == 189 and
             [x['sourceId'] for x in payload['auxiliaryExports']] == ['user-export-r79'] and
             envelope['compressedSha256'] == COMPRESSED_SHA and envelope['plainSha256'] == PLAIN_SHA,
             'Frozen private snapshot inventory changed')
        return raw

    def facts(self):
        self.inputs()
        runtime = self.runtime_reader()
        need(runtime['featureSha256'] == FEATURE_SHA and runtime['lease'] == LEASE, 'Native feature/lease changed')
        inspection = self.m.inspect(runtime['binding']['hostPath'])
        need(inspection['namespace'] == KEY and inspection['dbWrites'] == 0, 'Wrong namespace inspection')
        need(inspection['db']['deviceInode'] == runtime['binding']['deviceInode'], 'DB binding changed during inspect')
        need(inspection['base']['count'] == 0 and inspection['base']['tip'] == 0 and inspection['base']['authors'] == [],
             'Namespace is not empty; inspect existing journal without retry')
        return runtime, inspection

    def preflight(self, name):
        paths = self.paths(name)
        need(not any(path.exists() for path in paths.values()), 'Attempt name already exists')
        runtime, inspection = self.facts()
        receipt = {'schema': 1, 'kind': 'ROOT_FORMS_PRIVATE_PREFLIGHT', 'name': name,
                   'observedAt': datetime.now(timezone.utc).isoformat(), 'runtime': runtime,
                   'inspection': inspection, 'helperSha256': HELPER_SHA, 'payloadSha256': PAYLOAD_SHA,
                   'sourceLatestSha256': SOURCE_SHA, 'documents': 190, 'latestSourceRevision': 189,
                   'expectedLatestNativeVersion': 190, 'rootApprovalRequired': True}
        raw = encode(receipt)
        self.m.newfile(paths['preflight'], raw)
        return {'status': 'PREFLIGHT_READONLY_BASE_READY_NOT_IMPORTED', 'name': name,
                'preflightSha256': digest(raw), 'contentImage': runtime['image'],
                'databasePath': inspection['db']['path'], 'databaseDeviceInode': inspection['db']['deviceInode'],
                'schemaDigest': inspection['db']['schemaDigest'], 'baseDigest': inspection['base']['digest'],
                'namespaceCount': 0, 'namespaceTip': 0, 'documentsPlanned': 190,
                'latestNativeVersionPlanned': 190, 'dbWrites': 0}

    def verify_preflight(self, name, expected_sha):
        paths = self.paths(name)
        raw = self.m.read(paths['preflight'], 64 * 1024)
        need(re.fullmatch(r'[0-9a-f]{64}', expected_sha or '') is not None and digest(raw) == expected_sha, 'Independent preflight SHA mismatch')
        receipt = self.m.decode(raw)
        need(receipt.get('schema') == 1 and receipt.get('kind') == 'ROOT_FORMS_PRIVATE_PREFLIGHT' and
             receipt.get('name') == name and receipt.get('helperSha256') == HELPER_SHA and
             receipt.get('payloadSha256') == PAYLOAD_SHA and receipt.get('sourceLatestSha256') == SOURCE_SHA and
             receipt.get('documents') == 190 and receipt.get('expectedLatestNativeVersion') == 190,
             'Preflight contract mismatch')
        need(0 <= now() - timestamp(receipt['observedAt']) <= 900, 'Preflight stale/future; use fresh name')
        runtime, inspection = self.facts()
        need(runtime == receipt['runtime'] and inspection == receipt['inspection'], 'Native BASE changed after Root preflight')
        return paths, receipt

    def proof(self, raw, expected_sha):
        need(type(raw) is bytes and 0 < len(raw) <= MAX_OWNER and raw.endswith(b'\n') and raw.count(b'\n') == 1 and
             all(byte == 10 or 32 <= byte <= 126 for byte in raw), 'Exactly one bounded ASCII JSON line plus LF required')
        need(re.fullmatch(r'[0-9a-f]{64}', expected_sha or '') is not None and digest(raw) == expected_sha, 'Actual owner data SHA mismatch')
        proof = self.m.decode(raw)
        need(type(proof) is dict and set(proof) == {'rootConfirmed', 'host', 'observedAt', 'identity'} and
             proof['rootConfirmed'] is True and proof['host'] == 'synapse.synapsebusiness.ru', 'Exact selected owner proof required')
        actor = proof['identity']
        need(type(actor) is dict and set(actor) == {'id', 'role', 'company', 'board', 'sessionVersion'} and
             actor['id'] == '1' and actor['role'] == 'owner' and actor['company'] == 'palitra-love' and
             actor['board'] == 'palitra-orders', 'Actual Root owner/company changed')
        version = actor['sessionVersion']
        need(version is None or (type(version) is str and 0 < len(version) <= 128 and version.isascii()) or
             (type(version) is int and 0 <= version < 2**53), 'Invalid actual sessionVersion type')
        need(0 <= now() - timestamp(proof['observedAt']) <= 300, 'Actual owner proof stale/future')
        return proof

    def apply(self, name, preflight_sha, source_frozen_sha, owner_sha, raw_owner, *, apply=False):
        need(apply is True and source_frozen_sha == SOURCE_SHA, 'Explicit Root apply/source freeze required')
        paths, receipt = self.verify_preflight(name, preflight_sha)
        need(not any(paths[key].exists() for key in ('proof', 'approval', 'journal', 'complete')), 'Attempt already started; inspect without retry')
        proof = self.proof(raw_owner, owner_sha)
        approval = {'schema': 1, 'rootApproved': True, 'namespace': KEY,
                    'compressedSha256': COMPRESSED_SHA, 'plainSha256': PLAIN_SHA,
                    'sourceLatestSha256': SOURCE_SHA, 'featureSha256': FEATURE_SHA,
                    'databaseBindingVerified': True, 'sourceSnapshotFrozen': True,
                    'contentImage': receipt['runtime']['image'], 'lease': LEASE,
                    'db': receipt['inspection']['db'], 'base': receipt['inspection']['base'],
                    'owner': proof['identity'], 'ownerProofSha256': owner_sha,
                    'allowedExistingAuthors': [], 'includeAuxiliaryExports': ['user-export-r79']}
        self.m.newfile(paths['proof'], raw_owner)
        self.m.newfile(paths['approval'], encode(approval))
        reader = lambda: self.m.read(paths['proof'], MAX_OWNER)

        def guard_lease(_approval):
            # Frozen helper calls this before work, in BEGIN, and before COMMIT.
            self.inputs()
            need(self.runtime_reader() == receipt['runtime'], 'Native image/feature/lease/DB binding changed')

        def validate(models, actual_approval):
            self.validator(models, actual_approval)
            guard_lease(actual_approval)

        raw = self.inputs()
        result = self.m.import_payload(raw, approval, approval['db']['path'], reader,
                                       apply=False, validator=validate, lease_check=guard_lease)
        need(result == {'status': 'DRY_RUN_NO_WRITES', 'documents': 190, 'latestSourceRevision': 189,
                        'latestNativeVersion': 190, 'dbWrites': 0}, 'Dry-run contract mismatch')
        guard_lease(approval)
        result = self.m.import_payload(raw, approval, approval['db']['path'], reader, apply=True,
                                       journal=paths['journal'], validator=validate, lease_check=guard_lease)
        need(result.get('status') == 'IMPORTED_DOCUMENTS_ONLY' and result.get('dbRowsInserted') == 190 and
             result.get('latestNativeVersion') == 190, 'Import outcome requires readonly investigation')
        journal_raw = self.m.read(paths['journal'])
        need(digest(journal_raw) == result['journalSha256'], 'Import journal changed')
        journal = self.m.decode(journal_raw)
        final = self.m.inspect(approval['db']['path'])
        need(final['base'] == journal['after'] and final['base']['count'] == 190 and final['base']['tip'] == 190,
             'Committed namespace requires readonly investigation')
        guard_lease(approval)
        complete = {'status': 'ROOT_FORMS_IMPORTED_READBACK_NOT_UI_PROOF', 'name': name,
                    'documents': 190, 'latestNativeVersion': 190, 'sourceLatestRevision': 189,
                    'sourceLatestSha256': SOURCE_SHA, 'journalSha256': result['journalSha256'],
                    'namespaceDigest': final['base']['digest'], 'dbRowsInserted': 190}
        self.m.newfile(paths['complete'], encode(complete))
        return complete


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['preflight', 'apply'])
    parser.add_argument('--name', required=True)
    parser.add_argument('--preflight-sha')
    parser.add_argument('--source-frozen-sha')
    parser.add_argument('--expected-owner-data-sha')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    stage = 'BOOTSTRAP'
    try:
        need(os.name == 'posix' and os.geteuid() == 0, 'Native Root execution required')
        migration = load_migration(PRIVATE / 'private_migration.py')
        migration.private_cli_path(PRIVATE / 'private_migration.py', True)
        migration.private_cli_path(PRIVATE / 'payload.json', True)
        engine = Engine(PRIVATE, migration, lambda: native_runtime(migration))
        if args.operation == 'preflight':
            need(not args.apply, 'Preflight never accepts --apply')
            stage = 'PREFLIGHT'
            result = engine.preflight(args.name)
        else:
            need(args.apply and args.source_frozen_sha == SOURCE_SHA, 'Explicit Root apply/source freeze required')
            need(re.fullmatch(r'[0-9a-f]{64}', args.expected_owner_data_sha or '') is not None,
                 'Independent owner data SHA format required before receiver')
            stage = 'APPROVAL_PREFLIGHT_RECHECK'
            paths, _receipt = engine.verify_preflight(args.name, args.preflight_sha)
            need(not any(paths[key].exists() for key in ('proof', 'approval', 'journal', 'complete')), 'Attempt already started; no retry')
            stage = 'ACTUAL_OWNER_DATA'
            raw = owner_input(args.expected_owner_data_sha)
            stage = 'DRY_RUN_AND_SINGLE_IMPORT'
            result = engine.apply(args.name, args.preflight_sha, args.source_frozen_sha,
                                  args.expected_owner_data_sha, raw, apply=True)
        print(json.dumps(result, ensure_ascii=True, separators=(',', ':')), flush=True)
        return 0
    except (Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        # No captured command output, model, token, proof or raw input is emitted.
        known_refused = isinstance(error, Refused) or ('migration' in locals() and isinstance(error, migration.Refused))
        reason = str(error) if known_refused else type(error).__name__
        print(json.dumps({'status': 'REFUSED', 'stage': stage, 'reason': reason}, ensure_ascii=True), flush=True)
        return 2
    except Exception as error:
        known_refused = 'migration' in locals() and isinstance(error, migration.Refused)
        reason = str(error) if known_refused else type(error).__name__
        print(json.dumps({'status': 'REFUSED', 'stage': stage, 'reason': reason}, ensure_ascii=True), flush=True)
        return 2


if __name__ == '__main__':
    sys.exit(main())
