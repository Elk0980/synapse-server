"""Offline package validation and Linux filesystem tests; no Telegram or secrets."""

import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile


SPEC = importlib.util.spec_from_file_location("eva_package_bootstrap", Path(__file__).with_name("package_bootstrap.py"))
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


def fixture(overrides=None, additions=(), change_info=None):
    contents = {name: ("fixture for " + name + "\n").encode("ascii")
                for name in sorted(bootstrap.ALLOWED_FILES)}
    contents.update(overrides or {})
    output = io.BytesIO()
    with warnings.catch_warnings(), zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        warnings.simplefilter("ignore", UserWarning)
        for name, data in list(contents.items()) + list(additions):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            if change_info:
                change_info(info)
            archive.writestr(info, data)
    raw = output.getvalue()
    metadata = {
        "schema": 1, **bootstrap.SOURCE_REVISIONS, "package_source_sha": "f" * 40,
        "file_sha256": {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()},
        "company_codes": list(bootstrap.COMPANY_CODES), "timezone": "Etc/UTC",
        "expected_bot": "SynapseBusinessEvaBot",
    }
    return metadata, base64.b64encode(raw).decode("ascii"), hashlib.sha256(raw).hexdigest()


class ValidationTests(unittest.TestCase):
    def test_complete_bundle_matches_only_approved_files(self):
        entries = bootstrap.validate_bundle(*fixture())
        self.assertEqual(set(entries), bootstrap.ALLOWED_FILES)
        self.assertEqual(len(entries), 22)

    def test_payload_hash_corruption_is_rejected_before_filesystem_access(self):
        metadata, encoded, digest = fixture()
        with mock.patch.object(bootstrap.os, "open") as opened, self.assertRaises(bootstrap.PackageError):
            bootstrap.validate_bundle(metadata, encoded, "0" * 64)
        opened.assert_not_called()

    def test_invalid_base64_and_oversized_payload_rejected(self):
        metadata, encoded, digest = fixture()
        for value in ("%%%%", "é", encoded + "\n", 4, None):
            with self.subTest(value_type=type(value)), self.assertRaises(bootstrap.PackageError):
                bootstrap.validate_bundle(metadata, value, digest)
        with mock.patch.object(bootstrap, "MAX_ZIP_BYTES", 1), self.assertRaises(bootstrap.PackageError):
            bootstrap.validate_bundle(metadata, encoded, digest)

    def test_non_zip_with_valid_hash_is_rejected(self):
        metadata, _, _ = fixture()
        data = b"not a zip"
        with self.assertRaises(bootstrap.PackageError):
            bootstrap.validate_bundle(metadata, base64.b64encode(data).decode(), hashlib.sha256(data).hexdigest())

    def test_metadata_rejects_wrong_version_revision_identity_and_extra_fields(self):
        metadata, encoded, digest = fixture()
        edits = [("schema", 2), ("schema", True), ("main_sha", "a" * 40),
                 ("eva_sha", "b" * 40), ("integrated_sha", "c" * 40),
                 ("package_source_sha", "HEAD"), ("company_codes", ["alvi"]),
                 ("timezone", "Europe/Moscow"), ("expected_bot", "OtherBot"),
                 ("activate", True)]
        for key, value in edits:
            invalid = copy.deepcopy(metadata)
            invalid[key] = value
            with self.subTest(key=key), self.assertRaises(bootstrap.PackageError):
                bootstrap.validate_bundle(invalid, encoded, digest)

    def test_manifest_requires_complete_known_files_and_valid_digest(self):
        metadata, encoded, digest = fixture()
        for mutation in (lambda manifest: manifest.pop("PACKAGE_README.md"),
                         lambda manifest: manifest.update({".env": "a" * 64}),
                         lambda manifest: manifest.update({"PACKAGE_README.md": "HASH"}),
                         lambda manifest: manifest.update({"PACKAGE_README.md": "0" * 64})):
            invalid = copy.deepcopy(metadata)
            mutation(invalid["file_sha256"])
            with self.assertRaises(bootstrap.PackageError):
                bootstrap.validate_bundle(invalid, encoded, digest)

    def test_archive_missing_file_rejected_even_with_valid_archive_hash(self):
        metadata, _, _ = fixture()
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("PACKAGE_README.md", b"fixture for PACKAGE_README.md\n")
        raw = output.getvalue()
        with self.assertRaises(bootstrap.PackageError):
            bootstrap.validate_bundle(metadata, base64.b64encode(raw).decode(), hashlib.sha256(raw).hexdigest())

    def test_traversal_absolute_backslash_empty_unknown_and_case_collision_paths_rejected(self):
        for name in ("../escape", "/tmp/escape", "ops/../escape", "ops//escape", "ops/./escape",
                     "C:/escape", "ops\\escape", "ops/eva-tasks/.env", "package_readme.md",
                     "ops/eva-tasks/bot.js/extra", "ops/eva-tasks/", "PACKAGE_README.md "):
            with self.subTest(name=name), self.assertRaises(bootstrap.PackageError):
                bootstrap.validate_bundle(*fixture(additions=[(name, b"untrusted")]))

    def test_duplicate_archive_entry_is_rejected(self):
        with self.assertRaises(bootstrap.PackageError):
            bootstrap.validate_bundle(*fixture(additions=[("PACKAGE_README.md", b"duplicate")]))

    def test_symlink_fifo_socket_and_directory_entries_rejected(self):
        for kind in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFSOCK, stat.S_IFDIR, stat.S_IFCHR):
            def change(info):
                if info.filename == "PACKAGE_README.md":
                    info.external_attr = (kind | 0o700) << 16
            with self.subTest(kind=kind), self.assertRaises(bootstrap.PackageError):
                bootstrap.validate_bundle(*fixture(change_info=change))

    def test_size_and_count_limits(self):
        for name, limit in (("MAX_FILE_BYTES", 1), ("MAX_TOTAL_BYTES", 1), ("MAX_FILES", 1)):
            bundle = fixture()
            with mock.patch.object(bootstrap, name, limit), self.assertRaises(bootstrap.PackageError):
                bootstrap.validate_bundle(*bundle)

    def test_corrupt_zip_crc_rejected_with_recomputed_payload_hash(self):
        metadata, encoded, _ = fixture()
        raw = base64.b64decode(encoded).replace(b"fixture for PACKAGE_README.md\n", b"changed for PACKAGE_README.md\n", 1)
        with self.assertRaises(bootstrap.PackageError):
            bootstrap.validate_bundle(metadata, base64.b64encode(raw).decode(), hashlib.sha256(raw).hexdigest())

    def test_compression_bomb_ratio_rejected(self):
        def compressed(info):
            info.compress_type = zipfile.ZIP_DEFLATED
        with self.assertRaises(bootstrap.PackageError):
            bootstrap.validate_bundle(*fixture(overrides={"PACKAGE_README.md": b"x" * 100000}, change_info=compressed))

    def test_check_mode_does_not_open_files_prompt_or_prepare(self):
        bundle = fixture()
        output = io.StringIO()
        with mock.patch.object(bootstrap, "check_platform"), \
                mock.patch.object(bootstrap.os, "open") as opened, \
                mock.patch.object(bootstrap, "prepare_bundle") as prepare, \
                mock.patch("builtins.input", side_effect=AssertionError("must never prompt")), \
                contextlib.redirect_stdout(output):
            self.assertEqual(bootstrap.main(["--check"], *bundle), 0)
        opened.assert_not_called()
        prepare.assert_not_called()
        self.assertIn("CHECK OK: 22 files", output.getvalue())
        self.assertIn("CONNECTION BLOCKED", output.getvalue())
        self.assertIn("PR443", output.getvalue())

    def test_default_mode_only_prepares_and_discloses_blocker(self):
        output = io.StringIO()
        with mock.patch.object(bootstrap, "check_platform"), \
                mock.patch.object(bootstrap, "prepare_bundle", return_value="eva-prepared-fixture") as prepare, \
                contextlib.redirect_stdout(output):
            self.assertEqual(bootstrap.main([], *fixture()), 0)
        prepare.assert_called_once()
        self.assertIn("PREPARED (not connected)", output.getvalue())
        self.assertIn("owner must then personally", output.getvalue())

    def test_unsupported_platform_and_python_are_rejected(self):
        for platform, version in (("win32", (3, 14)), ("darwin", (3, 12)), ("linux", (3, 8))):
            with mock.patch.object(bootstrap.sys, "platform", platform), \
                    mock.patch.object(bootstrap.sys, "version_info", version), \
                    self.assertRaises(bootstrap.PackageError):
                bootstrap.check_platform()

    def test_unbuilt_template_and_error_details_are_fail_closed(self):
        output = io.StringIO()
        with mock.patch.object(bootstrap, "check_platform"), contextlib.redirect_stderr(output):
            self.assertEqual(bootstrap.main(["--check"]), 1)
        self.assertIn("STOPPED", output.getvalue())
        output = io.StringIO()
        with mock.patch.object(bootstrap, "check_platform"), \
                mock.patch.object(bootstrap, "prepare_bundle", side_effect=OSError("private-environment-marker")), \
                contextlib.redirect_stderr(output):
            self.assertEqual(bootstrap.main([], *fixture()), 1)
        self.assertNotIn("private-environment-marker", output.getvalue())

    def test_no_network_process_secret_or_activation_imports(self):
        import ast
        tree = ast.parse(Path(bootstrap.__file__).read_text(encoding="utf-8"))
        imports = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import)
                   for alias in node.names}
        imports.update(node.module.split(".")[0] for node in ast.walk(tree)
                       if isinstance(node, ast.ImportFrom) and node.module)
        self.assertFalse(imports & {"subprocess", "socket", "urllib", "http", "requests", "getpass",
                                    "pairing", "setup", "shutil"})


