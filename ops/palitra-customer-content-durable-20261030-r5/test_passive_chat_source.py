"""Closed passive exact chat source read; no Node, hooks, extraction or native I/O."""
import copy,io,tarfile,unittest
from unittest.mock import patch
import test_install as fixture
m=fixture.m
REAL_SOURCE_REVIEW=m.source_review_guard
class Passive(unittest.TestCase):
 def setUp(self):
  self.f=fixture.Pipeline(methodName='runTest');self.f.setUp();self.chat=self.f.current['synapse-chat-1'];self.chat['Config']['Env']+=['NODE_OPTIONS=--require=/app/hooks.js','LD_PRELOAD=/app/hook.so'];self.code=b'// synthetic exact client bot bridge\n';self.pin=m.sha(self.code);self.raw=self.tar();self.calls=[]
 def tearDown(self):self.f.tearDown()
 def tar(self,name='client-bot-bridge.js',kind=tarfile.REGTYPE,extra=False,pax=False):
  stream=io.BytesIO()
  with tarfile.open(fileobj=stream,mode='w',format=tarfile.PAX_FORMAT if pax else tarfile.USTAR_FORMAT)as out:
   entry=tarfile.TarInfo(name);entry.type=kind;entry.size=len(self.code)if kind==tarfile.REGTYPE else 0
   if kind in(tarfile.SYMTYPE,tarfile.LNKTYPE):entry.linkname='/app/foreign.js'
   if pax:entry.pax_headers={'comment':'unknown header'}
   out.addfile(entry,io.BytesIO(self.code)if entry.size else None)
   if extra:out.addfile(tarfile.TarInfo('extra.js'))
  return stream.getvalue()
 def process(self,args,timeout,limit):
  if args[:2]!=['docker','cp']:return self.f.process(args,timeout,limit)
  self.calls.append(args);self.assertTrue(m.allowed_command(args));self.assertEqual(args,['docker','cp',self.chat['Id']+':/app/client-bot-bridge.js','-']);self.assertEqual(timeout,20);self.assertEqual(limit,512000);return 0,self.raw,b''
 def read(self):
  with patch.object(m,'_process',side_effect=self.process):return m.passive_chat_source(self.chat,self.pin)
 def test_actual_hooked_profile_is_passively_read_without_executing_node(self):
  with self.assertRaisesRegex(ValueError,'HOOKS_NOT_ALLOWED'):m.probe_profile(self.chat['Config'])
  self.assertEqual(self.read(),self.pin);self.assertEqual(len(self.calls),1);self.assertFalse(m._PASSIVE_CHAT_READS);self.assertFalse(any('exec'in x for x in self.calls))
 def test_capability_is_exact_scoped_one_read_and_revoked(self):
  good=['docker','cp',self.chat['Id']+':/app/client-bot-bridge.js','-'];self.assertFalse(m.allowed_command(good));self.read();self.assertFalse(m.allowed_command(good))
  for args in [['docker','cp',self.chat['Id']+':/app/server.js','-'],['docker','cp','synapse-chat-1:/app/client-bot-bridge.js','-'],['docker','cp','-L',good[2],'-'],good[:-1]+['/tmp/out']]:self.assertFalse(m.allowed_command(args))
 def test_links_directories_paths_extra_pax_are_rejected(self):
  for kw in [{'kind':tarfile.SYMTYPE},{'kind':tarfile.LNKTYPE},{'kind':tarfile.DIRTYPE},{'name':'app/client-bot-bridge.js'},{'name':'../client-bot-bridge.js'},{'extra':True},{'pax':True}]:
   with self.subTest(kw=kw):
    self.raw=self.tar(**kw)
    with self.assertRaises(ValueError):self.read()
    self.assertFalse(m._PASSIVE_CHAT_READS)
 def test_wrong_source_hash_and_nonzero_trailing_archive_fail(self):
  self.pin='0'*64
  with self.assertRaisesRegex(ValueError,'SOURCE_PIN_CHANGED'):self.read()
  self.pin=m.sha(self.code);self.raw=self.tar()+b'x'+b'\0'*511
  with self.assertRaisesRegex(ValueError,'TRAILING_DATA'):self.read()
 def test_archive_bounds_corruption_and_empty_fail(self):
  for raw in [b'',b'not tar',self.tar()+b'\0'*512000]:
   self.raw=raw
   with self.assertRaises((ValueError,tarfile.TarError)):self.read()
 def test_foreign_identity_changes_before_or_after_read_refuse(self):
  changed=copy.deepcopy(self.chat);changed['Image']='sha256:'+'f'*64
  with patch.object(m,'inspect_container',return_value=changed):
   with self.assertRaisesRegex(ValueError,'IDENTITY_CHANGED'):self.read()
  self.assertFalse(self.calls)
  with patch.object(m,'inspect_container',side_effect=[copy.deepcopy(self.chat),changed]):
   with self.assertRaisesRegex(ValueError,'IDENTITY_CHANGED'):self.read()
  self.assertEqual(len(self.calls),1)
 def test_timeout_or_nonzero_never_replays_or_retains_capability(self):
  def unknown(args,timeout,limit):
   if args[:2]==['docker','cp']:raise ValueError('COMMAND_TIMEOUT_INSPECT_ONLY')
   return self.f.process(args,timeout,limit)
  with patch.object(m,'_process',side_effect=unknown)as call:
   with self.assertRaisesRegex(ValueError,'TIMEOUT'):m.passive_chat_source(self.chat,self.pin)
   self.assertEqual(len([c for c in call.call_args_list if c.args[0][:2]==['docker','cp']]),1)
  self.assertFalse(m._PASSIVE_CHAT_READS)
 def test_real_source_guard_uses_passive_chat_and_unchanged_crm_node_guard(self):
  tree={'server.js':{'sha256':'a'},'site-workspace-feature.js':{'sha256':'b'}};inventory={'activeDatabases':[{'containerPath':x}for x in m.ACTIVE_DATABASE_PATHS],'archives':[{'containerPath':x}for x in m.OPAQUE_ARCHIVE_PATHS],'databasePathEnv':'/data/content.sqlite','sourcePins':{'server.js':'a','site-workspace-feature.js':'b'},'dataMount':str(self.f.content)}
  pins={'chat/client-bot-bridge.js':self.pin,'crm/task-dispatch.js':'c'}
  def load(path):return inventory if path.name=='inventory-review.json'else pins
  with patch.object(m,'load',side_effect=load),patch.object(m,'runtime_tree',return_value={'task-dispatch.js':{'sha256':'c'}})as runtime,patch.object(m,'_process',side_effect=self.process):
   REAL_SOURCE_REVIEW(self.f.current,tree);runtime.assert_called_once_with(self.f.current[m.CRM])
  self.assertEqual(len(self.calls),1)
if __name__=='__main__':unittest.main()
