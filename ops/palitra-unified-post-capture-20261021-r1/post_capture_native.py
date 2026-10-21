"""New private post-cleanup capture. No approval, admission or runtime writer.

Only Root/Linux main opens the existing content DB, read-only with its existing
WAL/SHM. Pinned R5 capture primitives and the pinned R6 Factory provide the
actual seals. The old live-content minimum is deliberately NOT called after a
legitimate deletion: report/traffic and every historical backup guard remain
unchanged; current content is independently captured for later Root review.
"""
import argparse
import hashlib
import importlib
import json
import os
import re
import sqlite3
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
PACKAGE = ROOT / 'palitra-unified-orders-20261021-r1-code'
PACKAGE_SHA = 'efd51087a3c9a1e1d778aa34f8b9a8850d6ff32969c10cbde755dc47da8e760e'
INSPECTOR_SHA = '7de083ac3cf4b39c352ed7b3c60d35e447480f0ab836915d2c87482ef8125c09'
ENGINE = ROOT / 'palitra-order-cleanup-copy-20261021-r10-code/cleanup_runtime.py'
ENGINE_SHA = '6bd4b9f29ff1ffd4e553750d43df437444b5651485748e1eeca82163c8259861'
DATABASE = Path('/var/lib/docker/volumes/synapse_content_data/_data/content.sqlite')
IMAGE = 'sha256:951db09e9e6c4781350bbced7e7a9e4ef099077a368e38a6b1fac40e0a4a6a22'
GUARD_RECEIPT_SHA = '34ce6389ef04a5db158d5b1a27734e2d09c919df28b35a9dad4561af48d42892'
LOCK = '/opt/synapse/.palitra-app-release.lock'
OUTPUT_PREFIX = 'palitra-unified-post-cleanup-20261021-r1-'
SHA = lambda raw: hashlib.sha256(raw).hexdigest()


def need(value, code):
    if not value:
        raise ValueError(code)


def digest(value):
    return type(value) is str and re.fullmatch('[a-f0-9]{64}', value) is not None


def exact(path, *, missing=False):
    p = Path(path)
    need(p.is_absolute() and '..' not in p.parts, 'ABSOLUTE_CANONICAL_PATH_REQUIRED')
    for part in (p, *p.parents):
        need(not part.is_symlink(), 'POST_CAPTURE_PATH_ALIAS_REFUSED')
    need(missing or p.exists(), 'EXISTING_POST_CAPTURE_INPUT_REQUIRED')
    return p


def identity(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def private_read(path, pin, maximum=16 * 1024 * 1024):
    need(digest(pin), 'EXACT_INPUT_SHA_REQUIRED')
    p = exact(path)
    need(ROOT in p.parents, 'PRIVATE_RELEASE_INPUT_ONLY')
    before = p.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == before.st_gid == 0 and stat.S_IMODE(before.st_mode) == 0o600 and before.st_size <= maximum, 'ROOT600_SINGLE_BOUNDED_INPUT_REQUIRED')
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(maximum + 1)
        need(identity(before) == identity(os.fstat(fd)) == identity(p.lstat()) and len(raw) == before.st_size and SHA(raw) == pin, 'EXACT_INPUT_BYTES_AND_IDENTITY_REQUIRED')
    finally:
        os.close(fd)
    return raw


