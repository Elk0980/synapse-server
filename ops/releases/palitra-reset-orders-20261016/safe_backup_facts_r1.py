"""Fixed11-17: root-native, pinned-private-backup SAFE FACTS only. No database API."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.dont_write_bytecode = True
ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
BACKUP = ROOT / 'reset-orders11-17-r2/target-backup.json'
BACKUP_SHA = '31dcfb01a1db2bc7f5fe93bf4017e8dab276d32aa7c1312f81c970511d0f9620'
BACKUP_BYTES = 261032
COLLECTOR_SHA = '1ab0cd944fa3d8a008e847df78a3f2986c5865c8c8e8047ca2ec224a055f7d59'
HELPER_SHA = '3c6333794080b547374353fc6734c7464cfeb880dd62f67a55e6963a20e59f7d'
IDS = [11, 12, 13, 14, 15, 16, 17]
REFS = {'id', 'order_id', 'site_order_id', 'thread_id', 'dialog_id', 'message_id',
        'channel_id', 'thread_message_id', 'legacy_message_id', 'client_message_id',
        'chat_message_id', 'replaces_message_id', 'job_id', 'update_id'}
STATES = {'new', 'in_progress', 'done', 'cancelled', 'pending', 'sending', 'uncertain',
          'error', 'sent', 'failed', 'queued', 'not_queued', 'prepared', 'receiving',
          'ready', 'committed', 'rejected', 'expired', 'active', 'closed', 'order',
          'telegram', 'web', 'customer', 'manager', 'admin', 'bot'}
IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*\Z')
sha = lambda raw: hashlib.sha256(raw).hexdigest()
canon = lambda obj: json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def need(ok, code):
    if not ok:
        raise ValueError(code)


def digest_rows(rows):
    """Order-independent multiset of complete rows; private values never emitted."""
    return sha(b'[' + b','.join(sorted(canon(row) for row in rows)) + b']')


def typed(value):
    if value is None:
        return {'type': 'null', 'value': None}
    if type(value) is int:
        return {'type': 'integer', 'value': value}
    if type(value) is str and re.fullmatch(r'(?:cb|order):[1-9][0-9]*', value):
        return {'type': 'workerJobReference', 'value': value}
    return {'type': type(value).__name__, 'sha256': sha(canon(value))}


def safe_schema(inventory):
    schema = inventory['schema']; columns = inventory['columns']; foreign = inventory['foreignKeys']
    need(len(schema) <= 3000 and all(IDENT.fullmatch(t) for t in columns), 'BOUNDED_NAMED_SCHEMA_REQUIRED')
    need(all(IDENT.fullmatch(c['name']) for cs in columns.values() for c in cs), 'NAMED_COLUMNS_REQUIRED')
    return {
        'sha256': inventory['sha256'],
        'objects': [{'type': row['type'], 'name': row['name'], 'table': row['tbl_name'],
                     'nameHash16': sha(row['name'].encode())[:16],
                     'sqlSha256': sha(canon(row.get('sql')))} for row in schema],
        'tables': {t: {'columns': [{k: c[k] for k in ('cid', 'name', 'type', 'notnull', 'pk')} for c in cs],
                       'primaryKey': [c['name'] for c in sorted(cs, key=lambda c: c['pk']) if c['pk']]}
                   for t, cs in columns.items()},
        'foreignKeys': foreign,
        'triggerSqlRead': False,
    }


def safe_rows(table, rows, columns):
    need(len(rows) <= 10000, 'BOUNDED_BACKUP_ROWS_REQUIRED')
    pk = [c['name'] for c in columns.get(table, []) if c['pk']]
    fields = sorted(set(pk) | (REFS & set(c['name'] for c in columns.get(table, []))))
    return {'count': len(rows), 'completeRowsMultisetSha256': digest_rows(rows),
            'digestCoverage': 'BACKUP_TARGET_ROWS_ONLY',
            'rows': [{'primaryKey': {k: typed(row[k]) for k in pk},
                      'references': {k: typed(row[k]) for k in fields if k in row},
                      'states': {k: (v if v in STATES else typed(v)) for k, v in row.items()
                                 if k in ('state', 'status', 'kind')},
                      'rowSha256': sha(canon(row))} for row in rows]}


def facts(value):
    need(value.get('schema') == 1 and value.get('status') == 'RESET_FIXED7_READONLY_BACKUP_NOT_APPROVAL'
         and value.get('fixedOrderIds') == IDS and value.get('collectorSha256') == COLLECTOR_SHA
         and value.get('helperSha256') == HELPER_SHA and value.get('dbWrites') == 0
         and value.get('workerLedgerWrites') == 0 and value.get('deletionApproved') is False
         and value.get('actionTimeConfirmationReceived') is False, 'EXACT_FIXED7_READONLY_BACKUP_REQUIRED')
    content = value['content']; worker = value['worker']; projection = content['projection']
    need(content['fixedOrderIds'] == IDS and content['scope'] == {'site': 'palitra', 'companyCode': 'palitra-love'},
         'EXACT_PALITRA_FIXED7_SCOPE_REQUIRED')
    content_schema = safe_schema(content['schemaInventory']); worker_schema = safe_schema(worker['schemaInventory'])
    tables = {t: safe_rows(t, rows, content['schemaInventory']['columns']) for t, rows in content['rows'].items()}
    worker_rows = dict(worker['rows'])
    for name, table in [('delivery', 'project_telegram_delivery'), ('ack', 'project_telegram_ack')]:
        worker_rows[table] = worker['project'][name]
    ledger = {t: safe_rows(t, rows, worker['schemaInventory']['columns']) for t, rows in worker_rows.items()}
    crm = {}
    for table in ('palitra_crm_inquiries', 'palitra_crm_orders'):
        rows = projection['crmTargetRows'][table]
        need(all(set(('id', 'company_code', 'site_order_id')) <= set(row) and row['company_code'] == 'palitra-love'
                 and row['site_order_id'] in IDS for row in rows), 'EXACT_CRM_BACKLINK_SCOPE_REQUIRED')
        crm[table] = {'count': len(rows),
                      'backlinks': [{k: row[k] for k in ('id', 'company_code', 'site_order_id')} for row in rows],
                      'completeRowsMultisetSha256': digest_rows(rows),
                      'preserveExceptSiteOrderIdMultisetSha256': digest_rows([
                          {k: v for k, v in row.items() if k != 'site_order_id'} for row in rows])}
    all_worker_names = worker['schemaInventory']['columns']
    scope_resolved = [t for t in all_worker_names if sha(t.encode())[:16] == '45da1fe94ccfb4c9']
    return {'schema': 1, 'status': 'RESET_FIXED7_SAFE_BACKUP_FACTS_NOT_DELETE_APPROVAL',
            'backupSha256': BACKUP_SHA, 'backupBytes': BACKUP_BYTES, 'fixedOrderIds': IDS,
            'contentSchema': content_schema, 'workerSchema': worker_schema,
            'targetTables': tables, 'crmPreserveRows': crm, 'workerPreserveTargetLedger': ledger,
            'workerScopeHash45da1fe94ccfb4c9ResolvedNames': scope_resolved,
            'workerTypedJobReferences': projection['jobs'],
            'workerInboxAggregate': worker['inboxAggregate'], 'workerCheckpoint': worker['checkpoint'],
            'workerSequence': worker['sequence'], 'contentSequence': content['sequence'],
            'workerCheckpointSha256': sha(canon(worker['checkpoint'])),
            'workerSequenceSha256': sha(canon(worker['sequence'])),
            'contentSequenceSha256': sha(canon(content['sequence'])),
            'outsideOrderIds': [r['id'] for r in projection['otherNativeOrders']],
            'foreignKeyCheck': projection['foreignKeyCheck'],
            'blockers': sorted(set(content['blockers'] + worker['blockers'])),
            'media': projection['media'], 'push': projection['push'],
            'unreviewedReferences': projection['unreviewedReferences'],
            'auditTargetCount': len(projection['auditTargetRows']),
            'auditTargetRowsSha256': digest_rows(projection['auditTargetRows']),
            'coverage': 'PINNED_BACKUP_ONLY_NOT_FRESH_RUNTIME_OR_FULL_UNRELATED_DATABASE_DIGEST',
            'rawMessagesOrPhonesEmitted': False, 'secretsOrSubscriptionsEmitted': False,
            'dbWrites': 0, 'workerLedgerWrites': 0, 'fileWrites': 0, 'deletionApproved': False}


def read_pinned_backup():
    need(os.name == 'posix' and os.geteuid() == 0, 'NATIVE_ROOT_REQUIRED')
    for path in [*reversed(BACKUP.parents), BACKUP]:
        info = path.lstat()
        need(not stat.S_ISLNK(info.st_mode), 'BACKUP_SYMLINK_REFUSED')
        need(stat.S_ISREG(info.st_mode) if path == BACKUP else stat.S_ISDIR(info.st_mode), 'EXACT_BACKUP_PATH_REQUIRED')
    need(BACKUP.parent.stat().st_uid == 0 and stat.S_IMODE(BACKUP.parent.stat().st_mode) == 0o700, 'ROOT_PRIVATE_DIRECTORY_REQUIRED')
    fd = os.open(BACKUP, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0))
    try:
        first = os.fstat(fd)
        need(first.st_uid == 0 and stat.S_IMODE(first.st_mode) == 0o600 and first.st_size == BACKUP_BYTES,
             'EXACT_PRIVATE_BACKUP_FILE_REQUIRED')
        chunks = []; total = 0
        while True:
            part = os.read(fd, 65536)
            if not part:
                break
            total += len(part); need(total <= BACKUP_BYTES, 'BOUNDED_PINNED_BACKUP_REQUIRED'); chunks.append(part)
        raw = b''.join(chunks); last = os.fstat(fd); path_now = BACKUP.lstat()
        need((first.st_dev, first.st_ino, first.st_uid, first.st_size, first.st_mtime_ns, first.st_ctime_ns)
             == (last.st_dev, last.st_ino, last.st_uid, last.st_size, last.st_mtime_ns, last.st_ctime_ns)
             and (last.st_dev, last.st_ino, last.st_uid) == (path_now.st_dev, path_now.st_ino, path_now.st_uid)
             and stat.S_ISREG(path_now.st_mode) and stat.S_IMODE(path_now.st_mode) == 0o600
             and len(raw) == BACKUP_BYTES and sha(raw) == BACKUP_SHA, 'PINNED_BACKUP_CHANGED')
        return json.loads(raw)
    finally:
        os.close(fd)


def action_brief(value):
    crm = {t: {'n': row['count'], 'links': [[r['id'], r['company_code'], r['site_order_id']] for r in row['backlinks']],
               'preserveSha': row['preserveExceptSiteOrderIdMultisetSha256']}
           for t, row in value['crmPreserveRows'].items()}
    ledger = {}
    for table, rows in value['workerPreserveTargetLedger'].items():
        states = {}
        for row in rows['rows']:
            for field, state in row['states'].items():
                key = field + ':' + (state if type(state) is str else sha(canon(state)))
                states[key] = states.get(key, 0) + 1
        ledger[table] = {'n': rows['count'], 'states': states, 'sha': rows['completeRowsMultisetSha256']}
    doc = value['targetTables']['documents']
    out = {'status': 'FIXED7_BACKUP_ACTION_BRIEF_NOT_APPROVAL', 'backupSha': value['backupSha256'],
           'ids': IDS, 'schemaSha': {'content': value['contentSchema']['sha256'], 'worker': value['workerSchema']['sha256']},
           'crm': crm, 'workerRefs': value['workerTypedJobReferences'], 'workerLedger': ledger,
           'inbox': value['workerInboxAggregate'], 'checkpointSha': value['workerCheckpointSha256'],
           'sequenceSha': {'content': value['contentSequenceSha256'], 'worker': value['workerSequenceSha256']},
           'scope45da': value['workerScopeHash45da1fe94ccfb4c9ResolvedNames'],
           'documents': {'n': doc['count'], 'sha': doc['completeRowsMultisetSha256']},
           'auditN': value['auditTargetCount'], 'media': value['media'], 'push': value['push'],
           'unreviewedRefs': value['unreviewedReferences'], 'fkN': value['foreignKeyCheck']['count'],
           'outsideIds': value['outsideOrderIds'], 'blockers': value['blockers'], 'writes': 0}
    need(len(canon(out)) <= 4000, 'ACTION_BRIEF_TOO_LARGE_REFUSED')
    return out


def schema_brief(value, filters):
    content_names = {'site_orders', 'site_order_outbox', 'chat_threads', 'chat_web_grants', 'chat_thread_links',
                     'client_bot_map', 'documents', 'palitra_crm_inquiries', 'palitra_crm_orders'}
    worker_names = {'client_bot_delivery', 'client_bot_ack', 'project_telegram_delivery', 'project_telegram_ack'}
    need(not filters or all(IDENT.fullmatch(t) and t in content_names | worker_names for t in filters), 'EXACT_SCHEMA_BRIEF_TABLE_REQUIRED')
    out = {'status': 'FIXED7_SCHEMA_BRIEF_NOT_APPROVAL', 'content': {}, 'worker': {}}
    for kind, schema, names in [('content', value['contentSchema'], content_names), ('worker', value['workerSchema'], worker_names)]:
        names = names & set(filters) if filters else names
        for table in sorted(names):
            need(table in schema['tables'], 'EXPECTED_ACTIVE_TABLE_SCHEMA_MISSING')
            item = schema['tables'][table]
            out[kind][table] = {'pk': item['primaryKey'], 'cols': [c['name'] for c in item['columns']],
                                'notnull': [c['name'] for c in item['columns'] if c['notnull']],
                                'fk': [fk for fk in schema['foreignKeys'] if fk['sourceTable'] == table or fk['table'] == table],
                                'triggers': [r['name'] for r in schema['objects'] if r['type'] == 'trigger' and r['table'] == table]}
    need(len(canon(out)) <= 8000, 'SCHEMA_BRIEF_USE_TABLE_FILTER_REQUIRED')
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--read-pinned-backup-only', action='store_true', required=True)
    parser.add_argument('--section', choices=('action-brief', 'schema-brief', 'summary', 'content-schema', 'worker-schema', 'target-rows', 'crm-worker', 'all'), default='action-brief')
    parser.add_argument('--table', action='append', default=[], help='Only for schema-brief; repeat for bounded chunks.')
    args = parser.parse_args()
    try:
        value = facts(read_pinned_backup())
        common = {k: value[k] for k in ('schema', 'status', 'backupSha256', 'backupBytes', 'fixedOrderIds', 'dbWrites', 'fileWrites', 'deletionApproved')}
        need(not args.table or args.section == 'schema-brief', 'TABLE_FILTER_ONLY_FOR_SCHEMA_BRIEF')
        if args.section == 'action-brief':
            result = action_brief(value)
        elif args.section == 'schema-brief':
            result = schema_brief(value, args.table)
        elif args.section == 'summary':
            summary_keys = ('blockers', 'outsideOrderIds', 'workerScopeHash45da1fe94ccfb4c9ResolvedNames',
                            'workerTypedJobReferences', 'workerInboxAggregate', 'workerCheckpoint', 'workerSequence',
                            'contentSequence', 'workerCheckpointSha256', 'workerSequenceSha256', 'contentSequenceSha256',
                            'foreignKeyCheck', 'media', 'push', 'unreviewedReferences', 'auditTargetCount',
                            'auditTargetRowsSha256', 'coverage')
            result = {**common, **{k: value[k] for k in summary_keys},
                      'targetTables': {t: {k: v for k, v in row.items() if k != 'rows'} for t, row in value['targetTables'].items()},
                      'crmPreserveRows': value['crmPreserveRows'], 'workerPreserveTargetLedger': value['workerPreserveTargetLedger']}
        elif args.section in ('content-schema', 'worker-schema'):
            result = {**common, 'schemaInventory': value['contentSchema' if args.section == 'content-schema' else 'workerSchema']}
        elif args.section == 'target-rows':
            result = {**common, 'targetTables': {t: row for t, row in value['targetTables'].items() if t != 'documents'},
                      'documents': {k: v for k, v in value['targetTables']['documents'].items() if k != 'rows'}}
        elif args.section == 'crm-worker':
            result = {**common, 'crmPreserveRows': value['crmPreserveRows'],
                      'workerPreserveTargetLedger': value['workerPreserveTargetLedger']}
        else:
            result = value
        print(json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=True))
        return 0
    except Exception as error:
        code = str(error) if type(error) is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,100}', str(error)) else 'SAFE_BACKUP_FACTS_REFUSED'
        print(json.dumps({'status': 'SAFE_BACKUP_FACTS_REFUSED', 'code': code, 'dbWrites': 0,
                          'messageSha256': sha(str(error).encode()), 'fileWrites': 0}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
