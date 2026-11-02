from pathlib import Path
import ast,hashlib,importlib.util,json,tempfile,unittest
HERE=Path(__file__).resolve().parent;MAIN=HERE.parent/'palitra-auth-chat-production-20261031-r7'
def literal(path,name):return ast.literal_eval(next(n.value for n in ast.parse(path.read_bytes()).body if isinstance(n,ast.Assign)and isinstance(n.targets[0],ast.Name)and n.targets[0].id==name))
class RecoveryLF(unittest.TestCase):
 def test_only_source_location_and_one_338_hash_literal_changed(self):
  original=(MAIN/'prepare_fallback_package.py').read_bytes();expected=original.replace(b'HERE=Path(__file__).resolve().parent',b"HERE=Path(__file__).resolve().parent.parent/'palitra-auth-chat-production-20261031-r7'").replace(b'eb5e683f1a69f5a8fcc417df219b74368da36eb668c5ee9e4a90d43956c09670',b'e564f807d1de31c2d9fd1a0f89581afd52a57042ce5b8a444aa3fa8ae793c5e8');self.assertEqual(expected,(HERE/'prepare_fallback_package_lf.py').read_bytes())
 def test_actual_offline_assembly_337_and_338_both_static_phases_closed_pins(self):
  s=importlib.util.spec_from_file_location('lf_recovery_factory',HERE/'prepare_fallback_package_lf.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);self.assertEqual(m.HERE,MAIN)
  with tempfile.TemporaryDirectory()as temporary:
   for version,phase in((337,0),(338,0),(338,2)):
    with self.subTest(version=version,phase=phase):
     revision='4d8e767175cb2d3c5f06a8e61ec40ab0122113e77691776f8ef04212e75055db'if version==337 else'a'*64
     out=m.assemble('sha256:53fcc6b81e2b68a782fdb58a0fa1a66e5ad3277dfc90fc08fd02cfb70ebfea26',version,revision,phase,Path(temporary)/f'fake-{version}-{phase}')
     pins=literal(out/'managed_history.py','PINS');self.assertEqual(pins['assets/storefront.js'],'008f75eecee63f7bd6657408d844f08f9f37472e1d1d3c81256f52505423a808'if version==337 else'e564f807d1de31c2d9fd1a0f89581afd52a57042ce5b8a444aa3fa8ae793c5e8');self.assertEqual(literal(out/'managed_history.py','HISTORY_COUNT'),version)
     anchor=json.loads((out/'managed-anchor.json').read_bytes());self.assertEqual((anchor['version'],anchor['revision']),(version,revision));manifest=json.loads((out/'manifest.json').read_bytes());self.assertEqual(manifest['helperSha256'],hashlib.sha256((out/'install.py').read_bytes()).hexdigest());self.assertEqual([r['target']for r in manifest['files']],['/app/site-orders.js'])
     for name,pin in literal(out/'install.py','REVIEWED_DATA_PINS').items():self.assertEqual(hashlib.sha256((out/name).read_bytes()).hexdigest(),pin,name)
if __name__=='__main__':unittest.main()
