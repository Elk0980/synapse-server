import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import board_report as board


class BoardTests(unittest.TestCase):
    def test_success_is_reported_once_and_has_exact_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            status = {"phase": "pull", "result": "OK", "sha": "OK", "id": "synapse-20261104T010000Z", "bytes": 10, "receipt_sha": "a" * 64}
            calls = []
            def rpc(c, name, args):
                calls.append((name, args))
                return {} if name != "task_get" else {"comments": []}
            with patch.object(board, "rpc", side_effect=rpc):
                self.assertTrue(board.publish({"board_endpoint_file": "unused"}, tmp, status))
                self.assertTrue(board.publish({"board_endpoint_file": "unused"}, tmp, status))
            comments = [args for name, args in calls if name == "task_comment"]
            self.assertEqual(len(comments), 1)
            self.assertEqual(comments[0]["task_id"], 58)
            self.assertIn(board.ACK + json.dumps({"id": status["id"], "receipt_sha": "a" * 64}, sort_keys=True), comments[0]["text"])

    def test_unknown_delivery_is_read_back_not_repeated(self):
        with tempfile.TemporaryDirectory() as tmp:
            status = {"phase": "pull", "result": "ERROR", "error": "NO_SPACE_D"}
            calls = []
            def rpc(c, name, args):
                calls.append(name)
                if name == "task_comment":
                    raise TimeoutError("private-url-must-not-leak")
                return {"comments": []}
            with patch.object(board, "rpc", side_effect=rpc):
                self.assertFalse(board.publish({"board_endpoint_file": "unused"}, tmp, status))
                self.assertFalse(board.publish({"board_endpoint_file": "unused"}, tmp, status))
            self.assertEqual(calls.count("task_comment"), 1)
            saved = next((Path(tmp) / ".board-outbox").glob("*.json"))
            self.assertNotIn("private-url", saved.read_text(encoding="utf-8"))
            message = json.loads(saved.read_text(encoding="utf-8"))["text"]
            self.assertIn("нет места", message)
            with patch.object(board, "rpc", return_value={"comments": [{"author": board.AUTHOR, "text": message}]}):
                self.assertTrue(board.publish({"board_endpoint_file": "unused"}, tmp, status))

    def test_no_ack_on_failed_weekly_verify(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(board.publish({}, tmp, {"phase": "pull", "result": "ERROR", "sha": "OK", "id": "fixture", "error": "PULL_OR_VERIFY_FAILED"}))
            saved = json.loads(next((Path(tmp) / ".board-outbox").glob("*.json")).read_text(encoding="utf-8"))
            self.assertNotIn(board.ACK, saved["text"])

    def test_ack_requires_author_and_matching_receipt(self):
        message = board.ACK + json.dumps({"id": "fixture", "receipt_sha": "abc"})
        for author, digest, accepted in (("other", "abc", False), (board.AUTHOR, "wrong", False), (board.AUTHOR, "abc", True)):
            with patch.object(board, "comments", return_value=iter([{"author": author, "text": message}])):
                self.assertEqual(board.acknowledged({}, "fixture", digest), accepted)

    def test_report_endpoint_never_redirects_or_uses_http(self):
        with self.assertRaises(ValueError):
            board.NoRedirect().redirect_request(None, None, None, None, None, None)
        with tempfile.TemporaryDirectory() as tmp:
            endpoint = Path(tmp) / "url"
            endpoint.write_text("http://127.0.0.1/private")
            with self.assertRaises(ValueError):
                board.rpc({"board_endpoint_file": str(endpoint)}, "task_get", {"task_id": 58})