@unittest.skipUnless(sys.platform == "linux", "requires real Linux dir_fd/O_NOFOLLOW and POSIX modes")
class LinuxFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="eva-package-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.bundle = fixture()
        self.destination = self.base / ("eva-prepared-" + self.bundle[2][:16])

    def prepare(self):
        return bootstrap.prepare_bundle(*self.bundle, directory=self.base)

    def test_prepare_exact_files_private_modes_and_existing_env_untouched(self):
        marker = self.base / ".env"
        marker.write_text("CRM_EXISTING_FIXTURE=must-stay\n", encoding="utf-8")
        before = marker.read_bytes()
        self.assertEqual(self.prepare(), self.destination.name)
        files = {path.relative_to(self.destination).as_posix() for path in self.destination.rglob("*") if path.is_file()}
        self.assertEqual(files, bootstrap.ALLOWED_FILES)
        for path in [self.destination] + list(self.destination.rglob("*")):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)
        self.assertEqual(marker.read_bytes(), before)

    def test_existing_folder_idempotent_rerun_fails_without_mutation(self):
        self.prepare()
        target = self.destination / "PACKAGE_README.md"
        target.write_bytes(b"owner change")
        with self.assertRaises(bootstrap.PackageError):
            self.prepare()
        self.assertEqual(target.read_bytes(), b"owner change")

    def test_existing_destination_symlink_is_not_followed(self):
        foreign = self.base / "foreign"
        foreign.mkdir()
        self.destination.symlink_to(foreign, target_is_directory=True)
        with self.assertRaises(bootstrap.PackageError):
            self.prepare()
        self.assertEqual(list(foreign.iterdir()), [])
        self.assertTrue(self.destination.is_symlink())

    def test_shared_writable_working_directory_rejected(self):
        self.base.chmod(0o777)
        with self.assertRaises(bootstrap.PackageError):
            self.prepare()
        self.assertFalse(self.destination.exists())
        self.base.chmod(0o700)

    def test_invalid_bundle_causes_no_directory_creation(self):
        metadata, encoded, digest = self.bundle
        with self.assertRaises(bootstrap.PackageError):
            bootstrap.prepare_bundle(metadata, encoded, "0" * 64, directory=self.base)
        self.assertEqual(list(self.base.iterdir()), [])

    def test_partial_write_failure_rolls_back_only_created_files_and_directories(self):
        marker = self.base / ".env"
        marker.write_bytes(b"unchanged")
        original = os.write
        calls = []
        def write(fd, data):
            calls.append(fd)
            if len(calls) == 1:
                return original(fd, data[:3])
            raise OSError("fixture write failure")
        with mock.patch.object(bootstrap.os, "write", side_effect=write), self.assertRaises(OSError):
            self.prepare()
        self.assertFalse(self.destination.exists())
        self.assertEqual(marker.read_bytes(), b"unchanged")

    def test_failure_after_nested_creation_rolls_back_nested_tree(self):
        original = os.write
        def write(fd, data):
            if b"ops/crm/" in data:
                raise OSError("fixture nested failure")
            return original(fd, data)
        with mock.patch.object(bootstrap.os, "write", side_effect=write), self.assertRaises(OSError):
            self.prepare()
        self.assertFalse(self.destination.exists())

    def test_open_failure_rolls_back_new_empty_directory(self):
        original = os.open
        def opened(name, *args, **kwargs):
            if name == "ops":
                raise OSError("fixture directory-open failure")
            return original(name, *args, **kwargs)
        with mock.patch.object(bootstrap.os, "open", side_effect=opened), self.assertRaises(OSError):
            self.prepare()
        self.assertFalse(self.destination.exists())

    def test_rollback_preserves_file_modified_by_another_actor(self):
        original = os.write
        def write(fd, data):
            if b"integration.patch" in data:
                (self.destination / "PACKAGE_README.md").write_bytes(b"owner edit must survive")
                raise OSError("fixture failure")
            return original(fd, data)
        with mock.patch.object(bootstrap.os, "write", side_effect=write), self.assertRaises(OSError):
            self.prepare()
        self.assertEqual((self.destination / "PACKAGE_README.md").read_bytes(), b"owner edit must survive")
        self.assertFalse((self.destination / "integration.patch").exists())

    def test_rollback_preserves_replacement_inode_and_foreign_file(self):
        original = os.write
        def write(fd, data):
            if b"integration.patch" in data:
                target = self.destination / "PACKAGE_README.md"
                target.unlink()
                target.write_bytes(b"replacement must survive")
                (self.destination / "foreign.txt").write_bytes(b"foreign must survive")
                raise OSError("fixture failure")
            return original(fd, data)
        with mock.patch.object(bootstrap.os, "write", side_effect=write), self.assertRaises(OSError):
            self.prepare()
        self.assertEqual((self.destination / "PACKAGE_README.md").read_bytes(), b"replacement must survive")
        self.assertEqual((self.destination / "foreign.txt").read_bytes(), b"foreign must survive")

    def test_rollback_preserves_file_touched_without_content_change(self):
        original = os.write
        def write(fd, data):
            if b"integration.patch" in data:
                target = self.destination / "PACKAGE_README.md"
                info = target.stat()
                os.utime(target, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000))
                raise OSError("fixture failure")
            return original(fd, data)
        with mock.patch.object(bootstrap.os, "write", side_effect=write), self.assertRaises(OSError):
            self.prepare()
        self.assertEqual((self.destination / "PACKAGE_README.md").read_bytes(), b"fixture for PACKAGE_README.md\n")

    def test_rollback_does_not_follow_replaced_directory_symlink(self):
        foreign = self.base / "foreign"
        foreign.mkdir()
        sentinel = foreign / "sentinel"
        sentinel.write_bytes(b"untouched")
        original = os.write
        def write(fd, data):
            if b"ops/crm/" in data:
                (self.destination / "ops").rename(self.destination / "ops-moved")
                (self.destination / "ops").symlink_to(foreign, target_is_directory=True)
                raise OSError("fixture failure")
            return original(fd, data)
        with mock.patch.object(bootstrap.os, "write", side_effect=write), self.assertRaises(OSError):
            self.prepare()
        self.assertEqual(sentinel.read_bytes(), b"untouched")
        self.assertTrue((self.destination / "ops").is_symlink())


if __name__ == "__main__":
    unittest.main()
