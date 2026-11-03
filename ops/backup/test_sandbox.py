import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import sandbox


@unittest.skipIf(os.name == "nt", "Linux Docker command fixture")
class SandboxTests(unittest.TestCase):
    def test_cabinet_probe_is_required_and_cleanup_on_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "VERIFIED.json").write_text("{}")
            (root / "containers.json").write_text(json.dumps([
                {"Name": "/crm", "Image": "fixture-crm", "Config": {}, "Mounts": []},
                {"Name": "/caddy", "Image": "fixture-caddy", "Config": {}, "Mounts": []}]))
            for fail in (False, True):
                calls = []
                def run(args, **kw):
                    calls.append(args)
                    if fail and any("cabinet.html" in arg for arg in args):
                        raise RuntimeError("cabinet unavailable")
                with patch.object(sandbox, "run", side_effect=run), patch.object(sandbox.sp, "run", return_value=type("OK", (), {"returncode": 0})()), patch.dict(os.environ, {"SYNAPSE_RESTORE_SITE_PATH": "fixture"}):
                    if fail:
                        with self.assertRaises(RuntimeError):
                            sandbox.main(root)
                    else:
                        sandbox.main(root)
                        self.assertTrue(json.loads((root / "SANDBOX_OK.json").read_text())["cabinet"])
                        (root / "SANDBOX_OK.json").unlink()
                self.assertTrue(any(any("cabinet.html" in arg for arg in args) for args in calls))
                self.assertEqual(sum(args[1:3] == ["rm", "-f"] for args in calls), 2)
                for args in calls:
                    if args[1] == "create":
                        self.assertEqual(args[args.index("--network") + 1], "none")
                        self.assertNotIn("-p", args)
                self.assertFalse((root / "SANDBOX_OK.json").exists())
