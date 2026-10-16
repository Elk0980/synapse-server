"""NEW Root-only exact11-17 purge draft. Approval observes only; apply requires fresh explicit confirmation.
Never imports old fixed8/cap18, rewrites r2 backup, writes worker DB, resets sequence, deletes media or sends.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import types

sys.dont_write_bytecode = True
ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
CODE = ROOT / 'reset-orders11-17-code-r1'
PRIVATE = ROOT / 'reset-orders11-17-purge-r1'
COLLECTOR_HELPER_SHA = '3c6333794080b547374353fc6734c7464cfeb880dd62f67a55e6963a20e59f7d'
SAFE_HELPER_SHA = '0b04f5967c2fdbe8124eca49667f878f0016f9d9cbef2fa3e0b3dd604c7d8d32'
SCRIPT_SHA = '1ab0cd944fa3d8a008e847df78a3f2986c5865c8c8e8047ca2ec224a055f7d59'
BACKUP_SHA = '31dcfb01a1db2bc7f5fe93bf4017e8dab276d32aa7c1312f81c970511d0f9620'
IDS = [11, 12, 13, 14, 15, 16, 17]
DELETE_ORDER = ('chat_thread_links', 'chat_web_grants', 'client_bot_map', 'documents',
                'site_order_outbox', 'chat_threads', 'site_orders')
COUNTS = {'site_orders': 7, 'site_order_outbox': 14, 'chat_threads': 7, 'chat_web_grants': 7,
          'chat_thread_links': 3, 'client_bot_map': 7, 'documents': 17,
          **{t: 0 for t in ('site_order_work', 'site_order_work_events', 'site_order_checklist',
                           'site_order_checklist_events', 'client_order_links', 'client_dialogs',
                           'chat_thread_channels', 'chat_thread_messages', 'chat_message_deliveries',
                           'chat_thread_requests', 'chat_manager_map', 'chat_thread_attachments',
                           'chat_thread_media_events', 'chat_native_jobs', 'client_dialog_messages',
                           'client_dialog_versions', 'client_dialog_attachments', 'client_dialog_owner_requests',
                           'client_bot_outbox', 'client_bot_receipts', 'chat_web_uploads')}}
CRM = ('palitra_crm_inquiries', 'palitra_crm_orders')
LEDGER = ('client_bot_delivery', 'client_bot_ack', 'project_telegram_delivery', 'project_telegram_ack')
ALLOWED_CONTENT_BLOCKERS = ['CRM_REFERENCE_OUTSIDE_DELETE_SCOPE']
ALLOWED_WORKER_BLOCKERS = ['WORKER_JOB_SCOPE_UNRESOLVED:45da1fe94ccfb4c9']
sha = lambda raw: hashlib.sha256(raw).hexdigest()
canon = lambda obj: json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
encoded = lambda obj: canon(obj) + b'\n'


def need(ok, code):
    if not ok:
        raise ValueError(code)


def qi(value):
    need(type(value) is str and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', value), 'EXACT_IDENTIFIER_REQUIRED')
    return '"' + value + '"'


def safe(path):
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'ABSOLUTE_EXACT_PATH_REQUIRED')
    for item in [*reversed(path.parents), path]:
        info = item.lstat()
        need(not stat.S_ISLNK(info.st_mode), 'SYMLINK_REFUSED')
        if item != path:
            need(stat.S_ISDIR(info.st_mode), 'DIRECTORY_REQUIRED')
    return path


def read_private(path):
    path = safe(path); fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600
             and info.st_size <= 1024 * 1024, 'PRIVATE_INPUT_REQUIRED')
        raw = b''
        while len(raw) <= info.st_size:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            raw += chunk
        last = os.fstat(fd); now = path.lstat()
        need((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
             == (last.st_dev, last.st_ino, last.st_size, last.st_mtime_ns, last.st_ctime_ns)
             and (last.st_dev, last.st_ino) == (now.st_dev, now.st_ino) and len(raw) == info.st_size,
             'PRIVATE_INPUT_CHANGED')
        return raw
    finally:
        os.close(fd)


def sync_dir(path):
    fd = os.open(safe(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def create(path, value):
    raw = encoded(value); need(not os.path.lexists(path), 'PRIOR_OR_UNKNOWN_FILE_NO_RETRY')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as out:
            out.write(raw); out.flush(); os.fsync(fd)
        info = os.fstat(fd)
        need(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size == len(raw), 'PRIVATE_WRITE_REQUIRED')
    finally:
        os.close(fd)
    need(read_private(path) == raw, 'PRIVATE_WRITE_READBACK_CHANGED'); sync_dir(Path(path).parent)
    return sha(raw)


def journal_replace(path, old, value):
    expected = encoded(old); need(read_private(path) == expected, 'JOURNAL_CAS_CHANGED')
    pending = Path(str(path) + '.pending'); create(pending, value)
    need(read_private(path) == expected, 'LAST_JOURNAL_CAS_CHANGED')
    os.replace(pending, path); sync_dir(path.parent)
    need(read_private(path) == encoded(value), 'JOURNAL_REPLACE_READBACK_CHANGED')


def load(path, pin, name):
    path = safe(path); raw = path.read_bytes(); need(sha(raw) == pin, 'EXACT_NEW_DEPENDENCY_REQUIRED')
    module = types.ModuleType(name); module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def digest_rows(rows):
    return sha(b'[' + b','.join(sorted(canon(row) for row in rows)) + b']')


def allrows(conn, table):
    rows = []
    for row in conn.execute('SELECT * FROM ' + qi(table)):
        rows.append(dict(row)); need(len(rows) <= 100000, 'AFFECTED_TABLE_ROWS_BOUNDED')
    need(sum(len(canon(r)) for r in rows) <= 32 * 1024 * 1024, 'AFFECTED_TABLE_BYTES_BOUNDED')
    return rows


def pk_fields(schema, table):
    fields = [c['name'] for c in sorted(schema['columns'][table], key=lambda c: c['pk']) if c['pk']]
    need(fields, 'EXPLICIT_PINNED_PRIMARY_KEY_REQUIRED')
    return fields


def row_key(row, fields):
    return tuple(row[field] for field in fields)


def where_key(fields):
    return ' AND '.join(qi(field) + ' IS ?' for field in fields)


def schema_now(conn):
    schema = [dict(r) for r in conn.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
    need(len(schema) <= 3000, 'BOUNDED_SCHEMA_REQUIRED')
    columns = {}; foreign = []
    for row in schema:
        if row['type'] != 'table':
            continue
        table = row['name']; columns[table] = [dict(r) for r in conn.execute('PRAGMA table_info(' + qi(table) + ')')]
        foreign += [{'sourceTable': table, **dict(r)} for r in conn.execute('PRAGMA foreign_key_list(' + qi(table) + ')')]
    return {'schema': schema, 'columns': columns, 'foreignKeys': foreign}


def compare_schema(conn, pinned):
    actual = schema_now(conn)
    need(canon(actual) == canon({k: pinned[k] for k in actual}), 'FULL_ACTUAL_SCHEMA_CHANGED')
    affected = set(DELETE_ORDER) | set(CRM)
    need(not any(r['type'] == 'trigger' and r['tbl_name'] in affected for r in actual['schema']), 'AFFECTED_TRIGGER_REFUSED')
    for fk in actual['foreignKeys']:
        if fk['table'] in DELETE_ORDER:
            need(fk['on_delete'] in ('NO ACTION', 'RESTRICT'), 'UNREVIEWED_DELETE_CASCADE_REFUSED')
    for table in CRM:
        info = {c['name']: c for c in actual['columns'][table]}
        need(info['site_order_id']['notnull'] == 0 and not any(f['sourceTable'] == table and f['from'] == 'site_order_id'
             for f in actual['foreignKeys']), 'NULLABLE_NON_FK_CRM_BACKLINK_REQUIRED')


def sequence(conn):
    return [dict(r) for r in conn.execute('SELECT name,seq FROM sqlite_sequence ORDER BY name')]


def worker_binding(worker):
    return {'schema': worker['schemaInventory'], 'rows': worker['rows'], 'project': worker['project'],
            'checkpoint': worker['checkpoint'], 'database': worker['database'],
            'sequence': [row for row in worker['sequence'] if row['name'] in LEDGER]}


def state_binding(state):
    # Unrelated counters may advance between operations. All counters stay unchanged inside our DML.
    return {**{k: v for k, v in state.items() if k != 'sequence'},
            'targetSequence': [row for row in state['sequence'] if row['name'] in set(COUNTS) | set(CRM)]}


def review_worker(worker, baseline, refs):
    need(worker['blockers'] == ALLOWED_WORKER_BLOCKERS and all(r['state'] == 'done' for r in worker['inboxAggregate']),
         'WORKER_NOT_IDLE_OR_UNRESOLVED_BLOCKER')
    need(digest_rows(worker['rows']['client_bot_delivery']) == digest_rows(baseline['rows']['client_bot_delivery'])
         and worker_binding(worker) == worker_binding(baseline), 'PINNED_TARGET_WORKER_LEDGER_CHECKPOINT_OR_SEQUENCE_DRIFT')
    need(worker['rows']['client_bot_ack'] == [] and worker['project']['ack'] == [], 'TARGET_WORKER_ACKS_EXIST')
    delivery = worker['rows']['client_bot_delivery']; project = worker['project']['delivery']
    need(len(delivery) == len(project) == 7 and all(r['state'] == 'sent' and r['part'] == 0 for r in delivery + project),
         'EXACT_SENT_PART_ZERO_TARGET_LEDGER_REQUIRED')
    need(sorted(r['job_id'] for r in delivery + project) == sorted(refs) and len(refs) == len(set(refs)) == 14,
         'EVERY_TARGET_JOB_MUST_HAVE_ONE_SENT_LEDGER')


def reviewed_locked(conn, fresh, baseline):
    need(conn.in_transaction, 'BEGIN_IMMEDIATE_REQUIRED')
    content = fresh['content']; old = baseline['content']
    need(content['blockers'] == ALLOWED_CONTENT_BLOCKERS and content['counts'] == COUNTS
         and set(content['rows']) == set(COUNTS) and content['fixedOrderIds'] == IDS, 'EXACT_FIXED7_COUNTS_AND_BLOCKERS_REQUIRED')
    need(all(digest_rows(content['rows'][t]) == digest_rows(old['rows'][t]) for t in COUNTS), 'TARGET_ROWS_CHANGED_SINCE_BACKUP')
    need(content['projection']['otherNativeOrders'] == [] and content['projection']['unreviewedReferences'] == []
         and content['projection']['auditTargetRows'] == [] and content['projection']['media']['targetAttachmentRows'] == 0
         and content['projection']['push']['activeEncrypted'] == 0 and content['projection']['push']['decrypted'] is False
         and content['projection']['foreignKeyCheck']['count'] == 0, 'EXACT_CLOSURE_IDLE_PUSH_MEDIA_AND_FK_REQUIRED')
    need(content['projection']['jobs'] == {'siteOrder': ['order:' + str(i) for i in range(21, 35)], 'clientBot': []},
         'EXACT_FOURTEEN_JOB_REFERENCES_REQUIRED')
    outbox = content['rows']['site_order_outbox']
    need(all(r['status'] == 'sent' and r.get('claimed_at') is None for r in outbox), 'TARGET_OUTBOX_NOT_SENT_OR_CLAIMED')
    compare_schema(conn, old['schemaInventory'])
    need(content['schemaInventory'] == old['schemaInventory'] and sequence(conn) == content['sequence'], 'LOCKED_SCHEMA_OR_SEQUENCE_DRIFT')
    keys = {}; preserved = {}; crm = content['projection']['crmTargetRows']
    for table in CRM:
        rows = crm[table]; expected = [(i, 'palitra-love', i + 8) for i in range(3, 10 if table == CRM[0] else 6)]
        need(sorted((r['id'], r['company_code'], r['site_order_id']) for r in rows) == expected
             and digest_rows(rows) == digest_rows(old['projection']['crmTargetRows'][table]), 'EXACT_TEN_CRM_BACKLINKS_REQUIRED')
    for table in DELETE_ORDER:
        rows = content['rows'][table]; fields = pk_fields(old['schemaInventory'], table); keys[table] = fields
        need(len({row_key(r, fields) for r in rows}) == len(rows), 'DUPLICATE_TARGET_PRIMARY_KEY')
        for row in rows:
            actual = [dict(r) for r in conn.execute('SELECT * FROM ' + qi(table) + ' WHERE ' + where_key(fields), row_key(row, fields))]
            need(actual == [row], 'LOCKED_TARGET_ROW_CAS_CHANGED')
        drop = {row_key(r, fields) for r in rows}
        kept = [r for r in allrows(conn, table) if row_key(r, fields) not in drop]
        preserved[table] = {'count': len(kept), 'sha256': digest_rows(kept)}
    for table in CRM:
        actual = allrows(conn, table)
        for row in crm[table]:
            need([r for r in actual if r['id'] == row['id']] == [row], 'LOCKED_CRM_ROW_CAS_CHANGED')
        preserved[table] = {'count': len(actual), 'sha256': digest_rows(actual)}
    refs = content['projection']['jobs']['siteOrder']; review_worker(fresh['worker'], baseline['worker'], refs)
    return {'preserved': preserved, 'sequence': sequence(conn), 'keys': keys,
            'workerBindingSha256': sha(canon(worker_binding(fresh['worker']))),
            'targetRowsSha256': {t: digest_rows(content['rows'][t]) for t in COUNTS},
            'crmRowsSha256': {t: digest_rows(crm[t]) for t in CRM}}


def delete_locked(conn, state, baseline, fault=None):
    need(conn.in_transaction, 'LOCKED_TRANSACTION_REQUIRED')
    before = conn.total_changes; counts = {}; crm = baseline['content']['projection']['crmTargetRows']
    for table in CRM:
        for row in crm[table]:
            cursor = conn.execute('UPDATE ' + qi(table) + ' SET site_order_id=NULL WHERE id=? AND company_code=? AND site_order_id=?',
                                  (row['id'], 'palitra-love', row['site_order_id']))
            need(cursor.rowcount == 1, 'EXACT_CRM_BACKLINK_CAS_FAILED')
    for table in DELETE_ORDER:
        fields = state['keys'][table]; count = 0
        for row in baseline['content']['rows'][table]:
            count += conn.execute('DELETE FROM ' + qi(table) + ' WHERE ' + where_key(fields), row_key(row, fields)).rowcount
        need(count == COUNTS[table], 'EXACT_TARGET_DELETE_COUNT_CHANGED'); counts[table] = count
        if fault:
            fault(table, conn)
    need(conn.total_changes - before == 72, 'UNINTENDED_MUTATION_COUNT')
    for table, expected in state['preserved'].items():
        rows = allrows(conn, table)
        if table in CRM:
            links = {r['id']: r for r in crm[table]}
            for row in rows:
                if row['id'] in links:
                    need(row['site_order_id'] is None, 'CRM_BACKLINK_REMAINS')
                    row['site_order_id'] = links[row['id']]['site_order_id']
        need({'count': len(rows), 'sha256': digest_rows(rows)} == expected, 'OUTSIDE_OR_CRM_OTHER_FIELD_CHANGED')
    need(sequence(conn) == state['sequence'], 'CONTENT_SEQUENCE_CHANGED')
    need(conn.execute('SELECT COUNT(*) FROM site_orders WHERE id IN (11,12,13,14,15,16,17)').fetchone()[0] == 0,
         'FIXED_TARGET_ORDERS_REMAIN')
    need(conn.execute('PRAGMA foreign_key_check').fetchall() == [], 'NATIVE_FOREIGN_KEY_CHECK_FAILED')
    return counts


class Purge:
    def __init__(self, lease_pid):
        self.h = load(CODE / 'reset_collect_r2.py', COLLECTOR_HELPER_SHA, 'fixed7_exact_readonly_r2')
        self.s = load(CODE / 'safe_backup_facts_r1.py', SAFE_HELPER_SHA, 'fixed7_safe_pinned_backup')
        self.baseline = self.s.read_pinned_backup(); self.s.facts(self.baseline)
        self.script = safe(CODE / 'reset_snapshot.cjs').read_bytes(); need(sha(self.script) == SCRIPT_SHA, 'EXACT_COLLECTOR_REQUIRED')
        self.guard = self.h.Current23(lease_pid)
        self.decision_path = PRIVATE / 'decision.json'; self.journal_path = PRIVATE / 'apply-journal.json'

    def immutable_inputs(self):
        need(sha(safe(CODE / 'reset_collect_r2.py').read_bytes()) == COLLECTOR_HELPER_SHA
             and sha(safe(CODE / 'safe_backup_facts_r1.py').read_bytes()) == SAFE_HELPER_SHA
             and sha(safe(CODE / 'reset_snapshot.cjs').read_bytes()) == SCRIPT_SHA
             and self.s.read_pinned_backup() == self.baseline, 'PINNED_IMMUTABLE_INPUT_CHANGED')

    def runtime(self):
        self.immutable_inputs(); value = self.guard.runtime()
        need({k: v for k, v in value.items() if k != 'freshLeasePid'}
             == {k: v for k, v in self.baseline['runtimeBefore'].items() if k != 'freshLeasePid'}, 'CURRENT23_BACKUP_RUNTIME_DRIFT')
        return value

    def connect(self):
        mount = self.baseline['mounts']['content']; path = safe(Path(mount['source']) / 'content.sqlite'); info = path.stat()
        need((info.st_dev, info.st_ino) == (mount['device'], mount['inode']), 'EXACT_CONTENT_DATABASE_IDENTITY_REQUIRED')
        self.guard.mount('content', self.baseline['content']['database'])
        conn = sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, isolation_level=None, timeout=10)
        conn.row_factory = sqlite3.Row; conn.execute('PRAGMA foreign_keys=ON')
        need(conn.execute('PRAGMA foreign_keys').fetchone()[0] == 1, 'FOREIGN_KEYS_REQUIRED')
        need((path.stat().st_dev, path.stat().st_ino) == (info.st_dev, info.st_ino), 'CONTENT_DATABASE_REPLACED')
        return conn

    def observe_locked(self, conn):
        fresh = self.h.collect(self.guard, self.script)
        need(fresh['mounts'] == self.baseline['mounts'], 'DATABASE_MOUNT_IDENTITY_CHANGED')
        return reviewed_locked(conn, fresh, self.baseline)

    def worker_unchanged(self, state):
        refs = ['order:' + str(i) for i in range(21, 35)]
        raw = self.h.run(['docker', 'exec', '--env', 'PALITRA_RESET_READONLY_NATIVE=1', 'synapse-chat-1',
                          '/usr/local/bin/node', '-e', self.script.decode(), 'worker', json.dumps(refs, separators=(',', ':'))])
        current = json.loads(raw); review_worker(current, self.baseline['worker'], refs)
        self.guard.mount('worker', current['database'])
        need(sha(canon(worker_binding(current))) == state['workerBindingSha256'], 'WORKER_TARGET_CHANGED_NO_REPLAY')

    def approve(self):
        need(not os.path.lexists(PRIVATE), 'PRIOR_APPROVAL_OR_UNKNOWN_ATTEMPT_NO_RETRY')
        started = datetime.now(timezone.utc); runtime = self.runtime(); conn = self.connect()
        try:
            conn.execute('BEGIN IMMEDIATE'); state = self.observe_locked(conn)
            need(self.runtime() == runtime, 'RUNTIME_DRIFT_DURING_APPROVAL'); conn.execute('ROLLBACK')
        finally:
            if conn.in_transaction:
                conn.execute('ROLLBACK')
            conn.close()
        need((datetime.now(timezone.utc) - started).total_seconds() < 300, 'APPROVAL_OBSERVATION_STALE')
        self.guard.release.lease(); PRIVATE.mkdir(mode=0o700); os.chmod(PRIVATE, 0o700)
        info = safe(PRIVATE).stat(); need(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'PRIVATE_ATTEMPT_DIRECTORY_REQUIRED')
        sync_dir(ROOT)
        decision = {'schema': 1, 'status': 'FIXED7_DECISION_READY_NOT_DELETE_APPROVAL', 'observedAtUtc': started.isoformat(),
                    'fixedOrderIds': IDS, 'backupSha256': BACKUP_SHA, 'helperSha256': sha(Path(__file__).read_bytes()),
                    'runtime': runtime, 'state': state, 'actionTimeConfirmationReceived': False}
        pin = create(self.decision_path, decision)
        return {'status': decision['status'], 'decisionSha256': pin, 'counts': COUNTS, 'crmBacklinksToDetach': 10,
                'targetWorkerLedgerPreserved': True, 'dbWrites': 0, 'deletionApproved': False}

    def apply_once(self, decision_sha, confirmed):
        need(confirmed and re.fullmatch('[0-9a-f]{64}', decision_sha or ''), 'ACTION_TIME_CONFIRMED_FIXED7_APPLY_REQUIRED')
        info = safe(PRIVATE).stat(); need(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'PRIVATE_ATTEMPT_DIRECTORY_REQUIRED')
        need(not os.path.lexists(self.journal_path) and not os.path.lexists(str(self.journal_path) + '.pending'), 'PRIOR_OR_UNKNOWN_APPLY_NO_REPLAY')
        raw = read_private(self.decision_path); decision = json.loads(raw)
        need(sha(raw) == decision_sha and decision['status'] == 'FIXED7_DECISION_READY_NOT_DELETE_APPROVAL'
             and decision['fixedOrderIds'] == IDS and decision['backupSha256'] == BACKUP_SHA
             and decision['helperSha256'] == sha(Path(__file__).read_bytes()), 'EXACT_PRIVATE_DECISION_REQUIRED')
        def fresh():
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(decision['observedAtUtc'])).total_seconds()
            need(0 <= age < 300, 'DECISION_STALE_OR_FUTURE')
        fresh(); need(self.runtime() == decision['runtime'], 'RUNTIME_DRIFT_BEFORE_APPLY')
        journal = {'schema': 1, 'status': 'FIXED7_DELETE_STARTED_UNKNOWN_NO_REPLAY', 'decisionSha256': decision_sha,
                   'backupSha256': BACKUP_SHA, 'fixedOrderIds': IDS, 'actionTimeConfirmationReceived': True,
                   'startedAtUtc': datetime.now(timezone.utc).isoformat(), 'automaticRetry': False}
        create(self.journal_path, journal); conn = None; commit_attempted = False
        try:
            conn = self.connect(); conn.execute('BEGIN IMMEDIATE'); state = self.observe_locked(conn)
            need(state_binding(state) == state_binding(decision['state']), 'LOCKED_TARGET_OR_PRESERVED_STATE_CHANGED_AFTER_APPROVAL')
            need(self.runtime() == decision['runtime'], 'LAST_FULL_RUNTIME_GUARD_CHANGED')
            fresh(); self.immutable_inputs(); need(read_private(self.decision_path) == raw, 'LAST_PRIVATE_DECISION_CAS_CHANGED')
            counts = delete_locked(conn, state, self.baseline); self.worker_unchanged(state)
            self.guard.release.lease(); fresh()
            final = {**journal, 'status': 'FIXED7_COMMIT_STARTED_UNKNOWN_NO_REPLAY'}
            journal_replace(self.journal_path, journal, final); journal = final
            commit_attempted = True; conn.execute('COMMIT')
            self.worker_unchanged(state)
            need(self.runtime() == decision['runtime'], 'POST_COMMIT_FULL_RUNTIME_CHANGED_NO_REPLAY')
            need(conn.execute('SELECT COUNT(*) FROM site_orders WHERE id IN (11,12,13,14,15,16,17)').fetchone()[0] == 0,
                 'POST_COMMIT_TARGETS_REMAIN')
            final = {**journal, 'status': 'FIXED7_ORDERS_AND_SCOPED_ROWS_DELETED', 'deletedCounts': counts,
                     'deletedOrders': 7, 'crmBacklinksDetached': 10, 'crmOtherFieldsPreserved': True,
                     'contentSequencePreserved': True, 'workerTargetLedgerPreserved': True, 'workerDbWrites': 0,
                     'mediaFilesDeleted': 0, 'outboundMessages': 0, 'finishedAtUtc': datetime.now(timezone.utc).isoformat()}
            journal_replace(self.journal_path, journal, final); return final
        except Exception:
            rolled_back = False
            if conn is not None and conn.in_transaction:
                conn.execute('ROLLBACK'); rolled_back = True
            if rolled_back and not commit_attempted:
                final = {**journal, 'status': 'FIXED7_REFUSED_TRANSACTION_ROLLED_BACK_NO_DELETE'}
                journal_replace(self.journal_path, journal, final)
            raise
        finally:
            if conn is not None:
                conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('approve', 'apply-once'))
    parser.add_argument('--lease-pid', type=int, required=True)
    parser.add_argument('--decision-sha')
    parser.add_argument('--apply-once', action='store_true')
    parser.add_argument('--action-time-confirmed-delete-11-through-17', action='store_true')
    args = parser.parse_args()
    try:
        need(os.name == 'posix' and os.geteuid() == 0 and safe(__file__).parent == CODE, 'EXACT_NATIVE_ROOT_INVOCATION_REQUIRED')
        need(args.operation != 'approve' or not args.apply_once, 'APPROVE_CANNOT_DELETE')
        purge = Purge(args.lease_pid)
        if args.operation == 'approve':
            result = purge.approve()
        else:
            need(args.apply_once, 'EXPLICIT_APPLY_ONCE_REQUIRED')
            result = purge.apply_once(args.decision_sha, args.action_time_confirmed_delete_11_through_17)
        print(json.dumps(result, sort_keys=True, separators=(',', ':'))); return 0
    except Exception as error:
        code = str(error) if type(error) is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,100}', str(error)) else 'FIXED7_PURGE_REFUSED_OR_UNKNOWN_READ_JOURNAL'
        print(json.dumps({'status': 'FIXED7_REFUSED_OR_UNKNOWN_NO_REPLAY', 'code': code,
                          'messageSha256': sha(str(error).encode()), 'automaticRetry': False})); return 2


if __name__ == '__main__':
    sys.exit(main())