def closed_code(directory, manifest_name, manifest_sha, count, *, package):
    directory = exact(directory)
    info = directory.lstat()
    need(directory.parent == ROOT and stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'ROOT700_STAGED_CODE_DIRECTORY_REQUIRED')
    manifest = json.loads(private_read(directory / manifest_name, manifest_sha))
    files = manifest.get('files')
    need(type(files) is dict and len(files) == count and manifest.get('runtimeAuthorization') is False, 'EXACT_CLOSED_CODE_COUNT_REQUIRED')
    if package:
        need(directory == PACKAGE and manifest.get('schema') == 'palitra-unified-native-code-manifest/v1' and manifest.get('namespace') == 'palitra-unified-orders-20261021-r1' and manifest.get('mutableRuntimeFiles') == [], 'EXACT_R5_PACKAGE_REQUIRED')
    else:
        need(manifest.get('schema') == 1 and manifest.get('status') == 'FROZEN_READONLY_CODE_ONLY_NOT_RUNTIME_ADMISSION', 'EXACT_R6_INSPECTOR_REQUIRED')
    expected_dirs = {p.as_posix() for name in files for p in Path(name).parents if str(p) != '.'}
    actual_files = set()
    actual_dirs = set()
    for path in directory.rglob('*'):
        exact(path)
        relative = path.relative_to(directory).as_posix()
        entry = path.lstat()
        if stat.S_ISDIR(entry.st_mode):
            need(entry.st_uid == entry.st_gid == 0 and stat.S_IMODE(entry.st_mode) == 0o700, 'ROOT700_PACKAGE_SUBDIRECTORY_REQUIRED')
            actual_dirs.add(relative)
        else:
            actual_files.add(relative)
    need(actual_files == set(files) | {manifest_name} and actual_dirs == expected_dirs, 'EXACT_STAGED_CODE_CLOSURE_REQUIRED')
    for name, pin in files.items():
        need(type(name) is str and not name.startswith('/') and '\\' not in name and ':' not in name and all(part not in ('', '.', '..') for part in name.split('/')), 'CLOSED_RELATIVE_CODE_PATH_REQUIRED')
        private_read(directory / name, pin)
    return files


def validate_links(receipt, pre_full, approval, *, pre_full_sha, approval_sha, pid, ticks):
    need(receipt.get('status') == 'CLEANUP_COMMITTED_REQUIRES_ROOT_READONLY_ACCEPTANCE' and receipt.get('runtimeAcceptance') is False and receipt.get('automaticRetry') is False and receipt.get('automaticRestore') is False and receipt.get('guardImage') == IMAGE, 'ACTUAL_COMMITTED_CLEANUP_RECEIPT_REQUIRED')
    bindings = receipt.get('transactionEvidence', {}).get('bindings', {})
    need(bindings.get('preFullInspectionSha256') == pre_full_sha and bindings.get('userApprovalSha256') == approval_sha, 'EXACT_COMMITTED_PRE_FULL_AND_APPROVAL_LINKS_REQUIRED')
    need(pre_full.get('schema') == 'palitra-readonly-managed260-inspection/v2' and pre_full.get('status') == 'EXACT_INSTALLED_GUARD_WITH_MANAGED260_READONLY_R2' and pre_full.get('mode') == 'full' and pre_full.get('fullInspection') is True and pre_full.get('runtimeWrites') == 0 and pre_full.get('runtimeAdmission') is False and pre_full.get('image') == IMAGE and pre_full.get('guardReceiptSha256') == GUARD_RECEIPT_SHA and pre_full.get('codeManifestSha256') == INSPECTOR_SHA and (pre_full.get('sourceFiles'), pre_full.get('staticFiles'), pre_full.get('chainFiles')) == (240, 43, 49), 'ACTUAL_EXACT_R6_PRE_FULL_REQUIRED')
    need(pre_full.get('lease') == {'pid': pid, 'startTicks': ticks, 'lock': LOCK}, 'SAME_ACTUAL_POST_CAPTURE_LEASE_REQUIRED')
    need(approval.get('status') == 'USER_CONFIRMED_PERMANENT_PALITRA_CLEANUP' and approval.get('permanentDeleteConfirmed') is True, 'ACTUAL_EXISTING_USER_APPROVAL_REQUIRED')


def readonly_authorizer(action, first, second, _database, _trigger):
    if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, getattr(sqlite3, 'SQLITE_RECURSIVE', -1)):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_TRANSACTION and first in ('BEGIN', 'ROLLBACK'):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_PRAGMA:
        name = (first or '').lower()
        if name in ('query_only', 'foreign_keys') and (second is None or str(second).lower() in ('on', '1')):
            return sqlite3.SQLITE_OK
        if name == 'busy_timeout' and (second is None or str(second) == '0'):
            return sqlite3.SQLITE_OK
        if name in ('quick_check', 'foreign_key_check', 'user_version', 'application_id', 'journal_mode') and second is None:
            return sqlite3.SQLITE_OK
        if name in ('table_xinfo', 'table_info') and type(second) is str and re.fullmatch('[A-Za-z_][A-Za-z0-9_]*', second):
            return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def encode_private(value):
    # SQLite BLOBs in rawPrivateMinimum stay lossless and private; no row value
    # is printed. Native-minimum row hashes and existing R6 hash semantics are
    # unaffected by this external JSON representation.
    def blob(item):
        need(type(item) is bytes, 'UNSUPPORTED_PRIVATE_JSON_VALUE')
        return {'__palitra_sqlite_blob_hex_v1__': item.hex()}
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=blob).encode()


