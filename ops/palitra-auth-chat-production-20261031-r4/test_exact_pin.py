"""Only the observed ID transcription and closed namespace delta; no native calls."""
from pathlib import Path
import ast,hashlib,importlib.util,json,unittest
HERE=Path(__file__).resolve().parent
OLD=HERE.parent/'palitra-auth-chat-production-20261031-r3'
BAD='53fcc6b81e2b68a782fdb58a0fa1a66e5ad3277dfc90fc08fd02bc0f70abfe26'
GOOD=''.join(('53fcc6b8','1e2b68a7','82fdb58a','0fa1a66e','5ad3277d','fc90fc08','fd02cfb7','0ebfea26'))
def literal(path,name):
 return ast.literal_eval(next(n.value for n in ast.parse(path.read_bytes()).body if isinstance(n,ast.Assign)and isinstance(n.targets[0],ast.Name)and n.targets[0].id==name))
class PinDelta(unittest.TestCase):
 def test_exact_observed_main_and_fallback_ids(self):
  self.assertEqual(literal(HERE/'prebuild.py','EXISTING_MAIN'),'sha256:'+GOOD)
  self.assertNotEqual(GOOD,BAD)
  self.assertEqual(literal(HERE/'prebuild.py','EXISTING_FALLBACK'),literal(OLD/'prebuild.py','EXISTING_FALLBACK'))
 def test_all_executable_ast_exact_after_only_closed_retarget_and_pin_normalization(self):
  for before in OLD.glob('*.py'):
   if before.name.startswith('test_'):continue
   after=HERE/before.name
   expected=before.read_bytes().decode().replace('palitra-auth-chat-production-20261031-r3','palitra-auth-chat-production-20261031-r4').replace('palitra-auth-chat-fallback-20261031-r3','palitra-auth-chat-fallback-20261031-r4').replace(BAD,GOOD)
   a,b=ast.parse(expected),ast.parse(after.read_bytes())
   def normalized(tree):
    for n in tree.body:
     if isinstance(n,ast.Assign)and isinstance(n.targets[0],ast.Name)and n.targets[0].id=='REVIEWED_DATA_PINS':n.value=ast.Constant('separately-checked-exact-byte-pins')
    return ast.dump(tree,include_attributes=False)
   self.assertEqual(normalized(a),normalized(b),before.name)
 def test_every_data_pin_helper_and_product_static_manifest_exact(self):
  for name,pin in literal(HERE/'install.py','REVIEWED_DATA_PINS').items():self.assertEqual(hashlib.sha256((HERE/name).read_bytes()).hexdigest(),pin,name)
  doc=json.loads((HERE/'manifest.json').read_bytes());old=json.loads((OLD/'manifest.json').read_bytes())
  self.assertEqual(doc['helperSha256'],hashlib.sha256((HERE/'install.py').read_bytes()).hexdigest())
  self.assertEqual(doc['packageId'],'palitra-auth-chat-production-20261031-r4')
  doc.pop('helperSha256');old.pop('helperSha256');doc.pop('packageId');old.pop('packageId');self.assertEqual(doc,old)
  for folder in ('payload','static-payload','source-proof'):
   for p in (OLD/folder).rglob('*'):
    if p.is_file():self.assertEqual(p.read_bytes(),(HERE/p.relative_to(OLD)).read_bytes(),str(p))
if __name__=='__main__':unittest.main()
