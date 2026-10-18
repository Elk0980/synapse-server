"""Draft successor of installed36. No action while FROZEN is false.

Uses the immutable completed36 lineage only for reading proofs and the existing
compose adapter. Never invokes an old apply/approve/inspect or reuses its lease.
"""
import argparse
import base64
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import time
import types

FROZEN = False
ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
NAME = 'multi-company-app-20261019-r3'
CODE = ROOT / (NAME + '-code')
LOCK = '/opt/synapse/.palitra-app-release.lock'
PARENT = 'sha256:83b1873906d0740fc238acbf464bed02e88564e885e472f1cc68be3de336c063'
RECEIPT36 = '82239c55f1d5d05ac84ffdb70c1eac28d61024d41bb6fd8e288da254d9ed5cea'
DECISION36 = 'c86640f2b7f3ab577dabcedeab68379831193defba17842e24df44b5f0d30af9'
HELPER36 = '6f6804f53581bd53b33a72e231ab3fa77d2c36b3c78a42055c467e86dd5d86a9'
MANIFEST_SHA = '0' * 64
ROLLBACK_SHA = '0' * 64
ABSENT_REPORT_DB = {'path': '/data/salon-reports.sqlite', 'files': {'db': None, 'wal': None, 'shm': None}}
sha = lambda raw: hashlib.sha256(raw).hexdigest()
digest = lambda value: isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def need(value, code):
    if not value:
        raise ValueError(code)


def private_report_db(value):
    return (type(value) is dict and set(value) == {'path', 'files'} and value['path'] == '/data/salon-reports.sqlite'
            and type(value['files']) is dict and set(value['files']) == {'db', 'wal', 'shm'} and value['files']['db'] is not None
            and all(row is None or type(row) is dict and row == {'uid': 0, 'mode': 0o600} for row in value['files'].values()))


def load36(pid):
    need(type(pid) is int and pid > 1 and pid not in (3031696, 3015977), 'FRESH_RECEIVER_LEASE_REQUIRED')
    folder = ROOT / 'palitra-chat-open-layout-code-r1'
    path = folder / 'chat_open_layout_release_native.py'
    for item in [*reversed(path.parents), path]:
        need(not item.is_symlink(), 'SEALED36_SYMLINK_REFUSED')
    raw = path.read_bytes()
    need(sha(raw) == HELPER36, 'EXACT_SEALED36_HELPER_REQUIRED')
    prior = types.ModuleType('read_completed36'); prior.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), prior.__dict__)
    a, b, before35 = prior.load_current35(pid)
    journal = ROOT / 'palitra-chat-open-layout-r1-journal.json'
    receipt = a.pinned(journal, RECEIPT36, True)
    historical = receipt.get('inputs', {}).get('freshLeasePid')
    need(historical == 3031696, 'COMPLETED36_HISTORICAL_BINDING_REQUIRED')
    accepted = prior.ChatOpenLayoutRelease(a, b, before35, folder / 'payload', prior.MANIFEST_SHA, historical)
    need(receipt.get('name') == prior.NAME and receipt.get('phase') == prior.PHASE
         and receipt.get('inputs') == accepted.binding() and receipt.get('before') == accepted.base
         and receipt.get('childImage') == PARENT and receipt.get('decisionSha256') == DECISION36
         and receipt.get('workerRecreated') is False and receipt.get('uploadsEnabled') is True
         and receipt.get('directDbWrites') == receipt.get('queueEdits') == receipt.get('oldJournalWrites') == 0
         and receipt.get('automaticRetry') is False and receipt.get('automaticCodeRollback') is False,
         'EXACT_COMPLETED36_RECEIPT_REQUIRED')
    sealed = a.pinned(accepted.paths()['decision'], DECISION36, True)
    need(sealed.get('rootApproved') is True and sealed.get('inputs') == accepted.binding()
         and sealed.get('before') == accepted.base and sealed.get('sourceModes') == receipt.get('sourceModes'),
         'EXACT_COMPLETED36_DECISION_REQUIRED')
    proof = {k: receipt[k] for k in ('childImage', 'overlaySha256', 'plannedConfigHash')}
    need(receipt['after']['containers']['content'] == accepted.expected_metadata('content', PARENT, proof)
         and len(receipt['after']['containers']['content']['files']) == 35
         and receipt['after']['containers']['chat'] == accepted.base['containers']['chat']
         and all(receipt['after'][k] == accepted.base[k] for k in ('worker', 'selected', 'l12'))
         and len(accepted.final_source) == 211 and len(accepted.final_static) == 27,
         'EXACT_COMPLETED36_FULL_MAPS_REQUIRED')

    def stable():
        accepted.stable()
        need(sha(a.read(journal)) == RECEIPT36 and a.pinned(accepted.paths()['decision'], DECISION36, True) == sealed,
             'COMPLETED36_SEALS_CHANGED')
        need(accepted.context_proof(receipt, True) == receipt['contextSha256'], 'COMPLETED36_CONTEXT_CHANGED')
        accepted.backup_guard(receipt)

    stable()
    current = types.SimpleNamespace(base=copy.deepcopy(receipt['after']), source=dict(accepted.final_source),
                                    static=dict(accepted.final_static), cabinet=accepted.cabinet, managed=accepted.managed,
                                    stable=stable, source_script=before35.source_script, accepted=accepted)
    supplemental = {'client-bot-config.js': '33661a009e697c034c10632e3e6affdea30ba72176546147d029fd4b284706eb'}
    need(not set(supplemental).intersection(current.source)
         and b.photo.hashes(supplemental) == supplemental, 'EXACT_SUPPLEMENTAL_NATIVE_SOURCE_REQUIRED')
    current.source.update(supplemental)
    need(len(current.source) == 212, 'EXACT_AUGMENTED_SOURCE212_REQUIRED')
    return a, b, prior, current


