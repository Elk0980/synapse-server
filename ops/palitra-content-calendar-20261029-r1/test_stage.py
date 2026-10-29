"""Exercise the actual stage contract using only in-memory HTTP fixtures."""
import importlib.util, io, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('calendar_stage',Path(__file__).with_name('install.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class StageTest(unittest.TestCase):
    def test_actual_manifest_stages_and_missing_helper_pin_writes_nothing(self):
        package=Path(__file__).parent
        raw=(package/'manifest.json').read_bytes()
        manifest=json.loads(raw)
        self.assertEqual(manifest['helperSha256'],m.sha(m.SELF.read_bytes()))
        def response(url,timeout):
            suffix=url.split('/ops/'+m.NAME+'/',1)[1]
            return io.BytesIO((package/suffix).read_bytes())
        with tempfile.TemporaryDirectory() as temp:
            area=Path(temp)/'stage'
            with patch.object(m,'AREA',area),patch.object(m.urllib.request,'urlopen',side_effect=response):
                m.stage('a'*40,m.sha(raw))
                self.assertTrue((area/'stage.json').is_file())
                for row in manifest['targets']:
                    self.assertEqual(m.sha((area/'payload'/row['target']).read_bytes()),row['afterSha256'])
            area2=Path(temp)/'refused'
            bad={**manifest};del bad['helperSha256'];badraw=json.dumps(bad).encode()
            with patch.object(m,'AREA',area2),patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(badraw)):
                with self.assertRaises(KeyError):m.stage('a'*40,m.sha(badraw))
                self.assertFalse(area2.exists())

if __name__=='__main__':unittest.main()
