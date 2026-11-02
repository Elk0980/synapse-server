"""Approved combined payload goes through the real assembler; frozen guards stay exact."""
from pathlib import Path
import ast,hashlib,importlib.util,json,sys,unittest
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent;BASE=HERE.parent/'ATTENTION_DURABLE_R8'
class R9Lineage(unittest.TestCase):
 def test_combined_shop_exact_with_single_target_delta_and_unchanged_guards(self):
  def load(name,path):
   spec=importlib.util.spec_from_file_location(name,path);mod=importlib.util.module_from_spec(spec);sys.modules[name]=mod;spec.loader.exec_module(mod);return mod
  old=load('r8_lineage',BASE/'install.py');new=load('r9_lineage',HERE/'install.py');assembler=load('r9_assembler_lineage',HERE/'make_manifest.py')
  shop='/app/palitra-orders-public/shell.js';approved=HERE.parent/'PRIVATE_SHOP_ACCOUNT_PREFILL_R1/candidate/shop-shell.js';raw=(HERE/'payload'/shop.removeprefix('/app/')).read_bytes()
  self.assertEqual(raw,approved.read_bytes());self.assertEqual(len(raw),379553);self.assertEqual(hashlib.sha256(raw).hexdigest(),'b7efae7638e05351296d93243f771b2c7ca134672bda1abe348ac7912d3fab60')
  self.assertEqual(new.NAME,'palitra-attention-durable-20261030-r9');self.assertEqual(new.BASE_IMAGE,old.BASE_IMAGE);self.assertEqual(new.STATIC_PINS,old.STATIC_PINS);self.assertEqual(new.PRESERVED_R7,old.PRESERVED_R7)
  self.assertEqual({k:v for k,v in new.FILE_PINS.items()if k!=shop},{k:v for k,v in old.FILE_PINS.items()if k!=shop});self.assertEqual(new.FILE_PINS[shop][0],old.FILE_PINS[shop][0])
  self.assertEqual({k:v for k,v in new.REVIEWED_DATA_PINS.items()if k!='scope-review.json'},{k:v for k,v in old.REVIEWED_DATA_PINS.items()if k!='scope-review.json'})
  skip={'NAME','FILE_PINS','REVIEWED_DATA_PINS'}
  def tree(path):
   t=ast.parse(path.read_text());t.body=[n for n in t.body if not(isinstance(n,ast.Assign)and any(isinstance(x,ast.Name)and x.id in skip for x in n.targets))];return ast.dump(t,include_attributes=False)
  self.assertEqual(tree(HERE/'install.py'),tree(BASE/'install.py'))
  scope=json.loads((HERE/'scope-review.json').read_bytes());row=next(r for r in scope['targets']if r['target']==shop);self.assertEqual((row['beforeSha256'],row['afterSha256']),new.FILE_PINS[shop]);self.assertEqual(row['afterBytes'],len(raw))
  images={n:'sha256:'+'a'*64 for n in new.CONTAINERS};images[new.CONTENT]=new.BASE_IMAGE;inv={'sourceReviewSha256':new.INVENTORY_REVIEW_SHA,'contentPaths':list(new.ACTIVE_DATABASE_PATHS+new.OPAQUE_ARCHIVE_PATHS),'crmPaths':['/data/crm.sqlite']};manifest=assembler.build(images,inv)
  self.assertEqual(manifest['status'],'ROOT_REVIEWED_CODE_ONLY');self.assertEqual((len(manifest['files']),len(manifest['staticFiles'])),(4,2));assembled=next(r for r in manifest['files']if r['target']==shop);self.assertEqual((assembled['beforeSha256'],assembled['afterSha256'],assembled['bytes']),(*new.FILE_PINS[shop],379553))
  for r in manifest['files']:
   if r['target']!=shop:self.assertEqual((HERE/'payload'/r['target'].removeprefix('/app/')).read_bytes(),(BASE/'payload'/r['target'].removeprefix('/app/')).read_bytes())
  for target,name in new.STATIC_NAMES.items():self.assertEqual((HERE/'static-payload'/name).read_bytes(),(BASE/'static-payload'/name).read_bytes())
if __name__=='__main__':unittest.main()
