import datetime as dt
import contextlib
import io
import json
import os
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
    @unittest.skipIf(os.name == "nt", "Linux server reporting fixture")
    def test_server_no_space_writes_status_and_reports(self):
        import grp
        with tempfile.TemporaryDirectory() as tmp:
            c = {"reviewed_inventory": True, "output": tmp, "reader_group": grp.getgrgid(os.getgid()).gr_name}
            with patch.object(b.os, "chown"), patch.object(b, "_create", side_effect=b.BackupError("NO_SPACE_SERVER")), patch.object(b.board_report, "publish", return_value=True) as report:
                with self.assertRaisesRegex(b.BackupError, "NO_SPACE_SERVER"):
                    b.create(c)
            status = json.loads((Path(tmp) / "status.json").read_text())
            self.assertEqual(status["error"], "NO_SPACE_SERVER")
            self.assertEqual(status["board"], "OK")
            self.assertEqual(report.call_args.args[2]["error"], "NO_SPACE_SERVER")

    @unittest.skipUnless(os.name != "nt" and shutil.which("age") and shutil.which("age-keygen"), "Linux online create/age fixture")
    def test_online_create_restore_absolute_link_without_container_pause(self):
        import grp
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            deploy, out, temp_parent = root / "deploy", root / "backups", root / "temps"
            for path in (deploy, out, temp_parent):
                path.mkdir()
            (deploy / "site.html").write_text("fixture")
            (deploy / "absolute").symlink_to(deploy / "site.html")
            identity = root / "key"
            subprocess.run(["age-keygen", "-o", str(identity)], check=True, capture_output=True)
            recipient = subprocess.run(["age-keygen", "-y", str(identity)], check=True, capture_output=True, text=True).stdout.strip()
            metadata = [{"Name": "/crm", "Image": "fixture-image", "Mounts": [{"Type": "bind", "Source": str(deploy), "Destination": "/data"}]}]
            def docker(args, **kw):
                if args == ["docker", "ps", "-q"]:
                    return type("Result", (), {"stdout": "fixture-container"})()
                if args == ["docker", "inspect", "fixture-container"]:
                    return type("Result", (), {"stdout": json.dumps(metadata)})()
                if args == ["docker", "image", "inspect", "fixture-image"]:
                    return type("Result", (), {"stdout": '[{"Size":1000}]'})()
                if args == ["docker", "image", "save", "fixture-image"]:
                    with tarfile.open(fileobj=kw["stdout"], mode="w|") as tar:
                        item = tarfile.TarInfo("manifest.json")
                        item.size = 2
                        tar.addfile(item, io.BytesIO(b"[]"))
                    return
                self.fail("Unexpected Docker mutation: " + str(args))
            c = {"roots": [str(deploy)], "containers": ["crm"], "max_bundle_bytes": 2**22, "max_sqlite_bytes": 2**20,
                 "recipient": recipient, "reader_group": grp.getgrgid(os.getgid()).gr_name, "identity": str(identity),
                 "verify_temp_dir": str(temp_parent), "max_restore_bytes": 2**31}
            with contextlib.closing(sqlite3.connect(deploy / "data.sqlite")) as connection:
                connection.execute("pragma journal_mode=wal")
                connection.execute("create table messages(body)")
                connection.execute("insert into messages values('old draft')")
                connection.commit()
                with patch.object(b, "run", side_effect=docker), patch.object(b.os, "chown"):
                    b._create(c, out)
                b.restore(c, b.completed(out)[0], root / "restored")
            restored = root / "restored/rootfs" / str(deploy).lstrip("/")
            self.assertFalse(os.path.isabs(os.readlink(restored / "absolute")))
            self.assertEqual((restored / "absolute").read_text(), "fixture")
            with contextlib.closing(sqlite3.connect(restored / "data.sqlite")) as connection:
                self.assertEqual(connection.execute("select body from messages").fetchone()[0], "old draft")
            self.assertFalse((restored / "data.sqlite-wal").exists())
            self.assertEqual(list(temp_parent.iterdir()), [])

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
            temp_parent = tmp / "temps"
            temp_parent.mkdir()
            c = {"recipient": recipient, "identity": str(identity), "verify_temp_dir": str(temp_parent), "max_restore_bytes": 2**20}
            # No production data or key material enters output or git.
            bundle = tmp / "backups" / "synapse-20261104T010000Z"
            bundle.mkdir(parents=True)
            content = b"fixture"
            manifest = {"files": {"rootfs/fixture": __import__("hashlib").sha256(content).hexdigest()}, "sqlite": []}
            def data(pipe):
                with tarfile.open(fileobj=pipe, mode="w|gz") as tar:
                    for name, value in (("rootfs/fixture", content), ("manifest.json", json.dumps(manifest).encode())):
                        item = tarfile.TarInfo(name)
                        item.size = len(value)
                        tar.addfile(item, io.BytesIO(value))
            b.encrypt(c, bundle / b.FILES[0], data)
            def images(pipe):
                with tarfile.open(fileobj=pipe, mode="w|") as tar:
                    item = tarfile.TarInfo("manifest.json")
                    item.size = 2
                    tar.addfile(item, io.BytesIO(b"[]"))
            b.encrypt(c, bundle / b.FILES[1], images)
            b.write_json(bundle / "receipt.json", {"id": bundle.name, "restore_bytes": 2**19, "files": {f: {"sha256": b.sha(bundle / f), "bytes": (bundle / f).stat().st_size} for f in b.FILES}})
            b.restore(c, bundle, tmp / "ok")
            self.assertEqual((tmp / "ok/rootfs/fixture").read_bytes(), content)
            self.assertEqual(list(temp_parent.iterdir()), [])
            path = bundle / b.FILES[0]
            path.write_bytes(path.read_bytes()[:-5])
            with self.assertRaises(ValueError):
                b.restore(c, bundle, tmp / "tampered")
            self.assertFalse((tmp / "tampered").exists())
            self.assertEqual(list(temp_parent.iterdir()), [])
            # Re-hash the truncated ciphertext: SHA alone now passes, age must fail.
            receipt = json.loads((bundle / "receipt.json").read_text())
            receipt["files"][b.FILES[0]] = {"sha256": b.sha(path), "bytes": path.stat().st_size}
            b.write_json(bundle / "receipt.json", receipt)
            with self.assertRaises(ValueError):
                b.restore(c, bundle, tmp / "bad-auth")
            self.assertFalse((tmp / "bad-auth").exists())
            self.assertEqual(list(temp_parent.iterdir()), [])

    def test_absolute_symlink_is_relative_or_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            target, link = root / "target", root / "link"
            target.write_text("data")
            try:
                link.symlink_to(target)
            except OSError:
                self.skipTest("Windows symlink permission; Linux CI exercises")
            self.assertEqual(b.link_target(link, [root]), "target")
            link.unlink()
            link.symlink_to(root.parent / "outside")
            with self.assertRaisesRegex(b.BackupError, "LINK_OUTSIDE_ROOTS"):
                b.link_target(link, [root])

    def test_partial_cleanup_only_stale_owned_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "synapse-20261101T010000Z.partial"
            recent = root / "synapse-20261102T010000Z.partial"
            foreign = root / "personal.partial"
            for p in (stale, recent, foreign):
                p.mkdir()
            os.utime(stale, (1, 1))
            os.utime(foreign, (1, 1))
            b.cleanup_partial(root)
            self.assertFalse(stale.exists())
            self.assertTrue(recent.exists())
            self.assertTrue(foreign.exists())

    def test_weekly_failure_does_not_skip_rotation_status_or_board(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("synapse-20260101T010000Z", "synapse-20260102T010000Z"):
                path = root / name
                path.mkdir()
                (path / "receipt.json").write_text("{}")
            dest = root / "synapse-20261104T010000Z"
            dest.mkdir()
            (dest / "receipt.json").write_text("{}")
            with patch.object(b, "download", return_value=(dest, {"files": {"a": {"bytes": 1}}})), patch.object(b, "weekly_verify", side_effect=ValueError("SECRET")), patch.object(b.board_report, "publish", return_value=True) as report:
                with self.assertRaises(ValueError):
                    b.pull({"destination": tmp})
            self.assertFalse((root / "synapse-20260101T010000Z").exists())
            status = json.loads((root / "status.json").read_text())
            self.assertEqual(status["result"], "ERROR")
            self.assertEqual(status["sha"], "OK")
            self.assertNotIn("SECRET", (root / "status.json").read_text())
            self.assertTrue(report.called)

    def test_no_space_temp_checked_before_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backup = root / "archives" / "synapse-20261104T010000Z"
            backup.mkdir(parents=True)
            b.write_json(backup / "receipt.json", {"restore_bytes": 100})
            c = {"verify_temp_dir": tmp, "identity": str(root / "identity"), "max_restore_bytes": 200}
            with patch.object(b.shutil, "disk_usage", return_value=type("Space", (), {"free": 99})()), patch.object(b, "restore") as restore:
                with self.assertRaisesRegex(b.BackupError, "NO_SPACE_TEMP"):
                    b.weekly_verify(c, backup)
                restore.assert_not_called()

    def test_key_and_temp_must_be_outside_archives(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backup = root / "archives" / "synapse-20261104T010000Z"
            backup.mkdir(parents=True)
            with self.assertRaises(b.BackupError):
                b.temporary_parent({"identity": str(root / "key"), "verify_temp_dir": str(backup.parent)}, backup)
            with self.assertRaises(b.BackupError):
                b.temporary_parent({"identity": str(backup.parent / "key"), "verify_temp_dir": tmp}, backup)

    def test_readonly_key_cannot_ack_or_delete(self):
        for command in ("ack synapse-20261104T010000Z", "delete synapse-20261104T010000Z"):
            with patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": command}), self.assertRaises(ValueError):
                b.serve({"output": "."})

    def test_prune_requires_exact_latest_d_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("synapse-20261101T010000Z", "synapse-20261102T010000Z"):
                path = root / name
                path.mkdir()
                for file in b.FILES:
                    (path / file).write_bytes(b"fixture")
                b.write_json(path / "receipt.json", {"id": name, "files": {f: {"bytes": 7, "sha256": b.sha(path / f)} for f in b.FILES}})
            with patch.object(b.board_report, "acknowledged", return_value=False):
                b.prune({"output": tmp})
            self.assertEqual(len(b.completed(root)), 2)
            with patch.object(b.board_report, "acknowledged", return_value=True) as ack:
                b.prune({"output": tmp})
            self.assertEqual(len(b.completed(root)), 1)
            self.assertEqual(ack.call_args.args[1:], (b.completed(root)[0].name, b.sha(b.completed(root)[0] / "receipt.json")))


if __name__ == "__main__":
    unittest.main()