def auxiliary_guard_proof(before, after):
    """Seal the actual present/ABSENT DTO without inventing missing content."""
    need(type(before) is dict and type(after) is dict, 'ACTUAL_AUXILIARY_DATABASE_DTOS_REQUIRED')
    if before.get('status') == 'ABSENT':
        need(after.get('status') == 'ABSENT' and before.get('identity') is None and after.get('identity') is None and before.get('content') is None and after.get('content') is None, 'ABSENT_AUXILIARY_DATABASE_MUST_REMAIN_ABSENT')
        need(type(before.get('family')) is dict and before['family'] and all(value is None for value in before['family'].values()) and after.get('family') == before['family'] and after.get('directoryIdentity') == before.get('directoryIdentity'), 'ABSENT_AUXILIARY_FAMILY_OR_DIRECTORY_CHANGED')
    def seal(value):
        return {'status': value.get('status'), 'identity': value.get('identity'), 'directoryIdentity': value.get('directoryIdentity'), 'family': value.get('family'), 'contentSha256': SHA(encode_private(value.get('content'))), 'actualMinimumSha256': SHA(encode_private(value))}
    return {'before': seal(before), 'after': seal(after)}


def write_exclusive(path, raw):
    p = exact(path, missing=True)
    need(p.parent.parent == ROOT and re.fullmatch(re.escape(OUTPUT_PREFIX) + '[a-f0-9]{32}', p.parent.name) and p.name in ('post-content-capture.json', 'native-content-minimum.json', 'guard-proof.json', 'CAPTURE_RESULT.json'), 'OWN_CAPTURE_OUTPUT_NAMESPACE_ONLY')
    parent = p.parent.lstat()
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == parent.st_gid == 0 and stat.S_IMODE(parent.st_mode) == 0o700, 'NEW_ROOT700_OUTPUT_DIRECTORY_REQUIRED')
    need(type(raw) is bytes and len(raw) <= 16 * 1024 * 1024, 'BOUNDED_PRIVATE_CAPTURE_OUTPUT_REQUIRED')
    fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        need(os.fstat(fd).st_nlink == 1 and stat.S_IMODE(os.fstat(fd).st_mode) == 0o600, 'NEW_ROOT600_CAPTURE_REQUIRED')
    finally:
        os.close(fd)
    need(private_read(p, SHA(raw)) == raw, 'CAPTURE_OUTPUT_READBACK_REQUIRED')
    return {'path': str(p), 'sha256': SHA(raw)}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Root-only readonly post-cleanup capture; no acceptance/admission')
    parser.add_argument('--capture-post-cleanup', action='store_true')
    parser.add_argument('--cleanup-receipt', type=Path, required=True)
    parser.add_argument('--cleanup-receipt-sha', required=True)
    parser.add_argument('--pre-full', type=Path, required=True)
    parser.add_argument('--pre-full-sha', required=True)
    parser.add_argument('--user-approval', type=Path, required=True)
    parser.add_argument('--user-approval-sha', required=True)
    parser.add_argument('--lease-pid', type=int, required=True)
    parser.add_argument('--lease-start-ticks', required=True)
    parser.add_argument('--inspector-directory', type=Path, required=True)
    parser.add_argument('--output-directory', type=Path, required=True)
    args = parser.parse_args(argv)
    need(args.capture_post_cleanup and os.name == 'posix' and os.geteuid() == 0, 'EXPLICIT_ROOT_LINUX_CAPTURE_REQUIRED')
    need(type(args.lease_pid) is int and args.lease_pid > 1 and re.fullmatch('[1-9][0-9]*', args.lease_start_ticks), 'EXACT_ACTUAL_LEASE_ARGUMENTS_REQUIRED')
    output = exact(args.output_directory, missing=True)
    need(output.parent == ROOT and re.fullmatch(re.escape(OUTPUT_PREFIX) + '[a-f0-9]{32}', output.name) and not output.exists(), 'NEW_EXACT_PRIVATE_CAPTURE_AREA_REQUIRED_NO_REPLAY')
    sources = [('cleanupReceipt', args.cleanup_receipt, args.cleanup_receipt_sha), ('preFull', args.pre_full, args.pre_full_sha), ('userApproval', args.user_approval, args.user_approval_sha)]
    raw = {key: private_read(path, pin) for key, path, pin in sources}
    docs = {key: json.loads(value) for key, value in raw.items()}
    validate_links(docs['cleanupReceipt'], docs['preFull'], docs['userApproval'], pre_full_sha=args.pre_full_sha, approval_sha=args.user_approval_sha, pid=args.lease_pid, ticks=args.lease_start_ticks)

    def code_guard():
        closed_code(PACKAGE, 'code-manifest.json', PACKAGE_SHA, 63, package=True)
        return closed_code(args.inspector_directory, 'readonly-code-pins.json', INSPECTOR_SHA, 14, package=False)

    inspector_pins = code_guard()
    engine_raw = private_read(ENGINE, ENGINE_SHA)
    need(not any(name in sys.modules for name in ('post_content_capture', 'forward_guard', 'schema_migration', 'manifest_inputs', 'private_files', 'inspect_readonly')), 'FRESH_POST_CAPTURE_PROCESS_REQUIRED')
    sys.path.insert(0, str(PACKAGE))
    capture_module = importlib.import_module('post_content_capture')
    bridge = importlib.import_module('forward_guard')
    for module in (capture_module, bridge):
        need(Path(module.__file__).resolve().parent == PACKAGE, 'EXACT_LOADED_R5_MODULE_REQUIRED')
    inspector, loaded_pins = bridge.load_inspector(args.inspector_directory, INSPECTOR_SHA)
    need(loaded_pins == inspector_pins, 'SAME_EXACT_R6_CODE_REQUIRED')

    def lease_gate():
        need(inspector.M.lease(args.lease_pid) == args.lease_start_ticks, 'ACTUAL_ROOT_LEASE_CHANGED')
        return {'pid': args.lease_pid, 'startTicks': args.lease_start_ticks, 'lock': LOCK}

    lease_gate()
    factory = inspector.Factory(args.lease_pid, inspector_pins, 'runtime-cas')
    need(factory.ticks == args.lease_start_ticks, 'FACTORY_ACTUAL_LEASE_CHANGED')
    factory.make_databases()
    capture_module.inspect_transaction_receipt(docs['cleanupReceipt'], engine_sha256=ENGINE_SHA, pre_full_sha256=args.pre_full_sha, user_approval_sha256=args.user_approval_sha)

    def checkpoint(previous=None):
        lease_gate(); factory.history_guard(); factory.managed_guard(); factory.storage_guard()
        snapshot = inspector.C.snapshot(factory.context())
        need(snapshot == factory.receipt['after'], 'UNCHANGED_INSTALLED_RUNTIME240_STATIC43_CHAIN49_REQUIRED')
        auxiliary = {}
        for key in ('report', 'traffic'):
            db = factory.databases[key]
            auxiliary[key] = db.guard((previous or factory.receipt['minimumBeforeUp'])[key])
            db.backup_guard(factory.receipt['backups'][key])
        need(all(row['revision'] >= 3 for row in auxiliary['report']['content']['cache'].values()), 'UNCHANGED_REPORT_REVISIONS3_REQUIRED')
        factory.databases['content'].backup_guard(factory.receipt['backups']['content'])
        factory.history_guard(); factory.storage_guard(); lease_gate()
        return snapshot, auxiliary

    before_runtime, auxiliary_before = checkpoint()
    content = factory.databases['content']
    family_before = content.facts()
    need(content.path == DATABASE and family_before.get('wal') is not None and family_before.get('shm') is not None, 'EXISTING_LIVE_CONTENT_WAL_AND_SHM_REQUIRED_NO_CREATION')
    connection = sqlite3.connect(DATABASE.as_uri() + '?mode=ro', uri=True, timeout=0)
    try:
        connection.set_authorizer(readonly_authorizer)
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA busy_timeout=0')
        need(connection.execute('PRAGMA journal_mode').fetchone() == ('wal',), 'EXISTING_WAL_MODE_REQUIRED_NO_MODE_CHANGE')
        capture = capture_module.capture(connection, engine_bytes=engine_raw, receipt_bytes=raw['cleanupReceipt'], receipt_sha256=args.cleanup_receipt_sha, pre_full_sha256=args.pre_full_sha, user_approval_sha256=args.user_approval_sha, lease_gate=lease_gate, native_minimum=lambda db: capture_module.native_connection_minimum(db, factory))
        need(connection.total_changes == 0 and not connection.in_transaction and connection.execute('PRAGMA query_only').fetchone() == (1,), 'UNCHANGED_READONLY_CONTENT_CONNECTION_REQUIRED')
    finally:
        connection.close()
    need(content.identity(family_before) == content.identity(content.facts()), 'CONTENT_DB_REPLACED_DURING_POST_CAPTURE')
    after_runtime, auxiliary_after = checkpoint(auxiliary_before)
    need(before_runtime == after_runtime, 'RUNTIME_CHANGED_DURING_POST_CAPTURE')
    code_guard(); lease_gate()
    for key, path, pin in sources:
        need(private_read(path, pin) == raw[key], 'POST_CAPTURE_PROOF_INPUT_CHANGED')
    need(private_read(ENGINE, ENGINE_SHA) == engine_raw, 'POST_CAPTURE_ENGINE_CHANGED')

    capture['rawPrivateMinimumEncoding'] = 'JSON_SQLITE_BYTES_HEX_V1'
    capture['capturedAtUtc'] = datetime.now(timezone.utc).isoformat()
    guard_proof = {'schema': 'palitra-post-cleanup-independent-read-guards/v1', 'status': 'CURRENT_CONTENT_CAPTURE_WITH_EXISTING_AUXILIARY_AND_RUNTIME_GUARDS_NOT_ACCEPTANCE', 'runtimeAuthorization': False, 'runtimeWrites': 0, 'databaseWrites': 0, 'userApprovalCreated': False, 'lease': lease_gate(), 'packageManifestSha256': PACKAGE_SHA, 'inspectorManifestSha256': INSPECTOR_SHA, 'engineSha256': ENGINE_SHA, 'cleanupReceiptSha256': args.cleanup_receipt_sha, 'preFullInspectionSha256': args.pre_full_sha, 'userApprovalSha256': args.user_approval_sha, 'runtimeSnapshotSha256': SHA(encode_private(after_runtime)), 'oldContentMinimumCompared': False, 'sameConnectionNativeMinimum': True, 'allThreeHistoricalBackupGuardsPassed': True, 'oldArtifactsChanged': False, 'reportTraffic': {key: auxiliary_guard_proof(auxiliary_before[key], auxiliary_after[key]) for key in ('report', 'traffic')}, 'captureSemantics': 'ONE_READONLY_QUERY_ONLY_CONTENT_TRANSACTION_AUXILIARY_GUARDS_SEPARATE_NOT_GLOBAL_ATOMIC'}
    output_values = [(name, encode_private(value)) for name, value in [('post-content-capture.json', capture), ('native-content-minimum.json', capture['nativeContentMinimum']), ('guard-proof.json', guard_proof)]]
    need(all(len(value) <= 16 * 1024 * 1024 for _, value in output_values), 'R5_PRIVATE_JSON_READER_BOUND_EXCEEDED_NO_TRUNCATION')
    need(not output.exists(), 'CAPTURE_AREA_EXISTS_NO_REPLAY')
    output.mkdir(mode=0o700)
    directory_identity = identity(output.lstat())[:6]
    files = {}
    for name, value in output_values:
        need(identity(output.lstat())[:6] == directory_identity, 'NEW_CAPTURE_DIRECTORY_CHANGED')
        files[name] = write_exclusive(output / name, value)
    result = {'schema': 'palitra-post-cleanup-private-capture-result/v1', 'status': 'PRIVATE_POST_CLEANUP_CAPTURE_REQUIRES_INDEPENDENT_ROOT_REVIEW', 'runtimeAuthorization': False, 'userApprovalCreated': False, 'admissionCreated': False, 'databaseWrites': 0, 'oldArtifactWrites': 0, 'typedContentSha256': capture['typedContentSha256'], 'files': files}
    write_exclusive(output / 'CAPTURE_RESULT.json', encode_private(result))
    fd = os.open(output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    lease_gate()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        code = str(error) if type(error) is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,140}', str(error)) else type(error).__name__
        print(json.dumps({'status': 'POST_CAPTURE_REFUSED_OR_UNKNOWN_NO_RETRY', 'code': code, 'runtimeAuthorization': False, 'userApprovalCreated': False, 'admissionCreated': False, 'databaseWrites': 0, 'automaticRetry': False}))
        raise SystemExit(2)
