"""Fixed opaque archives only. Real byte copies/stat/SHA; never invoke SQLite on them."""
from pathlib import Path
import copy,hashlib,importlib.util,os,tempfile,time,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('opaque_release',Path(__file__).with_name('install.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Archives(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.area=self.root/'release';self.area.mkdir();self.file=self.root/'retained.sqlite';self.raw=b'SQLite format 3\x00'+b'\x00\x00\x02\x02'+b'CREATE VIRTUAL TABLE synthetic USING fts5(body);opaque payload';self.file.write_bytes(self.raw);self.file.chmod(0o600)
  self.row={'preservation':'opaque','role':'content','containerPath':m.OPAQUE_ARCHIVE_PATHS[0],'hostPath':str(self.file),'identity':m.db_identity(self.file)}
  self.key='content:'+self.row['containerPath'];self.lease={'pid':1,'startTicks':'synthetic'}
  self.patches=[patch.object(m,'AREA',self.area),patch.object(m,'base_guard'),patch.object(m,'own_lease',return_value=self.lease)]
  if os.name=='nt':
   # Windows fd ctime differs from path ctime; native Linux safe_read stays exact.
   def windows_reader(path):
    path=Path(path);before=path.lstat();m.need(not path.is_symlink()and before.st_nlink==1 and before.st_size<=m.MAX_FILE,'REGULAR_BOUNDED_FILE');raw=path.read_bytes();after=path.lstat();m.need((before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'STABLE_READ_REQUIRED');return raw
   self.patches.append(patch.object(m,'safe_read',side_effect=windows_reader))
  for p in self.patches:p.start()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.temp.cleanup()
 def fact(self):return m.opaque_archive_facts(self.row)
 def base(self):return {'databases':{self.key:self.row},'databaseFacts':{self.key:self.fact()},'lease':self.lease,'expires':time.time()+120}
 def review(self):return {'containerPath':self.row['containerPath'],'role':'opaque_retained_copy','uid':0,'gid':0,'mode':'0600','nlink':1,'sameResolvedPath':True,'maxBytes':m.MAX_FILE,'observedBytes':len(self.raw),'sidecars':{'-wal':{'present':False},'-shm':{'present':False}}}
 def test_wal_header_absent_sidecars_and_virtual_bytes_preserved_without_any_sqlite_open(self):
  before={p.name:p.read_bytes()for p in self.root.iterdir()if p.is_file()}
  with patch.object(m.sqlite3,'connect',side_effect=AssertionError('ARCHIVE_SQLITE_OPEN_FORBIDDEN'))as sql:
   base=self.base();self.assertEqual(m.snapshot_databases(base['databases']),base['databaseFacts']);backups=m.backup_databases(base);m.backup_guard();self.assertEqual(sql.call_count,0)
  self.assertEqual(len(backups),1);backup=Path(backups[self.key]['path']);self.assertEqual(backup.read_bytes(),self.raw);self.assertEqual(before,{p.name:p.read_bytes()for p in self.root.iterdir()if p.is_file()});self.assertFalse(Path(str(self.file)+'-wal').exists());self.assertFalse(Path(str(self.file)+'-shm').exists())
 def test_existing_zero_wal_and_shm_all_receive_exclusive_raw_backups(self):
  Path(str(self.file)+'-wal').write_bytes(b'');Path(str(self.file)+'-shm').write_bytes(b'S'*32768);base=self.base()
  with patch.object(m.sqlite3,'connect',side_effect=AssertionError('NO_SQLITE')):backups=m.backup_databases(base)
  self.assertEqual(set(backups),{self.key,self.key+'-wal',self.key+'-shm'})
  for suffix in('','-wal','-shm'):self.assertEqual(Path(backups[self.key+suffix]['path']).read_bytes(),Path(str(self.file)+suffix).read_bytes())
  with self.assertRaisesRegex(ValueError,'BACKUPS_EXIST_INSPECT_ONLY'):m.backup_databases(base)
 def test_sidecar_addition_removal_or_content_drift_refuses_preservation(self):
  initial=self.fact();wal=Path(str(self.file)+'-wal');wal.write_bytes(b'opaque wal')
  with self.assertRaisesRegex(ValueError,'ARCHIVE_OR_SIDECAR_CHANGED'):m.assert_preserved_path(self.row,initial)
  current=self.fact();wal.write_bytes(b'OPAQUE WAL')
  with self.assertRaisesRegex(ValueError,'ARCHIVE_OR_SIDECAR_CHANGED'):m.assert_preserved_path(self.row,current)
  wal.unlink()
  with self.assertRaisesRegex(ValueError,'ARCHIVE_OR_SIDECAR_CHANGED'):m.assert_preserved_path(self.row,current)
 def test_main_same_size_byte_drift_and_inode_replacement_refuse(self):
  initial=self.fact();self.file.write_bytes(self.raw[:-1]+b'X')
  with self.assertRaisesRegex(ValueError,'ARCHIVE_OR_SIDECAR_CHANGED'):m.assert_preserved_path(self.row,initial)
  replacement=self.root/'replacement';replacement.write_bytes(self.raw);replacement.replace(self.file)
  with self.assertRaisesRegex(ValueError,'DATABASE_IDENTITY_CHANGED'):m.assert_preserved_path(self.row,initial)
 def test_raw_files_are_bounded_and_unknown_archive_path_not_accepted(self):
  with patch.object(m,'MAX_FILE',len(self.raw)-1):
   with self.assertRaisesRegex(ValueError,'BOUND'):self.fact()
  with self.assertRaisesRegex(ValueError,'FIXED_OPAQUE_ARCHIVE_REQUIRED'):m.opaque_archive_facts({**self.row,'containerPath':'/data/unknown.sqlite'})
 def test_source_drift_during_raw_copy_refuses_without_backup_manifest_or_sqlite(self):
  base=self.base();write=m.write_new
  def drifting(target,raw,*args,**kwargs):
   write(target,raw,*args,**kwargs)
   if Path(target).suffix=='.raw':self.file.write_bytes(self.raw[:-1]+b'X')
  with patch.object(m,'write_new',side_effect=drifting),patch.object(m.sqlite3,'connect',side_effect=AssertionError('NO_SQLITE')):
   with self.assertRaisesRegex(ValueError,'ARCHIVE_OR_SIDECAR_CHANGED'):m.backup_databases(base)
  self.assertFalse((self.area/'backups.json').exists())
 def test_fresh_review_sidecar_presence_and_observed_size_are_mandatory(self):
  review=self.review();m.archive_review_state(self.row,review)
  Path(str(self.file)+'-shm').write_bytes(b'new')
  with self.assertRaisesRegex(ValueError,'SIDECAR_PRESENCE_CHANGED'):m.archive_review_state(self.row,review)
  Path(str(self.file)+'-shm').unlink();review['observedBytes']+=1
  with self.assertRaisesRegex(ValueError,'REVIEWED_SIZE_CHANGED'):m.archive_review_state(self.row,review)
 def test_protected_raw_backup_corruption_refuses_without_source_restore(self):
  backups=m.backup_databases(self.base());Path(backups[self.key]['path']).write_bytes(b'damaged')
  with self.assertRaisesRegex(ValueError,'PROTECTED_BACKUP_CHANGED'):m.backup_guard()
  self.assertEqual(self.file.read_bytes(),self.raw)
if __name__=='__main__':unittest.main()
