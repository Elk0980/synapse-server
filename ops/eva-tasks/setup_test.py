"""Offline tests: fake tokens only; never opens /etc or calls Telegram/Docker."""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("eva_setup", Path(__file__).with_name("setup.py"))
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)
FAKE_TOKEN = "1" * 9 + ":" + "fixture_" * 5


def directory(mode=0o700, owner=0):
    return SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=owner)


class ValidationTests(unittest.TestCase):
    def test_owner_must_be_positive_numeric_safe_integer(self):
        self.assertEqual(setup.validate_owner_id("12345"), "12345")
        for value in ("", "0", "-1", "01", "1.0", "@owner", "1\n", "١٢٣", str(2**53)):
            with self.subTest(value=value), self.assertRaises(setup.SetupError):
                setup.validate_owner_id(value)

    def test_timezone_default_and_iana_validation(self):
        with mock.patch.object(setup, "ZoneInfo") as zone:
            self.assertEqual(setup.validate_timezone(""), "Etc/UTC")
            self.assertEqual(setup.validate_timezone("Asia/Irkutsk"), "Asia/Irkutsk")
            zone.assert_called_with("Asia/Irkutsk")
            zone.side_effect = setup.ZoneInfoNotFoundError
            with self.assertRaises(setup.SetupError):
                setup.validate_timezone("Unknown/Unknown")
        for value in ("Etc/UTC\nTOKEN=value", "UTC ", "$ENV", ""):
            if not value:
                continue
            with self.subTest(value=value), self.assertRaises(setup.SetupError):
                setup.validate_timezone(value)

    def test_volume_exact_name_no_paths_or_env_injection(self):
        self.assertEqual(setup.validate_volume("synapse-server_crm_data"), "synapse-server_crm_data")
        for value in ("", "x", "/data", "../crm", " crm", "crm\nX=1", "${CRM}", "crm:ro"):
            with self.subTest(value=value), self.assertRaises(setup.SetupError):
                setup.validate_volume(value)

    def test_token_errors_do_not_echo_value(self):
        self.assertEqual(setup.validate_token(FAKE_TOKEN), FAKE_TOKEN)
        for value in ("invalid-sensitive-value", FAKE_TOKEN + " ", FAKE_TOKEN + "\n", "${TOKEN}",
                      "0" + FAKE_TOKEN, str(2**53) + ":" + "fixture_" * 5):
            with self.subTest(length=len(value)), self.assertRaises(setup.SetupError) as error:
                setup.validate_token(value)
            self.assertNotIn(value, str(error.exception))

    def test_private_directory_rejects_wrong_owner_mode_or_symlink(self):
        setup.validate_directory(directory(), private=True)
        setup.validate_directory(directory(0o755), private=False)
        for info in (directory(0o755), directory(0o700, 1000), directory(0o777),
                     SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0)):
            with self.subTest(info=info), self.assertRaises(setup.SetupError):
                setup.validate_directory(info, private=True)


