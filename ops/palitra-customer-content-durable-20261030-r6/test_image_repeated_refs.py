"""OCI ordered repeated references are distinct from duplicate outer archive entries."""
from pathlib import Path
import copy,io,json,tarfile,tempfile,unittest
import test_image_archive_audit as fixture
a=fixture.a
class Repeat(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'image.tar';self.raw=fixture.tar_bytes([('app/one.js',b'synthetic',tarfile.REGTYPE)]);self.calls=[]
 def tearDown(self):self.temp.cleanup()
 def repeated(self,compressed=True):
  e=fixture.Export(self.raw,compressed=compressed)
  e.manifest['layers'].insert(1,copy.deepcopy(e.manifest['layers'][0]));diffs=[e.parent_diff,e.parent_diff,e.last_diff];cfg=json.loads(e.config_raw);cfg['rootfs']['diff_ids']=diffs;e.config_raw=fixture.enc(cfg);e.config_digest='sha256:'+a.sha(e.config_raw);e.child['RootFS']['Layers']=diffs;e.manifest['config']=e.blob(e.config_raw,'application/vnd.oci.image.config.v1+json');e.replace_manifest();return e
 def scope(self,raw,base,manifest):
  self.calls.append(raw)
  with tarfile.open(fileobj=io.BytesIO(raw),mode='r:')as archive:
   rows=list(archive);a.need(len(rows)==1 and rows[0].name=='app/one.js'and rows[0].isfile(),'SAME_SCOPE_CALLBACK_REJECTED')
 def check(self,e,extra=()):e.write(self.path,extra);return a.audit(self.path,{}, {},e.child,self.scope)
 def test_inherited_repeat_with_one_physical_blob_preserves_full_order_gzip_and_plain(self):
  for compressed in (True,False):
   with self.subTest(compressed=compressed):
    e=self.repeated(compressed);self.calls=[];self.assertEqual(len(e.child['RootFS']['Layers']),3);self.assertEqual(len(set(e.child['RootFS']['Layers'])),2);self.assertEqual(len(e.manifest['layers']),3);self.assertEqual(len({v['digest']for v in e.manifest['layers']}),2)
    self.assertEqual(self.check(e)['format'],'oci');self.assertEqual(self.calls,[self.raw])
    with tarfile.open(self.path)as archive:
     names=archive.getnames();self.assertEqual(len(names),len(set(names)))
 def test_ordered_compat_reference_substitution_not_deduped(self):
  e=self.repeated();compat=json.loads(e.files['manifest.json']);refs=compat[0]['Layers'];refs[1],refs[2]=refs[2],refs[1];e.files['manifest.json']=fixture.enc(compat)
  with self.assertRaisesRegex(ValueError,'COMPATIBILITY_LAYER_MISMATCH'):self.check(e)
  self.assertFalse(self.calls)
 def test_missing_shared_blob_is_not_excused_by_repeated_reference(self):
  e=self.repeated();del e.files['blobs/sha256/'+e.manifest['layers'][0]['digest'][7:]]
  with self.assertRaisesRegex(ValueError,'REFERENCE_SIZE_OR_MISSING'):self.check(e)
 def test_missing_extra_or_replaced_compat_reference_refuses(self):
  for change in ('missing','extra','replace'):
   with self.subTest(change=change):
    e=self.repeated();compat=json.loads(e.files['manifest.json']);refs=compat[0]['Layers']
    if change=='missing':refs.pop(0)
    elif change=='extra':refs.insert(0,refs[0])
    else:refs[1]=refs[-1]
    e.files['manifest.json']=fixture.enc(compat)
    with self.assertRaisesRegex(ValueError,'LEGACY_LAYER_LIST|COMPATIBILITY_LAYER_MISMATCH'):self.check(e)
 def test_duplicate_outer_shared_blob_entry_still_refuses(self):
  e=self.repeated();name='blobs/sha256/'+e.manifest['layers'][0]['digest'][7:]
  with self.assertRaisesRegex(ValueError,'DUPLICATE_ENTRY'):self.check(e,[(name,e.files[name],tarfile.REGTYPE)])
 def test_legacy_only_repeated_reference_still_refuses_without_oci_witness(self):
  e=fixture.Export(self.raw,kind='legacy');cfg=json.loads(e.config_raw);cfg['rootfs']['diff_ids']=[e.parent_diff,e.parent_diff,e.last_diff];e.config_raw=fixture.enc(cfg);e.config_digest='sha256:'+a.sha(e.config_raw);e.child.update(Id=e.config_digest,RootFS={'Layers':cfg['rootfs']['diff_ids']});config_name=e.config_digest[7:]+'.json';e.files[config_name]=e.config_raw;e.files['manifest.json']=fixture.enc([{'Config':config_name,'Layers':['parent/layer.tar','parent/layer.tar','child/layer.tar']}])
  with self.assertRaisesRegex(ValueError,'LEGACY_LAYER_LIST'):self.check(e)
if __name__=='__main__':unittest.main()
