"""Sparse actual layer regression and exact existing-image validation; isolated."""
import ast,copy,hashlib,importlib.util,io,json,sys,tarfile,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m
m=load('sparse_install',HERE/'install.py');p=load('sparse_prebuild',HERE/'prebuild.py');f=load('sparse_fallback',HERE/'fallback_image.py')
def file(raw):return {'type':'file','mode':0o644,'uid':0,'gid':0,'nlink':1,'sha256':m.sha(raw),'bytes':len(raw)}
def fixture():
 base={'tree':{}}
 for name in ('server.js','palitra-manager-attention.cjs','site-orders.js'):base['tree'][name]=file((HERE/'payload'/name).read_bytes())
 rows=[]
 for name in ('server.js','palitra-manager-attention.cjs','site-orders.js'):
  raw=(HERE/'source-proof'/('fallback-'+name)).read_bytes();rows.append({'target':'/app/'+name,'beforeSha256':base['tree'][name]['sha256'],'afterSha256':m.sha(raw),'bytes':len(raw)})
 return base,{'files':rows},{'files':[rows[2]]},(HERE/'source-proof/fallback-site-orders.js').read_bytes()
def archive(raw,mutation=None):
 stream=io.BytesIO()
 with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT)as t:
  if mutation=='missing':return stream.getvalue()
  name='app/site-orders.js';item=tarfile.TarInfo(name);item.size=len(raw);item.mode=0o644;item.uid=item.gid=0
  if mutation=='content':raw=b'x'*len(raw)
  if mutation=='owner':item.uid=1
  if mutation=='symlink':item.type=tarfile.SYMTYPE;item.linkname='/foreign';item.size=0
  if mutation=='traversal':item.name='app/../site-orders.js'
  if mutation=='whiteout':item.name='app/.wh.site-orders.js'
  t.addfile(item,io.BytesIO(raw)if item.isfile()else None)
  if mutation=='extra':
   extra=tarfile.TarInfo('app/foreign.js');extra.size=1;extra.mode=0o644;t.addfile(extra,io.BytesIO(b'x'))
  if mutation=='duplicate':t.addfile(item,io.BytesIO(raw))
 return stream.getvalue()