def validate_records(manifest):
    need(type(manifest) is dict and set(manifest) == {'schema', 'build', 'records'} and manifest['schema'] == 1
         and manifest['build'] == 'synapse-company-app-20261019-r2' and type(manifest['records']) is list
         and len(manifest['records']) == 21, 'EXACT_CLOSED_PRODUCT_MANIFEST_REQUIRED')
    products = {'shell.js', 'shell.css', 'synapse-bridge.js', 'native-host.js', 'cabinet.html', 'company-context.js',
                'customer-reports-ui.js', 'customer-reports-ui.css', 'report-source.html', 'report-source-ui.js', 'report-source.css'}
    modules = {'runtime.cjs', 'company-app-http.cjs', 'company-context.js', 'customer-reports-http.cjs', 'customer-reports.cjs',
               'customer-report-import-http.cjs', 'customer-report-cache.cjs', 'customer-report-aggregates.cjs'}
    names = {'product/' + n for n in products} | {'backend/company-app/' + n for n in modules} | {'backend/server.js', 'backend/client-bot-config.js'}
    result = {}
    for row in manifest['records']:
        need(type(row) is dict and set(row) == {'name', 'target', 'sha256', 'bytes', 'beforeSha256', 'beforeSourceSha256', 'static'}
             and row['name'] in names and row['name'] not in result and digest(row['sha256'])
             and type(row['bytes']) is int and 0 < row['bytes'] <= 2 * 1024 * 1024
             and (row['beforeSha256'] is None or digest(row['beforeSha256'])), 'EXACT_PRODUCT_RECORD_REQUIRED')
        target = row['name'].removeprefix('backend/') if row['name'].startswith('backend/') else 'palitra-orders-public/' + row['name'].split('/')[-1]
        need(row['target'] == target and row['static'] == (row['name'].split('/')[-1] if row['name'].startswith('product/') else None), 'CLOSED_TARGET_MAPPING_REQUIRED')
        need(row['beforeSourceSha256'] == (None if row['name'] == 'product/cabinet.html' else row['beforeSha256']), 'EXACT_DISTINCT_RUNTIME_STATIC_BASE_REQUIRED')
        result[row['name']] = row
    need(set(result) == names and len({r['target'] for r in result.values()}) == 21, 'CLOSED_UNIQUE_PAYLOAD_REQUIRED')
    return result


