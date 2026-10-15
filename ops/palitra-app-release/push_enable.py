"""Root-only Web Push configuration, after exact completed incremental release.

Reuses unchanged accepted snapshot/source/Compose guards. No DB/auth/worker edits.
Private keys are generated/read only by installed accepted Node CLI; never by Python.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import types
from datetime import datetime, timezone

ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
INCREMENTAL_SHA = 'f7170af089f3ca6e951426320f74b139294e85eda18a56296726c360c1f807d7'
MANIFEST_SHA = '8894c2f449b18698848e5e3f60d973ba64e307316a2b3adc630336601c95c853'
TARGET = '/run/secrets/palitra-push'
PENDING_KEY = 'vapid.pending.json'
KEY_DIRECTORY = Path('/opt/synapse/.palitra-push-keys')
FLAG_JS = "process.stdout.write(process.env.PALITRA_WEB_PUSH_ENABLED==='true'?'true':'false');"
DB_JS = "const fs=require('fs'),p=process.env.DATABASE_PATH||'/data/content.sqlite';console.log(JSON.stringify({path:p,realpath:fs.realpathSync(p)}));"
PUSH_COUNT_JS = "const {DatabaseSync}=require('node:sqlite'),p=process.env.DATABASE_PATH||'/data/content.sqlite',d=new DatabaseSync(p,{readOnly:true});try{const n=d.prepare(\"SELECT COUNT(*) AS n FROM documents WHERE key LIKE 'palitra-push-private/v1/%'\").get().n;if(!Number.isSafeInteger(n)||n<0)throw Error('COUNT');console.log(JSON.stringify({pushDocuments:n,dbWrites:0}));}finally{d.close();}"
KEY_JS = "const c=require('crypto'),{readVapid}=require('/app/palitra-push-keys.cjs'),k=readVapid('/run/secrets/palitra-push/vapid.json'),v=require('/app/palitra-push-deps/node_modules/web-push/package.json').version;const w=require('/app/palitra-push-deps/node_modules/web-push'),s=require('/app/palitra-push-transport.cjs').createSafeSender({webpush:w,vapid:k});console.log(JSON.stringify({keyValid:true,publicKeySha256:c.createHash('sha256').update(k.publicKey).digest('hex'),webPushVersion:v,transportReady:typeof s==='function'}));"
HEALTH_JS = "const p=Number(process.env.PORT||8080);fetch('http://127.0.0.1:'+p+'/health',{signal:AbortSignal.timeout(4000)}).then(async r=>{const d=await r.json();if(r.status!==200||d.ok!==true||d.service!=='content')throw Error('HEALTH');console.log(JSON.stringify({status:200,ok:true,service:'content'}));}).catch(()=>process.exit(7));"


def need(value, message):
    if not value:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def loaded_incremental(root=ROOT):
    path = root / 'incremental_native.py'
    need(not path.is_symlink(), 'INCREMENTAL_CODE_LINK_REFUSED')
    raw = path.read_bytes()
    need(sha(raw) == INCREMENTAL_SHA, 'EXACT_ACCEPTED_INCREMENTAL_REQUIRED')
    module = types.ModuleType('accepted_push_incremental')
    module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    core = module.pinned_core(root)
    core.path(path)
    return module, core


class PushEnable:
    def __init__(self, release, incremental_name, incremental_receipt_sha, key_directory=KEY_DIRECTORY, public_roots=(Path('/opt/synapse/sites'),)):
        self.r, self.c, self.run, self.a = release, release.c, release.run, release.a
        self.root, self.now = release.root, release.now
        self.key_directory = self.c.path(Path(key_directory), True)
        self.public_roots = [Path(value) for value in public_roots]
        need(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}', incremental_name or '') is not None, 'INCREMENTAL_NAME_REQUIRED')
        self.incremental_path = self.root / (incremental_name + '-journal.json')
        self.incremental_sha = incremental_receipt_sha
        self.incremental = self.r.pin(self.incremental_path, incremental_receipt_sha)
        need(self.incremental.get('phase') == 'INCREMENTAL_CONTENT_AND_STATIC_APPLIED_NOT_PUBLIC_PROOF' and
             self.incremental.get('manifestSha256') == self.r.msha and self.incremental.get('pushEnabled') is False and
             self.incremental.get('workerRecreated') is False, 'COMPLETED_INCREMENTAL_PUSH_OFF_REQUIRED')

    def paths(self, name):
        need(re.fullmatch(r'push-r[1-9][0-9]{0,3}', name or '') is not None, 'UNIQUE_PUSH_RN_REQUIRED')
        return {kind: self.root / (name + '-' + kind + '.json') for kind in
                ('preflight', 'keys', 'overlay', 'journal', 'rollback-overlay')}

    def flag(self):
        value = self.run(['docker', 'exec', 'synapse-content-1', 'node', '-e', FLAG_JS])
        need(value in (b'true', b'false'), 'EXACT_PUSH_FLAG_REQUIRED')
        return value == b'true'

    def cid(self):
        value = self.run(['docker', 'inspect', '--format', '{{.Id}}', 'synapse-content-1']).decode().strip()
        need(re.fullmatch(r'[0-9a-f]{64}', value) is not None, 'CURRENT_CONTENT_CID_REQUIRED')
        return value

    def mounts(self):
        raw = self.c.obj(self.run(['docker', 'inspect', '--format', '{{json .Mounts}}', 'synapse-content-1']))
        need(type(raw) is list and len(raw) <= 20, 'BOUNDED_ACTUAL_MOUNTS_REQUIRED')
        projected = []
        for item in raw:
            need(type(item) is dict and item.get('Type') in ('bind', 'volume', 'tmpfs') and
                 type(item.get('Source')) is str and type(item.get('Destination')) is str and
                 item['Destination'].startswith('/') and type(item.get('RW')) is bool, 'ACTUAL_MOUNT_SHAPE_REQUIRED')
            projected.append({key: item[key] for key in ('Type', 'Source', 'Destination', 'RW')})
        need(len({row['Destination'] for row in projected}) == len(projected), 'DUPLICATE_MOUNT_DESTINATION')
        return sorted(projected, key=lambda row: row['Destination'])

    def binding(self, mounts):
        selected = self.c.obj(self.run(['docker', 'exec', 'synapse-content-1', 'node', '-e', DB_JS]))
        need(set(selected) == {'path', 'realpath'} and selected['path'] == selected['realpath'], 'EXISTING_DB_NO_SYMLINK_REQUIRED')
        path = PurePosixPath(selected['path'])
        need(path.is_absolute() and '..' not in path.parts, 'ABSOLUTE_CONTAINER_DB_REQUIRED')
        rows = [row for row in mounts if row['Type'] in ('volume', 'bind') and row['RW'] and
                (str(path) == row['Destination'] or str(path).startswith(row['Destination'].rstrip('/') + '/'))]
        need(bool(rows), 'EXISTING_PERSISTENT_DB_MOUNT_REQUIRED')
        maximum = max(len(row['Destination']) for row in rows)
        rows = [row for row in rows if len(row['Destination']) == maximum]
        need(len(rows) == 1, 'AMBIGUOUS_DB_MOUNT')
        row = rows[0]
        host = self.c.path(Path(row['Source']).joinpath(*path.relative_to(PurePosixPath(row['Destination'])).parts))
        info = host.stat()
        need(stat.S_ISREG(info.st_mode), 'EXISTING_DB_REGULAR_FILE_REQUIRED')
        keydir = self.c.path(self.key_directory, True)
        need(str(keydir).isascii() and all(32 <= ord(char) <= 126 and char != ',' for char in str(keydir)),
             'PRIVATE_BIND_PATH_DELIMITER_REFUSED')
        sources = [self.c.path(Path(item['Source'])) for item in mounts if item['Type'] in ('volume', 'bind') and
                   not (item['Source'] == str(keydir) and item['Destination'] == TARGET and item['RW'] is False)]
        public = self.public_roots + [self.r.cabinet, Path(self.r.frozen()['roots']['customer']), self.root]
        for source in sources + public:
            source = self.c.path(source)
            need(not keydir.is_relative_to(source) and not source.is_relative_to(keydir), 'PRIVATE_KEY_PATH_OVERLAPS_EXISTING_MOUNT_OR_PUBLIC_ROOT')
        parent = keydir.parent.stat()
        if os.name == 'posix':
            need(parent.st_uid == 0 and parent.st_mode & 0o022 == 0, 'PRIVATE_KEY_PARENT_NOT_TRUSTED')
        return {'containerPath': str(path), 'hostPath': str(host), 'deviceInode': [info.st_dev, info.st_ino],
                'keyDirectory': str(keydir), 'dataMount': row}

    def incremental_base(self):
        need(sha(self.c.read(self.incremental_path)) == self.incremental_sha, 'INCREMENTAL_RECEIPT_CHANGED')
        self.r.stable()
        snap = self.a.snapshot()
        old = self.incremental
        self.r.compare(snap, old['before'], old['after']['afterImages'], Path(old['overlay']), old['plannedConfigHash'])
        self.r.worker({'workerContainerId': old['workerProof']['containerId']})
        self.r.static_after(old)
        need(self.r.hashes(self.r.expected_hashes(True)) == self.r.expected_hashes(True), 'INCREMENTAL_SOURCE_READBACK_CHANGED')
        need(snap['selected']['content']['PALITRA_WEB_UPLOADS_ENABLED'] != 'true', 'MEDIA_UPLOADS_MUST_STAY_OFF')
        need(not self.flag(), 'PUSH_MUST_STILL_BE_OFF')
        return snap

    def capture(self):
        first_cid = self.cid()
        snapshot = self.incremental_base()
        mounts = self.mounts()
        need(not any(row['Destination'] == TARGET for row in mounts), 'EXISTING_PUSH_SECRET_MOUNT_REQUIRES_REVIEW')
        binding = self.binding(mounts)
        need(self.cid() == first_cid, 'CONTENT_RECREATED_DURING_CAPTURE')
        return {'snapshot': snapshot, 'contentContainerId': first_cid, 'mounts': mounts, 'binding': binding}

    def preflight(self, name):
        paths = self.paths(name)
        need(not any(path.exists() for path in paths.values()), 'ATTEMPT_ALREADY_EXISTS_NO_RETRY')
        started = self.now()
        facts = self.capture()
        image = facts['snapshot']['afterImages']['content']
        need(self.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image]).decode().strip() == image, 'CURRENT_LOCAL_IMAGE_REQUIRED')
        declared = self.c.obj(self.run(['docker', 'image', 'inspect', '--format', '{{json .Config.Volumes}}', image]))
        user = self.c.obj(self.run(['docker', 'image', 'inspect', '--format', '{{json .Config.User}}', image]))
        need(declared in (None, {}) and user in ('', '0', 'root'), 'TRUSTED_ROOT_IMAGE_WITHOUT_DECLARED_VOLUMES_REQUIRED')
        need(not Path(facts['binding']['keyDirectory']).exists(), 'EXISTING_KEYS_NEVER_REGENERATE_REVIEW_PRIVATE_RECEIPT')
        self.no_existing_encrypted_documents()
        self.a.lease()
        need(0 <= (self.now() - started).total_seconds() <= 600, 'NATIVE_PREFLIGHT_TOO_OLD')
        value = {'schema': 1, 'kind': 'PUSH_ENABLE_PREFLIGHT_NOT_APPROVAL', 'name': name,
                 'observedAtUtc': started.isoformat(), 'incrementalReceiptSha256': self.incremental_sha,
                 'manifestSha256': self.r.msha, 'facts': facts, 'pushEnabled': False, 'dbWrites': 0}
        self.c.create(paths['preflight'], value)
        return {'status': 'PUSH_PREFLIGHT_READY_KEYS_NOT_CREATED', 'preflightSha256': sha(self.c.read(paths['preflight'])),
                'contentImage': image, 'contentContainerId': facts['contentContainerId'], 'pushEnabled': False,
                'dbWrites': 0, 'workerRecreated': False}

    def receipt(self, name, preflight_sha):
        paths = self.paths(name)
        value = self.r.pin(paths['preflight'], preflight_sha)
        need(value.get('schema') == 1 and value.get('kind') == 'PUSH_ENABLE_PREFLIGHT_NOT_APPROVAL' and
             value.get('name') == name and value.get('incrementalReceiptSha256') == self.incremental_sha and
             value.get('manifestSha256') == self.r.msha, 'EXACT_PUSH_PREFLIGHT_REQUIRED')
        when = datetime.fromisoformat(value['observedAtUtc'].replace('Z', '+00:00'))
        need(when.tzinfo is not None and 0 <= (self.now() - when).total_seconds() <= 600, 'ROOT_PUSH_PREFLIGHT_STALE_OR_FUTURE')
        return paths, value

    def same_before(self, receipt):
        need(self.capture() == receipt['facts'], 'PUSH_PREFLIGHT_BASE_CHANGED')

    def no_existing_encrypted_documents(self):
        value = self.c.obj(self.run(['docker', 'exec', 'synapse-content-1', 'node', '-e', PUSH_COUNT_JS]))
        need(value == {'pushDocuments': 0, 'dbWrites': 0}, 'EXISTING_ENCRYPTED_PUSH_DOCUMENTS_NEED_ORIGINAL_KEY_NOT_REGENERATION')

    def private_meta(self, directory):
        directory = self.c.path(directory)
        info = directory.stat()
        need(stat.S_ISDIR(info.st_mode) and sorted(item.name for item in directory.iterdir()) == ['vapid.json'], 'ONLY_ONE_PRIVATE_KEY_FILE_REQUIRED')
        file = self.c.path(directory / 'vapid.json')
        value = file.stat()
        need(stat.S_ISREG(value.st_mode) and 100 <= value.st_size <= 2048, 'BOUNDED_PRIVATE_KEY_FILE_REQUIRED')
        if os.name == 'posix':
            need(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700 and value.st_uid == 0 and stat.S_IMODE(value.st_mode) == 0o600, 'ROOT_PRIVATE_MODES_REQUIRED')
        return {'directoryDeviceInode': [info.st_dev, info.st_ino], 'fileDeviceInode': [value.st_dev, value.st_ino],
                'fileSize': value.st_size, 'fileMtimeNs': value.st_mtime_ns}

    def key_command(self, image, directory, *, generate=False, name=None):
        # No volume inheritance, DB, network, arbitrary entrypoint or shell.
        args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--user', '0']
        if generate:
            args += ['--name', 'palitra-push-keys-' + name]
        mount = 'type=bind,source=' + str(directory) + ',target=' + TARGET + ('' if generate else ',readonly')
        args += ['--mount', mount, '--entrypoint', 'node', image]
        return args + (['/app/palitra-push-keys.cjs', 'generate', TARGET + '/' + PENDING_KEY] if generate else ['-e', KEY_JS])

    def publish_pending(self, directory):
        # CLI already fsynced and validated this complete private key. Publish
        # atomically without replacement or reading private key bytes in Python.
        need(sorted(item.name for item in directory.iterdir()) == [PENDING_KEY], 'ONLY_PENDING_PRIVATE_KEY_REQUIRED')
        pending = self.c.path(directory / PENDING_KEY)
        before = pending.stat()
        need(stat.S_ISREG(before.st_mode) and 100 <= before.st_size <= 2048, 'PENDING_KEY_REGULAR_BOUNDED_REQUIRED')
        if os.name == 'posix':
            need(before.st_uid == 0 and stat.S_IMODE(before.st_mode) == 0o600, 'PENDING_PRIVATE_MODE_REQUIRED')
        final = self.c.path(directory / 'vapid.json', True)
        need(not final.exists(), 'FINAL_KEY_EXISTS_NO_REPLACEMENT')
        os.link(pending, final, follow_symlinks=False)
        linked = final.lstat()
        need(stat.S_ISREG(linked.st_mode) and (linked.st_dev, linked.st_ino) == (before.st_dev, before.st_ino), 'ATOMIC_PRIVATE_KEY_LINK_CHANGED')
        if os.name == 'posix':
            fd = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
            try:
                os.fsync(fd)
                pending.unlink()
                os.fsync(fd)
            finally:
                os.close(fd)
        else:
            pending.unlink()  # Synthetic local tests only; native main is POSIX Root.

    def key_probe(self, image, directory):
        value = self.c.obj(self.run(self.key_command(image, directory)))
        need(set(value) == {'keyValid', 'publicKeySha256', 'webPushVersion', 'transportReady'} and
             value['keyValid'] is True and value['transportReady'] is True and value['webPushVersion'] == '3.6.7' and
             re.fullmatch(r'[0-9a-f]{64}', value['publicKeySha256']) is not None, 'ACCEPTED_KEY_LIBRARY_TRANSPORT_PROBE_REQUIRED')
        return value

    def create_keys(self, name, preflight_sha, *, apply=False):
        need(apply is True, 'EXPLICIT_ROOT_KEY_GENERATION_REQUIRED')
        paths, receipt = self.receipt(name, preflight_sha)
        need(not paths['keys'].exists() and not paths['journal'].exists(), 'KEY_ATTEMPT_EXISTS_NO_REGENERATION')
        self.same_before(receipt)
        self.no_existing_encrypted_documents()
        directory = self.c.path(Path(receipt['facts']['binding']['keyDirectory']), True)
        need(not directory.exists(), 'EXISTING_PRIVATE_DIRECTORY_NO_REGENERATION')
        image = receipt['facts']['snapshot']['afterImages']['content']
        state = {'schema': 1, 'phase': 'PUSH_KEY_GENERATION_STARTED_UNKNOWN', 'name': name,
                 'preflightSha256': preflight_sha, 'directory': str(directory), 'dbWrites': 0}
        self.c.create(paths['keys'], state)
        directory.mkdir(mode=0o700)
        self.same_before(receipt)
        need(not any(directory.iterdir()), 'PRIVATE_GENERATION_DIRECTORY_NO_LONGER_EMPTY')
        self.a.lease()
        self.receipt(name, preflight_sha)
        generated = self.c.obj(self.run(self.key_command(image, directory, generate=True, name=name)))
        need(set(generated) == {'status', 'publicKey'} and generated['status'] == 'SERVER_PRIVATE_KEYS_CREATED' and
             re.fullmatch(r'[A-Za-z0-9_-]{87}', generated['publicKey']) is not None, 'KEY_GENERATION_UNKNOWN_DO_NOT_REPEAT')
        public_sha = sha(generated['publicKey'].encode('ascii'))
        del generated
        self.publish_pending(directory)
        probe = self.key_probe(image, directory)
        need(probe['publicKeySha256'] == public_sha, 'KEY_PUBLIC_READBACK_MISMATCH')
        metadata = self.private_meta(directory)
        self.same_before(receipt)
        state.update(phase='PUSH_KEYS_CREATED_NOT_ENABLED', publicKeySha256=public_sha, keyMetadata=metadata)
        self.c.replace(paths['keys'], state)
        return {'status': state['phase'], 'keyReceiptSha256': sha(self.c.read(paths['keys'])), 'publicKeySha256': public_sha,
                'pushEnabled': False, 'dbWrites': 0, 'workerRecreated': False}

    def verified_keys(self, paths, receipt, key_sha):
        keys = self.r.pin(paths['keys'], key_sha)
        need(keys.get('phase') == 'PUSH_KEYS_CREATED_NOT_ENABLED' and keys.get('preflightSha256') == sha(self.c.read(paths['preflight'])) and
             keys.get('directory') == receipt['facts']['binding']['keyDirectory'], 'EXACT_KEY_RECEIPT_REQUIRED')
        directory = Path(keys['directory'])
        need(self.private_meta(directory) == keys['keyMetadata'], 'PERMANENT_KEY_METADATA_CHANGED')
        probe = self.key_probe(receipt['facts']['snapshot']['afterImages']['content'], directory)
        need(probe['publicKeySha256'] == keys['publicKeySha256'], 'PERMANENT_KEY_IDENTITY_CHANGED')
        return keys

    def after(self, before, overlay, planned, keys, *, enabled):
        self.r.stable()
        need(sha(self.c.read(self.incremental_path)) == self.incremental_sha, 'INCREMENTAL_RECEIPT_CHANGED')
        actual = self.a.snapshot()
        self.r.compare(actual, before['snapshot'], before['snapshot']['afterImages'], overlay, planned)
        self.r.worker({'workerContainerId': self.incremental['workerProof']['containerId']})
        self.r.static_after(self.incremental)
        need(self.r.hashes(self.r.expected_hashes(True)) == self.r.expected_hashes(True), 'ACTIVE_CODE_CHANGED')
        need(self.flag() is enabled, 'EXACT_PUSH_FLAG_READBACK_FAILED')
        expected_mounts = sorted(before['mounts'] + [{'Type': 'bind', 'Source': keys['directory'], 'Destination': TARGET, 'RW': False}], key=lambda row: row['Destination'])
        need(self.mounts() == expected_mounts, 'ONLY_PRIVATE_RO_MOUNT_ADDITION_ALLOWED')
        need(self.binding(self.mounts()) == before['binding'], 'PERSISTENT_DATABASE_BINDING_CHANGED')
        need(self.private_meta(Path(keys['directory'])) == keys['keyMetadata'], 'PERMANENT_PRIVATE_KEY_CHANGED')
        if enabled:
            probe = self.c.obj(self.run(['docker', 'exec', 'synapse-content-1', 'node', '-e', KEY_JS]))
            need(probe == self.key_probe(actual['afterImages']['content'], Path(keys['directory'])) and
                 probe['publicKeySha256'] == keys['publicKeySha256'], 'ACTIVE_KEY_LIBRARY_PROBE_FAILED')
        health = self.c.obj(self.run(['docker', 'exec', 'synapse-content-1', 'node', '-e', HEALTH_JS]))
        need(health == {'status': 200, 'ok': True, 'service': 'content'}, 'ACTUAL_CONTENT_HEALTH_FAILED')
        return actual

    def enable(self, name, preflight_sha, key_sha, *, apply=False):
        need(apply is True, 'EXPLICIT_ROOT_PUSH_ENABLE_REQUIRED')
        paths, receipt = self.receipt(name, preflight_sha)
        need(not paths['journal'].exists() and not paths['overlay'].exists() and not paths['rollback-overlay'].exists(), 'PUSH_ATTEMPT_EXISTS_NO_RETRY')
        self.same_before(receipt)
        keys = self.verified_keys(paths, receipt, key_sha)
        before = receipt['facts']
        value = {'services': {'content': {'image': before['snapshot']['afterImages']['content'],
                 'environment': {'PALITRA_WEB_PUSH_ENABLED': 'true'},
                 'volumes': [{'type': 'bind', 'source': keys['directory'], 'target': TARGET,
                              'read_only': True, 'bind': {'create_host_path': False}}]}}}
        self.c.create(paths['overlay'], value)
        overlay_sha = sha(self.c.read(paths['overlay']))
        planned = self.r.plan_hash(before['snapshot'], paths['overlay'])
        state = {'schema': 1, 'phase': 'PUSH_CONTENT_UP_STARTED_UNKNOWN', 'name': name,
                 'preflightSha256': preflight_sha, 'keyReceiptSha256': key_sha, 'before': before,
                 'overlay': str(paths['overlay']), 'overlaySha256': overlay_sha, 'plannedConfigHash': planned,
                 'workerRecreated': False, 'dbWrites': 0}
        self.c.create(paths['journal'], state)
        self.same_before(receipt)
        self.verified_keys(paths, receipt, key_sha)
        need(sha(self.c.read(paths['overlay'])) == overlay_sha, 'PUSH_OVERLAY_CHANGED_BEFORE_UP')
        self.a.lease()
        self.receipt(name, preflight_sha)
        self.run(self.r.command(before['snapshot'], paths['overlay'], ['up', '--detach', '--no-build', '--pull', 'never', '--no-deps', 'content']))
        actual = self.after(before, paths['overlay'], planned, keys, enabled=True)
        need(self.cid() != before['contentContainerId'], 'ACTUAL_CONTENT_RECREATION_EXPECTED')
        state.update(phase='PUSH_SERVER_CONFIG_APPLIED_NOT_DEVICE_PROOF', after=actual, contentContainerId=self.cid(),
                     publicKeySha256=keys['publicKeySha256'])
        self.c.replace(paths['journal'], state)
        return {'status': state['phase'], 'journalSha256': sha(self.c.read(paths['journal'])), 'pushEnabled': True,
                'publicKeySha256': keys['publicKeySha256'], 'workerRecreated': False, 'dbWrites': 0,
                'authenticatedCapabilityVerified': False, 'deviceDeliveryVerified': False}

    def rollback(self, name, journal_sha, *, apply=False):
        need(apply is True, 'EXPLICIT_ROOT_PUSH_DISABLE_REQUIRED')
        paths = self.paths(name)
        state = self.r.pin(paths['journal'], journal_sha)
        need(state.get('phase') == 'PUSH_SERVER_CONFIG_APPLIED_NOT_DEVICE_PROOF', 'COMPLETED_PUSH_RECEIPT_REQUIRED')
        receipt = self.r.pin(paths['preflight'], state['preflightSha256'])
        keys = self.verified_keys(paths, receipt, state['keyReceiptSha256'])
        need(sha(self.c.read(paths['overlay'])) == state['overlaySha256'], 'APPLIED_PUSH_OVERLAY_CHANGED')
        current = self.after(state['before'], paths['overlay'], state['plannedConfigHash'], keys, enabled=True)
        need(self.cid() == state['contentContainerId'], 'CURRENT_PUSH_CONTENT_RECREATED_REVIEW_REQUIRED')
        self.c.create(paths['rollback-overlay'], {'services': {'content': {'image': current['afterImages']['content'],
                       'environment': {'PALITRA_WEB_PUSH_ENABLED': 'false'}}}})
        pin = sha(self.c.read(paths['rollback-overlay']))
        planned = self.r.plan_hash(current, paths['rollback-overlay'])
        state.update(phase='PUSH_DISABLE_STARTED_UNKNOWN', rollbackOverlaySha256=pin)
        self.c.replace(paths['journal'], state)
        self.after(state['before'], paths['overlay'], state['plannedConfigHash'], keys, enabled=True)
        need(sha(self.c.read(paths['rollback-overlay'])) == pin, 'PUSH_DISABLE_OVERLAY_CHANGED')
        self.a.lease()
        self.run(self.r.command(current, paths['rollback-overlay'], ['up', '--detach', '--no-build', '--pull', 'never', '--no-deps', 'content']))
        # Compare against the previous content chain, but preserve the original data mounts.
        disable_base = {**state['before'], 'snapshot': current}
        after = self.after(disable_base, paths['rollback-overlay'], planned, keys, enabled=False)
        state.update(phase='PUSH_DISABLED_KEYS_AND_DATA_PRESERVED', afterDisable=after)
        self.c.replace(paths['journal'], state)
        return {'status': state['phase'], 'journalSha256': sha(self.c.read(paths['journal'])), 'pushEnabled': False,
                'workerRecreated': False, 'dbRestore': False, 'privateKeysPreserved': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['preflight', 'create-keys', 'enable', 'rollback'])
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--incremental-name', required=True)
    parser.add_argument('--incremental-receipt-sha', required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--preflight-sha')
    parser.add_argument('--key-receipt-sha')
    parser.add_argument('--journal-sha')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        need(os.name == 'posix' and os.geteuid() == 0, 'NATIVE_ROOT_ONLY')
        inc, core = loaded_incremental()
        release = inc.Release(core, args.bundle, MANIFEST_SHA)
        engine = PushEnable(release, args.incremental_name, args.incremental_receipt_sha)
        if args.operation == 'preflight':
            need(not args.apply, 'PREFLIGHT_IS_READONLY')
            result = engine.preflight(args.name)
        elif args.operation == 'create-keys':
            result = engine.create_keys(args.name, args.preflight_sha, apply=args.apply)
        elif args.operation == 'enable':
            result = engine.enable(args.name, args.preflight_sha, args.key_receipt_sha, apply=args.apply)
        else:
            result = engine.rollback(args.name, args.journal_sha, apply=args.apply)
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except BaseException as error:
        code = str(error)
        code = code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,100}', code) else 'ACCEPTED_GUARD_REFUSED'
        print(json.dumps({'status': 'REFUSED_UNKNOWN_DO_NOT_RETRY', 'operation': args.operation, 'code': code,
                          'automaticRetry': False, 'dbRestore': False}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
