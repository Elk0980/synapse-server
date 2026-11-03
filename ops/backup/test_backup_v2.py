import datetime as dt
import contextlib
import io
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import backup_v2 as b


class BackupTests(unittest.TestCase):
    def test_live_wal_snapshot_preserves_committed_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, copy = Path(tmp) / "db", Path(tmp) / "copy"
            with contextlib.closing(sqlite3.connect(source)) as conn:
                conn.execute("pragma journal_mode=wal")
                conn.execute("create table messages(body)")
                conn.execute("insert into messages values ('старый черновик')")
                conn.commit()
                b.snapshot(source, copy)
                with contextlib.closing(sqlite3.connect(copy)) as restored:
                    self.assertEqual(restored.execute("select body from messages").fetchone()[0], "старый черновик")

    def test_corrupt_sqlite_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "bad"
            p.write_bytes(b"SQLite format 3\0broken")
            with self.assertRaises(sqlite3.DatabaseError):
                b.check_db(p)

    def test_retention_fourteen_days_and_monthly(self):
        today = dt.date(2026, 11, 4)
        ids = ["synapse-20261104T010000Z", "synapse-20261022T010000Z", "synapse-20261021T010000Z", "synapse-20261001T010000Z", "synapse-20260920T010000Z", "synapse-20260901T010000Z", "foreign"]
        self.assertEqual(b.keep_ids(ids, today), {ids[0], ids[1], ids[4]})

    def test_readonly_server_command_rejects_traversal(self):
        with patch.dict("os.environ", {"SSH_ORIGINAL_COMMAND": "get ../../etc passwd"}):
            with self.assertRaises(ValueError):
                b.serve({"output": "."})

    def test_restore_never_overwrites_existing_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                b.restore({}, tmp, tmp)

    def test_ssh_has_strict_host_pin_and_no_shell(self):
        c = {"known_hosts": "pin", "ssh_key": "key", "host": "backup@host"}
        with patch.object(b, "run") as run:
            b.ssh(c, "list", io.BytesIO())
            args = run.call_args.args[0]
            self.assertIn("-oStrictHostKeyChecking=yes", args)
            self.assertNotIn("shell", run.call_args.kwargs)

    def test_pull_bad_receipt_keeps_old_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            name = "synapse-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            old = Path(tmp) / "synapse-20260101T000000Z"
            old.mkdir()
            (old / "receipt.json").write_text("{}")
            def fake(c, cmd, target):
                target.write(json.dumps([name] if cmd == "list" else {"id": name, "files": {"../../unsafe": {}}}).encode())
            with patch.object(b, "ssh", side_effect=fake), self.assertRaises(ValueError):
                b.pull({"destination": tmp})
            self.assertTrue(old.exists())

    @unittest.skipUnless(shutil.which("age") and shutil.which("age-keygen"), "age unavailable locally; mandatory Linux CI")
    def test_real_age_roundtrip_and_tamper(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            identity = tmp / "identity"
            subprocess.run(["age-keygen", "-o", str(identity)], check=True, capture_output=True)
            recipient = subprocess.run(["age-keygen", "-y", str(identity)], check=True, capture_output=True, text=True).stdout.strip()
            c = {"recipient": recipient, "identity": str(identity)}
            # No production data or key material enters output or git.
            bundle = tmp / "bundle"
            bundle.mkdir()
            content = b"fixture"
            manifest = {"files": {"rootfs/fixture": __import__("hashlib").sha256(content).hexdigest()}, "sqlite": []}
            def data(pipe):
                with tarfile.open(fileobj=pipe, mode="w|gz") as tar:
                    for name, value in (("rootfs/fixture", content), ("manifest.json", json.dumps(manifest).encode())):
                        item = tarfile.TarInfo(name)
                        item.size = len(value)
                        tar.addfile(item, io.BytesIO(value))
            b.encrypt(c, bundle / b.FILES[0], data)
            b.encrypt(c, bundle / b.FILES[1], lambda pipe: pipe.write(b"image-fixture"))
            b.write_json(bundle / "receipt.json", {"files": {f: {"sha256": b.sha(bundle / f)} for f in b.FILES}})
            b.restore(c, bundle, tmp / "ok")
            self.assertEqual((tmp / "ok/rootfs/fixture").read_bytes(), content)
            path = bundle / b.FILES[0]
            path.write_bytes(path.read_bytes()[:-5])
            with self.assertRaises(ValueError):
                b.restore(c, bundle, tmp / "tampered")


if __name__ == "__main__":
    unittest.main()
