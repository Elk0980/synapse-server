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
        self.assertEqual(setup.validate_volume("approved_eva_task_socket"), "approved_eva_task_socket")
        for value in ("", "x", "/data", "../tasks", " tasks", "tasks\nX=1", "${SOCKET}", "tasks:ro"):
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
            setup.save_configuration(40, FAKE_TOKEN, "12345", "Etc/UTC", "test_task_socket")
        self.assertEqual(write.call_args_list[0], mock.call(40, "telegram-token", (FAKE_TOKEN + "\n").encode()))
        metadata = write.call_args_list[1].args[2].decode()
        self.assertEqual(metadata, "EVA_OWNER_USER_ID=12345\nEVA_TIMEZONE=Etc/UTC\nEVA_TASK_SOCKET_VOLUME=test_task_socket\n")
        self.assertNotIn(FAKE_TOKEN, metadata)
        self.assertNotIn("TOKEN", metadata)
        self.assertNotIn("CRM", metadata)
        self.assertNotIn("EVA_DB_PATH", metadata)


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
        for forbidden in ("os.environ", "getenv(", "subprocess", "urllib", "requests", "import socket", "chmod("):
            self.assertNotIn(forbidden, source)


class DeployBoundaryTests(unittest.TestCase):
    def test_bot_config_cannot_mount_crm_or_take_a_database_path(self):
        compose = Path(__file__).with_name("compose.eva.yml").read_text(encoding="utf-8")
        self.assertIn("EVA_TASK_SOCKET: /run/eva-tasks/tasks.sock", compose)
        self.assertIn("EVA_TASK_SOCKET_VOLUME:?", compose)
        self.assertIn("external: true", compose)
        self.assertIn("target: /run/eva-tasks\n        read_only: true", compose)
        for forbidden in ("EVA_DB_PATH", "EVA_CRM_VOLUME", "crm_data", "target: /crm", "CRM_API_KEY", "env_file:", "ports:"):
            self.assertNotIn(forbidden, compose)

    def test_image_contains_socket_client_and_not_legacy_database_adapter(self):
        base = Path(__file__).parent
        dockerfile = (base / "Dockerfile").read_text(encoding="utf-8")
        allowed = (base / ".dockerignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("COPY runtime.js bot.js socket-source.js ./", dockerfile)
        self.assertNotIn("task-source.js", dockerfile)
        self.assertEqual(allowed, ["**", "!Dockerfile", "!.dockerignore", "!runtime.js", "!bot.js", "!socket-source.js"])

    def test_crm_overlay_requires_explicit_scope_and_has_no_default_or_public_port(self):
        compose = Path(__file__).with_name("compose.eva-crm.example.yml").read_text(encoding="utf-8")
        self.assertIn("services:\n  crm:\n", compose)
        self.assertIn("EVA_TASK_SOCKET_PATH: /run/eva-tasks/tasks.sock", compose)
        self.assertIn("EVA_TASK_PROJECTS: ${EVA_TASK_PROJECTS:?", compose)
        self.assertIn("EVA_TASK_SOCKET_VOLUME:?", compose)
        self.assertIn("external: true", compose)
        for forbidden in ("ports:", "EVA_TASK_PROJECTS:-", "EVA_TASK_PROJECTS: []", "EVA_TASK_PROJECTS: '*'", "CRM_API_KEY"):
            self.assertNotIn(forbidden, compose)


class PairedSetupTests(unittest.TestCase):
    ARGS = ["--pair", "FixtureEvaBot", "Asia/Bangkok", "fixture_eva_socket"]

    def run_main(self, *, pair_result=None, pair_error=None, lock_error=None, stdout_tty=True, save_error=None, argv=None):
        import pairing
        events = []
        out, err = io.StringIO(), io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(err))
            for target, value in ((setup.sys, "linux"),):
                stack.enter_context(mock.patch.object(target, "platform", value))
            stack.enter_context(mock.patch.object(setup.os, "geteuid", return_value=0, create=True))
            stack.enter_context(mock.patch.object(setup.sys.stdin, "isatty", return_value=True))
            stack.enter_context(mock.patch.object(out, "isatty", return_value=stdout_tty))
            stack.enter_context(mock.patch.object(err, "isatty", return_value=True))
            stack.enter_context(mock.patch.object(setup.os, "umask"))
            stack.enter_context(mock.patch.object(setup, "ZoneInfo"))
            opened = stack.enter_context(mock.patch.object(setup, "open_private_directory", return_value=40))
            locked = stack.enter_context(mock.patch.object(setup, "lock_setup", side_effect=lock_error))
            stack.enter_context(mock.patch.object(setup, "refuse_existing"))
            closed = stack.enter_context(mock.patch.object(setup.os, "close"))
            manual_inputs = ["12345", "Asia/Bangkok", "fixture_eva_socket"]
            stack.enter_context(mock.patch("builtins.input", side_effect=manual_inputs if argv == [] else AssertionError("No numeric ID prompt")))
            token = stack.enter_context(mock.patch.object(setup, "read_hidden_token", side_effect=lambda: events.append("token") or FAKE_TOKEN))
            def confirm(*_args):
                events.append("confirm")
                if pair_error:
                    raise pair_error
                return pair_result or {"owner_id": "12345", "expires_at": pairing.time.monotonic() + 100}
            paired = stack.enter_context(mock.patch.object(setup, "confirm_owner", side_effect=confirm))
            def save(*_args):
                events.append("save")
                if save_error:
                    raise save_error
            saved = stack.enter_context(mock.patch.object(setup, "save_configuration", side_effect=save))
            result = setup.main(self.ARGS if argv is None else argv)
        self.assertNotIn(FAKE_TOKEN, out.getvalue() + err.getvalue())
        return result, events, opened, locked, closed, token, paired, saved

    def test_token_first_then_confirm_then_exclusive_save_with_no_id_question(self):
        result, events, _, locked, closed, _, paired, saved = self.run_main()
        self.assertEqual(result, 0)
        self.assertEqual(events, ["token", "confirm", "save"])
        locked.assert_called_once_with(40)
        closed.assert_called_once_with(40)
        paired.assert_called_once_with(FAKE_TOKEN, "FixtureEvaBot")
        saved.assert_called_once_with(40, FAKE_TOKEN, "12345", "Asia/Bangkok", "fixture_eva_socket")

    def test_previous_manual_mode_stays_offline_and_does_not_pair(self):
        import pairing
        with mock.patch.object(pairing, "TelegramAPI") as api:
            result, events, _, _, _, _, paired, saved = self.run_main(argv=[])
        self.assertEqual(result, 0)
        self.assertEqual(events, ["token", "save"])
        paired.assert_not_called()
        api.assert_not_called()
        saved.assert_called_once_with(40, FAKE_TOKEN, "12345", "Asia/Bangkok", "fixture_eva_socket")

    def test_pairing_failure_or_abort_never_saves(self):
        for failure in (setup.SetupError("not confirmed"), EOFError(), KeyboardInterrupt()):
            with self.subTest(kind=type(failure).__name__):
                result, events, _, _, closed, _, _, saved = self.run_main(pair_error=failure)
                self.assertEqual(result, 1)
                self.assertEqual(events, ["token", "confirm"])
                saved.assert_not_called()
                closed.assert_called_once_with(40)

    def test_expiry_rechecked_immediately_before_save(self):
        result, _, _, _, closed, _, _, saved = self.run_main(pair_result={"owner_id": "12345", "expires_at": 0})
        self.assertEqual(result, 1)
        saved.assert_not_called()
        closed.assert_called_once_with(40)

    def test_lock_failure_before_token_or_network(self):
        result, events, _, _, closed, token, paired, saved = self.run_main(lock_error=setup.SetupError("locked"))
        self.assertEqual(result, 1)
        self.assertEqual(events, [])
        token.assert_not_called()
        paired.assert_not_called()
        saved.assert_not_called()
        closed.assert_called_once_with(40)

    def test_pairing_stdout_must_be_personal_tty(self):
        result, events, opened, _, _, _, _, _ = self.run_main(stdout_tty=False)
        self.assertEqual(result, 2)
        self.assertEqual(events, [])
        opened.assert_not_called()

    def test_write_failure_does_not_claim_success_or_expose_secret(self):
        result, _, _, _, closed, _, _, _ = self.run_main(save_error=OSError(FAKE_TOKEN))
        self.assertEqual(result, 1)
        closed.assert_called_once_with(40)

    def test_lock_uses_nonblocking_flock_and_does_not_create_lock_file(self):
        fake = SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=mock.Mock())
        with mock.patch.dict("sys.modules", {"fcntl": fake}):
            setup.lock_setup(40)
            fake.flock.assert_called_once_with(40, 6)
            fake.flock.side_effect = BlockingIOError(FAKE_TOKEN)
            with self.assertRaises(setup.SetupError) as error:
                setup.lock_setup(40)
        self.assertNotIn(FAKE_TOKEN, str(error.exception))

    def test_pairing_code_echo_fallback_stops(self):
        def warn(*_args, **_kwargs):
            setup.warnings.warn("no terminal", setup.getpass.GetPassWarning)
        with mock.patch.object(setup.getpass, "getpass", side_effect=warn):
            with self.assertRaises(setup.getpass.GetPassWarning):
                setup.read_pairing_code(30)

    def test_deadline_timer_interrupts_entire_pairing_and_is_restored(self):
        import pairing
        fake_signal = SimpleNamespace(ITIMER_REAL=0, SIGALRM=14,
                                      getitimer=mock.Mock(return_value=(0.0, 0.0)),
                                      signal=mock.Mock(return_value="prior"), setitimer=mock.Mock())
        with mock.patch.dict("sys.modules", {"signal": fake_signal}), \
             mock.patch.object(pairing, "TelegramAPI") as api, \
             mock.patch.object(pairing, "pair_owner", side_effect=pairing.PairingError("timeout")):
            with self.assertRaises(setup.SetupError):
                setup.confirm_owner(FAKE_TOKEN, "FixtureEvaBot")
        api.assert_called_once_with(FAKE_TOKEN)
        self.assertEqual(fake_signal.setitimer.call_args_list, [mock.call(0, 300), mock.call(0, 0)])
        self.assertEqual(fake_signal.signal.call_args_list[-1], mock.call(14, "prior"))
        handler = fake_signal.signal.call_args_list[0].args[1]
        with self.assertRaises(pairing.PairingError):
            handler(14, None)


if __name__ == "__main__":
    unittest.main()
