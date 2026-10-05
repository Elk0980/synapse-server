import base64
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile

import build_package as builder


class PackageBuildTests(unittest.TestCase):
    def setUp(self):
        self.files = {"PACKAGE_README.md": b"Preparation only\n", "ops/eva-tasks/setup.py": b"# reviewed\n"}
        self.template = b"def main():\n    return 0\n"
        self.sha = "a" * 40

    def test_reproducible_order_independent_and_uncompressed(self):
        first = builder.render_artifacts(self.files, self.template, self.sha)
        second = builder.render_artifacts(dict(reversed(list(self.files.items()))), self.template, self.sha)
        self.assertEqual(first, second)
        archive = zipfile.ZipFile(io.BytesIO(first["eva-prepare-aaaaaaaaaaaa.zip"]))
        self.assertEqual(archive.namelist(), sorted(self.files))
        for info in archive.infolist():
            self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
            self.assertEqual(info.compress_type, zipfile.ZIP_STORED)
            self.assertEqual(archive.read(info), self.files[info.filename])

    def test_checksum_command_covers_exact_delivered_executable(self):
        artifacts = builder.render_artifacts(self.files, self.template, self.sha)
        name = "eva-prepare-aaaaaaaaaaaa.py"
        digest = hashlib.sha256(artifacts[name]).hexdigest()
        self.assertIn(digest, artifacts["COMMAND.txt"].decode())
        self.assertIn("&& python3 '" + name + "' --prepare", artifacts["COMMAND.txt"].decode())
        for line in artifacts["SHA256SUMS"].decode().splitlines():
            expected, filename = line.split("  ", 1)
            self.assertEqual(expected, hashlib.sha256(artifacts[filename]).hexdigest())

    def test_standalone_contains_matching_manifest_and_archive(self):
        artifacts = builder.render_artifacts(self.files, self.template, self.sha)
        scope = {"__name__": "fixture_package"}
        exec(compile(artifacts["eva-prepare-aaaaaaaaaaaa.py"], "fixture_package", "exec"), scope)
        self.assertEqual(scope["PACKAGE_METADATA"], json.loads(artifacts["MANIFEST.json"]))
        payload = base64.b64decode(scope["PAYLOAD_B64"], validate=True)
        self.assertEqual(payload, artifacts["eva-prepare-aaaaaaaaaaaa.zip"])
        self.assertEqual(scope["PAYLOAD_SHA256"], builder.sha256(payload))

    def test_full_source_sha_required(self):
        for source in ("main", "a" * 7, "a" * 39 + "'", "A" * 40):
            with self.subTest(source=source), self.assertRaises(ValueError):
                builder.render_artifacts(self.files, self.template, source)

    def test_builder_reads_only_pinned_allowlist_and_explicit_patch(self):
        calls = []
        def fake_git(root, *args):
            calls.append(args)
            if args[0] == "show":
                if args[-1].endswith("/build_package.py"):
                    return Path(builder.__file__).read_bytes()
                return self.template if args[-1].endswith("package_bootstrap.py") else b"source\n"
            return b"patch\n"
        with mock.patch.object(builder, "git", side_effect=fake_git):
            artifacts = builder.build(Path("."), self.sha)
        self.assertTrue(artifacts)
        reads = [args[1] for args in calls if args[0] == "show"]
        expected = {builder.INTEGRATED_SHA + ":" + path for path in builder.ORIGINAL_FILES}
        expected.update(self.sha + ":ops/eva-tasks/" + name for name in ("PACKAGE_README.md", "package_bootstrap.py", "build_package.py"))
        self.assertEqual(set(reads), expected)
        patch = next(args for args in calls if args[0] == "diff")
        self.assertIn(builder.MAIN_SHA, patch)
        self.assertIn(builder.INTEGRATED_SHA, patch)
        for option in ("--no-textconv", "--full-index", "--unified=3", "--inter-hunk-context=0", "--src-prefix=a/", "--dst-prefix=b/", "--diff-algorithm=myers", "--no-indent-heuristic"):
            self.assertIn(option, patch)
        self.assertFalse(any(".env" in path or "telegram-token" in path for path in builder.ORIGINAL_FILES))

    def test_mismatched_builder_cannot_claim_requested_commit(self):
        with mock.patch.object(builder, "git", return_value=b"different builder"), self.assertRaises(ValueError):
            builder.build(Path("."), self.sha)

    def test_patch_is_independent_of_user_git_diff_preferences(self):
        root = Path(__file__).resolve().parents[2]
        baseline = builder.integration_patch(root)
        preferences = {
            "diff.context": "0", "diff.interHunkContext": "20",
            "diff.algorithm": "histogram", "diff.mnemonicPrefix": "true",
            "diff.noprefix": "true", "diff.indentHeuristic": "true", "core.abbrev": "5",
        }
        environment = {"GIT_CONFIG_COUNT": str(len(preferences)), "GIT_DIFF_OPTS": "--unified=0"}
        for index, (key, value) in enumerate(preferences.items()):
            environment["GIT_CONFIG_KEY_" + str(index)] = key
            environment["GIT_CONFIG_VALUE_" + str(index)] = value
        with mock.patch.dict(os.environ, environment):
            self.assertEqual(baseline, builder.integration_patch(root))

    def test_existing_delivery_and_unrelated_key_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            output = directory / "delivery"
            output.mkdir()
            key = output / ".env"
            key.write_bytes(b"SYNTHETIC_EXISTING_CRM_KEY=keep\n")
            with self.assertRaises(FileExistsError):
                builder.write_artifacts(output, {"new.py": b"source"})
            self.assertEqual(key.read_bytes(), b"SYNTHETIC_EXISTING_CRM_KEY=keep\n")
            self.assertEqual(list(output.iterdir()), [key])


if __name__ == "__main__":
    unittest.main()
