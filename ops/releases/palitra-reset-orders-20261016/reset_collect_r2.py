"""Root-only fixed11-17 READONLY inventory/private backup. No approval or delete API."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import types
from datetime import datetime, timezone
sys.dont_write_bytecode = True
ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
CODE = ROOT / 'reset-orders11-17-code-r1'
PRIVATE = ROOT / 'reset-orders11-17-r2'
RELEASE = ROOT / 'palitra-forms-consistency-code-r1'
RELEASE_SHA = '173cc77f563a4756588cc9bde0919a34ed144110757005ee008eaa4b107e1935'
WRAPPER_SHA = '4795d3b244cd4b105d0dea81e6f08e84b7aa03603791d1601e85bab41e8db21a'
MANIFEST_SHA = '3c69588b06a9f9fc686d34bf383792ec8a53f576bca801d13cde266f044657b0'
RECEIPT_SHA = '3ede27a3b2d08fce282df8f42fd3befcebd8367df8450040c02b985207d9f5ea'
CONTENT = 'sha256:e1f6120cb2d4582020f12682854b3c495f7962c7c8a7db214167a202379ea690'
WORKER = 'sha256:d4d4d453ce2e3dc47d5e0962d62b95938f42c56ec73789fe76a324e0d2ff0508'
SCRIPT_SHA = '1ab0cd944fa3d8a008e847df78a3f2986c5865c8c8e8047ca2ec224a055f7d59'
IDS = [11, 12, 13, 14, 15, 16, 17]
sha = lambda raw: hashlib.sha256(raw).hexdigest()
encoded = lambda value: (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def need(value, code):
    if not value: raise ValueError(code)


def exact(path, missing=False):
    path = Path(path); need(path.is_absolute() and '..' not in path.parts, 'ABSOLUTE_RESET_PATH_REQUIRED')
    for item in [*reversed(path.parents), path]:
        try: row = item.lstat()
        except FileNotFoundError:
            need(missing and item == path, 'RESET_PATH_MISSING'); continue
        need(not stat.S_ISLNK(row.st_mode) and not (getattr(row, 'st_file_attributes', 0) & 0x400), 'RESET_SYMLINK_REFUSED')
        if item != path: need(stat.S_ISDIR(row.st_mode), 'RESET_PARENT_NOT_DIRECTORY')
    return path


def load_release():
    path = exact(RELEASE / 'journey_release_native.py'); raw = path.read_bytes()
    need(sha(raw) == RELEASE_SHA and sha(exact(RELEASE / 'journey.py').read_bytes()) == WRAPPER_SHA
         and sha(exact(RELEASE / 'payload/MANIFEST.json').read_bytes()) == MANIFEST_SHA, 'PINNED_READONLY_RELEASE23_CODE_REQUIRED')
    module = types.ModuleType('reset_readonly_accepted23'); module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


class Current23:
    """Use accepted constructors and readonly snapshot only; never call predecessor actions."""
    def __init__(self, lease_pid):
        need(re.fullmatch(r'sha256:[0-9a-f]{64}', CONTENT) is not None, 'EXACT_CONTENT_IMAGE_DIGEST_REQUIRED')
        self.module = module = load_release()
        self.a, self.b, current = module.load_current(lease_pid)
        self.receipt_path = ROOT / 'palitra-forms-consistency-r1-journal.json'
        receipt = self.a.pinned(self.receipt_path, RECEIPT_SHA, True)
        historical_pid = receipt.get('inputs', {}).get('freshLeasePid')
        need(type(historical_pid) is int and historical_pid > 1, 'EXACT_HISTORICAL23_LEASE_BINDING_REQUIRED')
        release = module.JourneyRelease(self.a, self.b, current, RELEASE / 'payload', MANIFEST_SHA, historical_pid)
        need(receipt.get('schema') == 1 and receipt.get('name') == module.NAME and receipt.get('phase') == module.PHASE
             and receipt.get('inputs') == release.binding() and receipt.get('before') == release.base
             and receipt.get('childImage') == CONTENT and receipt.get('workerRecreated') is False
             and receipt.get('uploadsEnabled') is True and receipt.get('directDbWrites') == receipt.get('queueEdits') == receipt.get('oldJournalWrites') == 0
             and receipt.get('automaticRetry') is False and receipt.get('automaticCodeRollback') is False
             and type(receipt.get('static')) is list and len(receipt['static']) == 5 and all(row.get('written') is True for row in receipt['static']), 'EXACT_COMPLETED23_RECEIPT_REQUIRED')
        release.backup_guard(receipt)
        need(release.context_proof(receipt, True) == receipt.get('contextSha256'), 'ACCEPTED23_CONTEXT_CHANGED')
        self.proof = {key: receipt[key] for key in ('childImage', 'overlaySha256', 'plannedConfigHash')}
        need(receipt.get('overlay') == str(release.paths()['overlay'])
             and receipt['after']['containers']['content'] == release.expected_metadata('content', CONTENT, self.proof)
             and len(receipt['after']['containers']['content']['files']) == 23 and receipt['after']['worker']['image'] == WORKER
             and len(release.final_source) == 209 and len(release.final_static) == 26, 'EXACT_ACCEPTED23_SOURCE209_STATIC26_REQUIRED')
        # Historical PID is ONLY receipt binding. All actual lease checks use the NEW Root PID.
        release.lease_pid = lease_pid; self.release = release; self.receipt = receipt

    def runtime(self):
        need(sha(self.a.read(self.receipt_path)) == RECEIPT_SHA, 'IMMUTABLE_COMPLETED23_RECEIPT_CHANGED')
        snap = self.release.snapshot(CONTENT, True, self.proof); self.release.users(CONTENT)
        need(snap == self.receipt['after'] and self.b.heartbeat(snap['worker']['startedAt'], self.release.clock())['freshAfterWorkerStart'], 'CURRENT23_RUNTIME_OR_HEARTBEAT_CHANGED')
        return {'current': snap, 'sourceInventorySha256': sha(encoded(self.release.final_source)), 'staticInventorySha256': sha(encoded(self.release.final_static)),
                'releaseReceiptSha256': RECEIPT_SHA, 'sourceFiles': 209, 'staticFiles': 26, 'contentChainFiles': 23, 'freshLeasePid': self.release.lease_pid}

    def mount(self, kind, database):
        container = 'synapse-content-1' if kind == 'content' else 'synapse-chat-1'
        rows = self.a.decode(run(['docker', 'inspect', '--format', '{{json .Mounts}}', container], limit=1024*1024))
        rows = [row for row in rows if row.get('Destination') == '/data']
        need(len(rows) == 1 and rows[0].get('Type') == 'volume' and rows[0].get('RW') is True, 'EXACT_EXISTING_DATA_VOLUME_REQUIRED')
        source = exact(rows[0]['Source'])
        need(source.is_relative_to(Path('/var/lib/docker/volumes')) and source.name == '_data'
             and not PRIVATE.is_relative_to(source) and not source.is_relative_to(PRIVATE), 'PRIVATE_BACKUP_DATA_VOLUME_OVERLAP')
        path = exact(source / ('content.sqlite' if kind == 'content' else 'chat.sqlite')); info = path.stat()
        need(stat.S_ISREG(info.st_mode) and (info.st_dev, info.st_ino) == (database['device'], database['inode'])
             and database['path'] == ('/data/content.sqlite' if kind == 'content' else '/data/chat.sqlite') and database['readOnly'] is True, 'HOST_CONTAINER_DATABASE_IDENTITY_MISMATCH')
        return {'container': container, 'source': str(source), 'device': info.st_dev, 'inode': info.st_ino, 'rw': True}


def run(command, timeout=45, limit=32*1024*1024):
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, shell=False, timeout=timeout)
    need(result.returncode == 0 and len(result.stdout) <= limit and len(result.stderr) <= 1048576, 'READONLY_RESET_COMMAND_REFUSED')
    return result.stdout


def stable_worker(value): return {key: item for key, item in value.items() if key != 'observedAtUtc'}


def collect(guard, script):
    need(sha(script) == SCRIPT_SHA, 'EXACT_NEW_READONLY_COLLECTOR_REQUIRED')
    before = guard.runtime(); prefix = ['docker', 'exec', '--env', 'PALITRA_RESET_READONLY_NATIVE=1']
    content = json.loads(run(prefix + ['synapse-content-1', 'node', '-e', script.decode(), 'content'], timeout=60))
    need(content.get('status') == 'RESET_FIXED7_CONTENT_SNAPSHOT_NOT_DELETE_APPROVAL' and content.get('fixedOrderIds') == IDS, 'EXACT_FIXED7_READONLY_CONTENT_REQUIRED')
    refs = content['projection']['jobs']['siteOrder'] + content['projection']['jobs']['clientBot']
    worker_command = prefix + ['synapse-chat-1', '/usr/local/bin/node', '-e', script.decode(), 'worker', json.dumps(refs, separators=(',', ':'))]
    worker = json.loads(run(worker_command))
    need(worker.get('status') == 'RESET_FIXED7_WORKER_TARGET_JOB_PROJECTION', 'READONLY_WORKER_REQUIRED')
    mounts = {'content': guard.mount('content', content['database']), 'worker': guard.mount('worker', worker['database'])}
    worker_after = json.loads(run(worker_command)); need(stable_worker(worker_after) == stable_worker(worker), 'WORKER_LEDGER_DRIFT_DURING_SNAPSHOT')
    after = guard.runtime(); need(after == before, 'CURRENT23_CHANGED_DURING_READONLY_SNAPSHOT')
    return {'schema': 1, 'status': 'RESET_FIXED7_READONLY_BACKUP_NOT_APPROVAL', 'observedAtUtc': datetime.now(timezone.utc).isoformat(),
            'fixedOrderIds': IDS, 'runtimeBefore': before, 'runtimeAfter': after, 'mounts': mounts, 'content': content, 'worker': worker,
            'crossDatabaseAtomic': False, 'requiresFreshPreDeleteRecheck': True, 'deletionApproved': False, 'actionTimeConfirmationReceived': False,
            'collectorSha256': sha(script), 'helperSha256': sha(Path(__file__).read_bytes()), 'dbWrites': 0, 'workerLedgerWrites': 0,
            'fileDeletion': False, 'physicalMediaInspected': False, 'outboundMessages': 0, 'consentsChanged': False}


def backup(value, guard):
    need(not os.path.lexists(PRIVATE), 'PRIVATE_RESET_BACKUP_ALREADY_EXISTS_NO_REPLACE')
    root_facts = guard.release.facts(ROOT); raw = encoded(value); need(len(raw) <= 32*1024*1024, 'BOUNDED_PRIVATE_RESET_BACKUP_REQUIRED')
    guard.release.lease(); guard.release.files.directory(exact(PRIVATE, True), 0o700)
    directory = guard.release.facts(PRIVATE); need(directory[2:] == [0, 0o700], 'ROOT_PRIVATE_RESET_DIRECTORY_REQUIRED')
    path = PRIVATE / 'target-backup.json'; identity = guard.release.files.write(path, raw, 0o600)
    fd = os.open(exact(path), os.O_RDONLY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0))
    try:
        first = os.fstat(fd); digest = hashlib.sha256(); total = 0
        need(stat.S_ISREG(first.st_mode) and (first.st_dev, first.st_ino, first.st_uid) == identity
             and first.st_uid == 0 and guard.release.files.fd_mode(fd) == 0o600, 'PRIVATE_RESET_BACKUP_FD_REQUIRED')
        while True:
            part = os.read(fd, 65536)
            if not part: break
            total += len(part); need(total <= len(raw), 'PRIVATE_RESET_BACKUP_SIZE_CHANGED'); digest.update(part)
        last = os.fstat(fd); info = exact(path).stat()
        need(identity == (last.st_dev, last.st_ino, last.st_uid) == (info.st_dev, info.st_ino, info.st_uid)
             and guard.release.files.fd_mode(fd) == guard.release.files.mode(path) == 0o600 and total == len(raw) and digest.hexdigest() == sha(raw)
             and guard.release.facts(ROOT) == root_facts and guard.release.facts(PRIVATE) == directory, 'PRIVATE_RESET_BACKUP_READBACK_CHANGED')
    finally: os.close(fd)
    for parent in (PRIVATE, ROOT):
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
    guard.release.lease(); return {'backupFile': str(path), 'backupSha256': sha(raw), 'backupBytes': len(raw)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('inspect', 'backup-readonly'))
    parser.add_argument('--lease-pid', type=int, required=True); parser.add_argument('--collect-readonly', action='store_true')
    args = parser.parse_args(argv)
    try:
        need(SCRIPT_SHA != '0' * 64, 'READONLY_COLLECTOR_NOT_FROZEN')
        need(args.collect_readonly and os.name == 'posix' and os.geteuid() == 0 and exact(__file__).parent == CODE, 'EXACT_NATIVE_ROOT_READONLY_INVOCATION_REQUIRED')
        guard = Current23(args.lease_pid); script = exact(CODE / 'reset_snapshot.cjs').read_bytes(); value = collect(guard, script)
        saved = backup(value, guard) if args.operation == 'backup-readonly' else {}
        print(json.dumps({'status': value['status'], 'orderIds': IDS, 'counts': value['content']['counts'],
                          'blockers': sorted(set(value['content']['blockers'] + value['worker']['blockers'])), 'outsideOrderIds': [row['id'] for row in value['content']['projection']['otherNativeOrders']],
                          'sourceFiles': 209, 'staticFiles': 26, 'contentChainFiles': 23, 'dbWrites': 0, 'deletionApproved': False,
                          'actionTimeConfirmationReceived': False, **saved}, separators=(',', ':'))); return 0
    except Exception as error:
        code = str(error) if type(error) is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,100}', str(error)) else 'READONLY_RESET_COLLECTION_REFUSED'
        print(json.dumps({'status': 'READONLY_RESET_REFUSED_NO_DELETE', 'code': code, 'messageSha256': sha(str(error).encode()), 'dbWrites': 0, 'automaticRetry': False})); return 2


if __name__ == '__main__': sys.exit(main())
