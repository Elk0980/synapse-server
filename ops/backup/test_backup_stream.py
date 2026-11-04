"""Синтетические проверки stream-v1. Реальные ключи/SSH/данные не используются.

Linux FIFO и quota проверяются отдельно от portable protocol. Криптография в
положительных crypto-тестах всегда настоящий age, с одноразовой fixture identity.
"""
import contextlib
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import backup_v2 as b
import backup_stream as s

AGE = shutil.which('age')
KEYGEN = shutil.which('age-keygen')
LINUX = sys.platform.startswith('linux')


class StreamTests(unittest.TestCase):
    def setUp(self):
        parent = os.environ.get('SYNAPSE_BACKUP_TEST_TEMP')
        self.temporary = tempfile.TemporaryDirectory(prefix='stream-fixture-', dir=parent)
        self.root = Path(self.temporary.name).resolve()
        if parent:
            self.assertTrue(self.root.is_relative_to(Path(parent).resolve()))
        self.addCleanup(self.temporary.cleanup)
        self.dest = self.root / 'D'
        self.dest.mkdir()
        self.temp = self.root / 'private-temp'
        self.temp.mkdir()
        self.name = 'synapse-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        self.c = {'transport': s.TRANSPORT, 'destination': str(self.dest),
                  'identity': str(self.root / 'fixture-identity'),
                  'verify_temp_dir': str(self.temp), 'max_bundle_bytes': 4 * 1024**2,
                  'max_restore_bytes': 8 * 1024**2, 'stream_offer_wait_seconds': .15,
                  'stream_receipt_wait_seconds': .15}
        self.payload = {b.FILES[0]: b'cipher-fixture-data', b.FILES[1]: b'cipher-fixture-images'}
        self.receipt = self.make_receipt()
        self.offer = {'schema': 1, 'transport': s.TRANSPORT, 'id': self.name,
                      'state': 'OFFERED', 'expires_at': time.time() + 30,
                      'max_total_bytes': self.c['max_bundle_bytes'],
                      'files': {f: {'state': 'WAITING'} for f in b.FILES}}
        self.calls = []

    def make_receipt(self):
        return {'schema': 2, 'transport': s.TRANSPORT, 'id': self.name,
                'restore_bytes': 2 * 1024**2,
                'files': {f: {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
                          for f, data in self.payload.items()}}

    def remote(self, c, command):
        self.calls.append(command)
        if command == 'list':
            return [self.name]
        if command == f'get {self.name} {s.META}':
            return self.offer
        if command == f'get {self.name} receipt.json':
            return self.receipt
        self.fail('Unexpected metadata command')

    def receive(self, c, command, target, maximum, timeout):
        self.calls.append(command)
        data = self.payload[command.split()[-1]]
        self.assertLessEqual(len(data), maximum)
        target.write(data)
        return 0

    def download(self, remote=None, receive=None):
        with patch.object(s, 'remote_json', side_effect=remote or self.remote), \
             patch.object(s, 'ssh_receive', side_effect=receive or self.receive):
            return s.download(self.c, self.dest)

    def test_producer_refuses_unreviewed_inventory_before_any_output(self):
        c = dict(self.c, output=str(self.root / 'not-created'), reviewed_inventory=False)
        with self.assertRaises(s.ConfigurationError):
            s.produce(c)
        self.assertFalse((self.root / 'not-created').exists())

    def test_linux_ci_requires_real_crypto_tools(self):
        if LINUX and os.environ.get('CI'):
            self.assertTrue(AGE and KEYGEN, 'Linux CI must install actual age and age-keygen')

    def test_offer_has_no_final_sha_and_download_stages_without_promotion(self):
        staged, receipt = self.download()
        self.assertEqual(staged, self.dest / '.stream-partials' / self.name)
        self.assertFalse((self.dest / self.name).exists())
        self.assertEqual(b.validate_bundle(staged), receipt)
        self.assertNotIn('sha256', json.dumps(self.offer))
        self.assertEqual(self.calls.count(f'get {self.name} receipt.json'), 1)
        self.assertNotIn('result', receipt)

    def test_completed_stage_reconciles_without_reopening_consumed_fifo(self):
        staged, _ = self.download()
        self.calls.clear()
        with patch.object(s, 'remote_json', side_effect=AssertionError('No stream replay')), \
             patch.object(s, 'ssh_receive', side_effect=AssertionError('No stream replay')):
            same, _ = s.download(self.c, self.dest)
        self.assertEqual(same, staged)
        self.assertEqual(self.calls, [])

    def test_unknown_transport_exit_with_full_bytes_requires_final_receipt(self):
        def unknown(c, command, target, maximum, timeout):
            self.receive(c, command, target, maximum, timeout)
            self.offer['files'][command.split()[-1]]['state'] = 'DONE'
            return 255
        staged, _ = self.download(receive=unknown)
        self.assertEqual(b.validate_bundle(staged), self.receipt)
        self.assertFalse((self.dest / self.name).exists())

    def test_stale_complete_stage_does_not_hide_fresh_offer(self):
        old = 'synapse-' + (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)).strftime('%Y%m%dT%H%M%SZ')
        stage = self.dest / '.stream-partials' / old
        stage.mkdir(parents=True)
        receipt = dict(self.receipt, id=old)
        for name, data in self.payload.items():
            (stage / name).write_bytes(data)
        (stage / 'receipt.json').write_text(json.dumps(receipt))
        selected, _ = self.download()
        self.assertEqual(selected.name, self.name)
        self.assertIn('list', self.calls)
        self.assertEqual(b.validate_bundle(stage), receipt)
        future = 'synapse-' + (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=2)).strftime('%Y%m%dT%H%M%SZ')
        self.assertFalse(s.fresh_id(future))

    def test_interrupted_partial_is_not_appended_or_replayed(self):
        def broken(c, command, target, maximum, timeout):
            target.write(b'partial')
            return 255
        with self.assertRaisesRegex(b.BackupError, 'STREAM_NEW_SESSION_REQUIRED'):
            self.download(receive=broken)
        self.assertFalse((self.dest / self.name).exists())
        self.calls.clear()
        with self.assertRaisesRegex(b.BackupError, 'STREAM_NEW_SESSION_REQUIRED'):
            self.download()
        self.assertFalse(any(x.endswith(tuple(b.FILES)) for x in self.calls))

    def test_final_receipt_mismatch_or_aggregate_bound_never_promotes(self):
        self.receipt['files'][b.FILES[0]]['sha256'] = '0' * 64
        with self.assertRaisesRegex(b.BackupError, 'BAD_SHA'):
            self.download()
        self.assertFalse((self.dest / self.name).exists())
        for changed in [('id', 'synapse-19990101T000000Z'), ('transport', 'other')]:
            value = self.make_receipt()
            value[changed[0]] = changed[1]
            with self.assertRaisesRegex(b.BackupError, 'BAD_RECEIPT'):
                s._validate_receipt(value, self.name, self.c['max_bundle_bytes'])
        with self.assertRaisesRegex(b.BackupError, 'BAD_RECEIPT'):
            s._validate_receipt(self.make_receipt(), self.name, 20)

    def test_private_identity_and_temp_must_be_outside_entire_destination(self):
        for key, error in [('identity', 'IDENTITY_MUST_BE_OUTSIDE_BACKUPS'),
                           ('verify_temp_dir', 'TEMP_MUST_BE_OUTSIDE_BACKUPS')]:
            with self.subTest(key=key):
                c = dict(self.c, **{key: str(self.dest / 'unrelated-subdir')})
                with self.assertRaisesRegex(b.BackupError, error):
                    s.download(c, self.dest)
        self.assertEqual(self.calls, [])

    def test_promote_requires_valid_owned_stage_and_never_overwrites(self):
        staged, _ = self.download()
        final = s.promote(self.c, self.dest, staged)
        self.assertEqual(final, self.dest / self.name)
        self.assertFalse(staged.exists())
        self.assertEqual(b.validate_bundle(final), self.receipt)
        other = self.root / 'outside' / self.name
        other.mkdir(parents=True)
        with self.assertRaisesRegex(b.BackupError, 'UNSAFE_DESTINATION'):
            s.promote(self.c, self.dest, other)

    def test_partial_housekeeping_preserves_fresh_and_rejects_foreign_paths(self):
        stage = s._local_root(self.dest)
        stale = stage / 'synapse-20000101T000000Z'
        fresh = stage / self.name
        stale.mkdir(); fresh.mkdir()
        (stale / 'own.partial').write_bytes(b'fixture')
        os.utime(stale, (1, 1))
        s.cleanup_local(self.dest)
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())
        (stage / 'foreign').mkdir()
        with self.assertRaisesRegex(b.BackupError, 'UNSAFE_DESTINATION'):
            s.cleanup_local(self.dest)
        self.assertTrue((stage / 'foreign').exists())

    def test_bounded_owned_ssh_stdout_and_strict_host_options(self):
        start = s.Children.start
        seen = []
        def child(owner, args, **kwargs):
            seen.append(args)
            return start(owner, [sys.executable, '-c', 'import os;os.write(1,b"x"*20000)'], **kwargs)
        c = dict(self.c, host='synthetic.invalid', ssh_key='fixture-only', known_hosts='fixture-hosts')
        out = io.BytesIO()
        with patch.object(s.Children, 'start', new=child):
            with self.assertRaisesRegex(b.BackupError, 'BAD_RECEIPT'):
                s.ssh_receive(c, 'get fixture stream.json', out, 100, 3)
        self.assertLessEqual(len(out.getvalue()), 100)
        self.assertIn('-oStrictHostKeyChecking=yes', seen[0])
        self.assertIn('-oIdentitiesOnly=yes', seen[0])
        self.assertNotIn('shell=True', seen[0])

    def test_pull_verification_failure_keeps_stage_and_never_acknowledges(self):
        staged, _ = self.download()
        reported = []
        with patch.object(b, 'download', return_value=(staged, self.receipt)), \
             patch.object(b, 'weekly_verify', side_effect=b.BackupError('BAD_SHA')), \
             patch.object(s, 'promote', side_effect=AssertionError('No promotion before verify')), \
             patch.object(b.board_report, 'publish', side_effect=lambda c,r,status: reported.append(dict(status)) or True):
            with self.assertRaisesRegex(b.BackupError, 'BAD_SHA'):
                b.pull(self.c)
        self.assertTrue(staged.exists())
        self.assertFalse((self.dest / self.name).exists())
        self.assertEqual(reported[-1]['result'], 'ERROR')
        self.assertEqual(reported[-1]['verified_at'], 0)

    def test_pull_verifies_then_promotes_and_board_pending_does_not_restream(self):
        staged, _ = self.download()
        order = []
        promote = s.promote
        def promoted(c, root, source):
            order.append('promote')
            return promote(c, root, source)
        with patch.object(b, 'download', return_value=(staged, self.receipt)) as download, \
             patch.object(b, 'weekly_verify', side_effect=lambda *a: order.append('verify')), \
             patch.object(s, 'promote', side_effect=promoted), \
             patch.object(b.board_report, 'publish', return_value=False):
            with self.assertRaisesRegex(b.BackupError, 'BOARD_REPORT_PENDING'):
                b.pull(self.c)
        self.assertEqual(order, ['verify', 'promote'])
        download.assert_called_once()
        self.assertTrue((self.dest / self.name).is_dir())

    @unittest.skipUnless(AGE and KEYGEN, 'Requires actual age and age-keygen')
    def test_real_age_stream_download_restore_old_wal_data_and_tamper(self):
        identity = Path(self.c['identity'])
        subprocess.run([KEYGEN, '-o', str(identity)], check=True, capture_output=True)
        recipient = subprocess.run([KEYGEN, '-y', str(identity)], check=True, capture_output=True, text=True).stdout.strip()
        self.c.update(age=AGE, recipient=recipient)
        source = self.root / 'wal-db'
        sealed = self.root / 'sealed-db'
        with contextlib.closing(sqlite3.connect(source)) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY,body TEXT,attachment BLOB,draft TEXT,consent INTEGER)')
            db.execute('INSERT INTO messages VALUES(4,?,?,?,1)', ('старое сообщение', b'attachment', 'черновик'))
            db.commit()
            b.snapshot(source, sealed)
        content = sealed.read_bytes()
        manifest = {'schema': 2, 'files': {'rootfs/data.sqlite': hashlib.sha256(content).hexdigest()}, 'sqlite': ['rootfs/data.sqlite']}
        def data(pipe):
            with tarfile.open(fileobj=pipe, mode='w|gz') as tar:
                for name, raw in [('rootfs/data.sqlite', content), ('manifest.json', json.dumps(manifest).encode())]:
                    info = tarfile.TarInfo(name); info.size = len(raw); info.mode = 0o600
                    tar.addfile(info, io.BytesIO(raw))
        def images(pipe):
            with tarfile.open(fileobj=pipe, mode='w|') as tar:
                info = tarfile.TarInfo('manifest.json'); info.size = 2
                tar.addfile(info, io.BytesIO(b'[]'))
        for filename, producer in zip(b.FILES, [data, images]):
            encrypted = self.root / filename
            b.encrypt(self.c, encrypted, producer)
            self.payload[filename] = encrypted.read_bytes()
        self.receipt = self.make_receipt()
        staged, _ = self.download()
        b.restore(self.c, staged, self.root / 'restored')
        with contextlib.closing(sqlite3.connect(self.root / 'restored/rootfs/data.sqlite')) as db:
            self.assertEqual(db.execute('SELECT * FROM messages').fetchall(), [(4, 'старое сообщение', b'attachment', 'черновик', 1)])
        self.assertEqual(list(self.temp.iterdir()), [])
        corrupt = staged / b.FILES[0]
        raw = bytearray(corrupt.read_bytes()); raw[-1] ^= 1; corrupt.write_bytes(raw)
        receipt = json.loads((staged / 'receipt.json').read_text())
        receipt['files'][b.FILES[0]] = {'bytes': len(raw), 'sha256': b.sha(corrupt)}
        b.write_json(staged / 'receipt.json', receipt)
        with self.assertRaises(ValueError):
            b.restore(self.c, staged, self.root / 'unauthenticated')
        self.assertFalse((self.root / 'unauthenticated').exists())
        self.assertEqual(list(self.temp.iterdir()), [])


