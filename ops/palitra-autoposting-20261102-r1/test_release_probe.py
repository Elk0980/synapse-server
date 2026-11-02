import copy
import hashlib
import importlib.util
import pathlib
import subprocess
import unittest

MODULE = pathlib.Path(__file__).with_name("release_probe.py")
loader = importlib.util.spec_from_file_location("palitra_release_probe", MODULE)
probe = importlib.util.module_from_spec(loader)
loader.loader.exec_module(probe)


class SourcePreservationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = subprocess.check_output(["git", "show", "4a3ae9c59288bf304e467948584d20c2b4756ed9:ops/crm/autoposting.js"])
        cls.feature = subprocess.check_output(["git", "show", "2e6152082d9f52e2f0fc3f03f48d2395d0d23550:ops/crm/autoposting.js"])

    def test_transfers_only_feature_and_preserves_existing_extension(self):
        source = b"// existing publication-copy extension must survive\n" + self.before
        spec = copy.deepcopy(probe.PATCH_SPEC)
        spec["actualRuntimeBeforeSha256"] = hashlib.sha256(source).hexdigest()
        result = probe.rebase(source, spec)
        self.assertEqual(result, b"// existing publication-copy extension must survive\n" + self.feature)

    def test_refuses_drift_before_any_patch(self):
        with self.assertRaisesRegex(probe.Refused, "CORE_CHANGED"):
            probe.rebase(self.before, probe.PATCH_SPEC)

    def test_refuses_duplicate_patch_context(self):
        spec = copy.deepcopy(probe.PATCH_SPEC)
        source = self.before + spec["patches"][0]["before"].encode()
        spec["actualRuntimeBeforeSha256"] = hashlib.sha256(source).hexdigest()
        with self.assertRaisesRegex(probe.Refused, "PATCH_CONTEXT_NOT_UNIQUE"):
            probe.rebase(source, spec)


if __name__ == "__main__":
    unittest.main()
