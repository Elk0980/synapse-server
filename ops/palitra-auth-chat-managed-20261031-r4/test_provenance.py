"""Isolated current-release provenance; no Docker/HTTP/DB writes/real receipts."""
from pathlib import Path
from unittest.mock import patch
import ast,copy,importlib.util,json,tempfile,unittest
HERE=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('r3_managed_verifier',HERE/'verify.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
SOURCE=HERE.parent/'palitra-auth-chat-production-20261031-r4'
class Provenance(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.area=self.root/'releases'/m.RELEASE_PACKAGE;self.area.mkdir(parents=True)
  def safe(q,limit=m.LIMIT):
   q=Path(q);self.assertTrue(q.resolve().is_relative_to(self.root));self.assertFalse(q.is_symlink());raw=q.read_bytes();self.assertLessEqual(len(raw),limit);self.assertEqual(raw,q.read_bytes());return raw
  for p in[patch.object(m,'ROOT',self.root),patch.object(m,'RELEASE_AREA',self.area),patch.object(m,'safe',side_effect=safe)]:p.start();self.addCleanup(p.stop)
  self.seed()
 def put(self,name,value):raw=m.enc(value);(self.area/name).write_bytes(raw);return raw
 def seed(self):
  raw=(SOURCE/'manifest.json').read_bytes();(self.area/'manifest.json').write_bytes(raw);self.put('stage.json',{'manifestSha256':m.sha(raw),'helperSha256':m.RELEASE_HELPER_SHA})
  self.child={'parent':m.IMAGES['synapse-content-1'],'image':'sha256:53fcc6b81e2b68a782fdb58a0fa1a66e5ad3277dfc90fc08fd02cfb70ebfea26'};self.child_raw=self.put('child.json',self.child)
  (self.area/'base.json').write_bytes(b'private-fake-base');(self.area/'history-witness.json').write_bytes(b'private-fake-history')
  self.accepted={'status':'AFTER_INDEPENDENT_READBACK_PASS','childSha256':m.sha(self.child_raw),'baseSha256':m.sha(b'private-fake-base'),'historyWitnessSha256':m.sha(b'private-fake-history'),'identities':{n:'fake-identity'for n in m.NAMES}};self.put('runtime-accepted.json',self.accepted)
 def test_exact_current_release_provenance_accepts_real_public_manifest_and_fake_private_receipts(self):
  result=m.provenance();self.assertEqual(result['image'],self.child['image']);self.assertEqual(m.NAME,'palitra-auth-chat-managed-20261031-r4');self.assertEqual(result['manifestSha256'],m.RELEASE_MANIFEST_SHA)
 def test_old_and_foreign_release_areas_refused_before_any_receipt_read(self):
  for name in('palitra-auth-chat-production-20261031-r1','palitra-auth-chat-production-20261031-r2','palitra-auth-chat-production-20261031-r3','foreign-release'):
   with patch.object(m,'RELEASE_AREA',self.root/'releases'/name):
    with self.assertRaisesRegex(ValueError,'CLOSED_RELEASE_PROVENANCE_AREA'):m.provenance()
 def test_old_foreign_or_tampered_package_cannot_be_copied_into_current_area(self):
  for kind in('old','foreign','helper','source'):
   self.seed();doc=m.parse((self.area/'manifest.json').read_bytes())
   if kind=='old':doc['packageId']='palitra-auth-chat-production-20261031-r1'
   if kind=='foreign':doc['packageId']='foreign'
   if kind=='helper':doc['helperSha256']='a'*64
   if kind=='source':doc['files'][0]['afterSha256']='b'*64
   raw=self.put('manifest.json',doc);self.put('stage.json',{'manifestSha256':m.sha(raw),'helperSha256':doc['helperSha256']})
   with self.assertRaisesRegex(ValueError,'EXACT_REVIEWED_R3_RELEASE_REQUIRED'):m.provenance()
 def test_staged_and_independent_receipt_bindings_still_refuse_tamper(self):
  for name in('stage','child','base','history'):
   self.seed()
   if name=='stage':self.put('stage.json',{'manifestSha256':'a'*64,'helperSha256':m.RELEASE_HELPER_SHA})
   if name=='child':self.put('child.json',{**self.child,'image':'sha256:'+'b'*64})
   if name=='base':(self.area/'base.json').write_bytes(b'changed')
   if name=='history':(self.area/'history-witness.json').write_bytes(b'changed')
   with self.assertRaises(ValueError):m.provenance()
 def test_wrong_parent_or_parent_image_is_never_accepted(self):
  for kind in('parent','same-image'):
   self.seed();child=copy.deepcopy(self.child)
   if kind=='parent':child['parent']='sha256:'+'b'*64
   else:child['image']=child['parent']
   raw=self.put('child.json',child);self.put('runtime-accepted.json',{**self.accepted,'childSha256':m.sha(raw)})
   with self.assertRaisesRegex(ValueError,'EXACT_CONTENT_CHILD_REQUIRED'):m.provenance()
 def test_all_non_provenance_guard_functions_are_ast_exact_predecessor(self):
  def funcs(p):return {n.name:ast.dump(n,include_attributes=False)for n in ast.parse(p.read_text()).body if isinstance(n,ast.FunctionDef)}
  old=funcs(SOURCE/'managed_verify.py');new=funcs(HERE/'verify.py');self.assertEqual(set(old),set(new))
  for name in old:
   if name!='provenance':self.assertEqual(old[name],new[name],name)
  self.assertEqual(m.RUNTIME_AFTER,{r['target']:r['afterSha256']for r in json.loads((SOURCE/'manifest.json').read_bytes())['files']})
if __name__=='__main__':unittest.main()
