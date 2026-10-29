"""Offline stage fixtures for the exact three existing smooth-calendar targets."""
import importlib.util, io, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('calendar_smooth_stage',Path(__file__).with_name('install.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class StageTest(unittest.TestCase):
    def test_exact_scope_and_helper_pin_stage_without_touching_production(self):
        rows=[{'target':target,'beforeSha256':'0'*64,'afterSha256':m.sha(('after-'+str(index)).encode())} for index,target in enumerate(m.SCOPE)]
        manifest={'packageId':m.NAME,'helperSha256':m.sha(m.SELF.read_bytes()),'targets':rows}
        raw=m.enc(manifest)
        files={'manifest.json':raw,**{'payload/'+target:('after-'+str(index)).encode() for index,target in enumerate(m.SCOPE)}}
        def response(url,timeout):
            return io.BytesIO(files[url.split('/ops/'+m.NAME+'/',1)[1]])
        with tempfile.TemporaryDirectory() as temp:
            area=Path(temp)/'staged'
            with patch.object(m,'AREA',area),patch.object(m.urllib.request,'urlopen',side_effect=response):
                m.stage('a'*40,m.sha(raw))
                self.assertTrue((area/'stage.json').is_file())
                for row in rows:self.assertEqual(m.sha((area/'payload'/row['target']).read_bytes()),row['afterSha256'])
            refused=Path(temp)/'refused'
            bad={**manifest};del bad['helperSha256'];badraw=m.enc(bad)
            with patch.object(m,'AREA',refused),patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(badraw)):
                with self.assertRaises(KeyError):m.stage('a'*40,m.sha(badraw))
                self.assertFalse(refused.exists())

    def test_new_or_old_scope_not_accepted(self):
        rows=[{'target':target,'beforeSha256':'0'*64,'afterSha256':'1'*64} for target in m.SCOPE]
        rows[-1]['target']='sites/synapse/cabinet/palitra-orders/native-host.js'
        raw=m.enc({'packageId':m.NAME,'helperSha256':m.sha(m.SELF.read_bytes()),'targets':rows})
        with tempfile.TemporaryDirectory() as temp:
            area=Path(temp)/'refused'
            with patch.object(m,'AREA',area),patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(raw)):
                with self.assertRaisesRegex(ValueError,'EXACT_THREE_FILES_REQUIRED'):m.stage('a'*40,m.sha(raw))
                self.assertFalse(area.exists())

if __name__=='__main__':unittest.main()
