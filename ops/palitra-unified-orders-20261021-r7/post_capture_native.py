"""R7 private capture: immutable cleanup history and a separate current lease.

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
from pathlib import Path, PurePosixPath

sys.dont_write_bytecode = True
ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
PACKAGE = ROOT / 'palitra-unified-orders-20261021-r7-code'
PACKAGE_SHA = 'fd60d0f17369a41527c1f0b3fa67c32724d9b24a2896cfee476dd753958cb676'
INSPECTOR_SHA = '7de083ac3cf4b39c352ed7b3c60d35e447480f0ab836915d2c87482ef8125c09'
ENGINE = ROOT / 'palitra-order-cleanup-copy-20261021-r10-code/cleanup_runtime.py'
ENGINE_SHA = '6bd4b9f29ff1ffd4e553750d43df437444b5651485748e1eeca82163c8259861'
DATABASE = Path('/var/lib/docker/volumes/synapse_content_data/_data/content.sqlite')
IMAGE = 'sha256:951db09e9e6c4781350bbced7e7a9e4ef099077a368e38a6b1fac40e0a4a6a22'
GUARD_RECEIPT_SHA = '34ce6389ef04a5db158d5b1a27734e2d09c919df28b35a9dad4561af48d42892'
LOCK = '/opt/synapse/.palitra-app-release.lock'
OUTPUT_PREFIX = 'palitra-unified-post-cleanup-20261021-r4-'
CLEANUP_RECEIPT_SHA = '94301d3154b612fea52a9a18b8b9ca75969b54fd832f4b457edb79adca4d4f7b'
CLEANUP_ADMISSION_SHA = 'ba6a2ab94b0fcae4aa25eaf82f4db4f134f1a136848d83b9bc4b7d9d89fbdf03'
SMALL_LIMIT = 16 * 1024 * 1024
RAW_LIMIT = 256 * 1024 * 1024
RAW_NAME = 'raw-content-minimum.json'
RAW_ENCODING = 'JSON_SQLITE_BYTES_HEX_V1'
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
        need(directory == PACKAGE and manifest.get('schema') == 'palitra-unified-native-code-manifest/v1' and manifest.get('namespace') == 'palitra-unified-orders-20261021-r7' and manifest.get('mutableRuntimeFiles') == [], 'EXACT_R7_PACKAGE_REQUIRED')
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


def validate_links(receipt, pre_full, approval, *, pre_full_sha, approval_sha, admission, admission_sha, receipt_sha, pre_full_path, approval_path):
    need(receipt.get('status') == 'CLEANUP_COMMITTED_REQUIRES_ROOT_READONLY_ACCEPTANCE' and receipt.get('runtimeAcceptance') is False and receipt.get('automaticRetry') is False and receipt.get('automaticRestore') is False and receipt.get('guardImage') == IMAGE, 'ACTUAL_COMMITTED_CLEANUP_RECEIPT_REQUIRED')
    bindings = receipt.get('transactionEvidence', {}).get('bindings', {})
    need(bindings.get('preFullInspectionSha256') == pre_full_sha and bindings.get('userApprovalSha256') == approval_sha, 'EXACT_COMMITTED_PRE_FULL_AND_APPROVAL_LINKS_REQUIRED')
    need(pre_full.get('schema') == 'palitra-readonly-managed260-inspection/v2' and pre_full.get('status') == 'EXACT_INSTALLED_GUARD_WITH_MANAGED260_READONLY_R2' and pre_full.get('mode') == 'full' and pre_full.get('fullInspection') is True and pre_full.get('runtimeWrites') == 0 and pre_full.get('runtimeAdmission') is False and pre_full.get('image') == IMAGE and pre_full.get('guardReceiptSha256') == GUARD_RECEIPT_SHA and pre_full.get('codeManifestSha256') == INSPECTOR_SHA and (pre_full.get('sourceFiles'), pre_full.get('staticFiles'), pre_full.get('chainFiles')) == (240, 43, 49), 'ACTUAL_EXACT_R6_PRE_FULL_REQUIRED')
    # Completed cleanup history is immutable. It is not this new capture lease.
    need(receipt_sha == CLEANUP_RECEIPT_SHA and admission_sha == CLEANUP_ADMISSION_SHA
         and receipt.get('admissionSha256') == admission_sha, 'EXACT_IMMUTABLE_COMMITTED_CLEANUP_ADMISSION_REQUIRED')
    need(type(admission) is dict and admission.get('schema') == 2 and admission.get('enabled') is True
         and admission.get('site') == 'palitra' and admission.get('companyCode') == 'palitra-love'
         and admission.get('serverId') == 8936001 and admission.get('account') == 'sa133295'
         and admission.get('oneApply') is True and admission.get('userActionTimeConfirmed') is True
         and admission.get('guardImage') == IMAGE, 'EXACT_HISTORICAL_CLEANUP_ADMISSION_REQUIRED')
    need(all(digest(admission.get(key)) for key in ('scopeSha256', 'snapshotSha256'))
         and receipt.get('namespace') == admission.get('namespace') and receipt.get('nonce') == admission.get('nonce')
         and receipt.get('scopeSha256') == admission['scopeSha256'] and receipt.get('snapshotSha256') == admission['snapshotSha256'],
         'EXACT_COMMITTED_CLEANUP_SCOPE_AND_ATTEMPT_REQUIRED')
    need(admission.get('artifacts', {}).get('runtimeInspection') == {'path': str(pre_full_path), 'sha256': pre_full_sha}
         and admission.get('artifacts', {}).get('userApproval') == {'path': str(approval_path), 'sha256': approval_sha},
         'HISTORICAL_ADMISSION_MUST_BIND_ACTUAL_PRE_FULL_AND_APPROVAL_FILES')
    historical = admission.get('lease')
    need(type(historical) is dict and set(historical) == {'pid', 'startTicks', 'lockPath'}
         and type(historical['pid']) is int and historical['pid'] > 1
         and type(historical['startTicks']) is str and re.fullmatch('[1-9][0-9]*', historical['startTicks'])
         and historical['lockPath'] == LOCK, 'EXACT_HISTORICAL_CLEANUP_LEASE_REQUIRED')
    need(pre_full.get('lease') == {'pid': historical['pid'], 'startTicks': historical['startTicks'], 'lock': historical['lockPath']},
         'HISTORICAL_PRE_FULL_MUST_MATCH_COMMITTED_ADMISSION_LEASE')
    need(approval.get('namespace') == admission['namespace'] and approval.get('nonce') == admission['nonce']
         and approval.get('scopeSha256') == admission['scopeSha256'] and approval.get('snapshotSha256') == admission['snapshotSha256'],
         'HISTORICAL_APPROVAL_SCOPE_AND_ATTEMPT_CHANGED')
    need(approval.get('status') == 'USER_CONFIRMED_PERMANENT_PALITRA_CLEANUP' and approval.get('permanentDeleteConfirmed') is True, 'ACTUAL_EXISTING_USER_APPROVAL_REQUIRED')
    return {'pid': historical['pid'], 'startTicks': historical['startTicks'], 'lock': historical['lockPath']}


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


class OutputSizeRefusal(ValueError):
    def __init__(self, code, sizes):
        super().__init__(code)
        self.sizes = dict(sizes)


def validate_raw_reference(reference, output):
    need(type(reference) is dict and set(reference) == {'schema', 'path', 'sha256', 'bytes', 'encoding'}, 'EXACT_SEPARATE_RAW_REFERENCE_REQUIRED')
    folder = PurePosixPath(str(output))
    need(folder.parent == PurePosixPath(ROOT.as_posix()) and re.fullmatch(re.escape(OUTPUT_PREFIX) + '[a-f0-9]{32}', folder.name), 'NEW_RAW_REFERENCE_NAMESPACE_REQUIRED')
    need(reference['schema'] == 'palitra-post-cleanup-raw-minimum-ref/v1' and reference['path'] == str(folder / RAW_NAME) and reference['encoding'] == RAW_ENCODING and digest(reference['sha256']) and type(reference['bytes']) is int and 0 < reference['bytes'] <= RAW_LIMIT, 'EXACT_LOSSLESS_RAW_REFERENCE_METADATA_REQUIRED')
    return True


def prepare_output_bytes(capture, guard_proof, output):
    """Pure one-time serialization and complete size gate, before mkdir/write.

    Keep every original field except rawPrivateMinimum at the top level. The
    full value of that field is serialized once, losslessly, in its own file.
    R5 reads only the compact DTO/native minimum, whose16MiB bounds stay exact.
    """
    need(type(capture) is dict and 'rawPrivateMinimum' in capture and 'rawPrivateMinimumRef' not in capture, 'ORIGINAL_RAW_MINIMUM_WITHOUT_PREEXISTING_REF_REQUIRED')
    raw_value = capture['rawPrivateMinimum']
    need(type(raw_value) is dict and set(raw_value) == {'schema', 'tables'} and type(raw_value['schema']) is list and type(raw_value['tables']) is dict, 'EXACT_R6_RAW_MINIMUM_VALUE_REQUIRED')
    compact = dict(capture)
    compact.pop('rawPrivateMinimum')
    raw_bytes = encode_private(raw_value)
    minimum_bytes = encode_private(capture['nativeContentMinimum'])
    reference = {'schema': 'palitra-post-cleanup-raw-minimum-ref/v1', 'path': str(PurePosixPath(str(output)) / RAW_NAME), 'sha256': SHA(raw_bytes), 'bytes': len(raw_bytes), 'encoding': RAW_ENCODING}
    # Shape/binding checks are independent of the size checks below, so an
    # oversize value returns a precise safe size diagnostic rather than a path
    # or serialization fallback. No raw value is printed or dropped.
    compact['rawPrivateMinimumRef'] = reference
    compact_bytes = encode_private(compact)
    guard_bytes = encode_private(guard_proof)
    sizes = {'rawPrivateMinimumBytes': len(raw_bytes), 'nativeMinimumBytes': len(minimum_bytes), 'compactPostCaptureBytes': len(compact_bytes), 'guardProofBytes': len(guard_bytes), 'r5ReaderLimitBytes': SMALL_LIMIT, 'separateRawLimitBytes': RAW_LIMIT}
    if len(minimum_bytes) > SMALL_LIMIT:
        raise OutputSizeRefusal('NATIVE_MINIMUM_EXCEEDS_FROZEN_R5_READER_BOUND_NO_OUTPUT', sizes)
    if len(compact_bytes) > SMALL_LIMIT:
        raise OutputSizeRefusal('COMPACT_POST_CAPTURE_EXCEEDS_FROZEN_R5_READER_BOUND_NO_OUTPUT', sizes)
    if len(raw_bytes) > RAW_LIMIT:
        raise OutputSizeRefusal('SEPARATE_RAW_MINIMUM_EXCEEDS_256MIB_BOUND_NO_OUTPUT', sizes)
    if len(guard_bytes) > SMALL_LIMIT:
        raise OutputSizeRefusal('GUARD_PROOF_EXCEEDS_PRIVATE_READER_BOUND_NO_OUTPUT', sizes)
    validate_raw_reference(reference, output)
    return {'phaseOne': (RAW_NAME, raw_bytes), 'phaseTwo': [('post-content-capture.json', compact_bytes), ('native-content-minimum.json', minimum_bytes), ('guard-proof.json', guard_bytes)], 'sizes': sizes, 'rawReference': reference}


def verify_written(path, pin, size, maximum):
    """Streaming private raw readback; never allocate another256MiB copy."""
    p = exact(path)
    need(ROOT in p.parents and digest(pin) and type(size) is int and 0 < size <= maximum, 'EXACT_PRIVATE_OUTPUT_READBACK_REFERENCE_REQUIRED')
    before = p.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == before.st_gid == 0 and stat.S_IMODE(before.st_mode) == 0o600 and before.st_size == size, 'ROOT600_EXACT_OUTPUT_FILE_REQUIRED')
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    total = 0
    hasher = hashlib.sha256()
    try:
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                total += len(chunk)
                need(total <= size, 'PRIVATE_OUTPUT_GREW_DURING_READBACK')
                hasher.update(chunk)
        need(identity(before) == identity(os.fstat(fd)) == identity(p.lstat()) and total == size and hasher.hexdigest() == pin, 'EXACT_PRIVATE_OUTPUT_HASH_AND_IDENTITY_REQUIRED')
    finally:
        os.close(fd)


def write_exclusive(path, raw):
    p = exact(path, missing=True)
    need(p.parent.parent == ROOT and re.fullmatch(re.escape(OUTPUT_PREFIX) + '[a-f0-9]{32}', p.parent.name) and p.name in (RAW_NAME, 'post-content-capture.json', 'native-content-minimum.json', 'guard-proof.json', 'CAPTURE_RESULT.json'), 'OWN_CAPTURE_OUTPUT_NAMESPACE_ONLY')
    parent = p.parent.lstat()
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == parent.st_gid == 0 and stat.S_IMODE(parent.st_mode) == 0o700, 'NEW_ROOT700_OUTPUT_DIRECTORY_REQUIRED')
    maximum = RAW_LIMIT if p.name == RAW_NAME else SMALL_LIMIT
    need(type(raw) is bytes and 0 < len(raw) <= maximum, 'BOUNDED_PRIVATE_CAPTURE_OUTPUT_REQUIRED')
    fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        need(os.fstat(fd).st_nlink == 1 and stat.S_IMODE(os.fstat(fd).st_mode) == 0o600, 'NEW_ROOT600_CAPTURE_REQUIRED')
    finally:
        os.close(fd)
    verify_written(p, SHA(raw), len(raw), maximum)
    return {'path': str(p), 'sha256': SHA(raw)}


def write_capture_outputs(output, serialized, typed_content_sha, lease_gate):
    """Own new namespace only: raw verified first, consumer DTOs second."""
    output = exact(output, missing=True)
    need(output.parent == ROOT and re.fullmatch(re.escape(OUTPUT_PREFIX) + '[a-f0-9]{32}', output.name) and not output.exists(), 'NEW_EXACT_PRIVATE_CAPTURE_AREA_REQUIRED_NO_REPLAY')
    need(callable(lease_gate) and digest(typed_content_sha) and type(serialized) is dict and set(serialized) == {'phaseOne', 'phaseTwo', 'sizes', 'rawReference'}, 'EXACT_PREPARED_CAPTURE_OUTPUTS_REQUIRED')
    validate_raw_reference(serialized['rawReference'], output)
    raw_name, raw_output = serialized['phaseOne']
    need(raw_name == RAW_NAME and type(raw_output) is bytes and len(raw_output) == serialized['rawReference']['bytes'] and SHA(raw_output) == serialized['rawReference']['sha256'], 'EXACT_PREPARED_RAW_BYTES_REQUIRED')
    need([name for name, _ in serialized['phaseTwo']] == ['post-content-capture.json', 'native-content-minimum.json', 'guard-proof.json'] and all(type(value) is bytes and 0 < len(value) <= SMALL_LIMIT for _, value in serialized['phaseTwo']), 'EXACT_THREE_SMALL_CONSUMER_OUTPUTS_REQUIRED')
    need(serialized['sizes'] == {'rawPrivateMinimumBytes': len(raw_output), 'nativeMinimumBytes': len(serialized['phaseTwo'][1][1]), 'compactPostCaptureBytes': len(serialized['phaseTwo'][0][1]), 'guardProofBytes': len(serialized['phaseTwo'][2][1]), 'r5ReaderLimitBytes': SMALL_LIMIT, 'separateRawLimitBytes': RAW_LIMIT}, 'EXACT_PREPARED_OUTPUT_SIZES_REQUIRED')
    compact = json.loads(serialized['phaseTwo'][0][1])
    need(compact.get('rawPrivateMinimumRef') == serialized['rawReference'] and 'rawPrivateMinimum' not in compact and compact.get('typedContentSha256') == typed_content_sha and compact.get('nativeContentMinimum') == json.loads(serialized['phaseTwo'][1][1]), 'COMPACT_RAW_REFERENCE_AND_NATIVE_MINIMUM_MUST_STAY_EXACT')
    lease_gate()
    output.mkdir(mode=0o700)
    directory_identity = identity(output.lstat())[:6]
    files = {}
    # Phase1: full raw data must be EXCL/root600 and hash-read back BEFORE the
    # compact reference can be materialized. A partial area is never replayed.
    files[raw_name] = write_exclusive(output / raw_name, raw_output)
    need(files[raw_name] == {key: serialized['rawReference'][key] for key in ('path', 'sha256')}, 'ACTUAL_RAW_WRITE_MUST_MATCH_COMPACT_REFERENCE')
    need(identity(output.lstat())[:6] == directory_identity, 'NEW_CAPTURE_DIRECTORY_CHANGED')
    lease_gate()
    # Phase2 retains the unchanged16MiB bounds; no raw value is discarded.
    for name, value in serialized['phaseTwo']:
        need(identity(output.lstat())[:6] == directory_identity, 'NEW_CAPTURE_DIRECTORY_CHANGED')
        files[name] = write_exclusive(output / name, value)
    result = {'schema': 'palitra-post-cleanup-private-capture-result/v2', 'status': 'PRIVATE_POST_CLEANUP_CAPTURE_REQUIRES_INDEPENDENT_ROOT_REVIEW', 'runtimeAuthorization': False, 'userApprovalCreated': False, 'admissionCreated': False, 'databaseWrites': 0, 'oldArtifactWrites': 0, 'typedContentSha256': typed_content_sha, 'outputSizes': serialized['sizes'], 'files': files}
    write_exclusive(output / 'CAPTURE_RESULT.json', encode_private(result))
    fd = os.open(output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    lease_gate()
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description='Root-only readonly post-cleanup capture; no acceptance/admission')
    parser.add_argument('--capture-post-cleanup', action='store_true')
    parser.add_argument('--cleanup-receipt', type=Path, required=True)
    parser.add_argument('--cleanup-receipt-sha', required=True)
    parser.add_argument('--cleanup-admission', type=Path, required=True)
    parser.add_argument('--cleanup-admission-sha', required=True)
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
    sources = [('cleanupReceipt', args.cleanup_receipt, args.cleanup_receipt_sha), ('cleanupAdmission', args.cleanup_admission, args.cleanup_admission_sha), ('preFull', args.pre_full, args.pre_full_sha), ('userApproval', args.user_approval, args.user_approval_sha)]
    raw = {key: private_read(path, pin) for key, path, pin in sources}
    docs = {key: json.loads(value) for key, value in raw.items()}
    historical_cleanup_lease = validate_links(docs['cleanupReceipt'], docs['preFull'], docs['userApproval'], pre_full_sha=args.pre_full_sha, approval_sha=args.user_approval_sha, admission=docs['cleanupAdmission'], admission_sha=args.cleanup_admission_sha, receipt_sha=args.cleanup_receipt_sha, pre_full_path=args.pre_full, approval_path=args.user_approval)

    def code_guard():
        closed_code(PACKAGE, 'code-manifest.json', PACKAGE_SHA, 66, package=True)
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

    capture['cleanupAdmission'] = {'path': str(args.cleanup_admission), 'sha256': args.cleanup_admission_sha}
    capture['historicalCleanupLease'] = historical_cleanup_lease
    capture['rawPrivateMinimumEncoding'] = RAW_ENCODING
    capture['capturedAtUtc'] = datetime.now(timezone.utc).isoformat()
    guard_proof = {'schema': 'palitra-post-cleanup-independent-read-guards/v1', 'status': 'CURRENT_CONTENT_CAPTURE_WITH_EXISTING_AUXILIARY_AND_RUNTIME_GUARDS_NOT_ACCEPTANCE', 'runtimeAuthorization': False, 'runtimeWrites': 0, 'databaseWrites': 0, 'userApprovalCreated': False, 'lease': lease_gate(), 'packageManifestSha256': PACKAGE_SHA, 'inspectorManifestSha256': INSPECTOR_SHA, 'engineSha256': ENGINE_SHA, 'cleanupReceiptSha256': args.cleanup_receipt_sha, 'preFullInspectionSha256': args.pre_full_sha, 'userApprovalSha256': args.user_approval_sha, 'runtimeSnapshotSha256': SHA(encode_private(after_runtime)), 'oldContentMinimumCompared': False, 'sameConnectionNativeMinimum': True, 'allThreeHistoricalBackupGuardsPassed': True, 'oldArtifactsChanged': False, 'reportTraffic': {key: auxiliary_guard_proof(auxiliary_before[key], auxiliary_after[key]) for key in ('report', 'traffic')}, 'captureSemantics': 'ONE_READONLY_QUERY_ONLY_CONTENT_TRANSACTION_AUXILIARY_GUARDS_SEPARATE_NOT_GLOBAL_ATOMIC'}
    managed260 = factory.managed.get('current260')
    need(type(managed260) is dict and managed260.get('version') == 260 and digest(managed260.get('revision')), 'ACTUAL_GUARDED_MANAGED260_REVISION_REQUIRED')
    guard_proof['managed260'] = {'version': 260, 'revision': managed260['revision']}
    guard_proof['cleanupAdmission'] = capture['cleanupAdmission']
    guard_proof['historicalCleanupLease'] = historical_cleanup_lease
    serialized = prepare_output_bytes(capture, guard_proof, output)
    result = write_capture_outputs(output, serialized, capture['typedContentSha256'], lease_gate)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z][A-Z0-9_]{0,140}', str(error)) else type(error).__name__
        result = {'status': 'POST_CAPTURE_REFUSED_OR_UNKNOWN_NO_RETRY', 'code': code, 'runtimeAuthorization': False, 'userApprovalCreated': False, 'admissionCreated': False, 'databaseWrites': 0, 'automaticRetry': False}
        if isinstance(error, OutputSizeRefusal):
            result['outputSizes'] = error.sizes
        print(json.dumps(result))
        raise SystemExit(2)