class Release:
    def __init__(self, a, b, prior, current, pid):
        self.a, self.b, self.prior, self.current, self.pid = a, b, prior, current, pid
        self.run, self.files = b.run, prior.FileOps()
        self.base = copy.deepcopy(current.base)
        self.paths = {n: ROOT / (NAME + '-' + n + ('.json' if n in ('decision', 'journal', 'overlay') else ''))
                      for n in ('decision', 'journal', 'overlay', 'context', 'backup')}
        self.cabinet = a.exact_path(current.cabinet)
        self.manifest = a.pinned(CODE / 'payload/MANIFEST.json', MANIFEST_SHA)
        self.records = validate_records(self.manifest)
        self.source, self.static = dict(current.source), dict(current.static)
        self.static_records, self.existing_sources, self.added_sources = {}, {}, []
        for row in self.records.values():
            raw = a.read(CODE / 'payload' / row['name'])
            need(len(raw) == row['bytes'] and sha(raw) == row['sha256'], 'PRODUCT_PAYLOAD_CHANGED')
            need(current.source.get(row['target']) == row['beforeSourceSha256'], 'SOURCE_BASE36_MISMATCH')
            if row['beforeSourceSha256'] is None: self.added_sources.append(row['target'])
            else: self.existing_sources[row['target']] = row
            self.source[row['target']] = row['sha256']
            if row['static']:
                target = str(self.cabinet / row['static'])
                need(current.static.get(target) == row['beforeSha256'], 'STATIC_BASE36_MISMATCH')
                self.static[target] = row['sha256']; self.static_records[target] = row
        need(len(current.source) == 212 and len(self.source) == 227 and len(self.static) == 33 and len(self.added_sources) == 15, 'EXACT_SUCCESSOR227_STATIC33_REQUIRED')
        self.pins = {str(CODE / 'payload/MANIFEST.json'): MANIFEST_SHA, str(Path(__file__)): sha(Path(__file__).read_bytes()), str(CODE / 'ROLLBACK.md'): ROLLBACK_SHA}
        self.b.lease = self.lease

    def lease(self):
        raw = self.run(['lslocks', '--noheadings', '--output', 'PID,PATH'])
        need(len(raw) <= 1048576, 'BOUNDED_LEASE_REQUIRED')
        rows = [r.strip().split(maxsplit=1) for r in raw.decode().splitlines() if len(r.strip().split(maxsplit=1)) == 2 and r.strip().split(maxsplit=1)[1] == LOCK]
        need(rows == [[str(self.pid), LOCK]], 'EXACT_OWN_SINGLE_WRITER_REQUIRED')

    def stable(self):
        self.current.stable()
        for p, pin in self.pins.items(): need(sha(self.a.read(Path(p))) == pin, 'FROZEN_RECEIVER_CODE_CHANGED')
        for row in self.records.values(): need(sha(self.a.read(CODE / 'payload' / row['name'])) == row['sha256'], 'FROZEN_PRODUCT_CHANGED')

    def metadata(self, child=None, proof=None):
        expected = copy.deepcopy(self.base['containers']['content'])
        if child:
            need(type(proof) is dict and set(proof) == {'overlaySha256', 'plannedConfigHash'}
                 and all(digest(v) for v in proof.values()) and child != PARENT and self.a.image(child), 'EXPLICIT_CHILD_PROOF_REQUIRED')
            overlay = str(self.paths['overlay']); files = expected['files'] + [overlay]
            need(len(files) == len(set(files)) == 36 and sha(self.a.read(Path(overlay))) == proof['overlaySha256'], 'EXACT_NEW_CHAIN36_REQUIRED')
            expected.update(image=child, files=files, configFiles=','.join(files), filePins={**expected['filePins'], overlay: proof['overlaySha256']}, configHash=proof['plannedConfigHash'])
        row = self.a.decode(self.run(['docker', 'inspect', '--format', self.a.LABELS, 'synapse-content-1']))
        need(type(row) is dict and row.get('configFiles') == expected['configFiles'], 'COMPOSE_CHAIN_CHANGED')
        row.update(files=list(expected['files']), filePins={name: sha(self.a.read(Path(name))) for name in expected['files']})
        need(row == expected and self.b.metadata('chat') == self.base['containers']['chat'], 'COMPLETE_RUNTIME_METADATA_CHANGED')
        return {'content': row, 'chat': copy.deepcopy(self.base['containers']['chat'])}

    def report_db(self):
        script = "const f=require('fs'),p=require('path');const n=p.join(p.dirname(process.env.DATABASE_PATH||'/data/content.sqlite'),'salon-reports.sqlite');if(n!=='/data/salon-reports.sqlite')throw Error('EXACT_DATA_PATH_REQUIRED');const out={path:n,files:{}};for(const[k,suffix]of [['db',''],['wal','-wal'],['shm','-shm']]){let s;try{s=f.lstatSync(n+suffix)}catch(e){if(e.code!=='ENOENT')throw e}if(s&&(!s.isFile()||s.isSymbolicLink()||s.nlink!==1))throw Error('REGULAR_REPORT_GROUP_REQUIRED');out.files[k]=s?{uid:s.uid,mode:s.mode&511}:null}console.log(JSON.stringify(out));"
        return self.a.decode(self.run(['docker', 'exec', 'synapse-content-1', 'node', '-e', script]))

    def users(self, child=None):
        result = {'current': self.a.decode(self.run(['docker', 'inspect', '--format', self.prior.USER_FORMAT, 'synapse-content-1'])),
                  'parent': self.a.decode(self.run(['docker', 'image', 'inspect', '--format', self.prior.USER_FORMAT, PARENT]))}
        if child: result['child'] = self.a.decode(self.run(['docker', 'image', 'inspect', '--format', self.prior.USER_FORMAT, child]))
        need(all(type(v) is str and v in self.prior.ROOT_USERS for v in result.values())
             and (not child or result['parent'] == result['child']), 'PRESERVED_ROOT_SERVICE_USER_REQUIRED')
        return result

    def source_modes(self, child=False):
        names = sorted((row['target'] for row in self.records.values()) if child else self.existing_sources)
        script = self.prior.SOURCE_FACTS_JS
        value = self.a.decode(self.run(['docker', 'exec', 'synapse-content-1', 'node', '-e', script, json.dumps(names)]))
        need(type(value) is dict and set(value) == set(names) and all(v.get('uid') == v.get('gid') == 0 and v.get('mode') in (0o600, 0o644) for v in value.values()), 'ROOT_SOURCE_MODES_REQUIRED')
        if not child:
            for name in self.added_sources: value[name] = {'uid': 0, 'gid': 0, 'mode': 0o644}
        return value

    def static_modes(self, changed=frozenset()):
        result = {}
        for target, row in self.static_records.items():
            path = self.a.exact_path(Path(target), row['beforeSha256'] is None and target not in changed)
            if row['beforeSha256'] is None and target not in changed:
                need(not os.path.lexists(path), 'NEW_STATIC_TARGET_ALREADY_EXISTS'); result[target] = 0o644; continue
            s = path.stat()
            need(stat.S_ISREG(s.st_mode) and s.st_uid == s.st_gid == 0 and stat.S_IMODE(s.st_mode) in (0o600, 0o644), 'EXACT_ROOT_STATIC_MODES_REQUIRED')
            result[target] = stat.S_IMODE(s.st_mode)
        return result

    def snapshot(self, child=None, changed=frozenset(), proof=None):
        self.stable(); self.lease(); self.current.accepted.revision_guard()
        first = self.metadata(child, proof); worker = self.b.worker_facts(); selected = {s: self.b.a.selected(s) for s in ('content', 'chat')}
        flags = self.a.decode(self.run(['docker', 'exec', 'synapse-content-1', 'node', '-e', self.a.FLAGS_JS]))
        need(worker == self.base['worker'] and selected == self.base['selected'] and flags == self.base['l12'], 'WORKER_FLAGS_SELECTION_CHANGED')
        for service, row in first.items():
            value = self.run(self.b._resolve_command(row, service)).decode('ascii').strip()
            need(re.fullmatch(re.escape(service) + r'\s+' + re.escape(row['configHash']), value) is not None, 'RESOLVED_COMPOSE_HASH_CHANGED')
        self.b.graph(new=True); self.b.push_guard()
        source = self.source if child else self.current.source
        need(self.b.photo.hashes(source) == source, 'FULL_SOURCE_INVENTORY_CHANGED')
        if not child:
            check = "const f=require('fs');for(const n of JSON.parse(process.argv[1])){let s;try{s=f.lstatSync('/app/'+n)}catch(e){if(e.code!=='ENOENT')throw e}if(s)throw Error('ADDED_SOURCE_ALREADY_EXISTS')}process.stdout.write('ABSENT');"
            need(self.run(['docker', 'exec', 'synapse-content-1', 'node', '-e', check, json.dumps(self.added_sources)]) == b'ABSENT', 'ADDED_SOURCE_COLLISION')
        expected = dict(self.current.static)
        for target in changed: need(target in self.static_records, 'UNKNOWN_STATIC_TARGET'); expected[target] = self.static[target]
        for name, pin in expected.items(): need(sha(self.a.read(Path(name))) == pin, 'FULL_STATIC_INVENTORY_CHANGED')
        self.static_modes(changed)
        cid = self.b.photo.cid()
        need(first == self.metadata(child, proof) and worker == self.b.worker_facts() and selected == {s: self.b.a.selected(s) for s in ('content', 'chat')}
             and cid == self.b.photo.cid(), 'CONCURRENT_NATIVE_CHANGE')
        self.stable(); self.lease()
        return {'containers': first, 'selected': selected, 'worker': worker, 'contentCid': cid, 'l12': flags}

    def baseline(self):
        snap = self.snapshot()
        need(snap == self.base and self.b.heartbeat(snap['worker']['startedAt'], time.time())['freshAfterWorkerStart'], 'FRESH_EXACT36_REQUIRED')
        need(self.report_db() == ABSENT_REPORT_DB, 'PREEXISTING_REPORT_DB_WAL_SHM_REQUIRE_SEPARATE_BACKUP_REVIEW')
        self.users()
        return snap

    def binding(self):
        return {'parentReceipt': RECEIPT36, 'parentImage': PARENT, 'manifest': MANIFEST_SHA, 'helper': self.pins[str(Path(__file__))],
                'freshLeasePid': self.pid, 'beforeSource': self.current.source, 'afterSource': self.source,
                'beforeStatic': self.current.static, 'afterStatic': self.static}

    def inspect_current(self):
        self.baseline()
        return {'status': 'CURRENT36_READONLY_NOT_APPROVED', 'sourceFiles': 212, 'sealedSourceFiles': 211, 'staticFiles': 27, 'chainFiles': 35,
                'candidateSourceFiles': 227, 'candidateStaticFiles': 33, 'sourceModes': self.source_modes(), 'staticModes': self.static_modes(),
                'reportDatabaseBefore': self.report_db(), 'runtimeWrites': 0}

    def acceptance(self, pin):
        value = self.a.pinned(CODE / 'ROOT_ACCEPTANCE.json', pin, True)
        need(type(value) is dict and value.get('status') == 'ACCEPTED_CURRENT36_COMPATIBILITY'
             and value.get('installerStatus') == 'ACCEPTED_NATIVE_INSTALLER_AND_ROLLBACK'
             and value.get('manifestSha256') == MANIFEST_SHA
             and value.get('helperSha256') == self.pins[str(Path(__file__))]
             and value.get('rollbackSha256') == ROLLBACK_SHA
             and value.get('reviewerThreadId') == '01a0a408-4f98-7713-a652-e6a741da834c',
             'EXACT_PRODUCT_AND_INSTALLER_ROOT_ACCEPTANCE_REQUIRED')
        return value

    def unused(self, allow_decision=False):
        for name, path in self.paths.items():
            if name == 'decision' and allow_decision: continue
            self.a.exact_path(path, True)
            need(not os.path.lexists(path) and not os.path.lexists(str(path) + '.pending'), 'OWN_ATTEMPT_EXISTS_NO_RETRY')
        for target in self.static_records:
            pending = Path(target).with_name(Path(target).name + '.' + NAME + '.pending')
            self.a.exact_path(pending, True); need(not os.path.lexists(pending), 'OWN_STATIC_PENDING_EXISTS_NO_RETRY')

    def approve(self, acceptance_pin, apply=False):
        need(apply is True and digest(acceptance_pin), 'EXPLICIT_ROOT_ACCEPTED_APPROVAL_REQUIRED')
        self.unused(); self.acceptance(acceptance_pin); before = self.baseline()
        value = {'schema': 1, 'name': NAME, 'inputs': self.binding(), 'before': before,
                 'observedAtUtc': self.a.stamp(time.time()), 'sourceModes': self.source_modes(), 'staticModes': self.static_modes(),
                 'rootAcceptanceSha256': acceptance_pin, 'reportDatabaseBefore': self.report_db(), 'serviceUsers': self.users()}
        self.a.write_new(self.paths['decision'], value)
        return {'status': 'NEW_DECISION_NOT_APPLIED', 'decisionSha256': sha(self.a.read(self.paths['decision'])), 'runtimeWrites': 0}

    def decision(self, pin, fresh=True):
        value = self.a.pinned(self.paths['decision'], pin, True)
        need(type(value) is dict and set(value) == {'schema', 'name', 'inputs', 'before', 'observedAtUtc', 'sourceModes', 'staticModes', 'rootAcceptanceSha256', 'reportDatabaseBefore', 'serviceUsers'}
             and value['schema'] == 1 and value['name'] == NAME and value['inputs'] == self.binding()
             and value['before'] == self.base and value['reportDatabaseBefore'] == ABSENT_REPORT_DB,
             'EXACT_OWN_DECISION_REQUIRED')
        self.acceptance(value['rootAcceptanceSha256'])
        need(value['serviceUsers'] == self.users(), 'APPROVED_SERVICE_USERS_CHANGED')
        if fresh: self.a.fresh(value['observedAtUtc'], time.time())
        return value

    def update(self, journal, phase, **fields):
        journal.update(phase=phase, **fields); self.a.replace(self.paths['journal'], journal)

    def context_proof(self, state, built=False):
        context = self.paths['context']
        wanted = {'Dockerfile': sha(('FROM ' + NAME + '-base\nCOPY app/ /app/\n').encode())}
        wanted.update({'app/' + row['target']: row['sha256'] for row in self.records.values()})
        wanted.update({'static/' + str(i): row['sha256'] for i, row in enumerate(state['static'])})
        actual = {}
        directories = {'app', 'static'} | {'app/' + str(p) for r in self.records.values() for p in PurePosixPath(r['target']).parents if str(p) != '.'}
        for path in context.rglob('*'):
            self.a.exact_path(path)
            if path.is_file():
                relative = path.relative_to(context).as_posix()
                if built and relative == 'image.id': continue
                actual[relative] = sha(self.a.read(path))
            else: need(path.is_dir() and path.relative_to(context).as_posix() in directories, 'UNEXPECTED_BUILD_DIRECTORY')
        need(actual == wanted, 'EXACT_CLOSED_BUILD_CONTEXT_REQUIRED')
        for target, mode in state['sourceModes'].items():
            need(self.files.mode(context / 'app' / target) == mode['mode'], 'SOURCE_CONTEXT_MODE_CHANGED')
        return sha(json.dumps(sorted(actual.items()), separators=(',', ':')).encode())

    def backups(self, state):
        directory = self.a.exact_path(self.paths['backup']); s = directory.stat()
        need(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and stat.S_IMODE(s.st_mode) == 0o700
             and state['backupIdentity'] == [s.st_dev, s.st_ino, s.st_uid], 'PRIVATE_BACKUP_DIRECTORY_CHANGED')
        need(len(state['sourceBackups']) == len(self.existing_sources) == 6
             and {r['target']: r['baseSha256'] for r in state['sourceBackups']} == {k: v['beforeSourceSha256'] for k, v in self.existing_sources.items()}
             and len(state['static']) == len(self.static_records) == 11
             and {r['target'] for r in state['static']} == set(self.static_records), 'EXACT_COMPLETE_BACKUP_INVENTORY_REQUIRED')
        for row in state['static']:
            record = self.static_records[row['target']]
            need(row['baseSha256'] == record['beforeSha256'] and row['sha256'] == record['sha256']
                 and (row['backup'] is None) == (record['beforeSha256'] is None), 'STATIC_BACKUP_RECORD_CHANGED')
        wanted = set()
        for row in state['sourceBackups'] + state['static']:
            if row['backup'] is None: continue
            p = Path(row['backup']); need(p.parent == directory, 'BACKUP_BOUNDARY_REQUIRED'); wanted.add(p.name)
            self.a.exact_path(p); info = p.stat()
            need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and self.files.mode(p) == 0o600
                 and sha(self.a.read(p)) == row['baseSha256'], 'PRIVATE_EXACT_BACKUP_CHANGED')
        need({p.name for p in directory.iterdir()} == wanted, 'CLOSED_BACKUP_DIRECTORY_REQUIRED')

    def publish(self, row, state, pin):
        self.backups(state); self.decision(pin); self.snapshot(changed=frozenset(state['written']))
        target = self.a.exact_path(Path(row['target']), row['baseSha256'] is None)
        if row['baseSha256'] is None: need(not os.path.lexists(target), 'ADDED_STATIC_COLLISION')
        else: need(sha(self.a.read(target)) == row['baseSha256'] and self.files.mode(target) == row['mode'], 'STATIC_CAS_CHANGED')
        raw = self.a.read(Path(row['prepared'])); need(sha(raw) == row['sha256'], 'PREPARED_STATIC_CHANGED')
        pending = target.with_name(target.name + '.' + NAME + '.pending')
        self.a.exact_path(pending, True); self.files.write(pending, raw, row['mode'])
        self.snapshot(changed=frozenset(state['written'])); self.decision(pin); self.lease()
        need(sha(self.a.read(pending)) == row['sha256'] and self.files.mode(pending) == row['mode'], 'STATIC_PENDING_CHANGED')
        if row['baseSha256'] is None:
            os.link(pending, target); os.unlink(pending)  # exclusive publication, never replace a newly appeared file
        else:
            need(sha(self.a.read(target)) == row['baseSha256'] and self.files.mode(target) == row['mode'], 'LAST_STATIC_CAS_CHANGED')
            os.replace(pending, target)
        state['written'].append(str(target))

    def apply(self, pin, apply=False):
        need(apply is True and digest(pin), 'EXPLICIT_OWN_APPLY_REQUIRED')
        self.unused(allow_decision=True); decision = self.decision(pin); before = self.baseline()
        need(self.source_modes() == decision['sourceModes'] and self.static_modes() == decision['staticModes'], 'APPROVED_FILE_MODES_CHANGED')
        alias, tag = NAME + '-base', NAME + '-content'
        for name in (alias, tag): need(not self.run(['docker', 'image', 'ls', '--quiet', '--filter', 'reference=' + name]).strip(), 'UNIQUE_NEW_IMAGE_ALIAS_REQUIRED')
        need(self.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', PARENT]).decode().strip() == PARENT, 'EXACT_PARENT_IMAGE_REQUIRED')
        layers = self.a.decode(self.run(['docker', 'image', 'inspect', '--format', '{{json .RootFS.Layers}}', PARENT]))
        need(type(layers) is list and layers, 'EXACT_PARENT_LAYERS_REQUIRED')
        state = {'schema': 1, 'name': NAME, 'inputs': self.binding(), 'before': before, 'decisionSha256': pin, 'static': [],
                 'sourceBackups': [], 'written': [], 'sourceModes': decision['sourceModes'], 'automaticRetry': False,
                 'automaticCodeRollback': False, 'workerRecreated': False, 'mainDbDirectWrites': 0, 'queueEdits': 0, 'oldJournalWrites': 0,
                 'reportDatabaseBefore': decision['reportDatabaseBefore']}
        self.a.write_new(self.paths['journal'], {**state, 'phase': 'CONTEXT_STARTED_UNKNOWN'})
        for path in (self.paths['context'], self.paths['backup']): self.files.directory(self.a.exact_path(path, True), 0o700)
        info = self.paths['backup'].stat(); state['backupIdentity'] = [info.st_dev, info.st_ino, info.st_uid]
        directories = {'app', 'static'} | {'app/' + str(p) for r in self.records.values() for p in PurePosixPath(r['target']).parents if str(p) != '.'}
        for relative in sorted(directories, key=lambda n: (n.count('/'), n)):
            self.files.directory(self.a.exact_path(self.paths['context'] / relative, True), 0o700 if relative == 'static' else 0o755)
        for target, row in sorted(self.existing_sources.items()):
            encoded = self.run(['docker', 'exec', 'synapse-content-1', 'node', '-e', self.current.source_script, target])
            need(len(encoded) < 3 * 1024 * 1024, 'BOUNDED_ORIGINAL_SOURCE_REQUIRED')
            raw = base64.b64decode(encoded, validate=True); need(sha(raw) == row['beforeSourceSha256'], 'SOURCE_BACKUP_BASE_CHANGED')
            backup = self.paths['backup'] / ('source-' + str(len(state['sourceBackups'])))
            self.files.write(backup, raw, 0o600); state['sourceBackups'].append({'target': target, 'baseSha256': row['beforeSourceSha256'], 'backup': str(backup)})
        for row in self.records.values():
            self.files.write(self.paths['context'] / 'app' / row['target'], self.a.read(CODE / 'payload' / row['name']), decision['sourceModes'][row['target']]['mode'])
        for target, row in sorted(self.static_records.items()):
            index = len(state['static']); prepared = self.paths['context'] / 'static' / str(index); backup = None
            raw = self.a.read(CODE / 'payload' / row['name']); self.files.write(prepared, raw, 0o600)
            if row['beforeSha256'] is not None:
                old = self.a.read(Path(target)); need(sha(old) == row['beforeSha256'], 'STATIC_BACKUP_BASE_CHANGED')
                backup = self.paths['backup'] / ('static-' + str(index)); self.files.write(backup, old, 0o600)
            state['static'].append({'target': target, 'baseSha256': row['beforeSha256'], 'sha256': row['sha256'], 'mode': decision['staticModes'][target],
                                    'backup': str(backup) if backup else None, 'prepared': str(prepared)})
        self.files.write(self.paths['context'] / 'Dockerfile', ('FROM ' + alias + '\nCOPY app/ /app/\n').encode(), 0o600)
        self.backups(state); self.update(state, 'CONTEXT_READY_NOT_BUILT', contextSha256=self.context_proof(state))
        self.baseline(); self.decision(pin); self.lease()
        self.run(['docker', 'image', 'tag', PARENT, alias]); need(self.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', alias]).decode().strip() == PARENT, 'PARENT_ALIAS_CHANGED')
        self.update(state, 'BUILD_STARTED_UNKNOWN'); need(self.context_proof(state) == state['contextSha256'], 'LAST_CONTEXT_CHANGED')
        self.run(['docker', 'build', '--network=none', '--pull=false', '--tag', tag, '--iidfile', str(self.paths['context'] / 'image.id'), str(self.paths['context'])])
        child = self.a.read(self.paths['context'] / 'image.id').decode().strip()
        need(self.a.image(child) and child != PARENT and self.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag]).decode().strip() == child, 'EXACT_CHILD_IMAGE_REQUIRED')
        child_layers = self.a.decode(self.run(['docker', 'image', 'inspect', '--format', '{{json .RootFS.Layers}}', child]))
        need(type(child_layers) is list and child_layers[:len(layers)] == layers and len(child_layers) == len(layers) + 1, 'ONE_COPY_LAYER_REQUIRED')
        need(self.context_proof(state, True) == state['contextSha256'] and self.b.photo.hashes(self.source, child) == self.source, 'FULL_CHILD_SOURCE_CHANGED')
        script = self.prior.CHILD_CHECK_JS + ";const {DatabaseSync}=require('node:sqlite');const r=require('/app/company-app/runtime.cjs').create({db:new DatabaseSync(':memory:')});r.close();"
        output = self.run(['docker', 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint=node', child, '-e', script, json.dumps(decision['sourceModes'])])
        need(output == b'PRECHECK_OK', 'CHILD_SYNTAX_RUNTIME_PREFLIGHT_REQUIRED')
        self.users(child)
        self.baseline(); self.decision(pin); self.backups(state)
        self.update(state, 'STATIC_STARTED_UNKNOWN', childImage=child)
        for row in sorted(state['static'], key=lambda row: (row['target'].endswith('/cabinet.html'), row['target'])):
            self.publish(row, state, pin); self.update(state, 'STATIC_STARTED_UNKNOWN')
        need(self.snapshot(changed=frozenset(state['written'])) == before, 'LAST_PARENT_WITH_PUBLISHED_STATIC_CHANGED')
        self.a.write_new(self.paths['overlay'], {'services': {'content': {'image': child}}})
        proof = {'overlaySha256': sha(self.a.read(self.paths['overlay'])), 'plannedConfigHash': self.b.plan(before, 'content', self.paths['overlay'])}
        self.update(state, 'CONTENT_UP_STARTED_UNKNOWN', **proof)
        self.decision(pin); self.lease(); self.backups(state); self.stable()
        need(self.context_proof(state, True) == state['contextSha256'] and self.b.plan(before, 'content', self.paths['overlay']) == proof['plannedConfigHash'], 'LAST_CONTEXT_OR_COMPOSE_PLAN_CHANGED')
        self.lease()
        need(self.report_db() == ABSENT_REPORT_DB, 'LAST_REPORT_DATABASE_GROUP_MUST_BE_ABSENT')
        self.b.up(before, 'content', self.paths['overlay'])
        after = self.snapshot(child, frozenset(state['written']), proof)
        need(after['contentCid'] != before['contentCid'] and self.source_modes(True) == decision['sourceModes'], 'EXACT_NEW_CONTENT_AND_MODES_REQUIRED')
        report_db = self.report_db(); need(private_report_db(report_db), 'PRIVATE_REPORT_DB_CREATION_REQUIRED')
        self.update(state, 'APPLIED_NOT_CUSTOMER_ACCEPTANCE', after=after, reportDatabaseAfter=report_db, finishedAtUtc=self.a.stamp(time.time()))
        return {'status': 'APPLIED_NOT_CUSTOMER_ACCEPTANCE', 'receiptSha256': sha(self.a.read(self.paths['journal'])), 'contentImage': child,
                'sourceFiles': 227, 'staticFiles': 33, 'chainFiles': 36, 'workerRecreated': False, 'mainDbDirectWrites': 0, 'oldJournalWrites': 0}

    def inspect(self, pin):
        state = self.a.pinned(self.paths['journal'], pin, True)
        need(state.get('phase') == 'APPLIED_NOT_CUSTOMER_ACCEPTANCE' and state.get('name') == NAME
             and state.get('inputs') == self.binding() and state.get('before') == self.base
             and state.get('workerRecreated') is False and state.get('automaticRetry') is False
             and state.get('automaticCodeRollback') is False
             and state.get('mainDbDirectWrites') == state.get('queueEdits') == state.get('oldJournalWrites') == 0,
             'EXACT_OWN_COMPLETED_RECEIPT_REQUIRED')
        self.decision(state['decisionSha256'], fresh=False); self.backups(state)
        need(self.context_proof(state, True) == state['contextSha256'] and set(state['written']) == set(self.static_records), 'SEALED_OWN_CONTEXT_AND_STATIC_REQUIRED')
        proof = {k: state[k] for k in ('overlaySha256', 'plannedConfigHash')}
        need(self.snapshot(state['childImage'], frozenset(state['written']), proof) == state['after']
             and self.report_db() == state['reportDatabaseAfter'], 'OWN_INSTALLATION_CHANGED')
        return {'status': 'OWN_COMPLETED_READONLY_NOT_CUSTOMER_ACCEPTANCE', 'sourceFiles': 227, 'staticFiles': 33, 'chainFiles': 36, 'runtimeWrites': 0}


def main():
    p = argparse.ArgumentParser(); p.add_argument('operation', choices=['inspect-current', 'approve-current', 'apply', 'inspect']); p.add_argument('--lease-pid', required=True, type=int)
    p.add_argument('--acceptance-sha'); p.add_argument('--decision-sha'); p.add_argument('--receipt-sha'); p.add_argument('--apply', action='store_true'); args = p.parse_args()
    try:
        need(FROZEN is True and digest(MANIFEST_SHA) and MANIFEST_SHA != '0' * 64, 'DRAFT_INSTALLER_NOT_FROZEN_NO_ACTION')
        need(os.name == 'posix' and os.geteuid() == 0 and Path(__file__).resolve().parent == CODE, 'EXACT_RECEIVER_CODE_ROOT_REQUIRED')
        a, b, prior, current = load36(args.lease_pid)
        release = Release(a, b, prior, current, args.lease_pid)
        if args.operation == 'inspect-current': result = release.inspect_current()
        elif args.operation == 'approve-current': result = release.approve(args.acceptance_sha, args.apply)
        elif args.operation == 'apply': result = release.apply(args.decision_sha, args.apply)
        else: result = release.inspect(args.receipt_sha)
        print(json.dumps(result, separators=(',', ':'))); return 0
    except Exception as error:
        code = str(error) if type(error) is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,100}', str(error)) else 'NATIVE_RELEASE_REFUSED'
        print(json.dumps({'status': 'REFUSED_OR_UNKNOWN_NO_AUTOMATIC_RETRY', 'code': code, 'messageSha256': sha(str(error).encode()), 'runtimeWritesNotAssumed': True})); return 2


if __name__ == '__main__':
    raise SystemExit(main())