class FilesystemContractTests(unittest.TestCase):
    def setUp(self):
        # Linux open flags are intentionally unavailable on native Windows; model
        # them for syscall-contract tests. Linux deployment is a separate live check.
        patcher = mock.patch.multiple(
            setup.os, O_DIRECTORY=getattr(os, "O_DIRECTORY", 0x10000),
            O_NOFOLLOW=getattr(os, "O_NOFOLLOW", 0x20000), create=True,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_walk_checks_every_component_and_uses_nofollow(self):
        with mock.patch.object(setup.os, "open", side_effect=[10, 11, 12, 13]) as opened, \
             mock.patch.object(setup.os, "fstat", side_effect=[directory(0o755)] * 3 + [directory()]), \
             mock.patch.object(setup.os, "close") as closed:
            self.assertEqual(setup.open_private_directory(), 13)
        self.assertEqual([call.args[0] for call in opened.call_args_list], ["/", "etc", "synapse", "eva"])
        for call in opened.call_args_list:
            self.assertTrue(call.args[1] & setup.os.O_NOFOLLOW)
            self.assertTrue(call.args[1] & setup.os.O_DIRECTORY)
        self.assertEqual(closed.call_args_list, [mock.call(10), mock.call(11), mock.call(12)])

    def test_missing_private_directory_created_0700(self):
        with mock.patch.object(setup.os, "open", side_effect=[10, 11, 12, FileNotFoundError(), 13]), \
             mock.patch.object(setup.os, "fstat", side_effect=[directory(0o755)] * 3 + [directory()]), \
             mock.patch.object(setup.os, "mkdir") as mkdir, \
             mock.patch.object(setup.os, "close"):
            self.assertEqual(setup.open_private_directory(), 13)
        mkdir.assert_called_once_with("eva", 0o700, dir_fd=12)

    def test_component_symlink_oserror_closes_fd_without_mutation(self):
        with mock.patch.object(setup.os, "open", side_effect=[10, OSError("symlink")]), \
             mock.patch.object(setup.os, "fstat", return_value=directory(0o755)), \
             mock.patch.object(setup.os, "close") as closed, \
             mock.patch.object(setup.os, "mkdir") as mkdir:
            with self.assertRaises(OSError):
                setup.open_private_directory()
        closed.assert_called_once_with(10)
        mkdir.assert_not_called()

    def test_unsafe_paths_rejected_before_open(self):
        with mock.patch.object(setup.os, "open") as opened:
            for path in ("/", "etc/synapse/eva", "/etc/../eva", "/etc//synapse/eva", "/etc/synapse/eva/"):
                with self.subTest(path=path), self.assertRaises(setup.SetupError):
                    setup.open_private_directory(path)
        opened.assert_not_called()

    def test_existing_file_or_symlink_is_never_read_or_replaced(self):
        for mode in (stat.S_IFREG | 0o600, stat.S_IFLNK | 0o777):
            with self.subTest(mode=mode), \
                 mock.patch.object(setup.os, "stat", return_value=SimpleNamespace(st_mode=mode)) as checked, \
                 mock.patch.object(setup.os, "open") as opened:
                with self.assertRaises(setup.SetupError):
                    setup.refuse_existing(40)
                checked.assert_called_once_with("telegram-token", dir_fd=40, follow_symlinks=False)
                opened.assert_not_called()

    def test_write_uses_0600_exclusive_nofollow_and_handles_partial_write(self):
        data = b"fake data"
        with mock.patch.object(setup.os, "open", return_value=50) as opened, \
             mock.patch.object(setup.os, "write", side_effect=[2, len(data) - 2]) as written, \
             mock.patch.object(setup.os, "fsync") as synced, \
             mock.patch.object(setup.os, "close") as closed:
            setup.write_private_file(40, "telegram-token", data)
        flags = opened.call_args.args[1]
        for required in (os.O_WRONLY, os.O_CREAT, os.O_EXCL, setup.os.O_NOFOLLOW):
            self.assertTrue(flags & required)
        self.assertEqual(opened.call_args.args[2], 0o600)
        self.assertEqual(opened.call_args.kwargs, {"dir_fd": 40})
        self.assertEqual(bytes(written.call_args_list[1].args[1]), data[2:])
        synced.assert_called_once_with(50)
        closed.assert_called_once_with(50)

    def test_race_existing_file_does_not_write(self):
        with mock.patch.object(setup.os, "open", side_effect=FileExistsError()), \
             mock.patch.object(setup.os, "write") as written:
            with self.assertRaises(FileExistsError):
                setup.write_private_file(40, "telegram-token", b"fake data")
        written.assert_not_called()

    def test_metadata_has_allowlisted_nonsecret_values_only(self):
        with mock.patch.object(setup, "ZoneInfo"), \
             mock.patch.object(setup, "refuse_existing"), \
             mock.patch.object(setup, "write_private_file") as write, \
             mock.patch.object(setup.os, "fsync"):
            setup.save_configuration(40, FAKE_TOKEN, "12345", "Etc/UTC", "test_crm_data")
        self.assertEqual(write.call_args_list[0], mock.call(40, "telegram-token", (FAKE_TOKEN + "\n").encode()))
        metadata = write.call_args_list[1].args[2].decode()
        self.assertEqual(metadata, "EVA_OWNER_USER_ID=12345\nEVA_TIMEZONE=Etc/UTC\nEVA_CRM_VOLUME=test_crm_data\n")
        self.assertNotIn(FAKE_TOKEN, metadata)
        self.assertNotIn("TOKEN", metadata)


class HumanInputTests(unittest.TestCase):
    def test_cli_token_argument_rejected_without_echo(self):
        stream = io.StringIO()
        with contextlib.redirect_stderr(stream), mock.patch.object(setup, "read_hidden_token") as prompt:
            self.assertEqual(setup.main([FAKE_TOKEN]), 2)
        prompt.assert_not_called()
        self.assertNotIn(FAKE_TOKEN, stream.getvalue())

    def test_getpass_echo_fallback_stops(self):
        def warn(*args, **kwargs):
            setup.warnings.warn("no terminal", setup.getpass.GetPassWarning)
        with mock.patch.object(setup.getpass, "getpass", side_effect=warn):
            with self.assertRaises(setup.getpass.GetPassWarning):
                setup.read_hidden_token()

    def test_noninteractive_input_rejected_before_files_or_token(self):
        with mock.patch.object(setup.sys, "platform", "linux"), \
             mock.patch.object(setup.os, "geteuid", return_value=0, create=True), \
             mock.patch.object(setup.sys.stdin, "isatty", return_value=False), \
             mock.patch.object(setup, "open_private_directory") as opened, \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(setup.main([]), 2)
        opened.assert_not_called()

    def test_oserror_containing_secret_is_redacted(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(setup.sys, "platform", "linux"), \
             mock.patch.object(setup.os, "geteuid", return_value=0, create=True), \
             mock.patch.object(setup.sys.stdin, "isatty", return_value=True), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
             mock.patch.object(err, "isatty", return_value=True), \
             mock.patch.object(setup.os, "umask"), \
             mock.patch.object(setup, "open_private_directory", side_effect=OSError(FAKE_TOKEN)):
            self.assertEqual(setup.main([]), 1)
        self.assertNotIn(FAKE_TOKEN, out.getvalue() + err.getvalue())

    def test_no_token_environment_or_network_contract(self):
        source = Path(__file__).with_name("setup.py").read_text(encoding="utf-8")
        for forbidden in ("os.environ", "getenv(", "subprocess", "urllib", "requests", "socket", "chmod("):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
