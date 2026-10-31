from pathlib import Path
from unittest.mock import patch
import ast,hashlib,importlib.util,unittest
HERE=Path(__file__).resolve().parent
OLD=HERE.parent/'palitra-auth-chat-managed-20261031-r7'
MAIN=HERE.parent/'palitra-auth-chat-production-20261031-r7'
def module(path,name):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
class LFDelivery(unittest.TestCase):
 def test_only_actual_browser_normalization_and_three_constants_changed(self):
  original=(MAIN/'source-proof/storefront-after.js').read_bytes();actual=(HERE/'storefront-after.js').read_bytes();self.assertEqual(actual,original.replace(b'\r\n',b'\n'));self.assertEqual(original.count(b'\r'),1063);self.assertEqual(actual.count(b'\r'),0);self.assertEqual(len(actual),81128);self.assertEqual(hashlib.sha256(actual).hexdigest(),'e564f807d1de31c2d9fd1a0f89581afd52a57042ce5b8a444aa3fa8ae793c5e8')
  expected=(OLD/'verify.py').read_bytes().replace(b"NAME='palitra-auth-chat-managed-20261031-r7'",b"NAME='palitra-auth-chat-managed-20261031-r7-lf'").replace(b"AFTER='eb5e683f1a69f5a8fcc417df219b74368da36eb668c5ee9e4a90d43956c09670'",b"AFTER='e564f807d1de31c2d9fd1a0f89581afd52a57042ce5b8a444aa3fa8ae793c5e8'").replace(b'AFTER_BYTES=82191',b'AFTER_BYTES=81128');self.assertEqual(expected,(HERE/'verify.py').read_bytes())
  def funcs(path):return {n.name:ast.dump(n,include_attributes=False)for n in ast.parse(path.read_bytes()).body if isinstance(n,ast.FunctionDef)}
  self.assertEqual(funcs(OLD/'verify.py'),funcs(HERE/'verify.py'))
 def test_real_fake337_history_protection_old_crlf_expectation_refuses_then_lf_accepts(self):
  m=module(HERE/'verify.py','lf_readonly_checker');fixtures=module(MAIN/'test_managed.py','isolated_original_managed_fixture')
  with patch.object(fixtures,'m',m),patch.object(fixtures,'UI',HERE):
   case=fixtures.Delivery('test_protected_before_one_raw_copy_and_official_after336_preserve_history_register_other140')
   try:
    case.setUp();ready=case.backup();self.assertEqual(ready['status'],'PROTECTED_BEFORE_READY_NOT_SAVED');case.official_save_fixture()
    with patch.object(m,'AFTER','eb5e683f1a69f5a8fcc417df219b74368da36eb668c5ee9e4a90d43956c09670'),patch.object(m,'AFTER_BYTES',82191):
     with self.assertRaises(ValueError):m.readback()
    self.assertEqual(m.readback()['status'],'AFTER_INDEPENDENT_READBACK_PASS')
   finally:case.doCleanups()
if __name__=='__main__':unittest.main()
