"""Real OCI/legacy outer archives and compressed layers; synthetic code only, no Docker."""
from pathlib import Path
import copy,gzip,hashlib,importlib.util,io,json,tarfile,tempfile,unittest
spec=importlib.util.spec_from_file_location('image_audit',Path(__file__).with_name('image_archive_audit.py'));a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
enc=lambda value:(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
def tar_bytes(rows):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT)as t:
  for name,data,kind in rows:
   info=tarfile.TarInfo(name);info.mode=0o644;info.uid=info.gid=0;info.type=kind;info.size=len(data)if kind==tarfile.REGTYPE else 0
   if kind==tarfile.SYMTYPE:info.linkname='/outside'
   t.addfile(info,io.BytesIO(data)if kind==tarfile.REGTYPE else None)
 return out.getvalue()
class Export:
 def __init__(self,layer,config=None,kind='oci',compressed=True,attestation=True,diff=None,media=None):
  self.layer=layer;self.config=copy.deepcopy(config or{'Cmd':['node','server.js'],'Env':['SYNTHETIC=true']});self.kind=kind;self.files={};self.parent=tar_bytes([]);self.parent_diff='sha256:'+a.sha(self.parent);self.last_diff=diff or'sha256:'+a.sha(layer)
  self.config_raw=enc({'architecture':'amd64','os':'linux','config':self.config,'rootfs':{'type':'layers','diff_ids':[self.parent_diff,self.last_diff]}})
  self.config_digest='sha256:'+a.sha(self.config_raw)
  self.child={'Id':self.config_digest,'Config':self.config,'RootFS':{'Layers':[self.parent_diff,self.last_diff]},'Os':'linux','Architecture':'amd64','Variant':None}
  if kind=='legacy':
   self.files={self.config_digest[7:]+'.json':self.config_raw,'parent/layer.tar':self.parent,'child/layer.tar':layer}
   self.files['manifest.json']=enc([{'Config':self.config_digest[7:]+'.json','RepoTags':['synthetic:local'],'Layers':['parent/layer.tar','child/layer.tar']}]);return
  cfg=self.blob(self.config_raw,'application/vnd.oci.image.config.v1+json');parent=self.blob(self.parent,'application/vnd.oci.image.layer.v1.tar');last=self.blob(gzip.compress(layer,mtime=0)if compressed else layer,media or('application/vnd.oci.image.layer.v1.tar+gzip'if compressed else'application/vnd.oci.image.layer.v1.tar'))
  self.manifest={'schemaVersion':2,'mediaType':a.OCI_MANIFEST,'config':cfg,'layers':[parent,last]}
  main=self.blob(enc(self.manifest),a.OCI_MANIFEST);main['platform']={'os':'linux','architecture':'amd64','variant':None};refs=[main]
  if attestation:
   empty=self.blob(enc({'architecture':'unknown','os':'unknown'}),'application/vnd.oci.image.config.v1+json');proof=self.blob(b'{"synthetic":"attestation-not-executed"}','application/vnd.in-toto+json');att=self.blob(enc({'schemaVersion':2,'mediaType':a.OCI_MANIFEST,'config':empty,'layers':[proof]}),a.OCI_MANIFEST);att['platform']={'os':'unknown','architecture':'unknown'};att['annotations']={'vnd.docker.reference.type':'attestation-manifest'};refs.append(att)
  self.refs=refs;self.refresh()
 def blob(self,raw,media):
  digest='sha256:'+a.sha(raw);self.files['blobs/sha256/'+digest[7:]]=raw;return {'mediaType':media,'digest':digest,'size':len(raw)}
 def refresh(self):
  root=enc({'schemaVersion':2,'mediaType':a.OCI_INDEX,'manifests':self.refs});pin=self.blob(root,a.OCI_INDEX);self.child.update(Id=pin['digest'],Descriptor=copy.deepcopy(pin));wrapper=copy.deepcopy(pin);wrapper['annotations']={'org.opencontainers.image.ref.name':'synthetic:local'}
  self.files['index.json']=enc({'schemaVersion':2,'mediaType':a.OCI_INDEX,'manifests':[wrapper]});self.files['oci-layout']=enc({'imageLayoutVersion':'1.0.0'});self.files['manifest.json']=enc([{'Config':'blobs/sha256/'+self.config_digest[7:],'RepoTags':['synthetic:local'],'Layers':['blobs/sha256/'+v['digest'][7:]for v in self.manifest['layers']]}])
 def replace_manifest(self):
  main=self.blob(enc(self.manifest),a.OCI_MANIFEST);main['platform']=self.refs[0].get('platform');self.refs[0]=main;self.refresh()
 def write(self,path,extra=()):
  with tarfile.open(path,mode='w',format=tarfile.USTAR_FORMAT)as t:
   for name,raw in self.files.items():
    info=tarfile.TarInfo(name);info.mode=0o644;info.size=len(raw);t.addfile(info,io.BytesIO(raw))
   for name,raw,kind in extra:
    info=tarfile.TarInfo(name);info.type=kind;info.size=len(raw)if kind==tarfile.REGTYPE else 0;t.addfile(info,io.BytesIO(raw)if kind==tarfile.REGTYPE else None)