@unittest.skipUnless(LINUX, 'Real FIFO/Linux metadata/quotas are mandatory in Linux CI')
class LinuxStreamTests(unittest.TestCase):
    setUp = StreamTests.setUp
    make_receipt = StreamTests.make_receipt

    # Только UID metadata заменена для непривилегированного CI. Тип, inode,
    # symlink, mode, nlink и реальные FIFO остаются настоящими.
    def fixture_entry(self, path, kind='file'):
        path = s.checked_path(path)
        self.assertTrue(path.is_relative_to(self.root))
        info = path.lstat()
        expected = {'file': stat.S_ISREG, 'directory': stat.S_ISDIR, 'fifo': stat.S_ISFIFO}[kind]
        if not expected(info.st_mode) or info.st_mode & 0o027 or kind != 'directory' and info.st_nlink != 1:
            raise s.ConfigurationError('UNSAFE_DESTINATION')
        return info

    def fifo(self):
        fifo = self.root / 'cipher.fifo'
        os.mkfifo(fifo, 0o640); fifo.chmod(0o640)
        return fifo

    def test_parent_symlink_swap_cannot_export_outside_file(self):
        source, outside, scratch = self.root/'source', self.root/'outside', self.root/'scratch'
        source.mkdir(); outside.mkdir(); scratch.mkdir()
        original = source/'file'
        original.write_bytes(b'allowed fixture')
        secret = b'outside fixture must never enter the archive'
        (outside/'file').write_bytes(secret)
        inv = {'roots':[source], 'entries':[original], 'databases':set(), 'max_snapshot':1024**2, 'metadata':[]}
        source.rename(self.root/'original-source')
        source.symlink_to(outside, target_is_directory=True)
        archive = io.BytesIO()
        with self.assertRaises((OSError, b.BackupError)):
            s._data_producer(self.c, inv, scratch, s.Children(), time.monotonic()+2, self.name)(archive)
        self.assertNotIn(secret, archive.getvalue())
        self.assertEqual(list(scratch.iterdir()), [])

    def test_sqlite_binding_rejects_swapped_parent_before_export(self):
        source, outside = self.root/'source', self.root/'outside'
        source.mkdir(); outside.mkdir()
        for directory in [source, outside]:
            with contextlib.closing(sqlite3.connect(directory/'data.sqlite')) as db:
                db.execute('CREATE TABLE old_messages(body)'); db.commit()
        binding = s.SQLiteSourceBinding(source/'data.sqlite', self.root/'snapshot.sqlite')
        try:
            source.rename(self.root/'original-source')
            source.symlink_to(outside, target_is_directory=True)
            with contextlib.closing(sqlite3.connect('file:'+str(source/'data.sqlite')+'?mode=ro', uri=True)):
                with self.assertRaisesRegex(b.BackupError, 'SOURCE_CHANGED'):
                    binding.verify(1024**2)
            self.assertFalse((self.root/'snapshot.sqlite').exists())
        finally:
            binding.close()

    def test_fifo_no_reader_deadline_opens_no_child(self):
        owned = s.Children()
        with patch.object(s, 'root_entry', side_effect=self.fixture_entry):
            with self.assertRaisesRegex(b.BackupError, 'STREAM_TIMEOUT'):
                s.stream_cipher(dict(self.c, stream_reader_wait_seconds=.1), self.fifo(), lambda p: None, time.monotonic()+.2, children=owned)
        self.assertEqual(owned.items, [])

    @unittest.skipUnless(AGE and KEYGEN, 'Requires actual age and age-keygen')
    def test_real_fifo_age_cipher_hash_and_no_server_regular_archive(self):
        identity = self.root / 'fixture-identity'
        subprocess.run([KEYGEN, '-o', str(identity)], check=True, capture_output=True)
        recipient = subprocess.run([KEYGEN, '-y', str(identity)], check=True, capture_output=True, text=True).stdout.strip()
        fifo = self.fifo(); received = []
        def reader():
            with fifo.open('rb') as stream:
                received.append(stream.read())
        thread = threading.Thread(target=reader, daemon=True); thread.start()
        c = dict(self.c, age=AGE, recipient=recipient, _remaining_cipher_bytes=1024**2, stream_reader_wait_seconds=1)
        owned = s.Children()
        with patch.object(s, 'root_entry', side_effect=self.fixture_entry):
            result = s.stream_cipher(c, fifo, lambda pipe: pipe.write(b'private fixture'), time.monotonic()+5, children=owned)
        thread.join(2); self.assertFalse(thread.is_alive())
        self.assertEqual(result, {'bytes':len(received[0]), 'sha256':hashlib.sha256(received[0]).hexdigest()})
        self.assertTrue(stat.S_ISFIFO(fifo.stat().st_mode))
        plain = subprocess.run([AGE, '-d', '-i', str(identity)], input=received[0], check=True, capture_output=True).stdout
        self.assertEqual(plain, b'private fixture')
        self.assertTrue(all(p.poll() is not None for p in owned.items))
        self.assertFalse(any((self.root / f).exists() for f in b.FILES))

    @unittest.skipUnless(AGE and KEYGEN, 'Requires actual age and age-keygen')
    def test_fifo_disconnect_or_producer_error_reaps_only_owned_children(self):
        identity = self.root / 'fixture-identity'
        subprocess.run([KEYGEN, '-o', str(identity)], check=True, capture_output=True)
        recipient = subprocess.run([KEYGEN, '-y', str(identity)], check=True, capture_output=True, text=True).stdout.strip()
        c = dict(self.c, age=AGE, recipient=recipient, _remaining_cipher_bytes=4*1024**2,
                 stream_reader_wait_seconds=1, stream_stall_seconds=.2)
        for mode in ['disconnect', 'producer-error']:
            with self.subTest(mode=mode):
                fifo = self.root / (mode+'.fifo'); os.mkfifo(fifo, 0o640); fifo.chmod(0o640)
                def reader():
                    with fifo.open('rb', buffering=0) as stream:
                        stream.read(1) if mode == 'disconnect' else stream.read()
                thread = threading.Thread(target=reader, daemon=True); thread.start()
                owned = s.Children()
                def producer(pipe):
                    if mode == 'producer-error':
                        raise RuntimeError('synthetic-producer-failed')
                    pipe.write(os.urandom(2*1024**2))
                with patch.object(s, 'root_entry', side_effect=self.fixture_entry):
                    with self.assertRaises((BrokenPipeError, b.BackupError, RuntimeError, OSError)):
                        s.stream_cipher(c, fifo, producer, time.monotonic()+3, children=owned)
                thread.join(2); self.assertFalse(thread.is_alive())
                self.assertTrue(all(proc.poll() is not None for proc in owned.items))
                self.assertFalse((self.root / 'receipt.json').exists())

    def test_pipe_backpressure_stall_is_bounded(self):
        read_fd, write_fd = os.pipe()
        try:
            os.set_blocking(write_fd, False)
            started = time.monotonic()
            with self.assertRaisesRegex(b.BackupError, 'STREAM_STALLED'):
                s._write_all(write_fd, b'x'*(2*1024**2), time.monotonic()+2, .1)
            self.assertLess(time.monotonic()-started, 1.5)
        finally:
            os.close(write_fd); os.close(read_fd)

    def test_real_vacuum_worker_snapshot_and_hard_size_refusal(self):
        source = self.root / 'source.sqlite'
        with contextlib.closing(sqlite3.connect(source)) as db:
            db.execute('CREATE TABLE messages(body BLOB)')
            db.execute('INSERT INTO messages VALUES(?)', (b'fixture'*2000,)); db.commit()
        if os.geteuid() == 0:
            prefix=[]
        elif shutil.which('sudo'):
            prefix=[shutil.which('sudo'), '-n']
            result=subprocess.run(prefix+['true'], capture_output=True, timeout=5)
            if result.returncode:
                if os.environ.get('CI'):self.fail('Linux CI requires fixture-only sudo for real quota worker')
                self.skipTest('No fixture-only passwordless sudo')
        else:
            if os.environ.get('CI'):self.fail('Linux CI requires root or sudo for real quota worker')
            self.skipTest('No fixture-only root worker capability')
        for target,maximum,ok in [(self.root/'snapshot.sqlite',1024**2,True),
                                  (self.root/'too-small.sqlite',4096,False)]:
            # Жёстко только два дочерних пути ЭТОЙ временной fixture, не production.
            self.assertEqual(target.parent,self.root)
            self.assertEqual(source.parent,self.root)
            args=prefix+[sys.executable,str(Path(s.__file__).resolve()),'_snapshot',str(source),str(target),
                         str(maximum),'0',str(time.monotonic()+5)]
            result=subprocess.run(args,capture_output=True,timeout=8)
            self.assertEqual(result.returncode==0,ok)
            if target.exists():
                self.assertLessEqual(target.stat().st_size,maximum)
            if ok:
                self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o600)
            self.assertTrue(source.exists())

    def test_consumer_lock_refuses_second_get_before_fifo_open(self):
        directory = self.root / self.name; directory.mkdir(mode=0o750)
        lockpath = directory / ('.'+b.FILES[0]+'.lock'); lockpath.write_bytes(b''); lockpath.chmod(0o640)
        offer = dict(self.offer)
        with lockpath.open('rb') as lease, patch.object(s, 'root_entry', side_effect=self.fixture_entry), \
             patch.object(s, '_reader_state', return_value=offer):
            s._fcntl.flock(lease, s._fcntl.LOCK_EX | s._fcntl.LOCK_NB)
            with self.assertRaisesRegex(b.BackupError, 'STREAM_CONSUMER_BUSY'):
                s.read_fifo(self.c, directory, b.FILES[0], io.BytesIO())

    def test_only_list_get_no_shell_raw_path_ack_delete_or_traversal(self):
        output = self.root / 'reader'; output.mkdir(mode=0o750)
        marker = output / s.MARKER
        marker.write_text(json.dumps({'schema':1, 'transport':s.TRANSPORT})); marker.chmod(0o640)
        for command in ['sh', 'sudo true', 'put x', 'ack x', 'delete x', 'get /etc/passwd stream.json',
                        f'get {self.name} ../../source', f'get {self.name} raw.sqlite']:
            with self.subTest(command=command), patch.object(s, 'root_entry', side_effect=self.fixture_entry), \
                 patch.dict(os.environ, SSH_ORIGINAL_COMMAND=command):
                with self.assertRaises((ValueError, OSError)):
                    s.serve({'output':str(output)})

    def test_two_sqlite_files_use_one_snapshot_then_remove_and_skip_wal(self):
        deploy, scratch = self.root/'deploy', self.root/'scratch'
        deploy.mkdir(); scratch.mkdir(mode=0o700)
        databases=[]
        for index in range(2):
            dbpath=deploy/('db'+str(index))
            with contextlib.closing(sqlite3.connect(dbpath)) as db:
                db.execute('CREATE TABLE messages(body)'); db.execute('INSERT INTO messages VALUES(?)', ('old'+str(index),)); db.commit()
            databases.append(dbpath)
            Path(str(dbpath)+'-wal').write_bytes(b'excluded-sidecar')
        inv={'roots':[deploy], 'entries':sorted(deploy.iterdir()), 'databases':set(databases), 'max_snapshot':1024**2, 'metadata':[]}
        counts=[]
        def snapshot(source,target,maximum,margin,deadline,children):
            self.assertEqual(list(scratch.iterdir()), [])
            b.snapshot(source,target)
            counts.append(len(list(scratch.iterdir())))
        data=io.BytesIO()
        with patch.object(s, 'snapshot_one', side_effect=snapshot):
            s._data_producer(self.c, inv, scratch, s.Children(), time.monotonic()+5, self.name)(data)
        self.assertEqual(counts,[1,1]); self.assertEqual(list(scratch.iterdir()),[])
        data.seek(0)
        with tarfile.open(fileobj=data) as archive:
            self.assertFalse(any(name.endswith('-wal') for name in archive.getnames()))
            manifest=json.load(archive.extractfile('manifest.json'))
            self.assertEqual(len(manifest['sqlite']),2)

    def test_fresh_file_catalogue_includes_attachment_committed_after_offer(self):
        deploy, scratch = self.root/'deploy', self.root/'scratch'
        deploy.mkdir(); scratch.mkdir()
        source = deploy/'messages.sqlite'
        with contextlib.closing(sqlite3.connect(source)) as db:
            db.execute('CREATE TABLE attachments(path)'); db.commit()
        # The offer catalogued only the DB. The PC was then offline while an
        # attachment and its committed reference were created.
        inv = {'roots':[deploy], 'entries':[source], 'databases':{source},
               'max_snapshot':1024**2, 'metadata':[], 'images':[],
               'bound':4*1024**2, 'raw_bytes':source.stat().st_size}
        attachment = deploy/'new-attachment.bin'
        attachment.write_bytes(b'attachment committed while PC offline')
        with contextlib.closing(sqlite3.connect(source)) as db:
            db.execute('INSERT INTO attachments VALUES(?)', (attachment.name,)); db.commit()
        sequence = []
        def snapshot(original, target, maximum, margin, deadline, children):
            self.assertEqual(list(scratch.iterdir()), [])
            sequence.append('sqlite')
            b.snapshot(original, target)
        def refresh():
            self.assertEqual(sequence, ['sqlite'])
            self.assertEqual(list(scratch.iterdir()), [])
            sequence.append('files')
            return dict(inv, entries=sorted(deploy.iterdir()),
                        raw_bytes=sum(p.stat().st_size for p in deploy.iterdir()))
        data = io.BytesIO()
        with patch.object(s, 'snapshot_one', side_effect=snapshot):
            s._data_producer(self.c, inv, scratch, s.Children(), time.monotonic()+5,
                             self.name, refresh=refresh)(data)
        self.assertEqual(sequence, ['sqlite', 'files'])
        data.seek(0)
        with tarfile.open(fileobj=data) as archive:
            names = archive.getnames()
            db_name = 'rootfs/'+source.as_posix().lstrip('/')
            attachment_name = 'rootfs/'+attachment.as_posix().lstrip('/')
            self.assertLess(names.index(db_name), names.index(attachment_name))
            self.assertEqual(archive.extractfile(attachment_name).read(), attachment.read_bytes())
            restored = self.root/'restored.sqlite'
            restored.write_bytes(archive.extractfile(db_name).read())
        with contextlib.closing(sqlite3.connect(restored)) as db:
            self.assertEqual(db.execute('SELECT path FROM attachments').fetchall(), [(attachment.name,)])

    def test_new_sqlite_after_snapshots_rejects_incomplete_catalogue(self):
        deploy, scratch = self.root/'deploy', self.root/'scratch'
        deploy.mkdir(); scratch.mkdir()
        source = deploy/'messages.sqlite'
        with contextlib.closing(sqlite3.connect(source)) as db:
            db.execute('CREATE TABLE old_messages(body)'); db.commit()
        inv = {'roots':[deploy], 'entries':[source], 'databases':{source},
               'max_snapshot':1024**2, 'metadata':[], 'images':[],
               'bound':4*1024**2, 'raw_bytes':source.stat().st_size}
        def snapshot(original, target, maximum, margin, deadline, children):
            b.snapshot(original, target)
        def refresh():
            new_db = deploy/'new.sqlite'
            with contextlib.closing(sqlite3.connect(new_db)) as db:
                db.execute('CREATE TABLE new_messages(body)'); db.commit()
            return dict(inv, entries=sorted(deploy.iterdir()), databases={source,new_db})
        with patch.object(s, 'snapshot_one', side_effect=snapshot):
            with self.assertRaisesRegex(b.BackupError, 'SOURCE_CHANGED'):
                s._data_producer(self.c, inv, scratch, s.Children(), time.monotonic()+5,
                                 self.name, refresh=refresh)(io.BytesIO())
        self.assertEqual(list(scratch.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
