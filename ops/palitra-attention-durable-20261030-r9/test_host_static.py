"""Local temp filesystem CAS and partial/unknown transitions. No native capabilities."""
from pathlib import Path
import copy,hashlib,importlib.util,json,os,stat,tempfile,time,types,unittest
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('host_static_tested',HERE/'host_static.py');h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
def write_new(path,raw):
 with Path(path).open('xb')as f:f.write(raw)

class HostStatic(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=HERE);self.addCleanup(self.tmp.cleanup);root=Path(self.tmp.name).resolve();area=root/'release';area.mkdir();folder=root/'sites/synapse/cabinet/palitra-orders';folder.mkdir(parents=True)
  self.m=types.SimpleNamespace(ROOT=root,AREA=area,NAME='test-r8',STATIC_TARGETS=('/opt/synapse/sites/synapse/cabinet/palitra-orders/native-host.js','/opt/synapse/sites/synapse/cabinet/palitra-orders/shell.js'),STATIC_NAMES={},STATIC_PINS={})
  m=self.m;m.sha=lambda b:hashlib.sha256(b).hexdigest();m.enc=lambda o:(json.dumps(o,sort_keys=True,separators=(',',':'))+'\n').encode();m.need=lambda ok,code:None if ok else(_ for _ in()).throw(ValueError(code));m.safe_read=lambda p:Path(p).read_bytes();m.load=lambda p:json.loads(m.safe_read(p));m.own_lease=lambda:{'pid':1,'startTicks':'1'};m.sync_dir=lambda p:None;m.write_new=write_new;m.host_static_path=lambda t:m.ROOT/t.removeprefix('/opt/synapse/');m.full_static=lambda:{str(p.relative_to(root)).replace('\\','/'):m.sha(p.read_bytes())for p in(root/'sites').rglob('*.js')}
  (area/'static-payload').mkdir()
  for i,t in enumerate(m.STATIC_TARGETS):
   name=('cab-native-host.js','cab-shell.js')[i];old=('v1-'+str(i)).encode();new=('v2-'+str(i)).encode();m.STATIC_NAMES[t]=name;m.STATIC_PINS[t]=(m.sha(old),m.sha(new));m.host_static_path(t).write_bytes(old);m.host_static_path(t).chmod(0o644);(area/'static-payload'/name).write_bytes(new)
  (root/'sites/other.js').write_bytes(b'preserved other resource');protected=h.protect_before(m);self.base={'hostStatic':protected,'static':m.full_static()};(area/'static-base.json').write_bytes(m.enc(self.base));self.checks=[]
  def guard(phase,readback=False,history_full=False):self.checks.append((phase,readback,history_full));h.expect(m,self.base,phase);return self.base
  m.static_guard=guard
  if os.name=='nt':self.addCleanup(patch.stopall);patch.object(os,'fchmod',lambda *a:None,create=True).start()
 def test_two_atomic_steps_preserve_all_other_resources_and_before_backups(self):
  m=self.m;self.assertEqual(h.write_one(m,0)['phase'],1);self.assertEqual(h.write_one(m,1)['phase'],2);r=h.inspect(m,True);self.assertEqual(r['status'],'ATTENTION_ALL_AFTER_PASS');self.assertTrue(self.checks[-1][2]);self.assertEqual((m.ROOT/'sites/other.js').read_bytes(),b'preserved other resource');h.backup_guard(m,self.base)
  with self.assertRaisesRegex(ValueError,'ONE_ATTEMPT'):h.write_one(m,0)
 def test_shell_cannot_precede_host_and_nonprefix_is_rejected(self):
  m=self.m
  with self.assertRaisesRegex(ValueError,'HOST_ACCEPTANCE_REQUIRED'):h.write_one(m,1)
  target=m.STATIC_TARGETS[1];m.host_static_path(target).write_bytes((m.AREA/'static-payload'/m.STATIC_NAMES[target]).read_bytes())
  with self.assertRaisesRegex(ValueError,'NONPREFIX'):h.classify(m,self.base)
 def test_unknown_after_rename_requires_readonly_observation_before_shell_no_second_write(self):
  m=self.m;original=m.static_guard
  def unknown(phase,**kw):
   if phase==1 and not kw:raise ValueError('UNKNOWN_AFTER_RENAME')
   return original(phase,**kw)
  m.static_guard=unknown
  with self.assertRaisesRegex(ValueError,'UNKNOWN_AFTER_RENAME'):h.write_one(m,0)
  m.static_guard=original
  with self.assertRaisesRegex(ValueError,'ONE_ATTEMPT'):h.write_one(m,0)
  with self.assertRaisesRegex(ValueError,'HOST_ACCEPTANCE_REQUIRED'):h.write_one(m,1)
  r=h.inspect(m);self.assertEqual(r['phase'],1);self.assertTrue((m.AREA/'host-static-host-observed.json').exists());h.write_one(m,1);self.assertEqual(h.inspect(m,True)['phase'],2)
 def test_unknown_before_rename_never_replays_or_overwrites_before(self):
  m=self.m;replace=os.replace
  def unknown(a,b):
   if Path(b)==m.host_static_path(m.STATIC_TARGETS[0]):raise ValueError('UNKNOWN_BEFORE_RENAME')
   return replace(a,b)
  with patch.object(os,'replace',side_effect=unknown):
   with self.assertRaisesRegex(ValueError,'UNKNOWN_BEFORE_RENAME'):h.write_one(m,0)
  self.assertEqual(h.classify(m,self.base)[0],0)
  with self.assertRaisesRegex(ValueError,'ONE_ATTEMPT'):h.write_one(m,0)
  self.assertEqual(h.inspect(m)['phase'],0)
 def test_other_static_drift_payload_backup_or_mode_drift_fail_closed(self):
  m=self.m;(m.ROOT/'sites/other.js').write_bytes(b'new unrelated resource')
  with self.assertRaisesRegex(ValueError,'OTHER_RESOURCES'):h.write_one(m,0)
  (m.ROOT/'sites/other.js').write_bytes(b'preserved other resource');backup=Path(self.base['hostStatic'][m.STATIC_TARGETS[0]]['backup']);backup.write_bytes(b'corrupt')
  with self.assertRaisesRegex(ValueError,'PROTECTED_BEFORE'):h.write_one(m,0)
 def test_late_cas_drift_does_not_overwrite_new_source(self):
  m=self.m;calls=0;original=m.static_guard;target=m.host_static_path(m.STATIC_TARGETS[0])
  def late(phase,**kw):
   nonlocal calls
   calls+=1
   if calls==2:target.write_bytes(b'concurrent owner change')
   return original(phase,**kw)
  m.static_guard=late
  with self.assertRaises(ValueError):h.write_one(m,0)
  self.assertEqual(target.read_bytes(),b'concurrent owner change');self.assertTrue((m.AREA/'host-static-host-intent.json').exists())
 def test_unknown_shell_after_rename_is_inspected_as_complete_never_replayed(self):
  m=self.m;h.write_one(m,0);original=m.static_guard
  def unknown(phase,**kw):
   if phase==2 and not kw:raise ValueError('UNKNOWN_SHELL_AFTER_RENAME')
   return original(phase,**kw)
  m.static_guard=unknown
  with self.assertRaisesRegex(ValueError,'UNKNOWN_SHELL'):h.write_one(m,1)
  m.static_guard=original
  with self.assertRaisesRegex(ValueError,'ONE_ATTEMPT'):h.write_one(m,1)
  self.assertEqual(h.inspect(m,True)['status'],'ATTENTION_ALL_AFTER_PASS')
  self.assertTrue((m.AREA/'host-static-shell-observed.json').exists());target=m.host_static_path(m.STATIC_TARGETS[1]);replacement=target.with_name('same-bytes-replacement.tmp');replacement.write_bytes(target.read_bytes());replacement.chmod(stat.S_IMODE(target.stat().st_mode));os.replace(replacement,target)
  with self.assertRaisesRegex(ValueError,'ACCEPTED_IDENTITY_CHANGED'):h.inspect(m,True)
if __name__=='__main__':unittest.main()
