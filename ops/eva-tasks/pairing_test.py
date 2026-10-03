"""Pairing contract tests. Synthetic Telegram only; no credentials or live network."""

import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import ssl
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("eva_pairing", Path(__file__).with_name("pairing.py"))
pairing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pairing)

BOT_ID = 111111111
BOT_USERNAME = "EvaFixtureBot"
OWNER = 731000001
OTHER = 731000002
NONCE = "n" * 32
CODE = "A1B2C3D4E5"
TOKEN = str(BOT_ID) + ":" + "fixture_" * 5
COMMAND = "/start eva_" + NONCE


class Clock:
    def __init__(self, value=100.0):
        self.value = value

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


def message(update_id=10, owner=OWNER, text=COMMAND):
    return {
        "update_id": update_id,
        "message": {
            "message_id": update_id + 100,
            "date": 1800000000,
            "from": {"id": owner, "is_bot": False, "first_name": "Fixture"},
            "chat": {"id": owner, "type": "private"},
            "text": text,
        },
    }


class TelegramFixture:
    def __init__(self, clock, batches=None):
        self.clock = clock
        self.batches = list(batches if batches is not None else [[message()], []])
        self.identity = {"id": BOT_ID, "is_bot": True, "username": BOT_USERNAME}
        self.webhook = {"url": ""}
        self.calls = []

    def __call__(self, method, params=None):
        params = copy.deepcopy(params or {})
        self.calls.append((method, params))
        if method == "getMe":
            return copy.deepcopy(self.identity)
        if method == "getWebhookInfo":
            return copy.deepcopy(self.webhook)
        if method == "getUpdates":
            self.clock.advance(1)
            if self.batches:
                result = self.batches.pop(0)
                if isinstance(result, BaseException):
                    raise result
                return copy.deepcopy(result)
            self.clock.advance(10)
            return []
        if method == "sendMessage":
            return {"message_id": 999, "chat": {"id": params["chat_id"], "type": "private"}}
        raise AssertionError("Unexpected transport method")


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.links = []
        self.transport = TelegramFixture(self.clock)
        patcher = mock.patch("socket.create_connection", side_effect=AssertionError("Live network forbidden"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def pair(self, confirm=None, **changes):
        options = dict(
            show_link=self.links.append,
            confirm_code=confirm or (lambda remaining: CODE),
            clock=self.clock,
            nonce_factory=lambda: NONCE,
            code_factory=lambda: CODE,
        )
        options.update(changes)
        return pairing.pair_owner(self.transport, BOT_USERNAME, BOT_ID, **options)

    def sent(self):
        return [params for method, params in self.transport.calls if method == "sendMessage"]

    def test_success_needs_hidden_confirmation_then_acknowledges_only_candidate(self):
        self.transport.batches = [[message(10), message(11, OTHER)], [message(11, OTHER)]]
        confirmations = []

        def confirm(remaining):
            self.assertGreater(remaining, 0)
            self.assertLessEqual(remaining, 300)
            self.assertEqual(len(self.sent()), 1)
            self.assertEqual(self.sent()[0]["chat_id"], OWNER)
            confirmations.append(remaining)
            return CODE

        result = self.pair(confirm)
        self.assertEqual(result, {"owner_id": str(OWNER), "expires_at": 400.0})
        self.assertEqual(len(confirmations), 1)
        self.assertEqual(len(self.links), 1)
        self.assertIn("https://t.me/", self.links[0])
        self.assertIn("start=eva_" + NONCE, self.links[0])
        self.assertNotIn(TOKEN, self.links[0])
        self.assertIn(CODE, self.sent()[0]["text"])
        self.assertNotIn(NONCE, self.sent()[0]["text"])
        method, acknowledgement = self.transport.calls[-1]
        self.assertEqual(method, "getUpdates")
        self.assertEqual(acknowledgement["offset"], 11)
        self.assertEqual(acknowledgement["timeout"], 0)
        self.assertEqual(acknowledgement["limit"], 50)
        self.assertEqual(acknowledgement["allowed_updates"], ["message"])
        self.assertEqual(len(self.sent()), 1)

    def test_wrong_nonce_sender_before_owner_is_not_selected(self):
        self.transport.batches = [[message(3, OTHER, "/start"), message(4, OTHER, "/start eva_wrong")],
                                  [message(7)], []]
        self.assertEqual(self.pair()["owner_id"], str(OWNER))
        self.assertEqual([entry["chat_id"] for entry in self.sent()], [OWNER])
        polling = [params for method, params in self.transport.calls if method == "getUpdates"]
        self.assertEqual(polling[1]["offset"], 5)

    def test_invalid_message_shapes_never_become_candidate(self):
        variants = []
        for field, value in (("type", "group"), ("type", "supergroup"), ("id", OTHER)):
            candidate = message(1, OTHER)
            candidate["message"]["chat"][field] = value if field != "id" else OWNER
            variants.append(candidate)
        for field, value in (("id", True), ("id", 0), ("id", -1), ("id", "123"),
                             ("id", 2**53), ("is_bot", True), ("is_bot", "false")):
            candidate = message(1, OTHER)
            candidate["message"]["from"][field] = value
            variants.append(candidate)
        for field in ("forward_origin", "forward_from", "forward_from_chat", "forward_date", "forward_sender_name",
                      "is_automatic_forward", "via_bot", "sender_chat", "edit_date", "business_connection_id"):
            candidate = message(1, OTHER)
            candidate["message"][field] = 1800000000 if field.endswith("date") else "Untrusted"
            variants.append(candidate)
        candidate = message(1, OTHER)
        variants.append({"update_id": 1, "edited_message": candidate["message"]})
        variants.append({"update_id": 1, "callback_query": {"from": {"id": OTHER}, "data": COMMAND}})
        candidate = message(1, OTHER)
        del candidate["message"]["from"]
        variants.append(candidate)
        for invalid in variants:
            with self.subTest(invalid=invalid):
                self.transport = TelegramFixture(self.clock, [[invalid, message(2)], []])
                self.assertEqual(self.pair()["owner_id"], str(OWNER))
                self.assertEqual([entry["chat_id"] for entry in self.sent()], [OWNER])

    def test_start_payload_must_match_exactly(self):
        for invalid in (COMMAND + " ", COMMAND + "\n", " " + COMMAND, COMMAND + "suffix",
                        "/start@OtherBot eva_" + NONCE, "/tasks", "/start eva_" + "x" * 32):
            with self.subTest(payload=invalid):
                self.transport = TelegramFixture(self.clock, [[message(1, OTHER, invalid), message(2)], []])
                self.assertEqual(self.pair()["owner_id"], str(OWNER))
                self.assertEqual([entry["chat_id"] for entry in self.sent()], [OWNER])

    def test_wrong_confirmation_does_not_return_or_acknowledge(self):
        for code in ("", "0000000000", CODE + "suffix", CODE + "\n", "А1Б2В3Г4Д5"):
            with self.subTest(code=code):
                self.transport = TelegramFixture(self.clock)
                with self.assertRaises(pairing.PairingError):
                    self.pair(lambda remaining: code)
                self.assertEqual(len(self.sent()), 1)
                self.assertEqual(self.transport.calls[-1][0], "sendMessage")

    def test_confirmation_expiry_is_checked_after_blocking_input(self):
        def late_confirmation(remaining):
            self.clock.advance(301)
            return CODE
        with self.assertRaises(pairing.PairingError):
            self.pair(late_confirmation)
        self.assertEqual(self.transport.calls[-1][0], "sendMessage")

    def test_no_candidate_times_out_without_sending_or_confirming(self):
        self.transport.batches = []
        confirmation = mock.Mock(return_value=CODE)
        with self.assertRaises(pairing.PairingError):
            self.pair(confirmation)
        confirmation.assert_not_called()
        self.assertEqual(self.sent(), [])
        self.assertLess(len(self.transport.calls), 40)

    def test_replayed_update_and_previous_attempt_nonce_are_ignored(self):
        self.transport.batches = [[message(10, OTHER, "/start eva_" + "x" * 32)],
                                  [message(9, OTHER), message(20)], []]
        self.assertEqual(self.pair()["owner_id"], str(OWNER))
        self.assertEqual([entry["chat_id"] for entry in self.sent()], [OWNER])

    def test_invalid_poll_response_stops_before_delivery_and_confirmation(self):
        for response in (None, {}, [None], [{"update_id": True}], [{"update_id": -1}],
                         [{"update_id": 2**53}], [message(index) for index in range(51)]):
            with self.subTest(response_type=type(response).__name__):
                self.transport = TelegramFixture(self.clock, [response])
                confirmation = mock.Mock(return_value=CODE)
                with self.assertRaises(pairing.PairingError):
                    self.pair(confirmation)
                confirmation.assert_not_called()
                self.assertEqual(self.sent(), [])

    def test_failed_or_mismatched_delivery_never_reaches_confirmation(self):
        invalid = [pairing.PairingError("fixture failure"), None, {},
                   {"message_id": 9, "chat": {"id": OTHER, "type": "private"}},
                   {"message_id": 9, "chat": {"id": OWNER, "type": "group"}}]
        for delivery in invalid:
            with self.subTest(delivery=delivery):
                delegate = TelegramFixture(self.clock)

                def transport(method, params=None):
                    result = delegate(method, params)
                    if method == "sendMessage":
                        if isinstance(delivery, BaseException):
                            raise delivery
                        return delivery
                    return result

                self.transport = transport
                confirmation = mock.Mock(return_value=CODE)
                with self.assertRaises(pairing.PairingError):
                    self.pair(confirmation)
                confirmation.assert_not_called()
                self.assertEqual([name for name, _ in delegate.calls].count("sendMessage"), 1)
                self.assertEqual(delegate.calls[-1][0], "sendMessage")

    def test_slow_delivery_cannot_confirm_expired_challenge(self):
        delegate = self.transport

        def transport(method, params=None):
            result = delegate(method, params)
            if method == "sendMessage":
                self.clock.advance(301)
            return result

        self.transport = transport
        confirmation = mock.Mock(return_value=CODE)
        with self.assertRaises(pairing.PairingError):
            self.pair(confirmation)
        confirmation.assert_not_called()

    def test_invalid_generated_challenge_or_code_is_never_shown_or_sent(self):
        for nonce, code in (("short", CODE), (NONCE, "123"), (NONCE, "abcdefghij"),
                            (TOKEN, CODE), (NONCE, TOKEN)):
            with self.subTest(nonce_length=len(nonce), code_length=len(code)):
                self.transport = TelegramFixture(self.clock)
                self.links.clear()
                with self.assertRaises(pairing.PairingError):
                    self.pair(nonce_factory=lambda: nonce, code_factory=lambda: code)
                self.assertEqual(self.links, [])
                self.assertEqual(self.sent(), [])

    def test_confirmation_interrupt_does_not_acknowledge(self):
        for failure in (EOFError(), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__):
                self.transport = TelegramFixture(self.clock)
                with self.assertRaises((pairing.PairingError, EOFError, KeyboardInterrupt)):
                    self.pair(mock.Mock(side_effect=failure))
                self.assertEqual(self.transport.calls[-1][0], "sendMessage")

    def test_username_matching_is_case_insensitive(self):
        self.transport.identity["username"] = BOT_USERNAME.swapcase()
        self.assertEqual(self.pair()["owner_id"], str(OWNER))

    def test_bot_identity_mismatch_stops_before_polling(self):
        variants = [None, {}, {"id": BOT_ID, "is_bot": True, "username": "OtherFixtureBot"},
                    {"id": BOT_ID + 1, "is_bot": True, "username": BOT_USERNAME},
                    {"id": BOT_ID, "is_bot": False, "username": BOT_USERNAME},
                    {"id": str(BOT_ID), "is_bot": True, "username": BOT_USERNAME}]
        for identity in variants:
            with self.subTest(identity=identity):
                self.transport = TelegramFixture(self.clock)
                self.transport.identity = identity
                with self.assertRaises(pairing.PairingError):
                    self.pair()
                self.assertNotIn("getUpdates", [name for name, _ in self.transport.calls])
                self.assertEqual(self.sent(), [])

    def test_webhook_present_or_invalid_is_not_deleted_or_polled(self):
        for webhook in ({"url": "https://fixture.invalid/secret"}, {}, None, {"url": None}):
            with self.subTest(webhook=webhook):
                self.transport = TelegramFixture(self.clock)
                self.transport.webhook = webhook
                with self.assertRaises(pairing.PairingError):
                    self.pair()
                self.assertEqual([name for name, _ in self.transport.calls], ["getMe", "getWebhookInfo"])

    def test_acknowledgement_failure_or_malformed_response_prevents_success(self):
        for response in (pairing.PairingError("fixture failure"), None, {}, [None],
                         [{"update_id": True}], [{"update_id": -1}], [{"update_id": 2**53}]):
            with self.subTest(response=response):
                self.transport = TelegramFixture(self.clock, [[message()], response])
                with self.assertRaises(pairing.PairingError):
                    self.pair()
                self.assertEqual(len(self.sent()), 1)

    def test_expiry_during_acknowledgement_prevents_success(self):
        delegate = self.transport

        def transport(method, params=None):
            result = delegate(method, params)
            if method == "getUpdates" and params.get("timeout") == 0:
                self.clock.advance(301)
            return result

        self.transport = transport
        with self.assertRaises(pairing.PairingError):
            self.pair()

    def test_update_budget_stops_without_unbounded_polling(self):
        self.transport.batches = [[message(index, OTHER, "/start wrong") for index in range(start, start + 50)]
                                  for start in range(0, 1100, 50)]
        with self.assertRaises(pairing.PairingError):
            self.pair()
        self.assertEqual(self.sent(), [])
        polls = [params for method, params in self.transport.calls if method == "getUpdates"]
        self.assertLessEqual(len(polls), 21)

    def test_helper_does_not_print_nonce_code_chat_or_token(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = self.pair()
        self.assertEqual(result["owner_id"], str(OWNER))
        self.assertEqual(out.getvalue() + err.getvalue(), "")

    def test_freshness_boundary(self):
        pairing.ensure_fresh(101.0, clock=self.clock)
        for deadline in (100.0, 99.0):
            with self.subTest(deadline=deadline), self.assertRaises(pairing.PairingError):
                pairing.ensure_fresh(deadline, clock=self.clock)


class HTTPResponseFixture:
    def __init__(self, *, status=200, body=None, headers=None):
        self.status = status
        self.body = io.BytesIO(body if body is not None else b'{"ok":true,"result":{"id":111111111}}')
        self.headers = headers or {"Content-Type": "application/json"}
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        return self.body.read(size)

    def getheader(self, name, default=None):
        return next((value for key, value in self.headers.items() if key.lower() == name.lower()), default)


class HTTPConnectionFixture:
    def __init__(self, response=None, failure=None):
        self.response = response or HTTPResponseFixture()
        self.failure = failure
        self.requests = []
        self.closed = False

    def request(self, method, url, body=None, headers=None, **kwargs):
        self.requests.append((method, url, body, headers or {}))
        if self.failure:
            raise self.failure

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class TelegramAPITests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch("socket.create_connection", side_effect=AssertionError("Live network forbidden"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def api(self, response=None, failure=None):
        self.connection = HTTPConnectionFixture(response, failure)
        self.factory = mock.Mock(return_value=self.connection)
        return pairing.TelegramAPI(TOKEN, connection_factory=self.factory)

    def test_fixed_https_host_post_json_and_connection_cleanup(self):
        api = self.api()
        self.assertEqual(api("getMe"), {"id": BOT_ID})
        args, kwargs = self.factory.call_args
        self.assertEqual(args[0] if args else kwargs["host"], "api.telegram.org")
        self.assertEqual(args[1] if len(args) > 1 else kwargs.get("port", 443), 443)
        self.assertGreater(kwargs["timeout"], 0)
        self.assertLessEqual(kwargs["timeout"], 30)
        self.assertEqual(kwargs["context"].verify_mode, ssl.CERT_REQUIRED)
        self.assertIs(kwargs["context"].check_hostname, True)
        method, path, body, headers = self.connection.requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/bot" + TOKEN + "/getMe")
        self.assertEqual(json.loads(body), {})
        self.assertEqual({key.lower(): value for key, value in headers.items()}["content-type"], "application/json")
        self.assertTrue(self.connection.closed)

    def test_only_four_pairing_methods_are_allowed(self):
        api = self.api()
        for method in ("getMe", "getWebhookInfo", "getUpdates", "sendMessage"):
            self.assertEqual(api(method), {"id": BOT_ID})
            self.connection.response = HTTPResponseFixture()
        for method in ("deleteWebhook", "setWebhook", "getFile", "getChat", "../getMe",
                       "https://fixture.invalid/", "getMe?token=" + TOKEN):
            self.factory.reset_mock()
            with self.subTest(method=method), self.assertRaises(pairing.PairingError) as raised:
                api(method)
            self.factory.assert_not_called()
            self.assertNotIn(TOKEN, str(raised.exception))

    def test_deadline_alarm_during_connection_cleanup_is_not_swallowed(self):
        api = self.api()
        with mock.patch.object(self.connection, "close", side_effect=pairing.PairingError("deadline")):
            with self.assertRaises(pairing.PairingError):
                api("getMe")

    def test_redirect_and_http_errors_are_not_followed_or_retried(self):
        for status in (301, 302, 307, 308, 401, 409, 429, 500):
            response = HTTPResponseFixture(status=status, body=TOKEN.encode(),
                                           headers={"Location": "https://fixture.invalid/" + TOKEN})
            api = self.api(response)
            with self.subTest(status=status), self.assertRaises(pairing.PairingError) as raised:
                api("getUpdates")
            self.factory.assert_called_once()
            self.assertEqual(len(self.connection.requests), 1)
            self.assertTrue(self.connection.closed)
            self.assertNotIn(TOKEN, str(raised.exception))

    def test_transport_error_does_not_echo_secret_or_request_url(self):
        for error in (OSError("https://api.telegram.org/bot" + TOKEN), TimeoutError(TOKEN)):
            api = self.api(failure=error)
            with self.subTest(error=type(error).__name__), self.assertRaises(pairing.PairingError) as raised:
                api("getMe")
            self.assertNotIn(TOKEN, str(raised.exception))
            self.assertNotIn("api.telegram.org", str(raised.exception))
            self.assertTrue(self.connection.closed)

    def test_connection_construction_and_response_read_errors_are_redacted(self):
        factory = mock.Mock(side_effect=OSError(TOKEN))
        api = pairing.TelegramAPI(TOKEN, connection_factory=factory)
        with self.assertRaises(pairing.PairingError) as raised:
            api("getMe")
        self.assertNotIn(TOKEN, str(raised.exception))
        for operation in ("getresponse", "read"):
            api = self.api()
            target = self.connection if operation == "getresponse" else self.connection.response
            with self.subTest(operation=operation), \
                 mock.patch.object(target, operation, side_effect=OSError(TOKEN)), \
                 self.assertRaises(pairing.PairingError) as raised:
                api("getMe")
            self.assertNotIn(TOKEN, str(raised.exception))
            self.assertTrue(self.connection.closed)

    def test_bad_json_envelopes_and_telegram_errors_are_static(self):
        bodies = [b"not JSON", b"\xff", b"[]", b"null", b"{}", b'{"ok":true}',
                  b'{"ok":1,"result":{}}', json.dumps({"ok": False, "error_code": 409, "description": TOKEN}).encode()]
        for body in bodies:
            api = self.api(HTTPResponseFixture(body=body))
            with self.subTest(body=body[:30]), self.assertRaises(pairing.PairingError) as raised:
                api("getMe")
            self.assertNotIn(TOKEN, str(raised.exception))
            self.assertTrue(self.connection.closed)

    def test_response_body_size_is_bounded_before_json_parsing(self):
        response = HTTPResponseFixture(body=b" " * 262145)
        api = self.api(response)
        with self.assertRaises(pairing.PairingError):
            api("getUpdates")
        self.assertTrue(response.read_sizes)
        self.assertTrue(all(0 < size <= 262145 for size in response.read_sizes))
        self.assertTrue(self.connection.closed)


if __name__ == "__main__":
    unittest.main()