class SparseLayer(unittest.TestCase):
 def test_actual_one_file_layer_reproduces_old_three_file_refusal_and_new_pass(self):
  base,old,new,raw=fixture();layer=archive(raw)
  with self.assertRaisesRegex(ValueError,'MISSING_LAYER_FILE'):m.tar_members(layer,base,old)
  m.tar_members(layer,base,new)
  # Same complete result: server/manager remain inherited byte-for-byte.
  self.assertEqual(m.expected_tree(base,old),m.expected_tree(base,new))
  for name in ('server.js','palitra-manager-attention.cjs'):self.assertEqual(m.expected_tree(base,new)['%s'%name],base['tree'][name])
 def test_strict_validator_unchanged_and_effective_manifest_exactly_one(self):
  old=HERE.parent/'palitra-auth-chat-production-20261031-r2/install.py'
  def fn(path):return ast.dump(next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='tar_members'),include_attributes=False)
  self.assertEqual(fn(old),fn(HERE/'install.py'));self.assertEqual(f.NAMES,('site-orders.js',))
  x=types.SimpleNamespace(AREA=HERE,FILE_PINS=m.FILE_PINS,REVIEWED_DATA_PINS=m.REVIEWED_DATA_PINS,safe_read=lambda q:q.read_bytes())
  self.assertEqual([r['target']for r in f.manifest(x)['files']],['/app/site-orders.js'])
 def test_missing_changed_file_and_every_unsafe_member_still_refused(self):
  base,_,doc,raw=fixture()
  for mutation in ('missing','content','owner','symlink','traversal','whiteout','extra','duplicate'):
   with self.subTest(mutation=mutation):
    with self.assertRaises((ValueError,tarfile.ReadError)):m.tar_members(archive(raw,mutation),base,doc)
 def test_generated_fallback_preserves_server_manager_and_strict_sparse_tar(self):
  factory=load('sparse_factory',HERE/'prepare_fallback_package.py');base,_,doc,raw=fixture()
  with tempfile.TemporaryDirectory()as directory:
   out=factory.assemble(p.EXISTING_MAIN,337,m.MANAGED_REV,0,Path(directory)/'generated');fm=load('sparse_generated',out/'install.py');d=json.loads((out/'manifest.json').read_text());fm.validate_manifest(d)
   self.assertEqual(set(fm.FILE_PINS),{'/app/site-orders.js'})
   self.assertEqual(fm.PRESERVED_R7['/app/server.js'],base['tree']['server.js']['sha256']);self.assertEqual(fm.PRESERVED_R7['/app/palitra-manager-attention.cjs'],base['tree']['palitra-manager-attention.cjs']['sha256'])
   # Complete source guard includes both immutable controls in both phases.
   tree={name:{'sha256':pin}for name,pin in ((t.removeprefix('/app/'),pin)for t,pin in fm.PRESERVED_R7.items())}
   for after in (False,True):
    fm.source_phase_tree(tree,after)
    for name in ('server.js','palitra-manager-attention.cjs'):
     broken=copy.deepcopy(tree);broken[name]['sha256']='changed'
     with self.assertRaises(ValueError):fm.source_phase_tree(broken,after)
   fm.tar_members(archive(raw),base,d)
 def test_existing_image_attestation_checks_parent_config_tree_and_strict_archive(self):
  base,_,doc,raw=fixture();config={'Entrypoint':['unchanged']};before={'Config':config,'RootFS':{'Layers':['base','forward']}}
  for mutation in (None,'parent','config','tree','content','extra'):
   with tempfile.TemporaryDirectory()as directory:
    area=Path(directory);after={'Config':copy.deepcopy(config),'RootFS':{'Layers':['base','forward','fallback']}};tree=m.expected_tree(base,doc);calls=[]
    if mutation=='parent':after['RootFS']['Layers']=['base','foreign','fallback']
    if mutation=='config':after['Config']['Entrypoint']=['foreign']
    if mutation=='tree':tree['server.js']['sha256']='changed'
    def run(args,timeout):calls.append(args);Path(args[4]).write_bytes(archive(raw,mutation if mutation in('content','extra')else None))
    def audit(path,b,d,info):m.tar_members(path.read_bytes(),b,d)
    x=types.SimpleNamespace(need=m.need,image_info=lambda image:before if image==p.EXISTING_MAIN else after,image_tree=lambda _:tree,expected_tree=m.expected_tree,run=run,audit_saved_layer=audit,sha=m.sha,enc=m.enc)
    if mutation:
     with self.assertRaises(ValueError):p.attest_existing(x,p.EXISTING_FALLBACK,p.EXISTING_MAIN,base,doc,area/'saved')
    else:
     note=p.attest_existing(x,p.EXISTING_FALLBACK,p.EXISTING_MAIN,base,doc,area/'saved');self.assertEqual(note['image'],p.EXISTING_FALLBACK)
    self.assertTrue(all(args[:3]==['docker','image','save']for args in calls));self.assertNotIn('build',sum(calls,[]));self.assertNotIn('up',sum(calls,[]))
 def test_existing_image_reuse_seals_attempt_and_never_replays_old_area(self):
  for fail in (False,True):
   with tempfile.TemporaryDirectory()as directory:
    area=Path(directory);(area/'image-base.json').write_bytes(b'fixed-code-anchor');calls=[];stage={'commit':'commit','helperSha256':'helper','manifestSha256':'manifest'}
    x=types.SimpleNamespace(NAME='palitra-auth-chat-production-20261031-r3',AREA=area,BASE_IMAGE=m.BASE_IMAGE,need=m.need,enc=m.enc,sha=m.sha,safe_read=lambda q:q.read_bytes(),load=lambda q:json.loads(q.read_bytes()),own_lease=lambda:{'pid':123},package=lambda:(stage,{}),sync_dir=lambda _:None)
    def write(q,raw):
     with q.open('xb')as out:out.write(raw)
    x.write_new=write;x.make_plan=lambda *_:write(area/'forward-plan.json',b'plan');x.built_image_guard=lambda *_:calls.append('main-guard')
    fake_f=types.SimpleNamespace(parent=lambda _ :({'tree':{}},x.load(area/'child.json')),manifest=lambda _:{'files':[{'target':'/app/site-orders.js'}]},validate=lambda _:calls.append('fallback-guard'));x.module=lambda _:fake_f
    def attest(_m,image,parent,*args):
     calls.append(image)
     if fail and image==p.EXISTING_FALLBACK:raise ValueError('SPARSE_ARCHIVE_CHANGED')
     return {'image':image,'parent':parent,'imageConfigSha256':'config','lastDiffId':'diff'}
    with patch.object(p,'guard',return_value=({}, {'files':[]}, {'tree':{}}, {})),patch.object(p,'attest_existing',side_effect=attest):
     if fail:
      with self.assertRaisesRegex(ValueError,'SPARSE_ARCHIVE_CHANGED'):p.reuse_images(x)
      self.assertFalse((area/'reuse-images-accepted.json').exists())
     else:
      p.reuse_images(x);self.assertEqual(x.load(area/'reuse-images-accepted.json'),p.reuse_note(x))
     intent=(area/'reuse-images-intent.json').read_bytes()
     with self.assertRaisesRegex(ValueError,'FRESH_IMAGE_REUSE_ONLY'):p.reuse_images(x)
     self.assertEqual((area/'reuse-images-intent.json').read_bytes(),intent);self.assertFalse((area/'base.json').exists());self.assertFalse((area/'apply-intent.json').exists())
     self.assertFalse(any(q.name=='old-r2'for q in area.iterdir()))

if __name__=='__main__':unittest.main()
