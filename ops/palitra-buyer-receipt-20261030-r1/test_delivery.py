"""Synthetic local SQLite/filesystem; all subprocess/native/HTTP capabilities mocked."""
from pathlib import Path
from unittest.mock import patch
import ast,copy,hashlib,importlib.util,json,os,shutil,sqlite3,stat,tempfile,time,unittest
from datetime import datetime,timezone
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('ui_delivery',HERE/'verify_buyer_receipt.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
UI=HERE/'payload/assets';SOURCE=HERE/'fixtures/base'
class Delivery(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir=HERE);self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.data=self.root/'data';self.data.mkdir();self.releases=self.root/'releases';self.releases.mkdir();self.versions=self.data/'projects'/m.COMPANY/'sites'/m.SITE/'versions';self.versions.mkdir(parents=True);self.area=self.releases/m.NAME;self.lease={'pid':101,'startTicks':'1'};self.images={n:{'image':v,'identitySha256':'a'*64}for n,v in m.IMAGES.items()};self.proof={'historicalReceiptAt':time.time()-30000,'receiptSha256':'b'*64}
  patches=[patch.object(m,'DATA',self.data),patch.object(m,'AREA',self.area),patch.object(m,'runtime',return_value=self.images),patch.object(m,'provenance',return_value=self.proof),patch.object(m,'own_lease',return_value=self.lease)]
  self.host=self.root/'host';self.host.mkdir();pins={}
  for name in ('native-host.js','shell.js'):
   file=self.host/name;file.write_bytes(('synthetic '+name).encode());file.chmod(0o600);pins[str(file)]=m.sha(file.read_bytes())
  patches.append(patch.object(m,'HOST_PINS',pins))
  body=json.dumps({'version':83,'synthetic':True});patches.append(patch.object(m,'PRICE_SHA',m.sha(body.encode())))
  if os.name=='nt':
   def windows_safe(path,limit=m.LIMIT):
    path=Path(path);before=m.file_meta(path);self.assertEqual(path.resolve(),path);self.assertFalse(path.is_symlink());self.assertTrue(stat.S_ISREG(path.lstat().st_mode));raw=path.read_bytes();self.assertLessEqual(len(raw),limit);self.assertEqual(before,m.file_meta(path));return raw
   patches.extend([patch.object(m,'safe',side_effect=windows_safe),patch.object(m,'sync_dir')])
  for item in patches:item.start();self.addCleanup(item.stop)
  self.db=sqlite3.connect(self.data/'content.sqlite');self.addCleanup(self.db.close);self.db.executescript('CREATE TABLE managed_sites(id TEXT PRIMARY KEY,company_code TEXT,is_active INTEGER,deleted_at TEXT,updated_at TEXT,extra TEXT); CREATE TABLE site_workspaces(site_id TEXT PRIMARY KEY,hostname TEXT,runtime TEXT,current_revision TEXT,extra TEXT); CREATE TABLE site_workspace_revisions(site_id TEXT,revision TEXT PRIMARY KEY,version INTEGER,manifest_json TEXT,created_by TEXT,created_at TEXT,message TEXT); CREATE TABLE documents(key TEXT,version INTEGER,body TEXT,updated_at TEXT);')
  self.db.execute('INSERT INTO managed_sites VALUES(?,?,1,NULL,?,?)',(m.SITE,m.COMPANY,'2026-10-29T00:00:00.000Z','preserve unknown metadata'));self.db.execute('INSERT INTO managed_sites VALUES(?,?,1,NULL,?,?)',('foreign','synthetic-foreign','old','foreign preserved'))
  self.db.execute('INSERT INTO site_workspaces VALUES(?,?,?,?,?)',(m.SITE,'palitra-love-draft-1.synapsebusiness.ru','palitra-draft',m.BASE_REV,'keep'));self.db.execute('INSERT INTO site_workspaces VALUES(?,?,?,?,?)',('foreign','synthetic.invalid','synthetic','z'*64,'foreign keep'));self.db.execute('INSERT INTO documents VALUES(?,?,?,?)',('palitra/price',83,body,'preserve-price-row'))
  for version in range(1,336):
   rev=f'{version:064x}';folder=self.versions/rev;folder.mkdir(mode=0o700);file=folder/'old.txt';file.write_bytes(('synthetic historical '+str(version)).encode());file.chmod(0o600);doc={'old.txt':{'sha256':m.sha(file.read_bytes()),'bytes':len(file.read_bytes())}}
   if version==257:doc['old.txt']['sha256']='0'*64
   self.db.execute('INSERT INTO site_workspace_revisions VALUES(?,?,?,?,?,?,?)',(m.SITE,rev,version,json.dumps(doc),'fixture-owner','2026-10-29T00:00:00.000Z','kept history'))
  base=self.versions/m.BASE_REV;(base/'assets').mkdir(parents=True,mode=0o700);(base/'account/register').mkdir(parents=True,mode=0o700);(base/m.TARGET).write_bytes((SOURCE/'order.js').read_bytes());(base/m.REGISTER).write_bytes((SOURCE/'register.html').read_bytes())
  (base/'assets/storefront.js').write_bytes((SOURCE/'storefront.js').read_bytes())
  for i in range(138):(base/('fixture-'+str(i)+'.txt')).write_bytes(b'preserved public bytes')
  for f in base.rglob('*'):
   if f.is_file():f.chmod(0o600)
  self.base_doc=self.document(base);self.db.execute('INSERT INTO site_workspace_revisions VALUES(?,?,?,?,?,?,?)',(m.SITE,m.BASE_REV,336,json.dumps(self.base_doc),'fixture-owner','2026-10-29T00:00:00.000Z','accepted base'));self.db.commit()
 def document(self,folder):return {f.relative_to(folder).as_posix():{'sha256':m.sha(f.read_bytes()),'bytes':len(f.read_bytes())}for f in sorted(folder.rglob('*'))if f.is_file()}
 def backup(self):return m.protect_before()
 def official_save_fixture(self,extra=None):
  temporary=self.versions/'synthetic-staging';shutil.copytree(self.versions/m.BASE_REV,temporary);(temporary/m.TARGET).write_bytes((UI/'order.js').read_bytes())
  if extra:(temporary/extra).write_bytes(b'unrelated new content')
  doc=self.document(temporary);raw=json.dumps(doc,sort_keys=True,separators=(',',':'));revision=m.sha((raw+'\n'+m.BASE_REV).encode());temporary.rename(self.versions/revision);stamp=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z');self.db.execute('INSERT INTO site_workspace_revisions VALUES(?,?,?,?,?,?,?)',(m.SITE,revision,337,raw,'fixture-owner',stamp,'browser profile hints'));self.db.execute('UPDATE site_workspaces SET current_revision=? WHERE site_id=?',(revision,m.SITE));self.db.execute('UPDATE managed_sites SET updated_at=? WHERE id=?',(stamp,m.SITE));self.db.commit();return revision
 def test_protected_before_one_raw_copy_and_official_after336_preserve_history_register_other140(self):
  ready=self.backup();self.assertEqual(ready['status'],'PROTECTED_BEFORE_READY_NOT_SAVED');self.assertEqual((self.area/'order.before.js').read_bytes(),(SOURCE/'order.js').read_bytes());base=m.parse((self.area/'baseline.json').read_bytes());old257=copy.deepcopy(base['history'][f'{257:064x}']);self.official_save_fixture();result=m.readback();self.assertEqual(result['status'],'AFTER_INDEPENDENT_READBACK_PASS');current=m.parse(next(self.area.glob('readback-*.json')).read_bytes())['snapshot'];self.assertEqual(current['history'][f'{257:064x}'],old257);self.assertEqual(current['manifest'][m.REGISTER],base['manifest'][m.REGISTER]);self.assertEqual(len(current['history']),337);self.assertEqual(len(current['manifest']),141)
 def test_exact_accepted_storefront336_guard_before_save(self):
  self.base_doc['assets/storefront.js']['sha256']='0'*64;self.db.execute('UPDATE site_workspace_revisions SET manifest_json=? WHERE revision=?',(json.dumps(self.base_doc),m.BASE_REV));self.db.commit()
  with self.assertRaisesRegex(ValueError,'MANIFEST_FILE_CONTENT|ACCEPTED336'):self.backup()
 def test_existing_namespace_never_overwritten_and_unknown_before_no_replay(self):
  self.backup();before=(self.area/'baseline.json').read_bytes()
  with self.assertRaisesRegex(ValueError,'NAMESPACE_EXISTS'):self.backup()
  self.assertEqual((self.area/'baseline.json').read_bytes(),before);self.assertEqual(m.readback()['status'],'BEFORE_NO_REPLAY')
 def test_only_target_file_changes_unrelated_new_file_is_refused(self):
  self.backup();self.official_save_fixture('fixture-17.txt')
  with self.assertRaisesRegex(ValueError,'ONLY_ORDER'):m.readback()
 def test_all_old_rows_and_historical_tree_tamper_are_refused(self):
  self.backup();self.official_save_fixture();file=self.versions/f'{257:064x}'/'old.txt';file.write_bytes(b'new historical tamper')
  with self.assertRaisesRegex(ValueError,'OLD336'):m.readback()
 def test_old_revision_row_metadata_is_exact(self):
  self.backup();self.official_save_fixture();self.db.execute('UPDATE site_workspace_revisions SET message=? WHERE revision=?',('changed',f'{1:064x}'));self.db.commit()
  with self.assertRaisesRegex(ValueError,'OLD336'):m.readback()
 def test_foreign_managed_row_and_untouched_target_fields_do_not_get_ignored(self):
  self.backup();self.official_save_fixture();self.db.execute('UPDATE managed_sites SET extra=? WHERE id=?',('changed','foreign'));self.db.commit()
  with self.assertRaisesRegex(ValueError,'PRESERVED_MANAGEDROWS'):m.readback()
 def test_two_field_target_timestamp_delta_must_match_new_created_at(self):
  self.backup();self.official_save_fixture();self.db.execute('UPDATE managed_sites SET updated_at=? WHERE id=?',('2026-10-30T00:00:00.000Z',m.SITE));self.db.commit()
  with self.assertRaisesRegex(ValueError,'TWO_FIELD'):m.readback()
 def test_save_after_short_fresh_permit_is_not_accepted(self):
  with patch.object(m,'PERMIT_SECONDS',-1):self.backup()
  self.official_save_fixture()
  with self.assertRaisesRegex(ValueError,'OUTSIDE_FRESH_PERMIT'):m.readback()
 def test_new336_modes_and_register_changes_are_not_hidden(self):
  self.backup();revision=self.official_save_fixture();file=self.versions/revision/m.REGISTER;file.write_bytes(b'register changed without matching manifest')
  with self.assertRaisesRegex(ValueError,'MANIFEST_FILE_CONTENT'):m.readback()
 def test_protected_raw_backup_and_helper_tamper_refuse(self):
  self.backup();(self.area/'order.before.js').write_bytes(b'corrupt evidence')
  with self.assertRaisesRegex(ValueError,'RAW_BEFORE'):m.readback()
 def test_sql_authorizer_refuses_updates_without_mutating_database(self):
  c=m.open_db()
  try:
   with self.assertRaises(sqlite3.DatabaseError):c.execute("UPDATE managed_sites SET extra='blocked'")
   self.assertEqual(c.total_changes,0)
  finally:c.close()
 def test_price_guard_is_source_exact_fullrow_and_schema_without_network(self):
  self.backup();self.official_save_fixture();self.db.execute('UPDATE documents SET updated_at=? WHERE key=?',('changed','palitra/price'));self.db.commit()
  with self.assertRaisesRegex(ValueError,'PRESERVED_PRICE'):m.readback()
 def test_new_current_file_mode_change_refuses_even_when_bytes_are_identical(self):
  self.backup();revision=self.official_save_fixture();file=self.versions/revision/'fixture-1.txt';file.chmod(0o400);self.addCleanup(lambda:file.chmod(0o600))
  with self.assertRaisesRegex(ValueError,'MODE_OWNER_LINK'):m.readback()
 def test_target_unknown_metadata_and_schema_remain_exact(self):
  self.backup();self.official_save_fixture();self.db.execute('UPDATE site_workspaces SET extra=? WHERE site_id=?',('changed',m.SITE));self.db.commit()
  with self.assertRaisesRegex(ValueError,'PRESERVED_MANAGEDROWS'):m.readback()
 def test_image_full_identity_change_refuses(self):
  self.backup();self.official_save_fixture();self.images['caddy']={**self.images['caddy'],'identitySha256':'c'*64}
  with self.assertRaisesRegex(ValueError,'PRESERVED_IMAGES'):m.readback()
 def test_more_than_one_new_revision_is_not_accepted(self):
  self.backup();self.official_save_fixture();extra='f'*64;folder=self.versions/extra;folder.mkdir();file=folder/'extra.txt';file.write_bytes(b'synthetic extra');doc={'extra.txt':{'sha256':m.sha(file.read_bytes()),'bytes':len(file.read_bytes())}};self.db.execute('INSERT INTO site_workspace_revisions VALUES(?,?,?,?,?,?,?)',(m.SITE,extra,338,json.dumps(doc),'fixture-owner','2026-10-30T00:00:00.000Z','unapproved extra revision'));self.db.commit()
  with self.assertRaisesRegex(ValueError,'ONE_NEW337'):m.readback()
 def test_before_refuses_target_metadata_that_official_writer_would_drop(self):
  doc=copy.deepcopy(self.base_doc);doc[m.TARGET]['futureMetadata']='keep';self.db.execute('UPDATE site_workspace_revisions SET manifest_json=? WHERE revision=?',(json.dumps(doc),m.BASE_REV));self.db.commit()
  with self.assertRaisesRegex(ValueError,'METADATA_WOULD_BE_DROPPED'):self.backup()
  self.assertFalse((self.area/'baseline.json').exists());self.assertFalse((self.area/'order.before.js').exists())
 def test_before_refuses_unmanifested_empty_current_directory_before_save(self):
  (self.versions/m.BASE_REV/'kept-empty').mkdir()
  with self.assertRaisesRegex(ValueError,'DIRECTORY_WOULD_BE_DROPPED'):self.backup()
  self.assertFalse((self.area/'baseline.json').exists())
 def test_before_requires_official_max_version334_to_avoid_unexpected_save_version(self):
  self.db.execute('UPDATE site_workspace_revisions SET version=400 WHERE revision=?',(f'{1:064x}',));self.db.commit()
  with self.assertRaisesRegex(ValueError,'NEXT_VERSION_MUST_BE337'):self.backup()
  self.assertFalse((self.area/'baseline.json').exists())
 def test_protected_metadata_bound_refuses_before_ready_without_overwrite(self):
  with patch.object(m,'LIMIT',65536):
   with self.assertRaisesRegex(ValueError,'PROTECTED_METADATA_BOUND'):self.backup()
  self.assertFalse((self.area/'baseline.ready.json').exists())
class Metadata(unittest.TestCase):
 def row(self):return {'Id':'a'*64,'Image':next(iter(m.IMAGES.values())),'Config':{'Unknown':True},'HostConfig':{'Keep':True},'NetworkSettings':{'Keep':'all'},'RestartCount':0,'State':{'Running':True,'Paused':False,'Restarting':False,'OOMKilled':False,'Dead':False,'StartedAt':'old','FinishedAt':''},'Mounts':[{'Destination':'/z','Source':'keep','Options':['ro'],'Unknown':17},{'Destination':'/a','Source':'keep2','Unknown':{'keep':True}}]}
 def test_full_mount_identity_order_only_normalization(self):
  left=self.row();right=copy.deepcopy(left);right['Mounts'].reverse();self.assertEqual(m.enc(m.container_identity(left)),m.enc(m.container_identity(right)))
  right['Mounts'][0]['Unknown']='changed';self.assertNotEqual(m.enc(m.container_identity(left)),m.enc(m.container_identity(right)))
  for field in ('Id','RestartCount'):
   changed=copy.deepcopy(left);changed[field]='changed';self.assertNotEqual(m.enc(m.container_identity(left)),m.enc(m.container_identity(changed)))
  changed=copy.deepcopy(left);changed['State']['StartedAt']='new';self.assertNotEqual(m.enc(m.container_identity(left)),m.enc(m.container_identity(changed)))
  left['Mounts'].append(copy.deepcopy(left['Mounts'][0]))
  with self.assertRaisesRegex(ValueError,'DUPLICATE_MOUNT'):m.container_identity(left)
 def test_source_has_no_http_save_subprocess_runtime_exec_or_sql_dml(self):
  source=(HERE/'verify_buyer_receipt.py').read_text();tree=ast.parse(source);self.assertNotIn('urllib',source);self.assertNotIn('urlopen',source);self.assertNotIn('docker exec',source)
  for node in ast.walk(tree):
   if isinstance(node,ast.Constant)and isinstance(node.value,str):self.assertFalse(node.value.lstrip().upper().startswith(('UPDATE ','INSERT ','DELETE ','CREATE ','DROP ','ALTER ')))
  expected=hashlib.sha256((HERE/'accepted-profile-session.py').read_bytes()).hexdigest();self.assertEqual(expected,'48e6e0ab462a1f193e9cbfc1970d277c38eec5f9f0d39f7458712bad963ea2ab')
if __name__=='__main__':unittest.main()
