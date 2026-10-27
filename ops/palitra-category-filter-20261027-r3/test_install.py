"""Offline filesystem tests only: no production commands or access."""
from pathlib import Path
import importlib.util, json, tempfile, unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bounded_static_install', Path(__file__).with_name('install.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class StaticInstallTest(unittest.TestCase):
    def test_mount_order_is_ignored_but_all_mount_values_are_checked(self):
        first={'Type':'bind','Source':'/one','Destination':'/app','RW':False}
        second={'Type':'volume','Name':'data','Source':'/volume','Destination':'/data','RW':True}
        self.assertEqual(m.mount_digest([first,second]),m.mount_digest([second,first]))
        self.assertNotEqual(m.mount_digest([first,second]),m.mount_digest([first,{**second,'RW':False}]))
        self.assertNotEqual(m.mount_digest([first,second]),m.mount_digest([first,{**second,'Source':'/another'}]))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.area = self.root/'releases'/m.NAME
        self.area.mkdir(parents=True)
        self.patches = [patch.object(m,'ROOT',self.root),patch.object(m,'AREA',self.area),
                        patch.object(m,'lease',return_value={'pid':123,'startTicks':'456'}),
                        patch.object(m,'environment',return_value={'priceVersion':83,'priceSha256':'fixture'})]
        for p in self.patches: p.start()
        self.rows=[]
        for index,name in enumerate(m.SCOPE):
            target=self.root/name;target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(('before-'+str(index)).encode())
            payload=self.area/'payload'/name;payload.parent.mkdir(parents=True,exist_ok=True)
            payload.write_bytes(('after-'+str(index)).encode())
            self.rows.append({'target':name,'beforeSha256':m.sha(target.read_bytes()),'afterSha256':m.sha(payload.read_bytes())})
        self.foreign=self.root/'sites/synapse/unrelated.js';self.foreign.write_bytes(b'preserve')
        manifest={'packageId':m.NAME,'targets':self.rows}
        m.write_new(self.area/'manifest.json',m.enc(manifest))
        m.write_new(self.area/'stage.json',m.enc({'commit':'a'*40,'helperSha256':m.sha(m.SELF.read_bytes()),'manifestSha256':m.sha((self.area/'manifest.json').read_bytes())}))

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()

    def test_backup_apply_readback_preserve_unrelated_and_refuse_repeat(self):
        m.prepare()
        with patch.object(m.os,'chown',create=True): m.apply()
        for r in self.rows:
            self.assertEqual(m.sha((self.root/r['target']).read_bytes()),r['afterSha256'])
            self.assertEqual(m.sha((self.area/'backup'/r['target']).read_bytes()),r['beforeSha256'])
        self.assertEqual(self.foreign.read_bytes(),b'preserve')
        self.assertTrue((self.area/'installed.json').is_file())
        with self.assertRaisesRegex(ValueError,'ONE_ATTEMPT'): m.apply()

    def test_changed_target_refuses_before_first_write(self):
        m.prepare()
        (self.root/m.SCOPE[1]).write_bytes(b'newer-writer')
        with self.assertRaisesRegex(ValueError,'CAS_TARGET_CHANGED'): m.apply()
        self.assertEqual(m.sha((self.root/m.SCOPE[0]).read_bytes()),self.rows[0]['beforeSha256'])
        self.assertFalse((self.area/'apply-attempt.json').exists())

    def test_changed_environment_refuses_before_first_write(self):
        m.prepare()
        with patch.object(m,'environment',return_value={'priceVersion':84,'priceSha256':'newer'}):
            with self.assertRaisesRegex(ValueError,'ENVIRONMENT_OR_PRICE_CHANGED'): m.apply()
        self.assertFalse((self.area/'apply-attempt.json').exists())

    def test_extra_payload_refused(self):
        (self.area/'payload/foreign.js').write_bytes(b'extra')
        with self.assertRaisesRegex(ValueError,'CLOSED_PAYLOAD'): m.prepare()
        self.assertFalse((self.area/'backup').exists())

    def test_changed_backup_refused(self):
        m.prepare()
        (self.area/'backup'/m.SCOPE[0]).write_bytes(b'damaged')
        with self.assertRaisesRegex(ValueError,'BACKUP_CHANGED'): m.apply()
        self.assertFalse((self.area/'apply-attempt.json').exists())

    def test_expired_action_refused(self):
        m.prepare()
        action=m.read_json(self.area/'action.json');action['expires']=0
        (self.area/'action.json').write_bytes(m.enc(action))
        with self.assertRaisesRegex(ValueError,'FRESH_ACTION'): m.apply()
        self.assertFalse((self.area/'apply-attempt.json').exists())

if __name__=='__main__': unittest.main()
