"""Synthetic POSIX lstat evidence through actual closed path and file_state functions.
Windows cannot establish native POSIX owner/mode: the metadata below is deliberately modeled.
"""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import hashlib,importlib.util,os,stat,sys,tempfile,unittest
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);mod=importlib.util.module_from_spec(spec);sys.modules[name]=mod;spec.loader.exec_module(mod);return mod
class HostPosixMetadata(unittest.TestCase):
 def setUp(self):
  self.m=load('metadata_install',HERE/'install.py');self.h=load('metadata_host',HERE/'host_static.py');self.raw=b'actual fixture file bytes retained';self.metadata=dict(st_dev=1,st_ino=101,st_mode=stat.S_IFREG|0o600,st_uid=0,st_gid=0,st_nlink=1,st_size=len(self.raw),st_mtime_ns=12,st_ctime_ns=13);self.alias=False;self.symlink=False
  owner=self
  class EvidencePath:
   def resolve(self):return object()if owner.alias else self
   def is_symlink(self):return owner.symlink
   def lstat(self):return SimpleNamespace(**owner.metadata)
  self.path=EvidencePath();self.temp=tempfile.TemporaryDirectory(dir=HERE);self.addCleanup(self.temp.cleanup);self.real=Path(self.temp.name)/'cabinet-file.js';self.real.write_bytes(self.raw)
  class Root:
   def __truediv__(self,relative):
    owner.assertIn('/opt/synapse/'+relative,owner.m.STATIC_TARGETS);return owner.path
  class PosixOs:
   name='posix'
   def __getattr__(self,key):return getattr(os,key)
  for obj,key,value in [(self.m,'ROOT',Root()),(self.m,'safe_read',lambda path:self.real.read_bytes()),(self.h,'os',PosixOs())]:
   q=patch.object(obj,key,value);q.start();self.addCleanup(q.stop)
 def read(self,index=0):return self.h.file_state(self.m,self.m.STATIC_TARGETS[index])
 def test_both_exact_paths_root600_accept_actual_bytes_and_all_stat_identity(self):
  for index in (0,1):
   result=self.read(index);self.assertEqual(result['sha256'],hashlib.sha256(self.raw).hexdigest());self.assertEqual(result['bytes'],len(self.raw));self.assertEqual(stat.S_IMODE(result['stat'][2]),0o600);self.assertEqual(result['stat'][3:6],[0,0,1])
 def test_other_permission_modes_refuse_instead_of_broadening_or_chmod(self):
  for mode in (0o644,0o660,0o400,0o700):
   with self.subTest(mode=mode):
    self.metadata['st_mode']=stat.S_IFREG|mode
    with self.assertRaisesRegex(ValueError,'HOST_STATIC_ROOT_MODE'):self.read()
 def test_owner_group_link_and_nonregular_refuse(self):
  for key,value,reason in [('st_uid',1,'HOST_STATIC_ROOT_MODE'),('st_gid',1,'HOST_STATIC_ROOT_MODE'),('st_nlink',2,'HOST_STATIC_REGULAR_ONE_LINK'),('st_mode',stat.S_IFDIR|0o600,'HOST_STATIC_REGULAR_ONE_LINK')]:
   with self.subTest(key=key):
    before=self.metadata[key];self.metadata[key]=value
    with self.assertRaisesRegex(ValueError,reason):self.read()
    self.metadata[key]=before
 def test_actual_closed_path_rejects_alias_and_symlink_before_mode_read(self):
  self.alias=True
  with self.assertRaisesRegex(ValueError,'HOST_STATIC_CANONICAL_PATH'):self.read()
  self.alias=False;self.symlink=True
  with self.assertRaisesRegex(ValueError,'HOST_STATIC_CANONICAL_PATH'):self.read()
  with self.assertRaisesRegex(ValueError,'CLOSED_HOST_STATIC_PATH'):self.h.file_state(self.m,'/opt/synapse/sites/other.js')
if __name__=='__main__':unittest.main()