class Audit(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'image.tar';self.raw=tar_bytes([('app/one.js',b'synthetic',tarfile.REGTYPE)]);self.calls=[]
 def tearDown(self):self.tmp.cleanup()
 def scope(self,raw,base,manifest):
  self.calls.append(raw)
  with tarfile.open(fileobj=io.BytesIO(raw),mode='r:')as t:
   rows=list(t);a.need(len(rows)==1 and rows[0].name=='app/one.js'and rows[0].isfile(),'SAME_SCOPE_CALLBACK_REJECTED')
 def check(self,e,extra=()):e.write(self.path,extra);return a.audit(self.path,{}, {},e.child,self.scope)
 def test_actual_oci_index_id_differs_from_config_with_passive_unknown_attestation(self):
  e=Export(self.raw);self.assertNotEqual(e.child['Id'],e.config_digest);r=self.check(e);self.assertEqual(r['format'],'oci');self.assertEqual(r['configDigest'],e.config_digest);self.assertEqual(r['rootDescriptorDigest'],e.child['Descriptor']['digest']);self.assertEqual(self.calls,[self.raw])
 def test_oci_plain_and_legacy_plain_use_same_full_scope_callback(self):
  for kind in('oci','legacy'):
   self.calls=[];self.assertEqual(self.check(Export(self.raw,kind=kind,compressed=False))['format'],kind);self.assertEqual(self.calls,[self.raw])
 def test_image_id_must_bind_root_descriptor_or_actual_config_digest(self):
  e=Export(self.raw);e.child['Id']='sha256:'+'f'*64
  with self.assertRaisesRegex(ValueError,'ID_DESCRIPTOR_OR_CONFIG_BINDING'):self.check(e)
 def test_config_rootfs_and_platform_mismatch_cannot_select_runtime(self):
  for field,value in [('Config',{'Cmd':['different']}),('RootFS',{'Layers':['sha256:'+'f'*64]}),('Architecture','arm64')]:
   e=Export(self.raw);e.child[field]=value
   with self.assertRaises(ValueError):self.check(e)
 def test_pinned_descriptor_root_must_be_reachable_and_exact(self):
  e=Export(self.raw);e.child['Descriptor']['digest']='sha256:'+'0'*64
  with self.assertRaisesRegex(ValueError,'PINNED_ROOT_UNREACHABLE'):self.check(e)
  e=Export(self.raw);e.child['Descriptor']['size']+=1
  with self.assertRaisesRegex(ValueError,'ROOT_DESCRIPTOR_MISMATCH'):self.check(e)
 def test_two_matching_runtime_manifests_are_ambiguous(self):
  e=Export(self.raw);other=copy.deepcopy(e.manifest);other['annotations']={'different':'manifest'};ref=e.blob(enc(other),a.OCI_MANIFEST);ref['platform']={'os':'linux','architecture':'amd64'};e.refs.append(ref);e.refresh()
  with self.assertRaisesRegex(ValueError,'SELECTION_AMBIGUOUS'):self.check(e)
 def test_unknown_platform_is_never_selected(self):
  e=Export(self.raw);e.refs[0]['platform']={'os':'unknown','architecture':'unknown'};e.refresh()
  with self.assertRaisesRegex(ValueError,'SELECTION_AMBIGUOUS_OR_MISSING'):self.check(e)
 def test_config_blob_size_or_digest_corruption_refuses(self):
  e=Export(self.raw);name='blobs/sha256/'+e.config_digest[7:];e.files[name]=e.files[name]+b' '
  with self.assertRaisesRegex(ValueError,'BLOB_DIGEST_OR_SIZE'):self.check(e)
 def test_compressed_layer_and_attestation_references_are_hashed(self):
  for index in(0,1):
   e=Export(self.raw);ref=e.manifest['layers'][-1]if index==0 else None
   if ref is None:
    att=json.loads(e.files['blobs/sha256/'+e.refs[1]['digest'][7:]]);ref=att['layers'][0]
   name='blobs/sha256/'+ref['digest'][7:];e.files[name]=e.files[name][:-1]+b'X'
   with self.assertRaisesRegex(ValueError,'REFERENCE_DIGEST'):self.check(e)
 def test_zstd_or_unknown_selected_layer_media_refuses_without_decoder(self):
  for media in('application/vnd.oci.image.layer.v1.tar+zstd','unknown/format'):
   with self.assertRaisesRegex(ValueError,'LAYER_MEDIA_UNSUPPORTED'):self.check(Export(self.raw,media=media))
 def test_gzip_bomb_plain_oversize_and_truncated_gzip_fail_bounded(self):
  with self.assertRaisesRegex(ValueError,'DECOMPRESSED_BOUND'):self.check(Export(b'X'*(a.MAX_LAYER+1)))
  with self.assertRaisesRegex(ValueError,'COMPRESSED_BOUND'):self.check(Export(b'X'*(a.MAX_LAYER+1),compressed=False))
  e=Export(self.raw);last=e.manifest['layers'][-1];body=e.files['blobs/sha256/'+last['digest'][7:]][:-5];e.manifest['layers'][-1]=e.blob(body,last['mediaType']);e.replace_manifest()
  with self.assertRaisesRegex(ValueError,'GZIP_TRUNCATED'):self.check(e)
 def test_last_uncompressed_diffid_and_gzip_multimember_fail(self):
  with self.assertRaisesRegex(ValueError,'LAST_DIFFID_MISMATCH'):self.check(Export(self.raw,diff='sha256:'+'f'*64))
  e=Export(self.raw);last=e.manifest['layers'][-1];body=e.files['blobs/sha256/'+last['digest'][7:]]+gzip.compress(b'extra');e.manifest['layers'][-1]=e.blob(body,last['mediaType']);e.replace_manifest()
  with self.assertRaisesRegex(ValueError,'GZIP_TRAILING_OR_MULTIMEMBER'):self.check(e)
 def test_full_scope_outside_app_and_hidden_trailing_data_rejected(self):
  bad=tar_bytes([('app/one.js',b'synthetic',tarfile.REGTYPE),('etc/outside',b'forbidden',tarfile.REGTYPE)])
  with self.assertRaisesRegex(ValueError,'SAME_SCOPE_CALLBACK'):self.check(Export(bad))
  with self.assertRaisesRegex(ValueError,'TRAILING_DATA_OR_END'):self.check(Export(self.raw+b'hidden'))
 def test_outer_duplicate_path_traversal_or_link_refused_before_selection(self):
  for row in [('index.json',b'{}',tarfile.REGTYPE),('../outside',b'x',tarfile.REGTYPE),('alias',b'',tarfile.SYMTYPE)]:
   with self.assertRaises(ValueError):self.check(Export(self.raw),[row])
 def test_compatibility_mismatch_and_unknown_layout_fail(self):
  e=Export(self.raw);data=json.loads(e.files['manifest.json']);data[0]['Layers'].reverse();e.files['manifest.json']=enc(data)
  with self.assertRaisesRegex(ValueError,'COMPATIBILITY_LAYER_MISMATCH'):self.check(e)
  e=Export(self.raw);e.files['oci-layout']=enc({'imageLayoutVersion':'2.0.0'})
  with self.assertRaisesRegex(ValueError,'LAYOUT_UNKNOWN'):self.check(e)
 def test_legacy_config_identity_and_manifest_reference_are_mandatory(self):
  e=Export(self.raw,kind='legacy');e.child['Id']='sha256:'+'f'*64
  with self.assertRaisesRegex(ValueError,'LEGACY_SELECTION'):self.check(e)
  e=Export(self.raw,kind='legacy');del e.files['manifest.json']
  with self.assertRaisesRegex(ValueError,'REFERENCED_FILE_MISSING'):self.check(e)
if __name__=='__main__':unittest.main()
